import type { PageHandle } from '../../core/connection.js';
import { TvMcpError } from '../../core/errors.js';
import {
  openPineEditor,
  readPineEditorState,
  readPineOwnEdit,
  type PineEditorState,
} from './page.js';

export type { PineEditorState } from './page.js';

// The Node side of the Pine Editor access layer, which the Pine tools build on. It reads the state
// of the editor, opens it when it is closed, and guards its unsaved text: nothing may replace that
// text without confirm: true (design spec 5.3), unless it is an unsaved edit of exactly the text
// this session wrote last. The text itself is never read here, returned or logged: the page
// compares it.
//
// A member of the editor that could not be read is reported as a warning in `warnings`, which the
// caller passes in to collect the warnings of its tool, and the state carries the safe default:
// modified for an unknown isModified, and for an unknown flag of unsaved changes TradingView keeps
// (unsaved text of an editor whose side panel closed, which it shows again when the editor opens,
// with isModified() false).

// What each member that could not be read means for the state.
const UNREADABLE_WARNINGS: Record<string, string> = {
  getFacade:
    'The Pine Editor is open, but TradingView did not hand over its facade, so its state is ' +
    'unknown: it is reported as modified: true, so that its text is not replaced without confirm, ' +
    'and without a script.',
  getScriptIdVersion:
    'The id and version of the script in the Pine Editor could not be read, so script is null.',
  isModified:
    'Whether the Pine Editor holds unsaved changes could not be read, so it is reported as ' +
    'modified: true, so that its text is not replaced without confirm.',
  unsavedChanges:
    'Whether TradingView keeps unsaved changes of the Pine Editor, whose text it shows again when ' +
    'the editor opens, could not be read, so it is reported as modified: true, so that its text ' +
    'is not replaced without confirm.',
  isDraft:
    'Whether the script in the Pine Editor is a draft could not be read, so draft is taken from ' +
    'whether it has a script id and version.',
};

function warnAbout(unreadable: readonly string[], warnings: string[]): void {
  for (const member of unreadable) {
    warnings.push(
      UNREADABLE_WARNINGS[member] ??
        `The member ${member} of the Pine Editor could not be read, so the state may be incomplete.`,
    );
  }
}

// The state of the editor, read without changing anything. Fails CAPABILITY_UNAVAILABLE when the
// page has no registry of open editors.
export async function readEditorState(
  page: PageHandle,
  warnings: string[] = [],
): Promise<PineEditorState> {
  const { state, unreadable } = await page.bridge.evaluateWithLib(readPineEditorState, []);
  warnAbout(unreadable, warnings);
  return state;
}

// The state of the editor, opened first when it is closed, the way the Pine button of the toolbar
// opens it (see openPineEditor for what it then shows). An open editor is left as it is. Waits at
// most waitMs for the editor to be ready (TIMEOUT); see openPineEditor for the other failures.
export async function ensureEditorOpen(
  page: PageHandle,
  waitMs: number,
  warnings: string[] = [],
): Promise<PineEditorState> {
  const { state, unreadable } = await page.bridge.evaluateWithLib(openPineEditor, [waitMs]);
  warnAbout(unreadable, warnings);
  return state;
}

// The error of a tool that needs an open editor and found it closed.
export function notOpenError(): TvMcpError {
  return new TvMcpError('NOT_AVAILABLE', 'The Pine Editor is not open', {
    hint: 'Open a saved script with pine_open, or start a new one with pine_new.',
  });
}

// What the flag of unsaved changes TradingView keeps for the editor does, and what closing the
// editor does to it: the close writes the flag anew from the text the editor holds then.
export const CLOSE_EDITOR_HINT =
  'TradingView flags unsaved changes until the Pine Editor closes, also after a call replaced ' +
  'them. Closing the Pine Editor in TradingView clears the flag only when the editor holds no ' +
  'unsaved changes at that moment; else TradingView keeps the text and shows it again on the next ' +
  'open.';

// The hint of a refusal to replace unsaved text of the editor. The page says it in its own words
// (changePineEditor), which a test holds to these.
export const UNSAVED_TEXT_HINT = `Pass confirm: true to replace it, or save it first with pine_save. ${CLOSE_EDITOR_HINT}`;

// What saving and closing do to the flag of unsaved changes TradingView keeps, for the refusals to
// add or save a script it flags: saving leaves the flag set, and only a close with nothing unsaved
// writes it down (see CLOSE_EDITOR_HINT).
export const KEPT_FLAG_REMEDY =
  'Saving does not clear the flag of unsaved changes TradingView keeps, which also marks text it ' +
  'kept across a close of the Pine Editor: once nothing is unsaved, closing the Pine Editor in ' +
  'TradingView clears it.';

// The hint of a refusal to add a saved script with unsaved changes to the chart, which TradingView
// would ask about in a dialog. The page says it in its own words (addPineScriptToChart), which a
// test holds to these.
export const SAVED_CHANGES_HINT =
  'Save the changes first with pine_save, or start a new script with pine_new and the source, ' +
  `then add that. ${KEPT_FLAG_REMEDY} Then open the script with pine_open and add it.`;

// The error of `action`, which would replace unsaved text of the editor without confirm.
export function unsavedTextError(action: string): TvMcpError {
  return new TvMcpError(
    'CONFIRMATION_REQUIRED',
    `${action} would replace the unsaved text in the Pine Editor`,
    { hint: UNSAVED_TEXT_HINT, details: { action } },
  );
}

// Fails CONFIRMATION_REQUIRED when the editor holds unsaved changes and the caller did not pass
// confirm: true, before `action` replaces the text of the editor.
export function requireUnmodifiedOrConfirmed(
  state: PineEditorState,
  confirm: boolean | undefined,
  action: string,
): void {
  if (state.modified && confirm !== true) {
    throw unsavedTextError(action);
  }
}

// requireUnmodifiedOrConfirmed, except that unsaved changes are no reason to refuse while they are
// an unsaved edit of exactly `written`, the text this session wrote last into the editor (null for
// none; see readPineOwnEdit): they, and the flag of them TradingView keeps until the editor closes,
// are then the session's own. A failure to read the editor is passed on as it is. An early check,
// before a tool spends time on what it would write: the page checks again right before it writes
// (changePineEditor).
export async function requireReplaceable(
  page: PageHandle,
  state: PineEditorState,
  confirm: boolean | undefined,
  action: string,
  written: string | null,
): Promise<void> {
  if (!state.modified || confirm === true) {
    return;
  }
  if (written !== null && (await page.bridge.evaluateWithLib(readPineOwnEdit, [written]))) {
    return;
  }
  throw unsavedTextError(action);
}
