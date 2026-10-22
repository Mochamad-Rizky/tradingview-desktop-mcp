import { loadTvFixture, type TvStateFixture } from '../../helpers/fake-tv/fixture.js';
import type { FakeWebpackRequire } from '../../helpers/fake-tv/webpack.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTvOverrides,
  type FakeTvWindow,
} from '../../helpers/fake-tv/window.js';

// The watchlists of the fake account and the watchlist modules of the fake app (watchlists.ts),
// checked against what the reverse-engineering notes of Plan 3 (section 3) and the web build record
// for the app. Values are synthetic.

const fixture = loadTvFixture();

type Selector = (state: unknown, ...args: unknown[]) => unknown;

interface Store {
  getState(): Record<string, unknown> & {
    customLists: { lists: { ids: unknown[] }; timestamp: number | null };
    activeSymbolList: unknown;
  };
  dispatch(action: unknown): unknown;
}

interface Backend {
  getCustomWatchLists(): Promise<Record<string, unknown>[]>;
  addSymbols(list: unknown, symbols: unknown): Promise<string[]>;
  removeSymbols(list: unknown, symbols: unknown): Promise<string[]>;
  replaceSymbols(list: unknown, symbols: unknown): Promise<unknown>;
  setActive(list: unknown): Promise<unknown>;
}

// The exports of the default webpack cache, by name. Each look pushes a chunk of its own: the runtime
// hands nothing to a chunk ID it has seen.
let probes = 0;
function exportsOf(win: FakeTvWindow): Record<string, unknown> {
  let handed: FakeWebpackRequire | undefined;
  probes += 1;
  (win.webpackChunktradingview as { push(chunk: unknown): unknown }).push([
    [`probe${String(probes)}`],
    {},
    (given: FakeWebpackRequire) => (handed = given),
  ]);
  const found: Record<string, unknown> = {};
  for (const record of Object.values(handed?.c ?? {})) {
    Object.assign(found, record.exports);
  }
  return found;
}

function windowWith(from: TvStateFixture = fixture, overrides: FakeTvOverrides = {}): FakeTvWindow {
  return createFakeTvWindow(from, overrides);
}

function serviceOf(win: FakeTvWindow, descriptorName: string): unknown {
  const exports = exportsOf(win);
  return (exports.serviceOrNull as (descriptor: unknown) => unknown)(exports[descriptorName]);
}

function storeOf(win: FakeTvWindow): Store {
  return (serviceOf(win, 'SYMBOL_LIST_SERVICE') as { store: Store }).store;
}

function backendOf(win: FakeTvWindow): Backend {
  return serviceOf(win, 'SYMBOL_LIST_REPOSITORY_BACKEND_SERVICE') as Backend;
}

function selector(win: FakeTvWindow, name: string): Selector {
  return exportsOf(win)[name] as Selector;
}

const withWatchlists = (
  change: Partial<NonNullable<TvStateFixture['watchlists']>>,
): TvStateFixture => ({
  ...fixture,
  watchlists: {
    ...(fixture.watchlists ?? { lists: [], active: null }),
    ...change,
  },
});

// What a promise rejected with, as a plain object of the members page code reads.
async function rejectionOf(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    const { name, message } = error as Record<string, unknown>;
    return { name, message };
  }
  throw new Error('Expected the promise to reject');
}

const calls = (win: FakeTvWindow, name: string) => inspectFakeWindow(win).callsTo(name);

describe('the symbol list service', () => {
  test('is registered with the service locator under SYMBOL_LIST_SERVICE, with a store and its actions', () => {
    const win = windowWith();
    const exports = exportsOf(win);

    expect(exports.SYMBOL_LIST_SERVICE).toBe('SymbolListService');
    expect(exports.SYMBOL_LIST_REPOSITORY_BACKEND_SERVICE).toBe('SymbolListRepositoryBackend');
    expect((exports.hasService as (descriptor: unknown) => boolean)('SymbolListService')).toBe(
      true,
    );
    const service = serviceOf(win, 'SYMBOL_LIST_SERVICE') as Record<string, unknown>;
    expect(Object.keys(service).sort()).toEqual(['actions', 'runner', 'store', 'task']);
    expect(Object.keys(service.actions as object).sort()).toEqual([
      'addSymbols',
      'createNewWatchList',
      'initWidget',
      'saveListAs',
    ]);
  });

  test('at boot the store holds the active list alone, without the timestamp of a full load, and every flag and hot list', () => {
    const state = storeOf(windowWith()).getState();

    expect(Object.keys(state).sort()).toEqual([
      'activeSymbolList',
      'collapsedSeparators',
      'customLists',
      'hotLists',
      'isAuthenticated',
      'markedLists',
      'positions',
      'widgets',
    ]);
    expect(state.customLists.timestamp).toBeNull();
    expect(state.customLists.lists.ids).toEqual([101]);
    expect(state.activeSymbolList).toEqual({ type: 'custom', id: 101 });
    expect(state.isAuthenticated).toBe(true);
    expect(state.markedLists).toMatchObject({
      lists: {
        colors: ['red'],
        byColor: { red: { color: 'red', name: null, symbols: ['NASDAQ:NVDA'] } },
        bySymbol: { 'NASDAQ:NVDA': 'red' },
      },
    });
    expect(state.hotLists).toMatchObject({
      lists: { '###HOT###US.gainers': { type: 'hot', name: 'Fixture Gainers' } },
    });
  });

  test('holds every custom list with a timestamp when the fixture says the lists are ready', () => {
    const state = storeOf(windowWith(withWatchlists({ ready: true }))).getState();

    expect(state.customLists.lists.ids).toEqual([101, 102]);
    expect(state.customLists.timestamp).toEqual(expect.any(Number));
  });

  test('a fixture without watchlists gives an empty store, no active list and no list on the server', () => {
    const win = windowWith({ ...fixture, watchlists: undefined });

    expect(storeOf(win).getState()).toMatchObject({
      customLists: { lists: { ids: [] }, timestamp: null },
      activeSymbolList: null,
    });
    expect(inspectFakeWindow(win).state.watchlists.server).toEqual([]);
  });
});

describe('the selectors', () => {
  test('read the custom lists, the active list and the readiness the way the app does', () => {
    const win = windowWith(withWatchlists({ ready: true }));
    const state = storeOf(win).getState();

    expect(selector(win, 'getCustomLists')(state)).toEqual([
      {
        type: 'custom',
        id: 101,
        name: 'Fixture List',
        description: null,
        symbols: ['###Tech', 'NASDAQ:AAPL', 'NASDAQ:MSFT', '###Crypto', 'BINANCE:BTCUSDT'],
        shared: false,
        persistedState: expect.any(Object) as object,
      },
      expect.objectContaining({ type: 'custom', id: 102, name: 'Second List' }),
    ]);
    expect(selector(win, 'getCustomListById')(state, 102)).toMatchObject({ name: 'Second List' });
    expect(selector(win, 'getCustomListById')(state, '102')).toMatchObject({ name: 'Second List' });
    expect(selector(win, 'getCustomListById')(state, 999)).toBeNull();
    expect(selector(win, 'getGlobalActiveID')(state)).toBe(101);
    expect(selector(win, 'getGlobalActiveSymbolList')(state)).toMatchObject({
      type: 'custom',
      id: 101,
      name: 'Fixture List',
    });
    expect(selector(win, 'getIsReadyCustomLists')(state)).toBe(true);
    expect(selector(win, 'getIsReadyCustomLists')(storeOf(windowWith()).getState())).toBe(false);
    expect(selector(win, 'getCustomListsState')(state)).toBe(state.customLists);
  });

  test('getGlobalActiveSymbolList reads an active flag list, named by its color, and an active hot list', () => {
    const flagged = windowWith(withWatchlists({ active: { type: 'color', id: 'red' } }));
    const hot = windowWith(withWatchlists({ active: { type: 'hot', id: '###HOT###US.gainers' } }));
    const gone = windowWith(withWatchlists({ active: { type: 'color', id: 'blue' } }));

    expect(
      selector(flagged, 'getGlobalActiveSymbolList')(storeOf(flagged).getState()),
    ).toMatchObject({ type: 'colored', id: 'red', name: 'Red list', symbols: ['NASDAQ:NVDA'] });
    expect(selector(hot, 'getGlobalActiveSymbolList')(storeOf(hot).getState())).toEqual({
      id: '###HOT###US.gainers',
      name: 'Fixture Gainers',
      type: 'hot',
      group: 'gainers',
      exchange: 'US',
      symbols: ['NASDAQ:AAPL', 'NYSE:IBM'],
    });
    expect(selector(gone, 'getGlobalActiveSymbolList')(storeOf(gone).getState())).toBeNull();
    expect((exportsOf(flagged).getColoredListTitle as (color: string) => string)('pink')).toBe(
      'Pink list',
    );
  });
});

describe('the refresh thunk', () => {
  test('getCustomWatchlistsThunk loads every custom list into the store through the backend', async () => {
    const win = windowWith();
    const store = storeOf(win);
    const thunk = exportsOf(win).getCustomWatchlistsThunk as (signal: unknown) => unknown;

    const done = store.dispatch(thunk(null));

    expect(done).toBeInstanceOf(Promise);
    await done;
    expect(store.getState().customLists.lists.ids).toEqual([101, 102]);
    expect(store.getState().customLists.timestamp).toEqual(expect.any(Number));
    expect(calls(win, 'symbolListBackend.getCustomWatchLists')).toEqual([[]]);
    expect(calls(win, 'symbolListStore.dispatch')).toEqual([['custom-lists/setup']]);
  });

  test('a call aborts the call before it, which then changes nothing', async () => {
    const win = windowWith();
    const store = storeOf(win);
    const thunk = exportsOf(win).getCustomWatchlistsThunk as (signal: unknown) => unknown;

    const first = store.dispatch(thunk(null));
    const second = store.dispatch(thunk(null));
    await Promise.all([first, second]);

    expect(calls(win, 'symbolListBackend.getCustomWatchLists')).toHaveLength(2);
    expect(calls(win, 'symbolListStore.dispatch')).toEqual([['custom-lists/setup']]);
  });

  test('rejects with the refusal of the backend and leaves the store as it was, unless it was aborted', async () => {
    const win = windowWith();
    const store = storeOf(win);
    const thunk = exportsOf(win).getCustomWatchlistsThunk as (signal: unknown) => unknown;
    inspectFakeWindow(win).state.watchlists.errors.getCustomWatchLists = {
      code: null,
      message: 'Failed to fetch',
    };

    expect(await rejectionOf(store.dispatch(thunk(null)) as Promise<unknown>)).toEqual({
      name: 'TypeError',
      message: 'Failed to fetch',
    });
    expect(store.getState().customLists.timestamp).toBeNull();
    const aborted = store.dispatch(thunk(null)) as Promise<unknown>;
    const latest = store.dispatch(thunk(null)) as Promise<unknown>;
    await expect(aborted).resolves.toBeUndefined();
    await expect(latest).rejects.toThrow('Failed to fetch');
  });

  test('the store ignores an action it does not know, and a thunk that answers nothing', () => {
    const win = windowWith();
    const store = storeOf(win);
    const before = store.getState();

    store.dispatch({ type: 'custom-lists/insert', payload: {} });
    store.dispatch(undefined);

    expect(store.getState()).toBe(before);
    expect(calls(win, 'symbolListStore.dispatch')).toEqual([['custom-lists/insert'], [undefined]]);
  });
});

describe('the backend service', () => {
  test('addSymbols appends what the list does not hold on the server, not in the store, and answers its symbols', async () => {
    const win = windowWith();
    const backend = backendOf(win);

    const answered = await backend.addSymbols({ id: 102 }, [
      'NASDAQ:MSFT',
      'NYSE:IBM',
      'NASDAQ:MSFT',
    ]);

    expect(answered).toEqual(['NYSE:IBM', 'FX:EURUSD', 'NASDAQ:MSFT']);
    expect(inspectFakeWindow(win).state.watchlists.server[1]?.symbols).toEqual(answered);
    // The store learns of it only from the next refresh.
    expect(storeOf(win).getState().customLists.lists.ids).toEqual([101]);
    expect(calls(win, 'symbolListBackend.addSymbols')).toEqual([
      [{ id: 102 }, ['NASDAQ:MSFT', 'NYSE:IBM', 'NASDAQ:MSFT']],
    ]);
  });

  test('removeSymbols takes every entry of the given symbols out on the server and answers what is left', async () => {
    const win = windowWith();
    inspectFakeWindow(win).state.watchlists.server[0]?.symbols.push('NASDAQ:AAPL');

    const answered = await backendOf(win).removeSymbols({ id: 101 }, ['NASDAQ:AAPL', 'NYSE:IBM']);

    expect(answered).toEqual(['###Tech', 'NASDAQ:MSFT', '###Crypto', 'BINANCE:BTCUSDT']);
    expect(calls(win, 'symbolListBackend.removeSymbols')).toEqual([
      [{ id: 101 }, ['NASDAQ:AAPL', 'NYSE:IBM']],
    ]);
  });

  test('refuses the way handleJSON of the app does: a staged error, an unknown list, a bad request and the limit of the server', async () => {
    const win = windowWith();
    const backend = backendOf(win);
    const { state } = inspectFakeWindow(win);

    state.watchlists.errors.addSymbols = { code: 'some_code', message: 'Refused' };
    expect(await rejectionOf(backend.addSymbols({ id: 101 }, ['NYSE:IBM']))).toEqual({
      name: 'ApiError:some_code',
      message: 'Refused',
    });
    state.watchlists.errors = {};
    expect(await rejectionOf(backend.removeSymbols({ id: 7 }, ['NYSE:IBM']))).toEqual({
      name: 'ApiError:not_found',
      message: 'Not found',
    });
    expect(await rejectionOf(backend.addSymbols({ id: 101 }, 'NYSE:IBM'))).toEqual({
      name: 'ApiError:invalid_request',
      message: 'Invalid request',
    });
    expect(await rejectionOf(backend.removeSymbols({ id: 101 }, [1]))).toEqual({
      name: 'ApiError:invalid_request',
      message: 'Invalid request',
    });
    state.watchlists.serverLimit = 6;
    expect(await rejectionOf(backend.addSymbols({ id: 101 }, ['NYSE:IBM', 'FX:EURUSD']))).toEqual({
      name: 'ApiError:plan_symbols_limit_reached',
      message: 'A watchlist can hold up to 6 symbols on the plan of the account',
    });
    await expect(backend.addSymbols({ id: 101 }, ['NYSE:IBM'])).resolves.toHaveLength(6);
  });

  test('while the list has open sections to save, it is replaced with the symbols of the store and the change is left out', async () => {
    const win = windowWith();
    const backend = backendOf(win);
    const { state } = inspectFakeWindow(win);
    const pending = exportsOf(win).pendingOpenSeparators as Set<string>;

    expect(pending).toBe(state.watchlists.pendingOpenSeparators);
    state.watchlists.server[0]?.symbols.push('NYSE:IBM');
    pending.add('101');
    const added = await backend.addSymbols({ id: 101 }, ['FX:EURUSD']);
    pending.add('101');
    state.watchlists.server[0]?.symbols.push('NYSE:IBM');
    const removed = await backend.removeSymbols({ id: 101 }, ['NASDAQ:AAPL']);

    const stored = ['###Tech', 'NASDAQ:AAPL', 'NASDAQ:MSFT', '###Crypto', 'BINANCE:BTCUSDT'];
    expect(added).toEqual(stored);
    expect(removed).toEqual(stored);
    expect(state.watchlists.server[0]?.symbols).toEqual(stored);
    expect(pending.size).toBe(0);
  });

  test('getCustomWatchLists answers the lists of the server; the other methods only record themselves', async () => {
    const win = windowWith();
    const backend = backendOf(win);

    const lists = await backend.getCustomWatchLists();
    await backend.replaceSymbols({ id: 101 }, []);
    await backend.setActive({ id: 102 });

    expect(lists.map(({ id, name, type }) => [id, name, type])).toEqual([
      [101, 'Fixture List', 'custom'],
      [102, 'Second List', 'custom'],
    ]);
    expect(calls(win, 'symbolListBackend.replaceSymbols')).toEqual([[{ id: 101 }, []]]);
    expect(calls(win, 'symbolListBackend.setActive')).toEqual([[{ id: 102 }]]);
    expect(inspectFakeWindow(win).state.watchlists.server[0]?.symbols).toHaveLength(5);
  });
});

describe('the limits', () => {
  test('getWatchlistSymbolsLimit is MAX_WATCHLIST_LENGTH while tiered limits are off, and the plan limit while they are on', () => {
    const off = exportsOf(windowWith());
    const on = exportsOf(
      windowWith({
        ...fixture,
        featureToggles: { ...fixture.featureToggles, watchlist_symbols_tiered_limits: true },
      }),
    );
    const onWithout = exportsOf(
      windowWith({
        ...fixture,
        planLimits: { INDICATORS_ON_CHART: 2 },
        featureToggles: { watchlist_symbols_tiered_limits: true },
      }),
    );

    expect(off.MAX_WATCHLIST_LENGTH).toBe(1000);
    expect((off.getWatchlistSymbolsLimit as () => number)()).toBe(1000);
    expect((on.getWatchlistSymbolsLimit as () => number)()).toBe(30);
    expect((onWithout.getWatchlistSymbolsLimit as () => number)()).toBe(1000);
  });

  test('showMaxLimitError records the warning dialog of the app', () => {
    const win = windowWith();

    (exportsOf(win).showMaxLimitError as (parent?: unknown) => void)('parent');

    expect(calls(win, 'dialog.watchlistMaxLimit')).toEqual([['parent']]);
  });
});

describe('the watchlist functions the tools must never use', () => {
  test('every call of the dialog thunks, the widget thunks, the service actions and initSymbolListService is recorded', () => {
    const win = windowWith();
    const exports = exportsOf(win);
    const service = serviceOf(win, 'SYMBOL_LIST_SERVICE') as {
      actions: Record<string, (...args: unknown[]) => unknown>;
    };

    for (const name of [
      'addWatchlistSymbolsThunk',
      'removeWatchlistSymbolsThunk',
      'replaceWatchlistSymbolsThunk',
      'getActiveWatchlistThunk',
      'setActiveWatchlistThunk',
      'createWatchlistThunk',
      'validateWatchListSymbols',
      'addSymbolsThunk',
      'addSymbolsToCustomListThunk',
      'addSymbolsToListThunk',
      'removeSymbolsThunk',
      'removeSelectedSymbolsThunk',
      'enforceListAccessThunk',
      'initSymbolListService',
    ]) {
      expect((exports[name] as (...args: unknown[]) => unknown)('x'), name).toBeUndefined();
    }
    service.actions.addSymbols?.('watchlist-widget', ['NYSE:IBM']);

    expect(inspectFakeWindow(win).calls.map(({ name }) => name)).toEqual([
      'watchlistThunks.addWatchlistSymbolsThunk',
      'watchlistThunks.removeWatchlistSymbolsThunk',
      'watchlistThunks.replaceWatchlistSymbolsThunk',
      'watchlistThunks.getActiveWatchlistThunk',
      'watchlistThunks.setActiveWatchlistThunk',
      'watchlistThunks.createWatchlistThunk',
      'watchlistThunks.validateWatchListSymbols',
      'watchlistWidget.addSymbolsThunk',
      'watchlistWidget.addSymbolsToCustomListThunk',
      'watchlistWidget.addSymbolsToListThunk',
      'watchlistWidget.removeSymbolsThunk',
      'watchlistWidget.removeSelectedSymbolsThunk',
      'watchlistWidget.enforceListAccessThunk',
      'initSymbolListService',
      'symbolListService.actions.addSymbols',
    ]);
  });

  test('TVD.getActiveWatchlistId resolves undefined, as on the app, and records itself', async () => {
    const win = windowWith();

    await expect(win.TVD.getActiveWatchlistId()).resolves.toBeUndefined();
    expect(calls(win, 'TVD.getActiveWatchlistId')).toEqual([[]]);
  });
});

describe('options', () => {
  test('a service can be left out of the service locator, and a module out of the cache', () => {
    const exports = exportsOf(
      windowWith(fixture, {
        watchlists: {
          withoutService: true,
          withoutBackend: true,
          withoutSelectors: true,
          withoutRefreshThunk: true,
          withoutLimits: true,
        },
      }),
    );
    const serviceOrNull = exports.serviceOrNull as (descriptor: unknown) => unknown;

    expect(serviceOrNull('SymbolListService')).toBeNull();
    expect(serviceOrNull('SymbolListRepositoryBackend')).toBeNull();
    for (const name of [
      'getCustomLists',
      'getCustomWatchlistsThunk',
      'getWatchlistSymbolsLimit',
      'MAX_WATCHLIST_LENGTH',
    ]) {
      expect(Object.hasOwn(exports, name), name).toBe(false);
    }
    // The page layout service is still there.
    expect(serviceOrNull('PageLayoutService')).not.toBeNull();
    expect(exports.addWatchlistSymbolsThunk).toEqual(expect.any(Function));
  });
});
