import {
  deriveEquity,
  downsample,
  legSeconds,
  toFills,
  toTrades,
  type ReadFill,
  type ReadTrade,
} from '../../../../src/tools/strategy/mappers.js';

// How what a page reads of a strategy report (readStrategyReport) becomes what the Strategy Tester
// tools return: the trades with their ISO times, the filled orders, the equity curve derived from
// the closed trades, and the downsampling of a curve. Values are synthetic.

// 2023-11-14T22:13:20Z, and the same time a day later.
const T0 = 1_700_000_000;
const DAY = 86_400;
const iso = (seconds: number): string =>
  new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');

const leg = (overrides: Partial<NonNullable<ReadTrade['exit']>> = {}) => ({
  type: 'le',
  time: T0,
  price: 100,
  id: 'Long',
  ...overrides,
});

const trade = (overrides: Partial<ReadTrade> = {}): ReadTrade => ({
  tradeNumber: null,
  isOpen: false,
  entry: leg(),
  exit: leg({ type: 'lx', time: T0 + DAY, price: 110, id: 'Exit long' }),
  quantity: 10,
  profit: 100,
  profitPercent: 10,
  cumulativeProfit: 100,
  runup: 120,
  drawdown: 20,
  ...overrides,
});

const fill = (overrides: Partial<ReadFill> = {}): ReadFill => ({
  id: 'Long',
  isBuy: true,
  isEntry: true,
  price: 100,
  quantity: 10,
  comment: null,
  barIndex: 20,
  time: T0,
  ...overrides,
});

describe('legSeconds', () => {
  test('keeps a time in seconds', () => {
    expect(legSeconds(T0)).toBe(T0);
  });

  test('turns a time above 1e11 from milliseconds into whole seconds', () => {
    expect(legSeconds(T0 * 1000)).toBe(T0);
    expect(legSeconds(T0 * 1000 + 999)).toBe(T0);
  });

  test('takes 1e11 itself for seconds, as every time of the server is read', () => {
    expect(legSeconds(1e11)).toBe(1e11);
    expect(legSeconds(1e11 + 1)).toBe(Math.floor((1e11 + 1) / 1000));
  });

  test('floors a fraction of a second', () => {
    expect(legSeconds(T0 + 0.9)).toBe(T0);
  });

  test('gives no time for none, or for a time no date can show', () => {
    expect(legSeconds(null)).toBeNull();
    expect(legSeconds(9e15)).toBeNull();
    expect(legSeconds(-9e15)).toBeNull();
  });
});

describe('toTrades', () => {
  test('trades map entry and exit with ISO times', () => {
    const { total, trades } = toTrades([trade({ tradeNumber: 7 })], 0, 100);

    expect(total).toBe(1);
    expect(trades).toStrictEqual([
      {
        number: 7,
        isOpen: false,
        side: 'long',
        entry: { time: T0, timeIso: '2023-11-14T22:13:20Z', price: 100, signal: 'Long' },
        exit: {
          time: T0 + DAY,
          timeIso: '2023-11-15T22:13:20Z',
          price: 110,
          signal: 'Exit long',
        },
        quantity: 10,
        profit: 100,
        profitPercent: 10,
        cumulativeProfit: 100,
        runup: 120,
        drawdown: 20,
      },
    ]);
  });

  test('turns the legs of a trade stamped in milliseconds into seconds', () => {
    const [mapped] = toTrades(
      [
        trade({
          entry: leg({ time: T0 * 1000 }),
          exit: leg({ time: (T0 + DAY) * 1000 }),
        }),
      ],
      0,
      100,
    ).trades;

    expect(mapped?.entry).toMatchObject({ time: T0, timeIso: iso(T0) });
    expect(mapped?.exit).toMatchObject({ time: T0 + DAY, timeIso: iso(T0 + DAY) });
  });

  test('names the side by the type of the entry leg: le is long, se is short, else none', () => {
    const sides = ['le', 'se', 'lx', 'sx', 'zz', null].map(
      (type) => toTrades([trade({ entry: leg({ type }) })], 0, 10).trades[0]?.side,
    );

    expect(sides).toEqual(['long', 'short', null, null, null, null]);
  });

  test('reports an open trade without an exit, whatever leg the page read for it', () => {
    const [open] = toTrades([trade({ isOpen: true })], 0, 10).trades;

    expect(open).toMatchObject({ isOpen: true, exit: null });
  });

  test('reports a trade that has no exit leg without one', () => {
    const [mapped] = toTrades([trade({ exit: null })], 0, 10).trades;

    expect(mapped?.exit).toBeNull();
  });

  test('numbers a trade by its trade number, else by its place in the whole list', () => {
    const list = [trade({ tradeNumber: 10 }), trade(), trade({ tradeNumber: 0 }), trade()];

    expect(toTrades(list, 0, 10).trades.map(({ number }) => number)).toEqual([10, 2, 0, 4]);
    // The place counts from the start of the list, not of the page.
    expect(toTrades(list, 1, 2).trades.map(({ number }) => number)).toEqual([2, 0]);
  });

  test('keeps a time no date can show out, with its ISO form, and keeps the rest of the leg', () => {
    const [mapped] = toTrades(
      [trade({ entry: leg({ time: null, price: null, id: null }), exit: leg({ time: 9e15 }) })],
      0,
      10,
    ).trades;

    expect(mapped?.entry).toStrictEqual({ time: null, timeIso: null, price: null, signal: null });
    expect(mapped?.exit).toMatchObject({ time: null, timeIso: null, price: 100 });
  });

  test('passes on the amounts it has, and null for the ones it lacks', () => {
    const [mapped] = toTrades(
      [
        trade({
          quantity: null,
          profit: null,
          profitPercent: null,
          cumulativeProfit: null,
          runup: null,
          drawdown: null,
        }),
      ],
      0,
      10,
    ).trades;

    expect(mapped).toMatchObject({
      quantity: null,
      profit: null,
      profitPercent: null,
      cumulativeProfit: null,
      runup: null,
      drawdown: null,
    });
  });

  test('pages with offset and limit, and counts every trade', () => {
    const list = Array.from({ length: 7 }, (_, position) => trade({ tradeNumber: position + 1 }));
    const numbers = (offset: number, limit: number) =>
      toTrades(list, offset, limit).trades.map(({ number }) => number);

    expect(numbers(0, 3)).toEqual([1, 2, 3]);
    expect(numbers(3, 3)).toEqual([4, 5, 6]);
    expect(numbers(6, 3)).toEqual([7]);
    expect(numbers(7, 3)).toEqual([]);
    expect(numbers(100, 3)).toEqual([]);
    expect(numbers(0, 100)).toHaveLength(7);
    for (const [offset, limit] of [
      [0, 3],
      [6, 3],
      [100, 3],
    ] as const) {
      expect(toTrades(list, offset, limit).total).toBe(7);
    }
  });

  test('reports an empty list as no trades', () => {
    expect(toTrades([], 0, 100)).toStrictEqual({ total: 0, trades: [] });
  });
});

describe('toFills', () => {
  test('names the side of an order and gives the time of its bar with its ISO form', () => {
    const { total, fills } = toFills(
      [
        fill(),
        fill({ id: 'Exit long', isBuy: false, isEntry: false, comment: 'Take profit', time: null }),
        fill({ id: null, isBuy: null, price: null, quantity: null, barIndex: null }),
      ],
      0,
      100,
    );

    expect(total).toBe(3);
    expect(fills).toStrictEqual([
      {
        id: 'Long',
        side: 'buy',
        isEntry: true,
        price: 100,
        quantity: 10,
        comment: null,
        barIndex: 20,
        time: T0,
        timeIso: '2023-11-14T22:13:20Z',
      },
      {
        id: 'Exit long',
        side: 'sell',
        isEntry: false,
        price: 100,
        quantity: 10,
        comment: 'Take profit',
        barIndex: 20,
        time: null,
        timeIso: null,
      },
      {
        id: null,
        side: null,
        isEntry: true,
        price: null,
        quantity: null,
        comment: null,
        barIndex: null,
        time: T0,
        timeIso: '2023-11-14T22:13:20Z',
      },
    ]);
  });

  test('keeps a time no date can show out', () => {
    const [mapped] = toFills([fill({ time: 9e15 })], 0, 10).fills;

    expect(mapped).toMatchObject({ time: null, timeIso: null });
  });

  test('pages with offset and limit, and counts every order', () => {
    const list = Array.from({ length: 5 }, (_, position) => fill({ barIndex: position }));

    const page = toFills(list, 3, 10);

    expect(page.total).toBe(5);
    expect(page.fills.map(({ barIndex }) => barIndex)).toEqual([3, 4]);
    expect(toFills(list, 0, 2).fills.map(({ barIndex }) => barIndex)).toEqual([0, 1]);
    expect(toFills(list, 9, 2)).toMatchObject({ total: 5, fills: [] });
  });
});

describe('deriveEquity', () => {
  test('equity is derived from cumulative profit without an equity series', () => {
    const closed = [
      trade({
        entry: leg({ time: T0 }),
        exit: leg({ time: T0 + 2 * DAY }),
        cumulativeProfit: 100,
      }),
      trade({
        entry: leg({ time: T0 + 3 * DAY }),
        exit: leg({ time: T0 + 5 * DAY }),
        cumulativeProfit: 50,
      }),
      trade({
        entry: leg({ time: T0 + 6 * DAY }),
        exit: leg({ time: T0 + 9 * DAY }),
        cumulativeProfit: 155,
      }),
    ];

    const { points, skipped } = deriveEquity(closed, 10_000);

    expect(skipped).toBe(0);
    // The curve starts at the first entry with the initial capital, then moves to the initial
    // capital plus the cumulative profit at the exit of each closed trade.
    expect(points).toStrictEqual([
      { time: T0, timeIso: iso(T0), equity: 10_000 },
      { time: T0 + 2 * DAY, timeIso: iso(T0 + 2 * DAY), equity: 10_100 },
      { time: T0 + 5 * DAY, timeIso: iso(T0 + 5 * DAY), equity: 10_050 },
      { time: T0 + 9 * DAY, timeIso: iso(T0 + 9 * DAY), equity: 10_155 },
    ]);
  });

  test('leaves an open trade out, as its profit is not realized', () => {
    const { points } = deriveEquity(
      [trade({ cumulativeProfit: 100 }), trade({ isOpen: true, cumulativeProfit: 900 })],
      1000,
    );

    expect(points.map(({ equity }) => equity)).toEqual([1000, 1100]);
  });

  test('orders the points by time, a trade that closed first coming first', () => {
    const { points } = deriveEquity(
      [
        trade({
          entry: leg({ time: T0 }),
          exit: leg({ time: T0 + 8 * DAY }),
          cumulativeProfit: 300,
        }),
        trade({
          entry: leg({ time: T0 + DAY }),
          exit: leg({ time: T0 + 2 * DAY }),
          cumulativeProfit: 100,
        }),
      ],
      1000,
    );

    expect(points.map(({ time, equity }) => [time - T0, equity])).toEqual([
      [0, 1000],
      [2 * DAY, 1100],
      [8 * DAY, 1300],
    ]);
  });

  test('puts the start of the curve at the earliest entry of the closed trades', () => {
    const { points } = deriveEquity(
      [
        trade({ entry: leg({ time: T0 + 4 * DAY }), exit: leg({ time: T0 + 5 * DAY }) }),
        trade({ entry: leg({ time: T0 + DAY }), exit: leg({ time: T0 + 6 * DAY }) }),
      ],
      1000,
    );

    expect(points[0]).toMatchObject({ time: T0 + DAY, equity: 1000 });
  });

  test('keeps two trades that closed at one time in the order they came, the start first', () => {
    const { points } = deriveEquity(
      [
        trade({ entry: leg({ time: T0 }), exit: leg({ time: T0 }), cumulativeProfit: 10 }),
        trade({ entry: leg({ time: T0 }), exit: leg({ time: T0 }), cumulativeProfit: 30 }),
      ],
      100,
    );

    expect(points.map(({ equity }) => equity)).toEqual([100, 110, 130]);
  });

  test('reads legs stamped in milliseconds as seconds', () => {
    const { points } = deriveEquity(
      [trade({ entry: leg({ time: T0 * 1000 }), exit: leg({ time: (T0 + DAY) * 1000 }) })],
      500,
    );

    expect(points.map(({ time }) => time)).toEqual([T0, T0 + DAY]);
  });

  test('skips a closed trade that has no exit time or no cumulative profit, and counts it', () => {
    const { points, skipped } = deriveEquity(
      [
        trade({ cumulativeProfit: 100 }),
        trade({ exit: null }),
        trade({ exit: leg({ time: null }) }),
        trade({ exit: leg({ time: 9e15 }) }),
        trade({ cumulativeProfit: null }),
      ],
      1000,
    );

    expect(skipped).toBe(4);
    expect(points.map(({ equity }) => equity)).toEqual([1000, 1100]);
  });

  test('has no start without a valid entry time, but keeps the exits', () => {
    const { points } = deriveEquity(
      [trade({ entry: leg({ time: null }), cumulativeProfit: 100 })],
      1000,
    );

    expect(points.map(({ equity }) => equity)).toEqual([1100]);
  });

  test('gives no points when no trade has closed, and no start either', () => {
    expect(deriveEquity([], 1000)).toStrictEqual({ points: [], skipped: 0 });
    expect(deriveEquity([trade({ isOpen: true })], 1000)).toStrictEqual({ points: [], skipped: 0 });
    expect(deriveEquity([trade({ exit: null })], 1000)).toStrictEqual({ points: [], skipped: 1 });
  });
});

describe('downsample', () => {
  const curve = (...equities: number[]) =>
    equities.map((equity, position) => ({ time: T0 + position * DAY, equity }));
  const equitiesOf = (points: readonly { equity: number }[]) => points.map(({ equity }) => equity);

  test('downsample keeps the first, last and extreme points', () => {
    const points = curve(10, 12, 9, 15, 11, 8, 14, 13, 10, 20);

    const kept = downsample(points, 6);

    // The interior splits in two stretches: 12 9 15 11 and 8 14 13 10. Each keeps its lowest and
    // highest point, in time order.
    expect(equitiesOf(kept)).toEqual([10, 9, 15, 8, 14, 20]);
    expect(kept[0]).toBe(points[0]);
    expect(kept.at(-1)).toBe(points.at(-1));
    // The lowest and the highest of the whole curve are among them.
    expect(Math.min(...equitiesOf(kept))).toBe(8);
    expect(Math.max(...equitiesOf(kept))).toBe(20);
  });

  test('returns every point when there are no more than maxPoints', () => {
    const points = curve(1, 2, 3, 4);

    expect(downsample(points, 4)).toEqual(points);
    expect(downsample(points, 500)).toEqual(points);
    expect(downsample(points, 4)).not.toBe(points);
    expect(downsample([], 10)).toEqual([]);
  });

  test('keeps only the first and the last point for a budget of two or three', () => {
    const points = curve(5, 1, 9, 3, 7, 2);

    expect(equitiesOf(downsample(points, 2))).toEqual([5, 2]);
    expect(equitiesOf(downsample(points, 3))).toEqual([5, 2]);
  });

  test('keeps one point of a stretch that is flat, and never more than maxPoints', () => {
    const points = curve(1, 4, 4, 4, 4, 4, 4, 9);

    const kept = downsample(points, 6);

    // Two stretches of three: 4 4 4 and 4 4 4. The lowest and the highest are one point each.
    expect(equitiesOf(kept)).toEqual([1, 4, 4, 9]);
    expect(kept.length).toBeLessThanOrEqual(6);
  });

  test('keeps the first of equal extremes', () => {
    const points = curve(0, 5, 1, 5, 1, 9);

    // One stretch of four (a budget of 4): 5 1 5 1 gives the first 1 and the first 5.
    expect(downsample(points, 4).map(({ time }) => (time - T0) / DAY)).toEqual([0, 1, 2, 5]);
  });

  test('returns points in time order that are a subsequence of the curve, with its extremes', () => {
    // A deterministic wobble, so no random numbers are involved.
    const points = Array.from({ length: 1000 }, (_, position) => ({
      time: T0 + position * DAY,
      equity: 1000 + ((position * 7919) % 211) - 100 + position / 10,
    }));

    for (const maxPoints of [2, 3, 4, 5, 10, 11, 100, 999]) {
      const kept = downsample(points, maxPoints);
      const indexes = kept.map((point) => points.indexOf(point));

      expect(indexes, String(maxPoints)).not.toContain(-1);
      expect(indexes, String(maxPoints)).toEqual([...indexes].sort((a, b) => a - b));
      expect(new Set(indexes).size, String(maxPoints)).toBe(indexes.length);
      expect(kept.length, String(maxPoints)).toBeLessThanOrEqual(maxPoints);
      expect(kept[0], String(maxPoints)).toBe(points[0]);
      expect(kept.at(-1), String(maxPoints)).toBe(points.at(-1));
      // From a budget of four the lowest and the highest point of the whole curve are kept: each is
      // the first, the last, or the extreme of its stretch.
      if (maxPoints >= 4) {
        expect(Math.min(...equitiesOf(kept)), String(maxPoints)).toBe(
          Math.min(...equitiesOf(points)),
        );
        expect(Math.max(...equitiesOf(kept)), String(maxPoints)).toBe(
          Math.max(...equitiesOf(points)),
        );
      }
    }
  });
});
