import type { JsonValue } from '../../src/utils/json.js';
import type {
  FixtureFilledOrder,
  FixtureStrategyReport,
  FixtureStudy,
  TvStateFixture,
} from './fake-tv/fixture.js';

// Synthetic strategies for the tests of the Strategy Tester tools and of the fake that holds their
// reports. Every number is made up, and the trades are in the shape the Strategy Tester of the app
// gives them (reverse-engineering notes of Plan 2, section Q6), which the raw report of a study may
// or may not have: the variants below stage the other cases.

// The time of the bar at an index on the fake chart of chart-basic: it starts on 2024-01-02 at
// 00:00 UTC with one bar a day.
export const barTime = (index: number): number => 1_704_153_600 + index * 86_400;

type Json = Record<string, JsonValue>;

// A leg of a trade. `scale` 1000 stamps it in milliseconds, as a leg stamped from the clock is.
function leg(type: string, barIndex: number, price: number, id: string, scale = 1): Json {
  return { type, time: barTime(barIndex) * scale, price, id, barIndex };
}

const amount = (value: number, percentValue: number): Json => ({ value, percentValue });

// Three closed trades and one that is still open. The cumulative profit is that of the Strategy
// Tester: the sum of the profits of the trades that closed up to and including that trade.
export const SAMPLE_TRADES: Json[] = [
  {
    tradeNumber: 1,
    entry: leg('le', 20, 100, 'Long'),
    exit: leg('lx', 30, 110, 'Exit long'),
    isOpen: false,
    quantity: 10,
    profit: amount(100, 10),
    runup: amount(120, 12),
    drawdown: amount(20, 2),
    cumulativeProfit: amount(100, 1),
  },
  {
    // Stamped in milliseconds.
    tradeNumber: 2,
    entry: leg('se', 50, 120, 'Short', 1000),
    exit: leg('sx', 62, 125, 'Exit short', 1000),
    isOpen: false,
    quantity: 10,
    profit: amount(-50, -4.2),
    runup: amount(10, 0.8),
    drawdown: amount(60, 5),
    cumulativeProfit: amount(50, 0.5),
  },
  {
    tradeNumber: 3,
    entry: leg('le', 80, 105, 'Long'),
    exit: leg('lx', 95, 115.5, 'Exit long'),
    isOpen: false,
    quantity: 10,
    profit: amount(105, 10),
    runup: amount(110, 10.5),
    drawdown: amount(5, 0.5),
    cumulativeProfit: amount(155, 1.55),
  },
  {
    // Open: its exit leg is where the app puts the current state of the trade.
    tradeNumber: 4,
    entry: leg('le', 250, 130, 'Long'),
    exit: leg('lx', 299, 128, 'Open'),
    isOpen: true,
    quantity: 10,
    profit: amount(-20, -1.5),
    runup: amount(15, 1.1),
    drawdown: amount(40, 3),
    cumulativeProfit: amount(135, 1.35),
  },
];

// The filled orders behind SAMPLE_TRADES, entry and exit of each trade. The first entry says that
// it is one (e: true) and the others leave e out; barIndex is what barsIndexes() reports for the
// order.
export const SAMPLE_FILLS: FixtureFilledOrder[] = [
  { id: 'Long', b: true, e: true, p: 100, q: 10, barIndex: 20 },
  { id: 'Exit long', b: false, e: false, p: 110, q: 10, c: 'Take profit', barIndex: 30 },
  { id: 'Short', b: false, p: 120, q: 10, barIndex: 50 },
  { id: 'Exit short', b: true, e: false, p: 125, q: 10, barIndex: 62 },
  { id: 'Long', b: true, p: 105, q: 10, barIndex: 80 },
  { id: 'Exit long', b: false, e: false, p: 115.5, q: 10, barIndex: 95 },
  { id: 'Long', b: true, p: 130, q: 10, c: 'Breakout', barIndex: 250 },
];

// The performance member of the report: some values are numeric strings, some are not numbers at
// all, and buyHoldReturn sits next to all, long and short instead of in one of them.
export const SAMPLE_PERFORMANCE: Json = {
  all: {
    initialCapital: 10_000,
    netProfit: 155,
    netProfitPercent: 1.55,
    grossProfit: '205',
    grossLoss: -50,
    openPL: -20,
    totalTrades: 3,
    totalOpenTrades: 1,
    numberOfWiningTrades: 2,
    numberOfLosingTrades: 1,
    percentProfitable: '66.67',
    avgLosTrade: -50,
    profitFactor: '4.1',
    maxStrategyDrawDown: 60,
    notAvailable: 'n/a',
    inUse: true,
    nested: { value: 1 },
    gone: null,
  },
  long: { netProfit: 205, totalTrades: 2, numberOfWiningTrades: 2, percentProfitable: 100 },
  short: {
    netProfit: -50,
    totalTrades: 1,
    numberOfWiningTrades: 0,
    numberOfLosingTrades: 1,
    percentProfitable: '0',
  },
  buyHoldReturn: -120.5,
};

export const SAMPLE_REPORT: FixtureStrategyReport = {
  currency: 'USD',
  performance: SAMPLE_PERFORMANCE,
  trades: SAMPLE_TRADES,
  filledOrders: SAMPLE_FILLS,
};

// A strategy that is on the chart with a report. Its initial capital is also an input of the
// strategy, by the internal id the app gives it.
export const SAMPLE_STRATEGY: FixtureStudy = {
  id: 'STRAT01',
  name: 'RSI Strategy',
  title: 'RSI Strategy',
  plots: [],
  pine: { scriptIdPart: 'STD;RSI%1Strategy', version: '12.0' },
  strategy: true,
  inputs: [
    { id: 'in_0', name: 'RSI Length', type: 'integer', value: 14 },
    {
      id: 'in_1',
      name: 'Initial capital',
      internalID: 'initial_capital',
      type: 'float',
      value: 10_000,
    },
  ],
  report: SAMPLE_REPORT,
};

// A second strategy, with a report of its own: two closed trades, the later one at a loss.
export const SECOND_STRATEGY: FixtureStudy = {
  ...SAMPLE_STRATEGY,
  id: 'STRAT02',
  name: 'MACD Strategy',
  title: 'MACD Strategy',
  pine: { scriptIdPart: 'STD;MACD%1Strategy', version: '9.0' },
  report: {
    currency: 'USD',
    performance: { all: { initialCapital: 5_000, netProfit: 25, totalTrades: 2 } },
    trades: [
      {
        tradeNumber: 1,
        entry: leg('le', 10, 100, 'Buy'),
        exit: leg('lx', 12, 101, 'Sell'),
        isOpen: false,
        quantity: 1,
        profit: amount(75, 75),
        runup: amount(80, 80),
        drawdown: amount(0, 0),
        cumulativeProfit: amount(75, 1.5),
      },
      {
        tradeNumber: 2,
        entry: leg('le', 14, 100, 'Buy'),
        exit: leg('lx', 16, 99, 'Sell'),
        isOpen: false,
        quantity: 1,
        profit: amount(-50, -50),
        runup: amount(0, 0),
        drawdown: amount(50, 50),
        cumulativeProfit: amount(25, 0.5),
      },
    ],
    filledOrders: [],
  },
};

// The chart of the fixture with `studies` after its own studies.
export function withStudies(base: TvStateFixture, ...studies: FixtureStudy[]): TvStateFixture {
  return { ...base, studies: [...base.studies, ...studies] };
}

// The sample strategy with the members of its report replaced. A member given as undefined is left
// out of the report, as when the app does not hold it.
export function strategyWith(report: Partial<FixtureStrategyReport>): FixtureStudy {
  return { ...SAMPLE_STRATEGY, report: { ...SAMPLE_REPORT, ...report } };
}

// `count` closed long trades, one every two bars from bar 10, whose profits zig-zag so that the
// equity curve has peaks and valleys to keep: each trade earns 50 and every third one loses 100.
// Quantities and prices are made up.
export function generatedTrades(count: number): Json[] {
  let cumulative = 0;
  return Array.from({ length: count }, (_, position) => {
    const profit = (position + 1) % 3 === 0 ? -100 : 50;
    cumulative += profit;
    return {
      tradeNumber: position + 1,
      entry: leg('le', 10 + position * 2, 100, 'Long'),
      exit: leg('lx', 11 + position * 2, 100 + profit / 10, 'Exit long'),
      isOpen: false,
      quantity: 10,
      profit: amount(profit, profit / 10),
      runup: amount(Math.max(profit, 0), 0),
      drawdown: amount(Math.max(-profit, 0), 0),
      cumulativeProfit: amount(cumulative, cumulative / 100),
    };
  });
}
