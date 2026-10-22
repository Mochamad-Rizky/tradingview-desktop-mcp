import { isTvMcpError, TvMcpError } from '../errors.js';
import type { CdpTargetInfo } from './types.js';

export type TargetKind = 'chart' | 'window-chrome' | 'helper' | 'blank' | 'other';

// What `document.visibilityState` of a tab reported, or 'unknown' when it could not be read.
export type Visibility = 'visible' | 'hidden' | 'unknown';

// Each tab of the app is a page on tradingview.com/chart/. The optional label admits regional hosts
// such as in.tradingview.com; the anchors keep look-alikes like tradingview.com.example.net out.
const CHART_URL = /^https:\/\/([a-z0-9-]+\.)?tradingview\.com\/chart\//;

const WINDOW_CHROME_PATH = '/app/window/index.html';

// TradingView's own New tab page, the start page a new tab opens on for a signed-in user
// (reverse-engineering notes of Plan 3, section 3.2): a local page that shows no chart.
const NEW_TAB_PAGE_PATH = '/app/new-tab/index.html';

// TradingView Desktop names itself in the user agent of its debug port, twice (TradingView/3.4.1 …
// TVDesktop/3.4.1). Another browser that holds the port, such as a Chrome started with a debug port
// of its own, names neither, even when a tab of it shows a chart of tradingview.com.
const TRADINGVIEW_USER_AGENT = /(?:^|[\s(;])(?:TradingView|TVDesktop)\/\S/;

export function isTradingViewUserAgent(userAgent: string): boolean {
  return TRADINGVIEW_USER_AGENT.test(userAgent);
}

// Only the path counts. The query after it is data handed to the renderer, and it must not decide
// what kind of page this is.
function pathOf(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

function isWindowChrome(url: string): boolean {
  return pathOf(url).includes(WINDOW_CHROME_PATH);
}

export function classifyTarget(target: CdpTargetInfo): TargetKind {
  // Iframes (ad and anti-abuse frames inside the chart page) and workers are listed next to the
  // pages, but none of them is a renderer to drive.
  if (target.type !== 'page') {
    return 'other';
  }
  const { url } = target;
  if (CHART_URL.test(url)) {
    return 'chart';
  }
  // The app keeps two pages with an empty URL that have no execution context, so evaluating
  // anything on them never returns. They get a kind of their own so that callers can skip them.
  if (url === '') {
    return 'blank';
  }
  if (url.startsWith('file://')) {
    return isWindowChrome(url) ? 'window-chrome' : 'helper';
  }
  return 'other';
}

export function findChartTargets(list: CdpTargetInfo[]): CdpTargetInfo[] {
  return list.filter((target) => classifyTarget(target) === 'chart');
}

export function findWindowChromeTarget(list: CdpTargetInfo[]): CdpTargetInfo | undefined {
  return list.find((target) => classifyTarget(target) === 'window-chrome');
}

// Whether a target is the page of a tab on TradingView's New tab page. To classifyTarget it is a
// helper page like the others the app loads from its own files. Its renderer has Node integration,
// like the window chrome, so it is told by its URL in the target list alone: the server never
// connects to it, let alone runs anything in it.
export function isNewTabPage(target: CdpTargetInfo): boolean {
  return (
    target.type === 'page' &&
    target.url.startsWith('file://') &&
    pathOf(target.url).includes(NEW_TAB_PAGE_PATH)
  );
}

export function findNewTabPages(list: CdpTargetInfo[]): CdpTargetInfo[] {
  return list.filter(isNewTabPage);
}

// The refusal of a chart tool while a New tab page is open and no chart tab reports itself visible:
// the tab in front shows no chart, and the chart tabs behind it are not the one the user looks at.
// It lists the chart tabs with what each reported, and says newTabPage, which
// isNoChartInFrontError reads.
function noChartInFront(
  candidates: CdpTargetInfo[],
  visibility: ReadonlyMap<string, Visibility>,
): TvMcpError {
  return new TvMcpError('TARGET_NOT_FOUND', 'The active tab of TradingView shows no chart', {
    hint:
      'Bring a tab that shows a chart to the front with tab_switch (tab_list lists the tabs). ' +
      "A tab on TradingView's New tab page shows none: open a layout there, or close it with " +
      'tab_close.',
    details: {
      newTabPage: true,
      tabs: candidates.map(({ id, url }) => ({
        id,
        url,
        visibility: visibility.get(id) ?? 'unknown',
      })),
    },
  });
}

// Whether `error` is the refusal of pickChartTarget while a New tab page is open and no chart tab
// is in front.
export function isNoChartInFrontError(error: unknown): error is TvMcpError {
  return (
    isTvMcpError(error) && error.code === 'TARGET_NOT_FOUND' && error.details?.newTabPage === true
  );
}

// Whether every chart tab that refusal lists reported itself hidden, so that none of them can be
// the tab in front: one whose visibility could not be read might be. True when it lists none.
export function isEveryChartTabHidden(error: TvMcpError): boolean {
  const tabs = error.details?.tabs;
  return (
    Array.isArray(tabs) &&
    tabs.every(
      (tab) =>
        typeof tab === 'object' &&
        tab !== null &&
        !Array.isArray(tab) &&
        tab.visibility === 'hidden',
    )
  );
}

// Chooses the tab to control among the chart tabs. Guessing would send commands such as a symbol
// change to the wrong chart, so anything but a single visible tab is an error that lists the tabs
// for the caller to resolve.
//
// A lone chart tab needs no tie-break, unless a New tab page is open (newTabPageOpen): that page may
// be the tab in front, and only one tab is in front, so the lone chart tab counts only when it
// reports itself visible. Then no chart tab that reports itself visible means that the tab in front
// shows no chart, which is refused as such (isNoChartInFrontError), with or without chart tabs.
export function pickChartTarget(
  candidates: CdpTargetInfo[],
  visibility: ReadonlyMap<string, Visibility>,
  newTabPageOpen = false,
): CdpTargetInfo {
  const [first, ...others] = candidates;
  if (first === undefined && !newTabPageOpen) {
    throw new TvMcpError('TARGET_NOT_FOUND', 'No TradingView chart tab is open', {
      hint:
        'Open a chart tab in TradingView Desktop (a tab that shows a chart, not the home page), ' +
        'then try again.',
    });
  }
  // A lone tab needs no tie-break, and its visibility may not have been read at all.
  if (first !== undefined && others.length === 0 && !newTabPageOpen) {
    return first;
  }
  const [onlyVisible, ...moreVisible] = candidates.filter(
    (candidate) => visibility.get(candidate.id) === 'visible',
  );
  if (onlyVisible !== undefined && moreVisible.length === 0) {
    return onlyVisible;
  }
  if (newTabPageOpen && onlyVisible === undefined) {
    throw noChartInFront(candidates, visibility);
  }
  throw new TvMcpError(
    'TARGET_NOT_FOUND',
    `${String(candidates.length)} chart tabs are open and it is unclear which one to use`,
    {
      hint:
        'Focus the chart tab you want to control in TradingView Desktop, so that it is the only ' +
        'visible one, then try again.',
      details: { tabs: candidates.map(({ id, url }) => ({ id, url })) },
    },
  );
}
