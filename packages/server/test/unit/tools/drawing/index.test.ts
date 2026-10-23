import { z } from 'zod';
import { READ_ONLY } from '../../../../src/tools/annotations.js';
import { drawingTools } from '../../../../src/tools/drawing/index.js';
import { allTools } from '../../../../src/tools/index.js';
import { selectTools } from '../../../../src/tools/registry.js';
import { strategyTools } from '../../../../src/tools/strategy/index.js';
import type { AnyToolDefinition } from '../../../../src/tools/types.js';

// What the model and the client see of the drawing tools: their names, annotations and input
// schemas. The behavior behind them is tested through a server in
// test/integration/tools/drawing.test.ts.

function toolNamed(name: string): AnyToolDefinition {
  const tool = drawingTools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`There is no drawing tool ${name}`);
  }
  return tool;
}

const schemaOf = (name: string) => z.object(toolNamed(name).inputSchema);

const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

test('drawingTools lists the drawing tools in the order of the catalog', () => {
  expect(drawingTools.map(({ name }) => name)).toEqual([
    'drawing_create',
    'drawing_list',
    'drawing_get',
    'drawing_remove',
    'drawing_clear_all',
  ]);
  expect(new Set(drawingTools.map(({ domain }) => domain))).toEqual(new Set(['drawing']));
});

test('the catalog lists the drawing tools after the strategy tools and before the alert tools', () => {
  const names = allTools.map(({ name }) => name);
  const lastStrategy = strategyTools.at(-1);
  if (lastStrategy === undefined) {
    throw new Error('There are no strategy tools');
  }

  expect(names.indexOf('drawing_create')).toBe(names.indexOf(lastStrategy.name) + 1);
  expect(names.indexOf('drawing_clear_all')).toBe(names.indexOf('alert_create') - 1);
});

test('drawing_list and drawing_get only read, so the readonly profile offers them and no other', () => {
  expect(toolNamed('drawing_list').annotations).toBe(READ_ONLY);
  expect(toolNamed('drawing_get').annotations).toBe(READ_ONLY);
  expect(
    selectTools(drawingTools, { profile: 'readonly', patterns: [] }).map(({ name }) => name),
  ).toEqual(['drawing_list', 'drawing_get']);
});

test('drawing_remove and drawing_clear_all destroy, and drawing_create changes the chart without destroying', () => {
  expect(toolNamed('drawing_remove').annotations).toEqual(DESTRUCTIVE);
  expect(toolNamed('drawing_clear_all').annotations).toEqual(DESTRUCTIVE);
  expect(toolNamed('drawing_create').annotations).toEqual({
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  });
});

// The core profile itself is pinned in test/unit/tools/registry.test.ts.
test('the core profile keeps drawing_create and drawing_list of the drawing tools', () => {
  const core = selectTools(drawingTools, { profile: 'core', patterns: [] });

  expect(core.map(({ name }) => name)).toEqual(['drawing_create', 'drawing_list']);
  for (const tool of drawingTools.filter((candidate) => !core.includes(candidate))) {
    expect(tool.core, tool.name).toBeUndefined();
  }
});

test('drawing_create takes a curated shape, points of a time and a price, a text, a style and a chart', () => {
  const schema = schemaOf('drawing_create');
  const input = {
    shape: 'trend_line',
    points: [
      { time: '2024-03-01', price: 101.5 },
      { time: 1_709_510_400, price: 103 },
    ],
    text: 'support',
    style: { color: '#FF5500', lineWidth: 2, lineStyle: 'dashed', fontSize: 12 },
    chartIndex: 0,
  };

  expect(schema.parse(input)).toEqual(input);
  expect(schema.parse({ shape: 'flag', points: [{ time: 1_709_510_400_000, price: 1 }] })).toEqual({
    shape: 'flag',
    points: [{ time: 1_709_510_400_000, price: 1 }],
  });
  expect(
    schema.parse({
      shape: 'text',
      points: [{ time: 1_709_510_400, price: 1 }],
      text: 'a',
      style: { color: 'rgba(255, 85, 0, 0.5)' },
    }).style,
  ).toEqual({ color: 'rgba(255, 85, 0, 0.5)' });
});

test.each([
  ['an unknown shape', { shape: 'arrow_marker' }],
  ['no points', { points: [] }],
  ['more than ten points', { points: Array.from({ length: 11 }, () => ({ time: 1, price: 1 })) }],
  ['a point without a price', { points: [{ time: 1_709_510_400 }] }],
  ['an empty text', { text: '' }],
  ['a line width of 5', { style: { lineWidth: 5 } }],
  ['a line width that is no integer', { style: { lineWidth: 1.5 } }],
  ['a font size of 7', { style: { fontSize: 7 } }],
  ['a font size of 41', { style: { fontSize: 41 } }],
  ['a line style TradingView has no name for here', { style: { lineStyle: 'dashdot' } }],
  ['a color name', { style: { color: 'red' } }],
  ['a short hex color', { style: { color: '#f50' } }],
])('drawing_create refuses %s', (_label, change) => {
  const base = { shape: 'horizontal_line', points: [{ time: 1_709_510_400, price: 1 }] };

  expect(schemaOf('drawing_create').safeParse({ ...base, ...change }).success).toBe(false);
});

test('drawing_list pages 100 drawings by default, from the first, and at most 500', () => {
  const schema = schemaOf('drawing_list');

  expect(schema.parse({})).toEqual({ limit: 100, offset: 0 });
  expect(schema.parse({ limit: 500, offset: 50, chartIndex: 0 })).toEqual({
    limit: 500,
    offset: 50,
    chartIndex: 0,
  });
  for (const change of [{ limit: 0 }, { limit: 501 }, { limit: 1.5 }, { offset: -1 }]) {
    expect(schema.safeParse(change).success, JSON.stringify(change)).toBe(false);
  }
});

test('drawing_get takes an id, and drawing_remove an id and an optional confirm', () => {
  expect(schemaOf('drawing_get').parse({ id: 'AbC123' })).toEqual({ id: 'AbC123' });
  expect(schemaOf('drawing_get').safeParse({ id: '' }).success).toBe(false);
  expect(schemaOf('drawing_remove').parse({ id: 'AbC123', confirm: true })).toEqual({
    id: 'AbC123',
    confirm: true,
  });
  expect(schemaOf('drawing_remove').safeParse({}).success).toBe(false);
  expect(schemaOf('drawing_remove').safeParse({ id: 'a', confirm: 'yes' }).success).toBe(false);
});

test('drawing_clear_all needs a scope, created_by_mcp or all, and takes an optional confirm', () => {
  const schema = schemaOf('drawing_clear_all');

  expect(schema.parse({ scope: 'created_by_mcp' })).toEqual({ scope: 'created_by_mcp' });
  expect(schema.parse({ scope: 'all', confirm: true })).toEqual({ scope: 'all', confirm: true });
  expect(schema.safeParse({}).success).toBe(false);
  expect(schema.safeParse({ scope: 'mine' }).success).toBe(false);
});
