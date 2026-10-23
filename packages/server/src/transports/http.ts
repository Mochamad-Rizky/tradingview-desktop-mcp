import { randomUUID } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import { isIPv6, type AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Config } from '../config/schema.js';
import { TvMcpError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type { DashboardApi } from './dashboard/api.js';
import {
  allowedHostsFor,
  bearerToken,
  isAllowedHost,
  isAllowedOrigin,
  tokenMatches,
} from './http-security.js';

export interface HttpServerHandle {
  // Where clients connect. It never holds the token, so it can be shown and logged.
  url: string;
  port: number;
  close(): Promise<void>;
}

export interface HttpTransportOptions {
  config: Readonly<Config>;
  // Called for every MCP session. The servers it returns should share the dependencies of the
  // process (see createServerDeps), because a target may only ever have one CDP session.
  createServer: () => McpServer;
  logger: Logger;
  // The dashboard: its API under /api, and where its built files are. Without it, /api is 404.
  dashboard?: {
    api: DashboardApi;
    // Serving the files arrives with the dashboard package; until then it is unused.
    dir?: string;
  };
  // How long a session may go without a request in flight before it is closed.
  sessionIdleTimeoutMs?: number;
}

// Shorter tokens draw a warning at startup: the endpoint may be tunnelled to the internet, where a
// short secret can be guessed. openssl rand -hex 32, which the hints suggest, gives 64 characters.
const MIN_TOKEN_LENGTH = 32;

// A client that goes away without deleting its session would keep its server forever otherwise.
// Half an hour is longer than a user takes to answer a model, so a live session is never cut off.
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

// /mcp, /mcp/ and /mcp/<token>, for connector UIs that cannot send headers. A token that holds a
// reserved character comes percent-encoded as one segment.
const MCP_ROUTE = /^\/mcp(?:\/([^/]+))?\/?$/;
// Everything after /mcp/ can be a token, or a part of one that holds a slash.
const MCP_SUBPATH = /^\/mcp\/./;
// /api and everything under it.
const API_ROUTE = /^\/api(?:\/|$)/;
const REDACTED = '<redacted>';
const REDACTED_PATH = '/mcp/<redacted>';
const MCP_METHODS = ['GET', 'POST', 'DELETE'];
const HEALTH_METHODS = ['GET', 'HEAD'];

const MISSING_TOKEN =
  'Authentication required: send the token as "Authorization: Bearer <token>", or in the path ' +
  'as /mcp/<token>';
const MISSING_API_TOKEN =
  'Authentication required: send the token as "Authorization: Bearer <token>"';
const TOKEN_IN_URL =
  'Send the token in the "Authorization: Bearer <token>" header only, never in the URL';

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  // Responses in flight, an open event stream included. A session with none is idle.
  open: number;
  idleTimer: NodeJS.Timeout | undefined;
  closed: boolean;
  // Why the server closed it. A session that closes without one was ended by its client.
  closeReason: 'idle' | 'shutdown' | undefined;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: object,
  headers: OutgoingHttpHeaders = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

// Refusals of the MCP protocol itself take the JSON-RPC shape the SDK uses for its own.
function sendRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });
}

// Each run of percent-escapes is decoded on its own, so one malformed escape cannot keep the rest
// of the text from being read.
function decodeEscapes(text: string): string {
  return text.replace(/(?:%[0-9a-f]{2})+/gi, (escapes) => {
    try {
      return decodeURIComponent(escapes);
    } catch {
      return escapes;
    }
  });
}

// null for a malformed escape, which no token can match.
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function urlHost(host: string): string {
  return isIPv6(host) ? `[${host}]` : host;
}

// Where MCP clients connect to a transport on host:port. It never holds the token, so it can be
// shown and logged.
export function mcpUrl(host: string, port: number): string {
  return `http://${urlHost(host)}:${String(port)}/mcp`;
}

// Whether a URL carries the token, as it is or percent-encoded: as a path segment (several, for a
// token that holds a slash), or anywhere in the query string, where a client might put a parameter
// or an "Authorization" value. Only whole segments count in the path, where the names of the routes
// are.
function urlCarriesToken(url: string, token: string): boolean {
  const queryStart = url.indexOf('?');
  const path = queryStart === -1 ? url : url.slice(0, queryStart);
  const query = queryStart === -1 ? '' : url.slice(queryStart + 1);
  const inPath = [path, decodeEscapes(path)].some((text) => `${text}/`.includes(`/${token}/`));
  const inQuery = [query, decodeEscapes(query), decodeEscapes(query.replaceAll('+', ' '))].some(
    (text) => text.includes(token),
  );
  return inPath || inQuery;
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return typeof error.code === 'string' ? error.code : undefined;
  }
  return undefined;
}

function listenFailed(error: Error, where: string): Error {
  switch (errnoCode(error)) {
    case 'EADDRINUSE':
      return new TvMcpError('INVALID_INPUT', `Cannot listen on ${where}: the port is in use`, {
        hint:
          'Stop the program that uses the port, or choose another one with --port or ' +
          'TV_MCP_HTTP_PORT.',
        cause: error,
      });
    case 'EADDRNOTAVAIL':
    case 'ENOTFOUND':
      return new TvMcpError(
        'INVALID_INPUT',
        `Cannot listen on ${where}: the address is not one of this machine`,
        {
          hint: 'Use a local address, such as the default 127.0.0.1, with --host or TV_MCP_HTTP_HOST.',
          cause: error,
        },
      );
    default:
      return error;
  }
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(listenFailed(error, `${urlHost(host)}:${String(port)}`));
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

// Streamable HTTP with stateful sessions on config.httpHost:config.httpPort, and the dashboard API
// under /api when a dashboard is given. Every request must name this server as its Host and come
// from no web page but the server's own, and every MCP and API request must carry the token.
// /healthz needs no token, for scripts that check the server is up.
export async function startHttpTransport(options: HttpTransportOptions): Promise<HttpServerHandle> {
  const { config, createServer, logger } = options;
  const token = config.authToken;
  if (token === undefined) {
    throw new TvMcpError('INVALID_INPUT', 'TV_MCP_AUTH_TOKEN is required for the HTTP transport', {
      hint: 'Set TV_MCP_AUTH_TOKEN to a random secret, or use the stdio transport.',
    });
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    // Neither the token nor its length: both would help someone who guesses it.
    logger.warn(
      { minimumLength: MIN_TOKEN_LENGTH },
      `TV_MCP_AUTH_TOKEN is shorter than ${String(MIN_TOKEN_LENGTH)} characters. Whoever holds ` +
        'it can control TradingView, and a tunnel can expose this endpoint: use a long random ' +
        'secret, such as the output of "openssl rand -hex 32"',
    );
  }
  const idleTimeoutMs = options.sessionIdleTimeoutMs ?? SESSION_IDLE_TIMEOUT_MS;
  // Sessions by id, from the moment the SDK starts them.
  const sessions = new Map<string, Session>();
  // Every session that is not closed, started or not, so that close() reaches them all.
  const live = new Set<Session>();
  // Known once the port is bound, which is before the first request.
  let allowedHosts: string[] = [];

  // What a client sends can carry the token: under /mcp/ whole, cut by a slash it holds, or with a
  // typo; anywhere as it is or percent-encoded in any form. No part of it may reach a log.
  const redact = (text: string): string => {
    if (MCP_SUBPATH.test(text)) {
      return REDACTED_PATH;
    }
    const decoded = decodeEscapes(text);
    if (decoded !== text && decoded.includes(token)) {
      return REDACTED;
    }
    return text.replaceAll(token, REDACTED);
  };

  const refuse = (
    req: IncomingMessage,
    path: string,
    reason: string,
    header?: { name: 'host' | 'origin'; value: string | undefined },
  ): void => {
    logger.warn(
      {
        method: req.method,
        path: redact(path),
        reason,
        ...(header?.value === undefined ? {} : { [header.name]: redact(header.value) }),
      },
      'Refused an HTTP request',
    );
  };

  const armIdleTimer = (session: Session): void => {
    session.idleTimer = setTimeout(() => {
      session.closeReason = 'idle';
      void session.server.close();
    }, idleTimeoutMs);
    // The listening socket keeps the process alive; a session waiting to expire must not.
    session.idleTimer.unref();
  };

  const openSession = async (): Promise<Session> => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      // Called before the response to initialize goes out, so the next request of the client
      // already finds the session.
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, session);
        logger.info({ sessionId }, 'An MCP session started');
      },
    });
    const session: Session = {
      server,
      transport,
      open: 0,
      idleTimer: undefined,
      closed: false,
      closeReason: undefined,
    };
    // Set before connect(), which calls these and then its own.
    transport.onclose = () => {
      session.closed = true;
      clearTimeout(session.idleTimer);
      live.delete(session);
      const { sessionId } = transport;
      if (sessionId !== undefined && sessions.delete(sessionId)) {
        logger.info({ sessionId, reason: session.closeReason ?? 'client' }, 'An MCP session ended');
      }
    };
    transport.onerror = (error) => {
      logger.debug(
        { sessionId: transport.sessionId, error: error.message },
        'The MCP transport refused a message',
      );
    };
    // The SDK types the callbacks of this transport as accessors that may return undefined, which
    // exactOptionalPropertyTypes does not accept for the optional members of its own Transport.
    await server.connect(transport as Transport);
    live.add(session);
    return session;
  };

  const serveRequest = async (
    session: Session,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    session.open += 1;
    clearTimeout(session.idleTimer);
    res.once('close', () => {
      session.open -= 1;
      if (session.open === 0 && !session.closed) {
        armIdleTimer(session);
      }
    });
    await session.transport.handleRequest(req, res);
  };

  const serveMcp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? '';
    if (!MCP_METHODS.includes(method)) {
      sendJson(res, 405, { error: 'Method not allowed' }, { Allow: MCP_METHODS.join(', ') });
      return;
    }
    const header = req.headers['mcp-session-id'];
    if (typeof header === 'string') {
      const session = sessions.get(header);
      if (session === undefined) {
        sendRpcError(res, 404, -32001, 'Session not found');
        return;
      }
      await serveRequest(session, req, res);
      return;
    }
    if (method !== 'POST') {
      sendRpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id header is required');
      return;
    }
    // Only an initialize request may come without a session. The SDK transport decides whether
    // this is one, and refuses anything else.
    const session = await openSession();
    await serveRequest(session, req, res);
    if (session.transport.sessionId === undefined) {
      // It started no session, so nothing can ever reach this server again.
      await session.server.close();
    }
  };

  // The dashboard API takes the token from the Authorization header only. A URL ends up in logs,
  // browser histories and Referer headers, so one that carries the token is refused even next to
  // the header: whoever sent it learns to stop.
  const serveApi = async (req: IncomingMessage, res: ServerResponse, path: string) => {
    const { dashboard } = options;
    if (dashboard === undefined) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    if (urlCarriesToken(req.url ?? path, token)) {
      refuse(req, path, 'token in the URL');
      sendJson(res, 401, { error: TOKEN_IN_URL }, { 'WWW-Authenticate': 'Bearer' });
      return;
    }
    const provided = bearerToken(req.headers.authorization);
    if (!tokenMatches(provided, token)) {
      refuse(req, path, provided === undefined ? 'missing token' : 'wrong token');
      sendJson(
        res,
        401,
        { error: provided === undefined ? MISSING_API_TOKEN : 'Invalid token' },
        { 'WWW-Authenticate': 'Bearer' },
      );
      return;
    }
    await dashboard.api.handle(req, res, path);
  };

  const route = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    const { host, origin } = req.headers;
    // 403 for a foreign Host as for a foreign Origin, as the SDK's own Host check answers: the
    // request is refused, and 421 would invite a client to retry it elsewhere.
    if (!isAllowedHost(host, allowedHosts)) {
      refuse(req, path, 'host not allowed', { name: 'host', value: host });
      sendJson(res, 403, {
        error: `The Host header ${JSON.stringify(host ?? '')} does not name this server`,
      });
      return;
    }
    if (!isAllowedOrigin(origin, allowedHosts)) {
      refuse(req, path, 'origin not allowed', { name: 'origin', value: origin });
      sendJson(res, 403, { error: `Requests from the Origin ${String(origin)} are not allowed` });
      return;
    }
    if (path === '/healthz') {
      if (HEALTH_METHODS.includes(req.method ?? '')) {
        sendJson(res, 200, { ok: true });
      } else {
        sendJson(res, 405, { error: 'Method not allowed' }, { Allow: HEALTH_METHODS.join(', ') });
      }
      return;
    }
    if (API_ROUTE.test(path)) {
      await serveApi(req, res, path);
      return;
    }
    const match = MCP_ROUTE.exec(path);
    if (match === null) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    const segment = match[1];
    const provided =
      segment === undefined ? bearerToken(req.headers.authorization) : decodeSegment(segment);
    if (provided === null || !tokenMatches(provided, token)) {
      refuse(req, path, provided === undefined ? 'missing token' : 'wrong token');
      sendJson(
        res,
        401,
        { error: provided === undefined ? MISSING_TOKEN : 'Invalid token' },
        { 'WWW-Authenticate': 'Bearer' },
      );
      return;
    }
    await serveMcp(req, res);
  };

  const httpServer = createHttpServer((req, res) => {
    // The path as sent: no normalization, so only the exact routes match.
    const path = (req.url ?? '/').split('?', 1)[0] ?? '/';
    res.once('close', () => {
      logger.debug(
        { method: req.method, path: redact(path), status: res.statusCode },
        'Answered an HTTP request',
      );
    });
    route(req, res, path).catch((error: unknown) => {
      logger.error(
        { err: error, method: req.method, path: redact(path) },
        'An HTTP request failed',
      );
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, 500, { error: 'Internal server error' });
    });
  });

  await listen(httpServer, config.httpHost, config.httpPort);
  // Port 0 asks the system for a free port, so the bound one is read back.
  const { port } = httpServer.address() as AddressInfo;
  allowedHosts = allowedHostsFor(config.httpHost, port);

  let closing: Promise<void> | undefined;
  return {
    url: mcpUrl(config.httpHost, port),
    port,
    close() {
      closing ??= (async () => {
        // New connections are refused from here on, and idle ones are closed.
        const stopped = new Promise<void>((resolve) => {
          httpServer.close(() => {
            resolve();
          });
        });
        // The event streams of the dashboard end after what they sent, so their clients see them
        // end rather than break. Ending a response hands its last bytes to the socket at once, so
        // cutting the connections below loses none of them.
        options.dashboard?.api.close();
        const open = [...live];
        for (const session of open) {
          session.closeReason = 'shutdown';
        }
        // Closing a session ends its event streams, so their connections can finish.
        await Promise.all(open.map((session) => session.server.close()));
        httpServer.closeAllConnections();
        await stopped;
      })();
      return closing;
    },
  };
}
