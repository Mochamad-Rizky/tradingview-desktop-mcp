import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { loadConfig } from '../../src/config/load.js';
import type { TvWindow } from '../../src/core/tv/tv-window.js';
import { createMcpServer } from '../../src/server.js';
import { CHART_TYPE_NAMES_BY_ID } from '../../src/tools/chart/mappers.js';
import type { ToolContext } from '../../src/tools/types.js';
import { callTool, connectInMemoryClient, textOf } from '../helpers/mcp-client.js';
import { quietLogger } from '../helpers/tool-context.js';

// The harness of the end-to-end suites, which drive the real TradingView Desktop of the person
// running them (design spec 10). They run only with TV_E2E=1, against the debug port of TV_CDP_HOST
// and TV_CDP_PORT (127.0.0.1:9222 by default).
//
// A suite may change only the symbol, the timeframe, the chart type and the visible range of the
// active chart. It snapshots them before its first test and restores them after its last one,
// whether its tests passed or not, and a test that changes more than one of them restores them
// itself as well. Restoring goes through the tools, so it is tested too; afterwards the zoom of the
// view is put back exactly through the time scale, because the tools set a range in whole bars.
// Nothing else of the app is touched: no drawing, indicator, alert, layout, Pine script, replay,
// watchlist or trading control, and the app is never reloaded, quit or started.

export function e2eEnabled(): boolean {
  return process.env.TV_E2E === '1';
}

export interface ChartSnapshot {
  symbol: string;
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

export async function snapshotChart(client: Client): Promise<ChartSnapshot> {
  const state = await readChartState(client);
  if (state.visibleRange === null) {
    throw new Error('The chart reports no visible range; wait until it has loaded its data');
  }
  return {
    symbol: state.symbol,
    resolution: state.resolution,
    chartType: state.chartType,
    visibleRange: { from: state.visibleRange.from, to: state.visibleRange.to },
  };
}

// Puts the chart back as `snapshot` describes it, through the tools: the symbol, the timeframe and
// the chart type where they differ, and the visible range always, since a new symbol or timeframe
// moves the view as well. Every step is tried even when an earlier one fails, and the failures are
// thrown together at the end.
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
    await step('chart_set_symbol', { symbol: snapshot.symbol });
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
  barSpacing(): number;
  rightOffset(): number;
  setBarSpacing(spacing: number): void;
  setRightOffset(offset: number): void;
}

// The zoom of the view in the time scale's own terms: the width of a bar in pixels and how many
// bars the last bar stands left of the right edge. Together they fix the view exactly, where a
// range in bars only fixes it to the nearest bar. It only reads.
export function readView(win: TvWindow): { barSpacing: number; rightOffset: number } | null {
  const scale = win.TradingViewApi?.activeChart()._chartWidget?.model().model().timeScale() as
    Partial<ExactTimeScale> | undefined;
  if (typeof scale?.barSpacing !== 'function' || typeof scale.rightOffset !== 'function') {
    return null;
  }
  return { barSpacing: scale.barSpacing(), rightOffset: scale.rightOffset() };
}

// Derived from the page function, because a page function may only return a JSON type, which an
// interface is not.
export type ViewSnapshot = NonNullable<ReturnType<typeof readView>>;

export function applyView(win: TvWindow, view: ViewSnapshot): boolean {
  const scale = win.TradingViewApi?.activeChart()._chartWidget?.model().model().timeScale() as
    Partial<ExactTimeScale> | undefined;
  if (typeof scale?.setBarSpacing !== 'function' || typeof scale.setRightOffset !== 'function') {
    return false;
  }
  scale.setBarSpacing(view.barSpacing);
  scale.setRightOffset(view.rightOffset);
  return true;
}

export async function snapshotView(ctx: ToolContext): Promise<ViewSnapshot | null> {
  const page = await ctx.connection.chartPage();
  return page.bridge.evaluate(readView, []);
}

// Puts the zoom back exactly, once the tools have restored the symbol, the timeframe and the range.
export async function restoreView(ctx: ToolContext, view: ViewSnapshot): Promise<void> {
  const page = await ctx.connection.chartPage();
  if (!(await page.bridge.evaluate(applyView, [view]))) {
    throw new Error('The time scale of the chart cannot set its zoom on this build');
  }
}
