import { z } from 'zod';
import { readPlanLimits } from '../../../../src/core/tv/plan-limits.js';
import { READ_ONLY } from '../../../../src/tools/annotations.js';
import { allTools } from '../../../../src/tools/index.js';
import { layoutNew, layoutTools, newLayout } from '../../../../src/tools/layout/index.js';
import {
  awaitChartData,
  checkLayoutPermission,
  createLayoutViaApi,
  loadLayoutInPlace,
  readLayoutState,
  readSavedLayouts,
} from '../../../../src/tools/layout/page.js';
import { selectTools } from '../../../../src/tools/registry.js';
import type { AnyToolDefinition, ToolContext } from '../../../../src/tools/types.js';
import { watchlistTools } from '../../../../src/tools/watchlist/index.js';
import { failureOf } from '../../../helpers/failure-of.js';
import { capturingLogger, createTestContext, testConfig } from '../../../helpers/tool-context.js';

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

test('the catalog lists the layout tools after the watchlist tools and before the pane tools', () => {
  const names = allTools.map(({ name }) => name);
  const lastWatchlist = watchlistTools.at(-1);
  if (lastWatchlist === undefined) {
    throw new Error('There are no watchlist tools');
  }

  expect(names.indexOf('layout_list')).toBe(names.indexOf(lastWatchlist.name) + 1);
  expect(names.indexOf('layout_switch')).toBe(names.indexOf('pane_list') - 1);
});

test('layout_list only reads, so the readonly profile offers it and no other layout tool', () => {
  expect(toolNamed('layout_list').annotations).toBe(READ_ONLY);
  expect(
    selectTools(layoutTools, { profile: 'readonly', patterns: [] }).map(({ name }) => name),
  ).toEqual(['layout_list']);
});

test('layout_new and layout_switch can discard unsaved changes, and a second layout_switch changes nothing more', () => {
  expect(toolNamed('layout_new').annotations).toEqual({
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  });
  // Switching again to the layout shown answers changed: false.
  expect(toolNamed('layout_switch').annotations).toEqual({
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  });
});

test('the layout tools are left out of the core profile', () => {
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
  // What layout_switch cannot rule out is named, not promised away.
  expect(change).not.toMatch(/No dialog opens/);
  expect(change).toMatch(/upgrade prompt/);
  expect(change).toMatch(/multi-chart layout on a plan with fewer charts/);
  expect(change).toMatch(/server refuses/);
  expect(change).toMatch(/out of date/);
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

test('layout_new reports the layout it created, unopened, when opening it fails with an error that is no error of the server, and logs that error', async () => {
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
  const { logger, lines } = capturingLogger();
  const ctx = {
    ...createTestContext({ logger }),
    connection: { chartPage: () => Promise.resolve({ bridge }) },
  } as unknown as ToolContext;

  // The layout exists, so the call reports it, rather than fail and have a client create another.
  expect(await layoutNew.handler({ name: 'Example Layout' }, ctx)).toEqual({
    data: { id: 'NEW00001', name: 'Example Layout', opened: false },
    via: 'internal',
    warnings: [
      expect.stringMatching(
        /^TradingView created the layout NEW00001 but did not open it\. Open it with layout_switch/,
      ),
    ],
  });
  // The client is not told what the error said; the log keeps it, and no layout name.
  expect(lines).toEqual([
    expect.objectContaining({
      level: 50,
      tool: 'layout_new',
      err: expect.objectContaining({ message: 'A bug' }) as unknown,
    }),
  ]);
  expect(JSON.stringify(lines)).not.toContain('Example Layout');
});

// The time layout_new allows itself, tested with a clock of its own: a scripted page answers each
// page function at once and moves the clock on by the time the script says the call took.
describe('the time layout_new allows itself', () => {
  interface Scripted {
    value: unknown;
    takesMs?: number;
  }

  // The page answers for a layout created as NEW00001 and opened, each at once unless changed.
  const script = (changes: [unknown, Scripted][] = []): Map<unknown, Scripted> =>
    new Map<unknown, Scripted>([
      [
        readLayoutState,
        { value: { signedIn: true, id: 'NEW00001', name: 'Example', unsaved: false } },
      ],
      [readSavedLayouts, { value: { layouts: [] } }],
      [readPlanLimits, { value: { CHART_STORAGE: 5 } }],
      [checkLayoutPermission, { value: { allowed: true } }],
      [createLayoutViaApi, { value: { url: 'https://www.tradingview.com/chart/NEW00001/' } }],
      [loadLayoutInPlace, { value: { ended: 'loaded', reason: null } }],
      [awaitChartData, { value: { ready: true } }],
      ...changes,
    ]);

  function scriptedRun(answers: Map<unknown, Scripted>, callTimeoutMs: number) {
    const clock = { now: 0 };
    const asked: { fn: unknown; args: unknown[] }[] = [];
    const answer = (fn: unknown, args: unknown[]): Promise<unknown> => {
      asked.push({ fn, args });
      const scripted = answers.get(fn);
      if (scripted === undefined) {
        return Promise.reject(new Error('Unexpected page function'));
      }
      clock.now += scripted.takesMs ?? 0;
      return Promise.resolve(scripted.value);
    };
    const ctx = {
      ...createTestContext({ config: testConfig({ callTimeoutMs }) }),
      connection: {
        chartPage: () => Promise.resolve({ bridge: { evaluate: answer, evaluateWithLib: answer } }),
      },
    } as unknown as ToolContext;
    const argsOf = (fn: unknown): unknown[][] =>
      asked.filter((call) => call.fn === fn).map(({ args }) => args);
    return { clock, ctx, argsOf };
  }

  // A budget of 4800 ms and a call timeout of 2600 ms make every page wait 1600 ms: what the call
  // timeout leaves a page call, and a third of the budget.
  const BUDGET_MS = 4800;
  const CALL_TIMEOUT_MS = 2600;

  test('answers TIMEOUT, and creates nothing, when less than one page wait of its time is left before the creation', async () => {
    const run = scriptedRun(
      script([[readSavedLayouts, { value: { layouts: [] }, takesMs: 3300 }]]),
      CALL_TIMEOUT_MS,
    );

    const error = await failureOf(
      newLayout({ name: 'Example' }, run.ctx, BUDGET_MS, () => run.clock.now),
    );

    expect(error.toPayload()).toEqual({
      code: 'TIMEOUT',
      message: expect.stringContaining('nothing was created') as string,
      hint: expect.stringContaining('safe to call layout_new again') as string,
      details: { budgetMs: BUDGET_MS },
    });
    expect(run.argsOf(createLayoutViaApi)).toEqual([]);
  });

  test('gives the opening of the created layout only what is left of its time', async () => {
    const run = scriptedRun(
      script([
        [
          createLayoutViaApi,
          { value: { url: 'https://www.tradingview.com/chart/NEW00001/' }, takesMs: 3500 },
        ],
      ]),
      CALL_TIMEOUT_MS,
    );

    const output = await newLayout({ name: 'Example' }, run.ctx, BUDGET_MS, () => run.clock.now);

    expect(output.data).toEqual({ id: 'NEW00001', name: 'Example', opened: true });
    // 1300 ms of the budget were left: less than a page wait.
    expect(run.argsOf(loadLayoutInPlace)).toEqual([['NEW00001', 1300, false]]);
    const [dataWait] = run.argsOf(awaitChartData);
    expect(dataWait?.[0]).toBeLessThanOrEqual(1300);
  });

  test('reports the created layout unopened, and loads nothing, when no time is left to open it', async () => {
    const run = scriptedRun(
      script([
        [
          createLayoutViaApi,
          { value: { url: 'https://www.tradingview.com/chart/NEW00001/' }, takesMs: 4000 },
        ],
      ]),
      CALL_TIMEOUT_MS,
    );

    const output = await newLayout({ name: 'Example' }, run.ctx, BUDGET_MS, () => run.clock.now);

    expect(output).toEqual({
      data: { id: 'NEW00001', name: 'Example', opened: false },
      via: 'internal',
      warnings: [
        expect.stringMatching(
          /^TradingView created the layout NEW00001 but did not open it \(no time was left to open it\)\. Open it with layout_switch/,
        ),
      ],
    });
    expect(run.argsOf(loadLayoutInPlace)).toEqual([]);
  });

  test('keeps every page wait of layout_new to a third of its 45 s, whatever the call timeout', async () => {
    const run = scriptedRun(script(), 120_000);

    await layoutNew.handler({ name: 'Example' }, run.ctx);

    expect(run.argsOf(readSavedLayouts)).toEqual([[15_000]]);
    expect(run.argsOf(checkLayoutPermission)).toEqual([[15_000]]);
    expect(run.argsOf(createLayoutViaApi)).toEqual([['Example', 15_000]]);
  });
});
