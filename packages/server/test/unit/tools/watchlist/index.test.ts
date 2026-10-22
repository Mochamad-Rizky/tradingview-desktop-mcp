import { z } from 'zod';
import { alertTools } from '../../../../src/tools/alert/index.js';
import { READ_ONLY } from '../../../../src/tools/annotations.js';
import { allTools } from '../../../../src/tools/index.js';
import { selectTools } from '../../../../src/tools/registry.js';
import type { AnyToolDefinition, ToolContext } from '../../../../src/tools/types.js';
import { watchlistRemove, watchlistTools } from '../../../../src/tools/watchlist/index.js';
import {
  changeWatchlistViaApi,
  readWatchlist,
  type WatchlistRecord,
} from '../../../../src/tools/watchlist/page.js';
import { createTestContext } from '../../../helpers/tool-context.js';

// What the model and the client see of the watchlist tools: their names, annotations, descriptions
// and input schemas. The behavior behind them is tested through a server in
// test/integration/tools/watchlist.test.ts, apart from a failure the real page bridge never gives.

function toolNamed(name: string): AnyToolDefinition {
  const tool = watchlistTools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`There is no watchlist tool ${name}`);
  }
  return tool;
}

const schemaOf = (name: string) => z.object(toolNamed(name).inputSchema);
const symbols = (count: number) =>
  Array.from({ length: count }, (_, index) => `EXAMPLE:S${String(index)}`);

test('watchlistTools lists the watchlist tools in the order of the catalog', () => {
  expect(watchlistTools.map(({ name }) => name)).toEqual([
    'watchlist_list',
    'watchlist_get',
    'watchlist_add',
    'watchlist_add_bulk',
    'watchlist_remove',
  ]);
  expect(new Set(watchlistTools.map(({ domain }) => domain))).toEqual(new Set(['watchlist']));
});

test('the catalog lists the watchlist tools after the alert tools and before the screenshot', () => {
  const names = allTools.map(({ name }) => name);
  const lastAlert = alertTools.at(-1);
  if (lastAlert === undefined) {
    throw new Error('There are no alert tools');
  }

  expect(names.indexOf('watchlist_list')).toBe(names.indexOf(lastAlert.name) + 1);
  expect(names.indexOf('watchlist_remove')).toBe(names.indexOf('screenshot_capture') - 1);
});

test('watchlist_list and watchlist_get only read, so the readonly profile offers them and no other watchlist tool', () => {
  expect(toolNamed('watchlist_list').annotations).toBe(READ_ONLY);
  expect(toolNamed('watchlist_get').annotations).toBe(READ_ONLY);
  expect(
    selectTools(watchlistTools, { profile: 'readonly', patterns: [] }).map(({ name }) => name),
  ).toEqual(['watchlist_list', 'watchlist_get']);
});

test('watchlist_remove destroys, and the adds change a list without destroying anything', () => {
  expect(toolNamed('watchlist_remove').annotations).toEqual({
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  });
  for (const name of ['watchlist_add', 'watchlist_add_bulk']) {
    expect(toolNamed(name).annotations, name).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  }
});

test('the watchlist tools are left out of the core profile until the core set is chosen', () => {
  for (const tool of watchlistTools) {
    expect(tool.core, tool.name).toBeUndefined();
  }
  expect(selectTools(allTools, { profile: 'core', patterns: [] }).map(({ name }) => name)).toEqual(
    expect.not.arrayContaining(watchlistTools.map(({ name }) => name)) as string[],
  );
});

test('the add tools say that the WATCHLIST_SYMBOLS config is not what TradingView enforces while its tiered limits are off', () => {
  for (const name of ['watchlist_add', 'watchlist_add_bulk']) {
    const { description } = toolNamed(name);

    expect(description, name).toMatch(/WATCHLIST_SYMBOLS/);
    expect(description, name).toMatch(/tiered limits/);
    expect(description, name).toMatch(/PLAN_LIMIT/);
  }
  expect(toolNamed('watchlist_remove').description).toMatch(/confirm: true/);
});

test('watchlist_list takes nothing, and watchlist_get an optional listId', () => {
  expect(Object.keys(toolNamed('watchlist_list').inputSchema)).toEqual([]);
  expect(schemaOf('watchlist_get').parse({})).toEqual({});
  expect(schemaOf('watchlist_get').parse({ listId: '101' })).toEqual({ listId: '101' });
  expect(schemaOf('watchlist_get').parse({ listId: '###HOT###US.gainers' })).toEqual({
    listId: '###HOT###US.gainers',
  });
});

test('watchlist_add takes a symbol and a listId, watchlist_add_bulk 1 to 100 symbols', () => {
  expect(schemaOf('watchlist_add').parse({ symbol: 'NASDAQ:AAPL', listId: '101' })).toEqual({
    symbol: 'NASDAQ:AAPL',
    listId: '101',
  });
  expect(schemaOf('watchlist_add_bulk').parse({ symbols: symbols(100) }).symbols).toHaveLength(100);
  expect(schemaOf('watchlist_add_bulk').parse({ symbols: ['AAPL'] })).toEqual({
    symbols: ['AAPL'],
  });
});

test('watchlist_remove takes 1 to 100 symbols, a listId and confirm', () => {
  const schema = schemaOf('watchlist_remove');

  expect(schema.parse({ symbols: ['NASDAQ:AAPL'], listId: '101', confirm: true })).toEqual({
    symbols: ['NASDAQ:AAPL'],
    listId: '101',
    confirm: true,
  });
  expect(Object.keys(toolNamed('watchlist_remove').inputSchema).sort()).toEqual([
    'confirm',
    'listId',
    'symbols',
  ]);
});

test.each([
  ['watchlist_get', 'an empty listId', { listId: '' }],
  ['watchlist_get', 'a listId of 201 characters', { listId: 'x'.repeat(201) }],
  ['watchlist_add', 'no symbol', {}],
  ['watchlist_add', 'an empty symbol', { symbol: '' }],
  ['watchlist_add', 'a symbol of 201 characters', { symbol: 'X'.repeat(201) }],
  ['watchlist_add', 'a symbol that is no text', { symbol: 3 }],
  ['watchlist_add_bulk', 'no symbols', {}],
  ['watchlist_add_bulk', 'an empty list', { symbols: [] }],
  ['watchlist_add_bulk', '101 symbols', { symbols: symbols(101) }],
  ['watchlist_add_bulk', 'an empty symbol', { symbols: ['NYSE:IBM', ''] }],
  ['watchlist_remove', 'an empty list', { symbols: [] }],
  ['watchlist_remove', '101 symbols', { symbols: symbols(101) }],
  ['watchlist_remove', 'a confirm that is no boolean', { symbols: ['NYSE:IBM'], confirm: 'yes' }],
])('%s refuses %s', (name, _label, input) => {
  expect(schemaOf(name).safeParse(input).success).toBe(false);
});

test('watchlist_remove lets through a failure that is no error of the server, after the change', async () => {
  // The page bridge rejects only with errors of the server, so a failure of another kind, a bug,
  // needs a page of its own: the list is read, the removal is taken, and the read after it fails.
  const list: WatchlistRecord = {
    id: '101',
    kind: 'custom',
    name: 'Fixture List',
    entries: ['NASDAQ:AAPL'],
    active: true,
    editable: true,
  };
  let reads = 0;
  const bridge = {
    evaluateWithLib: (fn: unknown, args: unknown[]): Promise<unknown> => {
      if (fn === changeWatchlistViaApi) {
        return Promise.resolve({ sent: true, symbols: [] });
      }
      if (fn !== readWatchlist) {
        return Promise.reject(new Error('Unexpected page function'));
      }
      reads += 1;
      return args[2] === true
        ? Promise.reject(new Error('A bug'))
        : Promise.resolve({ ready: true, refreshed: null, signedIn: true, list });
    },
  };
  const ctx = {
    ...createTestContext(),
    connection: { chartPage: () => Promise.resolve({ bridge }) },
  } as unknown as ToolContext;

  await expect(
    watchlistRemove.handler({ symbols: ['NASDAQ:AAPL'], confirm: true }, ctx),
  ).rejects.toThrow('A bug');
  expect(reads).toBe(2);
});
