import type { Config } from '../../src/config/schema.js';
import type { ToolCallEvent } from '../../src/core/events.js';
import { createMcpServer, createServerDeps } from '../../src/server.js';
import { toolInputJsonSchema } from '../../src/tools/schema-export.js';
import type { ToolRegistry } from '../../src/tools/types.js';
import { createDashboardApi } from '../../src/transports/dashboard/api.js';
import type {
  DashboardCallResult,
  DashboardInfo,
  DashboardToolList,
} from '../../src/transports/dashboard/contract.js';
import { mcpUrl, startHttpTransport, type HttpServerHandle } from '../../src/transports/http.js';
import { VERSION } from '../../src/version.js';
import {
  CountingBus,
  freePort,
  openEventStream,
  send,
  type EventStreamClient,
} from '../helpers/dashboard-client.js';
import { startFakeCdpServer, type FakeCdpServer } from '../helpers/fake-cdp/server.js';
import { loadTargetsFixture } from '../helpers/fake-cdp/targets.js';
import { loadTvFixture } from '../helpers/fake-tv/fixture.js';
import { createFakeTvWindow } from '../helpers/fake-tv/window.js';
import {
  capturingLogger,
  refusingLauncher,
  testConfig,
  unreachableConnection,
} from '../helpers/tool-context.js';

const TOKEN = 'test-token';
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const JSON_AUTH = { ...AUTH, 'Content-Type': 'application/json' };
const STARTED_AT = new Date('2026-10-23T08:00:00.000Z');
// What a user might type into a field: it must never reach the events.
const TYPED_TEXT = 'Synthetic private note';

// Everything a test starts is closed here, newest first, so a client goes before its server and a
// connection manager before the fake app it talks to.
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

interface Started {
  handle: HttpServerHandle;
  lines: Record<string, unknown>[];
  events: CountingBus;
  registry: ToolRegistry;
}

interface StartOptions {
  config?: Partial<Config>;
  // The fake app the connection reaches; without one, the debug port never answers.
  app?: FakeCdpServer;
  // A port to listen on that is known before the transport starts, for the MCP endpoint.
  httpPort?: number;
}

// The transport with the dashboard API on a free port and the token TOKEN, wired as the CLI wires
// it: one dashboard registry beside the servers of the MCP sessions, all on one set of
// dependencies.
async function start({ config: overrides = {}, app, httpPort = 0 }: StartOptions = {}) {
  const config = testConfig({
    transport: 'http',
    authToken: TOKEN,
    httpPort,
    ...(app === undefined ? {} : { cdpPort: app.port, callTimeoutMs: 5000 }),
    ...overrides,
  });
  const { logger, lines } = capturingLogger();
  const events = new CountingBus();
  const deps = createServerDeps(config, {
    launcher: refusingLauncher(),
    logger,
    events,
    ...(app === undefined ? { connection: unreachableConnection(logger) } : {}),
  });
  cleanups.push(() => deps.connection.close());
  const { registry } = createMcpServer(config, deps);
  const api = createDashboardApi({
    config,
    registry,
    events,
    connection: deps.connection,
    version: VERSION,
    startedAt: STARTED_AT,
    mcpEndpoint: httpPort === 0 ? null : mcpUrl(config.httpHost, httpPort),
    logger,
  });
  const handle = await startHttpTransport({
    config,
    logger,
    createServer: () => createMcpServer(config, deps).server,
    dashboard: { api },
  });
  cleanups.push(() => handle.close());
  return { handle, lines, events, registry } satisfies Started;
}

async function startApp(): Promise<FakeCdpServer> {
  const win = createFakeTvWindow(loadTvFixture());
  const app = await startFakeCdpServer({ targets: loadTargetsFixture({ chartWindow: () => win }) });
  cleanups.push(() => app.close());
  return app;
}

function post(
  port: number,
  path: string,
  body: string,
  headers: Record<string, string> = JSON_AUTH,
) {
  return send(port, { method: 'POST', path, headers, body });
}

async function stream(
  port: number,
  { path = '/api/events', lastEventId }: { path?: string; lastEventId?: string } = {},
): Promise<EventStreamClient> {
  const client = await openEventStream(port, {
    path,
    headers: { ...AUTH, ...(lastEventId === undefined ? {} : { 'Last-Event-ID': lastEventId }) },
  });
  cleanups.push(() => {
    client.close();
  });
  return client;
}

function emitCalls(events: CountingBus, count: number): void {
  for (let n = 1; n <= count; n++) {
    events.emit({
      id: `call-${String(n)}`,
      tool: 'chart_get_state',
      origin: 'mcp',
      phase: 'start',
      at: '2026-10-23T08:00:00.000Z',
    });
  }
}

// The seq and the id of each tool event a stream has received, and `gap` for a gap.
function received(client: EventStreamClient): string[] {
  return client
    .events()
    .map(({ event, id, data }) =>
      event === 'tool' ? `${String((data as ToolCallEvent).seq)} ${String(id)}` : event,
    );
}

function ids(bootId: string, ...seqs: number[]): string[] {
  return seqs.map((seq) => `${String(seq)} ${bootId}-${String(seq)}`);
}

test('GET /api/info without a token is 401 with WWW-Authenticate and never echoes a token', async () => {
  const { handle, lines } = await start();

  const missing = await send(handle.port, { path: '/api/info' });
  const wrong = await send(handle.port, {
    path: '/api/info',
    headers: { Authorization: 'Bearer not-the-token' },
  });
  // A token without the Bearer scheme is no token.
  const bare = await send(handle.port, { path: '/api/info', headers: { Authorization: TOKEN } });

  for (const response of [missing, wrong, bare]) {
    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');
    expect(response.body).not.toContain(TOKEN);
    expect(response.body).not.toContain('not-the-token');
  }
  expect(JSON.parse(missing.body)).toEqual({
    error: 'Authentication required: send the token as "Authorization: Bearer <token>"',
  });
  expect(JSON.parse(wrong.body)).toEqual({ error: 'Invalid token' });
  const logged = JSON.stringify(lines);
  expect(logged).not.toContain(TOKEN);
  expect(logged).not.toContain('not-the-token');
  expect(lines).toContainEqual(
    expect.objectContaining({ path: '/api/info', reason: 'missing token' }),
  );
});

// A URL ends up in logs, browser histories and Referer headers, so the API refuses one that
// carries the token even when the header carries it too.
test('GET /api/info with a token in the query or path is 401', async () => {
  const { handle, lines } = await start();

  const refused: [string, Record<string, string>][] = [
    [`/api/info?token=${TOKEN}`, AUTH],
    [`/api/info?access_token=${TOKEN}`, AUTH],
    [`/api/info?auth=Bearer+${TOKEN}`, AUTH],
    ['/api/info?token=test%2Dtoken', AUTH],
    [`/api/info?${TOKEN}`, AUTH],
    [`/api/info/${TOKEN}`, AUTH],
    [`/api/${TOKEN}/info`, AUTH],
    ['/api/test%2dtoken/info', AUTH],
    [`/api/events?limit=10&token=${TOKEN}`, AUTH],
  ];
  for (const [path, headers] of refused) {
    const response = await send(handle.port, { path, headers });
    expect({ path, status: response.status }).toEqual({ path, status: 401 });
    expect(response.headers['www-authenticate']).toBe('Bearer');
    expect(JSON.parse(response.body)).toEqual({
      error: 'Send the token in the "Authorization: Bearer <token>" header only, never in the URL',
    });
  }
  // Parameters without the token are no reason to refuse.
  const plain = await send(handle.port, { path: '/api/info?view=full', headers: AUTH });

  expect(plain.status).toBe(200);
  expect(JSON.stringify(lines)).not.toContain(TOKEN);
  expect(lines).toContainEqual(
    expect.objectContaining({ path: '/api/<redacted>/info', reason: 'token in the URL' }),
  );
});

// The URL is searched for the token only once the header has shown, by the constant-time check,
// that the client holds it: a client without it gets the answer of a missing or wrong token, and
// how long the server takes to give it says nothing of the token.
test('GET /api/info with a token in the URL but not in the header is refused for the header', async () => {
  const { handle, lines } = await start();

  const missing = await send(handle.port, { path: `/api/info?token=${TOKEN}` });
  const wrong = await send(handle.port, {
    path: `/api/${TOKEN}/info`,
    headers: { Authorization: 'Bearer not-the-token' },
  });

  for (const response of [missing, wrong]) {
    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');
  }
  expect(JSON.parse(missing.body)).toEqual({
    error: 'Authentication required: send the token as "Authorization: Bearer <token>"',
  });
  expect(JSON.parse(wrong.body)).toEqual({ error: 'Invalid token' });
  expect(JSON.stringify(lines)).not.toContain(TOKEN);
  expect(lines).toContainEqual(
    expect.objectContaining({ path: '/api/info', reason: 'missing token' }),
  );
  expect(lines).toContainEqual(
    expect.objectContaining({ path: '/api/<redacted>/info', reason: 'wrong token' }),
  );
  expect(lines).not.toContainEqual(expect.objectContaining({ reason: 'token in the URL' }));
});

test('a foreign Origin on /api is 403 and a rebinding Host is 403', async () => {
  const { handle, events } = await start();

  const origin = await post(handle.port, '/api/tools/chart_get_state', '{}', {
    ...JSON_AUTH,
    Origin: 'https://evil.example',
  });
  const host = await send(handle.port, {
    path: '/api/info',
    headers: { ...AUTH, Host: `evil.example:${String(handle.port)}` },
  });
  const ownPage = await send(handle.port, {
    path: '/api/info',
    headers: { ...AUTH, Origin: `http://localhost:${String(handle.port)}` },
  });

  expect(origin.status).toBe(403);
  expect(JSON.parse(origin.body)).toEqual({ error: expect.stringContaining('Origin') as string });
  expect(host.status).toBe(403);
  expect(JSON.parse(host.body)).toEqual({ error: expect.stringContaining('Host') as string });
  expect(ownPage.status).toBe(200);
  expect(events.recent()).toEqual([]);
});

test('/api/info reports the version, profile, tool count and the MCP endpoint without the token', async () => {
  const httpPort = await freePort();
  const { handle } = await start({ config: { profile: 'core' }, httpPort });

  const response = await send(handle.port, { path: '/api/info', headers: AUTH });

  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(JSON.parse(response.body) as DashboardInfo).toStrictEqual({
    name: 'tradingview-desktop-mcp',
    version: VERSION,
    transport: 'http',
    profile: 'core',
    toolPatterns: [],
    allowEval: false,
    toolCount: 40,
    mcpEndpoint: handle.url,
    startedAt: STARTED_AT.toISOString(),
  });
  expect(handle.url).toBe(`http://127.0.0.1:${String(httpPort)}/mcp`);
  expect(response.body).not.toContain(TOKEN);
});

test('/api/tools lists the offered tools with JSON schemas, annotations and profiles', async () => {
  const { handle, registry } = await start({ config: { profile: 'core' } });

  const response = await send(handle.port, { path: '/api/tools', headers: AUTH });

  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  const { tools } = JSON.parse(response.body) as DashboardToolList;
  expect(tools).toHaveLength(40);
  expect(tools.map(({ name }) => name)).toEqual(registry.list().map(({ name }) => name));
  for (const tool of tools) {
    expect(tool.core).toBe(true);
    expect(tool.profiles).toContain('core');
    expect(tool.profiles).toContain('full');
    expect(tool.inputSchema).toMatchObject({ type: 'object' });
    expect(tool.annotations).toEqual({
      readOnlyHint: expect.any(Boolean) as boolean,
      destructiveHint: expect.any(Boolean) as boolean,
      idempotentHint: expect.any(Boolean) as boolean,
      openWorldHint: false,
    });
  }
  const chartState = registry.list().find(({ name }) => name === 'chart_get_state');
  expect(tools.find(({ name }) => name === 'chart_get_state')).toStrictEqual({
    name: 'chart_get_state',
    domain: 'chart',
    title: 'Read the chart state',
    description: chartState?.description,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    core: true,
    profiles: ['full', 'core', 'readonly'],
    inputSchema: chartState === undefined ? undefined : toolInputJsonSchema(chartState),
  });
});

test('POST /api/tools/chart_get_state runs through the registry with origin dashboard and the call appears on the bus', async () => {
  const app = await startApp();
  const { handle, events } = await start({ app });

  const response = await post(handle.port, '/api/tools/chart_get_state', '{}');

  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  const result = JSON.parse(response.body) as DashboardCallResult;
  expect(result.isError).toBeUndefined();
  expect(result.structuredContent).toMatchObject({
    ok: true,
    data: { chartIndex: 0, symbol: expect.any(String) as string },
  });
  expect(result.content).toEqual([
    { type: 'text', text: JSON.stringify(result.structuredContent) },
  ]);
  const calls = events.recent();
  expect(calls.map(({ tool, origin, phase, ok }) => ({ tool, origin, phase, ok }))).toEqual([
    { tool: 'chart_get_state', origin: 'dashboard', phase: 'start', ok: undefined },
    { tool: 'chart_get_state', origin: 'dashboard', phase: 'end', ok: true },
  ]);
  expect(calls[0]?.id).toBe(calls[1]?.id);
});

test('POST /api/tools/ui_type_text shows only redacted arguments in the replayed events', async () => {
  const { handle, events } = await start();

  const response = await post(
    handle.port,
    '/api/tools/ui_type_text',
    JSON.stringify({ arguments: { text: TYPED_TEXT } }),
  );
  const client = await stream(handle.port);
  await expect.poll(() => client.events().length).toBe(2);

  expect(response.status).toBe(200);
  const [started, ended] = client.events();
  expect(started).toMatchObject({
    event: 'tool',
    data: { tool: 'ui_type_text', origin: 'dashboard', phase: 'start', args: { redacted: true } },
  });
  expect(ended).toMatchObject({ event: 'tool', data: { phase: 'end' } });
  expect(client.text()).not.toContain(TYPED_TEXT);
  expect(JSON.stringify(events.recent())).not.toContain(TYPED_TEXT);
});

test('POST /api/tools/unknown_tool is 404, a non-object arguments is 400, a 2 MB body is 413, text/plain is 415', async () => {
  const { handle, events } = await start();
  const twoMegabytes = JSON.stringify({ arguments: { text: 'x'.repeat(2 * 1024 * 1024) } });

  const unknown = await post(handle.port, '/api/tools/unknown_tool', '{}');
  // Offered by no profile of this server, it is as unknown as a name nobody gave.
  const outsideProfile = await start({ config: { profile: 'readonly' } }).then(
    ({ handle: other }) => post(other.port, '/api/tools/ui_type_text', '{}'),
  );
  const notObject = await post(handle.port, '/api/tools/chart_get_state', '{"arguments":[1]}');
  const tooLarge = await post(handle.port, '/api/tools/chart_get_state', twoMegabytes);
  const plainText = await post(handle.port, '/api/tools/chart_get_state', '{}', {
    ...AUTH,
    'Content-Type': 'text/plain',
  });

  expect(unknown.status).toBe(404);
  expect(outsideProfile.status).toBe(404);
  expect(notObject.status).toBe(400);
  expect(JSON.parse(notObject.body)).toEqual({ error: 'arguments must be a JSON object' });
  expect(tooLarge.status).toBe(413);
  expect(JSON.parse(tooLarge.body)).toEqual({ error: 'The body is larger than 1048576 bytes' });
  expect(plainText.status).toBe(415);
  for (const response of [unknown, outsideProfile, notObject, tooLarge, plainText]) {
    expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(response.body)).toEqual({ error: expect.any(String) as string });
  }
  // None of them reached the registry.
  expect(events.recent()).toEqual([]);
  // The connection that sent the large body is still of use.
  expect((await send(handle.port, { path: '/api/health', headers: AUTH })).status).toBe(200);
});

test('a tool error comes back as a 200 result with isError true and the error code', async () => {
  const { handle, events } = await start();

  const response = await post(handle.port, '/api/tools/chart_get_state', '{"arguments":{}}');

  expect(response.status).toBe(200);
  const result = JSON.parse(response.body) as DashboardCallResult;
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    ok: false,
    error: { code: 'CDP_UNREACHABLE', message: expect.any(String) as string },
  });
  expect(events.recent().at(-1)).toMatchObject({
    origin: 'dashboard',
    phase: 'end',
    ok: false,
    errorCode: 'CDP_UNREACHABLE',
  });
});

test('/api/health reports what the connection finds', async () => {
  const { handle } = await start();

  const response = await send(handle.port, { path: '/api/health', headers: AUTH });

  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(JSON.parse(response.body)).toMatchObject({
    cdp: { reachable: false, endpoint: 'http://127.0.0.1:9' },
    chart: { found: false, tabs: 0 },
    app: { ready: false },
  });
});

test('GET /api/events replays recent events and then streams live ones, each with its seq as id', async () => {
  const { handle, events } = await start();
  emitCalls(events, 3);

  const client = await stream(handle.port, { path: '/api/events?limit=2' });
  await expect.poll(() => client.events().length).toBe(2);
  // A call from the dashboard itself shows up too.
  await post(handle.port, '/api/tools/app_health', '{}');
  await expect.poll(() => client.events().length).toBe(4);

  expect(client.status).toBe(200);
  expect(client.headers['content-type']).toBe('text/event-stream; charset=utf-8');
  expect(client.headers['cache-control']).toBe('no-store');
  // The id is the seq after the boot id of the bus, so a server that restarted can tell an id of
  // its own from one of the process before it.
  expect(received(client)).toEqual(ids(events.bootId, 2, 3, 4, 5));
  expect(client.events().slice(2)).toMatchObject([
    { event: 'tool', data: { tool: 'app_health', origin: 'dashboard', phase: 'start' } },
    { event: 'tool', data: { tool: 'app_health', origin: 'dashboard', phase: 'end' } },
  ]);
});

test('GET /api/events with Last-Event-ID replays only newer events and announces a gap when some were dropped', async () => {
  const { handle, events } = await start();
  emitCalls(events, 3);

  const resumed = await stream(handle.port, { lastEventId: `${events.bootId}-1` });
  await expect.poll(() => resumed.events().length).toBe(2);
  expect(received(resumed)).toEqual(ids(events.bootId, 2, 3));

  // The bus keeps 500 events: of the 501 after seq 1, the oldest (seq 2) is gone.
  emitCalls(events, 499);
  const behind = await stream(handle.port, { lastEventId: `${events.bootId}-1` });
  await expect.poll(() => behind.events().length).toBe(501);

  expect(received(behind)).toEqual(['gap', ...ids(events.bootId, ...range(3, 502))]);
  expect(behind.events()[0]).toEqual({ event: 'gap', id: `${events.bootId}-502`, data: {} });
});

test('GET /api/events with a Last-Event-ID of an earlier server process announces a gap and replays the recent events', async () => {
  const before = await start();
  emitCalls(before.events, 5);
  const { handle, events } = await start();
  emitCalls(events, 2);

  // Seq 3 is beyond this bus's last; seq 1 is not, and resuming from it would miss event 1.
  const fromFar = await stream(handle.port, { lastEventId: `${before.events.bootId}-3` });
  const fromNear = await stream(handle.port, { lastEventId: `${before.events.bootId}-1` });
  await expect.poll(() => fromFar.events().length).toBe(3);
  await expect.poll(() => fromNear.events().length).toBe(3);

  expect(received(fromFar)).toEqual(['gap', ...ids(events.bootId, 1, 2)]);
  expect(received(fromNear)).toEqual(['gap', ...ids(events.bootId, 1, 2)]);
});

test('GET /api/events with an unparsable Last-Event-ID announces a gap and replays the recent events', async () => {
  const { handle, events } = await start();
  emitCalls(events, 2);

  const client = await stream(handle.port, { path: '/api/events?limit=1', lastEventId: '7' });
  await expect.poll(() => client.events().length).toBe(2);

  expect(received(client)).toEqual(['gap', ...ids(events.bootId, 2)]);
});

test('an events stream ends cleanly when the server closes', async () => {
  const { handle, events } = await start();
  const client = await stream(handle.port);
  emitCalls(events, 1);
  await expect.poll(() => client.events().length).toBe(1);
  expect(events.subscribers).toBe(1);

  await handle.close();

  expect(await client.ended).toBe('end');
  expect(events.subscribers).toBe(0);
  await expect(send(handle.port, { path: '/healthz' })).rejects.toMatchObject({
    code: 'ECONNREFUSED',
  });
});

test('an events stream lets go of the bus when its client goes away', async () => {
  const { handle, events } = await start();
  const client = await stream(handle.port);
  expect(events.subscribers).toBe(1);

  client.close();

  await expect.poll(() => events.subscribers).toBe(0);
});

test('/api is not served without the dashboard, with the token or without it', async () => {
  const { logger } = capturingLogger();
  const config = testConfig({ transport: 'http', authToken: TOKEN, httpPort: 0 });
  const handle = await startHttpTransport({
    config,
    logger,
    createServer: () => {
      throw new Error('No MCP request is made');
    },
  });
  cleanups.push(() => handle.close());

  for (const headers of [AUTH, {}]) {
    const response = await send(handle.port, { path: '/api/info', headers });
    expect(response.status).toBe(404);
  }
});

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}
