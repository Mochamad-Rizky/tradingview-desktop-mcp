import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import {
  createServer as createTcpServer,
  type AddressInfo,
  type Server as TcpServer,
  type Socket,
} from 'node:net';
import { networkInterfaces } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { createCriConnector } from '../../src/core/cdp/cri-connector.js';
import { createHttpDiscovery } from '../../src/core/cdp/discovery.js';
import type { CdpSession, CdpTargetInfo } from '../../src/core/cdp/types.js';
import { TimeoutError, TvMcpError } from '../../src/core/errors.js';
import {
  FakeCdpError,
  startFakeCdpServer,
  type FakeCdpServer,
  type FakeTarget,
} from '../helpers/fake-cdp/server.js';
import { loadTargetsFixture } from '../helpers/fake-cdp/targets.js';

const CHART_ID = 'BBB144A7827AE55CBA0E74986FC9574C';
// A blank page of the app: it accepts the WebSocket and never answers a command.
const SILENT_ID = 'D4FA899CB58B76FCEDDAC2E1E63735B2';
const SCRIPTED_ID = 'SCRIPTED';
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

async function startFakeCdp(targets: FakeTarget[] = loadTargetsFixture()): Promise<FakeCdpServer> {
  const server = await startFakeCdpServer({ targets });
  cleanups.push(() => server.close());
  return server;
}

// The target as discovery reports it, which is what the connection manager hands to the connector.
async function targetInfo(server: FakeCdpServer, id: string): Promise<CdpTargetInfo> {
  const discovery = createHttpDiscovery({
    host: server.host,
    port: server.port,
    timeoutMs: CALL_TIMEOUT_MS,
  });
  const found = (await discovery.targets()).find((target) => target.id === id);
  if (found === undefined) {
    throw new Error(`The fake server does not list ${id}`);
  }
  return found;
}

async function connectTo(
  server: FakeCdpServer,
  id: string,
  defaultTimeoutMs = CALL_TIMEOUT_MS,
): Promise<CdpSession> {
  const connector = createCriConnector({
    host: server.host,
    port: server.port,
    defaultTimeoutMs,
  });
  const session = await connector.connect(await targetInfo(server, id));
  cleanups.push(() => session.close());
  return session;
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

function listen(server: HttpServer | TcpServer, host: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: HttpServer | TcpServer): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

// A port that nothing listens on: it was free a moment ago, so connecting to it is refused.
async function closedPort(host = LOOPBACK): Promise<number> {
  const server = createTcpServer();
  const port = await listen(server, host);
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
  const port = await listen(server, LOOPBACK);
  cleanups.push(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await closeServer(server);
  });
  return port;
}

interface ScriptedCdp {
  port: number;
  // WebSocket handshakes completed so far, and the connections that are still open.
  accepted(): number;
  open(): number;
}

interface ScriptedCdpOptions {
  host?: string;
  // Time the server waits before it completes a WebSocket handshake.
  upgradeDelayMs?: number;
  // Stops reading from every connection, so the peer answers nothing, not even a close frame.
  frozen?: boolean;
}

const commandSchema = z.object({ id: z.number() });

// A CDP endpoint the fake server cannot be: bound to another address, slow to complete the
// handshake, or deaf once connected. It lists one target and answers every command with the same
// result.
async function startScriptedCdp(options: ScriptedCdpOptions = {}): Promise<ScriptedCdp> {
  const host = options.host ?? LOOPBACK;
  const sockets = new Set<WebSocket>();
  let accepted = 0;
  const webSocketServer = new WebSocketServer({ noServer: true });
  const httpServer = createHttpServer((request, response) => {
    if (request.url === '/json/list') {
      const port = (httpServer.address() as AddressInfo).port;
      const authority = host.includes(':') ? `[${host}]` : host;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify([
          {
            id: SCRIPTED_ID,
            type: 'page',
            title: '',
            url: '',
            webSocketDebuggerUrl: `ws://${authority}:${String(port)}/devtools/page/${SCRIPTED_ID}`,
          },
        ]),
      );
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  httpServer.on('upgrade', (request, socket, head) => {
    socket.on('error', () => undefined);
    const timer = setTimeout(() => {
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        accepted += 1;
        sockets.add(webSocket);
        webSocket.on('error', () => undefined);
        webSocket.on('close', () => {
          sockets.delete(webSocket);
        });
        if (options.frozen === true) {
          webSocket.pause();
          return;
        }
        webSocket.on('message', (data) => {
          const { id } = commandSchema.parse(JSON.parse((data as Buffer).toString('utf8')));
          webSocket.send(JSON.stringify({ id, result: { answeredBy: 'scripted' } }));
        });
      });
    }, options.upgradeDelayMs ?? 0);
    socket.once('close', () => {
      clearTimeout(timer);
    });
  });
  const port = await listen(httpServer, host);
  cleanups.push(async () => {
    for (const webSocket of sockets) {
      webSocket.terminate();
    }
    webSocketServer.close();
    const closed = closeServer(httpServer);
    httpServer.closeAllConnections();
    await closed;
  });
  return {
    port,
    accepted: () => accepted,
    open: () => sockets.size,
  };
}

function targetWith(id: string, webSocketDebuggerUrl?: string): CdpTargetInfo {
  return {
    id,
    type: 'page',
    title: '',
    url: '',
    ...(webSocketDebuggerUrl === undefined ? {} : { webSocketDebuggerUrl }),
  };
}

function debuggerUrl(port: number, id: string): string {
  return `ws://${LOOPBACK}:${String(port)}/devtools/page/${id}`;
}

test('sends a command and resolves its result', async () => {
  const server = await startFakeCdp();
  const session = await connectTo(server, CHART_ID);

  const result = await session.send('Runtime.evaluate', {
    expression: '1 + 1',
    returnByValue: true,
  });

  expect(result).toEqual({ result: { type: 'number', value: 2 } });
  expect(session.targetId).toBe(CHART_ID);
  expect(session.isClosed).toBe(false);
  expect(server.calls).toEqual([
    {
      targetId: CHART_ID,
      method: 'Runtime.evaluate',
      params: { expression: '1 + 1', returnByValue: true },
    },
  ]);
});

test('rejects with TIMEOUT when the target never answers', async () => {
  const server = await startFakeCdp();
  const session = await connectTo(server, SILENT_ID);
  const startedAt = performance.now();

  const error = await failureOf(
    session.send('Runtime.evaluate', { expression: '1 + 1' }, { timeoutMs: 300 }),
  );
  const waitedMs = performance.now() - startedAt;

  expect(error).toBeInstanceOf(TimeoutError);
  expect(error.code).toBe('TIMEOUT');
  expect(error.details).toEqual({ label: `CDP Runtime.evaluate on ${SILENT_ID}`, ms: 300 });
  expect(waitedMs).toBeGreaterThanOrEqual(250);
  expect(waitedMs).toBeLessThan(CALL_TIMEOUT_MS);
  // The command did reach the target: the deadline is on the answer, not on the delivery.
  expect(server.calls.map(({ method }) => method)).toEqual(['Runtime.evaluate']);
});

test('marks the session closed when the server drops the connection', async () => {
  const server = await startFakeCdp();
  const session = await connectTo(server, CHART_ID);
  const first = vi.fn();
  const second = vi.fn();
  session.onClose(first);
  session.onClose(second);
  expect(session.isClosed).toBe(false);

  server.dropConnections();

  await vi.waitFor(() => {
    expect(session.isClosed).toBe(true);
  });
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
});

test('connects through the debugger URL of the target without listing targets', async () => {
  const server = await startFakeCdp();
  const target = await targetInfo(server, CHART_ID);
  // Nothing listens on the port the connector is given, so a /json/list request of its own would
  // be refused: only the URL of the target leads to the server.
  const connector = createCriConnector({
    host: LOOPBACK,
    port: await closedPort(),
    defaultTimeoutMs: CALL_TIMEOUT_MS,
  });

  const session = await connector.connect(target);
  cleanups.push(() => session.close());

  expect(await session.send('Runtime.evaluate', { expression: '2 + 3' })).toEqual({
    result: { type: 'number', value: 5 },
  });
  expect(server.connectionCount(CHART_ID)).toBe(1);
});

test('accepts localhost as the host of the debugger URL', async () => {
  const server = await startFakeCdp();
  const connector = createCriConnector({
    host: server.host,
    port: server.port,
    defaultTimeoutMs: CALL_TIMEOUT_MS,
  });

  const session = await connector.connect(
    targetWith(CHART_ID, `ws://localhost:${String(server.port)}/devtools/page/${CHART_ID}`),
  );
  cleanups.push(() => session.close());

  expect(await session.send('Runtime.evaluate', { expression: '1' })).toEqual({
    result: { type: 'number', value: 1 },
  });
});

test('looks the target up by id when it lists no debugger URL', async () => {
  const server = await startFakeCdp();
  const connector = createCriConnector({
    host: server.host,
    port: server.port,
    defaultTimeoutMs: CALL_TIMEOUT_MS,
  });

  const session = await connector.connect(targetWith(CHART_ID));
  cleanups.push(() => session.close());

  expect(await session.send('Runtime.evaluate', { expression: '1' })).toEqual({
    result: { type: 'number', value: 1 },
  });
  expect(server.connectionCount(CHART_ID)).toBe(1);
});

test('does not let the library pick a target when the id is empty', async () => {
  // With an empty target the library connects to the first page it finds, which is not
  // necessarily the one that was asked for.
  const server = await startFakeCdp();
  const connector = createCriConnector({
    host: server.host,
    port: server.port,
    defaultTimeoutMs: CALL_TIMEOUT_MS,
  });

  const error = await failureOf(connector.connect(targetWith('')));

  expect(error.code).toBe('TARGET_NOT_FOUND');
  expect(server.connectionCount()).toBe(0);
});

test.each([
  ['its debugger URL', true],
  ['its id', false],
])(
  'maps a refused connection to CDP_UNREACHABLE and names the target (via %s)',
  async (_via, useUrl) => {
    const port = await closedPort();
    const connector = createCriConnector({
      host: LOOPBACK,
      port,
      defaultTimeoutMs: CALL_TIMEOUT_MS,
    });

    const error = await failureOf(
      connector.connect(targetWith(CHART_ID, useUrl ? debuggerUrl(port, CHART_ID) : undefined)),
    );

    expect(error.code).toBe('CDP_UNREACHABLE');
    expect(error.details).toEqual({
      targetId: CHART_ID,
      endpoint: `ws://127.0.0.1:${String(port)}`,
      code: 'ECONNREFUSED',
    });
    expect(error.message).toContain(CHART_ID);
    expect(error.hint).toContain(`--remote-debugging-port=${String(port)}`);
    // The original failure stays reachable for the log, although it never leaves the server.
    expect(error.cause).toBeInstanceOf(Error);
  },
);

test('maps a target that refuses the upgrade to CDP_UNREACHABLE with the HTTP status', async () => {
  const server = await startFakeCdp();
  const connector = createCriConnector({
    host: server.host,
    port: server.port,
    defaultTimeoutMs: CALL_TIMEOUT_MS,
  });

  // The tab closed after it was listed, so the app no longer knows its id.
  const error = await failureOf(
    connector.connect(targetWith('CLOSED', debuggerUrl(server.port, 'CLOSED'))),
  );

  expect(error.code).toBe('CDP_UNREACHABLE');
  expect(error.details).toEqual({
    targetId: 'CLOSED',
    endpoint: `ws://127.0.0.1:${String(server.port)}`,
    status: 404,
  });
});

test.each([
  // 192.0.2.1 is documentation address space (RFC 5737): nothing answers there, so a connection
  // attempt would run into the deadline instead of failing.
  ['a host outside the loopback interface', 'ws://192.0.2.1:9222/devtools/page/X'],
  ['a scheme other than ws', 'http://127.0.0.1:9222/devtools/page/X'],
  ['a path without a host', '/devtools/page/X'],
  ['text that is not a URL', 'not a url'],
])('refuses a debugger URL with %s', async (_label, url) => {
  const server = await startFakeCdp();
  const connector = createCriConnector({
    host: server.host,
    port: server.port,
    defaultTimeoutMs: 2000,
  });
  const startedAt = performance.now();

  const error = await failureOf(connector.connect(targetWith(CHART_ID, url)));

  expect(error.code).toBe('CDP_UNREACHABLE');
  expect(error.details).toEqual({
    targetId: CHART_ID,
    endpoint: `ws://127.0.0.1:${String(server.port)}`,
    webSocketDebuggerUrl: url,
  });
  // Refused before any connection: waiting for the deadline would end in TIMEOUT instead.
  expect(performance.now() - startedAt).toBeLessThan(1000);
  // The server that does answer on the configured port is not used as a fallback for a URL
  // the target gave.
  expect(server.connectionCount()).toBe(0);
});

test('times out a connection attempt that stalls', async () => {
  const port = await startStalledServer();
  const connector = createCriConnector({ host: LOOPBACK, port, defaultTimeoutMs: 300 });
  const startedAt = performance.now();

  const error = await failureOf(
    connector.connect(targetWith(CHART_ID, debuggerUrl(port, CHART_ID))),
  );
  const waitedMs = performance.now() - startedAt;

  expect(error).toBeInstanceOf(TimeoutError);
  expect(error.code).toBe('TIMEOUT');
  expect(error.details).toEqual({ label: `CDP connect to ${CHART_ID}`, ms: 300 });
  expect(waitedMs).toBeGreaterThanOrEqual(250);
  expect(waitedMs).toBeLessThan(CALL_TIMEOUT_MS);
});

test('closes a connection that completes after the connect deadline', async () => {
  const slow = await startScriptedCdp({ upgradeDelayMs: 600 });
  const connector = createCriConnector({ host: LOOPBACK, port: slow.port, defaultTimeoutMs: 200 });

  const error = await failureOf(
    connector.connect(targetWith(SCRIPTED_ID, debuggerUrl(slow.port, SCRIPTED_ID))),
  );

  expect(error.code).toBe('TIMEOUT');
  // The library cannot abort a handshake, so it finishes anyway. Nobody holds that connection,
  // which is why it has to be closed again instead of staying open on the app.
  await vi.waitFor(
    () => {
      expect(slow.accepted()).toBe(1);
    },
    { timeout: 3000 },
  );
  await vi.waitFor(
    () => {
      expect(slow.open()).toBe(0);
    },
    { timeout: 3000 },
  );
});

test.skipIf(!HAS_IPV6_LOOPBACK)('connects over the IPv6 loopback', async () => {
  const scripted = await startScriptedCdp({ host: '::1' });
  const connector = createCriConnector({
    host: '::1',
    port: scripted.port,
    defaultTimeoutMs: CALL_TIMEOUT_MS,
  });

  // The target lists its URL with the address in brackets, and without a URL the library asks
  // the endpoint for the list itself.
  const viaUrl = await connector.connect(
    targetWith(SCRIPTED_ID, `ws://[::1]:${String(scripted.port)}/devtools/page/${SCRIPTED_ID}`),
  );
  const viaId = await connector.connect(targetWith(SCRIPTED_ID));
  cleanups.push(
    () => viaUrl.close(),
    () => viaId.close(),
  );

  expect(await viaUrl.send('Runtime.evaluate', { expression: '1' })).toEqual({
    answeredBy: 'scripted',
  });
  expect(await viaId.send('Runtime.evaluate', { expression: '1' })).toEqual({
    answeredBy: 'scripted',
  });
});

test.skipIf(!HAS_IPV6_LOOPBACK)('puts an IPv6 endpoint in brackets', async () => {
  const port = await closedPort('::1');
  const connector = createCriConnector({ host: '::1', port, defaultTimeoutMs: CALL_TIMEOUT_MS });

  const error = await failureOf(connector.connect(targetWith(CHART_ID)));

  expect(error.code).toBe('CDP_UNREACHABLE');
  expect(error.details).toMatchObject({ endpoint: `ws://[::1]:${String(port)}` });
});

test('sends a command without params', async () => {
  const server = await startFakeCdp();
  const session = await connectTo(server, CHART_ID);

  const screenshot = await session.send('Page.captureScreenshot');

  expect(screenshot.data).not.toBe('');
  expect(server.calls).toEqual([
    { targetId: CHART_ID, method: 'Page.captureScreenshot', params: {} },
  ]);
});

test('maps an unknown method (-32601) to CAPABILITY_UNAVAILABLE', async () => {
  const server = await startFakeCdp();
  const session = await connectTo(server, CHART_ID);

  // The app does not implement this method, which is what an unsupported build looks like. It is
  // refused before anything runs, so a caller with another strategy may go on to it.
  const error = await failureOf(session.send('Browser.getVersion'));

  expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
  expect(error.details).toEqual({
    method: 'Browser.getVersion',
    code: -32601,
    message: "'Browser.getVersion' wasn't found",
  });
  expect(error.message).toContain('Browser.getVersion');
  expect(error.message).toContain(CHART_ID);
  expect(error.cause).toBeInstanceOf(Error);
  // A protocol error answers the call: the connection is fine.
  expect(session.isClosed).toBe(false);
});

// A page whose Runtime.evaluate is answered with the given protocol error.
function pageFailingWith(code: number, message: string, data?: string): FakeTarget {
  return {
    id: 'HANDLED',
    type: 'page',
    title: '',
    url: '',
    behavior: 'page',
    handlers: {
      'Runtime.evaluate': () => {
        throw new FakeCdpError(code, message, data);
      },
    },
  };
}

test('maps other protocol errors to PAGE_EVALUATION_FAILED', async () => {
  const server = await startFakeCdp([
    pageFailingWith(-32000, 'Execution context was destroyed', 'context 7'),
  ]);
  const session = await connectTo(server, 'HANDLED');

  // An answer like this can come after the command started to act, which is why it must not be
  // taken for "the capability is missing": that would let a caller try the same action again by
  // another route.
  const error = await failureOf(session.send('Runtime.evaluate', { expression: '1' }));

  expect(error.code).toBe('PAGE_EVALUATION_FAILED');
  expect(error.details).toEqual({
    method: 'Runtime.evaluate',
    code: -32000,
    message: 'Execution context was destroyed',
  });
  // What the app adds to the error is kept in the message.
  expect(error.message).toContain('Execution context was destroyed (context 7)');
  expect(error.message).toContain('HANDLED');
  expect(error.cause).toBeInstanceOf(Error);
  expect(session.isClosed).toBe(false);
});

// The standard JSON-RPC codes on both sides of -32601, so that only that code is told apart.
test.each([-32700, -32600, -32602, -32603])(
  'maps protocol error code %s to PAGE_EVALUATION_FAILED',
  async (code) => {
    const server = await startFakeCdp([pageFailingWith(code, 'Refused')]);
    const session = await connectTo(server, 'HANDLED');

    const error = await failureOf(session.send('Runtime.evaluate', { expression: '1' }));

    expect(error.code).toBe('PAGE_EVALUATION_FAILED');
    expect(error.details).toEqual({ method: 'Runtime.evaluate', code, message: 'Refused' });
  },
);

test('passes an error of an unexpected kind through unchanged', async () => {
  const server = await startFakeCdp();
  const session = await connectTo(server, CHART_ID);
  // A value that cannot be turned into JSON is a bug of the caller, not a failure of the target,
  // so it is left as it is for whoever logs it, instead of being reported as one.
  const params = { expression: '1', self: undefined as unknown };
  params.self = params;

  const failure = session.send('Runtime.evaluate', params);

  await expect(failure).rejects.toBeInstanceOf(TypeError);
  await expect(failure).rejects.not.toBeInstanceOf(TvMcpError);
  expect(session.isClosed).toBe(false);
  expect(server.calls).toEqual([]);
});

test('uses the default timeout when a call gives none', async () => {
  const server = await startFakeCdp();
  const session = await connectTo(server, SILENT_ID, 150);

  const error = await failureOf(session.send('Runtime.evaluate', { expression: '1' }));

  expect(error.code).toBe('TIMEOUT');
  expect(error.details).toEqual({ label: `CDP Runtime.evaluate on ${SILENT_ID}`, ms: 150 });
});

// Each of these would make the timer of withTimeout fire at once, or after a millisecond.
test.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
  'falls back to the default timeout for the unusable per-call timeout %s',
  async (timeoutMs) => {
    const server = await startFakeCdp();
    const session = await connectTo(server, SILENT_ID, 150);

    const error = await failureOf(
      session.send('Runtime.evaluate', { expression: '1' }, { timeoutMs }),
    );

    expect(error.code).toBe('TIMEOUT');
    expect(error.details).toMatchObject({ ms: 150 });
  },
);

test('accepts the largest per-call timeout a timer can honor', async () => {
  const server = await startFakeCdp();
  const session = await connectTo(server, SILENT_ID, 150);
  const pending = failureOf(
    session.send('Runtime.evaluate', { expression: '1' }, { timeoutMs: 2_147_483_647 }),
  );
  await vi.waitFor(() => {
    expect(server.calls).toHaveLength(1);
  });

  // Neither the default (150 ms) nor an immediate deadline applies: the call is still waiting.
  const outcome = await Promise.race([pending.then(() => 'rejected'), delay(450, 'waiting')]);

  expect(outcome).toBe('waiting');
  // Closing the session ends the wait, so the call does not outlive the test.
  await session.close();
  expect((await pending).code).toBe('CDP_UNREACHABLE');
});

test('keeps the session usable after a call timed out', async () => {
  const server = await startFakeCdp([
    {
      id: 'SLOW',
      type: 'page',
      title: '',
      url: '',
      behavior: 'page',
      handlers: {
        // The answer arrives long after the deadline, as an error: nobody waits for it any more.
        'Runtime.evaluate': async () => {
          await delay(300);
          throw new FakeCdpError(-32000, 'Too late');
        },
      },
    },
  ]);
  const session = await connectTo(server, 'SLOW');

  const error = await failureOf(
    session.send('Runtime.evaluate', { expression: '1' }, { timeoutMs: 100 }),
  );
  await delay(500);

  expect(error.code).toBe('TIMEOUT');
  expect(session.isClosed).toBe(false);
  expect((await session.send('Page.captureScreenshot')).data).not.toBe('');
});

test('rejects a command in flight when the connection drops', async () => {
  const server = await startFakeCdp();
  const session = await connectTo(server, SILENT_ID);
  const pending = failureOf(
    session.send('Runtime.evaluate', { expression: '1' }, { timeoutMs: 20_000 }),
  );
  await vi.waitFor(() => {
    expect(server.calls).toHaveLength(1);
  });

  server.dropConnections();
  const error = await pending;

  expect(error.code).toBe('CDP_UNREACHABLE');
  // It was on the wire when the connection went, so the caller is told it may have run.
  expect(error.message).toContain('was not completed');
  expect(error.hint).toContain('reconnects');
  expect(error.hint).toContain('may already have run');
  expect(error.details).toEqual({ targetId: SILENT_ID, method: 'Runtime.evaluate' });
  expect(session.isClosed).toBe(true);
});

test('rejects at once, without reaching the target, after the connection dropped', async () => {
  const server = await startFakeCdp();
  const session = await connectTo(server, CHART_ID);
  server.dropConnections();
  await vi.waitFor(() => {
    expect(session.isClosed).toBe(true);
  });
  const startedAt = performance.now();

  const error = await failureOf(
    session.send('Runtime.evaluate', { expression: '1' }, { timeoutMs: 20_000 }),
  );

  expect(performance.now() - startedAt).toBeLessThan(1000);
  expect(error.code).toBe('CDP_UNREACHABLE');
  // Nothing went out, which is what makes repeating the call safe.
  expect(error.message).toContain('was not sent');
  expect(error.hint).toContain('reconnects');
  expect(error.hint).not.toContain('may already have run');
  expect(error.details).toEqual({ targetId: CHART_ID, method: 'Runtime.evaluate' });
  expect(server.calls).toEqual([]);
});

test('rejects at once after close()', async () => {
  const server = await startFakeCdp();
  const session = await connectTo(server, CHART_ID);
  await session.close();
  const startedAt = performance.now();

  const error = await failureOf(
    session.send('Runtime.evaluate', { expression: '1' }, { timeoutMs: 20_000 }),
  );

  expect(performance.now() - startedAt).toBeLessThan(1000);
  expect(error.code).toBe('CDP_UNREACHABLE');
  expect(error.message).toContain('was not sent');
  expect(error.hint).toContain('reconnects');
  expect(server.calls).toEqual([]);
});

test('close() is idempotent and releases the connection', async () => {
  const server = await startFakeCdp();
  const session = await connectTo(server, CHART_ID);
  expect(server.openConnectionCount(CHART_ID)).toBe(1);

  const closing = session.close();

  // The session counts as closed from the moment of the call, so that nothing is sent through a
  // connection that is going away.
  expect(session.isClosed).toBe(true);
  // The library would leave the first of two overlapping closes waiting for good.
  await Promise.all([closing, session.close()]);
  await session.close();
  await vi.waitFor(() => {
    expect(server.openConnectionCount(CHART_ID)).toBe(0);
  });
});

test('runs the onClose listeners once when close() ends the session', async () => {
  const server = await startFakeCdp();
  const session = await connectTo(server, CHART_ID);
  const listener = vi.fn();
  session.onClose(listener);

  await session.close();
  await session.close();

  expect(listener).toHaveBeenCalledTimes(1);
});

test('does not run the onClose listeners again when close() follows a dropped connection', async () => {
  const server = await startFakeCdp();
  const session = await connectTo(server, CHART_ID);
  const listener = vi.fn();
  session.onClose(listener);
  server.dropConnections();
  await vi.waitFor(() => {
    expect(session.isClosed).toBe(true);
  });

  await session.close();

  expect(listener).toHaveBeenCalledTimes(1);
});

test('keeps notifying the other listeners when one throws as the connection drops', async () => {
  const server = await startFakeCdp();
  const session = await connectTo(server, CHART_ID);
  const before = vi.fn();
  const failing = vi.fn(() => {
    throw new Error('listener failed');
  });
  const after = vi.fn();
  session.onClose(before);
  session.onClose(failing);
  session.onClose(after);

  server.dropConnections();

  await vi.waitFor(() => {
    expect(after).toHaveBeenCalledTimes(1);
  });
  expect(before).toHaveBeenCalledTimes(1);
  expect(failing).toHaveBeenCalledTimes(1);
});

test('keeps notifying the other listeners when one throws as close() ends the session', async () => {
  const server = await startFakeCdp();
  const session = await connectTo(server, CHART_ID);
  const failing = vi.fn(() => {
    throw new Error('listener failed');
  });
  const after = vi.fn();
  session.onClose(failing);
  session.onClose(after);

  await expect(session.close()).resolves.toBeUndefined();

  expect(failing).toHaveBeenCalledTimes(1);
  expect(after).toHaveBeenCalledTimes(1);
});

test('runs a listener that is added after the session closed, once and at once', async () => {
  const server = await startFakeCdp();
  const session = await connectTo(server, CHART_ID);
  await session.close();
  const late = vi.fn();

  session.onClose(late);

  expect(late).toHaveBeenCalledTimes(1);
  // A failing listener does not make onClose throw either.
  expect(() => {
    session.onClose(() => {
      throw new Error('listener failed');
    });
  }).not.toThrow();
});

test('stops waiting for a peer that does not finish the closing handshake', async () => {
  const frozen = await startScriptedCdp({ frozen: true });
  const connector = createCriConnector({
    host: LOOPBACK,
    port: frozen.port,
    defaultTimeoutMs: 300,
  });
  const session = await connector.connect(
    targetWith(SCRIPTED_ID, debuggerUrl(frozen.port, SCRIPTED_ID)),
  );
  const startedAt = performance.now();

  // The library itself gives up on such a peer only after 30 seconds.
  await session.close();
  const waitedMs = performance.now() - startedAt;

  expect(session.isClosed).toBe(true);
  expect(waitedMs).toBeGreaterThanOrEqual(250);
  expect(waitedMs).toBeLessThan(CALL_TIMEOUT_MS);
});
