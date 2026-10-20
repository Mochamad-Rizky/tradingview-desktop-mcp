import type { SeriesLike, TvWindow } from '../../src/core/tv/tv-window.js';
import { readHistory } from '../../src/tools/data/page.js';
import { pollUntil } from '../../src/utils/poll.js';
import { toIso } from '../../src/utils/time.js';
import { callTool } from '../helpers/mcp-client.js';
import {
  callOk,
  changeThenRestore,
  e2eEnabled,
  expectChartRestored,
  observe,
  prepareChartChange,
  readChartState,
  restoreChartAndView,
  startE2eServer,
  type ChartChangePlan,
  type E2eServer,
  type ToolFailure,
} from './setup.js';

// The market data tools against the real TradingView Desktop. Every test only reads, apart from
// one, which loads a few dozen bars of older history into the chart, the way a scroll to the left
// does, inside the snapshot and restore of the chart (setup.ts). Nothing of the user is printed:
// the chart symbol and the prices are compared, never shown, and what the tests observe of the app
// is key names, types, counts and booleans.

// How many bars beyond those loaded the history test asks for, in each of its two requests.
const OLDER_BARS = 20;

interface Bar {
  time: number;
  timeIso: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

interface Ohlcv {
  symbol: string | null;
  resolution: string | null;
  bars: Bar[];
  complete: boolean;
}

interface Quote {
  symbol: string | null;
  last: number | null;
  change: number | null;
  changePercent: number | null;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  high: number | null;
  low: number | null;
  open: number | null;
  prevClose: number | null;
  volume: number | null;
  currency: string | null;
  time: number | null;
  timeIso: string | null;
}

interface SymbolInfo {
  source: 'chart' | 'search';
  symbol: string;
  fullName: string | null;
  proName: string | null;
  exchange: string | null;
  description: string | null;
  type: string | null;
  currency: string | null;
  pricescale: number | null;
  minmov: number | null;
  timezone: string | null;
  session: string | null;
  hasIntraday: boolean | null;
}

interface SearchResult {
  symbol: string;
  ticker: string;
  description: string;
  exchange: string | null;
  type: string | null;
  currency: string | null;
}

// What is wrong with a list of bars, without a value: each bar has finite prices, a high at or above
// its other prices and a low at or below them, an ISO time that matches its time, and a time after
// that of the bar before it.
function barProblems(bars: readonly Bar[]): string[] {
  return bars.flatMap((bar, index) => {
    const prices = [bar.open, bar.high, bar.low, bar.close];
    const problems: string[] = [];
    if (!prices.every(Number.isFinite)) {
      problems.push(`bar ${String(index)} has a price that is not a number`);
    }
    if (
      bar.high < Math.max(bar.open, bar.close, bar.low) ||
      bar.low > Math.min(bar.open, bar.close)
    ) {
      problems.push(`bar ${String(index)} has a high or low outside its other prices`);
    }
    if (bar.timeIso !== toIso(bar.time)) {
      problems.push(`bar ${String(index)} has an ISO time that is not its time`);
    }
    const previous = bars[index - 1];
    if (previous !== undefined && !(bar.time > previous.time)) {
      problems.push(`bar ${String(index)} is not later than the bar before it`);
    }
    return problems;
  });
}

// Asks the main series of the active chart for `count` older bars, as data_get_ohlcv does, and
// answers what it said right before the call and right after it, in the same task: whether a load
// runs, whether another request may be sent, and how many bars it holds.
function requestOlderBars(
  win: TvWindow,
  count: number,
): {
  before: { loading: boolean; available: boolean; size: number | null };
  after: { loading: boolean; available: boolean; size: number | null };
} {
  const series = win.TradingViewApi?.activeChart()._chartWidget?.model().mainSeries() as
    Partial<SeriesLike> | undefined;
  const read = () => {
    const size: unknown = series?.bars?.().size();
    return {
      loading: series?.isLoading?.() === true,
      available: series?.requestMoreDataAvailable?.() === true,
      size: typeof size === 'number' ? size : null,
    };
  };
  const before = read();
  series?.requestMoreData?.(count);
  return { before, after: read() };
}

// What the symbol search of the app answers for `text`, as data_search_symbols asks it (one request,
// without highlight markup): how many items, the keys they carry with the types of their values,
// whether any symbol or description holds markup, and the fields of the first item whose symbol is
// `text`, which names a public listing. Nothing of the user is in it.
function searchItemShapes(
  win: TvWindow,
  text: string,
): Promise<{
  items: number;
  remaining: string;
  keys: string[];
  markup: boolean;
  match: { prefix: string | null; exchange: string | null; fullName: string | null } | null;
}> {
  const api = win.TradingViewApi;
  return Promise.resolve()
    .then(() => api?.searchSymbols?.({ text, serverHighlight: false }))
    .then((response: unknown) => {
      const { symbols, symbols_remaining: remaining } = (response ?? {}) as {
        symbols?: unknown;
        symbols_remaining?: unknown;
      };
      const items = (Array.isArray(symbols) ? symbols : []) as Record<string, unknown>[];
      const types = new Map<string, Set<string>>();
      for (const item of items) {
        for (const [key, value] of Object.entries(item)) {
          const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
          types.set(key, (types.get(key) ?? new Set()).add(type));
        }
      }
      const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);
      const match = items.find((item) => textOf(item.symbol) === text);
      return {
        items: items.length,
        remaining: typeof remaining,
        keys: [...types].map(([key, set]) => `${key}: ${[...set].join('|')}`).sort(),
        markup: items.some((item) =>
          /<[^>]*>/.test(`${textOf(item.symbol) ?? ''} ${textOf(item.description) ?? ''}`),
        ),
        match:
          match === undefined
            ? null
            : {
                prefix: textOf(match.prefix),
                exchange: textOf(match.exchange),
                fullName: textOf(match.full_name),
              },
      };
    });
}

describe.skipIf(!e2eEnabled())('the market data tools against TradingView Desktop', () => {
  let e2e: E2eServer | undefined;
  // The snapshot and the view the history test puts back, or why it may not change the chart.
  let plan: ChartChangePlan | undefined;

  beforeAll(async () => {
    e2e = await startE2eServer();
    plan = await prepareChartChange(e2e);
  });

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

  function server(): E2eServer {
    if (e2e === undefined) {
      throw new Error('The server did not start');
    }
    return e2e;
  }

  // What the main series of the active chart says about its history, read only.
  async function loadedBars() {
    const page = await server().ctx.connection.chartPage();
    return page.bridge.evaluate(readHistory, [null, null, null]);
  }

  test('OHLCV returns ascending bars', async () => {
    const { client } = server();
    const state = await readChartState(client);
    // No more than the chart holds, so that nothing is loaded.
    const count = Math.min(50, (await loadedBars()).size);
    expect(count).toBeGreaterThan(0);

    const { data, via, warnings } = await callOk<Ohlcv>(client, 'data_get_ohlcv', { count });

    expect(data.symbol === state.symbol, 'the bars are those of the chart symbol').toBe(true);
    expect(data.resolution === state.resolution, 'the bars are of the chart timeframe').toBe(true);
    expect(data.bars.length === count, 'every bar asked for').toBe(true);
    expect(data.complete).toBe(true);
    expect(barProblems(data.bars)).toEqual([]);
    expect(via).toBe('internal');
    expect(warnings.length === 0, 'data_get_ohlcv gives no warning').toBe(true);
  });

  test('quote of the chart symbol has a last price', async () => {
    const { client } = server();
    const state = await readChartState(client);

    // Right after the chart was switched (the chart suite may run just before), its quote comes a
    // moment later, which the tool says with NOT_AVAILABLE: it is asked again for a while.
    await pollUntil(
      () => callTool(client, 'data_get_quote'),
      (result) => result.isError !== true,
      { intervalMs: 250, timeoutMs: 10_000 },
    );
    const { data } = await callOk<Quote>(client, 'data_get_quote');

    expect(data.symbol === state.symbol, 'the quote is of the chart symbol').toBe(true);
    expect(typeof data.last === 'number' && Number.isFinite(data.last)).toBe(true);
    const numbers = [
      data.change,
      data.changePercent,
      data.bid,
      data.ask,
      data.bidSize,
      data.askSize,
      data.high,
      data.low,
      data.open,
      data.prevClose,
      data.volume,
    ];
    expect(numbers.every((value) => value === null || Number.isFinite(value))).toBe(true);
    expect(data.time === null || data.timeIso === toIso(data.time)).toBe(true);
    observe('quote of the chart symbol', {
      reported: Object.entries(data)
        .filter(([, value]) => value !== null)
        .map(([key]) => key),
      missing: Object.entries(data)
        .filter(([, value]) => value === null)
        .map(([key]) => key),
    });
  });

  test('symbol info of the chart symbol', async () => {
    const { client } = server();
    const state = await readChartState(client);

    const { data, warnings } = await callOk<SymbolInfo>(client, 'data_get_symbol_info');

    expect(data.source).toBe('chart');
    expect(data.symbol === state.symbol, 'the info is of the chart symbol').toBe(true);
    for (const text of [data.proName, data.description, data.type, data.timezone, data.session]) {
      expect(typeof text === 'string' && text !== '').toBe(true);
    }
    expect(typeof data.pricescale === 'number' && data.pricescale > 0).toBe(true);
    expect(typeof data.minmov === 'number' && data.minmov > 0).toBe(true);
    expect(typeof data.hasIntraday).toBe('boolean');
    expect(warnings.length === 0, 'data_get_symbol_info gives no warning').toBe(true);
  });

  test('symbol info of another symbol comes from the symbol search', async () => {
    const { client } = server();

    const { data, warnings } = await callOk<SymbolInfo>(client, 'data_get_symbol_info', {
      symbol: 'NASDAQ:AAPL',
    });

    // A chart that shows Apple answers from the chart instead.
    if (data.source === 'chart') {
      expect(data.symbol.endsWith(':AAPL'), 'the info is of AAPL').toBe(true);
      return;
    }
    expect(data.symbol === 'NASDAQ:AAPL', 'the info is of NASDAQ:AAPL').toBe(true);
    expect(data.description).toMatch(/apple/i);
    expect(data.pricescale).toBeNull();
    expect(warnings.length === 1, 'a warning says that only some fields are filled').toBe(true);
  });

  test('search finds AAPL', async () => {
    const { client, ctx } = server();

    const { data, via } = await callOk<{ results: SearchResult[]; remaining: number }>(
      client,
      'data_search_symbols',
      { query: 'AAPL', limit: 10 },
    );

    expect(via).toBe('api');
    const apple = data.results.find((result) => result.ticker === 'AAPL');
    expect(/^[A-Z][A-Z0-9_]*:AAPL$/.test(apple?.symbol ?? ''), 'AAPL comes as EXCHANGE:AAPL').toBe(
      true,
    );
    expect(apple?.description).toMatch(/apple/i);
    const texts = data.results.map(
      ({ symbol, ticker, description }) => symbol + ticker + description,
    );
    expect(texts.some((text) => /[<>]/.test(text))).toBe(false);
    expect(Number.isInteger(data.remaining)).toBe(true);

    const page = await ctx.connection.chartPage();
    const shapes = await page.bridge.evaluate(searchItemShapes, ['AAPL']);
    observe('symbol search items for AAPL', shapes);
    expect(shapes.items).toBeGreaterThan(0);
    expect(shapes.markup).toBe(false);
  });

  test('the top of the book of the chart symbol', async () => {
    const { client } = server();

    const result = await callTool(client, 'data_get_market_depth', { levels: 5 });

    if (result.isError === true) {
      const { error } = result.structuredContent as { error: ToolFailure };
      expect(error.code).toBe('NOT_AVAILABLE');
      observe('top of the book', { available: false });
      return;
    }
    const { data, meta } = result.structuredContent as {
      data: {
        levels: number;
        fullDepth: boolean;
        bids: { price: number; size: number | null }[];
        asks: { price: number; size: number | null }[];
      };
      meta: { warnings?: string[] };
    };
    // The book holds the prices of the moment, so only its shape is compared.
    expect(data.levels === 1 && !data.fullDepth, 'one level, not the full depth').toBe(true);
    expect(data.bids.length + data.asks.length).toBeGreaterThan(0);
    expect(data.bids.length <= 1 && data.asks.length <= 1).toBe(true);
    expect(meta.warnings?.some((warning) => warning.includes('one level'))).toBe(true);
    observe('top of the book', {
      available: true,
      bid: data.bids.length === 1,
      ask: data.asks.length === 1,
      sizes: [...data.bids, ...data.asks].every(({ size }) => size !== null),
    });
  });

  test('asks for a few dozen bars more than are loaded, and says how far history loads', async (context) => {
    const e2eServer = server();
    const snapshot = plan?.snapshot;
    if (snapshot === undefined) {
      return context.skip(plan?.skipReason ?? 'The chart could not be prepared for a change');
    }
    await changeThenRestore(e2eServer.client, snapshot, async () => {
      const page = await e2eServer.ctx.connection.chartPage();
      const first = await loadedBars();
      expect(first.loading).toBe(false);

      // One request the way the tool sends it, to see what the series says right after it.
      const asked = await page.bridge.evaluate(requestOlderBars, [OLDER_BARS]);
      const settled = await pollUntil(loadedBars, (state) => !state.loading, {
        intervalMs: 100,
        timeoutMs: 10_000,
      });
      const loaded = settled.last;

      // Then the tool itself, asked for more than are loaded now.
      const count = Math.min(loaded.size + OLDER_BARS, 5000);
      const began = performance.now();
      const { data, warnings } = await callOk<Ohlcv>(e2eServer.client, 'data_get_ohlcv', { count });
      const toolMs = Math.round(performance.now() - began);
      const after = await loadedBars();

      observe('history loading', {
        requestTaken: asked.before.available && (asked.after.loading || !asked.after.available),
        loadingRightAfterRequest: asked.after.loading,
        availableRightAfterRequest: asked.after.available,
        settledWithinTenSeconds: settled.satisfied,
        firstRequestGrewBy: loaded.size - first.size,
        toolReturned: data.bars.length === count ? 'every bar asked for' : 'fewer bars',
        toolComplete: data.complete,
        toolWarnings: warnings.length,
        toolMs,
        endOfData: after.endOfData,
        endOfDataType: after.endOfDataType,
        availableAfter: after.available,
      });
      expect(asked.after.loading || !asked.after.available, 'the request went out').toBe(true);
      expect(settled.satisfied).toBe(true);
      expect(barProblems(data.bars)).toEqual([]);
      if (loaded.size > first.size) {
        // Older bars came: the tool loads the rest it asks for, or says why it could not.
        if (data.complete) {
          expect(data.bars.length === count, 'every bar asked for').toBe(true);
        } else {
          expect(warnings.length).toBeGreaterThan(0);
        }
      } else if (loaded.endOfData) {
        expect(data.complete).toBe(false);
        expect(
          warnings.length === 1 && /first bar|history limit/.test(warnings[0] ?? ''),
          'one warning says where history ends',
        ).toBe(true);
      } else {
        // TradingView answered with no bar and no end of its data, and takes no further request
        // for now: the tool returns the loaded bars at once and says so.
        expect(loaded.available).toBe(false);
        expect(data.complete).toBe(false);
        expect(data.bars.length === loaded.size, 'the bars that are loaded').toBe(true);
        expect(
          warnings.length === 1 && (warnings[0] ?? '').includes('sends no more older history'),
          'one warning says that TradingView sends no more older history',
        ).toBe(true);
        expect(toolMs).toBeLessThan(5000);
      }
    });
    await expectChartRestored(e2eServer, snapshot);
  });
});
