import { z } from 'zod';
import { indicatorTools } from '../../../../src/tools/indicator/index.js';
import { allTools } from '../../../../src/tools/index.js';
import type { AnyToolDefinition } from '../../../../src/tools/types.js';

// What the model and the client see of the indicator tools: their names, annotations and input
// schemas. The behavior behind them is tested through a server in
// test/integration/tools/indicator.test.ts.

function toolNamed(name: string): AnyToolDefinition {
  const tool = indicatorTools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`There is no indicator tool ${name}`);
  }
  return tool;
}

const schemaOf = (name: string) => z.object(toolNamed(name).inputSchema);

const READ_TOOLS = ['indicator_list', 'indicator_search', 'indicator_get_values'];

test('indicatorTools lists the indicator tools in the order of the catalog', () => {
  expect(indicatorTools.map(({ name }) => name)).toEqual([
    'indicator_list',
    'indicator_search',
    'indicator_add',
    'indicator_remove',
    'indicator_set_inputs',
    'indicator_set_visibility',
    'indicator_get_values',
  ]);
  expect(new Set(indicatorTools.map(({ domain }) => domain))).toEqual(new Set(['indicator']));
});

test('the catalog lists the indicator tools after the data tools', () => {
  const names = allTools.map(({ name }) => name);

  expect(names.indexOf('indicator_list')).toBe(names.indexOf('data_get_market_depth') + 1);
});

test('every indicator read tool only reads, and the tools that edit an indicator are not core', () => {
  // Reading, adding and removing indicators are the essentials; changing the inputs or the
  // visibility of one that is on the chart can be done with the full profile.
  expect(indicatorTools.filter(({ core }) => core === true).map(({ name }) => name)).toEqual([
    'indicator_list',
    'indicator_search',
    'indicator_add',
    'indicator_remove',
    'indicator_get_values',
  ]);
  expect(toolNamed('indicator_set_inputs').core).toBeUndefined();
  expect(toolNamed('indicator_set_visibility').core).toBeUndefined();
  for (const tool of indicatorTools.filter(({ name }) => READ_TOOLS.includes(name))) {
    expect(tool.annotations, tool.name).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  }
});

test('indicator_add changes the chart without destroying anything, and indicator_remove destroys', () => {
  expect(toolNamed('indicator_add').annotations).toEqual({
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  });
  expect(toolNamed('indicator_remove').annotations).toEqual({
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  });
  for (const name of ['indicator_set_inputs', 'indicator_set_visibility']) {
    expect(toolNamed(name).annotations, name).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  }
});

test('indicator_add takes a name, inputs of text, numbers or booleans, overlay and a chart', () => {
  const schema = schemaOf('indicator_add');

  expect(schema.parse({ name: 'RSI' })).toEqual({ name: 'RSI' });
  expect(
    schema.parse({
      name: 'RSI',
      inputs: { Length: 21, Source: 'hl2', Show: true },
      overlay: true,
      chartIndex: 0,
    }),
  ).toEqual({
    name: 'RSI',
    inputs: { Length: 21, Source: 'hl2', Show: true },
    overlay: true,
    chartIndex: 0,
  });
  expect(schema.safeParse({}).success).toBe(false);
  expect(schema.safeParse({ name: '' }).success).toBe(false);
  expect(schema.safeParse({ name: 'RSI', inputs: { Length: [1] } }).success).toBe(false);
  expect(schema.safeParse({ name: 'RSI', inputs: { Length: null } }).success).toBe(false);
});

test('indicator_remove takes an id and an optional confirm', () => {
  expect(schemaOf('indicator_remove').parse({ id: 'AbC123', confirm: true })).toEqual({
    id: 'AbC123',
    confirm: true,
  });
  expect(schemaOf('indicator_remove').safeParse({ id: '' }).success).toBe(false);
  expect(schemaOf('indicator_remove').safeParse({ id: 'a', confirm: 'yes' }).success).toBe(false);
});

test('indicator_set_inputs takes an id and inputs, and indicator_set_visibility an id and visible', () => {
  expect(schemaOf('indicator_set_inputs').parse({ id: 'a', inputs: { in_0: 3 } })).toEqual({
    id: 'a',
    inputs: { in_0: 3 },
  });
  expect(schemaOf('indicator_set_inputs').safeParse({ id: 'a' }).success).toBe(false);
  expect(schemaOf('indicator_set_visibility').parse({ id: 'a', visible: false })).toEqual({
    id: 'a',
    visible: false,
  });
  expect(schemaOf('indicator_set_visibility').safeParse({ id: 'a' }).success).toBe(false);
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
