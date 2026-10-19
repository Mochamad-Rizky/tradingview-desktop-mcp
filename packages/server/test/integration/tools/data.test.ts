import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpServer } from '../../../src/server.js';
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
import { quietLogger, refusingLauncher, testConfig } from '../../helpers/tool-context.js';

// The market data tools through the whole server: an SDK client over the in-memory transport, the
// real registry, connection manager and CDP adapter, and the fake debug port of the app with a fake
// chart behind it. Prices are synthetic.

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
const DAY = 86_400;
const bars = syntheticBars(fixture.bars);
const barTime = (index: number): number => fixture.bars.startTime + index * DAY;
const withHistory = (totalBars: number, endOfDataType = 'end'): TvStateFixture => ({
  ...fixture,
  history: { totalBars, endOfDataType },
});

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
  options: { win?: FakeTvWindow; callTimeoutMs?: number } = {},
): Promise<{ client: Client; win: FakeTvWindow }> {
  const win = options.win ?? createFakeTvWindow(fixture);
  const app = await startFakeCdpServer({ targets: loadTargetsFixture({ chartWindow: () => win }) });
  cleanups.push(() => app.close());
  const config = testConfig({ cdpPort: app.port, callTimeoutMs: options.callTimeoutMs ?? 5000 });
  const { server, ctx } = createMcpServer(config, {
    launcher: refusingLauncher(),
    logger: quietLogger,
  });
  cleanups.push(() => ctx.connection.close());
  return { client: await connect(server), win };
}

function seriesOf(win: FakeTvWindow) {
  const series = win.TradingViewApi?.activeChart()._chartWidget.model().mainSeries();
  if (series === undefined) {
    throw new Error('The fake window has no series');
  }
  return series;
}

const windowWith = (from: TvStateFixture, overrides: FakeTvOverrides = {}) =>
  createFakeTvWindow(from, overrides);

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

const barOf = (row: (typeof bars)[number]) => ({
  time: row[0],
  timeIso: new Date(row[0] * 1000).toISOString().replace('.000Z', 'Z'),
  open: row[1],
  high: row[2],
  low: row[3],
  close: row[4],
  volume: row[5],
});

describe('data_get_ohlcv', () => {
  test('data_get_ohlcv returns the last 100 bars with ISO times', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'data_get_ohlcv');

    expect(result.isError).not.toBe(true);
    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: {
        symbol: 'NASDAQ:AAPL',
        resolution: '1D',
        bars: bars.slice(200).map(barOf),
        complete: true,
      },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(dataOf(result).bars).toHaveLength(100);
    expect((dataOf(result).bars as { timeIso: string }[])[0]?.timeIso).toBe('2024-07-20T00:00:00Z');
    expect(JSON.parse(textOf(result))).toStrictEqual(result.structuredContent);
    // Enough bars were loaded, so no history was asked for.
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('data_get_ohlcv returns the loaded bars and complete false when history stops growing', async () => {
    const callTimeoutMs = 5000;
    const { client, win } = await startHarness({ callTimeoutMs });
    const started = performance.now();

    const result = await callTool(client, 'data_get_ohlcv', { count: 5000 });

    expect(performance.now() - started).toBeLessThan(callTimeoutMs);
    expect(result.isError).not.toBe(true);
    expect(dataOf(result).bars).toHaveLength(300);
    expect(dataOf(result).complete).toBe(false);
    expect(warningsOf(result)).toEqual([
      expect.stringMatching(/^Only 300 of the 5000 bars .*first bar of the symbol was reached/),
    ]);
    expect(inspectFakeWindow(win).callsTo('series.requestMoreData')).toEqual([[4700]]);
  });

  test('data_get_ohlcv loads older history until it has the bars asked for', async () => {
    const { client, win } = await startHarness({ win: windowWith(withHistory(450)) });

    const result = await callTool(client, 'data_get_ohlcv', { count: 400 });

    const returned = dataOf(result).bars as { time: number }[];
    expect(returned).toHaveLength(400);
    expect(returned[0]?.time).toBe(barTime(-100));
    expect(returned.at(-1)?.time).toBe(barTime(299));
    expect(dataOf(result).complete).toBe(true);
    expect(warningsOf(result)).toEqual([]);
    expect(inspectFakeWindow(win).callsTo('series.requestMoreData')).toEqual([[100]]);
  });

  test('data_get_ohlcv asks again while each request brings bars', async () => {
    const { client, win } = await startHarness({
      win: windowWith(withHistory(1000), { historyBatchBars: 200 }),
    });

    const result = await callTool(client, 'data_get_ohlcv', { count: 900 });

    expect(dataOf(result).bars).toHaveLength(900);
    expect(dataOf(result).complete).toBe(true);
    // Each request asks for what is still missing, and brings at most 200 bars.
    expect(inspectFakeWindow(win).callsTo('series.requestMoreData')).toEqual([[600], [400], [200]]);
  });

  test('data_get_ohlcv stops at the end of the data that a request with bars reports', async () => {
    const { client, win } = await startHarness({ win: windowWith(withHistory(700)) });

    const result = await callTool(client, 'data_get_ohlcv', { count: 1200 });

    expect(dataOf(result).bars).toHaveLength(700);
    expect(dataOf(result).complete).toBe(false);
    expect(warningsOf(result)).toEqual([expect.stringMatching(/^Only 700 of the 1200 bars/)]);
    expect(inspectFakeWindow(win).callsTo('series.requestMoreData')).toEqual([[900]]);
  });

  test('data_get_ohlcv says when history stopped short of the first bar, as at the plan limit', async () => {
    const { client } = await startHarness({ win: windowWith(withHistory(300, 'limit')) });

    const result = await callTool(client, 'data_get_ohlcv', { count: 400 });

    expect(dataOf(result).complete).toBe(false);
    expect(warningsOf(result)).toEqual([
      expect.stringMatching(/stopped loading older history \(limit\).*HISTORICAL_BARS/),
    ]);
  });

  test('data_get_ohlcv returns within the call timeout while TradingView keeps loading', async () => {
    const callTimeoutMs = 2000;
    const { client } = await startHarness({
      win: windowWith(withHistory(5000), { historyLoadMs: 60_000 }),
      callTimeoutMs,
    });
    const started = performance.now();

    const result = await callTool(client, 'data_get_ohlcv', { count: 1000 });

    expect(performance.now() - started).toBeLessThan(callTimeoutMs);
    expect(result.isError).not.toBe(true);
    expect(dataOf(result).bars).toHaveLength(300);
    expect(dataOf(result).complete).toBe(false);
    expect(warningsOf(result)).toEqual([expect.stringMatching(/still loading older history/)]);
  });

  test('data_get_ohlcv says when TradingView did not load more history when asked', async () => {
    const win = windowWith(withHistory(450));
    // A request the app does not send, as for a chart that has not laid out its bars.
    seriesOf(win).requestMoreData = () => undefined;
    const { client } = await startHarness({ win });

    const result = await callTool(client, 'data_get_ohlcv', { count: 400 });

    expect(dataOf(result).bars).toHaveLength(300);
    expect(dataOf(result).complete).toBe(false);
    expect(warningsOf(result)).toEqual([expect.stringMatching(/did not load more history/)]);
  });

  test('data_get_ohlcv waits for a load the app started before it asks for more', async () => {
    const win = windowWith(withHistory(450), { historyLoadMs: 200 });
    seriesOf(win).requestMoreData(50);
    const { client } = await startHarness({ win });

    const result = await callTool(client, 'data_get_ohlcv', { count: 400 });

    expect(dataOf(result).bars).toHaveLength(400);
    expect(dataOf(result).complete).toBe(true);
    expect(inspectFakeWindow(win).callsTo('series.requestMoreData')).toEqual([[50], [50]]);
  });

  test('data_get_ohlcv returns within the call timeout while a load the app started runs on', async () => {
    const callTimeoutMs = 2000;
    const win = windowWith(withHistory(450), { historyLoadMs: 60_000 });
    seriesOf(win).requestMoreData(50);
    const { client } = await startHarness({ win, callTimeoutMs });
    const started = performance.now();

    const result = await callTool(client, 'data_get_ohlcv', { count: 400 });

    expect(performance.now() - started).toBeLessThan(callTimeoutMs);
    expect(dataOf(result).bars).toHaveLength(300);
    expect(warningsOf(result)).toEqual([expect.stringMatching(/still loading older history/)]);
    expect(inspectFakeWindow(win).callsTo('series.requestMoreData')).toEqual([[50]]);
  });

  test('data_get_ohlcv reads the loaded bars on a build that cannot load older ones', async () => {
    const win = windowWith(withHistory(450));
    delete (seriesOf(win) as Partial<ReturnType<typeof seriesOf>>).requestMoreData;
    const { client } = await startHarness({ win });

    const result = await callTool(client, 'data_get_ohlcv', { count: 400 });

    expect(dataOf(result).bars).toHaveLength(300);
    expect(warningsOf(result)).toEqual([expect.stringMatching(/no way to load older history/)]);
  });

  test('data_get_ohlcv keeps to from and to, in the times of the bar rows', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'data_get_ohlcv', {
      from: new Date(barTime(10) * 1000).toISOString(),
      to: barTime(19),
      count: 50,
    });

    expect(dataOf(result).bars).toStrictEqual(bars.slice(10, 20).map(barOf));
    // The range lies inside the loaded bars, so it is complete without more history.
    expect(dataOf(result).complete).toBe(true);
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('data_get_ohlcv refuses a from that is not earlier than to', async () => {
    const { client } = await startHarness();

    const result = await callTool(client, 'data_get_ohlcv', { from: barTime(20), to: barTime(10) });

    expect(errorOf(result)?.code).toBe('INVALID_INPUT');
  });

  test('data_get_ohlcv fails NOT_AVAILABLE while the chart has no bars', async () => {
    const win = createFakeTvWindow(fixture);
    inspectFakeWindow(win).state.symbolInvalid = true;
    const { client } = await startHarness({ win });

    const result = await callTool(client, 'data_get_ohlcv', { count: 10 });

    expect(errorOf(result)?.code).toBe('NOT_AVAILABLE');
  });

  test('data_get_ohlcv checks chartIndex against the layout', async () => {
    const { client } = await startHarness();

    const result = await callTool(client, 'data_get_ohlcv', { chartIndex: 3 });

    expect(errorOf(result)?.code).toBe('INVALID_INPUT');
  });
});

describe('data_get_quote', () => {
  test('data_get_quote reads the chart symbol', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'data_get_quote');
    const bare = await callTool(client, 'data_get_quote', { symbol: 'aapl' });

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: {
        symbol: 'NASDAQ:AAPL',
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
      },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(dataOf(bare)).toStrictEqual(dataOf(result));
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('data_get_quote reads another symbol from the caches of the app, and creates no session', async () => {
    const { client, win } = await startHarness();

    const msft = await callTool(client, 'data_get_quote', { symbol: 'NASDAQ:MSFT' });
    const ibm = await callTool(client, 'data_get_quote', { symbol: 'NYSE:IBM' });
    const eurusd = await callTool(client, 'data_get_quote', { symbol: 'FX:EURUSD' });

    expect(dataOf(msft)).toMatchObject({ symbol: 'NASDAQ:MSFT', last: 211.37, bid: 211.36 });
    expect(dataOf(ibm)).toMatchObject({ symbol: 'NYSE:IBM', last: 57.81, bid: null, ask: null });
    expect(dataOf(eurusd)).toMatchObject({ symbol: 'FX:EURUSD', last: 1.0731, volume: null });
    expect(envelopeOf(msft).meta.via).toBe('internal');
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('data_get_quote fails NOT_AVAILABLE for an uncached symbol', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'data_get_quote', { symbol: 'NASDAQ:NVDA' });

    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: expect.stringMatching(/NASDAQ:NVDA/) as string,
      hint: expect.stringMatching(/chart_set_symbol.*watchlist/) as string,
    });
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('data_get_quote fails NOT_AVAILABLE while the chart has no quote', async () => {
    const win = createFakeTvWindow(fixture);
    inspectFakeWindow(win).state.symbolInvalid = true;
    const { client } = await startHarness({ win });

    const result = await callTool(client, 'data_get_quote');

    expect(errorOf(result)?.code).toBe('NOT_AVAILABLE');
  });

  test('data_get_quote refuses a blank symbol', async () => {
    const { client } = await startHarness();

    const result = await callTool(client, 'data_get_quote', { symbol: '  ' });

    expect(errorOf(result)?.code).toBe('INVALID_INPUT');
  });
});

describe('data_get_symbol_info', () => {
  test('data_get_symbol_info reads the symbol info of the chart', async () => {
    const { client } = await startHarness();

    const result = await callTool(client, 'data_get_symbol_info');

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: {
        source: 'chart',
        symbol: 'NASDAQ:AAPL',
        fullName: 'NASDAQ:AAPL',
        proName: 'NASDAQ:AAPL',
        exchange: 'NASDAQ',
        listedExchange: 'NASDAQ',
        description: 'Apple Inc.',
        type: 'stock',
        typespecs: ['common'],
        currency: 'USD',
        pricescale: 100,
        minmov: 1,
        pointvalue: 1,
        session: '0930-1600',
        timezone: 'America/New_York',
        hasIntraday: true,
        hasExtendedHours: true,
        isReplayable: true,
      },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
  });

  test('data_get_symbol_info takes another symbol from its best search match', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'data_get_symbol_info', { symbol: 'NYSE:IBM' });

    expect(envelopeOf(result).meta.via).toBe('api');
    expect(dataOf(result)).toStrictEqual({
      source: 'search',
      symbol: 'NYSE:IBM',
      fullName: null,
      proName: null,
      exchange: 'NYSE',
      listedExchange: null,
      description: 'International Business Machines Corporation',
      type: 'stock',
      typespecs: ['common'],
      currency: 'USD',
      pricescale: null,
      minmov: null,
      pointvalue: null,
      session: null,
      timezone: null,
      hasIntraday: null,
      hasExtendedHours: null,
      isReplayable: null,
    });
    expect(warningsOf(result)).toEqual([expect.stringMatching(/symbol search/)]);
    expect(inspectFakeWindow(win).callsTo('TradingViewApi.searchSymbols')).toEqual([
      [{ text: 'IBM', serverHighlight: false }],
    ]);
  });

  test('data_get_symbol_info matches a bare ticker by the ticker of the results', async () => {
    const { client } = await startHarness();

    const result = await callTool(client, 'data_get_symbol_info', { symbol: 'msft' });

    expect(dataOf(result)).toMatchObject({ source: 'search', symbol: 'NASDAQ:MSFT' });
  });

  test('data_get_symbol_info picks the listing the exchange names among several', async () => {
    const { client } = await startHarness();

    const result = await callTool(client, 'data_get_symbol_info', { symbol: 'BATS:AAPL' });

    expect(dataOf(result)).toMatchObject({ source: 'search', symbol: 'BATS:AAPL' });
  });

  test('data_get_symbol_info fails NOT_AVAILABLE when the search finds no such symbol', async () => {
    const { client } = await startHarness();

    const result = await callTool(client, 'data_get_symbol_info', { symbol: 'NYSE:NOPE' });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      hint: expect.stringMatching(/data_search_symbols/) as string,
    });
  });

  test('data_get_symbol_info fails NOT_AVAILABLE while the chart symbol is not resolved', async () => {
    const win = createFakeTvWindow(fixture);
    inspectFakeWindow(win).state.symbolInvalid = true;
    const { client } = await startHarness({ win });

    const result = await callTool(client, 'data_get_symbol_info');

    expect(errorOf(result)?.code).toBe('NOT_AVAILABLE');
  });
});

describe('data_search_symbols', () => {
  test('data_search_symbols strips tags and honors limit', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'data_search_symbols', { query: 'AAPL', limit: 2 });

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: {
        results: [
          {
            symbol: 'NASDAQ:AAPL',
            ticker: 'AAPL',
            description: 'Apple Inc.',
            exchange: 'NASDAQ',
            type: 'stock',
            currency: 'USD',
          },
          {
            symbol: 'BATS:AAPL',
            ticker: 'AAPL',
            description: 'Apple Inc.',
            exchange: 'Cboe BZX',
            type: 'stock',
            currency: 'USD',
          },
        ],
        remaining: 37,
      },
      meta: { via: 'api', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(inspectFakeWindow(win).callsTo('TradingViewApi.searchSymbols')).toEqual([
      [{ text: 'AAPL', serverHighlight: false }],
    ]);
  });

  test('data_search_symbols sends the type the app knows for crypto, and the exchange', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'data_search_symbols', {
      query: 'btc',
      type: 'crypto',
      exchange: 'BINANCE',
    });

    expect(dataOf(result).results).toEqual([
      expect.objectContaining({ symbol: 'BINANCE:BTCUSDT', type: 'spot' }),
    ]);
    expect(inspectFakeWindow(win).callsTo('TradingViewApi.searchSymbols')).toEqual([
      [{ text: 'btc', serverHighlight: false, exchange: 'BINANCE', type: 'bitcoin,crypto' }],
    ]);
  });

  test('data_search_symbols refuses a type the app does not know', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'data_search_symbols', { query: 'x', type: 'bitcoin' });

    expect(result.isError).toBe(true);
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });
});

describe('data_get_market_depth', () => {
  test('data_get_market_depth returns one level from the quote and warns when more levels were asked for', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'data_get_market_depth');

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: {
        symbol: 'NASDAQ:AAPL',
        levels: 1,
        fullDepth: false,
        bids: [{ price: 103.41, size: 100 }],
        asks: [{ price: 103.43, size: 200 }],
      },
      meta: {
        via: 'internal',
        durationMs: expect.any(Number) as number,
        warnings: [expect.stringMatching(/top of the book.*broker.*depth data entitlement/)],
      },
    });
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('data_get_market_depth does not warn when one level is asked for', async () => {
    const { client } = await startHarness();

    const result = await callTool(client, 'data_get_market_depth', {
      symbol: 'NASDAQ:MSFT',
      levels: 1,
    });

    expect(dataOf(result)).toMatchObject({
      symbol: 'NASDAQ:MSFT',
      bids: [{ price: 211.36, size: 300 }],
      asks: [{ price: 211.38, size: 100 }],
    });
    expect(warningsOf(result)).toEqual([]);
  });

  test('data_get_market_depth reports the side the quote has, with a size it may lack', async () => {
    const win = createFakeTvWindow({
      ...fixture,
      quote: { ...fixture.quote, ask: null, bid_size: null },
    });
    const { client } = await startHarness({ win });

    const result = await callTool(client, 'data_get_market_depth', { levels: 1 });

    expect(dataOf(result)).toMatchObject({ bids: [{ price: 103.41, size: null }], asks: [] });
    expect(warningsOf(result)).toEqual([expect.stringMatching(/no ask/)]);
  });

  test('data_get_market_depth reports an empty bid side when the quote has only an ask', async () => {
    const win = createFakeTvWindow({ ...fixture, quote: { ...fixture.quote, bid: null } });
    const { client } = await startHarness({ win });

    const result = await callTool(client, 'data_get_market_depth', { levels: 1 });

    expect(dataOf(result)).toMatchObject({ bids: [], asks: [{ price: 103.43, size: 200 }] });
    expect(warningsOf(result)).toEqual([expect.stringMatching(/no bid/)]);
  });

  test('data_get_market_depth fails NOT_AVAILABLE without bid and ask', async () => {
    const { client } = await startHarness();

    const result = await callTool(client, 'data_get_market_depth', { symbol: 'NYSE:IBM' });

    expect(errorOf(result)?.code).toBe('NOT_AVAILABLE');
  });
});
