import { z } from 'zod';
import { TvMcpError } from '../../../../src/core/errors.js';
import { readPlanConfig } from '../../../../src/core/tv/plan-limits.js';
import { alertDelete, alertTools, createAlert } from '../../../../src/tools/alert/index.js';
import {
  createAlertViaApi,
  deleteAlertsViaApi,
  readAlertContext,
  readAlerts,
} from '../../../../src/tools/alert/page.js';
import { READ_ONLY } from '../../../../src/tools/annotations.js';
import { drawingTools } from '../../../../src/tools/drawing/index.js';
import { allTools } from '../../../../src/tools/index.js';
import { selectTools } from '../../../../src/tools/registry.js';
import type { AnyToolDefinition, ToolContext } from '../../../../src/tools/types.js';
import { failureOf } from '../../../helpers/failure-of.js';
import { createTestContext, testConfig } from '../../../helpers/tool-context.js';

// What the model and the client see of the alert tools: their names, annotations and input
// schemas. The behavior behind them is tested through a server in
// test/integration/tools/alert.test.ts, apart from a failure the real page bridge never gives.

function toolNamed(name: string): AnyToolDefinition {
  const tool = alertTools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`There is no alert tool ${name}`);
  }
  return tool;
}

const schemaOf = (name: string) => z.object(toolNamed(name).inputSchema);

test('alertTools lists the alert tools in the order of the catalog', () => {
  expect(alertTools.map(({ name }) => name)).toEqual([
    'alert_create',
    'alert_list',
    'alert_delete',
  ]);
  expect(new Set(alertTools.map(({ domain }) => domain))).toEqual(new Set(['alert']));
});

test('the catalog lists the alert tools after the drawing tools and before the watchlist tools', () => {
  const names = allTools.map(({ name }) => name);
  const lastDrawing = drawingTools.at(-1);
  if (lastDrawing === undefined) {
    throw new Error('There are no drawing tools');
  }

  expect(names.indexOf('alert_create')).toBe(names.indexOf(lastDrawing.name) + 1);
  expect(names.indexOf('alert_delete')).toBe(names.indexOf('watchlist_list') - 1);
});

test('alert_list only reads, so the readonly profile offers it and no other alert tool', () => {
  expect(toolNamed('alert_list').annotations).toBe(READ_ONLY);
  expect(
    selectTools(alertTools, { profile: 'readonly', patterns: [] }).map(({ name }) => name),
  ).toEqual(['alert_list']);
});

test('alert_delete destroys, and alert_create adds an alert without destroying anything', () => {
  expect(toolNamed('alert_delete').annotations).toEqual({
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  });
  expect(toolNamed('alert_create').annotations).toEqual({
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  });
});

// The core profile itself is pinned in test/unit/tools/registry.test.ts.
// Core creates alerts, which persist in the account, count against SERVER_SIDE_ALERTS and fire, so
// it can delete them too.
test('the core profile keeps every alert tool, alert_delete included', () => {
  expect(
    selectTools(alertTools, { profile: 'core', patterns: [] }).map(({ name }) => name),
  ).toEqual(['alert_create', 'alert_list', 'alert_delete']);
  expect(alertDelete.core).toBe(true);
});

test('alert_create takes a symbol, a condition, a price, a message and an expiration', () => {
  const schema = schemaOf('alert_create');
  const input = {
    symbol: 'NASDAQ:AAPL',
    condition: 'crossing_up',
    price: 150.25,
    message: 'AAPL crossing up 150.25',
    expiration: '2026-11-01T00:00:00Z',
  };

  expect(schema.parse(input)).toEqual(input);
  expect(
    schema.parse({ condition: 'less_than', price: -3, expiration: 1_793_491_200_000 }),
  ).toEqual({ condition: 'less_than', price: -3, expiration: 1_793_491_200_000 });
  expect(
    schema.parse({ condition: 'crossing', price: 1, message: 'x'.repeat(400) }).message,
  ).toHaveLength(400);
});

test.each([
  ['no condition', { condition: undefined }],
  ['an unknown condition', { condition: 'cross' }],
  ['no price', { price: undefined }],
  ['a price that is not finite', { price: Number.POSITIVE_INFINITY }],
  ['an empty message', { message: '' }],
  ['a message of 401 characters', { message: 'x'.repeat(401) }],
  ['an empty symbol', { symbol: '' }],
  ['a symbol of 201 characters', { symbol: 'X'.repeat(201) }],
  ['an empty expiration', { expiration: '' }],
  ['an expiration that is no time at all', { expiration: true }],
])('alert_create refuses %s', (_label, change) => {
  const base = { condition: 'crossing', price: 150 };

  expect(schemaOf('alert_create').safeParse({ ...base, ...change }).success).toBe(false);
});

test('alert_list lists every alert by default and filters by status', () => {
  const schema = schemaOf('alert_list');

  expect(schema.parse({})).toEqual({ status: 'all' });
  for (const status of ['active', 'stopped', 'triggered', 'all']) {
    expect(schema.parse({ status })).toEqual({ status });
  }
  expect(schema.safeParse({ status: 'fired' }).success).toBe(false);
});

test('alert_delete takes 1 to 50 alert ids and an optional confirm', () => {
  const schema = schemaOf('alert_delete');
  const fifty = Array.from({ length: 50 }, (_, index) => String(index + 1));

  expect(schema.parse({ alertIds: ['12'], confirm: true })).toEqual({
    alertIds: ['12'],
    confirm: true,
  });
  expect(schema.parse({ alertIds: fifty }).alertIds).toHaveLength(50);
  for (const change of [
    {},
    { alertIds: [] },
    { alertIds: [...fifty, '51'] },
    { alertIds: [12] },
    { alertIds: ['0'] },
    { alertIds: ['-1'] },
    { alertIds: ['012'] },
    { alertIds: ['1e3'] },
    { alertIds: ['1234567890123456'] },
    { alertIds: ['1'], confirm: 'yes' },
  ]) {
    expect(schema.safeParse(change).success, JSON.stringify(change)).toBe(false);
  }
});

test('alert_delete has no input that deletes every alert', () => {
  const schema = schemaOf('alert_delete');

  expect(Object.keys(toolNamed('alert_delete').inputSchema).sort()).toEqual([
    'alertIds',
    'confirm',
  ]);
  // A key of its own for "all" is not part of the input, and the ids stay required.
  for (const attempt of [{ all: true }, { scope: 'all', confirm: true }, { alertIds: ['*'] }]) {
    expect(schema.safeParse(attempt).success, JSON.stringify(attempt)).toBe(false);
  }
});

test('alert_delete lets through a failure that is no error of the server, after the deletion', async () => {
  // The page bridge rejects only with errors of the server, so a failure of another kind, a bug,
  // needs a page of its own: the first list answers, the deletion is accepted, and the list that
  // would confirm it fails.
  let lists = 0;
  const bridge = {
    evaluateWithLib: (fn: unknown): Promise<unknown> => {
      if (fn === deleteAlertsViaApi) {
        return Promise.resolve({ sent: true });
      }
      lists += 1;
      return lists === 1
        ? Promise.resolve({
            alerts: [
              {
                id: 7,
                symbol: 'NYSE:IBM',
                kinds: ['regular'],
                active: true,
                lastStopReason: null,
                complexity: 'primitive',
                condition: 'cross',
                price: 100,
                message: 'Synthetic',
                expires: null,
              },
            ],
            unreadable: 0,
          })
        : Promise.reject(new Error('A bug'));
    },
  };
  const ctx = {
    ...createTestContext(),
    connection: { chartPage: () => Promise.resolve({ bridge }) },
  } as unknown as ToolContext;

  await expect(alertDelete.handler({ alertIds: ['7'], confirm: true }, ctx)).rejects.toThrow(
    'A bug',
  );
  expect(lists).toBe(2);
});

// What a scripted page function answers: value, or the items of sequence one call after another (the
// last one again once they run out), where an Error is a rejection; each call takes `takesMs` of the
// clock of the run.
interface Scripted {
  value?: unknown;
  sequence?: unknown[];
  takesMs?: number;
}

describe('alert_create within the time a client waits for one call', () => {
  // A chart page whose page functions answer as `answers` says, each taking `takesMs` of the clock
  // of the run, which the call reads as its own.
  function scriptedRun(answers: Map<unknown, Scripted>, callTimeoutMs: number) {
    const clock = { now: 0 };
    const asked: { fn: unknown; args: unknown[] }[] = [];
    const answer = (fn: unknown, args: unknown[]): Promise<unknown> => {
      const scripted = answers.get(fn);
      const nth = asked.filter((call) => call.fn === fn).length;
      asked.push({ fn, args });
      if (scripted === undefined) {
        return Promise.reject(new Error('Unexpected page function'));
      }
      clock.now += scripted.takesMs ?? 0;
      const { sequence } = scripted;
      const value =
        sequence === undefined ? scripted.value : sequence[Math.min(nth, sequence.length - 1)];
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
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

  // A row of the alert the run creates, as TradingView lists it.
  const createdRow = (active: boolean, lastStopReason: string | null = null) => ({
    id: 9001,
    symbol: 'NASDAQ:AAPL',
    kinds: ['regular'],
    active,
    lastStopReason,
    complexity: 'primitive',
    condition: 'cross',
    series: 'barset',
    study: null,
    value: 150,
    message: 'AAPL crossing 150',
    expires: null,
  });
  const listing = (...alerts: ReturnType<typeof createdRow>[]) => ({ alerts, unreadable: 0 });

  // A daily chart of a symbol the alert takes, and a plan with room for it; TradingView lists the
  // alert as active once it is created.
  function script(change: [unknown, Scripted][] = []) {
    return new Map<unknown, Scripted>([
      [
        readAlertContext,
        {
          value: {
            symbol: 'NASDAQ:AAPL',
            names: ['AAPL'],
            alertSymbol: 'NASDAQ:AAPL',
            resolution: '1D',
            maxExpiration: null,
            defaultExpiration: null,
          },
        },
      ],
      [readAlerts, { sequence: [listing(), listing(createdRow(true))] }],
      [readPlanConfig, { value: { limit: 3, primitive_limit: 3, overall_limit: 50 } }],
      [createAlertViaApi, { value: { id: '9001' } }],
      ...change,
    ]);
  }

  // A budget of 4800 ms and a call timeout of 2600 ms make every page wait 1600 ms: what the call
  // timeout leaves a page call, and a third of the budget.
  const BUDGET_MS = 4800;
  const CALL_TIMEOUT_MS = 2600;
  const INPUT = { condition: 'crossing' as const, price: 150 };

  test('answers TIMEOUT, and sends nothing, when less than one page wait of its time is left before the creation', async () => {
    const run = scriptedRun(
      script([[readAlerts, { value: { alerts: [], unreadable: 0 }, takesMs: 3300 }]]),
      CALL_TIMEOUT_MS,
    );

    const error = await failureOf(createAlert(INPUT, run.ctx, BUDGET_MS, () => run.clock.now));

    expect(error.toPayload()).toEqual({
      code: 'TIMEOUT',
      message: expect.stringContaining('nothing was created') as string,
      hint: expect.stringContaining('safe to call alert_create again') as string,
      details: { budgetMs: BUDGET_MS },
    });
    expect(run.argsOf(createAlertViaApi)).toEqual([]);
    expect(run.ctx.session.createdAlertIds.size).toBe(0);
  });

  test('says that it keeps within 45 s', () => {
    expect(toolNamed('alert_create').description).toMatch(/45 s/);
  });

  test('creates the alert while a page wait of its time is left, waiting a third of it at most', async () => {
    const run = scriptedRun(script(), 120_000);

    const output = await createAlert(INPUT, run.ctx, 45_000, () => run.clock.now);

    expect(output.data).toMatchObject({ id: '9001', condition: 'crossing', price: 150 });
    // The check of the limit, then one listing that finds the new alert active, which waits no
    // longer than the 5 s of the wait for it.
    expect(run.argsOf(readAlerts)).toEqual([[15_000], [5000]]);
    expect(run.argsOf(createAlertViaApi)[0]?.[1]).toBe(15_000);
    expect(run.ctx.session.createdAlertIds).toEqual(new Set(['9001']));
    expect(output.warnings ?? []).toEqual([]);
  });

  test('waits until TradingView lists the new alert as active, a refused or failed listing, or one without it, counting as not active yet', async () => {
    const run = scriptedRun(
      script([
        [
          readAlerts,
          {
            sequence: [
              listing(),
              { refused: { code: 'general', message: 'Synthetic refusal' } },
              new TvMcpError('TIMEOUT', 'Synthetic timeout'),
              // Not listed yet.
              listing(),
              listing(createdRow(false)),
              listing(createdRow(true)),
            ],
            takesMs: 100,
          },
        ],
      ]),
      120_000,
    );

    const output = await createAlert(INPUT, run.ctx, 45_000, () => run.clock.now);

    expect(output.data).toMatchObject({ id: '9001' });
    expect(output.warnings ?? []).toEqual([]);
    expect(run.argsOf(readAlerts)).toHaveLength(6);
  });

  test('answers the alert with a warning when TradingView does not list it as active within 5 s', async () => {
    const run = scriptedRun(
      script([[readAlerts, { sequence: [listing(), listing(createdRow(false))], takesMs: 1000 }]]),
      120_000,
    );

    const output = await createAlert(INPUT, run.ctx, 45_000, () => run.clock.now);

    expect(output.data).toMatchObject({ id: '9001' });
    expect(output.warnings).toEqual([
      expect.stringContaining('did not list it as active within 5') as string,
    ]);
    expect(output.warnings?.[0]).toContain('Check alert_list before creating it again');
    expect(run.ctx.session.createdAlertIds).toEqual(new Set(['9001']));
    // Each listing of the wait waits no longer than what is left of it, and 1 s at the least.
    const waits = run
      .argsOf(readAlerts)
      .slice(1)
      .map(([waitMs]) => waitMs as number);
    expect(waits[0]).toBe(5000);
    expect(Math.min(...waits)).toBe(1000);
  });

  test('stops waiting, with no warning, when TradingView lists the new alert as stopped before it saw it active', async () => {
    // A greater_than alert at a price the symbol is above already fires at once: TradingView lists
    // it as not active, stopped by itself, without ever listing it as active.
    const run = scriptedRun(
      script([
        [readAlerts, { sequence: [listing(), listing(createdRow(false, 'auto'))], takesMs: 100 }],
      ]),
      120_000,
    );

    const output = await createAlert(
      { condition: 'greater_than', price: 150 },
      run.ctx,
      45_000,
      () => run.clock.now,
    );

    expect(output.data).toMatchObject({ id: '9001', condition: 'greater_than' });
    expect(output.warnings ?? []).toEqual([]);
    // The check of the limit and one listing, which settles the wait.
    expect(run.argsOf(readAlerts)).toHaveLength(2);
    expect(run.ctx.session.createdAlertIds).toEqual(new Set(['9001']));
  });

  test('a bug in a listing of the wait is not taken for an inactive alert', async () => {
    const run = scriptedRun(
      script([[readAlerts, { sequence: [listing(), new Error('A bug')] }]]),
      120_000,
    );

    await expect(createAlert(INPUT, run.ctx, 45_000, () => run.clock.now)).rejects.toThrow('A bug');
  });
});
