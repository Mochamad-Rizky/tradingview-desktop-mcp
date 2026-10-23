// Starts the built CLI the way an MCP client does and checks, over stdio alone, that it answers the
// handshake, lists its tools, keeps stdout for JSON-RPC and stops when its input closes. CI runs it
// on the oldest Node the package supports, where the test suites cannot run: Vitest needs Node 22
// or newer, the bundle only needs 20.19.
//
// Plain JavaScript without dependencies, so that it runs wherever the bundle does.
// Usage, after `pnpm build`: node scripts/smoke-node20.mjs

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../packages/server/dist/cli.js', import.meta.url));
// A fast machine needs about a second. The margin is for a cold disk on a busy runner.
const TIMEOUT_MS = 20_000;
// The server has to stop on its own once its client closes its input.
const EXIT_GRACE_MS = 5_000;
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
    async stop(graceMs) {
      expectExit = true;
      child.stdin.end();
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(resolve, graceMs, undefined);
      });
      try {
        return await Promise.race([closed, timeout]);
      } finally {
        clearTimeout(timer);
      }
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

async function main() {
  if (!existsSync(CLI)) {
    throw new SmokeFailure(`${CLI} is missing: run pnpm build first`);
  }
  const server = startServer();
  let waitingFor = 'starting the server';
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new SmokeFailure(`timed out after ${String(TIMEOUT_MS / 1000)} s ${waitingFor}`));
    }, TIMEOUT_MS);
  });
  try {
    await Promise.race([
      smoke(server, (what) => {
        waitingFor = what;
      }),
      server.problem,
      deadline,
    ]);
  } catch (error) {
    // What the server itself said is what explains a bundle that cannot start. A bug in this
    // script is passed on as it is, with its stack.
    const lines = server.stderr().trimEnd().split('\n');
    if (!(error instanceof SmokeFailure) || lines.join('') === '') {
      throw error;
    }
    const shown = lines.slice(0, STDERR_LINES).join('\n');
    const more = lines.length > STDERR_LINES ? '\n...' : '';
    throw new SmokeFailure(`${error.message}\n--- stderr of the server ---\n${shown}${more}`);
  } finally {
    clearTimeout(timer);
    server.kill();
  }
}

try {
  await main();
  console.log('smoke ok');
} catch (error) {
  const reason = error instanceof SmokeFailure ? error.message : (error?.stack ?? String(error));
  console.error(`smoke failed: ${reason}`);
  process.exitCode = 1;
}
