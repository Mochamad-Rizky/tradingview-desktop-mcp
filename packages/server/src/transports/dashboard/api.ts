import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from '../../config/schema.js';
import type { ConnectionManager } from '../../core/connection.js';
import type { ToolCallEvent, ToolEventBus } from '../../core/events.js';
import type { Logger } from '../../core/logger.js';
import { toolInputJsonSchema, toolProfiles } from '../../tools/schema-export.js';
import type { AnyToolDefinition, ToolRegistry } from '../../tools/types.js';
import type { JsonObject, JsonValue } from '../../utils/json.js';
import { PACKAGE_NAME } from '../../version.js';
import { sendJson } from '../respond.js';
import { BodyError, discardBody, readJsonBody } from './body.js';
import type {
  DashboardCallResult,
  DashboardError,
  DashboardHealth,
  DashboardInfo,
  DashboardTool,
  DashboardToolList,
} from './contract.js';
import { SseStream } from './sse.js';

// The routes under /api that the dashboard calls, with the JSON of contract.ts. The transport checks
// the Host, the Origin and the token before a request gets here.

export interface DashboardApiDeps {
  config: Readonly<Config>;
  // The registry the dashboard calls tools in: one per process, with a session state of its own.
  registry: ToolRegistry;
  // The bus of the process, which every registry reports its calls to.
  events: ToolEventBus;
  connection: Pick<ConnectionManager, 'health'>;
  version: string;
  startedAt: Date;
  // Where MCP clients connect over HTTP, without the token; null when MCP runs over stdio.
  mcpEndpoint: string | null;
  logger: Logger;
}

export interface DashboardApi {
  // Answers one request whose path starts with /api.
  handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<void>;
  // Ends every open event stream after what it sent, for a server that shuts down: its clients see
  // the stream end rather than the connection break. A stream asked for after it is refused.
  close(): void;
}

// What a new stream replays when its client names no limit, and the most it may name: all the bus
// keeps.
const DEFAULT_REPLAY = 200;
const MAX_REPLAY = 500;
const WHOLE_NUMBER = /^\d+$/;
// A tool name is one segment, matched as sent: the names of tools need no escapes.
const TOOL_ROUTE = /^\/api\/tools\/([^/]+)$/;

function sendError(
  res: ServerResponse,
  status: number,
  error: string,
  headers: OutgoingHttpHeaders = {},
): void {
  const body: DashboardError = { error };
  sendJson(res, status, body, headers);
}

// An error answer to a request whose body is not read: the body is dropped first, so that a client
// still sending it gets the answer (discardBody).
async function refuse(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  error: string,
  headers: OutgoingHttpHeaders = {},
): Promise<void> {
  await discardBody(req);
  sendError(res, status, error, headers);
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// `value` as JSON, the way JSON.stringify writes it, but without toJSON: undefined for what JSON
// has no form for (left out of an object, null in a list), null for a number that is not finite.
// Only plain objects and arrays are walked: a Date or a Map is no JSON value. `ancestors` are the
// objects `value` is inside of, so a cycle is cut where it would begin again.
function toJson(value: unknown, ancestors: readonly object[]): JsonValue | undefined {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'object':
      break;
    default:
      return undefined;
  }
  if (value === null) {
    return null;
  }
  if (ancestors.includes(value)) {
    return undefined;
  }
  const inside = [...ancestors, value];
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return items.map((item) => toJson(item, inside) ?? null);
  }
  return isPlainObject(value) ? jsonObject(value, inside) : undefined;
}

function jsonObject(value: Record<string, unknown>, ancestors: readonly object[]): JsonObject {
  const entries: [string, JsonValue][] = [];
  for (const [key, item] of Object.entries(value)) {
    const json = toJson(item, ancestors);
    if (json !== undefined) {
      entries.push([key, json]);
    }
  }
  // fromEntries defines every key as a property of its own, so a key named __proto__ stays a key.
  return Object.fromEntries(entries);
}

// A tool result as the dashboard takes it. The SDK types structuredContent as unknown values,
// though the registry builds it from JSON, so it is copied as JSON. The registry makes text and
// image blocks only; any other kind would be one the dashboard cannot show, and is left out.
export function toDashboardCallResult(result: CallToolResult): DashboardCallResult {
  const content: DashboardCallResult['content'] = [];
  for (const block of result.content) {
    if (block.type === 'text') {
      content.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      content.push({ type: 'image', data: block.data, mimeType: block.mimeType });
    }
  }
  const mapped: DashboardCallResult = { content };
  const { structuredContent, isError } = result;
  if (structuredContent !== undefined) {
    mapped.structuredContent = jsonObject(structuredContent, [structuredContent]);
  }
  if (isError !== undefined) {
    mapped.isError = isError;
  }
  return mapped;
}

function dashboardTool(tool: AnyToolDefinition): DashboardTool {
  const {
    readOnlyHint = false,
    destructiveHint,
    idempotentHint = false,
    openWorldHint = false,
  } = tool.annotations;
  return {
    name: tool.name,
    domain: tool.domain,
    title: tool.title,
    description: tool.description,
    annotations: {
      readOnlyHint,
      // MCP reads a missing destructiveHint as true, which means nothing for a tool that only reads.
      destructiveHint: destructiveHint ?? !readOnlyHint,
      idempotentHint,
      // The server registers every tool as one that reaches nothing beyond the local app unless the
      // tool says otherwise (registerToolsWithServer).
      openWorldHint,
    },
    core: tool.core === true,
    profiles: toolProfiles(tool),
    inputSchema: toolInputJsonSchema(tool),
  };
}

// The `limit` of the query string: how many recent events a new stream replays. undefined when it
// is not a whole number from 0 to MAX_REPLAY.
function replayLimit(url: string): number | undefined {
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

// The id of a stream event: the boot id of the bus, a dash and the seq.
function streamId(bootId: string, seq: number): string {
  return `${bootId}-${String(seq)}`;
}

// The seq in a stream id that this bus gave, or undefined for an id of another process or of none.
function seqOf(lastEventId: string, bootId: string): number | undefined {
  const prefix = `${bootId}-`;
  if (!lastEventId.startsWith(prefix)) {
    return undefined;
  }
  const digits = lastEventId.slice(prefix.length);
  if (!WHOLE_NUMBER.test(digits)) {
    return undefined;
  }
  const seq = Number(digits);
  return Number.isSafeInteger(seq) ? seq : undefined;
}

// What a new stream sends before the live events, and whether its client missed some.
function replayFor(
  events: ToolEventBus,
  lastEventId: string | undefined,
  limit: number,
): { events: ToolCallEvent[]; gap: boolean } {
  // A first connection: a browser sends no Last-Event-ID before it has an id.
  if (lastEventId === undefined || lastEventId === '') {
    return { events: events.recent(limit), gap: false };
  }
  const seq = seqOf(lastEventId, events.bootId);
  // The id of an earlier process, a server that restarted, or one no server gave: the seqs the
  // client knows are another bus's, so it gets the recent events of this one and learns that it
  // missed whatever came between.
  if (seq === undefined) {
    return { events: events.recent(limit), gap: true };
  }
  // A client that resumes misses nothing the bus still holds, whatever limit it asked for at first.
  return events.after(seq);
}

export function createDashboardApi(deps: DashboardApiDeps): DashboardApi {
  const { config, registry, events, connection, version, startedAt, mcpEndpoint, logger } = deps;
  // The event streams that are open, so that close() can end them.
  const streams = new Set<SseStream>();
  // Set by close(). A stream opened after it would be cut when the server drops its connections.
  let closed = false;

  const info = (): DashboardInfo => ({
    name: PACKAGE_NAME,
    version,
    transport: config.transport,
    profile: config.profile,
    toolPatterns: [...config.toolPatterns],
    allowEval: config.allowEval,
    toolCount: registry.list().length,
    mcpEndpoint,
    startedAt: startedAt.toISOString(),
  });

  // Never an error: a problem is part of the report, which comes within the call timeout.
  const health = (): Promise<DashboardHealth> => connection.health();

  const toolList = (): DashboardToolList => ({ tools: registry.list().map(dashboardTool) });

  const callTool = async (req: IncomingMessage, res: ServerResponse, name: string) => {
    // A name this registry does not offer is no call at all, so it reaches neither the registry
    // nor the events.
    if (!registry.list().some((tool) => tool.name === name)) {
      await refuse(req, res, 404, 'This server offers no tool of that name');
      return;
    }
    let body: JsonValue;
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
    // A failed call is a result like any other, as an MCP client gets it: 200 with isError.
    const result = await registry.call(name, args, 'dashboard');
    sendJson(res, 200, toDashboardCallResult(result));
  };

  const openEvents = (req: IncomingMessage, res: ServerResponse): void => {
    if (closed) {
      sendError(res, 503, 'The server is shutting down');
      return;
    }
    const limit = replayLimit(req.url ?? '');
    if (limit === undefined) {
      sendError(res, 400, `limit must be a whole number from 0 to ${String(MAX_REPLAY)}`);
      return;
    }
    const header = req.headers['last-event-id'];
    const replay = replayFor(events, typeof header === 'string' ? header : undefined, limit);
    const stream = new SseStream(res);
    streams.add(stream);
    // From the replay to the subscription nothing waits, so no event can fall between them. A
    // stream that closes on the way (its client left, or fell behind) stops the replay, and its
    // close listener takes the subscription back at once.
    if (replay.gap) {
      stream.send('gap', {});
    }
    for (const event of replay.events) {
      if (!stream.send('tool', event, streamId(events.bootId, event.seq))) {
        break;
      }
    }
    const unsubscribe = events.subscribe((event) => {
      stream.send('tool', event, streamId(events.bootId, event.seq));
    });
    stream.onClose(() => {
      unsubscribe();
      streams.delete(stream);
      logger.debug('A dashboard event stream closed');
    });
    logger.debug(
      { replayed: replay.events.length, gap: replay.gap },
      'A dashboard event stream opened',
    );
  };

  // True when the request uses `allowed`; otherwise it is answered with 405.
  const allows = async (
    req: IncomingMessage,
    res: ServerResponse,
    allowed: string,
  ): Promise<boolean> => {
    if (req.method === allowed) {
      return true;
    }
    await refuse(req, res, 405, 'Method not allowed', { Allow: allowed });
    return false;
  };

  return {
    async handle(req, res, path) {
      switch (path) {
        case '/api/info':
          if (await allows(req, res, 'GET')) {
            sendJson(res, 200, info());
          }
          return;
        case '/api/health':
          if (await allows(req, res, 'GET')) {
            sendJson(res, 200, await health());
          }
          return;
        case '/api/tools':
          if (await allows(req, res, 'GET')) {
            sendJson(res, 200, toolList());
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
        await refuse(req, res, 404, 'Not found');
        return;
      }
      if (await allows(req, res, 'POST')) {
        await callTool(req, res, name);
      }
    },
    close() {
      closed = true;
      for (const stream of [...streams]) {
        stream.close();
      }
    },
  };
}
