import { z } from 'zod';
import type { PageHandle } from '../../core/connection.js';
import { isTvMcpError } from '../../core/errors.js';
import { inPlanLimitedTurn } from '../../core/tv/plan-limits.js';
import { CHANGES_IDEMPOTENT, DESTRUCTIVE_IDEMPOTENT, READ_ONLY } from '../annotations.js';
import { pageWaitMs } from '../chart/strategies.js';
import { mapSearchResult } from '../data/mappers.js';
import { searchSymbolsViaApi } from '../data/page.js';
import { defineTool, type AnyToolDefinition, type ToolContext } from '../types.js';
import {
  blankSymbolsError,
  confirmationError,
  listedEntry,
  noActiveListError,
  notAddedWarning,
  notChangedError,
  notEditableError,
  notLoadedError,
  notRemovedWarning,
  removalPlan,
  requireRoom,
  resolveAdditions,
  shortName,
  signedOutError,
  STALE_STORE_WARNING,
  symbolsToSearch,
  toListing,
  toWatchlistView,
  unconfirmedChangeError,
  unknownListError,
  unknownSymbolError,
  watchlistRefusalError,
  type PlannedAddition,
} from './mappers.js';
import {
  changeWatchlistViaApi,
  readWatchlist,
  readWatchlistLimits,
  readWatchlists,
  type WatchlistRecord,
  type WatchlistRefusal,
} from './page.js';

// The watchlist tools (design spec 7, domain Watchlist): the watchlists are the user's own data, in
// the store of the symbol list service of the app, which the tools read with the selectors of the
// app and change with the append and remove requests of its backend, refreshing the store afterwards
// (reverse-engineering notes of Plan 3, section 3). Nothing opens a dialog: the thunks of the app
// that wrap those requests, which open warning, paywall and confirmation dialogs, are never used, and
// the service is never created.
//
// An addition checks every symbol with the symbol search of TradingView first, skips the symbols the
// list holds already, by their full or short name as the app does, and adds each at most once. It
// checks first, in a turn of the plan-limited actions, the limits the app itself checks before it
// adds to a watchlist (WATCHLIST_SYMBOLS, design spec 5.3, rule 3), and relays a limit the server
// reports as PLAN_LIMIT unchanged. Removing a symbol this session did not add needs confirm: true
// (rule 2), and a section marker is never removed. Only custom lists saved on the account are edited.
// The names and symbols of the user's watchlists are returned to the client and never logged.

const MAX_SYMBOLS = 100;
const MAX_SYMBOL_LENGTH = 200;
const MAX_LIST_ID_LENGTH = 200;
// How many symbol searches an addition runs at once.
const SEARCHES_AT_ONCE = 4;

// An addition changes the list without destroying anything, and adding again adds nothing more
// (CHANGES_IDEMPOTENT); a removal destroys an entry of the user's list, and removing again removes
// nothing more (DESTRUCTIVE_IDEMPOTENT).

const LIMIT_TEXT =
  'The size of a watchlist is limited, and every entry counts, section markers included: when ' +
  'the symbols do not fit, the call fails with PLAN_LIMIT (feature WATCHLIST_SYMBOLS) before ' +
  'anything is added, and a limit the watchlist server reports is relayed as PLAN_LIMIT ' +
  'unchanged. The limit checked is the one TradingView applies when it adds to a watchlist ' +
  'itself: while its tiered limits are off, that is its maximum of entries for any watchlist ' +
  '(1000 on this build), not the WATCHLIST_SYMBOLS limit app_get_plan_limits reports (30 on a ' +
  'free plan), which TradingView does not enforce then. A list that holds more than that maximum ' +
  'takes nothing (NOT_AVAILABLE).';

const LIST_ID = z
  .string()
  .min(1)
  .max(MAX_LIST_ID_LENGTH)
  .optional()
  .describe('The id of a watchlist from watchlist_list. Default: the active watchlist.');

const SYMBOL = z.string().min(1).max(MAX_SYMBOL_LENGTH);

// The list `listId` names, or the active list without it, as the store of the app holds it (loaded
// first when the store holds the active list alone). Fails with INVALID_INPUT for a list the account
// does not have, and with NOT_AVAILABLE when there is no active list or TradingView has not loaded the
// lists to tell.
async function readList(
  page: PageHandle,
  listId: string | undefined,
  waitMs: number,
): Promise<{ list: WatchlistRecord; signedIn: boolean }> {
  const read = await page.bridge.evaluateWithLib(readWatchlist, [listId ?? null, waitMs, false]);
  if (read.list !== null) {
    return { list: read.list, signedIn: read.signedIn };
  }
  if (listId === undefined) {
    throw noActiveListError();
  }
  throw read.ready ? unknownListError(listId) : notLoadedError();
}

// The list an edit works on, as readList finds it: an edit needs a signed-in account, and a custom
// list saved on the account.
async function editableList(
  page: PageHandle,
  listId: string | undefined,
  waitMs: number,
): Promise<WatchlistRecord> {
  const { list, signedIn } = await readList(page, listId, waitMs);
  if (!signedIn) {
    throw signedOutError();
  }
  if (!list.editable) {
    throw notEditableError(list, listId === undefined);
  }
  return list;
}

// The symbols given, trimmed. Fails with INVALID_INPUT for a blank one, before the app is asked
// anything.
function trimmedSymbols(symbols: readonly string[]): string[] {
  const trimmed = symbols.map((symbol) => symbol.trim());
  const blank = trimmed.flatMap((symbol, index) => (symbol === '' ? [index + 1] : []));
  if (blank.length > 0) {
    throw blankSymbolsError(blank);
  }
  return trimmed;
}

// Runs `task` for each of `items`, at most `limit` at a time.
async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const worker = async (): Promise<void> => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
}

// The symbol each of `symbols` stands for as the symbol search of TradingView names it, the way
// data_get_symbol_info finds a symbol: EXCHANGE:TICKER is the result of that name, and a ticker alone
// the first result of that ticker. Null for one the search does not find. By the symbol given, upper
// case. A ticker is searched for once, however many symbols name it.
async function findListings(
  page: PageHandle,
  symbols: readonly string[],
): Promise<Map<string, string | null>> {
  const byTicker = new Map<string, string[]>();
  for (const symbol of symbols) {
    const upper = symbol.toUpperCase();
    const ticker = shortName(upper);
    byTicker.set(ticker, [...(byTicker.get(ticker) ?? []), upper]);
  }
  const found = new Map<string, string | null>();
  await eachLimited([...byTicker], SEARCHES_AT_ONCE, async ([ticker, named]) => {
    const { items } = await page.bridge.evaluate(searchSymbolsViaApi, [ticker, null, null]);
    const results = items.map(mapSearchResult);
    for (const upper of named) {
      const match = results.find((result) =>
        upper.includes(':')
          ? result.symbol.toUpperCase() === upper
          : result.ticker.toUpperCase() === upper,
      );
      found.set(upper, match?.symbol ?? null);
    }
  });
  return found;
}

// Reloads the lists into the store of the app, as the watchlist panel does when it opens, and reads
// the list `listId` again. Not managing that is no failure of the change before it: refreshed is
// false then.
async function refreshList(
  page: PageHandle,
  listId: string,
  waitMs: number,
): Promise<{ refreshed: boolean; list: WatchlistRecord | null }> {
  try {
    const read = await page.bridge.evaluateWithLib(readWatchlist, [listId, waitMs, true]);
    return { refreshed: read.refreshed === true, list: read.list };
  } catch (error) {
    if (!isTvMcpError(error)) {
      throw error;
    }
    return { refreshed: false, list: null };
  }
}

// Sends a change of `list` to the watchlist server, then refreshes the store of the app whatever came
// of it, so that TradingView shows what the server holds. Answers the entries of the list after the
// change: as the refreshed store holds them, else as the server answered them, else null; and whether
// the store was refreshed. A refusal of the server fails with the error watchlistRefusalError makes
// of it.
async function changeList(
  page: PageHandle,
  change: 'add' | 'remove',
  list: WatchlistRecord,
  symbols: string[],
  waitMs: number,
): Promise<{ entries: string[] | null; refreshed: boolean }> {
  let sent: { sent: true; symbols: string[] | null } | { refused: WatchlistRefusal };
  try {
    sent = await page.bridge.evaluateWithLib(changeWatchlistViaApi, [
      change,
      Number(list.id),
      symbols,
      waitMs,
    ]);
  } catch (error) {
    // A change that did not answer in time may still land.
    if (isTvMcpError(error) && error.code === 'TIMEOUT') {
      await refreshList(page, list.id, waitMs);
    }
    throw error;
  }
  if ('refused' in sent) {
    await refreshList(page, list.id, waitMs);
    throw watchlistRefusalError(
      sent.refused,
      change === 'add'
        ? 'add the symbols to the watchlist'
        : 'remove the symbols from the watchlist',
    );
  }
  const after = await refreshList(page, list.id, waitMs);
  return after.refreshed && after.list !== null
    ? { entries: after.list.entries, refreshed: true }
    : { entries: sent.symbols, refreshed: false };
}

// An addition worked out: the list it adds to and the outcome of each symbol given.
interface PlannedChange {
  page: PageHandle;
  waitMs: number;
  list: WatchlistRecord;
  planned: PlannedAddition[];
}

// Works out what an addition of `given` to the list `listId` (the active list without it) does,
// before anything changes: the list must be one the tools edit, and each symbol is looked up in the
// list and with the symbol search.
async function planAddition(
  ctx: ToolContext,
  given: string[],
  listId: string | undefined,
): Promise<PlannedChange> {
  const page = await ctx.connection.chartPage();
  const waitMs = pageWaitMs(ctx.config.callTimeoutMs);
  const list = await editableList(page, listId, waitMs);
  const found = await findListings(page, symbolsToSearch(given, list.entries));
  return { page, waitMs, list, planned: resolveAdditions(given, list.entries, found) };
}

// Carries out a planned addition. From the check of the limit to the end of the change and of the
// refresh after it, the other actions on plan limits wait, so that a second addition sees the first
// one. Answers the outcome of each symbol as it turned out, the symbols added, as the list holds
// them, and the warnings, and records the symbols added in the session.
async function commitAddition(
  ctx: ToolContext,
  { page, waitMs, list, planned }: PlannedChange,
): Promise<{ planned: PlannedAddition[]; added: string[]; warnings: string[] }> {
  if (!planned.some(({ outcome }) => outcome === 'add')) {
    return { planned, added: [], warnings: [] };
  }
  const outcome = await inPlanLimitedTurn(async () => {
    // The list as it is now: an addition that took its turn first may have added some symbols.
    const current = await editableList(page, list.id, waitMs);
    const now = planned.map((item): PlannedAddition => {
      const held = item.outcome === 'add' ? listedEntry(current.entries, item.name) : null;
      return held === null ? item : { given: item.given, outcome: 'already_listed', name: held };
    });
    const sending = now.flatMap((item) => (item.outcome === 'add' ? [item.name] : []));
    if (sending.length === 0) {
      return { planned: now, added: [], warnings: [] };
    }
    requireRoom(
      current.entries.length,
      sending.length,
      await page.bridge.evaluateWithLib(readWatchlistLimits, []),
    );
    const { entries, refreshed } = await changeList(page, 'add', current, sending, waitMs);
    if (entries === null) {
      throw unconfirmedChangeError('add', current.id, sending);
    }
    const added = sending.filter((name) => entries.includes(name));
    if (added.length === 0) {
      throw notChangedError('add', current.id, sending);
    }
    const missing = sending.filter((name) => !added.includes(name));
    return {
      planned: now,
      added,
      warnings: [
        ...(missing.length === 0 ? [] : [notAddedWarning(missing)]),
        ...(refreshed ? [] : [STALE_STORE_WARNING]),
      ],
    };
  });
  if (outcome.added.length > 0) {
    const own = ctx.session.addedWatchlistSymbols.get(list.id) ?? new Set<string>();
    for (const name of outcome.added) {
      own.add(name);
    }
    ctx.session.addedWatchlistSymbols.set(list.id, own);
  }
  return outcome;
}

// What watchlist_get reports for the list `listId`, or the active list without it.
export async function readWatchlistData(ctx: ToolContext, listId?: string) {
  const page = await ctx.connection.chartPage();
  const { list } = await readList(page, listId, pageWaitMs(ctx.config.callTimeoutMs));
  return { data: toWatchlistView(list), via: 'internal' as const };
}

export const watchlistList = defineTool({
  name: 'watchlist_list',
  domain: 'watchlist',
  title: 'List watchlists',
  description:
    "Lists the watchlists of the user's TradingView account, and changes nothing. Returns " +
    'lists, each with id (the listId of the other watchlist tools), name, symbolCount (its ' +
    'symbols, section markers left out), active (whether it is the active watchlist of ' +
    'TradingView) and editable (whether watchlist_add, watchlist_add_bulk and watchlist_remove ' +
    'change it: true for the custom lists saved on the account; false for flag lists, hot lists ' +
    'of an exchange and lists TradingView keeps on this computer only). When TradingView has not ' +
    'loaded the watchlists yet, it loads them as opening its watchlist panel does.',
  inputSchema: {},
  annotations: READ_ONLY,
  async handler(_input, ctx) {
    const page = await ctx.connection.chartPage();
    const listing = await page.bridge.evaluateWithLib(readWatchlists, [
      pageWaitMs(ctx.config.callTimeoutMs),
    ]);
    if (!listing.ready) {
      throw notLoadedError();
    }
    return { data: { lists: listing.lists.map(toListing) }, via: 'internal' };
  },
});

export const watchlistGet = defineTool({
  name: 'watchlist_get',
  domain: 'watchlist',
  title: 'Read a watchlist',
  description:
    "Reads one watchlist of the user's TradingView account, and changes nothing: the active " +
    'watchlist by default, or the one listId names (an id from watchlist_list). Returns id, ' +
    'name, editable (whether the watchlist tools change it), symbols (as EXCHANGE:TICKER, in the ' +
    'order of the list, section markers left out) and sections, the sections of the list in ' +
    'order, each { name, symbols }; symbols above the first section come first, with name null. ' +
    'A listId the account does not have fails with INVALID_INPUT.',
  inputSchema: { listId: LIST_ID },
  annotations: READ_ONLY,
  core: true,
  handler: ({ listId }, ctx) => readWatchlistData(ctx, listId),
});

export const watchlistAdd = defineTool({
  name: 'watchlist_add',
  domain: 'watchlist',
  title: 'Add a symbol to a watchlist',
  description:
    "Adds a symbol to a watchlist of the user's TradingView account: the active watchlist by " +
    'default, or the custom list listId names (from watchlist_list; a list whose editable is ' +
    'false fails with INVALID_INPUT). The symbol is checked with the symbol search of ' +
    'TradingView first: one it does not know fails with INVALID_INPUT and nothing is added. ' +
    'EXCHANGE:TICKER picks the listing; a ticker alone is taken as the first listing the search ' +
    'finds. A symbol the list holds already, by its full name or by its ticker alone, is not ' +
    `added again (outcome already_listed). ${LIMIT_TEXT} Returns listId, symbol (as the list ` +
    'holds it) and outcome: added or already_listed. No dialog opens. watchlist_remove removes ' +
    'what this session added without confirm.',
  inputSchema: {
    symbol: SYMBOL.describe(
      'The symbol to add: EXCHANGE:TICKER such as NASDAQ:AAPL, as data_search_symbols reports ' +
        'it, or a ticker alone for its first listing.',
    ),
    listId: LIST_ID,
  },
  annotations: CHANGES_IDEMPOTENT,
  core: true,
  async handler({ symbol, listId }, ctx) {
    const plan = await planAddition(ctx, trimmedSymbols([symbol]), listId);
    // An addition of nothing but an unknown symbol changes nothing.
    const { planned, warnings } = await commitAddition(ctx, plan);
    const [item] = planned;
    if (item?.outcome !== 'add' && item?.outcome !== 'already_listed') {
      throw unknownSymbolError(symbol.trim());
    }
    return {
      data: {
        listId: plan.list.id,
        symbol: item.name,
        outcome: item.outcome === 'add' ? ('added' as const) : ('already_listed' as const),
      },
      via: 'internal',
      warnings,
    };
  },
});

export const watchlistAddBulk = defineTool({
  name: 'watchlist_add_bulk',
  domain: 'watchlist',
  title: 'Add symbols to a watchlist',
  description:
    `Adds 1 to ${String(MAX_SYMBOLS)} symbols to a watchlist of the user's TradingView account: ` +
    'the active watchlist by default, or the custom list listId names (from watchlist_list; a ' +
    'list whose editable is false fails with INVALID_INPUT). Each symbol is checked with the ' +
    'symbol search of TradingView first, and added at most once: EXCHANGE:TICKER picks the ' +
    'listing, and a ticker alone is taken as the first listing the search finds. Returns ' +
    'listId, added (the symbols added, as the list holds them, in the order given) and skipped, ' +
    'each { symbol (as given), reason }: already_listed (the list holds it, by its full name or ' +
    'its ticker alone), duplicate (given before in the same call) or unknown (the symbol search ' +
    `does not know it). The limit is checked for all the symbols together. ${LIMIT_TEXT} No ` +
    'dialog opens. watchlist_remove removes what this session added without confirm.',
  inputSchema: {
    symbols: z
      .array(SYMBOL)
      .min(1)
      .max(MAX_SYMBOLS)
      .describe(
        `The symbols to add, 1 to ${String(MAX_SYMBOLS)}: EXCHANGE:TICKER such as NASDAQ:AAPL, ` +
          'or a ticker alone for its first listing.',
      ),
    listId: LIST_ID,
  },
  annotations: CHANGES_IDEMPOTENT,
  async handler({ symbols, listId }, ctx) {
    const plan = await planAddition(ctx, trimmedSymbols(symbols), listId);
    const { planned, added, warnings } = await commitAddition(ctx, plan);
    return {
      data: {
        listId: plan.list.id,
        added,
        skipped: planned.flatMap(({ given, outcome }) =>
          outcome === 'add' ? [] : [{ symbol: given, reason: outcome }],
        ),
      },
      via: 'internal',
      warnings,
    };
  },
});

export const watchlistRemove = defineTool({
  name: 'watchlist_remove',
  domain: 'watchlist',
  title: 'Remove symbols from a watchlist',
  description:
    "Removes symbols from a watchlist of the user's TradingView account: the active watchlist by " +
    'default, or the custom list listId names (from watchlist_list; a list whose editable is ' +
    `false fails with INVALID_INPUT). Give 1 to ${String(MAX_SYMBOLS)} symbols as watchlist_get ` +
    'lists them, case aside; a section marker is never removed. Symbols this session added with ' +
    'watchlist_add or watchlist_add_bulk go without more ado; any other symbol of the list is ' +
    "the user's and needs confirm: true, else the call fails with CONFIRMATION_REQUIRED and " +
    'nothing is removed. Returns listId, removed (as the list held them) and notListed (the ' +
    'symbols given that the list does not hold). TradingView has no undo for it. No dialog opens.',
  inputSchema: {
    symbols: z
      .array(SYMBOL)
      .min(1)
      .max(MAX_SYMBOLS)
      .describe(`The symbols to remove, 1 to ${String(MAX_SYMBOLS)}, as watchlist_get lists them.`),
    listId: LIST_ID,
    confirm: z
      .boolean()
      .optional()
      .describe(
        "Must be true to remove a symbol this session did not add, which was the user's. Not " +
          'needed for symbols added with watchlist_add or watchlist_add_bulk in this session.',
      ),
  },
  annotations: DESTRUCTIVE_IDEMPOTENT,
  async handler({ symbols, listId, confirm }, ctx) {
    const given = trimmedSymbols(symbols);
    const page = await ctx.connection.chartPage();
    const waitMs = pageWaitMs(ctx.config.callTimeoutMs);
    const list = await editableList(page, listId, waitMs);
    const { toRemove, notListed } = removalPlan(given, list.entries);
    if (toRemove.length === 0) {
      return { data: { listId: list.id, removed: [], notListed }, via: 'internal' };
    }
    const own = ctx.session.addedWatchlistSymbols.get(list.id);
    const foreign = toRemove.filter((symbol) => own?.has(symbol) !== true);
    if (foreign.length > 0 && confirm !== true) {
      throw confirmationError(list.id, foreign);
    }
    const { entries, refreshed } = await changeList(page, 'remove', list, toRemove, waitMs);
    if (entries === null) {
      throw unconfirmedChangeError('remove', list.id, toRemove);
    }
    const removed = toRemove.filter((symbol) => !entries.includes(symbol));
    if (own !== undefined) {
      for (const symbol of removed) {
        own.delete(symbol);
      }
      if (own.size === 0) {
        ctx.session.addedWatchlistSymbols.delete(list.id);
      }
    }
    if (removed.length === 0) {
      throw notChangedError('remove', list.id, toRemove);
    }
    const kept = toRemove.filter((symbol) => !removed.includes(symbol));
    return {
      data: { listId: list.id, removed, notListed },
      via: 'internal',
      warnings: [
        ...(kept.length === 0 ? [] : [notRemovedWarning(kept)]),
        ...(refreshed ? [] : [STALE_STORE_WARNING]),
      ],
    };
  },
});

// In the order of the catalog (design spec 7).
export const watchlistTools: AnyToolDefinition[] = [
  watchlistList,
  watchlistGet,
  watchlistAdd,
  watchlistAddBulk,
  watchlistRemove,
];
