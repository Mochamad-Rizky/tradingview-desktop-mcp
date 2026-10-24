import { z } from 'zod';
import type { PageHandle } from '../../core/connection.js';
import { TvMcpError } from '../../core/errors.js';
import type { PageErrorSentinel } from '../../core/tv/page-bridge.js';
import { pollUntil } from '../../utils/poll.js';
import { parseTimeInput, toIso } from '../../utils/time.js';
import { READ_ONLY } from '../annotations.js';
import { chartIndexInput, TIME_INPUT, timeInput } from '../chart/index.js';
import { sameSymbol } from '../chart/mappers.js';
import { pageWaitMs, resolveChartTarget } from '../chart/strategies.js';
import { defineTool, type AnyToolDefinition, type ToolContext } from '../types.js';
import {
  mapQuote,
  mapSearchResult,
  QUOTE_FIELDS,
  SEARCH_TYPES,
  searchTypeParam,
  stripTags,
  toBarRows,
  type SearchItem,
} from './mappers.js';
import {
  readBarRows,
  readCachedQuote,
  readChartQuote,
  readChartSymbolInfo,
  readHistory,
  requestHistory,
  searchSymbolsViaApi,
} from './page.js';
import { findListing, symbolSearchOn } from './symbol-lookup.js';

// The tools that read market data (design spec 7, domain Market data): bars, quotes, symbol info,
// symbol search and the top of the order book. Each of them only reads what the app already holds
// or asks the app the way its own interface does: the bars of the chart (loading older ones the way
// a scroll to the left does), the quote caches, and the symbol search. None creates a quote
// session, resolves a symbol on the chart session or opens a depth session, which TradingView
// Desktop 3.4.1 was seen to do with the web build of 2026-10-16.

// How often the series is asked while older bars load.
const HISTORY_POLL_MS = 100;

const MAX_BARS = 5000;

function symbolInput(what: string) {
  return z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      `${what}, best in the EXCHANGE:SYMBOL form such as NASDAQ:AAPL. Leave it out for the symbol ` +
        'of the active chart.',
    );
}

// The symbol a client gave, trimmed, or undefined for the chart symbol. A blank one is refused.
function wantedSymbol(symbol: string | undefined): string | undefined {
  if (symbol === undefined) {
    return undefined;
  }
  const trimmed = symbol.trim();
  if (trimmed === '') {
    throw new TvMcpError('INVALID_INPUT', 'The symbol is blank', {
      hint: 'Give a symbol such as NASDAQ:AAPL, or leave it out for the chart symbol.',
    });
  }
  return trimmed;
}

// Whether `wanted` names the symbol the chart shows, by the name it shows or the names of its
// symbol info. A bare ticker matches the ticker of any of them.
function isChartSymbol(wanted: string, names: readonly (string | null)[]): boolean {
  return names.some((name) => name !== null && sameSymbol(wanted, name));
}

// What the main series says about its history (readHistory).
type HistoryState = Exclude<ReturnType<typeof readHistory>, PageErrorSentinel>;

// Why loading older bars ended: the bars asked for were there (done), the series reported the end
// of its data (end), the series takes no more requests without reporting an end (stalled: after a
// request that brought no bar, the app keeps it that way), the series ignored a request it should
// have taken (ignored, as on a chart that is hidden or not laid out), a load was still running when
// the wait ran out (timeout), or the series cannot load older bars (unsupported).
type HistoryStop = 'done' | 'end' | 'stalled' | 'ignored' | 'timeout' | 'unsupported';

// Loads older bars until `count` bars lie between `from` and `to`, or the first bar of the series
// is at or before `from`, one request per round, since the series takes another request only after
// the bars of the last one arrived (read from the web build). Before a request it waits only while
// a load runs; after one, until the load has ended. It ends when a round brings no bar, when the
// series reports the end of its data or takes no more requests, or when `waitMs` is up, and never
// waits past it. A series without bars gets no request: the app ignores one.
async function loadHistory(
  page: PageHandle,
  chartIndex: number | null,
  from: number | null,
  to: number | null,
  count: number,
  waitMs: number,
): Promise<{ state: HistoryState; stop: HistoryStop }> {
  const deadline = performance.now() + waitMs;
  const read = () => page.bridge.evaluate(readHistory, [chartIndex, from, to]);
  const covered = (state: HistoryState): boolean =>
    state.inRange >= count ||
    (from !== null && state.firstTime !== null && state.firstTime <= from);
  // Asks the series until no load runs, the first time at once.
  const untilIdle = () =>
    pollUntil(read, (state) => !state.loading, {
      intervalMs: HISTORY_POLL_MS,
      timeoutMs: deadline - performance.now(),
    });

  let state = await read();
  for (;;) {
    if (covered(state)) {
      return { state, stop: 'done' };
    }
    if (!state.canLoad) {
      return { state, stop: 'unsupported' };
    }
    if (state.size === 0) {
      return { state, stop: 'ignored' };
    }
    if (state.loading) {
      // A load the app started itself, such as after a scroll, ends before another request.
      const idle = await untilIdle();
      state = idle.last;
      if (!idle.satisfied) {
        return { state, stop: 'timeout' };
      }
      continue;
    }
    if (state.endOfData) {
      return { state, stop: 'end' };
    }
    if (!state.available) {
      return { state, stop: 'stalled' };
    }
    if (deadline - performance.now() <= 0) {
      return { state, stop: 'timeout' };
    }
    const before = state.size;
    const { sent } = await page.bridge.evaluate(requestHistory, [
      chartIndex,
      count - state.inRange,
    ]);
    if (!sent) {
      return { state: await read(), stop: 'ignored' };
    }
    const loaded = await untilIdle();
    state = loaded.last;
    if (!loaded.satisfied) {
      return { state, stop: 'timeout' };
    }
    if (state.size <= before) {
      return { state, stop: state.endOfData ? 'end' : 'stalled' };
    }
  }
}

// What a call of data_get_ohlcv says when it returns fewer bars than were asked for, by why loading
// older bars ended.
function shortfallWarning(
  returned: number,
  count: number,
  stop: Exclude<HistoryStop, 'done'>,
  state: HistoryState,
  waitMs: number,
): string {
  const only = `Only ${String(returned)} of the ${String(count)} bars asked for are returned`;
  switch (stop) {
    case 'end':
      return state.endOfDataType === 'end'
        ? `${only}: the first bar of the symbol was reached, so no earlier bars exist.`
        : `${only}: TradingView stopped loading older history (${state.endOfDataType ?? 'no reason given'}) ` +
            'before the first bar of the symbol, most likely at the history limit of the plan ' +
            '(HISTORICAL_BARS, which app_get_plan_limits reports).';
    case 'stalled':
      return (
        `${only}: TradingView sends no more older history for now: the chart takes no further ` +
        'request and has not reported the end of its data. This can be the history limit of the ' +
        'plan (HISTORICAL_BARS, which app_get_plan_limits reports).'
      );
    case 'ignored':
      return (
        `${only}: TradingView did not load more history when asked. The chart may be hidden or ` +
        'not laid out yet; show the chart and try again.'
      );
    case 'timeout':
      return (
        `${only}: TradingView was still loading older history when the wait of ` +
        `${String(waitMs)} ms ended. Call again to continue from what has loaded, or raise the ` +
        'call timeout (TV_CALL_TIMEOUT_MS).'
      );
    case 'unsupported':
      return `${only}: this TradingView build offers no way to load older history, so only the loaded bars were read.`;
  }
}

// What data_get_ohlcv and the resource tradingview://chart/ohlcv report: the last `count` bars of a
// chart between `from` and `to` (Unix seconds, in the times of the bar rows), with older history
// loaded as far as needed and the app allows, and a warning when fewer bars exist or could be
// loaded within the call timeout.
export async function readOhlcvData(
  ctx: ToolContext,
  input: { count: number; from?: number; to?: number; chartIndex?: number },
) {
  const { count } = input;
  const from = input.from ?? null;
  const to = input.to ?? null;
  const page = await ctx.connection.chartPage();
  const target = await resolveChartTarget(page, input.chartIndex);
  const waitMs = pageWaitMs(ctx.config.callTimeoutMs);
  const { state, stop } = await loadHistory(page, target.index, from, to, count, waitMs);
  if (state.size === 0) {
    throw new TvMcpError('NOT_AVAILABLE', 'The chart has no bars loaded', {
      hint:
        'The chart may still be loading its data, or show a symbol TradingView does not know. ' +
        'Check chart_get_state and try again.',
    });
  }
  const read = await page.bridge.evaluate(readBarRows, [target.index, from, to, count]);
  const bars = toBarRows(read.rows, input.from, input.to, count);
  // Rows the chart holds without a price for each of open, high, low and close are left out.
  const dropped = read.rows.length - bars.length;
  // Complete when every bar asked for is returned: count of them, or every bar of a range whose
  // start is loaded.
  const startLoaded = from !== null && state.firstTime !== null && state.firstTime <= from;
  const complete = bars.length === count || (startLoaded && dropped === 0);
  const warnings: string[] = [];
  if (!complete && stop !== 'done') {
    warnings.push(shortfallWarning(bars.length, count, stop, state, waitMs));
  }
  if (dropped > 0) {
    warnings.push(
      `${String(dropped)} bar${dropped === 1 ? '' : 's'} of the chart had no open, high, low or ` +
        'close price and were left out.',
    );
  }
  return {
    data: { symbol: read.symbol, resolution: read.resolution, bars, complete },
    warnings,
  };
}

export const dataGetOhlcv = defineTool({
  name: 'data_get_ohlcv',
  domain: 'data',
  title: 'Read OHLCV bars',
  description:
    'Reads the bars (open, high, low, close, volume) of the symbol and timeframe a chart shows: ' +
    'the last count bars, or the last count bars between from and to. When fewer bars are ' +
    'loaded, older history is loaded the way a scroll to the left loads it, as far as the app ' +
    'allows and the call timeout lets it. Returns symbol, resolution, bars (time in Unix seconds ' +
    'and timeIso, oldest first) and complete: false, with a warning, when fewer bars than asked ' +
    'for exist or could be loaded, such as at the first bar of the symbol or at the history ' +
    'limit of the plan (HISTORICAL_BARS); call again to continue a load the timeout cut short. ' +
    'Bar times are the start of each bar as TradingView stores it: for daily bars of a US stock ' +
    'that is the session open (13:30 UTC), so give from and to with that in mind. To read another ' +
    'symbol or timeframe, change the chart first (chart_set_symbol, chart_set_timeframe).',
  inputSchema: {
    count: z
      .number()
      .int()
      .min(1)
      .max(MAX_BARS)
      .default(100)
      .describe(
        `How many bars, the most recent first counted: 1 to ${String(MAX_BARS)}, 100 by default.`,
      ),
    from: timeInput()
      .optional()
      .describe(`Earliest bar time to return: ${TIME_INPUT}. Without an offset a time is UTC.`),
    to: timeInput()
      .optional()
      .describe(`Latest bar time to return: ${TIME_INPUT}. Without an offset a time is UTC.`),
    chartIndex: chartIndexInput(),
  },
  annotations: READ_ONLY,
  core: true,
  async handler({ count, from, to, chartIndex }, ctx) {
    const start = from === undefined ? undefined : parseTimeInput(from);
    const end = to === undefined ? undefined : parseTimeInput(to);
    if (start !== undefined && end !== undefined && start >= end) {
      throw new TvMcpError(
        'INVALID_INPUT',
        `from must be earlier than to, but from is ${toIso(start)} and to is ${toIso(end)}`,
        { hint: 'Give a from that is earlier than to.' },
      );
    }
    const { data, warnings } = await readOhlcvData(ctx, {
      count,
      ...(start === undefined ? {} : { from: start }),
      ...(end === undefined ? {} : { to: end }),
      ...(chartIndex === undefined ? {} : { chartIndex }),
    });
    return { data, via: 'internal', warnings };
  },
});

// The quote values of a symbol: those of the active chart for its own symbol, else those the caches
// of the app hold. NOT_AVAILABLE when there are none.
async function quoteValues(
  ctx: ToolContext,
  symbol: string | undefined,
): Promise<{ symbol: string | null; values: Record<string, string | number | boolean> }> {
  const wanted = wantedSymbol(symbol);
  const page = await ctx.connection.chartPage();
  const chart = await page.bridge.evaluate(readChartQuote, [[...QUOTE_FIELDS]]);
  if (
    wanted === undefined ||
    isChartSymbol(wanted, [chart.symbol, chart.proName, chart.fullName])
  ) {
    if (chart.values === null) {
      throw new TvMcpError('NOT_AVAILABLE', 'The chart has no quote yet', {
        hint:
          'The chart may still be loading its data, or show a symbol TradingView does not know. ' +
          'Check chart_get_state and try again.',
      });
    }
    return { symbol: chart.symbol ?? chart.proName, values: chart.values };
  }
  const cached = await page.bridge.evaluateWithLib(readCachedQuote, [wanted, [...QUOTE_FIELDS]]);
  if (cached === null) {
    throw new TvMcpError('NOT_AVAILABLE', `TradingView holds no quote of ${wanted}`, {
      hint:
        'TradingView keeps quotes only of the symbols it shows or watches. Switch the chart to ' +
        'the symbol (chart_set_symbol) or add it to a watchlist, then try again; write it in the ' +
        'EXCHANGE:SYMBOL form, such as NASDAQ:AAPL.',
      details: { symbol: wanted },
    });
  }
  return { symbol: cached.symbol, values: cached.values };
}

export const dataGetQuote = defineTool({
  name: 'data_get_quote',
  domain: 'data',
  title: 'Read a quote',
  description:
    'Reads the latest quote of a symbol, and changes nothing. Returns symbol, last, change, ' +
    'changePercent, bid, ask, bidSize, askSize, high, low, open (of the day), prevClose, ' +
    'volume, currency and the time of the last price (time in Unix seconds, timeIso); a field ' +
    'TradingView does not report is null. The chart symbol is read from the chart. Another symbol ' +
    'is read from the quotes TradingView already holds (symbols it has shown or watches), and ' +
    'fails with NOT_AVAILABLE when it holds none: switch the chart to the symbol or add it to a ' +
    'watchlist first.',
  inputSchema: { symbol: symbolInput('Symbol to quote') },
  annotations: READ_ONLY,
  core: true,
  async handler({ symbol }, ctx) {
    const quote = await quoteValues(ctx, symbol);
    return { data: { symbol: quote.symbol, ...mapQuote(quote.values) }, via: 'internal' };
  },
});

// The keys of the symbol info of a chart that data_get_symbol_info reports.
const SYMBOL_INFO_KEYS = [
  'full_name',
  'pro_name',
  'exchange',
  'listed_exchange',
  'description',
  'type',
  'typespecs',
  'currency_code',
  'pricescale',
  'minmov',
  'pointvalue',
  'session',
  'timezone',
  'has_intraday',
  'has_extended_hours',
  'is_replayable',
];

// The symbol info data_get_symbol_info reports, from the symbol info of a chart or the fields of a
// search item under the same keys. A key that is missing, or of the wrong type, is null.
function toSymbolInfo(
  source: 'chart' | 'search',
  symbol: string,
  info: Readonly<Record<string, string | number | boolean | string[] | null>>,
) {
  const text = (key: string): string | null => {
    const value = info[key];
    return typeof value === 'string' ? value : null;
  };
  const number = (key: string): number | null => {
    const value = info[key];
    return typeof value === 'number' ? value : null;
  };
  const flag = (key: string): boolean | null => {
    const value = info[key];
    return typeof value === 'boolean' ? value : null;
  };
  const typespecs = info.typespecs;
  return {
    source,
    symbol,
    fullName: text('full_name'),
    proName: text('pro_name'),
    exchange: text('exchange'),
    listedExchange: text('listed_exchange'),
    description: text('description'),
    type: text('type'),
    typespecs: Array.isArray(typespecs) ? typespecs : null,
    currency: text('currency_code'),
    pricescale: number('pricescale'),
    minmov: number('minmov'),
    pointvalue: number('pointvalue'),
    session: text('session'),
    timezone: text('timezone'),
    hasIntraday: flag('has_intraday'),
    hasExtendedHours: flag('has_extended_hours'),
    isReplayable: flag('is_replayable'),
  };
}

// The fields a search item gives, under the keys of a symbol info, with every tag stripped.
function searchItemInfo(item: SearchItem): Record<string, string | string[] | null> {
  const result = mapSearchResult(item);
  return {
    full_name: item.fullName === null ? null : stripTags(item.fullName),
    exchange: result.exchange,
    description: result.description,
    type: result.type,
    typespecs: item.typespecs,
    currency_code: result.currency,
  };
}

// The symbol search of the app, for `text`.
async function searchSymbols(
  ctx: ToolContext,
  text: string,
  exchange: string | null,
  type: string | null,
): Promise<{ items: SearchItem[]; remaining: number | null }> {
  const page = await ctx.connection.chartPage();
  return page.bridge.evaluate(searchSymbolsViaApi, [text, exchange, type]);
}

export const dataGetSymbolInfo = defineTool({
  name: 'data_get_symbol_info',
  domain: 'data',
  title: 'Read symbol info',
  description:
    'Reads what TradingView knows about a symbol, and changes nothing. Returns source, symbol, ' +
    'fullName, proName (the listing), exchange, listedExchange, description, type, typespecs, ' +
    'currency, pricescale and minmov (the tick is minmov / pricescale), pointvalue, session, ' +
    'timezone, hasIntraday, hasExtendedHours and isReplayable. For the chart symbol every field ' +
    'comes from the chart (source: chart). Another symbol is looked up with the symbol search ' +
    '(source: search), which gives only symbol, exchange, description, type, typespecs and ' +
    'currency; the rest, fullName included, is null. Switch the chart to the symbol for the full ' +
    'info. ' +
    'NOT_AVAILABLE when the search finds no such symbol.',
  inputSchema: { symbol: symbolInput('Symbol to describe') },
  annotations: READ_ONLY,
  core: true,
  async handler({ symbol }, ctx) {
    const wanted = wantedSymbol(symbol);
    const page = await ctx.connection.chartPage();
    const chart = await page.bridge.evaluate(readChartSymbolInfo, [SYMBOL_INFO_KEYS]);
    const names = [
      chart.symbol,
      typeof chart.info?.pro_name === 'string' ? chart.info.pro_name : null,
      typeof chart.info?.full_name === 'string' ? chart.info.full_name : null,
    ];
    if (wanted === undefined || isChartSymbol(wanted, names)) {
      if (chart.info === null || chart.symbol === null) {
        throw new TvMcpError('NOT_AVAILABLE', 'The chart has not resolved its symbol yet', {
          hint:
            'The chart may still be loading, or show a symbol TradingView does not know. Check ' +
            'chart_get_state and try again.',
        });
      }
      return { data: toSymbolInfo('chart', chart.symbol, chart.info), via: 'internal' };
    }
    const match = await findListing(symbolSearchOn(page), wanted);
    if (match === null) {
      throw new TvMcpError('NOT_AVAILABLE', `The symbol search of TradingView found no ${wanted}`, {
        hint:
          'Check the spelling, or find the symbol with data_search_symbols and give it in the ' +
          'EXCHANGE:SYMBOL form it reports.',
        details: { symbol: wanted },
      });
    }
    return {
      data: toSymbolInfo('search', match.result.symbol, searchItemInfo(match.item)),
      via: 'api',
      warnings: [
        'The symbol is not on the chart, so only the fields the symbol search gives are filled. ' +
          'Switch the chart to it (chart_set_symbol) for the full info.',
      ],
    };
  },
});

export const dataSearchSymbols = defineTool({
  name: 'data_search_symbols',
  domain: 'data',
  title: 'Search symbols',
  description:
    'Searches symbols the way the symbol search dialog of TradingView does, and changes nothing ' +
    'on the chart. Returns results, best first: symbol (EXCHANGE:TICKER, ready for ' +
    'chart_set_symbol and the other tools), ticker, description, exchange, type and currency; ' +
    'and remaining, how many more results there are than those returned: those TradingView did ' +
    'not send, and those it sent beyond limit. A futures ' +
    'root is reported as its first contract, such as CME_MINI:ES1!.',
  inputSchema: {
    query: z
      .string()
      .min(1)
      .max(200)
      .describe('What to search for: a ticker, part of one, or words of the name (AAPL, apple).'),
    exchange: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe('Only results of this exchange, such as NASDAQ or BINANCE.'),
    type: z
      .enum(SEARCH_TYPES)
      .optional()
      .describe(`Only results of this type: ${SEARCH_TYPES.join(', ')}.`),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe('How many results at most: 1 to 50, 20 by default.'),
  },
  annotations: READ_ONLY,
  core: true,
  async handler({ query, exchange, type, limit }, ctx) {
    const { items, remaining } = await searchSymbols(
      ctx,
      query,
      exchange ?? null,
      type === undefined ? null : searchTypeParam(type),
    );
    // What is left out counts as remaining too: the results TradingView has not sent, and those
    // it sent beyond the limit.
    return {
      data: {
        results: items.slice(0, limit).map(mapSearchResult),
        remaining: (remaining ?? 0) + Math.max(items.length - limit, 0),
      },
      via: 'api',
    };
  },
});

export const dataGetMarketDepth = defineTool({
  name: 'data_get_market_depth',
  domain: 'data',
  title: 'Read the top of the book',
  description:
    'Reads the top of the book of a symbol from its quote, and changes nothing: the best bid and ' +
    'the best ask with their sizes (a size TradingView does not report is null). Returns symbol, ' +
    'levels (always 1), fullDepth (always false), bids and asks, each a list of price and size. ' +
    'Full depth needs a broker connection or a depth data entitlement and a depth session of its ' +
    'own, which this server does not open, so a warning says so when more levels are asked for. ' +
    'The symbols it can read are those data_get_quote can read; NOT_AVAILABLE when the quote has ' +
    'neither a bid nor an ask.',
  inputSchema: {
    symbol: symbolInput('Symbol whose book to read'),
    levels: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe('How many price levels are wanted: 1 to 50, 10 by default. Only 1 is available.'),
  },
  annotations: READ_ONLY,
  async handler({ symbol, levels }, ctx) {
    const quote = await quoteValues(ctx, symbol);
    const { bid, ask, bidSize, askSize } = mapQuote(quote.values);
    const shown = quote.symbol ?? 'the chart symbol';
    if (bid === null && ask === null) {
      throw new TvMcpError('NOT_AVAILABLE', `The quote of ${shown} has no bid and no ask`, {
        hint:
          'TradingView reports no bid and ask for this symbol on this account, for example ' +
          'outside trading hours or without real-time data.',
        details: { symbol: quote.symbol },
      });
    }
    const warnings: string[] = [];
    if (levels > 1) {
      warnings.push(
        'Only the top of the book (one level) is available: full depth needs a broker connection ' +
          'or a depth data entitlement, and this server opens no depth session.',
      );
    }
    if (bid === null || ask === null) {
      warnings.push(`The quote of ${shown} has no ${bid === null ? 'bid' : 'ask'}.`);
    }
    return {
      data: {
        symbol: quote.symbol,
        levels: 1,
        fullDepth: false,
        bids: bid === null ? [] : [{ price: bid, size: bidSize }],
        asks: ask === null ? [] : [{ price: ask, size: askSize }],
      },
      via: 'internal',
      warnings,
    };
  },
});

export const dataTools: AnyToolDefinition[] = [
  dataGetOhlcv,
  dataGetQuote,
  dataGetSymbolInfo,
  dataSearchSymbols,
  dataGetMarketDepth,
];
