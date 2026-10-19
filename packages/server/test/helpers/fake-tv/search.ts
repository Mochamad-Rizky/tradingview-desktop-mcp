import type { JsonValue } from '../../../src/utils/json.js';
import type { TvStateFixture } from './fixture.js';

// TradingViewApi.searchSymbols, the symbol search of the app, answering from the search items of
// the fixture. The real one sends an HTTP request on every call; this one keeps the items whose
// symbol or description contains the text, case aside and markup stripped, and whose exchange or
// prefix is the exchange given. A type filters by the type of the item. A type the app does not
// know rejects with the error of the app. The items keep the <em> markup of the fixture whatever
// serverHighlight says, so that the caller has to strip it, which it must do anyway.
// symbols_remaining is the count of the fixture.

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
      symbols: structuredClone(symbols),
      symbols_remaining: search.remaining,
    });
  };
}
