import { EventEmitter } from 'node:events';
import { createServer as createTcpServer, type AddressInfo, type Server } from 'node:net';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { runCli } from '../../src/cli/run.js';
import { ToolEventBus } from '../../src/core/events.js';
import { allTools } from '../../src/tools/index.js';
import { startFakeCdpServer, type FakeCdpServer } from '../helpers/fake-cdp/server.js';
import { loadTargetsFixture } from '../helpers/fake-cdp/targets.js';
import { loadTvFixture } from '../helpers/fake-tv/fixture.js';
import { createFakeTvWindow } from '../helpers/fake-tv/window.js';
import { connectStdioClient } from '../helpers/mcp-client.js';
import { CaptureStream } from '../helpers/streams.js';
import {
  capturingLogger,
  quietLogger,
  refusingLauncher,
  unreachableConnection,
} from '../helpers/tool-context.js';

const HEALTH_URI = 'tradingview://app/health';
const TOKEN = 'test-token';
// The chart tab of the recorded target list.
const CHART_ID = 'BBB144A7827AE55CBA0E74986FC9574C';
const fixture = loadTvFixture();

// Everything a test starts is closed here, newest first.
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function startApp(): Promise<FakeCdpServer> {
  const win = createFakeTvWindow(fixture);
  const app = await startFakeCdpServer({ targets: loadTargetsFixture({ chartWindow: () => win }) });
  cleanups.push(() => app.close());
  return app;
}

function appEnv(app: FakeCdpServer): NodeJS.ProcessEnv {
  return { TV_CDP_PORT: String(app.port), TV_CALL_TIMEOUT_MS: '5000' };
}

async function listenOnFreePort(): Promise<Server> {
  const server = createTcpServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

function portOf(server: Server): number {
  return (server.address() as AddressInfo).port;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

// A port nothing listens on right now.
async function freePort(): Promise<number> {
  const server = await listenOnFreePort();
  const port = portOf(server);
  await closeServer(server);
  return port;
}

async function connectHttpClient(url: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  const client = new Client({ name: 'tradingview-mcp-tests', version: '0.0.0' });
  // The SDK types sessionId as an accessor that may return undefined, which
  // exactOptionalPropertyTypes does not accept for the optional member of its own Transport.
  await client.connect(transport as Transport);
  cleanups.push(() => client.close());
  return client;
}

test('doctor reports a ready app, exits 0, and closes its CDP session', async () => {
  const app = await startApp();
  const stdout = new CaptureStream();

  const code = await runCli(
    ['doctor'],
    appEnv(app),
    { stdout, stderr: new CaptureStream() },
    { logger: quietLogger, launcher: refusingLauncher() },
  );

  expect(code).toBe(0);
  expect(stdout.text).toContain(`✔ Debug port answers at http://127.0.0.1:${String(app.port)}`);
  expect(stdout.text).toContain('✔ Chart tab open: https://www.tradingview.com/chart/FIXTURE1/');
  expect(stdout.text).toContain(`(build ${fixture.buildTime})`);
  expect(app.connectionCount(CHART_ID)).toBe(1);
  expect(app.openConnectionCount()).toBe(0);
});

test('serve over stdio answers a client, and stops and closes its CDP session when the input ends', async () => {
  const app = await startApp();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new CaptureStream();
  const running = runCli(
    [],
    appEnv(app),
    { stdin, stdout, stderr },
    { logger: quietLogger, launcher: refusingLauncher() },
  );
  const client = await connectStdioClient(stdout, stdin);
  cleanups.push(() => client.close());

  const { tools } = await client.listTools();
  await client.readResource({ uri: HEALTH_URI });

  expect(tools.map(({ name }) => name)).toContain('batch_run');
  expect(app.openConnectionCount(CHART_ID)).toBe(1);
  expect(stderr.text).toMatch(/transport +stdio/);
  expect(stderr.text).toContain(`http://127.0.0.1:${String(app.port)}`);

  stdin.end();

  expect(await running).toBe(0);
  expect(app.openConnectionCount()).toBe(0);
});

test('serve over http shares one CDP session between MCP sessions and stops on SIGTERM', async () => {
  const app = await startApp();
  const port = await freePort();
  const signals = new EventEmitter();
  const stderr = new CaptureStream();
  const running = runCli(
    ['--transport', 'http', '--port', String(port)],
    { ...appEnv(app), TV_MCP_AUTH_TOKEN: TOKEN },
    { stdout: new CaptureStream(), stderr, process: signals },
    { logger: quietLogger, launcher: refusingLauncher() },
  );
  const endpoint = `http://127.0.0.1:${String(port)}/mcp`;
  await expect.poll(() => stderr.text, { timeout: 5000 }).toContain(endpoint);
  expect(stderr.text).not.toContain(TOKEN);

  const first = await connectHttpClient(endpoint);
  const second = await connectHttpClient(endpoint);
  await first.readResource({ uri: HEALTH_URI });
  await second.readResource({ uri: HEALTH_URI });

  // Two connection managers would have opened a session each; the chart tab may only have one.
  expect(app.connectionCount(CHART_ID)).toBe(1);

  signals.emit('SIGTERM');

  expect(await running).toBe(0);
  await expect(fetch(`http://127.0.0.1:${String(port)}/healthz`)).rejects.toThrow();
  expect(app.openConnectionCount()).toBe(0);
  expect(signals.eventNames()).toEqual([]);
});

// A request to the dashboard API of a server on `port`, with the token.
function apiRequest(port: number, path: string, body?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${String(port)}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { method: 'POST', body }),
  });
}

test('serve over http serves the dashboard API on the bus and the connection of the process', async () => {
  const app = await startApp();
  const port = await freePort();
  const events = new ToolEventBus();
  const signals = new EventEmitter();
  const stderr = new CaptureStream();
  const running = runCli(
    ['--transport', 'http', '--port', String(port)],
    { ...appEnv(app), TV_MCP_AUTH_TOKEN: TOKEN },
    { stdout: new CaptureStream(), stderr, process: signals },
    { logger: quietLogger, launcher: refusingLauncher(), events },
  );
  const endpoint = `http://127.0.0.1:${String(port)}/mcp`;
  await expect.poll(() => stderr.text, { timeout: 5000 }).toContain(endpoint);

  const info = (await (await apiRequest(port, '/api/info')).json()) as Record<string, unknown>;
  const call = await apiRequest(port, '/api/tools/chart_get_state', '{}');
  const client = await connectHttpClient(endpoint);
  await client.callTool({ name: 'chart_get_state', arguments: {} });

  // The endpoint the dashboard shows is the one of the banner.
  expect(info).toMatchObject({ transport: 'http', mcpEndpoint: endpoint });
  expect(info.toolCount).toBe(allTools.length);
  expect(call.status).toBe(200);
  expect(events.recent().map(({ origin, phase }) => `${origin} ${phase}`)).toEqual([
    'dashboard start',
    'dashboard end',
    'mcp start',
    'mcp end',
  ]);
  // The dashboard's calls go through the connection manager of the process, like the session's.
  expect(app.connectionCount(CHART_ID)).toBe(1);

  signals.emit('SIGTERM');
  expect(await running).toBe(0);
});

// A server without tools says so each time it is created, which shows when the CLI creates one.
test('serve over http builds one dashboard registry at startup, and none with --no-dashboard', async () => {
  const noTools = (lines: Record<string, unknown>[]) =>
    lines.filter((line) => typeof line.msg === 'string' && line.msg.startsWith('No tool matches'));

  for (const [flags, status, registries] of [
    [[], 200, 1],
    [['--no-dashboard'], 404, 0],
  ] as const) {
    const { logger, lines } = capturingLogger();
    const port = await freePort();
    const signals = new EventEmitter();
    const stderr = new CaptureStream();
    const running = runCli(
      ['--transport', 'http', '--port', String(port), '--tools', 'nosuchdomain_*', ...flags],
      { TV_CDP_PORT: '9', TV_MCP_AUTH_TOKEN: TOKEN },
      { stdout: new CaptureStream(), stderr, process: signals },
      { logger, launcher: refusingLauncher(), connection: unreachableConnection(logger) },
    );
    await expect.poll(() => stderr.text, { timeout: 5000 }).toContain(String(port));

    const first = await apiRequest(port, '/api/info');
    const second = await apiRequest(port, '/api/tools/app_health', '{}');

    expect(first.status).toBe(status);
    // No tool is offered to call, and without the dashboard there is no API at all.
    expect(second.status).toBe(404);
    expect(noTools(lines)).toHaveLength(registries);
    signals.emit('SIGTERM');
    expect(await running).toBe(0);
  }
});

test('serve over http exits 1 with the code, message and hint when the port is taken', async () => {
  const blocker = await listenOnFreePort();
  cleanups.push(() => closeServer(blocker));
  const port = String(portOf(blocker));
  const stderr = new CaptureStream();

  const code = await runCli(
    ['--transport', 'http', '--port', port],
    { TV_CDP_PORT: '9', TV_MCP_AUTH_TOKEN: TOKEN },
    { stdout: new CaptureStream(), stderr },
    { logger: quietLogger, launcher: refusingLauncher(), connection: unreachableConnection() },
  );

  expect(code).toBe(1);
  expect(stderr.text).toContain('✖ INVALID_INPUT: Cannot listen on 127.0.0.1:');
  expect(stderr.text).toContain(port);
  expect(stderr.text).toContain('--port');
});

// The CDP client library can throw from inside a WebSocket event handler, where nothing can catch
// it, and a promise can be rejected with nobody listening.
test.each(['uncaughtException', 'unhandledRejection'])(
  'an error nothing caught (%s) is logged with its stack and ends the CLI with 1',
  async (event) => {
    const { logger, lines } = capturingLogger();
    const signals = new EventEmitter();
    const stdin = new PassThrough();
    const stderr = new CaptureStream();
    const running = runCli(
      [],
      { TV_CDP_PORT: '9' },
      { stdin, stdout: new PassThrough(), stderr, process: signals },
      { logger, launcher: refusingLauncher(), connection: unreachableConnection(logger) },
    );
    // The server that is left running stops once its input ends.
    cleanups.push(() => {
      stdin.end();
      return Promise.resolve();
    });
    await expect.poll(() => stderr.text, { timeout: 5000 }).toMatch(/transport +stdio/);

    signals.emit(event, new Error('thrown from a socket handler'));

    expect(await running).toBe(1);
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 60,
        err: expect.objectContaining({
          stack: expect.stringContaining('thrown from a socket handler') as string,
        }) as unknown,
      }),
    );
    expect(signals.listenerCount(event)).toBe(0);
  },
);
