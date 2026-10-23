import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { freePort } from '../test/helpers/dashboard-client.js';
import { startFakeCdpServer, type FakeCdpServer } from '../test/helpers/fake-cdp/server.js';
import { loadTargetsFixture } from '../test/helpers/fake-cdp/targets.js';
import { loadTvFixture } from '../test/helpers/fake-tv/fixture.js';
import { createFakeTvWindow } from '../test/helpers/fake-tv/window.js';

// The server of the dashboard's real-server end-to-end tests (the real project of
// packages/dashboard/playwright.config.ts, which runs this with tsx): the built CLI as it ships,
// serving over HTTP with the dashboard, on a free port and with a token made for the run.
// - By default it talks to the fake TradingView of the server's tests, which this script starts.
// - With TV_E2E=1 it talks to the user's TradingView, at 127.0.0.1:9222 or at TV_CDP_HOST and
//   TV_CDP_PORT. The server then offers chart_get_state alone, from the readonly profile, so that
//   nothing the tests do can change the app. What the server writes is dropped unread, because it
//   can name the user's chart.
//
// Once the server answers, the script writes its address and token as JSON to the file that
// DASHBOARD_E2E_SERVER_FILE names, readable by the user alone, and prints a line without the token
// that Playwright waits for. On SIGTERM or SIGINT, as Playwright stops it, and when the server
// exits, it stops the server and the fake app and removes the file.
//
// Usage: DASHBOARD_E2E_SERVER_FILE=<path> [TV_E2E=1] tsx scripts/dashboard-e2e-server.ts

const READY_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;

const PACKAGE = fileURLToPath(new URL('../', import.meta.url));
const CLI = join(PACKAGE, 'dist/cli.js');
const DASHBOARD_INDEX = join(PACKAGE, 'dist/dashboard/index.html');
// What the bundle and its copy of the dashboard are built from.
const SERVER_INPUTS = ['src', 'package.json', 'tsup.config.ts'].map((path) => join(PACKAGE, path));
const DASHBOARD_INPUTS = ['../dashboard/src', '../dashboard/index.html'].map((path) =>
  join(PACKAGE, path),
);

function fail(message: string): never {
  console.error(`dashboard-e2e-server: ${message}`);
  process.exit(1);
}

// The newest modification time under `path`.
function lastChangeMs(path: string): number {
  const stats = statSync(path);
  if (!stats.isDirectory()) {
    return stats.mtimeMs;
  }
  return Math.max(0, ...readdirSync(path).map((name) => lastChangeMs(join(path, name))));
}

// The tests are of the package as it ships, so it must be built from the sources as they are now.
function checkBuild(): void {
  for (const [built, inputs] of [
    [CLI, SERVER_INPUTS],
    [DASHBOARD_INDEX, DASHBOARD_INPUTS],
  ] as const) {
    if (!existsSync(built)) {
      fail(`${built} is missing: run pnpm build first`);
    }
    const builtMs = statSync(built).mtimeMs;
    const changed = inputs.filter((input) => lastChangeMs(input) > builtMs);
    if (changed.length > 0) {
      fail(`${built} is older than ${changed.join(', ')}: run pnpm build first`);
    }
  }
}

async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

// What stops everything the script started, once: the server, the fake app and the file. Set as
// soon as there is something to stop. `signaled` says that a signal stops the script: Playwright
// sends it to the whole process group, the server included, which then stops on its own, and a
// second signal would make it quit at once instead.
let stop: (code: number, signaled?: boolean) => Promise<never> = (code) => process.exit(code);

async function main(): Promise<void> {
  const serverFile = process.env.DASHBOARD_E2E_SERVER_FILE;
  if (serverFile === undefined || serverFile === '') {
    fail('set DASHBOARD_E2E_SERVER_FILE to the file the address and token go to');
  }
  const realApp = process.env.TV_E2E === '1';
  checkBuild();

  let app: FakeCdpServer | undefined;
  if (!realApp) {
    const win = createFakeTvWindow(loadTvFixture());
    app = await startFakeCdpServer({ targets: loadTargetsFixture({ chartWindow: () => win }) });
  }

  const port = await freePort();
  const token = randomBytes(32).toString('hex');
  const url = `http://127.0.0.1:${String(port)}`;
  // Only what a client passes on, and not the TV_* settings of the developer's shell, except where
  // the user's TradingView listens.
  const env: Record<string, string> = {
    ...getDefaultEnvironment(),
    TV_MCP_AUTH_TOKEN: token,
    TV_MCP_HTTP_HOST: '127.0.0.1',
    TV_MCP_HTTP_PORT: String(port),
    TV_MCP_LOG_LEVEL: 'warn',
    NO_COLOR: '1',
  };
  if (app === undefined) {
    // The user's TradingView: one tool, which only reads.
    env.TV_MCP_PROFILE = 'readonly';
    env.TV_MCP_TOOLS = 'chart_get_state';
    for (const name of ['TV_CDP_HOST', 'TV_CDP_PORT']) {
      const value = process.env[name];
      if (value !== undefined) {
        env[name] = value;
      }
    }
  } else {
    env.TV_CDP_PORT = String(app.port);
    env.TV_CALL_TIMEOUT_MS = '5000';
  }

  const child = spawn(process.execPath, [CLI, '--transport', 'http'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve();
    });
  });
  let stopping: Promise<never> | undefined;
  stop = (code, signaled = false) => {
    stopping ??= (async () => {
      rmSync(serverFile, { force: true });
      if (child.exitCode === null && child.signalCode === null) {
        if (!signaled) {
          child.kill('SIGTERM');
        }
        const timer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
        await exited;
        clearTimeout(timer);
      }
      await app?.close();
      return process.exit(code);
    })();
    return stopping;
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void stop(0, true);
    });
  }

  // Kept to explain a server that fails against the fake app; dropped unread against the user's.
  let output = '';
  const keep = (chunk: Buffer): void => {
    if (!realApp) {
      output += chunk.toString('utf8');
    }
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  void exited.then(() => {
    if (stopping === undefined) {
      const why = realApp
        ? 'its output is not shown, as it can name the chart: run it by hand to see why'
        : `it wrote:\n${output}`;
      console.error(
        `dashboard-e2e-server: the server exited with ${String(child.exitCode)}; ${why}`,
      );
      void stop(1);
    }
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!(await answers(`${url}/healthz`))) {
    if (stopping !== undefined) {
      return;
    }
    if (Date.now() > deadline) {
      console.error(
        `dashboard-e2e-server: the server did not answer within ${String(READY_TIMEOUT_MS)} ms`,
      );
      await stop(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // A file left by a run that was killed would keep the mode it was made with.
  rmSync(serverFile, { force: true });
  writeFileSync(serverFile, JSON.stringify({ url, token }), { mode: 0o600 });
  const against = realApp ? 'your TradingView, read-only' : 'the fake TradingView';
  console.log(`dashboard-e2e-server: ready at ${url}/, against ${against}`);
}

main().catch(async (error: unknown) => {
  console.error(`dashboard-e2e-server: ${error instanceof Error ? error.message : String(error)}`);
  await stop(1);
});
