import type { PageHandle } from '../../core/connection.js';
import { mapSearchResult, type SearchItem } from './mappers.js';
import { searchSymbolsViaApi } from './page.js';

// How the tools that take a symbol find the listing it stands for with the symbol search of
// TradingView: data_get_symbol_info, alert_create and the watchlist additions.

// One search: the items the symbol search answers for a text, among the listings of an exchange
// when one is given. The search answers one page, so a crowded ticker may have more listings.
export type SymbolSearch = (
  text: string,
  exchange: string | null,
) => Promise<readonly SearchItem[]>;

export interface FoundListing {
  item: SearchItem;
  result: ReturnType<typeof mapSearchResult>;
}

// The symbol search of the app on `page`, which sends each search once, however many lookups need
// it.
export function symbolSearchOn(page: PageHandle): SymbolSearch {
  const sent = new Map<string, Promise<readonly SearchItem[]>>();
  return (text, exchange) => {
    const key = JSON.stringify([text, exchange]);
    let items = sent.get(key);
    if (items === undefined) {
      items = page.bridge
        .evaluate(searchSymbolsViaApi, [text, exchange, null])
        .then((answer) => answer.items);
      sent.set(key, items);
    }
    return items;
  };
}

// The listing `wanted` stands for, as the symbol search names it, or null when the search does not
// find it. EXCHANGE:TICKER is the result of that name, searched for among the listings of its
// exchange, so that a listing beyond the first page of a ticker that many exchanges list is found;
// and searched for again without the exchange when that finds none, since the filter of the app
// may know a listing by its exchange where the name has its prefix (BATS:AAPL is listed on Cboe
// BZX). A ticker alone is its first result, searched for without an exchange. The ticker is sent
// as given, and the exchange in capitals, as TradingView writes exchanges.
export async function findListing(
  search: SymbolSearch,
  wanted: string,
): Promise<FoundListing | null> {
  const colon = wanted.lastIndexOf(':');
  const ticker = wanted.slice(colon + 1);
  const upper = wanted.toUpperCase();
  const pick = (items: readonly SearchItem[]): FoundListing | null =>
    items
      .map((item) => ({ item, result: mapSearchResult(item) }))
      .find(({ result }) =>
        colon === -1
          ? result.ticker.toUpperCase() === upper
          : result.symbol.toUpperCase() === upper,
      ) ?? null;
  if (colon === -1) {
    return pick(await search(ticker, null));
  }
  const exchange = wanted.slice(0, colon).toUpperCase();
  const inExchange = exchange === '' ? null : pick(await search(ticker, exchange));
  return inExchange ?? pick(await search(ticker, null));
}
