import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { classifyTarget } from '../../../src/core/cdp/targets.js';
import { SELECTORS } from '../../../src/core/tv/selectors.js';
import { startFakeCdpServer } from '../../helpers/fake-cdp/server.js';
import type { FakeDomWindow } from '../../helpers/fake-tv/dom.js';
import { loadTvFixture } from '../../helpers/fake-tv/fixture.js';
import {
  CHROME_SELECTORS,
  tabPartSelector,
  type FakeWindowChrome,
} from '../../helpers/fake-tv/window-chrome.js';
import { inspectFakeWindow, type FakeTvWindow } from '../../helpers/fake-tv/window.js';
import {
  chartFixture,
  createTabWorld,
  NEW_TAB_PAGE_URL,
  WINDOW_CHROME_TARGET_ID,
  type TabWorldOptions,
} from '../../helpers/tab-world.js';

// The fake window of several tabs behind the fake debug port (tab-world.ts) has to list the pages of
// its tabs and change them the way the notes of Plan 3 (section 3) record that TradingView Desktop
// does on macOS, since the tests of the tab tools and of the mapping of tabs to pages trust it to.
// Values are synthetic.

const fixture = loadTvFixture();
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const N = '33333333-3333-4333-8333-333333333333';
const SETTLE_MS = 40;

function worldWith(options: Partial<TabWorldOptions> = {}) {
  return createTabWorld({
    tabs: [
      { id: A, kind: 'chart', fixture },
      {
        id: B,
        kind: 'chart',
        fixture: chartFixture(fixture, 'FIXTURE2', 'Second Layout', 'NASDAQ:MSFT'),
      },
    ],
    ...options,
  });
}

function chartOf(world: { charts: ReadonlyMap<string, FakeTvWindow> }, tabId: string) {
  const win = world.charts.get(tabId);
  if (win === undefined) {
    throw new Error(`No chart page for ${tabId}`);
  }
  return win;
}

const visibilityOf = (win: FakeTvWindow) => inspectFakeWindow(win).state.visibilityState;

function clickPart(chrome: FakeWindowChrome, selector: string): void {
  const element = (chrome.window as FakeDomWindow).document.querySelector?.(selector);
  if (element === null || element === undefined) {
    throw new Error(`Nothing matches ${selector}`);
  }
  const { x, y, width, height } = element.getBoundingClientRect();
  for (const type of ['mousePressed', 'mouseReleased']) {
    chrome.dispatchMouseEvent({
      type,
      x: x + width / 2,
      y: y + height / 2,
      button: 'left',
      clickCount: 1,
    });
  }
}

test('lists the window chrome, a page for every tab and the helper pages the app keeps', () => {
  const world = worldWith({
    tabs: [
      { id: A, kind: 'chart', fixture },
      { id: N, kind: 'new-tab' },
    ],
  });

  const listed = world.targets();
  const kinds = listed.map((target) => [target.id, classifyTarget(target)]);

  expect(listed[0]?.id).toBe(WINDOW_CHROME_TARGET_ID);
  expect(kinds.filter(([, kind]) => kind === 'chart')).toEqual([[world.targetOf(A), 'chart']]);
  expect(listed.find(({ id }) => id === world.targetOf(N))).toMatchObject({
    type: 'page',
    url: NEW_TAB_PAGE_URL,
  });
  expect(listed.find(({ id }) => id === world.targetOf(A))?.url).toBe(
    'https://www.tradingview.com/chart/FIXTURE1/',
  );
  // The helpers, the blank pages, the frames of the first chart and the worker, as recorded.
  expect(listed).toHaveLength(12);
  expect(world.chrome.state.tabs.map(({ title }) => title)).toEqual([
    ['AAPL', 'Fixture Layout'],
    ['New tab'],
  ]);
});

test('the chart page of the tab in front is visible and every other one hidden, as on macOS', async () => {
  const world = worldWith();

  expect([visibilityOf(chartOf(world, A)), visibilityOf(chartOf(world, B))]).toEqual([
    'visible',
    'hidden',
  ]);
  clickPart(world.chrome, tabPartSelector(B, CHROME_SELECTORS.title));
  await delay(SETTLE_MS);

  expect([visibilityOf(chartOf(world, A)), visibilityOf(chartOf(world, B))]).toEqual([
    'hidden',
    'visible',
  ]);
});

test('every page reports hidden while the window is out of view, the tab in front and the window chrome too', () => {
  const world = worldWith({ inView: false });

  expect([visibilityOf(chartOf(world, A)), visibilityOf(chartOf(world, B))]).toEqual([
    'hidden',
    'hidden',
  ]);
  expect(
    (world.chrome.window as { document: { visibilityState: string } }).document.visibilityState,
  ).toBe('hidden');
});

test('with pageLag, the pages hear of a switch later than the strip shows it, and start out as the window shows them', async () => {
  const world = worldWith({ pageLag: { hideMs: 60, showMs: 120 } });
  const both = () => [visibilityOf(chartOf(world, A)), visibilityOf(chartOf(world, B))];

  expect(both()).toEqual(['visible', 'hidden']);
  clickPart(world.chrome, tabPartSelector(B, CHROME_SELECTORS.title));
  await delay(20);
  // The strip shows the switch; the pages still report what they did.
  expect(world.chrome.state.active).toBe(B);
  expect(both()).toEqual(['visible', 'hidden']);
  await delay(70);
  // The page that left the front heard first: for a moment no chart page reports visible.
  expect(both()).toEqual(['hidden', 'hidden']);
  await delay(80);
  expect(both()).toEqual(['hidden', 'visible']);
});

test('with pageLag, a later switch wins over what an earlier one left pending', async () => {
  const world = worldWith({ pageLag: { hideMs: 80, showMs: 80 } });
  const both = () => [visibilityOf(chartOf(world, A)), visibilityOf(chartOf(world, B))];

  clickPart(world.chrome, tabPartSelector(B, CHROME_SELECTORS.title));
  await delay(20);
  clickPart(world.chrome, tabPartSelector(A, CHROME_SELECTORS.title));
  await delay(150);

  expect(world.chrome.state.active).toBe(A);
  expect(both()).toEqual(['visible', 'hidden']);
});

test('every chart page reports visible with allVisible, as on Windows and Linux', () => {
  const world = worldWith({ allVisible: true });

  expect([visibilityOf(chartOf(world, A)), visibilityOf(chartOf(world, B))]).toEqual([
    'visible',
    'visible',
  ]);
});

test('a new tab shows its New tab page among the targets of the debug port a moment after the strip', async () => {
  const world = worldWith({ pageMs: 30 });
  const app = await startFakeCdpServer({ targets: world.targets() });
  world.attach(app);
  try {
    clickPart(world.chrome, SELECTORS.windowChrome.newTab);
    await delay(15);
    const [, , opened] = world.chrome.state.tabs;
    expect(world.chrome.state.active).toBe(opened?.id);
    expect(world.targets().some(({ url }) => url === NEW_TAB_PAGE_URL)).toBe(false);

    await delay(SETTLE_MS);
    const listed = (await (
      await fetch(`http://${app.host}:${String(app.port)}/json/list`)
    ).json()) as { url: string }[];

    expect(listed.filter(({ url }) => url === NEW_TAB_PAGE_URL)).toHaveLength(1);
    // Every chart page is in the background now.
    expect([visibilityOf(chartOf(world, A)), visibilityOf(chartOf(world, B))]).toEqual([
      'hidden',
      'hidden',
    ]);
    expect(world.newTabPageAccess()).toEqual({ connections: 0, calls: [] });
  } finally {
    await app.close();
  }
});

test('a closed tab leaves the list with its page, and the page asks to save first', async () => {
  const world = worldWith();
  const app = await startFakeCdpServer({ targets: world.targets() });
  world.attach(app);
  try {
    inspectFakeWindow(chartOf(world, B)).state.layouts.unsaved = true;
    clickPart(world.chrome, tabPartSelector(B, CHROME_SELECTORS.closeButton));
    await delay(SETTLE_MS);
    expect(world.chrome.actions).toEqual([{ action: 'closeDialog', tabId: B }]);

    inspectFakeWindow(chartOf(world, B)).state.layouts.unsaved = false;
    const target = world.targetOf(B);
    clickPart(world.chrome, tabPartSelector(B, CHROME_SELECTORS.closeButton));
    await delay(SETTLE_MS);

    expect(world.chrome.state.tabs.map(({ id }) => id)).toEqual([A]);
    expect(world.targets().some(({ id }) => id === target)).toBe(false);
    expect(world.charts.has(B)).toBe(false);
  } finally {
    await app.close();
  }
});

test('reports a connection to a New tab page and the methods sent to it', async () => {
  const world = worldWith({
    tabs: [
      { id: A, kind: 'chart', fixture },
      { id: N, kind: 'new-tab' },
    ],
  });
  const app = await startFakeCdpServer({ targets: world.targets() });
  world.attach(app);
  try {
    const socket = new WebSocket(
      `ws://${app.host}:${String(app.port)}/devtools/page/${world.targetOf(N)}`,
    );
    await once(socket, 'open');
    const answered = once(socket, 'message');
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '1' } }));
    await answered;
    socket.close();

    expect(world.newTabPageAccess()).toEqual({ connections: 1, calls: ['Runtime.evaluate'] });
  } finally {
    await app.close();
  }
});
