import type { PageHandle } from '../../core/connection.js';
import { TvMcpError } from '../../core/errors.js';
import { openPineEditor, readPineEditorState, type PineEditorState } from './page.js';

export type { PineEditorState } from './page.js';

// The Node side of the Pine Editor access layer, which the Pine tools build on. It reads the state
// of the editor, opens it when it is closed, and guards its unsaved text: nothing may replace that
// text without confirm: true (design spec 5.3). The text itself is never read here, returned or
// logged.
//
// A member of the editor that could not be read is reported as a warning in `warnings`, which the
// caller passes in to collect the warnings of its tool, and the state carries the safe default:
// modified for an unknown isModified.

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
// opens it, which restores the script or draft the editor last held. An open editor is left as it
// is. Waits at most waitMs for the editor to be ready (TIMEOUT); see openPineEditor for the other
// failures.
export async function ensureEditorOpen(
  page: PageHandle,
  waitMs: number,
  warnings: string[] = [],
): Promise<PineEditorState> {
  const { state, unreadable } = await page.bridge.evaluateWithLib(openPineEditor, [waitMs]);
  warnAbout(unreadable, warnings);
  return state;
}

// Fails CONFIRMATION_REQUIRED when the editor holds unsaved changes and the caller did not pass
// confirm: true, before `action` replaces the text of the editor.
export function requireUnmodifiedOrConfirmed(
  state: PineEditorState,
  confirm: boolean | undefined,
  action: string,
): void {
  if (state.modified && confirm !== true) {
    throw new TvMcpError(
      'CONFIRMATION_REQUIRED',
      `${action} would replace the unsaved text in the Pine Editor`,
      {
        hint: 'Pass confirm: true to replace it, or save it first with pine_save.',
        details: { action },
      },
    );
  }
}
