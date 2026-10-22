import { setImmediate as nextMacrotask } from 'node:timers/promises';
import type {
  CdpConnector,
  CdpDiscovery,
  CdpSession,
  CdpTargetInfo,
  CdpVersionInfo,
} from '../../src/core/cdp/types.js';
import { ConnectionManager, type ConnectionManagerDeps } from '../../src/core/connection.js';
import { TvMcpError } from '../../src/core/errors.js';
import { createLogger } from '../../src/core/logger.js';
import { createPageRuntime, type PageRuntime } from './fake-cdp/runtime.js';
import { CHROME_USER_AGENT } from './fake-cdp/server.js';
import { loadTvFixture } from './fake-tv/fixture.js';
import { createFakeTvWindow, inspectFakeWindow } from './fake-tv/window.js';

// In-memory stand-ins for discovery, the connector and the sessions of the app, for the unit tests
// of the connection manager. Unlike the fake CDP server they have no sockets, so a test can hold
// a connection half-open, fail a listing, or answer a listing late. The manager against the real
// adapters and the fake CDP server is tested in test/integration/connection.test.ts.

export const fixture = loadTvFixture();
export const ENDPOINT = 'http://127.0.0.1:9333';
export const CALL_TIMEOUT_MS = 1000;
export const PROBE_TIMEOUT_MS = 1500;
// Something a page says about itself, which must never end up in a log.
export const PRIVATE_TITLE = 'Private layout title';
// What /json/version answers when another browser holds the debug port: a Chrome that was started
// with a debug port of its own. Its user agent names no TradingView.
export const OTHER_BROWSER: CdpVersionInfo = {
  browser: 'Chrome/146.0.7680.216',
  protocolVersion: '1.3',
  userAgent: CHROME_USER_AGENT,
};

export function chart(id: string): CdpTargetInfo {
  return {
    id,
    type: 'page',
    title: PRIVATE_TITLE,
    url: `https://www.tradingview.com/chart/${id}/`,
  };
}

export const CHROME: CdpTargetInfo = {
  id: 'CHROME',
  type: 'page',
  title: 'index.html',
  url: 'file:///Applications/TradingView.app/Contents/Resources/app.asar/app/window/index.html?rendererInitialData=%7B%7D',
};
export const HELPER: CdpTargetInfo = {
  id: 'HELPER',
  type: 'page',
  title: 'index.html',
  url: 'file:///Applications/TradingView.app/Contents/Resources/app.asar/app/tooltip/index.html',
};
// TradingView's local New tab page, which a new tab opens on (notes of Plan 3, section 3.2). It has
// Node integration, so the manager must never connect to it.
export const NEW_TAB: CdpTargetInfo = {
  id: 'NEWTAB',
  type: 'page',
  title: 'index.html',
  url: 'file:///Applications/TradingView.app/Contents/Resources/app.asar/app/new-tab/index.html',
};
export const BLANK: CdpTargetInfo = { id: 'BLANK', type: 'page', title: '', url: '' };
export const IFRAME: CdpTargetInfo = {
  id: 'IFRAME',
  type: 'iframe',
  title: 'https://www.google.com/recaptcha/api2/aframe',
  url: 'https://www.google.com/recaptcha/api2/aframe',
  parentId: 'A',
};
export const WORKER: CdpTargetInfo = { id: 'WORKER', type: 'worker', title: '', url: '' };
export const OTHER_SITE: CdpTargetInfo = {
  id: 'OTHER',
  type: 'page',
  title: 'Example',
  url: 'https://example.com/',
};

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

export function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

export function unreachable(status?: number): TvMcpError {
  return new TvMcpError('CDP_UNREACHABLE', 'The debug port does not answer', {
    details: status === undefined ? {} : { status },
  });
}

interface SentCommand {
  method: string;
  options: { timeoutMs?: number } | undefined;
}

export interface FakeSession extends CdpSession {
  readonly sent: SentCommand[];
  closeCalls: number;
  // The app dropping the connection.
  drop(): void;
}

export interface FakeApp {
  // The targets the app lists. Assign to change them.
  listing: CdpTargetInfo[];
  // The window behind each page. A page without one gets a booted chart that is visible.
  windows: Map<string, object>;
  // How a call is answered. The defaults answer from `listing` and `windows`; a test replaces one
  // to fail it, delay it, or never answer it.
  onVersion: () => Promise<CdpVersionInfo>;
  onList: () => Promise<CdpTargetInfo[]>;
  onConnect: (target: CdpTargetInfo) => Promise<void>;
  onEvaluate: ((targetId: string, params: unknown) => Promise<unknown>) | undefined;
  // Answers a Runtime.evaluate the way the page behind a target does.
  evaluate(targetId: string, params: unknown): Promise<unknown>;
  // What the manager did, in order.
  versionCalls: number;
  listCalls: number;
  connects: string[];
  sessions: FakeSession[];
  discovery: CdpDiscovery;
  connector: CdpConnector;
}

const disposers: (() => void)[] = [];
const managers: ConnectionManager[] = [];

// Has the harness close a manager that a test made itself.
export function track(manager: ConnectionManager): void {
  managers.push(manager);
}

// Closes every manager a test made and releases the pages behind the sessions. A test file calls
// it from afterEach.
export async function cleanUpHarness(): Promise<void> {
  for (const manager of managers.splice(0)) {
    await manager.close();
  }
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
}

// The window behind a target, made on first use and kept, so that every session of the target sees
// the same page.
export function windowFor(app: FakeApp, targetId: string): object {
  let win = app.windows.get(targetId);
  if (win === undefined) {
    win = createFakeTvWindow(fixture);
    app.windows.set(targetId, win);
  }
  return win;
}

function openSession(app: FakeApp, targetId: string): FakeSession {
  const listeners: (() => void)[] = [];
  const sent: SentCommand[] = [];
  let closed = false;
  const markClosed = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    for (const listener of listeners.splice(0)) {
      listener();
    }
  };
  const send = (
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number },
  ): Promise<unknown> => {
    sent.push({ method, options });
    if (closed) {
      return Promise.reject(new TvMcpError('CDP_UNREACHABLE', 'The connection is closed'));
    }
    if (method !== 'Runtime.evaluate') {
      return Promise.resolve({});
    }
    return app.onEvaluate === undefined
      ? app.evaluate(targetId, params)
      : app.onEvaluate(targetId, params);
  };
  const session: FakeSession = {
    targetId,
    get isClosed() {
      return closed;
    },
    // The protocol typings of send are generic over every CDP method; this fake answers one.
    send: send as CdpSession['send'],
    onClose(listener) {
      if (closed) {
        listener();
      } else {
        listeners.push(listener);
      }
    },
    close() {
      session.closeCalls += 1;
      markClosed();
      return Promise.resolve();
    },
    sent,
    closeCalls: 0,
    drop: markClosed,
  };
  app.sessions.push(session);
  return session;
}

export function createApp(listing: CdpTargetInfo[]): FakeApp {
  const runtimes = new Map<string, PageRuntime>();
  const app: FakeApp = {
    listing,
    windows: new Map(),
    onVersion: () =>
      Promise.resolve({
        browser: 'Chrome/146.0.7680.216',
        protocolVersion: '1.3',
        userAgent: 'TradingView/3.4.1',
      }),
    onList: () => Promise.resolve(app.listing),
    onConnect: () => Promise.resolve(),
    onEvaluate: undefined,
    evaluate(targetId, params) {
      let runtime = runtimes.get(targetId);
      if (runtime === undefined) {
        const created = createPageRuntime(windowFor(app, targetId));
        disposers.push(() => {
          created.dispose();
        });
        runtimes.set(targetId, created);
        runtime = created;
      }
      return runtime.evaluate(params as Record<string, unknown>);
    },
    versionCalls: 0,
    listCalls: 0,
    connects: [],
    sessions: [],
    discovery: {
      version() {
        app.versionCalls += 1;
        return app.onVersion();
      },
      targets() {
        app.listCalls += 1;
        return app.onList();
      },
    },
    connector: {
      async connect(target) {
        app.connects.push(target.id);
        await app.onConnect(target);
        return openSession(app, target.id);
      },
    },
  };
  return app;
}

// The sessions the manager opened to a target, oldest first.
export function sessionsOf(app: FakeApp, targetId: string): FakeSession[] {
  return app.sessions.filter((session) => session.targetId === targetId);
}

// The first session the manager opened to a target.
export function firstSessionOf(app: FakeApp, targetId: string): FakeSession {
  const [session] = sessionsOf(app, targetId);
  if (session === undefined) {
    throw new Error(`No session was opened to ${targetId}`);
  }
  return session;
}

// The sessions that are still open, whichever target they belong to.
export function openSessions(app: FakeApp): FakeSession[] {
  return app.sessions.filter((session) => !session.isClosed);
}

// The Runtime.evaluate commands that reached a session.
export function evaluationsOf(session: FakeSession): SentCommand[] {
  return session.sent.filter(({ method }) => method === 'Runtime.evaluate');
}

export function setVisibility(app: FakeApp, targetId: string, state: 'visible' | 'hidden'): void {
  inspectFakeWindow(windowFor(app, targetId)).state.visibilityState = state;
}

export const quiet = createLogger({ level: 'silent', destination: { write: () => undefined } });

// Retries do not wait here: delays are recorded, and `random: 1` makes them the longest the
// backoff allows, so a test can compare them to the schedule.
export function createManager(
  app: FakeApp,
  overrides: Partial<ConnectionManagerDeps> = {},
): { manager: ConnectionManager; delays: number[] } {
  const delays: number[] = [];
  const manager = new ConnectionManager({
    discovery: app.discovery,
    connector: app.connector,
    logger: quiet,
    callTimeoutMs: CALL_TIMEOUT_MS,
    endpoint: ENDPOINT,
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
    random: () => 1,
    ...overrides,
  });
  managers.push(manager);
  return { manager, delays };
}

// Lets every promise chain that needs no timer and no socket run to its end.
export async function settle(): Promise<void> {
  await nextMacrotask();
}

// A call that fails with `reason`, whatever it is: an error of ours, a stray Error, or something
// that is not an error at all.
export function failing(reason: unknown): () => Promise<never> {
  return () =>
    Promise.resolve().then(() => {
      throw reason;
    });
}

// A listing that fails with CDP_UNREACHABLE `times` times, and then answers.
export function failListingTimes(app: FakeApp, times: number): void {
  let failures = times;
  app.onList = () => {
    if (failures > 0) {
      failures -= 1;
      return Promise.reject(unreachable());
    }
    return Promise.resolve(app.listing);
  };
}
