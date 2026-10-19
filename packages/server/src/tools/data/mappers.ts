import { toIso } from '../../utils/time.js';
import { isReportableTime } from '../chart/mappers.js';

// How the market data tools turn what the app holds into what they report: bar rows, quote fields
// and symbol search items.

const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

// The bars of `rows` that lie between `from` and `to` (both included, in the times of the rows),
// at most the last `count` of them, oldest first as the rows come: time in Unix seconds and as
// ISO, the four prices, and the volume, null where the row has none. A row that is not a bar with a
// reportable time and four prices is dropped.
export function toBarRows(
  rows: readonly unknown[],
  from: number | undefined,
  to: number | undefined,
  count: number,
) {
  return rows
    .flatMap((row) => {
      if (!Array.isArray(row)) {
        return [];
      }
      const [time, ...values] = row as unknown[];
      const [open, high, low, close, volume] = values.map(finiteNumber);
      if (
        !isReportableTime(time) ||
        open == null ||
        high == null ||
        low == null ||
        close == null ||
        (from !== undefined && time < from) ||
        (to !== undefined && time > to)
      ) {
        return [];
      }
      return [{ time, timeIso: toIso(time), open, high, low, close, volume: volume ?? null }];
    })
    .slice(-count);
}

// The quote fields the tools read, by the names the app keeps them under. The app renames the wire
// fields lp, ch and chp to last_price, change and change_percent before it caches a quote, so the
// wire names never reach a page.
export const QUOTE_FIELDS = [
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
] as const;

// A quote as the tools report it, from the values of a quote of the app. A field that is missing,
// or of the wrong type, is null. time is the time of the last price (lp_time).
export function mapQuote(values: Readonly<Record<string, unknown>>) {
  const time = isReportableTime(values.lp_time) ? values.lp_time : null;
  return {
    last: finiteNumber(values.last_price),
    change: finiteNumber(values.change),
    changePercent: finiteNumber(values.change_percent),
    bid: finiteNumber(values.bid),
    ask: finiteNumber(values.ask),
    bidSize: finiteNumber(values.bid_size),
    askSize: finiteNumber(values.ask_size),
    high: finiteNumber(values.high_price),
    low: finiteNumber(values.low_price),
    open: finiteNumber(values.open_price),
    prevClose: finiteNumber(values.prev_close_price),
    volume: finiteNumber(values.volume),
    currency: typeof values.currency_code === 'string' ? values.currency_code : null,
    time,
    timeIso: time === null ? null : toIso(time),
  };
}

// The regexp the app strips the markup of search results with, a tag cut off at the end included.
const TAGS = /<\/?[^>]+(>|$)/g;

export function stripTags(text: string): string {
  return text.replace(TAGS, '');
}

// A symbol search item as the page function copies it: the raw texts, markup included, and the
// symbol of the first contract of a futures root (contract), which is what a click in the search
// dialog shows.
export interface SearchItem {
  symbol: string;
  description: string;
  exchange: string | null;
  prefix: string | null;
  type: string | null;
  typespecs: string[] | null;
  currency: string | null;
  fullName: string | null;
  contract: string | null;
}

// A search result: symbol, the name to give the other tools, built the way the app builds the
// symbol it puts on the chart (the prefix of the item, or else its exchange, a colon and the
// ticker), the ticker, description, exchange, type and currency, with every tag stripped. The
// ticker of a futures root is the symbol of its first contract.
export function mapSearchResult(item: SearchItem) {
  const ticker = stripTags(item.contract ?? item.symbol);
  // An empty prefix counts as none, as `prefix || exchange` has it in the app.
  const named = (text: string | null): string | null =>
    text === null || stripTags(text) === '' ? null : stripTags(text);
  const listing = named(item.prefix) ?? named(item.exchange);
  const exchange = item.exchange === null ? null : stripTags(item.exchange);
  return {
    symbol: listing === null ? ticker : `${listing}:${ticker}`,
    ticker,
    description: stripTags(item.description),
    exchange,
    type: item.type,
    currency: item.currency,
  };
}

// The search types the app knows, by the names a client gives. crypto is sent as the type the app
// knows it by, "bitcoin,crypto"; any other type makes the search of the app reject.
export const SEARCH_TYPES = [
  'stocks',
  'funds',
  'futures',
  'forex',
  'cfd',
  'crypto',
  'index',
  'bond',
  'economic',
  'options',
] as const;

export type SearchType = (typeof SEARCH_TYPES)[number];

export function searchTypeParam(type: SearchType): string {
  return type === 'crypto' ? 'bitcoin,crypto' : type;
}
