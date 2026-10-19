import { sameSymbol } from '../../src/tools/chart/mappers.js';
import { callTool } from '../helpers/mcp-client.js';
import {
  barDistance,
  callOk,
  e2eEnabled,
  findMissingChartMembers,
  readChartState,
  restoreChart,
  restoreView,
  snapshotChart,
  snapshotView,
  startE2eServer,
  UnrestorableChartError,
  type ChartSnapshot,
  type E2eServer,
  type ViewSnapshot,
} from './setup.js';

// The chart tools against the real TradingView Desktop. The suite changes the symbol, the
// timeframe, the chart type and the visible range of the active chart, and nothing else. Before its
// first change it checks, by reading only, that the chart API has what the tools use and that the
// chart can be put back as it is, and otherwise it skips every test with the reason and changes
// nothing. It takes a snapshot first and restores the chart after every test and after the last
// one, whatever the tests did (see setup.ts).

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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

describe.skipIf(!e2eEnabled())('the chart tools against TradingView Desktop', () => {
  let e2e: E2eServer | undefined;
  let snapshot: ChartSnapshot | undefined;
  let view: ViewSnapshot | null = null;
  // Why the suite does not run, when it does not. Set before anything has changed.
  let skipReason: string | undefined;

  beforeAll(async () => {
    e2e = await startE2eServer();
    const missing = await findMissingChartMembers(e2e.ctx);
    if (missing.length > 0) {
      skipReason =
        `The chart API lacks ${missing.join(', ')}, so the tools would fall back to clicks and ` +
        'typing; nothing was changed.';
      return;
    }
    try {
      snapshot = await snapshotChart(e2e.client);
    } catch (error) {
      if (error instanceof UnrestorableChartError) {
        skipReason = `${error.message}; nothing was changed.`;
        return;
      }
      throw error;
    }
    view = await snapshotView(e2e.ctx);
  });

  beforeEach((context) => {
    if (skipReason !== undefined) {
      context.skip(skipReason);
    }
  });

  // The chart through the tools, then the exact view, each tried whatever the other did; the
  // failures are thrown together once the server is closed.
  afterAll(async () => {
    if (e2e === undefined) {
      return;
    }
    const failures: string[] = [];
    if (snapshot !== undefined) {
      try {
        await restoreChart(e2e.client, snapshot);
      } catch (error) {
        failures.push(messageOf(error));
      }
      if (view !== null) {
        try {
          await restoreView(e2e.ctx, view);
        } catch (error) {
          failures.push(messageOf(error));
        }
      }
    }
    await e2e.close();
    if (failures.length > 0) {
      throw new Error(failures.join('; '));
    }
  });

  function started(): { e2e: E2eServer; snapshot: ChartSnapshot } {
    if (e2e === undefined || snapshot === undefined) {
      throw new Error('The suite could not take a snapshot of the chart');
    }
    return { e2e, snapshot };
  }

  // Runs `change` and restores the chart first thing after it, however it ended. A restore that
  // fails after a failed test does not hide that test's own failure: the failure is thrown and the
  // restore's error is logged next to it. After a test that passed, a failed restore fails it.
  async function changeThenRestore(change: () => Promise<void>): Promise<void> {
    const { e2e: server, snapshot: before } = started();
    let failure: unknown;
    let failed = false;
    try {
      await change();
    } catch (error) {
      failure = error;
      failed = true;
    }
    try {
      await restoreChart(server.client, before);
    } catch (restoreError) {
      if (!failed) {
        throw restoreError;
      }
      console.error(
        `The chart could not be restored after a failed test: ${messageOf(restoreError)}`,
      );
    }
    if (failed) {
      throw failure;
    }
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
    await changeThenRestore(async () => {
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
    });
    await expectRestored();
  });

  test('changes chart type and restores it', async () => {
    const { e2e: server } = started();
    await changeThenRestore(async () => {
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
    });
    await expectRestored();
  });

  test('sets and restores the visible range', async () => {
    const { e2e: server } = started();
    await changeThenRestore(async () => {
      const shown = (await callOk<Range>(server.client, 'chart_get_visible_range')).data;
      // A range inside the view, in its older half, where the chart has loaded bars.
      const width = shown.to - shown.from;
      const inner = {
        from: Math.round(shown.from + width * 0.15),
        to: Math.round(shown.from + width * 0.35),
      };
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
    });
    await expectRestored();
  });

  test('reports an unknown symbol and switches the chart back', async () => {
    const { e2e: server, snapshot: before } = started();
    await changeThenRestore(async () => {
      const result = await callTool(server.client, 'chart_set_symbol', { symbol: UNKNOWN_SYMBOL });

      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as unknown as ErrorEnvelope;
      expect(error.code).toBe('INVALID_INPUT');
      expect(error.details).toMatchObject({ requested: UNKNOWN_SYMBOL, kept: before.symbol });
      expect((await readChartState(server.client)).symbol).toBe(before.symbol);
    });
    await expectRestored();
  });
});
