import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from './config/schema.js';
import { createCriConnector } from './core/cdp/cri-connector.js';
import { createHttpDiscovery, debugPortEndpoint } from './core/cdp/discovery.js';
import { ConnectionManager } from './core/connection.js';
import { ToolEventBus } from './core/events.js';
import { createNodeInstallDeps } from './core/launcher/install.js';
import { createLauncher, type Launcher } from './core/launcher/launch.js';
import { createDetachedSpawn } from './core/launcher/process.js';
import { createLogger, type Logger } from './core/logger.js';
import { registerResources } from './resources/index.js';
import { allTools } from './tools/index.js';
import { createToolRegistry, registerToolsWithServer, selectTools } from './tools/registry.js';
import type { SessionState, ToolContext, ToolRegistry } from './tools/types.js';
import { VERSION } from './version.js';

// The parts of a server that belong to the process rather than to one client. There must be one of
// each per process: a target may only ever have one session, because input is serialized per
// session; launches take turns inside one launcher; and the dashboard watches one event bus. A
// process creates them once with createServerDeps and hands them to the server of every session.
export interface ServerDeps {
  connection: ConnectionManager;
  launcher: Launcher;
  logger: Logger;
  events: ToolEventBus;
}

const SERVER_NAME = 'tradingview-desktop-mcp';

function createConnection(config: Readonly<Config>, logger: Logger): ConnectionManager {
  const { cdpHost: host, cdpPort: port, callTimeoutMs } = config;
  return new ConnectionManager({
    discovery: createHttpDiscovery({ host, port, timeoutMs: callTimeoutMs }),
    connector: createCriConnector({ host, port, defaultTimeoutMs: callTimeoutMs }),
    logger,
    callTimeoutMs,
    endpoint: debugPortEndpoint(host, port),
  });
}

function createDefaultLauncher(config: Readonly<Config>, connection: ConnectionManager): Launcher {
  return createLauncher({
    install: createNodeInstallDeps(),
    spawn: createDetachedSpawn(),
    // The launcher judges readiness by the report of the connection manager the tools use, so a
    // launch and the calls after it agree on whether the app is up.
    health: () => connection.health(),
    config,
  });
}

// The dependencies of a process: the ones given, and the others created from the configuration.
// A process that serves several clients calls this once and hands the result to every server.
// Nothing is started: no connection is opened before the first call that needs one.
export function createServerDeps(
  config: Readonly<Config>,
  deps: Partial<ServerDeps> = {},
): ServerDeps {
  const logger = deps.logger ?? createLogger({ level: config.logLevel });
  const connection = deps.connection ?? createConnection(config, logger);
  const launcher = deps.launcher ?? createDefaultLauncher(config, connection);
  const events = deps.events ?? new ToolEventBus();
  return { logger, connection, launcher, events };
}

// A server for one client, with the tools that the profile and the tool filter select, and the
// resources. A dependency that is not given is created, which suits a process with one client
// (stdio); a process with several (HTTP) passes the same set to every server. Creating a server
// starts nothing: no connection is opened before the first call that needs one.
export function createMcpServer(
  config: Readonly<Config>,
  deps: Partial<ServerDeps> = {},
): { server: McpServer; registry: ToolRegistry; ctx: ToolContext } {
  const { logger, connection, launcher, events } = createServerDeps(config, deps);
  const session: SessionState = {
    createdDrawingIds: new Set(),
    createdAlertIds: new Set(),
    createdStudyIds: new Set(),
  };
  const base = { config, logger, connection, launcher, events, session };

  const tools = selectTools(allTools, { profile: config.profile, patterns: config.toolPatterns });
  if (tools.length === 0) {
    // Most likely a typo in the filter. The server still starts, so the client can say why.
    logger.warn(
      { profile: config.profile, patterns: config.toolPatterns },
      'No tool matches the profile and the tool filter, so the server offers none',
    );
  }
  const registry = createToolRegistry(tools, base);
  const ctx: ToolContext = { ...base, registry };

  const server = new McpServer({ name: SERVER_NAME, version: VERSION });
  registerToolsWithServer(server, registry);
  registerResources(server, ctx);
  return { server, registry, ctx };
}
