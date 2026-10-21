import type { PageHandle } from '../../core/connection.js';
import { TvMcpError } from '../../core/errors.js';
import {
  openPineEditor,
  readPineEditorState,
  readPineSource,
  type PineEditorState,
} from './page.js';

export type { PineEditorState } from './page.js';

// The Node side of the Pine Editor access layer, which the Pine tools build on. It reads the state
// of the editor, opens it when it is closed, and guards its unsaved text: nothing may replace that
// text without confirm: true (design spec 5.3), unless it is exactly the text this session wrote
// last. The text itself is read here only to compare it with that one, and never returned or
// logged.
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

// The state of the editor, read without changing anything. With `written`, the text this session
// wrote last into the editor, the flag of unsaved changes TradingView keeps counts for nothing while
// isModified() says none and the editor holds exactly that text (see readPineEditorState): the
// state tools that save or add the script go by. Fails CAPABILITY_UNAVAILABLE when the page has no
// registry of open editors.
export async function readEditorState(
  page: PageHandle,
  warnings: string[] = [],
  written: string | null = null,
): Promise<PineEditorState> {
  const { state, unreadable } = await page.bridge.evaluateWithLib(readPineEditorState, [written]);
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

// What clears the flag of unsaved changes TradingView keeps for the editor, which outlives the
// changes, for the hints of the refusals it causes.
export const CLOSE_EDITOR_HINT =
  'TradingView flags unsaved changes until the Pine Editor closes, also after a call replaced ' +
  'them: once nothing in the editor needs keeping, closing the Pine Editor in TradingView clears ' +
  'that flag.';

// The error of `action`, which would replace unsaved text of the editor without confirm.
export function unsavedTextError(action: string): TvMcpError {
  return new TvMcpError(
    'CONFIRMATION_REQUIRED',
    `${action} would replace the unsaved text in the Pine Editor`,
    {
      hint: `Pass confirm: true to replace it, or save it first with pine_save. ${CLOSE_EDITOR_HINT}`,
      details: { action },
    },
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

// requireUnmodifiedOrConfirmed, except that unsaved changes are no reason to refuse while the
// editor holds exactly `written`, the text this session wrote last into it (null for none): they,
// and the flag of them TradingView keeps until the editor closes, are then the session's own. The
// text of the editor is read only for that, and a text that cannot be read is not that text. An
// early check, before a tool spends time on what it would write: the page checks again right
// before it writes (changePineEditor).
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
  if (written !== null) {
    try {
      if ((await page.bridge.evaluateWithLib(readPineSource, [])).source === written) {
        return;
      }
    } catch {
      // Not the text this session wrote, as far as can be told.
    }
  }
  throw unsavedTextError(action);
}
