import { z } from 'zod';
import { TvMcpError } from '../../core/errors.js';
import type { Tier } from '../../core/result.js';
import { SELECTORS } from '../../core/tv/selectors.js';
import { parseTimeInput, toIso } from '../../utils/time.js';
import { defineTool, type AnyToolDefinition, type ToolContext } from '../types.js';
import {
  CHART_TYPE_NAMES,
  CHART_TYPE_NAMES_BY_ID,
  CHART_TYPES,
  chartTypeName,
  isReportableTime,
  normalizeTimeframe,
  sameResolution,
  sameSymbol,
  toTimeRange,
} from './mappers.js';
import { readChartState, readVisibleRange } from './page.js';
import {
  chartTypeStrategies,
  pageWaitMs,
  presetStrategies,
  rangeStrategies,
  resolveChartTarget,
  revertUnknownSymbol,
  runStrategies,
  scrollStrategies,
  symbolStrategies,
  timeframeStrategies,
  unknownSymbolPrevious,
  type DateRangePreset,
  type SymbolChange,
} from './strategies.js';

// The tools that read and change what a chart shows (design spec 7, domain Chart): its symbol,
// timeframe, type and visible range.

// How every time input of the chart tools is described, word for word. The other domains that take
// times or a chart index use these three as well.
export const TIME_INPUT =
  'ISO 8601 date/time (e.g. 2024-01-31 or 2024-01-31T10:00:00Z) or Unix timestamp in ' +
  'seconds/milliseconds; compact forms like 20240131 are rejected';

// A time as a client sends it, taken as written: parseTimeInput reads it in the handler, because a
// schema that converted it would convert its own output again when the registry parses the input a
// second time.
export function timeInput() {
  return z.union([z.string().min(1).max(64), z.number()]);
}

export function chartIndexInput() {
  return z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Which chart of a multi-chart layout, counted from 0 (layout.chartsCount of chart_get_state ' +
        'says how many there are). Leave it out for the active chart.',
    );
}

const PRESETS = Object.keys(SELECTORS.buttons.dateRange) as [DateRangePreset, ...DateRangePreset[]];

// The range a tool reports when the chart did not report one after the change.
const NO_RANGE = { from: null, to: null, fromIso: null, toIso: null };

const UNCHECKED =
  'The chart API of TradingView could not be read, so the change could not be checked. Call ' +
  'chart_get_state to see what the chart shows.';

// What chart_get_state and the resource tradingview://chart/state report: the state of a chart, its
// visible range in Unix seconds and ISO, and a warning for each part the chart could not report.
export async function readChartStateData(ctx: ToolContext, chartIndex?: number) {
  const page = await ctx.connection.chartPage();
  const target = await resolveChartTarget(page, chartIndex);
  const state = await page.bridge.evaluate(readChartState, [
    target.index,
    { ...CHART_TYPE_NAMES_BY_ID },
  ]);
  const visibleRange = toTimeRange(state.visibleRange.from, state.visibleRange.to);
  const warnings: string[] = [];
  if (visibleRange === null) {
    warnings.push('The chart did not report its visible range, so visibleRange is null.');
  }
  if (state.studies === null) {
    warnings.push('The chart did not report its studies, so studies is null.');
  }
  if (state.drawingCount === null) {
    warnings.push('The chart did not report its drawings, so drawingCount is null.');
  }
  return {
    data: {
      chartIndex: state.chartIndex,
      symbol: state.symbol,
      resolution: state.resolution,
      chartType: state.chartType,
      chartTypeName: state.chartTypeName,
      visibleRange,
      studies: state.studies,
      drawingCount: state.drawingCount,
      layout: state.layout,
    },
    warnings,
  };
}

export const chartGetState = defineTool({
  name: 'chart_get_state',
  domain: 'chart',
  title: 'Read the chart state',
  description:
    'Reads what a chart shows, and changes nothing. Returns chartIndex, symbol (as TradingView ' +
    'names it, such as NASDAQ:AAPL), resolution (the timeframe as TradingView writes it: 60 is one ' +
    'hour, 1D one day), chartType (the style id) and chartTypeName (such as candles), ' +
    'visibleRange (from and to in Unix seconds and as ISO strings, UTC), studies (id and name of ' +
    'each indicator on the chart), drawingCount, and layout (type, chartsCount, ' +
    'activeChartIndex, name, id). visibleRange, studies and drawingCount are null, with a ' +
    'warning, when the chart cannot report them, and a layout field is null when the app does not ' +
    'say. Use it before changing the chart; the resource tradingview://chart/state holds the same ' +
    'data.',
  inputSchema: { chartIndex: chartIndexInput() },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  core: true,
  async handler({ chartIndex }, ctx) {
    const { data, warnings } = await readChartStateData(ctx, chartIndex);
    return { data, via: 'api', warnings };
  },
});

export const chartSetSymbol = defineTool({
  name: 'chart_set_symbol',
  domain: 'chart',
  title: 'Change the chart symbol',
  description:
    'Switches a chart to another symbol and waits until its data has loaded. Returns symbol (as ' +
    'TradingView names it, which can differ from the input: AAPL may become NASDAQ:AAPL, and a ' +
    'symbol can show through the exchange of its data feed, such as BATS:AAPL for NASDAQ:AAPL), ' +
    'previous and changed, which is false when the chart shows the same symbol afterwards: when it ' +
    'showed the symbol already, as itself or through its data feed, nothing is done, and a bare ' +
    'ticker of the symbol shown (AAPL while NASDAQ:AAPL is shown) is loaded again by TradingView ' +
    'and ends where it started. A symbol TradingView does not know fails with INVALID_INPUT, and ' +
    'the chart is switched back to the symbol it showed (error.details.kept); details say so if ' +
    'switching back failed too. TIMEOUT when the data does not load within the call timeout. Uses ' +
    'the chart API, and falls back to the symbol search dialog and to typing the symbol on the ' +
    'chart, which reach the active chart only.',
  inputSchema: {
    symbol: z
      .string()
      .min(1)
      .max(200)
      .describe(
        'Symbol to show, best in the EXCHANGE:SYMBOL form such as NASDAQ:AAPL or ' +
          'BINANCE:BTCUSDT. A bare ticker such as AAPL lets TradingView choose the exchange.',
      ),
    chartIndex: chartIndexInput(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  core: true,
  async handler({ symbol: written, chartIndex }, ctx) {
    const symbol = written.trim();
    if (symbol === '') {
      throw new TvMcpError('INVALID_INPUT', 'The symbol is blank', {
        hint: 'Give a symbol such as NASDAQ:AAPL.',
      });
    }
    const page = await ctx.connection.chartPage();
    const target = await resolveChartTarget(page, chartIndex);
    const waitMs = pageWaitMs(ctx.config.callTimeoutMs);
    let outcome: { value: SymbolChange; via: Tier };
    try {
      outcome = await runStrategies(
        symbolStrategies(page, target, symbol, waitMs),
        ctx.logger,
        'Neither the chart API, nor the symbol search, nor typing on the chart could be used. ' +
          'Check app_health: the chart may still be loading or be covered by a dialog. The ' +
          'interface reaches the active chart only, and it is not used while a text field, such as ' +
          'the Pine Editor, has the focus.',
      );
    } catch (error) {
      // The chart has been switched to a symbol that does not exist, and is switched back before
      // the error is reported.
      const previous = unknownSymbolPrevious(error, symbol);
      if (previous === undefined) {
        throw error;
      }
      throw await revertUnknownSymbol(page, target, symbol, previous, waitMs, ctx.logger);
    }
    const { value, via } = outcome;
    const warnings: string[] = [];
    if (value.symbol === null) {
      warnings.push(UNCHECKED);
    } else {
      if (!value.confirmed) {
        warnings.push(
          `The chart shows ${value.symbol}, but TradingView did not confirm within the wait that ` +
            'it found the symbol and loaded its data. It may still be loading, or the symbol may ' +
            'be unknown; call chart_get_state to see what the chart shows.',
        );
      }
      // The chart may show the symbol through the exchange of its data feed (BATS:AAPL for
      // NASDAQ:AAPL), in which case the listing the series resolved names the one asked for.
      const listed = value.listing !== null && sameSymbol(symbol, value.listing);
      if (!sameSymbol(symbol, value.symbol) && !listed) {
        // Enter in the symbol search applies the highlighted result, which need not be the one
        // asked for, and the chart API resolves a symbol its own way too.
        warnings.push(
          `The chart shows ${value.symbol} instead of ${symbol}; TradingView may have chosen ` +
            'another match. Give the symbol in the EXCHANGE:SYMBOL form to pick one.',
        );
      }
    }
    return {
      data: { symbol: value.symbol, previous: value.previous, changed: value.changed },
      via,
      warnings,
    };
  },
});

export const chartSetTimeframe = defineTool({
  name: 'chart_set_timeframe',
  domain: 'chart',
  title: 'Change the chart timeframe',
  description:
    'Changes the timeframe (interval) of a chart and waits until its data has loaded. Takes ' +
    'TradingView resolutions and the usual aliases: 1h is 60, 1d is 1D, and lowercase m is minutes ' +
    'while uppercase M is months. Returns resolution (the TradingView resolution the chart shows), ' +
    'previous and changed (false when the chart showed it already, or keeps the timeframe it ' +
    'showed because TradingView did not take the new one). A timeframe it cannot read ' +
    'fails with INVALID_INPUT, which lists the accepted forms; a warning says when the chart ' +
    'settles on another timeframe. TIMEOUT when the data does not load within the call timeout, ' +
    'which can also mean that the plan does not offer the timeframe. Uses the chart API, and falls ' +
    'back to an interval button of the header toolbar and to typing the interval on the chart, ' +
    'which reach the active chart only.',
  inputSchema: {
    timeframe: z
      .string()
      .min(1)
      .max(16)
      .describe(
        'Timeframe to show: a TradingView resolution such as 1, 15, 60, 240, 1D, 1W or 1M, or a ' +
          'count with a unit: lowercase m = minutes (15m), uppercase M = months (3M), h hours ' +
          '(1h = 60, 4h = 240; H works too), d/D days (1d = 1D), w/W weeks (1w = 1W), s/S seconds ' +
          '(30s = 30S), T ticks (100T), R ranges (1000R). A unit alone counts one (D = 1D). Some ' +
          'timeframes, such as seconds, need a higher TradingView plan.',
      ),
    chartIndex: chartIndexInput(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  core: true,
  async handler({ timeframe, chartIndex }, ctx) {
    // Before anything else, so that a timeframe that cannot be read costs no look at the app.
    const resolution = normalizeTimeframe(timeframe);
    const page = await ctx.connection.chartPage();
    const target = await resolveChartTarget(page, chartIndex);
    const waitMs = pageWaitMs(ctx.config.callTimeoutMs);
    const { value, via } = await runStrategies(
      timeframeStrategies(page, target, resolution, waitMs),
      ctx.logger,
      'Neither the chart API, nor an interval button, nor typing on the chart could be used. ' +
        'Check app_health: the chart may still be loading or be covered by a dialog. The ' +
        'interface reaches the active chart only, and it is not used while a text field, such as ' +
        'the Pine Editor, has the focus.',
    );
    const warnings: string[] = [];
    if (value.resolution === null) {
      warnings.push(UNCHECKED);
    } else if (!sameResolution(value.resolution, resolution)) {
      warnings.push(
        `The chart settled on the timeframe ${value.resolution} instead of ${resolution}; ` +
          `TradingView may not offer ${resolution} for this symbol or plan.`,
      );
    }
    return {
      data: { resolution: value.resolution, previous: value.previous, changed: value.changed },
      via,
      warnings,
    };
  },
});

export const chartSetType = defineTool({
  name: 'chart_set_type',
  domain: 'chart',
  title: 'Change the chart type',
  description:
    'Changes the chart type (the style of the main series) by name, such as candles, ' +
    'heikin_ashi, line, area or renko. Returns chartType (the TradingView style id), ' +
    'chartTypeName, previous (chartType and chartTypeName before) and changed (false when the ' +
    'chart showed the type already, in which case nothing is done). TradingView can take a moment ' +
    'to apply types that need data of their own (renko, kagi, point_and_figure, line_break), so ' +
    'a warning says when the chart does not show the new type right away; check with ' +
    'chart_get_state.',
  inputSchema: {
    type: z.enum(CHART_TYPE_NAMES).describe(`Chart type, by name: ${CHART_TYPE_NAMES.join(', ')}.`),
    chartIndex: chartIndexInput(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  core: true,
  async handler({ type, chartIndex }, ctx) {
    const typeId = CHART_TYPES[type];
    const page = await ctx.connection.chartPage();
    const target = await resolveChartTarget(page, chartIndex);
    const { value, via } = await runStrategies(
      chartTypeStrategies(page, target, typeId),
      ctx.logger,
      'This page has no chart API to change the chart type with. Check app_health: the chart may ' +
        'still be loading, or the tab does not show a chart.',
    );
    const shown = chartTypeName(value.chartType);
    return {
      data: {
        chartType: value.chartType,
        chartTypeName: shown,
        previous: { chartType: value.previous, chartTypeName: chartTypeName(value.previous) },
        changed: value.changed,
      },
      via,
      warnings:
        value.chartType === typeId
          ? []
          : [
              `The chart shows ${shown} right after the change to ${type}. TradingView may still ` +
                `be applying ${type}, or may not offer it for this symbol; call chart_get_state ` +
                'to check.',
            ],
    };
  },
});

export const chartGetVisibleRange = defineTool({
  name: 'chart_get_visible_range',
  domain: 'chart',
  title: 'Read the visible range',
  description:
    'Reads which period a chart shows, and changes nothing. Returns from and to in Unix seconds ' +
    'and as ISO 8601 strings (fromIso, toIso, UTC). NOT_AVAILABLE while the chart has no data to ' +
    'report a range for.',
  inputSchema: { chartIndex: chartIndexInput() },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  core: true,
  async handler({ chartIndex }, ctx) {
    const page = await ctx.connection.chartPage();
    const target = await resolveChartTarget(page, chartIndex);
    const range = await page.bridge.evaluate(readVisibleRange, [target.index]);
    const times = toTimeRange(range.from, range.to);
    if (times === null) {
      throw new TvMcpError('NOT_AVAILABLE', 'The chart did not report its visible range', {
        hint: 'The chart may still be loading its data. Try again in a moment.',
      });
    }
    return { data: times, via: 'api' };
  },
});

// What a set_visible_range call asks for: a range of times, or a preset. Checked before the app is
// looked at.
function requestedRange(
  from: string | number | undefined,
  to: string | number | undefined,
  preset: DateRangePreset | undefined,
): { kind: 'range'; from: number; to: number } | { kind: 'preset'; preset: DateRangePreset } {
  const hint = 'Give from and to together, such as 2024-01-01 and 2024-03-31, or give a preset.';
  if (preset !== undefined) {
    if (from !== undefined || to !== undefined) {
      throw new TvMcpError('INVALID_INPUT', 'Give either from and to, or preset, not both', {
        hint,
      });
    }
    return { kind: 'preset', preset };
  }
  if (from === undefined || to === undefined) {
    throw new TvMcpError('INVALID_INPUT', 'Give from and to together, or a preset', { hint });
  }
  const start = parseTimeInput(from);
  const end = parseTimeInput(to);
  if (start >= end) {
    throw new TvMcpError(
      'INVALID_INPUT',
      `from must be earlier than to, but from is ${toIso(start)} and to is ${toIso(end)}`,
      { hint: 'Give a from that is earlier than to.' },
    );
  }
  return { kind: 'range', from: start, to: end };
}

export const chartSetVisibleRange = defineTool({
  name: 'chart_set_visible_range',
  domain: 'chart',
  title: 'Change the visible range',
  description:
    'Changes which period a chart shows. Give either from and to (the chart then shows the ' +
    'loaded bars nearest to them), or a preset of the date range bar under the chart, not both. ' +
    'A range is set through the time scale of the chart. Its end may lie in the empty space the ' +
    'chart keeps after the last bar, as chart_get_visible_range reports it, so a range read there ' +
    'can be set again; a time before the first loaded bar, or past that space, is clamped, with a ' +
    'warning, because TradingView loads older history only on demand. A preset is clicked in the ' +
    'date range bar of the active chart, ' +
    'and TradingView then also picks a timeframe that suits the range: the result reports it ' +
    '(resolution) and warns when it changed. Returns the visible range afterwards: from and to in ' +
    'Unix seconds and as ISO strings (fromIso, toIso, UTC), plus preset and resolution for a ' +
    'preset.',
  inputSchema: {
    from: timeInput()
      .optional()
      .describe(`Start of the range, with to: ${TIME_INPUT}. Without an offset a time is UTC.`),
    to: timeInput()
      .optional()
      .describe(`End of the range, with from: ${TIME_INPUT}. Without an offset a time is UTC.`),
    preset: z
      .enum(PRESETS)
      .optional()
      .describe(
        `A preset of the date range bar instead of from and to: ${PRESETS.join(', ')}. It can ` +
          'change the timeframe too.',
      ),
    chartIndex: chartIndexInput(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  core: true,
  async handler({ from, to, preset, chartIndex }, ctx) {
    const request = requestedRange(from, to, preset);
    const page = await ctx.connection.chartPage();
    const target = await resolveChartTarget(page, chartIndex);
    if (request.kind === 'range') {
      const { value, via } = await runStrategies(
        rangeStrategies(page, target, request.from, request.to),
        ctx.logger,
        'The time scale of the chart cannot be reached on this TradingView build. Try a preset ' +
          'instead, and check app_health.',
      );
      const times = toTimeRange(value.from, value.to);
      return {
        data: times ?? NO_RANGE,
        via,
        warnings:
          times === null
            ? [...value.warnings, 'The chart did not report its visible range after the change.']
            : value.warnings,
      };
    }

    const { value, via } = await runStrategies(
      presetStrategies(page, target, request.preset, pageWaitMs(ctx.config.callTimeoutMs)),
      ctx.logger,
      'The date range bar under the active chart has no button for this preset, or it is hidden. ' +
        'Use from and to instead, or show the date range bar.',
    );
    const times = toTimeRange(value.from, value.to);
    const warnings: string[] = [];
    if (times === null) {
      warnings.push(UNCHECKED);
    } else if (value.moved === false) {
      warnings.push(
        'The visible range did not change after the preset was clicked; the chart may have shown ' +
          'that range already.',
      );
    }
    if (
      value.resolution !== null &&
      value.previousResolution !== null &&
      value.resolution !== value.previousResolution
    ) {
      warnings.push(
        `The preset also changed the timeframe from ${value.previousResolution} to ${value.resolution}`,
      );
    }
    return {
      data: { ...(times ?? NO_RANGE), preset: request.preset, resolution: value.resolution },
      via,
      warnings,
    };
  },
});

export const chartScrollToDate = defineTool({
  name: 'chart_scroll_to_date',
  domain: 'chart',
  title: 'Scroll the chart to a date',
  description:
    'Scrolls a chart to a date and keeps its zoom: the bar nearest to the date goes to the center ' +
    'of the view, or to its left or right edge with align, and the view keeps its width in bars. ' +
    'A date before the first loaded bar or after the last one goes to that bar, with a warning. ' +
    'Returns time and timeIso (the bar it scrolled to), align, and the visible range afterwards ' +
    '(from, to, fromIso, toIso; Unix seconds and ISO strings, UTC).',
  inputSchema: {
    date: timeInput().describe(
      `The date to scroll to: ${TIME_INPUT}. Without an offset a time is UTC.`,
    ),
    align: z
      .enum(['left', 'center', 'right'])
      .default('center')
      .describe('Where the bar goes: the left edge, the center (default) or the right edge.'),
    chartIndex: chartIndexInput(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  core: true,
  async handler({ date, align, chartIndex }, ctx) {
    const time = parseTimeInput(date);
    const page = await ctx.connection.chartPage();
    const target = await resolveChartTarget(page, chartIndex);
    const { value, via } = await runStrategies(
      scrollStrategies(page, target, time, align),
      ctx.logger,
      'The time scale of the chart cannot be reached on this TradingView build, or the chart does ' +
        'not report its visible range. Check app_health.',
    );
    const times = toTimeRange(value.from, value.to);
    const reached = isReportableTime(value.time) ? value.time : null;
    const warnings = [...value.warnings];
    if (reached === null) {
      warnings.push('The chart did not report the time of the bar it scrolled to.');
    }
    if (times === null) {
      warnings.push('The chart did not report its visible range after the scroll.');
    }
    return {
      data: {
        time: reached,
        timeIso: reached === null ? null : toIso(reached),
        align,
        ...(times ?? NO_RANGE),
      },
      via,
      warnings,
    };
  },
});

export const chartTools: AnyToolDefinition[] = [
  chartGetState,
  chartSetSymbol,
  chartSetTimeframe,
  chartSetType,
  chartGetVisibleRange,
  chartSetVisibleRange,
  chartScrollToDate,
];
