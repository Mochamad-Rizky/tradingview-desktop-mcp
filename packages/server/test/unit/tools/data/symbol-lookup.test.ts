import type { PageHandle } from '../../../../src/core/connection.js';
import type { SearchItem } from '../../../../src/tools/data/mappers.js';
import {
  findListing,
  symbolSearchOn,
  type SymbolSearch,
} from '../../../../src/tools/data/symbol-lookup.js';

// How the tools find the listing a symbol stands for with the symbol search of TradingView. Values
// are synthetic.

function item(symbol: string, exchange: string, prefix: string | null = null): SearchItem {
  return {
    symbol,
    description: `${symbol} Synthetic`,
    exchange,
    prefix,
    type: 'stock',
    typespecs: ['common'],
    currency: 'USD',
    fullName: null,
    contract: null,
  };
}

// A search that answers from `answers` by text and exchange, and records what it was asked.
function searchFrom(answers: Record<string, SearchItem[]>): SymbolSearch & { asked: string[] } {
  const asked: string[] = [];
  const search = (text: string, exchange: string | null): Promise<readonly SearchItem[]> => {
    const key = exchange === null ? text : `${exchange}|${text}`;
    asked.push(key);
    return Promise.resolve(answers[key] ?? []);
  };
  return Object.assign(search, { asked });
}

test('EXCHANGE:TICKER is searched among the listings of its exchange', async () => {
  const search = searchFrom({ 'EX55|CROWD': [item('CROWD', 'EX55')] });

  const found = await findListing(search, 'ex55:CROWD');

  expect(found?.result.symbol).toBe('EX55:CROWD');
  expect(found?.item.exchange).toBe('EX55');
  // The exchange goes as TradingView writes exchanges, the ticker as given.
  expect(search.asked).toEqual(['EX55|CROWD']);
});

test('EXCHANGE:TICKER is searched again without the exchange when the exchange finds none', async () => {
  // The filter of the app may know a listing by its exchange rather than by its prefix.
  const search = searchFrom({ AAPL: [item('AAPL', 'NASDAQ'), item('AAPL', 'Cboe BZX', 'BATS')] });

  const found = await findListing(search, 'BATS:AAPL');
  const missing = await findListing(search, 'NYSE:AAPL');

  expect(found?.result.symbol).toBe('BATS:AAPL');
  expect(missing).toBeNull();
  expect(search.asked).toEqual(['BATS|AAPL', 'AAPL', 'NYSE|AAPL', 'AAPL']);
});

test('a blank exchange is not sent as a filter', async () => {
  const search = searchFrom({ AAPL: [item('AAPL', 'NASDAQ')] });

  // No listing is named ":AAPL", so nothing is found, but nothing is asked of an empty exchange.
  expect(await findListing(search, ':AAPL')).toBeNull();
  expect(search.asked).toEqual(['AAPL']);
});

test('a ticker alone is searched without an exchange, and stands for its first listing', async () => {
  const search = searchFrom({ msft: [item('MSFTX', 'NASDAQ'), item('MSFT', 'NASDAQ')] });

  const found = await findListing(search, 'msft');

  expect(found?.result.symbol).toBe('NASDAQ:MSFT');
  expect(search.asked).toEqual(['msft']);
  expect(await findListing(searchFrom({}), 'NOPE')).toBeNull();
});

test('symbolSearchOn sends each search once, however many lookups need it', async () => {
  const evaluate = vi.fn((_fn: unknown, [text, exchange]: [string, string | null, null]) =>
    Promise.resolve({ items: [item(text, exchange ?? 'NASDAQ')], remaining: 0 }),
  );
  const page = { bridge: { evaluate } } as unknown as PageHandle;
  const search = symbolSearchOn(page);

  const [first, again, other] = await Promise.all([
    search('AAPL', 'NASDAQ'),
    search('AAPL', 'NASDAQ'),
    search('AAPL', null),
  ]);

  expect(again).toBe(first);
  expect(other).not.toBe(first);
  expect(evaluate.mock.calls.map(([, args]) => args)).toEqual([
    ['AAPL', 'NASDAQ', null],
    ['AAPL', null, null],
  ]);
});
