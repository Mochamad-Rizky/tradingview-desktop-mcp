import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import {
  createServer as createTcpServer,
  type AddressInfo,
  type Server as TcpServer,
  type Socket,
} from 'node:net';
import { networkInterfaces } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createHttpDiscovery } from '../../src/core/cdp/discovery.js';
import { findChartTargets, findWindowChromeTarget } from '../../src/core/cdp/targets.js';
import { TimeoutError, TvMcpError } from '../../src/core/errors.js';
import { startFakeCdpServer, type FakeCdpServer } from '../helpers/fake-cdp/server.js';
import { loadTargetsFixture } from '../helpers/fake-cdp/targets.js';

const CHART_ID = 'BBB144A7827AE55CBA0E74986FC9574C';
const WINDOW_CHROME_ID = 'EE67363DAA56C9940A709061CFAA2FFF';
const LOOPBACK = '127.0.0.1';
const CALL_TIMEOUT_MS = 5000;

const HAS_IPV6_LOOPBACK = Object.values(networkInterfaces()).some((addresses) =>
  addresses?.some(({ address }) => address === '::1'),
);

// Everything a test starts is registered here, because a server that is still listening or a
// socket that is still open keeps the vitest worker from exiting.
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function listen(server: HttpServer | TcpServer, host: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function close(server: HttpServer | TcpServer): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

async function startFakeCdp(): Promise<FakeCdpServer> {
  const server = await startFakeCdpServer({ targets: loadTargetsFixture() });
  cleanups.push(() => server.close());
  return server;
}

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

interface Stub {
  port: number;
  // The Host header of every request, in arrival order.
  hosts: string[];
}

// An HTTP server that answers however a test needs, for the responses the fake CDP server never
// gives.
async function startStub(handler: Handler, host = LOOPBACK): Promise<Stub> {
  const hosts: string[] = [];
  const server = createServer((request, response) => {
    hosts.push(request.headers.host ?? '');
    handler(request, response);
  });
  const port = await listen(server, host);
  cleanups.push(async () => {
    const closed = close(server);
    // Keep-alive connections of the client would hold the close back until they time out.
    server.closeAllConnections();
    await closed;
  });
  return { port, hosts };
}

function reply(status: number, body: string, contentType = 'application/json'): Handler {
  return (_request, response) => {
    response.writeHead(status, { 'Content-Type': contentType });
    response.end(body);
  };
}

// One JSON document per path, like Chrome, and 404 for any other path.
function documents(byPath: Record<string, unknown>): Handler {
  return (request, response) => {
    const path = request.url ?? '';
    if (Object.hasOwn(byPath, path)) {
      reply(200, JSON.stringify(byPath[path]))(request, response);
    } else {
      reply(404, 'Unknown path', 'text/plain')(request, response);
    }
  };
}

interface StalledServer {
  port: number;
  // Settles when the client has closed the connection.
  clientClosed: Promise<void>;
  requestReceived(): boolean;
}

// Accepts connections and never answers, like an app that is frozen behind an open debug port.
async function startStalledServer(): Promise<StalledServer> {
  const sockets = new Set<Socket>();
  let received = false;
  let markClosed: () => void = () => undefined;
  const clientClosed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    // A client that aborts may end the connection with a reset.
    socket.on('error', () => undefined);
    socket.on('data', () => {
      received = true;
    });
    socket.on('close', markClosed);
  });
  const port = await listen(server, LOOPBACK);
  cleanups.push(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await close(server);
  });
  return { port, clientClosed, requestReceived: () => received };
}

// A port that nothing listens on: it was free a moment ago, so connecting to it is refused.
async function closedPort(): Promise<number> {
  const server = createTcpServer();
  const port = await listen(server, LOOPBACK);
  await close(server);
  return port;
}

// Resolves with the error of a call that must fail with one of ours.
async function failureOf(call: Promise<unknown>): Promise<TvMcpError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof TvMcpError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the call to reject');
}

// What the details of a rejected document say about the part that was wrong.
function issueOf(error: TvMcpError): string {
  const issue = error.details?.issue;
  if (typeof issue !== 'string') {
    throw new Error('Expected the details to name an issue');
  }
  return issue;
}

async function settlesWithin(ms: number, promise: Promise<void>): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    // Not ref'd, so a timer that lost the race does not hold the process back.
    delay(ms, false, { ref: false }),
  ]);
}

test('discovery lists targets from a running endpoint', async () => {
  const server = await startFakeCdp();
  const discovery = createHttpDiscovery({
    host: server.host,
    port: server.port,
    timeoutMs: CALL_TIMEOUT_MS,
  });

  const listed = await discovery.targets();

  // Exactly the fields of CdpTargetInfo: the description and frontend URL that Chrome adds are
  // dropped, and parentId appears on the iframes only.
  expect(listed).toStrictEqual(
    loadTargetsFixture().map(({ id, type, title, url, parentId }) => ({
      id,
      type,
      title,
      url,
      webSocketDebuggerUrl: `ws://127.0.0.1:${String(server.port)}/devtools/page/${id}`,
      ...(parentId === undefined ? {} : { parentId }),
    })),
  );
  expect(findChartTargets(listed).map(({ id }) => id)).toEqual([CHART_ID]);
  expect(findWindowChromeTarget(listed)?.id).toBe(WINDOW_CHROME_ID);
});

test('discovery reads the version of a running endpoint', async () => {
  const server = await startFakeCdp();
  const discovery = createHttpDiscovery({
    host: server.host,
    port: server.port,
    timeoutMs: CALL_TIMEOUT_MS,
  });

  const version = await discovery.version();

  expect(Object.keys(version).sort()).toEqual([
    'browser',
    'protocolVersion',
    'userAgent',
    'v8Version',
  ]);
  expect(version.browser).toBe('Chrome/146.0.7680.216');
  expect(version.protocolVersion).toBe('1.3');
  expect(version.userAgent).toContain('TradingView/3.4.1');
  expect(version.v8Version).toBe('14.6.202.34');
});

test('discovery asks the endpoint again on every call', async () => {
  const server = await startFakeCdp();
  const discovery = createHttpDiscovery({
    host: server.host,
    port: server.port,
    timeoutMs: CALL_TIMEOUT_MS,
  });
  expect(await discovery.targets()).toHaveLength(11);

  server.setTargets([{ id: 'ONLY', type: 'page', title: '', url: '', behavior: 'silent' }]);

  expect((await discovery.targets()).map(({ id }) => id)).toEqual(['ONLY']);
});

test('discovery leaves out the optional fields an endpoint does not send', async () => {
  const stub = await startStub(
    documents({
      '/json/version': {
        Browser: 'Chrome/146.0.0.0',
        'Protocol-Version': '1.3',
        'User-Agent': 'Agent',
        'WebKit-Version': '537.36',
      },
      '/json/list': [{ id: 'A', type: 'page', title: 'Title', url: 'https://example.net/' }],
    }),
  );
  const discovery = createHttpDiscovery({
    host: LOOPBACK,
    port: stub.port,
    timeoutMs: CALL_TIMEOUT_MS,
  });

  // toStrictEqual tells an absent key from one that is set to undefined.
  expect(await discovery.version()).toStrictEqual({
    browser: 'Chrome/146.0.0.0',
    protocolVersion: '1.3',
    userAgent: 'Agent',
  });
  expect(await discovery.targets()).toStrictEqual([
    { id: 'A', type: 'page', title: 'Title', url: 'https://example.net/' },
  ]);
});

test('discovery maps connection refused to CDP_UNREACHABLE', async () => {
  const port = await closedPort();
  const discovery = createHttpDiscovery({ host: LOOPBACK, port, timeoutMs: CALL_TIMEOUT_MS });

  // Each call starts when its turn comes, so no rejection waits without a handler.
  for (const call of [() => discovery.targets(), () => discovery.version()]) {
    const error = await failureOf(call());

    expect(error.code).toBe('CDP_UNREACHABLE');
    expect(error.hint).toContain('app_launch');
    expect(error.hint).toContain(`--remote-debugging-port=${String(port)}`);
    expect(error.details).toEqual({
      endpoint: `http://127.0.0.1:${String(port)}`,
      code: 'ECONNREFUSED',
    });
    // The original failure stays reachable for the log, although it never leaves the server.
    expect(error.cause).toBeInstanceOf(Error);
  }
});

// localhost may resolve to both ::1 and 127.0.0.1, and the failure then arrives as an
// AggregateError instead of a plain error.
test('discovery maps connection refused on localhost to CDP_UNREACHABLE', async () => {
  const port = await closedPort();
  const discovery = createHttpDiscovery({ host: 'localhost', port, timeoutMs: CALL_TIMEOUT_MS });

  const error = await failureOf(discovery.version());

  expect(error.code).toBe('CDP_UNREACHABLE');
  expect(error.hint).toContain('app_launch');
  expect(error.details).toMatchObject({ endpoint: `http://localhost:${String(port)}` });
});

test('discovery times out on a stalled endpoint', async () => {
  const stalled = await startStalledServer();
  const discovery = createHttpDiscovery({ host: LOOPBACK, port: stalled.port, timeoutMs: 300 });
  const startedAt = performance.now();

  const error = await failureOf(discovery.targets());
  const waitedMs = performance.now() - startedAt;

  expect(error).toBeInstanceOf(TimeoutError);
  expect(error.code).toBe('TIMEOUT');
  expect(error.details).toEqual({ label: 'CDP discovery GET /json/list', ms: 300 });
  expect(waitedMs).toBeGreaterThanOrEqual(250);
  expect(waitedMs).toBeLessThan(CALL_TIMEOUT_MS);
  expect(stalled.requestReceived()).toBe(true);
  // The request is cancelled, not just forgotten: the connection does not stay open on the app.
  expect(await settlesWithin(2000, stalled.clientClosed)).toBe(true);
});

test('discovery times out when the answer stops after its headers', async () => {
  let markGone: () => void = () => undefined;
  const gone = new Promise<void>((resolve) => {
    markGone = resolve;
  });
  const stub = await startStub((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('[{"id":');
    response.once('close', markGone);
  });
  const discovery = createHttpDiscovery({ host: LOOPBACK, port: stub.port, timeoutMs: 300 });

  const error = await failureOf(discovery.targets());

  expect(error.code).toBe('TIMEOUT');
  expect(await settlesWithin(2000, gone)).toBe(true);
});

test('discovery maps a connection that drops mid-answer to CDP_UNREACHABLE', async () => {
  const stub = await startStub((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
    // The announced body never completes: the connection goes away after the first bytes.
    response.write('[{"id":', () => {
      request.socket.destroy();
    });
  });
  const discovery = createHttpDiscovery({
    host: LOOPBACK,
    port: stub.port,
    timeoutMs: CALL_TIMEOUT_MS,
  });

  const error = await failureOf(discovery.targets());

  expect(error.code).toBe('CDP_UNREACHABLE');
});

test('discovery reports the status of an error response', async () => {
  const stub = await startStub(reply(503, 'Service Unavailable', 'text/plain'));
  const discovery = createHttpDiscovery({
    host: LOOPBACK,
    port: stub.port,
    timeoutMs: CALL_TIMEOUT_MS,
  });

  const error = await failureOf(discovery.targets());

  expect(error.code).toBe('CDP_UNREACHABLE');
  expect(error.details).toEqual({
    endpoint: `http://127.0.0.1:${String(stub.port)}`,
    path: '/json/list',
    status: 503,
  });
  expect(error.hint).toContain('--cdp-port');
});

test.each<[string, Handler]>([
  ['an error status', reply(500, 'Internal Server Error', 'text/plain')],
  ['a page that is not JSON', reply(200, '<html><body>Welcome</body></html>', 'text/html')],
  ['an empty body', reply(200, '')],
  ['a JSON object instead of a list', reply(200, '{"message":"hello"}')],
  ['an entry without an id', reply(200, '[{"type":"page","title":"","url":""}]')],
  ['an entry with a numeric id', reply(200, '[{"id":7,"type":"page","title":"","url":""}]')],
  ['an entry that is not an object', reply(200, '["A"]')],
])('discovery maps %s from /json/list to CDP_UNREACHABLE', async (_label, handler) => {
  const stub = await startStub(handler);
  const discovery = createHttpDiscovery({
    host: LOOPBACK,
    port: stub.port,
    timeoutMs: CALL_TIMEOUT_MS,
  });

  const error = await failureOf(discovery.targets());

  expect(error.code).toBe('CDP_UNREACHABLE');
  expect(error.hint).toContain('--cdp-port');
});

test.each<[string, Handler]>([
  ['an error status', reply(404, 'Unknown path', 'text/plain')],
  ['a page that is not JSON', reply(200, '<html><body>Welcome</body></html>', 'text/html')],
  ['a JSON list instead of an object', reply(200, '[]')],
  ['a document without a browser', reply(200, '{"Protocol-Version":"1.3","User-Agent":"Agent"}')],
  [
    'a document with a numeric protocol version',
    reply(200, '{"Browser":"Chrome/1","Protocol-Version":1.3,"User-Agent":"Agent"}'),
  ],
])('discovery maps %s from /json/version to CDP_UNREACHABLE', async (_label, handler) => {
  const stub = await startStub(handler);
  const discovery = createHttpDiscovery({
    host: LOOPBACK,
    port: stub.port,
    timeoutMs: CALL_TIMEOUT_MS,
  });

  const error = await failureOf(discovery.version());

  expect(error.code).toBe('CDP_UNREACHABLE');
  expect(error.hint).toContain('--cdp-port');
});

test('discovery says which part of an unexpected document was wrong', async () => {
  const wrongEntry = await startStub(reply(200, '[{"id":"A","type":"page","title":"","url":5}]'));
  const notAList = await startStub(reply(200, '{"message":"hello"}'));
  const wrongKeys = await startStub(reply(200, '{"Browser":"Chrome/1","Protocol-Version":"1.3"}'));
  const discoveryFor = (stub: Stub) =>
    createHttpDiscovery({ host: LOOPBACK, port: stub.port, timeoutMs: CALL_TIMEOUT_MS });

  const entryError = await failureOf(discoveryFor(wrongEntry).targets());
  const listError = await failureOf(discoveryFor(notAList).targets());
  const versionError = await failureOf(discoveryFor(wrongKeys).version());

  expect(entryError.details).toMatchObject({ path: '/json/list' });
  expect(issueOf(entryError)).toMatch(/^0\.url: /);
  expect(issueOf(listError)).toMatch(/expected array/);
  expect(issueOf(versionError)).toMatch(/^User-Agent: /);
});

test('discovery does not follow a redirect to another address', async () => {
  const elsewhere = await startStub(documents({ '/json/list': [] }));
  const redirecting = await startStub((_request, response) => {
    response.writeHead(302, { Location: `http://127.0.0.1:${String(elsewhere.port)}/json/list` });
    response.end();
  });
  const discovery = createHttpDiscovery({
    host: LOOPBACK,
    port: redirecting.port,
    timeoutMs: CALL_TIMEOUT_MS,
  });

  const error = await failureOf(discovery.targets());

  expect(error.code).toBe('CDP_UNREACHABLE');
  expect(elsewhere.hosts).toEqual([]);
});

test.skipIf(!HAS_IPV6_LOOPBACK)('discovery puts an IPv6 host in brackets', async () => {
  const stub = await startStub(documents({ '/json/list': [] }), '::1');
  const discovery = createHttpDiscovery({
    host: '::1',
    port: stub.port,
    timeoutMs: CALL_TIMEOUT_MS,
  });

  expect(await discovery.targets()).toEqual([]);
  expect(stub.hosts).toEqual([`[::1]:${String(stub.port)}`]);
});
