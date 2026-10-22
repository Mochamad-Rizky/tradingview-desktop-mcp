import type { FakeCdpServer, FakeTarget } from './fake-cdp/server.js';
import { loadTargetsFixture } from './fake-cdp/targets.js';
import type { TvStateFixture } from './fake-tv/fixture.js';
import {
  createFakeWindowChrome,
  type FakeChromeTab,
  type FakeShellAction,
  type FakeTabSize,
  type FakeWindowChrome,
} from './fake-tv/window-chrome.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTvOverrides,
  type FakeTvWindow,
} from './fake-tv/window.js';

// A TradingView window with several tabs behind the fake debug port, for the tests of the tab tools
// and of how the connection manager maps the tab in front to its page (reverse-engineering notes of
// Plan 3, section 3). Values are synthetic.
//
// The window chrome is the strip of window-chrome.ts. Every tab has a page among the targets the
// debug port lists: a tab that shows a chart has a chart page, a fake chart of window.ts on its own
// fixture, and a tab on TradingView's New tab start page has a page at the local URL of that page.
// The rest of the list is the one recorded from the app: its helper pages, its two blank pages, the
// frames of the first chart page and a worker.
//
// As on macOS, where the app throttles the tabs in the background, the chart page of the tab in
// front reports itself visible and every other one hidden; allVisible makes every chart page report
// visible, as on Windows and Linux, where the app does not throttle them. A tab that the shell
// opens shows its New tab page among the targets pageMs after it shows in the strip, and a tab the
// shell closes leaves the list with its page. Closing a chart tab asks its page whether to save
// its layout (shouldBeSaved), and the shell opens its "Close tab?" dialog instead when the page
// says yes.
//
// A New tab page has Node integration, so the server must never connect to one, let alone
// evaluate anything there: newTabPageAccess reports both, and a test fails on either.

export const NEW_TAB_PAGE_URL =
  'file:///Applications/TradingView.app/Contents/Resources/app.asar/app/new-tab/index.html';

// The id the recorded target list gives the window chrome, and its first chart page.
export const WINDOW_CHROME_TARGET_ID = 'EE67363DAA56C9940A709061CFAA2FFF';
const FIRST_CHART_TARGET_ID = 'BBB144A7827AE55CBA0E74986FC9574C';
const CHART_URL_PREFIX = 'https://www.tradingview.com/chart/';

export interface WorldTab {
  id: string;
  // What the tab shows: a chart, built from `fixture` (its layout id names the chart page), or the
  // New tab page.
  kind: 'chart' | 'new-tab';
  fixture?: TvStateFixture;
  overrides?: FakeTvOverrides;
  // The pieces of its title. Default: the symbol and the layout name of the fixture, or "New tab".
  title?: string[];
  pinned?: boolean;
}

export interface TabWorldOptions {
  tabs: WorldTab[];
  // The tab in front. Default: the first.
  active?: string;
  size?: FakeTabSize;
  isLastWindow?: boolean;
  closeButtonOverTitle?: boolean;
  // How long the strip takes to show a change after a click. Default 5 ms; Infinity: never.
  changeMs?: number;
  // How long a new tab takes to show its page among the targets once it shows in the strip.
  // Default 10 ms; Infinity: never.
  pageMs?: number;
  allVisible?: boolean;
  newTabIds?: string[];
}

export interface TabWorld {
  readonly chrome: FakeWindowChrome;
  // The chart page of each chart tab, by the id of the tab.
  readonly charts: ReadonlyMap<string, FakeTvWindow>;
  // The id of the target of a tab's page.
  targetOf(tabId: string): string;
  // The targets the debug port lists now.
  targets(): FakeTarget[];
  // Makes the debug port the world was started with list the pages that open and close.
  attach(app: FakeCdpServer): void;
  // The connections to New tab pages and the CDP methods sent to them: both must stay empty.
  newTabPageAccess(): { connections: number; calls: string[] };
}

// The chart of the fixture under another layout, as a second tab shows it.
export function chartFixture(
  base: TvStateFixture,
  layoutId: string,
  layoutName: string,
  symbol: string,
): TvStateFixture {
  return { ...base, symbol, layout: { ...base.layout, id: layoutId, name: layoutName } };
}

function tickerOf(symbol: string): string {
  return symbol.slice(symbol.lastIndexOf(':') + 1);
}

export function createTabWorld(options: TabWorldOptions): TabWorld {
  const recorded = loadTargetsFixture();
  // The window chrome, the helpers, the blank pages and the worker of the recorded list; the
  // chart page and its frames are replaced by the pages of the tabs, the frames kept for the first.
  const chromeTarget = recorded.find(({ id }) => id === WINDOW_CHROME_TARGET_ID);
  if (chromeTarget === undefined) {
    throw new Error('The recorded target list has no window chrome');
  }
  const frames = recorded.filter(({ parentId }) => parentId === FIRST_CHART_TARGET_ID);
  const others = recorded.filter(
    (target) =>
      target !== chromeTarget &&
      target.id !== FIRST_CHART_TARGET_ID &&
      target.parentId !== FIRST_CHART_TARGET_ID,
  );

  const charts = new Map<string, FakeTvWindow>();
  // The page of each tab, by tab id, kept as the same object while the tab is open: the fake debug
  // port keeps a page for as long as its target object is listed.
  const pages = new Map<string, FakeTarget>();
  let chartPages = 0;
  let newTabPages = 0;
  const allNewTabPageIds: string[] = [];
  let app: FakeCdpServer | undefined;

  const chartTarget = (tab: WorldTab, win: FakeTvWindow): FakeTarget => {
    chartPages += 1;
    const id =
      chartPages === 1 ? FIRST_CHART_TARGET_ID : `C${String(chartPages).padStart(31, '0')}`;
    const layoutId = tab.fixture?.layout.id ?? `TAB${String(chartPages)}`;
    return {
      id,
      type: 'page',
      title: 'Live stock, index, futures, Forex and Bitcoin charts on TradingView',
      url: `${CHART_URL_PREFIX}${layoutId}/`,
      behavior: 'page',
      window: () => win,
    };
  };

  const newTabTarget = (): FakeTarget => {
    newTabPages += 1;
    const id = `7AB${String(newTabPages).padStart(29, '0')}`;
    allNewTabPageIds.push(id);
    return { id, type: 'page', title: 'index.html', url: NEW_TAB_PAGE_URL, behavior: 'page' };
  };

  const addPage = (tab: WorldTab): void => {
    if (tab.kind === 'new-tab') {
      pages.set(tab.id, newTabTarget());
      return;
    }
    if (tab.fixture === undefined) {
      throw new Error(`The chart tab ${tab.id} needs a fixture`);
    }
    const win = createFakeTvWindow(tab.fixture, tab.overrides);
    charts.set(tab.id, win);
    pages.set(tab.id, chartTarget(tab, win));
  };
  for (const tab of options.tabs) {
    addPage(tab);
  }

  const publish = (): void => {
    app?.setTargets(world.targets());
  };

  // As on macOS: the chart page of the tab in front is visible, every other one hidden.
  const showFront = (): void => {
    for (const [tabId, win] of charts) {
      inspectFakeWindow(win).state.visibilityState =
        options.allVisible === true || tabId === chrome.state.active ? 'visible' : 'hidden';
    }
  };

  const changed = (action: FakeShellAction): void => {
    if (action.action === 'new') {
      const pageMs = options.pageMs ?? 10;
      if (pageMs !== Infinity) {
        setTimeout(() => {
          if (chrome.state.tabs.some(({ id }) => id === action.tabId)) {
            pages.set(action.tabId, newTabTarget());
            publish();
          }
        }, pageMs).unref();
      }
    } else if (action.action === 'close') {
      pages.delete(action.tabId);
      charts.delete(action.tabId);
      publish();
    }
    showFront();
  };

  const asksToSave = (tab: FakeChromeTab): boolean => {
    const win = charts.get(tab.id);
    return win?.TradingViewApi?.shouldBeSaved?.() === true;
  };

  const chrome = createFakeWindowChrome({
    tabs: options.tabs.map((tab) => ({
      id: tab.id,
      title:
        tab.title ??
        (tab.kind === 'new-tab' || tab.fixture === undefined
          ? ['New tab']
          : [tickerOf(tab.fixture.symbol), tab.fixture.layout.name]),
      ...(tab.pinned === undefined ? {} : { pinned: tab.pinned }),
    })),
    active: options.active ?? options.tabs[0]?.id ?? '',
    ...(options.size === undefined ? {} : { size: options.size }),
    ...(options.isLastWindow === undefined ? {} : { isLastWindow: options.isLastWindow }),
    ...(options.closeButtonOverTitle === undefined
      ? {}
      : { closeButtonOverTitle: options.closeButtonOverTitle }),
    ...(options.changeMs === undefined ? {} : { changeMs: options.changeMs }),
    ...(options.newTabIds === undefined ? {} : { newTabIds: options.newTabIds }),
    hooks: { asksToSave, changed },
  });
  showFront();

  const windowChrome: FakeTarget = {
    ...chromeTarget,
    window: () => chrome.window,
    handlers: {
      'Input.dispatchMouseEvent': (params) => {
        chrome.dispatchMouseEvent(params);
        return {};
      },
    },
  };

  const world: TabWorld = {
    chrome,
    charts,
    targetOf(tabId) {
      const page = pages.get(tabId);
      if (page === undefined) {
        throw new Error(`The tab ${tabId} has no page`);
      }
      return page.id;
    },
    targets() {
      const tabPages = chrome.state.tabs.flatMap(({ id }) => {
        const page = pages.get(id);
        return page === undefined ? [] : [page];
      });
      const firstChart = tabPages.find(({ id }) => id === FIRST_CHART_TARGET_ID);
      return [windowChrome, ...tabPages, ...(firstChart === undefined ? [] : frames), ...others];
    },
    attach(server) {
      app = server;
    },
    newTabPageAccess() {
      const ids = new Set(allNewTabPageIds);
      return {
        connections: allNewTabPageIds.reduce((sum, id) => sum + (app?.connectionCount(id) ?? 0), 0),
        calls: (app?.calls ?? [])
          .filter(({ targetId }) => ids.has(targetId))
          .map(({ method }) => method),
      };
    },
  };
  return world;
}
