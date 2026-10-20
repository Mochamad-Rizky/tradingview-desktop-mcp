import { z } from 'zod';
import { indicatorTools } from '../../../../src/tools/indicator/index.js';
import { allTools } from '../../../../src/tools/index.js';
import type { AnyToolDefinition } from '../../../../src/tools/types.js';

// What the model and the client see of the indicator read tools: their names, annotations and
// input schemas. The behavior behind them is tested through a server in
// test/integration/tools/indicator.test.ts.

function toolNamed(name: string): AnyToolDefinition {
  const tool = indicatorTools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`There is no indicator tool ${name}`);
  }
  return tool;
}

const schemaOf = (name: string) => z.object(toolNamed(name).inputSchema);

test('indicatorTools lists the indicator read tools in the order of the catalog', () => {
  expect(indicatorTools.map(({ name }) => name)).toEqual([
    'indicator_list',
    'indicator_search',
    'indicator_get_values',
  ]);
  expect(new Set(indicatorTools.map(({ domain }) => domain))).toEqual(new Set(['indicator']));
});

test('the catalog lists the indicator tools after the data tools', () => {
  const names = allTools.map(({ name }) => name);

  expect(names.indexOf('indicator_list')).toBe(names.indexOf('data_get_market_depth') + 1);
});

test('every indicator read tool only reads and is core', () => {
  for (const tool of indicatorTools) {
    expect(tool.annotations, tool.name).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(tool.core, tool.name).toBe(true);
  }
});

test('indicator_search takes a query and up to 50 results, 20 by default', () => {
  expect(schemaOf('indicator_search').parse({ query: 'rsi' })).toEqual({ query: 'rsi', limit: 20 });
  expect(schemaOf('indicator_search').safeParse({}).success).toBe(false);
  for (const limit of [0, 51, 1.5]) {
    expect(schemaOf('indicator_search').safeParse({ query: 'a', limit }).success).toBe(false);
  }
});

test('indicator_get_values takes an id, up to 500 rows, 1 by default, and a time', () => {
  expect(schemaOf('indicator_get_values').parse({ id: 'AbC123' })).toEqual({
    id: 'AbC123',
    count: 1,
  });
  expect(
    schemaOf('indicator_get_values').parse({
      id: 'a',
      count: 500,
      at: '2024-01-02',
      chartIndex: 0,
    }),
  ).toEqual({ id: 'a', count: 500, at: '2024-01-02', chartIndex: 0 });
  for (const count of [0, 501, 1.5]) {
    expect(schemaOf('indicator_get_values').safeParse({ id: 'a', count }).success).toBe(false);
  }
  expect(schemaOf('indicator_get_values').safeParse({ id: '' }).success).toBe(false);
});
