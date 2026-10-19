import {
  mapQuote,
  mapSearchResult,
  QUOTE_FIELDS,
  SEARCH_TYPES,
  searchTypeParam,
  stripTags,
  toBarRows,
  type SearchItem,
} from '../../../../src/tools/data/mappers.js';

// How the market data tools turn what the app holds into what they report. Prices are synthetic.

const DAY = 86_400;
const START = 1_704_153_600;
const row = (index: number, volume: unknown = 1000 + index): unknown[] => [
  START + index * DAY,
  100 + index,
  101 + index,
  99 + index,
  100.5 + index,
  volume,
];
const rows = Array.from({ length: 10 }, (_, index) => row(index));

describe('toBarRows', () => {
  test('toBarRows keeps the last count bars inside from/to', () => {
    const bars = toBarRows(rows, START + 2 * DAY, START + 7 * DAY, 3);

    expect(bars.map((bar) => bar.time)).toEqual([
      START + 5 * DAY,
      START + 6 * DAY,
      START + 7 * DAY,
    ]);
    expect(bars[0]).toStrictEqual({
      time: START + 5 * DAY,
      timeIso: '2024-01-07T00:00:00Z',
      open: 105,
      high: 106,
      low: 104,
      close: 105.5,
      volume: 1005,
    });
  });

  test('toBarRows keeps every bar of the range when the range holds fewer than count', () => {
    expect(toBarRows(rows, START + 8 * DAY, undefined, 100)).toHaveLength(2);
    expect(toBarRows(rows, undefined, START + DAY, 100)).toHaveLength(2);
    expect(toBarRows(rows, undefined, undefined, 100)).toHaveLength(10);
  });

  test('toBarRows reports a volume that is not a number as null', () => {
    const bars = toBarRows(
      [row(0).slice(0, 5), row(1, null), row(2, Number.NaN)],
      undefined,
      undefined,
      5,
    );

    expect(bars.map((bar) => bar.volume)).toEqual([null, null, null]);
  });

  test('toBarRows drops rows that are not bars', () => {
    const bars = toBarRows(
      [
        null,
        'bar',
        [START],
        [START, 1, 2, 'low', 1, 1],
        [Number.NaN, 1, 2, 0, 1, 1],
        [1e15, 1, 2, 0, 1, 1],
        row(3),
      ],
      undefined,
      undefined,
      10,
    );

    expect(bars.map((bar) => bar.time)).toEqual([START + 3 * DAY]);
  });
});

describe('mapQuote', () => {
  test('mapQuote maps TradingView quote fields and nulls missing ones', () => {
    expect(
      mapQuote({
        last_price: 103.42,
        change: -0.16,
        change_percent: -0.15,
        bid: 103.41,
        ask: 103.43,
        bid_size: 100,
        ask_size: 200,
        high_price: 103.72,
        low_price: 102.91,
        open_price: 103.58,
        prev_close_price: 103.58,
        volume: 4035204,
        currency_code: 'USD',
        lp_time: 1729987200,
      }),
    ).toStrictEqual({
      last: 103.42,
      change: -0.16,
      changePercent: -0.15,
      bid: 103.41,
      ask: 103.43,
      bidSize: 100,
      askSize: 200,
      high: 103.72,
      low: 102.91,
      open: 103.58,
      prevClose: 103.58,
      volume: 4035204,
      currency: 'USD',
      time: 1729987200,
      timeIso: '2024-10-27T00:00:00Z',
    });

    expect(mapQuote({ last_price: 1.07 })).toStrictEqual({
      last: 1.07,
      change: null,
      changePercent: null,
      bid: null,
      ask: null,
      bidSize: null,
      askSize: null,
      high: null,
      low: null,
      open: null,
      prevClose: null,
      volume: null,
      currency: null,
      time: null,
      timeIso: null,
    });
  });

  test('mapQuote reads only the names the app keeps, never the wire names lp, ch and chp', () => {
    const quote = mapQuote({ lp: 1, ch: 2, chp: 3 });

    expect([quote.last, quote.change, quote.changePercent]).toEqual([null, null, null]);
  });

  test('mapQuote nulls values of the wrong type and times it cannot report', () => {
    const quote = mapQuote({
      last_price: '103',
      currency_code: 5,
      lp_time: 1e15,
      volume: Infinity,
    });

    expect([quote.last, quote.currency, quote.time, quote.timeIso, quote.volume]).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  test('QUOTE_FIELDS lists every field mapQuote reads', () => {
    expect([...QUOTE_FIELDS].sort()).toEqual(
      [
        'last_price',
        'change',
        'change_percent',
        'bid',
        'ask',
        'bid_size',
        'ask_size',
        'high_price',
        'low_price',
        'open_price',
        'prev_close_price',
        'volume',
        'currency_code',
        'lp_time',
      ].sort(),
    );
  });
});

describe('stripTags and mapSearchResult', () => {
  test('stripTags removes <em> highlights', () => {
    expect(stripTags('<em>Apple</em> Inc.')).toBe('Apple Inc.');
    expect(stripTags('<em>AAPL</em>34')).toBe('AAPL34');
    // The regexp of the app also drops a tag cut off at the end.
    expect(stripTags('S&P 500 <em')).toBe('S&P 500 ');
    // So does a lone < with no > after it, which the app strips to the end as well.
    expect(stripTags('a < b')).toBe('a ');
  });

  const item = (overrides: Partial<SearchItem> = {}): SearchItem => ({
    symbol: '<em>AAPL</em>',
    description: '<em>Apple</em> Inc.',
    exchange: 'NASDAQ',
    prefix: null,
    type: 'stock',
    typespecs: ['common'],
    currency: 'USD',
    fullName: null,
    contract: null,
    ...overrides,
  });

  test('mapSearchResult builds the symbol from the exchange and strips tags', () => {
    expect(mapSearchResult(item())).toStrictEqual({
      symbol: 'NASDAQ:AAPL',
      ticker: 'AAPL',
      description: 'Apple Inc.',
      exchange: 'NASDAQ',
      type: 'stock',
      currency: 'USD',
    });
  });

  test('mapSearchResult prefers the prefix to the exchange, as the app does', () => {
    expect(mapSearchResult(item({ exchange: 'Cboe BZX', prefix: 'BATS' })).symbol).toBe(
      'BATS:AAPL',
    );
  });

  test('mapSearchResult takes an empty prefix as none, and an empty exchange as well', () => {
    expect(mapSearchResult(item({ prefix: '' })).symbol).toBe('NASDAQ:AAPL');
    expect(mapSearchResult(item({ prefix: '', exchange: '' })).symbol).toBe('AAPL');
  });

  test('mapSearchResult names the first contract of a futures root, which a click would show', () => {
    const result = mapSearchResult(
      item({ symbol: 'ES', exchange: 'CME_MINI', type: 'futures', contract: 'ES1!' }),
    );

    expect([result.symbol, result.ticker]).toEqual(['CME_MINI:ES1!', 'ES1!']);
  });

  test('mapSearchResult keeps the bare ticker when the item has no exchange', () => {
    const result = mapSearchResult(item({ exchange: null, currency: null, type: null }));

    expect([result.symbol, result.exchange, result.currency, result.type]).toEqual([
      'AAPL',
      null,
      null,
      null,
    ]);
  });
});

describe('search types', () => {
  test('crypto becomes the type the app sends for it, and the others stay as they are', () => {
    expect(SEARCH_TYPES.map(searchTypeParam)).toEqual([
      'stocks',
      'funds',
      'futures',
      'forex',
      'cfd',
      'bitcoin,crypto',
      'index',
      'bond',
      'economic',
      'options',
    ]);
  });
});
