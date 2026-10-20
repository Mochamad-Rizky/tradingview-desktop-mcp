import { toIso } from '../../utils/time.js';
import type { SavedScriptRow } from './page.js';

export type { SavedScriptRow } from './page.js';

// The saved Pine scripts of the account on the Node side: how a row of the list the app requests
// becomes what the tools return, and read-only replicas of the saved-script limit checks of the app
// (reverse-engineering notes of Plan 2, section Q1, "Paywall side effect"). The app runs these
// checks itself before it saves or opens a script, and opens its paywall when one is blocked, so
// the tools run the replicas first and fail with PLAN_LIMIT instead.

export type PineScriptType = 'indicator' | 'strategy' | 'library';

// What the app decides the saved-script limit by, besides the limit of the plan.
export interface SavedScriptLimitContext {
  // window.is_authenticated: the app applies no limit while signed out.
  authenticated: boolean;
  // The feature toggle pine_free_saved_scripts_limit, null when it could not be read.
  limitEnabled: boolean | null;
  // The UNLIMITED_FEATURE_LIMIT of the app, null when it could not be read.
  unlimited: number | null;
}

// The value of UNLIMITED_FEATURE_LIMIT on the captured web build, for when the page does not give
// it.
const UNLIMITED_FEATURE_LIMIT = 99999;

// Numbers above this are milliseconds and the rest seconds, the rule of the time inputs (design
// spec 5.1).
const MILLISECONDS_ABOVE = 1e11;

// The last second Date can print with a four-digit year, 9999-12-31T23:59:59Z.
const MAX_SECONDS = 253_402_300_799;

// The modified time of a saved script as an ISO string, or null for what is no time. The unit of a
// number is not known, so it follows the rule of the time inputs.
export function modifiedToIso(value: number | string | null): string | null {
  let seconds: number;
  if (typeof value === 'number') {
    seconds = value > MILLISECONDS_ABOVE ? value / 1000 : value;
  } else if (typeof value === 'string') {
    seconds = Date.parse(value) / 1000;
  } else {
    return null;
  }
  return Number.isFinite(seconds) && seconds > 0 && seconds <= MAX_SECONDS ? toIso(seconds) : null;
}

// The script type of a kind of the app: "study" is an indicator, and so is a script without a kind
// or with one the tools do not know.
export function scriptTypeOf(kind: string | null): PineScriptType {
  return kind === 'strategy' || kind === 'library' ? kind : 'indicator';
}

// A saved script as pine_list_scripts returns it. modified in the row is as the list gives it, a
// number in an unknown unit or a date string, or null.
export function toSavedScript(row: SavedScriptRow) {
  return {
    id: row.scriptIdPart,
    name: row.scriptName ?? row.scriptTitle ?? row.scriptIdPart,
    version: row.version,
    type: scriptTypeOf(row.kind),
    modified: modifiedToIso(row.modified),
  };
}

export type SavedScript = ReturnType<typeof toSavedScript>;

// The saved-script limit the app applies, or null when it applies none: signed out, with the
// feature toggle off, without a known limit, or with a limit at the unlimited value. A toggle that
// could not be read counts as on, so that an unknown state never opens the paywall.
export function savedScriptLimit(
  context: SavedScriptLimitContext,
  limit: number | null | undefined,
): number | null {
  if (!context.authenticated || context.limitEnabled === false || typeof limit !== 'number') {
    return null;
  }
  return limit < (context.unlimited ?? UNLIMITED_FEATURE_LIMIT) ? limit : null;
}

// The saved scripts the limit counts: every one whose version does not parse to 0 the way
// parseInt does, which leaves out the server drafts (version 0.x). A missing version parses to NaN
// and so counts, as in the app.
export function countedScripts(rows: readonly SavedScriptRow[]): SavedScriptRow[] {
  return rows.filter(({ version }) => Number.parseInt(version ?? '', 10) !== 0);
}

// The sort key of a script by its modified time. A number is used as it is, as the app sorts by
// b.modified - a.modified; a date string by its time; a script without a time sorts last.
function modifiedKey(row: SavedScriptRow): number {
  const key = typeof row.modified === 'string' ? Date.parse(row.modified) : row.modified;
  return key === null || Number.isNaN(key) ? Number.NEGATIVE_INFINITY : key;
}

// Whether the plan keeps the script of this id from being opened or updated: the app lets only the
// newest `limit` counted scripts by modified be opened (isSavedScriptOpenLimited), and refuses to
// update the others (isScriptUpdateBlockedByPaywall runs the same check). A draft, a script the
// list does not have and an account without a limit are never limited.
export function isOpenLimited(
  rows: readonly SavedScriptRow[],
  scriptId: string,
  limit: number | null,
): boolean {
  if (limit === null) {
    return false;
  }
  const counted = countedScripts(rows);
  if (!counted.some(({ scriptIdPart }) => scriptIdPart === scriptId)) {
    return false;
  }
  const newest = [...counted].sort((a, b) => modifiedKey(b) - modifiedKey(a)).slice(0, limit);
  return !newest.some(({ scriptIdPart }) => scriptIdPart === scriptId);
}

// The saved scripts of an id, exactly, or of a name, matched against the name or the title of a
// script case aside and without surrounding spaces.
export function findSavedScripts(
  rows: readonly SavedScriptRow[],
  wanted: { scriptId: string } | { name: string },
): SavedScriptRow[] {
  if ('scriptId' in wanted) {
    const { scriptId } = wanted;
    return rows.filter(({ scriptIdPart }) => scriptIdPart === scriptId);
  }
  const name = wanted.name.trim().toLowerCase();
  return rows.filter(
    ({ scriptName, scriptTitle }) =>
      scriptName?.trim().toLowerCase() === name || scriptTitle?.trim().toLowerCase() === name,
  );
}
