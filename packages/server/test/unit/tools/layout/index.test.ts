import { z } from 'zod';
import { readPlanLimits } from '../../../../src/core/tv/plan-limits.js';
import { READ_ONLY } from '../../../../src/tools/annotations.js';
import { allTools } from '../../../../src/tools/index.js';
import { layoutNew, layoutTools } from '../../../../src/tools/layout/index.js';
import {
  checkLayoutPermission,
  createLayoutViaApi,
  readLayoutState,
  readSavedLayouts,
} from '../../../../src/tools/layout/page.js';
import { selectTools } from '../../../../src/tools/registry.js';
import type { AnyToolDefinition, ToolContext } from '../../../../src/tools/types.js';
import { watchlistTools } from '../../../../src/tools/watchlist/index.js';
import { createTestContext } from '../../../helpers/tool-context.js';

// What the model and the client see of the layout tools: their names, annotations, descriptions and
// input schemas. The behavior behind them is tested through a server in
// test/integration/tools/layout.test.ts, apart from failures the real page bridge never gives.

function toolNamed(name: string): AnyToolDefinition {
  const tool = layoutTools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`There is no layout tool ${name}`);
  }
  return tool;
}

const schemaOf = (name: string) => z.object(toolNamed(name).inputSchema);

test('layoutTools lists the layout tools in the order of the catalog', () => {
  expect(layoutTools.map(({ name }) => name)).toEqual([
    'layout_list',
    'layout_new',
    'layout_switch',
  ]);
  expect(new Set(layoutTools.map(({ domain }) => domain))).toEqual(new Set(['layout']));
});

test('the catalog lists the layout tools after the watchlist tools and before the screenshot', () => {
  const names = allTools.map(({ name }) => name);
  const lastWatchlist = watchlistTools.at(-1);
  if (lastWatchlist === undefined) {
    throw new Error('There are no watchlist tools');
  }

  expect(names.indexOf('layout_list')).toBe(names.indexOf(lastWatchlist.name) + 1);
  expect(names.indexOf('layout_switch')).toBe(names.indexOf('screenshot_capture') - 1);
});

test('layout_list only reads, so the readonly profile offers it and no other layout tool', () => {
  expect(toolNamed('layout_list').annotations).toBe(READ_ONLY);
  expect(
    selectTools(layoutTools, { profile: 'readonly', patterns: [] }).map(({ name }) => name),
  ).toEqual(['layout_list']);
});

test('layout_new and layout_switch can discard unsaved changes, and neither is idempotent', () => {
  for (const name of ['layout_new', 'layout_switch']) {
    expect(toolNamed(name).annotations, name).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
  }
});

test('the layout tools are left out of the core profile until the core set is chosen', () => {
  for (const tool of layoutTools) {
    expect(tool.core, tool.name).toBeUndefined();
  }
  expect(selectTools(allTools, { profile: 'core', patterns: [] }).map(({ name }) => name)).toEqual(
    expect.not.arrayContaining(layoutTools.map(({ name }) => name)) as string[],
  );
});

test('the descriptions name the plan limit, the confirmation, the in-place loading and what TradingView may still show', () => {
  const { description: create } = toolNamed('layout_new');
  const { description: change } = toolNamed('layout_switch');

  expect(create).toMatch(/CHART_STORAGE/);
  expect(create).toMatch(/PLAN_LIMIT/);
  expect(create).toMatch(/confirm: true/);
  expect(create).toMatch(/1 to 64 characters/);
  expect(create).toMatch(/may show a message/);
  expect(create).toMatch(/opened: false/);
  expect(change).toMatch(/confirm: true/);
  expect(change).toMatch(/discard/);
  expect(change).toMatch(/in place/);
  expect(change).toMatch(/CHART_STORAGE/);
  expect(toolNamed('layout_list').description).toMatch(/changes nothing/);
});

test('layout_list takes nothing, layout_new a name and confirm, layout_switch a layoutId and confirm', () => {
  expect(Object.keys(toolNamed('layout_list').inputSchema)).toEqual([]);
  expect(schemaOf('layout_new').parse({ name: ' Example ', confirm: true })).toEqual({
    name: ' Example ',
    confirm: true,
  });
  expect(schemaOf('layout_switch').parse({ layoutId: 'FIXTURE2' })).toEqual({
    layoutId: 'FIXTURE2',
  });
  expect(Object.keys(toolNamed('layout_new').inputSchema).sort()).toEqual(['confirm', 'name']);
  expect(Object.keys(toolNamed('layout_switch').inputSchema).sort()).toEqual([
    'confirm',
    'layoutId',
  ]);
});

test.each([
  ['layout_new', 'no name', {}],
  ['layout_new', 'an empty name', { name: '' }],
  ['layout_new', 'a name of 201 characters', { name: 'x'.repeat(201) }],
  ['layout_new', 'a name that is no text', { name: 3 }],
  ['layout_new', 'a confirm that is no boolean', { name: 'X', confirm: 'yes' }],
  ['layout_switch', 'no layoutId', {}],
  ['layout_switch', 'an empty layoutId', { layoutId: '' }],
  ['layout_switch', 'a layoutId of 101 characters', { layoutId: 'x'.repeat(101) }],
  ['layout_switch', 'a confirm that is no boolean', { layoutId: 'FIXTURE2', confirm: 1 }],
])('%s refuses %s', (name, _label, input) => {
  expect(schemaOf(name).safeParse(input).success).toBe(false);
});

test('layout_new lets through a failure that is no error of the server while it opens the new layout', async () => {
  // The page bridge rejects only with errors of the server, so a failure of another kind, a bug,
  // needs a page of its own: the layout is created, and the load of it fails.
  const answers = new Map<unknown, unknown>([
    [readLayoutState, { signedIn: true, id: 'FIXTURE1', name: 'Fixture Layout', unsaved: false }],
    [readSavedLayouts, { layouts: [] }],
    [readPlanLimits, { CHART_STORAGE: 5 }],
    [checkLayoutPermission, { allowed: true }],
    [createLayoutViaApi, { url: 'https://www.tradingview.com/chart/NEW00001/' }],
  ]);
  const answer = (fn: unknown): Promise<unknown> =>
    answers.has(fn) ? Promise.resolve(answers.get(fn)) : Promise.reject(new Error('A bug'));
  const bridge = { evaluate: answer, evaluateWithLib: answer };
  const ctx = {
    ...createTestContext(),
    connection: { chartPage: () => Promise.resolve({ bridge }) },
  } as unknown as ToolContext;

  await expect(layoutNew.handler({ name: 'Example Layout' }, ctx)).rejects.toThrow('A bug');
});
