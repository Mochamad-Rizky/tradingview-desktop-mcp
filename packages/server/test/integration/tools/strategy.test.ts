import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpServer } from '../../../src/server.js';
import { readStrategyResultsData } from '../../../src/tools/strategy/index.js';
import type { ToolContext } from '../../../src/tools/types.js';
import type { JsonValue } from '../../../src/utils/json.js';
import { startFakeCdpServer } from '../../helpers/fake-cdp/server.js';
import { loadTargetsFixture } from '../../helpers/fake-cdp/targets.js';
import { loadTvFixture, type TvStateFixture } from '../../helpers/fake-tv/fixture.js';
import { syntheticBars } from '../../helpers/fake-tv/synthetic-bars.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTvOverrides,
  type FakeTvWindow,
} from '../../helpers/fake-tv/window.js';
import { callTool, connectInMemoryClient, textOf } from '../../helpers/mcp-client.js';
import {
  barTime,
  generatedTrades,
  SAMPLE_STRATEGY,
  SECOND_STRATEGY,
  strategyWith,
  withStudies,
} from '../../helpers/strategy-fixtures.js';
import { quietLogger, refusingLauncher, testConfig } from '../../helpers/tool-context.js';

// The Strategy Tester tools (strategy_get_results, strategy_get_trades and strategy_get_equity)
// through the whole server: an SDK client over the in-memory transport, the real registry,
// connection manager and CDP adapter, and the fake debug port of the app with a fake chart behind
// it, whose strategies hold synthetic reports. Values are synthetic.

// Nothing in this file may run a real program or start TradingView.
vi.mock('node:child_process', () => ({
  spawn: () => {
    throw new Error('A test tried to start a real program with spawn');
  },
  execFile: () => {
    throw new Error('A test tried to start a real program with execFile');
  },
}));

const fixture = loadTvFixture();
const bars = syntheticBars(fixture.bars);

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function connect(server: McpServer): Promise<Client> {
  const client = await connectInMemoryClient(server);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function startHarness(
  from: TvStateFixture = withStudies(fixture, SAMPLE_STRATEGY),
  overrides: FakeTvOverrides = {},
  win: FakeTvWindow = createFakeTvWindow(from, overrides),
): Promise<{ client: Client; win: FakeTvWindow; ctx: ToolContext }> {
  const app = await startFakeCdpServer({ targets: loadTargetsFixture({ chartWindow: () => win }) });
  cleanups.push(() => app.close());
  const config = testConfig({ cdpPort: app.port, callTimeoutMs: 5000 });
  const { server, ctx } = createMcpServer(config, {
    launcher: refusingLauncher(),
    logger: quietLogger,
  });
  cleanups.push(() => ctx.connection.close());
  return { client: await connect(server), win, ctx };
}

interface Envelope {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; hint?: string; details?: Record<string, unknown> };
  meta: { via?: string; durationMs: number; warnings?: string[] };
}

const envelopeOf = (result: { structuredContent?: unknown }): Envelope =>
  result.structuredContent as Envelope;
const dataOf = (result: { structuredContent?: unknown }) => envelopeOf(result).data ?? {};
const errorOf = (result: { structuredContent?: unknown }) => envelopeOf(result).error;
const warningsOf = (result: { structuredContent?: unknown }) =>
  envelopeOf(result).meta.warnings ?? [];

const isoOf = (time: number) => new Date(time * 1000).toISOString().replace('.000Z', 'Z');
// A time as the tools report one.
const at = (time: number) => ({ time, timeIso: isoOf(time) });

const TOOLS = ['strategy_get_results', 'strategy_get_trades', 'strategy_get_equity'] as const;

// The strategy the tools name in their results: the one they read.
const SAMPLE_REF = { id: 'STRAT01', name: 'RSI Strategy' };
const SECOND_REF = { id: 'STRAT02', name: 'MACD Strategy' };

// The performance of the sample strategy as strategy_get_results reports it.
const SAMPLE_PERFORMANCE_RESULT = {
  all: {
    buyHoldReturn: -120.5,
    initialCapital: 10_000,
    netProfit: 155,
    netProfitPercent: 1.55,
    grossProfit: 205,
    grossLoss: -50,
    openPL: -20,
    totalTrades: 3,
    totalOpenTrades: 1,
    numberOfWiningTrades: 2,
    numberOfLosingTrades: 1,
    percentProfitable: 66.67,
    avgLosTrade: -50,
    profitFactor: 4.1,
    maxStrategyDrawDown: 60,
  },
  long: { netProfit: 205, totalTrades: 2, numberOfWiningTrades: 2, percentProfitable: 100 },
  short: {
    netProfit: -50,
    totalTrades: 1,
    numberOfWiningTrades: 0,
    numberOfLosingTrades: 1,
    percentProfitable: 0,
  },
};

// The trades of the sample strategy as strategy_get_trades reports them. The second trade is
// stamped in milliseconds in the report, and reported in seconds.
const SAMPLE_TRADES_RESULT = [
  {
    number: 1,
    isOpen: false,
    side: 'long',
    entry: { ...at(barTime(20)), price: 100, signal: 'Long' },
    exit: { ...at(barTime(30)), price: 110, signal: 'Exit long' },
    quantity: 10,
    profit: 100,
    profitPercent: 10,
    cumulativeProfit: 100,
    runup: 120,
    drawdown: 20,
  },
  {
    number: 2,
    isOpen: false,
    side: 'short',
    entry: { ...at(barTime(50)), price: 120, signal: 'Short' },
    exit: { ...at(barTime(62)), price: 125, signal: 'Exit short' },
    quantity: 10,
    profit: -50,
    profitPercent: -4.2,
    cumulativeProfit: 50,
    runup: 10,
    drawdown: 60,
  },
  {
    number: 3,
    isOpen: false,
    side: 'long',
    entry: { ...at(barTime(80)), price: 105, signal: 'Long' },
    exit: { ...at(barTime(95)), price: 115.5, signal: 'Exit long' },
    quantity: 10,
    profit: 105,
    profitPercent: 10,
    cumulativeProfit: 155,
    runup: 110,
    drawdown: 5,
  },
  {
    number: 4,
    isOpen: true,
    side: 'long',
    entry: { ...at(barTime(250)), price: 130, signal: 'Long' },
    exit: null,
    quantity: 10,
    profit: -20,
    profitPercent: -1.5,
    cumulativeProfit: 135,
    runup: 15,
    drawdown: 40,
  },
];

// The filled orders of the sample strategy as strategy_get_trades reports them without trades.
const fill = (
  id: string,
  side: string,
  isEntry: boolean,
  price: number,
  barIndex: number,
  comment: string | null = null,
) => ({
  id,
  side,
  isEntry,
  price,
  quantity: 10,
  comment,
  barIndex,
  ...at(barTime(barIndex)),
});
const SAMPLE_FILLS_RESULT = [
  fill('Long', 'buy', true, 100, 20),
  fill('Exit long', 'sell', false, 110, 30, 'Take profit'),
  fill('Short', 'sell', true, 120, 50),
  fill('Exit short', 'buy', false, 125, 62),
  fill('Long', 'buy', true, 105, 80),
  fill('Exit long', 'sell', false, 115.5, 95),
  fill('Long', 'buy', true, 130, 250, 'Breakout'),
];

// The chart with the sample strategy but for its report, which has no trades.
const withoutTrades = withStudies(fixture, strategyWith({ trades: undefined }));
const withTwo = withStudies(fixture, SAMPLE_STRATEGY, SECOND_STRATEGY);
const withNoStrategy = fixture;

test('the sample strategy sits on the bars of the fixture', () => {
  expect(barTime(0)).toBe(bars[0]?.[0]);
  expect(barTime(299)).toBe(bars[299]?.[0]);
});

describe('strategy_get_results', () => {
  test('strategy_get_results returns all, long and short performance', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'strategy_get_results');

    expect(result.isError).not.toBe(true);
    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: {
        strategy: SAMPLE_REF,
        currency: 'USD',
        initialCapital: 10_000,
        performance: SAMPLE_PERFORMANCE_RESULT,
      },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(JSON.parse(textOf(result))).toStrictEqual(result.structuredContent);
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('strategy_get_results keeps the names of TradingView, its misspellings included', async () => {
    const { client } = await startHarness();

    const { performance } = dataOf(await callTool(client, 'strategy_get_results')) as {
      performance: { all: Record<string, number> };
    };

    expect(performance.all.numberOfWiningTrades).toBe(2);
    expect(performance.all.avgLosTrade).toBe(-50);
    expect(performance.all).not.toHaveProperty('numberOfWinningTrades');
  });

  test('strategy_get_results reads the active strategy when several are on the chart', async () => {
    const two = withStudies(fixture, SAMPLE_STRATEGY, { ...SECOND_STRATEGY, activeStrategy: true });
    const { client } = await startHarness(two);

    const result = await callTool(client, 'strategy_get_results');

    expect(dataOf(result)).toMatchObject({
      strategy: { id: 'STRAT02', name: 'MACD Strategy' },
      initialCapital: 5000,
      performance: { all: { netProfit: 25 } },
    });
  });

  test('strategy_get_results reads the strategy of the studyId it is given', async () => {
    const { client } = await startHarness(withTwo);

    const first = await callTool(client, 'strategy_get_results', { studyId: 'STRAT01' });
    const second = await callTool(client, 'strategy_get_results', { studyId: 'STRAT02' });

    expect(dataOf(first)).toMatchObject({ strategy: { id: 'STRAT01' }, initialCapital: 10_000 });
    expect(dataOf(second)).toMatchObject({ strategy: { id: 'STRAT02' }, initialCapital: 5000 });
  });

  test('strategy_get_results takes the initial capital of the strategy input when the report lacks it', async () => {
    const study = {
      ...strategyWith({ performance: { all: { netProfit: 1, totalTrades: 0 } } }),
      inputs: [
        { id: 'in_1', name: 'Capital', internalID: 'initial_capital', type: 'float', value: 2500 },
      ],
    };
    const { client } = await startHarness(withStudies(fixture, study));

    const result = await callTool(client, 'strategy_get_results');

    expect(dataOf(result)).toMatchObject({
      initialCapital: 2500,
      performance: { all: { netProfit: 1, totalTrades: 0 } },
    });
  });

  test('strategy_get_results reports an initial capital it cannot find as null, and a currency of NONE as it is', async () => {
    const study = {
      ...strategyWith({ currency: 'NONE', performance: { all: { netProfit: 1 } } }),
      inputs: [],
    };
    const { client } = await startHarness(withStudies(fixture, study));

    const result = await callTool(client, 'strategy_get_results');

    expect(dataOf(result)).toMatchObject({ currency: 'NONE', initialCapital: null });
    expect(warningsOf(result)).toEqual([]);
  });

  test('strategy_get_results says so when the report holds no number', async () => {
    const study = strategyWith({ performance: { all: { note: 'soon' }, long: {}, short: [] } });
    const { client } = await startHarness(withStudies(fixture, study));

    const result = await callTool(client, 'strategy_get_results');

    expect(dataOf(result)).toMatchObject({ performance: { all: {}, long: {}, short: {} } });
    expect(warningsOf(result)).toEqual([expect.stringMatching(/no numeric statistic/i) as string]);
  });

  test('readStrategyResultsData gives the data and warnings of the tool, for the resource', async () => {
    const { client, ctx } = await startHarness(withTwo);

    const tool = await callTool(client, 'strategy_get_results', { studyId: 'STRAT02' });
    const direct = await readStrategyResultsData(ctx, 'STRAT02');

    expect(direct).toStrictEqual({ data: dataOf(tool), warnings: warningsOf(tool) });
    expect(await readStrategyResultsData(ctx, 'STRAT01', 0)).toMatchObject({
      data: { strategy: { id: 'STRAT01' } },
    });
  });

  test('readStrategyResultsData fails the way the tool does', async () => {
    const { ctx } = await startHarness(withNoStrategy);

    await expect(readStrategyResultsData(ctx)).rejects.toMatchObject({
      code: 'NOT_AVAILABLE',
      hint: expect.stringMatching(/pine_compile/) as string,
    });
  });
});

describe('strategy_get_trades', () => {
  test('strategy_get_trades lists the trades with their sides, legs, ISO times and amounts', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'strategy_get_trades');

    expect(result.isError).not.toBe(true);
    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: { strategy: SAMPLE_REF, total: 4, trades: SAMPLE_TRADES_RESULT },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('strategy_get_trades pages with offset and limit', async () => {
    const { client } = await startHarness();
    const numbers = async (args: Record<string, unknown>) => {
      const result = await callTool(client, 'strategy_get_trades', args);
      return {
        total: dataOf(result).total,
        numbers: (dataOf(result).trades as { number: number }[]).map(({ number }) => number),
      };
    };

    expect(await numbers({ limit: 2 })).toEqual({ total: 4, numbers: [1, 2] });
    expect(await numbers({ limit: 2, offset: 1 })).toEqual({ total: 4, numbers: [2, 3] });
    expect(await numbers({ limit: 2, offset: 3 })).toEqual({ total: 4, numbers: [4] });
    expect(await numbers({ offset: 4 })).toEqual({ total: 4, numbers: [] });
    expect(await numbers({ offset: 100, limit: 1000 })).toEqual({ total: 4, numbers: [] });
    expect(await numbers({ limit: 1000 })).toEqual({ total: 4, numbers: [1, 2, 3, 4] });
  });

  test('strategy_get_trades reports the trades of the strategy of the studyId it is given', async () => {
    const { client } = await startHarness(withTwo);

    const result = await callTool(client, 'strategy_get_trades', { studyId: 'STRAT02' });

    expect(dataOf(result)).toMatchObject({ total: 2 });
    expect(
      (dataOf(result).trades as { cumulativeProfit: number }[]).map(
        (trade) => trade.cumulativeProfit,
      ),
    ).toEqual([75, 25]);
  });

  test('strategy_get_trades lists the filled orders, with a warning, when the report has no trades', async () => {
    const { client, win } = await startHarness(withoutTrades);

    const result = await callTool(client, 'strategy_get_trades');

    expect(result.isError).not.toBe(true);
    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: { strategy: SAMPLE_REF, total: 7, trades: [], fills: SAMPLE_FILLS_RESULT },
      meta: {
        via: 'internal',
        durationMs: expect.any(Number) as number,
        warnings: [expect.stringMatching(/STRAT01.*no list of trades.*fills/s) as string],
      },
    });
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('strategy_get_trades pages over the fills with offset and limit, and counts them all', async () => {
    const { client } = await startHarness(withoutTrades);

    const result = await callTool(client, 'strategy_get_trades', { limit: 2, offset: 5 });

    expect(dataOf(result)).toStrictEqual({
      strategy: SAMPLE_REF,
      total: 7,
      trades: [],
      fills: SAMPLE_FILLS_RESULT.slice(5, 7),
    });
    const past = await callTool(client, 'strategy_get_trades', { offset: 7 });
    expect(dataOf(past)).toStrictEqual({ strategy: SAMPLE_REF, total: 7, trades: [], fills: [] });
    expect(warningsOf(past)).toHaveLength(1);
  });

  test('strategy_get_trades falls back to the fills when the trades are in no shape it knows', async () => {
    for (const trades of [[], [{ foo: 1 }], 'many', null]) {
      const { client } = await startHarness(withStudies(fixture, strategyWith({ trades })));

      const result = await callTool(client, 'strategy_get_trades');

      expect(dataOf(result), JSON.stringify(trades)).toMatchObject({ total: 7, trades: [] });
      expect(dataOf(result), JSON.stringify(trades)).toHaveProperty('fills');
      expect(warningsOf(result), JSON.stringify(trades)).toHaveLength(1);
    }
  });

  test('strategy_get_trades reports a strategy that made no trade as an empty list, without a warning', async () => {
    const idle = strategyWith({ trades: [], filledOrders: [] });
    const { client } = await startHarness(withStudies(fixture, idle));

    const result = await callTool(client, 'strategy_get_trades');

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: { strategy: SAMPLE_REF, total: 0, trades: [] },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
  });

  test('strategy_get_trades with neither trades nor orders says the report has no list of trades', async () => {
    const bare = strategyWith({ trades: undefined, filledOrders: undefined });
    const { client } = await startHarness(withStudies(fixture, bare));

    const result = await callTool(client, 'strategy_get_trades');

    expect(dataOf(result)).toStrictEqual({
      strategy: SAMPLE_REF,
      total: 0,
      trades: [],
      fills: [],
    });
    expect(warningsOf(result)).toHaveLength(1);
  });
});

describe('strategy_get_equity', () => {
  test('strategy_get_equity derives the curve from the closed trades', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'strategy_get_equity');

    expect(result.isError).not.toBe(true);
    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: {
        strategy: SAMPLE_REF,
        initialCapital: 10_000,
        // The first entry with the initial capital, then the exit of each closed trade, in time
        // order. The open trade is not in it.
        points: [
          { ...at(barTime(20)), equity: 10_000 },
          { ...at(barTime(30)), equity: 10_100 },
          { ...at(barTime(62)), equity: 10_050 },
          { ...at(barTime(95)), equity: 10_155 },
        ],
        downsampled: false,
      },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('strategy_get_equity starts from the initial capital of the strategy input when the report lacks it', async () => {
    const study = {
      ...strategyWith({ performance: { all: { netProfit: 155 } } }),
      inputs: [
        { id: 'in_1', name: 'Capital', internalID: 'initial_capital', type: 'float', value: 2000 },
      ],
    };
    const { client } = await startHarness(withStudies(fixture, study));

    const result = await callTool(client, 'strategy_get_equity');

    expect(dataOf(result)).toMatchObject({ initialCapital: 2000, downsampled: false });
    expect((dataOf(result).points as { equity: number }[]).map(({ equity }) => equity)).toEqual([
      2000, 2100, 2050, 2155,
    ]);
  });

  test('strategy_get_equity reads the strategy of the studyId it is given', async () => {
    const { client } = await startHarness(withTwo);

    const result = await callTool(client, 'strategy_get_equity', { studyId: 'STRAT02' });

    expect(dataOf(result)).toMatchObject({ initialCapital: 5000 });
    expect((dataOf(result).points as { equity: number }[]).map(({ equity }) => equity)).toEqual([
      5000, 5075, 5025,
    ]);
  });

  describe('with more points than maxPoints', () => {
    const many = withStudies(
      fixture,
      strategyWith({ trades: generatedTrades(60), filledOrders: [] }),
    );

    test('strategy_get_equity keeps the first, the last and the extremes, and says it dropped points', async () => {
      const { client } = await startHarness(many);
      const whole = await callTool(client, 'strategy_get_equity', { maxPoints: 5000 });
      const points = dataOf(whole).points as { time: number; equity: number }[];

      expect(points).toHaveLength(61);
      expect(dataOf(whole).downsampled).toBe(false);
      for (const maxPoints of [2, 3, 10, 11, 60]) {
        const result = await callTool(client, 'strategy_get_equity', { maxPoints });
        const kept = dataOf(result).points as { time: number; equity: number }[];

        expect(dataOf(result).downsampled, String(maxPoints)).toBe(true);
        expect(kept.length, String(maxPoints)).toBeLessThanOrEqual(maxPoints);
        expect(kept[0], String(maxPoints)).toEqual(points[0]);
        expect(kept.at(-1), String(maxPoints)).toEqual(points.at(-1));
        // In time order, and every one of them a point of the whole curve.
        expect(
          kept.map(({ time }) => time),
          String(maxPoints),
        ).toEqual([...kept.map(({ time }) => time)].sort((a, b) => a - b));
        for (const point of kept) {
          expect(points, String(maxPoints)).toContainEqual(point);
        }
        if (maxPoints >= 4) {
          const equities = (list: { equity: number }[]) => list.map(({ equity }) => equity);
          expect(Math.min(...equities(kept)), String(maxPoints)).toBe(
            Math.min(...equities(points)),
          );
          expect(Math.max(...equities(kept)), String(maxPoints)).toBe(
            Math.max(...equities(points)),
          );
        }
      }
    });

    test('strategy_get_equity keeps all points at a maxPoints that is as large as the curve', async () => {
      const { client } = await startHarness(many);

      const result = await callTool(client, 'strategy_get_equity', { maxPoints: 61 });

      expect(dataOf(result).points).toHaveLength(61);
      expect(dataOf(result).downsampled).toBe(false);
    });

    test('strategy_get_equity returns 500 points at most by default', async () => {
      const { client } = await startHarness(
        withStudies(fixture, strategyWith({ trades: generatedTrades(600), filledOrders: [] })),
      );

      const result = await callTool(client, 'strategy_get_equity');

      expect((dataOf(result).points as unknown[]).length).toBeLessThanOrEqual(500);
      expect((dataOf(result).points as unknown[]).length).toBeGreaterThan(400);
      expect(dataOf(result).downsampled).toBe(true);
    });
  });

  test('strategy_get_equity fails NOT_AVAILABLE, saying why, when the report holds fills and no trades', async () => {
    const { client } = await startHarness(withoutTrades);

    const result = await callTool(client, 'strategy_get_equity');

    expect(result.isError).toBe(true);
    expect(errorOf(result)).toEqual({
      code: 'NOT_AVAILABLE',
      message: expect.stringMatching(/STRAT01.*no list of trades.*equity/s) as string,
      hint: expect.stringMatching(/strategy_get_trades/) as string,
    });
  });

  test('strategy_get_equity fails NOT_AVAILABLE, saying why, when the initial capital cannot be read', async () => {
    const study = { ...strategyWith({ performance: { all: { netProfit: 1 } } }), inputs: [] };
    const { client } = await startHarness(withStudies(fixture, study));

    const result = await callTool(client, 'strategy_get_equity');

    expect(result.isError).toBe(true);
    expect(errorOf(result)).toEqual({
      code: 'NOT_AVAILABLE',
      message: expect.stringMatching(/initial capital.*STRAT01/s) as string,
      hint: expect.stringMatching(/strategy_get_results/) as string,
    });
  });

  test('strategy_get_equity gives no points, with a warning, while no trade has closed', async () => {
    const open = generatedTrades(1)[0];
    const study = strategyWith({ trades: [{ ...open, isOpen: true }], filledOrders: [] });
    const { client } = await startHarness(withStudies(fixture, study));

    const result = await callTool(client, 'strategy_get_equity');

    expect(dataOf(result)).toStrictEqual({
      strategy: SAMPLE_REF,
      initialCapital: 10_000,
      points: [],
      downsampled: false,
    });
    expect(warningsOf(result)).toEqual([expect.stringMatching(/no trade has closed/i) as string]);
  });

  test('strategy_get_equity leaves out a closed trade it cannot place, and counts it in a warning', async () => {
    const [first = {}, second = {}, third = {}] = generatedTrades(3);
    const unplaced = (trade: Record<string, JsonValue>) => ({ ...trade, cumulativeProfit: null });
    const run = async (trades: Record<string, JsonValue>[]) => {
      const study = strategyWith({ trades, filledOrders: [] });
      const { client } = await startHarness(withStudies(fixture, study));
      return callTool(client, 'strategy_get_equity');
    };

    const one = await run([first, unplaced(second)]);
    const two = await run([first, unplaced(second), unplaced(third)]);

    // The start and the exit of the trade that can be placed.
    expect((dataOf(one).points as unknown[]).length).toBe(2);
    expect(warningsOf(one)).toEqual([
      expect.stringMatching(/1 closed trade has no exit time.*it is not on the curve/) as string,
    ]);
    expect((dataOf(two).points as unknown[]).length).toBe(2);
    expect(warningsOf(two)).toEqual([
      expect.stringMatching(
        /2 closed trades have no exit time.*they are not on the curve/,
      ) as string,
    ]);
  });
});

describe('the three tools', () => {
  test('strategy tools name the strategy they read, however it was chosen', async () => {
    const active = withStudies(fixture, SAMPLE_STRATEGY, {
      ...SECOND_STRATEGY,
      activeStrategy: true,
    });
    const { client: onlyOne } = await startHarness();
    const { client: oneActive } = await startHarness(active);
    const { client: several } = await startHarness(withTwo);

    for (const tool of TOOLS) {
      // The only strategy on the chart, the active one of two, and the one a studyId names.
      const strategies = [
        dataOf(await callTool(onlyOne, tool)).strategy,
        dataOf(await callTool(oneActive, tool)).strategy,
        dataOf(await callTool(several, tool, { studyId: 'STRAT01' })).strategy,
        dataOf(await callTool(several, tool, { studyId: 'STRAT02' })).strategy,
      ];

      expect(strategies, tool).toEqual([SAMPLE_REF, SECOND_REF, SAMPLE_REF, SECOND_REF]);
    }
  });

  test('strategy tools fail NOT_AVAILABLE without a strategy on the chart', async () => {
    const { client, win } = await startHarness(withNoStrategy);

    for (const tool of TOOLS) {
      const result = await callTool(client, tool);

      expect(result.isError, tool).toBe(true);
      expect(errorOf(result), tool).toEqual({
        code: 'NOT_AVAILABLE',
        message: 'The chart has no strategy',
        // How to get one: a strategy script from pine_new, and pine_compile to put it on the chart.
        hint: expect.stringMatching(/pine_new.*strategy.*pine_compile.*addToChart/s) as string,
      });
    }
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('strategy tools fail INVALID_INPUT, naming the ids, with several strategies and none active', async () => {
    const { client } = await startHarness(withTwo);

    for (const tool of TOOLS) {
      const result = await callTool(client, tool);

      expect(errorOf(result), tool).toMatchObject({
        code: 'INVALID_INPUT',
        details: { ids: ['STRAT01', 'STRAT02'] },
        hint: expect.stringMatching(/studyId/) as string,
      });
    }
  });

  test('strategy tools fail INVALID_INPUT for an unknown studyId or a study that is not a strategy', async () => {
    const { client, win } = await startHarness();

    for (const tool of TOOLS) {
      const unknown = await callTool(client, tool, { studyId: 'NOPE01' });
      const indicator = await callTool(client, tool, { studyId: 'STUDY01' });

      expect(errorOf(unknown), tool).toMatchObject({
        code: 'INVALID_INPUT',
        message: expect.stringMatching(/NOPE01/) as string,
        hint: expect.stringMatching(/indicator_list/) as string,
        details: { id: 'NOPE01' },
      });
      expect(errorOf(indicator), tool).toMatchObject({
        code: 'INVALID_INPUT',
        message: expect.stringMatching(/STUDY01.*not a strategy/) as string,
        hint: expect.stringMatching(/indicator_list/) as string,
      });
    }
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('strategy tools fail NOT_AVAILABLE, with a hint to try again, while the report is not ready', async () => {
    const { client } = await startHarness(
      withStudies(fixture, { ...SAMPLE_STRATEGY, report: undefined }),
    );

    for (const tool of TOOLS) {
      const result = await callTool(client, tool);

      expect(result.isError, tool).toBe(true);
      expect(errorOf(result), tool).toMatchObject({
        code: 'NOT_AVAILABLE',
        message: expect.stringMatching(/STRAT01.*not ready/) as string,
        hint: expect.stringMatching(/call again/) as string,
      });
    }
  });

  test('strategy tools read the report again on every call, so a report that has arrived is read', async () => {
    const win = createFakeTvWindow(withStudies(fixture, { ...SAMPLE_STRATEGY, report: undefined }));
    const { client } = await startHarness(undefined, {}, win);
    const core = win.TradingViewApi?.activeChart().getStudyById('STRAT01').study();
    if (core === undefined) {
      throw new Error('The fake window has no chart');
    }

    const early = await callTool(client, 'strategy_get_results');
    // The report arrives.
    Object.assign(core, {
      reportData: () => ({ currency: 'EUR', performance: { all: { netProfit: 12 } } }),
    });
    const late = await callTool(client, 'strategy_get_results');

    expect(errorOf(early)).toMatchObject({ code: 'NOT_AVAILABLE' });
    expect(dataOf(late)).toMatchObject({
      strategy: { id: 'STRAT01' },
      currency: 'EUR',
      performance: { all: { netProfit: 12 } },
    });
  });

  test('strategy tools read the chart of the index they are given, and refuse one the layout lacks', async () => {
    const { client } = await startHarness();

    for (const tool of TOOLS) {
      const first = await callTool(client, tool, { chartIndex: 0 });
      const second = await callTool(client, tool, { chartIndex: 1 });

      expect(first.isError, tool).not.toBe(true);
      expect(errorOf(second), tool).toMatchObject({
        code: 'INVALID_INPUT',
        details: { chartIndex: 1, chartsCount: 1 },
      });
    }
  });

  test.each([
    ['strategy_get_trades', { limit: 0 }, /limit/],
    ['strategy_get_trades', { limit: 1001 }, /limit/],
    ['strategy_get_trades', { limit: 1.5 }, /limit/],
    ['strategy_get_trades', { offset: -1 }, /offset/],
    ['strategy_get_trades', { offset: 1.5 }, /offset/],
    ['strategy_get_equity', { maxPoints: 1 }, /maxPoints/],
    ['strategy_get_equity', { maxPoints: 5001 }, /maxPoints/],
    ['strategy_get_equity', { maxPoints: 2.5 }, /maxPoints/],
    ['strategy_get_results', { studyId: '' }, /studyId/],
  ])('%s refuses %j', async (tool, args, field) => {
    const { client, win } = await startHarness();

    const result = await callTool(client, tool, args);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(field);
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('strategy tools take the extremes of their ranges', async () => {
    const { client } = await startHarness();

    for (const [tool, args] of [
      ['strategy_get_trades', { limit: 1 }],
      ['strategy_get_trades', { limit: 1000, offset: 0 }],
      ['strategy_get_equity', { maxPoints: 2 }],
      ['strategy_get_equity', { maxPoints: 5000 }],
    ] as const) {
      const result = await callTool(client, tool, args);

      expect(result.isError, `${tool} ${JSON.stringify(args)}`).not.toBe(true);
    }
  });

  test('strategy tools change nothing, send nothing and open nothing', async () => {
    const { client, win } = await startHarness(withTwo);

    for (const tool of TOOLS) {
      await callTool(client, tool, { studyId: 'STRAT01' });
      await callTool(client, tool, { studyId: 'STRAT02', chartIndex: 0 });
      await callTool(client, tool);
    }

    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('strategy tools say that they only read', async () => {
    const { client } = await startHarness();

    const { tools } = await client.listTools();
    const wanted = tools.filter(({ name }) => name.startsWith('strategy_'));

    expect(wanted.map(({ name }) => name)).toEqual([...TOOLS]);
    for (const { annotations, description } of wanted) {
      expect(annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(description).toMatch(/changes nothing/);
    }
  });

  test('strategy tools fail CAPABILITY_UNAVAILABLE on a build whose strategies cannot give a report', async () => {
    const win = createFakeTvWindow(withStudies(fixture, SAMPLE_STRATEGY));
    const core = win.TradingViewApi?.activeChart().getStudyById('STRAT01').study();
    if (core === undefined) {
      throw new Error('The fake window has no chart');
    }
    Reflect.deleteProperty(core, 'reportData');
    const { client } = await startHarness(undefined, {}, win);

    for (const tool of TOOLS) {
      const result = await callTool(client, tool);

      expect(errorOf(result), tool).toMatchObject({
        code: 'CAPABILITY_UNAVAILABLE',
        hint: expect.stringMatching(/app_health/) as string,
      });
    }
  });

  test('strategy tools read a strategy that is hidden on the chart as well', async () => {
    const hidden = withStudies(fixture, { ...SAMPLE_STRATEGY, visible: false });
    const { client } = await startHarness(hidden);

    const result = await callTool(client, 'strategy_get_results');

    expect(dataOf(result)).toMatchObject({ strategy: { id: 'STRAT01' } });
  });
});
