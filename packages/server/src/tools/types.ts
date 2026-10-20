import type {
  CallToolResult,
  ImageContent,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import type { Config } from '../config/schema.js';
import type { ConnectionManager } from '../core/connection.js';
import type { ToolCallEvent, ToolEventBus } from '../core/events.js';
import type { Launcher } from '../core/launcher/launch.js';
import type { Logger } from '../core/logger.js';
import type { Tier } from '../core/result.js';
import type { JsonValue } from '../utils/json.js';
import type { PineCompileResult } from './pine/mappers.js';

// The tool name prefixes of design spec 5.1, without the underscore.
export type Domain =
  | 'app'
  | 'chart'
  | 'data'
  | 'indicator'
  | 'pine'
  | 'strategy'
  | 'drawing'
  | 'alert'
  | 'watchlist'
  | 'layout'
  | 'pane'
  | 'tab'
  | 'replay'
  | 'screenshot'
  | 'ui'
  | 'batch';

// What the server created during one MCP session. Removing these needs no confirmation (design
// spec 5.3, rule 2), unlike objects that were there before. Every server instance has its own,
// and over HTTP every session has its own server.
export interface SessionState {
  createdDrawingIds: Set<string>;
  createdAlertIds: Set<string>;
  // The ids of the studies indicator_add put on a chart, until indicator_remove removes them.
  createdStudyIds: Set<string>;
  // The ids of the Pine scripts pine_save saved as new scripts. Saving a new version of one needs
  // no confirmation.
  createdScriptIds: Set<string>;
  // The result of the last pine_compile, or of the last attempt of a pine_smart_compile, which
  // pine_get_errors returns; null before the first.
  lastPineCompile: PineCompileResult | null;
}

// What a handler works with. Over HTTP the connection, the launcher, the logger and the event bus
// are shared by every session of the process; the session state and the registry are per server.
export interface ToolContext {
  config: Readonly<Config>;
  logger: Logger;
  connection: ConnectionManager;
  launcher: Launcher;
  events: ToolEventBus;
  session: SessionState;
  // The registry the handler runs in, so that a tool can run other tools the way a client would,
  // with the same validation, envelope and events (batch_run).
  registry: ToolRegistry;
}

// What a handler returns. The registry wraps it in the result envelope of design spec 5.2: `via`
// and `warnings` go into meta, and the images go in front of the JSON block.
export interface ToolOutput<T extends JsonValue> {
  data: T;
  via?: Tier;
  warnings?: string[];
  images?: ImageContent[];
}

export interface ToolDefinition<S extends z.ZodRawShape, T extends JsonValue> {
  // snake_case, starting with the domain and an underscore.
  name: string;
  domain: Domain;
  title: string;
  // For the model: when to use the tool, what it returns, and its limits and side effects.
  description: string;
  // Every field carries a .describe() text. The schema validates and may fill in defaults, but it
  // should not convert values: an MCP call is parsed by the SDK first and by the registry again,
  // so a transform would run on its own output. Conversions belong in the handler.
  inputSchema: S;
  annotations: ToolAnnotations;
  // Kept by the core profile (design spec 5.4).
  core?: boolean;
  // Declared as a method so that a definition with a narrower input still counts as an
  // AnyToolDefinition. Errors are thrown: a TvMcpError reaches the client as it is, anything else
  // as INTERNAL.
  handler(input: z.output<z.ZodObject<S>>, ctx: ToolContext): Promise<ToolOutput<T>>;
}

// Returns the definition unchanged. It exists for inference: the handler's input type comes from
// the schema, and its data type from what the handler returns.
export function defineTool<S extends z.ZodRawShape, T extends JsonValue>(
  def: ToolDefinition<S, T>,
): ToolDefinition<S, T> {
  return def;
}

export type AnyToolDefinition = ToolDefinition<z.ZodRawShape, JsonValue>;

export interface ToolRegistry {
  // The tools this server offers, in registration order.
  list(): AnyToolDefinition[];
  // Runs a tool the way every origin runs it: validated, wrapped in the envelope, and reported to
  // the event bus. It never rejects; every failure is an error result.
  call(name: string, args: unknown, origin: ToolCallEvent['origin']): Promise<CallToolResult>;
}
