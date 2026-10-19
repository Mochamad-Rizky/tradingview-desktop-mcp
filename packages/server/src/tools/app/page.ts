import type { PageErrorSentinel } from '../../core/tv/page-bridge.js';
import { SELECTORS } from '../../core/tv/selectors.js';
import type { TvdLike, TvWindow } from '../../core/tv/tv-window.js';

// The page functions of the app tools. The page bridge sends the source text of each one into the
// page, so each uses nothing of this module, only its parameters and the globals of the page.
// Whatever it needs to know about the interface is handed in as an argument.

// What the app says about itself, for a tool that wants more than the health report holds. The
// app counts as connected only when isConnected answers true, so an app without that method, or
// one where it throws, is not connected as far as this says. The build time is null when the page
// does not state one, and the layout type is null when the app cannot tell (it is "s" for a single
// chart).
export function readAppInfo(win: TvWindow): {
  buildTime: string | null;
  connected: boolean;
  layoutType: string | null;
  url: string;
} {
  const api = win.TradingViewApi;
  let connected = false;
  let layoutType: string | null = null;
  if (api !== undefined) {
    try {
      const answer: unknown = api.isConnected();
      connected = answer === true;
    } catch {
      // An app whose isConnected is missing or throws cannot say that it is connected.
    }
    try {
      const layout: unknown = api.layout();
      layoutType = typeof layout === 'string' ? layout : null;
    } catch {
      // The same for the layout: an app that is half started has none yet.
    }
  }
  const buildTime = win.BUILD_TIME;
  return {
    buildTime: typeof buildTime === 'string' ? buildTime : null,
    connected,
    layoutType,
    url: win.location.href,
  };
}

// Where readUiState looks, as the notes record it (sections 5.1 to 5.4). The page function cannot
// import the selectors, so they are handed in with every call.
//
// - widgetPages, minPanelWidth: the pages of the right panel, and how wide they are at least once
//   the panel is open. The widget bar holds the toolbar on the right edge too and stays shown while
//   the panel is collapsed, its pages then being a border of 1 px (seen on the app), so the pages
//   tell whether the panel is open; any panel is far wider than the 50 px asked for.
// - widgets: the widgets that can show in the right panel, by the type the page gives them, in the
//   order they are tried. The details of a symbol come last because they show next to the
//   watchlist, which is the one to report when both are there.
// - labelAttributes: the attributes that name a dialog, most telling first. The text of a dialog
//   is never read: it can hold the name of a layout or of a script.
export const UI_STATE_SELECTORS = {
  widgetBar: SELECTORS.widgets.widgetBar,
  widgetPages: SELECTORS.widgets.widgetBarTabs,
  minPanelWidth: 50,
  widgets: {
    watchlist: SELECTORS.widgets.watchlist,
    alerts: SELECTORS.widgets.alerts,
    object_tree: SELECTORS.widgets.objectTree,
    pine_logs: SELECTORS.widgets.pineLogs,
    detail: SELECTORS.widgets.detail,
  },
  bottomArea: SELECTORS.regions.bottomArea,
  overlapRoot: SELECTORS.regions.overlapManagerRoot,
  labelAttributes: ['data-name', 'aria-label', 'role'],
  fullscreenButton: SELECTORS.header.fullscreen,
  replayButton: SELECTORS.header.replay,
  pineEditorButton: SELECTORS.buttons.pineEditor,
};

// Which parts of the interface are open, read from the DOM of the chart tab (design spec 7). It is
// a best-effort reading of a page whose markup is not published, so what it cannot see counts as
// closed:
// - A panel or widget is open when its element has a box and is neither display: none nor
//   visibility: hidden. A page without getComputedStyle is judged by the box alone. The right panel
//   is open when the widget bar is and its pages are at least minPanelWidth wide (a page without
//   such pages is judged by the bar alone), and a widget is reported only while it is open.
// - Fullscreen is on when the browser's own fullscreen mode is, or when the fullscreen button is
//   pressed. The replay toolbar and the Pine Editor are on when their buttons are pressed. A
//   button is pressed when it says so through aria-pressed or aria-selected, whether or not the
//   page shows it, since fullscreen mode hides the toolbars and their buttons still tell what is on.
//   The fullscreen button of the app says neither (seen on the app), and whether the app's own
//   fullscreen mode goes through the browser's was not seen, so that mode can go unseen, and
//   fullscreen is false then.
// - Each layer that #overlap-manager-root holds is a dialog, a menu or a popup, and is listed
//   while it is shown, by the first of data-name, aria-label and role that it or the first named
//   element inside it has, cut to one short line. A layer with nothing to name it by is listed as
//   unnamed, and an empty one is not listed. Text is never read, and neither is any other
//   attribute, because the page can show the names of the user's layouts and scripts in them.
// It answers NOT_AVAILABLE on a page without a DOM.
export function readUiState(
  win: TvWindow,
  selectors: {
    widgetBar: string;
    widgetPages: string;
    minPanelWidth: number;
    widgets: Record<string, string>;
    bottomArea: string;
    overlapRoot: string;
    labelAttributes: string[];
    fullscreenButton: string;
    replayButton: string;
    pineEditorButton: string;
  },
):
  | {
      rightPanel: { open: boolean; activeWidget: string | null };
      bottomPanelOpen: boolean;
      dialogs: string[];
      fullscreen: boolean;
      replayToolbarVisible: boolean;
      pineEditorOpen: boolean;
    }
  | PageErrorSentinel {
  const doc = win.document;
  if (typeof doc.querySelector !== 'function') {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: 'The page has no DOM to read the interface from',
        hint: 'Make sure the target is a loaded TradingView page, not a blank or helper page.',
      },
    };
  }

  const find = (selector: string): Element | null => doc.querySelector?.(selector) ?? null;
  const isShown = (element: Element): boolean => {
    const box = element.getBoundingClientRect();
    if (!element.isConnected || box.width <= 0 || box.height <= 0) {
      return false;
    }
    const style = win.getComputedStyle?.(element);
    return style === undefined || (style.display !== 'none' && style.visibility !== 'hidden');
  };
  const isOpen = (selector: string): boolean => {
    const element = find(selector);
    return element !== null && isShown(element);
  };
  const isPressed = (selector: string): boolean => {
    const element = find(selector);
    return (
      element !== null &&
      (element.getAttribute('aria-pressed') === 'true' ||
        element.getAttribute('aria-selected') === 'true')
    );
  };
  // A name is one short line, so that a long or odd label cannot flood the answer.
  const labelOf = (element: Element): string | null => {
    for (const attribute of selectors.labelAttributes) {
      const text = (element.getAttribute(attribute) ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60)
        .trim();
      if (text !== '') {
        return text;
      }
    }
    return null;
  };

  const panelPages = find(selectors.widgetPages);
  const rightPanelOpen =
    isOpen(selectors.widgetBar) &&
    (panelPages === null ||
      (isShown(panelPages) && panelPages.getBoundingClientRect().width >= selectors.minPanelWidth));
  let activeWidget: string | null = null;
  if (rightPanelOpen) {
    for (const [name, selector] of Object.entries(selectors.widgets)) {
      if (isOpen(selector)) {
        activeWidget = name;
        break;
      }
    }
  }

  const dialogs: string[] = [];
  const root = find(selectors.overlapRoot);
  if (root !== null) {
    const named = selectors.labelAttributes.map((attribute) => `[${attribute}]`).join(', ');
    for (const layer of Array.from(root.children)) {
      // The layer is named itself, or by the first named element inside it.
      let holder: Element | null = layer;
      let label = labelOf(layer);
      if (label === null) {
        holder = layer.querySelector(named);
        label = holder === null ? null : labelOf(holder);
      }
      if (holder === null) {
        if (layer.children.length > 0 && isShown(layer)) {
          dialogs.push('unnamed');
        }
      } else if (isShown(holder)) {
        dialogs.push(label ?? 'unnamed');
      }
    }
  }

  return {
    rightPanel: { open: rightPanelOpen, activeWidget },
    bottomPanelOpen: isOpen(selectors.bottomArea),
    dialogs,
    fullscreen: (doc.fullscreenElement ?? null) !== null || isPressed(selectors.fullscreenButton),
    replayToolbarVisible: isPressed(selectors.replayButton),
    pineEditorOpen: isPressed(selectors.pineEditorButton),
  };
}

// Asks the desktop app to reload this tab, which is the one thing a tool does with the desktop
// bridge (window.TVD) of the page: only reloadTab is looked at, never another member, because the
// bridge also holds the credentials of the user. The reload is only requested here and takes place
// after this returns, so the page that answers is not the page that comes back.
export function reloadTab(win: TvWindow): { requested: true } | PageErrorSentinel {
  const desktop: Partial<TvdLike> | undefined = win.TVD;
  if (typeof desktop?.reloadTab !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no TVD.reloadTab to reload the tab with',
        hint:
          'Only TradingView Desktop offers it. Reload the tab yourself in TradingView, then call ' +
          'app_health to see when the app is ready again.',
      },
    };
  }
  desktop.reloadTab();
  return { requested: true };
}
