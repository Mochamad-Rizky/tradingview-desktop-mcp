/** @import { DashboardCallResult, DashboardErrorCode, DashboardEvent, DashboardHealth, DashboardInfo, DashboardTool, JsonValue } from '../../server/src/transports/dashboard/contract.ts' */

// What the mock server of the end-to-end tests answers with, and the screenshots of the README
// show. Every value is made up: the tools are a few of the server's own with their descriptions
// cut short, the symbols are placeholders, and no value comes from a real account or chart.

export const MOCK_HOST = '127.0.0.1';
export const MOCK_PORT = 4173;
export const MOCK_URL = `http://${MOCK_HOST}:${String(MOCK_PORT)}`;

// The token the mock accepts, as TV_MCP_AUTH_TOKEN would hold it.
export const MOCK_TOKEN = 'e2e-token-0123456789abcdef0123456789abcdef';

// The headers of every answer of the dashboard files, a 404 included, as the server's
// transports/dashboard/static.ts sends them. The mock sends these, and a test of auth.spec.ts holds
// the real server to them as well, so that the two cannot drift apart unseen.
export const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

const DEBUG_PORT = 'http://127.0.0.1:9222';
const BROWSER = 'Chrome/146.0.7680.216';

// TradingView as the status page can find it: up with a chart in front, up with the chart in a
// tab behind another, and not running with its debug port.
/** @type {Record<'ready' | 'background' | 'unreachable', DashboardHealth>} */
export const health = {
  ready: {
    cdp: {
      reachable: true,
      endpoint: DEBUG_PORT,
      browser: BROWSER,
      userAgent: `Mozilla/5.0 (Macintosh) TradingView/3.4.1 ${BROWSER} Electron/41.7.1`,
    },
    chart: {
      found: true,
      tabs: 1,
      url: 'https://www.tradingview.com/chart/EXAMPLE1/',
      inBackground: false,
    },
    app: { ready: true, connected: true, buildTime: '2026-09-30T12:00:00.000Z' },
  },
  background: {
    cdp: { reachable: true, endpoint: DEBUG_PORT, browser: BROWSER },
    chart: {
      found: true,
      tabs: 2,
      url: 'https://www.tradingview.com/chart/EXAMPLE1/',
      inBackground: true,
    },
    app: { ready: false, connected: true, buildTime: null },
  },
  unreachable: {
    cdp: { reachable: false, endpoint: DEBUG_PORT },
    chart: { found: false, tabs: 0 },
    app: { ready: false },
  },
};

const SCHEMA = 'https://json-schema.org/draft/2020-12/schema';

/** @type {JsonValue} */
const chartIndex = {
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
const CHANGES = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const ADDS = { ...CHANGES, idempotentHint: false };
const REMOVES = { ...ADDS, destructiveHint: true };

/** @type {DashboardTool['profiles']} */
const ALL_PROFILES = ['full', 'core', 'readonly'];
/** @type {DashboardTool['profiles']} */
const CORE_PROFILES = ['full', 'core'];

/**
 * @param {Record<string, JsonValue>} properties
 * @param {string[]} [required]
 * @returns {Record<string, JsonValue>}
 */
function objectSchema(properties, required) {
  return {
    $schema: SCHEMA,
    type: 'object',
    properties,
    ...(required === undefined ? {} : { required }),
  };
}

// Fourteen tools of seven domains: read-only ones, ones that change the chart or the account and
// one that removes data; core tools and others.
/** @type {DashboardTool[]} */
export const tools = [
  {
    name: 'app_health',
    domain: 'app',
    title: 'TradingView health',
    description:
      'Reports how far TradingView is up, and changes nothing: whether the debug port answers, ' +
      'how many chart tabs are open and whether the app is ready.',
    annotations: READ_ONLY,
    core: true,
    profiles: ALL_PROFILES,
    inputSchema: objectSchema({}),
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
    inputSchema: objectSchema({}),
  },
  {
    name: 'chart_get_state',
    domain: 'chart',
    title: 'Read the chart state',
    description:
      'Reads what a chart shows, and changes nothing: its symbol, timeframe, chart type, visible ' +
      'range, indicators and number of drawings, and the layout it is part of.',
    annotations: READ_ONLY,
    core: true,
    profiles: ALL_PROFILES,
    inputSchema: objectSchema({ chartIndex }),
  },
  {
    name: 'chart_set_symbol',
    domain: 'chart',
    title: 'Change the chart symbol',
    description:
      'Switches a chart to another symbol and waits until its data has loaded.\n\n' +
      'A symbol TradingView does not know fails with INVALID_INPUT, and the chart keeps the ' +
      'symbol it showed.',
    annotations: CHANGES,
    core: true,
    profiles: CORE_PROFILES,
    inputSchema: objectSchema(
      {
        symbol: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: 'Symbol to show, best in the EXCHANGE:SYMBOL form such as NASDAQ:AAPL.',
        },
        chartIndex,
      },
      ['symbol'],
    ),
  },
  {
    name: 'chart_set_timeframe',
    domain: 'chart',
    title: 'Change the chart timeframe',
    description:
      'Changes the timeframe of a chart and waits until its data has loaded. Takes TradingView ' +
      'resolutions and the usual aliases: 1h is 60, 1d is 1D.',
    annotations: CHANGES,
    core: true,
    profiles: CORE_PROFILES,
    inputSchema: objectSchema(
      {
        timeframe: {
          type: 'string',
          minLength: 1,
          maxLength: 16,
          description: 'Timeframe to show, such as 15, 60, 1D or 1W.',
        },
        chartIndex,
      },
      ['timeframe'],
    ),
  },
  {
    name: 'data_get_ohlcv',
    domain: 'data',
    title: 'Read OHLCV bars',
    description:
      'Reads the bars (open, high, low, close, volume) of the symbol and timeframe a chart ' +
      'shows, and changes nothing.',
    annotations: READ_ONLY,
    core: true,
    profiles: ALL_PROFILES,
    inputSchema: objectSchema({
      count: {
        default: 100,
        description: 'How many bars, the most recent first counted: 1 to 5000, 100 by default.',
        type: 'integer',
        minimum: 1,
        maximum: 5000,
      },
      chartIndex,
    }),
  },
  {
    name: 'data_get_quote',
    domain: 'data',
    title: 'Read a quote',
    description: 'Reads the latest quote of a symbol, and changes nothing.',
    annotations: READ_ONLY,
    core: true,
    profiles: ALL_PROFILES,
    inputSchema: objectSchema({
      symbol: {
        description: 'Symbol to quote. Leave it out for the symbol of the active chart.',
        type: 'string',
        minLength: 1,
        maxLength: 200,
      },
    }),
  },
  {
    name: 'indicator_list',
    domain: 'indicator',
    title: 'List indicators',
    description: 'Lists the indicators on a chart, strategies included, and changes nothing.',
    annotations: READ_ONLY,
    core: true,
    profiles: ALL_PROFILES,
    inputSchema: objectSchema({ chartIndex }),
  },
  {
    name: 'indicator_add',
    domain: 'indicator',
    title: 'Add an indicator',
    description:
      'Adds an indicator to a chart, by its name or short name, such as RSI. The indicator ' +
      'limit of the plan is checked first.',
    annotations: ADDS,
    core: true,
    profiles: CORE_PROFILES,
    inputSchema: objectSchema(
      {
        name: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: 'The indicator: its name or short name.',
        },
        chartIndex,
      },
      ['name'],
    ),
  },
  {
    name: 'drawing_list',
    domain: 'drawing',
    title: 'List drawings',
    description: 'Lists the drawings on a chart, a page at a time, and changes nothing.',
    annotations: READ_ONLY,
    core: true,
    profiles: ALL_PROFILES,
    inputSchema: objectSchema({
      chartIndex,
      limit: {
        default: 100,
        description: 'How many drawings at most: 1 to 500, 100 by default.',
        type: 'integer',
        minimum: 1,
        maximum: 500,
      },
    }),
  },
  {
    name: 'drawing_clear_all',
    domain: 'drawing',
    title: 'Remove drawings',
    description:
      'Removes drawings from a chart: those this session drew, or all of them, the ones of the ' +
      'user too.',
    annotations: REMOVES,
    core: false,
    profiles: ['full'],
    inputSchema: objectSchema(
      {
        scope: {
          type: 'string',
          enum: ['created_by_mcp', 'all'],
          description: 'created_by_mcp for the drawings this session drew, all for every drawing.',
        },
        confirm: { description: 'Must be true with scope all.', type: 'boolean' },
        chartIndex,
      },
      ['scope'],
    ),
  },
  {
    name: 'alert_list',
    domain: 'alert',
    title: 'List alerts',
    description: 'Lists the alerts of the TradingView account, and changes nothing.',
    annotations: READ_ONLY,
    core: true,
    profiles: ALL_PROFILES,
    inputSchema: objectSchema({
      status: {
        default: 'all',
        description: 'Which alerts: active, stopped, triggered, or all (the default).',
        type: 'string',
        enum: ['active', 'stopped', 'triggered', 'all'],
      },
    }),
  },
  {
    name: 'alert_create',
    domain: 'alert',
    title: 'Create a price alert',
    description:
      'Creates a price alert in the TradingView account, as the alert dialog of TradingView ' +
      'would. The alert limit of the plan is checked first.',
    annotations: ADDS,
    core: true,
    profiles: CORE_PROFILES,
    inputSchema: objectSchema(
      {
        symbol: {
          description: 'What to watch, such as NASDAQ:AAPL. Default: the symbol of the chart.',
          type: 'string',
          minLength: 1,
          maxLength: 200,
        },
        condition: {
          type: 'string',
          enum: ['crossing', 'crossing_up', 'crossing_down', 'greater_than', 'less_than'],
          description: 'When the alert fires.',
        },
        price: { type: 'number', description: 'The price the alert compares with.' },
      },
      ['condition', 'price'],
    ),
  },
  {
    name: 'watchlist_get',
    domain: 'watchlist',
    title: 'Read a watchlist',
    description:
      'Reads one watchlist of the TradingView account, the active one by default, and changes ' +
      'nothing.',
    annotations: READ_ONLY,
    core: true,
    profiles: ALL_PROFILES,
    inputSchema: objectSchema({
      listId: {
        description: 'The id of a watchlist. Default: the active watchlist.',
        type: 'string',
        minLength: 1,
        maxLength: 200,
      },
    }),
  },
];

/** @type {DashboardInfo} */
export const info = {
  name: 'tradingview-desktop-mcp',
  version: '0.1.0',
  transport: 'http',
  profile: 'full',
  toolPatterns: [],
  allowEval: false,
  toolCount: tools.length,
  mcpEndpoint: 'http://127.0.0.1:8787/mcp',
  startedAt: '2026-10-20T09:28:41.000Z',
};

// The symbols the mock knows, as TradingView names them.
const SYMBOLS = ['NASDAQ:AAPL', 'NASDAQ:MSFT', 'NYSE:IBM', 'BINANCE:BTCUSDT'];

/**
 * A tool result as the registry builds it: the envelope goes into the text block and into
 * structuredContent alike, and the meta of a success always holds its warnings.
 * @param {JsonValue} data
 * @param {{ via: string, durationMs: number, warnings?: string[] }} meta
 * @returns {DashboardCallResult}
 */
function okResult(data, meta) {
  const envelope = { ok: true, data, meta: { ...meta, warnings: meta.warnings ?? [] } };
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    structuredContent: envelope,
  };
}

/**
 * @param {{ code: DashboardErrorCode, message: string, hint?: string, details?: JsonValue }} error
 * @param {number} durationMs
 * @returns {DashboardCallResult}
 */
function errorResult(error, durationMs) {
  const envelope = { ok: false, error, meta: { durationMs } };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    structuredContent: envelope,
  };
}

/** @type {Record<string, (args: Record<string, JsonValue>) => DashboardCallResult>} */
const RESULTS = {
  app_health: () => okResult(health.ready, { via: 'cdp', durationMs: 21 }),
  app_get_plan_limits: () =>
    okResult(
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
      { via: 'internal', durationMs: 64 },
    ),
  chart_get_state: (args) =>
    args.chartIndex === undefined || args.chartIndex === 0
      ? okResult(
          {
            chartIndex: 0,
            symbol: 'NASDAQ:AAPL',
            resolution: '1D',
            chartType: 1,
            chartTypeName: 'candles',
            visibleRange: {
              from: 1771200000,
              to: 1792800000,
              fromIso: '2026-02-16T00:00:00.000Z',
              toIso: '2026-10-24T00:00:00.000Z',
            },
            studies: [{ id: 'st1', name: 'Volume' }],
            drawingCount: 2,
            layout: {
              type: 's',
              chartsCount: 1,
              activeChartIndex: 0,
              name: 'Example layout',
              id: 'EXAMPLE1',
            },
          },
          { via: 'api', durationMs: 38 },
        )
      : // As the server words it for a layout of one chart.
        errorResult(
          {
            code: 'INVALID_INPUT',
            message: `chartIndex ${JSON.stringify(args.chartIndex)} is out of range: the layout has 1 chart, so chartIndex must be 0`,
            hint:
              'Leave chartIndex out to use the active chart. chart_get_state reports how many ' +
              'charts the layout has (layout.chartsCount).',
            details: { chartIndex: args.chartIndex ?? null, chartsCount: 1 },
          },
          9,
        ),
  chart_set_symbol: (args) =>
    typeof args.symbol === 'string' && SYMBOLS.includes(args.symbol)
      ? okResult(
          { symbol: args.symbol, previous: 'NASDAQ:AAPL', changed: args.symbol !== 'NASDAQ:AAPL' },
          { via: 'api', durationMs: 1240 },
        )
      : errorResult(
          {
            code: 'INVALID_INPUT',
            message: `TradingView does not know the symbol ${JSON.stringify(args.symbol ?? null)}`,
            hint: 'Use the EXCHANGE:SYMBOL form, such as NASDAQ:AAPL, as data_search_symbols reports it.',
          },
          2140,
        ),
  chart_set_timeframe: (args) =>
    okResult(
      { resolution: args.timeframe ?? '1D', previous: '1D', changed: args.timeframe !== '1D' },
      { via: 'api', durationMs: 910 },
    ),
  data_get_ohlcv: () =>
    okResult(
      {
        symbol: 'NASDAQ:AAPL',
        resolution: '1D',
        count: 3,
        bars: [
          { time: 1792540800, open: 101.5, high: 103.25, low: 100.75, close: 102.5, volume: 40100 },
          { time: 1792627200, open: 102.5, high: 104, low: 101.25, close: 103.75, volume: 38200 },
          { time: 1792713600, open: 103.75, high: 105.5, low: 103, close: 104.25, volume: 41800 },
        ],
      },
      { via: 'api', durationMs: 412 },
    ),
  data_get_quote: (args) =>
    okResult(
      {
        symbol: typeof args.symbol === 'string' ? args.symbol : 'NASDAQ:AAPL',
        last: 104.25,
        change: 0.5,
        changePercent: 0.48,
        currency: 'USD',
        time: 1792800000,
        timeIso: '2026-10-24T00:00:00.000Z',
      },
      { via: 'api', durationMs: 57 },
    ),
  indicator_list: () =>
    okResult(
      { studies: [{ id: 'st1', name: 'Volume', title: 'Vol', visible: true, isPine: false }] },
      { via: 'api', durationMs: 47 },
    ),
  indicator_add: (args) =>
    okResult(
      { id: 'st7', name: args.name ?? null, chartIndex: 0 },
      { via: 'api', durationMs: 655 },
    ),
  drawing_list: () =>
    okResult(
      {
        total: 2,
        drawings: [
          { id: 'dr1', shape: 'horizontal_line', points: [{ time: 1792540800, price: 100 }] },
          { id: 'dr2', shape: 'trend_line', points: [{ time: 1790000000, price: 95.5 }] },
        ],
      },
      { via: 'api', durationMs: 29 },
    ),
  drawing_clear_all: (args) =>
    okResult({ scope: args.scope ?? null, removed: 2 }, { via: 'api', durationMs: 188 }),
  alert_list: () =>
    okResult(
      {
        alerts: [
          { id: 'al1', symbol: 'NASDAQ:AAPL', condition: 'crossing_up', price: 110, active: true },
        ],
      },
      { via: 'internal', durationMs: 133 },
    ),
  alert_create: () =>
    errorResult(
      {
        code: 'PLAN_LIMIT',
        message: 'The plan allows 20 server-side alerts, and 20 are set',
        hint: 'Delete an alert with alert_delete first, or choose a plan that allows more.',
      },
      302,
    ),
};

/**
 * What a call of `name` with `args` answers.
 * @param {string} name
 * @param {Record<string, JsonValue>} args
 * @returns {DashboardCallResult}
 */
export function resultFor(name, args) {
  const result = RESULTS[name];
  return result === undefined ? okResult({}, { via: 'api', durationMs: 15 }) : result(args);
}

/**
 * How long a result says its call took, for the end event of the call.
 * @param {DashboardCallResult} result
 * @returns {number}
 */
export function durationOf(result) {
  const meta = result.structuredContent?.meta;
  const durationMs =
    typeof meta === 'object' && meta !== null && !Array.isArray(meta) ? meta.durationMs : undefined;
  return typeof durationMs === 'number' ? durationMs : 0;
}

/**
 * The error code of a failed result, for the end event of the call.
 * @param {DashboardCallResult} result
 * @returns {DashboardErrorCode | undefined}
 */
export function errorCodeOf(result) {
  const error = result.structuredContent?.error;
  return asErrorCode(
    typeof error === 'object' && error !== null && !Array.isArray(error) ? error.code : undefined,
  );
}

/**
 * The error code `value` names, or undefined when it names none.
 * @param {JsonValue | undefined} value
 * @returns {DashboardErrorCode | undefined}
 */
export function asErrorCode(value) {
  return ERROR_CODES.find((code) => code === value);
}

/** @type {DashboardErrorCode[]} */
const ERROR_CODES = [
  'TV_NOT_INSTALLED',
  'TV_NOT_RUNNING',
  'RESTART_REQUIRED',
  'LAUNCH_FAILED',
  'CDP_UNREACHABLE',
  'TARGET_NOT_FOUND',
  'TIMEOUT',
  'PAGE_EVALUATION_FAILED',
  'CAPABILITY_UNAVAILABLE',
  'NOT_AVAILABLE',
  'PLAN_LIMIT',
  'INVALID_INPUT',
  'CONFIRMATION_REQUIRED',
  'UNSAFE_ACTION_BLOCKED',
  'AUTH_REQUIRED',
  'INTERNAL',
];

/** @typedef {Omit<DashboardEvent, 'seq'>} UnnumberedEvent */

const BASE_TIME = Date.parse('2026-10-20T09:30:00.000Z');

/**
 * A call id as the registry makes one (a UUID), numbered.
 * @param {number} n
 */
export function callId(n) {
  return `5b0f0c1e-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/**
 * @typedef {object} BacklogCall
 * @property {string} tool
 * @property {DashboardEvent['origin']} origin
 * @property {number} startMs When it started, after the first call.
 * @property {JsonValue} args
 * @property {number} [durationMs] Left out for a call still running.
 * @property {DashboardErrorCode} [errorCode]
 */

/** @type {BacklogCall[]} */
const BACKLOG = [
  { tool: 'app_health', origin: 'mcp', startMs: 0, args: {}, durationMs: 21 },
  { tool: 'chart_get_state', origin: 'mcp', startMs: 4_200, args: {}, durationMs: 38 },
  { tool: 'data_get_ohlcv', origin: 'mcp', startMs: 9_800, args: { count: 300 }, durationMs: 412 },
  {
    tool: 'chart_set_symbol',
    origin: 'mcp',
    startMs: 31_500,
    args: { symbol: 'NASDAQ:MSFT' },
    durationMs: 1240,
  },
  {
    tool: 'indicator_add',
    origin: 'batch',
    startMs: 47_000,
    args: { name: 'RSI' },
    durationMs: 655,
  },
  { tool: 'indicator_list', origin: 'batch', startMs: 47_700, args: {}, durationMs: 47 },
  {
    tool: 'alert_create',
    origin: 'mcp',
    startMs: 72_300,
    args: { symbol: 'NASDAQ:MSFT', condition: 'crossing_up', price: 450 },
    durationMs: 302,
    errorCode: 'PLAN_LIMIT',
  },
  {
    tool: 'data_get_quote',
    origin: 'mcp',
    startMs: 95_000,
    args: { symbol: 'NYSE:IBM' },
    durationMs: 15_000,
    errorCode: 'TIMEOUT',
  },
  {
    tool: 'app_get_plan_limits',
    origin: 'dashboard',
    startMs: 128_400,
    args: {},
    durationMs: 64,
  },
  { tool: 'drawing_list', origin: 'mcp', startMs: 151_900, args: { limit: 50 }, durationMs: 29 },
  { tool: 'data_get_ohlcv', origin: 'mcp', startMs: 166_000, args: { count: 5000 } },
];

/**
 * The events the mock's bus holds when it starts, oldest first, without their seqs: the starts
 * and ends of a few calls of every origin, two of them failed and the last one still running.
 * @returns {UnnumberedEvent[]}
 */
export function backlogEvents() {
  /** @type {UnnumberedEvent[]} */
  const events = [];
  BACKLOG.forEach((call, index) => {
    const id = callId(index + 1);
    const { tool, origin } = call;
    events.push({
      id,
      tool,
      origin,
      phase: 'start',
      at: new Date(BASE_TIME + call.startMs).toISOString(),
      args: call.args,
    });
    if (call.durationMs !== undefined) {
      events.push({
        id,
        tool,
        origin,
        phase: 'end',
        at: new Date(BASE_TIME + call.startMs + call.durationMs).toISOString(),
        durationMs: call.durationMs,
        ok: call.errorCode === undefined,
        ...(call.errorCode === undefined ? {} : { errorCode: call.errorCode }),
      });
    }
  });
  // In the order the bus emitted them: an end can come after the start of a later call.
  return events.sort((a, b) => a.at.localeCompare(b.at));
}
