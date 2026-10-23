import { setTimeout as delay } from 'node:timers/promises';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Config } from '../../../src/config/schema.js';
import { describeElement } from '../../../src/core/tv/input.js';
import { readVisibilityState } from '../../../src/core/tv/probes.js';
import { createMcpServer } from '../../../src/server.js';
import { readTabs, readUnsavedLayout } from '../../../src/tools/tab/page.js';
import type { JsonValue } from '../../../src/utils/json.js';
import { startFakeCdpServer, type FakeCdpServer } from '../../helpers/fake-cdp/server.js';
import { loadTvFixture } from '../../helpers/fake-tv/fixture.js';
import type { FakeChromeClick } from '../../helpers/fake-tv/window-chrome.js';
import { inspectFakeWindow, type FakeTvWindow } from '../../helpers/fake-tv/window.js';
import { callTool, connectInMemoryClient, textOf } from '../../helpers/mcp-client.js';
import {
  chartFixture,
  createTabWorld,
  NEW_TAB_PAGE_URL,
  WINDOW_CHROME_TARGET_ID,
  type TabWorld,
  type TabWorldOptions,
  type WorldTab,
} from '../../helpers/tab-world.js';
import { quietLogger, refusingLauncher, testConfig } from '../../helpers/tool-context.js';

// The tab tools through the whole server: an SDK client over the in-memory transport, the real
// registry, connection manager and CDP adapter, and the fake debug port of a TradingView window with
// several tabs (tab-world.ts): the window chrome with its tab strip, a chart page for each chart
// tab, and TradingView's New tab page for each new tab. As on macOS, only the chart page of the tab
// in front reports itself visible. Values are synthetic.
//
// After every test: nothing connected to a New tab page, which has Node integration, the window
// chrome was never asked for anything of Node, and no double, middle or right click reached the
// strip.

// Nothing in this file may run a real program or start TradingView.
vi.mock('node:child_process', () => ({
  spawn: () => {
    throw new Error('A test tried to start a real program with spawn');
  },
  execFile: () => {
    throw new Error('A test tried to start a real program with execFile');
  },
}));

const fixture = loadTvFixture();

// The ids of the tabs: two chart tabs, a New tab page, and the tab the shell opens next.
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const N = '33333333-3333-4333-8333-333333333333';
const OPENED = '44444444-4444-4444-8444-444444444444';

const chartA: WorldTab = { id: A, kind: 'chart', fixture };
const chartB: WorldTab = {
  id: B,
  kind: 'chart',
  fixture: chartFixture(fixture, 'FIXTURE2', 'Second Layout', 'NASDAQ:MSFT'),
};
const newTabPage: WorldTab = { id: N, kind: 'new-tab' };

const worlds: TabWorld[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  for (const world of worlds.splice(0)) {
    expect(world.newTabPageAccess()).toEqual({ connections: 0, calls: [] });
    expect(world.chrome.nodeAccess).toEqual([]);
    expect(world.chrome.hazards).toEqual([]);
  }
});

interface Harness {
  client: Client;
  world: TabWorld;
  app: FakeCdpServer;
}

async function startHarness(
  options: TabWorldOptions,
  config: Partial<Config> = {},
): Promise<Harness> {
  const world = createTabWorld({ newTabIds: [OPENED], ...options });
  worlds.push(world);
  const app = await startFakeCdpServer({ targets: world.targets() });
  world.attach(app);
  cleanups.push(() => app.close());
  const { server, ctx } = createMcpServer(
    testConfig({ cdpPort: app.port, callTimeoutMs: 5000, ...config }),
    { launcher: refusingLauncher(), logger: quietLogger },
  );
  cleanups.push(() => ctx.connection.close());
  const client = await connectInMemoryClient(server);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, world, app };
}

interface Envelope {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; hint?: string; details?: Record<string, unknown> };
  meta: { via?: string; durationMs: number; warnings?: string[] };
}

const envelopeOf = (result: { structuredContent?: unknown }): Envelope =>
  result.structuredContent as Envelope;
const dataOf = (result: { structuredContent?: unknown }) => envelopeOf(result).data ?? {};
const errorOf = (result: { structuredContent?: unknown }) => envelopeOf(result).error;
const warningsOf = (result: { structuredContent?: unknown }) =>
  envelopeOf(result).meta.warnings ?? [];

// The presses of a mouse button the strip received, with what each landed on.
const presses = (world: TabWorld): FakeChromeClick[] =>
  world.chrome.clicks.filter(({ type }) => type === 'mousePressed');

const tabIds = (world: TabWorld) => world.chrome.state.tabs.map(({ id }) => id);

function chartOf(world: TabWorld, tabId: string): FakeTvWindow {
  const win = world.charts.get(tabId);
  if (win === undefined) {
    throw new Error(`No chart page for ${tabId}`);
  }
  return win;
}

// The expressions evaluated in a page, in order.
function evaluatedIn(app: FakeCdpServer, targetId: string): string[] {
  return app.calls
    .filter((call) => call.targetId === targetId && call.method === 'Runtime.evaluate')
    .map(({ params }) => (params as { expression: string }).expression);
}

// Whether a page function was evaluated in a page.
function ran(app: FakeCdpServer, targetId: string, fn: { toString(): string }): boolean {
  return evaluatedIn(app, targetId).some((expression) =>
    expression.startsWith(`(${fn.toString()})`),
  );
}

const ANY_DURATION = expect.any(Number) as number;

describe('tab_list', () => {
  test('tab_list lists the tabs of the window in the order of the strip, and changes nothing', async () => {
    const { client, world, app } = await startHarness({
      tabs: [chartA, chartB, newTabPage],
      active: B,
    });

    const result = await callTool(client, 'tab_list');

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: {
        tabs: [
          { id: A, index: 0, title: 'AAPL Fixture Layout', active: false, openedBySession: false },
          { id: B, index: 1, title: 'MSFT Second Layout', active: true, openedBySession: false },
          { id: N, index: 2, title: 'New tab', active: false, openedBySession: false },
        ],
      },
      meta: { via: 'dom', durationMs: ANY_DURATION, warnings: [] },
    });
    expect(JSON.parse(textOf(result))).toStrictEqual(result.structuredContent);
    // One read of the strip, and nothing sent to it or to the pages of the tabs.
    expect(
      app.calls
        .filter(({ targetId }) => targetId === WINDOW_CHROME_TARGET_ID)
        .map(({ method }) => method),
    ).toEqual(['Runtime.evaluate']);
    expect(world.chrome.clicks).toEqual([]);
    for (const tabId of [A, B]) {
      expect(evaluatedIn(app, world.targetOf(tabId))).toEqual([]);
    }
  });
});

describe('tab_new', () => {
  test('tab_new waits for the new tab and its page target and records it', async () => {
    // The page shows among the targets a while after the tab shows in the strip.
    const { client, world } = await startHarness({ tabs: [chartA], pageMs: 60 });

    const result = await callTool(client, 'tab_new');

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: { id: OPENED, index: 1 },
      meta: { via: 'dom', durationMs: ANY_DURATION, warnings: [] },
    });
    // By the time it answers, the tab is in front and its page is listed.
    expect(world.chrome.state.active).toBe(OPENED);
    expect(world.targets().filter(({ url }) => url === NEW_TAB_PAGE_URL)).toHaveLength(1);
    // One click on the new-tab button, with a click count of 1.
    expect(presses(world)).toEqual([
      { type: 'mousePressed', button: 'left', clickCount: 1, on: 'new-tab', tabId: null },
    ]);
    expect(world.chrome.actions).toEqual([{ action: 'new', tabId: OPENED }]);
    // Recorded: tab_list says this session opened it.
    expect(dataOf(await callTool(client, 'tab_list')).tabs).toEqual([
      { id: A, index: 0, title: 'AAPL Fixture Layout', active: false, openedBySession: false },
      { id: OPENED, index: 1, title: 'New tab', active: true, openedBySession: true },
    ]);
  });

  test('tab_new waits for a page of its own tab, not for the New tab page of a tab that was open already', async () => {
    const { client, world } = await startHarness({
      tabs: [chartA, newTabPage],
      active: A,
      pageMs: 60,
    });

    const result = await callTool(client, 'tab_new');

    expect(dataOf(result)).toEqual({ id: OPENED, index: 2 });
    expect(world.targets().filter(({ url }) => url === NEW_TAB_PAGE_URL)).toHaveLength(2);
  });

  test('tab_new leaves the chart tools refusing while its New tab page is in front, until a chart tab is back in front', async () => {
    const { client, world, app } = await startHarness({ tabs: [chartA] });

    await callTool(client, 'tab_new');
    const behind = await callTool(client, 'chart_get_state');
    const switched = await callTool(client, 'tab_switch', { tabId: A });
    const front = await callTool(client, 'chart_get_state');

    // The lone chart tab is in the background: it is not the one the user looks at.
    expect(errorOf(behind)).toEqual({
      code: 'TARGET_NOT_FOUND',
      message: 'The active tab of TradingView shows no chart',
      hint: expect.stringContaining('tab_switch') as string,
      details: {
        newTabPage: true,
        tabs: [
          {
            id: world.targetOf(A),
            url: 'https://www.tradingview.com/chart/FIXTURE1/',
            visibility: 'hidden',
          },
        ],
      },
    });
    expect(dataOf(switched)).toEqual({ id: A, index: 0, changed: true });
    expect(dataOf(front)).toMatchObject({ symbol: 'NASDAQ:AAPL' });
    // The chart was only asked whether it is visible while it was behind the New tab page.
    expect(inspectFakeWindow(chartOf(world, A)).calls).toEqual([]);
    expect(evaluatedIn(app, world.targetOf(A)).length).toBeGreaterThan(1);
  });

  test('tab_new refuses AUTH_REQUIRED while TradingView is signed out, and clicks nothing', async () => {
    const { client, world } = await startHarness({ tabs: [chartA] });
    inspectFakeWindow(chartOf(world, A)).state.pineEditor.signedIn = false;

    const result = await callTool(client, 'tab_new');

    expect(errorOf(result)).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(world.chrome.clicks).toEqual([]);
    expect(tabIds(world)).toEqual([A]);
  });

  test('tab_new fails TIMEOUT, and records nothing, when no new tab shows in time', async () => {
    const { client, world } = await startHarness(
      { tabs: [chartA], changeMs: Infinity },
      { callTimeoutMs: 1500 },
    );

    const result = await callTool(client, 'tab_new');

    expect(errorOf(result)).toMatchObject({
      code: 'TIMEOUT',
      message: 'No new tab showed in the tab strip within 500 ms',
      hint: expect.stringMatching(/tab_list/) as string,
    });
    expect(presses(world)).toHaveLength(1);
    expect(dataOf(await callTool(client, 'tab_list')).tabs).toEqual([
      { id: A, index: 0, title: 'AAPL Fixture Layout', active: true, openedBySession: false },
    ]);
  });

  test('tab_new reports a new tab whose page does not show in time with a warning, and records it', async () => {
    const { client } = await startHarness(
      { tabs: [chartA], pageMs: Infinity },
      { callTimeoutMs: 1500 },
    );

    const result = await callTool(client, 'tab_new');

    expect(dataOf(result)).toEqual({ id: OPENED, index: 1 });
    expect(warningsOf(result)).toEqual([
      expect.stringMatching(/^The new tab is open, but its page did not show .* within 500 ms/),
    ]);
    expect(dataOf(await callTool(client, 'tab_list')).tabs).toMatchObject([
      { id: A, openedBySession: false },
      { id: OPENED, openedBySession: true },
    ]);
  });
});

describe('tab_switch', () => {
  test('tab_switch makes the tab active and the next chart call uses its target', async () => {
    const { client, world, app } = await startHarness({ tabs: [chartA, chartB], active: A });
    const before = await callTool(client, 'chart_get_state');

    const result = await callTool(client, 'tab_switch', { tabId: B });
    const after = await callTool(client, 'chart_get_state');

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: { id: B, index: 1, changed: true },
      meta: { via: 'dom', durationMs: ANY_DURATION, warnings: [] },
    });
    expect(world.chrome.state.active).toBe(B);
    expect([dataOf(before).symbol, dataOf(after).symbol]).toEqual(['NASDAQ:AAPL', 'NASDAQ:MSFT']);
    expect(dataOf(after).layout).toMatchObject({ id: 'FIXTURE2', name: 'Second Layout' });
    // One click, with a click count of 1, on the title of the tab.
    expect(presses(world)).toEqual([
      { type: 'mousePressed', button: 'left', clickCount: 1, on: 'title', tabId: B },
    ]);
    expect(world.chrome.actions).toEqual([{ action: 'switch', tabId: B }]);
    expect(ran(app, world.targetOf(B), readUnsavedLayout)).toBe(false);
  });

  test('tab_switch by index brings the tab at that place of the strip to the front', async () => {
    const { client, world } = await startHarness({ tabs: [chartA, chartB, newTabPage], active: A });

    const result = await callTool(client, 'tab_switch', { index: 2 });

    expect(dataOf(result)).toEqual({ id: N, index: 2, changed: true });
    expect(world.chrome.state.active).toBe(N);
  });

  test('tab_switch to the active tab changes nothing and makes no click', async () => {
    const { client, world, app } = await startHarness({ tabs: [chartA, chartB], active: A });

    const byId = await callTool(client, 'tab_switch', { tabId: A });
    const byIndex = await callTool(client, 'tab_switch', { index: 0 });

    for (const result of [byId, byIndex]) {
      expect(dataOf(result)).toEqual({ id: A, index: 0, changed: false });
    }
    // Not even the pointer moved: a second click on a tab can duplicate it.
    expect(world.chrome.clicks).toEqual([]);
    expect(
      app.calls.filter(({ method }) => method.startsWith('Input.')).map(({ method }) => method),
    ).toEqual([]);
  });

  test('tab_switch to a tab whose layout is named after a trading action goes through, while ui_click on the same title is refused', async () => {
    const { client, world } = await startHarness({
      tabs: [chartA, { ...chartB, title: ['MSFT', 'Sell the rally'] }],
      active: A,
    });
    const title = `div.tab[id="${B}"] .tab-title`;

    const clicked = await callTool(client, 'ui_click', { selector: title, target: 'window' });
    // ui_click has no input that reaches the option of the tab tools, and drops what it does not
    // know.
    const withOptions = await callTool(client, 'ui_click', {
      selector: title,
      target: 'window',
      skipTradingNames: true,
      onTargetOnly: true,
    });
    expect(world.chrome.clicks).toEqual([]);
    const switched = await callTool(client, 'tab_switch', { tabId: B });

    for (const refused of [clicked, withOptions]) {
      expect(errorOf(refused)).toMatchObject({
        code: 'UNSAFE_ACTION_BLOCKED',
        details: { selector: title, name: 'MSFT Sell the rally' },
      });
    }
    expect(dataOf(switched)).toEqual({ id: B, index: 1, changed: true });
    expect(world.chrome.state.active).toBe(B);
  });

  test('tab_switch clicks the title of the tab, never its close button, and refuses when the close button lies over the title', async () => {
    const { client, world } = await startHarness({
      tabs: [chartA, chartB],
      active: A,
      closeButtonOverTitle: true,
    });

    const result = await callTool(client, 'tab_switch', { tabId: B });

    // What lies at the center of the title is the icon of the close button.
    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      details: { selector: `div.tab[id="${B}"] .tab-title`, obscuredBy: 'svg' },
    });
    expect(world.chrome.clicks).toEqual([]);
    expect(tabIds(world)).toEqual([A, B]);
    expect(world.chrome.state.active).toBe(A);
  });

  test('tab_switch fails TIMEOUT when the tab does not come to the front, after a single click', async () => {
    const { client, world } = await startHarness(
      { tabs: [chartA, chartB], active: A, changeMs: Infinity },
      { callTimeoutMs: 1500 },
    );

    const result = await callTool(client, 'tab_switch', { tabId: B });

    expect(errorOf(result)).toMatchObject({
      code: 'TIMEOUT',
      message: 'The tab did not come to the front within 500 ms',
      details: { tabId: B, ms: 500 },
    });
    expect(presses(world)).toHaveLength(1);
  });
});

describe('tab_switch and tab_close', () => {
  test('exactly one of tabId or index is required', async () => {
    const { client, world, app } = await startHarness({ tabs: [chartA, chartB], active: A });

    const results = [
      await callTool(client, 'tab_switch'),
      await callTool(client, 'tab_switch', { tabId: B, index: 1 }),
      await callTool(client, 'tab_close', { confirm: true }),
      await callTool(client, 'tab_close', { tabId: B, index: 1, confirm: true }),
    ];

    for (const result of results) {
      expect(errorOf(result)).toEqual({
        code: 'INVALID_INPUT',
        message: 'Give exactly one of tabId or index',
        hint: expect.stringContaining('tab_list') as string,
      });
    }
    // Refused before the window was even read.
    expect(app.calls).toEqual([]);
    expect(world.chrome.clicks).toEqual([]);
  });

  test('an unknown tab is INVALID_INPUT with the hint tab_list', async () => {
    const { client, world } = await startHarness({ tabs: [chartA, chartB], active: A });

    const byId = await callTool(client, 'tab_switch', { tabId: 'no-such-tab' });
    const byIndex = await callTool(client, 'tab_close', { index: 2, confirm: true });

    expect(errorOf(byId)).toEqual({
      code: 'INVALID_INPUT',
      message: 'No tab of the window has the id "no-such-tab"',
      hint: expect.stringContaining('tab_list') as string,
      details: { tabId: 'no-such-tab' },
    });
    expect(errorOf(byIndex)).toEqual({
      code: 'INVALID_INPUT',
      message: 'There is no tab at index 2: the window has 2 tabs',
      hint: expect.stringContaining('tab_list') as string,
      details: { index: 2, tabs: 2 },
    });
    expect(world.chrome.clicks).toEqual([]);
  });
});

describe('tab_close', () => {
  test('tab_close refuses to close the last tab', async () => {
    const { client, world } = await startHarness({ tabs: [chartA], isLastWindow: false });

    const plain = await callTool(client, 'tab_close', { tabId: A });
    const confirmed = await callTool(client, 'tab_close', { index: 0, confirm: true });

    for (const result of [plain, confirmed]) {
      expect(errorOf(result)).toMatchObject({
        code: 'NOT_AVAILABLE',
        message: 'The only tab of the window is not closed: closing it would close the window',
        details: { tabId: A },
      });
    }
    expect(world.chrome.clicks).toEqual([]);
    expect(tabIds(world)).toEqual([A]);
  });

  test('tab_close a tab this session did not open requires confirm', async () => {
    const { client, world } = await startHarness({ tabs: [chartA, chartB], active: A });

    const refused = await callTool(client, 'tab_close', { tabId: B });
    const declined = await callTool(client, 'tab_close', { tabId: B, confirm: false });

    for (const result of [refused, declined]) {
      expect(errorOf(result)).toMatchObject({
        code: 'CONFIRMATION_REQUIRED',
        hint: expect.stringContaining(
          'Make sure the user wants it closed, then call tab_close again with confirm: true',
        ) as string,
        details: { tabId: B },
      });
    }
    expect(world.chrome.clicks).toEqual([]);
    expect(tabIds(world)).toEqual([A, B]);

    const closed = await callTool(client, 'tab_close', { tabId: B, confirm: true });

    expect(envelopeOf(closed)).toStrictEqual({
      ok: true,
      data: { closed: B, remaining: 1 },
      meta: { via: 'dom', durationMs: ANY_DURATION, warnings: [] },
    });
    expect(tabIds(world)).toEqual([A]);
  });

  test('tab_close of a tab in the background brings it to the front first, checks its layout, then clicks its close button', async () => {
    // At a small size, only the tab in front shows its close button.
    const { client, world, app } = await startHarness({
      tabs: [chartA, chartB],
      active: A,
      size: 'small',
    });
    const target = world.targetOf(B);

    const result = await callTool(client, 'tab_close', { tabId: B, confirm: true });

    expect(dataOf(result)).toEqual({ closed: B, remaining: 1 });
    expect(presses(world)).toEqual([
      { type: 'mousePressed', button: 'left', clickCount: 1, on: 'title', tabId: B },
      { type: 'mousePressed', button: 'left', clickCount: 1, on: 'close', tabId: B },
    ]);
    expect(world.chrome.actions).toEqual([
      { action: 'switch', tabId: B },
      { action: 'close', tabId: B },
    ]);
    expect(ran(app, target, readUnsavedLayout)).toBe(true);
    // The tab that took its place in front is the one the chart tools use now.
    expect(world.chrome.state.active).toBe(A);
    expect(dataOf(await callTool(client, 'chart_get_state'))).toMatchObject({
      symbol: 'NASDAQ:AAPL',
    });
  });

  test('tab_close of the tab tab_new opened needs no confirm, and closes its New tab page without a look for unsaved changes', async () => {
    const { client, world, app } = await startHarness({ tabs: [chartA] });
    await callTool(client, 'tab_new');

    const result = await callTool(client, 'tab_close', { tabId: OPENED });

    expect(dataOf(result)).toEqual({ closed: OPENED, remaining: 1 });
    expect(tabIds(world)).toEqual([A]);
    expect(ran(app, world.targetOf(A), readUnsavedLayout)).toBe(false);
    expect(world.chrome.actions).toEqual([
      { action: 'new', tabId: OPENED },
      { action: 'close', tabId: OPENED },
    ]);
    // Forgotten once closed: the chart tab is in front again, and the chart tools use it.
    expect(dataOf(await callTool(client, 'tab_list')).tabs).toEqual([
      { id: A, index: 0, title: 'AAPL Fixture Layout', active: true, openedBySession: false },
    ]);
    expect(dataOf(await callTool(client, 'chart_get_state'))).toMatchObject({
      symbol: 'NASDAQ:AAPL',
    });
  });

  test('tab_close refuses a tab whose layout has unsaved changes, confirm or not, and clicks nothing', async () => {
    const { client, world } = await startHarness({ tabs: [chartA, chartB], active: B });
    inspectFakeWindow(chartOf(world, B)).state.layouts.unsaved = true;

    const result = await callTool(client, 'tab_close', { tabId: B, confirm: true });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      message:
        'The layout of the tab has unsaved changes: closing it would open the "Close tab?" ' +
        'dialog of TradingView',
      hint: expect.stringMatching(/save the layout/i) as string,
      details: { tabId: B },
    });
    expect(world.chrome.clicks).toEqual([]);
    expect(world.chrome.actions).toEqual([]);
    expect(tabIds(world)).toEqual([A, B]);
  });

  test('tab_close refuses a tab whose page cannot say whether its layout has unsaved changes', async () => {
    const { client, world } = await startHarness({ tabs: [chartA, chartB], active: B });
    delete chartOf(world, B).TradingViewApi?.shouldBeSaved;

    const result = await callTool(client, 'tab_close', { tabId: B, confirm: true });

    expect(errorOf(result)).toMatchObject({ code: 'NOT_AVAILABLE', details: { tabId: B } });
    expect(errorOf(result)?.message).toMatch(/does not say whether the layout of the tab/);
    expect(world.chrome.clicks).toEqual([]);
  });

  test('tab_close refuses while the window is out of view, where a chart tab in front reports itself hidden too, and clicks nothing', async () => {
    // The window is behind other windows: every page of it reports hidden, the chart in front too,
    // so that page cannot be told from a New tab page in front. Closing it would ask about its
    // unsaved changes in a dialog.
    const { client, world } = await startHarness({
      tabs: [chartA, chartB, newTabPage],
      active: A,
      inView: false,
    });
    inspectFakeWindow(chartOf(world, A)).state.layouts.unsaved = true;

    const chart = await callTool(client, 'tab_close', { tabId: A, confirm: true });
    const page = await callTool(client, 'tab_close', { tabId: N, confirm: true });

    for (const [result, tabId] of [
      [chart, A],
      [page, N],
    ] as const) {
      expect(errorOf(result)).toMatchObject({
        code: 'NOT_AVAILABLE',
        message:
          'The TradingView window is out of view, so whether the tab in front shows a chart ' +
          'cannot be told',
        hint: expect.stringMatching(/into view/) as string,
        details: { tabId, reason: 'window-out-of-view' },
      });
    }
    // Refused before anything was clicked: no tab was brought to the front, none closed, and no
    // dialog opened.
    expect(world.chrome.clicks).toEqual([]);
    expect(world.chrome.actions).toEqual([]);
    expect(tabIds(world)).toEqual([A, B, N]);
  });

  test('tab_close of a lone chart tab refuses while the window is out of view, though the chart tools use that tab then', async () => {
    const { client, world } = await startHarness({
      tabs: [chartA, newTabPage],
      active: A,
      inView: false,
    });

    const state = await callTool(client, 'chart_get_state');
    const closed = await callTool(client, 'tab_close', { tabId: A, confirm: true });

    expect(dataOf(state)).toMatchObject({ symbol: 'NASDAQ:AAPL' });
    expect(errorOf(closed)).toMatchObject({
      code: 'NOT_AVAILABLE',
      details: { tabId: A, reason: 'window-out-of-view' },
    });
    expect(world.chrome.clicks).toEqual([]);
  });

  test('tab_close refuses when it cannot tell which page the tab shows, and clicks nothing', async () => {
    // As on Windows: every chart page reports itself visible.
    const { client, world } = await startHarness({
      tabs: [chartA, chartB],
      active: A,
      allVisible: true,
    });

    const result = await callTool(client, 'tab_close', { tabId: A, confirm: true });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      details: { tabId: A, reason: 'TARGET_NOT_FOUND' },
    });
    expect(errorOf(result)?.message).toMatch(/^Cannot tell whether closing the tab would open/);
    expect(world.chrome.clicks).toEqual([]);
    expect(tabIds(world)).toEqual([A, B]);
  });

  test('tab_close refuses a tab that shows no close button, such as a pinned one', async () => {
    const { client, world } = await startHarness({
      tabs: [{ ...chartA, pinned: true }, chartB],
      active: A,
    });

    const result = await callTool(client, 'tab_close', { tabId: A, confirm: true });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: 'The tab shows no close button',
      details: { tabId: A },
    });
    expect(world.chrome.clicks).toEqual([]);
  });

  test('tab_close refuses, and clicks nothing, when another tab comes to the front while it checks the layout', async () => {
    const { client, world } = await startHarness({ tabs: [chartA, chartB], active: B });
    const api = chartOf(world, B).TradingViewApi;
    if (api === undefined) {
      throw new Error('The chart of tab B has no API');
    }
    // The user brings tab A to the front at the moment the layout of tab B is asked about.
    api.shouldBeSaved = () => {
      world.chrome.state.active = A;
      world.chrome.render();
      return false;
    };

    const result = await callTool(client, 'tab_close', { tabId: B, confirm: true });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: 'The tab is no longer in front of the window',
      details: { tabId: B },
    });
    expect(world.chrome.clicks).toEqual([]);
    expect(tabIds(world)).toEqual([A, B]);
  });

  test('tab_close of a pinned tab in the background brings it to the front, then refuses: it shows no close button', async () => {
    const { client, world } = await startHarness({
      tabs: [chartA, { ...chartB, pinned: true }],
      active: A,
    });

    const result = await callTool(client, 'tab_close', { tabId: B, confirm: true });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: 'The tab shows no close button',
      details: { tabId: B },
    });
    // Whether a tab in the background shows its close button once in front cannot be told before.
    expect(presses(world)).toEqual([
      { type: 'mousePressed', button: 'left', clickCount: 1, on: 'title', tabId: B },
    ]);
    expect(tabIds(world)).toEqual([A, B]);
  });

  test('tab_close refuses at its last look when the tab has become the only one of the window', async () => {
    // Not the last window, so the only tab shows its close button; closing it would close the window.
    const { client, world } = await startHarness({
      tabs: [chartA, chartB],
      active: A,
      isLastWindow: false,
    });
    const api = chartOf(world, A).TradingViewApi;
    if (api === undefined) {
      throw new Error('The chart of tab A has no API');
    }
    // The user closes tab B at the moment the layout of tab A is asked about.
    api.shouldBeSaved = () => {
      world.chrome.state.tabs = world.chrome.state.tabs.filter(({ id }) => id !== B);
      world.chrome.render();
      return false;
    };

    const result = await callTool(client, 'tab_close', { tabId: A, confirm: true });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: 'The only tab of the window is not closed: closing it would close the window',
      details: { tabId: A },
    });
    expect(world.chrome.clicks).toEqual([]);
    expect(tabIds(world)).toEqual([A]);
  });

  test('tab_close says that the tab it brought to the front stays there when it refuses', async () => {
    const { client, world } = await startHarness({ tabs: [chartA, chartB], active: A });
    inspectFakeWindow(chartOf(world, B)).state.layouts.unsaved = true;

    const unsaved = await callTool(client, 'tab_close', { tabId: B, confirm: true });

    expect(errorOf(unsaved)).toMatchObject({
      code: 'NOT_AVAILABLE',
      message:
        'The layout of the tab has unsaved changes: closing it would open the "Close tab?" ' +
        'dialog of TradingView',
      hint: expect.stringMatching(/^The tab is in front now, where tab_close brought it/) as string,
      details: { tabId: B, inFront: true },
    });
    expect(world.chrome.state.active).toBe(B);
  });

  test('tab_close says where the tab is when the user brings another one to the front after its switch', async () => {
    const { client, world } = await startHarness({ tabs: [chartA, chartB], active: A });
    const api = chartOf(world, B).TradingViewApi;
    if (api === undefined) {
      throw new Error('The chart of tab B has no API');
    }
    // The user brings tab A back at the moment the layout of tab B is asked about.
    api.shouldBeSaved = () => {
      world.chrome.state.active = A;
      world.chrome.render();
      return false;
    };

    const result = await callTool(client, 'tab_close', { tabId: B, confirm: true });

    expect(errorOf(result)).toEqual({
      code: 'NOT_AVAILABLE',
      message: 'The tab is no longer in front of the window',
      hint: 'Check tab_list, then try again.',
      details: { tabId: B, inFront: false },
    });
  });

  test('tab_close does not say a tab stays in front when it refused before any click', async () => {
    const { client } = await startHarness({ tabs: [chartA, chartB], active: B });

    const refused = await callTool(client, 'tab_close', { tabId: B });

    expect(errorOf(refused)?.code).toBe('CONFIRMATION_REQUIRED');
    expect(errorOf(refused)?.details).not.toHaveProperty('inFront');
  });

  test('tab_close fails TIMEOUT when the tab does not close in time', async () => {
    const { client, world } = await startHarness(
      { tabs: [chartA, chartB], active: A, changeMs: Infinity },
      { callTimeoutMs: 1500 },
    );

    const result = await callTool(client, 'tab_close', { tabId: A, confirm: true });

    expect(errorOf(result)).toMatchObject({
      code: 'TIMEOUT',
      message: 'The tab did not close within 500 ms',
      details: { tabId: A, ms: 500 },
    });
    expect(presses(world)).toEqual([
      { type: 'mousePressed', button: 'left', clickCount: 1, on: 'close', tabId: A },
    ]);
  });
});

describe('app_health while a New tab page is in front', () => {
  test('app_health says that the chart tabs are behind a tab that shows no chart, and what to do', async () => {
    const { client } = await startHarness({ tabs: [chartA, newTabPage], active: N });

    const result = await callTool(client, 'app_health');

    expect(dataOf(result)).toMatchObject({
      chart: { found: true, tabs: 1, inBackground: true },
      app: { ready: false },
      capabilities: null,
    });
    expect(warningsOf(result)).toEqual([expect.stringMatching(/shows no chart.*tab_switch/)]);
  });
});

describe('the chart tools while the window is out of view', () => {
  // Covered by other windows or minimized, as it is while the user works in another app: every page
  // of the window reports hidden, the chart in front and the window chrome too.

  test.each([A, N])(
    'use the lone chart tab, with a New tab page open, whichever tab is in front (%s)',
    async (front) => {
      const { client, world, app } = await startHarness({
        tabs: [chartA, newTabPage],
        active: front,
        inView: false,
      });

      const result = await callTool(client, 'chart_get_state');

      expect(dataOf(result)).toMatchObject({ symbol: 'NASDAQ:AAPL' });
      // The window chrome was asked whether the window is in view, by its document alone.
      expect(ran(app, WINDOW_CHROME_TARGET_ID, readVisibilityState)).toBe(true);
      expect(world.chrome.clicks).toEqual([]);
    },
  );

  test('refuse several chart tabs, saying the window is covered or minimized', async () => {
    const { client } = await startHarness({ tabs: [chartA, chartB], active: A, inView: false });

    const result = await callTool(client, 'chart_get_state');

    expect(errorOf(result)).toMatchObject({
      code: 'TARGET_NOT_FOUND',
      message: "TradingView's window is covered or minimized, so the tab in front cannot be told",
      hint: expect.stringMatching(/Bring TradingView to the front/) as string,
    });
  });

  test('app_health reports TradingView ready, with a lone chart tab and a New tab page', async () => {
    const { client } = await startHarness({ tabs: [chartA, newTabPage], active: N, inView: false });

    const result = await callTool(client, 'app_health');

    expect(dataOf(result)).toMatchObject({
      chart: { found: true, tabs: 1 },
      app: { ready: true, connected: true },
    });
    expect(warningsOf(result)).toEqual([]);
  });
});

describe('pages that hear of a switch later than the strip shows it', () => {
  // The strip and the pages are separate renderers: for a while after the strip shows the tab in
  // front, the page that left the front may still report itself visible, and the page that came to
  // the front hidden.
  const LAG = { hideMs: 300, showMs: 300 };

  test('tab_close of a chart tab in the background asks that tab about unsaved changes, not the tab it left', async () => {
    const { client, world } = await startHarness({
      tabs: [chartA, chartB],
      active: A,
      pageLag: LAG,
    });
    inspectFakeWindow(chartOf(world, B)).state.layouts.unsaved = true;

    const result = await callTool(client, 'tab_close', { tabId: B, confirm: true });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      message:
        'The layout of the tab has unsaved changes: closing it would open the "Close tab?" ' +
        'dialog of TradingView',
      details: { tabId: B },
    });
    // Brought to the front, never closed: no "Close tab?" dialog.
    expect(presses(world)).toEqual([
      { type: 'mousePressed', button: 'left', clickCount: 1, on: 'title', tabId: B },
    ]);
    expect(world.chrome.actions).toEqual([{ action: 'switch', tabId: B }]);
  });

  test('tab_close of a chart tab behind a New tab page does not take its late page for a New tab page', async () => {
    const { client, world } = await startHarness({
      tabs: [newTabPage, chartA],
      active: N,
      pageLag: LAG,
    });
    inspectFakeWindow(chartOf(world, A)).state.layouts.unsaved = true;

    const result = await callTool(client, 'tab_close', { tabId: A, confirm: true });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      message:
        'The layout of the tab has unsaved changes: closing it would open the "Close tab?" ' +
        'dialog of TradingView',
      details: { tabId: A },
    });
    expect(world.chrome.actions).toEqual([{ action: 'switch', tabId: A }]);
    expect(tabIds(world)).toEqual([N, A]);
  });

  // A tab that shows a symbol is a chart tab, whose page may lag past the settle of a reading of no
  // chart in front: it is never taken for a New tab page, which has no layout to ask about.
  test.each([
    [1500, 5000],
    [60_000, 1500],
  ])(
    'tab_close of a chart tab behind a New tab page, whose page lags %d ms, never takes it for a New tab page',
    async (showMs, callTimeoutMs) => {
      const { client, world } = await startHarness(
        { tabs: [newTabPage, chartA], active: N, pageLag: { hideMs: 0, showMs } },
        { callTimeoutMs },
      );
      inspectFakeWindow(chartOf(world, A)).state.layouts.unsaved = true;

      const result = await callTool(client, 'tab_close', { tabId: A, confirm: true });

      expect(errorOf(result)).toMatchObject({ code: 'NOT_AVAILABLE', details: { tabId: A } });
      // Brought to the front, never closed: no "Close tab?" dialog.
      expect(world.chrome.actions).toEqual([{ action: 'switch', tabId: A }]);
      expect(tabIds(world)).toEqual([N, A]);
    },
  );

  test('tab_switch from a New tab page to a chart tab whose page lags past the wait is NOT_AVAILABLE', async () => {
    const { client } = await startHarness(
      { tabs: [newTabPage, chartA], active: N, pageLag: { hideMs: 0, showMs: 60_000 } },
      { callTimeoutMs: 1500 },
    );

    const result = await callTool(client, 'tab_switch', { tabId: A });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: 'The tab is selected in the tab strip, but its page has not come to the front yet',
      details: { tabId: A },
    });
  });

  test('tab_close of a chart tab in front whose page has not come to the front refuses, as a tab that shows a symbol is never a New tab page', async () => {
    const { client, world } = await startHarness({
      tabs: [newTabPage, chartA],
      active: N,
      pageLag: { hideMs: 0, showMs: 60_000 },
    });
    inspectFakeWindow(chartOf(world, A)).state.layouts.unsaved = true;
    // The user has just brought the chart tab to the front.
    await world.userSwitchesTo(A);

    const result = await callTool(client, 'tab_close', { tabId: A, confirm: true });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      details: { tabId: A, reason: 'page-not-in-front' },
    });
    expect(world.chrome.actions).toEqual([{ action: 'switch', tabId: A }]);
    expect(tabIds(world)).toEqual([N, A]);
  });

  test('tab_close of the tab in front reads which page is in front twice, a settle apart, before it asks about unsaved changes', async () => {
    const { client, world } = await startHarness({
      tabs: [chartA, chartB],
      active: A,
      pageLag: LAG,
    });
    inspectFakeWindow(chartOf(world, B)).state.layouts.unsaved = true;
    // The user has just brought tab B to the front, and the page of tab A reports itself visible
    // for a while yet.
    await world.userSwitchesTo(B);

    const result = await callTool(client, 'tab_close', { tabId: B, confirm: true });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      details: { tabId: B, reason: 'front-unknown' },
    });
    expect(world.chrome.actions).toEqual([{ action: 'switch', tabId: B }]);
    expect(tabIds(world)).toEqual([A, B]);
  });

  test('tab_switch answers once the page of the tab is in front, so the next chart call acts on that tab', async () => {
    const { client } = await startHarness({ tabs: [chartA, chartB], active: A, pageLag: LAG });

    const switched = await callTool(client, 'tab_switch', { tabId: B });
    const state = await callTool(client, 'chart_get_state');

    expect(dataOf(switched)).toEqual({ id: B, index: 1, changed: true });
    expect(warningsOf(switched)).toEqual([]);
    expect(dataOf(state)).toMatchObject({ symbol: 'NASDAQ:MSFT' });
  });

  test('a batch of tab_switch and a chart call acts on the tab switched to', async () => {
    const { client } = await startHarness({ tabs: [chartA, chartB], active: A, pageLag: LAG });

    const result = await callTool(client, 'batch_run', {
      steps: [{ tool: 'tab_switch', arguments: { tabId: B } }, { tool: 'chart_get_state' }],
    });

    const [switched, state] = (dataOf(result).steps ?? []) as {
      ok: boolean;
      data?: Record<string, unknown>;
    }[];
    expect(switched?.ok).toBe(true);
    expect(state?.data).toMatchObject({ symbol: 'NASDAQ:MSFT' });
  });

  test('tab_switch between chart tabs waits through a moment in which no chart reports itself visible', async () => {
    // The page that left the front hears at once, the one that came to the front a while later,
    // while a New tab page is open in a third tab.
    const { client } = await startHarness({
      tabs: [chartA, chartB, newTabPage],
      active: A,
      pageLag: { hideMs: 0, showMs: 250 },
    });

    const switched = await callTool(client, 'tab_switch', { tabId: B });
    const state = await callTool(client, 'chart_get_state');

    expect(dataOf(switched)).toEqual({ id: B, index: 1, changed: true });
    expect(dataOf(state)).toMatchObject({ symbol: 'NASDAQ:MSFT' });
  });

  test('tab_switch to a New tab page answers once no chart is in front, so the chart tools refuse after it', async () => {
    const { client } = await startHarness({ tabs: [chartA, newTabPage], active: A, pageLag: LAG });

    const switched = await callTool(client, 'tab_switch', { tabId: N });
    const state = await callTool(client, 'chart_get_state');

    expect(dataOf(switched)).toEqual({ id: N, index: 1, changed: true });
    expect(errorOf(state)).toMatchObject({
      code: 'TARGET_NOT_FOUND',
      message: 'The active tab of TradingView shows no chart',
    });
  });

  test('tab_new answers once its New tab page is in front, so the chart tools refuse after it', async () => {
    const { client } = await startHarness({ tabs: [chartA], pageLag: LAG });

    await callTool(client, 'tab_new');
    const state = await callTool(client, 'chart_get_state');

    expect(errorOf(state)).toMatchObject({
      code: 'TARGET_NOT_FOUND',
      message: 'The active tab of TradingView shows no chart',
    });
  });

  test('tab_switch is NOT_AVAILABLE when the strip shows the tab but its page does not come to the front in time', async () => {
    const { client, world } = await startHarness(
      { tabs: [chartA, chartB], active: A, pageLag: { hideMs: 60_000, showMs: 60_000 } },
      { callTimeoutMs: 1500 },
    );

    const result = await callTool(client, 'tab_switch', { tabId: B });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: 'The tab is selected in the tab strip, but its page has not come to the front yet',
      hint: expect.stringMatching(/tab_list.*chart tool.*again/) as string,
      details: { tabId: B },
    });
    expect(world.chrome.state.active).toBe(B);
    expect(presses(world)).toHaveLength(1);
  });

  test('tab_close closes nothing when the strip shows the tab but its page does not come to the front in time', async () => {
    const { client, world } = await startHarness(
      { tabs: [chartA, chartB], active: A, pageLag: { hideMs: 60_000, showMs: 60_000 } },
      { callTimeoutMs: 1500 },
    );

    const result = await callTool(client, 'tab_close', { tabId: B, confirm: true });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      details: { tabId: B, reason: 'page-not-in-front' },
    });
    expect(errorOf(result)?.message).toMatch(/has not come to the front yet/);
    expect(presses(world)).toEqual([
      { type: 'mousePressed', button: 'left', clickCount: 1, on: 'title', tabId: B },
    ]);
    expect(world.chrome.actions).toEqual([{ action: 'switch', tabId: B }]);
  });

  test('tab_switch in a covered window succeeds with a warning that the page in front could not be confirmed', async () => {
    const { client, world } = await startHarness({
      tabs: [chartA, chartB],
      active: A,
      inView: false,
    });

    const result = await callTool(client, 'tab_switch', { tabId: B });

    expect(dataOf(result)).toEqual({ id: B, index: 1, changed: true });
    expect(warningsOf(result)).toEqual([
      expect.stringMatching(/could not be confirmed while the TradingView window is covered/),
    ]);
    expect(world.chrome.state.active).toBe(B);
  });

  test('tab_switch where no page says which tab is in front, before or after, succeeds with a warning', async () => {
    // As on Windows: every chart page reports itself visible.
    const { client, world } = await startHarness(
      { tabs: [chartA, chartB], active: A, allVisible: true },
      { callTimeoutMs: 1500 },
    );

    const result = await callTool(client, 'tab_switch', { tabId: B });

    expect(dataOf(result)).toEqual({ id: B, index: 1, changed: true });
    expect(warningsOf(result)).toEqual([expect.stringMatching(/could not be confirmed/)]);
    expect(world.chrome.state.active).toBe(B);
  });

  test('tab_close refuses, and closes nothing, when the window goes out of view while its page comes to the front', async () => {
    const { client, world } = await startHarness({
      tabs: [chartA, chartB],
      active: A,
      pageLag: LAG,
    });
    const cover = setInterval(() => {
      if (world.chrome.state.active === B) {
        world.chrome.state.inView = false;
      }
    }, 1);

    const result = await callTool(client, 'tab_close', { tabId: B, confirm: true });
    clearInterval(cover);

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      details: { tabId: B, reason: 'window-out-of-view' },
    });
    expect(world.chrome.actions).toEqual([{ action: 'switch', tabId: B }]);
  });

  test('tab_new warns when the chart tab it covers does not show in time that it is behind it', async () => {
    const { client } = await startHarness(
      { tabs: [chartA], pageLag: { hideMs: 60_000, showMs: 60_000 } },
      { callTimeoutMs: 1500 },
    );

    const result = await callTool(client, 'tab_new');

    expect(dataOf(result)).toEqual({ id: OPENED, index: 1 });
    expect(warningsOf(result)).toEqual([
      expect.stringMatching(/did not show yet that it is behind it/),
    ]);
  });

  test('tab_new warns as well when no page says which tab is in front, before or after', async () => {
    const { client } = await startHarness(
      { tabs: [chartA, chartB], active: A, allVisible: true },
      { callTimeoutMs: 1500 },
    );

    const result = await callTool(client, 'tab_new');

    expect(dataOf(result)).toEqual({ id: OPENED, index: 2 });
    expect(warningsOf(result)).toEqual([
      expect.stringMatching(/did not show yet that it is behind it/),
    ]);
  });

  test('tab_new in a covered window leaves the chart tools to the lone chart tab, without a warning', async () => {
    const { client } = await startHarness({ tabs: [chartA], inView: false });

    const result = await callTool(client, 'tab_new');
    const state = await callTool(client, 'chart_get_state');

    expect(dataOf(result)).toEqual({ id: OPENED, index: 1 });
    expect(warningsOf(result)).toEqual([]);
    expect(dataOf(state)).toMatchObject({ symbol: 'NASDAQ:AAPL' });
  });

  test('tab_close of a tab in the background refuses before any click when no page says which tab is in front', async () => {
    const { client, world } = await startHarness({
      tabs: [chartA, chartB],
      active: A,
      allVisible: true,
    });

    const result = await callTool(client, 'tab_close', { tabId: B, confirm: true });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      details: { tabId: B, reason: 'front-unknown' },
    });
    expect(world.chrome.clicks).toEqual([]);
  });
});

describe('calls that run while a tab tool changes the tab in front', () => {
  // A call on the chart page held open for a while: an expression that settles later.
  const SLOW = 'new Promise((resolve) => setTimeout(() => resolve("settled"), 500))';

  test('tab_switch leaves a call that runs on the chart page meanwhile to finish, and the next chart call acts on the new tab', async () => {
    const { client } = await startHarness(
      { tabs: [chartA, chartB], active: A },
      { allowEval: true },
    );

    const slow = callTool(client, 'ui_evaluate', { expression: SLOW });
    // The expression is under way in the page of the first tab before the switch.
    await delay(100);
    const switched = await callTool(client, 'tab_switch', { tabId: B });
    const state = await callTool(client, 'chart_get_state');

    expect(envelopeOf(await slow)).toMatchObject({
      ok: true,
      data: { value: 'settled', truncated: false },
    });
    expect(dataOf(switched)).toEqual({ id: B, index: 1, changed: true });
    expect(dataOf(state)).toMatchObject({ symbol: 'NASDAQ:MSFT' });
  });

  test('tab_new and tab_close leave a call that runs on a chart page meanwhile to finish', async () => {
    const { client } = await startHarness({ tabs: [chartA] }, { allowEval: true });

    const during = async (tool: string, args: Record<string, unknown> = {}) => {
      const slow = callTool(client, 'ui_evaluate', { expression: SLOW });
      await delay(100);
      const result = await callTool(client, tool, args);
      expect(envelopeOf(await slow), tool).toMatchObject({ ok: true, data: { value: 'settled' } });
      return result;
    };

    const opened = await during('tab_new');
    await callTool(client, 'tab_switch', { tabId: A });
    const closed = await during('tab_close', { tabId: OPENED });

    expect(dataOf(opened)).toMatchObject({ id: OPENED });
    expect(dataOf(closed)).toEqual({ closed: OPENED, remaining: 1 });
  });
});

describe('the tab tools while a replay this session started runs', () => {
  test('tab_switch, tab_new and tab_close refuse NOT_AVAILABLE, naming replay_stop, before any click', async () => {
    const { client, world } = await startHarness({ tabs: [chartA, chartB], active: A });
    await callTool(client, 'replay_start', { date: 'first' });

    const refused = [
      await callTool(client, 'tab_switch', { tabId: B }),
      await callTool(client, 'tab_new'),
      await callTool(client, 'tab_close', { tabId: B, confirm: true }),
      await callTool(client, 'tab_close', { tabId: A, confirm: true }),
    ];

    for (const result of refused) {
      expect(errorOf(result)).toMatchObject({
        code: 'NOT_AVAILABLE',
        hint: expect.stringContaining('replay_stop') as string,
      });
    }
    expect(world.chrome.clicks).toEqual([]);
    expect(tabIds(world)).toEqual([A, B]);
    // Bringing the tab in front to the front changes nothing, so it goes on as before.
    expect(dataOf(await callTool(client, 'tab_switch', { tabId: A }))).toEqual({
      id: A,
      index: 0,
      changed: false,
    });
    // Once the replay is stopped, they act.
    await callTool(client, 'replay_stop');
    expect(dataOf(await callTool(client, 'tab_switch', { tabId: B }))).toEqual({
      id: B,
      index: 1,
      changed: true,
    });
  });
});

describe('a tab whose id holds characters a selector must quote', () => {
  test('tab_switch and tab_close reach it by a selector that quotes its id', async () => {
    const odd = 'tab "one" \\ two\u0007';
    const { client, world } = await startHarness({
      tabs: [chartA, { ...chartB, id: odd }],
      active: A,
    });

    const switched = await callTool(client, 'tab_switch', { tabId: odd });
    const closed = await callTool(client, 'tab_close', { tabId: odd, confirm: true });

    expect(dataOf(switched)).toEqual({ id: odd, index: 1, changed: true });
    expect(dataOf(closed)).toEqual({ closed: odd, remaining: 1 });
    expect(world.chrome.actions).toEqual([
      { action: 'switch', tabId: odd },
      { action: 'close', tabId: odd },
    ]);
  });
});

describe('the window chrome and the New tab page', () => {
  test('the window chrome is only read through the DOM page functions and sent guarded input', async () => {
    const { client, app } = await startHarness({ tabs: [chartA, chartB], active: A });

    await callTool(client, 'tab_list');
    await callTool(client, 'tab_switch', { tabId: B });
    await callTool(client, 'tab_new');
    await callTool(client, 'tab_close', { tabId: OPENED });
    await callTool(client, 'tab_close', { index: 0, confirm: true });

    const calls = app.calls.filter(({ targetId }) => targetId === WINDOW_CHROME_TARGET_ID);
    expect(new Set(calls.map(({ method }) => method))).toEqual(
      new Set(['Runtime.evaluate', 'Page.getLayoutMetrics', 'Input.dispatchMouseEvent']),
    );
    const sources = [readTabs, describeElement, readVisibilityState].map((fn) => fn.toString());
    const evaluated = evaluatedIn(app, WINDOW_CHROME_TARGET_ID);
    expect(evaluated.length).toBeGreaterThan(0);
    for (const expression of evaluated) {
      const source = sources.find((candidate) =>
        expression.startsWith(`(${candidate})(window, ...`),
      );
      expect(source, 'one of the page functions that only read the DOM').toBeDefined();
      const prefix = `(${source ?? ''})(window, ...`;
      const args = JSON.parse(expression.slice(prefix.length, -1)) as JsonValue[];
      // Exactly (source)(window, ...args): no page library and nothing else around the function.
      expect(expression).toBe(`(${source ?? ''})(window, ...${JSON.stringify(args)})`);
    }
    // Every press is a single left click.
    for (const { params } of calls.filter(({ method }) => method === 'Input.dispatchMouseEvent')) {
      const { type, button, clickCount } = params as Record<string, unknown>;
      if (type !== 'mouseMoved') {
        expect([button, clickCount]).toEqual(['left', 1]);
      }
    }
  });
});
