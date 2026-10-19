import type { PageErrorSentinel } from '../../core/tv/page-bridge.js';
import type { PageLib } from '../../core/tv/page-lib.js';
import type {
  BarsLike,
  ChartWidgetApiLike,
  QuoteEntryLike,
  QuoteFieldsCacheLike,
  QuoteSessionAdaptersLike,
  QuoteSessionLike,
  SeriesLike,
  SymbolSearchOptionsLike,
  TradingViewApiLike,
  TvWindow,
} from '../../core/tv/tv-window.js';

// The page functions of the market data tools. The page bridge sends the source text of each one
// into the page, so each uses nothing of this file, only its parameters and the globals of the
// page, and whatever it shares with another is written out in both. Types are erased, so the type
// imports above are fine.
//
// A chartIndex of null means the active chart; any other value has been checked against the layout
// by the caller. Members of the app are read defensively: another web build can drop or reshape any
// of them, and a read that throws counts as no answer. Only requestHistory changes anything, and
// none of them creates a quote session, resolves a symbol or opens a depth session.

// What the main series says about its history: how many bars it holds (size), how many of them lie
// between `from` and `to` (inRange; null bounds are open), the time of its oldest bar, whether a
// request for older bars runs (loading), whether one may be sent now (available), whether no more
// history comes (endOfData) and why (endOfDataType: "end" for the first bar of the symbol), and
// whether the series can load older bars at all (canLoad). Times are those of the bar rows.
export function readHistory(
  win: TvWindow,
  chartIndex: number | null,
  from: number | null,
  to: number | null,
):
  | {
      size: number;
      inRange: number;
      firstTime: number | null;
      loading: boolean;
      available: boolean;
      endOfData: boolean;
      endOfDataType: string | null;
      canLoad: boolean;
    }
  | PageErrorSentinel {
  const attempt = (read: () => unknown): unknown => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  const chart = attempt(() =>
    chartIndex === null ? api?.activeChart?.() : api?.chart?.(chartIndex),
  ) as Partial<ChartWidgetApiLike> | null | undefined;
  const series = attempt(() => chart?._chartWidget?.model().mainSeries()) as
    Partial<SeriesLike> | undefined;
  const bars = attempt(() => series?.bars?.()) as Partial<BarsLike> | undefined;
  if (
    typeof bars?.size !== 'function' ||
    typeof bars.firstIndex !== 'function' ||
    typeof bars.lastIndex !== 'function' ||
    typeof bars.valueAt !== 'function'
  ) {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no chart series to read bars from',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  // Checked above: the members called without a guard are there.
  const loaded = bars as BarsLike;
  const first = loaded.firstIndex();
  const last = loaded.lastIndex();
  let inRange = 0;
  let firstTime: number | null = null;
  if (first !== null && last !== null) {
    for (let index = first; index <= last; index += 1) {
      const time: unknown = loaded.valueAt(index)?.[0];
      if (typeof time !== 'number' || !Number.isFinite(time)) {
        continue;
      }
      firstTime ??= time;
      if ((from === null || time >= from) && (to === null || time <= to)) {
        inRange += 1;
      }
    }
  }
  const size: unknown = loaded.size();
  const type = attempt(() => series?.endOfDataType?.());
  return {
    size: typeof size === 'number' && Number.isFinite(size) ? size : 0,
    inRange,
    firstTime,
    loading: attempt(() => series?.isLoading?.()) === true,
    available: attempt(() => series?.requestMoreDataAvailable?.()) === true,
    endOfData: attempt(() => series?.endOfData?.()) === true,
    endOfDataType: typeof type === 'string' ? type : null,
    canLoad: typeof series?.requestMoreData === 'function',
  };
}

// Asks the main series for `count` bars older than its first one. The app answers later and only
// when it may send a request at all, so the answer is only whether the request went out: a request
// that went out makes the series unavailable for another one, and loading, at once, so either
// change from before the call tells.
export function requestHistory(
  win: TvWindow,
  chartIndex: number | null,
  count: number,
): { sent: boolean } | PageErrorSentinel {
  const attempt = (read: () => unknown): unknown => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  const chart = attempt(() =>
    chartIndex === null ? api?.activeChart?.() : api?.chart?.(chartIndex),
  ) as Partial<ChartWidgetApiLike> | null | undefined;
  const series = attempt(() => chart?._chartWidget?.model().mainSeries()) as
    Partial<SeriesLike> | undefined;
  if (typeof series?.requestMoreData !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no chart series to load older bars with',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  const loading = (): boolean => attempt(() => series.isLoading?.()) === true;
  const available = (): unknown => attempt(() => series.requestMoreDataAvailable?.());
  const wasLoading = loading();
  const wasAvailable = available();
  series.requestMoreData(count);
  return {
    sent: (wasAvailable === true && available() === false) || (!wasLoading && loading()),
  };
}

// The bar rows of the main series between `from` and `to` (null bounds are open), at most the last
// `count` of them, oldest first, with the symbol and the resolution of the chart. A row is
// [time, open, high, low, close, volume] in the time base of the rows, a value that is not a number
// copied as null; a row without a time is passed over. The rows are read from the last one back,
// so a long history costs no more than the rows asked for.
export function readBarRows(
  win: TvWindow,
  chartIndex: number | null,
  from: number | null,
  to: number | null,
  count: number,
):
  | { symbol: string | null; resolution: string | null; rows: (number | null)[][] }
  | PageErrorSentinel {
  const attempt = (read: () => unknown): unknown => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  const number = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  const chart = attempt(() =>
    chartIndex === null ? api?.activeChart?.() : api?.chart?.(chartIndex),
  ) as Partial<ChartWidgetApiLike> | null | undefined;
  const series = attempt(() => chart?._chartWidget?.model().mainSeries()) as
    Partial<SeriesLike> | undefined;
  const bars = attempt(() => series?.bars?.()) as Partial<BarsLike> | undefined;
  if (
    typeof bars?.firstIndex !== 'function' ||
    typeof bars.lastIndex !== 'function' ||
    typeof bars.valueAt !== 'function'
  ) {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no chart series to read bars from',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  // Checked above: the members called without a guard are there.
  const loaded = bars as BarsLike;
  const first = loaded.firstIndex();
  const last = loaded.lastIndex();
  const rows: (number | null)[][] = [];
  if (first !== null && last !== null) {
    for (let index = last; index >= first && rows.length < count; index -= 1) {
      const row: unknown = loaded.valueAt(index);
      const time = Array.isArray(row) ? number(row[0]) : null;
      if (time === null || (to !== null && time > to)) {
        continue;
      }
      if (from !== null && time < from) {
        break;
      }
      const values = row as unknown[];
      rows.push([time, ...[1, 2, 3, 4, 5].map((slot) => number(values[slot]))]);
    }
  }
  return {
    symbol: text(attempt(() => chart?.symbol?.())),
    resolution: text(attempt(() => chart?.resolution?.())),
    rows: rows.reverse(),
  };
}

// The quote of the active chart: the `fields` of the live quote of its main series, copied out
// because the app keeps merging updates into that object, with the symbol the chart shows and the
// names its symbol info gives (pro_name, full_name). Only text, finite numbers and booleans are
// copied. values is null while the series has no quote.
export function readChartQuote(
  win: TvWindow,
  fields: string[],
):
  | {
      symbol: string | null;
      proName: string | null;
      fullName: string | null;
      values: Record<string, string | number | boolean> | null;
    }
  | PageErrorSentinel {
  const attempt = (read: () => unknown): unknown => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  const chart = attempt(() => api?.activeChart?.()) as
    Partial<ChartWidgetApiLike> | null | undefined;
  const series = attempt(() => chart?._chartWidget?.model().mainSeries()) as
    Partial<SeriesLike> | undefined;
  if (typeof series?.quotes !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no chart series to read the quote from',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  const quote = attempt(() => series.quotes?.());
  let values: Record<string, string | number | boolean> | null = null;
  if (typeof quote === 'object' && quote !== null) {
    values = {};
    for (const field of fields) {
      const value: unknown = (quote as Record<string, unknown>)[field];
      if (
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))
      ) {
        values[field] = value;
      }
    }
  }
  const info = attempt(() => series.symbolInfo?.()) as Record<string, unknown> | null | undefined;
  return {
    symbol: text(attempt(() => chart?.symbol?.())),
    proName: text(info?.pro_name),
    fullName: text(info?.full_name),
    values,
  };
}

// The quote of a symbol the chart does not show, from the caches of the app only, in this order:
// the quote field cache that every quote session feeds (QUOTE_FIELDS_CACHE), the "full" quote
// session if the app created it (getQuoteSessionNoEnsure, which creates nothing), and the cache of
// the watchlist widget (quoteSessionAdapters._lastSymbolData). Nothing that creates a session or
// sends a request is called. The caches are keyed by the symbol as the app subscribed it, so the
// symbol is looked up as written and in capitals. An entry with the status "error", or without any
// of the `fields`, does not count. Null when no cache holds the symbol.
export function readCachedQuote(
  _win: TvWindow,
  lib: PageLib,
  symbol: string,
  fields: string[],
): {
  symbol: string;
  source: 'quote cache' | 'quote session' | 'watchlist';
  values: Record<string, string | number | boolean>;
} | null {
  const attempt = (read: () => unknown): unknown => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  // Looked up first, so that every lookup happens whatever the symbol.
  const fieldsCache = lib.findExport('QUOTE_FIELDS_CACHE') as Partial<QuoteFieldsCacheLike> | null;
  const noEnsure = lib.findExport('getQuoteSessionNoEnsure');
  const adapters = lib.findExport('quoteSessionAdapters') as QuoteSessionAdaptersLike | null;

  // The fields asked for out of an entry, or null for an entry that does not count.
  const valuesOf = (entry: unknown): Record<string, string | number | boolean> | null => {
    const { status, values } = (entry ?? {}) as QuoteEntryLike;
    if (status === 'error' || typeof values !== 'object' || values === null) {
      return null;
    }
    const picked: Record<string, string | number | boolean> = {};
    for (const field of fields) {
      const value: unknown = (values as Record<string, unknown>)[field];
      if (
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))
      ) {
        picked[field] = value;
      }
    }
    return Object.keys(picked).length === 0 ? null : picked;
  };
  const session = attempt(() =>
    typeof noEnsure === 'function' ? (noEnsure as (type: string) => unknown)('full') : undefined,
  ) as Partial<QuoteSessionLike> | null | undefined;
  const sessionData = attempt(() => session?.internals?.().data()) as
    Record<string, unknown> | null | undefined;
  const watchlist = adapters?._lastSymbolData;
  const sources: ['quote cache' | 'quote session' | 'watchlist', (key: string) => unknown][] = [
    [
      'quote cache',
      (key) => (typeof fieldsCache?.get === 'function' ? fieldsCache.get(key) : null),
    ],
    [
      'quote session',
      (key) =>
        typeof sessionData === 'object' && sessionData !== null && Object.hasOwn(sessionData, key)
          ? sessionData[key]
          : null,
    ],
    [
      'watchlist',
      (key) =>
        typeof watchlist?.has === 'function' && watchlist.has(key) ? watchlist.get(key) : null,
    ],
  ];
  const keys = [...new Set([symbol, symbol.toUpperCase()])];
  for (const [source, read] of sources) {
    for (const key of keys) {
      const entry = attempt(() => read(key));
      const values = valuesOf(entry);
      if (values !== null) {
        const name = (entry as QuoteEntryLike).symbolname;
        return { symbol: typeof name === 'string' ? name : key, source, values };
      }
    }
  }
  return null;
}

// The symbol info of the main series of the active chart, as far as `keys` name it, with the symbol
// the chart shows. Text, finite numbers, booleans and lists of text are copied; other values are
// left out. info is null while the symbol is not resolved.
export function readChartSymbolInfo(
  win: TvWindow,
  keys: string[],
):
  | { symbol: string | null; info: Record<string, string | number | boolean | string[]> | null }
  | PageErrorSentinel {
  const attempt = (read: () => unknown): unknown => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  const chart = attempt(() => api?.activeChart?.()) as
    Partial<ChartWidgetApiLike> | null | undefined;
  const series = attempt(() => chart?._chartWidget?.model().mainSeries()) as
    Partial<SeriesLike> | undefined;
  if (typeof series?.symbolInfo !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no chart series to read the symbol info from',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  const symbol: unknown = attempt(() => chart?.symbol?.());
  const raw = attempt(() => series.symbolInfo?.());
  let info: Record<string, string | number | boolean | string[]> | null = null;
  if (typeof raw === 'object' && raw !== null) {
    info = {};
    for (const key of keys) {
      const value: unknown = (raw as Record<string, unknown>)[key];
      if (
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))
      ) {
        info[key] = value;
      } else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
        info[key] = value.map((item: unknown) => String(item));
      }
    }
  }
  return { symbol: typeof symbol === 'string' ? symbol : null, info };
}

// Searches symbols with the search of the app, the request its search dialog sends, without
// highlight markup (serverHighlight false; the caller strips tags anyway). Each item is copied with
// its texts as they come, and the symbol of the first contract of a futures root. An item without
// a symbol is dropped. remaining is the count of results the app has not returned, null when it
// does not say. A search that fails is NOT_AVAILABLE with the message of the app.
export function searchSymbolsViaApi(
  win: TvWindow,
  text: string,
  exchange: string | null,
  type: string | null,
):
  | Promise<
      | {
          items: {
            symbol: string;
            description: string;
            exchange: string | null;
            prefix: string | null;
            type: string | null;
            typespecs: string[] | null;
            currency: string | null;
            fullName: string | null;
            contract: string | null;
          }[];
          remaining: number | null;
        }
      | PageErrorSentinel
    >
  | PageErrorSentinel {
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  const search = api?.searchSymbols;
  if (typeof search !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no symbol search to ask',
        hint: 'Check app_health: the app may still be loading, or the tab does not show a chart.',
      },
    };
  }
  const options: SymbolSearchOptionsLike = {
    text,
    serverHighlight: false,
    ...(exchange === null ? {} : { exchange }),
    ...(type === null ? {} : { type }),
  };
  const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  return Promise.resolve()
    .then(() => search.call(api, options))
    .then(
      (response: unknown) => {
        const { symbols, symbols_remaining: remaining } = (response ?? {}) as {
          symbols?: unknown;
          symbols_remaining?: unknown;
        };
        const list: unknown[] = Array.isArray(symbols) ? symbols : [];
        const items = list.flatMap((raw) => {
          const item = (raw ?? {}) as Record<string, unknown>;
          const symbol = textOf(item.symbol);
          if (symbol === null) {
            return [];
          }
          const { typespecs, contracts } = item;
          const firstContract: unknown = Array.isArray(contracts) ? contracts[0] : undefined;
          return [
            {
              symbol,
              description: textOf(item.description) ?? '',
              exchange: textOf(item.exchange),
              prefix: textOf(item.prefix),
              type: textOf(item.type),
              typespecs:
                Array.isArray(typespecs) && typespecs.every((spec) => typeof spec === 'string')
                  ? typespecs.map((spec: unknown) => String(spec))
                  : null,
              currency: textOf(item.currency_code),
              fullName: textOf(item.full_name),
              contract: textOf((firstContract as { symbol?: unknown } | null | undefined)?.symbol),
            },
          ];
        });
        return {
          items,
          remaining: typeof remaining === 'number' && Number.isFinite(remaining) ? remaining : null,
        };
      },
      (error: unknown): PageErrorSentinel => {
        const message: unknown = (error as { message?: unknown } | null | undefined)?.message;
        return {
          __tvmcpError: {
            code: 'NOT_AVAILABLE',
            message: `The symbol search of TradingView failed: ${typeof message === 'string' ? message : String(error)}`,
            hint: 'TradingView may be offline or slow. Check app_health and try again.',
          },
        };
      },
    );
}
