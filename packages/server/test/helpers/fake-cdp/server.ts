import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP, type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { fixturePath } from '../fixture-path.js';
import { CDP_ERROR, FakeCdpError, isRecord } from './protocol.js';
import { createPageRuntime, type PageRuntime } from './runtime.js';

export { FakeCdpError } from './protocol.js';

// A stand-in for the remote debugging port of TradingView Desktop, with the HTTP and WebSocket
// shapes Chrome 146 serves (the app was observed at 3.4.1). The server under test talks to it
// over a real socket, unchanged.

const HOST = '127.0.0.1';

export interface FakeTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  // "silent" targets accept the WebSocket and then never answer, like the blank pages of the
  // app: they have no execution context, so Runtime.evaluate on them never returns.
  behavior: 'page' | 'silent';
  // Set on iframes, to the id of the page that embeds them.
  parentId?: string;
  // Creates the window Runtime.evaluate runs against. Called on the first evaluation and then
  // kept for as long as this FakeTarget object stays in the list, so page globals persist
  // between calls and connections. Passing a new object for the same id gives a fresh page,
  // the way a reload would. Pages without a factory get a minimal browser window.
  window?: () => object;
  // Answers for single CDP methods. They win over the defaults, may return a promise, and may
  // throw a FakeCdpError to answer with a protocol error.
  handlers?: Record<string, (params: unknown) => unknown>;
}

export interface FakeCdpCall {
  targetId: string;
  method: string;
  params: unknown;
}

export interface FakeCdpServer {
  host: typeof HOST;
  port: number;
  // Every call that reached a target, answered or not, in arrival order. Params are `{}` when
  // the client sent none.
  calls: FakeCdpCall[];
  // Replaces what /json/list serves and which targets accept new connections. Connections that
  // are already open keep working: use dropConnections to cut them.
  setTargets(targets: FakeTarget[]): void;
  // Ends every open WebSocket without a close frame, like the app going away.
  dropConnections(): void;
  // WebSocket connections accepted since the server started (all, or for one target).
  connectionCount(targetId?: string): number;
  // The ones among them that are still open.
  openConnectionCount(targetId?: string): number;
  close(): Promise<void>;
}

export interface FakeCdpServerOptions {
  targets: FakeTarget[];
}

const BROWSER_VERSION = {
  Browser: 'Chrome/146.0.7680.216',
  'Protocol-Version': '1.3',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) TradingView/3.4.1 Chrome/146.0.7680.216 Electron/41.7.1 Safari/537.36 TVDesktop/3.4.1',
  'V8-Version': '14.6.202.34',
  'WebKit-Version': '537.36',
};

// The enable and disable commands of the domains a client may switch on before using them.
// Without event streams they have nothing to start or stop.
const ACKNOWLEDGED_METHODS = new Set(
  ['Runtime', 'Page', 'Network', 'Log', 'DOM'].flatMap((domain) => [
    `${domain}.enable`,
    `${domain}.disable`,
  ]),
);

const PAGE_PATH = /^\/devtools\/page\/([^/]+)$/;

// Chrome answers requests for any other Host with this text, which stops a web page from
// reaching the debug port through DNS rebinding.
const HOST_REFUSAL = 'Host header is specified and is not an IP address or localhost.';

let screenshot: string | undefined;

function screenshotData(): string {
  screenshot ??= readFileSync(fixturePath('png/1x1.png')).toString('base64');
  return screenshot;
}

// The host name of a Host header, without its port. An IPv6 literal is bracketed, so the port is
// whatever follows the closing bracket; a literal without one is malformed and has no name.
function hostnameOf(header: string): string {
  if (header.startsWith('[')) {
    const end = header.indexOf(']');
    return end === -1 ? '' : header.slice(1, end);
  }
  return header.split(':')[0] ?? '';
}

function isAllowedHost(header: string | undefined): boolean {
  if (header === undefined) {
    return true;
  }
  const host = hostnameOf(header);
  return host === 'localhost' || isIP(host) !== 0;
}

function pathnameOf(url: string | undefined): string | undefined {
  try {
    return new URL(url ?? '/', `http://${HOST}`).pathname;
  } catch {
    return undefined;
  }
}

function decode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
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

function sendText(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=UTF-8',
    'Content-Length': Buffer.byteLength(text),
    Connection: 'close',
  });
  response.end(text);
}

// Chrome pretty-prints its JSON endpoints, with a trailing newline.
function sendJson(response: ServerResponse, body: unknown): void {
  const text = `${JSON.stringify(body, null, 2)}\n`;
  response.writeHead(200, {
    'Content-Type': 'application/json; charset=UTF-8',
    'Content-Length': Buffer.byteLength(text),
    Connection: 'close',
  });
  response.end(text);
}

function errorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof FakeCdpError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.data === undefined ? {} : { data: error.data }),
    };
  }
  return {
    code: CDP_ERROR.serverError,
    message: error instanceof Error ? error.message : String(error),
  };
}

function createBlankWindow(url: string): object {
  return { location: { href: url }, document: { visibilityState: 'visible' } };
}

interface Connection {
  webSocket: WebSocket;
  targetId: string;
}

export async function startFakeCdpServer(options: FakeCdpServerOptions): Promise<FakeCdpServer> {
  let targets = [...options.targets];
  let port = 0;
  const browserId = randomUUID();
  const calls: FakeCdpCall[] = [];
  const connections = new Set<Connection>();
  const acceptedTargetIds: string[] = [];
  const refusedSockets = new Set<Duplex>();
  const runtimes = new WeakMap<FakeTarget, PageRuntime>();
  const liveRuntimes = new Set<PageRuntime>();
  const webSocketServer = new WebSocketServer({ noServer: true });

  const runtimeFor = (target: FakeTarget): PageRuntime => {
    let runtime = runtimes.get(target);
    if (!runtime) {
      runtime = createPageRuntime(target.window?.() ?? createBlankWindow(target.url));
      runtimes.set(target, runtime);
      liveRuntimes.add(runtime);
    }
    return runtime;
  };

  const describeTarget = (target: FakeTarget): Record<string, string> => {
    const path = `${HOST}:${String(port)}/devtools/page/${encodeURIComponent(target.id)}`;
    return {
      description: '',
      devtoolsFrontendUrl: `/devtools/inspector.html?ws=${path}`,
      id: target.id,
      ...(target.parentId === undefined ? {} : { parentId: target.parentId }),
      title: target.title,
      type: target.type,
      url: target.url,
      webSocketDebuggerUrl: `ws://${path}`,
    };
  };

  const httpServer = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (!isAllowedHost(request.headers.host)) {
      sendText(response, 500, HOST_REFUSAL);
      return;
    }
    const pathname = pathnameOf(request.url);
    if (request.method !== 'GET') {
      sendText(response, 404, 'Unknown path');
    } else if (pathname === '/json/version') {
      sendJson(response, {
        ...BROWSER_VERSION,
        webSocketDebuggerUrl: `ws://${HOST}:${String(port)}/devtools/browser/${browserId}`,
      });
    } else if (pathname === '/json/list' || pathname === '/json') {
      sendJson(response, targets.map(describeTarget));
    } else {
      sendText(response, 404, 'Unknown path');
    }
  });

  // Methods answered without a handler, which is what a plain page does.
  const defaultAnswer = (target: FakeTarget, method: string, params: Record<string, unknown>) => {
    if (method === 'Runtime.evaluate') {
      return runtimeFor(target).evaluate(params);
    }
    if (method === 'Page.captureScreenshot') {
      return { data: screenshotData() };
    }
    if (method.startsWith('Input.') || ACKNOWLEDGED_METHODS.has(method)) {
      return {};
    }
    throw new FakeCdpError(CDP_ERROR.methodNotFound, `'${method}' wasn't found`);
  };

  const answer = async (
    connection: Connection,
    target: FakeTarget,
    id: number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> => {
    let payload: Record<string, unknown>;
    try {
      const handler =
        target.handlers !== undefined && Object.hasOwn(target.handlers, method)
          ? target.handlers[method]
          : undefined;
      const result: unknown = await (handler
        ? handler(params)
        : defaultAnswer(target, method, params));
      payload = { id, result: result ?? {} };
    } catch (error) {
      payload = { id, error: errorPayload(error) };
    }
    send(connection.webSocket, payload);
  };

  const send = (webSocket: WebSocket, payload: Record<string, unknown>): void => {
    if (webSocket.readyState === WebSocket.OPEN) {
      webSocket.send(JSON.stringify(payload));
    }
  };

  const handleMessage = (connection: Connection, target: FakeTarget, data: RawData): void => {
    let message: unknown;
    try {
      message = JSON.parse(rawToString(data));
    } catch {
      message = undefined;
    }
    if (!isRecord(message)) {
      send(connection.webSocket, {
        error: { code: CDP_ERROR.parseError, message: 'Message must be a valid JSON' },
      });
      return;
    }
    const { id, method, params } = message;
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      send(connection.webSocket, {
        error: {
          code: CDP_ERROR.invalidRequest,
          message: "Message must have integer 'id' property",
        },
      });
      return;
    }
    if (typeof method !== 'string') {
      send(connection.webSocket, {
        id,
        error: {
          code: CDP_ERROR.invalidRequest,
          message: "Message must have string 'method' property",
        },
      });
      return;
    }
    const callParams = isRecord(params) ? params : {};
    calls.push({ targetId: target.id, method, params: callParams });
    if (target.behavior === 'silent') {
      return;
    }
    void answer(connection, target, id, method, callParams);
  };

  const accept = (webSocket: WebSocket, target: FakeTarget): void => {
    const connection: Connection = { webSocket, targetId: target.id };
    connections.add(connection);
    acceptedTargetIds.push(target.id);
    // A peer that disappears mid-frame makes ws emit an error, which must not take the test
    // process down.
    webSocket.on('error', () => undefined);
    webSocket.on('close', () => {
      connections.delete(connection);
    });
    webSocket.on('message', (data) => {
      handleMessage(connection, target, data);
    });
  };

  const refuseUpgrade = (socket: Duplex, status: number, reason: string, text: string): void => {
    refusedSockets.add(socket);
    socket.once('close', () => {
      refusedSockets.delete(socket);
    });
    socket.end(
      `HTTP/1.1 ${String(status)} ${reason}\r\n` +
        'Content-Type: text/plain; charset=UTF-8\r\n' +
        `Content-Length: ${String(Buffer.byteLength(text))}\r\n` +
        `Connection: close\r\n\r\n${text}`,
    );
  };

  httpServer.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => undefined);
    if (!isAllowedHost(request.headers.host)) {
      refuseUpgrade(socket, 500, 'Internal Server Error', HOST_REFUSAL);
      return;
    }
    // Chrome refuses browser-originated connections unless they are allowed explicitly. Clients
    // such as chrome-remote-interface send no Origin header, so only web pages are kept out.
    const origin = request.headers.origin;
    if (origin !== undefined) {
      refuseUpgrade(
        socket,
        403,
        'Forbidden',
        `Rejected an incoming WebSocket connection from the ${origin} origin.`,
      );
      return;
    }
    const pathname = pathnameOf(request.url);
    const targetId = decode(PAGE_PATH.exec(pathname ?? '')?.[1] ?? '');
    const target = targets.find((candidate) => candidate.id === targetId);
    if (!target) {
      refuseUpgrade(socket, 404, 'Not Found', 'No such target id');
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      accept(webSocket, target);
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, HOST, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  const address = httpServer.address() as AddressInfo | null;
  if (address === null) {
    throw new Error('The fake CDP server did not report a port');
  }
  port = address.port;

  const countAccepted = (targetId: string | undefined): number =>
    targetId === undefined
      ? acceptedTargetIds.length
      : acceptedTargetIds.filter((accepted) => accepted === targetId).length;

  let closing: Promise<void> | undefined;

  return {
    host: HOST,
    port,
    calls,
    setTargets(next) {
      targets = [...next];
    },
    dropConnections() {
      for (const { webSocket } of connections) {
        webSocket.terminate();
      }
    },
    connectionCount: countAccepted,
    openConnectionCount(targetId) {
      return [...connections].filter(
        (connection) =>
          connection.webSocket.readyState === WebSocket.OPEN &&
          (targetId === undefined || connection.targetId === targetId),
      ).length;
    },
    close() {
      closing ??= (async () => {
        for (const runtime of liveRuntimes) {
          runtime.dispose();
        }
        for (const { webSocket } of connections) {
          webSocket.terminate();
        }
        for (const socket of refusedSockets) {
          socket.destroy();
        }
        webSocketServer.close();
        await new Promise<void>((resolve) => {
          httpServer.close(() => {
            resolve();
          });
          // Closes keep-alive connections of clients such as fetch, which would hold the
          // close callback back until they time out.
          httpServer.closeAllConnections();
        });
      })();
      return closing;
    },
  };
}
