import { z } from 'zod';
import type { PageHandle } from '../../core/connection.js';
import { isTvMcpError, PlanLimitError, TvMcpError } from '../../core/errors.js';
import { getPlanLimits, inPlanLimitedTurn, requireBelowLimit } from '../../core/tv/plan-limits.js';
import { parseTimeInput, toIso } from '../../utils/time.js';
import { READ_ONLY } from '../annotations.js';
import { chartIndexInput, TIME_INPUT, timeInput } from '../chart/index.js';
import { pageWaitMs, resolveChartTarget } from '../chart/strategies.js';
import { defineTool, type AnyToolDefinition, type ToolContext } from '../types.js';
import {
  plotKeys,
  resolveIndicator,
  searchCatalog,
  toReportedInput,
  toStudyInputs,
  toValueRows,
  validateInputs,
  type IndicatorCatalog,
  type InputValue,
  type ResolvedIndicator,
} from './mappers.js';
import {
  editStudyInputs,
  insertStudy,
  readStudies,
  readStudyCatalog,
  readStudyInsertContext,
  readStudyValues,
  removeStudy,
  setStudyVisibility,
} from './page.js';

// The indicator tools (design spec 7, domain Indicators). The readers report the studies on a
// chart, the indicators the app can add and the values a study has computed, from what the app
// holds; the only request is the list of standard Pine scripts, which the indicator dialog of the
// app asks for the same way (and the study metadata, once, if the app has not loaded it yet).
//
// The others change the user's chart, so they keep to these rules: indicator_add checks the
// indicator limit of the plan before it adds anything and refuses indicators that need an input
// dialog of TradingView, so that no paywall or dialog opens, and refuses as well when it cannot
// read the limit or the metadata of a built-in; inputs are checked against what the study accepts
// before any is set; and indicator_remove needs confirm: true for a study this session did not add
// (design spec 5.3, rule 2), removing it the way the user could undo.

const MAX_ROWS = 500;

// The built-in studies whose descriptor makes TradingView ask for their inputs in a dialog, where it
// waits for the user (reverse-engineering notes of Plan 2, section 7).
const DIALOG_STUDIES = new Set(
  ['Overlay', 'CorrelationCoefficient', 'Correlation Coeff', 'Spread', 'Ratio'].map(
    (name) => `${name}@tv-basicstudies`,
  ),
);

const DIALOG_HINT =
  'This indicator needs the input dialog of TradingView, which only a person can answer: add it ' +
  'in TradingView itself.';

const FULL_CHART_HINT =
  'Remove an indicator first: indicator_list gives their ids, and indicator_remove removes one ' +
  '(an indicator this session did not add needs confirm: true).';

const idInput = () =>
  z.string().min(1).max(64).describe('The id of the indicator on the chart, from indicator_list.');

// Input values by input id or name. A schema without its description, which each use adds last,
// because a wrapper such as optional() would not carry it.
const inputValues = () =>
  z.record(z.string().min(1).max(200), z.union([z.string().max(10_000), z.number(), z.boolean()]));

const INPUTS_TEXT =
  'Input values by input id or name (case aside), as indicator_list reports them, such as ' +
  '{ "Length": 21, "Source": "hl2" }. Numbers must be within the bounds of the input, and a ' +
  'value of an input with options one of them. A time input takes ' +
  `${TIME_INPUT}; indicator_list reports it in Unix seconds with valueIso.`;

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
    'choices of an input that has them, else null). The value of a time input (type time or ' +
    'bar_time) is in Unix seconds, with valueIso (ISO 8601, UTC), both null when no time is set. ' +
    'The internal inputs of Pine scripts are left out. Use indicator_get_values for the values ' +
    'an indicator computed.',
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
    return {
      data: {
        studies: studies.map((study) => ({ ...study, inputs: study.inputs.map(toReportedInput) })),
      },
      via: 'internal',
      warnings,
    };
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

// Fails unless the chart has room for one more study, before anything is added. The check of the
// chart model answers for the study itself (the app does not count some built-ins, such as
// Volume); without it the studies on the chart are counted against the plan, and when either the
// count or the limit cannot be read the call fails with NOT_AVAILABLE, since the app would apply
// its own check, with a dialog. check and count are what readStudyInsertContext reads (with an
// empty id for a Pine script). pine_compile with addToChart shares it.
export async function requireStudyRoom(
  page: PageHandle,
  check: { success: boolean; reason: string | null; limitValue: number | null } | null,
  count: number | null,
): Promise<void> {
  const planLimit = async (): Promise<number | null | undefined> =>
    (await getPlanLimits(page, ['INDICATORS_ON_CHART'])).INDICATORS_ON_CHART;
  if (check === null) {
    requireBelowLimit('INDICATORS_ON_CHART', count, await planLimit(), FULL_CHART_HINT);
    return;
  }
  if (check.success) {
    return;
  }
  if (check.reason === 'general') {
    const limit = check.limitValue ?? (await planLimit());
    const message =
      'The chart holds as many indicators as the plan allows' +
      (typeof limit === 'number' ? ` (${String(limit)})` : '');
    if (typeof limit === 'number') {
      throw new PlanLimitError('INDICATORS_ON_CHART', limit, message, FULL_CHART_HINT);
    }
    throw new TvMcpError('PLAN_LIMIT', message, {
      hint: FULL_CHART_HINT,
      details: { feature: 'INDICATORS_ON_CHART' },
    });
  }
  // Not a count the user can make room in: a study on another study, a fundamental study or a
  // forecast that the account or chart does not allow.
  const reason = check.reason ?? 'unknown';
  throw new TvMcpError(
    'NOT_AVAILABLE',
    `TradingView does not allow this indicator on this chart (reason: ${reason})`,
    {
      hint: 'Check in TradingView whether the plan or the symbol allows this indicator.',
      details: { reason },
    },
  );
}

// What indicator_add does once it knows the indicator: it checks the room on the chart and whether
// the indicator needs a dialog, adds the study and sets its inputs, taking the study off again when
// they fail. Answers the id of the study and the chart it went to. Without chartIndex the check
// resolves the active chart to its index, once, and every later step works on the chart of that
// index, so the study goes to the chart whose room was checked even when another chart becomes the
// active one meanwhile. Runs in a turn of the plan-limited actions (inPlanLimitedTurn), so that no
// other call takes the slot it checked.
async function addStudy(
  page: PageHandle,
  ctx: ToolContext,
  chartIndex: number | null,
  indicator: ResolvedIndicator,
  {
    inputs,
    overlay,
  }: { inputs: Record<string, InputValue> | undefined; overlay: boolean | undefined },
  warnings: string[],
): Promise<{ id: string; chartIndex: number | null }> {
  const context = await page.bridge.evaluateWithLib(readStudyInsertContext, [
    chartIndex,
    indicator.kind === 'builtin' ? indicator.id : '',
  ]);
  const { builtin } = context;
  if (builtin?.confirm === true) {
    throw new TvMcpError('NOT_AVAILABLE', `${indicator.name} cannot be added by this tool`, {
      hint: DIALOG_HINT,
      details: { id: indicator.id },
    });
  }
  // Without its metadata, whether a built-in needs the input dialog cannot be told, so it is
  // refused rather than added on a guess.
  if (indicator.kind === 'builtin' && builtin === null) {
    throw new TvMcpError(
      'NOT_AVAILABLE',
      `The metadata of ${indicator.name} cannot be read on this TradingView build, so whether ` +
        'TradingView would ask for its inputs in a dialog cannot be checked',
      {
        hint: 'Add this indicator in TradingView itself.',
        details: { id: indicator.id },
      },
    );
  }
  await requireStudyRoom(page, context.check, context.count);
  // The chart the check looked at: the one named, else the active one, by the index it had then.
  // Null only on a page that does not say which chart is active, which then gets the active chart.
  const at = context.chartIndex;
  const wanted = inputs ?? {};
  const hasInputs = Object.keys(wanted).length > 0;
  // A built-in's inputs are known before it is added; a Pine script's only afterwards.
  const checked = hasInputs && builtin !== null ? validateInputs(builtin.inputs, wanted) : null;

  const how =
    indicator.kind === 'pine'
      ? ({ kind: 'pine', pineId: indicator.id, pineVersion: indicator.version } as const)
      : builtin?.firstMatch === true
        ? ({ kind: 'description', description: builtin.description } as const)
        : ({ kind: 'java', studyId: indicator.id } as const);
  if (overlay === true && how.kind !== 'description') {
    warnings.push(
      'overlay was not applied: TradingView takes it only for a built-in study it adds by ' +
        'name, so the indicator is where TradingView puts it.',
    );
  }
  const { id } = await page.bridge.evaluate(insertStudy, [
    at,
    how,
    overlay === true,
    pageWaitMs(ctx.config.callTimeoutMs),
  ]);
  ctx.session.createdStudyIds.add(id);

  if (hasInputs) {
    try {
      const values =
        checked ??
        validateInputs(
          (await page.bridge.evaluate(editStudyInputs, [at, id, null])).inputs,
          wanted,
        );
      await page.bridge.evaluate(editStudyInputs, [at, id, values]);
    } catch (error) {
      // The study was added for nothing: take it off again, so the chart is as it was. Should
      // that fail too, the error of the inputs still is the one to report, with the study it left
      // on the chart, which stays one this session added.
      try {
        await page.bridge.evaluate(removeStudy, [at, id, true]);
        ctx.session.createdStudyIds.delete(id);
      } catch (cause) {
        ctx.logger.warn(
          { id, code: isTvMcpError(cause) ? cause.code : 'INTERNAL' },
          'indicator_add could not remove the study whose inputs failed',
        );
        throw leftOnChart(error, id);
      }
      throw error;
    }
  }
  return { id, chartIndex: at };
}

// The error of inputs that failed after the study `id` was added, when it could not be taken off
// again: its code and message, with the study in details.leftOnChart and a hint that says it is on
// the chart, in place of one that would say nothing was changed. An error that is not one of ours
// is passed on as it is.
function leftOnChart(error: unknown, id: string): unknown {
  if (!isTvMcpError(error)) {
    return error;
  }
  return new TvMcpError(error.code, error.message, {
    hint:
      `The indicator was added as ${id} and could not be taken off again, so ${id} is still on ` +
      'the chart: remove it with indicator_remove, which needs no confirm for it, then add the ' +
      'indicator again with inputs it takes.',
    details: { ...error.details, leftOnChart: id },
  });
}

export const indicatorAdd = defineTool({
  name: 'indicator_add',
  domain: 'indicator',
  title: 'Add an indicator',
  description:
    'Adds an indicator to a chart. name is an id from indicator_search, or a name or short name ' +
    '(case aside, such as RSI or Relative Strength Index); standard Pine scripts win over ' +
    'built-in studies. Returns id (for the other indicator tools), name and chartIndex. The ' +
    'indicator limit of the plan is checked first: a full chart fails with PLAN_LIMIT ' +
    '(error.details.feature INDICATORS_ON_CHART and limit) and nothing is added, and so does a ' +
    'limit that cannot be read on this TradingView build, with NOT_AVAILABLE. inputs are ' +
    'checked like indicator_set_inputs and set after the indicator is added; invalid inputs fail ' +
    'with INVALID_INPUT and leave the chart as it was, unless the indicator cannot be taken off ' +
    'again, which error.details.leftOnChart then names. overlay: true puts a built-in study on ' +
    'the price pane where TradingView allows it; for other indicators it is not applied and a ' +
    'warning says so. Indicators that need the input dialog of TradingView, and built-in studies ' +
    'whose metadata cannot be read, fail with NOT_AVAILABLE. indicator_remove removes what this ' +
    'tool added without confirm.',
  inputSchema: {
    name: z
      .string()
      .min(1)
      .max(200)
      .describe('The indicator: an id from indicator_search, or its name or short name.'),
    inputs: inputValues()
      .optional()
      .describe(`${INPUTS_TEXT} Set once the indicator is added. Default: its defaults.`),
    overlay: z
      .boolean()
      .optional()
      .describe(
        'true to put a built-in study on the price pane. Not applied to Pine scripts. Default: ' +
          'where TradingView puts it.',
      ),
    chartIndex: chartIndexInput(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  core: true,
  async handler({ name, inputs, overlay, chartIndex }, ctx) {
    const page = await ctx.connection.chartPage();
    const target = await resolveChartTarget(page, chartIndex);
    const { catalog, warnings } = await loadIndicatorCatalog(page);
    const indicator = resolveIndicator(catalog, name);
    if (indicator === null) {
      throw new TvMcpError('INVALID_INPUT', `No indicator TradingView can add is named ${name}`, {
        hint: 'Call indicator_search for the names and ids of the indicators that can be added.',
        details: { name },
      });
    }
    if (indicator.kind === 'builtin' && DIALOG_STUDIES.has(indicator.id)) {
      throw new TvMcpError('NOT_AVAILABLE', `${indicator.name} cannot be added by this tool`, {
        hint: DIALOG_HINT,
        details: { id: indicator.id },
      });
    }
    // From the check of the room to the end of the add, the other actions on plan limits wait.
    const added = await inPlanLimitedTurn(() =>
      addStudy(page, ctx, target.index, indicator, { inputs, overlay }, warnings),
    );
    return {
      data: { id: added.id, name: indicator.name, chartIndex: added.chartIndex },
      via: 'internal',
      warnings,
    };
  },
});

export const indicatorRemove = defineTool({
  name: 'indicator_remove',
  domain: 'indicator',
  title: 'Remove an indicator',
  description:
    'Removes an indicator from a chart, the way the user could undo in TradingView. An indicator ' +
    "this session added with indicator_add goes without more ado; any other one was the user's " +
    'and needs confirm: true, else the call fails with CONFIRMATION_REQUIRED and changes nothing. ' +
    'Returns removed, the id. An id that is not on the chart fails with INVALID_INPUT; take ids ' +
    'from indicator_list.',
  inputSchema: {
    id: idInput(),
    confirm: z
      .boolean()
      .optional()
      .describe(
        "Must be true to remove an indicator this session did not add, which was the user's. " +
          'Not needed for indicators added with indicator_add in this session.',
      ),
    chartIndex: chartIndexInput(),
  },
  // Removing what the user put on the chart is destructive, although the user can undo it.
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  core: true,
  async handler({ id, confirm, chartIndex }, ctx) {
    const page = await ctx.connection.chartPage();
    const target = await resolveChartTarget(page, chartIndex);
    const confirmed = confirm === true || ctx.session.createdStudyIds.has(id);
    // Unconfirmed, this only checks that the study is there, so an unknown id is reported first.
    const { removed, name } = await page.bridge.evaluate(removeStudy, [
      target.index,
      id,
      confirmed,
    ]);
    if (!removed) {
      throw new TvMcpError(
        'CONFIRMATION_REQUIRED',
        `Removing ${name} (${id}) needs confirmation: this session did not add it`,
        {
          hint:
            "The indicator was on the chart before, so it is the user's. Make sure the user wants " +
            'it gone, then call indicator_remove again with confirm: true.',
          details: { id, name },
        },
      );
    }
    ctx.session.createdStudyIds.delete(id);
    return { data: { removed: id }, via: 'internal' };
  },
});

export const indicatorSetInputs = defineTool({
  name: 'indicator_set_inputs',
  domain: 'indicator',
  title: 'Change indicator inputs',
  description:
    'Changes input values of an indicator on a chart. Inputs are named by id or name (case ' +
    'aside) as indicator_list reports them, and checked first: an unknown input, a value of the ' +
    'wrong type, a number outside the bounds of the input or a value that is not one of its ' +
    'options fails with INVALID_INPUT, and then nothing is set. Returns id, previous and current: ' +
    'the inputs before and after (id, name, type, value, options; a time input in Unix seconds ' +
    'with valueIso, as indicator_list reports it), so a change can be undone with the previous ' +
    'values.',
  inputSchema: {
    id: idInput(),
    inputs: inputValues().describe(INPUTS_TEXT),
    chartIndex: chartIndexInput(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler({ id, inputs, chartIndex }, ctx) {
    if (Object.keys(inputs).length === 0) {
      throw new TvMcpError('INVALID_INPUT', 'No inputs to change were given', {
        hint: 'Give at least one input by id or name, such as { "Length": 21 }.',
      });
    }
    const page = await ctx.connection.chartPage();
    const target = await resolveChartTarget(page, chartIndex);
    const before = await page.bridge.evaluate(editStudyInputs, [target.index, id, null]);
    const values = validateInputs(before.inputs, inputs);
    const after = await page.bridge.evaluate(editStudyInputs, [target.index, id, values]);
    return {
      data: { id, previous: toStudyInputs(before.inputs), current: toStudyInputs(after.inputs) },
      via: 'internal',
    };
  },
});

export const indicatorSetVisibility = defineTool({
  name: 'indicator_set_visibility',
  domain: 'indicator',
  title: 'Show or hide an indicator',
  description:
    'Shows or hides an indicator on a chart, keeping it and its settings. Returns id, visible ' +
    '(as TradingView reports it afterwards) and previous, the visibility before.',
  inputSchema: {
    id: idInput(),
    visible: z.boolean().describe('true to show the indicator, false to hide it.'),
    chartIndex: chartIndexInput(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler({ id, visible, chartIndex }, ctx) {
    const page = await ctx.connection.chartPage();
    const target = await resolveChartTarget(page, chartIndex);
    const result = await page.bridge.evaluate(setStudyVisibility, [target.index, id, visible]);
    return { data: { id, visible: result.visible, previous: result.previous }, via: 'internal' };
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

// In the order of the catalog (design spec 7).
export const indicatorTools: AnyToolDefinition[] = [
  indicatorList,
  indicatorSearch,
  indicatorAdd,
  indicatorRemove,
  indicatorSetInputs,
  indicatorSetVisibility,
  indicatorGetValues,
];
