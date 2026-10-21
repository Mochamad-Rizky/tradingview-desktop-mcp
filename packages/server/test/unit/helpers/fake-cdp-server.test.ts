import { once } from 'node:events';
import { request } from 'node:http';
import { connect as connectSocket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import vm from 'node:vm';
import WebSocket, { type RawData } from 'ws';
import { layoutMetrics } from '../../helpers/fake-cdp/layout.js';
import { createPageContext, createPageRuntime } from '../../helpers/fake-cdp/runtime.js';
import {
  FakeCdpError,
  startFakeCdpServer,
  type FakeCdpServer,
  type FakeTarget,
} from '../../helpers/fake-cdp/server.js';
import { loadTargetsFixture } from '../../helpers/fake-cdp/targets.js';
import { loadTvFixture } from '../../helpers/fake-tv/fixture.js';
import { createFakeTvWindow } from '../../helpers/fake-tv/window.js';

const CHART_URL = 'https://www.tradingview.com/chart/FIXTURE1/';
const CHART_TARGET_ID = 'BBB144A7827AE55CBA0E74986FC9574C';

interface CdpReply {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: string };
}

interface RemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  description?: string;
  value?: unknown;
}

interface ExceptionDetails {
  exceptionId: number;
  text: string;
  lineNumber: number;
  columnNumber: number;
  exception: RemoteObject;
}

interface EvaluateResult {
  result: RemoteObject;
  exceptionDetails?: ExceptionDetails;
}

interface CdpClient {
  readonly socket: WebSocket;
  readonly received: CdpReply[];
  send(method: string, params?: unknown): Promise<CdpReply>;
}

// Everything a test opens is registered here, because a server that is still listening or a
// socket that is still open keeps the vitest worker from exiting.
const servers: FakeCdpServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.terminate();
  }
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function start(targets: FakeTarget[]): Promise<FakeCdpServer> {
  const server = await startFakeCdpServer({ targets });
  servers.push(server);
  return server;
}

function pageTarget(overrides: Partial<FakeTarget> = {}): FakeTarget {
  return {
    id: 'PAGE1',
    type: 'page',
    title: 'Live stock, index, futures, Forex and Bitcoin charts on TradingView',
    url: CHART_URL,
    behavior: 'page',
    ...overrides,
  };
}

function silentTarget(overrides: Partial<FakeTarget> = {}): FakeTarget {
  return pageTarget({ id: 'BLANK1', title: '', url: '', behavior: 'silent', ...overrides });
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }
  return data.toString('utf8');
}

function pageUrl(server: FakeCdpServer, targetId: string): string {
  return `ws://127.0.0.1:${String(server.port)}/devtools/page/${targetId}`;
}

function httpUrl(server: FakeCdpServer, path: string): string {
  return `http://127.0.0.1:${String(server.port)}${path}`;
}

async function connect(server: FakeCdpServer, targetId: string): Promise<CdpClient> {
  const socket = new WebSocket(pageUrl(server, targetId));
  sockets.push(socket);
  const received: CdpReply[] = [];
  const waiting = new Map<number, (reply: CdpReply) => void>();
  socket.on('message', (data) => {
    const reply = parseJson(rawToString(data)) as CdpReply;
    received.push(reply);
    if (reply.id !== undefined) {
      waiting.get(reply.id)?.(reply);
    }
  });
  await once(socket, 'open');
  let nextId = 1;
  return {
    socket,
    received,
    send(method, params) {
      const id = nextId++;
      return new Promise<CdpReply>((resolve) => {
        waiting.set(id, resolve);
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

function evaluate(client: CdpClient, expression: string, awaitPromise = false): Promise<CdpReply> {
  return client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
}

// The Runtime.evaluate result of a reply that is not a protocol error.
function evaluation(reply: CdpReply): EvaluateResult {
  expect(reply.error).toBeUndefined();
  return reply.result as EvaluateResult;
}

function closeCode(socket: WebSocket): Promise<number> {
  return new Promise<number>((resolve) => {
    socket.once('close', (code: number) => {
      resolve(code);
    });
  });
}

function pageGlobal(window: object, name: string): unknown {
  return (window as Record<string, unknown>)[name];
}

// Fails a test that waits for a reply which never comes, instead of letting it run into the test
// timeout.
async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  const deadline = delay(ms).then(() => {
    throw new Error(`No answer within ${String(ms)} ms`);
  });
  return Promise.race([work, deadline]);
}

// Resolves with the HTTP status of a refused WebSocket upgrade. A listener for
// "unexpected-response" stops ws from reporting it as a generic error.
function upgradeStatus(url: string, options: WebSocket.ClientOptions = {}): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(url, options);
    sockets.push(socket);
    socket.on('unexpected-response', (clientRequest, response) => {
      resolve(response.statusCode ?? 0);
      clientRequest.destroy();
    });
    socket.on('open', () => {
      reject(new Error('The upgrade was accepted'));
    });
    socket.on('error', () => undefined);
  });
}

function httpGet(
  server: FakeCdpServer,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { host: '127.0.0.1', port: server.port, path, headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

// Sends a hand-written request, for the shapes an HTTP client library would never produce.
function rawHttp(server: FakeCdpServer, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket({ host: '127.0.0.1', port: server.port });
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    socket.write(text);
  });
}

test('serves the target list with WebSocket URLs', async () => {
  const server = await start([
    pageTarget(),
    pageTarget({
      id: 'FRAME1',
      type: 'iframe',
      title: 'https://www.google.com/recaptcha/api2/aframe',
      url: 'https://www.google.com/recaptcha/api2/aframe',
      parentId: 'PAGE1',
    }),
  ]);
  const port = String(server.port);

  const response = await fetch(httpUrl(server, '/json/list'));

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  const list: unknown = await response.json();
  expect(list).toEqual([
    {
      description: '',
      devtoolsFrontendUrl: `/devtools/inspector.html?ws=127.0.0.1:${port}/devtools/page/PAGE1`,
      id: 'PAGE1',
      title: 'Live stock, index, futures, Forex and Bitcoin charts on TradingView',
      type: 'page',
      url: CHART_URL,
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/PAGE1`,
    },
    {
      description: '',
      devtoolsFrontendUrl: `/devtools/inspector.html?ws=127.0.0.1:${port}/devtools/page/FRAME1`,
      id: 'FRAME1',
      parentId: 'PAGE1',
      title: 'https://www.google.com/recaptcha/api2/aframe',
      type: 'iframe',
      url: 'https://www.google.com/recaptcha/api2/aframe',
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/FRAME1`,
    },
  ]);
});

test('serves the same list on /json, like the DevTools HTTP endpoint', async () => {
  const server = await start([pageTarget()]);

  const [list, alias] = await Promise.all([
    fetch(httpUrl(server, '/json/list')).then((response) => response.json() as Promise<unknown>),
    fetch(httpUrl(server, '/json')).then((response) => response.json() as Promise<unknown>),
  ]);

  expect(alias).toEqual(list);
});

test('serves the version document observed on TradingView Desktop 3.4.1', async () => {
  const server = await start([pageTarget()]);

  const response = await fetch(httpUrl(server, '/json/version'));

  expect(response.status).toBe(200);
  const version = (await response.json()) as Record<string, string>;
  const { webSocketDebuggerUrl, ...rest } = version;
  expect(rest).toEqual({
    Browser: 'Chrome/146.0.7680.216',
    'Protocol-Version': '1.3',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) TradingView/3.4.1 Chrome/146.0.7680.216 Electron/41.7.1 Safari/537.36 TVDesktop/3.4.1',
    'V8-Version': '14.6.202.34',
    'WebKit-Version': '537.36',
  });
  expect(webSocketDebuggerUrl).toMatch(
    new RegExp(`^ws://127\\.0\\.0\\.1:${String(server.port)}/devtools/browser/[0-9a-f-]{36}$`),
  );
});

test('answers unknown HTTP paths and non-GET methods with 404', async () => {
  const server = await start([pageTarget()]);

  const unknown = await fetch(httpUrl(server, '/json/unknown'));
  const post = await fetch(httpUrl(server, '/json/list'), { method: 'POST' });

  expect(unknown.status).toBe(404);
  expect(post.status).toBe(404);
});

test('survives request lines it cannot parse and requests without a Host header', async () => {
  const server = await start([pageTarget()]);

  const malformed = await rawHttp(server, 'GET // HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
  const legacy = await rawHttp(server, 'GET /json/version HTTP/1.0\r\n\r\n');

  expect(malformed).toMatch(/^HTTP\/1\.1 404 /);
  expect(legacy).toMatch(/^HTTP\/1\.1 200 /);
  expect(legacy).toContain('"Protocol-Version": "1.3"');
});

test('listens on the loopback interface only', async () => {
  const server = await start([pageTarget()]);

  expect(server.host).toBe('127.0.0.1');
  expect(server.port).toBeGreaterThan(0);
});

test('evaluates expressions against the fake window', async () => {
  const fixture = loadTvFixture();
  const server = await start([pageTarget({ window: () => createFakeTvWindow(fixture) })]);
  const client = await connect(server, 'PAGE1');

  const reply = await evaluate(client, 'window.TradingViewApi.activeChart().symbol()');

  expect(reply).toEqual({ id: 1, result: { result: { type: 'string', value: fixture.symbol } } });
});

test('evaluates a plain sum without extra parameters', async () => {
  const server = await start([pageTarget()]);
  const client = await connect(server, 'PAGE1');

  const reply = await client.send('Runtime.evaluate', { expression: '1 + 1' });

  expect(reply).toEqual({ id: 1, result: { result: { type: 'number', value: 2 } } });
});

test('exposes the fake window as the page global, like a browser', async () => {
  const fixture = loadTvFixture();
  const server = await start([pageTarget({ window: () => createFakeTvWindow(fixture) })]);
  const client = await connect(server, 'PAGE1');
  const value = async (expression: string): Promise<unknown> =>
    evaluation(await evaluate(client, expression)).result.value;

  expect(await value('window === globalThis && self === window')).toBe(true);
  expect(await value('TradingViewApi.activeChart() === window.TradingViewApi.activeChart()')).toBe(
    true,
  );
  expect(await value('document.visibilityState')).toBe('visible');
  expect(await value('typeof NotAGlobal')).toBe('undefined');
});

test('reports a missing TradingViewApi like a page that has not booted', async () => {
  const fixture = loadTvFixture();
  const server = await start([
    pageTarget({ window: () => createFakeTvWindow(fixture, { withoutApi: true }) }),
  ]);
  const client = await connect(server, 'PAGE1');

  const property = evaluation(await evaluate(client, 'typeof window.TradingViewApi'));
  const bare = evaluation(await evaluate(client, 'TradingViewApi.isConnected()'));

  expect(property.result.value).toBe('undefined');
  expect(bare.exceptionDetails?.exception.className).toBe('ReferenceError');
  expect(bare.exceptionDetails?.exception.description).toMatch(
    /^ReferenceError: TradingViewApi is not defined\n {4}at <anonymous>:1:1$/,
  );
});

test.each([
  ['a number', '1 + 1', { type: 'number', value: 2 }],
  ['a string', '"abc"', { type: 'string', value: 'abc' }],
  ['a boolean', 'false', { type: 'boolean', value: false }],
  ['undefined', 'undefined', { type: 'undefined' }],
  ['null', 'null', { type: 'object', subtype: 'null', value: null }],
  [
    'an object',
    '({ a: 1, b: [1, 2], c: { d: null }, skipped: undefined })',
    { type: 'object', value: { a: 1, b: [1, 2], c: { d: null } } },
  ],
  ['an array', '[1, "x", null]', { type: 'object', value: [1, 'x', null] }],
  ['NaN', 'NaN', { type: 'number', unserializableValue: 'NaN', description: 'NaN' }],
  [
    'Infinity',
    'Infinity',
    { type: 'number', unserializableValue: 'Infinity', description: 'Infinity' },
  ],
  [
    'negative Infinity',
    '-Infinity',
    { type: 'number', unserializableValue: '-Infinity', description: '-Infinity' },
  ],
  ['negative zero', '-0', { type: 'number', unserializableValue: '-0', description: '-0' }],
  ['a bigint', '12n', { type: 'bigint', unserializableValue: '12n', description: '12n' }],
  ['a promise that is not awaited', '(async () => 1)()', { type: 'object', value: {} }],
])('serializes %s by value, like returnByValue', async (_label, expression, expected) => {
  const server = await start([pageTarget()]);
  const client = await connect(server, 'PAGE1');

  const reply = await evaluate(client, expression);

  expect(reply).toEqual({ id: 1, result: { result: expected } });
});

test('refuses to return values that cannot be serialized', async () => {
  const server = await start([pageTarget()]);
  const client = await connect(server, 'PAGE1');

  await expect(evaluate(client, '(() => 1)')).resolves.toEqual({
    id: 1,
    error: { code: -32000, message: "Object couldn't be returned by value" },
  });
  await expect(evaluate(client, '({ big: 1n })')).resolves.toEqual({
    id: 2,
    error: { code: -32000, message: "Object couldn't be returned by value" },
  });
  await expect(evaluate(client, 'const cycle = {}; cycle.self = cycle; cycle')).resolves.toEqual({
    id: 3,
    error: { code: -32000, message: 'Object reference chain is too long' },
  });
});

test('awaits promises only when awaitPromise is set, across realms', async () => {
  const fixture = loadTvFixture();
  const server = await start([pageTarget({ window: () => createFakeTvWindow(fixture) })]);
  const client = await connect(server, 'PAGE1');

  // An async function created inside the page gives a promise of the page realm.
  await expect(evaluate(client, '(async () => 41 + 1)()', true)).resolves.toEqual({
    id: 1,
    result: { result: { type: 'number', value: 42 } },
  });
  // A promise made by the fake window comes from the host realm instead.
  await expect(
    evaluate(
      client,
      "window.TradingViewApi.activeChart().setSymbol('NASDAQ:MSFT', { dataReady: () => undefined })",
      true,
    ),
  ).resolves.toEqual({ id: 2, result: { result: { type: 'boolean', value: true } } });
  // A thenable that is not a Promise at all is awaited too.
  await expect(
    evaluate(client, '({ then(resolve) { resolve("thenable"); } })', true),
  ).resolves.toEqual({ id: 3, result: { result: { type: 'string', value: 'thenable' } } });
});

test('returns exceptionDetails when the expression throws', async () => {
  const server = await start([pageTarget()]);
  const client = await connect(server, 'PAGE1');

  const reply = await evaluate(client, 'window.missing.member');

  const description =
    "TypeError: Cannot read properties of undefined (reading 'member')\n    at <anonymous>:1:16";
  expect(reply).toEqual({
    id: 1,
    result: {
      result: { type: 'object', subtype: 'error', className: 'TypeError', description },
      exceptionDetails: {
        exceptionId: 1,
        text: 'Uncaught',
        lineNumber: 0,
        columnNumber: 15,
        exception: { type: 'object', subtype: 'error', className: 'TypeError', description },
      },
    },
  });
});

test('numbers exceptions per page and keeps only the frames of the evaluated code', async () => {
  const server = await start([pageTarget()]);
  const client = await connect(server, 'PAGE1');

  const first = evaluation(await evaluate(client, 'null.x'));
  const second = evaluation(await evaluate(client, 'function inner() { return null.y; } inner()'));

  expect(first.exceptionDetails?.exceptionId).toBe(1);
  expect(second.exceptionDetails).toMatchObject({
    exceptionId: 2,
    lineNumber: 0,
    columnNumber: 31,
  });
  expect(second.result.description?.split('\n')).toEqual([
    "TypeError: Cannot read properties of null (reading 'y')",
    '    at inner (<anonymous>:1:32)',
    '    at <anonymous>:1:37',
  ]);
});

test('describes errors created by the fake window like page errors', async () => {
  const fixture = loadTvFixture();
  const server = await start([pageTarget({ window: () => createFakeTvWindow(fixture) })]);
  const client = await connect(server, 'PAGE1');

  const { result, exceptionDetails } = evaluation(
    await evaluate(client, 'window.TradingViewApi.activeChart().setVisibleRange({})'),
  );

  // The frame of the fake itself is dropped, so only the frame of the evaluated code remains.
  expect(result).toEqual({
    type: 'object',
    subtype: 'error',
    className: 'Error',
    description: 'Error: Not implemented\n    at <anonymous>:1:37',
  });
  expect(exceptionDetails?.text).toBe('Uncaught');
  expect(exceptionDetails?.exception.description).toBe(result.description);
});

test('reports thrown values that are not errors without a description', async () => {
  const server = await start([pageTarget()]);
  const client = await connect(server, 'PAGE1');

  const reply = await evaluate(client, 'throw "Data export is not supported"');

  expect(reply.result).toEqual({
    result: { type: 'string', value: 'Data export is not supported' },
    exceptionDetails: {
      exceptionId: 1,
      text: 'Uncaught',
      lineNumber: 0,
      columnNumber: 0,
      exception: { type: 'string', value: 'Data export is not supported' },
    },
  });
});

test('reports thrown values that cannot be serialized without failing', async () => {
  const server = await start([pageTarget()]);
  const client = await connect(server, 'PAGE1');

  const { result, exceptionDetails } = evaluation(await evaluate(client, 'throw (() => 1)'));

  expect(result).toEqual({ type: 'object', className: 'Object', description: 'Object' });
  expect(exceptionDetails?.text).toBe('Uncaught');
});

test('reports syntax errors as exceptions', async () => {
  const server = await start([pageTarget()]);
  const client = await connect(server, 'PAGE1');

  const { result, exceptionDetails } = evaluation(await evaluate(client, 'var broken = ;'));

  expect(result).toEqual({
    type: 'object',
    subtype: 'error',
    className: 'SyntaxError',
    description: "SyntaxError: Unexpected token ';'",
  });
  expect(exceptionDetails?.text).toBe('Uncaught');
  expect(exceptionDetails?.exception.className).toBe('SyntaxError');
});

test('reports a rejected promise as an exception in the promise', async () => {
  const server = await start([pageTarget()]);
  const client = await connect(server, 'PAGE1');

  const error = evaluation(
    await evaluate(client, 'Promise.reject(new RangeError("out of range"))', true),
  );
  const text = evaluation(
    await evaluate(client, 'Promise.reject("Data export is not supported")', true),
  );

  expect(error.result).toMatchObject({ subtype: 'error', className: 'RangeError' });
  expect(error.exceptionDetails).toMatchObject({
    exceptionId: 1,
    text: 'Uncaught (in promise)',
    exception: { className: 'RangeError' },
  });
  expect(error.exceptionDetails?.exception.description).toMatch(/^RangeError: out of range\n/);
  expect(text).toEqual({
    result: { type: 'string', value: 'Data export is not supported' },
    exceptionDetails: {
      exceptionId: 2,
      text: 'Uncaught (in promise)',
      lineNumber: 0,
      columnNumber: 0,
      exception: { type: 'string', value: 'Data export is not supported' },
    },
  });
});

// The shape the page bridge sends: a function source called with the window and JSON arguments.
// This one waits for dataReady with a deadline, and tells a symbol that never resolves apart by
// the invalid flag of the series, which is how the chart tools have to detect a bad symbol.
const SET_SYMBOL_PAGE_FUNCTION = `async (win, symbol, timeoutMs) => {
  const chart = win.TradingViewApi.activeChart();
  const ready = new Promise((resolve) => {
    chart.setSymbol(symbol, { dataReady: () => resolve({ ok: true, symbol: chart.symbol() }) });
  });
  const deadline = new Promise((resolve) => {
    setTimeout(() => {
      resolve({ ok: false, invalid: chart._chartWidget.model().mainSeries().isSymbolInvalid() });
    }, timeoutMs);
  });
  return Promise.race([ready, deadline]);
}`;

function pageBridgeExpression(source: string, args: unknown[]): string {
  return `(${source})(window, ...${JSON.stringify(args)})`;
}

test('runs a page function the way the page bridge sends it', async () => {
  const fixture = loadTvFixture();
  const server = await start([pageTarget({ window: () => createFakeTvWindow(fixture) })]);
  const client = await connect(server, 'PAGE1');
  const call = (symbol: string): Promise<CdpReply> =>
    evaluate(client, pageBridgeExpression(SET_SYMBOL_PAGE_FUNCTION, [symbol, 50]), true);

  const known = evaluation(await call('NASDAQ:MSFT'));
  const unknown = evaluation(await call('NOSUCH:SYMBOL'));

  expect(known.result.value).toEqual({ ok: true, symbol: 'NASDAQ:MSFT' });
  expect(unknown.result.value).toEqual({ ok: false, invalid: true });
});

test('does not leak an unhandled rejection when a rejected promise is not awaited', async () => {
  const unhandled = vi.fn();
  process.on('unhandledRejection', unhandled);
  try {
    const server = await start([pageTarget()]);
    const client = await connect(server, 'PAGE1');

    await evaluate(client, 'Promise.reject(new Error("nobody listens"))');
    await delay(20);

    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    process.off('unhandledRejection', unhandled);
  }
});

test('keeps page globals between evaluations and shares them across connections', async () => {
  const factory = vi.fn(() => createFakeTvWindow(loadTvFixture()));
  const server = await start([pageTarget({ window: factory })]);
  expect(factory).not.toHaveBeenCalled();
  const first = await connect(server, 'PAGE1');
  const second = await connect(server, 'PAGE1');

  await evaluate(first, 'window.counter = (window.counter ?? 0) + 1');
  await evaluate(first, 'window.counter = (window.counter ?? 0) + 1');
  const seen = await evaluate(second, 'window.counter');

  expect(seen).toEqual({ id: 1, result: { result: { type: 'number', value: 2 } } });
  expect(factory).toHaveBeenCalledOnce();
});

test('gives every target its own window', async () => {
  const server = await start([pageTarget(), pageTarget({ id: 'PAGE2' })]);
  const first = await connect(server, 'PAGE1');
  const second = await connect(server, 'PAGE2');

  await evaluate(first, 'window.marker = "first"');

  expect(evaluation(await evaluate(second, 'typeof window.marker')).result.value).toBe('undefined');
});

test('gives pages without a window factory a minimal browser window', async () => {
  const server = await start([pageTarget({ url: 'file:///app/window/index.html' })]);
  const client = await connect(server, 'PAGE1');

  const reply = await evaluate(client, '[location.href, document.visibilityState]');

  expect(evaluation(reply).result.value).toEqual(['file:///app/window/index.html', 'visible']);
});

test('runs page timers and clears the pending ones when the server closes', async () => {
  const win = createFakeTvWindow(loadTvFixture());
  const server = await start([pageTarget({ window: () => win })]);
  const client = await connect(server, 'PAGE1');

  const late = await evaluate(
    client,
    'new Promise((resolve) => setTimeout(() => resolve("late"), 20))',
    true,
  );
  const handle = await evaluate(
    client,
    'window.ticks = 0; const id = setInterval(() => { window.ticks += 1; }, 5); typeof id',
  );
  await evaluate(client, 'setTimeout(() => { window.fired = true; }, 50)');
  expect(evaluation(late).result.value).toBe('late');
  expect(evaluation(handle).result.value).toBe('number');

  await server.close();
  await delay(120);

  expect(pageGlobal(win, 'fired')).toBeUndefined();
  const ticksAtClose = pageGlobal(win, 'ticks');
  await delay(40);
  expect(pageGlobal(win, 'ticks')).toBe(ticksAtClose);
});

test('keeps the timers and self that a window defines itself', async () => {
  const own = { self: 'own self', setTimeout: () => 7 };
  const server = await start([pageTarget({ window: () => own })]);
  const client = await connect(server, 'PAGE1');

  const reply = await evaluate(
    client,
    '[self, setTimeout(() => undefined, 0), typeof setInterval]',
  );

  expect(evaluation(reply).result.value).toEqual(['own self', 7, 'function']);
});

test('can cancel a page timer', async () => {
  const server = await start([pageTarget()]);
  const client = await connect(server, 'PAGE1');

  await evaluate(
    client,
    'const id = setTimeout(() => { window.fired = true; }, 10); clearTimeout(id)',
  );
  await delay(40);

  expect(evaluation(await evaluate(client, 'window.fired')).result).toEqual({ type: 'undefined' });
});

test('passes timer arguments, treats odd delays as zero and ignores unknown handles', async () => {
  const server = await start([pageTarget()]);
  const client = await connect(server, 'PAGE1');

  const reply = await evaluate(
    client,
    `new Promise((resolve) => {
      const seen = [];
      setTimeout((a, b) => { seen.push(a + b); }, -5, 'x', 'y');
      setTimeout(() => { seen.push('nan'); }, NaN);
      setTimeout(() => { seen.push('none'); });
      clearTimeout(undefined);
      clearInterval(9999);
      clearTimeout('not a handle');
      setTimeout(() => resolve(seen.slice().sort()), 30);
    })`,
    true,
  );

  expect(evaluation(reply).result.value).toEqual(['nan', 'none', 'xy']);
});

test('refuses a timer without a function, like a browser given a non-callable', async () => {
  const server = await start([pageTarget()]);
  const client = await connect(server, 'PAGE1');

  const { result } = evaluation(await evaluate(client, 'setTimeout("1 + 1", 0)'));

  expect(result.className).toBe('TypeError');
});

test('survives a page timer that throws', async () => {
  const server = await start([pageTarget()]);
  const client = await connect(server, 'PAGE1');

  await evaluate(client, 'setTimeout(() => { throw new Error("uncaught in a timer"); }, 5)');
  await delay(30);

  expect(evaluation(await evaluate(client, '1 + 1')).result.value).toBe(2);
});

test('clears the timers of a window that two servers share when either one closes', async () => {
  const win = createFakeTvWindow(loadTvFixture());
  const first = await start([pageTarget({ window: () => win })]);
  const second = await start([pageTarget({ window: () => win })]);
  const firstClient = await connect(first, 'PAGE1');
  const secondClient = await connect(second, 'PAGE1');
  // The first page puts the timer functions on the window, and the second finds them there.
  await evaluate(firstClient, '1');
  await evaluate(secondClient, 'setTimeout(() => { window.fired = true; }, 200)');

  await second.close();
  await delay(250);

  expect(pageGlobal(win, 'fired')).toBeUndefined();
});

test('disposing one runtime clears the timers every runtime of the window scheduled', async () => {
  const win = {};
  const first = createPageRuntime(win);
  const second = createPageRuntime(win);
  await first.evaluate({ expression: 'setTimeout(() => { window.first = true; }, 100)' });
  await second.evaluate({ expression: 'setTimeout(() => { window.second = true; }, 100)' });

  second.dispose();
  await delay(150);

  expect(pageGlobal(win, 'first')).toBeUndefined();
  expect(pageGlobal(win, 'second')).toBeUndefined();
  first.dispose();
});

describe('createPageContext', () => {
  test('runs page code with the window as its global object, and with timers', async () => {
    const win = createFakeTvWindow(loadTvFixture(), { visibilityState: 'hidden' });
    const page = createPageContext(win);
    try {
      // A string, because values made in the page come from another realm.
      const value = page.run(`new Promise((resolve) => {
        setTimeout(() => {
          resolve([window === globalThis, self === window, document.visibilityState,
            TradingViewApi.activeChart().symbol()].join(' '));
        }, 5);
      })`);

      await expect(value).resolves.toBe('true true hidden NASDAQ:AAPL');
    } finally {
      page.dispose();
    }
  });

  test('throws what the page code throws, as an error of the page', () => {
    const page = createPageContext(createFakeTvWindow(loadTvFixture()));

    let thrown: unknown;
    try {
      page.run('notAPageGlobal + 1');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).not.toBeInstanceOf(ReferenceError);
    expect(thrown).toMatchObject({
      name: 'ReferenceError',
      message: 'notAPageGlobal is not defined',
    });
    expect(page.run('typeof ReferenceError')).toBe('function');
    page.dispose();
  });

  test('gives the vm context of the window for vm calls of its own', () => {
    const win = createFakeTvWindow(loadTvFixture());
    const page = createPageContext(win);

    expect(vm.runInContext('typeof setTimeout', page.context)).toBe('function');
    expect(page.context).toBe(win);
    page.dispose();
  });

  test('dispose cancels the pending timers of the page', async () => {
    const win = createFakeTvWindow(loadTvFixture());
    const page = createPageContext(win);
    page.run('setTimeout(() => { window.fired = true; }, 20)');

    page.dispose();
    await delay(60);

    expect(pageGlobal(win, 'fired')).toBeUndefined();
  });

  test('shares the timers of a window with the runtime of a server', async () => {
    const win = createFakeTvWindow(loadTvFixture());
    const server = await start([pageTarget({ window: () => win })]);
    const client = await connect(server, 'PAGE1');
    const page = createPageContext(win);
    page.run('setTimeout(() => { window.fromContext = true; }, 200)');
    await evaluate(client, 'setTimeout(() => { window.fromServer = true; }, 200)');

    await server.close();
    await delay(250);

    expect(pageGlobal(win, 'fromContext')).toBeUndefined();
    expect(pageGlobal(win, 'fromServer')).toBeUndefined();
    page.dispose();
  });
});

test('never answers silent targets', async () => {
  const server = await start([silentTarget()]);
  const client = await connect(server, 'BLANK1');

  void client.send('Runtime.evaluate', { expression: '1 + 1' });
  await delay(300);

  expect(client.received).toEqual([]);
  // The call itself still arrives, so tests can assert the client really sent it.
  expect(server.calls).toEqual([
    { targetId: 'BLANK1', method: 'Runtime.evaluate', params: { expression: '1 + 1' } },
  ]);
});

test('records Input calls', async () => {
  const server = await start([pageTarget()]);
  const client = await connect(server, 'PAGE1');
  const press = { type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1 };
  const key = { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 };

  const replies = [
    await client.send('Input.dispatchMouseEvent', press),
    await client.send('Input.insertText', { text: 'AAPL' }),
    await client.send('Input.dispatchKeyEvent', key),
  ];

  expect(replies.map((reply) => reply.result)).toEqual([{}, {}, {}]);
  expect(server.calls.filter((call) => call.method.startsWith('Input.'))).toEqual([
    { targetId: 'PAGE1', method: 'Input.dispatchMouseEvent', params: press },
    { targetId: 'PAGE1', method: 'Input.insertText', params: { text: 'AAPL' } },
    { targetId: 'PAGE1', method: 'Input.dispatchKeyEvent', params: key },
  ]);
});

test('records every call with the target it was sent to, in order', async () => {
  const server = await start([pageTarget(), pageTarget({ id: 'PAGE2' })]);
  const first = await connect(server, 'PAGE1');
  const second = await connect(server, 'PAGE2');

  await first.send('Runtime.evaluate', { expression: '1' });
  await second.send('Page.captureScreenshot');
  await first.send('Input.insertText', { text: 'x' });

  expect(server.calls).toEqual([
    { targetId: 'PAGE1', method: 'Runtime.evaluate', params: { expression: '1' } },
    { targetId: 'PAGE2', method: 'Page.captureScreenshot', params: {} },
    { targetId: 'PAGE1', method: 'Input.insertText', params: { text: 'x' } },
  ]);
});

test('answers unknown methods with a JSON-RPC method-not-found error', async () => {
  const server = await start([pageTarget()]);
  const client = await connect(server, 'PAGE1');

  const reply = await client.send('Foo.bar', { anything: true });

  expect(reply).toEqual({ id: 1, error: { code: -32601, message: "'Foo.bar' wasn't found" } });
});

test('does not mistake inherited object members for handlers', async () => {
  const server = await start([pageTarget({ handlers: {} })]);
  const client = await connect(server, 'PAGE1');

  const reply = await client.send('constructor');

  expect(reply.error).toEqual({ code: -32601, message: "'constructor' wasn't found" });
});

test('acknowledges the enable and disable commands of the domains the app uses', async () => {
  const server = await start([pageTarget()]);
  const client = await connect(server, 'PAGE1');

  const replies = [
    await client.send('Runtime.enable'),
    await client.send('Page.enable'),
    await client.send('Network.disable'),
  ];

  expect(replies.map((reply) => reply.result)).toEqual([{}, {}, {}]);
});

test('captures the 1x1 PNG fixture as a base64 screenshot', async () => {
  const server = await start([pageTarget()]);
  const client = await connect(server, 'PAGE1');

  const reply = await client.send('Page.captureScreenshot', { format: 'png' });

  const { data } = reply.result as { data: string };
  const png = Buffer.from(data, 'base64');
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(png.readUInt32BE(16)).toBe(1);
  expect(png.readUInt32BE(20)).toBe(1);
});

test('captures a PNG when no format is asked for, as Chrome does', async () => {
  const server = await start([pageTarget()]);
  const client = await connect(server, 'PAGE1');

  const reply = await client.send('Page.captureScreenshot');

  const { data } = reply.result as { data: string };
  expect(Buffer.from(data, 'base64').subarray(1, 4).toString('latin1')).toBe('PNG');
});

test('captures the 1x1 JPEG fixture as a base64 screenshot when a jpeg is asked for', async () => {
  const server = await start([pageTarget()]);
  const client = await connect(server, 'PAGE1');

  const reply = await client.send('Page.captureScreenshot', { format: 'jpeg', quality: 80 });

  const { data } = reply.result as { data: string };
  const jpeg = Buffer.from(data, 'base64');
  // From the start-of-image marker to the end-of-image marker.
  expect(jpeg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  expect(jpeg.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
  // The frame header (SOF0) holds the height and the width, 1 each, after the precision byte.
  const frame = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
  expect(frame).toBeGreaterThan(0);
  expect([jpeg.readUInt16BE(frame + 5), jpeg.readUInt16BE(frame + 7)]).toEqual([1, 1]);
});

test('records the parameters of a screenshot, so a test can look at the clip and the scale', async () => {
  const server = await start([pageTarget()]);
  const client = await connect(server, 'PAGE1');
  const clip = { x: 52, y: 44, width: 1403, height: 757, scale: 0.25 };

  const reply = await client.send('Page.captureScreenshot', {
    format: 'jpeg',
    quality: 80,
    clip,
    captureBeyondViewport: false,
  });

  expect(reply.error).toBeUndefined();
  expect(server.calls).toEqual([
    {
      targetId: 'PAGE1',
      method: 'Page.captureScreenshot',
      params: { format: 'jpeg', quality: 80, clip, captureBeyondViewport: false },
    },
  ]);
});

test.each([
  ['a format Chrome has not got', { format: 'gif' }, -32602, 'format: png or jpeg expected'],
  ['a format that is not text', { format: 7 }, -32602, 'format: png or jpeg expected'],
  ['a clip that is not an object', { clip: 'all' }, -32602, 'clip: Viewport value expected'],
  [
    'a clip without a scale',
    { clip: { x: 0, y: 0, width: 10, height: 10 } },
    -32602,
    'clip: Viewport value expected',
  ],
  [
    'a clip with a number as text',
    { clip: { x: 0, y: 0, width: '10', height: 10, scale: 1 } },
    -32602,
    'clip: Viewport value expected',
  ],
  [
    'a clip with no width',
    { clip: { x: 0, y: 0, width: 0, height: 10, scale: 1 } },
    -32000,
    undefined,
  ],
  [
    'a clip with no height',
    { clip: { x: 0, y: 0, width: 10, height: 0, scale: 1 } },
    -32000,
    undefined,
  ],
  [
    'a clip with no scale to speak of',
    { clip: { x: 0, y: 0, width: 10, height: 10, scale: 0 } },
    -32602,
    'clip.scale: positive number expected',
  ],
])('refuses a screenshot with %s', async (_case, params, code, data) => {
  const server = await start([pageTarget()]);
  const client = await connect(server, 'PAGE1');

  const reply = await client.send('Page.captureScreenshot', params);

  expect(reply.result).toBeUndefined();
  expect(reply.error?.code).toBe(code);
  expect(reply.error?.data).toBe(data);
});

test('refuses a screenshot with a clip that has no width in the words of Chrome', async () => {
  const server = await start([pageTarget()]);
  const client = await connect(server, 'PAGE1');

  const reply = await client.send('Page.captureScreenshot', {
    clip: { x: 0, y: 0, width: 0, height: 10, scale: 1 },
  });

  expect(reply.error?.message).toBe('Cannot take screenshot with 0 width.');
});

test('answers Page.getLayoutMetrics from the viewport of the window of the target', async () => {
  const win = createFakeTvWindow(loadTvFixture(), {
    screen: { width: 1600, height: 1000, devicePixelRatio: 2 },
  });
  const server = await start([pageTarget({ window: () => win })]);
  const client = await connect(server, 'PAGE1');

  const reply = await client.send('Page.getLayoutMetrics');

  expect(reply.result).toEqual(layoutMetrics({ width: 1600, height: 1000, devicePixelRatio: 2 }));
  const metrics = reply.result as ReturnType<typeof layoutMetrics>;
  // The metrics in CSS pixels are the viewport, and those in device pixels are twice as big.
  expect(metrics.cssVisualViewport).toMatchObject({ clientWidth: 1600, clientHeight: 1000 });
  expect(metrics.visualViewport).toMatchObject({ clientWidth: 3200, clientHeight: 2000 });
  expect(server.calls).toEqual([
    { targetId: 'PAGE1', method: 'Page.getLayoutMetrics', params: {} },
  ]);
});

test('answers Page.getLayoutMetrics of a page with no window of its own as a blank viewport', async () => {
  const server = await start([pageTarget()]);
  const client = await connect(server, 'PAGE1');

  const reply = await client.send('Page.getLayoutMetrics');

  expect(reply.result).toEqual(layoutMetrics({ width: 1280, height: 720, devicePixelRatio: 1 }));
});

test('answers Page.getLayoutMetrics of every target from its own window', async () => {
  const wide = (): object => ({ innerWidth: 2000, innerHeight: 34, devicePixelRatio: 3 });
  const server = await start([
    pageTarget({ id: 'CHART1', window: wide }),
    pageTarget({ id: 'OTHER1', url: 'file:///app.asar/app/window/index.html' }),
  ]);
  const chart = await connect(server, 'CHART1');
  const other = await connect(server, 'OTHER1');

  expect((await chart.send('Page.getLayoutMetrics')).result).toEqual(
    layoutMetrics({ width: 2000, height: 34, devicePixelRatio: 3 }),
  );
  expect((await other.send('Page.getLayoutMetrics')).result).toEqual(
    layoutMetrics({ width: 1280, height: 720, devicePixelRatio: 1 }),
  );
});

test('lets a target override default methods and add its own', async () => {
  const seen: unknown[] = [];
  const server = await start([
    pageTarget({
      handlers: {
        'Page.captureScreenshot': () => ({ data: 'AAAA' }),
        'Runtime.evaluate': (params) => {
          seen.push(params);
          return { result: { type: 'string', value: 'from handler' } };
        },
        'Browser.getVersion': () => Promise.resolve({ product: 'Chrome/146.0.7680.216' }),
        'Page.navigate': () => undefined,
      },
    }),
  ]);
  const client = await connect(server, 'PAGE1');

  const screenshot = await client.send('Page.captureScreenshot');
  const evaluated = await client.send('Runtime.evaluate', { expression: 'ignored' });
  const version = await client.send('Browser.getVersion');
  const navigated = await client.send('Page.navigate', { url: 'https://example.test/' });

  expect(screenshot.result).toEqual({ data: 'AAAA' });
  expect(evaluated.result).toEqual({ result: { type: 'string', value: 'from handler' } });
  expect(seen).toEqual([{ expression: 'ignored' }]);
  expect(version.result).toEqual({ product: 'Chrome/146.0.7680.216' });
  expect(navigated.result).toEqual({});
});

test('turns a handler failure into a CDP error response', async () => {
  const server = await start([
    pageTarget({
      handlers: {
        'Page.navigate': () => {
          throw new FakeCdpError(-32000, 'Cannot navigate to invalid URL');
        },
        'Page.reload': () => {
          throw new Error('renderer crashed');
        },
        'Page.stopLoading': () => Promise.reject(new FakeCdpError(-32602, 'Invalid parameters')),
      },
    }),
  ]);
  const client = await connect(server, 'PAGE1');

  await expect(client.send('Page.navigate')).resolves.toEqual({
    id: 1,
    error: { code: -32000, message: 'Cannot navigate to invalid URL' },
  });
  await expect(client.send('Page.reload')).resolves.toEqual({
    id: 2,
    error: { code: -32000, message: 'renderer crashed' },
  });
  await expect(client.send('Page.stopLoading')).resolves.toEqual({
    id: 3,
    error: { code: -32602, message: 'Invalid parameters' },
  });
});

test('answers with a server error when a handler result cannot be serialized', async () => {
  const unhandled = vi.fn();
  process.on('unhandledRejection', unhandled);
  try {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const server = await start([
      pageTarget({
        handlers: {
          'Page.getLayoutMetrics': () => ({ contentSize: 1n }),
          'Page.getFrameTree': () => Promise.resolve(cyclic),
        },
      }),
    ]);
    const client = await connect(server, 'PAGE1');

    const bigint = await within(client.send('Page.getLayoutMetrics'), 1000);
    const cycle = await within(client.send('Page.getFrameTree'), 1000);
    const after = await within(client.send('Runtime.evaluate', { expression: '1 + 1' }), 1000);
    await delay(20);

    expect(bigint).toEqual({
      id: 1,
      error: { code: -32000, message: 'Do not know how to serialize a BigInt' },
    });
    expect(cycle.id).toBe(2);
    expect(cycle.error?.code).toBe(-32000);
    expect(cycle.error?.message).toMatch(/^Converting circular structure to JSON/);
    // The connection keeps working after a reply that could not be sent as it was.
    expect(after.result).toEqual({ result: { type: 'number', value: 2 } });
    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    process.off('unhandledRejection', unhandled);
  }
});

test('rejects Runtime.evaluate without an expression as invalid parameters', async () => {
  const server = await start([pageTarget()]);
  const client = await connect(server, 'PAGE1');

  const reply = await client.send('Runtime.evaluate', { returnByValue: true });

  expect(reply).toEqual({
    id: 1,
    error: {
      code: -32602,
      message: 'Invalid parameters',
      data: 'expression: string value expected',
    },
  });
});

test('answers malformed messages with protocol errors', async () => {
  const server = await start([pageTarget()]);
  const client = await connect(server, 'PAGE1');
  const nextMessage = (): Promise<unknown> =>
    new Promise((resolve) => {
      client.socket.once('message', (data) => {
        resolve(parseJson(rawToString(data)));
      });
    });

  const invalidJson = nextMessage();
  client.socket.send('this is not json');
  await expect(invalidJson).resolves.toEqual({
    error: { code: -32700, message: 'Message must be a valid JSON' },
  });

  const missingId = nextMessage();
  client.socket.send(JSON.stringify({ method: 'Runtime.evaluate' }));
  await expect(missingId).resolves.toEqual({
    error: { code: -32600, message: "Message must have integer 'id' property" },
  });

  const missingMethod = nextMessage();
  client.socket.send(JSON.stringify({ id: 7 }));
  await expect(missingMethod).resolves.toEqual({
    id: 7,
    error: { code: -32600, message: "Message must have string 'method' property" },
  });
  expect(server.calls).toEqual([]);
});

test('setTargets changes what is discoverable without cutting open connections', async () => {
  const server = await start([pageTarget()]);
  const existing = await connect(server, 'PAGE1');

  server.setTargets([pageTarget({ id: 'PAGE2' })]);

  const list = (await (await fetch(httpUrl(server, '/json/list'))).json()) as { id: string }[];
  expect(list.map((entry) => entry.id)).toEqual(['PAGE2']);
  await expect(upgradeStatus(pageUrl(server, 'PAGE1'))).resolves.toBe(404);
  await expect(connect(server, 'PAGE2')).resolves.toBeDefined();
  expect(evaluation(await evaluate(existing, '1 + 1')).result.value).toBe(2);
});

test('counts WebSocket connections per target', async () => {
  const server = await start([pageTarget(), pageTarget({ id: 'PAGE2' })]);
  expect(server.connectionCount()).toBe(0);

  await connect(server, 'PAGE1');
  await connect(server, 'PAGE1');
  await connect(server, 'PAGE2');

  expect(server.connectionCount()).toBe(3);
  expect(server.connectionCount('PAGE1')).toBe(2);
  expect(server.connectionCount('PAGE2')).toBe(1);
  expect(server.openConnectionCount()).toBe(3);
  expect(server.openConnectionCount('PAGE2')).toBe(1);
});

test('dropConnections closes every open socket, and clients can reconnect', async () => {
  const server = await start([pageTarget(), pageTarget({ id: 'PAGE2' })]);
  const first = await connect(server, 'PAGE1');
  const second = await connect(server, 'PAGE2');
  const codes = Promise.all([closeCode(first.socket), closeCode(second.socket)]);

  server.dropConnections();

  // 1006 is the code a client reports when the peer vanishes without a close frame.
  await expect(codes).resolves.toEqual([1006, 1006]);
  expect(server.openConnectionCount()).toBe(0);
  expect(server.connectionCount()).toBe(2);
  const again = await connect(server, 'PAGE1');
  expect(evaluation(await evaluate(again, '1 + 1')).result.value).toBe(2);
  expect(server.connectionCount()).toBe(3);
});

test('refuses WebSocket upgrades for unknown targets', async () => {
  const server = await start([pageTarget()]);

  await expect(upgradeStatus(pageUrl(server, 'NOPE'))).resolves.toBe(404);
  await expect(upgradeStatus(pageUrl(server, '%E0%A4%A'))).resolves.toBe(404);
  await expect(
    upgradeStatus(`ws://127.0.0.1:${String(server.port)}/devtools/browser/anything`),
  ).resolves.toBe(404);
});

test('refuses browser origins and rebinding hosts, like Chrome does by default', async () => {
  const server = await start([pageTarget()]);

  await expect(
    upgradeStatus(pageUrl(server, 'PAGE1'), { origin: 'https://evil.example' }),
  ).resolves.toBe(403);
  await expect(
    upgradeStatus(pageUrl(server, 'PAGE1'), { headers: { Host: 'evil.example' } }),
  ).resolves.toBe(500);
  const rebinding = await httpGet(server, '/json/list', { Host: 'evil.example:80' });
  expect(rebinding.status).toBe(500);
  expect(rebinding.body).toBe('Host header is specified and is not an IP address or localhost.');
  expect(server.connectionCount()).toBe(0);
});

test('refuses a bracketed host without a closing bracket', async () => {
  const server = await start([pageTarget()]);

  const reply = await httpGet(server, '/json/version', { Host: '[::1' });

  expect(reply.status).toBe(500);
});

test('accepts localhost, IPv4 and bracketed IPv6 host headers', async () => {
  const server = await start([pageTarget()]);

  for (const host of [
    `localhost:${String(server.port)}`,
    `127.0.0.1:${String(server.port)}`,
    `[::1]:${String(server.port)}`,
    'localhost',
  ]) {
    const reply = await httpGet(server, '/json/version', { Host: host });
    expect(reply.status, host).toBe(200);
  }
});

test('close releases the port and ends open and silent connections', async () => {
  const server = await start([pageTarget(), silentTarget()]);
  const answering = await connect(server, 'PAGE1');
  const silent = await connect(server, 'BLANK1');
  void silent.send('Runtime.evaluate', { expression: '1' });
  const closed = Promise.all([closeCode(answering.socket), closeCode(silent.socket)]);

  await server.close();

  await closed;
  await expect(fetch(httpUrl(server, '/json/version'))).rejects.toThrow();
  expect(server.openConnectionCount()).toBe(0);
  // Closing twice is harmless, because afterEach closes every server again.
  await expect(server.close()).resolves.toBeUndefined();
});

test('loads the observed macOS target list as fake targets', () => {
  const targets = loadTargetsFixture();

  expect(targets.map((target) => [target.id, target.type])).toEqual([
    ['EE67363DAA56C9940A709061CFAA2FFF', 'page'],
    [CHART_TARGET_ID, 'page'],
    ['45FA12C67FCC102BC635696179137865', 'iframe'],
    ['359029838B634FA51337C41A946372CD', 'iframe'],
    ['A0290DCF69763ECAA55FA54875AD50A1', 'iframe'],
    ['0621E0BEA8DA2CEEE3C6E3AFFD3C3229', 'page'],
    ['D4FA899CB58B76FCEDDAC2E1E63735B2', 'page'],
    ['B8F925F86CC032DD97DED7C12AB73A28', 'page'],
    ['ABC65E8C0B5768A7D97D910867C78382', 'page'],
    ['80A80E86AF3E47B46C0E0C0A748CFC57', 'page'],
    ['98698293B7D146D1E80957D68A04BDD7', 'worker'],
  ]);
});

test('marks only the two blank pages of the fixture as silent', () => {
  const targets = loadTargetsFixture();

  const silent = targets.filter((target) => target.behavior === 'silent');

  expect(silent.map((target) => target.id)).toEqual([
    'D4FA899CB58B76FCEDDAC2E1E63735B2',
    '80A80E86AF3E47B46C0E0C0A748CFC57',
  ]);
  expect(silent.every((target) => target.type === 'page' && target.url === '')).toBe(true);
  expect(targets.filter((target) => target.behavior === 'page')).toHaveLength(9);
});

test('keeps the chart page, its frames and the scrubbed instance IDs in the fixture', () => {
  const targets = loadTargetsFixture();
  const chart = targets.find((target) => target.url === CHART_URL);

  expect(chart).toMatchObject({
    id: CHART_TARGET_ID,
    type: 'page',
    title: 'Live stock, index, futures, Forex and Bitcoin charts on TradingView',
  });
  const frames = targets.filter((target) => target.type === 'iframe');
  expect(frames.map((frame) => frame.parentId)).toEqual([
    CHART_TARGET_ID,
    CHART_TARGET_ID,
    CHART_TARGET_ID,
  ]);
  expect(targets.filter((target) => target.parentId === undefined)).toHaveLength(8);
  const chrome = targets.find((target) => target.url.includes('/app/window/index.html'));
  expect(chrome?.url).toContain('fixture-tvd%3Atabbed-window');
  expect(JSON.stringify(targets)).not.toMatch(/webSocketDebuggerUrl|devtoolsFrontendUrl/);
});

test('attaches a chart window to the chart page of the fixture only', () => {
  const chartWindow = (): object => ({});

  const targets = loadTargetsFixture({ chartWindow });

  expect(
    targets.filter((target) => target.window !== undefined).map((target) => target.id),
  ).toEqual([CHART_TARGET_ID]);
  expect(loadTargetsFixture().every((target) => target.window === undefined)).toBe(true);
});

test('attaches a chrome window to the window chrome page of the fixture only', () => {
  const chromeWindow = (): object => ({});

  const targets = loadTargetsFixture({ chromeWindow });
  const both = loadTargetsFixture({ chartWindow: () => ({}), chromeWindow });

  const chrome = targets.find((target) => target.url.includes('/app/window/index.html'));
  expect(targets.filter((target) => target.window !== undefined)).toEqual([chrome]);
  expect(chrome?.window).toBe(chromeWindow);
  expect(both.filter((target) => target.window !== undefined)).toHaveLength(2);
});

test('serves the whole fixture with WebSocket URLs and answers on the chart page', async () => {
  const fixture = loadTvFixture();
  const server = await start(
    loadTargetsFixture({ chartWindow: () => createFakeTvWindow(fixture) }),
  );

  const list = (await (await fetch(httpUrl(server, '/json/list'))).json()) as {
    id: string;
    webSocketDebuggerUrl: string;
  }[];
  const client = await connect(server, CHART_TARGET_ID);

  expect(list).toHaveLength(11);
  expect(list.every((entry) => entry.webSocketDebuggerUrl === pageUrl(server, entry.id))).toBe(
    true,
  );
  await expect(evaluate(client, 'window.TradingViewApi.activeChart().symbol()')).resolves.toEqual({
    id: 1,
    result: { result: { type: 'string', value: fixture.symbol } },
  });
});
