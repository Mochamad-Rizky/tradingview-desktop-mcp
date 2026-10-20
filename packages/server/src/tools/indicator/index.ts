import { z } from 'zod';
import type { PageHandle } from '../../core/connection.js';
import { TvMcpError } from '../../core/errors.js';
import { parseTimeInput, toIso } from '../../utils/time.js';
import { chartIndexInput, TIME_INPUT, timeInput } from '../chart/index.js';
import { resolveChartTarget } from '../chart/strategies.js';
import { defineTool, type AnyToolDefinition } from '../types.js';
import { plotKeys, searchCatalog, toValueRows, type IndicatorCatalog } from './mappers.js';
import { readStudies, readStudyCatalog, readStudyValues } from './page.js';

// The tools that read indicators (design spec 7, domain Indicators): the studies on a chart, the
// indicators the app can add, and the values a study has computed. They read what the app holds;
// the only request is the list of standard Pine scripts, which the indicator dialog of the app asks
// for the same way (and the study metadata, once, if the app has not loaded it yet).

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const MAX_ROWS = 500;

// What the app knows of the indicators it can add, with a warning for each source it could not
// read: the standard Pine scripts (each with the script version a Pine study descriptor takes as
// pineVersion) and the visible built-in studies. The tools that add indicators look names and ids
// up here.
export async function loadIndicatorCatalog(
  page: PageHandle,
): Promise<{ catalog: IndicatorCatalog; warnings: string[] }> {
  const catalog = await page.bridge.evaluateWithLib(readStudyCatalog, []);
  const warnings: string[] = [];
  if (catalog.scripts === null) {
    warnings.push(
      'The standard Pine scripts (the indicators the indicator dialog of TradingView inserts, such ' +
        `as RSI and MACD) could not be listed: ${catalog.scriptsError ?? 'no reason given'}. Only ` +
        'built-in studies are searched.',
    );
  }
  if (catalog.builtins === null) {
    warnings.push(
      'The built-in studies of TradingView could not be read on this build, so only standard ' +
        'Pine scripts are searched.',
    );
  }
  return { catalog, warnings };
}

export const indicatorList = defineTool({
  name: 'indicator_list',
  domain: 'indicator',
  title: 'List indicators',
  description:
    'Lists the indicators (studies) on a chart, strategies included, and changes nothing. Returns ' +
    'studies, each with id (what the other indicator tools take), name, title (as the legend ' +
    'shows it), visible, isPine, isStrategy and inputs: id, name, type, value and options (the ' +
    'choices of an input that has them, else null). The internal inputs of Pine scripts are left ' +
    'out. Use indicator_get_values for the values an indicator computed.',
  inputSchema: { chartIndex: chartIndexInput() },
  annotations: READ_ONLY,
  core: true,
  async handler({ chartIndex }, ctx) {
    const page = await ctx.connection.chartPage();
    const target = await resolveChartTarget(page, chartIndex);
    const { studies, unreadable } = await page.bridge.evaluate(readStudies, [target.index]);
    const warnings = unreadable.map(
      (id) =>
        `The study ${id} could not be read, so only its id and name are reported; the other ` +
        'fields are defaults.',
    );
    return { data: { studies }, via: 'internal', warnings };
  },
});

export const indicatorSearch = defineTool({
  name: 'indicator_search',
  domain: 'indicator',
  title: 'Search indicators',
  description:
    'Searches the indicators TradingView can add, by name or short name (case aside), and ' +
    'changes nothing. Returns results: name, shortName, id (what indicator_add takes), kind ' +
    '(pine for a standard Pine script such as Relative Strength Index, which is what the ' +
    'indicator dialog of TradingView inserts; builtin for a built-in study such as Volume) and ' +
    'isStrategy. Standard Pine scripts come first. TradingView is asked for its list of standard ' +
    'scripts the way its indicator dialog asks; when that fails, built-in studies are returned ' +
    'with a warning. Community and saved scripts are not searched.',
  inputSchema: {
    query: z
      .string()
      .min(1)
      .max(100)
      .describe('Part of the name or short name, such as rsi or moving average.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe('How many results at most: 1 to 50, 20 by default.'),
  },
  annotations: READ_ONLY,
  core: true,
  async handler({ query, limit }, ctx) {
    if (query.trim() === '') {
      throw new TvMcpError('INVALID_INPUT', 'The query is blank', {
        hint: 'Give part of an indicator name, such as rsi.',
      });
    }
    const page = await ctx.connection.chartPage();
    const { catalog, warnings } = await loadIndicatorCatalog(page);
    return {
      data: { results: searchCatalog(catalog, query, limit) },
      via: 'internal',
      warnings,
    };
  },
});

export const indicatorGetValues = defineTool({
  name: 'indicator_get_values',
  domain: 'indicator',
  title: 'Read indicator values',
  description:
    'Reads the values an indicator on a chart computed, and changes nothing: the last count bars, ' +
    'or the count bars that end at the bar at or before at. Returns id, plots (the keys of the ' +
    'values: each plot by its title, a repeated title numbered #2, #3, a plot without a title by ' +
    'its plot id; colors and alert conditions are left out) and rows, oldest first: time (Unix ' +
    'seconds, in the bar times of data_get_ohlcv) with timeIso, and values by plot key, null ' +
    'where the indicator has no value for that bar (such as before its length is reached). Take ' +
    'the id from indicator_list.',
  inputSchema: {
    id: z.string().min(1).max(64).describe('The id of the indicator, from indicator_list.'),
    count: z
      .number()
      .int()
      .min(1)
      .max(MAX_ROWS)
      .default(1)
      .describe(
        `How many bars, the most recent first counted: 1 to ${String(MAX_ROWS)}, 1 by default.`,
      ),
    at: timeInput()
      .optional()
      .describe(
        `The bar to end at: the last bar at or before this time, ${TIME_INPUT}. Without an ` +
          'offset a time is UTC. Leave it out for the last bar.',
      ),
    chartIndex: chartIndexInput(),
  },
  annotations: READ_ONLY,
  core: true,
  async handler({ id, count, at, chartIndex }, ctx) {
    const time = at === undefined ? null : parseTimeInput(at);
    const page = await ctx.connection.chartPage();
    const target = await resolveChartTarget(page, chartIndex);
    const read = await page.bridge.evaluate(readStudyValues, [target.index, id, count, time]);
    const keys = plotKeys(read.plots, read.styles, read.ohlcPlots);
    const rows = toValueRows(read.rows, keys);
    const warnings: string[] = [];
    if (rows.length === 0) {
      warnings.push(
        time === null
          ? 'The indicator has no values yet: the chart may still be loading its data.'
          : `No bar of the chart lies at or before ${toIso(time)}, so no values are returned. ` +
              'data_get_ohlcv loads older bars.',
      );
    }
    return {
      data: { id, plots: keys.map(({ key }) => key), rows },
      via: 'internal',
      warnings,
    };
  },
});

export const indicatorTools: AnyToolDefinition[] = [
  indicatorList,
  indicatorSearch,
  indicatorGetValues,
];
