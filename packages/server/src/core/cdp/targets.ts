import { TvMcpError } from '../errors.js';
import type { CdpTargetInfo } from './types.js';

export type TargetKind = 'chart' | 'window-chrome' | 'helper' | 'blank' | 'other';

// What `document.visibilityState` of a tab reported, or 'unknown' when it could not be read.
export type Visibility = 'visible' | 'hidden' | 'unknown';

// Each tab of the app is a page on tradingview.com/chart/. The optional label admits regional hosts
// such as in.tradingview.com; the anchors keep look-alikes like tradingview.com.example.net out.
const CHART_URL = /^https:\/\/([a-z0-9-]+\.)?tradingview\.com\/chart\//;

const WINDOW_CHROME_PATH = '/app/window/index.html';

// TradingView Desktop names itself in the user agent of its debug port, twice (TradingView/3.4.1 …
// TVDesktop/3.4.1). Another browser that holds the port, such as a Chrome started with a debug port
// of its own, names neither, even when a tab of it shows a chart of tradingview.com.
const TRADINGVIEW_USER_AGENT = /(?:^|[\s(;])(?:TradingView|TVDesktop)\/\S/;

export function isTradingViewUserAgent(userAgent: string): boolean {
  return TRADINGVIEW_USER_AGENT.test(userAgent);
}

// Only the path counts. The query after it is data handed to the renderer, and it must not decide
// what kind of page this is.
function isWindowChrome(url: string): boolean {
  const end = url.search(/[?#]/);
  const path = end === -1 ? url : url.slice(0, end);
  return path.includes(WINDOW_CHROME_PATH);
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

// Chooses the tab to control among the chart tabs. Guessing would send commands such as a symbol
// change to the wrong chart, so anything but a single visible tab is an error that lists the tabs
// for the caller to resolve.
export function pickChartTarget(
  candidates: CdpTargetInfo[],
  visibility: ReadonlyMap<string, Visibility>,
): CdpTargetInfo {
  const [first, ...others] = candidates;
  if (first === undefined) {
    throw new TvMcpError('TARGET_NOT_FOUND', 'No TradingView chart tab is open', {
      hint:
        'Open a chart tab in TradingView Desktop (a tab that shows a chart, not the home page), ' +
        'then try again.',
    });
  }
  // A lone tab needs no tie-break, and its visibility may not have been read at all.
  if (others.length === 0) {
    return first;
  }
  const [onlyVisible, ...moreVisible] = candidates.filter(
    (candidate) => visibility.get(candidate.id) === 'visible',
  );
  if (onlyVisible !== undefined && moreVisible.length === 0) {
    return onlyVisible;
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
