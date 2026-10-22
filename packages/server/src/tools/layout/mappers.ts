import { PlanLimitError, TvMcpError } from '../../core/errors.js';
import { toIso } from '../../utils/time.js';
import { modifiedToSeconds } from '../pine/scripts.js';
import type { SavedLayoutRow } from './page.js';

// The pure parts of the layout tools: how a saved layout is reported, how the id of a new layout is
// read from its URL, how the name of a new layout is checked, and the errors and warnings. Layout
// names are the user's data: they go to the client in results, and into no message of these errors.

// The longest name the Create new layout dialog of TradingView takes (its maxLength).
export const MAX_LAYOUT_NAME = 64;

// What a saved layout is called in /chart/<id>/, the pattern the app reads it from a URL with.
const LAYOUT_PATH = /\/chart\/([^/]+)\/?$/;
// The base a URL without its origin is read against: only its path counts.
const URL_BASE = 'https://www.tradingview.com/';

// A saved layout as layout_list reports it: its id (the url of the record, the short id of the
// layout), its name, when it was last modified in Unix seconds and as ISO (null when the record does
// not say), and overLimit, only on a layout beyond the CHART_STORAGE limit of the plan. A type
// alias, not an interface: it goes to the client as JSON.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type LayoutListing = {
  id: string;
  name: string | null;
  modified: number | null;
  modifiedIso: string | null;
  overLimit?: true;
};

// The saved layouts as layout_list reports them, in the order given, and how many came without a url
// and are left out: a layout without an id cannot be named to the other tools. A time above 1e11 is
// read as milliseconds, the rule of the times of the tools.
export function toLayoutListing(rows: readonly SavedLayoutRow[]): {
  layouts: LayoutListing[];
  unreadable: number;
} {
  const layouts = rows.flatMap((row): LayoutListing[] => {
    if (row.url === null) {
      return [];
    }
    const modified = modifiedToSeconds(row.modified);
    return [
      {
        id: row.url,
        name: row.name,
        modified,
        modifiedIso: modified === null ? null : toIso(modified),
        ...(row.overLimit ? { overLimit: true as const } : {}),
      },
    ];
  });
  return { layouts, unreadable: rows.length - layouts.length };
}

// The id of the layout a URL of TradingView names, /chart/<id>/ as the app reads it, or null when
// the URL names none.
export function layoutIdFromUrl(url: string): string | null {
  let path: string;
  try {
    path = new URL(url, URL_BASE).pathname;
  } catch {
    return null;
  }
  return LAYOUT_PATH.exec(path)?.[1] ?? null;
}

// The name a new layout gets: the name given, trimmed. Fails with INVALID_INPUT for one that is blank
// or longer than the Create new layout dialog of TradingView takes.
export function layoutNameOf(given: string): string {
  const name = given.trim();
  if (name === '') {
    throw new TvMcpError('INVALID_INPUT', 'The layout name is blank', {
      hint: `Give a name of 1 to ${String(MAX_LAYOUT_NAME)} characters.`,
    });
  }
  if (name.length > MAX_LAYOUT_NAME) {
    throw new TvMcpError(
      'INVALID_INPUT',
      `The layout name is ${String(name.length)} characters long, and TradingView takes at most ` +
        String(MAX_LAYOUT_NAME),
      {
        hint: `Give a name of at most ${String(MAX_LAYOUT_NAME)} characters. Nothing was created.`,
        details: { length: name.length, max: MAX_LAYOUT_NAME },
      },
    );
  }
  return name;
}

// What the client can do about the CHART_STORAGE limit: no tool deletes a layout.
export const CHART_STORAGE_HINT =
  'The plan allows that many saved layouts. Delete a saved layout in TradingView itself, or ' +
  'switch to one of the saved layouts with layout_switch (layout_list lists them).';

export function signedOutError(): TvMcpError {
  return new TvMcpError('AUTH_REQUIRED', 'Saved layouts need a signed-in TradingView account', {
    hint: 'Sign in to TradingView, then try again.',
  });
}

// The error of a call that would discard the unsaved changes of the layout on the chart, or changes
// TradingView does not tell about (unsaved null), without confirm: switching to another layout, or
// opening a new one, loads it in place of the current one.
export function unsavedChangesError(action: 'switch' | 'new', unsaved: boolean | null): TvMcpError {
  const discarding =
    action === 'switch'
      ? 'switching layouts would discard'
      : 'opening the new layout would discard';
  return new TvMcpError(
    'CONFIRMATION_REQUIRED',
    unsaved === true
      ? `The current layout has unsaved changes, which ${discarding}`
      : `TradingView does not tell whether the current layout has unsaved changes, which ${discarding}`,
    {
      hint:
        'Save the layout in TradingView first, or, if the user wants the changes discarded, call ' +
        (action === 'switch'
          ? 'layout_switch again with confirm: true.'
          : 'layout_new again with confirm: true. Nothing was created.'),
      details: { unsavedChanges: unsaved },
    },
  );
}

export function unknownLayoutError(layoutId: string): TvMcpError {
  return new TvMcpError('INVALID_INPUT', `The account has no saved layout ${layoutId}`, {
    hint: 'Call layout_list for the ids of the saved layouts.',
    details: { layoutId },
  });
}

// The error of a layout beyond the CHART_STORAGE limit of the plan, which TradingView keeps locked:
// it would open its paywall instead of the layout.
export function overLimitError(layoutId: string): TvMcpError {
  return new TvMcpError(
    'PLAN_LIMIT',
    `The layout ${layoutId} is beyond the limit of saved layouts of the plan (CHART_STORAGE), so ` +
      'TradingView would offer an upgrade instead of opening it',
    {
      hint:
        'TradingView locks the saved layouts beyond the limit of the plan. Switch to a layout ' +
        'that layout_list does not mark overLimit.',
      details: { feature: 'CHART_STORAGE', layoutId },
    },
  );
}

// The error of a layout TradingView did not open, with why when it said.
export function notOpenedError(layoutId: string, reason: string | null): TvMcpError {
  return new TvMcpError(
    'NOT_AVAILABLE',
    `TradingView did not open the layout ${layoutId}${reason === null ? '' : `: ${reason}`}`,
    {
      hint:
        'Check layout_list, whose current is the layout the chart shows (a slow load may still ' +
        'land), and the id, then try again.',
      details: { layoutId },
    },
  );
}

// The error of a layout TradingView did not create after every check passed: TradingView opened a
// dialog of its own that says why, which nothing before could foresee.
export function notCreatedError(): TvMcpError {
  return new TvMcpError('NOT_AVAILABLE', 'TradingView did not create the layout', {
    hint:
      'TradingView may show a message in its window saying why. Nothing was opened; layout_list ' +
      'lists the saved layouts.',
  });
}

// The error of the check of the app saying the account may not save another layout, while the
// limit the tools read leaves room.
export function permissionRefusedError(limit: number): PlanLimitError {
  return new PlanLimitError(
    'CHART_STORAGE',
    limit,
    'TradingView does not let the account save another layout (plan limit CHART_STORAGE), so ' +
      'nothing was created',
    CHART_STORAGE_HINT,
  );
}

// The error of the check of the app failing, so that whether the account may save another layout is
// not known.
export function permissionUnknownError(reason: string): TvMcpError {
  return new TvMcpError(
    'NOT_AVAILABLE',
    'TradingView could not tell whether the account may save another layout, so nothing was ' +
      `created: ${reason}`,
    {
      hint: 'Try again in a moment, or create the layout in TradingView itself.',
      details: { feature: 'CHART_STORAGE' },
    },
  );
}

export function dataNotReadyWarning(layoutId: string, waitedMs: number): string {
  return (
    `The chart of the layout ${layoutId} did not report its data as loaded within ` +
    `${String(waitedMs)} ms; it may still be loading. chart_get_state shows what it shows now.`
  );
}

// The warning for a layout TradingView switched to without reporting that it finished loading it
// (the load had not ended, or failed after the switch), so that whether its chart has its data
// cannot be told.
export function unfinishedLoadWarning(layoutId: string): string {
  return (
    `TradingView switched to the layout ${layoutId} but did not report that it finished loading ` +
    'it, so its chart may still be loading. chart_get_state shows what it shows now.'
  );
}

// The warning for a layout layout_new created and did not open: a success, so that the client does
// not create it again.
export function notOpenedWarning(layoutId: string, reason: string | null): string {
  return (
    `TradingView created the layout ${layoutId} but did not open it in time` +
    `${reason === null ? '' : ` (${reason})`}. Open it with layout_switch (layoutId ${layoutId}); ` +
    'do not call layout_new again, which would create another layout.'
  );
}

export const NO_ID_WARNING =
  'TradingView created the layout but did not say its id, so it was not opened. layout_list lists ' +
  'it; open it with layout_switch rather than calling layout_new again, which would create ' +
  'another layout.';

export function unreadableLayoutsWarning(count: number): string {
  return count === 1
    ? '1 saved layout came without an id and is left out.'
    : `${String(count)} saved layouts came without an id and are left out.`;
}
