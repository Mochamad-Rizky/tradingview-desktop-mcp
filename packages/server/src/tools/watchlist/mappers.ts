import { PlanLimitError, TvMcpError } from '../../core/errors.js';
import { unreadableLimitError } from '../../core/tv/plan-limits.js';
import { listed } from '../drawing/mappers.js';
import type { WatchlistRecord, WatchlistRefusal, WatchlistSummary } from './page.js';

// The pure parts of the watchlist tools: the sections of a list, how a list holds a symbol, the
// outcome of each symbol of an addition, the room a list has, and the errors and warnings the tools
// give.

// What an entry of a list that marks the start of a section starts with (SEPARATOR_PREFIX of the
// app). The app marks a collapsed section with an invisible plus after it on the server.
const SECTION_PREFIX = '###';
const COLLAPSED_MARK = '⁤';

// The code of the watchlist server for a list the plan of the account lets hold no more symbols.
const LIMIT_CODE = 'plan_symbols_limit_reached';

const ROOM_HINT =
  'TradingView counts every entry of a watchlist, section markers included. Remove some with ' +
  'watchlist_remove first, or add to another watchlist (watchlist_list).';

export function isSectionMarker(entry: string): boolean {
  return entry.startsWith(SECTION_PREFIX);
}

// The name of a section, as the marker that starts it holds it.
export function sectionName(marker: string): string {
  return marker.slice(SECTION_PREFIX.length).replace(COLLAPSED_MARK, '');
}

// The symbols of a list, in order: its entries without the section markers.
export function symbolsOf(entries: readonly string[]): string[] {
  return entries.filter((entry) => !isSectionMarker(entry));
}

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type WatchlistSection = { name: string | null; symbols: string[] };

// The sections of a list in order, each with the symbols under its marker. The symbols before the
// first marker come first, in a section named null; a list without markers is one such section.
export function sectionsOf(entries: readonly string[]): WatchlistSection[] {
  const sections: WatchlistSection[] = [];
  let current: WatchlistSection | null = null;
  for (const entry of entries) {
    if (isSectionMarker(entry)) {
      current = { name: sectionName(entry), symbols: [] };
      sections.push(current);
    } else {
      if (current === null) {
        current = { name: null, symbols: [] };
        sections.push(current);
      }
      current.symbols.push(entry);
    }
  }
  return sections;
}

// The short name of a symbol: its ticker, without the exchange (safeShortName of the app, for the
// EXCHANGE:TICKER symbols the tools add).
export function shortName(symbol: string): string {
  return symbol.slice(symbol.lastIndexOf(':') + 1);
}

// The entry of the list that holds `symbol`: one with its name, or with its short name, case aside,
// as the app checks before it adds a symbol (it skips what the list holds by either). Null when the
// list holds neither. A section marker never holds a symbol.
export function listedEntry(entries: readonly string[], symbol: string): string | null {
  const byName = new Map<string, string>();
  for (const entry of symbolsOf(entries)) {
    const key = entry.toUpperCase();
    if (!byName.has(key)) {
      byName.set(key, entry);
    }
  }
  const key = symbol.toUpperCase();
  return byName.get(key) ?? byName.get(shortName(key)) ?? null;
}

// The symbols of an addition the symbol search has to find, each once and as first given: those that
// are no duplicate of a symbol given before and that the list does not hold already.
export function symbolsToSearch(given: readonly string[], entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const searched: string[] = [];
  for (const symbol of given) {
    const key = symbol.toUpperCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (listedEntry(entries, symbol) === null) {
      searched.push(symbol);
    }
  }
  return searched;
}

// What becomes of one symbol of an addition, given as given: added under the name the symbol search
// gives it, already listed under the entry the list holds for it, a duplicate of a symbol given
// before (with the symbol it stands for, when the search found it), or unknown to the search.
export type PlannedAddition =
  | { given: string; outcome: 'add' | 'already_listed'; name: string }
  | { given: string; outcome: 'duplicate'; name: string | null }
  | { given: string; outcome: 'unknown'; name: null };

// The outcome of each symbol of an addition, in the order given, with `found` the symbol each
// searched symbol stands for (by the symbol given, upper case), null for one the search does not
// know. A symbol given before, as written (case aside) or as the symbol it stands for, is a
// duplicate; one the list holds, by its name or short name or as the symbol it stands for, is
// already listed; one the search does not know is unknown; any other is added, under the name the
// search gives it.
export function resolveAdditions(
  given: readonly string[],
  entries: readonly string[],
  found: ReadonlyMap<string, string | null>,
): PlannedAddition[] {
  const seen = new Set<string>();
  // The symbols the symbols before stand for, upper case.
  const taken = new Set<string>();
  return given.map((symbol): PlannedAddition => {
    const key = symbol.toUpperCase();
    if (seen.has(key)) {
      return { given: symbol, outcome: 'duplicate', name: null };
    }
    seen.add(key);
    const held = listedEntry(entries, symbol);
    if (held !== null) {
      taken.add(key);
      taken.add(held.toUpperCase());
      return { given: symbol, outcome: 'already_listed', name: held };
    }
    const name = found.get(key) ?? null;
    if (name === null) {
      return { given: symbol, outcome: 'unknown', name: null };
    }
    const nameKey = name.toUpperCase();
    if (taken.has(nameKey)) {
      return { given: symbol, outcome: 'duplicate', name };
    }
    taken.add(nameKey);
    const heldAs = listedEntry(entries, name);
    if (heldAs !== null) {
      return { given: symbol, outcome: 'already_listed', name: heldAs };
    }
    return { given: symbol, outcome: 'add', name };
  });
}

// Fails unless `adding` more entries fit in a list of `entries`, by the limits the app checks before
// it adds to a watchlist itself (notes of Plan 3, section 3.6), which count every entry, section
// markers included: a list beyond MAX_WATCHLIST_LENGTH (`max`) takes nothing more, where the app
// shows a warning; more than getWatchlistSymbolsLimit() (`limit`) is PLAN_LIMIT WATCHLIST_SYMBOLS,
// where the app opens its paywall; and more than the maximum, which the limit can lie beyond on a
// plan with tiered limits, takes nothing either. A limit that cannot be read refuses (NOT_AVAILABLE).
export function requireRoom(
  entries: number,
  adding: number,
  limits: { limit: number | null; max: number | null },
): void {
  const { limit, max } = limits;
  if (limit === null || max === null) {
    throw unreadableLimitError('WATCHLIST_SYMBOLS');
  }
  const more = `${String(adding)} more ${adding === 1 ? 'does' : 'do'} not fit`;
  if (entries > max) {
    throw new TvMcpError(
      'NOT_AVAILABLE',
      `The watchlist holds ${String(entries)} entries, more than the ${String(max)} TradingView ` +
        'lets a watchlist hold, so nothing was added',
      {
        hint: `TradingView adds nothing to such a list. ${ROOM_HINT}`,
        details: { feature: 'WATCHLIST_SYMBOLS', entries, max },
      },
    );
  }
  if (entries + adding > limit) {
    throw new PlanLimitError(
      'WATCHLIST_SYMBOLS',
      limit,
      `Plan limit reached for WATCHLIST_SYMBOLS: the watchlist holds ${String(entries)} entries ` +
        `and TradingView lets it hold ${String(limit)}, so ${more}`,
      ROOM_HINT,
    );
  }
  if (entries + adding > max) {
    throw new TvMcpError(
      'NOT_AVAILABLE',
      `The watchlist holds ${String(entries)} entries and TradingView lets a watchlist hold ` +
        `${String(max)}, so ${more}`,
      { hint: ROOM_HINT, details: { feature: 'WATCHLIST_SYMBOLS', entries, max } },
    );
  }
}

// The error of a refusal of the watchlist server. The limit code of the plan is PLAN_LIMIT with the
// message of the server unchanged (design spec 5.3, rule 3); any other refusal PAGE_EVALUATION_FAILED
// with its code. `action` says what was asked, such as "add the symbols to the watchlist".
export function watchlistRefusalError(refusal: WatchlistRefusal, action: string): TvMcpError {
  const { code, message } = refusal;
  if (code === LIMIT_CODE) {
    return new TvMcpError(
      'PLAN_LIMIT',
      message === '' ? `TradingView refused to ${action}: ${code}` : message,
      {
        hint:
          'TradingView refused it for the watchlist limit of the plan of the account. Remove ' +
          'symbols with watchlist_remove first, or add to another watchlist (watchlist_list).',
        details: { feature: 'WATCHLIST_SYMBOLS', code },
      },
    );
  }
  const said = message === '' ? '' : `: ${message}`;
  return new TvMcpError(
    'PAGE_EVALUATION_FAILED',
    `TradingView did not ${action}${said}${code === null ? '' : ` (${code})`}`,
    {
      hint:
        code === null
          ? 'Check watchlist_get: TradingView may have acted despite the error.'
          : 'TradingView refused it, so nothing changed.',
      details: { code },
    },
  );
}

// What a removal takes out: the entries of the list that hold the given symbols, as the list holds
// them (case aside, each once), and the symbols given that the list does not hold, as given. A
// section marker is never taken out: given, it counts as not listed. A symbol given twice counts
// once.
export function removalPlan(
  given: readonly string[],
  entries: readonly string[],
): { toRemove: string[]; notListed: string[] } {
  const byName = new Map<string, string>();
  for (const entry of symbolsOf(entries)) {
    const key = entry.toUpperCase();
    if (!byName.has(key)) {
      byName.set(key, entry);
    }
  }
  const seen = new Set<string>();
  const toRemove: string[] = [];
  const notListed: string[] = [];
  for (const symbol of given) {
    const key = symbol.toUpperCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const entry = isSectionMarker(symbol) ? undefined : byName.get(key);
    if (entry === undefined) {
      notListed.push(symbol);
    } else {
      toRemove.push(entry);
    }
  }
  return { toRemove, notListed };
}

// A watchlist as watchlist_get reports it.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type WatchlistView = {
  id: string;
  name: string | null;
  editable: boolean;
  symbols: string[];
  sections: WatchlistSection[];
};

export function toWatchlistView(list: WatchlistRecord): WatchlistView {
  return {
    id: list.id,
    name: list.name,
    editable: list.editable,
    symbols: symbolsOf(list.entries),
    sections: sectionsOf(list.entries),
  };
}

// A watchlist as watchlist_list reports it.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type WatchlistListing = {
  id: string;
  name: string | null;
  symbolCount: number;
  active: boolean;
  editable: boolean;
};

export function toListing(summary: WatchlistSummary): WatchlistListing {
  const { id, name, symbolCount, active, editable } = summary;
  return { id, name, symbolCount, active, editable };
}

// The error of an edit of a list the watchlist tools do not edit: a flag list, a hot list, or a
// custom list the app keeps on this computer only. `defaulted` says the list is the active one,
// which the caller did not name.
export function notEditableError(list: WatchlistRecord, defaulted: boolean): TvMcpError {
  const why =
    list.kind === 'flag'
      ? 'is a flag list'
      : list.kind === 'hot'
        ? 'is a hot list of TradingView'
        : 'is kept by TradingView on this computer only';
  return new TvMcpError(
    'INVALID_INPUT',
    `${defaulted ? 'The active watchlist' : 'The watchlist'} ${list.name ?? list.id} ${why}, ` +
      'which the watchlist tools do not edit',
    {
      hint: 'Call watchlist_list, and give the id of a list whose editable is true as listId.',
      details: { listId: list.id },
    },
  );
}

// The error of a removal of symbols this session did not add, which were the user's.
export function confirmationError(listId: string, symbols: readonly string[]): TvMcpError {
  const one = symbols.length === 1;
  return new TvMcpError(
    'CONFIRMATION_REQUIRED',
    `Removing ${listed(symbols)} from the watchlist ${listId} needs confirmation: this session ` +
      `did not add ${one ? 'it' : 'them'}`,
    {
      hint: one
        ? "The symbol was in the list before, so it is the user's. Make sure the user wants it " +
          'removed, then call watchlist_remove again with confirm: true.'
        : "The symbols were in the list before, so they are the user's. Make sure the user wants " +
          'them removed, then call watchlist_remove again with confirm: true.',
      details: { listId, symbols: [...symbols] },
    },
  );
}

// The warning for symbols TradingView does not list after it took the addition.
export function notAddedWarning(symbols: readonly string[]): string {
  return (
    `TradingView does not list ${listed(symbols)} after the addition, so ` +
    `${symbols.length === 1 ? 'it is' : 'they are'} not reported as added. watchlist_get shows ` +
    'the list.'
  );
}

// The warning for symbols TradingView still lists after it took the removal.
export function notRemovedWarning(symbols: readonly string[]): string {
  return (
    `TradingView still lists ${listed(symbols)} after the removal. watchlist_get shows what is ` +
    'left.'
  );
}

// The warning for a store the app could not reload after a change.
export const STALE_STORE_WARNING =
  'TradingView did not reload the watchlist after the change, so its watchlist panel may show ' +
  'the change only later. The result follows the answer of the watchlist server.';

// The error of a list TradingView has not loaded, so that the tools cannot tell whether the account
// has it.
export function notLoadedError(): TvMcpError {
  return new TvMcpError(
    'NOT_AVAILABLE',
    'TradingView has not loaded the watchlists of the account',
    {
      hint:
        "Open the watchlist with ui_open_panel (panel: 'watchlist'), which loads them, then try " +
        'again.',
    },
  );
}

export function noActiveListError(): TvMcpError {
  return new TvMcpError('NOT_AVAILABLE', 'TradingView reports no active watchlist', {
    hint:
      'Give the listId of a list from watchlist_list, or open the watchlist with ui_open_panel ' +
      "(panel: 'watchlist').",
  });
}

export function unknownListError(listId: string): TvMcpError {
  return new TvMcpError('INVALID_INPUT', `The account has no watchlist ${listId}`, {
    hint: 'Call watchlist_list for the ids of the watchlists of the account.',
    details: { listId },
  });
}

export function signedOutError(): TvMcpError {
  return new TvMcpError(
    'AUTH_REQUIRED',
    'Editing a watchlist needs a signed-in TradingView account',
    {
      hint: 'Sign in to TradingView, then try again.',
    },
  );
}

export function unknownSymbolError(symbol: string): TvMcpError {
  return new TvMcpError('INVALID_INPUT', `The symbol search of TradingView found no ${symbol}`, {
    hint:
      'Check the spelling, or find the symbol with data_search_symbols and give it in the ' +
      'EXCHANGE:TICKER form it reports.',
    details: { symbol },
  });
}

// The error of symbols that are blank, by their positions in the list given, counted from 1.
export function blankSymbolsError(positions: readonly number[]): TvMcpError {
  const one = positions.length === 1;
  return new TvMcpError(
    'INVALID_INPUT',
    `${one ? 'The symbol at position' : 'The symbols at positions'} ` +
      `${listed(positions.map(String))} ${one ? 'is' : 'are'} blank`,
    {
      hint: 'Give each symbol as EXCHANGE:TICKER, such as NASDAQ:AAPL.',
      details: { positions: [...positions] },
    },
  );
}

// The error of a change the server took and that changed none of the symbols it was sent.
export function notChangedError(
  change: 'add' | 'remove',
  listId: string,
  symbols: readonly string[],
): TvMcpError {
  return new TvMcpError(
    'NOT_AVAILABLE',
    `TradingView did not ${change === 'add' ? 'add' : 'remove'} ${listed(symbols)} ` +
      `${change === 'add' ? 'to' : 'from'} the watchlist ${listId}`,
    { hint: 'Check watchlist_get, and try again.', details: { listId, symbols: [...symbols] } },
  );
}
