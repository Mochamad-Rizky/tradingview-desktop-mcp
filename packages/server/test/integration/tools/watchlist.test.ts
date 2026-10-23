import { setTimeout as delay } from 'node:timers/promises';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../../../src/config/schema.js';
import { createMcpServer } from '../../../src/server.js';
import type { SessionState } from '../../../src/tools/types.js';
import { startFakeCdpServer } from '../../helpers/fake-cdp/server.js';
import { loadTargetsFixture } from '../../helpers/fake-cdp/targets.js';
import {
  loadTvFixture,
  type FixtureWatchlists,
  type TvStateFixture,
} from '../../helpers/fake-tv/fixture.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTvOverrides,
  type FakeTvWindow,
} from '../../helpers/fake-tv/window.js';
import { callTool, connectInMemoryClient, textOf } from '../../helpers/mcp-client.js';
import type { Logger } from '../../../src/core/logger.js';
import {
  capturingLogger,
  quietLogger,
  refusingLauncher,
  testConfig,
} from '../../helpers/tool-context.js';

// The watchlist tools through the whole server: an SDK client over the in-memory transport, the real
// registry, connection manager and CDP adapter, and the fake debug port of the app with a fake chart,
// a fake symbol list store and a fake watchlist server behind it. Values are synthetic.

// Nothing in this file may run a real program or start TradingView.
vi.mock('node:child_process', () => ({
  spawn: () => {
    throw new Error('A test tried to start a real program with spawn');
  },
  execFile: () => {
    throw new Error('A test tried to start a real program with execFile');
  },
}));

const fixture = loadTvFixture();
// The entries of the active list of the fixture, 101: two sections and three symbols.
const FIXTURE_ENTRIES = ['###Tech', 'NASDAQ:AAPL', 'NASDAQ:MSFT', '###Crypto', 'BINANCE:BTCUSDT'];

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function connect(server: McpServer): Promise<Client> {
  const client = await connectInMemoryClient(server);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

// A server behind a fake app showing `win`, with the session state of the server.
async function startHarnessWith(
  win: FakeTvWindow,
  config: Partial<Config> = {},
  logger: Logger = quietLogger,
): Promise<{ client: Client; win: FakeTvWindow; session: SessionState }> {
  const app = await startFakeCdpServer({ targets: loadTargetsFixture({ chartWindow: () => win }) });
  cleanups.push(() => app.close());
  const { server, ctx } = createMcpServer(
    testConfig({ cdpPort: app.port, callTimeoutMs: 5000, ...config }),
    { launcher: refusingLauncher(), logger },
  );
  cleanups.push(() => ctx.connection.close());
  return { client: await connect(server), win, session: ctx.session };
}

function startHarness(
  from: TvStateFixture = fixture,
  overrides: FakeTvOverrides = {},
): Promise<{ client: Client; win: FakeTvWindow; session: SessionState }> {
  return startHarnessWith(createFakeTvWindow(from, overrides));
}

interface Envelope {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; hint?: string; details?: Record<string, unknown> };
  meta: { via?: string; durationMs: number; warnings?: string[] };
}

const envelopeOf = (result: { structuredContent?: unknown }): Envelope =>
  result.structuredContent as Envelope;
const dataOf = (result: { structuredContent?: unknown }) => envelopeOf(result).data ?? {};
const errorOf = (result: { structuredContent?: unknown }) => envelopeOf(result).error;
const warningsOf = (result: { structuredContent?: unknown }) =>
  envelopeOf(result).meta.warnings ?? [];

const calls = (win: FakeTvWindow, name: string) => inspectFakeWindow(win).callsTo(name);
const callNames = (win: FakeTvWindow) => inspectFakeWindow(win).calls.map(({ name }) => name);
const serverSymbols = (win: FakeTvWindow, id: number | string = 101) =>
  inspectFakeWindow(win).state.watchlists.server.find((list) => list.id === id)?.symbols;
const added = (win: FakeTvWindow) => calls(win, 'symbolListBackend.addSymbols');
const removed = (win: FakeTvWindow) => calls(win, 'symbolListBackend.removeSymbols');
const refreshes = (win: FakeTvWindow) => calls(win, 'getCustomWatchlistsThunk');

// The fixture with its watchlists changed by `change`.
function withWatchlists(
  change: Partial<FixtureWatchlists>,
  from: TvStateFixture = fixture,
): TvStateFixture {
  return {
    ...from,
    watchlists: { ...(from.watchlists ?? { lists: [], active: null }), ...change },
  };
}

// The fixture with the entries of the list `id` replaced.
function withEntries(entries: string[], id = 101, from: TvStateFixture = fixture): TvStateFixture {
  const lists = (from.watchlists?.lists ?? []).map((list) =>
    list.id === id ? { ...list, symbols: entries } : list,
  );
  return withWatchlists({ lists }, from);
}

// A plan whose watchlists are held to the WATCHLIST_SYMBOLS limit (30 in the fixture), as while the
// app turns on its tiered limits.
function tiered(from: TvStateFixture = fixture): TvStateFixture {
  return {
    ...from,
    featureToggles: { ...from.featureToggles, watchlist_symbols_tiered_limits: true },
  };
}

// `count` synthetic symbols that are not in the symbol search of the fixture.
const fillers = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `EXAMPLE:S${String(index)}`);

// The module of a fake window whose exports include `name`, which a test changes in place.
let probes = 0;
function moduleWith(win: FakeTvWindow, name: string): Record<string, unknown> {
  let handed: { c: Record<string, { exports: Record<string, unknown> }> } | undefined;
  probes += 1;
  (win.webpackChunktradingview as { push(chunk: unknown): unknown }).push([
    [`probe${String(probes)}`],
    {},
    (given: typeof handed) => (handed = given),
  ]);
  const found = Object.values(handed?.c ?? {}).find((record) =>
    Object.hasOwn(record.exports, name),
  );
  if (found === undefined) {
    throw new Error(`No module exports ${name}`);
  }
  return found.exports;
}

interface Backend {
  getCustomWatchLists: () => Promise<unknown>;
  addSymbols: (list: unknown, symbols: string[]) => Promise<unknown>;
  removeSymbols: (list: unknown, symbols: string[]) => Promise<unknown>;
}

// The watchlist backend of the fake app, the same object the page reaches.
function backendOf(win: FakeTvWindow): Backend {
  const locator = moduleWith(win, 'serviceOrNull');
  return (locator.serviceOrNull as (descriptor: unknown) => Backend)('SymbolListRepositoryBackend');
}

// Nothing of the dialog thunks of the app, its widget thunks, the actions of its symbol list service
// or initSymbolListService was used, no dialog opened, nothing was registered, TVD was not asked for
// the active watchlist, and of the backend only the calls of the tools went out, the store only
// being refreshed, each time with no signal.
const UNTOUCHABLE =
  /^(watchlistThunks|watchlistWidget|symbolListService|dialog)\.|^(initSymbolListService|registerService|unregisterService|TVD\.getActiveWatchlistId)$/;
const TOOL_CALLS = new Set([
  'symbolListBackend.getCustomWatchLists',
  'symbolListBackend.addSymbols',
  'symbolListBackend.removeSymbols',
]);

function expectNothingElseTouched(win: FakeTvWindow): void {
  const names = callNames(win);
  expect(names.filter((name) => UNTOUCHABLE.test(name))).toEqual([]);
  expect(
    names.filter((name) => name.startsWith('symbolListBackend.') && !TOOL_CALLS.has(name)),
  ).toEqual([]);
  expect(
    calls(win, 'symbolListStore.dispatch').filter(([type]) => type !== 'custom-lists/setup'),
  ).toEqual([]);
  expect(refreshes(win).filter((args) => args[0] !== null || args.length !== 1)).toEqual([]);
}

// Has every refresh of the store that a page function starts after a change of the server aborted
// at once by a refresh the app starts meanwhile, as when the watchlist panel mounts, which loads
// nothing before the call is over: the aborted refresh resolves without loading anything.
function abortRefreshesAfterChanges(win: FakeTvWindow): void {
  const thunks = moduleWith(win, 'getCustomWatchlistsThunk');
  const refresh = thunks.getCustomWatchlistsThunk as (signal: unknown) => unknown;
  thunks.getCustomWatchlistsThunk = (signal: unknown) => {
    const thunk = refresh(signal);
    if (added(win).length + removed(win).length > 0) {
      // The refresh of the app, which aborts the one before it as soon as it is made.
      refresh(null);
    }
    return thunk;
  };
}

// Whether the last refresh of the store came after the last call of the backend named `method`.
function refreshedAfter(win: FakeTvWindow, method: string): boolean {
  const names = callNames(win);
  return names.lastIndexOf('getCustomWatchlistsThunk') > names.lastIndexOf(method);
}

describe('watchlist_list', () => {
  test('watchlist_list reports every list with its symbol count, whether it is active and whether it can be edited', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'watchlist_list');

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: {
        lists: [
          { id: '101', name: 'Fixture List', symbolCount: 3, active: true, editable: true },
          { id: '102', name: 'Second List', symbolCount: 2, active: false, editable: true },
          { id: 'red', name: 'Red list', symbolCount: 1, active: false, editable: false },
          {
            id: '###HOT###US.gainers',
            name: 'Fixture Gainers',
            symbolCount: 2,
            active: false,
            editable: false,
          },
        ],
      },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(JSON.parse(textOf(result))).toStrictEqual(result.structuredContent);
    // TradingView had loaded the active list alone, so the lists were refreshed once, the way the
    // watchlist panel loads them.
    expect(refreshes(win)).toEqual([[null]]);
    expect(calls(win, 'symbolListBackend.getCustomWatchLists')).toEqual([[]]);
    expectNothingElseTouched(win);
  });

  test('watchlist_list does not refresh lists TradingView has loaded already', async () => {
    const { client, win } = await startHarness(withWatchlists({ ready: true }));

    const result = await callTool(client, 'watchlist_list');

    expect((dataOf(result).lists as unknown[]).length).toBe(4);
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('watchlist_list fails NOT_AVAILABLE when TradingView cannot load the watchlists', async () => {
    const win = createFakeTvWindow(fixture);
    inspectFakeWindow(win).state.watchlists.errors.getCustomWatchLists = {
      code: null,
      message: 'Failed to fetch',
    };
    const { client } = await startHarnessWith(win);

    const result = await callTool(client, 'watchlist_list');

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      hint: expect.stringMatching(/ui_open_panel.*watchlist/s) as string,
    });
  });

  test('a build without the refresh thunk lists what TradingView has loaded, and refuses while that is not every list', async () => {
    const { client: ready } = await startHarness(withWatchlists({ ready: true }), {
      watchlists: { withoutRefreshThunk: true },
    });
    const { client: loading } = await startHarness(fixture, {
      watchlists: { withoutRefreshThunk: true },
    });

    expect((dataOf(await callTool(ready, 'watchlist_list')).lists as unknown[]).length).toBe(4);
    expect(errorOf(await callTool(loading, 'watchlist_list'))).toMatchObject({
      code: 'NOT_AVAILABLE',
    });
  });
});

describe('reading', () => {
  test('the watchlist tools answer NOT_AVAILABLE with the hint to open the watchlist while the symbol list service is not set up, and never create it', async () => {
    const { client, win } = await startHarness(fixture, { watchlists: { withoutService: true } });

    for (const [tool, args] of [
      ['watchlist_list', {}],
      ['watchlist_get', {}],
      ['watchlist_add', { symbol: 'NYSE:IBM' }],
      ['watchlist_add_bulk', { symbols: ['NYSE:IBM'] }],
      ['watchlist_remove', { symbols: ['NASDAQ:AAPL'], confirm: true }],
    ] as const) {
      const result = await callTool(client, tool, args);

      expect(errorOf(result), tool).toMatchObject({
        code: 'NOT_AVAILABLE',
        hint: expect.stringMatching(/ui_open_panel.*panel: 'watchlist'/s) as string,
      });
    }
    expect(calls(win, 'initSymbolListService')).toEqual([]);
    expect(added(win)).toEqual([]);
    expect(removed(win)).toEqual([]);
    expectNothingElseTouched(win);
  });

  test('a build without the selectors of the watchlists refuses NOT_AVAILABLE', async () => {
    const { client, win } = await startHarness(fixture, { watchlists: { withoutSelectors: true } });

    for (const tool of ['watchlist_list', 'watchlist_get'] as const) {
      expect(errorOf(await callTool(client, tool)), tool).toMatchObject({ code: 'NOT_AVAILABLE' });
    }
    expectNothingElseTouched(win);
  });

  test('the default list is the active one', async () => {
    const { client, win } = await startHarness();
    const { client: other } = await startHarness(
      withWatchlists({ active: { type: 'custom', id: 102 }, ready: true }),
    );

    const active = dataOf(await callTool(client, 'watchlist_get'));
    const named = dataOf(await callTool(client, 'watchlist_get', { listId: '101' }));

    expect(active).toEqual(named);
    expect(active).toMatchObject({ id: '101', name: 'Fixture List', editable: true });
    expect(dataOf(await callTool(other, 'watchlist_get'))).toMatchObject({
      id: '102',
      name: 'Second List',
      symbols: ['NYSE:IBM', 'FX:EURUSD'],
    });
    // The active list is the one the store of the app holds; TVD is not asked for it.
    expect(calls(win, 'TVD.getActiveWatchlistId')).toEqual([]);
    expectNothingElseTouched(win);
  });

  test('watchlist_get leaves the section markers out of symbols and reports the sections in order', async () => {
    const { client } = await startHarness(
      withEntries([
        'NYSE:IBM',
        '###Tech',
        'NASDAQ:AAPL',
        'NASDAQ:MSFT',
        '###Empty',
        '###⁤Crypto',
        'BINANCE:BTCUSDT',
      ]),
    );

    const result = await callTool(client, 'watchlist_get');

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: {
        id: '101',
        name: 'Fixture List',
        editable: true,
        symbols: ['NYSE:IBM', 'NASDAQ:AAPL', 'NASDAQ:MSFT', 'BINANCE:BTCUSDT'],
        sections: [
          { name: null, symbols: ['NYSE:IBM'] },
          { name: 'Tech', symbols: ['NASDAQ:AAPL', 'NASDAQ:MSFT'] },
          { name: 'Empty', symbols: [] },
          { name: 'Crypto', symbols: ['BINANCE:BTCUSDT'] },
        ],
      },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
  });

  test('watchlist_get reads another custom list by its id, loading the lists first when TradingView has only the active one', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'watchlist_get', { listId: '102' });

    expect(dataOf(result)).toEqual({
      id: '102',
      name: 'Second List',
      editable: true,
      symbols: ['NYSE:IBM', 'FX:EURUSD'],
      sections: [{ name: null, symbols: ['NYSE:IBM', 'FX:EURUSD'] }],
    });
    expect(refreshes(win)).toEqual([[null]]);
  });

  test('watchlist_get reads a flag list and a hot list by their ids, which cannot be edited', async () => {
    const { client } = await startHarness();

    expect(dataOf(await callTool(client, 'watchlist_get', { listId: 'red' }))).toEqual({
      id: 'red',
      name: 'Red list',
      editable: false,
      symbols: ['NASDAQ:NVDA'],
      sections: [{ name: null, symbols: ['NASDAQ:NVDA'] }],
    });
    expect(
      dataOf(await callTool(client, 'watchlist_get', { listId: '###HOT###US.gainers' })),
    ).toMatchObject({ id: '###HOT###US.gainers', name: 'Fixture Gainers', editable: false });
  });

  test('an unknown listId is INVALID_INPUT with the hint watchlist_list', async () => {
    const { client, win } = await startHarness();

    for (const [tool, args] of [
      ['watchlist_get', { listId: '999' }],
      ['watchlist_get', { listId: 'constructor' }],
      ['watchlist_add', { symbol: 'NYSE:IBM', listId: '999' }],
      ['watchlist_add_bulk', { symbols: ['NYSE:IBM'], listId: '999' }],
      ['watchlist_remove', { symbols: ['NYSE:IBM'], listId: '999', confirm: true }],
    ] as const) {
      const result = await callTool(client, tool, args);

      expect(errorOf(result), `${tool} ${args.listId}`).toMatchObject({
        code: 'INVALID_INPUT',
        hint: expect.stringContaining('watchlist_list') as string,
        details: { listId: args.listId },
      });
    }
    expect(added(win)).toEqual([]);
    expect(removed(win)).toEqual([]);
  });

  test('a list TradingView cannot load fails NOT_AVAILABLE rather than INVALID_INPUT', async () => {
    const win = createFakeTvWindow(fixture);
    inspectFakeWindow(win).state.watchlists.errors.getCustomWatchLists = {
      code: 'maintenance',
      message: 'Maintenance',
    };
    const { client } = await startHarnessWith(win);

    const result = await callTool(client, 'watchlist_get', { listId: '102' });

    expect(errorOf(result)).toMatchObject({ code: 'NOT_AVAILABLE' });
    // The active list is in the store all the same.
    expect(dataOf(await callTool(client, 'watchlist_get'))).toMatchObject({ id: '101' });
  });

  test('without an active list watchlist_get fails NOT_AVAILABLE', async () => {
    const { client } = await startHarness(withWatchlists({ active: null }));

    expect(errorOf(await callTool(client, 'watchlist_get'))).toMatchObject({
      code: 'NOT_AVAILABLE',
      hint: expect.stringContaining('watchlist_list') as string,
    });
  });
});

describe('watchlist_add and watchlist_add_bulk', () => {
  test('watchlist_add_bulk reports added, already listed, duplicate and unknown symbols and adds each at most once', async () => {
    const { client, win, session } = await startHarness();

    const result = await callTool(client, 'watchlist_add_bulk', {
      symbols: ['NYSE:IBM', 'NASDAQ:MSFT', 'nyse:ibm', 'NASDAQ:ZZZZ', 'FX:EURUSD', 'IBM', 'AAPL'],
    });

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: {
        listId: '101',
        added: ['NYSE:IBM', 'FX:EURUSD'],
        skipped: [
          { symbol: 'NASDAQ:MSFT', reason: 'already_listed' },
          { symbol: 'nyse:ibm', reason: 'duplicate' },
          { symbol: 'NASDAQ:ZZZZ', reason: 'unknown' },
          // The ticker alone stands for its first listing, NYSE:IBM, given before.
          { symbol: 'IBM', reason: 'duplicate' },
          // NASDAQ:AAPL, which the list holds.
          { symbol: 'AAPL', reason: 'already_listed' },
        ],
      },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    // One request, with each new symbol once.
    expect(added(win)).toEqual([[{ id: 101 }, ['NYSE:IBM', 'FX:EURUSD']]]);
    expect(serverSymbols(win)).toEqual([...FIXTURE_ENTRIES, 'NYSE:IBM', 'FX:EURUSD']);
    // A ticker is searched for once, however many symbols name it.
    expect(
      calls(win, 'TradingViewApi.searchSymbols').map(
        ([options]) => (options as { text: string }).text,
      ),
    ).toEqual(['IBM', 'ZZZZ', 'EURUSD', 'AAPL']);
    expect(session.addedWatchlistSymbols).toEqual(
      new Map([['101', new Set(['NYSE:IBM', 'FX:EURUSD'])]]),
    );
    // The store was refreshed after the change, so TradingView shows the symbols.
    expect(refreshedAfter(win, 'symbolListBackend.addSymbols')).toBe(true);
    expect(dataOf(await callTool(client, 'watchlist_get')).symbols).toEqual([
      'NASDAQ:AAPL',
      'NASDAQ:MSFT',
      'BINANCE:BTCUSDT',
      'NYSE:IBM',
      'FX:EURUSD',
    ]);
    expectNothingElseTouched(win);
  });

  test('watchlist_add adds a symbol with the append request of the app and refreshes the store', async () => {
    const { client, win, session } = await startHarness();

    const result = await callTool(client, 'watchlist_add', { symbol: 'NYSE:IBM' });

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: { listId: '101', symbol: 'NYSE:IBM', outcome: 'added' },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(added(win)).toEqual([[{ id: 101 }, ['NYSE:IBM']]]);
    expect(refreshedAfter(win, 'symbolListBackend.addSymbols')).toBe(true);
    expect(session.addedWatchlistSymbols).toEqual(new Map([['101', new Set(['NYSE:IBM'])]]));
    expectNothingElseTouched(win);
  });

  test('watchlist_add adds to the list listId names, and takes a ticker alone as its first listing', async () => {
    const { client, win, session } = await startHarness();

    const ticker = await callTool(client, 'watchlist_add', { symbol: 'msft', listId: '102' });
    const prefixed = await callTool(client, 'watchlist_add', {
      symbol: 'bats:aapl',
      listId: '102',
    });

    expect(dataOf(ticker)).toEqual({ listId: '102', symbol: 'NASDAQ:MSFT', outcome: 'added' });
    expect(dataOf(prefixed)).toEqual({ listId: '102', symbol: 'BATS:AAPL', outcome: 'added' });
    expect(serverSymbols(win, 102)).toEqual(['NYSE:IBM', 'FX:EURUSD', 'NASDAQ:MSFT', 'BATS:AAPL']);
    expect(serverSymbols(win)).toEqual(FIXTURE_ENTRIES);
    expect(session.addedWatchlistSymbols.get('102')).toEqual(new Set(['NASDAQ:MSFT', 'BATS:AAPL']));
  });

  test('watchlist_add of a symbol the list holds already, by its full name or by its ticker alone, adds nothing', async () => {
    const { client, win, session } = await startHarness(withEntries([...FIXTURE_ENTRIES, 'IBM']));

    const full = await callTool(client, 'watchlist_add', { symbol: 'nasdaq:msft' });
    const short = await callTool(client, 'watchlist_add', { symbol: 'NYSE:IBM' });

    expect(dataOf(full)).toEqual({
      listId: '101',
      symbol: 'NASDAQ:MSFT',
      outcome: 'already_listed',
    });
    expect(dataOf(short)).toEqual({ listId: '101', symbol: 'IBM', outcome: 'already_listed' });
    expect(added(win)).toEqual([]);
    expect(session.addedWatchlistSymbols.size).toBe(0);
  });

  test('watchlist_add of a symbol the symbol search does not know is INVALID_INPUT, and nothing is added', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'watchlist_add', { symbol: 'NASDAQ:ZZZZ' });

    expect(errorOf(result)).toMatchObject({
      code: 'INVALID_INPUT',
      message: 'The symbol search of TradingView found no NASDAQ:ZZZZ',
      hint: expect.stringContaining('data_search_symbols') as string,
      details: { symbol: 'NASDAQ:ZZZZ' },
    });
    expect(added(win)).toEqual([]);
  });

  test('a blank symbol is INVALID_INPUT before TradingView is asked anything', async () => {
    const { client, win } = await startHarness();

    const single = await callTool(client, 'watchlist_add', { symbol: '   ' });
    const bulk = await callTool(client, 'watchlist_add_bulk', { symbols: ['NYSE:IBM', ' '] });
    const removal = await callTool(client, 'watchlist_remove', { symbols: [' '] });

    for (const result of [single, bulk, removal]) {
      expect(errorOf(result)).toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('watchlist_add returns PLAN_LIMIT WATCHLIST_SYMBOLS before adding when the list is full', async () => {
    // TradingView counts every entry, section markers included: 999 symbols and a marker are 1000.
    const { client, win, session } = await startHarness(withEntries(['###Full', ...fillers(999)]));
    const { client: tieredClient, win: tieredWin } = await startHarness(
      tiered(withEntries(fillers(30))),
    );

    const result = await callTool(client, 'watchlist_add', { symbol: 'NYSE:IBM' });
    const tieredResult = await callTool(tieredClient, 'watchlist_add', { symbol: 'NYSE:IBM' });

    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({
      code: 'PLAN_LIMIT',
      message: expect.stringContaining('WATCHLIST_SYMBOLS') as string,
      hint: expect.stringContaining('watchlist_remove') as string,
      details: { feature: 'WATCHLIST_SYMBOLS', limit: 1000 },
    });
    expect(errorOf(tieredResult)).toMatchObject({
      code: 'PLAN_LIMIT',
      details: { feature: 'WATCHLIST_SYMBOLS', limit: 30 },
    });
    expect(added(win)).toEqual([]);
    expect(added(tieredWin)).toEqual([]);
    expect(session.addedWatchlistSymbols.size).toBe(0);
    expectNothingElseTouched(win);
    expectNothingElseTouched(tieredWin);
  });

  test('watchlist_add_bulk checks the limit for all its symbols together before it adds any', async () => {
    const { client, win } = await startHarness(tiered(withEntries(fillers(28))));

    const tooMany = await callTool(client, 'watchlist_add_bulk', {
      symbols: ['NYSE:IBM', 'FX:EURUSD', 'NASDAQ:MSFT'],
    });

    expect(errorOf(tooMany)).toMatchObject({
      code: 'PLAN_LIMIT',
      details: { feature: 'WATCHLIST_SYMBOLS', limit: 30 },
    });
    expect(added(win)).toEqual([]);
    // Symbols the list holds already take no room.
    const fitting = await callTool(client, 'watchlist_add_bulk', {
      symbols: ['NYSE:IBM', 'FX:EURUSD', 'EXAMPLE:S0'],
    });
    expect(dataOf(fitting)).toMatchObject({ added: ['NYSE:IBM', 'FX:EURUSD'] });
    expect(serverSymbols(win)).toHaveLength(30);
  });

  test('the WATCHLIST_SYMBOLS config of the plan is not enforced while the tiered limits of TradingView are off', async () => {
    const { client, win } = await startHarness(withEntries(fillers(30)));

    const result = await callTool(client, 'watchlist_add', { symbol: 'NYSE:IBM' });

    expect(dataOf(result)).toMatchObject({ outcome: 'added' });
    expect(serverSymbols(win)).toHaveLength(31);
  });

  test('watchlist_add refuses when the limit cannot be read', async () => {
    const withoutModule = createFakeTvWindow(fixture, { watchlists: { withoutLimits: true } });
    const noNumber = createFakeTvWindow(fixture);
    moduleWith(noNumber, 'getWatchlistSymbolsLimit').getWatchlistSymbolsLimit = () => undefined;
    const throwing = createFakeTvWindow(fixture);
    moduleWith(throwing, 'getWatchlistSymbolsLimit').getWatchlistSymbolsLimit = () => {
      throw new Error('Not ready');
    };
    const noMaximum = createFakeTvWindow(fixture);
    moduleWith(noMaximum, 'MAX_WATCHLIST_LENGTH').MAX_WATCHLIST_LENGTH = 'many';

    for (const win of [withoutModule, noNumber, throwing, noMaximum]) {
      const { client } = await startHarnessWith(win);

      const result = await callTool(client, 'watchlist_add', { symbol: 'NYSE:IBM' });

      expect(errorOf(result)).toMatchObject({
        code: 'NOT_AVAILABLE',
        details: { feature: 'WATCHLIST_SYMBOLS' },
      });
      expect(added(win)).toEqual([]);
    }
  });

  test('watchlist_add refuses NOT_AVAILABLE when the list holds more entries than TradingView lets a watchlist hold', async () => {
    const over = createFakeTvWindow(withEntries(fillers(1001)));
    // A plan whose limit lies beyond the maximum of the app: the maximum still applies.
    const beyond = createFakeTvWindow(
      tiered({
        ...withEntries(fillers(1000)),
        planLimits: { ...fixture.planLimits, WATCHLIST_SYMBOLS: 2000 },
      }),
    );

    for (const win of [over, beyond]) {
      const { client } = await startHarnessWith(win);

      const result = await callTool(client, 'watchlist_add', { symbol: 'NYSE:IBM' });

      expect(errorOf(result)).toMatchObject({
        code: 'NOT_AVAILABLE',
        details: { feature: 'WATCHLIST_SYMBOLS', max: 1000 },
      });
      expect(added(win)).toEqual([]);
      expectNothingElseTouched(win);
    }
  });

  test('a refusal of the server for the limit of the plan is relayed as PLAN_LIMIT unchanged, and the store is refreshed', async () => {
    const win = createFakeTvWindow(fixture);
    inspectFakeWindow(win).state.watchlists.serverLimit = 5;
    const { client, session } = await startHarnessWith(win);

    const result = await callTool(client, 'watchlist_add', { symbol: 'NYSE:IBM' });

    expect(errorOf(result)).toMatchObject({
      code: 'PLAN_LIMIT',
      message: 'A watchlist can hold up to 5 symbols on the plan of the account',
      details: { feature: 'WATCHLIST_SYMBOLS', code: 'plan_symbols_limit_reached' },
    });
    expect(added(win)).toHaveLength(1);
    expect(refreshedAfter(win, 'symbolListBackend.addSymbols')).toBe(true);
    expect(serverSymbols(win)).toEqual(FIXTURE_ENTRIES);
    expect(session.addedWatchlistSymbols.size).toBe(0);
    expectNothingElseTouched(win);
  });

  test('any other refusal of the server is PAGE_EVALUATION_FAILED with its code, and the store is refreshed', async () => {
    const refusing = createFakeTvWindow(fixture);
    inspectFakeWindow(refusing).state.watchlists.errors.addSymbols = {
      code: 'symbol_not_allowed',
      message: 'Symbol not allowed',
    };
    const failing = createFakeTvWindow(fixture);
    inspectFakeWindow(failing).state.watchlists.errors.addSymbols = {
      code: null,
      message: 'Failed to fetch',
    };
    const { client: refusingClient } = await startHarnessWith(refusing);
    const { client: failingClient } = await startHarnessWith(failing);

    const refused = await callTool(refusingClient, 'watchlist_add', { symbol: 'NYSE:IBM' });
    const failed = await callTool(failingClient, 'watchlist_add', { symbol: 'NYSE:IBM' });

    expect(errorOf(refused)).toMatchObject({
      code: 'PAGE_EVALUATION_FAILED',
      message: expect.stringContaining('Symbol not allowed (symbol_not_allowed)') as string,
      details: { code: 'symbol_not_allowed' },
    });
    expect(errorOf(failed)).toMatchObject({
      code: 'PAGE_EVALUATION_FAILED',
      message: expect.stringContaining('Failed to fetch') as string,
      hint: expect.stringContaining('watchlist_get') as string,
      details: { code: null },
    });
    for (const win of [refusing, failing]) {
      expect(refreshedAfter(win, 'symbolListBackend.addSymbols')).toBe(true);
    }
  });

  test('two parallel watchlist_add calls at the limit − 1 add one symbol', async () => {
    const win = createFakeTvWindow(tiered(withEntries(fillers(29))));
    // A call that adds waits in addSymbols until the other call has read the limit as well, or for a
    // while when the other call waits for its turn instead.
    const limits = moduleWith(win, 'getWatchlistSymbolsLimit');
    const readLimit = limits.getWatchlistSymbolsLimit as () => number;
    let reads = 0;
    let readTwice = (): void => undefined;
    const secondRead = new Promise<void>((resolve) => {
      readTwice = resolve;
    });
    limits.getWatchlistSymbolsLimit = () => {
      reads += 1;
      if (reads === 2) {
        readTwice();
      }
      return readLimit();
    };
    const backend = backendOf(win);
    const add = backend.addSymbols.bind(backend);
    backend.addSymbols = async (list, symbols) => {
      await Promise.race([secondRead, delay(300)]);
      return add(list, symbols);
    };
    const { client } = await startHarnessWith(win);

    const results = await Promise.all([
      callTool(client, 'watchlist_add', { symbol: 'NYSE:IBM' }),
      callTool(client, 'watchlist_add', { symbol: 'FX:EURUSD' }),
    ]);

    expect(results.map((result) => envelopeOf(result).ok).sort()).toEqual([false, true]);
    expect(results.map((result) => errorOf(result)?.code).filter(Boolean)).toEqual(['PLAN_LIMIT']);
    expect(added(win)).toHaveLength(1);
    expect(serverSymbols(win)).toHaveLength(30);
  });

  test('two parallel additions of one symbol add it once, and the second reports it listed', async () => {
    const win = createFakeTvWindow(withWatchlists({ ready: true }));
    // The first addition lands late, after the second has read the list and searched the symbol.
    const backend = backendOf(win);
    const add = backend.addSymbols.bind(backend);
    backend.addSymbols = async (list, symbols) => {
      await delay(300);
      return add(list, symbols);
    };
    const { client, session } = await startHarnessWith(win);

    const results = await Promise.all([
      callTool(client, 'watchlist_add', { symbol: 'NYSE:IBM' }),
      callTool(client, 'watchlist_add_bulk', { symbols: ['NYSE:IBM'] }),
    ]);

    expect(dataOf(results[0])).toEqual({ listId: '101', symbol: 'NYSE:IBM', outcome: 'added' });
    expect(dataOf(results[1])).toEqual({
      listId: '101',
      added: [],
      skipped: [{ symbol: 'NYSE:IBM', reason: 'already_listed' }],
    });
    expect(added(win)).toHaveLength(1);
    expect(session.addedWatchlistSymbols).toEqual(new Map([['101', new Set(['NYSE:IBM'])]]));
  });

  test('a list that cannot be read again after a change is reported as a warning, with what the server answered', async () => {
    const win = createFakeTvWindow(withWatchlists({ ready: true }));
    // The first read of the list by its id after each change of the server fails, which is the read
    // after the change.
    const selectors = moduleWith(win, 'getCustomListById');
    const byId = selectors.getCustomListById as (state: unknown, id: number) => unknown;
    let seenChanges = 0;
    selectors.getCustomListById = (state: unknown, id: number) => {
      const changes = added(win).length + removed(win).length;
      if (changes > seenChanges) {
        seenChanges = changes;
        throw new Error('Not readable');
      }
      return byId(state, id);
    };
    const { client } = await startHarnessWith(win);

    const adding = await callTool(client, 'watchlist_add', { symbol: 'NYSE:IBM' });
    const removing = await callTool(client, 'watchlist_remove', {
      symbols: ['NYSE:IBM', 'NASDAQ:AAPL'],
      confirm: true,
    });

    expect(dataOf(adding)).toEqual({ listId: '101', symbol: 'NYSE:IBM', outcome: 'added' });
    expect(warningsOf(adding)).toEqual([expect.stringContaining('may show') as string]);
    expect(dataOf(removing)).toEqual({
      listId: '101',
      removed: ['NYSE:IBM', 'NASDAQ:AAPL'],
      notListed: [],
    });
    expect(warningsOf(removing)).toEqual([expect.stringContaining('may show') as string]);
    expect(serverSymbols(win)).toEqual(['###Tech', 'NASDAQ:MSFT', '###Crypto', 'BINANCE:BTCUSDT']);
  });

  test('a flag list, a hot list or an active flag list cannot be edited: INVALID_INPUT with the hint watchlist_list', async () => {
    const { client, win } = await startHarness();
    const { client: flagged, win: flaggedWin } = await startHarness(
      withWatchlists({ active: { type: 'color', id: 'red' } }),
    );

    for (const [tool, args] of [
      ['watchlist_add', { symbol: 'NYSE:IBM', listId: 'red' }],
      ['watchlist_add_bulk', { symbols: ['NYSE:IBM'], listId: '###HOT###US.gainers' }],
      ['watchlist_remove', { symbols: ['NASDAQ:NVDA'], listId: 'red', confirm: true }],
    ] as const) {
      expect(errorOf(await callTool(client, tool, args)), tool).toMatchObject({
        code: 'INVALID_INPUT',
        hint: expect.stringContaining('watchlist_list') as string,
        details: { listId: args.listId },
      });
    }
    expect(errorOf(await callTool(flagged, 'watchlist_add', { symbol: 'NYSE:IBM' }))).toMatchObject(
      { code: 'INVALID_INPUT', hint: expect.stringContaining('watchlist_list') as string },
    );
    for (const target of [win, flaggedWin]) {
      expect(added(target)).toEqual([]);
      expect(removed(target)).toEqual([]);
    }
  });

  test('a list TradingView keeps on this computer only cannot be edited', async () => {
    const { client, win } = await startHarness(
      withWatchlists({
        lists: [
          ...(fixture.watchlists?.lists ?? []),
          { id: 'deleted_symbols_list_id', name: 'Recently deleted', symbols: ['NYSE:IBM'] },
        ],
        ready: true,
      }),
    );

    const listed = dataOf(await callTool(client, 'watchlist_list')).lists as {
      id: string;
      editable: boolean;
    }[];
    const result = await callTool(client, 'watchlist_add', {
      symbol: 'FX:EURUSD',
      listId: 'deleted_symbols_list_id',
    });

    expect(listed.find(({ id }) => id === 'deleted_symbols_list_id')).toMatchObject({
      editable: false,
    });
    expect(errorOf(result)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(added(win)).toEqual([]);
  });

  test('editing a watchlist needs a signed-in account', async () => {
    const win = createFakeTvWindow(fixture);
    inspectFakeWindow(win).state.pineEditor.signedIn = false;
    const { client } = await startHarnessWith(win);

    for (const [tool, args] of [
      ['watchlist_add', { symbol: 'NYSE:IBM' }],
      ['watchlist_add_bulk', { symbols: ['NYSE:IBM'] }],
      ['watchlist_remove', { symbols: ['NASDAQ:AAPL'], confirm: true }],
    ] as const) {
      expect(errorOf(await callTool(client, tool, args)), tool).toMatchObject({
        code: 'AUTH_REQUIRED',
      });
    }
    expect(added(win)).toEqual([]);
    expect(removed(win)).toEqual([]);
    // Refused before anything was searched.
    expect(calls(win, 'TradingViewApi.searchSymbols')).toEqual([]);
    // Reading needs no account.
    expect(dataOf(await callTool(client, 'watchlist_get'))).toMatchObject({ id: '101' });
  });

  test('the watchlist tools change nothing while TradingView still has to save the sections of the list', async () => {
    const win = createFakeTvWindow(fixture);
    inspectFakeWindow(win).state.watchlists.pendingOpenSeparators.add('101');
    const { client } = await startHarnessWith(win);

    const adding = await callTool(client, 'watchlist_add', { symbol: 'NYSE:IBM' });
    const removing = await callTool(client, 'watchlist_remove', {
      symbols: ['NASDAQ:AAPL'],
      confirm: true,
    });

    for (const result of [adding, removing]) {
      expect(errorOf(result)).toMatchObject({ code: 'NOT_AVAILABLE' });
    }
    expect(added(win)).toEqual([]);
    expect(removed(win)).toEqual([]);
    expect(serverSymbols(win)).toEqual(FIXTURE_ENTRIES);
  });

  test('a symbol TradingView does not list after the addition is left out of added with a warning, and none listed is NOT_AVAILABLE', async () => {
    const partial = createFakeTvWindow(fixture);
    const partialBackend = backendOf(partial);
    const addPartly = partialBackend.addSymbols.bind(partialBackend);
    // The server takes the first symbol only.
    partialBackend.addSymbols = (list, symbols) => addPartly(list, symbols.slice(0, 1));
    const ignoring = createFakeTvWindow(fixture);
    backendOf(ignoring).addSymbols = () => Promise.resolve([...FIXTURE_ENTRIES]);
    const { client: partialClient, session } = await startHarnessWith(partial);
    const { client: ignoringClient } = await startHarnessWith(ignoring);

    const some = await callTool(partialClient, 'watchlist_add_bulk', {
      symbols: ['NYSE:IBM', 'FX:EURUSD'],
    });
    const none = await callTool(ignoringClient, 'watchlist_add', { symbol: 'NYSE:IBM' });

    expect(dataOf(some)).toEqual({ listId: '101', added: ['NYSE:IBM'], skipped: [] });
    expect(warningsOf(some)).toEqual([expect.stringContaining('FX:EURUSD') as string]);
    expect(session.addedWatchlistSymbols).toEqual(new Map([['101', new Set(['NYSE:IBM'])]]));
    expect(errorOf(none)).toMatchObject({
      code: 'NOT_AVAILABLE',
      hint: expect.stringContaining('watchlist_get') as string,
    });
  });

  test('a store that cannot be refreshed after the change is reported as a warning, with what the server answered', async () => {
    const win = createFakeTvWindow(withWatchlists({ ready: true }));
    const { client, session } = await startHarnessWith(win);
    inspectFakeWindow(win).state.watchlists.errors.getCustomWatchLists = {
      code: null,
      message: 'Failed to fetch',
    };

    const result = await callTool(client, 'watchlist_add', { symbol: 'NYSE:IBM' });

    expect(dataOf(result)).toEqual({ listId: '101', symbol: 'NYSE:IBM', outcome: 'added' });
    expect(warningsOf(result)).toEqual([expect.stringContaining('watchlist') as string]);
    expect(serverSymbols(win)).toEqual([...FIXTURE_ENTRIES, 'NYSE:IBM']);
    expect(session.addedWatchlistSymbols.get('101')).toEqual(new Set(['NYSE:IBM']));
  });

  test('an addition that neither the reloaded store nor the answer of the server shows is NOT_AVAILABLE, and nothing is recorded', async () => {
    const win = createFakeTvWindow(withWatchlists({ ready: true }));
    const backend = backendOf(win);
    const add = backend.addSymbols.bind(backend);
    // The server takes the symbols and answers no list of them.
    backend.addSymbols = async (list, symbols) => {
      await add(list, symbols);
      return undefined;
    };
    const { client, session } = await startHarnessWith(win);
    inspectFakeWindow(win).state.watchlists.errors.getCustomWatchLists = {
      code: null,
      message: 'Failed to fetch',
    };

    const single = await callTool(client, 'watchlist_add', { symbol: 'NYSE:IBM' });
    const bulk = await callTool(client, 'watchlist_add_bulk', { symbols: ['FX:EURUSD'] });

    expect(errorOf(single)).toMatchObject({
      code: 'NOT_AVAILABLE',
      hint: expect.stringMatching(/watchlist_get.*confirm: true/s) as string,
      details: { listId: '101', symbols: ['NYSE:IBM'] },
    });
    expect(errorOf(bulk)).toMatchObject({
      code: 'NOT_AVAILABLE',
      details: { listId: '101', symbols: ['FX:EURUSD'] },
    });
    expect(session.addedWatchlistSymbols.size).toBe(0);
  });

  test('an addition whose refresh a later refresh aborts follows the answer of the server, with a warning', async () => {
    const win = createFakeTvWindow(withWatchlists({ ready: true }));
    abortRefreshesAfterChanges(win);
    const { client, session } = await startHarnessWith(win);

    const result = await callTool(client, 'watchlist_add', { symbol: 'NYSE:IBM' });

    expect(dataOf(result)).toEqual({ listId: '101', symbol: 'NYSE:IBM', outcome: 'added' });
    expect(warningsOf(result)).toEqual([expect.stringContaining('may show') as string]);
    expect(session.addedWatchlistSymbols.get('101')).toEqual(new Set(['NYSE:IBM']));
  });

  test('a change that does not come within the time of a call is TIMEOUT, the store is refreshed and nothing is recorded', async () => {
    const win = createFakeTvWindow(fixture);
    const backend = backendOf(win);
    const add = backend.addSymbols.bind(backend);
    // The server takes the symbol at once, and its answer comes late.
    backend.addSymbols = async (list, symbols) => {
      const answer = add(list, symbols);
      await delay(900);
      return answer;
    };
    const { client, session } = await startHarnessWith(win, { callTimeoutMs: 1500 });

    const result = await callTool(client, 'watchlist_add', { symbol: 'NYSE:IBM' });

    expect(errorOf(result)).toMatchObject({
      code: 'TIMEOUT',
      hint: expect.stringMatching(/watchlist_get.*confirm: true/s) as string,
    });
    expect(session.addedWatchlistSymbols.size).toBe(0);
    expect(refreshedAfter(win, 'symbolListBackend.addSymbols')).toBe(true);
  });
});

describe('watchlist_remove', () => {
  test('watchlist_remove of a symbol this session did not add requires confirm', async () => {
    const { client, win } = await startHarness();

    const refused = await callTool(client, 'watchlist_remove', { symbols: ['NASDAQ:AAPL'] });

    expect(errorOf(refused)).toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      hint: expect.stringContaining('confirm: true') as string,
      details: { listId: '101', symbols: ['NASDAQ:AAPL'] },
    });
    expect(removed(win)).toEqual([]);
    expect(serverSymbols(win)).toEqual(FIXTURE_ENTRIES);

    const confirmed = await callTool(client, 'watchlist_remove', {
      symbols: ['NASDAQ:AAPL'],
      confirm: true,
    });

    expect(dataOf(confirmed)).toEqual({ listId: '101', removed: ['NASDAQ:AAPL'], notListed: [] });
    expect(removed(win)).toEqual([[{ id: 101 }, ['NASDAQ:AAPL']]]);
    expect(serverSymbols(win)).toEqual(['###Tech', 'NASDAQ:MSFT', '###Crypto', 'BINANCE:BTCUSDT']);
    expect(refreshedAfter(win, 'symbolListBackend.removeSymbols')).toBe(true);
    expectNothingElseTouched(win);
  });

  test('watchlist_remove of a symbol the session added needs none', async () => {
    const { client, win, session } = await startHarness();
    await callTool(client, 'watchlist_add_bulk', { symbols: ['NYSE:IBM', 'FX:EURUSD'] });

    const result = await callTool(client, 'watchlist_remove', { symbols: ['nyse:ibm'] });

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: { listId: '101', removed: ['NYSE:IBM'], notListed: [] },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(removed(win)).toEqual([[{ id: 101 }, ['NYSE:IBM']]]);
    expect(session.addedWatchlistSymbols).toEqual(new Map([['101', new Set(['FX:EURUSD'])]]));
    expect(dataOf(await callTool(client, 'watchlist_get')).symbols).toEqual([
      'NASDAQ:AAPL',
      'NASDAQ:MSFT',
      'BINANCE:BTCUSDT',
      'FX:EURUSD',
    ]);
    // Once the last symbol it added is gone, the session holds nothing for the list.
    await callTool(client, 'watchlist_remove', { symbols: ['FX:EURUSD'] });
    expect(session.addedWatchlistSymbols).toEqual(new Map());
    expectNothingElseTouched(win);
  });

  test('watchlist_remove asks confirm for the symbols this session did not add only, and removes nothing until then', async () => {
    const { client, win } = await startHarness();
    await callTool(client, 'watchlist_add', { symbol: 'NYSE:IBM' });

    const result = await callTool(client, 'watchlist_remove', {
      symbols: ['NYSE:IBM', 'NASDAQ:MSFT', 'BINANCE:BTCUSDT'],
    });

    expect(errorOf(result)).toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      details: { listId: '101', symbols: ['NASDAQ:MSFT', 'BINANCE:BTCUSDT'] },
    });
    expect(removed(win)).toEqual([]);
  });

  test('the symbols a session added count for the list they were added to only', async () => {
    const { client } = await startHarness();
    await callTool(client, 'watchlist_add', { symbol: 'NYSE:IBM' });

    const result = await callTool(client, 'watchlist_remove', {
      symbols: ['NYSE:IBM'],
      listId: '102',
    });

    expect(errorOf(result)).toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      details: { listId: '102', symbols: ['NYSE:IBM'] },
    });
  });

  test('watchlist_remove never removes a section marker and reports what the list does not hold', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'watchlist_remove', {
      symbols: ['###Tech', 'NYSE:IBM', 'nasdaq:msft', 'NASDAQ:MSFT'],
      confirm: true,
    });

    expect(dataOf(result)).toEqual({
      listId: '101',
      removed: ['NASDAQ:MSFT'],
      notListed: ['###Tech', 'NYSE:IBM'],
    });
    expect(removed(win)).toEqual([[{ id: 101 }, ['NASDAQ:MSFT']]]);
    expect(serverSymbols(win)).toEqual(['###Tech', 'NASDAQ:AAPL', '###Crypto', 'BINANCE:BTCUSDT']);
  });

  test('watchlist_remove of symbols the list does not hold changes nothing and needs no confirm', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'watchlist_remove', { symbols: ['NYSE:IBM', '###Tech'] });

    expect(dataOf(result)).toEqual({
      listId: '101',
      removed: [],
      notListed: ['NYSE:IBM', '###Tech'],
    });
    expect(removed(win)).toEqual([]);
  });

  test('watchlist_remove relays a refusal of the server and refreshes the store', async () => {
    const win = createFakeTvWindow(fixture);
    inspectFakeWindow(win).state.watchlists.errors.removeSymbols = {
      code: 'not_found',
      message: 'Not found',
    };
    const { client } = await startHarnessWith(win);

    const result = await callTool(client, 'watchlist_remove', {
      symbols: ['NASDAQ:AAPL'],
      confirm: true,
    });

    expect(errorOf(result)).toMatchObject({
      code: 'PAGE_EVALUATION_FAILED',
      details: { code: 'not_found' },
    });
    expect(refreshedAfter(win, 'symbolListBackend.removeSymbols')).toBe(true);
  });

  test('a symbol TradingView still lists after the removal comes back as a warning, and none removed is NOT_AVAILABLE', async () => {
    const partial = createFakeTvWindow(fixture);
    const partialBackend = backendOf(partial);
    const removePartly = partialBackend.removeSymbols.bind(partialBackend);
    partialBackend.removeSymbols = (list, symbols) => removePartly(list, symbols.slice(0, 1));
    const ignoring = createFakeTvWindow(fixture);
    backendOf(ignoring).removeSymbols = () => Promise.resolve([...FIXTURE_ENTRIES]);
    const { client: partialClient } = await startHarnessWith(partial);
    const { client: ignoringClient } = await startHarnessWith(ignoring);

    const some = await callTool(partialClient, 'watchlist_remove', {
      symbols: ['NASDAQ:AAPL', 'NASDAQ:MSFT'],
      confirm: true,
    });
    const none = await callTool(ignoringClient, 'watchlist_remove', {
      symbols: ['NASDAQ:AAPL'],
      confirm: true,
    });

    expect(dataOf(some)).toEqual({ listId: '101', removed: ['NASDAQ:AAPL'], notListed: [] });
    expect(warningsOf(some)).toEqual([expect.stringContaining('NASDAQ:MSFT') as string]);
    expect(errorOf(none)).toMatchObject({
      code: 'NOT_AVAILABLE',
      hint: expect.stringContaining('watchlist_get') as string,
    });
  });

  test('a removal that neither the reloaded store nor the answer of the server shows is NOT_AVAILABLE, and the session keeps the symbols', async () => {
    const win = createFakeTvWindow(withWatchlists({ ready: true }));
    const { client, session } = await startHarnessWith(win);
    await callTool(client, 'watchlist_add', { symbol: 'NYSE:IBM' });
    const backend = backendOf(win);
    const remove = backend.removeSymbols.bind(backend);
    // The server takes the removal and answers no list.
    backend.removeSymbols = async (list, symbols) => {
      await remove(list, symbols);
      return undefined;
    };
    inspectFakeWindow(win).state.watchlists.errors.getCustomWatchLists = {
      code: null,
      message: 'Failed to fetch',
    };

    const result = await callTool(client, 'watchlist_remove', { symbols: ['NYSE:IBM'] });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      hint: expect.stringContaining('watchlist_get') as string,
      details: { listId: '101', symbols: ['NYSE:IBM'] },
    });
    expect(session.addedWatchlistSymbols.get('101')).toEqual(new Set(['NYSE:IBM']));
  });

  test('a removal whose refresh a later refresh aborts follows the answer of the server, with a warning', async () => {
    const win = createFakeTvWindow(withWatchlists({ ready: true }));
    abortRefreshesAfterChanges(win);
    const { client } = await startHarnessWith(win);

    const result = await callTool(client, 'watchlist_remove', {
      symbols: ['NASDAQ:AAPL'],
      confirm: true,
    });

    expect(dataOf(result)).toEqual({ listId: '101', removed: ['NASDAQ:AAPL'], notListed: [] });
    expect(warningsOf(result)).toEqual([expect.stringContaining('may show') as string]);
  });
});

test('the watchlist tools log no name and no symbol of a watchlist', async () => {
  const { logger, lines } = capturingLogger();
  const { client } = await startHarnessWith(createFakeTvWindow(fixture), {}, logger);

  await callTool(client, 'watchlist_list');
  await callTool(client, 'watchlist_get', { listId: '102' });
  await callTool(client, 'watchlist_add_bulk', { symbols: ['NYSE:IBM', 'NASDAQ:ZZZZ'] });
  await callTool(client, 'watchlist_add', { symbol: 'NASDAQ:ZZZZ' });
  await callTool(client, 'watchlist_remove', { symbols: ['NASDAQ:AAPL'] });
  await callTool(client, 'watchlist_get', { listId: '999' });

  const logged = JSON.stringify(lines);
  for (const value of [
    'Fixture List',
    'Second List',
    'Fixture Gainers',
    'NASDAQ:AAPL',
    'NASDAQ:MSFT',
    'BINANCE:BTCUSDT',
    'NYSE:IBM',
    'FX:EURUSD',
    'NASDAQ:ZZZZ',
    'Tech',
    'Crypto',
  ]) {
    expect(logged).not.toContain(value);
  }
});
