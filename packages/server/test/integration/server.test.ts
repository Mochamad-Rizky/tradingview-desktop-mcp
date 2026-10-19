import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../../src/config/schema.js';
import { ConnectionManager, type HealthReport } from '../../src/core/connection.js';
import { TvMcpError } from '../../src/core/errors.js';
import { ToolEventBus, type ToolCallEvent } from '../../src/core/events.js';
import { registerResources } from '../../src/resources/index.js';
import { createMcpServer, createServerDeps, type ServerDeps } from '../../src/server.js';
import { appTools } from '../../src/tools/app/index.js';
import { batchTools } from '../../src/tools/batch/index.js';
import { chartTools } from '../../src/tools/chart/index.js';
import { createToolRegistry, registerToolsWithServer } from '../../src/tools/registry.js';
import { defineTool, type ToolRegistry } from '../../src/tools/types.js';
import { startFakeCdpServer } from '../helpers/fake-cdp/server.js';
import { loadTargetsFixture } from '../helpers/fake-cdp/targets.js';
import { loadTvFixture } from '../helpers/fake-tv/fixture.js';
import { createFakeTvWindow } from '../helpers/fake-tv/window.js';
import { callTool, connectInMemoryClient, textOf } from '../helpers/mcp-client.js';
import {
  capturingLogger,
  createTestContext,
  quietLogger,
  refusingLauncher,
  testConfig,
  unreachableConnection,
  unreachableConnectionDeps,
} from '../helpers/tool-context.js';

const HEALTH_URI = 'tradingview://app/health';
// What a server offers when nothing narrows its tools: the tools of the app and of the chart, then
// the batch.
const APP_TOOL_NAMES = appTools.map(({ name }) => name);
const CHART_TOOL_NAMES = chartTools.map(({ name }) => name);

// Everything a test starts is closed here, newest first, so a client goes before its server and a
// connection manager before the fake app it talks to.
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function connect(server: McpServer): Promise<Client> {
  const client = await connectInMemoryClient(server);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

// Dependencies that reach no app, shared the way one process shares them between sessions.
function offlineDeps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  return {
    connection: unreachableConnection(),
    launcher: refusingLauncher(),
    logger: quietLogger,
    events: new ToolEventBus(),
    ...overrides,
  };
}

// A server with batch_run and three steps for it: the second step always fails.

interface StepHarness {
  client: Client;
  registry: ToolRegistry;
  // The steps that ran, in order.
  ran: string[];
  events: ToolCallEvent[];
}

async function startStepServer(): Promise<StepHarness> {
  const ran: string[] = [];
  const step = (name: string, fails: boolean) =>
    defineTool({
      name,
      domain: 'chart',
      title: `Step ${name}`,
      description: fails ? 'Records that it ran, then fails.' : 'Records that it ran.',
      inputSchema: { label: z.string().optional().describe('A label to return') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      handler: ({ label }) => {
        ran.push(name);
        if (fails) {
          return Promise.reject(new TvMcpError('NOT_AVAILABLE', `${name} is not available`));
        }
        return Promise.resolve({ data: { step: name, label: label ?? null } });
      },
    });
  const base = createTestContext();
  const events: ToolCallEvent[] = [];
  base.events.subscribe((event) => {
    events.push(event);
  });
  const registry = createToolRegistry(
    [
      ...batchTools,
      step('chart_step_one', false),
      step('chart_step_two', true),
      step('chart_step_three', false),
    ],
    base,
  );
  const server = new McpServer({ name: 'step-server', version: '0.0.0' });
  registerToolsWithServer(server, registry);
  registerResources(server, { ...base, registry });
  return { client: await connect(server), registry, ran, events };
}

function steps(count: number, tool = 'chart_step_one'): { tool: string }[] {
  return Array.from({ length: count }, () => ({ tool }));
}

test('lists registered tools with descriptions and input schemas', async () => {
  const { server } = createMcpServer(testConfig(), offlineDeps());
  const client = await connect(server);

  const { tools } = await client.listTools();

  expect(tools.map(({ name }) => name)).toEqual([
    ...APP_TOOL_NAMES,
    ...CHART_TOOL_NAMES,
    'batch_run',
  ]);
  expect(tools.find(({ name }) => name === 'batch_run')).toMatchObject({
    name: 'batch_run',
    title: expect.any(String) as string,
    description: expect.stringContaining('20') as string,
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          description: expect.any(String) as string,
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string', description: expect.any(String) as string },
              arguments: { type: 'object', description: expect.any(String) as string },
            },
            required: ['tool'],
          },
        },
        stopOnError: {
          type: 'boolean',
          default: true,
          description: expect.any(String) as string,
        },
      },
      required: ['steps'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  });
});

test('lists every tool of a registry with the metadata of its definition', async () => {
  const { client } = await startStepServer();

  const { tools } = await client.listTools();

  expect(tools.map(({ name }) => name)).toEqual([
    'batch_run',
    'chart_step_one',
    'chart_step_two',
    'chart_step_three',
  ]);
  expect(tools[1]).toMatchObject({
    title: 'Step chart_step_one',
    description: 'Records that it ran.',
    inputSchema: {
      type: 'object',
      properties: { label: { type: 'string', description: 'A label to return' } },
    },
    // Every tool says that it reaches nothing beyond the local app, whether its definition does
    // or not.
    annotations: { readOnlyHint: false, openWorldHint: false },
  });
});

test('invalid input returns a validation error result', async () => {
  const { client, ran } = await startStepServer();

  const result = await callTool(client, 'chart_step_one', { label: 42 });

  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain('label');
  expect(ran).toEqual([]);
});

test('returns a failing tool as the error envelope', async () => {
  const { client } = await startStepServer();

  const result = await callTool(client, 'chart_step_two');

  expect(result.isError).toBe(true);
  expect(result.structuredContent).toStrictEqual({
    ok: false,
    error: { code: 'NOT_AVAILABLE', message: 'chart_step_two is not available' },
    meta: { durationMs: expect.any(Number) as number },
  });
  expect(JSON.parse(textOf(result))).toStrictEqual(result.structuredContent);
});

test('batch_run executes steps in order and stops on the first error', async () => {
  const { client, ran } = await startStepServer();

  const result = await callTool(client, 'batch_run', {
    steps: [
      { tool: 'chart_step_one', arguments: { label: 'first' } },
      { tool: 'chart_step_two' },
      { tool: 'chart_step_three' },
    ],
  });

  expect(ran).toEqual(['chart_step_one', 'chart_step_two']);
  // The batch itself worked; the failure belongs to its step.
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toStrictEqual({
    ok: true,
    data: {
      steps: [
        {
          tool: 'chart_step_one',
          ok: true,
          data: { step: 'chart_step_one', label: 'first' },
          meta: { durationMs: expect.any(Number) as number, warnings: [] },
        },
        {
          tool: 'chart_step_two',
          ok: false,
          error: { code: 'NOT_AVAILABLE', message: 'chart_step_two is not available' },
          meta: { durationMs: expect.any(Number) as number },
        },
      ],
      completed: 2,
      stopped: true,
    },
    meta: { durationMs: expect.any(Number) as number, warnings: [] },
  });
});

test('batch_run runs every step when stopOnError is false', async () => {
  const { client, ran } = await startStepServer();

  const result = await callTool(client, 'batch_run', {
    steps: [{ tool: 'chart_step_one' }, { tool: 'chart_step_two' }, { tool: 'chart_step_three' }],
    stopOnError: false,
  });

  expect(ran).toEqual(['chart_step_one', 'chart_step_two', 'chart_step_three']);
  expect(result.structuredContent).toMatchObject({
    ok: true,
    data: {
      steps: [{ ok: true }, { ok: false }, { tool: 'chart_step_three', ok: true }],
      completed: 3,
      stopped: false,
    },
  });
});

test('batch_run reports a step whose tool is unknown and stops there', async () => {
  const { client, ran } = await startStepServer();

  const result = await callTool(client, 'batch_run', {
    steps: [{ tool: 'chart_step_one' }, { tool: 'chart_missing' }, { tool: 'chart_step_three' }],
  });

  expect(ran).toEqual(['chart_step_one']);
  expect(result.structuredContent).toMatchObject({
    data: {
      steps: [{ ok: true }, { tool: 'chart_missing', ok: false, error: { code: 'INVALID_INPUT' } }],
      completed: 2,
      stopped: true,
    },
  });
});

test('batch_run rejects nested batch_run with INVALID_INPUT', async () => {
  const { client, ran } = await startStepServer();

  const result = await callTool(client, 'batch_run', {
    steps: [
      { tool: 'chart_step_one' },
      { tool: 'batch_run', arguments: { steps: [{ tool: 'chart_step_one' }] } },
    ],
  });

  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT', details: { steps: [1] } },
  });
  // Refused before anything ran, so the first step did not run either.
  expect(ran).toEqual([]);
});

test('batch_run limits steps to 20', async () => {
  const { client, registry, ran } = await startStepServer();

  const tooMany = await callTool(client, 'batch_run', { steps: steps(21) });
  const none = await callTool(client, 'batch_run', { steps: [] });

  expect(tooMany.isError).toBe(true);
  expect(textOf(tooMany)).toContain('steps');
  expect(none.isError).toBe(true);
  expect(ran).toEqual([]);
  // Calls that bypass MCP, from the dashboard, meet the same limit.
  const fromDashboard = await registry.call('batch_run', { steps: steps(21) }, 'dashboard');
  expect(fromDashboard.structuredContent).toMatchObject({
    error: { code: 'INVALID_INPUT', details: { issues: [{ path: 'steps' }] } },
  });
  expect(ran).toEqual([]);

  const most = await callTool(client, 'batch_run', { steps: steps(20) });

  expect(most.structuredContent).toMatchObject({ ok: true, data: { completed: 20 } });
  expect(ran).toHaveLength(20);
});

test('batch_run keeps the images of its steps', async () => {
  const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' } as const;
  const capture = defineTool({
    name: 'screenshot_fake',
    domain: 'screenshot',
    title: 'Fake screenshot',
    description: 'Returns one image.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: () => Promise.resolve({ data: { format: 'png' }, via: 'cdp', images: [image] }),
  });
  const registry = createToolRegistry([...batchTools, capture], createTestContext());
  const server = new McpServer({ name: 'capture-server', version: '0.0.0' });
  registerToolsWithServer(server, registry);
  const client = await connect(server);

  const result = await callTool(client, 'batch_run', {
    steps: [{ tool: 'screenshot_fake' }, { tool: 'screenshot_fake' }],
  });

  expect(result.content.slice(0, 2)).toEqual([image, image]);
  expect(result.content[2]).toMatchObject({ type: 'text' });
});

test('batch_run reports the data of a step as a direct call returns it', async () => {
  // NaN has no JSON form, so a client of a direct call receives null over stdio or HTTP, and the
  // text block says so too. The in-memory transport passes objects as they are, which is why the
  // direct call is read from its text block here.
  const odd = defineTool({
    name: 'data_odd',
    domain: 'data',
    title: 'Odd numbers',
    description: 'Returns a number that JSON cannot carry.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: () =>
      Promise.resolve({ data: { value: Number.NaN, list: [Number.POSITIVE_INFINITY] } }),
  });
  const registry = createToolRegistry([...batchTools, odd], createTestContext());
  const server = new McpServer({ name: 'odd-server', version: '0.0.0' });
  registerToolsWithServer(server, registry);
  const client = await connect(server);

  const direct = await callTool(client, 'data_odd');
  const batched = await callTool(client, 'batch_run', { steps: [{ tool: 'data_odd' }] });

  expect(JSON.parse(textOf(direct))).toMatchObject({ data: { value: null, list: [null] } });
  expect(batched.structuredContent).toMatchObject({
    ok: true,
    data: { steps: [{ tool: 'data_odd', ok: true, data: { value: null, list: [null] } }] },
  });
});

test('batch steps reach the event log as calls from the batch', async () => {
  const { client, events } = await startStepServer();

  await callTool(client, 'batch_run', { steps: [{ tool: 'chart_step_one' }] });

  expect(events.map(({ tool, origin, phase }) => `${origin} ${tool} ${phase}`)).toEqual([
    'mcp batch_run start',
    'batch chart_step_one start',
    'batch chart_step_one end',
    'mcp batch_run end',
  ]);
});

test('reads the app health resource', async () => {
  const fixture = loadTvFixture();
  const win = createFakeTvWindow(fixture);
  const app = await startFakeCdpServer({ targets: loadTargetsFixture({ chartWindow: () => win }) });
  cleanups.push(() => app.close());
  // The connection manager is the default one, over HTTP discovery and the CDP adapter.
  const { server, ctx } = createMcpServer(testConfig({ cdpPort: app.port, callTimeoutMs: 5000 }), {
    launcher: refusingLauncher(),
    logger: quietLogger,
  });
  cleanups.push(() => ctx.connection.close());
  const client = await connect(server);

  const { resources } = await client.listResources();
  const read = await client.readResource({ uri: HEALTH_URI });

  expect(resources).toContainEqual(
    expect.objectContaining({ uri: HEALTH_URI, mimeType: 'application/json' }),
  );
  expect(read.contents).toHaveLength(1);
  const [content] = read.contents;
  expect(content).toMatchObject({ uri: HEALTH_URI, mimeType: 'application/json' });
  const text = content !== undefined && 'text' in content ? content.text : '';
  expect(JSON.parse(text)).toEqual({
    cdp: {
      reachable: true,
      endpoint: `http://127.0.0.1:${String(app.port)}`,
      browser: 'Chrome/146.0.7680.216',
      userAgent: expect.stringContaining('TradingView/3.4.1') as string,
    },
    chart: { found: true, tabs: 1, url: 'https://www.tradingview.com/chart/FIXTURE1/' },
    app: { ready: true, connected: true, buildTime: fixture.buildTime },
  });
});

// Stands in for a connection manager with a bug: health() never fails on its own.
class BrokenConnection extends ConnectionManager {
  constructor(private readonly failure: unknown) {
    super(unreachableConnectionDeps());
  }

  override health(): Promise<HealthReport> {
    return Promise.resolve().then(() => {
      throw this.failure;
    });
  }
}

test('resource read errors come back as MCP errors and the server keeps working', async () => {
  const { logger, lines } = capturingLogger();
  const failure = new Error('ENOENT: /Users/someone/private/state.json');
  const { server } = createMcpServer(
    testConfig(),
    offlineDeps({ connection: new BrokenConnection(failure), logger }),
  );
  const client = await connect(server);

  const error = await client.readResource({ uri: HEALTH_URI }).then(
    () => undefined,
    (reason: unknown) => reason,
  );

  expect(error).toMatchObject({
    code: -32603,
    data: { code: 'INTERNAL', message: 'Unexpected error' },
  });
  // The original message stays in the server log.
  expect(String(error)).not.toContain('private');
  expect(lines).toContainEqual(
    expect.objectContaining({
      level: 50,
      uri: HEALTH_URI,
      err: expect.objectContaining({
        stack: expect.stringContaining('ENOENT') as string,
      }) as unknown,
    }),
  );
  await expect(client.listTools()).resolves.toMatchObject({
    tools: expect.arrayContaining([expect.objectContaining({ name: 'batch_run' })]) as unknown,
  });
});

// A mistake of the client is "invalid params" in JSON-RPC terms; anything else is the server's.
test.each([
  ['TARGET_NOT_FOUND', -32603],
  ['INVALID_INPUT', -32602],
] as const)('resource read errors of our own keep their code %s and hint', async (code, rpc) => {
  const failure = new TvMcpError(code, 'No chart tab is open', {
    hint: 'Open a chart in TradingView.',
  });
  const { server } = createMcpServer(
    testConfig(),
    offlineDeps({ connection: new BrokenConnection(failure) }),
  );
  const client = await connect(server);

  await expect(client.readResource({ uri: HEALTH_URI })).rejects.toMatchObject({
    code: rpc,
    message: expect.stringContaining('No chart tab is open') as string,
    data: { code, message: 'No chart tab is open', hint: 'Open a chart in TradingView.' },
  });
});

test('createServerDeps keeps the dependencies it is given and creates the others', async () => {
  const events = new ToolEventBus();

  const deps = createServerDeps(testConfig(), { logger: quietLogger, events });
  cleanups.push(() => deps.connection.close());

  expect(deps.logger).toBe(quietLogger);
  expect(deps.events).toBe(events);
  expect(deps.connection).toBeInstanceOf(ConnectionManager);
  // The connection it creates watches the configured debug port, where nothing answers here.
  await expect(deps.connection.health()).resolves.toMatchObject({
    cdp: { reachable: false, endpoint: 'http://127.0.0.1:9' },
  });
});

test('createMcpServer shares the dependencies it is given between servers', async () => {
  const deps = offlineDeps();
  const events: ToolCallEvent[] = [];
  deps.events.subscribe((event) => {
    events.push(event);
  });

  const first = createMcpServer(testConfig(), deps);
  const second = createMcpServer(testConfig(), deps);

  for (const { ctx } of [first, second]) {
    expect(ctx.connection).toBe(deps.connection);
    expect(ctx.launcher).toBe(deps.launcher);
    expect(ctx.logger).toBe(deps.logger);
    expect(ctx.events).toBe(deps.events);
  }
  // What a session created is its own.
  expect(first.ctx.session).not.toBe(second.ctx.session);
  expect(first.ctx.registry).toBe(first.registry);
  expect(second.ctx.registry).toBe(second.registry);

  await first.registry.call('batch_run', { steps: [{ tool: 'missing_tool' }] }, 'dashboard');
  const client = await connect(second.server);
  await callTool(client, 'batch_run', { steps: [{ tool: 'missing_tool' }] });

  expect(events.filter(({ phase }) => phase === 'end').map(({ origin }) => origin)).toEqual([
    'batch',
    'dashboard',
    'batch',
    'mcp',
  ]);
});

test('createMcpServer creates the dependencies it is not given', () => {
  const config: Readonly<Config> = testConfig({ logLevel: 'silent' });

  const { ctx, registry } = createMcpServer(config);
  cleanups.push(() => ctx.connection.close());

  expect(ctx.config).toBe(config);
  expect(ctx.connection).toBeInstanceOf(ConnectionManager);
  expect(ctx.events).toBeInstanceOf(ToolEventBus);
  expect(ctx.logger.level).toBe('silent');
  expect(ctx.launcher).toEqual({
    launch: expect.any(Function) as unknown,
    discover: expect.any(Function) as unknown,
  });
  expect(ctx.session).toEqual({ createdDrawingIds: new Set(), createdAlertIds: new Set() });
  expect(registry.list().map(({ name }) => name)).toEqual([
    ...APP_TOOL_NAMES,
    ...CHART_TOOL_NAMES,
    'batch_run',
  ]);
});

test('createMcpServer registers the tools of the profile and the tool filter only', () => {
  const { logger, lines } = capturingLogger();
  const deps = offlineDeps({ logger });
  const toolsOf = (overrides: Partial<Config>) =>
    createMcpServer(testConfig(overrides), deps)
      .registry.list()
      .map(({ name }) => name);

  expect(toolsOf({ profile: 'core' })).toEqual([
    ...APP_TOOL_NAMES,
    ...CHART_TOOL_NAMES,
    'batch_run',
  ]);
  expect(toolsOf({ profile: 'full', toolPatterns: ['batch_*'] })).toEqual(['batch_run']);
  expect(toolsOf({ profile: 'full', toolPatterns: ['app_*'] })).toEqual(APP_TOOL_NAMES);
  expect(toolsOf({ profile: 'core', toolPatterns: ['app_h*', 'batch_*'] })).toEqual([
    'app_health',
    'batch_run',
  ]);
  // Only the tools that say they read.
  expect(toolsOf({ profile: 'readonly' })).toEqual([
    'app_health',
    'app_discover',
    'app_get_ui_state',
    'app_get_plan_limits',
    'chart_get_state',
    'chart_get_visible_range',
  ]);
  expect(lines).toEqual([]);

  expect(toolsOf({ profile: 'readonly', toolPatterns: ['batch_*'] })).toEqual([]);
  expect(toolsOf({ toolPatterns: ['nosuchdomain_*'] })).toEqual([]);
  // A server without tools is most likely a typo in the filter, so it says so.
  expect(lines).toEqual([
    expect.objectContaining({ level: 40, profile: 'readonly', patterns: ['batch_*'] }),
    expect.objectContaining({ level: 40, profile: 'full', patterns: ['nosuchdomain_*'] }),
  ]);
});
