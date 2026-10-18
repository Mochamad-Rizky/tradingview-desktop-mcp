import type { CdpTargetInfo } from '../../../src/core/cdp/types.js';
import { failureOf } from '../../helpers/failure-of.js';
import {
  chart,
  CHROME,
  cleanUpHarness,
  createApp,
  createManager,
  type Deferred,
  deferred,
  firstSessionOf,
  openSessions,
  settle,
  unreachable,
} from '../../helpers/fake-connection.js';

// How the connection manager lets go of its sessions: reset, and close, which is final.

afterEach(cleanUpHarness);

describe('reset and close', () => {
  test('reset closes every cached session, and the next call connects again', async () => {
    const app = createApp([chart('A'), CHROME]);
    const { manager } = createManager(app);
    const tab = await manager.chartPage();
    const chrome = await manager.windowChromePage();

    await manager.reset();

    expect(tab.session.isClosed).toBe(true);
    expect(chrome.session.isClosed).toBe(true);
    const again = await manager.chartPage();
    expect(again.session).not.toBe(tab.session);
    expect(openSessions(app)).toEqual([again.session]);
  });

  test('reset has nothing to do when nothing is cached', async () => {
    const app = createApp([chart('A')]);
    const { manager } = createManager(app);

    await expect(manager.reset()).resolves.toBeUndefined();
    await expect(manager.reset()).resolves.toBeUndefined();
  });

  test('reset closes the session of a connection that was still opening', async () => {
    const app = createApp([chart('A')]);
    const gate = deferred();
    app.onConnect = () => gate.promise;
    const { manager } = createManager(app);
    const call = manager.chartPage();
    await vi.waitFor(() => {
      expect(app.connects).toEqual(['A']);
    });

    const resetting = manager.reset();
    gate.resolve();
    await resetting;
    await call;

    // Nothing is left behind from before the reset.
    expect(openSessions(app)).toEqual([]);
    const next = await manager.chartPage();
    expect(openSessions(app)).toEqual([next.session]);
  });

  test('reset keeps a call made right after it from getting the session it is closing', async () => {
    const app = createApp([CHROME]);
    const gate = deferred();
    let held = true;
    app.onConnect = () => (held ? gate.promise : Promise.resolve());
    const { manager } = createManager(app);
    const before = manager.windowChromePage();
    await vi.waitFor(() => {
      expect(app.connects).toEqual(['CHROME']);
    });

    const resetting = manager.reset();
    held = false;
    const after = await manager.windowChromePage();
    gate.resolve();
    await resetting;
    await before;

    expect(app.connects).toEqual(['CHROME', 'CHROME']);
    expect(after.session.isClosed).toBe(false);
    // Of the two sessions the target was given, only the newer one is left.
    expect(openSessions(app)).toEqual([after.session]);
  });

  test('close closes every cached session, once', async () => {
    const app = createApp([chart('A'), CHROME]);
    const { manager } = createManager(app);
    await manager.chartPage();
    await manager.windowChromePage();

    await manager.close();
    await manager.close();

    expect(app.sessions).toHaveLength(2);
    expect(app.sessions.map(({ closeCalls }) => closeCalls)).toEqual([1, 1]);
  });

  test('close called twice at once waits for the same work', async () => {
    const app = createApp([chart('A')]);
    const { manager } = createManager(app);
    await manager.chartPage();

    const first = manager.close();
    const second = manager.close();

    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(openSessions(app)).toEqual([]);
  });

  test('close refuses new calls instead of connecting after shutdown', async () => {
    const app = createApp([chart('A'), CHROME]);
    const { manager } = createManager(app);
    await manager.chartPage();
    await manager.close();

    const tab = await failureOf(manager.chartPage());
    const chrome = await failureOf(manager.windowChromePage());

    expect(tab.code).toBe('INTERNAL');
    expect(chrome.code).toBe('INTERNAL');
    expect(app.connects).toEqual(['A']);
  });

  test('close is not undone by a connection that finishes afterwards', async () => {
    const app = createApp([chart('A')]);
    const gate = deferred();
    app.onConnect = () => gate.promise;
    const { manager, delays } = createManager(app);
    const call = failureOf(manager.chartPage());
    await vi.waitFor(() => {
      expect(app.connects).toEqual(['A']);
    });

    const closing = manager.close();
    gate.resolve();
    await closing;
    const error = await call;

    expect(error.code).toBe('INTERNAL');
    expect(app.sessions).toHaveLength(1);
    expect(openSessions(app)).toEqual([]);
    // The refusal is not a fault that retrying would cure.
    expect(delays).toEqual([]);
  });

  test('close while the tabs are being looked at reports the closure, not an unclear choice', async () => {
    const app = createApp([chart('A'), chart('B')]);
    const answers = new Map<string, Deferred<unknown>>();
    app.onEvaluate = (targetId) => {
      const answer = deferred<unknown>();
      answers.set(targetId, answer);
      return answer.promise;
    };
    const { manager, delays } = createManager(app);
    const call = failureOf(manager.chartPage());
    await vi.waitFor(() => {
      expect(answers.size).toBe(2);
    });

    const closing = manager.close();
    for (const answer of answers.values()) {
      answer.resolve({ result: { type: 'string', value: 'visible' } });
    }
    await closing;
    const error = await call;

    expect(error.code).toBe('INTERNAL');
    expect(delays).toEqual([]);
    expect(openSessions(app)).toEqual([]);
  });

  test.each([
    ['a lone chart tab', [chart('A')]],
    ['several chart tabs', [chart('A'), chart('B')]],
  ])('close while the targets are being listed opens nothing, with %s', async (_case, listing) => {
    const app = createApp(listing);
    const listed = deferred<CdpTargetInfo[]>();
    app.onList = () => listed.promise;
    const { manager } = createManager(app);
    const call = failureOf(manager.chartPage());
    await vi.waitFor(() => {
      expect(app.listCalls).toBe(1);
    });

    await manager.close();
    listed.resolve(listing);
    const error = await call;

    expect(error.code).toBe('INTERNAL');
    expect(app.connects).toEqual([]);
  });

  test('close stops a call that is waiting to retry', async () => {
    const app = createApp([chart('A')]);
    app.onList = () => Promise.reject(unreachable());
    const wake = deferred();
    const { manager } = createManager(app, { sleep: () => wake.promise });
    const call = failureOf(manager.chartPage());
    await vi.waitFor(() => {
      expect(app.listCalls).toBe(1);
    });
    await settle();

    await manager.close();
    wake.resolve();
    const error = await call;

    expect(error.code).toBe('INTERNAL');
    expect(app.listCalls).toBe(1);
    expect(app.connects).toEqual([]);
  });

  test('close leaves the listing of targets usable', async () => {
    const app = createApp([chart('A')]);
    const { manager } = createManager(app);
    await manager.close();

    await expect(manager.targets()).resolves.toEqual([chart('A')]);
  });

  test('a session that fails to close does not stop the others from closing', async () => {
    const app = createApp([chart('A'), CHROME]);
    const { manager } = createManager(app);
    const tab = await manager.chartPage();
    await manager.windowChromePage();
    firstSessionOf(app, 'A').close = () => Promise.reject(new Error('The peer will not close'));

    await expect(manager.reset()).resolves.toBeUndefined();

    expect(tab.session.isClosed).toBe(false);
    expect(firstSessionOf(app, 'CHROME').isClosed).toBe(true);
  });
});
