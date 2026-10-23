import type { PageErrorSentinel } from '../../core/tv/page-bridge.js';
import type { PageLib } from '../../core/tv/page-lib.js';
import type {
  ServiceLocatorLike,
  SymbolListBackendLike,
  SymbolListSelectorsLike,
  SymbolListServiceLike,
  SymbolListStoreLike,
  TvWindow,
  WatchlistLimitsLike,
} from '../../core/tv/tv-window.js';

// The page functions of the watchlist tools (reverse-engineering notes of Plan 3, section 3). The page
// bridge sends the source text of each one into the page, so each uses nothing of this file, only its
// parameters and the globals of the page, and whatever it shares with another is written out in
// each. Types are erased, so the type imports above are fine.
//
// The watchlists live in the Redux store of the symbol list service of the app, which the app
// registers with its service locator when the chart page boots: serviceOrNull(SYMBOL_LIST_SERVICE),
// with the locator and the descriptor found by the names of their exports. While it is missing, the
// functions answer NOT_AVAILABLE with the hint to open the watchlist, which sets it up; they never
// create it (initSymbolListService). The lists are read with the selectors of the app. At boot the
// store holds the active list alone, until the watchlist panel loads every list: a function that
// finds the store not ready loads them once with the refresh thunk of the app
// (getCustomWatchlistsThunk(null), dispatched to the store), which sends the request the panel sends,
// and then reads again.
//
// Changes go through the backend service of the app (serviceOrNull(
// SYMBOL_LIST_REPOSITORY_BACKEND_SERVICE)), whose addSymbols and removeSymbols send the append and
// remove requests of the app and open nothing. They leave the store alone, so the caller refreshes it
// afterwards. The thunks of the app that wrap them are never used: they open warning, paywall and
// confirmation dialogs. A refusal of the server comes back as { refused: { code, message } }, for the
// server to map.

export type WatchlistKind = 'custom' | 'flag' | 'hot';

// A watchlist as the page reads it: its id as text (a number for a custom list saved on the account,
// a color for a flag list, ###HOT### and more for a hot list of an exchange), its kind, its name
// (null when it has none), its entries (symbols and section markers, in order), whether it is the
// active list and whether the watchlist tools edit it: only a custom list saved on the account, whose
// id is a number. A type alias, not an interface: it comes back from the page as JSON, which a type
// must satisfy JsonValue for.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type WatchlistRecord = {
  id: string;
  kind: WatchlistKind;
  name: string | null;
  entries: string[];
  active: boolean;
  editable: boolean;
};

// A watchlist as readWatchlists lists it: its entries counted, section markers left out.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type WatchlistSummary = {
  id: string;
  kind: WatchlistKind;
  name: string | null;
  symbolCount: number;
  active: boolean;
  editable: boolean;
};

// Why the watchlist server refused a change: the code of its ApiError, null without one (a request
// that failed on the way), and its message.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type WatchlistRefusal = { code: string | null; message: string };

// Every watchlist of the account: the custom lists, the flag lists and the hot lists the app has
// loaded, each as a WatchlistSummary. ready says whether the store holds every custom list: when it
// does not, the lists are loaded first, and when that fails or takes more than waitMs, ready is false
// and the custom lists are the ones the store holds. NOT_AVAILABLE while the symbol list service is
// not set up, on a build without its selectors, and when a selector fails.
export function readWatchlists(
  _win: TvWindow,
  lib: PageLib,
  waitMs: number,
): Promise<{ ready: boolean; lists: WatchlistSummary[] } | PageErrorSentinel> | PageErrorSentinel {
  const locator = lib.findModuleWith(['hasService', 'service', 'serviceOrNull']);
  const descriptor = lib.findExport('SYMBOL_LIST_SERVICE');
  const selectors = lib.findModuleWith([
    'getCustomLists',
    'getCustomListById',
    'getGlobalActiveSymbolList',
    'getIsReadyCustomLists',
  ]);
  const refreshThunk = lib.findExport('getCustomWatchlistsThunk');
  const titleOf = lib.findExport('getColoredListTitle');
  const setUpHint =
    "Open the watchlist with ui_open_panel (panel: 'watchlist'), which sets the watchlists up, " +
    'then try again.';
  let store: Partial<SymbolListStoreLike> | null | undefined;
  try {
    const services = locator as Partial<ServiceLocatorLike> | null;
    const service =
      typeof services?.serviceOrNull === 'function' && descriptor !== null
        ? (services.serviceOrNull(descriptor) as SymbolListServiceLike | null | undefined)
        : null;
    store = service?.store;
  } catch {
    store = null;
  }
  if (typeof store?.getState !== 'function' || typeof store.dispatch !== 'function') {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: 'TradingView has not set up its watchlists in this tab yet',
        hint: setUpHint,
      },
    };
  }
  if (selectors === null) {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message:
          'This TradingView build does not have the selectors of its watchlists that the ' +
          'watchlist tools read',
        hint: 'Use the watchlist in TradingView itself.',
      },
    };
  }
  const live = store as SymbolListStoreLike;
  const read = selectors as unknown as SymbolListSelectorsLike;
  const reasonOf = (error: unknown): string => {
    const message: unknown = (error as { message?: unknown } | null | undefined)?.message;
    return typeof error === 'string'
      ? error
      : typeof message === 'string'
        ? message
        : String(error);
  };
  const isReady = (): boolean => {
    try {
      return read.getIsReadyCustomLists(live.getState()) === true;
    } catch {
      return false;
    }
  };
  // Whether the refresh thunk loaded every custom list within waitMs.
  const reload = (): Promise<boolean> => {
    let loading: Promise<boolean>;
    try {
      loading =
        typeof refreshThunk === 'function'
          ? Promise.resolve(live.dispatch((refreshThunk as (signal: null) => unknown)(null))).then(
              () => true,
              () => false,
            )
          : Promise.resolve(false);
    } catch {
      loading = Promise.resolve(false);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        resolve(false);
      }, waitMs);
    });
    return Promise.race([loading, late]).then((done) => {
      clearTimeout(timer);
      return done;
    });
  };

  return (isReady() ? Promise.resolve(true) : reload()).then(
    (): { ready: boolean; lists: WatchlistSummary[] } | PageErrorSentinel => {
      try {
        const state = live.getState() as {
          activeSymbolList?: unknown;
          markedLists?: { lists?: { byColor?: unknown } };
          hotLists?: { lists?: unknown };
        } | null;
        const active = state?.activeSymbolList as
          { type?: unknown; id?: unknown } | null | undefined;
        const text = (value: unknown): string | null =>
          typeof value === 'string' && value !== '' ? value : null;
        const entriesOf = (value: unknown): string[] =>
          Array.isArray(value)
            ? (value as unknown[]).filter((entry): entry is string => typeof entry === 'string')
            : [];
        const countOf = (entries: string[]): number =>
          entries.filter((entry) => !entry.startsWith('###')).length;
        const lists: WatchlistSummary[] = [];
        const customs = read.getCustomLists(state);
        for (const item of Array.isArray(customs) ? (customs as unknown[]) : []) {
          const list = (typeof item === 'object' && item !== null ? item : {}) as {
            id?: unknown;
            name?: unknown;
            symbols?: unknown;
          };
          const { id } = list;
          if (typeof id !== 'number' && typeof id !== 'string') {
            continue;
          }
          const entries = entriesOf(list.symbols);
          lists.push({
            id: String(id),
            kind: 'custom',
            name: text(list.name),
            symbolCount: countOf(entries),
            active: active?.type === 'custom' && String(active.id) === String(id),
            editable: typeof id === 'number' && Number.isSafeInteger(id) && id > 0,
          });
        }
        const marked = state?.markedLists?.lists?.byColor;
        for (const [color, record] of Object.entries(
          typeof marked === 'object' && marked !== null ? marked : {},
        )) {
          if (typeof record !== 'object' || record === null) {
            continue;
          }
          const { name, symbols } = record as { name?: unknown; symbols?: unknown };
          let title: unknown = null;
          try {
            title =
              typeof titleOf === 'function' ? (titleOf as (key: string) => unknown)(color) : null;
          } catch {
            title = null;
          }
          const entries = entriesOf(symbols);
          lists.push({
            id: color,
            kind: 'flag',
            name: text(name) ?? text(title),
            symbolCount: countOf(entries),
            active: active?.type === 'color' && active.id === color,
            editable: false,
          });
        }
        const hot = state?.hotLists?.lists;
        for (const [id, item] of Object.entries(
          typeof hot === 'object' && hot !== null ? hot : {},
        )) {
          if (typeof item !== 'object' || item === null) {
            continue;
          }
          const { name, symbols } = item as { name?: unknown; symbols?: unknown };
          const entries = entriesOf(symbols);
          lists.push({
            id,
            kind: 'hot',
            name: text(name),
            symbolCount: countOf(entries),
            active: active?.type === 'hot' && active.id === id,
            editable: false,
          });
        }
        return { ready: isReady(), lists };
      } catch (error) {
        return {
          __tvmcpError: {
            code: 'NOT_AVAILABLE',
            message: `TradingView could not read its watchlists: ${reasonOf(error)}`,
            hint: setUpHint,
          },
        };
      }
    },
  );
}

// One watchlist as a WatchlistRecord: the active list when listId is null (getGlobalActiveSymbolList
// of the app, whatever its kind), else the custom list, flag list or hot list whose id listId is. A
// list the store does not hold is null. The store is refreshed first when refresh is true, or when it
// does not hold every custom list; refreshed says whether that loaded the lists, which a refresh the
// app aborts does not, null when no refresh was needed. ready says whether the store holds every
// custom list, and signedIn whether an account is signed in. NOT_AVAILABLE as for readWatchlists.
export function readWatchlist(
  win: TvWindow,
  lib: PageLib,
  listId: string | null,
  waitMs: number,
  refresh: boolean,
):
  | Promise<
      | {
          ready: boolean;
          refreshed: boolean | null;
          signedIn: boolean;
          list: WatchlistRecord | null;
        }
      | PageErrorSentinel
    >
  | PageErrorSentinel {
  const locator = lib.findModuleWith(['hasService', 'service', 'serviceOrNull']);
  const descriptor = lib.findExport('SYMBOL_LIST_SERVICE');
  const selectors = lib.findModuleWith([
    'getCustomLists',
    'getCustomListById',
    'getGlobalActiveSymbolList',
    'getIsReadyCustomLists',
  ]);
  const refreshThunk = lib.findExport('getCustomWatchlistsThunk');
  const titleOf = lib.findExport('getColoredListTitle');
  const setUpHint =
    "Open the watchlist with ui_open_panel (panel: 'watchlist'), which sets the watchlists up, " +
    'then try again.';
  let store: Partial<SymbolListStoreLike> | null | undefined;
  try {
    const services = locator as Partial<ServiceLocatorLike> | null;
    const service =
      typeof services?.serviceOrNull === 'function' && descriptor !== null
        ? (services.serviceOrNull(descriptor) as SymbolListServiceLike | null | undefined)
        : null;
    store = service?.store;
  } catch {
    store = null;
  }
  if (typeof store?.getState !== 'function' || typeof store.dispatch !== 'function') {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: 'TradingView has not set up its watchlists in this tab yet',
        hint: setUpHint,
      },
    };
  }
  if (selectors === null) {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message:
          'This TradingView build does not have the selectors of its watchlists that the ' +
          'watchlist tools read',
        hint: 'Use the watchlist in TradingView itself.',
      },
    };
  }
  const live = store as SymbolListStoreLike;
  const read = selectors as unknown as SymbolListSelectorsLike;
  const signedIn = win.is_authenticated === true;
  const reasonOf = (error: unknown): string => {
    const message: unknown = (error as { message?: unknown } | null | undefined)?.message;
    return typeof error === 'string'
      ? error
      : typeof message === 'string'
        ? message
        : String(error);
  };
  const isReady = (): boolean => {
    try {
      return read.getIsReadyCustomLists(live.getState()) === true;
    } catch {
      return false;
    }
  };
  // When the custom lists were last loaded into the store: customLists.timestamp of the app, which
  // the refresh thunk sets when it loads them.
  const loadedAt = (): unknown => {
    try {
      const state = live.getState() as { customLists?: { timestamp?: unknown } } | null;
      return state?.customLists?.timestamp;
    } catch {
      return undefined;
    }
  };
  // Whether the refresh thunk loaded every custom list within waitMs. A refresh the app starts
  // meanwhile aborts it, and the thunk then resolves without loading anything (respectLatest and
  // skipAbortError of the app), so it counts only once the time of the last load has changed.
  const reload = (): Promise<boolean> => {
    const before = loadedAt();
    let loading: Promise<boolean>;
    try {
      loading =
        typeof refreshThunk === 'function'
          ? Promise.resolve(live.dispatch((refreshThunk as (signal: null) => unknown)(null))).then(
              () => true,
              () => false,
            )
          : Promise.resolve(false);
    } catch {
      loading = Promise.resolve(false);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        resolve(false);
      }, waitMs);
    });
    return Promise.race([loading, late]).then((done) => {
      clearTimeout(timer);
      return done && loadedAt() !== before;
    });
  };

  return (refresh || !isReady() ? reload() : Promise.resolve(null)).then(
    (
      refreshed,
    ):
      | {
          ready: boolean;
          refreshed: boolean | null;
          signedIn: boolean;
          list: WatchlistRecord | null;
        }
      | PageErrorSentinel => {
      try {
        const state = live.getState() as {
          activeSymbolList?: unknown;
          markedLists?: { lists?: { byColor?: unknown } };
          hotLists?: { lists?: unknown };
        } | null;
        const active = state?.activeSymbolList as
          { type?: unknown; id?: unknown } | null | undefined;
        const text = (value: unknown): string | null =>
          typeof value === 'string' && value !== '' ? value : null;
        const entriesOf = (value: unknown): string[] =>
          Array.isArray(value)
            ? (value as unknown[]).filter((entry): entry is string => typeof entry === 'string')
            : [];
        const objectOr = (value: unknown): Record<string, unknown> | null =>
          typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
        // The record of a list of `kind` with the id, name and entries the app gives.
        const recordOf = (
          kind: WatchlistKind,
          id: number | string,
          name: string | null,
          symbols: unknown,
        ): WatchlistRecord => ({
          id: String(id),
          kind,
          name,
          entries: entriesOf(symbols),
          active:
            kind === 'custom'
              ? active?.type === 'custom' && String(active.id) === String(id)
              : active?.type === (kind === 'flag' ? 'color' : 'hot') && active.id === id,
          editable:
            kind === 'custom' && typeof id === 'number' && Number.isSafeInteger(id) && id > 0,
        });
        // A custom list the app answers, when it has an id the tools can name.
        const customOf = (found: unknown): WatchlistRecord | null => {
          const list = objectOr(found);
          const id = list?.id;
          return list !== null && (typeof id === 'number' || typeof id === 'string')
            ? recordOf('custom', id, text(list.name), list.symbols)
            : null;
        };
        let list: WatchlistRecord | null = null;
        if (listId === null) {
          const found = objectOr(read.getGlobalActiveSymbolList(state));
          const id = found?.id;
          if (found !== null && (typeof id === 'number' || typeof id === 'string')) {
            if (found.type === 'custom') {
              list = recordOf('custom', id, text(found.name), found.symbols);
            } else if (found.type === 'colored') {
              list = recordOf('flag', id, text(found.name), found.symbols);
            } else if (found.type === 'hot') {
              list = recordOf('hot', id, text(found.name), found.symbols);
            }
          }
        } else if (/^\d+$/.test(listId)) {
          list = customOf(read.getCustomListById(state, Number(listId)));
        } else {
          const customs = read.getCustomLists(state);
          const custom = (Array.isArray(customs) ? (customs as unknown[]) : []).find(
            (item) => objectOr(item)?.id === listId,
          );
          const marked = objectOr(state?.markedLists?.lists?.byColor);
          const hot = objectOr(state?.hotLists?.lists);
          if (custom !== undefined) {
            list = customOf(custom);
          } else if (marked !== null && Object.hasOwn(marked, listId)) {
            const record = objectOr(marked[listId]);
            if (record !== null) {
              let title: unknown = null;
              try {
                title =
                  typeof titleOf === 'function'
                    ? (titleOf as (key: string) => unknown)(listId)
                    : null;
              } catch {
                title = null;
              }
              list = recordOf('flag', listId, text(record.name) ?? text(title), record.symbols);
            }
          } else if (hot !== null && Object.hasOwn(hot, listId)) {
            const item = objectOr(hot[listId]);
            list = item === null ? null : recordOf('hot', listId, text(item.name), item.symbols);
          }
        }
        return { ready: isReady(), refreshed, signedIn, list };
      } catch (error) {
        return {
          __tvmcpError: {
            code: 'NOT_AVAILABLE',
            message: `TradingView could not read its watchlists: ${reasonOf(error)}`,
            hint: setUpHint,
          },
        };
      }
    },
  );
}

// The limits the app checks before it adds symbols to a watchlist itself (notes of Plan 3, section
// 3.6): getWatchlistSymbolsLimit(), beyond which it opens the paywall, and MAX_WATCHLIST_LENGTH,
// beyond which it shows a warning, both counting every entry of the list, section markers included.
// What cannot be read, or is no positive number, is null. It changes nothing.
export function readWatchlistLimits(
  _win: TvWindow,
  lib: PageLib,
): { limit: number | null; max: number | null } {
  const limits = lib.findModuleWith([
    'getWatchlistSymbolsLimit',
    'MAX_WATCHLIST_LENGTH',
  ]) as Partial<WatchlistLimitsLike> | null;
  const positive = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  let limit: unknown;
  try {
    limit =
      typeof limits?.getWatchlistSymbolsLimit === 'function'
        ? limits.getWatchlistSymbolsLimit()
        : null;
  } catch {
    limit = null;
  }
  return { limit: positive(limit), max: positive(limits?.MAX_WATCHLIST_LENGTH) };
}

// Adds symbols to the custom list listId, or removes them from it (change), with addSymbols or
// removeSymbols of the backend of the app: the append or remove request the app sends, which opens
// nothing and leaves the store alone. Answers that the server took the change, with the entries of
// the list it answered (null when it answered no list of them). Before anything is sent, a page
// without the backend is NOT_AVAILABLE, a signed-out app (which edits a local list instead)
// AUTH_REQUIRED, and a list whose open sections the app still has to save NOT_AVAILABLE: the app
// would replace the list with the entries of the store then, and leave the change out. An answer
// that does not come within waitMs is TIMEOUT.
export function changeWatchlistViaApi(
  win: TvWindow,
  lib: PageLib,
  change: 'add' | 'remove',
  listId: number,
  symbols: string[],
  waitMs: number,
):
  | Promise<
      { sent: true; symbols: string[] | null } | { refused: WatchlistRefusal } | PageErrorSentinel
    >
  | PageErrorSentinel {
  const locator = lib.findModuleWith(['hasService', 'service', 'serviceOrNull']);
  const descriptor = lib.findExport('SYMBOL_LIST_REPOSITORY_BACKEND_SERVICE');
  const pending = lib.findExport('pendingOpenSeparators');
  let backend: Partial<SymbolListBackendLike> | null | undefined;
  try {
    const services = locator as Partial<ServiceLocatorLike> | null;
    backend =
      typeof services?.serviceOrNull === 'function' && descriptor !== null
        ? (services.serviceOrNull(descriptor) as Partial<SymbolListBackendLike> | null | undefined)
        : null;
  } catch {
    backend = null;
  }
  const method = change === 'add' ? 'addSymbols' : 'removeSymbols';
  if (typeof backend?.[method] !== 'function') {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: 'TradingView has not set up its watchlists in this tab yet',
        hint:
          "Open the watchlist with ui_open_panel (panel: 'watchlist'), which sets the watchlists " +
          'up, then try again.',
      },
    };
  }
  if (win.is_authenticated !== true) {
    return {
      __tvmcpError: {
        code: 'AUTH_REQUIRED',
        message: 'Editing a watchlist needs a signed-in TradingView account',
        hint: 'Sign in to TradingView, then try again.',
      },
    };
  }
  let held: boolean;
  try {
    held =
      typeof (pending as { has?: unknown } | null)?.has === 'function' &&
      (pending as { has(key: string): unknown }).has(String(listId)) === true;
  } catch {
    held = false;
  }
  if (held) {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: `TradingView is still saving the sections of the watchlist ${String(listId)}, so nothing was changed`,
        hint: 'Try again in a moment.',
      },
    };
  }
  const api = backend as SymbolListBackendLike;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ late: true }>((resolve) => {
    timer = setTimeout(() => {
      resolve({ late: true });
    }, waitMs);
  });
  let ended: Promise<{ value: unknown } | { error: unknown }>;
  try {
    ended = Promise.resolve(api[method]({ id: listId }, symbols)).then(
      (value: unknown) => ({ value }),
      (error: unknown) => ({ error }),
    );
  } catch (error) {
    ended = Promise.resolve({ error });
  }
  return Promise.race([ended, late]).then(
    (
      outcome,
    ):
      | { sent: true; symbols: string[] | null }
      | { refused: WatchlistRefusal }
      | PageErrorSentinel => {
      clearTimeout(timer);
      if ('late' in outcome) {
        return {
          __tvmcpError: {
            code: 'TIMEOUT',
            message: `TradingView did not answer the change of the watchlist within ${String(waitMs)} ms`,
            hint:
              change === 'add'
                ? 'The symbols may be added all the same: check watchlist_get. This session could ' +
                  'not record them, so removing them needs confirm: true.'
                : 'Some of the symbols may be gone all the same: check watchlist_get.',
            details: { waitMs },
          },
        };
      }
      if ('error' in outcome) {
        const { error } = outcome;
        const { name, message } = (typeof error === 'object' && error !== null ? error : {}) as {
          name?: unknown;
          message?: unknown;
        };
        const code =
          typeof name === 'string' && name.startsWith('ApiError:') && name.length > 9
            ? name.slice(9)
            : null;
        return {
          refused: {
            code,
            message:
              typeof message === 'string'
                ? message
                : typeof error === 'string'
                  ? error
                  : String(error),
          },
        };
      }
      const { value } = outcome;
      return {
        sent: true,
        symbols:
          Array.isArray(value) && (value as unknown[]).every((entry) => typeof entry === 'string')
            ? (value as string[])
            : null,
      };
    },
  );
}
