/** @import { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http' */
/** @import { DashboardError, DashboardEvent, JsonValue } from '../../server/src/transports/dashboard/contract.ts' */
/** @import { UnnumberedEvent } from './fixtures.mjs' */

// The mock server of the dashboard's end-to-end tests (playwright.config.ts starts it, on port
// 4173): the built dashboard of packages/dashboard/dist, and the dashboard API answered from the
// synthetic fixtures of fixtures.mjs. It follows the server where the dashboard can tell:
// - the same routes, statuses and JSON (packages/server/src/transports/dashboard/api.ts);
// - the same Host and Origin checks, and the token as "Authorization: Bearer" only, a 401 with
//   WWW-Authenticate otherwise, and a token in the URL refused (transports/http.ts);
// - the same 401 for /mcp without the token; with it the mock answers 404, as it speaks no MCP;
// - the same event stream: retry: 3000, ids of the form <bootId>-<seq>, event: tool, event: gap for
//   a Last-Event-ID of another boot, and a ": ping" comment every 15 s (dashboard/sse.ts);
// - the same headers on the dashboard files (dashboard/static.ts).
// A tool call runs nothing: it answers from the fixtures, and its start and end go to the event
// stream as a dashboard call. The routes under /__control/ are the tests' own: they push events,
// change what the API answers, and set it all back.
//
// Plain JavaScript, so that `node e2e/mock-server.mjs` starts it as it is; e2e/tsconfig.json checks
// it with its JSDoc types.

import { randomBytes, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  asErrorCode,
  backlogEvents,
  durationOf,
  errorCodeOf,
  health,
  info,
  MOCK_HOST,
  MOCK_PORT,
  MOCK_TOKEN,
  resultFor,
  SECURITY_HEADERS,
  tools,
} from './fixtures.mjs';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const INDEX = 'index.html';

// The server's constants, as packages/server/src/transports keeps them.
const MAX_BODY_BYTES = 1_048_576;
const DEFAULT_REPLAY = 200;
const MAX_REPLAY = 500;
const BUFFER_SIZE = 500;
const RETRY_MS = 3000;
const HEARTBEAT_MS = 15_000;
const MAX_BUFFERED_BYTES = 1_048_576;
const WHOLE_NUMBER = /^\d+$/;
const TOOL_ROUTE = /^\/api\/tools\/([^/]+)$/;
const API_ROUTE = /^\/api(?:\/|$)/;
const RESERVED_ROUTE = /^\/(?:mcp|api)/;
const BEARER = /^bearer\s+(\S+)\s*$/i;
const ALLOWED_HOSTS = ['127.0.0.1', 'localhost', '[::1]'].map(
  (name) => `${name}:${String(MOCK_PORT)}`,
);

const MCP_ROUTE = /^\/mcp(?:\/([^/]+))?\/?$/;
const MISSING_API_TOKEN =
  'Authentication required: send the token as "Authorization: Bearer <token>"';
const MISSING_MCP_TOKEN =
  'Authentication required: send the token as "Authorization: Bearer <token>", or in the path ' +
  'as /mcp/<token>';
const TOKEN_IN_URL =
  'Send the token in the "Authorization: Bearer <token>" header only, never in the URL';

const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.json', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.woff2', 'font/woff2'],
  ['.webmanifest', 'application/manifest+json'],
]);

// How long a tool call takes in the mock: long enough for the page to show it running.
const CALL_MS = 150;

if (statSync(join(DIST, INDEX), { throwIfNoEntry: false })?.isFile() !== true) {
  console.error(
    `mock-server: ${join(DIST, INDEX)} is missing; build the dashboard first: ` +
      'pnpm --filter tradingview-desktop-mcp-dashboard build',
  );
  process.exit(1);
}

// The event bus, as packages/server/src/core/events.ts keeps it.

/**
 * @typedef {object} Bus
 * @property {string} bootId
 * @property {number} lastSeq
 * @property {DashboardEvent[]} buffer
 * @property {Set<(event: DashboardEvent) => void>} subscribers
 */

/**
 * @param {UnnumberedEvent[]} events What the bus holds when it starts.
 * @returns {Bus}
 */
function createBus(events) {
  /** @type {Bus} */
  const bus = {
    bootId: randomBytes(4).toString('hex'),
    lastSeq: 0,
    buffer: [],
    subscribers: new Set(),
  };
  for (const event of events) {
    emit(bus, event);
  }
  return bus;
}

/**
 * @param {Bus} bus
 * @param {UnnumberedEvent} event
 * @returns {DashboardEvent}
 */
function emit(bus, event) {
  bus.lastSeq += 1;
  /** @type {DashboardEvent} */
  const numbered = { ...event, seq: bus.lastSeq };
  bus.buffer.push(numbered);
  if (bus.buffer.length > BUFFER_SIZE) {
    bus.buffer.shift();
  }
  for (const subscriber of bus.subscribers) {
    subscriber(numbered);
  }
  return numbered;
}

/**
 * @param {Bus} bus
 * @param {number} limit
 */
function recent(bus, limit) {
  return limit < 1 ? [] : bus.buffer.slice(-limit);
}

/**
 * The events after `seq`, and whether some after it are lost: a seq this bus did not give is one
 * of an earlier bus, so every buffered event is new to its client and the rest is a gap.
 * @param {Bus} bus
 * @param {number} seq
 * @returns {{ events: DashboardEvent[], gap: boolean }}
 */
function after(bus, seq) {
  const known = seq <= bus.lastSeq;
  const from = known ? seq : 0;
  const newer = bus.lastSeq - from;
  const count = Math.min(newer, bus.buffer.length);
  const events = count === 0 ? [] : bus.buffer.slice(-count);
  return { events, gap: !known || events.length < newer };
}

/**
 * @param {Bus} bus
 * @param {number} seq
 */
function streamId(bus, seq) {
  return `${bus.bootId}-${String(seq)}`;
}

// What the tests can change, and set back with /__control/reset.

/**
 * @typedef {object} EventStream
 * @property {ServerResponse} res
 * @property {() => void} unsubscribe
 */

/**
 * @typedef {object} MockState
 * @property {string} token
 * @property {keyof typeof health} health
 * @property {Bus} bus
 * @property {{ name: string, arguments: Record<string, JsonValue> }[]} calls
 */

/** @type {MockState} */
const state = {
  token: MOCK_TOKEN,
  health: 'ready',
  bus: createBus(backlogEvents()),
  calls: [],
};

/** @type {Set<EventStream>} */
const streams = new Set();

/**
 * Ends every open event stream: cleanly, as a server that shuts down, or by breaking the
 * connection, as a network that failed.
 * @param {'end' | 'drop'} how
 */
function closeStreams(how) {
  for (const stream of [...streams]) {
    stream.unsubscribe();
    streams.delete(stream);
    if (how === 'end') {
      stream.res.end();
    } else {
      stream.res.destroy();
    }
  }
}

// The answers and the body reader, as transports/respond.ts and dashboard/body.ts have them.

/**
 * @param {ServerResponse} res
 * @param {number} status
 * @param {JsonValue} body
 * @param {OutgoingHttpHeaders} [headers]
 */
function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(text);
}

/**
 * @param {ServerResponse} res
 * @param {number} status
 * @param {string} error
 * @param {OutgoingHttpHeaders} [headers]
 */
function sendError(res, status, error, headers = {}) {
  /** @type {DashboardError} */
  const body = { error };
  sendJson(res, status, body, headers);
}

/**
 * Reads what is left of a body and drops it, so that a client still sending gets the answer.
 * @param {IncomingMessage} req
 * @returns {Promise<void>}
 */
function discardBody(req) {
  return new Promise((resolve) => {
    if (req.readableEnded || req.destroyed) {
      resolve();
      return;
    }
    req.on('end', () => {
      resolve();
    });
    req.on('close', () => {
      resolve();
    });
    req.resume();
  });
}

class BodyError extends Error {
  /**
   * @param {400 | 413 | 415} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * The JSON body of a request, with the server's refusals.
 * @param {IncomingMessage} req
 * @returns {Promise<JsonValue>}
 */
async function readJsonBody(req) {
  const type = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (type !== 'application/json') {
    await discardBody(req);
    throw new BodyError(415, 'Send the body as JSON, with Content-Type: application/json');
  }
  const tooLarge = `The body is larger than ${String(MAX_BODY_BYTES)} bytes`;
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
    await discardBody(req);
    throw new BodyError(413, tooLarge);
  }
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    if (!(chunk instanceof Buffer)) {
      continue;
    }
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      await discardBody(req);
      throw new BodyError(413, tooLarge);
    }
    chunks.push(chunk);
  }
  try {
    return /** @type {JsonValue} */ (JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch {
    throw new BodyError(400, 'The body is not valid JSON');
  }
}

/**
 * @param {JsonValue | undefined} value
 * @returns {value is Record<string, JsonValue>}
 */
function isJsonObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when the request uses `allowed`; otherwise it is answered with 405.
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {string} allowed
 */
async function allows(req, res, allowed) {
  if (req.method === allowed) {
    return true;
  }
  await discardBody(req);
  sendError(res, 405, 'Method not allowed', { Allow: allowed });
  return false;
}

// The dashboard API, as dashboard/api.ts answers it.

/**
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {string} name
 */
async function callTool(req, res, name) {
  if (!tools.some((tool) => tool.name === name)) {
    await discardBody(req);
    sendError(res, 404, 'This server offers no tool of that name');
    return;
  }
  /** @type {JsonValue} */
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    if (error instanceof BodyError) {
      sendError(res, error.status, error.message);
      return;
    }
    throw error;
  }
  if (!isJsonObject(body)) {
    sendError(res, 400, 'The body must be a JSON object, such as {"arguments": {}}');
    return;
  }
  const args = Object.hasOwn(body, 'arguments') ? body.arguments : {};
  if (!isJsonObject(args)) {
    sendError(res, 400, 'arguments must be a JSON object');
    return;
  }
  state.calls.push({ name, arguments: args });
  const { bus } = state;
  const id = randomUUID();
  emit(bus, {
    id,
    tool: name,
    origin: 'dashboard',
    phase: 'start',
    at: new Date().toISOString(),
    args,
  });
  await new Promise((resolve) => setTimeout(resolve, CALL_MS));
  const result = resultFor(name, args);
  const errorCode = errorCodeOf(result);
  emit(bus, {
    id,
    tool: name,
    origin: 'dashboard',
    phase: 'end',
    at: new Date().toISOString(),
    durationMs: durationOf(result),
    ok: result.isError !== true,
    ...(errorCode === undefined ? {} : { errorCode }),
  });
  sendJson(res, 200, result);
}

/**
 * The `limit` of the query string, or undefined when it is not a whole number from 0 to 500.
 * @param {string} url
 */
function replayLimit(url) {
  const start = url.indexOf('?');
  const value = start === -1 ? null : new URLSearchParams(url.slice(start + 1)).get('limit');
  if (value === null) {
    return DEFAULT_REPLAY;
  }
  if (!WHOLE_NUMBER.test(value)) {
    return undefined;
  }
  const limit = Number(value);
  return limit <= MAX_REPLAY ? limit : undefined;
}

/**
 * What a new stream replays, and whether its client missed some events.
 * @param {Bus} bus
 * @param {string | undefined} lastEventId
 * @param {number} limit
 * @returns {{ events: DashboardEvent[], gap: boolean }}
 */
function replayFor(bus, lastEventId, limit) {
  if (lastEventId === undefined || lastEventId === '') {
    return { events: recent(bus, limit), gap: false };
  }
  const prefix = `${bus.bootId}-`;
  const digits = lastEventId.startsWith(prefix) ? lastEventId.slice(prefix.length) : '';
  const seq = WHOLE_NUMBER.test(digits) ? Number(digits) : undefined;
  if (seq === undefined || !Number.isSafeInteger(seq)) {
    return { events: recent(bus, limit), gap: true };
  }
  return after(bus, seq);
}

/**
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 */
function openEvents(req, res) {
  const limit = replayLimit(req.url ?? '');
  if (limit === undefined) {
    sendError(res, 400, `limit must be a whole number from 0 to ${String(MAX_REPLAY)}`);
    return;
  }
  const header = req.headers['last-event-id'];
  const { bus } = state;
  const replay = replayFor(bus, typeof header === 'string' ? header : undefined, limit);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: ${String(RETRY_MS)}\n\n`);

  /** @param {string} chunk */
  const write = (chunk) => {
    if (res.writableEnded || res.destroyed) {
      return;
    }
    // A client that falls this far behind is dropped, as the server drops it.
    if (res.writableLength > MAX_BUFFERED_BYTES) {
      res.destroy();
      return;
    }
    res.write(chunk);
  };
  /** @param {DashboardEvent} event */
  const send = (event) => {
    write(`id: ${streamId(bus, event.seq)}\nevent: tool\ndata: ${JSON.stringify(event)}\n\n`);
  };

  if (replay.gap) {
    write('event: gap\ndata: {}\n\n');
  }
  for (const event of replay.events) {
    send(event);
  }
  bus.subscribers.add(send);
  const heartbeat = setInterval(() => {
    write(': ping\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref();
  /** @type {EventStream} */
  const stream = {
    res,
    unsubscribe: () => {
      clearInterval(heartbeat);
      bus.subscribers.delete(send);
    },
  };
  streams.add(stream);
  res.once('close', () => {
    stream.unsubscribe();
    streams.delete(stream);
  });
}

/**
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {string} path
 */
async function handleApi(req, res, path) {
  switch (path) {
    case '/api/info':
      if (await allows(req, res, 'GET')) {
        sendJson(res, 200, info);
      }
      return;
    case '/api/health':
      if (await allows(req, res, 'GET')) {
        sendJson(res, 200, health[state.health]);
      }
      return;
    case '/api/tools':
      if (await allows(req, res, 'GET')) {
        sendJson(res, 200, { tools });
      }
      return;
    case '/api/events':
      if (await allows(req, res, 'GET')) {
        openEvents(req, res);
      }
      return;
    default:
      break;
  }
  const name = TOOL_ROUTE.exec(path)?.[1];
  if (name === undefined) {
    await discardBody(req);
    sendError(res, 404, 'Not found');
    return;
  }
  if (await allows(req, res, 'POST')) {
    await callTool(req, res, name);
  }
}

/**
 * Whether a URL carries the token, as it is or percent-encoded, as a path segment or anywhere in
 * the query string.
 * @param {string} url
 * @param {string} token
 */
function urlCarriesToken(url, token) {
  const queryStart = url.indexOf('?');
  const path = queryStart === -1 ? url : url.slice(0, queryStart);
  const query = queryStart === -1 ? '' : url.slice(queryStart + 1);
  /** @param {string} text */
  const decoded = (text) => {
    try {
      return decodeURIComponent(text);
    } catch {
      return text;
    }
  };
  const inPath = [path, decoded(path)].some((text) => `${text}/`.includes(`/${token}/`));
  const inQuery = [query, decoded(query), decoded(query.replaceAll('+', ' '))].some((text) =>
    text.includes(token),
  );
  return inPath || inQuery;
}

/**
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {string} path
 */
async function serveApi(req, res, path) {
  /** @param {string} error */
  const unauthorized = (error) => {
    sendError(res, 401, error, { 'WWW-Authenticate': 'Bearer' });
  };
  if (urlCarriesToken(req.url ?? path, state.token)) {
    unauthorized(TOKEN_IN_URL);
    return;
  }
  const provided = BEARER.exec(req.headers.authorization ?? '')?.[1];
  if (provided === undefined) {
    unauthorized(MISSING_API_TOKEN);
    return;
  }
  if (provided !== state.token) {
    unauthorized('Invalid token');
    return;
  }
  await handleApi(req, res, path);
}

/**
 * /mcp, /mcp/ and /mcp/<token>, refused as the server refuses them without the token. The mock
 * speaks no MCP, so with the token it answers 404.
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {string} path
 */
function serveMcp(req, res, path) {
  const match = MCP_ROUTE.exec(path);
  if (match === null) {
    sendError(res, 404, 'Not found');
    return;
  }
  const segment = match[1];
  /** @type {string | null | undefined} */
  let provided;
  if (segment === undefined) {
    provided = BEARER.exec(req.headers.authorization ?? '')?.[1];
  } else {
    try {
      provided = decodeURIComponent(segment);
    } catch {
      provided = null;
    }
  }
  if (provided === undefined) {
    sendError(res, 401, MISSING_MCP_TOKEN, { 'WWW-Authenticate': 'Bearer' });
  } else if (provided !== state.token) {
    sendError(res, 401, 'Invalid token', { 'WWW-Authenticate': 'Bearer' });
  } else {
    sendError(res, 404, 'Not found');
  }
}

// The dashboard files, as dashboard/static.ts serves them.

/**
 * The file `path` names inside DIST, or undefined for a path that cannot name one.
 * @param {string} path
 */
function fileIn(path) {
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  const segments = decoded.split('/');
  const file = decoded === '/' ? join(DIST, INDEX) : join(DIST, ...segments);
  const inside = relative(DIST, file);
  const refused =
    segments.some((segment) => segment === '..' || /[\0\\]/.test(segment)) ||
    inside === '..' ||
    inside.startsWith(`..${sep}`) ||
    isAbsolute(inside);
  return refused ? undefined : file;
}

/**
 * @param {string} file
 * @returns {Promise<Buffer | undefined>}
 */
async function readRegularFile(file) {
  try {
    return (await stat(file)).isFile() ? await readFile(file) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Answers a GET or a HEAD from the dashboard files; false for any other method.
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {string} path
 */
async function serveDashboard(req, res, path) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return false;
  }
  const file = fileIn(path);
  const pageLoad =
    file !== undefined &&
    extname(file) === '' &&
    (req.headers.accept ?? '').toLowerCase().includes('text/html');
  const candidates = file === undefined ? [] : [file, ...(pageLoad ? [join(DIST, INDEX)] : [])];
  for (const candidate of candidates) {
    const content = await readRegularFile(candidate);
    if (content !== undefined) {
      const immutable = relative(DIST, candidate).startsWith(`assets${sep}`);
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type':
          CONTENT_TYPES.get(extname(candidate).toLowerCase()) ?? 'application/octet-stream',
        'Content-Length': content.length,
        'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : content);
      return true;
    }
  }
  sendError(res, 404, 'Not found', SECURITY_HEADERS);
  return true;
}

// The tests' own routes.

/**
 * @param {JsonValue} value
 * @returns {UnnumberedEvent}
 */
function scriptedEvent(value) {
  if (!isJsonObject(value)) {
    throw new BodyError(400, 'An event must be a JSON object');
  }
  const { id, tool, origin, phase, at } = value;
  if (
    typeof id !== 'string' ||
    typeof tool !== 'string' ||
    (origin !== 'mcp' && origin !== 'batch' && origin !== 'dashboard') ||
    (phase !== 'start' && phase !== 'end')
  ) {
    throw new BodyError(400, 'An event needs id, tool, origin and phase');
  }
  /** @type {UnnumberedEvent} */
  const event = {
    id,
    tool,
    origin,
    phase,
    at: typeof at === 'string' ? at : new Date().toISOString(),
  };
  if (typeof value.durationMs === 'number') {
    event.durationMs = value.durationMs;
  }
  if (typeof value.ok === 'boolean') {
    event.ok = value.ok;
  }
  const errorCode = asErrorCode(value.errorCode);
  if (errorCode !== undefined) {
    event.errorCode = errorCode;
  }
  if (value.args !== undefined) {
    event.args = value.args;
  }
  return event;
}

/**
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {string} path
 */
async function control(req, res, path) {
  if (path === '/__control/calls') {
    if (await allows(req, res, 'GET')) {
      sendJson(res, 200, { calls: state.calls });
    }
    return;
  }
  if (!(await allows(req, res, 'POST'))) {
    return;
  }
  const body = await readJsonBody(req);
  const fields = isJsonObject(body) ? body : {};
  switch (path) {
    case '/__control/reset':
      closeStreams('end');
      state.token = MOCK_TOKEN;
      state.health = 'ready';
      state.calls = [];
      state.bus = createBus(backlogEvents());
      break;
    case '/__control/emit': {
      const { events } = fields;
      if (!Array.isArray(events)) {
        throw new BodyError(400, 'events must be a list');
      }
      const scripted = events.map(scriptedEvent);
      sendJson(res, 200, { events: scripted.map((event) => emit(state.bus, event)) });
      return;
    }
    case '/__control/health': {
      const wanted = fields.state;
      if (wanted !== 'ready' && wanted !== 'background' && wanted !== 'unreachable') {
        throw new BodyError(400, 'state must be ready, background or unreachable');
      }
      state.health = wanted;
      break;
    }
    case '/__control/token':
      if (typeof fields.token !== 'string' || fields.token === '') {
        throw new BodyError(400, 'token must be a string');
      }
      state.token = fields.token;
      break;
    case '/__control/drop':
      closeStreams('drop');
      break;
    case '/__control/restart':
      closeStreams('drop');
      state.bus = createBus([]);
      break;
    default:
      sendError(res, 404, 'Not found');
      return;
  }
  sendJson(res, 200, { ok: true });
}

// The router: Host, Origin, /healthz, the tests' controls, the files, the API, /mcp, as the server
// orders them.

/**
 * @param {string | undefined} host
 */
function isAllowedHost(host) {
  return host !== undefined && ALLOWED_HOSTS.includes(host.toLowerCase());
}

/**
 * @param {string | undefined} origin
 */
function isAllowedOrigin(origin) {
  if (origin === undefined) {
    return true;
  }
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && isAllowedHost(url.host);
  } catch {
    return false;
  }
}

/**
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {string} path
 */
async function route(req, res, path) {
  const { host, origin } = req.headers;
  if (!isAllowedHost(host)) {
    sendError(res, 403, `The Host header ${JSON.stringify(host ?? '')} does not name this server`);
    return;
  }
  if (!isAllowedOrigin(origin)) {
    sendError(res, 403, `Requests from the Origin ${String(origin)} are not allowed`);
    return;
  }
  if (path === '/healthz') {
    if (req.method === 'GET' || req.method === 'HEAD') {
      sendJson(res, 200, { ok: true });
    } else {
      sendError(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    }
    return;
  }
  if (path.startsWith('/__control/')) {
    await control(req, res, path);
    return;
  }
  if (!RESERVED_ROUTE.test(path) && (await serveDashboard(req, res, path))) {
    return;
  }
  if (API_ROUTE.test(path)) {
    await serveApi(req, res, path);
    return;
  }
  serveMcp(req, res, path);
}

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?', 1)[0] ?? '/';
  route(req, res, path).catch((/** @type {unknown} */ error) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error instanceof BodyError) {
      sendError(res, error.status, error.message);
      return;
    }
    console.error('mock-server: a request failed', error);
    sendError(res, 500, 'Internal server error');
  });
});

server.on('error', (error) => {
  console.error(
    `mock-server: cannot listen on ${MOCK_HOST}:${String(MOCK_PORT)}: ${error.message}`,
  );
  process.exit(1);
});

server.listen(MOCK_PORT, MOCK_HOST, () => {
  console.log(`mock-server: listening on http://${MOCK_HOST}:${String(MOCK_PORT)}`);
});

for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
  process.on(signal, () => {
    closeStreams('end');
    server.close();
    server.closeAllConnections();
    process.exit(0);
  });
}
