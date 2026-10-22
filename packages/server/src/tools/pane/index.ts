import { z } from 'zod';
import type { PageHandle } from '../../core/connection.js';
import { isTvMcpError, TvMcpError } from '../../core/errors.js';
import {
  getPlanFeaturesEnabled,
  getPlanLimits,
  inPlanLimitedTurn,
  unreadableLimitError,
} from '../../core/tv/plan-limits.js';
import { pollUntil } from '../../utils/poll.js';
import { READ_ONLY } from '../annotations.js';
import { chartSetSymbol, requestedSymbol, setChartSymbol } from '../chart/index.js';
import { readChartLayout } from '../chart/page.js';
import {
  dataWaitMs,
  pageWaitMs,
  POLL_INTERVAL_MS,
  resolveChartTarget,
  type ChartTarget,
} from '../chart/strategies.js';
import { defineTool, type AnyToolDefinition, type ToolOutput } from '../types.js';
import {
  chartsNotReadyWarning,
  describeLayouts,
  fewerChartsError,
  layoutNotShownError,
  multipleChartsError,
  notFocusedError,
  PANE_LAYOUT_CODES,
  PANE_LAYOUTS,
  planChartsLimitOf,
  symbolChanges,
  syncedSymbolsWarning,
  uncountedLayoutError,
  unknownLayoutError,
  unreadableLayoutError,
  unreportedPanesWarning,
  unreportedStudiesWarning,
  type PaneLayout,
} from './mappers.js';
import {
  awaitChartsData,
  focusChart,
  readChartSymbols,
  readLayoutCount,
  readPaneLayout,
  readPanes,
  setLayoutViaApi,
} from './page.js';

// The pane tools (design spec 7, domain Layouts and panes): the charts of a multi-chart layout and
// the panes of each chart (reverse-engineering notes of Plan 3, section 2), through the chart API of
// the app. pane_set_layout changes how many charts the layout shows. TradingView opens its upgrade
// paywall by itself when a layout has more charts than the plan allows, on every path of its
// setLayout, so the tool takes its turn among the plan-limited actions and checks the MULTIPLE_CHARTS
// limit first, the way TradingView computes it, before it asks for the layout with the undo step of
// the app (design spec 5.3, rule 3). A layout of fewer charts hides the others until the layout is
// saved, and TradingView saves only the charts a layout shows, so its next save, which autosave makes
// by itself, drops them: that needs confirm: true (rule 2).

// TradingView makes a chart the active one at once, or, while the active chart is maximized, as it
// maximizes the chosen one; a chart that is not active by this time is not going to be.
const FOCUS_WAIT_MS = 1000;

// What pane_set_layout returns: the layout the tab shows, how many charts it shows and whether the
// call changed it. A type alias, not an interface: it goes to the client as JSON.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
type ShownLayout = { layout: string; chartsCount: number; changed: boolean };
// What pane_focus returns: the chart asked for, and whether the call made it the active one.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
type FocusedChart = { chartIndex: number; changed: boolean };

// The hints of resolveChartTarget suggest leaving chartIndex out for the active chart, which the
// pane tools do not allow: they always name a chart.
const PANE_INDEX_HINT =
  'pane_list reports how many charts the layout has and which one is active; chartIndex counts ' +
  'them from 0.';
const UNCOUNTED_CHARTS_HINT =
  'Check app_health: the chart may still be loading, or the tab does not show a chart.';

// The chart a pane tool works on, which it always names, unlike the tools of the chart.
function requiredChartIndexInput() {
  return z
    .number()
    .int()
    .min(0)
    .describe(
      'Which chart of the layout, counted from 0 (pane_list reports the charts and the active one).',
    );
}

// resolveChartTarget for a chart the caller named, with hints that fit tools that need a chartIndex.
async function resolvePaneTarget(page: PageHandle, chartIndex: number): Promise<ChartTarget> {
  try {
    return await resolveChartTarget(page, chartIndex);
  } catch (error) {
    if (isTvMcpError(error) && (error.code === 'INVALID_INPUT' || error.code === 'NOT_AVAILABLE')) {
      throw new TvMcpError(error.code, error.message, {
        hint: error.code === 'INVALID_INPUT' ? PANE_INDEX_HINT : UNCOUNTED_CHARTS_HINT,
        ...(error.details === undefined ? {} : { details: error.details }),
      });
    }
    throw error;
  }
}

// How many charts the layout `code` shows: what the table of layouts of TradingView says, or else,
// without the table, PANE_LAYOUTS. A code the table does not have would become a single chart
// without a word, and a code it does not count cannot be checked against the plan: both refuse.
async function chartsOf(page: PageHandle, code: PaneLayout): Promise<number> {
  const table = await page.bridge.evaluateWithLib(readLayoutCount, [code]);
  if (!table.found) {
    return PANE_LAYOUTS[code];
  }
  if (!table.known) {
    throw unknownLayoutError(code);
  }
  if (table.count === null) {
    throw uncountedLayoutError(code);
  }
  return table.count;
}

// How many charts the plan allows in a layout, from the enabled and getConfig of the plan module of
// the app, the way TradingView computes it (planChartsLimitOf): a plan that does not have the
// feature allows one chart, and so does one whose configuration gives no number for the limit. A
// module that does not answer whether the plan has the feature refuses (NOT_AVAILABLE): an
// unreadable limit never passes.
async function planChartsLimit(page: PageHandle): Promise<number> {
  const { MULTIPLE_CHARTS: enabled = null } = await getPlanFeaturesEnabled(page, [
    'MULTIPLE_CHARTS',
  ]);
  if (enabled === null) {
    throw unreadableLimitError('MULTIPLE_CHARTS');
  }
  if (!enabled) {
    return planChartsLimitOf(false, null);
  }
  const { MULTIPLE_CHARTS: limit = null } = await getPlanLimits(page, ['MULTIPLE_CHARTS']);
  return planChartsLimitOf(true, limit);
}

export const paneList = defineTool({
  name: 'pane_list',
  domain: 'pane',
  title: 'List the charts and panes',
  description:
    'Lists the charts of the layout of the chart tab and the panes of each, and changes nothing. ' +
    'Returns layout (the layout code TradingView shows, such as s for one chart or 2h for two side ' +
    'by side; pane_set_layout lists them) and charts, each with index (the chartIndex of the other ' +
    'tools), symbol, resolution, active (whether it is the active chart, the one the tools without ' +
    'a chartIndex act on) and panes, top to bottom: index, height (CSS pixels), studyIds (the ids ' +
    'of the indicators in the pane, as indicator_list reports them; the price series and the ' +
    'drawings are left out) and hasMainSeries (whether the price series of the chart is in the ' +
    'pane). layout, symbol and resolution are null when TradingView does not say, and panes and ' +
    'studyIds are null, with a warning, for a chart that does not report them.',
  inputSchema: {},
  annotations: READ_ONLY,
  async handler(_input, ctx) {
    const page = await ctx.connection.chartPage();
    const listing = await page.bridge.evaluate(readPanes, []);
    const warnings = listing.charts.flatMap(({ index, panes }) => {
      if (panes === null) {
        return [unreportedPanesWarning(index)];
      }
      return panes.some(({ studyIds }) => studyIds === null)
        ? [unreportedStudiesWarning(index)]
        : [];
    });
    return { data: listing, via: 'api', warnings };
  },
});

export const paneSetLayout = defineTool({
  name: 'pane_set_layout',
  domain: 'pane',
  title: 'Change the multi-chart layout',
  description:
    'Changes the layout of the chart tab to the layout code given, such as s (one chart), 2h (two ' +
    'side by side) or 4 (four in a grid), and waits until TradingView shows it with its charts and ' +
    'each chart has its data; a warning names the charts whose data did not load in time. Returns ' +
    'layout, chartsCount and changed (false when the layout is shown already, which is left as it ' +
    'is). A layout with more charts than the plan allows fails with PLAN_LIMIT (feature ' +
    'MULTIPLE_CHARTS, with the limit) before anything changes, since TradingView would open its ' +
    'upgrade offer instead; a plan limit that cannot be read, and a code this TradingView build ' +
    'does not know, fail with NOT_AVAILABLE. A layout with fewer charts than the layout shows now ' +
    'hides the charts beyond its count, and TradingView saves only the charts a layout shows, so ' +
    'its next save, which autosave can make at any time, drops them with their symbols, ' +
    'indicators and drawings: that needs confirm: true, or the call fails with ' +
    'CONFIRMATION_REQUIRED and nothing changes. The change is a step of the undo history of ' +
    'TradingView. TIMEOUT when TradingView does not show the layout within the call timeout.',
  inputSchema: {
    layout: z
      .enum(PANE_LAYOUT_CODES)
      .describe(`The layout code, by how many charts the layout shows: ${describeLayouts()}.`),
    confirm: z
      .boolean()
      .optional()
      .describe(
        'Must be true for a layout with fewer charts than the layout shows now: the next save of ' +
          'the layout drops the charts it hides. Not needed otherwise.',
      ),
  },
  // A smaller layout loses the charts it hides at the next save. Asking for the layout shown
  // changes nothing, so calling it again does nothing more.
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler({ layout: code, confirm }, ctx) {
    const page = await ctx.connection.chartPage();
    const waitMs = pageWaitMs(ctx.config.callTimeoutMs);
    // From the checks to the end of the change, the other actions on plan limits wait.
    return inPlanLimitedTurn(async (): Promise<ToolOutput<ShownLayout>> => {
      const before = await page.bridge.evaluate(readPaneLayout, []);
      if (before.layout === null || before.chartsCount === null) {
        throw unreadableLayoutError();
      }
      if (before.layout === code) {
        return {
          data: { layout: code, chartsCount: before.chartsCount, changed: false },
          via: 'api',
        };
      }
      const count = await chartsOf(page, code);
      // TradingView counts no plan limit against a single chart.
      if (code !== 's') {
        const limit = await planChartsLimit(page);
        if (count > limit) {
          throw multipleChartsError(code, count, limit);
        }
      }
      if (count < before.chartsCount && confirm !== true) {
        throw fewerChartsError(code, count, before.chartsCount);
      }

      const startedAt = performance.now();
      const left = (): number => Math.max(waitMs - (performance.now() - startedAt), 0);
      const change = await page.bridge.evaluate(setLayoutViaApi, [code, count, confirm === true]);
      if (change.outcome === 'same') {
        return {
          data: { layout: code, chartsCount: change.chartsCount ?? count, changed: false },
          via: 'api',
        };
      }
      if (change.outcome === 'fewer') {
        throw fewerChartsError(code, count, change.chartsCount);
      }
      const shown = await pollUntil(
        () => page.bridge.evaluate(readPaneLayout, []),
        (state) => state.layout === code && state.chartsCount === count,
        { intervalMs: POLL_INTERVAL_MS, timeoutMs: left() },
      );
      if (!shown.satisfied) {
        throw layoutNotShownError(code, count, waitMs, shown.last);
      }
      const dataWait = dataWaitMs(left(), waitMs);
      const { notReady } = await page.bridge.evaluate(awaitChartsData, [count, dataWait]);
      return {
        data: { layout: code, chartsCount: count, changed: true },
        via: 'api',
        warnings: notReady.length === 0 ? [] : [chartsNotReadyWarning(notReady, dataWait)],
      };
    });
  },
});

export const paneFocus = defineTool({
  name: 'pane_focus',
  domain: 'pane',
  title: 'Make a chart the active one',
  description:
    'Makes chart chartIndex of the layout the active chart, the one the tools without a ' +
    "chartIndex and TradingView's own toolbars act on, and returns chartIndex and changed (false " +
    'when it was the active chart already, which is left as it is). An index outside the layout ' +
    'fails with INVALID_INPUT, which names the range; pane_list reports the charts. When the ' +
    'active chart is maximized, TradingView maximizes the chosen chart instead. NOT_AVAILABLE when ' +
    'TradingView does not make the chart the active one.',
  inputSchema: { chartIndex: requiredChartIndexInput() },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler({ chartIndex }, ctx): Promise<ToolOutput<FocusedChart>> {
    const page = await ctx.connection.chartPage();
    const target = await resolvePaneTarget(page, chartIndex);
    if (target.activeIndex === chartIndex) {
      return { data: { chartIndex, changed: false }, via: 'api' };
    }
    const focus = await page.bridge.evaluate(focusChart, [chartIndex]);
    if (focus.wasActive) {
      return { data: { chartIndex, changed: false }, via: 'api' };
    }
    if (focus.activeChartIndex !== chartIndex) {
      const { satisfied, last } = await pollUntil(
        () => page.bridge.evaluate(readChartLayout, []),
        (layout) => layout.activeChartIndex === chartIndex,
        {
          intervalMs: POLL_INTERVAL_MS,
          timeoutMs: Math.min(FOCUS_WAIT_MS, pageWaitMs(ctx.config.callTimeoutMs)),
        },
      );
      if (!satisfied) {
        throw notFocusedError(chartIndex, last.activeChartIndex);
      }
    }
    return { data: { chartIndex, changed: true }, via: 'api' };
  },
});

export const paneSetSymbol = defineTool({
  name: 'pane_set_symbol',
  domain: 'pane',
  title: 'Change the symbol of a chart',
  description:
    'Switches chart chartIndex of the layout to another symbol, without making it the active ' +
    'chart, and waits until its data has loaded: chart_set_symbol for a chart named by its index, ' +
    'with the same checks and results. Returns chartIndex, symbol (as TradingView names ' +
    'it, which can differ from the input), previous and changed. A symbol TradingView does not ' +
    'know fails with INVALID_INPUT, and the chart is switched back (error.details.kept). An index ' +
    'outside the layout fails with INVALID_INPUT, which names the range. A layout that syncs the ' +
    'symbol of its charts changes the other charts too: a warning names them. Uses the chart API, ' +
    'and falls back to the symbol search dialog and to typing on the chart only when chartIndex is ' +
    'the active chart.',
  inputSchema: {
    chartIndex: requiredChartIndexInput(),
    symbol: z
      .string()
      .min(1)
      .max(200)
      .describe(
        'Symbol to show, best in the EXCHANGE:SYMBOL form such as NASDAQ:AAPL or ' +
          'BINANCE:BTCUSDT. A bare ticker such as AAPL lets TradingView choose the exchange.',
      ),
  },
  annotations: chartSetSymbol.annotations,
  async handler({ chartIndex, symbol: written }, ctx) {
    const symbol = requestedSymbol(written);
    const page = await ctx.connection.chartPage();
    const target = await resolvePaneTarget(page, chartIndex);
    const before = await page.bridge.evaluate(readChartSymbols, []);
    const { data, via, warnings } = await setChartSymbol(ctx, page, target, symbol);
    const after = await page.bridge.evaluate(readChartSymbols, []);
    const synced = symbolChanges(before.symbols, after.symbols, chartIndex);
    return {
      data: { chartIndex, ...data },
      via,
      warnings: synced.length === 0 ? warnings : [...warnings, syncedSymbolsWarning(synced)],
    };
  },
});

// In the order of the catalog (design spec 7).
export const paneTools: AnyToolDefinition[] = [paneList, paneSetLayout, paneFocus, paneSetSymbol];
