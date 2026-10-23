import { createCriConnector } from '../../src/core/cdp/cri-connector.js';
import {
  findChartTargets,
  findNewTabPages,
  findWindowChromeTarget,
} from '../../src/core/cdp/targets.js';
import type { CdpSession } from '../../src/core/cdp/types.js';
import type { TvWindow } from '../../src/core/tv/tv-window.js';
import { sleep } from '../../src/utils/timeout.js';
import {
  callFailure,
  callOk,
  describeFailure,
  e2eEnabled,
  HarnessError,
  observe,
  optedIn,
  readWindowVisibility,
  startE2eServer,
  type E2eServer,
} from './setup.js';

// The tab tools against the real TradingView Desktop. The tabs of the window hold the user's
// layouts: tab_list only reads them, and no test switches away from the user's chart tab for good
// or closes a tab of the user's. With TV_E2E_ALLOW_TABS=1, and only while the window is in view
// (tab_close refuses while it is covered, and the test could then not close its own tab), a test
// opens one tab on the New tab page, switches between it and the chart tab a few times and closes
// it, ending on the chart tab. While it does, a watcher of its own reads, on separate debugging
// connections, which tab the strip shows in front and the visibility of the chart page, to measure
// how long the page takes to follow the strip. The New tab page is never connected to, and the window
// chrome is only read through its DOM. Titles of tabs are compared, never printed: they show the
// user's symbols, prices and layout names.

interface ListedTab {
  id: string;
  index: number;
  title: string;
  active: boolean;
  openedBySession: boolean;
}

// One reading of the watcher: when, which tab the strip shows in front, and what the chart page
// says of its visibility.
interface Sample {
  t: number;
  front: string | null;
  chart: string | null;
}

// What the strip shows of each tab, by structure and length only: whether it shows a symbol
// (span.symbol, the first part of the title of a chart tab), how long its text is, a layout name, a
// logo and a close button, and the length of the whole title. It reads the DOM of the window chrome
// and nothing else.
function readTabStructure(win: TvWindow): {
  id: string;
  active: boolean;
  hasSymbol: boolean;
  symbolLength: number | null;
  hasLayoutName: boolean;
  layoutNameLength: number | null;
  hasLogo: boolean;
  hasCloseButton: boolean;
  titleLength: number;
}[] {
  const doc = win.document as unknown as Document;
  return Array.from(doc.querySelectorAll('div.tabs-container > div.tab')).map((tab) => {
    const symbol = tab.querySelector('span.symbol');
    const layout = tab.querySelector('span.layout-name');
    return {
      id: tab.id,
      active: tab.classList.contains('active'),
      hasSymbol: symbol !== null,
      symbolLength: symbol === null ? null : symbol.textContent.trim().length,
      hasLayoutName: layout !== null,
      layoutNameLength: layout === null ? null : layout.textContent.trim().length,
      hasLogo: tab.querySelector('img.logo-image') !== null,
      hasCloseButton: tab.querySelector('button.tab-close-button') !== null,
      titleLength: (tab.querySelector('.tab-title')?.textContent ?? '').trim().length,
    };
  });
}

// The expressions of the watcher: the id of the tab the strip shows in front (a DOM read of the
// window chrome), and the visibility of the chart page.
const FRONT_TAB = "document.querySelector('div.tabs-container > div.tab.active')?.id ?? null";
const VISIBILITY = 'document.visibilityState';

// Reads the strip and the chart page every few milliseconds on connections of its own, which the
// tools' resets of their sessions do not touch, until stopped.
async function watchSwitches(e2e: E2eServer): Promise<{ stop(): Promise<Sample[]> }> {
  const targets = await e2e.ctx.connection.targets();
  const chrome = findWindowChromeTarget(targets);
  const charts = findChartTargets(targets);
  const [chart] = charts;
  if (chrome === undefined || chart === undefined || charts.length !== 1) {
    throw new HarnessError('The watcher needs the window chrome and exactly one chart tab');
  }
  const connector = createCriConnector({
    host: e2e.ctx.config.cdpHost,
    port: e2e.ctx.config.cdpPort,
    defaultTimeoutMs: 3000,
  });
  const sessions: CdpSession[] = [];
  const chromeSession = await connector.connect(chrome);
  sessions.push(chromeSession);
  const chartSession = await connector.connect(chart);
  sessions.push(chartSession);
  const samples: Sample[] = [];
  const state = { running: true };
  const read = async (session: CdpSession, expression: string): Promise<string | null> => {
    try {
      const { result } = await session.send(
        'Runtime.evaluate',
        { expression, returnByValue: true },
        { timeoutMs: 1000 },
      );
      return typeof result.value === 'string' ? result.value : null;
    } catch {
      return null;
    }
  };
  const loop = (async () => {
    while (state.running) {
      const t = performance.now();
      const [front, visibility] = await Promise.all([
        read(chromeSession, FRONT_TAB),
        read(chartSession, VISIBILITY),
      ]);
      samples.push({ t, front, chart: visibility });
      await sleep(5);
    }
  })();
  return {
    async stop() {
      state.running = false;
      await loop;
      await Promise.all(sessions.map((session) => session.close().catch(() => undefined)));
      return samples;
    },
  };
}

// How long the chart page took to follow the strip in one switch: the first reading where the strip
// shows `to` in front, and the first one after the start where the chart page reports `visibility`.
// Negative when the page changed first; null when either did not change while watched.
function lagOf(
  samples: readonly Sample[],
  to: string,
  visibility: 'visible' | 'hidden',
): { stripMs: number | null; pageMs: number | null; lagMs: number | null } {
  const start = samples[0]?.t ?? 0;
  const strip = samples.find(({ front }) => front === to);
  const page = samples.find(({ chart }) => chart === visibility);
  return {
    stripMs: strip === undefined ? null : Math.round(strip.t - start),
    pageMs: page === undefined ? null : Math.round(page.t - start),
    lagMs: strip === undefined || page === undefined ? null : Math.round(page.t - strip.t),
  };
}

describe.skipIf(!e2eEnabled())('the tab tools against TradingView Desktop', () => {
  let e2e: E2eServer | undefined;

  beforeAll(async () => {
    e2e = await startE2eServer();
  });

  afterAll(async () => {
    await e2e?.close();
  });

  function server(): E2eServer {
    if (e2e === undefined) {
      throw new Error('The server did not start');
    }
    return e2e;
  }

  async function listTabs(): Promise<ListedTab[]> {
    return (await callOk<{ tabs: ListedTab[] }>(server().client, 'tab_list')).data.tabs;
  }

  async function structure() {
    const chrome = await server().ctx.connection.windowChromePage();
    return chrome.bridge.evaluate(readTabStructure, []);
  }

  test('lists the tabs of the window', async () => {
    const tabs = await listTabs();
    expect(tabs.length).toBeGreaterThan(0);
    expect(tabs.filter(({ active }) => active).length).toBe(1);
    tabs.forEach((tab, index) => {
      expect(tab.index).toBe(index);
      expect(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tab.id)).toBe(
        true,
      );
      expect(typeof tab.title).toBe('string');
      expect(tab.openedBySession).toBe(false);
    });
    const shown = await structure();
    observe('tabs of the window', {
      tabs: tabs.length,
      titled: tabs.filter(({ title }) => title !== '').length,
      structure: shown.map((tab) => ({
        active: tab.active,
        hasSymbol: tab.hasSymbol,
        symbolNonEmpty: tab.symbolLength === null ? null : tab.symbolLength > 0,
        hasLayoutName: tab.hasLayoutName,
        layoutNameNonEmpty: tab.layoutNameLength === null ? null : tab.layoutNameLength > 0,
        hasLogo: tab.hasLogo,
        hasCloseButton: tab.hasCloseButton,
        titleNonEmpty: tab.titleLength > 0,
      })),
      windowChrome: await readWindowVisibility(server().ctx),
    });
  });

  test('refuses to close the only tab, or a tab of the user without confirm', async () => {
    const { client } = server();
    const tabs = await listTabs();
    const front = tabs.find(({ active }) => active);
    if (front === undefined) {
      throw new Error('tab_list reports no tab in front');
    }
    // Refused before anything is clicked, either way.
    const refused = await callFailure(client, 'tab_close', { tabId: front.id });
    expect(refused.code).toBe(tabs.length === 1 ? 'NOT_AVAILABLE' : 'CONFIRMATION_REQUIRED');
    const unknown = await callFailure(client, 'tab_switch', { index: tabs.length });
    expect(unknown.code).toBe('INVALID_INPUT');
    const same = await callOk<{ id: string; changed: boolean }>(client, 'tab_switch', {
      tabId: front.id,
    });
    expect(same.data.changed).toBe(false);
    expect((await listTabs()).length).toBe(tabs.length);
  });

  test('opens a New tab page, switches between it and the chart tab, and closes it', async (context) => {
    const e2eServer = server();
    const { client, ctx } = e2eServer;
    if (!optedIn('TV_E2E_ALLOW_TABS')) {
      return context.skip(
        'The test opens a tab that a run cut short leaves open; set TV_E2E_ALLOW_TABS=1 to allow it',
      );
    }
    if ((await readWindowVisibility(ctx)) !== 'visible') {
      return context.skip(
        'The TradingView window is out of view (its window chrome reports hidden): tab_close ' +
          'refuses then, so the test could not close the tab it opens; bring the window into view',
      );
    }
    const before = await listTabs();
    const original = before.find(({ active }) => active);
    const targets = await ctx.connection.targets();
    if (original === undefined || findChartTargets(targets).length !== 1) {
      return context.skip(
        'The test needs exactly one chart tab in front, so that the watcher reads its page',
      );
    }
    if (findNewTabPages(targets).length > 0) {
      return context.skip('A New tab page is open already, which the test could take for its own');
    }

    let opened: string | null = null;
    const lags: { to: 'new' | 'chart'; via: string; lag: ReturnType<typeof lagOf> }[] = [];
    let newTabShape: ReturnType<typeof readTabStructure>[number] | undefined;
    let chartTabShape: ReturnType<typeof readTabStructure>[number] | undefined;
    let failure: unknown;
    let failed = false;

    // One tool call that changes the tab in front, watched from before it until a while after it.
    // `target` names the tab that comes to the front, from the answer of the call when need be.
    const watched = async <T>(
      to: 'new' | 'chart',
      via: string,
      call: () => Promise<T>,
      target: (answer: T | undefined) => string,
    ): Promise<T> => {
      const watcher = await watchSwitches(e2eServer);
      let answer: T | undefined;
      try {
        answer = await call();
        await sleep(1500);
        return answer;
      } finally {
        const samples = await watcher.stop();
        lags.push({
          to,
          via,
          lag: lagOf(samples, target(answer), to === 'new' ? 'hidden' : 'visible'),
        });
      }
    };

    try {
      const made = await watched(
        'new',
        'tab_new',
        async () => {
          const answer = await callOk<{ id: string; index: number }>(client, 'tab_new');
          opened = answer.data.id;
          return answer;
        },
        (answer) => answer?.data.id ?? '',
      );
      expect(made.warnings.length === 0, 'tab_new gives no warning').toBe(true);
      const tabs = await listTabs();
      expect(tabs.length).toBe(before.length + 1);
      const mine = tabs.find(({ id }) => id === opened);
      expect(mine?.active).toBe(true);
      expect(mine?.openedBySession).toBe(true);
      const shapes = await structure();
      newTabShape = shapes.find(({ id }) => id === opened);
      chartTabShape = shapes.find(({ id }) => id === original.id);
      expect(findNewTabPages(await ctx.connection.targets()).length).toBe(1);
      // No chart is in front: the chart tools say so.
      const noChart = await callFailure(client, 'chart_get_state');
      expect(noChart.code).toBe('TARGET_NOT_FOUND');

      for (let round = 0; round < 2; round += 1) {
        const back = await watched(
          'chart',
          'tab_switch',
          () => callOk<{ changed: boolean }>(client, 'tab_switch', { tabId: original.id }),
          () => original.id,
        );
        expect(back.data.changed).toBe(true);
        expect(back.warnings.length === 0, 'tab_switch gives no warning').toBe(true);
        await callOk(client, 'chart_get_state');
        const ahead = await watched(
          'new',
          'tab_switch',
          () => callOk<{ changed: boolean }>(client, 'tab_switch', { tabId: opened ?? '' }),
          () => opened ?? '',
        );
        expect(ahead.data.changed).toBe(true);
      }
      // Closed while it is in front; the shell then brings a neighbour to the front.
      const closed = await watched(
        'chart',
        'tab_close',
        () =>
          callOk<{ closed: string; remaining: number }>(client, 'tab_close', {
            tabId: opened ?? '',
          }),
        () => original.id,
      );
      expect(closed.data).toEqual({ closed: opened, remaining: before.length });
      opened = null;
    } catch (error) {
      failure = error;
      failed = true;
    }

    // However the test ended: the test's own tab is closed, the one tab_list says this session opened
    // and that was not there before, never another one, and the chart tab of before goes back to the
    // front.
    const failures: string[] = [];
    try {
      const now = await listTabs();
      const own = now.filter(
        ({ id, openedBySession }) =>
          (openedBySession || id === opened) && !before.some((tab) => tab.id === id),
      );
      for (const tab of own) {
        try {
          await callOk(client, 'tab_close', { tabId: tab.id });
        } catch (error) {
          failures.push(
            `The test could not close the tab it opened (${describeFailure(error)}): close the ` +
              'New tab page in TradingView',
          );
        }
      }
      const after = await listTabs();
      if (!after.some(({ id, active }) => id === original.id && active)) {
        try {
          await callOk(client, 'tab_switch', { tabId: original.id });
        } catch (error) {
          failures.push(
            `The chart tab of before could not be brought back to the front (${describeFailure(error)})`,
          );
        }
      }
      const left = await listTabs();
      if (left.length !== before.length) {
        failures.push(
          `The window has ${String(left.length)} tabs after the test and had ${String(before.length)} before`,
        );
      }
    } catch (error) {
      failures.push(describeFailure(error));
    }
    observe('tab switches: the chart page following the strip', {
      switches: lags.map(({ to, via, lag }) => ({ to, via, ...lag })),
      maxLagMs: Math.max(
        ...lags.map(({ lag }) => lag.lagMs ?? Number.NEGATIVE_INFINITY),
        Number.NEGATIVE_INFINITY,
      ),
    });
    observe('a New tab page tab against a chart tab in the strip', {
      newTab:
        newTabShape === undefined
          ? null
          : {
              hasSymbol: newTabShape.hasSymbol,
              symbolLength: newTabShape.symbolLength,
              hasLayoutName: newTabShape.hasLayoutName,
              layoutNameLength: newTabShape.layoutNameLength,
              hasLogo: newTabShape.hasLogo,
              hasCloseButton: newTabShape.hasCloseButton,
              titleNonEmpty: newTabShape.titleLength > 0,
            },
      chartTab:
        chartTabShape === undefined
          ? null
          : {
              hasSymbol: chartTabShape.hasSymbol,
              symbolNonEmpty: (chartTabShape.symbolLength ?? 0) > 0,
              hasLayoutName: chartTabShape.hasLayoutName,
              hasLogo: chartTabShape.hasLogo,
              hasCloseButton: chartTabShape.hasCloseButton,
            },
    });
    if (failed) {
      if (failures.length > 0) {
        console.error(`The tab test could not clean up after it failed: ${failures.join('; ')}`);
      }
      throw failure;
    }
    if (failures.length > 0) {
      throw new HarnessError(`The tab test could not clean up: ${failures.join('; ')}`);
    }
  });
});
