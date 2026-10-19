import { z } from 'zod';
import { chartTools } from '../../../../src/tools/chart/index.js';
import { CHART_TYPES } from '../../../../src/tools/chart/mappers.js';
import type { AnyToolDefinition } from '../../../../src/tools/types.js';

// What the model and the client see of the chart tools: their names, their annotations, and the
// promises their descriptions make. The behavior behind them is tested through a server in
// test/integration/tools/chart.test.ts.

function toolNamed(name: string): AnyToolDefinition {
  const tool = chartTools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`There is no chart tool ${name}`);
  }
  return tool;
}

const descriptionOf = (tool: AnyToolDefinition, field: string): string | undefined =>
  z.globalRegistry.get(tool.inputSchema[field] ?? z.never())?.description;

const schemaOf = (name: string) => z.object(toolNamed(name).inputSchema);

// The sentence every time input carries, word for word.
const TIME_INPUT =
  'ISO 8601 date/time (e.g. 2024-01-31 or 2024-01-31T10:00:00Z) or Unix timestamp in ' +
  'seconds/milliseconds; compact forms like 20240131 are rejected';

test('chartTools lists the chart tools of the catalog, in its order', () => {
  expect(chartTools.map(({ name }) => name)).toEqual([
    'chart_get_state',
    'chart_set_symbol',
    'chart_set_timeframe',
    'chart_set_type',
    'chart_get_visible_range',
    'chart_set_visible_range',
    'chart_scroll_to_date',
  ]);
  expect(new Set(chartTools.map(({ domain }) => domain))).toEqual(new Set(['chart']));
});

test('every chart tool is part of the core profile', () => {
  expect(chartTools.every(({ core }) => core === true)).toBe(true);
});

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
const SET = { readOnlyHint: false, destructiveHint: false, idempotentHint: true };

test.each([
  ['chart_get_state', READ],
  ['chart_set_symbol', SET],
  ['chart_set_timeframe', SET],
  ['chart_set_type', SET],
  ['chart_get_visible_range', READ],
  ['chart_set_visible_range', SET],
  ['chart_scroll_to_date', SET],
])('%s says how it acts', (name, hints) => {
  expect(toolNamed(name).annotations).toEqual({ ...hints, openWorldHint: false });
});

test('every chart tool takes an optional chartIndex and says what it is for', () => {
  for (const tool of chartTools) {
    const chartIndex = descriptionOf(tool, 'chartIndex');

    expect(chartIndex, tool.name).toMatch(/active chart/);
    expect(chartIndex, tool.name).toMatch(/from 0/);
    expect(z.object(tool.inputSchema).safeParse({ chartIndex: -1 }).success, tool.name).toBe(false);
    expect(z.object(tool.inputSchema).safeParse({ chartIndex: 0.5 }).success, tool.name).toBe(
      false,
    );
  }
});

test.each([
  ['chart_set_visible_range', 'from'],
  ['chart_set_visible_range', 'to'],
  ['chart_scroll_to_date', 'date'],
])('the time input %s.%s says which forms it takes', (name, field) => {
  expect(descriptionOf(toolNamed(name), field)).toContain(TIME_INPUT);
});

test('chart_set_timeframe documents the aliases it takes', () => {
  const timeframe = descriptionOf(toolNamed('chart_set_timeframe'), 'timeframe') ?? '';

  expect(timeframe).toMatch(/lowercase m = minutes/);
  expect(timeframe).toMatch(/uppercase M = months/);
  expect(timeframe).toMatch(/h hours/);
  expect(timeframe).toMatch(/d\/D days/);
  expect(timeframe).toMatch(/w\/W weeks/);
  expect(timeframe).toMatch(/s\/S seconds/);
  expect(timeframe).toMatch(/T ticks/);
  expect(timeframe).toMatch(/R ranges/);
  expect(timeframe).toMatch(/1h.*60/);
});

test('chart_set_symbol tells that an unknown symbol is refused and the chart switched back', () => {
  const { description } = toolNamed('chart_set_symbol');

  expect(description).toMatch(/INVALID_INPUT/);
  expect(description).toMatch(/switched back|switches back/);
  expect(descriptionOf(toolNamed('chart_set_symbol'), 'symbol')).toMatch(/NASDAQ:AAPL/);
});

test('chart_set_symbol and chart_set_timeframe tell when a change counts as none', () => {
  const symbol = toolNamed('chart_set_symbol').description;
  const timeframe = toolNamed('chart_set_timeframe').description;

  expect(symbol).toMatch(/data feed/);
  // TradingView loads a bare ticker of the symbol shown again, which ends where it started.
  expect(symbol).toMatch(/bare ticker/);
  expect(timeframe).toMatch(/keeps the timeframe it showed/);
});

test('chart_set_type offers every chart type by name', () => {
  const type = toolNamed('chart_set_type').inputSchema.type;

  expect(type).toBeDefined();
  for (const name of Object.keys(CHART_TYPES)) {
    expect(schemaOf('chart_set_type').safeParse({ type: name }).success, name).toBe(true);
  }
  expect(schemaOf('chart_set_type').safeParse({ type: 'pie' }).success).toBe(false);
  expect(schemaOf('chart_set_type').safeParse({ type: 8 }).success).toBe(false);
});

test('chart_set_visible_range tells to give either from and to or a preset', () => {
  const { description } = toolNamed('chart_set_visible_range');

  expect(description).toMatch(/from and to/);
  expect(description).toMatch(/preset/);
  expect(description).toMatch(/not both/);
  expect(description).toMatch(/timeframe/);
  expect(descriptionOf(toolNamed('chart_set_visible_range'), 'preset')).toMatch(/1D.*ALL/);
});

test('chart_scroll_to_date says where it puts the bar and that the zoom stays', () => {
  const { description } = toolNamed('chart_scroll_to_date');

  expect(description).toMatch(/zoom/);
  expect(descriptionOf(toolNamed('chart_scroll_to_date'), 'align')).toMatch(/center/);
  expect(schemaOf('chart_scroll_to_date').parse({ date: '2024-04-10' })).toEqual({
    date: '2024-04-10',
    align: 'center',
  });
});

// An MCP call is parsed by the SDK first and by the registry again, so a schema must give the same
// value when it parses its own output. Times and timeframes are taken as written and converted by
// the handlers.
test.each([
  ['chart_get_state', {}],
  ['chart_get_state', { chartIndex: 0 }],
  ['chart_set_symbol', { symbol: ' NASDAQ:AAPL ' }],
  ['chart_set_timeframe', { timeframe: '1h' }],
  ['chart_set_type', { type: 'heikin_ashi', chartIndex: 1 }],
  ['chart_get_visible_range', {}],
  ['chart_set_visible_range', { from: '2024-01-31', to: 1706745600 }],
  ['chart_set_visible_range', { preset: 'YTD' }],
  ['chart_scroll_to_date', { date: 1706745600000, align: 'left' }],
])(
  'the input schema of %s gives the same value when it parses its own output: %j',
  (name, input) => {
    const schema = schemaOf(name);

    const once = schema.parse(input);

    expect(once).toEqual({
      ...(name === 'chart_scroll_to_date' ? { align: 'center' } : {}),
      ...input,
    });
    expect(schema.parse(once)).toEqual(once);
  },
);

test.each([
  ['chart_set_symbol', { symbol: '' }],
  ['chart_set_symbol', {}],
  ['chart_set_timeframe', { timeframe: '' }],
  ['chart_set_timeframe', { timeframe: 60 }],
  ['chart_set_visible_range', { from: true, to: '2024-01-31' }],
  ['chart_set_visible_range', { preset: '2Y' }],
  ['chart_scroll_to_date', {}],
  ['chart_scroll_to_date', { date: '2024-04-10', align: 'middle' }],
])('the input schema of %s refuses %j', (name, input) => {
  expect(schemaOf(name).safeParse(input).success).toBe(false);
});
