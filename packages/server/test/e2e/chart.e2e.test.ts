import { sameSymbol } from '../../src/tools/chart/mappers.js';
import { callTool } from '../helpers/mcp-client.js';
import {
  barDistance,
  callOk,
  e2eEnabled,
  readChartState,
  restoreChart,
  restoreView,
  snapshotChart,
  snapshotView,
  startE2eServer,
  type ChartSnapshot,
  type E2eServer,
  type ViewSnapshot,
} from './setup.js';

// The chart tools against the real TradingView Desktop. The suite changes the symbol, the
// timeframe, the chart type and the visible range of the active chart, and nothing else. It takes
// a snapshot of them first and restores them after every test and after the last one, whatever
// the tests did (see setup.ts).

const TARGET_SYMBOL = 'NASDAQ:AAPL';
// No exchange lists this symbol.
const UNKNOWN_SYMBOL = 'NASDAQ:ZZZQQX1';

interface Range {
  from: number;
  to: number;
  fromIso: string;
  toIso: string;
}

interface SymbolResult {
  symbol: string | null;
  previous: string | null;
  changed: boolean | null;
}

interface ErrorEnvelope {
  ok: false;
  error: { code: string; message: string; details?: Record<string, unknown> };
}

describe.skipIf(!e2eEnabled())('the chart tools against TradingView Desktop', () => {
  let e2e: E2eServer | undefined;
  let snapshot: ChartSnapshot | undefined;
  let view: ViewSnapshot | null = null;

  beforeAll(async () => {
    e2e = await startE2eServer();
    snapshot = await snapshotChart(e2e.client);
    view = await snapshotView(e2e.ctx);
  });

  afterAll(async () => {
    if (e2e === undefined) {
      return;
    }
    try {
      if (snapshot !== undefined) {
        await restoreChart(e2e.client, snapshot);
        if (view !== null) {
          await restoreView(e2e.ctx, view);
        }
      }
    } finally {
      await e2e.close();
    }
  });

  function started(): { e2e: E2eServer; snapshot: ChartSnapshot } {
    if (e2e === undefined || snapshot === undefined) {
      throw new Error('The suite could not take a snapshot of the chart');
    }
    return { e2e, snapshot };
  }

  // The chart shows what the snapshot says again, its range within one bar of the one it had.
  async function expectRestored(): Promise<void> {
    const { e2e: server, snapshot: before } = started();
    const state = await readChartState(server.client);
    expect(state.symbol).toBe(before.symbol);
    expect(state.resolution).toBe(before.resolution);
    expect(state.chartType).toBe(before.chartType);
    expect(state.visibleRange).not.toBeNull();
    if (state.visibleRange !== null) {
      const distance = await barDistance(server.ctx, state.visibleRange, before.visibleRange);
      expect(distance.from).toBeLessThanOrEqual(1);
      expect(distance.to).toBeLessThanOrEqual(1);
    }
  }

  test('switches symbol and timeframe, then restores them', async () => {
    const { e2e: server, snapshot: before } = started();
    const timeframe = before.resolution === '60' ? '240' : '60';
    try {
      const switched = await callOk<SymbolResult>(server.client, 'chart_set_symbol', {
        symbol: TARGET_SYMBOL,
      });
      // TradingView may show the symbol through the exchange of its data feed, such as BATS:AAPL.
      expect(switched.data.symbol).toMatch(/:AAPL$/);
      expect(switched.via).toBe('api');
      expect(switched.warnings).toEqual([]);

      // The chart shows the symbol now, so asking again changes nothing.
      const again = await callOk<SymbolResult>(server.client, 'chart_set_symbol', {
        symbol: TARGET_SYMBOL,
      });
      expect(again.data).toMatchObject({ symbol: switched.data.symbol, changed: false });

      const changed = await callOk<{ resolution: string; changed: boolean }>(
        server.client,
        'chart_set_timeframe',
        { timeframe },
      );
      expect(changed.data).toMatchObject({ resolution: timeframe, changed: true });
      expect(changed.warnings).toEqual([]);

      const state = await readChartState(server.client);
      expect(sameSymbol('AAPL', state.symbol)).toBe(true);
      expect(state.resolution).toBe(timeframe);
      expect(state.visibleRange).not.toBeNull();
    } finally {
      await restoreChart(server.client, before);
    }
    await expectRestored();
  });

  test('changes chart type and restores it', async () => {
    const { e2e: server, snapshot: before } = started();
    try {
      for (const [type, id] of [
        ['candles', 1],
        ['line', 2],
        ['heikin_ashi', 8],
      ] as const) {
        const result = await callOk<{ chartType: number; chartTypeName: string }>(
          server.client,
          'chart_set_type',
          { type },
        );
        expect(result.data).toMatchObject({ chartType: id, chartTypeName: type });
        expect(result.warnings).toEqual([]);
        expect((await readChartState(server.client)).chartType).toBe(id);
      }
    } finally {
      await restoreChart(server.client, before);
    }
    await expectRestored();
  });

  test('sets and restores the visible range', async () => {
    const { e2e: server, snapshot: before } = started();
    const shown = (await callOk<Range>(server.client, 'chart_get_visible_range')).data;
    // A range inside the view, in its older half, where the chart has loaded bars.
    const width = shown.to - shown.from;
    const inner = {
      from: Math.round(shown.from + width * 0.15),
      to: Math.round(shown.from + width * 0.35),
    };
    try {
      const set = await callOk<Range>(server.client, 'chart_set_visible_range', inner);
      expect(set.via).toBe('internal');
      expect(set.warnings).toEqual([]);
      const reached = await barDistance(server.ctx, set.data, inner);
      expect(reached.from).toBeLessThanOrEqual(1);
      expect(reached.to).toBeLessThanOrEqual(1);
      expect((await callOk<Range>(server.client, 'chart_get_visible_range')).data).toEqual(
        set.data,
      );

      // The range read at the start goes back in as it came out, empty space after the last bar
      // included.
      const restored = await callOk<Range>(server.client, 'chart_set_visible_range', {
        from: shown.from,
        to: shown.to,
      });
      expect(restored.warnings).toEqual([]);
      const distance = await barDistance(server.ctx, restored.data, shown);
      expect(distance.from).toBeLessThanOrEqual(1);
      expect(distance.to).toBeLessThanOrEqual(1);
    } finally {
      await restoreChart(server.client, before);
    }
    await expectRestored();
  });

  test('reports an unknown symbol and switches the chart back', async () => {
    const { e2e: server, snapshot: before } = started();
    try {
      const result = await callTool(server.client, 'chart_set_symbol', { symbol: UNKNOWN_SYMBOL });

      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as unknown as ErrorEnvelope;
      expect(error.code).toBe('INVALID_INPUT');
      expect(error.details).toMatchObject({ requested: UNKNOWN_SYMBOL, kept: before.symbol });
      expect((await readChartState(server.client)).symbol).toBe(before.symbol);
    } finally {
      await restoreChart(server.client, before);
    }
    await expectRestored();
  });
});
