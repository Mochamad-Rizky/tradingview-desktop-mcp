import { EventEmitter } from 'node:events';
import { createServer as createTcpServer, type AddressInfo, type Server } from 'node:net';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { runCli } from '../../src/cli/run.js';
import type { Config } from '../../src/config/schema.js';
import { createMcpServer, createServerDeps } from '../../src/server.js';
import { createDashboardApi, type DashboardApi } from '../../src/transports/dashboard/api.js';
import type { DashboardInfo } from '../../src/transports/dashboard/contract.js';
import { startDashboardServer } from '../../src/transports/dashboard/server.js';
import { startHttpTransport, type HttpServerHandle } from '../../src/transports/http.js';
import { VERSION } from '../../src/version.js';
import {
  CountingBus,
  freePort,
  openEventStream,
  send,
  type RawResponse,
} from '../helpers/dashboard-client.js';
import {
  ASSET_JS,
  INDEX_HTML,
  OUTSIDE_JSON,
  createDashboardFiles,
  type DashboardFiles,
} from '../helpers/dashboard-files.js';
import { connectStdioClient } from '../helpers/mcp-client.js';
import { CaptureStream } from '../helpers/streams.js';
import {
  capturingLogger,
  refusingLauncher,
  testConfig,
  unreachableConnection,
} from '../helpers/tool-context.js';

const TOKEN = 'test-token';
const AUTH = { Authorization: `Bearer ${TOKEN}` };
// What a browser sends when it loads a page.
const HTML = { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };
const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};
const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'raw-http-test', version: '0.0.0' },
  },
});
const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' " +
    "data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; " +
    "form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};
const FILES_NOT_FOUND = /^Dashboard files not found/;
const NEEDS_TOKEN = /TV_MCP_AUTH_TOKEN/;

// Everything a test starts is closed here, newest first.
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function files(): DashboardFiles {
  const built = createDashboardFiles();
  cleanups.push(() => {
    built.remove();
  });
  return built;
}

function dashboardApi(config: Readonly<Config>, events = new CountingBus()) {
  const { logger, lines } = capturingLogger();
  const deps = createServerDeps(config, {
    launcher: refusingLauncher(),
    logger,
    events,
    connection: unreachableConnection(logger),
  });
  cleanups.push(() => deps.connection.close());
  const api = createDashboardApi({
    config,
    registry: createMcpServer(config, deps).registry,
    events,
    connection: deps.connection,
    version: VERSION,
    startedAt: new Date('2026-10-23T08:00:00.000Z'),
    mcpEndpoint: null,
    logger,
  });
  return { api, deps, logger, lines, events };
}

// The HTTP transport with the dashboard API and, unless `dir` is null, the files of `dir`.
async function startHttp({ dir }: { dir: string | null }): Promise<{
  handle: HttpServerHandle;
  lines: Record<string, unknown>[];
}> {
  const config = testConfig({ transport: 'http', authToken: TOKEN, httpPort: 0 });
  const { api, deps, logger, lines } = dashboardApi(config);
  const handle = await startHttpTransport({
    config,
    logger,
    createServer: () => createMcpServer(config, deps).server,
    dashboard: dir === null ? { api } : { api, dir },
  });
  cleanups.push(() => handle.close());
  return { handle, lines };
}

async function startHttpWithFiles(): Promise<HttpServerHandle> {
  return (await startHttp({ dir: files().dir })).handle;
}

function expectNotFound(response: RawResponse): void {
  expect(response.status).toBe(404);
  expect(JSON.parse(response.body)).toEqual({ error: 'Not found' });
  expect(response.body).not.toContain(OUTSIDE_JSON);
}

async function listenOnFreePort(): Promise<Server> {
  const server = createTcpServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  );
  return server;
}

function warnings(lines: Record<string, unknown>[], pattern: RegExp): Record<string, unknown>[] {
  return lines.filter(
    (line) => line.level === 40 && typeof line.msg === 'string' && pattern.test(line.msg),
  );
}

async function connectHttpClient(url: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: AUTH },
  });
  const client = new Client({ name: 'tradingview-mcp-tests', version: '0.0.0' });
  await client.connect(transport as Transport);
  cleanups.push(() => client.close());
  return client;
}

interface CliRun {
  port: number;
  lines: Record<string, unknown>[];
  stderr: CaptureStream;
  signals: EventEmitter;
  stdin: PassThrough;
  stdout: PassThrough;
  running: Promise<number>;
}

// The CLI in process, as `tradingview-desktop-mcp <argv> --port <port>`, offline, with the
// dashboard files of `dashboardDir` (null: none were built). It runs until a signal or, over
// stdio, until its input ends.
function runServer(
  argv: string[],
  {
    env = {},
    port,
    dashboardDir,
  }: { env?: NodeJS.ProcessEnv; port: number; dashboardDir: string | null },
): CliRun {
  const { logger, lines } = capturingLogger();
  const signals = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new CaptureStream();
  const running = runCli(
    [...argv, '--port', String(port)],
    { TV_CDP_PORT: '9', ...env },
    { stdin, stdout, stderr, process: signals },
    {
      logger,
      launcher: refusingLauncher(),
      connection: unreachableConnection(logger),
      dashboardDir,
    },
  );
  return { port, lines, stderr, signals, stdin, stdout, running };
}

test('the dashboard index is served at / without a token, with the security headers', async () => {
  const handle = await startHttpWithFiles();

  const page = await send(handle.port, { path: '/', headers: HTML });
  const asset = await send(handle.port, { path: '/assets/index-abc123.js' });
  // The page's own requests come with its Origin.
  const fromPage = await send(handle.port, {
    path: '/assets/index-abc123.js',
    headers: { Origin: `http://127.0.0.1:${String(handle.port)}` },
  });

  expect(page.status).toBe(200);
  expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
  expect(page.headers).toMatchObject(SECURITY_HEADERS);
  expect(page.headers['www-authenticate']).toBeUndefined();
  expect(page.body).toBe(INDEX_HTML);
  expect(asset.status).toBe(200);
  expect(asset.headers['content-type']).toBe('text/javascript; charset=utf-8');
  expect(asset.headers).toMatchObject(SECURITY_HEADERS);
  expect(asset.body).toBe(ASSET_JS);
  expect(fromPage.status).toBe(200);
});

test('the dashboard files keep the Host and Origin checks', async () => {
  const handle = await startHttpWithFiles();

  const host = await send(handle.port, {
    path: '/',
    headers: { ...HTML, Host: `evil.example:${String(handle.port)}` },
  });
  const origin = await send(handle.port, {
    path: '/assets/index-abc123.js',
    headers: { Origin: 'https://evil.example' },
  });

  expect(host.status).toBe(403);
  expect(host.body).not.toContain(INDEX_HTML);
  expect(origin.status).toBe(403);
  expect(origin.body).not.toContain(ASSET_JS);
});

test('an unknown route that accepts html falls back to index.html, and a missing asset is 404', async () => {
  const handle = await startHttpWithFiles();

  for (const path of ['/log', '/tools', '/tools/chart_get_state']) {
    const response = await send(handle.port, { path, headers: HTML });
    expect({ path, status: response.status }).toEqual({ path, status: 200 });
    expect(response.body).toBe(INDEX_HTML);
  }
  const missingAsset = await send(handle.port, { path: '/assets/missing.js', headers: HTML });
  const missingPage = await send(handle.port, { path: '/log' });

  expectNotFound(missingAsset);
  expect(missingAsset.headers).toMatchObject(SECURITY_HEADERS);
  expectNotFound(missingPage);
  // The paths of MCP and of the API never fall back to the page.
  for (const path of ['/mcpx', '/mcp/a/b', '/apix', '/api', '/api/nothing']) {
    const response = await send(handle.port, { path, headers: HTML });
    expect({ path, page: response.body === INDEX_HTML }).toEqual({ path, page: false });
    expect(response.headers['content-security-policy']).toBeUndefined();
  }
});

test('path traversal is 404', async () => {
  const handle = await startHttpWithFiles();

  for (const path of [
    '/../package.json',
    '/assets/../../package.json',
    '/%2e%2e/x',
    '/%2e%2e/package.json',
    '/..%2fpackage.json',
    '/index.html%00',
    '/%00/package.json',
    '/..\\package.json',
    '/..%5Cpackage.json',
  ]) {
    for (const headers of [{}, HTML]) {
      const response = await send(handle.port, { path, headers });
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
      expectNotFound(response);
    }
  }
});

test('assets are immutable and the index is not cached', async () => {
  const handle = await startHttpWithFiles();

  const asset = await send(handle.port, { path: '/assets/index-abc123.js' });
  const root = await send(handle.port, { path: '/' });
  const index = await send(handle.port, { path: '/index.html' });
  const page = await send(handle.port, { path: '/log', headers: HTML });

  expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  for (const response of [root, index, page]) {
    expect(response.headers['cache-control']).toBe('no-cache');
  }
});

test('/mcp still needs its token and /api still needs its token when the dashboard is served', async () => {
  const handle = await startHttpWithFiles();

  const mcp = await send(handle.port, {
    method: 'POST',
    path: '/mcp',
    headers: MCP_HEADERS,
    body: INITIALIZE,
  });
  const mcpPage = await send(handle.port, { path: '/mcp', headers: HTML });
  const api = await send(handle.port, { path: '/api/info', headers: HTML });
  const mcpWithToken = await send(handle.port, {
    method: 'POST',
    path: '/mcp',
    headers: { ...MCP_HEADERS, ...AUTH },
    body: INITIALIZE,
  });
  const apiWithToken = await send(handle.port, { path: '/api/info', headers: AUTH });

  for (const response of [mcp, mcpPage, api]) {
    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');
  }
  expect(mcpWithToken.status).toBe(200);
  expect(apiWithToken.status).toBe(200);
});

// One answer for a missing or wrong token, wherever it was needed.
test('a wrong token gets the same 401 from /api and from /mcp, with no-store', async () => {
  const handle = await startHttpWithFiles();
  const wrong = { Authorization: 'Bearer not-the-token' };

  const api = await send(handle.port, { path: '/api/info', headers: wrong });
  const mcp = await send(handle.port, {
    method: 'POST',
    path: '/mcp',
    headers: { ...MCP_HEADERS, ...wrong },
    body: INITIALIZE,
  });

  for (const response of [api, mcp]) {
    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toBe('application/json');
    expect(response.headers['www-authenticate']).toBe('Bearer');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(response.body)).toEqual({ error: 'Invalid token' });
  }
});

test('every /api answer of the transport, 401, 403 and 404 alike, carries Cache-Control: no-store', async () => {
  const { handle } = await startHttp({ dir: null });
  const config = testConfig({ transport: 'http', authToken: TOKEN, httpPort: 0 });
  const { logger } = capturingLogger();
  const bare = await startHttpTransport({
    config,
    logger,
    createServer: () => {
      throw new Error('No MCP request is made');
    },
  });
  cleanups.push(() => bare.close());

  const answers = [
    await send(handle.port, { path: '/api/info' }),
    await send(handle.port, { path: '/api/info', headers: { Authorization: 'Bearer wrong' } }),
    await send(handle.port, { path: `/api/info?token=${TOKEN}`, headers: AUTH }),
    await send(handle.port, {
      path: '/api/info',
      headers: { ...AUTH, Host: `evil.example:${String(handle.port)}` },
    }),
    await send(handle.port, {
      path: '/api/info',
      headers: { ...AUTH, Origin: 'https://evil.example' },
    }),
    // The transport without a dashboard has no API at all.
    await send(bare.port, { path: '/api/info', headers: AUTH }),
  ];

  expect(answers.map(({ status }) => status)).toEqual([401, 401, 401, 403, 403, 404]);
  for (const response of answers) {
    expect(response.headers['cache-control']).toBe('no-store');
  }
});

test('HTTP mode without built dashboard files logs one warning and still serves MCP', async () => {
  const server = runServer(['--transport', 'http'], {
    env: { TV_MCP_AUTH_TOKEN: TOKEN },
    port: await freePort(),
    dashboardDir: null,
  });
  const endpoint = `http://127.0.0.1:${String(server.port)}/mcp`;
  await expect.poll(() => server.stderr.text, { timeout: 5000 }).toContain(endpoint);

  const client = await connectHttpClient(endpoint);
  const { tools } = await client.listTools();
  const api = await send(server.port, { path: '/api/info', headers: AUTH });
  const page = await send(server.port, { path: '/', headers: HTML });

  expect(tools.length).toBeGreaterThan(0);
  expect(api.status).toBe(200);
  expectNotFound(page);
  expect(warnings(server.lines, FILES_NOT_FOUND)).toHaveLength(1);
  // There is no page to point at.
  expect(server.stderr.text).not.toMatch(/dashboard +http/);
  server.signals.emit('SIGTERM');
  expect(await server.running).toBe(0);
});

test('--no-dashboard in HTTP mode serves neither the files nor /api', async () => {
  const server = runServer(['--transport', 'http', '--no-dashboard'], {
    env: { TV_MCP_AUTH_TOKEN: TOKEN },
    port: await freePort(),
    dashboardDir: files().dir,
  });
  await expect
    .poll(() => server.stderr.text, { timeout: 5000 })
    .toContain(`http://127.0.0.1:${String(server.port)}/mcp`);

  const answers = [
    await send(server.port, { path: '/', headers: HTML }),
    await send(server.port, { path: '/log', headers: HTML }),
    await send(server.port, { path: '/assets/index-abc123.js' }),
    await send(server.port, { path: '/api/info', headers: AUTH }),
  ];

  for (const response of answers) {
    expectNotFound(response);
  }
  expect(warnings(server.lines, FILES_NOT_FOUND)).toEqual([]);
  expect(server.stderr.text).not.toMatch(/dashboard +http/);
  server.signals.emit('SIGTERM');
  expect(await server.running).toBe(0);
});

test('stdio with --dashboard and a token serves the dashboard and the API but not /mcp', async () => {
  const server = runServer(['--dashboard'], {
    env: { TV_MCP_AUTH_TOKEN: TOKEN },
    port: await freePort(),
    dashboardDir: files().dir,
  });
  const client = await connectStdioClient(server.stdout, server.stdin);
  cleanups.push(() => client.close());
  const url = `http://127.0.0.1:${String(server.port)}/`;
  await expect
    .poll(() => server.stderr.text, { timeout: 5000 })
    .toMatch(new RegExp(`dashboard +${url.replaceAll('.', '\\.')}\n`));

  const { tools } = await client.listTools();
  const page = await send(server.port, { path: '/', headers: HTML });
  const health = await send(server.port, { path: '/healthz' });
  const info = await send(server.port, { path: '/api/info', headers: AUTH });
  const anonymous = await send(server.port, { path: '/api/info' });
  const mcp = await send(server.port, {
    method: 'POST',
    path: '/mcp',
    headers: { ...MCP_HEADERS, ...AUTH },
    body: INITIALIZE,
  });
  const mcpPage = await send(server.port, { path: '/mcp', headers: HTML });
  const mcpPathToken = await send(server.port, { path: `/mcp/${TOKEN}`, headers: HTML });
  const host = await send(server.port, {
    path: '/',
    headers: { ...HTML, Host: `evil.example:${String(server.port)}` },
  });

  expect(tools.length).toBeGreaterThan(0);
  expect(page.status).toBe(200);
  expect(page.body).toBe(INDEX_HTML);
  expect(page.headers).toMatchObject(SECURITY_HEADERS);
  expect(health.status).toBe(200);
  expect(info.status).toBe(200);
  expect(JSON.parse(info.body) as DashboardInfo).toMatchObject({
    transport: 'stdio',
    mcpEndpoint: null,
  });
  expect(anonymous.status).toBe(401);
  for (const response of [mcp, mcpPage, mcpPathToken]) {
    expectNotFound(response);
  }
  expect(host.status).toBe(403);

  server.stdin.end();
  expect(await server.running).toBe(0);
  await expect(send(server.port, { path: '/healthz' })).rejects.toMatchObject({
    code: 'ECONNREFUSED',
  });
});

// From the sources, before a build, a development server serves the page and asks this listener
// for the API.
test('stdio with --dashboard and no built files serves the API alone, with one warning', async () => {
  const server = runServer(['--dashboard'], {
    env: { TV_MCP_AUTH_TOKEN: TOKEN },
    port: await freePort(),
    dashboardDir: null,
  });
  const client = await connectStdioClient(server.stdout, server.stdin);
  cleanups.push(() => client.close());
  await expect.poll(() => server.stderr.text, { timeout: 5000 }).toMatch(/transport +stdio/);

  const info = await send(server.port, { path: '/api/info', headers: AUTH });
  const page = await send(server.port, { path: '/', headers: HTML });

  expect(info.status).toBe(200);
  expectNotFound(page);
  expect(warnings(server.lines, FILES_NOT_FOUND)).toEqual([
    expect.objectContaining({
      // What a user of the package can do, and what a developer can.
      msg: expect.stringMatching(/package is incomplete: reinstall it\..*pnpm build/) as string,
    }),
  ]);
  // There is no page to point at, so neither the banner nor the log names one.
  expect(server.stderr.text).not.toMatch(/dashboard +http/);
  expect(server.lines).not.toContainEqual(
    expect.objectContaining({ msg: 'The dashboard is served' }),
  );
  server.stdin.end();
  expect(await server.running).toBe(0);
});

// The dashboard listener must not outlive the CLI, whatever went wrong before it was closed.
test('stdio with --dashboard closes the dashboard even when the MCP server fails to close', async () => {
  const failingClose = vi
    .spyOn(McpServer.prototype, 'close')
    .mockRejectedValueOnce(new Error('Synthetic close failure'));
  cleanups.push(() => {
    failingClose.mockRestore();
  });
  const server = runServer(['--dashboard'], {
    env: { TV_MCP_AUTH_TOKEN: TOKEN },
    port: await freePort(),
    dashboardDir: files().dir,
  });
  await expect
    .poll(() => server.stderr.text, { timeout: 5000 })
    .toMatch(/dashboard +http:\/\/127\.0\.0\.1:/);
  expect((await send(server.port, { path: '/healthz' })).status).toBe(200);

  server.signals.emit('SIGTERM');

  expect(await server.running).toBe(1);
  expect(failingClose).toHaveBeenCalledTimes(1);
  expect(server.stderr.text).toContain('Synthetic close failure');
  await expect(send(server.port, { path: '/healthz' })).rejects.toMatchObject({
    code: 'ECONNREFUSED',
  });
});

test('stdio with --dashboard and no token logs that TV_MCP_AUTH_TOKEN is needed and starts no listener', async () => {
  const server = runServer(['--dashboard'], { port: await freePort(), dashboardDir: files().dir });
  const client = await connectStdioClient(server.stdout, server.stdin);
  cleanups.push(() => client.close());
  await expect.poll(() => server.stderr.text, { timeout: 5000 }).toMatch(/transport +stdio/);

  const { tools } = await client.listTools();

  expect(tools.length).toBeGreaterThan(0);
  expect(warnings(server.lines, NEEDS_TOKEN)).toHaveLength(1);
  expect(server.stderr.text).not.toMatch(/dashboard +http/);
  await expect(send(server.port, { path: '/healthz' })).rejects.toMatchObject({
    code: 'ECONNREFUSED',
  });
  server.stdin.end();
  expect(await server.running).toBe(0);
});

test('stdio with --dashboard on a taken port logs a warning and the MCP server keeps answering', async () => {
  const blocker = await listenOnFreePort();
  const port = (blocker.address() as AddressInfo).port;
  const server = runServer(['--dashboard'], {
    env: { TV_MCP_AUTH_TOKEN: TOKEN },
    port,
    dashboardDir: files().dir,
  });
  const client = await connectStdioClient(server.stdout, server.stdin);
  cleanups.push(() => client.close());
  await expect.poll(() => server.stderr.text, { timeout: 5000 }).toMatch(/transport +stdio/);

  const { tools } = await client.listTools();
  const answer = await client.readResource({ uri: 'tradingview://app/health' });

  expect(tools.length).toBeGreaterThan(0);
  expect(answer.contents).toHaveLength(1);
  const refused = server.lines.filter((line) => line.level === 40 && line.port === port);
  expect(refused).toEqual([
    expect.objectContaining({
      msg: expect.stringContaining(`127.0.0.1:${String(port)}`) as string,
    }),
  ]);
  expect(server.stderr.text).not.toMatch(/dashboard +http/);
  server.stdin.end();
  expect(await server.running).toBe(0);
});

test('the dashboard next to stdio gives up with a warning on any listen error', async () => {
  const config = testConfig({ authToken: TOKEN, httpHost: '192.0.2.1', httpPort: 0 });
  const { api, logger, lines } = dashboardApi(config);

  const handle = await startDashboardServer({ config, logger, api });

  expect(handle).toBeNull();
  expect(lines).toContainEqual(
    expect.objectContaining({
      level: 40,
      host: '192.0.2.1',
      msg: expect.stringContaining('192.0.2.1') as string,
    }),
  );
});

test('the dashboard next to stdio refuses to start without a token', async () => {
  const config = testConfig({ httpPort: 0 });
  const { api, logger } = dashboardApi(config);

  await expect(startDashboardServer({ config, logger, api })).rejects.toMatchObject({
    code: 'INVALID_INPUT',
    message: expect.stringContaining('TV_MCP_AUTH_TOKEN') as string,
  });
});

test('the dashboard next to stdio ends its event streams and closes its API when it closes', async () => {
  const config = testConfig({ authToken: TOKEN, httpPort: 0 });
  const { api, logger, lines, events } = dashboardApi(config);
  let closedApi = 0;
  const watched: DashboardApi = {
    handle: (req, res, path) => api.handle(req, res, path),
    close: () => {
      closedApi += 1;
      api.close();
    },
  };
  const handle = await startDashboardServer({ config, logger, api: watched });
  if (handle === null) {
    throw new Error('The dashboard did not start');
  }
  const port = Number(new URL(handle.url).port);
  const client = await openEventStream(port, { headers: AUTH });
  cleanups.push(() => {
    client.close();
  });
  expect(events.subscribers).toBe(1);

  await Promise.all([handle.close(), handle.close()]);

  expect(closedApi).toBe(1);
  expect(await client.ended).toBe('end');
  expect(events.subscribers).toBe(0);
  expect(handle.url).toBe(`http://127.0.0.1:${String(port)}/`);
  // The token is short, which the dashboard says as the HTTP transport does.
  expect(warnings(lines, /shorter than 32 characters/)).toHaveLength(1);
  await expect(send(port, { path: '/healthz' })).rejects.toMatchObject({
    code: 'ECONNREFUSED',
  });
});
