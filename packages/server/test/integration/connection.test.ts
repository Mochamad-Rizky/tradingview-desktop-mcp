import {
  createServer as createTcpServer,
  type AddressInfo,
  type Server as TcpServer,
  type Socket,
} from 'node:net';
import { createCriConnector } from '../../src/core/cdp/cri-connector.js';
import { createHttpDiscovery } from '../../src/core/cdp/discovery.js';
import type { CdpDiscovery } from '../../src/core/cdp/types.js';
import { ConnectionManager } from '../../src/core/connection.js';
import { createLogger, type Logger } from '../../src/core/logger.js';
import { readVisibilityState } from '../../src/core/tv/probes.js';
import { failureOf } from '../helpers/failure-of.js';
import {
  CHROME_USER_AGENT,
  startFakeCdpServer,
  type FakeCdpServer,
  type FakeTarget,
} from '../helpers/fake-cdp/server.js';
import { loadTargetsFixture } from '../helpers/fake-cdp/targets.js';
import { loadTvFixture } from '../helpers/fake-tv/fixture.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTvOverrides,
  type FakeTvWindow,
} from '../helpers/fake-tv/window.js';

const LOOPBACK = '127.0.0.1';
const CHART_ID = 'BBB144A7827AE55CBA0E74986FC9574C';
const WINDOW_CHROME_ID = 'EE67363DAA56C9940A709061CFAA2FFF';
// The two blank pages of the app: they accept the WebSocket and never answer a command.
const BLANK_IDS = ['D4FA899CB58B76FCEDDAC2E1E63735B2', '80A80E86AF3E47B46C0E0C0A748CFC57'];
// Two chart tabs of one window, for the tests that have to choose between them.
const TAB_A = 'A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1';
const TAB_B = 'B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2';
// Long enough that a call which waited on a blank page, or ignored a deadline, shows.
const CALL_TIMEOUT_MS = 5000;
// What the visibility probe waits for a tab that does not answer, per its contract.
const PROBE_TIMEOUT_MS = 1500;

const fixture = loadTvFixture();

// Everything a test starts is registered here, because a server that is still listening or a
// socket that is still open keeps the vitest worker from exiting. The newest goes first, so a
// manager is closed before the server it talks to goes away.
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function startServer(targets: FakeTarget[]): Promise<FakeCdpServer> {
  const server = await startFakeCdpServer({ targets });
  cleanups.push(() => server.close());
  return server;
}

interface App {
  server: FakeCdpServer;
  // The window of the chart tab that the observed target list has.
  win: FakeTvWindow;
}

// The observed target list of the app, with a fake TradingView window on its chart tab.
async function startApp(overrides: FakeTvOverrides = {}): Promise<App> {
  const win = createFakeTvWindow(fixture, overrides);
  const server = await startServer(loadTargetsFixture({ chartWindow: () => win }));
  return { server, win };
}

function chartTab(id: string, win: object, behavior: FakeTarget['behavior'] = 'page'): FakeTarget {
  return {
    id,
    type: 'page',
    title: 'Live stock, index, futures, Forex and Bitcoin charts on TradingView',
    url: `https://www.tradingview.com/chart/${id.slice(0, 8)}/`,
    behavior,
    window: () => win,
  };
}

// The observed target list with its one chart tab replaced by `tabs`.
function appWith(tabs: FakeTarget[]): FakeTarget[] {
  return [...loadTargetsFixture().filter(({ id }) => id !== CHART_ID), ...tabs];
}

// The observed target list without the targets of `ids`.
function appWithout(...ids: string[]): FakeTarget[] {
  return loadTargetsFixture().filter(({ id }) => !ids.includes(id));
}

function endpointOf(port: number): string {
  return `http://${LOOPBACK}:${String(port)}`;
}

const quietLogger = createLogger({ level: 'silent', destination: { write: () => undefined } });

interface ManagerOptions {
  callTimeoutMs?: number;
  logger?: Logger;
  // Replaces the wait between attempts, so that a test can count the retries without waiting.
  sleep?: (ms: number) => Promise<void>;
  // Wraps the real discovery, for a test that needs it to say something out of date.
  discovery?: (real: CdpDiscovery) => CdpDiscovery;
}

// A manager that talks to `port` the way the server will: real discovery and real connector.
function managerFor(port: number, options: ManagerOptions = {}): ConnectionManager {
  const callTimeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS;
  const discovery = createHttpDiscovery({ host: LOOPBACK, port, timeoutMs: callTimeoutMs });
  const manager = new ConnectionManager({
    discovery: options.discovery === undefined ? discovery : options.discovery(discovery),
    connector: createCriConnector({ host: LOOPBACK, port, defaultTimeoutMs: callTimeoutMs }),
    logger: options.logger ?? quietLogger,
    callTimeoutMs,
    endpoint: endpointOf(port),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
  cleanups.push(() => manager.close());
  return manager;
}

function managerOn(server: FakeCdpServer, options: ManagerOptions = {}): ConnectionManager {
  return managerFor(server.port, options);
}

function listen(server: TcpServer): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK, () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: TcpServer): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

// A port that nothing listens on: it was free a moment ago, so connecting to it is refused.
async function closedPort(): Promise<number> {
  const server = createTcpServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

// Accepts connections and never answers, like an app that is frozen behind an open debug port.
async function startStalledServer(): Promise<number> {
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
  });
  const port = await listen(server);
  cleanups.push(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await closeServer(server);
  });
  return port;
}

// What the fake window of a tab reports as its visibility.
function tabWindow(state: 'visible' | 'hidden'): FakeTvWindow {
  return createFakeTvWindow(fixture, { visibilityState: state });
}

test('connects to the chart target and reuses the session', async () => {
  const { server } = await startApp();
  const manager = managerOn(server);

  const first = await manager.chartPage();
  const second = await manager.chartPage();

  expect(first.target.id).toBe(CHART_ID);
  expect(second.session).toBe(first.session);
  expect(second.bridge).toBe(first.bridge);
  expect(server.connectionCount()).toBe(1);
  expect(server.openConnectionCount()).toBe(1);
  // The handle works end to end: the bridge reaches the page through the cached session.
  await expect(first.bridge.evaluate(readVisibilityState, [])).resolves.toBe('visible');
});

test('re-resolves after the target disappears', async () => {
  const { server } = await startApp();
  const manager = managerOn(server);
  const first = await manager.chartPage();

  server.setTargets(appWith([chartTab(TAB_A, tabWindow('visible'))]));
  server.dropConnections();
  const second = await manager.chartPage();

  expect(first.target.id).toBe(CHART_ID);
  expect(second.target.id).toBe(TAB_A);
  expect(second.session).not.toBe(first.session);
  expect(first.session.isClosed).toBe(true);
  await expect(second.bridge.evaluate(readVisibilityState, [])).resolves.toBe('visible');
});

test('selects the visible tab when two chart targets exist', async () => {
  const hidden = tabWindow('hidden');
  const visible = tabWindow('visible');
  const server = await startServer(appWith([chartTab(TAB_A, hidden), chartTab(TAB_B, visible)]));
  const manager = managerOn(server);

  const page = await manager.chartPage();

  expect(page.target.id).toBe(TAB_B);
  await expect(page.bridge.evaluate(readVisibilityState, [])).resolves.toBe('visible');
});

test('skips blank targets that never answer', async () => {
  const { server } = await startApp();
  const manager = managerOn(server);
  const startedAt = performance.now();

  const page = await manager.chartPage();
  const elapsedMs = performance.now() - startedAt;

  expect(page.target.id).toBe(CHART_ID);
  // Touching a blank page would have waited for the call timeout.
  expect(elapsedMs).toBeLessThan(2000);
  for (const id of BLANK_IDS) {
    expect(server.connectionCount(id)).toBe(0);
  }
  expect(server.connectionCount()).toBe(1);
  expect(server.calls).toEqual([]);
});

test('health reports cdp unreachable within timeout', async () => {
  const port = await closedPort();
  const callTimeoutMs = 2000;
  const manager = managerFor(port, { callTimeoutMs });
  const startedAt = performance.now();

  const report = await manager.health();
  const elapsedMs = performance.now() - startedAt;

  expect(elapsedMs).toBeLessThan(callTimeoutMs);
  expect(report).toEqual({
    cdp: { reachable: false, endpoint: endpointOf(port) },
    chart: { found: false, tabs: 0 },
    app: { ready: false },
  });
});

test('health reports the app ready when TradingViewApi.isConnected() is true', async () => {
  const { server } = await startApp();
  const manager = managerOn(server);

  const report = await manager.health();

  expect(report).toEqual({
    cdp: {
      reachable: true,
      endpoint: endpointOf(server.port),
      browser: 'Chrome/146.0.7680.216',
      userAgent: expect.stringContaining('TradingView/3.4.1') as string,
    },
    chart: { found: true, tabs: 1, url: 'https://www.tradingview.com/chart/FIXTURE1/' },
    app: { ready: true, connected: true, buildTime: fixture.buildTime },
  });
});

test('health reports not ready when TradingViewApi is missing', async () => {
  const { server } = await startApp({ withoutApi: true });
  const manager = managerOn(server);

  const report = await manager.health();

  expect(report.cdp.reachable).toBe(true);
  expect(report.chart).toEqual({
    found: true,
    tabs: 1,
    url: 'https://www.tradingview.com/chart/FIXTURE1/',
  });
  // Nothing is said about the connection of an app that has no API to ask.
  expect(report.app).toEqual({ ready: false, buildTime: fixture.buildTime });
});

// Choosing a chart tab

test('selects the visible tab whichever order the tabs are listed in', async () => {
  const server = await startServer(
    appWith([chartTab(TAB_A, tabWindow('visible')), chartTab(TAB_B, tabWindow('hidden'))]),
  );
  const manager = managerOn(server);

  const page = await manager.chartPage();

  expect(page.target.id).toBe(TAB_A);
});

test('does not read the visibility of a lone chart tab', async () => {
  const { server } = await startApp();
  const manager = managerOn(server);

  await manager.chartPage();

  expect(server.calls).toEqual([]);
});

test('closes the sessions it opened only to look at the tabs it did not choose', async () => {
  const server = await startServer(
    appWith([chartTab(TAB_A, tabWindow('hidden')), chartTab(TAB_B, tabWindow('visible'))]),
  );
  const manager = managerOn(server);

  const page = await manager.chartPage();

  expect(page.target.id).toBe(TAB_B);
  expect(server.connectionCount(TAB_A)).toBe(1);
  await vi.waitFor(() => {
    expect(server.openConnectionCount(TAB_A)).toBe(0);
  });
  expect(server.openConnectionCount(TAB_B)).toBe(1);
  expect(page.session.isClosed).toBe(false);
});

test('keeps the session of the chosen tab and looks at the other tab again each time', async () => {
  const server = await startServer(
    appWith([chartTab(TAB_A, tabWindow('hidden')), chartTab(TAB_B, tabWindow('visible'))]),
  );
  const manager = managerOn(server);

  const first = await manager.chartPage();
  const second = await manager.chartPage();

  expect(second.session).toBe(first.session);
  expect(server.connectionCount(TAB_B)).toBe(1);
  // The user may have switched tabs, so the hidden one is asked again, on a short-lived session.
  expect(server.connectionCount(TAB_A)).toBe(2);
  await vi.waitFor(() => {
    expect(server.openConnectionCount()).toBe(1);
  });
});

test('follows the user to another tab without closing the session of the one it leaves', async () => {
  const windowA = tabWindow('visible');
  const windowB = tabWindow('hidden');
  const server = await startServer(appWith([chartTab(TAB_A, windowA), chartTab(TAB_B, windowB)]));
  const manager = managerOn(server);
  const onA = await manager.chartPage();

  inspectFakeWindow(windowA).state.visibilityState = 'hidden';
  inspectFakeWindow(windowB).state.visibilityState = 'visible';
  const onB = await manager.chartPage();

  expect(onA.target.id).toBe(TAB_A);
  expect(onB.target.id).toBe(TAB_B);
  // A call that still holds the page of the old tab must not lose its session to the switch.
  expect(onA.session.isClosed).toBe(false);
  await expect(onA.bridge.evaluate(readVisibilityState, [])).resolves.toBe('hidden');

  inspectFakeWindow(windowA).state.visibilityState = 'visible';
  inspectFakeWindow(windowB).state.visibilityState = 'hidden';
  const backOnA = await manager.chartPage();

  expect(backOnA.session).toBe(onA.session);
  expect(server.connectionCount(TAB_A)).toBe(1);
});

test('refuses to choose when several tabs are visible, and leaves no probe session open', async () => {
  const server = await startServer(
    appWith([chartTab(TAB_A, tabWindow('visible')), chartTab(TAB_B, tabWindow('visible'))]),
  );
  const manager = managerOn(server);

  const error = await failureOf(manager.chartPage());

  expect(error.code).toBe('TARGET_NOT_FOUND');
  expect(error.details).toEqual({
    tabs: [
      { id: TAB_A, url: `https://www.tradingview.com/chart/${TAB_A.slice(0, 8)}/` },
      { id: TAB_B, url: `https://www.tradingview.com/chart/${TAB_B.slice(0, 8)}/` },
    ],
  });
  await vi.waitFor(() => {
    expect(server.openConnectionCount()).toBe(0);
  });
});

test('refuses to choose when no tab is visible', async () => {
  const server = await startServer(
    appWith([chartTab(TAB_A, tabWindow('hidden')), chartTab(TAB_B, tabWindow('hidden'))]),
  );
  const manager = managerOn(server);

  const error = await failureOf(manager.chartPage());

  // The window chrome of the recorded list reports itself visible: the window is in view.
  expect(error.code).toBe('TARGET_NOT_FOUND');
  expect(error.message).toBe('2 chart tabs are open and it is unclear which one to use');
  // The sessions opened to look at the tabs are closed again. The window chrome, asked whether the
  // window is in view, keeps its session, which the tools of the tab strip share.
  await vi.waitFor(() => {
    expect(server.openConnectionCount(TAB_A)).toBe(0);
    expect(server.openConnectionCount(TAB_B)).toBe(0);
  });
  expect(server.openConnectionCount(WINDOW_CHROME_ID)).toBe(1);
  expect(server.openConnectionCount()).toBe(1);
});

test('counts a tab that does not answer as unknown and chooses the visible one', async () => {
  const server = await startServer(
    appWith([
      chartTab(TAB_A, tabWindow('visible'), 'silent'),
      chartTab(TAB_B, tabWindow('visible')),
    ]),
  );
  const manager = managerOn(server);
  const startedAt = performance.now();

  const page = await manager.chartPage();
  const elapsedMs = performance.now() - startedAt;

  expect(page.target.id).toBe(TAB_B);
  // It waited for the probe to give up on the silent tab, and not for the call timeout.
  expect(elapsedMs).toBeGreaterThanOrEqual(PROBE_TIMEOUT_MS - 100);
  expect(elapsedMs).toBeLessThan(CALL_TIMEOUT_MS);
  await vi.waitFor(() => {
    expect(server.openConnectionCount(TAB_A)).toBe(0);
  });
});

test('never connects to anything but the chart tab and the window chrome', async () => {
  const { server } = await startApp();
  const manager = managerOn(server);

  await manager.chartPage();
  await manager.windowChromePage();
  await manager.health();

  expect(server.connectionCount()).toBe(2);
  expect(server.connectionCount(CHART_ID)).toBe(1);
  expect(server.connectionCount(WINDOW_CHROME_ID)).toBe(1);
});

test('reports TARGET_NOT_FOUND when no chart tab is open, without connecting to anything', async () => {
  const server = await startServer(appWithout(CHART_ID));
  const manager = managerOn(server);

  const error = await failureOf(manager.chartPage());

  expect(error.code).toBe('TARGET_NOT_FOUND');
  expect(error.hint).toBeDefined();
  expect(server.connectionCount()).toBe(0);
});

// Reuse, dropped connections and overlapping calls

test('reconnects to the same target after the app drops the connection', async () => {
  const { server } = await startApp();
  const manager = managerOn(server);
  const first = await manager.chartPage();

  server.dropConnections();
  await vi.waitFor(() => {
    expect(first.session.isClosed).toBe(true);
  });
  const second = await manager.chartPage();

  expect(second.target.id).toBe(CHART_ID);
  expect(second.session).not.toBe(first.session);
  expect(server.connectionCount(CHART_ID)).toBe(2);
  await expect(second.bridge.evaluate(readVisibilityState, [])).resolves.toBe('visible');
});

test('closes the session of a target that left the list while the app still holds it open', async () => {
  const { server } = await startApp();
  const manager = managerOn(server);
  const first = await manager.chartPage();

  // No dropConnections: the app is still connected, but the tab is gone from the list.
  server.setTargets(appWith([chartTab(TAB_A, tabWindow('visible'))]));
  await manager.chartPage();

  expect(first.session.isClosed).toBe(true);
  await vi.waitFor(() => {
    expect(server.openConnectionCount(CHART_ID)).toBe(0);
  });
});

test('shares one connection between overlapping calls', async () => {
  const { server } = await startApp();
  const manager = managerOn(server);

  const pages = await Promise.all([manager.chartPage(), manager.chartPage(), manager.chartPage()]);

  expect(new Set(pages.map(({ session }) => session)).size).toBe(1);
  expect(server.connectionCount()).toBe(1);
});

test('shares the probe sessions between overlapping calls when two tabs are open', async () => {
  const server = await startServer(
    appWith([chartTab(TAB_A, tabWindow('hidden')), chartTab(TAB_B, tabWindow('visible'))]),
  );
  const manager = managerOn(server);

  const pages = await Promise.all([manager.chartPage(), manager.chartPage()]);

  expect(pages[1].session).toBe(pages[0].session);
  expect(pages[0].target.id).toBe(TAB_B);
  expect(pages[0].session.isClosed).toBe(false);
  expect(server.connectionCount(TAB_A)).toBe(1);
  expect(server.connectionCount(TAB_B)).toBe(1);
});

// Which failures are retried, with the errors the real adapters raise

function recordDelays(): { delays: number[]; sleep: (ms: number) => Promise<void> } {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

test('retries a closed debug port three times and then reports CDP_UNREACHABLE', async () => {
  const port = await closedPort();
  const { delays, sleep } = recordDelays();
  const manager = managerFor(port, { sleep });

  const error = await failureOf(manager.chartPage());

  expect(error.code).toBe('CDP_UNREACHABLE');
  expect(delays).toHaveLength(3);
});

test('does not retry a debug port that stalls', async () => {
  const callTimeoutMs = 300;
  const port = await startStalledServer();
  const { delays, sleep } = recordDelays();
  const manager = managerFor(port, { callTimeoutMs, sleep });
  const startedAt = performance.now();

  const error = await failureOf(manager.chartPage());
  const elapsedMs = performance.now() - startedAt;

  expect(error.code).toBe('TIMEOUT');
  expect(delays).toEqual([]);
  // One attempt waited for the deadline; four would have taken more than a second.
  expect(elapsedMs).toBeLessThan(callTimeoutMs * 3);
});

test('lists the targets again when the tab it listed is gone by the time it connects', async () => {
  const { server } = await startApp();
  const { delays, sleep } = recordDelays();
  // The first listing is out of date: it shows a tab that has closed since, with the address it
  // had, which the app now refuses.
  const closedTab = {
    ...chartTab(TAB_A, createFakeTvWindow(fixture)),
    webSocketDebuggerUrl: `ws://${LOOPBACK}:${String(server.port)}/devtools/page/${TAB_A}`,
  };
  let listed = 0;
  const manager = managerOn(server, {
    sleep,
    discovery: (real) => ({
      version: () => real.version(),
      targets: async () => {
        listed += 1;
        if (listed > 1) {
          return real.targets();
        }
        const { id, type, title, url, webSocketDebuggerUrl } = closedTab;
        return [{ id, type, title, url, webSocketDebuggerUrl }];
      },
    }),
  });

  const page = await manager.chartPage();

  expect(page.target.id).toBe(CHART_ID);
  expect(listed).toBe(2);
  expect(delays).toHaveLength(1);
  expect(server.connectionCount(TAB_A)).toBe(0);
});

// The window chrome

test('keeps one session per target for the chart and the window chrome', async () => {
  const { server } = await startApp();
  const manager = managerOn(server);

  const [chart, chrome, again] = await Promise.all([
    manager.chartPage(),
    manager.windowChromePage(),
    manager.windowChromePage(),
  ]);

  expect(chart.target.id).toBe(CHART_ID);
  expect(chrome.target.id).toBe(WINDOW_CHROME_ID);
  expect(chrome.session).not.toBe(chart.session);
  expect(again.session).toBe(chrome.session);
  expect(server.connectionCount(CHART_ID)).toBe(1);
  expect(server.connectionCount(WINDOW_CHROME_ID)).toBe(1);
  await expect(chrome.bridge.evaluate(readVisibilityState, [])).resolves.toBe('visible');
});

test('reports TARGET_NOT_FOUND when the window chrome is missing', async () => {
  const server = await startServer(appWithout(WINDOW_CHROME_ID));
  const manager = managerOn(server);

  const error = await failureOf(manager.windowChromePage());

  expect(error.code).toBe('TARGET_NOT_FOUND');
  expect(error.message).toMatch(/window chrome/i);
  expect(error.hint).toMatch(/window chrome/i);
  expect(server.connectionCount()).toBe(0);
});

// Health

test('health reports a connection the app lost', async () => {
  const { server, win } = await startApp();
  inspectFakeWindow(win).state.connected = false;
  const manager = managerOn(server);

  const report = await manager.health();

  expect(report.app).toEqual({ ready: false, connected: false, buildTime: fixture.buildTime });
});

test('health follows the app as it becomes ready', async () => {
  const { server, win } = await startApp();
  const manager = managerOn(server);
  inspectFakeWindow(win).state.connected = false;
  const before = await manager.health();

  inspectFakeWindow(win).state.connected = true;
  const after = await manager.health();

  expect(before.app.ready).toBe(false);
  expect(after.app.ready).toBe(true);
  // Both reports were read through the same session.
  expect(server.connectionCount(CHART_ID)).toBe(1);
});

test('health reports that no chart tab is open', async () => {
  const server = await startServer(appWithout(CHART_ID));
  const manager = managerOn(server);

  const report = await manager.health();

  expect(report.cdp.reachable).toBe(true);
  expect(report.chart).toEqual({ found: false, tabs: 0 });
  expect(report.app).toEqual({ ready: false });
  expect(server.connectionCount()).toBe(0);
});

test('health counts the tabs without choosing one when it is unclear which to use', async () => {
  const server = await startServer(
    appWith([chartTab(TAB_A, tabWindow('visible')), chartTab(TAB_B, tabWindow('visible'))]),
  );
  const manager = managerOn(server);

  const report = await manager.health();

  expect(report.chart).toEqual({ found: true, tabs: 2 });
  expect(report.app).toEqual({ ready: false });
});

test('health names the tab it read when it had to choose', async () => {
  const server = await startServer(
    appWith([chartTab(TAB_A, tabWindow('hidden')), chartTab(TAB_B, tabWindow('visible'))]),
  );
  const manager = managerOn(server);

  const report = await manager.health();

  expect(report.chart).toEqual({
    found: true,
    tabs: 2,
    url: `https://www.tradingview.com/chart/${TAB_B.slice(0, 8)}/`,
  });
  expect(report.app.ready).toBe(true);
});

test('health shares the session of the chart page instead of opening another', async () => {
  const { server } = await startApp();
  const manager = managerOn(server);

  await manager.health();
  const page = await manager.chartPage();
  await manager.health();

  expect(page.target.id).toBe(CHART_ID);
  expect(server.connectionCount()).toBe(1);
});

test('health returns within the call timeout when the page stalls', async () => {
  const callTimeoutMs = 600;
  const server = await startServer(
    appWith([chartTab(CHART_ID, createFakeTvWindow(fixture), 'silent')]),
  );
  const manager = managerOn(server, { callTimeoutMs });
  const startedAt = performance.now();

  const report = await manager.health();
  const elapsedMs = performance.now() - startedAt;

  expect(elapsedMs).toBeLessThan(callTimeoutMs + 400);
  expect(report.cdp.reachable).toBe(true);
  expect(report.chart).toEqual({
    found: true,
    tabs: 1,
    url: `https://www.tradingview.com/chart/${CHART_ID.slice(0, 8)}/`,
  });
  expect(report.app).toEqual({ ready: false });
});

test('health returns within the call timeout when the port accepts connections and never answers', async () => {
  const callTimeoutMs = 400;
  const port = await startStalledServer();
  const manager = managerFor(port, { callTimeoutMs });
  const startedAt = performance.now();

  const report = await manager.health();
  const elapsedMs = performance.now() - startedAt;

  expect(elapsedMs).toBeLessThan(callTimeoutMs + 400);
  expect(report).toEqual({
    cdp: { reachable: false, endpoint: endpointOf(port) },
    chart: { found: false, tabs: 0 },
    app: { ready: false },
  });
});

// Lifecycle

test('reset closes the cached sessions and the next call reconnects', async () => {
  const { server } = await startApp();
  const manager = managerOn(server);
  const first = await manager.chartPage();
  const chrome = await manager.windowChromePage();

  await manager.reset();

  expect(first.session.isClosed).toBe(true);
  expect(chrome.session.isClosed).toBe(true);
  await vi.waitFor(() => {
    expect(server.openConnectionCount()).toBe(0);
  });
  const second = await manager.chartPage();
  expect(second.session).not.toBe(first.session);
  expect(second.session.isClosed).toBe(false);
  expect(server.connectionCount(CHART_ID)).toBe(2);
});

test('close closes every session and may be called again', async () => {
  const { server } = await startApp();
  const manager = managerOn(server);
  const chart = await manager.chartPage();
  const chrome = await manager.windowChromePage();

  await manager.close();
  await manager.close();

  expect(chart.session.isClosed).toBe(true);
  expect(chrome.session.isClosed).toBe(true);
  await vi.waitFor(() => {
    expect(server.openConnectionCount()).toBe(0);
  });
});

test('close is final: later calls are refused and open nothing', async () => {
  const { server } = await startApp();
  const manager = managerOn(server);
  await manager.chartPage();
  await manager.close();

  const chart = await failureOf(manager.chartPage());
  const chrome = await failureOf(manager.windowChromePage());
  const report = await manager.health();

  expect(chart.code).toBe('INTERNAL');
  expect(chrome.code).toBe('INTERNAL');
  expect(report.app.ready).toBe(false);
  expect(server.connectionCount()).toBe(1);
});

// Logging

test('logs its decisions at debug level and no page data', async () => {
  const { server } = await startApp();
  const lines: string[] = [];
  const logger = createLogger({
    level: 'debug',
    destination: {
      write: (line) => {
        lines.push(line);
      },
    },
  });
  const manager = managerOn(server, { logger });

  await manager.chartPage();
  await manager.chartPage();
  server.setTargets(appWithout(CHART_ID));
  await failureOf(manager.chartPage());

  const records = lines.map(
    (line) => JSON.parse(line) as { level: number; msg: string; hostname?: string },
  );
  expect(records.length).toBeGreaterThan(0);
  expect(records.every(({ level }) => level === 20)).toBe(true);
  const messages = records.map(({ msg }) => msg);
  expect(messages).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/open/i),
      expect.stringMatching(/reus/i),
      expect.stringMatching(/gone|left/i),
    ]),
  );
  // Ids are fine to log. Where the page is (its URL) and what it is called (its title) are not.
  // The host name of the machine is in every record, so the check looks at the rest.
  const content = records
    .map((record) =>
      JSON.stringify(
        Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'hostname')),
      ),
    )
    .join('');
  expect(content).toContain(CHART_ID);
  expect(content).not.toContain('tradingview.com');
  expect(content).not.toContain('FIXTURE1');
  expect(content).not.toContain('Live stock');
});

// Chrome started with a debug port of its own, with a chart of tradingview.com in one of its tabs:
// the targets look like the app's, and only the user agent tells them apart.
test('refuses another browser on the debug port, even with a TradingView chart open in it', async () => {
  const win = createFakeTvWindow(fixture);
  const server = await startFakeCdpServer({
    targets: loadTargetsFixture({ chartWindow: () => win }),
    userAgent: CHROME_USER_AGENT,
  });
  cleanups.push(() => server.close());
  const manager = managerOn(server);

  const error = await failureOf(manager.chartPage());
  const report = await manager.health();

  expect(error).toMatchObject({ code: 'CDP_UNREACHABLE', details: { otherBrowser: true } });
  expect(error.hint).toMatch(/TV_CDP_PORT/);
  expect(report).toEqual({
    cdp: {
      reachable: false,
      endpoint: endpointOf(server.port),
      browser: 'Chrome/146.0.7680.216',
      userAgent: CHROME_USER_AGENT,
      otherBrowser: true,
    },
    chart: { found: false, tabs: 0 },
    app: { ready: false },
  });
  // Nothing of the browser was opened or read.
  expect(server.connectionCount()).toBe(0);
  expect(inspectFakeWindow(win).calls).toEqual([]);
});
