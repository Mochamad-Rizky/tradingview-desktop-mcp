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
  // The text this session last wrote into the Pine Editor (pine_new with a source, pine_set_source
  // and the write-back of pine_smart_compile); null before the first. While the editor holds exactly
  // this text as an unsaved edit, which isModified() reports, the edit, and the flag of it
  // TradingView keeps until the editor closes, are the session's own, so replacing the text needs no
  // confirmation. It never makes a text count as saved: saving and adding the script go by the flag
  // as ever. Kept in memory only: never logged or returned.
  lastWrittenPineText: string | null;
  // The symbols watchlist_add and watchlist_add_bulk added, by the id of the watchlist they were
  // added to, as the list holds them, until watchlist_remove removes them. Removing them needs no
  // confirmation; removing any other symbol of a list does.
  addedWatchlistSymbols: Map<string, Set<string>>;
  // The ids of the tabs tab_new opened, as the tab strip names them, until tab_close closes them.
  // Closing them needs no confirmation; closing any other tab does.
  openedTabIds: Set<string>;
  // Whether replay_start started a replay, until replay_stop leaves it. TradingView saves a replay
  // in the layout when it is left before its end, and offers to continue it in a dialog the next
  // time replay starts: replay_stop clears what a replay of this session left, and never what a
  // replay the user started left.
  replayStartedBySession: boolean;
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
  // Kept by the core profile (design spec 5.4), the reduced set for clients that cap the number of
  // tools: the essentials of a domain, so a tool is not core unless it says so.
  core?: boolean;
  // Keeps the arguments of a call out of the tool events that the dashboard shows and keeps, for a
  // tool that takes what should not linger there, such as text typed for the user or code. The
  // event says { redacted: true } instead; the handler gets the arguments as ever.
  redactArgs?: boolean;
  // For a tool whose arguments hold the arguments of other tools (batch_run): what the tool events
  // show of its arguments, which come as the client sent them, before they are validated. `redacts`
  // tells, from the definitions, whether a tool keeps its own arguments out of the events.
  eventArgs?(args: unknown, redacts: (tool: string) => boolean): unknown;
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
