import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Profile } from '../config/schema.js';
import { isTvMcpError, toErrorPayload, TvMcpError, type ErrorCode } from '../core/errors.js';
import type { ToolCallEvent } from '../core/events.js';
import { toErrorResult, toSuccessResult, type ToolMeta } from '../core/result.js';
import type { JsonValue } from '../utils/json.js';
import type { AnyToolDefinition, ToolContext, ToolOutput, ToolRegistry } from './types.js';

// Which tools each profile keeps (design spec 5.4).
const PROFILES: Record<Profile, (tool: AnyToolDefinition) => boolean> = {
  full: () => true,
  core: (tool) => tool.core === true,
  // A tool that does not say that it only reads may change something, so only the explicit hint
  // counts.
  readonly: (tool) => tool.annotations.readOnlyHint === true,
};

// `*` stands for any run of characters and every other character for itself. Case is ignored:
// tool names are lower case, and a filter typed in capitals means the same tools.
function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[\\^$.+?()[\]{}|]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`, 'i');
}

// The tools that the profile keeps and, when there are patterns, that match at least one of them.
// No patterns means no restriction. The order of `tools` is kept.
export function selectTools(
  tools: AnyToolDefinition[],
  options: { profile: Profile; patterns: string[] },
): AnyToolDefinition[] {
  const keep = PROFILES[options.profile];
  const globs = options.patterns.map(globToRegExp);
  return tools.filter(
    (tool) => keep(tool) && (globs.length === 0 || globs.some((glob) => glob.test(tool.name))),
  );
}

// The arguments in an event are for people watching the calls go by (the dashboard), and the bus
// keeps hundreds of events, so long strings, deep nesting and long lists are cut. The cut applies
// to every value alike, so that nothing a tool takes is kept whole because nobody thought of it.
const EVENT_TEXT_LIMIT = 200;
const EVENT_DEPTH_LIMIT = 8;
const EVENT_ENTRY_LIMIT = 50;
const CUT = '…';

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

// At most `EVENT_TEXT_LIMIT` UTF-16 units, the cut mark included.
function clip(text: string): string {
  if (text.length <= EVENT_TEXT_LIMIT) {
    return text;
  }
  let end = EVENT_TEXT_LIMIT - CUT.length;
  // Cutting between the two halves of a surrogate pair would leave half a character.
  if (isHighSurrogate(text.charCodeAt(end - 1))) {
    end -= 1;
  }
  return `${text.slice(0, end)}${CUT}`;
}

function summarize(value: unknown, depth: number): JsonValue {
  switch (typeof value) {
    case 'string':
      return clip(value);
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'boolean':
      return value;
    case 'object':
      break;
    default:
      // undefined, bigint, symbol and function have no JSON form; JSON.stringify writes null for
      // them in a list.
      return null;
  }
  if (value === null) {
    return null;
  }
  if (depth >= EVENT_DEPTH_LIMIT) {
    return CUT;
  }
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    const kept = items.slice(0, EVENT_ENTRY_LIMIT).map((item) => summarize(item, depth + 1));
    const rest = items.length - kept.length;
    return rest > 0 ? [...kept, `${CUT} ${String(rest)} more`] : kept;
  }
  const entries = Object.entries(value);
  const summary: Record<string, JsonValue> = {};
  for (const [key, item] of entries.slice(0, EVENT_ENTRY_LIMIT)) {
    summary[clip(key)] = summarize(item, depth + 1);
  }
  const rest = entries.length - EVENT_ENTRY_LIMIT;
  if (rest > 0) {
    summary[CUT] = `${String(rest)} more`;
  }
  return summary;
}

// A call must not fail because its arguments could not be shown: reading them can throw (a getter
// of an object that a caller in this process passed), and the event is only a report.
function eventArgs(args: unknown): JsonValue {
  try {
    return summarize(args, 0);
  } catch {
    return CUT;
  }
}

// A client that sends many bad values needs the first few to fix its call, not all of them.
const ISSUE_LIMIT = 10;

// In the dot-and-bracket form a reader knows from JavaScript: steps[3].tool.
function pathOf(path: readonly PropertyKey[]): string {
  let text = '';
  for (const key of path) {
    if (typeof key === 'number') {
      text += `[${String(key)}]`;
    } else {
      text += text === '' ? String(key) : `.${String(key)}`;
    }
  }
  return text;
}

// Zod's messages name the expected type and what was received, never the value itself, so they
// can be passed on.
function invalidArguments(name: string, error: z.ZodError): TvMcpError {
  const issues = error.issues
    .slice(0, ISSUE_LIMIT)
    .map((issue) => ({ path: pathOf(issue.path), message: issue.message }));
  const listed = issues
    .map(({ path, message }) => (path === '' ? message : `${path}: ${message}`))
    .join('; ');
  const rest = error.issues.length - issues.length;
  const more = rest > 0 ? ` (and ${String(rest)} more)` : '';
  return new TvMcpError('INVALID_INPUT', `Invalid arguments for ${name}: ${listed}${more}`, {
    hint: 'Check the arguments against the input schema of the tool in the tool list.',
    details: { issues },
  });
}

function unknownTool(name: string): TvMcpError {
  const shown = clip(name);
  return new TvMcpError('INVALID_INPUT', `Unknown tool ${JSON.stringify(shown)}`, {
    hint:
      'Call one of the tools this server lists. The profile and the tool filter ' +
      '(TV_MCP_PROFILE and TV_MCP_TOOLS) decide which tools it offers.',
    details: { tool: shown },
  });
}

const TOOL_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

// Mistakes in a definition are bugs, so they fail the creation of the server instead of reaching
// a client: the SDK would refuse a second tool of one name only after the first was registered.
function indexByName(tools: AnyToolDefinition[]): Map<string, AnyToolDefinition> {
  const byName = new Map<string, AnyToolDefinition>();
  for (const tool of tools) {
    if (!TOOL_NAME.test(tool.name)) {
      throw new Error(
        `Tool name ${JSON.stringify(tool.name)} is not snake_case with a domain prefix`,
      );
    }
    if (!tool.name.startsWith(`${tool.domain}_`)) {
      throw new Error(`Tool ${tool.name} is named outside its domain ${tool.domain}`);
    }
    if (byName.has(tool.name)) {
      throw new Error(`Tool ${tool.name} is defined twice`);
    }
    byName.set(tool.name, tool);
  }
  return byName;
}

// One object schema per definition, shared by every registry: over HTTP each session builds its
// registry from the same definitions.
const inputSchemas = new WeakMap<AnyToolDefinition, z.ZodObject<z.ZodRawShape>>();

function inputSchemaOf(tool: AnyToolDefinition): z.ZodObject<z.ZodRawShape> {
  let schema = inputSchemas.get(tool);
  if (schema === undefined) {
    schema = z.object(tool.inputSchema);
    inputSchemas.set(tool, schema);
  }
  return schema;
}

function elapsedSince(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function metaOf(output: ToolOutput<JsonValue>, durationMs: number): ToolMeta {
  return {
    ...(output.via === undefined ? {} : { via: output.via }),
    durationMs,
    // Always present, as in design spec 5.2, so a client need not check for it.
    warnings: output.warnings ?? [],
  };
}

// The one path every tool call takes, whether it comes from an MCP client, a batch or the
// dashboard. Handlers get `ctx` with this registry added. Creating a registry is cheap: it indexes
// the definitions and builds nothing else until a call needs it.
export function createToolRegistry(
  tools: AnyToolDefinition[],
  ctx: Omit<ToolContext, 'registry'>,
): ToolRegistry {
  const byName = indexByName(tools);
  const registry: ToolRegistry = {
    list: () => [...byName.values()],
    call,
  };
  const handlerCtx: ToolContext = { ...ctx, registry };

  async function run(name: string, args: unknown): Promise<ToolOutput<JsonValue>> {
    const tool = byName.get(name);
    if (tool === undefined) {
      throw unknownTool(name);
    }
    // Asynchronous, as the SDK parses too: a schema with an asynchronous check would fail a
    // synchronous parse.
    const parsed = await inputSchemaOf(tool).safeParseAsync(args);
    if (!parsed.success) {
      throw invalidArguments(name, parsed.error);
    }
    return tool.handler(parsed.data, handlerCtx);
  }

  function logFailure(
    error: unknown,
    code: ErrorCode,
    tool: string,
    origin: ToolCallEvent['origin'],
  ): void {
    if (isTvMcpError(error)) {
      // An expected outcome that the client is told about. The code is enough here, since a
      // message can carry what the page said.
      ctx.logger.debug({ tool, origin, code }, 'A tool call failed');
      return;
    }
    // The client only learns that something unexpected happened; the log keeps the whole error.
    ctx.logger.error({ err: error, tool, origin }, 'A tool call failed with an unexpected error');
  }

  async function call(
    name: string,
    args: unknown,
    origin: ToolCallEvent['origin'],
  ): Promise<CallToolResult> {
    const id = randomUUID();
    const tool = clip(name);
    const startedAt = performance.now();
    ctx.events.emit({
      id,
      tool,
      origin,
      phase: 'start',
      at: new Date().toISOString(),
      args: eventArgs(args),
    });

    let result: CallToolResult;
    let durationMs: number;
    let failure: ErrorCode | undefined;
    try {
      const output = await run(name, args);
      durationMs = elapsedSince(startedAt);
      result = toSuccessResult(output.data, metaOf(output, durationMs), output.images);
    } catch (error) {
      durationMs = elapsedSince(startedAt);
      // Built from the payload, never from the error: an Error's message is not enumerable, and
      // the payload is the only shape that may leave the server.
      const payload = toErrorPayload(error);
      logFailure(error, payload.code, tool, origin);
      failure = payload.code;
      result = toErrorResult(payload, durationMs);
    }

    ctx.events.emit({
      id,
      tool,
      origin,
      phase: 'end',
      at: new Date().toISOString(),
      durationMs,
      ok: failure === undefined,
      ...(failure === undefined ? {} : { errorCode: failure }),
    });
    return result;
  }

  return registry;
}

// Offers the tools of `registry` to MCP clients. The SDK lists each with the JSON Schema of its
// input, and validates the arguments of a call against it before the callback runs: a call that
// fails there gets the SDK's own error result and never reaches the registry. The registry then
// validates again, which changes nothing for valid arguments, and serves the call like any other.
export function registerToolsWithServer(server: McpServer, registry: ToolRegistry): void {
  for (const tool of registry.list()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        // The tools act on the local app and reach nothing beyond it (design spec 5.1), so a
        // definition need not repeat it.
        annotations: { openWorldHint: false, ...tool.annotations },
      },
      (args) => registry.call(tool.name, args, 'mcp'),
    );
  }
}
