import type { CdpTargetInfo } from '../../../src/core/cdp/types.js';
import { ConnectionManager } from '../../../src/core/connection.js';
import { TimeoutError, TvMcpError } from '../../../src/core/errors.js';
import { readVisibilityState } from '../../../src/core/tv/probes.js';
import { failureOf } from '../../helpers/failure-of.js';
import {
  BLANK,
  CALL_TIMEOUT_MS,
  chart,
  CHROME,
  cleanUpHarness,
  createApp,
  createManager,
  type Deferred,
  deferred,
  ENDPOINT,
  evaluationsOf,
  failListingTimes,
  firstSessionOf,
  HELPER,
  IFRAME,
  openSessions,
  OTHER_SITE,
  PROBE_TIMEOUT_MS,
  quiet,
  sessionsOf,
  settle,
  setVisibility,
  track,
  unreachable,
  WORKER,
} from '../../helpers/fake-connection.js';

// The connection manager against in-memory fakes, for how it chooses and reuses sessions and how it
// retries. The same manager against the real adapters and the fake CDP server is in
// test/integration/connection.test.ts.

afterEach(cleanUpHarness);

describe('chartPage', () => {
  test('opens one session for the chart tab and hands it out again', async () => {
    const app = createApp([chart('A')]);
    const { manager } = createManager(app);

    const first = await manager.chartPage();
    const second = await manager.chartPage();

    expect(first.target).toEqual(chart('A'));
    expect(second).toBe(first);
    expect(first.session).toBe(firstSessionOf(app, 'A'));
    expect(first.session.targetId).toBe('A');
    expect(app.connects).toEqual(['A']);
  });

  test('lists the targets on every call, so that it notices a tab that came or went', async () => {
    const app = createApp([chart('A')]);
    const { manager } = createManager(app);

    await manager.chartPage();
    await manager.chartPage();
    await manager.chartPage();

    expect(app.listCalls).toBe(3);
  });

  test('never connects to a target that is not a chart tab', async () => {
    const app = createApp([CHROME, HELPER, BLANK, IFRAME, WORKER, OTHER_SITE, chart('A')]);
    const { manager } = createManager(app);

    await manager.chartPage();
    await manager.health();

    expect(app.connects).toEqual(['A']);
  });

  test('gives the bridge of a handle the call timeout as its default', async () => {
    const app = createApp([chart('A')]);
    const { manager } = createManager(app, { callTimeoutMs: 4321 });

    const { bridge } = await manager.chartPage();
    await bridge.evaluate(readVisibilityState, []);
    await bridge.evaluate(readVisibilityState, [], { timeoutMs: 99 });

    expect(evaluationsOf(firstSessionOf(app, 'A')).map(({ options }) => options)).toEqual([
      { timeoutMs: 4321 },
      { timeoutMs: 99 },
    ]);
  });

  test('shares one connection between overlapping calls', async () => {
    const app = createApp([chart('A')]);
    const gate = deferred();
    app.onConnect = () => gate.promise;
    const { manager } = createManager(app);

    const calls = [manager.chartPage(), manager.chartPage(), manager.chartPage()];
    await vi.waitFor(() => {
      expect(app.connects).toEqual(['A']);
    });
    await settle();
    gate.resolve();
    const pages = await Promise.all(calls);

    expect(new Set(pages).size).toBe(1);
    expect(app.sessions).toHaveLength(1);
    expect(app.connects).toEqual(['A']);
    expect(app.listCalls).toBe(1);
  });

  test('lets overlapping calls share a failure, and starts afresh for the next call', async () => {
    const app = createApp([chart('A')]);
    const failure = new TvMcpError('TIMEOUT', 'The target did not answer');
    app.onConnect = () => Promise.reject(failure);
    const { manager } = createManager(app);

    const overlapping = await Promise.allSettled([manager.chartPage(), manager.chartPage()]);
    app.onConnect = () => Promise.resolve();
    const later = await manager.chartPage();

    expect(overlapping).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ]);
    expect(app.connects).toEqual(['A', 'A']);
    expect(later.session.isClosed).toBe(false);
  });

  test('keeps a failed connection out of the cache', async () => {
    const app = createApp([chart('A')]);
    app.onConnect = () => Promise.reject(new TvMcpError('TIMEOUT', 'The target did not answer'));
    const { manager } = createManager(app);
    await failureOf(manager.chartPage());
    app.onConnect = () => Promise.resolve();

    const page = await manager.chartPage();
    const again = await manager.chartPage();

    expect(again).toBe(page);
    expect(app.connects).toEqual(['A', 'A']);
  });

  test('reports TARGET_NOT_FOUND with advice when no chart tab is open', async () => {
    const app = createApp([CHROME, HELPER, BLANK, IFRAME, WORKER, OTHER_SITE]);
    const { manager, delays } = createManager(app);

    const error = await failureOf(manager.chartPage());

    expect(error.code).toBe('TARGET_NOT_FOUND');
    expect(error.hint).toBeDefined();
    expect(app.connects).toEqual([]);
    expect(app.listCalls).toBe(1);
    expect(delays).toEqual([]);
  });

  test('drops the cached session when it closes, and connects again on the next call', async () => {
    const app = createApp([chart('A')]);
    const { manager } = createManager(app);
    const first = await manager.chartPage();

    firstSessionOf(app, 'A').drop();
    const second = await manager.chartPage();

    expect(first.session.isClosed).toBe(true);
    expect(second.session).not.toBe(first.session);
    expect(second.session.isClosed).toBe(false);
    expect(app.connects).toEqual(['A', 'A']);
  });

  test('closes and forgets the session of a target that left the list', async () => {
    const app = createApp([chart('A')]);
    const { manager } = createManager(app);
    const first = await manager.chartPage();

    app.listing = [chart('B')];
    const second = await manager.chartPage();

    expect(second.target.id).toBe('B');
    expect(firstSessionOf(app, 'A').closeCalls).toBe(1);
    expect(first.session.isClosed).toBe(true);
    // The tab comes back under the same id: it gets a session of its own, not the dead one.
    app.listing = [chart('A')];
    const third = await manager.chartPage();
    expect(third.session).not.toBe(first.session);
    expect(sessionsOf(app, 'A')).toHaveLength(2);
  });

  test('forgets the sessions of vanished targets when the targets are listed', async () => {
    const app = createApp([chart('A'), CHROME]);
    const { manager } = createManager(app);
    const chrome = await manager.windowChromePage();
    const page = await manager.chartPage();

    app.listing = [chart('A')];
    const listed = await manager.targets();
    await settle();

    expect(listed).toEqual([chart('A')]);
    expect(chrome.session.isClosed).toBe(true);
    expect(page.session.isClosed).toBe(false);
  });

  test('ignores a listing that was asked for before a newer one and arrived after it', async () => {
    const app = createApp([chart('A')]);
    const { manager } = createManager(app);
    const page = await manager.chartPage();
    const older = deferred<CdpTargetInfo[]>();
    const newer = deferred<CdpTargetInfo[]>();
    const answers = [older, newer];
    app.onList = () => answers.shift()?.promise ?? Promise.resolve([]);

    const first = manager.targets();
    const second = manager.targets();
    newer.resolve([chart('A')]);
    await second;
    // The older listing predates the newer one, so what it lacks is not news.
    older.resolve([]);
    await first;
    await settle();

    expect(page.session.isClosed).toBe(false);
    app.onList = () => Promise.resolve(app.listing);
    await expect(manager.chartPage()).resolves.toBe(page);
  });

  test('applies the listings in the order they were asked for when they arrive in that order', async () => {
    const app = createApp([chart('A')]);
    const { manager } = createManager(app);
    const page = await manager.chartPage();
    const older = deferred<CdpTargetInfo[]>();
    const newer = deferred<CdpTargetInfo[]>();
    const answers = [older, newer];
    app.onList = () => answers.shift()?.promise ?? Promise.resolve([]);

    const first = manager.targets();
    const second = manager.targets();
    older.resolve([chart('A')]);
    await first;
    await settle();
    expect(page.session.isClosed).toBe(false);
    newer.resolve([]);
    await second;
    await settle();

    expect(page.session.isClosed).toBe(true);
  });

  test('passes on what discovery reports when the targets cannot be listed', async () => {
    const app = createApp([chart('A')]);
    const timeout = new TimeoutError('CDP discovery GET /json/list', CALL_TIMEOUT_MS);
    app.onList = () => Promise.reject(timeout);
    const { manager } = createManager(app);

    await expect(manager.targets()).rejects.toBe(timeout);
    await expect(manager.chartPage()).rejects.toBe(timeout);
  });
});

describe('choosing among several chart tabs', () => {
  test('does not read the visibility of a lone tab', async () => {
    const app = createApp([chart('A')]);
    const { manager } = createManager(app);

    await manager.chartPage();

    expect(evaluationsOf(firstSessionOf(app, 'A'))).toEqual([]);
  });

  test('reads the visibility of every tab at once, giving each 1500 ms to answer', async () => {
    const app = createApp([chart('A'), chart('B'), chart('C')]);
    const states = { A: 'hidden', B: 'visible', C: 'hidden' } as const;
    const answers = new Map<string, Deferred<unknown>>();
    app.onEvaluate = (targetId) => {
      const answer = deferred<unknown>();
      answers.set(targetId, answer);
      return answer.promise;
    };
    const { manager } = createManager(app);

    const call = manager.chartPage();
    // All three are in flight before any of them answers, so the probes run in parallel.
    await vi.waitFor(() => {
      expect([...answers.keys()].sort()).toEqual(['A', 'B', 'C']);
    });
    for (const [targetId, answer] of answers) {
      answer.resolve({
        result: { type: 'string', value: states[targetId as keyof typeof states] },
      });
    }
    const page = await call;

    expect(page.target.id).toBe('B');
    for (const session of app.sessions) {
      expect(evaluationsOf(session).map(({ options }) => options)).toEqual([
        { timeoutMs: PROBE_TIMEOUT_MS },
      ]);
    }
  });

  test('chooses the only visible tab, wherever it is listed', async () => {
    const ids = ['A', 'B', 'C'];
    for (const [visibleIndex, visibleId] of ids.entries()) {
      const app = createApp(ids.map(chart));
      for (const id of ids) {
        setVisibility(app, id, id === visibleId ? 'visible' : 'hidden');
      }
      const { manager } = createManager(app);

      const page = await manager.chartPage();

      expect(page.target.id, `visible tab ${String(visibleIndex)}`).toBe(visibleId);
    }
  });

  test('counts a probe that fails as unknown', async () => {
    const app = createApp([chart('A'), chart('B')]);
    app.onEvaluate = (targetId, params) =>
      targetId === 'A'
        ? Promise.reject(new TimeoutError('CDP Runtime.evaluate on A', PROBE_TIMEOUT_MS))
        : app.evaluate(targetId, params);
    const { manager } = createManager(app);

    const page = await manager.chartPage();

    expect(page.target.id).toBe('B');
    expect(app.connects).toEqual(['A', 'B']);
  });

  test('counts a tab it cannot connect to as unknown, and does not retry for it', async () => {
    const app = createApp([chart('A'), chart('B')]);
    app.onConnect = (target) =>
      target.id === 'A' ? Promise.reject(unreachable(404)) : Promise.resolve();
    const { manager, delays } = createManager(app);

    const page = await manager.chartPage();

    expect(page.target.id).toBe('B');
    expect(app.connects).toEqual(['A', 'B']);
    expect(delays).toEqual([]);
  });

  test('cannot choose when the one tab that answers is hidden', async () => {
    const app = createApp([chart('A'), chart('B')]);
    setVisibility(app, 'A', 'hidden');
    app.onEvaluate = (targetId, params) =>
      targetId === 'B'
        ? Promise.reject(new TimeoutError('CDP Runtime.evaluate on B', PROBE_TIMEOUT_MS))
        : app.evaluate(targetId, params);
    const { manager } = createManager(app);

    const error = await failureOf(manager.chartPage());

    expect(error.code).toBe('TARGET_NOT_FOUND');
    expect(openSessions(app)).toEqual([]);
  });

  test('lists the tabs it could not choose between', async () => {
    const app = createApp([chart('A'), chart('B')]);
    const { manager, delays } = createManager(app);

    const error = await failureOf(manager.chartPage());

    expect(error.code).toBe('TARGET_NOT_FOUND');
    expect(error.details).toEqual({
      tabs: [
        { id: 'A', url: chart('A').url },
        { id: 'B', url: chart('B').url },
      ],
    });
    // A decision that needs the user is not a fault that waiting would cure.
    expect(delays).toEqual([]);
    expect(app.listCalls).toBe(1);
  });

  test('closes the sessions it opened to look at tabs, except the one it chose', async () => {
    const app = createApp([chart('A'), chart('B'), chart('C')]);
    setVisibility(app, 'A', 'hidden');
    setVisibility(app, 'B', 'visible');
    setVisibility(app, 'C', 'hidden');
    const { manager } = createManager(app);

    const page = await manager.chartPage();

    expect(page.session).toBe(firstSessionOf(app, 'B'));
    expect(openSessions(app)).toEqual([page.session]);
    expect(firstSessionOf(app, 'A').closeCalls).toBe(1);
    expect(firstSessionOf(app, 'C').closeCalls).toBe(1);
    expect(page.session.isClosed).toBe(false);
  });

  test('closes them when it cannot choose too', async () => {
    const app = createApp([chart('A'), chart('B')]);
    const { manager } = createManager(app);

    await failureOf(manager.chartPage());

    expect(app.sessions).toHaveLength(2);
    expect(openSessions(app)).toEqual([]);
  });

  test('reads the visibility of a tab it holds a session to over that session', async () => {
    const app = createApp([chart('A'), chart('B')]);
    setVisibility(app, 'A', 'visible');
    setVisibility(app, 'B', 'hidden');
    const { manager } = createManager(app);
    const first = await manager.chartPage();

    const second = await manager.chartPage();

    expect(second).toBe(first);
    expect(sessionsOf(app, 'A')).toHaveLength(1);
    // The tab that is not in use is asked again, over a session that does not outlive the call.
    expect(sessionsOf(app, 'B')).toHaveLength(2);
    expect(openSessions(app)).toEqual([first.session]);
    expect(evaluationsOf(firstSessionOf(app, 'A'))).toHaveLength(2);
  });

  test('leaves alone a session that was cached before the tabs were looked at', async () => {
    const app = createApp([chart('A'), chart('B')]);
    setVisibility(app, 'A', 'visible');
    setVisibility(app, 'B', 'hidden');
    const { manager } = createManager(app);
    const onA = await manager.chartPage();

    setVisibility(app, 'A', 'hidden');
    setVisibility(app, 'B', 'visible');
    const onB = await manager.chartPage();

    expect(onB.target.id).toBe('B');
    // Whoever still holds the page of tab A keeps a working session.
    expect(onA.session.isClosed).toBe(false);
    expect(firstSessionOf(app, 'A').closeCalls).toBe(0);
    setVisibility(app, 'A', 'visible');
    setVisibility(app, 'B', 'hidden');
    const backOnA = await manager.chartPage();
    expect(backOnA.session).toBe(onA.session);
    expect(sessionsOf(app, 'A')).toHaveLength(1);
    // Tab B had a short-lived session in the first call, which was closed, and the one the second
    // call kept. That one stays too, for whoever holds the page of tab B.
    const [probe, kept] = sessionsOf(app, 'B');
    expect(probe?.isClosed).toBe(true);
    expect(kept).toBe(onB.session);
    expect(kept?.isClosed).toBe(false);
    expect(openSessions(app)).toEqual([onA.session, onB.session]);
  });

  test('shares one resolution between overlapping calls, so they do not read the tabs against each other', async () => {
    const app = createApp([chart('A'), chart('B')]);
    setVisibility(app, 'A', 'hidden');
    setVisibility(app, 'B', 'visible');
    const { manager } = createManager(app);

    const pages = await Promise.all([
      manager.chartPage(),
      manager.chartPage(),
      manager.chartPage(),
    ]);

    expect(new Set(pages).size).toBe(1);
    expect(pages[0].target.id).toBe('B');
    expect(app.connects).toEqual(['A', 'B']);
    expect(app.listCalls).toBe(1);
    expect(pages[0].session.isClosed).toBe(false);
    expect(firstSessionOf(app, 'A').closeCalls).toBe(1);
  });

  test('keeps handing out the session of the chosen tab however often it looks', async () => {
    const app = createApp([chart('A'), chart('B')]);
    setVisibility(app, 'A', 'visible');
    setVisibility(app, 'B', 'hidden');
    const { manager } = createManager(app);

    const first = await manager.chartPage();
    const second = await manager.chartPage();
    const third = await manager.chartPage();

    for (const page of [first, second, third]) {
      expect(page.session.isClosed).toBe(false);
    }
    expect(openSessions(app)).toEqual([first.session]);
  });
});

describe('retrying', () => {
  test('retries a call that finds the app unreachable, waiting longer each time', async () => {
    const app = createApp([chart('A')]);
    failListingTimes(app, 3);
    const { manager, delays } = createManager(app);

    const page = await manager.chartPage();

    expect(page.target.id).toBe('A');
    expect(app.listCalls).toBe(4);
    expect(delays).toEqual([100, 200, 400]);
  });

  test('gives up after three retries with the last error', async () => {
    const app = createApp([chart('A')]);
    const failures = [unreachable(), unreachable(), unreachable(), unreachable()];
    app.onList = () =>
      Promise.reject(failures[app.listCalls - 1] ?? new Error('The targets were listed too often'));
    const { manager, delays } = createManager(app);

    await expect(manager.chartPage()).rejects.toBe(failures[3]);

    expect(app.listCalls).toBe(4);
    expect(delays).toEqual([100, 200, 400]);
    expect(app.connects).toEqual([]);
  });

  test('lists the targets again when a connection is refused, in case the tab went away', async () => {
    const app = createApp([chart('A')]);
    let refusals = 1;
    app.onConnect = () => {
      if (refusals > 0) {
        refusals -= 1;
        // The tab closed between the listing and the connection.
        app.listing = [chart('B')];
        return Promise.reject(unreachable(404));
      }
      return Promise.resolve();
    };
    const { manager, delays } = createManager(app);

    const page = await manager.chartPage();

    expect(page.target.id).toBe('B');
    expect(app.connects).toEqual(['A', 'B']);
    expect(app.listCalls).toBe(2);
    expect(delays).toEqual([100]);
  });

  test('draws each delay between zero and the limit of the attempt', async () => {
    const app = createApp([chart('A')]);
    failListingTimes(app, 2);
    const { manager, delays } = createManager(app, { random: () => 0.5 });

    await manager.chartPage();

    expect(delays).toEqual([50, 100]);
  });

  test.each([
    ['a timeout', new TimeoutError('CDP discovery GET /json/list', CALL_TIMEOUT_MS)],
    ['a missing target', new TvMcpError('TARGET_NOT_FOUND', 'No such target')],
    ['a failing page', new TvMcpError('PAGE_EVALUATION_FAILED', 'The page threw')],
    ['an internal error', new TvMcpError('INTERNAL', 'A bug')],
    ['an error of no known kind', new Error('boom')],
  ])('does not retry %s', async (_case, failure) => {
    const app = createApp([chart('A')]);
    app.onList = () => Promise.reject(failure);
    const { manager, delays } = createManager(app);

    await expect(manager.chartPage()).rejects.toBe(failure);

    expect(app.listCalls).toBe(1);
    expect(delays).toEqual([]);
  });

  test('does not retry a connection that times out', async () => {
    const app = createApp([chart('A')]);
    const failure = new TimeoutError('CDP connect to A', CALL_TIMEOUT_MS);
    app.onConnect = () => Promise.reject(failure);
    const { manager, delays } = createManager(app);

    await expect(manager.chartPage()).rejects.toBe(failure);

    expect(app.connects).toEqual(['A']);
    expect(delays).toEqual([]);
  });

  test('retries the window chrome the same way', async () => {
    const app = createApp([CHROME]);
    let refusals = 2;
    app.onConnect = () => {
      if (refusals > 0) {
        refusals -= 1;
        return Promise.reject(unreachable());
      }
      return Promise.resolve();
    };
    const { manager, delays } = createManager(app);

    const page = await manager.windowChromePage();

    expect(page.target.id).toBe('CHROME');
    expect(delays).toEqual([100, 200]);
  });

  test('waits for real when nothing replaces the sleep', async () => {
    const app = createApp([chart('A')]);
    failListingTimes(app, 1);
    const manager = new ConnectionManager({
      discovery: app.discovery,
      connector: app.connector,
      logger: quiet,
      callTimeoutMs: CALL_TIMEOUT_MS,
      endpoint: ENDPOINT,
    });
    track(manager);
    const startedAt = performance.now();

    const page = await manager.chartPage();

    // The first delay is drawn between 0 and 100 ms.
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(page.target.id).toBe('A');
    expect(app.listCalls).toBe(2);
  });
});

describe('windowChromePage', () => {
  test('opens a session for the window chrome and hands it out again', async () => {
    const app = createApp([chart('A'), CHROME, HELPER, BLANK]);
    const { manager } = createManager(app);

    const first = await manager.windowChromePage();
    const second = await manager.windowChromePage();

    expect(first.target).toEqual(CHROME);
    expect(second).toBe(first);
    expect(app.connects).toEqual(['CHROME']);
  });

  test('keeps a session of its own, apart from the chart tab', async () => {
    const app = createApp([chart('A'), CHROME]);
    const { manager } = createManager(app);

    const [chrome, tab, again] = await Promise.all([
      manager.windowChromePage(),
      manager.chartPage(),
      manager.windowChromePage(),
    ]);

    expect(chrome.session).not.toBe(tab.session);
    expect(again.session).toBe(chrome.session);
    expect([...app.connects].sort()).toEqual(['A', 'CHROME']);
  });

  test('shares one connection between overlapping calls', async () => {
    const app = createApp([CHROME]);
    const gate = deferred();
    app.onConnect = () => gate.promise;
    const { manager } = createManager(app);

    const first = manager.windowChromePage();
    const second = manager.windowChromePage();
    await vi.waitFor(() => {
      expect(app.connects).toEqual(['CHROME']);
    });
    await settle();
    gate.resolve();
    const pages = await Promise.all([first, second]);

    expect(pages[1].session).toBe(pages[0].session);
    expect(app.connects).toEqual(['CHROME']);
  });

  test('reports TARGET_NOT_FOUND, naming the window chrome, when it is not there', async () => {
    const app = createApp([chart('A'), HELPER, BLANK, IFRAME]);
    const { manager, delays } = createManager(app);

    const error = await failureOf(manager.windowChromePage());

    expect(error.code).toBe('TARGET_NOT_FOUND');
    expect(error.message).toMatch(/window chrome/i);
    expect(error.hint).toMatch(/window chrome/i);
    expect(app.connects).toEqual([]);
    expect(delays).toEqual([]);
  });
});
