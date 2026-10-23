import type { Readable, Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config/load.js';
import type { CliCommand, Config } from '../config/schema.js';
import { debugPortEndpoint } from '../core/cdp/discovery.js';
import { isTvMcpError } from '../core/errors.js';
import { createMcpServer, createServerDeps, type ServerDeps } from '../server.js';
import { createDashboardApi, type DashboardApi } from '../transports/dashboard/api.js';
import { mcpUrl, startHttpTransport } from '../transports/http.js';
import { startStdioTransport } from '../transports/stdio.js';
import { withTimeout } from '../utils/timeout.js';
import { VERSION } from '../version.js';
import { renderBanner } from './banner.js';
import {
  colorEnabled,
  isHealthy,
  renderError,
  renderHealth,
  renderHelp,
  renderLaunchResult,
} from './output.js';

// The part of the process the CLI listens to.
export interface CliProcess {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface CliIo {
  stdout: Writable;
  stderr: Writable;
  // Where the messages of a stdio client arrive: process.stdin when absent.
  stdin?: Readable;
  // Where shutdown signals and errors that nothing caught are heard. Without it neither is
  // watched, which suits a caller that owns the process, such as a test.
  process?: CliProcess;
}

// Dependencies to use instead of the ones the CLI creates from the configuration.
export type CliDeps = Partial<ServerDeps>;

type Command = Exclude<CliCommand, 'config'>;

interface CommandContext {
  config: Readonly<Config>;
  deps: ServerDeps;
  io: CliIo;
  env: NodeJS.ProcessEnv;
}

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'];
const FATAL_EVENTS = ['uncaughtException', 'unhandledRejection'];

// connection.close() waits for connections that are still opening, for up to the call timeout, and
// the WebSocket of an app that stopped answering stays open for 30 s. Exiting matters more.
const CONNECTION_CLOSE_TIMEOUT_MS = 3000;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Returns how to take the listener off again.
function listen(
  target: CliProcess | undefined,
  event: string,
  listener: (...args: unknown[]) => void,
): () => void {
  target?.on(event, listener);
  return () => {
    target?.off(event, listener);
  };
}

// Read with the tokenizer of loadConfig, but before it, so that both work even when the settings
// would not load (http without a token, a mistyped flag).
function metaFlag(argv: readonly string[]): 'help' | 'version' | undefined {
  const { values } = parseArgs({
    args: [...argv],
    options: { help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' } },
    strict: false,
    allowPositionals: true,
  });
  if (values.help === true) {
    return 'help';
  }
  return values.version === true ? 'version' : undefined;
}

async function closeConnection({ connection, logger }: ServerDeps): Promise<void> {
  // A failure is caught apart from the deadline, so that the log can tell the two apart.
  let failure: { error: unknown } | undefined;
  const closing = connection.close().catch((error: unknown) => {
    failure = { error };
  });
  try {
    await withTimeout(closing, CONNECTION_CLOSE_TIMEOUT_MS, 'Closing the CDP connection');
  } catch {
    logger.warn(
      { timeoutMs: CONNECTION_CLOSE_TIMEOUT_MS },
      'The CDP connection did not close in time, so the CLI goes on without waiting for it',
    );
    return;
  }
  if (failure !== undefined) {
    logger.warn({ err: failure.error }, 'The CDP connection failed to close');
  }
}

// The dashboard API of the process. Its tool calls go through a registry of their own, created once
// with a session state of its own, on the dependencies of the process: they reach the connection
// and the event bus that every MCP session uses.
function dashboardApi(
  config: Readonly<Config>,
  deps: ServerDeps,
  mcpEndpoint: string | null,
): DashboardApi {
  return createDashboardApi({
    config,
    registry: createMcpServer(config, deps).registry,
    events: deps.events,
    connection: deps.connection,
    version: VERSION,
    startedAt: new Date(),
    mcpEndpoint,
    logger: deps.logger,
  });
}

interface Serving {
  // Where an HTTP client connects, without the token.
  endpoint?: string;
  close(): Promise<void>;
}

async function startServing(
  { config, deps, io }: CommandContext,
  stop: Deferred<string>,
): Promise<Serving> {
  if (config.transport === 'stdio') {
    const { server } = createMcpServer(config, deps);
    server.server.onclose = () => {
      stop.resolve('the client closed the connection');
    };
    await startStdioTransport(server, { stdin: io.stdin ?? process.stdin, stdout: io.stdout });
    return { close: () => server.close() };
  }
  // One server per MCP session, all on the dependencies of this process.
  const handle = await startHttpTransport({
    config,
    logger: deps.logger,
    createServer: () => createMcpServer(config, deps).server,
    ...(config.dashboard
      ? { dashboard: { api: dashboardApi(config, deps, mcpUrl(config.httpHost, config.httpPort)) } }
      : {}),
  });
  return { endpoint: handle.url, close: () => handle.close() };
}

async function serve(context: CommandContext): Promise<number> {
  const { config, deps, io, env } = context;
  const stop = deferred<string>();
  // Listened for before the transport starts, so that a signal during startup still shuts down.
  const unlisten = SHUTDOWN_SIGNALS.map((signal) =>
    listen(io.process, signal, () => {
      stop.resolve(`received ${signal}`);
    }),
  );
  const stopListening = (): void => {
    for (const off of unlisten) {
      off();
    }
  };
  try {
    const serving = await startServing(context, stop);
    const { endpoint } = serving;
    io.stderr.write(
      renderBanner(
        {
          version: VERSION,
          transport: config.transport,
          ...(endpoint === undefined ? {} : { endpoint }),
          cdp: debugPortEndpoint(config.cdpHost, config.cdpPort),
        },
        { color: colorEnabled(env, io.stderr) },
      ),
    );
    const reason = await stop.promise;
    // A second signal now gets Node's default handling, which ends the process at once: the way
    // out of a shutdown that hangs.
    stopListening();
    deps.logger.info({ reason }, 'Shutting down');
    await serving.close();
    return 0;
  } finally {
    stopListening();
  }
}

async function launch({ config, deps, io, env }: CommandContext): Promise<number> {
  io.stderr.write(
    `Looking for TradingView, and starting it with the debug port ${String(config.cdpPort)} if needed...\n`,
  );
  // Never a restart: closing the app can lose unsaved work, and that is the user's call to make.
  const result = await deps.launcher.launch({ restart: false });
  io.stdout.write(renderLaunchResult(result, { color: colorEnabled(env, io.stdout) }));
  return 0;
}

async function doctor({ deps, io, env }: CommandContext): Promise<number> {
  const report = await deps.connection.health();
  io.stdout.write(renderHealth(report, { color: colorEnabled(env, io.stdout) }));
  return isHealthy(report) ? 0 : 1;
}

const COMMANDS: Record<Command, (context: CommandContext) => Promise<number>> = {
  serve,
  launch,
  doctor,
};

// The whole CLI, without the process: it takes the arguments (without node and the script), the
// environment and the streams, and resolves with the exit code, which the caller applies. One
// logger, event bus, connection manager and launcher serve the whole process.
export async function runCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
  deps: CliDeps = {},
): Promise<number> {
  const color = colorEnabled(env, io.stderr);
  const meta = metaFlag(argv);
  if (meta === 'help') {
    io.stdout.write(renderHelp());
    return 0;
  }
  if (meta === 'version') {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }

  let loaded: ReturnType<typeof loadConfig>;
  try {
    loaded = loadConfig({ argv, env });
  } catch (error) {
    io.stderr.write(renderError(error, { color }));
    return 1;
  }
  const { command, config } = loaded;
  if (command === 'config') {
    io.stderr.write('Not implemented yet\n');
    return 2;
  }

  const shared = createServerDeps(config, deps);
  const fatal = deferred<number>();
  let ended = false;
  const unlisten = FATAL_EVENTS.map((event) =>
    listen(io.process, event, (error) => {
      shared.logger.fatal({ err: error }, 'An unexpected error ended the CLI');
      // The log may be silenced, and it is not where a person looks when a process ends. Only the
      // error that ended the CLI is printed; any after it are in the log.
      if (!ended) {
        ended = true;
        io.stderr.write(renderError(error, { color }));
      }
      fatal.resolve(1);
    }),
  );
  try {
    return await Promise.race([
      COMMANDS[command]({ config, deps: shared, io, env }),
      fatal.promise,
    ]);
  } catch (error) {
    if (!isTvMcpError(error)) {
      shared.logger.error({ err: error }, 'The command failed with an unexpected error');
    }
    io.stderr.write(renderError(error, { color }));
    return 1;
  } finally {
    for (const off of unlisten) {
      off();
    }
    await closeConnection(shared);
  }
}
