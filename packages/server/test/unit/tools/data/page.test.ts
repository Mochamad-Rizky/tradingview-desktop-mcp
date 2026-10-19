import { setTimeout as delay } from 'node:timers/promises';
import type { CdpSession } from '../../../../src/core/cdp/types.js';
import type { TvMcpError } from '../../../../src/core/errors.js';
import {
  createPageBridge,
  type PageBridge,
  type PageFunction,
  type PageLibFunction,
} from '../../../../src/core/tv/page-bridge.js';
import { createPageLib } from '../../../../src/core/tv/page-lib.js';
import type { TvWindow } from '../../../../src/core/tv/tv-window.js';
import { QUOTE_FIELDS } from '../../../../src/tools/data/mappers.js';
import {
  readBarRows,
  readCachedQuote,
  readChartQuote,
  readChartSymbolInfo,
  readHistory,
  requestHistory,
  searchSymbolsViaApi,
} from '../../../../src/tools/data/page.js';
import type { JsonValue } from '../../../../src/utils/json.js';
import { failureOf } from '../../../helpers/failure-of.js';
import { createPageRuntime } from '../../../helpers/fake-cdp/runtime.js';
import { loadTvFixture, type TvStateFixture } from '../../../helpers/fake-tv/fixture.js';
import { syntheticBars } from '../../../helpers/fake-tv/synthetic-bars.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTvOverrides,
  type FakeTvWindow,
} from '../../../helpers/fake-tv/window.js';

// The page functions of the market data tools, run the way the server runs them, as source text
// in a page through the real page bridge, and called directly on a second window built the same
// way, which is what the coverage of the module measures. The two answers must agree. Prices are
// synthetic.

const fixture = loadTvFixture();
const DAY = 86_400;
const bars = syntheticBars(fixture.bars);
const barTime = (index: number): number => fixture.bars.startTime + index * DAY;
const FIELDS = [...QUOTE_FIELDS];

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
});

function bridgeTo(win: object): PageBridge {
  const runtime = createPageRuntime(win);
  disposers.push(() => {
    runtime.dispose();
  });
  const send = (method: string, params?: unknown): Promise<unknown> =>
    method === 'Runtime.evaluate'
      ? runtime.evaluate(params as Record<string, unknown>)
      : Promise.reject(new Error(`Unexpected command ${method}`));
  const session: CdpSession = {
    targetId: 'PAGE1',
    isClosed: false,
    send: send as CdpSession['send'],
    onClose: () => undefined,
    close: () => Promise.resolve(),
  };
  return createPageBridge(session, { timeoutMs: 5000 });
}

type Make = () => object;

const chart =
  (from: TvStateFixture = fixture, overrides: FakeTvOverrides = {}): Make =>
  () =>
    createFakeTvWindow(from, overrides);

const plain =
  (win: object): Make =>
  () =>
    win;

async function resultOf<A extends JsonValue[], R extends JsonValue | null>(
  fn: PageFunction<A, R>,
  args: A,
  make: Make,
): Promise<{ result: R; win: object }> {
  const win = make();
  const result = await bridgeTo(win).evaluate(fn, args);
  const direct = await fn(make() as TvWindow, ...args);
  expect(direct).toEqual(result);
  return { result, win };
}

async function libResultOf<A extends JsonValue[], R extends JsonValue | null>(
  fn: PageLibFunction<A, R>,
  args: A,
  make: Make,
): Promise<{ result: R; win: object }> {
  const win = make();
  const result = await bridgeTo(win).evaluateWithLib(fn, args);
  const other = make() as TvWindow;
  const direct = await fn(other, createPageLib(other), ...args);
  expect(direct).toEqual(result);
  return { result, win };
}

async function failureOfBoth<A extends JsonValue[], R extends JsonValue | null>(
  fn: PageFunction<A, R>,
  args: A,
  make: Make,
): Promise<{ error: TvMcpError; win: object }> {
  const win = make();
  const error = await failureOf(bridgeTo(win).evaluate(fn, args));
  const direct = await fn(make() as TvWindow, ...args);
  expect(direct).toEqual({ __tvmcpError: error.toPayload() });
  return { error, win };
}

const callsOf = (win: object) => inspectFakeWindow(win).calls;

function seriesOf(win: FakeTvWindow) {
  const api = win.TradingViewApi;
  if (api === undefined) {
    throw new Error('The fake window has no TradingViewApi');
  }
  return api.activeChart()._chartWidget.model().mainSeries();
}

// A page whose chart has a series made of `series`, and nothing else of the app.
function withSeries(series: object, chartMembers: object = {}): Make {
  return plain({
    TradingViewApi: {
      activeChart: () => ({
        symbol: () => 'NASDAQ:AAPL',
        resolution: () => '1D',
        _chartWidget: { model: () => ({ mainSeries: () => series }) },
        ...chartMembers,
      }),
    },
  });
}

// A bar container over `rows`, indexed from `first`.
function barsOf(rows: unknown[], first = 0) {
  return {
    size: () => rows.length,
    firstIndex: () => (rows.length === 0 ? null : first),
    lastIndex: () => (rows.length === 0 ? null : first + rows.length - 1),
    valueAt: (index: number) => rows[index - first] ?? null,
  };
}

const NO_CHART: [string, Make][] = [
  ['a page without TradingViewApi', plain({})],
  ['a page whose app has not booted', chart(fixture, { withoutApi: true })],
  [
    'a page whose activeChart throws',
    plain({
      TradingViewApi: {
        activeChart: () => {
          throw new Error('No chart is active');
        },
      },
    }),
  ],
];

describe('readHistory', () => {
  test('reads how many bars the series holds and whether it can load more', async () => {
    const { result } = await resultOf(readHistory, [null, null, null], chart());

    expect(result).toStrictEqual({
      size: 300,
      inRange: 300,
      firstTime: barTime(0),
      loading: false,
      available: true,
      endOfData: false,
      endOfDataType: null,
      canLoad: true,
    });
  });

  test('counts the bars between from and to, in the times of the rows', async () => {
    const { result } = await resultOf(readHistory, [0, barTime(10), barTime(19)], chart());

    expect(result).toMatchObject({ size: 300, inRange: 10, firstTime: barTime(0) });
  });

  test('reports a request that runs, and the end of the data with its reason', async () => {
    const win = createFakeTvWindow({ ...fixture, history: { totalBars: 300, endOfDataType: 'x' } });
    const bridge = bridgeTo(win);
    seriesOf(win).requestMoreData(10);

    expect(await bridge.evaluate(readHistory, [null, null, null])).toMatchObject({
      loading: true,
      available: false,
      endOfData: false,
    });
    await delay(30);
    expect(await bridge.evaluate(readHistory, [null, null, null])).toMatchObject({
      loading: false,
      available: false,
      endOfData: true,
      endOfDataType: 'x',
    });
  });

  test('a series without the members of history loading cannot load, and reads as idle', async () => {
    const { result } = await resultOf(
      readHistory,
      [null, null, null],
      withSeries({ bars: () => barsOf(bars.slice(0, 3), -5) }),
    );

    expect(result).toStrictEqual({
      size: 3,
      inRange: 3,
      firstTime: barTime(0),
      loading: false,
      available: false,
      endOfData: false,
      endOfDataType: null,
      canLoad: false,
    });
  });

  test('passes over rows without a time, and reports a series without bars', async () => {
    const rows = [null, ['x'], bars[5], bars[6]];
    const { result } = await resultOf(
      readHistory,
      [null, null, null],
      withSeries({ bars: () => barsOf(rows), endOfDataType: () => 5 }),
    );
    const { result: empty } = await resultOf(
      readHistory,
      [null, null, null],
      withSeries({ bars: () => barsOf([]) }),
    );

    expect(result).toMatchObject({
      size: 4,
      inRange: 2,
      firstTime: barTime(5),
      endOfDataType: null,
    });
    expect(empty).toMatchObject({ size: 0, inRange: 0, firstTime: null });
  });

  test('reads the chart named by its index', async () => {
    const { result } = await resultOf(readHistory, [0, null, null], chart());

    expect(result).toMatchObject({ size: 300 });
  });

  test.each([
    ...NO_CHART,
    ['a series without bars()', withSeries({})],
    ['a bar container without valueAt', withSeries({ bars: () => ({ size: () => 1 }) })],
  ])('is unavailable on %s', async (_case, make) => {
    const { error } = await failureOfBoth(readHistory, [null, null, null], make);

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(error.hint).toMatch(/app_health/);
  });
});

describe('requestHistory', () => {
  test('asks the series for older bars and reports that the request went out', async () => {
    const { result, win } = await resultOf(requestHistory, [null, 120], chart());

    expect(result).toStrictEqual({ sent: true });
    expect(inspectFakeWindow(win).callsTo('series.requestMoreData')).toEqual([[120]]);
  });

  test('asks the series of the chart named by its index', async () => {
    const { result, win } = await resultOf(requestHistory, [0, 5], chart());

    expect(result).toStrictEqual({ sent: true });
    expect(inspectFakeWindow(win).callsTo('series.requestMoreData')).toEqual([[5]]);
  });

  test('reports a request the series did not send', async () => {
    const make = (): object => {
      const win = createFakeTvWindow(fixture);
      seriesOf(win).requestMoreData(1);
      return win;
    };

    const { result } = await resultOf(requestHistory, [null, 10], make);

    expect(result).toStrictEqual({ sent: false });
  });

  test('takes a series without isLoading by the availability alone', () => {
    let available = true;
    const series = {
      requestMoreData: () => {
        available = false;
      },
      requestMoreDataAvailable: () => available,
    };

    expect(requestHistory(withSeries(series)() as TvWindow, null, 5)).toEqual({ sent: true });
  });

  test.each([
    ...NO_CHART,
    ['a series without requestMoreData', withSeries({ bars: () => barsOf([]) })],
  ])('is unavailable on %s, before anything is asked', async (_case, make) => {
    const { error, win } = await failureOfBoth(requestHistory, [null, 10], make);

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
    let recorded: readonly unknown[] = [];
    try {
      recorded = callsOf(win);
    } catch {
      // A plain object has nothing to record.
    }
    expect(recorded).toEqual([]);
  });
});

describe('readBarRows', () => {
  test('returns the last count rows inside from and to, oldest first, with the chart names', async () => {
    const { result } = await resultOf(readBarRows, [null, barTime(10), barTime(19), 3], chart());

    expect(result).toStrictEqual({
      symbol: 'NASDAQ:AAPL',
      resolution: '1D',
      rows: [bars[17], bars[18], bars[19]],
    });
  });

  test('reads the chart named by its index', async () => {
    const { result } = await resultOf(readBarRows, [0, null, null, 2], chart());

    expect(result).toMatchObject({ rows: bars.slice(298) });
  });

  test('returns every row of the range when it holds fewer than count', async () => {
    const { result } = await resultOf(readBarRows, [null, barTime(295), null, 100], chart());

    expect(result).toMatchObject({ rows: bars.slice(295) });
  });

  test('copies values that are not numbers as null and passes over rows without a time', async () => {
    const rows = [[barTime(0), 1, 2, 0.5, 1.5, undefined], null, ['x', 1, 1, 1, 1, 1]];
    const { result } = await resultOf(
      readBarRows,
      [null, null, null, 10],
      withSeries({ bars: () => barsOf(rows) }, { symbol: () => 5 }),
    );

    expect(result).toStrictEqual({
      symbol: null,
      resolution: '1D',
      rows: [[barTime(0), 1, 2, 0.5, 1.5, null]],
    });
  });

  test('returns no rows for a series without bars', async () => {
    const { result } = await resultOf(readBarRows, [null, null, null, 10], chart(fixture, {}));
    const { result: empty } = await resultOf(
      readBarRows,
      [null, null, null, 10],
      withSeries({ bars: () => barsOf([]) }),
    );

    expect((result as { rows: unknown[] }).rows).toHaveLength(10);
    expect(empty).toMatchObject({ rows: [] });
  });

  test.each([...NO_CHART, ['a series without bars()', withSeries({})]])(
    'is unavailable on %s',
    async (_case, make) => {
      const { error } = await failureOfBoth(readBarRows, [null, null, null, 10], make);

      expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
    },
  );
});

describe('readChartQuote', () => {
  test('copies the fields asked for out of the live quote, with the names of the symbol', async () => {
    const { result } = await resultOf(readChartQuote, [FIELDS], chart());

    expect(result).toStrictEqual({
      symbol: 'NASDAQ:AAPL',
      proName: 'NASDAQ:AAPL',
      fullName: 'NASDAQ:AAPL',
      values: fixture.quote,
    });
  });

  test('keeps only the fields asked for, and only text, numbers and booleans', async () => {
    const quote = {
      last_price: 5,
      bid: Number.NaN,
      ask: { price: 1 },
      currency_code: 'USD',
      volume: true,
      description: 'Not asked for',
    };
    const { result } = await resultOf(
      readChartQuote,
      [FIELDS],
      withSeries({ quotes: () => quote, symbolInfo: () => null }),
    );

    expect(result).toStrictEqual({
      symbol: 'NASDAQ:AAPL',
      proName: null,
      fullName: null,
      values: { last_price: 5, currency_code: 'USD', volume: true },
    });
  });

  test('reports no values while the series has no quote', async () => {
    const make = (): object => {
      const win = createFakeTvWindow(fixture);
      inspectFakeWindow(win).state.symbolInvalid = true;
      return win;
    };

    const { result } = await resultOf(readChartQuote, [FIELDS], make);

    expect(result).toMatchObject({ values: null, proName: null });
  });

  test.each([...NO_CHART, ['a series without quotes()', withSeries({})]])(
    'is unavailable on %s',
    async (_case, make) => {
      const { error } = await failureOfBoth(readChartQuote, [FIELDS], make);

      expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
    },
  );
});

describe('readCachedQuote', () => {
  test('reads the quote field cache first', async () => {
    const { result } = await libResultOf(readCachedQuote, ['NASDAQ:MSFT', FIELDS], chart());

    // The description is in the cache too, but not among the fields asked for.
    const values = Object.fromEntries(
      Object.entries(fixture.quoteCache.fields['NASDAQ:MSFT'] ?? {}).filter(
        ([field]) => field !== 'description',
      ),
    );
    expect(result).toStrictEqual({ symbol: 'NASDAQ:MSFT', source: 'quote cache', values });
  });

  test('falls back to the full quote session and then to the watchlist cache', async () => {
    const { result: session } = await libResultOf(readCachedQuote, ['NYSE:IBM', FIELDS], chart());
    const { result: watchlist } = await libResultOf(
      readCachedQuote,
      ['FX:EURUSD', FIELDS],
      chart(),
    );

    expect(session).toStrictEqual({
      symbol: 'NYSE:IBM',
      source: 'quote session',
      values: fixture.quoteCache.full['NYSE:IBM'],
    });
    expect(watchlist).toStrictEqual({
      symbol: 'FX:EURUSD',
      source: 'watchlist',
      values: fixture.quoteCache.watchlist['FX:EURUSD'],
    });
  });

  test('finds a symbol written in lower case', async () => {
    const { result } = await libResultOf(readCachedQuote, ['nasdaq:msft', FIELDS], chart());

    expect(result).toMatchObject({ symbol: 'NASDAQ:MSFT', source: 'quote cache' });
  });

  test('passes over an error entry and answers null when no cache holds the symbol', async () => {
    const { result: failed } = await libResultOf(readCachedQuote, ['NASDAQ:NVDA', FIELDS], chart());
    const { result: unknown } = await libResultOf(readCachedQuote, ['NYSE:NOPE', FIELDS], chart());
    const { result: inherited } = await libResultOf(
      readCachedQuote,
      ['constructor', FIELDS],
      chart(),
    );

    expect([failed, unknown, inherited]).toEqual([null, null, null]);
  });

  test('passes over an entry without any field asked for', async () => {
    const { result } = await libResultOf(readCachedQuote, ['NASDAQ:MSFT', ['logoid']], chart());

    expect(result).toBeNull();
  });

  test('never calls what would create a quote session or send a request', async () => {
    const { win } = await libResultOf(readCachedQuote, ['NYSE:NOPE', FIELDS], chart());

    expect(callsOf(win)).toEqual([]);
  });

  test.each<[string, FakeTvOverrides]>([
    ['the quote modules are not loaded', { webpackModules: {} }],
    ['the webpack runtime has not loaded', { withoutWebpackRuntime: true }],
  ])('answers null when %s', async (_case, overrides) => {
    const { result } = await libResultOf(
      readCachedQuote,
      ['NASDAQ:MSFT', FIELDS],
      chart(fixture, overrides),
    );

    expect(result).toBeNull();
  });

  test('copes with caches whose members are missing or throw', async () => {
    const broken = {
      1: { QUOTE_FIELDS_CACHE: { get: () => ({ status: 'ok', values: 'none' }) } },
      2: {
        getQuoteSessionNoEnsure: () => {
          throw new Error('Not ready');
        },
      },
      3: { quoteSessionAdapters: { _lastSymbolData: { has: () => true, get: () => null } } },
    };

    const { result } = await libResultOf(
      readCachedQuote,
      ['NASDAQ:MSFT', FIELDS],
      chart(fixture, { webpackModules: broken }),
    );

    expect(result).toBeNull();
  });
});

describe('readChartSymbolInfo', () => {
  const KEYS = [
    'pro_name',
    'description',
    'typespecs',
    'pricescale',
    'has_intraday',
    'subsessions',
  ];

  test('copies the keys asked for out of the symbol info, with the symbol the chart shows', async () => {
    const { result } = await resultOf(readChartSymbolInfo, [KEYS], chart());

    expect(result).toStrictEqual({
      symbol: 'NASDAQ:AAPL',
      info: {
        pro_name: 'NASDAQ:AAPL',
        description: 'Apple Inc.',
        typespecs: ['common'],
        pricescale: 100,
        has_intraday: true,
      },
    });
  });

  test('keeps only lists of text, and reports no info while the symbol is not resolved', async () => {
    const { result } = await resultOf(
      readChartSymbolInfo,
      [['typespecs']],
      withSeries({ symbolInfo: () => ({ typespecs: ['a', 1] }) }),
    );
    const { result: unresolved } = await resultOf(
      readChartSymbolInfo,
      [KEYS],
      withSeries({ symbolInfo: () => null }),
    );

    const { result: unnamed } = await resultOf(
      readChartSymbolInfo,
      [['type']],
      withSeries({ symbolInfo: () => ({ type: 'stock' }) }, { symbol: () => undefined }),
    );

    expect(result).toStrictEqual({ symbol: 'NASDAQ:AAPL', info: {} });
    expect(unresolved).toStrictEqual({ symbol: 'NASDAQ:AAPL', info: null });
    expect(unnamed).toStrictEqual({ symbol: null, info: { type: 'stock' } });
  });

  test.each([...NO_CHART, ['a series without symbolInfo()', withSeries({})]])(
    'is unavailable on %s',
    async (_case, make) => {
      const { error } = await failureOfBoth(readChartSymbolInfo, [KEYS], make);

      expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
    },
  );
});

describe('searchSymbolsViaApi', () => {
  test('asks the search of the app without highlights and copies the items', async () => {
    const { result, win } = await resultOf(searchSymbolsViaApi, ['AAPL', null, null], chart());

    expect(result).toStrictEqual({
      items: [
        {
          symbol: '<em>AAPL</em>',
          description: '<em>Apple</em> Inc.',
          exchange: 'NASDAQ',
          prefix: null,
          type: 'stock',
          typespecs: ['common'],
          currency: 'USD',
          fullName: null,
          contract: null,
        },
        expect.objectContaining({ exchange: 'Cboe BZX', prefix: 'BATS' }) as unknown,
        expect.objectContaining({
          exchange: 'BMFBOVESPA',
          currency: 'BRL',
          typespecs: [],
        }) as unknown,
      ],
      remaining: 37,
    });
    expect(inspectFakeWindow(win).callsTo('TradingViewApi.searchSymbols')).toEqual([
      [{ text: 'AAPL', serverHighlight: false }],
    ]);
  });

  test('passes the exchange and the type, and names the first contract of a futures root', async () => {
    const { result, win } = await resultOf(
      searchSymbolsViaApi,
      ['ES', 'CME_MINI', 'futures'],
      chart(),
    );

    expect(result).toMatchObject({ items: [{ symbol: 'ES', contract: 'ES1!' }] });
    expect(inspectFakeWindow(win).callsTo('TradingViewApi.searchSymbols')).toEqual([
      [{ text: 'ES', serverHighlight: false, exchange: 'CME_MINI', type: 'futures' }],
    ]);
  });

  test('drops items without a symbol and reads a remaining count that is not a number as null', async () => {
    const searchSymbols = () =>
      Promise.resolve({
        symbols: [null, { description: 'x' }, { symbol: 'X', typespecs: 'common', contracts: [] }],
        symbols_remaining: '3',
      });

    const { result } = await resultOf(
      searchSymbolsViaApi,
      ['X', null, null],
      plain({ TradingViewApi: { searchSymbols } }),
    );

    expect(result).toStrictEqual({
      items: [
        {
          symbol: 'X',
          description: '',
          exchange: null,
          prefix: null,
          type: null,
          typespecs: null,
          currency: null,
          fullName: null,
          contract: null,
        },
      ],
      remaining: null,
    });
  });

  test('reports an answer without a list of symbols as no items', async () => {
    const { result } = await resultOf(
      searchSymbolsViaApi,
      ['X', null, null],
      plain({ TradingViewApi: { searchSymbols: () => Promise.resolve(null) } }),
    );

    expect(result).toStrictEqual({ items: [], remaining: null });
  });

  test('turns a failed search into NOT_AVAILABLE with the message of the app', async () => {
    const { error } = await failureOfBoth(
      searchSymbolsViaApi,
      ['X', null, null],
      plain({
        TradingViewApi: {
          searchSymbols: () => Promise.reject(new Error('503: Service Unavailable')),
        },
      }),
    );
    const { error: thrown } = await failureOfBoth(
      searchSymbolsViaApi,
      ['X', null, null],
      plain({
        TradingViewApi: {
          // A page can throw anything, not only errors.
          searchSymbols: () => {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- see above
            throw 'offline';
          },
        },
      }),
    );

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(error.message).toMatch(/503: Service Unavailable/);
    expect(thrown.message).toMatch(/offline/);
  });

  test.each([
    ['a page without TradingViewApi', plain({})],
    ['an API without searchSymbols', plain({ TradingViewApi: {} })],
  ])('is unavailable on %s', async (_case, make) => {
    const { error } = await failureOfBoth(searchSymbolsViaApi, ['X', null, null], make);

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
  });
});
