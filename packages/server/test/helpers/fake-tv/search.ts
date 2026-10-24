import type { JsonValue } from '../../../src/utils/json.js';
import type { TvStateFixture } from './fixture.js';

// TradingViewApi.searchSymbols, the symbol search of the app, answering from the search items of
// the fixture. The real one sends an HTTP request on every call; this one keeps the items whose
// symbol or description contains the text, case aside and markup stripped, and whose exchange or
// prefix is the exchange given. A type filters by the type of the item. A type the app does not
// know rejects with the error of the app. The items keep the <em> markup of the fixture whatever
// serverHighlight says, so that the caller has to strip it, which it must do anyway. Like the app,
// it answers one page of at most SEARCH_PAGE_SIZE items: symbols_remaining is the count of the
// fixture plus the matches beyond the page.

export interface FakeSearchOptions {
  text?: string;
  exchange?: string;
  type?: string;
  serverHighlight?: boolean;
}

export interface FakeSearchResponse {
  symbols: Record<string, JsonValue>[];
  symbols_remaining: number;
}

// The item types each search type keeps.
const ITEM_TYPES: Readonly<Record<string, readonly string[]>> = {
  '': [],
  stocks: ['stock', 'dr'],
  funds: ['fund'],
  futures: ['futures'],
  forex: ['forex'],
  cfd: ['cfd'],
  'bitcoin,crypto': ['spot', 'crypto'],
  index: ['index'],
  bond: ['bond'],
  economic: ['economic'],
  options: ['option'],
};

const TAGS = /<\/?[^>]+(>|$)/g;

// The items one search answers: seen on the app for AAPL, 50 items and a count of the others.
export const SEARCH_PAGE_SIZE = 50;

// `count` synthetic listings of one ticker, on the exchanges EX01, EX02 and so on, for a ticker
// that more exchanges list than one page of the search holds.
export function crowdedListings(ticker: string, count: number): Record<string, JsonValue>[] {
  return Array.from({ length: count }, (_, index) => ({
    symbol: ticker,
    description: 'Synthetic Crowded Listing',
    exchange: `EX${String(index + 1).padStart(2, '0')}`,
    type: 'stock',
    typespecs: ['common'],
    currency_code: 'USD',
  }));
}

export function createFakeSearch(
  search: TvStateFixture['search'],
  record: (name: string, args: readonly unknown[]) => void,
): (options: FakeSearchOptions) => Promise<FakeSearchResponse> {
  return (options) => {
    record('TradingViewApi.searchSymbols', [options]);
    const type = options.type ?? '';
    const types = Object.hasOwn(ITEM_TYPES, type) ? ITEM_TYPES[type] : undefined;
    if (types === undefined) {
      return Promise.reject(new Error('Value is undefined'));
    }
    const text = (options.text ?? '').toLowerCase();
    const plain = (value: JsonValue | undefined): string =>
      typeof value === 'string' ? value.replace(TAGS, '').toLowerCase() : '';
    const symbols = search.symbols.filter(
      (item) =>
        (plain(item.symbol).includes(text) || plain(item.description).includes(text)) &&
        (options.exchange === undefined ||
          [plain(item.exchange), plain(item.prefix)].includes(options.exchange.toLowerCase())) &&
        (types.length === 0 || types.includes(plain(item.type))),
    );
    return Promise.resolve({
      symbols: structuredClone(symbols.slice(0, SEARCH_PAGE_SIZE)),
      symbols_remaining: search.remaining + Math.max(0, symbols.length - SEARCH_PAGE_SIZE),
    });
  };
}
