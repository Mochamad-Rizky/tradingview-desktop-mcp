import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';
import { loadConfig } from '../../src/config/load.js';
import type { PageLib } from '../../src/core/tv/page-lib.js';
import type {
  BarsLike,
  ChartWidgetApiLike,
  TimeScaleLike,
  TvWindow,
} from '../../src/core/tv/tv-window.js';
import { getPlanLimits, type PlanFeature } from '../../src/core/tv/plan-limits.js';
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
import { pageWaitMs } from '../../src/tools/chart/strategies.js';
import { ensureEditorOpen, readEditorState } from '../../src/tools/pine/editor.js';
import {
  closePineEditor,
  readPineSource,
  readSavedPineScripts,
  type PineEditorState,
  type SavedScriptRow,
} from '../../src/tools/pine/page.js';
import {
  isOpenLimited,
  savedScriptLimit,
  type SavedScriptLimit,
} from '../../src/tools/pine/scripts.js';
import type { ToolContext } from '../../src/tools/types.js';
import type { JsonValue } from '../../src/utils/json.js';
import { pollUntil } from '../../src/utils/poll.js';
import { parseTimeInput } from '../../src/utils/time.js';
import { callTool, connectInMemoryClient } from '../helpers/mcp-client.js';
import { quietLogger } from '../helpers/tool-context.js';

// The harness of the end-to-end suites, which drive the real TradingView Desktop of the person
// running them (design spec 10). They run only with TV_E2E=1, against the debug port of TV_CDP_HOST
// and TV_CDP_PORT (127.0.0.1:9222 by default).
//
// A suite may change the symbol, the timeframe, the chart type and the visible range of the active
// chart, and load older history into it. Before it changes anything it checks, by reading only,
// that the chart API has what the tools use (so that no tool falls back to clicks or typing) and
// that the chart can be put back as it is (restorabilityProblems), and it skips its tests when
// either fails. It snapshots the four before its first test and restores them after every test and
// after its last one, whether the tests passed or not. Restoring goes through the tools, so it is
// tested too; afterwards the view is put back exactly through the time scale (the same bars from
// edge to edge), because the tools set a range in whole bars.
//
// The suites of Plan 2 also use the Pine Editor, under the guard below (snapshotEditor and
// restoreEditor): only while it holds no unsaved changes, and it is put back afterwards, the script
// it showed open again and the editor closed again when it was closed. Indicators and scripts are
// added only within the plan limits (planLimitSkipReason) and removed again by the test that added
// them. Nothing else of the app is touched: no drawing, indicator or saved script of the user, no
// alert, layout, replay, watchlist or trading control, nothing is saved, and the app is never
// reloaded, quit or started.

export function e2eEnabled(): boolean {
  return process.env.TV_E2E === '1';
}

// What a run may leave behind only when the person running it allows it, each by setting its
// variable to 1 (docs/testing.md):
// - TV_E2E_ALLOW_DRAFTS: the tests that add a script from the Pine Editor to the chart, which
//   TradingView keeps in the account as a server draft (version 0.x) that no tool deletes;
// - TV_E2E_ALLOW_EDITOR_TEXT: the test that closes the Pine Editor on unsaved text of its own,
//   which TradingView keeps for the next open, so that a run cut short leaves the editor reopening
//   on that text.
export type E2eOptIn = 'TV_E2E_ALLOW_DRAFTS' | 'TV_E2E_ALLOW_EDITOR_TEXT';

export function optedIn(name: E2eOptIn): boolean {
  return process.env[name] === '1';
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

// An error of the harness itself, whose message is a fixed text with tool names and error codes
// only: never a value of the user, such as the symbol of their chart, a price, a view or the name
// of a script, so that it can go into a skip reason, a log line or a failed test as it is.
export class HarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessError';
  }
}

// A tool call that failed, named by the tool and the code of its error. The message of a tool can
// name what the user has (chart_set_symbol names the symbol the chart went back to), so it is left
// out.
export class ToolCallError extends HarnessError {
  constructor(
    readonly tool: string,
    readonly code: string,
  ) {
    super(`${tool} failed with ${code}`);
    this.name = 'ToolCallError';
  }
}

// The code of the error a tool call answered, UNKNOWN when its envelope names none.
function errorCodeOf(result: Awaited<ReturnType<typeof callTool>>): string {
  const envelope = result.structuredContent as { error?: { code?: unknown } } | undefined;
  return typeof envelope?.error?.code === 'string' ? envelope.error.code : 'UNKNOWN';
}

// What a failure was, for a skip reason, a log line or an error to throw: the text of an error of
// the harness, which holds no value; for any other error its code, or else its kind. Never the
// message of another error, which can quote a tool or the page, and so what the user has.
export function describeFailure(error: unknown): string {
  if (error instanceof HarnessError) {
    return error.message;
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code !== '') {
    return `an error with code ${code}`;
  }
  return error instanceof Error ? `an unexpected ${error.name}` : 'an unexpected error';
}

// How a tool call ended: null when it succeeded; else the tool and the code of its error, or that
// the call itself threw (the transport broke). Never the text of either.
async function callFailureOf(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  let result: Awaited<ReturnType<typeof callTool>>;
  try {
    result = await callTool(client, name, args);
  } catch {
    return `${name} could not be called`;
  }
  return result.isError === true ? `${name} failed with ${errorCodeOf(result)}` : null;
}

export interface ToolSuccess<T> {
  data: T;
  via: string | undefined;
  warnings: string[];
}

// The data of a successful tool call. A failure throws a ToolCallError, which says which tool
// failed with which code, and not what the tool said, which can name what the user has.
export async function callOk<T>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolSuccess<T>> {
  const result = await callTool(client, name, args);
  const envelope = result.structuredContent as Envelope | undefined;
  if (result.isError === true || envelope?.ok !== true) {
    throw new ToolCallError(name, errorCodeOf(result));
  }
  return {
    data: envelope.data as T,
    via: envelope.meta.via,
    warnings: envelope.meta.warnings ?? [],
  };
}

// The error of a tool call that failed, as its envelope gives it.
export interface ToolFailure {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

// The error of a tool call that is expected to fail. A call that succeeds throws, without its data,
// which can hold what the user has.
export async function callFailure(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolFailure> {
  const result = await callTool(client, name, args);
  const envelope = result.structuredContent as { ok?: boolean; error?: ToolFailure } | undefined;
  if (result.isError !== true || envelope?.ok !== false || envelope.error === undefined) {
    throw new Error(`${name} was expected to fail, but it succeeded`);
  }
  return envelope.error;
}

// Prints what a suite saw of the app, to compare with the reverse-engineering notes after a
// TradingView update: key names, types, counts and booleans only, never a value of the user's (no
// symbol, price, name, id or text).
export function observe(name: string, facts: JsonValue): void {
  console.info(`observed ${name}: ${JSON.stringify(facts)}`);
}

// Why a test that needs room under a plan limit cannot run, or null when it can. `used` is how much
// of the feature the account already uses and `needed` how much the test adds, so a suite that adds
// two indicators to a chart that has two on a plan of three is skipped, instead of running into the
// paywall of the app. A limit the app does not report gives no reason to skip: the tool under test
// then refuses on its own (NOT_AVAILABLE) wherever nothing else tells it that there is room (for
// indicators, the check of the chart model can), so that no dialog of the app opens.
export async function planLimitSkipReason(
  client: Client,
  feature: PlanFeature,
  used: number,
  needed: number,
): Promise<string | null> {
  const { data } = await callOk<{ limits: Record<PlanFeature, number | null> }>(
    client,
    'app_get_plan_limits',
  );
  const limit = data.limits[feature];
  if (typeof limit !== 'number' || used + needed <= limit) {
    return null;
  }
  return (
    `The plan allows ${String(limit)} of ${feature} (limit of ${String(limit)}), ${String(used)} ` +
    `in use and the test needs ${String(needed)} more`
  );
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
// tools take as they are, the earlier first. A reason names the part, never its value, which is the
// user's: it becomes the skip reason of a suite.
export function restorabilityProblems(
  state: Pick<ChartState, 'symbol' | 'resolution' | 'chartType' | 'visibleRange'>,
): string[] {
  const problems: string[] = [];
  if (
    !accepts(chartSetSymbol.inputSchema, { symbol: state.symbol }) ||
    state.symbol.trim() === ''
  ) {
    problems.push('chart_set_symbol would not take the symbol the chart shows');
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
    problems.push('chart_set_timeframe would not take the timeframe the chart shows');
  }
  const type = CHART_TYPE_NAMES_BY_ID[String(state.chartType)];
  if (type === undefined || !accepts(chartSetType.inputSchema, { type })) {
    problems.push('chart_set_type has no name for the chart type the chart shows');
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
    problems.push('chart_set_visible_range would not take the visible range the chart shows');
  }
  return problems;
}

// What snapshotChart throws for a chart it could not put back as it is.
export class UnrestorableChartError extends HarnessError {
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
// symbol or timeframe moves the view as well, once the chart has bars again. Every step is tried
// even when an earlier one fails, and the failures are thrown together at the end, as a
// HarnessError that names each failed step by its tool and code only.
export async function restoreChart(client: Client, snapshot: ChartSnapshot): Promise<void> {
  const failures: string[] = [];
  const step = async (name: string, args: Record<string, unknown>): Promise<void> => {
    const failure = await callFailureOf(client, name, args);
    if (failure !== null) {
      failures.push(failure);
    }
  };
  let state: ChartState | undefined;
  try {
    state = await readChartState(client);
  } catch (error) {
    failures.push(
      error instanceof HarnessError ? error.message : 'chart_get_state could not be called',
    );
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
  // After a change of symbol, timeframe or chart type the series loads again, and a range can be
  // set only on bars: they are waited for, for a while.
  await pollUntil(
    () => callTool(client, 'data_get_ohlcv', { count: 1 }),
    (result) => result.isError !== true,
    { intervalMs: 200, timeoutMs: 15_000 },
  );
  await step('chart_set_visible_range', {
    from: snapshot.visibleRange.from,
    to: snapshot.visibleRange.to,
  });
  if (failures.length > 0) {
    throw new HarnessError(`The chart could not be restored: ${failures.join('; ')}`);
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
    throw new HarnessError('The time scale of the chart cannot set its view on this build');
  }
}

// What a suite that changes the chart found before its first test: the snapshot and the exact view
// to put back, or why it must not change the chart, in which case it changes nothing.
export interface ChartChangePlan {
  snapshot: ChartSnapshot | undefined;
  view: ViewSnapshot | null;
  skipReason: string | undefined;
}

// Reads, before the first change, that the chart API has every member the chart tools use and that
// the chart can be put back as it is, then takes the snapshot and the view. Either check failing
// gives the reason to skip, and nothing has been changed.
export async function prepareChartChange(e2e: E2eServer): Promise<ChartChangePlan> {
  const missing = await findMissingChartMembers(e2e.ctx);
  if (missing.length > 0) {
    return {
      snapshot: undefined,
      view: null,
      skipReason:
        `The chart API lacks ${missing.join(', ')}, so the tools would fall back to clicks and ` +
        'typing; nothing was changed.',
    };
  }
  let snapshot: ChartSnapshot;
  try {
    snapshot = await snapshotChart(e2e.client, e2e.ctx);
  } catch (error) {
    if (error instanceof UnrestorableChartError) {
      return {
        snapshot: undefined,
        view: null,
        skipReason: `${error.message}; nothing was changed.`,
      };
    }
    throw error;
  }
  return { snapshot, view: await snapshotView(e2e.ctx), skipReason: undefined };
}

// Puts the chart back after the last test: through the tools, then the exact view, each tried
// whatever the other did. Answers the failures, for the suite to throw once its server is closed.
export async function restoreChartAndView(
  e2e: E2eServer,
  plan: ChartChangePlan,
): Promise<string[]> {
  const failures: string[] = [];
  if (plan.snapshot === undefined) {
    return failures;
  }
  try {
    await restoreChart(e2e.client, plan.snapshot);
  } catch (error) {
    failures.push(describeFailure(error));
  }
  if (plan.view !== null) {
    try {
      await restoreView(e2e.ctx, plan.view);
    } catch (error) {
      failures.push(describeFailure(error));
    }
  }
  return failures;
}

// Runs `change` and restores the chart first thing after it, however it ended. A restore that
// fails after a failed test does not hide that test's own failure: the failure is thrown and the
// restore's failure is logged next to it, by its steps and codes only (describeFailure). After a
// test that passed, a failed restore fails it.
export async function changeThenRestore(
  client: Client,
  snapshot: ChartSnapshot,
  change: () => Promise<void>,
): Promise<void> {
  let failure: unknown;
  let failed = false;
  try {
    await change();
  } catch (error) {
    failure = error;
    failed = true;
  }
  try {
    await restoreChart(client, snapshot);
  } catch (restoreError) {
    if (!failed) {
      throw restoreError;
    }
    console.error(
      `The chart could not be restored after a failed test: ${describeFailure(restoreError)}`,
    );
  }
  if (failed) {
    throw failure;
  }
}

// A study as indicator_list gives it, as far as the cleanup below reads it.
export interface ListedStudy {
  id: string;
  name: string;
}

// The chart a test that adds studies works on: the chart that was active when it started, by its
// index, and the layout it is in, by its id, which stays in memory because it is the user's. The
// cleanup lists and removes studies on that chart only, and only while it is still the active chart
// of that layout, so that it never compares the studies of two charts.
export interface StudyScope {
  chartIndex: number;
  layoutId: string | null;
}

// The scope of the active chart now. An index that cannot be read leaves nothing to pin the
// cleanup to, so it fails, before the test changes anything.
export async function readStudyScope(client: Client): Promise<StudyScope> {
  const { data } = await callOk<{ chartIndex: number | null; layout: { id: string | null } }>(
    client,
    'chart_get_state',
  );
  if (data.chartIndex === null) {
    throw new HarnessError(
      'chart_get_state reports no index for the active chart, so the test would not know which ' +
        'chart to clean up; nothing was changed',
    );
  }
  return { chartIndex: data.chartIndex, layoutId: data.layout.id };
}

// The studies on the chart of `scope`.
export async function listScopedStudies(client: Client, scope: StudyScope): Promise<ListedStudy[]> {
  return (
    await callOk<{ studies: ListedStudy[] }>(client, 'indicator_list', {
      chartIndex: scope.chartIndex,
    })
  ).data.studies;
}

// The studies a test may have left on the chart: those on it now that were not on it before and
// whose name says the test added them. A call that failed halfway, adding a study and then failing
// to answer its id, leaves one. A study that was on the chart before is never among them, whatever
// its name: it is the user's.
export function strayStudies(
  before: readonly string[],
  now: readonly ListedStudy[],
  isAdded: (name: string) => boolean,
): string[] {
  const kept = new Set(before);
  return now.filter(({ id, name }) => !kept.has(id) && isAdded(name)).map(({ id }) => id);
}

// How long the cleanup after a failed test lists the studies again for one that comes late, as
// TradingView can add a study after the call that asked for it gave up (TIMEOUT).
const LATE_STUDY_WAIT_MS = 3000;
const LATE_STUDY_POLL_MS = 250;

// Removes the studies strayStudies finds on the chart of `scope`, each with confirm: true, because
// the session may not have recorded a study that a call added before it failed. It removes nothing,
// and says why, when the active chart or its layout is no longer the one of `scope`, and when more
// studies look added than the test could have added (`most`, 1 by default), since one of them would
// then be the user's. With `waitMs` it lists again, for that long, while it finds none, for a study
// that comes late. Answers the ids removed and the failures, which name tools, codes and counts
// only.
export async function removeStrayStudies(
  client: Client,
  scope: StudyScope,
  before: readonly string[],
  isAdded: (name: string) => boolean,
  options: { most?: number; waitMs?: number } = {},
): Promise<{ removed: string[]; failures: string[] }> {
  const most = options.most ?? 1;
  let strays: string[];
  try {
    const now = await readStudyScope(client);
    if (now.chartIndex !== scope.chartIndex || now.layoutId !== scope.layoutId) {
      return {
        removed: [],
        failures: [
          'The active chart or its layout changed during the test, so no study was removed: ' +
            'check the chart in TradingView',
        ],
      };
    }
    const found = await pollUntil(
      async () => strayStudies(before, await listScopedStudies(client, scope), isAdded),
      (ids) => ids.length > 0,
      { intervalMs: LATE_STUDY_POLL_MS, timeoutMs: options.waitMs ?? 0 },
    );
    strays = found.last;
  } catch (error) {
    return { removed: [], failures: [describeFailure(error)] };
  }
  if (strays.length > most) {
    return {
      removed: [],
      failures: [
        `${String(strays.length)} new studies have the name the test adds, more than the ` +
          `${String(most)} it could have added, so none was removed: check the chart in ` +
          'TradingView',
      ],
    };
  }
  const removed: string[] = [];
  const failures: string[] = [];
  for (const id of strays) {
    const failure = await callFailureOf(client, 'indicator_remove', {
      id,
      confirm: true,
      chartIndex: scope.chartIndex,
    });
    if (failure === null) {
      removed.push(id);
    } else {
      failures.push(failure);
    }
  }
  return { removed, failures };
}

// Runs `change`, a test that adds one study (`isAdded` tells it by name), within the chart snapshot
// of `plan`. The chart it works on is pinned first (readStudyScope), and its studies are listed.
// However the change ended, every study it left there is removed (removeStrayStudies, which after a
// failed change waits a while for a study that comes late), then the chart and its exact view are
// put back (restoreChartAndView), each step whatever the other did. The failure of `change` is the
// one thrown, with a failed cleanup logged next to it; after a change that passed, a failed cleanup
// fails it.
export async function addThenCleanUp(
  e2e: E2eServer,
  plan: ChartChangePlan,
  isAdded: (name: string) => boolean,
  change: () => Promise<void>,
): Promise<void> {
  const scope = await readStudyScope(e2e.client);
  const before = (await listScopedStudies(e2e.client, scope)).map(({ id }) => id);
  let failure: unknown;
  let failed = false;
  try {
    await change();
  } catch (error) {
    failure = error;
    failed = true;
  }
  const { failures } = await removeStrayStudies(e2e.client, scope, before, isAdded, {
    waitMs: failed ? LATE_STUDY_WAIT_MS : 0,
  });
  failures.push(...(await restoreChartAndView(e2e, plan)));
  if (failed) {
    if (failures.length > 0) {
      console.error(`The test could not clean up after it failed: ${failures.join('; ')}`);
    }
    throw failure;
  }
  if (failures.length > 0) {
    throw new HarnessError(`The test could not clean up: ${failures.join('; ')}`);
  }
}

// The chart shows what the snapshot says again, its range within one bar of the one it had. The
// comparisons say which part differs, never its value, which is the user's.
export async function expectChartRestored(e2e: E2eServer, snapshot: ChartSnapshot): Promise<void> {
  const state = await readChartState(e2e.client);
  expect(state.symbol === snapshot.symbol, 'the symbol is back').toBe(true);
  expect(state.resolution === snapshot.resolution, 'the timeframe is back').toBe(true);
  expect(state.chartType === snapshot.chartType, 'the chart type is back').toBe(true);
  expect(state.visibleRange, 'the chart reports a visible range').not.toBeNull();
  if (state.visibleRange !== null) {
    const distance = await barDistance(e2e.ctx, state.visibleRange, snapshot.visibleRange);
    expect(distance.from).toBeLessThanOrEqual(1);
    expect(distance.to).toBeLessThanOrEqual(1);
  }
}

// What the Pine Editor shows, for a suite that changes it to put it back: its state as the tools
// read it, whether its own text differs from the text of its script (isModified() of the facade;
// the state also counts the flag of unsaved changes the app keeps, which lags while the editor is
// open), whether it is on screen (null when the page cannot say), and its text, which is kept in
// memory to compare and never printed or logged, because it is the user's (null while no editor is
// open or the text cannot be read).
export interface EditorSnapshot {
  state: PineEditorState;
  ownModified: boolean | null;
  visible: boolean | null;
  source: string | null;
}

// isModified() of the facade of the open editor, or null without one or an answer. It only reads.
export function readEditorOwnModified(_win: TvWindow, lib: PageLib): boolean | null {
  try {
    const getOpen = lib.findExport('getOpenPineEditor') as
      ((placement: string) => { getFacade(): { isModified?: () => unknown } | null } | null) | null;
    for (const placement of ['dialog', 'bottom']) {
      const entry = getOpen?.(placement);
      if (entry !== null && entry !== undefined) {
        const modified = entry.getFacade()?.isModified?.();
        return typeof modified === 'boolean' ? modified : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Whether the Pine Editor is on screen as the side panel, by the export pineDialogOpenState of the
// app (isVisibleWV), or null when the page does not say. It only reads.
export function readEditorVisibility(_win: TvWindow, lib: PageLib): boolean | null {
  try {
    const open = lib.findExport('pineDialogOpenState') as {
      isVisibleWV?: () => { value(): unknown };
    } | null;
    const visible = open?.isVisibleWV?.().value();
    return typeof visible === 'boolean' ? visible : null;
  } catch {
    return null;
  }
}

export async function snapshotEditor(ctx: ToolContext): Promise<EditorSnapshot> {
  const page = await ctx.connection.chartPage();
  const state = await readEditorState(page);
  const ownModified = await page.bridge.evaluateWithLib(readEditorOwnModified, []);
  const visible = await page.bridge.evaluateWithLib(readEditorVisibility, []);
  let source: string | null = null;
  if (state.open) {
    try {
      source = (await page.bridge.evaluateWithLib(readPineSource, [])).source;
    } catch {
      source = null;
    }
  }
  return { state, ownModified, visible, source };
}

// The script the side panel of the Pine Editor last held, as the app keeps it for its next open
// (last_edited_script, with has_unsaved_modifications, both stored under the name of the account),
// read for its id and version only: the name, the text and the account stay in the page. null when
// the app keeps none, or keeps it for several accounts, so that it cannot tell which is this one.
// script is null for a new script, and unsaved whether the app keeps unsaved changes of it. It
// only reads.
export function readLastEditedScript(win: TvWindow): {
  script: { id: string; version: string | null } | null;
  unsaved: boolean | null;
} | null {
  const only = (key: string): unknown => {
    try {
      const storage = (win as unknown as { localStorage?: { getItem(key: string): unknown } })
        .localStorage;
      const raw = storage?.getItem(key);
      const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : null;
      const values: unknown[] =
        typeof parsed === 'object' && parsed !== null ? Object.values(parsed) : [];
      return values.length === 1 ? values[0] : undefined;
    } catch {
      return undefined;
    }
  };
  const kept = only('last_edited_script');
  if (typeof kept !== 'object' || kept === null) {
    return null;
  }
  const last = kept as { scriptIdPart?: unknown; version?: unknown };
  const unsaved = only('has_unsaved_modifications');
  const id = last.scriptIdPart;
  const version = last.version;
  return {
    script:
      typeof id === 'string' && id !== ''
        ? { id, version: typeof version === 'string' && version !== '' ? version : null }
        : null,
    unsaved: typeof unsaved === 'boolean' ? unsaved : null,
  };
}

export async function findLastEditedScript(ctx: ToolContext) {
  const page = await ctx.connection.chartPage();
  return page.bridge.evaluate(readLastEditedScript, []);
}

// Opens the editor the way the Pine button of the toolbar does (the server's own ensureEditorOpen).
// Seen on the app: the first open of a session shows the script the editor last held; after the
// editor was closed, an open shows a new script instead, unless the last one has unsaved changes,
// which the app always shows again.
export async function openEditor(ctx: ToolContext): Promise<void> {
  const page = await ctx.connection.chartPage();
  await ensureEditorOpen(page, pageWaitMs(ctx.config.callTimeoutMs));
}

// Closes the editor through the close path of the server (closePineEditor). Seen on the app: the
// side panel goes, and the editor leaves the registry of open editors.
export async function closeEditor(
  ctx: ToolContext,
): Promise<{ closed: boolean; placement: string | null }> {
  const page = await ctx.connection.chartPage();
  return page.bridge.evaluateWithLib(closePineEditor, []);
}

const sameScript = (a: PineEditorState['script'], b: PineEditorState['script']): boolean =>
  a === null || b === null ? a === b : a.id === b.id && a.version === b.version;

// What a suite puts back in the editor after its tests: a script (null for a new one), shown
// without unsaved changes, and its text when it is known (null when only the id is: the script the
// editor last held while it was closed, which the app keeps by id). Of a new script the text only
// tells its type: TradingView writes its template anew each time, so the text can differ (seen on
// the app), and an unchanged template holds nothing of the user's.
export interface EditorTarget {
  script: PineEditorState['script'];
  source: string | null;
}

// Which parts of `target` the editor does not show now: the script (id and version), no unsaved
// changes of its own text, and the text of a saved script when the target has it. Empty when it
// shows all of it. The flag of unsaved changes the app keeps is not asked: it is written when the
// editor closes, so after a test it can still be set while the editor shows the target, and the
// suites check it once the editor is closed again.
export function editorDifferences(now: EditorSnapshot, target: EditorTarget): string[] {
  const parts: string[] = [];
  if (!sameScript(now.state.script, target.script)) {
    parts.push('script');
  }
  if (now.ownModified ?? now.state.modified) {
    parts.push('modified');
  }
  if (target.script !== null && target.source !== null && now.source !== target.source) {
    parts.push('text');
  }
  return parts;
}

// Why pine_open could not show a saved script again after a test replaced it, one reason each, or
// none: the saved scripts (readSavedPineScripts) must have it at its version, which pine_open opens,
// and the plan must let TradingView open it (only the `limit` most recently changed saved scripts
// can be), which a limit that applies but cannot be read leaves unknown. A new script (null) needs
// none of this: pine_new starts its template again.
export function editorReopenProblems(
  script: PineEditorState['script'],
  saved: readonly SavedScriptRow[],
  limit: SavedScriptLimit,
): string[] {
  if (script === null) {
    return [];
  }
  const row = saved.find(({ scriptIdPart }) => scriptIdPart === script.id);
  if (row === undefined) {
    return ['pine_open would not find the script among the saved scripts'];
  }
  const problems: string[] = [];
  if (script.version === null || row.version !== script.version) {
    problems.push('pine_open would open another version of the script than the one shown');
  }
  if (limit === 'unreadable') {
    problems.push(
      'the saved-script limit of the plan cannot be read, so whether TradingView opens the script ' +
        'again is not known',
    );
  } else if (isOpenLimited(saved, script.id, limit)) {
    problems.push(
      `the plan lets TradingView open only the ${String(limit)} most recently changed saved scripts`,
    );
  }
  return problems;
}

export async function findEditorReopenProblems(
  ctx: ToolContext,
  script: PineEditorState['script'],
): Promise<string[]> {
  if (script === null) {
    return [];
  }
  const page = await ctx.connection.chartPage();
  const listing = await page.bridge.evaluateWithLib(readSavedPineScripts, []);
  const limits = await getPlanLimits(page, ['SAVED_PINE_SCRIPTS']);
  return editorReopenProblems(
    script,
    listing.scripts,
    savedScriptLimit(listing, limits.SAVED_PINE_SCRIPTS),
  );
}

// The type of the new script whose template `source` is, by its declaration, for pine_new to start
// the same one again.
export function templateType(source: string): 'indicator' | 'strategy' | 'library' {
  if (/^[ \t]*strategy[ \t]*\(/m.test(source)) {
    return 'strategy';
  }
  return /^[ \t]*library[ \t]*\(/m.test(source) ? 'library' : 'indicator';
}

// What came of putting the editor back: why it could not be (without any of its text or names;
// empty when it was), and, when a tool had to be called, what differed from the target right after
// the tool answered and how long the editor took to show it all.
export interface EditorRestore {
  problems: string[];
  differedAtFirst: string[] | null;
  waitedMs: number | null;
}

// Puts `target` back in the editor after a test changed it, through the tools: pine_open for a saved
// script, pine_new for the template of a new one. Only text the test wrote itself (`written`) may be
// discarded, so confirm: true is passed only while the editor holds such text; unsaved text of
// anyone else is left as it is. The editor is open while this runs. The editor can show what a tool
// did a moment after the tool answered, so it is read again until it shows the target, for at most
// the page wait.
export async function restoreEditor(
  client: Client,
  ctx: ToolContext,
  target: EditorTarget,
  written: ReadonlySet<string>,
): Promise<EditorRestore> {
  const now = await snapshotEditor(ctx);
  if (editorDifferences(now, target).length === 0) {
    return { problems: [], differedAtFirst: null, waitedMs: null };
  }
  if (now.state.modified && (now.source === null || !written.has(now.source))) {
    return {
      problems: [
        'The Pine Editor holds unsaved text this test did not write, so it was left as it is',
      ],
      differedAtFirst: null,
      waitedMs: null,
    };
  }
  const confirm = now.state.modified ? { confirm: true } : {};
  // Only the tool and the code of a failure are kept: the message of a Pine tool can name a saved
  // script of the user.
  const failure =
    target.script === null
      ? await callFailureOf(client, 'pine_new', {
          type: templateType(target.source ?? ''),
          ...confirm,
        })
      : await callFailureOf(client, 'pine_open', { scriptId: target.script.id, ...confirm });
  if (failure !== null) {
    return {
      problems: [`The Pine Editor could not be put back: ${failure}`],
      differedAtFirst: null,
      waitedMs: null,
    };
  }
  let differedAtFirst: string[] | null = null;
  const settled = await pollUntil(
    async () => {
      const parts = editorDifferences(await snapshotEditor(ctx), target);
      differedAtFirst ??= parts;
      return parts;
    },
    (parts) => parts.length === 0,
    { intervalMs: 100, timeoutMs: pageWaitMs(ctx.config.callTimeoutMs) },
  );
  return {
    problems: settled.satisfied
      ? []
      : [
          'The Pine Editor does not show the script it is to show again (it differs in ' +
            `${settled.last.join(', ')})`,
        ],
    differedAtFirst,
    waitedMs: settled.waitedMs,
  };
}
