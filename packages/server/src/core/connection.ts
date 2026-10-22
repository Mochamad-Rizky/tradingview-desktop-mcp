import { retry } from '../utils/retry.js';
import { withTimeout } from '../utils/timeout.js';
import {
  findChartTargets,
  findWindowChromeTarget,
  isNewTabPage,
  isNoChartInFrontError,
  isTradingViewUserAgent,
  pickChartTarget,
  type Visibility,
} from './cdp/targets.js';
import type { CdpConnector, CdpDiscovery, CdpSession, CdpTargetInfo } from './cdp/types.js';
import { isTvMcpError, TvMcpError } from './errors.js';
import type { Logger } from './logger.js';
import { createPageBridge, type PageBridge } from './tv/page-bridge.js';
import { readAppState, readVisibilityState } from './tv/probes.js';

// The one owner of the CDP sessions of the server. A tool asks for the page it works on, the chart
// tab or the window chrome, and gets a session and a bridge that are shared with every other caller
// for as long as the session lives. Nothing else in the server opens a session to the app.

// A page with its debugging session open. The same handle goes to every caller, so it is read-only.
// `target` is the target as it was listed when the session opened: its url and title can change
// afterwards (opening another layout in the tab changes the url), so list the targets for those.
// A handle is good until its session closes; ask the manager again for the next call.
export interface PageHandle {
  readonly target: CdpTargetInfo;
  readonly session: CdpSession;
  readonly bridge: PageBridge;
}

// What is known about the app, from the debug port inwards. A step that was not reached leaves its
// part at the defaults (not reachable, no chart tab, not ready), and the optional members are
// absent when they are not known:
// - cdp.browser and cdp.userAgent: as the debug port names them, once it answered.
// - cdp.otherBrowser: true when another browser answers on the debug port, such as a Chrome started
//   with a debug port of its own: its user agent names no TradingView. cdp.reachable is false then,
//   since TradingView cannot be reached there, and nothing of that browser is listed or read.
// - chart.tabs: the chart tabs open, whichever of them is in use. chart.url is the url of the tab
//   that was read, or of the only tab; it is absent when several are open and none was chosen.
// - chart.inBackground: true when the chart tabs are all behind a tab that shows no chart, such as
//   TradingView's New tab page, in a window in view (isNoChartInFrontError); absent otherwise.
// - app.ready: the tab has the app's API and the API says it is connected. app.connected is what
//   the API said, and is absent when there is no API or it could not say. app.buildTime is null
//   when the page does not state its build.
export interface HealthReport {
  cdp: {
    reachable: boolean;
    endpoint: string;
    browser?: string;
    userAgent?: string;
    otherBrowser?: boolean;
  };
  chart: { found: boolean; tabs: number; url?: string; inBackground?: boolean };
  app: { ready: boolean; connected?: boolean; buildTime?: string | null };
}

export interface ConnectionManagerDeps {
  discovery: CdpDiscovery;
  connector: CdpConnector;
  logger: Logger;
  // Bounds a page function and a health check. It is not validated here, because the configuration
  // already limits it to what a timer can honor.
  callTimeoutMs: number;
  // Where the debug port is, as the health report shows it.
  endpoint: string;
  // Replaceable so that tests can check the retry backoff without waiting and without randomness.
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

// Reading document.visibilityState is a single property read, so a tab that needs longer than this
// is not answering at all, like a page that is frozen or has no execution context.
const VISIBILITY_PROBE_TIMEOUT_MS = 1500;

// A refused connection is worth three more tries. The delays are small (at most 100, 200 and 400
// ms) because the usual cause is a tab that closed between the listing and the connection, or an
// app that is still starting, and the launcher does the long waiting for the latter.
const CONNECT_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 100;
const RETRY_MAX_DELAY_MS = 400;

// What a call gets when another browser answers on the debug port. Its pages are not the app's, not
// even one that shows a chart of tradingview.com, so none of them is listed or opened. The launcher
// refuses with it too: TradingView could not open its debug port on a port that is taken.
export function otherBrowserOnPort(endpoint: string, browser: string | undefined): TvMcpError {
  return new TvMcpError(
    'CDP_UNREACHABLE',
    `Another browser answers on the debug port at ${endpoint}, not TradingView Desktop`,
    {
      hint:
        'Another browser holds the debug port: quit it, or set TV_CDP_PORT (--cdp-port) to a ' +
        'free port and start this server again, so that TradingView can open its debug port there.',
      details: { endpoint, ...(browser === undefined ? {} : { browser }), otherBrowser: true },
    },
  );
}

export function isOtherBrowserError(error: unknown): boolean {
  return (
    isTvMcpError(error) && error.code === 'CDP_UNREACHABLE' && error.details?.otherBrowser === true
  );
}

// Only a debug port that does not answer is retried. A timeout means the app is stuck, and trying
// again would only wait as long again; another browser on the port does not go away by waiting
// either; every other failure is not one that waiting cures.
function isUnreachable(error: unknown): error is TvMcpError {
  return isTvMcpError(error) && error.code === 'CDP_UNREACHABLE' && !isOtherBrowserError(error);
}

// Logs carry codes and ids only. The message of a failure that came from a page can carry what the
// page said, so it stays out.
function failureCode(error: unknown): string {
  return isTvMcpError(error) ? error.code : 'UNEXPECTED';
}

function managerClosed(): TvMcpError {
  return new TvMcpError('INTERNAL', 'The connection manager has been closed', {
    hint: 'The server is shutting down. Start it again to reach TradingView.',
  });
}

function windowChromeMissing(): TvMcpError {
  return new TvMcpError('TARGET_NOT_FOUND', 'The TradingView window chrome was not found', {
    hint:
      'Open a TradingView Desktop window and try again. The window chrome is the page that holds ' +
      'the tab strip, and the app has none while it has no window.',
  });
}

async function closeSession(session: CdpSession): Promise<void> {
  try {
    await session.close();
  } catch {
    // The caller is done with the session and cannot do anything for one that will not close.
  }
}

// Waits for a connection that is still opening, so that the session it yields is closed too. One
// that failed has nothing to close.
async function closeQuietly(page: Promise<PageHandle>): Promise<void> {
  let handle: PageHandle;
  try {
    handle = await page;
  } catch {
    return;
  }
  await closeSession(handle.session);
}

export class ConnectionManager {
  // One entry per target, from the moment a connection to it is asked for until its session closes.
  // The entry is the promise, so a call that arrives while a connection is opening waits for that
  // one instead of opening another. Input is serialized per session object, so a target must
  // never have two live sessions.
  private readonly pages = new Map<string, Promise<PageHandle>>();
  // The resolution of the chart tab that is running, if any. See chartPage.
  private chartFlight: Promise<PageHandle> | undefined;
  // How many listings were asked for, and the newest of them that has been applied.
  private listingsAsked = 0;
  private listingApplied = 0;
  private closed = false;
  private closing: Promise<void> | undefined;

  private readonly discovery: CdpDiscovery;
  private readonly connector: CdpConnector;
  private readonly logger: Logger;
  private readonly callTimeoutMs: number;
  private readonly endpoint: string;
  private readonly sleep: ConnectionManagerDeps['sleep'];
  private readonly random: ConnectionManagerDeps['random'];

  constructor(deps: ConnectionManagerDeps) {
    this.discovery = deps.discovery;
    this.connector = deps.connector;
    this.logger = deps.logger;
    this.callTimeoutMs = deps.callTimeoutMs;
    this.endpoint = deps.endpoint;
    this.sleep = deps.sleep;
    this.random = deps.random;
  }

  // The targets the app lists right now, with the errors of CdpDiscovery. A session whose target is
  // not among them any more is closed and forgotten, since the tab it belonged to is gone. Another
  // browser on the debug port is refused before anything of it is listed (otherBrowserOnPort), and
  // the port is asked which program it is every time, since that can change between two calls.
  async targets(): Promise<CdpTargetInfo[]> {
    const version = await this.discovery.version();
    if (!isTradingViewUserAgent(version.userAgent)) {
      throw otherBrowserOnPort(this.endpoint, version.browser);
    }
    return this.listTargets();
  }

  private async listTargets(): Promise<CdpTargetInfo[]> {
    this.listingsAsked += 1;
    const asked = this.listingsAsked;
    const listed = await this.discovery.targets();
    // Answers can arrive in another order than they were asked for, and the older one then knows
    // less: a tab that opened in between is missing from it, and its session must not be dropped.
    if (asked > this.listingApplied) {
      this.listingApplied = asked;
      this.dropVanished(listed);
    }
    return listed;
  }

  // The chart tab to work on. It is TARGET_NOT_FOUND when no chart tab is open, or when several are
  // and none or more than one is the one the user is looking at (the error lists them), and while
  // TradingView's New tab page is open, when no chart tab is the one in front (see chooseChart). A
  // debug port that does not answer is retried three times first.
  chartPage(): Promise<PageHandle> {
    // A call that arrives while another one is resolving joins it. Choosing among several tabs
    // opens sessions to look at them and closes those it does not keep, so two resolutions running
    // at once could close a session the other one is about to hand out.
    this.chartFlight ??= this.retrying(() => this.resolveChart()).finally(() => {
      this.chartFlight = undefined;
    });
    return this.chartFlight;
  }

  // The window chrome, which holds the tab strip: TARGET_NOT_FOUND when the app has no window.
  windowChromePage(): Promise<PageHandle> {
    return this.retrying(() => this.resolveWindowChrome());
  }

  // What can be said about the app and how far it got, which is never an error: a problem is part
  // of the report. It answers within the call timeout, because the launcher and the doctor command
  // ask while the app is starting or stuck, and a report that came late would be of no use.
  async health(): Promise<HealthReport> {
    const report: HealthReport = {
      cdp: { reachable: false, endpoint: this.endpoint },
      chart: { found: false, tabs: 0 },
      app: { ready: false },
    };
    try {
      await withTimeout(this.inspect(report), this.callTimeoutMs, 'TradingView health check');
    } catch (error) {
      this.logger.debug({ code: failureCode(error) }, 'The health check ended early');
    }
    // A copy: a check that ran past its deadline goes on writing to `report`, and the caller must
    // not see it change.
    return structuredClone(report);
  }

  // Closes every session, so that the next call connects again. For a caller that has reason to
  // distrust the sessions it has been given.
  async reset(): Promise<void> {
    await this.dropAll('reset');
  }

  // Closes every session for good: later calls are refused, and a connection that was still
  // opening is closed when it arrives. It may be called again.
  close(): Promise<void> {
    this.closing ??= this.shutDown();
    return this.closing;
  }

  private async shutDown(): Promise<void> {
    this.closed = true;
    await this.dropAll('close');
  }

  private assertOpen(): void {
    if (this.closed) {
      throw managerClosed();
    }
  }

  // The whole resolution is retried, the listing included, because a refused connection is often
  // a tab that is gone, and only a new listing says so.
  private retrying<T>(resolve: () => Promise<T>): Promise<T> {
    return retry(resolve, {
      retries: CONNECT_RETRIES,
      baseDelayMs: RETRY_BASE_DELAY_MS,
      maxDelayMs: RETRY_MAX_DELAY_MS,
      shouldRetry: (error) => {
        const again = isUnreachable(error);
        if (again) {
          this.logger.debug({ code: error.code }, 'The debug port did not answer, trying again');
        }
        return again;
      },
      // With exactOptionalPropertyTypes an absent option must stay absent, not become undefined.
      ...(this.sleep === undefined ? {} : { sleep: this.sleep }),
      ...(this.random === undefined ? {} : { random: this.random }),
    });
  }

  private async resolveChart(): Promise<PageHandle> {
    this.assertOpen();
    const listed = await this.targets();
    return this.page(
      await this.chooseChart(findChartTargets(listed), {
        newTabPageOpen: listed.some(isNewTabPage),
        chrome: findWindowChromeTarget(listed),
      }),
    );
  }

  private async resolveWindowChrome(): Promise<PageHandle> {
    this.assertOpen();
    const chrome = findWindowChromeTarget(await this.targets());
    if (chrome === undefined) {
      throw windowChromeMissing();
    }
    return this.page(chrome);
  }

  // The tab to drive. A lone tab needs no question, and the visibility of the others is only read
  // when there is a choice to make: the one the user is looking at reports itself visible.
  //
  // Only the tab in front of the window has its page shown, and its page alone reports itself
  // visible, at least on macOS (notes of Plan 3, section 3.3). TradingView's New tab page shows no
  // chart and has no chart tab, so while one is open (newTabPageOpen), a lone chart tab may be behind
  // it: then the visibility of even a lone tab is read. The New tab page itself is never connected
  // to. While the window is covered by other windows or minimized, every page of it reports hidden,
  // the chart tab in front too, and so does the window chrome (seen on the app): so when no chart tab
  // reports itself visible, the window chrome is asked as well, and pickChartTarget weighs its
  // answer.
  private async chooseChart(
    candidates: CdpTargetInfo[],
    around: { newTabPageOpen: boolean; chrome: CdpTargetInfo | undefined },
  ): Promise<CdpTargetInfo> {
    const { newTabPageOpen } = around;
    if (candidates.length < 2 && !newTabPageOpen) {
      // Hands back the lone tab, and refuses an empty list with the advice to open a chart.
      return pickChartTarget(candidates, new Map());
    }
    // A session this call opens only to look at a tab is closed again unless that tab is the one
    // chosen. One that was cached before belongs to whoever holds its page, so it stays open.
    const withoutSession = candidates.filter(({ id }) => !this.pages.has(id));
    let chosen: CdpTargetInfo | undefined;
    try {
      const visibility = new Map(
        await Promise.all(
          candidates.map(async (candidate) => [candidate.id, await this.probe(candidate)] as const),
        ),
      );
      const anyVisible = [...visibility.values()].includes('visible');
      const chromeVisibility =
        candidates.length > 0 && !anyVisible
          ? await this.windowVisibility(around.chrome)
          : 'unknown';
      // Closing the manager made every probe fail, and "unclear which tab" would not say why.
      this.assertOpen();
      chosen = pickChartTarget(candidates, visibility, { newTabPageOpen, chromeVisibility });
      if (visibility.get(chosen.id) === 'visible') {
        this.logger.debug(
          { targetId: chosen.id, candidates: candidates.length },
          'Chose a chart tab by its visibility',
        );
      } else {
        this.logger.debug(
          { targetId: chosen.id, window: chromeVisibility },
          'Chose the lone chart tab, as the window is not known to be in view',
        );
      }
      return chosen;
    } finally {
      await this.release(withoutSession.filter(({ id }) => id !== chosen?.id));
    }
  }

  // A tab that cannot be read counts as unknown, which keeps it from being chosen. It does not
  // fail the call: the user's tab may well be one of the others.
  private async probe(target: CdpTargetInfo): Promise<Visibility> {
    try {
      const { bridge } = await this.page(target);
      return await bridge.evaluate(readVisibilityState, [], {
        timeoutMs: VISIBILITY_PROBE_TIMEOUT_MS,
      });
    } catch (error) {
      this.logger.debug(
        { targetId: target.id, code: failureCode(error) },
        'Could not read whether a chart tab is visible',
      );
      return 'unknown';
    }
  }

  // The visibility of the window chrome, hidden while the window is covered by other windows or
  // minimized: one read of a property of its document, as for a chart tab. It is unknown without a
  // window chrome or when the page does not answer. The session stays open, as the tools of the tab
  // strip share it, and one that would close under them is worse than one that stays idle.
  private async windowVisibility(chrome: CdpTargetInfo | undefined): Promise<Visibility> {
    if (chrome === undefined) {
      return 'unknown';
    }
    try {
      const { bridge } = await this.page(chrome);
      return await bridge.evaluate(readVisibilityState, [], {
        timeoutMs: VISIBILITY_PROBE_TIMEOUT_MS,
      });
    } catch (error) {
      this.logger.debug(
        { targetId: chrome.id, code: failureCode(error) },
        'Could not read whether the window is in view',
      );
      return 'unknown';
    }
  }

  // The page of a target, with a session that is opened on first use and kept.
  private page(target: CdpTargetInfo): Promise<PageHandle> {
    const existing = this.pages.get(target.id);
    if (existing !== undefined) {
      this.logger.debug({ targetId: target.id }, 'Reusing the CDP session');
      return existing;
    }
    if (this.closed) {
      return Promise.reject(managerClosed());
    }
    const opening: Promise<PageHandle> = this.open(target, () => {
      // Another session may have taken the place of this one by the time it closes.
      if (this.pages.get(target.id) === opening) {
        this.pages.delete(target.id);
        this.logger.debug({ targetId: target.id }, 'Forgetting a CDP session that closed');
      }
    });
    this.pages.set(target.id, opening);
    // A connection that fails leaves nothing behind, so the next call tries again.
    void opening.catch(() => {
      if (this.pages.get(target.id) === opening) {
        this.pages.delete(target.id);
      }
    });
    return opening;
  }

  private async open(target: CdpTargetInfo, onClosed: () => void): Promise<PageHandle> {
    this.logger.debug({ targetId: target.id }, 'Opening a CDP session');
    const session = await this.connector.connect(target);
    if (this.closed) {
      // The manager was closed while the connection was opening, and nobody is left to close it.
      await closeSession(session);
      throw managerClosed();
    }
    session.onClose(onClosed);
    return {
      target,
      session,
      bridge: createPageBridge(session, { timeoutMs: this.callTimeoutMs }),
    };
  }

  // Closes the sessions of some targets and forgets them.
  private async release(targets: readonly CdpTargetInfo[]): Promise<void> {
    const pages: Promise<PageHandle>[] = [];
    for (const { id } of targets) {
      const page = this.pages.get(id);
      if (page !== undefined) {
        this.pages.delete(id);
        pages.push(page);
      }
    }
    await Promise.all(pages.map(closeQuietly));
  }

  private dropVanished(listed: readonly CdpTargetInfo[]): void {
    const present = new Set(listed.map(({ id }) => id));
    for (const [id, page] of this.pages) {
      if (!present.has(id)) {
        this.pages.delete(id);
        this.logger.debug({ targetId: id }, 'Dropping the CDP session of a target that is gone');
        // Not waited for: a listing should not take longer because a peer is slow to close.
        void closeQuietly(page);
      }
    }
  }

  private async dropAll(reason: 'reset' | 'close'): Promise<void> {
    const pages = [...this.pages.values()];
    this.pages.clear();
    this.logger.debug({ sessions: pages.length, reason }, 'Closing every CDP session');
    await Promise.all(pages.map(closeQuietly));
  }

  // Fills `report` step by step, so that when the deadline stops it, what was learned is kept.
  private async inspect(report: HealthReport): Promise<void> {
    const version = await this.discovery.version();
    const answered = {
      endpoint: this.endpoint,
      browser: version.browser,
      userAgent: version.userAgent,
    };
    if (!isTradingViewUserAgent(version.userAgent)) {
      report.cdp = { reachable: false, ...answered, otherBrowser: true };
      return;
    }
    report.cdp = { reachable: true, ...answered };

    const tabs = findChartTargets(await this.listTargets());
    const lone = tabs.length === 1 ? tabs[0] : undefined;
    report.chart = {
      found: tabs.length > 0,
      tabs: tabs.length,
      ...(lone === undefined ? {} : { url: lone.url }),
    };
    if (tabs.length === 0) {
      return;
    }

    // The tab is chosen the way any call chooses it, over the session any call uses; another
    // session to read the app would be a second one to the same target.
    let page: PageHandle;
    try {
      page = await this.chartPage();
    } catch (error) {
      if (isNoChartInFrontError(error)) {
        report.chart = { ...report.chart, inBackground: true };
      }
      throw error;
    }
    const listed = tabs.find(({ id }) => id === page.target.id) ?? page.target;
    report.chart = { found: true, tabs: tabs.length, url: listed.url };

    const state = await page.bridge.evaluate(readAppState, []);
    report.app = {
      ready: state.apiPresent && state.connected === true,
      ...(state.connected === null ? {} : { connected: state.connected }),
      buildTime: state.buildTime,
    };
  }
}
