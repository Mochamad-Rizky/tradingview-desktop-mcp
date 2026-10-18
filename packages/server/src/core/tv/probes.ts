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

// Whether the app of a chart tab is up, for the health report. The app counts as ready once the tab
// has its API and the API says the app is connected to the data servers (reverse-engineering
// notes, sections 3.3 and 4.2). `connected` is null when the API cannot tell: a build without
// isConnected, one where it throws, or one that answers something else than a boolean. That is
// not the same as being disconnected, so the report keeps the two apart.
export function readAppState(win: TvWindow): {
  apiPresent: boolean;
  connected: boolean | null;
  buildTime: string | null;
} {
  const api = win.TradingViewApi;
  let connected: boolean | null = null;
  if (api !== undefined) {
    try {
      const answer: unknown = api.isConnected();
      if (typeof answer === 'boolean') {
        connected = answer;
      }
    } catch {
      // An app whose isConnected is missing or throws cannot say, which is not the same as no.
    }
  }
  const buildTime = win.BUILD_TIME;
  return {
    apiPresent: api !== undefined,
    connected,
    buildTime: typeof buildTime === 'string' ? buildTime : null,
  };
}
