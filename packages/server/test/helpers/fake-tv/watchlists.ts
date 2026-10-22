import type { JsonValue } from '../../../src/utils/json.js';
import type { FixtureWatchlists } from './fixture.js';

// The watchlists of the account and the watchlist modules of the app, built from the watchlists of
// the fixture (reverse-engineering notes of Plan 3, section 3, and the web build). Values are
// synthetic.
//
// - The symbol list service, which the app registers with its service locator at boot under the
//   descriptor that is the export SYMBOL_LIST_SERVICE, holds a Redux-like store: getState() answers
//   the state with the keys of the app (customLists, markedLists, hotLists, activeSymbolList,
//   widgets, positions, isAuthenticated, collapsedSeparators), and dispatch() runs a function as a
//   thunk (with dispatch and getState, answering what it returns, as redux-thunk does) and reduces a
//   plain action. The only action reduced is custom-lists/setup, which holds every custom list of
//   the account and sets customLists.timestamp, so that the lists count as ready; every plain action
//   records its type (symbolListStore.dispatch). As at the boot of the app, the store starts with
//   the active list alone and no timestamp, unless the fixture says the lists are ready; the flag
//   lists and the hot lists of the fixture are always there. The actions of the service
//   (addSymbols, initWidget, saveListAs, createNewWatchList) only record themselves.
// - The selectors of the app (getCustomListsState, getCustomLists, getCustomListById,
//   getGlobalActiveID, getGlobalActiveSymbolList, getIsReadyCustomLists) read that state the way the
//   app does: a custom list as { type: 'custom', id, name, description, symbols, shared,
//   persistedState }, a flag list as { type: 'colored', id: color, color, name, symbols, ... } named
//   by getColoredListTitle unless it has a name, a hot list as kept.
// - getCustomWatchlistsThunk(signal) makes the thunk the app refreshes the custom lists with, and
//   records itself with its signal: the thunk asks the backend service for the lists and dispatches
//   custom-lists/setup with them. As respectLatest of the app makes it, a call aborts the call before
//   it, which then changes nothing; a refusal of the backend rejects the thunk.
// - The backend service, registered under SYMBOL_LIST_REPOSITORY_BACKEND_SERVICE, answers from the
//   lists of the watchlist server (state.watchlists.server), which it alone changes: the store
//   learns of a change only from the next refresh, as on the app. getCustomWatchLists(),
//   addSymbols({ id }, symbols) and removeSymbols({ id }, symbols) each record themselves
//   (symbolListBackend.<method>) and answer on a later tick. addSymbols appends the symbols the list
//   does not hold yet and answers the symbols of the list; removeSymbols takes every entry of the
//   given symbols out and answers what is left. A refusal rejects the way handleJSON of the app does:
//   an Error with the message of the server and the name ApiError:<code>, for the error a test
//   stages for the method (state.watchlists.errors; a staged error without a code is a request that
//   failed on the way, a TypeError), for an unknown list (not_found), and for a list that would grow
//   beyond the limit of the server (state.watchlists.serverLimit, plan_symbols_limit_reached). While
//   state.watchlists.pendingOpenSeparators holds the id of the list, addSymbols and removeSymbols do
//   what the REST client of the app does then: they replace the list with the symbols the store holds
//   for it and leave out what they were given. The other methods only record themselves. The fake
//   does not model the local default list a signed-out app edits instead.
// - The limits of the app: MAX_WATCHLIST_LENGTH (1000), and getWatchlistSymbolsLimit(), which is the
//   WATCHLIST_SYMBOLS limit of the plan (1000 without one) while the feature toggle
//   watchlist_symbols_tiered_limits is on, and MAX_WATCHLIST_LENGTH otherwise. showMaxLimitError, the
//   warning dialog of the app, records itself (dialog.watchlistMaxLimit).
// - The export pendingOpenSeparators is the set of state.watchlists.pendingOpenSeparators.
// - The thunks and functions the tools must never use, whose app versions open warning, paywall or
//   confirmation dialogs or create the service, only record each call: the store thunks of the app
//   other than getCustomWatchlistsThunk (watchlistThunks.*), the thunks of the watchlist widget
//   (watchlistWidget.*) and initSymbolListService.

export interface FakeWatchlistsOptions {
  // Leaves the symbol list service out of the service locator, as in the early boot of the app.
  withoutService?: boolean;
  // Leaves the backend service out of the service locator.
  withoutBackend?: boolean;
  // Leave a module out of the cache, as a build without it.
  withoutSelectors?: boolean;
  withoutRefreshThunk?: boolean;
  withoutLimits?: boolean;
}

export type FakeWatchlistsMethod = 'getCustomWatchLists' | 'addSymbols' | 'removeSymbols';

// An error of the server, with the code handleJSON names the error after; null for a request that
// failed on the way.
export interface FakeWatchlistsError {
  code: string | null;
  message: string;
}

// A custom list as the watchlist server keeps it.
export interface FakeServerList {
  id: number | string;
  name: string;
  symbols: string[];
}

export interface FakeCustomListRecord {
  id: number | string;
  name: string;
  description: string | null;
  symbols: string[];
  shared: boolean;
  timestamp: number | null;
  collapsedSeparators: Record<string, boolean>;
  persistedState: Record<string, JsonValue>;
  lastChangeTimestamp: number;
}

export interface FakeMarkedListRecord {
  color: string;
  name: string | null;
  description: string | null;
  shared: boolean;
  symbols: string[];
  persistedState: Record<string, JsonValue>;
}

export interface FakeHotList {
  id: string;
  name: string;
  type: 'hot';
  exchange: string;
  group: string;
  symbols: string[];
}

export type FakeActiveList = { type: 'custom' | 'color' | 'hot'; id: number | string } | null;

// The state of the store of the symbol list service, with the keys of the app.
export interface FakeSymbolListState {
  customLists: {
    lists: { ids: (number | string)[]; byId: Record<string, FakeCustomListRecord> };
    timestamp: number | null;
  };
  markedLists: {
    lists: {
      colors: string[];
      byColor: Record<string, FakeMarkedListRecord>;
      bySymbol: Record<string, string>;
    };
    commands: unknown[];
    timestamp: number | null;
  };
  hotLists: { lists: Record<string, FakeHotList> };
  activeSymbolList: FakeActiveList;
  widgets: Record<string, unknown>;
  positions: Record<string, unknown>;
  isAuthenticated: boolean;
  collapsedSeparators: Record<string, unknown>;
}

// The live state of the watchlists. Tests may assign to it, for example to stage the error a method
// rejects with, or to change the store under the page.
export interface FakeWatchlistsState {
  // The custom lists of the account on the watchlist server, in order.
  server: FakeServerList[];
  // The state the store of the symbol list service holds.
  store: FakeSymbolListState;
  // The error each call of a method rejects with, until a test removes it.
  errors: Partial<Record<FakeWatchlistsMethod, FakeWatchlistsError>>;
  // The most entries the server lets a list hold, null for no limit of its own.
  serverLimit: number | null;
  // The ids of the lists whose open sections the app still has to save.
  pendingOpenSeparators: Set<string>;
}

export interface FakeWatchlistsDeps {
  state: FakeWatchlistsState;
  record: (name: string, args: readonly unknown[]) => void;
  signedIn: () => boolean;
  isFeatureEnabled: (name: string) => boolean;
  // The WATCHLIST_SYMBOLS limit of the plan, undefined without one.
  planLimit: number | undefined;
  provideService: (descriptor: unknown, service: unknown) => void;
  options?: FakeWatchlistsOptions | undefined;
}

export interface FakeWatchlists {
  readonly modules: Record<string, Record<string, unknown>>;
}

const SYMBOL_LIST_SERVICE = 'SymbolListService';
const SYMBOL_LIST_REPOSITORY_BACKEND_SERVICE = 'SymbolListRepositoryBackend';
export const MAX_WATCHLIST_LENGTH = 1000;
const SEPARATOR_PREFIX = '###';
// When the lists of the fixture were last changed, in milliseconds.
const FIXTURE_TIMESTAMP = Date.UTC(2026, 0, 1);

const COLOR_TITLES: Readonly<Record<string, string>> = {
  red: 'Red list',
  blue: 'Blue list',
  green: 'Green list',
  orange: 'Orange list',
  purple: 'Purple list',
  cyan: 'Cyan list',
  pink: 'Pink list',
};

function isHotListId(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith('###HOT###');
}

function isListColor(id: unknown): boolean {
  return typeof id === 'string' && Object.hasOwn(COLOR_TITLES, id);
}

function customRecord(list: FakeServerList, timestamp: number | null): FakeCustomListRecord {
  return {
    id: list.id,
    name: list.name,
    description: null,
    symbols: [...list.symbols],
    shared: false,
    timestamp,
    collapsedSeparators: {},
    persistedState: { id: list.id, type: 'custom', name: list.name, symbols: [...list.symbols] },
    lastChangeTimestamp: FIXTURE_TIMESTAMP,
  };
}

// makeCustomListFromRecord of the app.
function customListOf(record: FakeCustomListRecord): Record<string, unknown> {
  return {
    type: 'custom',
    id: record.id,
    name: record.name,
    description: record.description,
    symbols: record.symbols,
    shared: record.shared,
    persistedState: record.persistedState,
  };
}

// makeMarkedListFromRecord of the app.
function markedListOf(record: FakeMarkedListRecord): Record<string, unknown> {
  return {
    type: 'colored',
    id: record.color,
    color: record.color,
    symbols: record.symbols,
    name: record.name ?? COLOR_TITLES[record.color],
    description: record.description,
    shared: record.shared,
    persistedState: record.persistedState,
  };
}

function initialStore(
  fixture: FixtureWatchlists | undefined,
  signedIn: boolean,
): FakeSymbolListState {
  const lists = fixture?.lists ?? [];
  const active = fixture?.active ?? null;
  const ready = fixture?.ready === true;
  // At boot the app puts the active list alone in the store, without the timestamp of a full load.
  const shown = ready
    ? lists
    : lists.filter((list) => active?.type === 'custom' && list.id === active.id);
  const byId: Record<string, FakeCustomListRecord> = {};
  for (const list of shown) {
    byId[String(list.id)] = customRecord(list, ready ? FIXTURE_TIMESTAMP : null);
  }
  const byColor: Record<string, FakeMarkedListRecord> = {};
  const bySymbol: Record<string, string> = {};
  const colors: string[] = [];
  for (const flag of fixture?.flags ?? []) {
    byColor[flag.color] = {
      color: flag.color,
      name: flag.name ?? null,
      description: null,
      shared: false,
      symbols: [...flag.symbols],
      persistedState: { color: flag.color, symbols: [...flag.symbols] },
    };
    for (const symbol of flag.symbols) {
      if (!symbol.startsWith(SEPARATOR_PREFIX)) {
        bySymbol[symbol] = flag.color;
      }
    }
    if (flag.symbols.length > 0) {
      colors.push(flag.color);
    }
  }
  const hot: Record<string, FakeHotList> = {};
  for (const list of fixture?.hot ?? []) {
    hot[list.id] = { ...list, type: 'hot', symbols: [...list.symbols] };
  }
  return {
    customLists: {
      lists: { ids: shown.map(({ id }) => id), byId },
      timestamp: ready ? FIXTURE_TIMESTAMP : null,
    },
    markedLists: {
      lists: { colors, byColor, bySymbol },
      commands: [],
      timestamp: FIXTURE_TIMESTAMP,
    },
    hotLists: { lists: hot },
    activeSymbolList: active === null ? null : { ...active },
    widgets: {},
    positions: {},
    isAuthenticated: signedIn,
    collapsedSeparators: {},
  };
}

// What the backend rejects with: an Error named after the code of the server, as handleJSON of the
// app makes it, or the TypeError of a request that failed on the way.
function refusal(code: string | null, message: string): Error {
  if (code === null) {
    return new TypeError(message);
  }
  const error = new Error(message);
  error.name = `ApiError:${code}`;
  return error;
}

function isSymbolArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function createFakeWatchlists(
  fixture: FixtureWatchlists | undefined,
  deps: FakeWatchlistsDeps,
): FakeWatchlists {
  const options = deps.options ?? {};
  const { state } = deps;
  state.server = (fixture?.lists ?? []).map((list) => ({ ...list, symbols: [...list.symbols] }));
  state.store = initialStore(fixture, deps.signedIn());
  state.errors = {};
  state.serverLimit = null;
  state.pendingOpenSeparators = new Set();

  // Runs a call of the backend the way the app does: on a later tick, refused when a test staged an
  // error for the method.
  const answer = <T>(method: FakeWatchlistsMethod, act: () => T): Promise<T> =>
    Promise.resolve().then(() => {
      const staged = state.errors[method];
      if (staged !== undefined) {
        throw refusal(staged.code, staged.message);
      }
      return act();
    });

  const serverList = (list: unknown): FakeServerList => {
    const id = (list as { id?: unknown } | null | undefined)?.id;
    const found = state.server.find((candidate) => candidate.id === id);
    if (found === undefined) {
      throw refusal('not_found', 'Not found');
    }
    return found;
  };

  // What the REST client of the app does while the list has open sections to save: it replaces the
  // list on the server with the symbols the store holds for it, and answers those.
  const replacedWithStore = (list: FakeServerList): string[] | null => {
    if (!state.pendingOpenSeparators.has(String(list.id))) {
      return null;
    }
    const local = state.store.customLists.lists.byId[String(list.id)]?.symbols ?? [];
    list.symbols = [...local];
    state.pendingOpenSeparators.delete(String(list.id));
    return [...local];
  };

  const recordedOnly =
    (name: string) =>
    (...args: unknown[]): Promise<undefined> => {
      deps.record(`symbolListBackend.${name}`, args);
      return Promise.resolve(undefined);
    };

  const backend = {
    getCustomWatchLists(): Promise<Record<string, JsonValue>[]> {
      deps.record('symbolListBackend.getCustomWatchLists', []);
      return answer('getCustomWatchLists', () =>
        state.server.map((list) => ({
          type: 'custom',
          id: list.id,
          name: list.name,
          description: null,
          active: false,
          symbols: [...list.symbols],
          shared: false,
          collapsedSeparators: [],
          persistedState: { id: list.id, type: 'custom', name: list.name },
        })),
      );
    },
    addSymbols(list: unknown, symbols: unknown): Promise<string[]> {
      deps.record('symbolListBackend.addSymbols', [list, symbols]);
      return answer('addSymbols', () => {
        const target = serverList(list);
        const replaced = replacedWithStore(target);
        if (replaced !== null) {
          return replaced;
        }
        if (!isSymbolArray(symbols)) {
          throw refusal('invalid_request', 'Invalid request');
        }
        const next = [...target.symbols];
        for (const symbol of symbols) {
          if (!next.includes(symbol)) {
            next.push(symbol);
          }
        }
        if (state.serverLimit !== null && next.length > state.serverLimit) {
          throw refusal(
            'plan_symbols_limit_reached',
            `A watchlist can hold up to ${String(state.serverLimit)} symbols on the plan of the account`,
          );
        }
        target.symbols = next;
        return [...next];
      });
    },
    removeSymbols(list: unknown, symbols: unknown): Promise<string[]> {
      deps.record('symbolListBackend.removeSymbols', [list, symbols]);
      return answer('removeSymbols', () => {
        const target = serverList(list);
        const replaced = replacedWithStore(target);
        if (replaced !== null) {
          return replaced;
        }
        if (!isSymbolArray(symbols)) {
          throw refusal('invalid_request', 'Invalid request');
        }
        const doomed = new Set(symbols);
        target.symbols = target.symbols.filter((symbol) => !doomed.has(symbol));
        return [...target.symbols];
      });
    },
    replaceSymbols: recordedOnly('replaceSymbols'),
    getAllWatchLists: recordedOnly('getAllWatchLists'),
    getCustomWatchlist: recordedOnly('getCustomWatchlist'),
    getActive: recordedOnly('getActive'),
    setActive: recordedOnly('setActive'),
    createWatchList: recordedOnly('createWatchList'),
    putWatchList: recordedOnly('putWatchList'),
    removeWatchList: recordedOnly('removeWatchList'),
    renameWatchList: recordedOnly('renameWatchList'),
  };

  type Thunk = (dispatch: (action: unknown) => unknown, getState: () => unknown) => unknown;
  const getState = (): FakeSymbolListState => state.store;
  const dispatch = (action: unknown): unknown => {
    if (typeof action === 'function') {
      return (action as Thunk)(dispatch, getState);
    }
    const { type, payload } = (action ?? {}) as { type?: unknown; payload?: unknown };
    deps.record('symbolListStore.dispatch', [type]);
    if (type === 'custom-lists/setup') {
      const { lists, timestamp } = payload as {
        lists: FakeCustomListRecord[];
        timestamp: number;
      };
      const byId: Record<string, FakeCustomListRecord> = {};
      for (const list of lists) {
        byId[String(list.id)] = { ...list, symbols: [...list.symbols] };
      }
      state.store = {
        ...state.store,
        customLists: { lists: { ids: lists.map(({ id }) => id), byId }, timestamp },
      };
    }
    return action;
  };
  const store = { getState, dispatch, subscribe: () => () => undefined };

  // The call of getCustomWatchlistsThunk that is still running, which the next call aborts.
  let latest: { aborted: boolean } | null = null;
  const getCustomWatchlistsThunk = (signal: unknown): Thunk => {
    deps.record('getCustomWatchlistsThunk', [signal]);
    if (latest !== null) {
      latest.aborted = true;
    }
    const call = { aborted: false };
    latest = call;
    return async (dispatchAction) => {
      try {
        const lists = await backend.getCustomWatchLists();
        if (call.aborted) {
          return;
        }
        const timestamp = Date.now();
        dispatchAction({
          type: 'custom-lists/setup',
          payload: {
            lists: lists.map((list) =>
              customRecord(
                {
                  id: list.id as number | string,
                  name: list.name as string,
                  symbols: list.symbols as string[],
                },
                timestamp,
              ),
            ),
            timestamp,
          },
        });
      } catch (error) {
        if (!call.aborted) {
          throw error;
        }
      }
    };
  };

  const selectors = {
    getCustomListsState: (s: FakeSymbolListState) => s.customLists,
    getCustomLists: (s: FakeSymbolListState) =>
      s.customLists.lists.ids.map((id) => {
        const record = s.customLists.lists.byId[String(id)];
        if (record === undefined) {
          throw new Error('Value is null');
        }
        return customListOf(record);
      }),
    getCustomListById: (s: FakeSymbolListState, id: unknown) => {
      // The app reads byId[id] ?? null, as here.
      const record = (s.customLists.lists.byId as Record<string, unknown>)[String(id)] as
        FakeCustomListRecord | undefined;
      return record === undefined ? null : customListOf(record);
    },
    getGlobalActiveID: (s: FakeSymbolListState) => s.activeSymbolList?.id ?? null,
    getGlobalActiveSymbolList: (s: FakeSymbolListState) => {
      const id = s.activeSymbolList?.id ?? null;
      if (id === null) {
        return null;
      }
      if (isListColor(id)) {
        const record = s.markedLists.lists.byColor[id as string];
        return record === undefined ? null : markedListOf(record);
      }
      if (isHotListId(id)) {
        const list = s.hotLists.lists[id as string];
        return list === undefined
          ? null
          : {
              id: list.id,
              name: list.name,
              type: list.type,
              group: list.group,
              exchange: list.exchange,
              symbols: list.symbols,
            };
      }
      const record = s.customLists.lists.byId[String(id)];
      return record === undefined ? null : customListOf(record);
    },
    getIsReadyCustomLists: (s: FakeSymbolListState) => s.customLists.timestamp !== null,
  };

  // Functions that only record a call, by a prefix and their export name.
  const untouchable = (prefix: string, names: readonly string[]): Record<string, unknown> =>
    Object.fromEntries(
      names.map((name) => [
        name,
        function recorded(...args: unknown[]): undefined {
          deps.record(prefix === '' ? name : `${prefix}.${name}`, args);
          return undefined;
        },
      ]),
    );

  const service = {
    store,
    runner: {},
    task: {},
    actions: untouchable('symbolListService.actions', [
      'addSymbols',
      'initWidget',
      'saveListAs',
      'createNewWatchList',
    ]),
  };
  if (options.withoutService !== true) {
    deps.provideService(SYMBOL_LIST_SERVICE, service);
  }
  if (options.withoutBackend !== true) {
    deps.provideService(SYMBOL_LIST_REPOSITORY_BACKEND_SERVICE, backend);
  }

  const modules: Record<string, Record<string, unknown>> = {
    // Module IDs are arbitrary numbers, as in a production build.
    '90990': { SYMBOL_LIST_SERVICE },
    '94393': { SYMBOL_LIST_REPOSITORY_BACKEND_SERVICE },
    // The set of the state, so that a test can stage an id in it.
    '44462': {
      get pendingOpenSeparators() {
        return state.pendingOpenSeparators;
      },
    },
    '91605': { getColoredListTitle: (color: unknown) => COLOR_TITLES[String(color)] },
    '85747': {
      ...untouchable('watchlistThunks', [
        'addWatchlistSymbolsThunk',
        'removeWatchlistSymbolsThunk',
        'replaceWatchlistSymbolsThunk',
        'getActiveWatchlistThunk',
        'setActiveWatchlistThunk',
        'createWatchlistThunk',
        'validateWatchListSymbols',
      ]),
      ...(options.withoutRefreshThunk === true ? {} : { getCustomWatchlistsThunk }),
    },
    '88032': untouchable('watchlistWidget', [
      'addSymbolsThunk',
      'addSymbolsToCustomListThunk',
      'addSymbolsToListThunk',
      'removeSymbolsThunk',
      'removeSelectedSymbolsThunk',
      'enforceListAccessThunk',
    ]),
    '45675': untouchable('', ['initSymbolListService']),
  };
  if (options.withoutSelectors !== true) {
    modules['17580'] = selectors;
  }
  if (options.withoutLimits !== true) {
    modules['21917'] = {
      MAX_WATCHLIST_LENGTH,
      getWatchlistSymbolsLimit: () =>
        deps.isFeatureEnabled('watchlist_symbols_tiered_limits')
          ? (deps.planLimit ?? MAX_WATCHLIST_LENGTH)
          : MAX_WATCHLIST_LENGTH,
      showMaxLimitError(...args: unknown[]) {
        deps.record('dialog.watchlistMaxLimit', args);
      },
    };
  }
  return { modules };
}
