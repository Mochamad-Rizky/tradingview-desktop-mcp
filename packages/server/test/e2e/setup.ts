import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';
import { loadConfig } from '../../src/config/load.js';
import type {
  BarsLike,
  ChartWidgetApiLike,
  TimeScaleLike,
  TvWindow,
} from '../../src/core/tv/tv-window.js';
import { createMcpServer } from '../../src/server.js';
import {
  chartSetSymbol,
  chartSetTimeframe,
  chartSetType,
  chartSetVisibleRange,
} from '../../src/tools/chart/index.js';
import {
  CHART_TYPE_NAMES_BY_ID,
  normalizeTimeframe,
  sameResolution,
} from '../../src/tools/chart/mappers.js';
import type { ToolContext } from '../../src/tools/types.js';
import { parseTimeInput } from '../../src/utils/time.js';
import { callTool, connectInMemoryClient, textOf } from '../helpers/mcp-client.js';
import { quietLogger } from '../helpers/tool-context.js';

// The harness of the end-to-end suites, which drive the real TradingView Desktop of the person
// running them (design spec 10). They run only with TV_E2E=1, against the debug port of TV_CDP_HOST
// and TV_CDP_PORT (127.0.0.1:9222 by default).
//
// A suite may change only the symbol, the timeframe, the chart type and the visible range of the
// active chart. Before it changes anything it checks, by reading only, that the chart API has what
// the tools use (so that no tool falls back to clicks or typing) and that the chart can be put back
// as it is (restorabilityProblems), and it skips its tests when either fails. It snapshots the four
// before its first test and restores them after every test and after its last one, whether the
// tests passed or not. Restoring goes through the tools, so it is tested too; afterwards the view
// is put back exactly through the time scale (the same bars from edge to edge), because the tools
// set a range in whole bars. Nothing else of the app is touched: no drawing, indicator, alert, layout, Pine script,
// replay, watchlist or trading control, and the app is never reloaded, quit or started.

export function e2eEnabled(): boolean {
  return process.env.TV_E2E === '1';
}

export interface ChartSnapshot {
  // The symbol as the chart shows it, to compare with.
  symbol: string;
  // The symbol to put back: the listing the series has resolved (NASDAQ:AAPL), since the chart can
  // show a symbol through the exchange of its data feed (BATS:AAPL), and setting that name would
  // switch to another listing. The symbol as shown when the series names none.
  listing: string;
  resolution: string;
  chartType: number;
  visibleRange: { from: number; to: number };
}

export interface E2eServer {
  client: Client;
  ctx: ToolContext;
  close(): Promise<void>;
}

// A server for the app on this machine, with a client over the in-memory transport. Only the debug
// port is read from the environment, so that a profile or a tool filter someone set for daily use
// cannot hide the tools under test.
export async function startE2eServer(): Promise<E2eServer> {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['TV_CDP_HOST', 'TV_CDP_PORT', 'TV_CALL_TIMEOUT_MS']) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  const { config } = loadConfig({ argv: [], env });
  const { server, ctx } = createMcpServer(config, { logger: quietLogger });
  const client = await connectInMemoryClient(server);
  return {
    client,
    ctx,
    async close() {
      await client.close();
      await server.close();
      await ctx.connection.close();
    },
  };
}

interface Envelope {
  ok: boolean;
  data?: unknown;
  meta: { via?: string; warnings?: string[] };
}

export interface ToolSuccess<T> {
  data: T;
  via: string | undefined;
  warnings: string[];
}

// The data of a successful tool call. A failure throws with what the tool said, so that a failing
// test says why.
export async function callOk<T>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolSuccess<T>> {
  const result = await callTool(client, name, args);
  const envelope = result.structuredContent as Envelope | undefined;
  if (result.isError === true || envelope?.ok !== true) {
    throw new Error(`${name} failed: ${textOf(result)}`);
  }
  return {
    data: envelope.data as T,
    via: envelope.meta.via,
    warnings: envelope.meta.warnings ?? [],
  };
}

export interface ChartState {
  symbol: string;
  resolution: string;
  chartType: number;
  chartTypeName: string;
  visibleRange: { from: number; to: number; fromIso: string; toIso: string } | null;
}

export async function readChartState(client: Client): Promise<ChartState> {
  return (await callOk<ChartState>(client, 'chart_get_state')).data;
}

// Whether `args` pass the input schema of a tool, as the registry parses them.
function accepts(shape: z.ZodRawShape, args: Record<string, unknown>): boolean {
  return z.object(shape).safeParse(args).success;
}

// A time the time tools take as it is: parseTimeInput gives back the same Unix seconds.
function takenAsIs(time: number): boolean {
  try {
    return parseTimeInput(time) === time;
  } catch {
    return false;
  }
}

// Why the chart could not be put back as `state` describes it, one reason each, or none. restoreChart
// hands these values to chart_set_symbol, chart_set_timeframe, chart_set_type and
// chart_set_visible_range, so each must pass the tool's own input schema and the checks its handler
// makes: a symbol that is not blank, a timeframe normalizeTimeframe reads as the same one, a chart
// type with a name (id 11 and any id the tools do not know have none), and a range of two times the
// tools take as they are, the earlier first.
export function restorabilityProblems(
  state: Pick<ChartState, 'symbol' | 'resolution' | 'chartType' | 'visibleRange'>,
): string[] {
  const problems: string[] = [];
  if (
    !accepts(chartSetSymbol.inputSchema, { symbol: state.symbol }) ||
    state.symbol.trim() === ''
  ) {
    problems.push(`chart_set_symbol does not take the symbol ${JSON.stringify(state.symbol)}`);
  }
  let timeframe: string | undefined;
  try {
    timeframe = normalizeTimeframe(state.resolution);
  } catch {
    timeframe = undefined;
  }
  if (
    !accepts(chartSetTimeframe.inputSchema, { timeframe: state.resolution }) ||
    timeframe === undefined ||
    !sameResolution(timeframe, state.resolution)
  ) {
    problems.push(
      `chart_set_timeframe does not take the timeframe ${JSON.stringify(state.resolution)}`,
    );
  }
  const type = CHART_TYPE_NAMES_BY_ID[String(state.chartType)];
  if (type === undefined || !accepts(chartSetType.inputSchema, { type })) {
    problems.push(`chart_set_type has no name for the chart type ${String(state.chartType)}`);
  }
  const range = state.visibleRange;
  if (range === null) {
    problems.push('the chart reports no visible range');
  } else if (
    !accepts(chartSetVisibleRange.inputSchema, { from: range.from, to: range.to }) ||
    !takenAsIs(range.from) ||
    !takenAsIs(range.to) ||
    !(range.from < range.to)
  ) {
    problems.push(
      `chart_set_visible_range does not take the range from ${String(range.from)} to ${String(range.to)}`,
    );
  }
  return problems;
}

// What snapshotChart throws for a chart it could not put back as it is.
export class UnrestorableChartError extends Error {
  constructor(readonly problems: string[]) {
    super(`The chart could not be put back as it is: ${problems.join('; ')}`);
    this.name = 'UnrestorableChartError';
  }
}

// What the chart shows, for restoreChart to put back. A state restoreChart could not put back is
// refused with UnrestorableChartError, before anything is changed.
export async function snapshotChart(client: Client, ctx: ToolContext): Promise<ChartSnapshot> {
  const state = await readChartState(client);
  const problems = restorabilityProblems(state);
  if (problems.length > 0 || state.visibleRange === null) {
    throw new UnrestorableChartError(problems);
  }
  const page = await ctx.connection.chartPage();
  const listing = await page.bridge.evaluate(readSymbolListing, []);
  return {
    symbol: state.symbol,
    listing:
      listing !== null && accepts(chartSetSymbol.inputSchema, { symbol: listing })
        ? listing
        : state.symbol,
    resolution: state.resolution,
    chartType: state.chartType,
    visibleRange: { from: state.visibleRange.from, to: state.visibleRange.to },
  };
}

// The listing the series of the active chart has resolved, the pro_name of its symbol info, or null
// when the series does not say (while a symbol loads, or for one that does not exist). It only
// reads.
export function readSymbolListing(win: TvWindow): string | null {
  try {
    const info = win.TradingViewApi?.activeChart()._chartWidget?.model().mainSeries().symbolInfo();
    const listing = info?.pro_name;
    return typeof listing === 'string' && listing.trim() !== '' ? listing : null;
  } catch {
    return null;
  }
}

// The members of the active chart the chart tools use, through the chart API and the time scale,
// that the page lacks. Without one, a tool would fall back to clicks and typing in the interface,
// or have no way at all, so a suite that finds any missing does not run. It only reads.
export function missingChartMembers(win: TvWindow): string[] {
  const missing: string[] = [];
  let chart: Partial<ChartWidgetApiLike> | undefined;
  try {
    chart = win.TradingViewApi?.activeChart();
  } catch {
    chart = undefined;
  }
  const api = [
    'symbol',
    'resolution',
    'chartType',
    'getVisibleRange',
    'setSymbol',
    'setResolution',
    'setChartType',
  ] as const;
  for (const name of api) {
    if (typeof chart?.[name] !== 'function') {
      missing.push(`activeChart().${name}`);
    }
  }
  let scale: Partial<TimeScaleLike> | undefined;
  let bars: Partial<BarsLike> | undefined;
  try {
    const model = chart?._chartWidget?.model();
    scale = model?.model().timeScale();
    bars = model?.mainSeries().bars();
  } catch {
    scale = undefined;
  }
  if (typeof scale?.zoomToBarsRange !== 'function') {
    missing.push('timeScale().zoomToBarsRange');
  }
  for (const name of ['firstIndex', 'lastIndex', 'valueAt'] as const) {
    if (typeof bars?.[name] !== 'function') {
      missing.push(`bars().${name}`);
    }
  }
  return missing;
}

export async function findMissingChartMembers(ctx: ToolContext): Promise<string[]> {
  const page = await ctx.connection.chartPage();
  return page.bridge.evaluate(missingChartMembers, []);
}

// Puts the chart back as `snapshot` describes it, through the tools: the symbol (by its listing),
// the timeframe and the chart type where they differ, and the visible range always, since a new
// symbol or timeframe moves the view as well. Every step is tried even when an earlier one fails,
// and the failures are thrown together at the end.
export async function restoreChart(client: Client, snapshot: ChartSnapshot): Promise<void> {
  const failures: string[] = [];
  const step = async (name: string, args: Record<string, unknown>): Promise<void> => {
    try {
      await callOk(client, name, args);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  };
  let state: ChartState | undefined;
  try {
    state = await readChartState(client);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  if (state?.symbol !== snapshot.symbol) {
    await step('chart_set_symbol', { symbol: snapshot.listing });
  }
  if (state?.resolution !== snapshot.resolution) {
    await step('chart_set_timeframe', { timeframe: snapshot.resolution });
  }
  if (state?.chartType !== snapshot.chartType) {
    const type = CHART_TYPE_NAMES_BY_ID[String(snapshot.chartType)];
    if (type === undefined) {
      failures.push(`The chart type ${String(snapshot.chartType)} has no name to restore it by`);
    } else {
      await step('chart_set_type', { type });
    }
  }
  await step('chart_set_visible_range', {
    from: snapshot.visibleRange.from,
    to: snapshot.visibleRange.to,
  });
  if (failures.length > 0) {
    throw new Error(`The chart could not be restored: ${failures.join('; ')}`);
  }
}

// The index of the time point of the active chart nearest to each time, by the times the chart
// reports for them, including the points of the empty space after the last bar; null for each
// time when the chart cannot say. It only reads.
export function nearestTimePoints(win: TvWindow, times: number[]): (number | null)[] {
  const chart = win.TradingViewApi?.activeChart();
  const range = chart?._chartWidget?.model().model().timeScale().points?.().range().value();
  if (
    chart === undefined ||
    typeof chart._convertIndexToPublicTime !== 'function' ||
    range === null ||
    range === undefined
  ) {
    return times.map(() => null);
  }
  const timeAt = (index: number): number => chart._convertIndexToPublicTime?.(index) ?? Number.NaN;
  return times.map((time) => {
    let low = range.firstIndex;
    let high = range.lastIndex;
    if (!(time > timeAt(low))) {
      return low;
    }
    if (!(time < timeAt(high))) {
      return high;
    }
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (timeAt(middle) < time) {
        low = middle;
      } else {
        high = middle;
      }
    }
    return time - timeAt(low) <= timeAt(high) - time ? low : high;
  });
}

// How many time points apart the two ends of two ranges are, by the time scale of the chart.
export async function barDistance(
  ctx: ToolContext,
  actual: { from: number; to: number },
  expected: { from: number; to: number },
): Promise<{ from: number; to: number }> {
  const page = await ctx.connection.chartPage();
  const [actualFrom, actualTo, expectedFrom, expectedTo] = await page.bridge.evaluate(
    nearestTimePoints,
    [[actual.from, actual.to, expected.from, expected.to]],
  );
  if (actualFrom == null || actualTo == null || expectedFrom == null || expectedTo == null) {
    throw new Error('The time scale of the chart could not map the ranges to bars');
  }
  return { from: Math.abs(actualFrom - expectedFrom), to: Math.abs(actualTo - expectedTo) };
}

interface ExactTimeScale {
  width(): number;
  rightOffset(): number;
  logicalRange(): { left(): number; right(): number } | null;
  setBarSpacing(spacing: number): void;
  setRightOffset(offset: number): void;
}

// The view in the time scale's own terms: the bars it spans from edge to edge (the logical range,
// fractional) and how many bars it reaches past the last one (the right offset). Unlike a range of
// whole bars, these fix the view exactly. It only reads.
export function readView(
  win: TvWindow,
): { left: number; right: number; rightOffset: number } | null {
  const scale = win.TradingViewApi?.activeChart()._chartWidget?.model().model().timeScale() as
    Partial<ExactTimeScale> | undefined;
  const range = typeof scale?.logicalRange === 'function' ? scale.logicalRange() : null;
  if (range === null || typeof scale?.rightOffset !== 'function') {
    return null;
  }
  return { left: range.left(), right: range.right(), rightOffset: scale.rightOffset() };
}

// Derived from the page function, because a page function may only return a JSON type, which an
// interface is not.
export type ViewSnapshot = NonNullable<ReturnType<typeof readView>>;

// Puts the same bars back from edge to edge. The time scale spans width / barSpacing - 1 bars (seen
// on the app), so the bar spacing is worked out from the width the pane has now: TradingView can
// resize the price axis while a suite runs (after a change of symbol), and the bar spacing read
// before would then show other bars on a pane of another width. On a pane that kept its width this
// is the bar spacing it had.
export function applyView(win: TvWindow, view: ViewSnapshot): boolean {
  const scale = win.TradingViewApi?.activeChart()._chartWidget?.model().model().timeScale() as
    Partial<ExactTimeScale> | undefined;
  if (
    typeof scale?.width !== 'function' ||
    typeof scale.setBarSpacing !== 'function' ||
    typeof scale.setRightOffset !== 'function'
  ) {
    return false;
  }
  scale.setBarSpacing(scale.width() / (view.right - view.left + 1));
  scale.setRightOffset(view.rightOffset);
  return true;
}

export async function snapshotView(ctx: ToolContext): Promise<ViewSnapshot | null> {
  const page = await ctx.connection.chartPage();
  return page.bridge.evaluate(readView, []);
}

// Puts the view back exactly, once the tools have restored the symbol, the timeframe and the range.
export async function restoreView(ctx: ToolContext, view: ViewSnapshot): Promise<void> {
  const page = await ctx.connection.chartPage();
  if (!(await page.bridge.evaluate(applyView, [view]))) {
    throw new Error('The time scale of the chart cannot set its view on this build');
  }
}
