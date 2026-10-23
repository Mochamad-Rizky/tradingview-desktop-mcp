import {
  callFailure,
  callOk,
  describeFailure,
  e2eEnabled,
  HarnessError,
  observe,
  planLimitSkipReason,
  sameJson,
  startE2eServer,
  type E2eServer,
} from './setup.js';

// The watchlist tools against the real TradingView Desktop. The watchlists are the user's, in the
// account, and no test touches a symbol of theirs: the suite adds one symbol the active watchlist
// does not hold yet, only while the list has room for it, and removes it again however the test
// ended. Which symbols the lists hold, and which one the test added, is compared without being
// printed.

// Symbols the test may add, the first the active list does not hold, by its ticker as well, being
// the one. They are all listed on their exchange under these names.
const CANDIDATES = [
  'NASDAQ:AAPL',
  'NASDAQ:MSFT',
  'NYSE:KO',
  'NASDAQ:INTC',
  'NYSE:IBM',
  'NASDAQ:CSCO',
  'NYSE:PFE',
  'NYSE:T',
];
// No exchange lists this symbol.
const UNKNOWN_SYMBOL = 'NASDAQ:ZZZQQX1';

interface Listing {
  id: string;
  name: string;
  symbolCount: number;
  active: boolean;
  editable: boolean;
}

interface Watchlist {
  id: string;
  name: string;
  editable: boolean;
  symbols: string[];
  sections: { name: string | null; symbols: string[] }[];
}

const tickerOf = (symbol: string): string =>
  symbol.slice(symbol.lastIndexOf(':') + 1).toUpperCase();

describe.skipIf(!e2eEnabled())('the watchlist tools against TradingView Desktop', () => {
  let e2e: E2eServer | undefined;

  beforeAll(async () => {
    e2e = await startE2eServer();
  });

  afterAll(async () => {
    await e2e?.close();
  });

  function server(): E2eServer {
    if (e2e === undefined) {
      throw new Error('The server did not start');
    }
    return e2e;
  }

  async function activeList(): Promise<Watchlist> {
    return (await callOk<Watchlist>(server().client, 'watchlist_get')).data;
  }

  test('lists the watchlists and reads the active one', async () => {
    const { client } = server();
    const { data } = await callOk<{ lists: Listing[] }>(client, 'watchlist_list');
    const list = await activeList();
    const active = data.lists.filter((item) => item.active);
    expect(active.length).toBe(1);
    expect(active[0]?.id === list.id, 'watchlist_get reads the active list').toBe(true);
    expect(active[0]?.symbolCount).toBe(list.symbols.length);
    expect(
      sameJson(
        list.sections.flatMap(({ symbols }) => symbols),
        list.symbols,
      ),
      'the sections hold the symbols of the list, in order',
    ).toBe(true);
    expect(list.symbols.every((symbol) => /^[^:\s]+:\S+$/.test(symbol))).toBe(true);
    observe('watchlists of the account', {
      lists: data.lists.length,
      editable: data.lists.filter((item) => item.editable).length,
      activeEditable: list.editable,
      activeSymbols: list.symbols.length,
      activeSections: list.sections.length,
      activeNamedSections: list.sections.filter(({ name }) => name !== null).length,
    });
  });

  test('adds a symbol the active list does not hold, within its limit, and removes it', async (context) => {
    const { client } = server();
    const before = await activeList();
    if (!before.editable) {
      return context.skip('The active watchlist is not one the watchlist tools edit');
    }
    const tickers = new Set(before.symbols.map(tickerOf));
    const symbol = CANDIDATES.find((candidate) => !tickers.has(tickerOf(candidate)));
    if (symbol === undefined) {
      return context.skip('The active watchlist holds every symbol the test could add');
    }
    // Every entry counts against the limit, the section markers too.
    const entries =
      before.symbols.length + before.sections.filter(({ name }) => name !== null).length;
    const full = await planLimitSkipReason(client, 'WATCHLIST_SYMBOLS', entries, 1);
    if (full !== null) {
      return context.skip(full);
    }

    let added: string | null = null;
    // However the test ends, after a timeout too: the symbol goes again if the list holds it and did
    // not before.
    onTestFinished(async () => {
      const failures: string[] = [];
      try {
        const now = await activeList();
        const own = now.symbols.filter(
          (item) =>
            !before.symbols.includes(item) &&
            (item === added || tickerOf(item) === tickerOf(symbol)),
        );
        if (own.length > 0) {
          try {
            await callOk(client, 'watchlist_remove', {
              symbols: own,
              // Only symbols the list did not hold before the test.
              confirm: true,
            });
          } catch (error) {
            failures.push(describeFailure(error));
          }
        }
        const left = await activeList();
        if (!sameJson(left.symbols, before.symbols)) {
          failures.push(
            `The active watchlist holds ${String(left.symbols.length)} symbols after the test and ` +
              `held ${String(before.symbols.length)} before, or in another order`,
          );
        }
      } catch (error) {
        failures.push(describeFailure(error));
      }
      if (failures.length > 0) {
        throw new HarnessError(`The watchlist test could not clean up: ${failures.join('; ')}`);
      }
    });
    // Nothing is added for a symbol the symbol search does not know.
    const unknown = await callFailure(client, 'watchlist_add', { symbol: UNKNOWN_SYMBOL });
    expect(unknown.code).toBe('INVALID_INPUT');
    expect(sameJson((await activeList()).symbols, before.symbols), 'nothing was added').toBe(true);

    const result = await callOk<{ listId: string; symbol: string; outcome: string }>(
      client,
      'watchlist_add',
      { symbol },
    );
    added = result.data.symbol;
    expect(result.data.outcome).toBe('added');
    expect(result.data.listId === before.id, 'the symbol went to the active list').toBe(true);
    expect(
      result.warnings.length === 0,
      'watchlist_add gives no warning: the store of the app shows the change',
    ).toBe(true);
    const withIt = await activeList();
    expect(withIt.symbols.length).toBe(before.symbols.length + 1);
    expect(withIt.symbols.includes(result.data.symbol), 'the list holds the symbol').toBe(true);
    expect(
      sameJson(
        withIt.symbols.filter((item) => item !== result.data.symbol),
        before.symbols,
      ),
      'the other symbols are as they were',
    ).toBe(true);

    // A second add finds it there.
    const again = await callOk<{ outcome: string }>(client, 'watchlist_add', { symbol });
    expect(again.data.outcome).toBe('already_listed');

    // A symbol the list does not hold is not removed, and needs no confirm.
    const notListed = await callOk<{ removed: string[]; notListed: string[] }>(
      client,
      'watchlist_remove',
      { symbols: [UNKNOWN_SYMBOL] },
    );
    expect(
      notListed.data.removed.length === 0 && sameJson(notListed.data.notListed, [UNKNOWN_SYMBOL]),
      'a symbol the list does not hold is reported, and nothing is removed',
    ).toBe(true);

    // The session added it, so it goes without confirm.
    const removed = await callOk<{ listId: string; removed: string[]; notListed: string[] }>(
      client,
      'watchlist_remove',
      { symbols: [result.data.symbol] },
    );
    expect(
      removed.data.removed.length === 1 && removed.data.removed[0] === result.data.symbol,
    ).toBe(true);
    expect(removed.warnings.length === 0, 'watchlist_remove gives no warning').toBe(true);
    added = null;
    const after = await activeList();
    expect(sameJson(after.symbols, before.symbols), 'the list holds what it held before').toBe(
      true,
    );
    expect(sameJson(after.sections, before.sections), 'and in the same sections').toBe(true);
    observe('watchlist add and remove', {
      entriesBefore: entries,
      addedAtTheEnd: withIt.symbols.at(-1) === result.data.symbol,
      sectionOfTheAdded:
        withIt.sections.findIndex(({ symbols }) => symbols.includes(result.data.symbol)) ===
        withIt.sections.length - 1
          ? 'last'
          : 'other',
      warnings: result.warnings.length + removed.warnings.length,
    });
  });
});
