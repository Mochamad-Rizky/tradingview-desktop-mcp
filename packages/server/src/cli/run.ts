import type { Readable, Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config/load.js';
import type { ClientOptions, CliCommand, Config, LaunchOptions } from '../config/schema.js';
import { debugPortEndpoint } from '../core/cdp/discovery.js';
import { isTvMcpError } from '../core/errors.js';
import { createMcpServer, createServerDeps, type ServerDeps } from '../server.js';
import { createDashboardApi, type DashboardApi } from '../transports/dashboard/api.js';
import { startDashboardServer } from '../transports/dashboard/server.js';
import { resolveDashboardDir } from '../transports/dashboard/static.js';
import { dashboardUrl, mcpUrl, startHttpTransport } from '../transports/http.js';
import { startStdioTransport } from '../transports/stdio.js';
import { withTimeout } from '../utils/timeout.js';
import { VERSION } from '../version.js';
import { renderBanner } from './banner.js';
import { parseClientId, renderClientConfig, resolveCliPath } from './clients.js';
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

// Dependencies to use instead of the ones the CLI creates from the configuration, the folder of a
// built dashboard to serve instead of the one beside the bundle (null: none was built), and the
// path that config --local prints instead of the real path of the running script.
export type CliDeps = Partial<ServerDeps> & { dashboardDir?: string | null; cliPath?: string };

interface CommandContext {
  config: Readonly<Config>;
  deps: ServerDeps;
  io: CliIo;
  env: NodeJS.ProcessEnv;
  // Where the built dashboard is, or null when it was not built.
  dashboardDir: () => string | null;
  // What follows the command's name: the client of config.
  commandArgs: readonly string[];
  clientOptions: ClientOptions;
  launchOptions: LaunchOptions;
  // The real path of the running CLI, for config --local.
  cliPath: () => string;
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

// The published package carries the dashboard's files, so without them it is incomplete. A
// checkout of the sources has them once built.
function warnDashboardFilesMissing({ logger }: ServerDeps): void {
  logger.warn(
    'Dashboard files not found, so the dashboard page is not served, only its API. The installed ' +
      'package is incomplete: reinstall it. In a checkout of the sources, build them with ' +
      '"pnpm build"',
  );
}

interface Serving {
  // Where an HTTP client connects, without the token.
  endpoint?: string;
  // Where the dashboard page is, without the token.
  dashboard?: string;
  close(): Promise<void>;
}

interface StdioDashboard {
  // Where the page is, when its files were built.
  page?: string;
  close(): Promise<void>;
}

// The dashboard next to a stdio server, on a listener of its own. Neither a missing token nor a
// listener that cannot start stops the MCP server: the dashboard is left out, with a warning.
async function startStdioDashboard({
  config,
  deps,
  dashboardDir,
}: CommandContext): Promise<StdioDashboard | undefined> {
  if (config.authToken === undefined) {
    deps.logger.warn(
      'The dashboard needs TV_MCP_AUTH_TOKEN, the secret its API asks for, so it is off. Set it ' +
        'to a random secret, such as the output of "openssl rand -hex 32"',
    );
    return undefined;
  }
  const dir = dashboardDir();
  const handle = await startDashboardServer({
    config,
    logger: deps.logger,
    api: dashboardApi(config, deps, null),
    ...(dir === null ? {} : { dir }),
  });
  if (handle === null) {
    return undefined;
  }
  if (dir === null) {
    warnDashboardFilesMissing(deps);
  }
  return { ...(dir === null ? {} : { page: handle.url }), close: () => handle.close() };
}

async function serveStdio(context: CommandContext, stop: Deferred<string>): Promise<Serving> {
  const { config, deps, io } = context;
  const { server } = createMcpServer(config, deps);
  server.server.onclose = () => {
    stop.resolve('the client closed the connection');
  };
  await startStdioTransport(server, { stdin: io.stdin ?? process.stdin, stdout: io.stdout });
  const dashboard = config.dashboard ? await startStdioDashboard(context) : undefined;
  return {
    ...(dashboard?.page === undefined ? {} : { dashboard: dashboard.page }),
    // The dashboard closes even when the MCP server fails to, so that its port is freed.
    close: async () => {
      try {
        await server.close();
      } finally {
        await dashboard?.close();
      }
    },
  };
}

async function serveHttp({ config, deps, dashboardDir }: CommandContext): Promise<Serving> {
  const dir = config.dashboard ? dashboardDir() : null;
  // One server per MCP session, all on the dependencies of this process.
  const handle = await startHttpTransport({
    config,
    logger: deps.logger,
    createServer: () => createMcpServer(config, deps).server,
    ...(config.dashboard
      ? {
          dashboard: {
            api: dashboardApi(config, deps, mcpUrl(config.httpHost, config.httpPort)),
            ...(dir === null ? {} : { dir }),
          },
        }
      : {}),
  });
  if (config.dashboard && dir === null) {
    warnDashboardFilesMissing(deps);
  }
  return {
    endpoint: handle.url,
    ...(dir === null ? {} : { dashboard: dashboardUrl(config.httpHost, handle.port) }),
    close: () => handle.close(),
  };
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
    const serving =
      config.transport === 'stdio' ? await serveStdio(context, stop) : await serveHttp(context);
    const { endpoint, dashboard } = serving;
    io.stderr.write(
      renderBanner(
        {
          version: VERSION,
          transport: config.transport,
          ...(endpoint === undefined ? {} : { endpoint }),
          ...(dashboard === undefined ? {} : { dashboard }),
          cdp: debugPortEndpoint(config.cdpHost, config.cdpPort),
        },
        { color: colorEnabled(env, io.stderr) },
      ),
    );
    if (dashboard !== undefined) {
      deps.logger.info({ url: dashboard }, 'The dashboard is served');
    }
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

async function launch({ config, deps, io, env, launchOptions }: CommandContext): Promise<number> {
  const { restart } = launchOptions;
  const port = String(config.cdpPort);
  io.stderr.write(
    restart
      ? `Looking for TradingView, and starting it with the debug port ${port} if needed: if it runs without the port, it is asked to quit first...\n`
      : `Looking for TradingView, and starting it with the debug port ${port} if needed...\n`,
  );
  // A restart only on --restart: closing the app can lose unsaved work, and that is the user's call
  // to make.
  const result = await deps.launcher.launch({ restart });
  io.stdout.write(renderLaunchResult(result, { color: colorEnabled(env, io.stdout) }));
  return 0;
}

async function doctor({ deps, io, env }: CommandContext): Promise<number> {
  const report = await deps.connection.health();
  io.stdout.write(renderHealth(report, { color: colorEnabled(env, io.stdout) }));
  return isHealthy(report) ? 0 : 1;
}

// The snippet alone goes to stdout, so that it can be piped or pasted as it is.
function printClientConfig({
  io,
  commandArgs,
  clientOptions,
  cliPath,
}: CommandContext): Promise<number> {
  const client = parseClientId(commandArgs);
  const { local, url, platform, profile } = clientOptions;
  const { snippet, notes } = renderClientConfig(client, {
    platform: platform ?? process.platform,
    command: local ? { kind: 'local', cliPath: cliPath() } : { kind: 'npx' },
    ...(profile === undefined ? {} : { profile }),
    ...(url === undefined ? {} : { url }),
  });
  io.stdout.write(snippet);
  io.stderr.write(notes.map((note) => `${note}\n`).join(''));
  return Promise.resolve(0);
}

const COMMANDS: Record<CliCommand, (context: CommandContext) => Promise<number>> = {
  serve,
  launch,
  doctor,
  config: printClientConfig,
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
  const { command, commandArgs, config, clientOptions, launchOptions } = loaded;

  const { dashboardDir, cliPath, ...given } = deps;
  const shared = createServerDeps(config, given);
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
      COMMANDS[command]({
        config,
        deps: shared,
        io,
        env,
        dashboardDir: () => (dashboardDir === undefined ? resolveDashboardDir() : dashboardDir),
        commandArgs,
        clientOptions,
        launchOptions,
        cliPath: () => cliPath ?? resolveCliPath(process.argv[1]),
      }),
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
