import { sameSymbol } from '../../src/tools/chart/mappers.js';
import { callTool } from '../helpers/mcp-client.js';
import {
  barDistance,
  callOk,
  changeThenRestore,
  e2eEnabled,
  expectChartRestored,
  prepareChartChange,
  readChartState,
  restoreChartAndView,
  sameJson,
  startE2eServer,
  type ChartChangePlan,
  type ChartSnapshot,
  type E2eServer,
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

describe.skipIf(!e2eEnabled())('the chart tools against TradingView Desktop', () => {
  let e2e: E2eServer | undefined;
  // The snapshot and the view to put back, or why the suite does not run, found before anything
  // has changed.
  let plan: ChartChangePlan | undefined;

  beforeAll(async () => {
    e2e = await startE2eServer();
    plan = await prepareChartChange(e2e);
  });

  beforeEach((context) => {
    if (plan?.skipReason !== undefined) {
      context.skip(plan.skipReason);
    }
  });

  // The chart through the tools, then the exact view, each tried whatever the other did; the
  // failures are thrown together once the server is closed.
  afterAll(async () => {
    if (e2e === undefined) {
      return;
    }
    const failures = plan === undefined ? [] : await restoreChartAndView(e2e, plan);
    await e2e.close();
    if (failures.length > 0) {
      throw new Error(failures.join('; '));
    }
  });

  function started(): { e2e: E2eServer; snapshot: ChartSnapshot } {
    if (e2e === undefined || plan?.snapshot === undefined) {
      throw new Error('The suite could not take a snapshot of the chart');
    }
    return { e2e, snapshot: plan.snapshot };
  }

  test('switches symbol and timeframe, then restores them', async () => {
    const { e2e: server, snapshot: before } = started();
    const timeframe = before.resolution === '60' ? '240' : '60';
    await changeThenRestore(server.client, before, async () => {
      const switched = await callOk<SymbolResult>(server.client, 'chart_set_symbol', {
        symbol: TARGET_SYMBOL,
      });
      // TradingView may show the symbol through the exchange of its data feed, such as BATS:AAPL.
      expect((switched.data.symbol ?? '').endsWith(':AAPL'), 'the chart shows AAPL').toBe(true);
      expect(switched.via).toBe('api');
      expect(switched.warnings.length === 0, 'chart_set_symbol gives no warning').toBe(true);

      // The chart shows the symbol now, so asking again changes nothing.
      const again = await callOk<SymbolResult>(server.client, 'chart_set_symbol', {
        symbol: TARGET_SYMBOL,
      });
      expect(
        again.data.symbol === switched.data.symbol && again.data.changed === false,
        'asking again changes nothing',
      ).toBe(true);

      const changed = await callOk<{ resolution: string; changed: boolean }>(
        server.client,
        'chart_set_timeframe',
        { timeframe },
      );
      expect(
        changed.data.resolution === timeframe && changed.data.changed,
        'the timeframe changed',
      ).toBe(true);
      expect(changed.warnings.length === 0, 'chart_set_timeframe gives no warning').toBe(true);

      const state = await readChartState(server.client);
      expect(sameSymbol('AAPL', state.symbol)).toBe(true);
      expect(state.resolution === timeframe, 'the chart shows the timeframe').toBe(true);
      expect(state.visibleRange).not.toBeNull();
    });
    await expectChartRestored(server, before);
  });

  test('changes chart type and restores it', async () => {
    const { e2e: server, snapshot: before } = started();
    await changeThenRestore(server.client, before, async () => {
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
        expect(
          result.data.chartType === id && result.data.chartTypeName === type,
          'chart_set_type reports the type',
        ).toBe(true);
        expect(result.warnings.length === 0, 'chart_set_type gives no warning').toBe(true);
        const shown = (await readChartState(server.client)).chartType;
        expect(shown === id, 'the chart shows the type').toBe(true);
      }
    });
    await expectChartRestored(server, before);
  });

  test('sets and restores the visible range', async () => {
    const { e2e: server, snapshot: before } = started();
    await changeThenRestore(server.client, before, async () => {
      const shown = (await callOk<Range>(server.client, 'chart_get_visible_range')).data;
      // A range inside the view, in its older half, where the chart has loaded bars.
      const width = shown.to - shown.from;
      const inner = {
        from: Math.round(shown.from + width * 0.15),
        to: Math.round(shown.from + width * 0.35),
      };
      const set = await callOk<Range>(server.client, 'chart_set_visible_range', inner);
      expect(set.via).toBe('internal');
      expect(set.warnings.length === 0, 'chart_set_visible_range gives no warning').toBe(true);
      const reached = await barDistance(server.ctx, set.data, inner);
      expect(reached.from).toBeLessThanOrEqual(1);
      expect(reached.to).toBeLessThanOrEqual(1);
      const read = (await callOk<Range>(server.client, 'chart_get_visible_range')).data;
      expect(sameJson(read, set.data), 'chart_get_visible_range reads the range set').toBe(true);

      // The range read at the start goes back in as it came out, empty space after the last bar
      // included.
      const restored = await callOk<Range>(server.client, 'chart_set_visible_range', {
        from: shown.from,
        to: shown.to,
      });
      expect(restored.warnings.length === 0, 'the restore gives no warning').toBe(true);
      const distance = await barDistance(server.ctx, restored.data, shown);
      expect(distance.from).toBeLessThanOrEqual(1);
      expect(distance.to).toBeLessThanOrEqual(1);
    });
    await expectChartRestored(server, before);
  });

  test('reports an unknown symbol and switches the chart back', async () => {
    const { e2e: server, snapshot: before } = started();
    await changeThenRestore(server.client, before, async () => {
      const result = await callTool(server.client, 'chart_set_symbol', { symbol: UNKNOWN_SYMBOL });

      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as unknown as ErrorEnvelope;
      expect(error.code).toBe('INVALID_INPUT');
      expect(error.details?.requested).toBe(UNKNOWN_SYMBOL);
      expect(error.details?.kept === before.symbol, 'the error names the symbol kept').toBe(true);
      const kept = (await readChartState(server.client)).symbol;
      expect(kept === before.symbol, 'the chart keeps its symbol').toBe(true);
    });
    await expectChartRestored(server, before);
  });
});
