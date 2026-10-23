import { z } from 'zod';
import { alertDelete, alertTools } from '../../../../src/tools/alert/index.js';
import { deleteAlertsViaApi } from '../../../../src/tools/alert/page.js';
import { READ_ONLY } from '../../../../src/tools/annotations.js';
import { drawingTools } from '../../../../src/tools/drawing/index.js';
import { allTools } from '../../../../src/tools/index.js';
import { selectTools } from '../../../../src/tools/registry.js';
import type { AnyToolDefinition, ToolContext } from '../../../../src/tools/types.js';
import { createTestContext } from '../../../helpers/tool-context.js';

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
