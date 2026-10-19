import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import pkg from '../../package.json' with { type: 'json' };
import { ToolEventBus } from '../../src/core/events.js';
import { createMcpServer } from '../../src/server.js';
import { startStdioTransport } from '../../src/transports/stdio.js';
import { startFakeCdpServer, type FakeCdpServer } from '../helpers/fake-cdp/server.js';
import { loadTargetsFixture } from '../helpers/fake-cdp/targets.js';
import { loadTvFixture } from '../helpers/fake-tv/fixture.js';
import { createFakeTvWindow } from '../helpers/fake-tv/window.js';
import { connectStdioClient } from '../helpers/mcp-client.js';
import {
  quietLogger,
  refusingLauncher,
  testConfig,
  unreachableConnection,
} from '../helpers/tool-context.js';

const HEALTH_URI = 'tradingview://app/health';
const fixture = loadTvFixture();

// Everything a test starts is closed here, newest first.
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function offlineServer(): McpServer {
  return createMcpServer(testConfig(), {
    connection: unreachableConnection(),
    launcher: refusingLauncher(),
    logger: quietLogger,
    events: new ToolEventBus(),
  }).server;
}

function closedPromise(server: McpServer): Promise<void> {
  return new Promise((resolve) => {
    server.server.onclose = resolve;
  });
}

describe('startStdioTransport', () => {
  test('serves a client over the streams it is given', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = offlineServer();
    cleanups.push(() => server.close());

    await startStdioTransport(server, { stdin, stdout });
    const client = await connectStdioClient(stdout, stdin);
    cleanups.push(() => client.close());

    const { tools } = await client.listTools();
    expect(tools.map(({ name }) => name)).toEqual(['batch_run']);
  });

  // The client closing its end of the pipe is how a desktop client stops a stdio server. Each case
  // gives only one of the two signals: the stream that ends is never closed, and the stream that is
  // destroyed never ends.
  test.each([
    ['ends', () => new PassThrough({ emitClose: false }), (stream: PassThrough) => stream.end()],
    ['is destroyed', () => new PassThrough(), (stream: PassThrough) => stream.destroy()],
  ])('closes the server when its input %s', async (_how, createStdin, stop) => {
    const stdin = createStdin();
    const stdout = new PassThrough();
    const server = offlineServer();
    const closed = closedPromise(server);
    await startStdioTransport(server, { stdin, stdout });
    const client = await connectStdioClient(stdout, stdin);
    cleanups.push(() => client.close());
    await client.listTools();

    stop(stdin);

    await closed;
    expect(server.isConnected()).toBe(false);
  });

  // A client that died leaves a broken pipe, and the next write fails with EPIPE. Unhandled, that
  // error would be thrown from an event handler and end the process without a word.
  test('closes the server when its output breaks', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = offlineServer();
    const closed = closedPromise(server);
    await startStdioTransport(server, { stdin, stdout });

    stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));

    await closed;
    expect(server.isConnected()).toBe(false);
  });
});

// When a file, or anything in a directory, last changed.
function lastChangeMs(path: string): number {
  const stats = statSync(path);
  if (!stats.isDirectory()) {
    return stats.mtimeMs;
  }
  return Math.max(0, ...readdirSync(path).map((name) => lastChangeMs(join(path, name))));
}

describe('the built CLI over stdio', () => {
  const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
  // What the bundle is built from: the sources, the version it inlines, and the build settings.
  const inputs = ['src', 'package.json', 'tsup.config.ts'].map((path) =>
    fileURLToPath(new URL(`../../${path}`, import.meta.url)),
  );

  // These tests run the bundle that ships, as a client would start it, so it must be built from
  // the sources as they are now. They compare times instead of building, which would add a build
  // to every run: the gate builds first, and a forgotten build fails here, never silently.
  beforeAll(() => {
    if (!existsSync(cli)) {
      throw new Error(`${cli} is missing: run pnpm build before the integration tests`);
    }
    const builtMs = statSync(cli).mtimeMs;
    const changed = inputs.filter((input) => lastChangeMs(input) > builtMs);
    if (changed.length > 0) {
      throw new Error(
        `${cli} is older than ${changed.join(', ')}: run pnpm build before the integration tests`,
      );
    }
  });

  async function startApp(): Promise<FakeCdpServer> {
    const win = createFakeTvWindow(fixture);
    const app = await startFakeCdpServer({
      targets: loadTargetsFixture({ chartWindow: () => win }),
    });
    cleanups.push(() => app.close());
    return app;
  }

  // The real logger at its most talkative, so a log line that strayed onto stdout would show.
  function cliEnv(app: FakeCdpServer): Record<string, string> {
    return {
      TV_CDP_PORT: String(app.port),
      TV_CALL_TIMEOUT_MS: '5000',
      TV_MCP_LOG_LEVEL: 'debug',
      NO_COLOR: '1',
    };
  }

  interface Spawned {
    child: ChildProcess & { stdin: NonNullable<ChildProcess['stdin']> };
    output: { stdout: string; stderr: string };
    exited: Promise<number | null>;
  }

  function spawnCli(env: Record<string, string>): Spawned {
    const child = spawn(process.execPath, [cli], {
      // Only what a client passes on: no TV_* variable of the developer's shell.
      env: { ...getDefaultEnvironment(), ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = { stdout: '', stderr: '' };
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output.stdout += chunk;
    });
    // Drained even when unused: the logger writes to stderr synchronously, so a full pipe would
    // block the server.
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      output.stderr += chunk;
    });
    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => {
        resolve(code);
      });
    });
    cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    });
    return { child, output, exited };
  }

  // The ids of the responses among the complete lines written so far.
  function responseIds(stdout: string): unknown[] {
    return stdout
      .split('\n')
      .slice(0, -1)
      .flatMap((line) => {
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          return 'result' in message || 'error' in message ? [message.id] : [];
        } catch {
          return [];
        }
      });
  }

  function send(child: Spawned['child'], message: object): void {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  test('stdio client lists tools and reads the app health resource', async () => {
    const app = await startApp();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli],
      env: cliEnv(app),
      stderr: 'pipe',
    });
    transport.stderr?.on('data', () => undefined);
    const client = new Client({ name: 'tradingview-mcp-tests', version: '0.0.0' });
    await client.connect(transport);
    cleanups.push(() => client.close());

    const { tools } = await client.listTools();
    const read = await client.readResource({ uri: HEALTH_URI });

    expect(tools.map(({ name }) => name)).toContain('batch_run');
    const [content] = read.contents;
    const text = content !== undefined && 'text' in content ? content.text : '';
    expect(JSON.parse(text)).toMatchObject({
      cdp: { reachable: true, endpoint: `http://127.0.0.1:${String(app.port)}` },
      chart: { found: true, tabs: 1 },
      app: { ready: true, connected: true, buildTime: fixture.buildTime },
    });
  });

  test('stdio stdout carries only JSON-RPC', async () => {
    const app = await startApp();
    const { child, output, exited } = spawnCli(cliEnv(app));

    send(child, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'stdout-purity-test', version: '0.0.0' },
      },
    });
    await expect.poll(() => responseIds(output.stdout), { timeout: 15_000 }).toEqual([1]);
    send(child, { jsonrpc: '2.0', method: 'notifications/initialized' });
    send(child, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    // Reading the health opens a CDP session, which the server logs at debug level.
    send(child, { jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: HEALTH_URI } });
    await expect.poll(() => responseIds(output.stdout), { timeout: 15_000 }).toEqual([1, 2, 3]);
    child.stdin.end();

    expect(await exited).toBe(0);
    const lines = output.stdout.split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
    }
    // The banner and the log lines went to stderr instead.
    expect(output.stderr).toContain('tradingview-desktop-mcp');
    expect(output.stderr).toMatch(/transport +stdio/);
    const logLines = output.stderr.split('\n').filter((line) => line.startsWith('{"level":'));
    expect(logLines.length).toBeGreaterThan(0);
  });

  test.skipIf(process.platform === 'win32')(
    'the built CLI stops with exit code 0 on SIGTERM',
    async () => {
      const app = await startApp();
      const { child, output, exited } = spawnCli(cliEnv(app));
      // The banner comes once the server listens, and the signal handlers are in place by then.
      await expect.poll(() => output.stderr, { timeout: 15_000 }).toMatch(/transport +stdio/);

      child.kill('SIGTERM');

      expect(await exited).toBe(0);
    },
  );

  test('the built CLI prints its version', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [cli, '--version'], {
      env: getDefaultEnvironment(),
    });

    expect(stdout).toBe(`${pkg.version}\n`);
  });
});
