import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { HealthReport } from '../../../../src/core/connection.js';
import type { ToolCallEvent } from '../../../../src/core/events.js';
import { READ_ONLY } from '../../../../src/tools/annotations.js';
import { createToolRegistry } from '../../../../src/tools/registry.js';
import { toolInputJsonSchema } from '../../../../src/tools/schema-export.js';
import { defineTool } from '../../../../src/tools/types.js';
import {
  createDashboardApi,
  toDashboardCallResult,
  type DashboardApi,
  type DashboardApiDeps,
} from '../../../../src/transports/dashboard/api.js';
import type {
  DashboardCallResult,
  DashboardInfo,
  DashboardToolList,
} from '../../../../src/transports/dashboard/contract.js';
import {
  CountingBus,
  openEventStream,
  send,
  type EventStreamClient,
} from '../../../helpers/dashboard-client.js';
import { createTestContext, quietLogger, testConfig } from '../../../helpers/tool-context.js';

const STARTED_AT = new Date('2026-10-23T08:00:00.000Z');
const JSON_TYPE = { 'Content-Type': 'application/json' };
const REPORT: HealthReport = {
  cdp: { reachable: true, endpoint: 'http://127.0.0.1:9222', browser: 'Chrome/146.0.7680.216' },
  chart: { found: true, tabs: 1, url: 'https://www.tradingview.com/chart/FIXTURE1/' },
  app: { ready: true, connected: true, buildTime: '2026-10-16T17:55:37' },
};
const PIXEL = 'iVBORw0KGgo=';

// A tool that states no hint at all.
const echo = defineTool({
  name: 'chart_echo',
  domain: 'chart',
  title: 'Echo',
  description: 'Returns the text it was given.',
  inputSchema: { text: z.string().optional().describe('Any text.') },
  annotations: {},
  handler: (input) => Promise.resolve({ data: { received: input.text ?? null } }),
});

// A tool that says it only reads, and nothing else.
const peek = defineTool({
  name: 'chart_peek',
  domain: 'chart',
  title: 'Peek',
  description: 'Reads nothing at all.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
  handler: () => Promise.resolve({ data: null }),
});

// A core tool that only reads and shows an image.
const snapshot = defineTool({
  name: 'screenshot_fake',
  domain: 'screenshot',
  title: 'Fake screenshot',
  description: 'Shows one pixel.',
  inputSchema: {},
  annotations: READ_ONLY,
  core: true,
  handler: () =>
    Promise.resolve({
      data: { taken: true },
      images: [{ type: 'image' as const, data: PIXEL, mimeType: 'image/png' }],
    }),
});

const cleanups: (() => Promise<void> | void)[] = [];
// What api.handle rejected with: nothing, in every test.
const failures: unknown[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  expect(failures.splice(0)).toEqual([]);
});

interface Served {
  port: number;
  api: DashboardApi;
  events: CountingBus;
}

// The API alone behind a plain listener, without the checks of the transport in front of it.
async function serve(overrides: Partial<DashboardApiDeps> = {}): Promise<Served> {
  const events = new CountingBus();
  const registry = createToolRegistry([echo, peek, snapshot], createTestContext({ events }));
  const api = createDashboardApi({
    config: testConfig(),
    registry,
    events,
    connection: { health: () => Promise.resolve(REPORT) },
    version: '9.9.9',
    startedAt: STARTED_AT,
    mcpEndpoint: null,
    logger: quietLogger,
    ...overrides,
  });
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?', 1)[0] ?? '/';
    api.handle(req, res, path).catch((error: unknown) => {
      failures.push(error);
      res.destroy();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        api.close();
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  );
  return { port: (server.address() as AddressInfo).port, api, events };
}

function emitCalls(events: CountingBus, count: number): void {
  for (let n = 1; n <= count; n++) {
    events.emit({
      id: `call-${String(n)}`,
      tool: 'chart_echo',
      origin: 'mcp',
      phase: 'start',
      at: '2026-10-23T08:00:00.000Z',
    });
  }
}

async function stream(
  port: number,
  { path = '/api/events', lastEventId }: { path?: string; lastEventId?: string } = {},
): Promise<EventStreamClient> {
  const client = await openEventStream(port, {
    path,
    headers: lastEventId === undefined ? {} : { 'Last-Event-ID': lastEventId },
  });
  cleanups.push(() => {
    client.close();
  });
  return client;
}

// What a stream said in its first `count` events: `gap`, or the seq of a tool event and its id.
async function firstEvents(client: EventStreamClient, count: number): Promise<string[]> {
  await expect.poll(() => client.events().length).toBeGreaterThanOrEqual(count);
  return client
    .events()
    .slice(0, count)
    .map(({ event, id, data }) =>
      event === 'tool' ? `${String((data as ToolCallEvent).seq)} ${String(id)}` : event,
    );
}

function ids(bootId: string, ...seqs: number[]): string[] {
  return seqs.map((seq) => `${String(seq)} ${bootId}-${String(seq)}`);
}

test.each([
  '/api',
  '/api/',
  '/api/nope',
  '/api/Info',
  '/api/info/',
  '/api/tools/',
  '/api/events/live',
])('GET %s is 404', async (path) => {
  const { port } = await serve();

  const response = await send(port, { path });

  expect(response.status).toBe(404);
  expect(JSON.parse(response.body)).toEqual({ error: 'Not found' });
  expect(response.headers['cache-control']).toBe('no-store');
});

test.each(['/api/tools/chart_unknown', '/api/tools/chart%5Fecho', '/api/tools/chart_echo/x'])(
  'POST %s is 404, and no call is made',
  async (path) => {
    const { port, events } = await serve();

    const response = await send(port, { method: 'POST', path, headers: JSON_TYPE, body: '{}' });

    expect(response.status).toBe(404);
    expect(events.recent()).toEqual([]);
  },
);

test.each([
  ['POST', '/api/info', 'GET'],
  ['DELETE', '/api/health', 'GET'],
  ['PUT', '/api/tools', 'GET'],
  ['GET', '/api/tools/chart_echo', 'POST'],
  ['GET', '/api/tools/chart_unknown', 'POST'],
  ['POST', '/api/events', 'GET'],
  ['OPTIONS', '/api/events', 'GET'],
])('%s %s is 405 and allows %s', async (method, path, allowed) => {
  const { port, events } = await serve();

  const response = await send(port, { method, path });

  expect(response.status).toBe(405);
  expect(response.headers.allow).toBe(allowed);
  expect(JSON.parse(response.body)).toEqual({ error: 'Method not allowed' });
  expect(events.recent()).toEqual([]);
});

test('/api/info reports the settings, the tool count and no MCP endpoint next to stdio', async () => {
  const config = testConfig({
    transport: 'stdio',
    profile: 'readonly',
    toolPatterns: ['chart_*'],
    allowEval: true,
  });
  const { port } = await serve({ config });

  const response = await send(port, { path: '/api/info' });

  expect(response.status).toBe(200);
  expect(response.headers['content-type']).toBe('application/json');
  expect(response.headers['cache-control']).toBe('no-store');
  expect(JSON.parse(response.body) as DashboardInfo).toStrictEqual({
    name: 'tradingview-desktop-mcp',
    version: '9.9.9',
    transport: 'stdio',
    profile: 'readonly',
    toolPatterns: ['chart_*'],
    allowEval: true,
    toolCount: 3,
    mcpEndpoint: null,
    startedAt: '2026-10-23T08:00:00.000Z',
  });
});

test('/api/health answers with the report of the connection', async () => {
  const { port } = await serve();

  const response = await send(port, { path: '/api/health' });

  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(JSON.parse(response.body)).toStrictEqual(REPORT);
});

// MCP reads a missing destructiveHint as true and a missing idempotentHint as false; the server
// registers every tool with openWorldHint false unless it says otherwise.
test('/api/tools states every hint, reading a missing one as the server registers it', async () => {
  const { port } = await serve();

  const response = await send(port, { path: '/api/tools' });

  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(JSON.parse(response.body) as DashboardToolList).toStrictEqual({
    tools: [
      {
        name: 'chart_echo',
        domain: 'chart',
        title: 'Echo',
        description: 'Returns the text it was given.',
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
        core: false,
        profiles: ['full'],
        inputSchema: toolInputJsonSchema(echo),
      },
      {
        name: 'chart_peek',
        domain: 'chart',
        title: 'Peek',
        description: 'Reads nothing at all.',
        // A tool that only reads destroys nothing, whatever MCP assumes of a missing hint.
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        core: false,
        profiles: ['full', 'readonly'],
        inputSchema: toolInputJsonSchema(peek),
      },
      {
        name: 'screenshot_fake',
        domain: 'screenshot',
        title: 'Fake screenshot',
        description: 'Shows one pixel.',
        annotations: READ_ONLY,
        core: true,
        profiles: ['full', 'core', 'readonly'],
        inputSchema: toolInputJsonSchema(snapshot),
      },
    ],
  });
});

test('POST /api/tools/<name> without arguments calls the tool with none', async () => {
  const { port, events } = await serve();

  const response = await send(port, {
    method: 'POST',
    path: '/api/tools/chart_echo',
    headers: JSON_TYPE,
    body: '{}',
  });

  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  const result = JSON.parse(response.body) as DashboardCallResult;
  expect(result.structuredContent).toMatchObject({ ok: true, data: { received: null } });
  expect(events.recent().map(({ origin, phase, args }) => ({ origin, phase, args }))).toEqual([
    { origin: 'dashboard', phase: 'start', args: {} },
    { origin: 'dashboard', phase: 'end', args: undefined },
  ]);
});

test('POST /api/tools/<name> passes the arguments on and ignores the other fields', async () => {
  const { port } = await serve();

  const response = await send(port, {
    method: 'POST',
    path: '/api/tools/chart_echo',
    headers: JSON_TYPE,
    body: JSON.stringify({ arguments: { text: 'synthetic' }, note: 'ignored' }),
  });

  expect(response.status).toBe(200);
  expect(JSON.parse(response.body)).toMatchObject({
    structuredContent: { ok: true, data: { received: 'synthetic' } },
  });
});

test('POST /api/tools/<name> answers with the images in front of the text', async () => {
  const { port } = await serve();

  const response = await send(port, {
    method: 'POST',
    path: '/api/tools/screenshot_fake',
    headers: JSON_TYPE,
    body: '{"arguments":{}}',
  });

  const result = JSON.parse(response.body) as DashboardCallResult;
  expect(result.content).toEqual([
    { type: 'image', data: PIXEL, mimeType: 'image/png' },
    { type: 'text', text: JSON.stringify(result.structuredContent) },
  ]);
});

// Arguments the tool's schema refuses are the tool's to judge, as for any client.
test('arguments the tool refuses come back as a 200 result with INVALID_INPUT', async () => {
  const { port } = await serve();

  const response = await send(port, {
    method: 'POST',
    path: '/api/tools/chart_echo',
    headers: JSON_TYPE,
    body: '{"arguments":{"text":5}}',
  });

  expect(response.status).toBe(200);
  expect(JSON.parse(response.body)).toMatchObject({
    isError: true,
    structuredContent: { ok: false, error: { code: 'INVALID_INPUT' } },
  });
});

test.each([
  ['[]', 'The body must be a JSON object'],
  ['null', 'The body must be a JSON object'],
  ['"text"', 'The body must be a JSON object'],
  ['1', 'The body must be a JSON object'],
  ['{"arguments":[]}', 'arguments must be a JSON object'],
  ['{"arguments":null}', 'arguments must be a JSON object'],
  ['{"arguments":"text"}', 'arguments must be a JSON object'],
  ['{"arguments":1}', 'arguments must be a JSON object'],
])('POST the body %s is 400, and no call is made', async (body, message) => {
  const { port, events } = await serve();

  const response = await send(port, {
    method: 'POST',
    path: '/api/tools/chart_echo',
    headers: JSON_TYPE,
    body,
  });

  expect(response.status).toBe(400);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(JSON.parse(response.body)).toEqual({ error: expect.stringContaining(message) as string });
  expect(events.recent()).toEqual([]);
});

test('a body the API cannot read keeps the status of its error, and no call is made', async () => {
  const { port, events } = await serve();
  const post = (headers: Record<string, string>, body: string) =>
    send(port, { method: 'POST', path: '/api/tools/chart_echo', headers, body });

  const notJson = await post({ 'Content-Type': 'text/plain' }, '{}');
  const invalid = await post(JSON_TYPE, '{"arguments":');
  const large = await post(
    JSON_TYPE,
    JSON.stringify({ arguments: { text: 'x'.repeat(1_100_000) } }),
  );

  expect([notJson.status, invalid.status, large.status]).toEqual([415, 400, 413]);
  for (const response of [notJson, invalid, large]) {
    expect(JSON.parse(response.body)).toEqual({ error: expect.any(String) as string });
  }
  expect(events.recent()).toEqual([]);
});

test('toDashboardCallResult keeps the text and image blocks and drops every other kind', () => {
  const result: CallToolResult = {
    content: [
      {
        type: 'image',
        data: PIXEL,
        mimeType: 'image/png',
        annotations: { priority: 1 },
        _meta: { note: 'dropped' },
      },
      { type: 'audio', data: 'UklGRg==', mimeType: 'audio/wav' },
      { type: 'resource_link', uri: 'file:///synthetic/link', name: 'link' },
      { type: 'resource', resource: { uri: 'file:///synthetic/embedded', text: 'embedded' } },
      { type: 'text', text: '{"ok":true}', annotations: { audience: ['user'] } },
    ],
  };

  expect(toDashboardCallResult(result)).toStrictEqual({
    content: [
      { type: 'image', data: PIXEL, mimeType: 'image/png' },
      { type: 'text', text: '{"ok":true}' },
    ],
  });
});

// The registry builds structuredContent from JSON values, but the SDK types it as unknown values:
// the mapper keeps what JSON can carry and leaves the rest out, as JSON.stringify would.
test('toDashboardCallResult keeps only the JSON values of structuredContent', () => {
  const loop: Record<string, unknown> = { name: 'loop' };
  loop.self = loop;
  const shared = { kept: 'twice' };
  const result: CallToolResult = {
    content: [],
    isError: true,
    structuredContent: {
      ok: false,
      text: 'synthetic',
      count: 2,
      none: null,
      nested: { deep: [1, 'two', null, { three: 3 }] },
      notFinite: Number.NaN,
      numbers: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.5],
      missing: undefined,
      fn: () => 1,
      symbol: Symbol('dropped'),
      big: 1n,
      date: new Date(0),
      map: new Map([['a', 1]]),
      list: [undefined, () => 1, Symbol('gone'), 1n, new Date(0), loop],
      loop,
      first: shared,
      second: shared,
      bare: Object.assign(Object.create(null) as object, { plain: true }),
    },
  };

  expect(toDashboardCallResult(result)).toStrictEqual({
    content: [],
    structuredContent: {
      ok: false,
      text: 'synthetic',
      count: 2,
      none: null,
      nested: { deep: [1, 'two', null, { three: 3 }] },
      notFinite: null,
      numbers: [null, null, null, -0.5],
      list: [null, null, null, null, null, { name: 'loop' }],
      loop: { name: 'loop' },
      first: { kept: 'twice' },
      second: { kept: 'twice' },
      bare: { plain: true },
    },
    isError: true,
  });
});

test('toDashboardCallResult keeps a key named __proto__ as a key, not as the prototype', () => {
  const structuredContent = JSON.parse('{"__proto__":{"polluted":true}}') as Record<
    string,
    unknown
  >;

  const mapped = toDashboardCallResult({ content: [], structuredContent }).structuredContent;

  expect(Object.getPrototypeOf(mapped)).toBe(Object.prototype);
  expect(Object.hasOwn(mapped ?? {}, '__proto__')).toBe(true);
  expect(JSON.stringify(mapped)).toBe('{"__proto__":{"polluted":true}}');
});

test('GET /api/events without Last-Event-ID replays the recent events without a gap', async () => {
  const { port, events } = await serve();
  emitCalls(events, 3);

  const client = await stream(port);

  expect(client.status).toBe(200);
  expect(client.headers['content-type']).toBe('text/event-stream; charset=utf-8');
  expect(await firstEvents(client, 3)).toEqual(ids(events.bootId, 1, 2, 3));
});

test('GET /api/events with an id of this boot replays only the events after it', async () => {
  const { port, events } = await serve();
  emitCalls(events, 3);

  const resumed = await stream(port, { lastEventId: `${events.bootId}-1` });
  const fromNone = await stream(port, { lastEventId: `${events.bootId}-0` });
  const upToDate = await stream(port, { lastEventId: `${events.bootId}-3` });
  emitCalls(events, 1);

  expect(await firstEvents(resumed, 3)).toEqual(ids(events.bootId, 2, 3, 4));
  expect(await firstEvents(fromNone, 4)).toEqual(ids(events.bootId, 1, 2, 3, 4));
  expect(await firstEvents(upToDate, 1)).toEqual(ids(events.bootId, 4));
});

// The client of a server that restarted holds an id of the earlier process: every seq it knows
// belongs to another bus, so it gets the recent events of this one and is told it missed some.
test('GET /api/events with an id of another boot announces a gap, then replays the recent events', async () => {
  const { port, events } = await serve();
  emitCalls(events, 3);
  const otherBoot = events.bootId === '0badcafe' ? 'deadbeef' : '0badcafe';

  const client = await stream(port, { lastEventId: `${otherBoot}-2` });

  expect(await firstEvents(client, 4)).toEqual(['gap', ...ids(events.bootId, 1, 2, 3)]);
  expect(client.events()[0]).toEqual({ event: 'gap', id: `${events.bootId}-3`, data: {} });
});

// The id the client had means nothing to this bus, so the gap gives it one: the newest seq of this
// bus, or 0 before its first event. A client whose replay is empty resumes from that id, and hears
// of no gap again.
test('GET /api/events gives a gap the id of the newest event of this bus, or of none', async () => {
  const { port, events } = await serve();
  const otherBoot = events.bootId === '0badcafe' ? 'deadbeef' : '0badcafe';

  const restarted = await stream(port, { lastEventId: `${otherBoot}-7` });
  expect(await firstEvents(restarted, 1)).toEqual(['gap']);
  expect(restarted.events()[0]).toEqual({ event: 'gap', id: `${events.bootId}-0`, data: {} });

  emitCalls(events, 2);
  const withoutReplay = await stream(port, {
    path: '/api/events?limit=0',
    lastEventId: `${otherBoot}-7`,
  });
  const resumed = await stream(port, { lastEventId: `${events.bootId}-0` });
  emitCalls(events, 1);

  expect(await firstEvents(withoutReplay, 2)).toEqual(['gap', ...ids(events.bootId, 3)]);
  expect(withoutReplay.events()[0]).toEqual({ event: 'gap', id: `${events.bootId}-2`, data: {} });
  expect(await firstEvents(resumed, 3)).toEqual(ids(events.bootId, 1, 2, 3));
});

test.each([
  ['a bare seq', () => '2'],
  ['text', () => 'garbage'],
  ['no seq', (boot: string) => `${boot}-`],
  ['a seq that is no number', (boot: string) => `${boot}-x`],
  ['a fraction', (boot: string) => `${boot}-1.5`],
  ['a negative seq', (boot: string) => `${boot}--1`],
  ['an exponent', (boot: string) => `${boot}-1e1`],
  ['a seq too large to be exact', (boot: string) => `${boot}-99999999999999999999`],
  ['the boot id after the seq', (boot: string) => `1-${boot}`],
  ['two ids', (boot: string) => `${boot}-1, ${boot}-2`],
])(
  'GET /api/events with an unparsable Last-Event-ID (%s) announces a gap and replays the recent events',
  async (_case, lastEventId) => {
    const { port, events } = await serve();
    emitCalls(events, 2);

    const client = await stream(port, { lastEventId: lastEventId(events.bootId) });

    expect(await firstEvents(client, 3)).toEqual(['gap', ...ids(events.bootId, 1, 2)]);
  },
);

// This bus never gave the seq, so what came before it is unknown.
test('GET /api/events with an id of this boot beyond its last event announces a gap', async () => {
  const { port, events } = await serve();
  emitCalls(events, 2);

  const client = await stream(port, { lastEventId: `${events.bootId}-9` });

  expect(await firstEvents(client, 3)).toEqual(['gap', ...ids(events.bootId, 1, 2)]);
});

// A browser sends no Last-Event-ID before it has an id; a client that sends an empty one has none.
test('GET /api/events with an empty Last-Event-ID replays as without one', async () => {
  const { port, events } = await serve();
  emitCalls(events, 2);

  const client = await stream(port, { lastEventId: '' });
  emitCalls(events, 1);

  expect(await firstEvents(client, 3)).toEqual(ids(events.bootId, 1, 2, 3));
});

test('GET /api/events replays at most limit recent events, and 200 by default', async () => {
  const { port, events } = await serve();
  emitCalls(events, 250);

  const byDefault = await stream(port);
  const two = await stream(port, { path: '/api/events?limit=2' });
  const none = await stream(port, { path: '/api/events?limit=0' });
  const all = await stream(port, { path: '/api/events?limit=500' });
  const foreign = await stream(port, { path: '/api/events?limit=2', lastEventId: 'other-1' });
  // A client that resumes must miss nothing the buffer holds, whatever its limit.
  const resumed = await stream(port, {
    path: '/api/events?limit=1',
    lastEventId: `${events.bootId}-247`,
  });
  emitCalls(events, 1);

  await expect.poll(() => byDefault.events().length).toBe(201);
  expect(byDefault.events()[0]?.id).toBe(`${events.bootId}-51`);
  expect(await firstEvents(two, 3)).toEqual(ids(events.bootId, 249, 250, 251));
  expect(await firstEvents(none, 1)).toEqual(ids(events.bootId, 251));
  await expect.poll(() => all.events().length).toBe(251);
  expect(await firstEvents(foreign, 3)).toEqual(['gap', ...ids(events.bootId, 249, 250)]);
  expect(await firstEvents(resumed, 4)).toEqual(ids(events.bootId, 248, 249, 250, 251));
});

test.each(['501', '-1', '1.5', 'abc', '', '1e2', '0x10', '2,3'])(
  'GET /api/events?limit=%s is 400',
  async (limit) => {
    const { port, events } = await serve();

    const response = await send(port, { path: `/api/events?limit=${limit}` });

    expect(response.status).toBe(400);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(response.body)).toEqual({
      error: 'limit must be a whole number from 0 to 500',
    });
    expect(events.subscribers).toBe(0);
  },
);

test('an events stream lets go of the bus when its client goes away', async () => {
  const { port, events } = await serve();
  const client = await stream(port);
  expect(events.subscribers).toBe(1);

  client.close();

  await expect.poll(() => events.subscribers).toBe(0);
});

test('close() ends every open stream after what it sent and lets go of the bus', async () => {
  const { port, api, events } = await serve();
  const first = await stream(port);
  const second = await stream(port);
  emitCalls(events, 1);
  await expect.poll(() => second.events().length).toBe(1);
  expect(events.subscribers).toBe(2);

  api.close();

  expect(await first.ended).toBe('end');
  expect(await second.ended).toBe('end');
  expect(first.events()).toHaveLength(1);
  expect(events.subscribers).toBe(0);
});

// A request on a connection that stays open while the server shuts down would otherwise start a
// stream that the end of the connection cuts at once.
test('after close() a new events stream is refused with 503 and nothing subscribes', async () => {
  const { port, api, events } = await serve();
  emitCalls(events, 2);

  api.close();
  const response = await send(port, { path: '/api/events' });
  const info = await send(port, { path: '/api/info' });

  expect(response.status).toBe(503);
  expect(response.headers['content-type']).toBe('application/json');
  expect(response.headers['cache-control']).toBe('no-store');
  expect(JSON.parse(response.body)).toEqual({ error: 'The server is shutting down' });
  expect(events.subscribers).toBe(0);
  // The other routes answer as before: only a stream would outlive the server.
  expect(info.status).toBe(200);
});

// A response whose client is gone already, as a request that waited its turn may find it.
class GoneResponse extends EventEmitter {
  written = '';
  writableEnded = false;
  destroyed = true;
  writableLength = 0;

  writeHead(): this {
    return this;
  }

  write(chunk: string): boolean {
    this.written += chunk;
    return true;
  }

  end(): this {
    this.writableEnded = true;
    return this;
  }

  destroy(): this {
    return this;
  }
}

test('a stream whose client left before it opened replays nothing and does not subscribe', async () => {
  const { api, events } = await serve();
  emitCalls(events, 3);
  const res = new GoneResponse();
  // Without a url, as node:http types a request, the stream takes the default limit.
  const req = { method: 'GET', headers: { 'last-event-id': 'other-1' } };

  await api.handle(
    req as unknown as IncomingMessage,
    res as unknown as ServerResponse,
    '/api/events',
  );

  expect(res.written).not.toContain('event:');
  expect(events.subscribers).toBe(0);
});

// The transport answers it with 500 and logs it.
test('a failure that is no fault of the request reaches the caller of handle', async () => {
  const { api, events } = await serve();
  const headers = new Proxy(
    {},
    {
      get() {
        throw new Error('headers exploded');
      },
    },
  );
  const req = { method: 'POST', url: '/api/tools/chart_echo', headers };

  await expect(
    api.handle(
      req as unknown as IncomingMessage,
      new GoneResponse() as unknown as ServerResponse,
      '/api/tools/chart_echo',
    ),
  ).rejects.toThrow('headers exploded');
  expect(events.recent()).toEqual([]);
});
