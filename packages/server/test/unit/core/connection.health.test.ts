import type { CdpTargetInfo, CdpVersionInfo } from '../../../src/core/cdp/types.js';
import { TimeoutError } from '../../../src/core/errors.js';
import { createLogger } from '../../../src/core/logger.js';
import { failureOf } from '../../helpers/failure-of.js';
import { createFakeTvWindow, inspectFakeWindow } from '../../helpers/fake-tv/window.js';
import {
  BLANK,
  chart,
  CHROME,
  cleanUpHarness,
  createApp,
  createManager,
  deferred,
  ENDPOINT,
  evaluationsOf,
  failing,
  failListingTimes,
  firstSessionOf,
  fixture,
  HELPER,
  never,
  openSessions,
  PRIVATE_TITLE,
  PROBE_TIMEOUT_MS,
  settle,
  setVisibility,
  unreachable,
  windowFor,
} from '../../helpers/fake-connection.js';

// The health report of the connection manager, and what it writes to the log.

afterEach(cleanUpHarness);

describe('health', () => {
  const BROWSER = { browser: 'Chrome/146.0.7680.216', userAgent: 'TradingView/3.4.1' };
  const READY = {
    cdp: { reachable: true, endpoint: ENDPOINT, ...BROWSER },
    chart: { found: true, tabs: 1, url: chart('A').url },
    app: { ready: true, connected: true, buildTime: fixture.buildTime },
  };

  test('reports a running app that is connected', async () => {
    const app = createApp([chart('A')]);
    const { manager } = createManager(app);

    await expect(manager.health()).resolves.toEqual(READY);
  });

  test('reports the browser as the debug port names it', async () => {
    const app = createApp([chart('A')]);
    app.onVersion = () =>
      Promise.resolve({
        browser: 'Chrome/147.0.1',
        protocolVersion: '1.3',
        userAgent: 'Other/1.0',
        v8Version: '15.0',
      });
    const { manager } = createManager(app);

    const report = await manager.health();

    expect(report.cdp).toEqual({
      reachable: true,
      endpoint: ENDPOINT,
      browser: 'Chrome/147.0.1',
      userAgent: 'Other/1.0',
    });
  });

  test.each<[string, unknown]>([
    ['the port refuses', unreachable()],
    ['discovery times out', new TimeoutError('CDP discovery GET /json/version', 400)],
    ['an unexpected error occurs', new Error('boom')],
    ['something that is not an error is thrown', 'weird'],
  ])('never throws when %s', async (_case, failure) => {
    const app = createApp([chart('A')]);
    app.onVersion = failing(failure);
    const { manager, delays } = createManager(app);

    const report = await manager.health();

    expect(report).toEqual({
      cdp: { reachable: false, endpoint: ENDPOINT },
      chart: { found: false, tabs: 0 },
      app: { ready: false },
    });
    // One look, however it fails: a poller asks again, and a check that retried would answer late.
    expect(app.versionCalls).toBe(1);
    expect(delays).toEqual([]);
    expect(app.connects).toEqual([]);
  });

  test('reports the endpoint it was given when the app does not answer', async () => {
    const app = createApp([chart('A')]);
    app.onVersion = () => Promise.reject(unreachable());
    const { manager } = createManager(app, { endpoint: 'http://127.0.0.1:9444' });

    const report = await manager.health();

    expect(report.cdp.endpoint).toBe('http://127.0.0.1:9444');
  });

  test('stops at the call timeout when the app never answers', async () => {
    const app = createApp([chart('A')]);
    app.onVersion = () => never<CdpVersionInfo>();
    const { manager } = createManager(app, { callTimeoutMs: 60 });
    const startedAt = performance.now();

    const report = await manager.health();
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(50);
    expect(elapsedMs).toBeLessThan(400);
    expect(report.cdp).toEqual({ reachable: false, endpoint: ENDPOINT });
  });

  test('keeps what it learned before the call timeout', async () => {
    const app = createApp([chart('A')]);
    app.onList = () => never<CdpTargetInfo[]>();
    const { manager } = createManager(app, { callTimeoutMs: 60 });

    const report = await manager.health();

    expect(report).toEqual({
      cdp: { reachable: true, endpoint: ENDPOINT, ...BROWSER },
      chart: { found: false, tabs: 0 },
      app: { ready: false },
    });
  });

  test('keeps what it learned when the targets cannot be listed', async () => {
    const app = createApp([chart('A')]);
    app.onList = () => Promise.reject(unreachable());
    const { manager } = createManager(app);

    const report = await manager.health();

    expect(report).toEqual({
      cdp: { reachable: true, endpoint: ENDPOINT, ...BROWSER },
      chart: { found: false, tabs: 0 },
      app: { ready: false },
    });
  });

  test('returns a report that later work cannot change', async () => {
    const app = createApp([chart('A')]);
    const late = deferred<CdpTargetInfo[]>();
    app.onList = () => late.promise;
    const { manager } = createManager(app, { callTimeoutMs: 40 });

    const report = await manager.health();
    const before = JSON.stringify(report);
    late.resolve([chart('A')]);
    // The abandoned check goes on to connect and read the page.
    await vi.waitFor(() => {
      expect(app.connects).toEqual(['A']);
    });
    await vi.waitFor(() => {
      expect(evaluationsOf(firstSessionOf(app, 'A'))).toHaveLength(1);
    });
    await settle();

    expect(JSON.stringify(report)).toBe(before);
    expect(report.chart).toEqual({ found: false, tabs: 0 });
  });

  test('reports the tabs it found when it cannot read the app', async () => {
    const app = createApp([chart('A')]);
    app.onConnect = () => Promise.reject(unreachable(404));
    const { manager } = createManager(app);

    const report = await manager.health();

    expect(report.cdp.reachable).toBe(true);
    expect(report.chart).toEqual({ found: true, tabs: 1, url: chart('A').url });
    expect(report.app).toEqual({ ready: false });
  });

  test('returns within the call timeout when the connection to the chart tab hangs', async () => {
    const app = createApp([chart('A')]);
    const gate = deferred();
    app.onConnect = () => gate.promise;
    const { manager } = createManager(app, { callTimeoutMs: 60 });
    const startedAt = performance.now();

    const report = await manager.health();
    const elapsedMs = performance.now() - startedAt;
    gate.resolve();

    expect(elapsedMs).toBeLessThan(400);
    expect(report.cdp.reachable).toBe(true);
    expect(report.app.ready).toBe(false);
  });

  test('returns within the call timeout when the page stalls', async () => {
    const app = createApp([chart('A')]);
    app.onEvaluate = () => never<unknown>();
    const { manager } = createManager(app, { callTimeoutMs: 60 });
    const startedAt = performance.now();

    const report = await manager.health();
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(400);
    expect(report.chart).toEqual({ found: true, tabs: 1, url: chart('A').url });
    expect(report.app).toEqual({ ready: false });
  });

  test('reports a page whose probe fails as not ready', async () => {
    const app = createApp([chart('A')]);
    app.onEvaluate = () =>
      Promise.resolve({
        result: { type: 'object', subtype: 'error' },
        exceptionDetails: { exceptionId: 1, text: 'Uncaught', lineNumber: 0, columnNumber: 0 },
      });
    const { manager } = createManager(app);

    const report = await manager.health();

    expect(report.cdp.reachable).toBe(true);
    expect(report.app).toEqual({ ready: false });
  });

  test('reports an app that has not connected yet', async () => {
    const app = createApp([chart('A')]);
    inspectFakeWindow(windowFor(app, 'A')).state.connected = false;
    const { manager } = createManager(app);

    const report = await manager.health();

    expect(report.app).toEqual({ ready: false, connected: false, buildTime: fixture.buildTime });
  });

  test('reports a page whose app has not started, with its build', async () => {
    const app = createApp([chart('A')]);
    app.windows.set('A', createFakeTvWindow(fixture, { withoutApi: true }));
    const { manager } = createManager(app);

    const report = await manager.health();

    expect(report.app).toEqual({ ready: false, buildTime: fixture.buildTime });
  });

  test('reports a build time of null for a page that does not say', async () => {
    const app = createApp([chart('A')]);
    const win = createFakeTvWindow(fixture) as unknown as Record<string, unknown>;
    delete win.BUILD_TIME;
    app.windows.set('A', win);
    const { manager } = createManager(app);

    const report = await manager.health();

    expect(report.app).toEqual({ ready: true, connected: true, buildTime: null });
  });

  test('reads the app with the session the chart page uses', async () => {
    const app = createApp([chart('A')]);
    const { manager } = createManager(app);

    await manager.health();
    const page = await manager.chartPage();
    await manager.health();

    expect(app.sessions).toEqual([page.session]);
    expect(app.connects).toEqual(['A']);
  });

  test('reports that there is no chart tab, and does not connect to anything', async () => {
    const app = createApp([CHROME, HELPER, BLANK]);
    const { manager } = createManager(app);

    const report = await manager.health();

    expect(report).toEqual({
      cdp: { reachable: true, endpoint: ENDPOINT, ...BROWSER },
      chart: { found: false, tabs: 0 },
      app: { ready: false },
    });
    expect(app.connects).toEqual([]);
  });

  test('counts the chart tabs and leaves the choice alone when it is unclear', async () => {
    const app = createApp([chart('A'), chart('B'), chart('C')]);
    const { manager } = createManager(app);

    const report = await manager.health();

    expect(report.chart).toEqual({ found: true, tabs: 3 });
    expect(report.app).toEqual({ ready: false });
    expect(openSessions(app)).toEqual([]);
  });

  test('names the url the targets list now for the tab it read', async () => {
    const app = createApp([chart('A'), chart('B')]);
    setVisibility(app, 'A', 'hidden');
    setVisibility(app, 'B', 'visible');
    const { manager } = createManager(app);
    await manager.health();

    // The layout of the tab changed under the same id.
    const moved = { ...chart('B'), url: 'https://www.tradingview.com/chart/NEWLAYOUT/' };
    app.listing = [chart('A'), moved];
    const report = await manager.health();

    expect(report.chart).toEqual({ found: true, tabs: 2, url: moved.url });
  });

  test('names the url of the tab it read when the tab came after its own listing', async () => {
    const app = createApp([chart('A')]);
    const listings = [[chart('A')], [chart('B')]];
    let asked = 0;
    app.onList = () => {
      const listing = listings[Math.min(asked, listings.length - 1)] ?? [];
      asked += 1;
      return Promise.resolve(listing);
    };
    const { manager } = createManager(app);

    const report = await manager.health();

    expect(report.chart).toEqual({ found: true, tabs: 1, url: chart('B').url });
    expect(app.connects).toEqual(['B']);
  });

  test('still reports after close, without opening anything', async () => {
    const app = createApp([chart('A')]);
    const { manager } = createManager(app);
    await manager.close();

    const report = await manager.health();

    expect(report.cdp.reachable).toBe(true);
    expect(report.chart).toEqual({ found: true, tabs: 1, url: chart('A').url });
    expect(report.app).toEqual({ ready: false });
    expect(app.connects).toEqual([]);
  });
});

describe('logging', () => {
  function capture() {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'debug',
      destination: {
        write: (line) => {
          lines.push(line);
        },
      },
    });
    const records = () =>
      lines.map((line) => JSON.parse(line) as { level: number; msg: string; targetId?: string });
    return { logger, records, lines };
  }

  test('logs when it opens, reuses and forgets a session, at debug level', async () => {
    const app = createApp([chart('A')]);
    const { logger, records } = capture();
    const { manager } = createManager(app, { logger });

    await manager.chartPage();
    await manager.chartPage();
    firstSessionOf(app, 'A').drop();
    app.listing = [chart('B')];
    await manager.chartPage();

    const logged = records();
    expect(logged.every(({ level }) => level === 20)).toBe(true);
    const about = (pattern: RegExp) =>
      logged.filter(({ msg }) => pattern.test(msg)).map(({ targetId }) => targetId);
    expect(about(/open/i)).toEqual(['A', 'B']);
    expect(about(/reus/i)).toEqual(['A']);
    expect(about(/forget/i)).toEqual(['A']);
  });

  test('logs which tab it chose among several', async () => {
    const app = createApp([chart('A'), chart('B')]);
    setVisibility(app, 'A', 'hidden');
    setVisibility(app, 'B', 'visible');
    const { logger, records } = capture();
    const { manager } = createManager(app, { logger });

    await manager.chartPage();

    const chosen = records().filter(({ msg }) => /chose/i.test(msg));
    expect(chosen).toHaveLength(1);
    expect(chosen[0]).toMatchObject({ targetId: 'B', candidates: 2 });
  });

  test('logs a target that left the list', async () => {
    const app = createApp([chart('A')]);
    const { logger, records } = capture();
    const { manager } = createManager(app, { logger });
    await manager.chartPage();

    app.listing = [chart('B')];
    await manager.chartPage();

    const gone = records().filter(({ msg }) => /gone|left/i.test(msg));
    expect(gone.map(({ targetId }) => targetId)).toEqual(['A']);
  });

  test('logs a probe that failed, and a retry, by their codes', async () => {
    const app = createApp([chart('A'), chart('B')]);
    app.onEvaluate = (targetId, params) =>
      targetId === 'A'
        ? Promise.reject(new TimeoutError('CDP Runtime.evaluate on A', PROBE_TIMEOUT_MS))
        : app.evaluate(targetId, params);
    failListingTimes(app, 1);
    const { logger, lines } = capture();
    const { manager } = createManager(app, { logger });

    await manager.chartPage();

    const everything = lines.join('');
    expect(everything).toContain('TIMEOUT');
    expect(everything).toContain('CDP_UNREACHABLE');
  });

  test('never logs the url or the title of a page', async () => {
    const app = createApp([chart('A'), chart('B')]);
    setVisibility(app, 'A', 'hidden');
    setVisibility(app, 'B', 'visible');
    const { logger, records } = capture();
    const { manager } = createManager(app, { logger });

    await manager.chartPage();
    await manager.health();
    app.listing = [];
    await failureOf(manager.chartPage());

    // The host name of the machine is in every record, so the check looks at the rest.
    const content = records()
      .map((record) =>
        JSON.stringify(
          Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'hostname')),
        ),
      )
      .join('');
    expect(content.length).toBeGreaterThan(0);
    expect(content).not.toContain('tradingview.com');
    expect(content).not.toContain(PRIVATE_TITLE);
  });
});
