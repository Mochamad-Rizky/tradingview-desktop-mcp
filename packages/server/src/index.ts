// The programmatic API: load a configuration, then build a server and connect it to a transport.
export { VERSION } from './version.js';
export { loadConfig } from './config/load.js';
export { createMcpServer, type ServerDeps } from './server.js';

export type { CliCommand, Config, LogLevel, Profile, TransportKind } from './config/schema.js';
export type { ConnectionManager, HealthReport } from './core/connection.js';
export type { ErrorCode, ErrorPayload } from './core/errors.js';
export type { ToolCallEvent, ToolEventBus } from './core/events.js';
export type { Launcher, LaunchResult } from './core/launcher/launch.js';
export type { Logger } from './core/logger.js';
export type { Tier, ToolMeta } from './core/result.js';
export type {
  AnyToolDefinition,
  Domain,
  SessionState,
  ToolContext,
  ToolDefinition,
  ToolOutput,
  ToolRegistry,
} from './tools/types.js';
export type { JsonObject, JsonValue } from './utils/json.js';
