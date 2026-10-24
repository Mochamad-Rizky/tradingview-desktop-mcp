import type {
  DashboardCallResult,
  DashboardErrorCode,
  DashboardEvent,
  DashboardHealth,
  DashboardInfo,
  DashboardTool,
  JsonValue,
} from '@contract';
import type { ToolCall } from '@/api/event-log';

// What the fake API of the tests answers with. Every value is made up: the tools are a few of the
// server's own, cut short, and the symbols are the placeholders the server tests use.

// The token the fake API accepts, as TV_MCP_AUTH_TOKEN would hold it.
export const TEST_TOKEN = 'test-token-5f2c9a';

// The boot id of the fake server's event bus: a stream event's id is this, a dash and the seq.
export const BOOT_ID = 'b00710aa';

export function streamId(seq: number, bootId: string = BOOT_ID): string {
  return `${bootId}-${String(seq)}`;
}

export const info: DashboardInfo = {
  name: 'tradingview-desktop-mcp',
  version: '0.0.0-test',
  transport: 'http',
  profile: 'full',
  toolPatterns: [],
  allowEval: false,
  toolCount: 6,
  mcpEndpoint: 'http://127.0.0.1:8787/mcp',
  startedAt: '2026-01-02T03:04:05.000Z',
};

// TradingView is up, shows a chart in front, and its app is ready.
export const health: DashboardHealth = {
  cdp: {
    reachable: true,
    endpoint: 'http://127.0.0.1:9222',
    browser: 'Chrome/130.0.6723.191',
    userAgent: 'Mozilla/5.0 (Macintosh) TradingView/2.9.0 Chrome/130.0.6723.191 Electron/33.2.1',
  },
  chart: { found: true, tabs: 1, url: 'https://www.tradingview.com/chart/', inBackground: false },
  app: { ready: true, connected: true, buildTime: '2026-01-01T00:00:00.000Z' },
};

// TradingView is not running with its debug port.
export const unreachableHealth: DashboardHealth = {
  cdp: { reachable: false, endpoint: 'http://127.0.0.1:9222' },
  chart: { found: false, tabs: 0 },
  app: { ready: false },
};

// A chart is open, but the tab in front shows something else.
export const backgroundHealth: DashboardHealth = {
  cdp: { reachable: true, endpoint: 'http://127.0.0.1:9222', browser: 'Chrome/130.0.6723.191' },
  chart: { found: true, tabs: 2, url: 'https://www.tradingview.com/chart/', inBackground: true },
  app: { ready: false, connected: true, buildTime: null },
};

// TradingView answers on its debug port, but no tab shows a chart: it is on its New tab page, say.
export const noChartHealth: DashboardHealth = {
  cdp: { reachable: true, endpoint: 'http://127.0.0.1:9222', browser: 'Chrome/130.0.6723.191' },
  chart: { found: false, tabs: 0 },
  app: { ready: false },
};

const SCHEMA = 'https://json-schema.org/draft/2020-12/schema';

const chartIndex: JsonValue = {
  description:
    'Which chart of a multi-chart layout, counted from 0. Leave it out for the active chart.',
  type: 'integer',
  minimum: 0,
  maximum: 9007199254740991,
};

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

// Six tools of three domains: read-only ones, one that changes the chart and one that removes data;
// core tools and others; every kind of constraint a schema field shows.
export const tools: DashboardTool[] = [
  {
    name: 'app_health',
    domain: 'app',
    title: 'TradingView health',
    description: 'Reports how far TradingView is up, and changes nothing.',
    annotations: READ_ONLY,
    core: true,
    profiles: ['full', 'core', 'readonly'],
    inputSchema: { $schema: SCHEMA, type: 'object', properties: {} },
  },
  {
    name: 'app_get_plan_limits',
    domain: 'app',
    title: 'Read the plan limits',
    description:
      'Reads what the TradingView plan of the signed-in account allows, and changes nothing. ' +
      '99999 means unlimited, and null that the app does not report a limit.',
    annotations: READ_ONLY,
    core: false,
    profiles: ['full', 'readonly'],
    inputSchema: { $schema: SCHEMA, type: 'object', properties: {} },
  },
  {
    name: 'chart_get_state',
    domain: 'chart',
    title: 'Read the chart state',
    description: 'Reads what a chart shows, such as NASDAQ:AAPL on 1D, and changes nothing.',
    annotations: READ_ONLY,
    core: true,
    profiles: ['full', 'core', 'readonly'],
    inputSchema: { $schema: SCHEMA, type: 'object', properties: { chartIndex } },
  },
  {
    name: 'chart_set_symbol',
    domain: 'chart',
    title: 'Change the chart symbol',
    description:
      'Switches a chart to another symbol and waits until its data has loaded.\n\n' +
      'A symbol TradingView does not know fails with INVALID_INPUT, and the chart keeps the symbol ' +
      'it showed.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    core: true,
    profiles: ['full', 'core'],
    inputSchema: {
      $schema: SCHEMA,
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          pattern: '^[A-Z0-9_.:!]+$',
          description: 'Symbol to show, best as EXCHANGE:SYMBOL such as NASDAQ:AAPL.',
        },
        chartIndex,
      },
      required: ['symbol'],
    },
  },
  {
    name: 'drawing_list',
    domain: 'drawing',
    title: 'List the drawings',
    description: 'Lists the drawings on a chart, and changes nothing.',
    annotations: READ_ONLY,
    core: true,
    profiles: ['full', 'core', 'readonly'],
    inputSchema: {
      $schema: SCHEMA,
      type: 'object',
      properties: {
        chartIndex,
        limit: {
          default: 100,
          description: 'How many drawings at most: 1 to 500, 100 by default.',
          type: 'integer',
          minimum: 1,
          maximum: 500,
        },
      },
    },
  },
  {
    name: 'drawing_clear_all',
    domain: 'drawing',
    title: 'Remove the drawings',
    description: 'Removes the drawings of a chart: those this session drew, or all of them.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    core: false,
    profiles: ['full'],
    inputSchema: {
      $schema: SCHEMA,
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['created_by_mcp', 'all'],
          description: 'created_by_mcp for the drawings this session drew, all for every drawing.',
        },
        confirm: { type: 'boolean', description: 'Must be true with scope all.' },
        chartIndex,
      },
      required: ['scope'],
    },
  },
];

// The fixture tool of that name.
export function toolNamed(name: string): DashboardTool {
  const tool = tools.find((each) => each.name === name);
  if (tool === undefined) {
    throw new Error(`No fixture tool is named ${name}`);
  }
  return tool;
}

// A tool result as the registry builds it: the envelope goes into the text block and into
// structuredContent alike.
export function okResult(
  data: JsonValue,
  meta: { via?: string; durationMs?: number; warnings?: string[] } = {},
): DashboardCallResult {
  const envelope = { ok: true, data, meta: { via: 'api', durationMs: 12, ...meta } };
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    structuredContent: envelope,
  };
}

export function errorResult(error: {
  code: DashboardErrorCode;
  message: string;
  hint?: string;
}): DashboardCallResult {
  const envelope = { ok: false, error, meta: { durationMs: 7 } };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    structuredContent: envelope,
  };
}

// What a tool call answers in the fake API; a tool without an entry answers okResult({}).
export const callResults: Record<string, DashboardCallResult> = {
  app_get_plan_limits: okResult(
    {
      limits: {
        INDICATORS_ON_CHART: 5,
        SAVED_PINE_SCRIPTS: 99999,
        CHART_STORAGE: 10,
        MULTIPLE_CHARTS: 2,
        SERVER_SIDE_ALERTS: 20,
        WATCHLIST_SYMBOLS: 1000,
        STUDY_TEMPLATES: null,
        HISTORICAL_BARS: 10000,
      },
    },
    { via: 'internal' },
  ),
  chart_get_state: okResult({ chartIndex: 0, symbol: 'NASDAQ:AAPL', resolution: '1D' }),
  chart_set_symbol: errorResult({
    code: 'INVALID_INPUT',
    message: 'TradingView does not know the symbol NASDAQ:NOPE',
    hint: 'Use EXCHANGE:SYMBOL, such as NASDAQ:AAPL.',
  }),
};

const BASE_TIME = Date.parse('2026-01-02T03:04:05.000Z');

// The time of an event, `ms` after the first.
export function at(ms: number): string {
  return new Date(BASE_TIME + ms).toISOString();
}

// A call id as the registry makes one (a UUID), numbered.
export function callId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export function startEvent(
  seq: number,
  id: string,
  tool: string,
  options: { origin?: DashboardEvent['origin']; args?: JsonValue; at?: string } = {},
): DashboardEvent {
  return {
    seq,
    id,
    tool,
    origin: options.origin ?? 'mcp',
    phase: 'start',
    at: options.at ?? at(seq * 100),
    args: options.args ?? {},
  };
}

export function endEvent(
  seq: number,
  id: string,
  tool: string,
  options: {
    origin?: DashboardEvent['origin'];
    ok?: boolean;
    durationMs?: number;
    errorCode?: DashboardErrorCode;
    at?: string;
  } = {},
): DashboardEvent {
  const event: DashboardEvent = {
    seq,
    id,
    tool,
    origin: options.origin ?? 'mcp',
    phase: 'end',
    at: options.at ?? at(seq * 100),
    durationMs: options.durationMs ?? 42,
    ok: options.ok ?? options.errorCode === undefined,
  };
  if (options.errorCode !== undefined) {
    event.errorCode = options.errorCode;
  }
  return event;
}

// The start and the end of `count` calls in a row, from call number `first`, with seqs from
// `firstSeq`: what a busy client makes the server send.
export function callEvents(count: number, first = 1, firstSeq = 1): DashboardEvent[] {
  const events: DashboardEvent[] = [];
  for (let n = 0; n < count; n += 1) {
    const seq = firstSeq + n * 2;
    const id = callId(first + n);
    events.push(startEvent(seq, id, 'chart_get_state'), endEvent(seq + 1, id, 'chart_get_state'));
  }
  return events;
}

// What the event stream of the fake API replays to a new client: an OK call, a failed one and one
// still running.
export const events: DashboardEvent[] = [
  startEvent(1, callId(1), 'chart_get_state'),
  endEvent(2, callId(1), 'chart_get_state', { durationMs: 38 }),
  startEvent(3, callId(2), 'chart_set_symbol', { args: { symbol: 'NASDAQ:AAPL' } }),
  endEvent(4, callId(2), 'chart_set_symbol', { durationMs: 30000, errorCode: 'TIMEOUT' }),
  startEvent(5, callId(3), 'drawing_list', { origin: 'batch', args: { limit: 10 } }),
];

// Call `n` as the event log holds it while it runs: chart_get_state of origin mcp, unless `fields`
// say otherwise.
export function runningCall(n: number, fields: Partial<ToolCall> = {}): ToolCall {
  return {
    id: callId(n),
    tool: 'chart_get_state',
    origin: 'mcp',
    startedAt: at(n * 100),
    seq: n,
    ...fields,
  };
}

// Call `n` once its end came: OK after 42 ms, unless `fields` say otherwise.
export function endedCall(n: number, fields: Partial<ToolCall> = {}): ToolCall {
  return runningCall(n, { endedAt: at(n * 100 + 42), durationMs: 42, ok: true, ...fields });
}
