// Starts the built CLI twice and checks what a client sees. CI runs it on the oldest Node the
// package supports, where the test suites cannot run: Vitest needs Node 22 or newer, the bundle
// only needs 20.19.
// - Over stdio, the way an MCP client starts it: it answers the handshake, lists its tools, keeps
//   stdout for JSON-RPC and stops when its input closes.
// - Over HTTP, with a token made for the run and on a free port: it serves the dashboard page
//   without the token, answers the dashboard API only with it, and stops on SIGTERM.
//
// Plain JavaScript without dependencies, so that it runs wherever the bundle does.
// Usage, after `pnpm build`: node scripts/smoke-node20.mjs

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../packages/server/dist/cli.js', import.meta.url));
// A fast machine needs about a second for each leg. The margin is for a cold disk on a busy runner.
const TIMEOUT_MS = 20_000;
// The server has to stop on its own once its client closes its input, or once it gets SIGTERM.
const EXIT_GRACE_MS = 5_000;
// How often the HTTP leg asks whether the server answers yet.
const POLL_MS = 100;
// How much of the server's stderr a failure shows.
const STDERR_LINES = 12;
// Every tool of the full profile, which the server offers when nothing narrows it (serverEnv drops
// every TV_* variable): a bundle that registers fewer, or one twice, fails here.
const EXPECTED_TOOL_COUNT = 83;
// A server answers a version it knows with that version, and any other with its latest.
const PROTOCOL_VERSION = '2025-06-18';

class SmokeFailure extends Error {}

// A line of the server's stdout, shortened for a message.
function excerpt(line) {
  return JSON.stringify(line.length > 120 ? `${line.slice(0, 120)}...` : line);
}

// What a JSON-RPC 2.0 peer may send: a request or notification, which names a method, or a
// response, which says which request it answers and carries a result or an error.
function isJsonRpc(message) {
  if (typeof message !== 'object' || message === null || message.jsonrpc !== '2.0') {
    return false;
  }
  return (
    typeof message.method === 'string' ||
    ('id' in message && ('result' in message || 'error' in message))
  );
}

// No TV_* variable of the shell this runs in may change what the server does: a profile or a tool
// filter would hide the tools that are checked. Port 9 belongs to the discard service, so nothing
// listens there: the server cannot reach a TradingView debug port, and listing tools needs none.
function serverEnv() {
  const inherited = Object.entries(process.env).filter(([name]) => !name.startsWith('TV_'));
  return { ...Object.fromEntries(inherited), TV_CDP_PORT: '9', NO_COLOR: '1' };
}

// Starts the server and returns what the checks need. `problem` rejects at the first sign that the
// server broke the protocol or died, so that the checks do not wait for an answer that cannot come.
function startServer() {
  const child = spawn(process.execPath, [CLI, '--transport', 'stdio'], {
    env: serverEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let rejectProblem = () => undefined;
  const problem = new Promise((_resolve, reject) => {
    rejectProblem = reject;
  });
  // Without a handler, a rejection after the checks are over would end the process.
  problem.catch(() => undefined);
  const report = (reason) => {
    rejectProblem(new SmokeFailure(reason));
  };

  // The requests nobody has answered yet, by id.
  const pending = new Map();
  let buffer = '';
  let stderr = '';
  let expectExit = false;

  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        report(`stdout carries a line that is not JSON: ${excerpt(line)}`);
        continue;
      }
      if (!isJsonRpc(message)) {
        report(`stdout carries a line that is not a JSON-RPC 2.0 message: ${excerpt(line)}`);
        continue;
      }
      // A request or a notification of the server is valid, and nothing here needs to answer it.
      if (typeof message.method === 'string') {
        continue;
      }
      const answer = pending.get(message.id);
      if (answer === undefined) {
        report(`stdout carries a response that nobody asked for: ${excerpt(line)}`);
        continue;
      }
      pending.delete(message.id);
      answer(message);
    }
  });
  // Always drained: the server logs to stderr synchronously, so a full pipe would block it. Only
  // the start is kept, because a bundle that cannot start says why in its first lines.
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr = (stderr + chunk).slice(0, 4_000);
  });
  // A write to a server that is gone fails with EPIPE. The exit is reported on its own.
  child.stdin.on('error', () => undefined);
  child.once('error', (error) => {
    report(`cannot start the server: ${error.message}`);
  });

  const closed = new Promise((resolve) => {
    child.once('close', (code, signal) => {
      if (buffer !== '') {
        report(`stdout ends in the middle of a line: ${excerpt(buffer)}`);
      }
      if (!expectExit) {
        report(`the server exited early (${signal ?? `exit code ${String(code)}`})`);
      }
      resolve({ code, signal });
    });
  });

  const send = (message) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };

  return {
    problem,
    stderr: () => stderr,
    notify(method) {
      send({ method });
    },
    request(id, method, params) {
      return new Promise((resolve) => {
        pending.set(id, resolve);
        send({ id, method, ...(params === undefined ? {} : { params }) });
      });
    },
    // Closing its input is how a desktop client stops a stdio server. Resolves with how the server
    // exited, or with undefined when it kept running.
    stop(graceMs) {
      expectExit = true;
      child.stdin.end();
      return exitWithin(closed, graceMs);
    },
    // Harmless once the server is gone. The process ends when the child's pipes have closed.
    kill() {
      expectExit = true;
      child.kill('SIGKILL');
    },
  };
}

// The result of a response, or the reason it has none.
function resultOf(response, what) {
  if ('error' in response) {
    const { message = 'no message' } = response.error ?? {};
    throw new SmokeFailure(`${what} failed: ${String(message)}`);
  }
  if (typeof response.result !== 'object' || response.result === null) {
    throw new SmokeFailure(`${what} answered without a result`);
  }
  return response.result;
}

async function smoke(server, step) {
  step('waiting for the initialize response');
  const initialized = await server.request(1, 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'smoke-node20', version: '0.0.0' },
  });
  if (typeof resultOf(initialized, 'initialize').protocolVersion !== 'string') {
    throw new SmokeFailure('initialize did not name a protocol version');
  }
  server.notify('notifications/initialized');

  step('waiting for the tools/list response');
  const listed = resultOf(await server.request(2, 'tools/list'), 'tools/list');
  if (!Array.isArray(listed.tools)) {
    throw new SmokeFailure('tools/list answered without a tool list');
  }
  const names = listed.tools.map((tool) => tool?.name);
  const distinct = new Set(names.filter((name) => typeof name === 'string' && name !== ''));
  if (names.length !== EXPECTED_TOOL_COUNT || distinct.size !== names.length) {
    throw new SmokeFailure(
      `tools/list lists ${String(names.length)} tools, ${String(distinct.size)} of them named ` +
        `and distinct, not the ${String(EXPECTED_TOOL_COUNT)} tools of the full profile`,
    );
  }

  step('waiting for the server to stop after its input closed');
  const exit = await server.stop(EXIT_GRACE_MS);
  if (exit === undefined) {
    throw new SmokeFailure(
      `the server kept running for ${String(EXIT_GRACE_MS / 1000)} s after its input closed`,
    );
  }
  if (exit.code !== 0) {
    throw new SmokeFailure(
      `the server exited with ${exit.signal ?? `code ${String(exit.code)}`}, not with code 0`,
    );
  }
}

// Resolves with how the server exited (`closed`), or with undefined when it is still running after
// `graceMs`.
async function exitWithin(closed, graceMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, graceMs, undefined);
  });
  try {
    return await Promise.race([closed, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// A port on the loopback address that nothing listens on, as the system hands one out.
async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve) => {
    probe.close(resolve);
  });
  return port;
}

// Starts the server over HTTP on `port` with `token`, which it requires. Like startServer, `problem`
// rejects when the server dies before it is told to stop.
function startHttpServer(port, token) {
  const child = spawn(process.execPath, [CLI, '--transport', 'http'], {
    env: {
      ...serverEnv(),
      TV_MCP_AUTH_TOKEN: token,
      TV_MCP_HTTP_HOST: '127.0.0.1',
      TV_MCP_HTTP_PORT: String(port),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  let rejectProblem = () => undefined;
  const problem = new Promise((_resolve, reject) => {
    rejectProblem = reject;
  });
  problem.catch(() => undefined);
  let stderr = '';
  let expectExit = false;
  // The server never writes the token, so its stderr can be shown.
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr = (stderr + chunk).slice(0, 4_000);
  });
  child.once('error', (error) => {
    rejectProblem(new SmokeFailure(`cannot start the server: ${error.message}`));
  });
  const closed = new Promise((resolve) => {
    child.once('close', (code, signal) => {
      if (!expectExit) {
        rejectProblem(
          new SmokeFailure(`the server exited early (${signal ?? `exit code ${String(code)}`})`),
        );
      }
      resolve({ code, signal });
    });
  });

  return {
    problem,
    stderr: () => stderr,
    // SIGTERM is how a service manager stops the HTTP server. Resolves with how it exited, or with
    // undefined when it kept running.
    stop(graceMs) {
      expectExit = true;
      child.kill('SIGTERM');
      return exitWithin(closed, graceMs);
    },
    kill() {
      expectExit = true;
      child.kill('SIGKILL');
    },
  };
}

// The answer of the server to a GET of `path`, or null while nothing listens there.
async function get(base, path, headers = {}) {
  try {
    const response = await fetch(`${base}${path}`, { headers });
    return {
      status: response.status,
      type: response.headers.get('content-type') ?? '',
      body: await response.text(),
    };
  } catch {
    return null;
  }
}

// `ended` aborts once the leg is over, failed or timed out, so that the polling stops with it.
async function smokeHttp(server, step, { port, token, ended }) {
  const base = `http://127.0.0.1:${String(port)}`;
  step('waiting for the HTTP server to answer /healthz');
  for (;;) {
    const health = await get(base, '/healthz');
    if (health?.status === 200) {
      break;
    }
    if (ended.aborted) {
      return;
    }
    await sleep(POLL_MS);
  }

  step('waiting for the dashboard page');
  const page = await get(base, '/', { Accept: 'text/html' });
  if (
    page?.status !== 200 ||
    !page.type.startsWith('text/html') ||
    !page.body.includes('<div id="root">')
  ) {
    throw new SmokeFailure(
      `GET / answered ${String(page?.status)} (${String(page?.type)}), not the dashboard page: ` +
        'the bundle may lack dist/dashboard',
    );
  }

  step('waiting for /api/info without the token');
  const anonymous = await get(base, '/api/info');
  if (anonymous?.status !== 401) {
    throw new SmokeFailure(
      `GET /api/info without the token answered ${String(anonymous?.status)}, not 401`,
    );
  }

  step('waiting for /api/info with the token');
  const info = await get(base, '/api/info', { Authorization: `Bearer ${token}` });
  if (info?.status !== 200) {
    throw new SmokeFailure(
      `GET /api/info with the token answered ${String(info?.status)}, not 200`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(info.body);
  } catch {
    throw new SmokeFailure('GET /api/info answered with a body that is not JSON');
  }
  if (parsed?.transport !== 'http' || parsed?.toolCount !== EXPECTED_TOOL_COUNT) {
    throw new SmokeFailure(
      `GET /api/info reports the transport ${JSON.stringify(parsed?.transport)} and ` +
        `${String(parsed?.toolCount)} tools, not http and ${String(EXPECTED_TOOL_COUNT)}`,
    );
  }

  step('waiting for the HTTP server to stop after SIGTERM');
  const exit = await server.stop(EXIT_GRACE_MS);
  if (exit === undefined) {
    throw new SmokeFailure(
      `the server kept running for ${String(EXIT_GRACE_MS / 1000)} s after SIGTERM`,
    );
  }
  if (exit.code !== 0) {
    throw new SmokeFailure(
      `the server exited with ${exit.signal ?? `code ${String(exit.code)}`}, not with code 0`,
    );
  }
}

// Runs the checks of one leg against the server it started, within TIMEOUT_MS, and kills the server
// at the end whatever happened. A failure carries what the server wrote to stderr. The checks get
// a signal that aborts once the leg is over.
async function runLeg(name, server, checks) {
  const ended = new AbortController();
  let waitingFor = 'starting the server';
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new SmokeFailure(`timed out after ${String(TIMEOUT_MS / 1000)} s ${waitingFor}`));
    }, TIMEOUT_MS);
  });
  try {
    await Promise.race([
      checks((what) => {
        waitingFor = what;
      }, ended.signal),
      server.problem,
      deadline,
    ]);
  } catch (error) {
    // What the server itself said is what explains a bundle that cannot start. A bug in this
    // script is passed on as it is, with its stack.
    if (!(error instanceof SmokeFailure)) {
      throw error;
    }
    const lines = server.stderr().trimEnd().split('\n');
    const said =
      lines.join('') === ''
        ? ''
        : `\n--- stderr of the server ---\n${lines.slice(0, STDERR_LINES).join('\n')}${
            lines.length > STDERR_LINES ? '\n...' : ''
          }`;
    throw new SmokeFailure(`${name}: ${error.message}${said}`);
  } finally {
    ended.abort();
    clearTimeout(timer);
    server.kill();
  }
}

async function main() {
  if (!existsSync(CLI)) {
    throw new SmokeFailure(`${CLI} is missing: run pnpm build first`);
  }
  const stdio = startServer();
  await runLeg('stdio', stdio, (step) => smoke(stdio, step));

  // Made for this run, and never printed.
  const token = randomBytes(32).toString('hex');
  const port = await freePort();
  const http = startHttpServer(port, token);
  await runLeg('http', http, (step, ended) => smokeHttp(http, step, { port, token, ended }));
}

try {
  await main();
  console.log('smoke ok');
} catch (error) {
  const reason = error instanceof SmokeFailure ? error.message : (error?.stack ?? String(error));
  console.error(`smoke failed: ${reason}`);
  process.exitCode = 1;
}
