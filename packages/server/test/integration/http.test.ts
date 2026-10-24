import { request, type IncomingHttpHeaders } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from '../../src/config/schema.js';
import { ToolEventBus } from '../../src/core/events.js';
import { createMcpServer, type ServerDeps } from '../../src/server.js';
import {
  startHttpTransport,
  type HttpServerHandle,
  type HttpTransportOptions,
} from '../../src/transports/http.js';
import { failureOf } from '../helpers/failure-of.js';
import {
  capturingLogger,
  refusingLauncher,
  testConfig,
  unreachableConnection,
} from '../helpers/tool-context.js';

const TOKEN = 'test-token';
const AUTH = { Authorization: `Bearer ${TOKEN}` };
// What a Streamable HTTP client sends with every message.
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
const PING = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' });

// Everything a test starts is closed here, newest first, so a client goes before its server.
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

interface Started {
  handle: HttpServerHandle;
  lines: Record<string, unknown>[];
  // The MCP servers the transport asked for, one per session or stray request.
  servers: McpServer[];
}

// A transport on a free port with the token TOKEN. Its servers share one set of dependencies, as
// the servers of one process do, and none of them can reach an app.
async function start(
  overrides: Partial<Config> = {},
  options: Partial<HttpTransportOptions> = {},
): Promise<Started> {
  const config = testConfig({ transport: 'http', authToken: TOKEN, httpPort: 0, ...overrides });
  const { logger, lines } = capturingLogger();
  const deps: ServerDeps = {
    connection: unreachableConnection(logger),
    launcher: refusingLauncher(),
    logger,
    events: new ToolEventBus(),
  };
  const servers: McpServer[] = [];
  const handle = await startHttpTransport({
    config,
    logger,
    createServer: () => {
      const { server } = createMcpServer(config, deps);
      servers.push(server);
      return server;
    },
    ...options,
  });
  cleanups.push(() => handle.close());
  return { handle, lines, servers };
}

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

interface RawRequest {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
}

// A request with exactly these headers (node adds Host unless one is given), on a connection of its
// own, read to the end.
function send(
  port: number,
  { method = 'GET', path = '/mcp', headers = {}, body }: RawRequest = {},
) {
  return new Promise<RawResponse>((resolve, reject) => {
    const outgoing = request(
      { host: '127.0.0.1', port, method, path, headers, agent: false },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
        });
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text });
        });
        response.on('error', reject);
      },
    );
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

async function initialize(port: number): Promise<string> {
  const response = await send(port, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...AUTH },
    body: INITIALIZE,
  });
  const sessionId = response.headers['mcp-session-id'];
  if (response.status !== 200 || typeof sessionId !== 'string') {
    throw new Error(`initialize failed with ${String(response.status)}: ${response.body}`);
  }
  return sessionId;
}

function ping(port: number, sessionId: string): Promise<RawResponse> {
  return send(port, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...AUTH, 'Mcp-Session-Id': sessionId },
    body: PING,
  });
}

// The standalone event stream of a session, held open until close() is called.
function openStream(port: number, sessionId: string): Promise<{ status: number; close(): void }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: '/mcp',
        headers: { ...AUTH, Accept: 'text/event-stream', 'Mcp-Session-Id': sessionId },
        agent: false,
      },
      (response) => {
        // Destroying the request later makes the response emit an error about the reset.
        response.on('error', () => undefined);
        resolve({
          status: response.statusCode ?? 0,
          close: () => {
            outgoing.destroy();
          },
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

async function connectClient(url: URL, headers: Record<string, string> = {}) {
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  const client = new Client({ name: 'tradingview-mcp-tests', version: '0.0.0' });
  // The SDK types sessionId as an accessor that may return undefined, which
  // exactOptionalPropertyTypes does not accept for the optional member of its own Transport.
  await client.connect(transport as Transport);
  cleanups.push(() => client.close());
  return { client, transport };
}

function endedSessions(lines: Record<string, unknown>[], reason: string): unknown[] {
  return lines.filter((line) => line.reason === reason).map((line) => line.sessionId);
}

test('rejects requests without a token with 401', async () => {
  const { handle } = await start();

  const response = await send(handle.port, {
    method: 'POST',
    headers: MCP_HEADERS,
    body: INITIALIZE,
  });

  expect(response.status).toBe(401);
  expect(response.headers['www-authenticate']).toBe('Bearer');
  expect(JSON.parse(response.body)).toEqual({ error: expect.any(String) as string });
});

test('rejects a wrong token with 401, in the header or in the path', async () => {
  const { handle } = await start();

  const inHeader = await send(handle.port, {
    method: 'POST',
    headers: { ...MCP_HEADERS, Authorization: 'Bearer test-tokeN' },
    body: INITIALIZE,
  });
  const inPath = await send(handle.port, {
    method: 'POST',
    path: '/mcp/test-tokeN',
    headers: MCP_HEADERS,
    body: INITIALIZE,
  });

  expect(inHeader.status).toBe(401);
  expect(inPath.status).toBe(401);
  expect(inPath.headers['www-authenticate']).toBe('Bearer');
});

test('rejects a malformed path token with 401 instead of failing', async () => {
  const { handle } = await start();

  const response = await send(handle.port, {
    method: 'POST',
    path: '/mcp/%E0%A4%A',
    headers: MCP_HEADERS,
    body: INITIALIZE,
  });

  expect(response.status).toBe(401);
});

test('rejects a foreign Origin with 403', async () => {
  const { handle } = await start();

  const response = await send(handle.port, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...AUTH, Origin: 'https://evil.example' },
    body: INITIALIZE,
  });

  expect(response.status).toBe(403);
  expect(JSON.parse(response.body)).toEqual({ error: expect.stringContaining('Origin') as string });
});

test('accepts a request from a page the server served itself', async () => {
  const { handle } = await start();

  const response = await send(handle.port, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...AUTH, Origin: `http://localhost:${String(handle.port)}` },
    body: INITIALIZE,
  });

  expect(response.status).toBe(200);
});

// A web page whose name was rebound to 127.0.0.1 still sends its own name as the Host.
test('rejects a rebinding Host with 403, even with the right token', async () => {
  const { handle } = await start();
  const host = `evil.example:${String(handle.port)}`;

  const mcp = await send(handle.port, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...AUTH, Host: host },
    body: INITIALIZE,
  });
  const health = await send(handle.port, { path: '/healthz', headers: { Host: host } });

  expect(mcp.status).toBe(403);
  expect(JSON.parse(mcp.body)).toEqual({ error: expect.stringContaining('Host') as string });
  expect(health.status).toBe(403);
});

test('accepts every loopback name of the server as the Host', async () => {
  const { handle } = await start();
  const port = String(handle.port);

  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
    const response = await send(handle.port, { path: '/healthz', headers: { Host: host } });
    expect(response.status).toBe(200);
  }
});

const TUNNEL = 'abc.ngrok.app';
const TUNNEL_WARNING =
  'Extra allowed hosts are set and the profile is "full": anyone who reaches them with the token ' +
  'can control TradingView. Prefer --profile readonly behind a tunnel.';

function tunnelWarnings(lines: Record<string, unknown>[]): Record<string, unknown>[] {
  return lines.filter(
    (line) => typeof line.msg === 'string' && line.msg.startsWith('Extra allowed hosts are set'),
  );
}

test('a tunnel Host without a port is accepted on /mcp with the token, and still refused without it', async () => {
  const { handle } = await start({ allowedHosts: [TUNNEL] });

  // A tunnel forwards the request with the Host its client sent, which names no port for https.
  const accepted = await send(handle.port, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...AUTH, Host: TUNNEL },
    body: INITIALIZE,
  });
  const defaultPort = await send(handle.port, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...AUTH, Host: `${TUNNEL}:443` },
    body: INITIALIZE,
  });
  const pathToken = await send(handle.port, {
    method: 'POST',
    path: `/mcp/${TOKEN}`,
    headers: { ...MCP_HEADERS, Host: TUNNEL },
    body: INITIALIZE,
  });
  const anonymous = await send(handle.port, {
    method: 'POST',
    headers: { ...MCP_HEADERS, Host: TUNNEL },
    body: INITIALIZE,
  });
  const wrong = await send(handle.port, {
    method: 'POST',
    headers: { ...MCP_HEADERS, Authorization: 'Bearer not-the-token', Host: TUNNEL },
    body: INITIALIZE,
  });
  const otherHost = await send(handle.port, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...AUTH, Host: 'evil.example' },
    body: INITIALIZE,
  });
  const subdomain = await send(handle.port, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...AUTH, Host: `x.${TUNNEL}` },
    body: INITIALIZE,
  });

  expect(accepted.status).toBe(200);
  expect(accepted.headers['mcp-session-id']).toEqual(expect.any(String));
  expect(defaultPort.status).toBe(200);
  expect(pathToken.status).toBe(200);
  expect(anonymous.status).toBe(401);
  expect(wrong.status).toBe(401);
  expect(otherHost.status).toBe(403);
  expect(subdomain.status).toBe(403);
});

test('a tunnel Origin https://<host> is accepted and another origin is still refused', async () => {
  const { handle } = await start({ allowedHosts: [TUNNEL] });
  const fromOrigin = (origin: string) =>
    send(handle.port, {
      method: 'POST',
      headers: { ...MCP_HEADERS, ...AUTH, Host: TUNNEL, Origin: origin },
      body: INITIALIZE,
    });

  const tunnel = await fromOrigin(`https://${TUNNEL}`);
  // A host without a port lets in no page over plain http.
  const plain = await fromOrigin(`http://${TUNNEL}`);
  const foreign = await fromOrigin('https://evil.example');
  const sibling = await fromOrigin(`https://x.${TUNNEL}`);

  expect(tunnel.status).toBe(200);
  for (const response of [plain, foreign, sibling]) {
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      error: expect.stringContaining('Origin') as string,
    });
  }
});

test('an extra host:port matches only with its port, and lets its pages in over http too', async () => {
  const { handle } = await start({ allowedHosts: ['mymac.local:8443'] });

  const exact = await send(handle.port, {
    path: '/healthz',
    headers: { Host: 'mymac.local:8443', Origin: 'http://mymac.local:8443' },
  });
  const noPort = await send(handle.port, { path: '/healthz', headers: { Host: 'mymac.local' } });

  expect(exact.status).toBe(200);
  expect(noPort.status).toBe(403);
});

test('extra hosts with a profile other than readonly log the tunnel warning once', async () => {
  const { handle, lines } = await start({ allowedHosts: [TUNNEL], profile: 'full' });
  await send(handle.port, { path: '/healthz', headers: { Host: TUNNEL } });
  await initialize(handle.port);

  const warnings = tunnelWarnings(lines);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatchObject({ level: 40, msg: TUNNEL_WARNING });
  expect(JSON.stringify(lines)).not.toContain(TOKEN);

  const core = await start({ allowedHosts: [TUNNEL], profile: 'core' });
  expect(tunnelWarnings(core.lines).map((line) => line.msg)).toEqual([
    TUNNEL_WARNING.replace('"full"', '"core"'),
  ]);
  // Behind a tunnel readonly is the advice, and without extra hosts there is nothing to warn of.
  expect(
    tunnelWarnings((await start({ allowedHosts: [TUNNEL], profile: 'readonly' })).lines),
  ).toEqual([]);
  expect(tunnelWarnings((await start({ profile: 'full' })).lines)).toEqual([]);
});

test('loopback hosts keep working with extra hosts set', async () => {
  const { handle } = await start({ allowedHosts: [TUNNEL, 'mymac.local:8443'] });
  const port = String(handle.port);

  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
    const response = await send(handle.port, {
      path: '/healthz',
      headers: { Host: host, Origin: `http://${host}` },
    });
    expect(response.status).toBe(200);
  }
  expect(await initialize(handle.port)).toEqual(expect.any(String));
  // A rebinding Host on the bound port is refused as before.
  const rebinding = await send(handle.port, {
    path: '/healthz',
    headers: { Host: `evil.example:${port}` },
  });
  expect(rebinding.status).toBe(403);
});

test('accepts the token as a Bearer header', async () => {
  const { handle } = await start();

  const response = await send(handle.port, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...AUTH },
    body: INITIALIZE,
  });

  expect(response.status).toBe(200);
  expect(response.headers['mcp-session-id']).toEqual(expect.any(String));
  expect(response.body).toContain('"protocolVersion"');
});

test('accepts the token as a path segment', async () => {
  const { handle } = await start();

  const response = await send(handle.port, {
    method: 'POST',
    path: `/mcp/${TOKEN}`,
    headers: MCP_HEADERS,
    body: INITIALIZE,
  });

  expect(response.status).toBe(200);
  expect(response.headers['mcp-session-id']).toEqual(expect.any(String));
});

test('accepts a decoded path token and a trailing slash after /mcp', async () => {
  const { handle } = await start({ authToken: 'to/ken with space' });

  const encoded = await send(handle.port, {
    method: 'POST',
    path: '/mcp/to%2Fken%20with%20space',
    headers: MCP_HEADERS,
    body: INITIALIZE,
  });
  const slash = await send(handle.port, {
    method: 'POST',
    path: '/mcp/',
    headers: { ...MCP_HEADERS, Authorization: 'Bearer x' },
    body: INITIALIZE,
  });

  expect(encoded.status).toBe(200);
  // The trailing slash names no token, so the header is read, and this one is wrong.
  expect(slash.status).toBe(401);
});

test('serves /healthz without a token', async () => {
  const { handle } = await start();

  const response = await send(handle.port, { path: '/healthz' });

  expect(response.status).toBe(200);
  expect(JSON.parse(response.body)).toEqual({ ok: true });
});

test('answers 405 for a method a route does not take', async () => {
  const { handle } = await start();

  const mcp = await send(handle.port, { method: 'PUT', headers: AUTH });
  const health = await send(handle.port, { method: 'POST', path: '/healthz' });

  expect(mcp.status).toBe(405);
  expect(mcp.headers.allow).toBe('GET, POST, DELETE');
  expect(health.status).toBe(405);
  expect(health.headers.allow).toBe('GET, HEAD');
});

// The session id travels in a header anyone along the way can read, so it must never stand in for
// the token.
test('refuses a known session without the token', async () => {
  const { handle } = await start();
  const sessionId = await initialize(handle.port);

  const response = await send(handle.port, {
    method: 'POST',
    headers: { ...MCP_HEADERS, 'Mcp-Session-Id': sessionId },
    body: PING,
  });

  expect(response.status).toBe(401);
  expect((await ping(handle.port, sessionId)).status).toBe(200);
});

// A CORS preflight (OPTIONS) and a HEAD are not MCP requests. Without the token they learn no more
// than any other request; with it they are refused as methods /mcp does not take.
test.each(['OPTIONS', 'HEAD'])(
  'refuses %s on /mcp: 401 without the token, 405 with it',
  async (method) => {
    const { handle } = await start();

    const anonymous = await send(handle.port, { method });
    const authorized = await send(handle.port, { method, headers: AUTH });

    expect(anonymous.status).toBe(401);
    expect(authorized.status).toBe(405);
    expect(authorized.headers.allow).toBe('GET, POST, DELETE');
  },
);

test('answers 404 for any other path', async () => {
  const { handle } = await start();

  for (const path of ['/', '/api/tools', '/mcp/a/b', '/mcpx']) {
    const response = await send(handle.port, { path, headers: AUTH });
    expect(response.status).toBe(404);
  }
});

test('client lists tools over Streamable HTTP', async () => {
  const { handle } = await start();
  const { client } = await connectClient(new URL(handle.url), AUTH);

  const { tools } = await client.listTools();

  expect(tools.map(({ name }) => name)).toContain('batch_run');
});

test('client lists tools through the path token address', async () => {
  const { handle } = await start();
  const { client } = await connectClient(new URL(`${handle.url}/${TOKEN}`));

  const { tools } = await client.listTools();

  expect(tools.map(({ name }) => name)).toContain('batch_run');
});

test('every session gets a server of its own', async () => {
  const { handle, servers } = await start();
  await connectClient(new URL(handle.url), AUTH);
  await connectClient(new URL(handle.url), AUTH);

  expect(servers).toHaveLength(2);
  expect(servers[0]).not.toBe(servers[1]);
});

test('refuses a message without a session that does not start one, and drops its server', async () => {
  const { handle, servers } = await start();

  const response = await send(handle.port, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...AUTH },
    body: PING,
  });

  expect(response.status).toBe(400);
  expect(servers).toHaveLength(1);
  expect(servers[0]?.isConnected()).toBe(false);
});

test('refuses a stream or a deletion without a session', async () => {
  const { handle } = await start();

  const stream = await send(handle.port, {
    headers: { ...AUTH, Accept: 'text/event-stream' },
  });
  const deletion = await send(handle.port, { method: 'DELETE', headers: AUTH });

  expect(stream.status).toBe(400);
  expect(deletion.status).toBe(400);
});

test('answers 404 for a session it does not know', async () => {
  const { handle } = await start();

  const response = await ping(handle.port, 'no-such-session');

  expect(response.status).toBe(404);
});

test('a session ends when the client deletes it', async () => {
  const { handle, lines } = await start();
  const { transport } = await connectClient(new URL(handle.url), AUTH);
  const sessionId = transport.sessionId ?? '';
  expect((await ping(handle.port, sessionId)).status).toBe(200);

  await transport.terminateSession();

  expect((await ping(handle.port, sessionId)).status).toBe(404);
  // The transport alone would answer 404 too; the session must also be gone from the server.
  expect(endedSessions(lines, 'client')).toEqual([sessionId]);
});

test('a session stays open while a stream is open, and closes once it has been idle', async () => {
  // Long enough that the moment between the end of initialize and the opening of the stream, when
  // the session is idle, cannot close it even on a busy machine.
  const idleMs = 300;
  const { handle, lines } = await start({}, { sessionIdleTimeoutMs: idleMs });
  const sessionId = await initialize(handle.port);
  const stream = await openStream(handle.port, sessionId);
  expect(stream.status).toBe(200);

  // Three idle periods pass while the stream is open.
  await sleep(3 * idleMs);
  expect((await ping(handle.port, sessionId)).status).toBe(200);
  // That request ended while the stream stayed open, which must not start the idle clock.
  await sleep(3 * idleMs);
  expect((await ping(handle.port, sessionId)).status).toBe(200);

  stream.close();
  await expect.poll(() => endedSessions(lines, 'idle'), { timeout: 5000 }).toContain(sessionId);
  expect((await ping(handle.port, sessionId)).status).toBe(404);
});

test('logs never contain the token', async () => {
  const { handle, lines } = await start();

  await send(handle.port, {
    method: 'POST',
    path: `/mcp/${TOKEN}`,
    headers: MCP_HEADERS,
    body: INITIALIZE,
  });
  // A wrong token can be a real one with a typo, so it is kept out of the logs as well.
  await send(handle.port, {
    method: 'POST',
    path: '/mcp/not-the-token',
    headers: MCP_HEADERS,
    body: INITIALIZE,
  });
  await send(handle.port, {
    method: 'POST',
    headers: { ...MCP_HEADERS, Authorization: 'Bearer not-the-token' },
    body: INITIALIZE,
  });

  const logged = JSON.stringify(lines);
  expect(logged).not.toContain(TOKEN);
  expect(logged).not.toContain('not-the-token');
  // The refusal was logged, with the path in a form that names no token.
  expect(lines).toContainEqual(expect.objectContaining({ path: '/mcp/<redacted>' }));
});

// A token may hold a slash, and a client may send it as it is or percent-encoded in any case.
const SLASHED_TOKEN = 'Sekrit1/Sekrit2/Sekrit3';
const TOKEN_PARTS = ['Sekrit1', 'Sekrit2', 'Sekrit3'];
const foreignHost = (port: number) => ({ Host: `evil.example:${String(port)}` });
const foreignOrigin = () => ({ Origin: 'https://evil.example' });
const noHeaders = () => ({});

test.each<[string, string, (port: number) => Record<string, string>, number]>([
  ['a refused Host', '/mcp/Sekrit1/Sekrit2/Sekrit3', foreignHost, 403],
  ['a refused Origin', '/mcp/Sekrit1/Sekrit2/Sekrit3', foreignOrigin, 403],
  ['an unknown path under /mcp', '/mcp/Sekrit1/Sekrit2/Sekrit3', noHeaders, 404],
  // Not the whole token, so only cutting everything after /mcp/ keeps its parts out.
  ['a truncated token under /mcp', '/mcp/Sekrit1/Sekrit2', noHeaders, 404],
  ['an unknown path elsewhere', '/x/Sekrit1/Sekrit2/Sekrit3', noHeaders, 404],
  ['a refused Host, encoded', '/mcp/Sekrit1%2FSekrit2%2FSekrit3', foreignHost, 403],
  ['a refused Origin, encoded', '/mcp/Sekrit1%2FSekrit2%2FSekrit3', foreignOrigin, 403],
  ['an unknown path, encoded in lower case', '/x/Sekrit1%2fSekrit2%2fSekrit3', noHeaders, 404],
  // An escape that does not decode must not keep the encoded token after it from being found.
  ['a malformed escape before it', '/x/%E0%A4/Sekrit1%2FSekrit2%2FSekrit3', noHeaders, 404],
])(
  'no part of a token with a slash reaches the logs, for %s',
  async (_case, path, headers, status) => {
    const { handle, lines } = await start({ authToken: SLASHED_TOKEN });

    const response = await send(handle.port, { path, headers: headers(handle.port) });

    expect(response.status).toBe(status);
    // The request was logged, so the check below is not vacuous.
    await expect.poll(() => lines.some((line) => 'path' in line)).toBe(true);
    const logged = JSON.stringify(lines);
    for (const part of TOKEN_PARTS) {
      expect(logged).not.toContain(part);
    }
  },
);

test('an unexpected failure is answered with 500, logged, and does not stop the server', async () => {
  const { logger, lines } = capturingLogger();
  const handle = await startHttpTransport({
    config: testConfig({ transport: 'http', authToken: TOKEN, httpPort: 0 }),
    logger,
    createServer: () => {
      throw new Error('boom');
    },
  });
  cleanups.push(() => handle.close());

  const failed = await send(handle.port, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...AUTH },
    body: INITIALIZE,
  });
  const health = await send(handle.port, { path: '/healthz' });

  expect(failed.status).toBe(500);
  expect(health.status).toBe(200);
  expect(lines).toContainEqual(
    expect.objectContaining({
      level: 50,
      err: expect.objectContaining({ stack: expect.stringContaining('boom') as string }) as unknown,
    }),
  );
});

test('the handle names the bound port and leaves the token out of the address', async () => {
  const { handle } = await start();

  expect(handle.port).toBeGreaterThan(0);
  expect(handle.url).toBe(`http://127.0.0.1:${String(handle.port)}/mcp`);
});

test('close() ends every session and stops listening', async () => {
  const { handle, servers } = await start();
  const sessionId = await initialize(handle.port);
  const stream = await openStream(handle.port, sessionId);
  expect(stream.status).toBe(200);

  await handle.close();

  expect(servers.map((server) => server.isConnected())).toEqual([false]);
  await expect(send(handle.port, { path: '/healthz' })).rejects.toMatchObject({
    code: 'ECONNREFUSED',
  });
});

test('fails to start when the port is taken', async () => {
  const { handle } = await start();

  const error = await failureOf(start({ httpPort: handle.port }));

  expect(error.code).toBe('INVALID_INPUT');
  expect(error.message).toContain(String(handle.port));
  expect(error.hint).toContain('--port');
});

test('fails to start on an address that belongs to another machine', async () => {
  // 192.0.2.0/24 is reserved for documentation, so no machine has it.
  const error = await failureOf(start({ httpHost: '192.0.2.1' }));

  expect(error.code).toBe('INVALID_INPUT');
  expect(error.message).toContain('192.0.2.1');
  expect(error.hint).toContain('--host');
});

test('refuses to start without a token', async () => {
  const { logger } = capturingLogger();
  const config = testConfig({ transport: 'http', httpPort: 0 });

  const error = await failureOf(
    startHttpTransport({
      config,
      logger,
      createServer: () => {
        throw new Error('A transport that did not start has no sessions');
      },
    }),
  );

  expect(error.code).toBe('INVALID_INPUT');
  expect(error.message).toContain('TV_MCP_AUTH_TOKEN');
});

// The endpoint may be tunnelled to the internet, where a short token can be guessed.
test('warns at startup when the token is shorter than 32 characters, without naming it', async () => {
  const { lines } = await start({ authToken: 'short-but-real' });

  expect(lines).toContainEqual(
    expect.objectContaining({
      level: 40,
      msg: expect.stringMatching(/TV_MCP_AUTH_TOKEN is shorter than 32 characters/) as string,
    }),
  );
  expect(JSON.stringify(lines)).not.toContain('short-but-real');
});

test('does not warn about a token of 32 characters', async () => {
  const { lines } = await start({ authToken: 'k'.repeat(32) });

  expect(lines.filter((line) => line.level === 40)).toEqual([]);
});
