import { z } from 'zod';
import { dataTools } from '../../../../src/tools/data/index.js';
import { allTools } from '../../../../src/tools/index.js';
import type { AnyToolDefinition } from '../../../../src/tools/types.js';

// What the model and the client see of the market data tools: their names, annotations and input
// schemas. The behavior behind them is tested through a server in test/integration/tools/data.test.ts.

function toolNamed(name: string): AnyToolDefinition {
  const tool = dataTools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`There is no data tool ${name}`);
  }
  return tool;
}

const schemaOf = (name: string) => z.object(toolNamed(name).inputSchema);

test('dataTools lists the market data tools of the catalog, in its order', () => {
  expect(dataTools.map(({ name }) => name)).toEqual([
    'data_get_ohlcv',
    'data_get_quote',
    'data_get_symbol_info',
    'data_search_symbols',
    'data_get_market_depth',
  ]);
  expect(new Set(dataTools.map(({ domain }) => domain))).toEqual(new Set(['data']));
});

test('the catalog lists the data tools after the chart tools', () => {
  const names = allTools.map(({ name }) => name);

  expect(names.indexOf('data_get_ohlcv')).toBe(names.indexOf('chart_scroll_to_date') + 1);
});

test('every data tool only reads, and all but market depth are core', () => {
  for (const tool of dataTools) {
    expect(tool.annotations, tool.name).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  }
  expect(dataTools.filter(({ core }) => core === true).map(({ name }) => name)).toEqual([
    'data_get_ohlcv',
    'data_get_quote',
    'data_get_symbol_info',
    'data_search_symbols',
  ]);
});

test('data_get_ohlcv takes up to 5000 bars, 100 by default', () => {
  expect(schemaOf('data_get_ohlcv').parse({})).toEqual({ count: 100 });
  expect(
    schemaOf('data_get_ohlcv').parse({ count: 5000, from: '2024-01-02', to: 1704240000 }),
  ).toEqual({ count: 5000, from: '2024-01-02', to: 1704240000 });
  for (const count of [0, 5001, 1.5]) {
    expect(schemaOf('data_get_ohlcv').safeParse({ count }).success, String(count)).toBe(false);
  }
});

test('data_search_symbols takes the search types of the app by their plain names', () => {
  expect(schemaOf('data_search_symbols').parse({ query: 'btc', type: 'crypto' })).toEqual({
    query: 'btc',
    type: 'crypto',
    limit: 20,
  });
  for (const input of [
    { query: 'btc', type: 'bitcoin,crypto' },
    { query: '' },
    { query: 'x', limit: 51 },
  ]) {
    expect(schemaOf('data_search_symbols').safeParse(input).success, JSON.stringify(input)).toBe(
      false,
    );
  }
});

test('data_get_market_depth takes 1 to 50 levels, 10 by default', () => {
  expect(schemaOf('data_get_market_depth').parse({})).toEqual({ levels: 10 });
  expect(schemaOf('data_get_market_depth').safeParse({ levels: 51 }).success).toBe(false);
});

test('the descriptions state the limits a model must know', () => {
  expect(toolNamed('data_get_ohlcv').description).toMatch(/complete/);
  expect(toolNamed('data_get_ohlcv').description).toMatch(/HISTORICAL_BARS/);
  expect(toolNamed('data_get_quote').description).toMatch(/NOT_AVAILABLE/);
  expect(toolNamed('data_get_symbol_info').description).toMatch(/source/);
  // The items of the symbol search of the app have no full name (seen on the app).
  expect(toolNamed('data_get_symbol_info').description).toMatch(
    /gives only symbol, exchange, description, type, typespecs and currency; the rest, fullName included, is null/,
  );
  expect(toolNamed('data_get_market_depth').description).toMatch(/top of the book/i);
});
