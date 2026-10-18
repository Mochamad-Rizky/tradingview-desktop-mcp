import type { Visibility } from '../cdp/targets.js';
import type { TvWindow } from './tv-window.js';

// Page functions: the page bridge sends their source text into the page, so they use nothing of
// this module, only their parameters and the globals of the page.

// Which tab the user is looking at. When several chart tabs are open, the one that reports
// "visible" is the one to drive.
export function readVisibilityState(win: TvWindow): Visibility {
  // Typed as the two states of current browsers, but read from whatever page answers.
  const state: unknown = win.document.visibilityState;
  return state === 'visible' || state === 'hidden' ? state : 'unknown';
}
