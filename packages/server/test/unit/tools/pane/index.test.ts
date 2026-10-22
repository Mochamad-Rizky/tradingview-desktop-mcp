import { z } from 'zod';
import { READ_ONLY } from '../../../../src/tools/annotations.js';
import { chartSetSymbol } from '../../../../src/tools/chart/index.js';
import { allTools } from '../../../../src/tools/index.js';
import { layoutTools } from '../../../../src/tools/layout/index.js';
import { PANE_LAYOUT_CODES } from '../../../../src/tools/pane/mappers.js';
import { paneTools } from '../../../../src/tools/pane/index.js';
import { selectTools } from '../../../../src/tools/registry.js';
import type { AnyToolDefinition } from '../../../../src/tools/types.js';

// What the model and the client see of the pane tools: their names, annotations, descriptions and
// input schemas. The behavior behind them is tested through a server in
// test/integration/tools/pane.test.ts.

function toolNamed(name: string): AnyToolDefinition {
  const tool = paneTools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`There is no pane tool ${name}`);
  }
  return tool;
}

const schemaOf = (name: string) => z.object(toolNamed(name).inputSchema);
const descriptionOf = (name: string, field: string): string | undefined =>
  z.globalRegistry.get(toolNamed(name).inputSchema[field] ?? z.never())?.description;

test('paneTools lists the pane tools in the order of the catalog', () => {
  expect(paneTools.map(({ name }) => name)).toEqual([
    'pane_list',
    'pane_set_layout',
    'pane_focus',
    'pane_set_symbol',
  ]);
  expect(new Set(paneTools.map(({ domain }) => domain))).toEqual(new Set(['pane']));
});

test('the catalog lists the pane tools after the layout tools and before the tab tools', () => {
  const names = allTools.map(({ name }) => name);
  const lastLayout = layoutTools.at(-1);
  if (lastLayout === undefined) {
    throw new Error('There are no layout tools');
  }

  expect(names.indexOf('pane_list')).toBe(names.indexOf(lastLayout.name) + 1);
  expect(names.indexOf('pane_set_symbol')).toBe(names.indexOf('tab_list') - 1);
});

test('pane_list only reads, so the readonly profile offers it and no other pane tool', () => {
  expect(toolNamed('pane_list').annotations).toBe(READ_ONLY);
  expect(
    selectTools(paneTools, { profile: 'readonly', patterns: [] }).map(({ name }) => name),
  ).toEqual(['pane_list']);
});

test('pane_set_layout is destructive, since the next save drops the charts a smaller layout hides', () => {
  expect(toolNamed('pane_set_layout').annotations).toEqual({
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  });
});

test('pane_focus changes what is active only, and calling it again changes nothing more', () => {
  expect(toolNamed('pane_focus').annotations).toEqual({
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
});

test('pane_set_symbol has the annotations of chart_set_symbol, whose path it takes', () => {
  expect(toolNamed('pane_set_symbol').annotations).toEqual(chartSetSymbol.annotations);
});

test('pane_set_symbol takes its symbol with the schema of chart_set_symbol, so the two cannot drift', () => {
  expect(toolNamed('pane_set_symbol').inputSchema.symbol).toBe(chartSetSymbol.inputSchema.symbol);
});

test('the pane tools are left out of the core profile until the core set is chosen', () => {
  for (const tool of paneTools) {
    expect(tool.core, tool.name).toBeUndefined();
  }
  expect(selectTools(allTools, { profile: 'core', patterns: [] }).map(({ name }) => name)).toEqual(
    expect.not.arrayContaining(paneTools.map(({ name }) => name)) as string[],
  );
});

test('pane_list takes nothing; pane_set_layout a layout code and confirm; pane_focus a chartIndex; pane_set_symbol a chartIndex and a symbol', () => {
  expect(Object.keys(toolNamed('pane_list').inputSchema)).toEqual([]);
  expect(Object.keys(toolNamed('pane_set_layout').inputSchema).sort()).toEqual([
    'confirm',
    'layout',
  ]);
  expect(Object.keys(toolNamed('pane_focus').inputSchema)).toEqual(['chartIndex']);
  expect(Object.keys(toolNamed('pane_set_symbol').inputSchema).sort()).toEqual([
    'chartIndex',
    'symbol',
  ]);
  expect(schemaOf('pane_set_layout').parse({ layout: '2h' })).toEqual({ layout: '2h' });
  expect(schemaOf('pane_set_layout').parse({ layout: 's', confirm: true })).toEqual({
    layout: 's',
    confirm: true,
  });
  expect(schemaOf('pane_focus').parse({ chartIndex: 0 })).toEqual({ chartIndex: 0 });
  expect(schemaOf('pane_set_symbol').parse({ chartIndex: 1, symbol: 'NASDAQ:AAPL' })).toEqual({
    chartIndex: 1,
    symbol: 'NASDAQ:AAPL',
  });
});

test('pane_set_layout takes every layout code of TradingView, and nothing else', () => {
  const schema = schemaOf('pane_set_layout');

  for (const code of PANE_LAYOUT_CODES) {
    expect(schema.safeParse({ layout: code }).success, code).toBe(true);
  }
  expect(PANE_LAYOUT_CODES).toHaveLength(55);
  for (const code of ['5x', 'S', '2H', '', '1']) {
    expect(schema.safeParse({ layout: code }).success, code).toBe(false);
  }
});

test.each([
  ['pane_set_layout', 'no layout', {}],
  ['pane_set_layout', 'a confirm that is no boolean', { layout: 's', confirm: 'yes' }],
  ['pane_focus', 'no chartIndex', {}],
  ['pane_focus', 'a negative chartIndex', { chartIndex: -1 }],
  ['pane_focus', 'a fractional chartIndex', { chartIndex: 1.5 }],
  ['pane_set_symbol', 'no chartIndex', { symbol: 'NASDAQ:AAPL' }],
  ['pane_set_symbol', 'no symbol', { chartIndex: 0 }],
  ['pane_set_symbol', 'an empty symbol', { chartIndex: 0, symbol: '' }],
  ['pane_set_symbol', 'a symbol of 201 characters', { chartIndex: 0, symbol: 'x'.repeat(201) }],
])('%s refuses %s', (name, _case, input) => {
  expect(schemaOf(name).safeParse(input).success).toBe(false);
});

test('every input of the pane tools is described', () => {
  for (const tool of paneTools) {
    for (const key of Object.keys(tool.inputSchema)) {
      expect(descriptionOf(tool.name, key), `${tool.name}.${key}`).toEqual(expect.any(String));
    }
  }
});

test('the description of the layout input names each code by its count of charts', () => {
  const described = descriptionOf('pane_set_layout', 'layout') ?? '';

  expect(described).toContain('1 chart: s;');
  expect(described).toContain('2 charts: 2h, 2v;');
  expect(described).toContain('16 charts: 16c8, 16c4');
});

test('the descriptions say what the model must know before it calls', () => {
  const { description: list } = toolNamed('pane_list');
  const { description: layout } = toolNamed('pane_set_layout');
  const { description: focus } = toolNamed('pane_focus');
  const { description: symbol } = toolNamed('pane_set_symbol');

  expect(list).toMatch(/changes nothing/);
  expect(list).toMatch(/studyIds/);
  expect(list).toMatch(/drawings are left out/);
  expect(layout).toMatch(/PLAN_LIMIT/);
  expect(layout).toMatch(/MULTIPLE_CHARTS/);
  expect(layout).toMatch(/CONFIRMATION_REQUIRED/);
  expect(layout).toMatch(/confirm: true/);
  expect(layout).toMatch(/autosave/);
  expect(layout).toMatch(/NOT_AVAILABLE/);
  expect(focus).toMatch(/maximized/);
  expect(focus).toMatch(/INVALID_INPUT/);
  expect(symbol).toMatch(/without making it the active chart/);
  expect(symbol).toMatch(/syncs the symbol/);
  expect(symbol).toMatch(/chart_set_symbol/);
});
