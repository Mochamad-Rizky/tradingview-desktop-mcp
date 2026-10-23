import type { PageErrorSentinel } from '../../core/tv/page-bridge.js';
import { SELECTORS } from '../../core/tv/selectors.js';
import type { TvWindow } from '../../core/tv/tv-window.js';

// The page functions of the tab tools. The page bridge sends the source text of each one into the
// page, so each uses nothing of this module, only its parameters and the globals of the page.
// Whatever it needs to know about the interface is handed in as an argument.
//
// readTabs runs in the window chrome, the page with the tab strip, whose renderer has Node
// integration: it reads the DOM there and nothing else. readUnsavedLayout runs in the page of a
// chart tab.

// Where readTabs looks in the tab strip (notes of Plan 3, section 3.1): every tab, in the order of
// the strip, the class of the active one, and in a tab, its title, its symbol and its close button.
export const TAB_STRIP = {
  tabs: SELECTORS.windowChrome.tabs,
  activeTab: SELECTORS.windowChrome.activeTab,
  title: SELECTORS.windowChrome.tabTitle,
  symbol: SELECTORS.windowChrome.tabSymbol,
  closeButton: SELECTORS.windowChrome.tabCloseButton,
};

// A tab as the strip shows it. A type alias, not an interface: it comes back from the page as
// JSON, which a type must satisfy JsonValue for.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type StripTab = {
  id: string;
  title: string;
  active: boolean;
  closable: boolean;
  showsSymbol: boolean;
};

// The tabs of the window, in the order of the strip, which makes the place of a tab in the list
// its index. Of each: its id, the id the shell gives the tab; its title, the text of its title with
// a space between the texts of different elements and every run of white space one space, as the
// symbol, the last price, the change and the name of the layout stand apart on the screen; whether
// it is the active tab; whether it shows its close button, which the shell leaves out on a pinned
// tab, on the only tab of the last window, and on a tab in the background at small widths; and
// whether it shows a symbol, which a chart tab shows in its title and a tab on the New tab page does
// not (seen on the app), told by the length of the symbol and never by its text. Titles are what the
// user named and watches: the caller never logs them. NOT_AVAILABLE on a page without a DOM.
export function readTabs(
  win: TvWindow,
  strip: { tabs: string; activeTab: string; title: string; symbol: string; closeButton: string },
): { tabs: StripTab[] } | PageErrorSentinel {
  const doc = win.document;
  if (typeof doc.querySelectorAll !== 'function') {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: 'The window chrome has no DOM to read the tabs from',
        hint: 'Check app_health: the window of TradingView may still be loading.',
      },
    };
  }
  // The text an element shows: its text nodes, with a space between the pieces of different
  // elements, and every run of white space one space, none at the ends.
  const shown = (element: Element): string => {
    let text = '';
    const collect = (node: Element): void => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) {
          text += (child as CharacterData).data;
        } else if (child.nodeType === 1) {
          text += ' ';
          collect(child as Element);
          text += ' ';
        }
      }
    };
    collect(element);
    return text.replace(/\s+/g, ' ').trim();
  };
  const tabs = Array.from(doc.querySelectorAll(strip.tabs)).map((listed): StripTab => {
    // A real page lists elements, of which the type of the window records only the box.
    const tab = listed as Element;
    const title = tab.querySelector(strip.title);
    const symbol = tab.querySelector(strip.symbol);
    return {
      id: tab.id,
      title: title === null ? '' : shown(title),
      active: tab.matches(strip.activeTab),
      closable: tab.querySelector(strip.closeButton) !== null,
      showsSymbol: symbol !== null && shown(symbol).length > 0,
    };
  });
  return { tabs };
}

// Whether the layout of the chart tab has changes that TradingView asks about when the tab closes:
// TradingViewApi.shouldBeSaved(), which the shell asks the page of a tab before it closes the tab,
// and when it is true, the shell opens its "Close tab?" dialog (notes of Plan 3, section 3.4).
// shouldBeSaved is null when the page cannot say: no API, no such member, a throw, or an answer that
// is not a boolean. Changes nothing.
export function readUnsavedLayout(win: TvWindow): { shouldBeSaved: boolean | null } {
  const api = win.TradingViewApi;
  if (typeof api?.shouldBeSaved !== 'function') {
    return { shouldBeSaved: null };
  }
  try {
    const answer: unknown = api.shouldBeSaved();
    return { shouldBeSaved: typeof answer === 'boolean' ? answer : null };
  } catch {
    return { shouldBeSaved: null };
  }
}
