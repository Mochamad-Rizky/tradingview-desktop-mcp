// The JSON that the dashboard API and the dashboard exchange. The dashboard type-checks this file
// on its own, where no server module resolves, so it imports nothing: every type here mirrors a
// server type by hand, and test/unit/transports/dashboard/contract.test.ts fails when the two
// drift apart. Type aliases, not interfaces: a type must satisfy JsonValue to go out as JSON.
//
// The server sends these over HTTP: GET /api/info, /api/health and /api/tools, POST
// /api/tools/<name>, and the event stream of GET /api/events.

export type JsonPrimitive = string | number | boolean | null;

// The object arm stays an inline index signature: TypeScript rejects a cycle that goes through the
// Record alias (TS2456), but accepts one through an object type literal.
export type JsonValue = JsonPrimitive | JsonValue[] | { [k: string]: JsonValue };

// A JSON Schema document, as zod writes the input schema of a tool.
export type JsonSchemaObject = Record<string, JsonValue>;

// The tool sets of the server (Profile).
export type DashboardProfile = 'core' | 'full' | 'readonly';

// The tool name prefixes, without the underscore (Domain).
export type DashboardDomain =
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

// The codes a failed call ends with (ErrorCode), a closed set.
export type DashboardErrorCode =
  | 'TV_NOT_INSTALLED'
  | 'TV_NOT_RUNNING'
  | 'RESTART_REQUIRED'
  | 'LAUNCH_FAILED'
  | 'CDP_UNREACHABLE'
  | 'TARGET_NOT_FOUND'
  | 'TIMEOUT'
  | 'PAGE_EVALUATION_FAILED'
  | 'CAPABILITY_UNAVAILABLE'
  | 'NOT_AVAILABLE'
  | 'PLAN_LIMIT'
  | 'INVALID_INPUT'
  | 'CONFIRMATION_REQUIRED'
  | 'UNSAFE_ACTION_BLOCKED'
  | 'AUTH_REQUIRED'
  | 'INTERNAL';

// GET /api/info: the running server and its settings. It never holds the token. mcpEndpoint is
// null when the server speaks MCP over stdio, and startedAt is an ISO 8601 time.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type DashboardInfo = {
  name: string;
  version: string;
  transport: 'stdio' | 'http';
  profile: DashboardProfile;
  toolPatterns: string[];
  allowEval: boolean;
  toolCount: number;
  mcpEndpoint: string | null;
  startedAt: string;
};

// GET /api/health: whether TradingView answers on its debug port and shows a chart (HealthReport).
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type DashboardHealth = {
  cdp: {
    reachable: boolean;
    endpoint: string;
    browser?: string;
    userAgent?: string;
    otherBrowser?: boolean;
  };
  chart: { found: boolean; tabs: number; url?: string; inBackground?: boolean };
  app: { ready: boolean; connected?: boolean; buildTime?: string | null };
};

// An event of the stream of GET /api/events (ToolCallEvent): the start or the end of a tool call.
// seq numbers the events of one server process from 1. The id of the stream event is the boot id of
// that process, a dash and the seq, so that a server that restarted can tell the id of a client that
// resumes from one of its own; a client keeps it as it is. A gap event, which says that the client
// missed events, carries an id of the same form, with the newest seq of the process (0 before its
// first event), from which the client resumes. A start carries the arguments as the server shows
// them, redacted and cut; an end carries the outcome.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type DashboardEvent = {
  seq: number;
  id: string;
  tool: string;
  origin: 'mcp' | 'batch' | 'dashboard';
  phase: 'start' | 'end';
  at: string;
  durationMs?: number;
  ok?: boolean;
  errorCode?: DashboardErrorCode;
  args?: JsonValue;
};

// A tool the server offers, with every hint stated and the profiles that keep it.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type DashboardTool = {
  name: string;
  domain: DashboardDomain;
  title: string;
  description: string;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  core: boolean;
  profiles: DashboardProfile[];
  inputSchema: JsonSchemaObject;
};

// GET /api/tools: the tools in the order the server lists them.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type DashboardToolList = { tools: DashboardTool[] };

// The body of POST /api/tools/<name>. No arguments means {}.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type DashboardCallRequest = { arguments?: Record<string, JsonValue> };

// The answer to POST /api/tools/<name>: the tool result as an MCP client gets it, a failed call
// included (isError). Images come in front of the text block that holds the result envelope.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type DashboardCallResult = {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
  structuredContent?: Record<string, JsonValue>;
  isError?: boolean;
};

// The body of every API answer that is not a success.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type DashboardError = { error: string };
