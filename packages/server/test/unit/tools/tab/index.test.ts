import { z } from 'zod';
import { READ_ONLY } from '../../../../src/tools/annotations.js';
import { allTools } from '../../../../src/tools/index.js';
import { paneTools } from '../../../../src/tools/pane/index.js';
import { selectTools } from '../../../../src/tools/registry.js';
import { tabTools } from '../../../../src/tools/tab/index.js';
import type { AnyToolDefinition } from '../../../../src/tools/types.js';

// What the model and the client see of the tab tools: their names, annotations, descriptions and
// input schemas. The behavior behind them is tested through a server in
// test/integration/tools/tab.test.ts.

function toolNamed(name: string): AnyToolDefinition {
  const tool = tabTools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`There is no tab tool ${name}`);
  }
  return tool;
}

const schemaOf = (name: string) => z.object(toolNamed(name).inputSchema);
const descriptionOf = (name: string, field: string): string | undefined =>
  z.globalRegistry.get(toolNamed(name).inputSchema[field] ?? z.never())?.description;

test('tabTools lists the tab tools in the order of the catalog', () => {
  expect(tabTools.map(({ name }) => name)).toEqual([
    'tab_list',
    'tab_new',
    'tab_switch',
    'tab_close',
  ]);
  expect(new Set(tabTools.map(({ domain }) => domain))).toEqual(new Set(['tab']));
});

test('the catalog lists the tab tools after the pane tools and before the screenshot', () => {
  const names = allTools.map(({ name }) => name);
  const lastPane = paneTools.at(-1);
  if (lastPane === undefined) {
    throw new Error('There are no pane tools');
  }

  expect(names.indexOf('tab_list')).toBe(names.indexOf(lastPane.name) + 1);
  expect(names.indexOf('tab_close')).toBe(names.indexOf('screenshot_capture') - 1);
});

test('tab_list only reads, so the readonly profile offers it and no other tab tool', () => {
  expect(toolNamed('tab_list').annotations).toBe(READ_ONLY);
  expect(
    selectTools(tabTools, { profile: 'readonly', patterns: [] }).map(({ name }) => name),
  ).toEqual(['tab_list']);
});

test('tab_new opens a tab every time it is called, and destroys nothing', () => {
  expect(toolNamed('tab_new').annotations).toEqual({
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  });
});

test('tab_switch changes which tab is in front only, and calling it again changes nothing more', () => {
  expect(toolNamed('tab_switch').annotations).toEqual({
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
});

test('tab_close is destructive, and a second call by index closes another tab', () => {
  expect(toolNamed('tab_close').annotations).toEqual({
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  });
});

test('the tab tools are left out of the core profile until the core set is chosen', () => {
  for (const tool of tabTools) {
    expect(tool.core, tool.name).toBeUndefined();
  }
  expect(selectTools(allTools, { profile: 'core', patterns: [] }).map(({ name }) => name)).toEqual(
    expect.not.arrayContaining(tabTools.map(({ name }) => name)) as string[],
  );
});

test('tab_list and tab_new take nothing; tab_switch a tabId or an index; tab_close those and confirm', () => {
  expect(Object.keys(toolNamed('tab_list').inputSchema)).toEqual([]);
  expect(Object.keys(toolNamed('tab_new').inputSchema)).toEqual([]);
  expect(Object.keys(toolNamed('tab_switch').inputSchema)).toEqual(['tabId', 'index']);
  expect(Object.keys(toolNamed('tab_close').inputSchema)).toEqual(['tabId', 'index', 'confirm']);
  // Neither is required by the schema: the handler asks for exactly one of them.
  expect(schemaOf('tab_switch').parse({})).toEqual({});
  expect(schemaOf('tab_switch').parse({ tabId: 'abc', index: 2 })).toEqual({
    tabId: 'abc',
    index: 2,
  });
  expect(schemaOf('tab_close').parse({ index: 0, confirm: true })).toEqual({
    index: 0,
    confirm: true,
  });
});

test.each([
  ['tab_switch', 'an empty tabId', { tabId: '' }],
  ['tab_switch', 'a tabId of 201 characters', { tabId: 'x'.repeat(201) }],
  ['tab_switch', 'a negative index', { index: -1 }],
  ['tab_switch', 'a fractional index', { index: 1.5 }],
  ['tab_close', 'an index that is no number', { index: '1' }],
  ['tab_close', 'a confirm that is no boolean', { index: 1, confirm: 'yes' }],
])('%s refuses %s', (name, _case, input) => {
  expect(schemaOf(name).safeParse(input).success).toBe(false);
});

test('every input of the tab tools is described', () => {
  for (const tool of tabTools) {
    for (const key of Object.keys(tool.inputSchema)) {
      expect(descriptionOf(tool.name, key), `${tool.name}.${key}`).toEqual(expect.any(String));
    }
  }
});

test('the descriptions say what the model must know before it calls', () => {
  const { description: list } = toolNamed('tab_list');
  const { description: open } = toolNamed('tab_new');
  const { description: change } = toolNamed('tab_switch');
  const { description: close } = toolNamed('tab_close');

  expect(list).toMatch(/changes nothing/);
  expect(list).toMatch(/openedBySession/);
  expect(open).toMatch(/New tab/);
  expect(open).toMatch(/no chart/);
  expect(open).toMatch(/CHART_STORAGE/);
  expect(open).toMatch(/tab_switch/);
  expect(open).toMatch(/tab_close/);
  expect(change).toMatch(/exactly one of tabId or index/);
  expect(change).toMatch(/changed/);
  expect(change).toMatch(/INVALID_INPUT/);
  expect(close).toMatch(/only tab/);
  expect(close).toMatch(/confirm: true/);
  expect(close).toMatch(/CONFIRMATION_REQUIRED/);
  expect(close).toMatch(/unsaved changes/);
  expect(close).toMatch(/autosave/);
  expect(close).toMatch(/NOT_AVAILABLE/);
  expect(close).toMatch(/remaining/);
});
