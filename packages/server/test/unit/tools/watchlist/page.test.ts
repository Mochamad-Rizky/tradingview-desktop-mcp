import type { CdpSession } from '../../../../src/core/cdp/types.js';
import type { TvMcpError } from '../../../../src/core/errors.js';
import {
  createPageBridge,
  type PageBridge,
  type PageLibFunction,
} from '../../../../src/core/tv/page-bridge.js';
import { createPageLib } from '../../../../src/core/tv/page-lib.js';
import type { TvWindow } from '../../../../src/core/tv/tv-window.js';
import {
  changeWatchlistViaApi,
  readWatchlist,
  readWatchlistLimits,
  readWatchlists,
} from '../../../../src/tools/watchlist/page.js';
import type { JsonValue } from '../../../../src/utils/json.js';
import { failureOf } from '../../../helpers/failure-of.js';
import { createPageRuntime } from '../../../helpers/fake-cdp/runtime.js';
import { loadTvFixture, type TvStateFixture } from '../../../helpers/fake-tv/fixture.js';
import type {
  FakeCustomListRecord,
  FakeSymbolListState,
} from '../../../helpers/fake-tv/watchlists.js';
import { createFakeWebpack } from '../../../helpers/fake-tv/webpack.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTvOverrides,
  type FakeTvWindow,
} from '../../../helpers/fake-tv/window.js';

// The page functions of the watchlist tools, run the way the server runs them, as source text in a
// page through the real page bridge, and called directly on a second window built the same way,
// which is what the coverage of the module measures. The two answers must agree. Values are
// synthetic.

const fixture = loadTvFixture();
const WAIT_MS = 2000;
// For the calls that are meant to give up.
const SHORT_WAIT_MS = 60;
const FIXTURE_ENTRIES = ['###Tech', 'NASDAQ:AAPL', 'NASDAQ:MSFT', '###Crypto', 'BINANCE:BTCUSDT'];

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
});

function bridgeTo(win: object): PageBridge {
  const runtime = createPageRuntime(win);
  disposers.push(() => {
    runtime.dispose();
  });
  const send = (method: string, params?: unknown): Promise<unknown> =>
    method === 'Runtime.evaluate'
      ? runtime.evaluate(params as Record<string, unknown>)
      : Promise.reject(new Error(`Unexpected command ${method}`));
  const session: CdpSession = {
    targetId: 'PAGE1',
    isClosed: false,
    send: send as CdpSession['send'],
    onClose: () => undefined,
    close: () => Promise.resolve(),
  };
  return createPageBridge(session, { timeoutMs: 5000 });
}

type Make = () => object;

const chart =
  (from: TvStateFixture = fixture, overrides: FakeTvOverrides = {}): Make =>
  () =>
    createFakeTvWindow(from, overrides);

// A fake chart changed by `change` after it is built.
const changed =
  (
    change: (win: FakeTvWindow) => void,
    from: TvStateFixture = fixture,
    overrides: FakeTvOverrides = {},
  ): Make =>
  () => {
    const win = createFakeTvWindow(from, overrides);
    change(win);
    return win;
  };

// A page with the webpack cache `modules` and the members of `page`.
const withModules =
  (modules: Record<string, Record<string, unknown>>, page: Record<string, unknown> = {}): Make =>
  () => ({ webpackChunktradingview: createFakeWebpack(modules), ...page });

async function libResultOf<A extends JsonValue[], R extends JsonValue | null>(
  fn: PageLibFunction<A, R>,
  args: A,
  make: Make,
): Promise<{ result: R; win: object }> {
  const win = make();
  const result = await bridgeTo(win).evaluateWithLib(fn, args);
  const other = make() as TvWindow;
  const direct = await fn(other, createPageLib(other), ...args);
  expect(direct).toEqual(result);
  return { result, win };
}

async function libFailureOfBoth<A extends JsonValue[], R extends JsonValue | null>(
  fn: PageLibFunction<A, R>,
  args: A,
  make: Make,
): Promise<{ error: TvMcpError; win: object }> {
  const win = make();
  const error = await failureOf(bridgeTo(win).evaluateWithLib(fn, args));
  const other = make() as TvWindow;
  expect(await fn(other, createPageLib(other), ...args)).toEqual({
    __tvmcpError: error.toPayload(),
  });
  return { error, win };
}

const calls = (win: object, name: string) => inspectFakeWindow(win).callsTo(name);

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
  addSymbols: (list: unknown, symbols: string[]) => Promise<unknown>;
  removeSymbols: (list: unknown, symbols: string[]) => Promise<unknown>;
}

function backendOf(win: FakeTvWindow): Backend {
  return (moduleWith(win, 'serviceOrNull').serviceOrNull as (descriptor: unknown) => Backend)(
    'SymbolListRepositoryBackend',
  );
}

const withWatchlists = (
  change: Partial<NonNullable<TvStateFixture['watchlists']>>,
): TvStateFixture => ({
  ...fixture,
  watchlists: { ...(fixture.watchlists ?? { lists: [], active: null }), ...change },
});
const READY = withWatchlists({ ready: true });

// Changes the state of the store of a fake window, as the app may hold it.
const restaged =
  (change: (state: FakeSymbolListState) => Record<string, unknown>) =>
  (win: FakeTvWindow): void => {
    const { watchlists } = inspectFakeWindow(win).state;
    watchlists.store = change(watchlists.store) as unknown as FakeSymbolListState;
  };

// The record of the list 101 in a state, changed by `change`, which may give it fields of any type.
function list101(state: FakeSymbolListState, change: Record<string, unknown>): unknown {
  const base: FakeCustomListRecord | undefined = state.customLists.lists.byId['101'];
  if (base === undefined) {
    throw new Error('The store holds no list 101');
  }
  return { ...base, ...change };
}

const SUMMARIES = [
  {
    id: '101',
    kind: 'custom',
    name: 'Fixture List',
    symbolCount: 3,
    active: true,
    editable: true,
  },
  {
    id: '102',
    kind: 'custom',
    name: 'Second List',
    symbolCount: 2,
    active: false,
    editable: true,
  },
  { id: 'red', kind: 'flag', name: 'Red list', symbolCount: 1, active: false, editable: false },
  {
    id: '###HOT###US.gainers',
    kind: 'hot',
    name: 'Fixture Gainers',
    symbolCount: 2,
    active: false,
    editable: false,
  },
];

// Pages on which the symbol list service cannot be reached: not set up, no locator at all, a service
// without a store, and a locator that throws.
const UNREACHABLE: Make[] = [
  chart(fixture, { watchlists: { withoutService: true } }),
  withModules({}),
  withModules({
    1: { hasService: () => true, service: () => ({}), serviceOrNull: () => ({}) },
    2: { SYMBOL_LIST_SERVICE: 'SymbolListService' },
  }),
  withModules({
    1: {
      hasService: () => true,
      service: () => null,
      serviceOrNull: () => {
        throw new Error('Locked');
      },
    },
    2: { SYMBOL_LIST_SERVICE: 'SymbolListService' },
  }),
];

// What a selector of a fake window throws, in the three forms a throw can take.
const THROWN: [unknown, string][] = [
  [new Error('Value is null'), 'Value is null'],
  ['Broken', 'Broken'],
  [7, '7'],
];

describe('readWatchlists', () => {
  test('lists the custom, flag and hot lists, loading the custom ones first when TradingView has only the active one', async () => {
    const { result, win } = await libResultOf(readWatchlists, [WAIT_MS], chart());

    expect(result).toEqual({ ready: true, lists: SUMMARIES });
    expect(calls(win, 'getCustomWatchlistsThunk')).toEqual([[null]]);
    expect(calls(win, 'symbolListStore.dispatch')).toEqual([['custom-lists/setup']]);
  });

  test('reads without loading anything when TradingView has every list', async () => {
    const { result, win } = await libResultOf(readWatchlists, [WAIT_MS], chart(READY));

    expect(result).toEqual({ ready: true, lists: SUMMARIES });
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('is not ready when the lists cannot be loaded: refused, late, without the refresh thunk, or with one that throws', async () => {
    const loadingOnly = SUMMARIES.filter(({ id }) => id !== '102');
    for (const make of [
      changed((win) => {
        inspectFakeWindow(win).state.watchlists.errors.getCustomWatchLists = {
          code: null,
          message: 'Failed to fetch',
        };
      }),
      changed((win) => {
        moduleWith(win, 'getCustomWatchlistsThunk').getCustomWatchlistsThunk = () => () =>
          new Promise(() => undefined);
      }),
      chart(fixture, { watchlists: { withoutRefreshThunk: true } }),
      changed((win) => {
        moduleWith(win, 'getCustomWatchlistsThunk').getCustomWatchlistsThunk = () => {
          throw new Error('No thunk');
        };
      }),
    ]) {
      const { result } = await libResultOf(readWatchlists, [SHORT_WAIT_MS], make);

      expect(result).toEqual({ ready: false, lists: loadingOnly });
    }
  });

  test('is NOT_AVAILABLE, with the hint to open the watchlist, while the symbol list service is not set up', async () => {
    for (const make of UNREACHABLE) {
      const { error } = await libFailureOfBoth(readWatchlists, [WAIT_MS], make);

      expect(error.toPayload()).toEqual({
        code: 'NOT_AVAILABLE',
        message: 'TradingView has not set up its watchlists in this tab yet',
        hint: expect.stringMatching(/ui_open_panel \(panel: 'watchlist'\)/) as string,
      });
    }
  });

  test('is NOT_AVAILABLE without the selectors of the app, or when one throws', async () => {
    const { error: missing } = await libFailureOfBoth(
      readWatchlists,
      [WAIT_MS],
      chart(fixture, { watchlists: { withoutSelectors: true } }),
    );
    expect(missing.toPayload()).toMatchObject({ code: 'NOT_AVAILABLE' });
    for (const [thrown, said] of THROWN) {
      const { error: throwing } = await libFailureOfBoth(
        readWatchlists,
        [WAIT_MS],
        changed((win) => {
          moduleWith(win, 'getCustomLists').getCustomLists = () => {
            throw thrown;
          };
        }, READY),
      );

      expect(throwing.toPayload()).toMatchObject({
        code: 'NOT_AVAILABLE',
        message: `TradingView could not read its watchlists: ${said}`,
      });
    }
  });

  test('passes over custom lists that are no lists, marks an active hot list, and names no flag list without a title function', async () => {
    const { result } = await libResultOf(
      readWatchlists,
      [WAIT_MS],
      changed(
        (win) => {
          const selectors = moduleWith(win, 'getCustomLists');
          const lists = selectors.getCustomLists as (state: unknown) => unknown[];
          selectors.getCustomLists = (state: unknown) => [null, 5, ...lists(state)];
          delete moduleWith(win, 'getColoredListTitle').getColoredListTitle;
        },
        withWatchlists({ ready: true, active: { type: 'hot', id: '###HOT###US.gainers' } }),
      ),
    );

    expect(result).toEqual({
      ready: true,
      lists: [
        { ...SUMMARIES[0], active: false },
        SUMMARIES[1],
        { ...SUMMARIES[2], name: null },
        { ...SUMMARIES[3], active: true },
      ],
    });
  });

  test('reads no custom list from an answer that is no list, and is not ready when TradingView cannot say', async () => {
    const { result, win } = await libResultOf(
      readWatchlists,
      [WAIT_MS],
      changed((win) => {
        const selectors = moduleWith(win, 'getCustomLists');
        selectors.getCustomLists = () => 'lists';
        selectors.getIsReadyCustomLists = () => {
          throw new Error('Not ready');
        };
      }, READY),
    );

    expect(result).toEqual({ ready: false, lists: SUMMARIES.slice(2) });
    // Not knowing whether the lists are there, it loaded them.
    expect(calls(win, 'getCustomWatchlistsThunk')).toEqual([[null]]);
  });

  test('reads odd records field by field', async () => {
    const { result } = await libResultOf(
      readWatchlists,
      [WAIT_MS],
      changed(
        restaged((state) => ({
          ...state,
          customLists: {
            ...state.customLists,
            lists: {
              ids: [101, 7, 8, 9],
              byId: {
                ...state.customLists.lists.byId,
                7: list101(state, { id: 7, name: 42, symbols: 'x' }),
                8: list101(state, { id: { x: 1 } }),
                9: list101(state, { id: 0, symbols: ['NYSE:IBM', 5] }),
              },
            },
          },
          markedLists: {
            ...state.markedLists,
            lists: {
              ...state.markedLists.lists,
              byColor: {
                red: { ...state.markedLists.lists.byColor.red, name: 'Watching' },
                blue: null,
                orange: { color: 'orange', name: null, symbols: [] },
              },
            },
          },
          hotLists: { lists: { bad: 3 } },
          activeSymbolList: null,
        })),
        READY,
      ),
    );

    expect(result).toEqual({
      ready: true,
      lists: [
        {
          id: '101',
          kind: 'custom',
          name: 'Fixture List',
          symbolCount: 3,
          active: false,
          editable: true,
        },
        { id: '7', kind: 'custom', name: null, symbolCount: 0, active: false, editable: true },
        // Listed under 9, with the id 0, which no list saved on the account has.
        {
          id: '0',
          kind: 'custom',
          name: 'Fixture List',
          symbolCount: 1,
          active: false,
          editable: false,
        },
        {
          id: 'red',
          kind: 'flag',
          name: 'Watching',
          symbolCount: 1,
          active: false,
          editable: false,
        },
        {
          id: 'orange',
          kind: 'flag',
          name: 'Orange list',
          symbolCount: 0,
          active: false,
          editable: false,
        },
      ],
    });
  });

  test('gives a flag list no name when TradingView has none for it, and reads a state without flag or hot lists', async () => {
    const activeFlag = withWatchlists({ ready: true, active: { type: 'color', id: 'red' } });
    const untitled = (win: FakeTvWindow): void => {
      moduleWith(win, 'getColoredListTitle').getColoredListTitle = () => {
        throw new Error('No title');
      };
    };
    const { result: bare } = await libResultOf(
      readWatchlists,
      [WAIT_MS],
      changed((win) => {
        untitled(win);
        restaged((state) => ({ ...state, markedLists: undefined, hotLists: undefined }))(win);
      }, activeFlag),
    );
    const { result: unnamed } = await libResultOf(
      readWatchlists,
      [WAIT_MS],
      changed(untitled, activeFlag),
    );

    expect(bare).toEqual({
      ready: true,
      lists: SUMMARIES.slice(0, 2).map((list) => ({ ...list, active: false })),
    });
    expect(unnamed).toMatchObject({
      lists: expect.arrayContaining([
        { id: 'red', kind: 'flag', name: null, symbolCount: 1, active: true, editable: false },
      ]) as unknown[],
    });
  });
});

describe('readWatchlist', () => {
  test('reads the active list, whatever its kind', async () => {
    const { result: custom } = await libResultOf(readWatchlist, [null, WAIT_MS, false], chart());
    const { result: flag } = await libResultOf(
      readWatchlist,
      [null, WAIT_MS, false],
      chart(withWatchlists({ ready: true, active: { type: 'color', id: 'red' } })),
    );
    const { result: hot } = await libResultOf(
      readWatchlist,
      [null, WAIT_MS, false],
      chart(withWatchlists({ ready: true, active: { type: 'hot', id: '###HOT###US.gainers' } })),
    );

    expect(custom).toEqual({
      ready: true,
      refreshed: true,
      signedIn: true,
      list: {
        id: '101',
        kind: 'custom',
        name: 'Fixture List',
        entries: FIXTURE_ENTRIES,
        active: true,
        editable: true,
      },
    });
    expect(flag).toMatchObject({
      refreshed: null,
      list: {
        id: 'red',
        kind: 'flag',
        name: 'Red list',
        entries: ['NASDAQ:NVDA'],
        active: true,
        editable: false,
      },
    });
    expect(hot).toMatchObject({
      list: {
        id: '###HOT###US.gainers',
        kind: 'hot',
        name: 'Fixture Gainers',
        active: true,
        editable: false,
      },
    });
  });

  test('reads a list by its id: a custom list by number or by text, a flag list by its color, a hot list by its id', async () => {
    const local = withWatchlists({
      ready: true,
      lists: [
        ...(fixture.watchlists?.lists ?? []),
        { id: 'deleted_symbols_list_id', name: 'Recently deleted', symbols: ['NYSE:IBM'] },
      ],
    });
    const read = async (listId: string) =>
      (await libResultOf(readWatchlist, [listId, WAIT_MS, false], chart(local))).result;

    expect(await read('102')).toMatchObject({
      list: { id: '102', kind: 'custom', editable: true, active: false },
    });
    expect(await read('deleted_symbols_list_id')).toMatchObject({
      list: {
        id: 'deleted_symbols_list_id',
        kind: 'custom',
        name: 'Recently deleted',
        editable: false,
      },
    });
    expect(await read('red')).toMatchObject({ list: { id: 'red', kind: 'flag', active: false } });
    expect(await read('###HOT###US.gainers')).toMatchObject({
      list: { kind: 'hot', active: false },
    });
  });

  test('answers no list for an id it does not know, an inherited name included', async () => {
    for (const listId of ['999', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const { result } = await libResultOf(readWatchlist, [listId, WAIT_MS, false], chart(READY));

      expect(result, listId).toEqual({ ready: true, refreshed: null, signedIn: true, list: null });
    }
  });

  test('refreshes when told to, or when TradingView has only the active list, and says whether that worked', async () => {
    const forced = await libResultOf(readWatchlist, ['101', WAIT_MS, true], chart(READY));
    const failed = await libResultOf(
      readWatchlist,
      ['101', WAIT_MS, true],
      changed((win) => {
        inspectFakeWindow(win).state.watchlists.errors.getCustomWatchLists = {
          code: 'maintenance',
          message: 'Maintenance',
        };
      }, READY),
    );
    const missing = await libResultOf(
      readWatchlist,
      ['101', WAIT_MS, true],
      chart(READY, { watchlists: { withoutRefreshThunk: true } }),
    );

    expect(forced.result).toMatchObject({ ready: true, refreshed: true });
    expect(calls(forced.win, 'getCustomWatchlistsThunk')).toEqual([[null]]);
    expect(failed.result).toMatchObject({ ready: true, refreshed: false, list: { id: '101' } });
    expect(missing.result).toMatchObject({ ready: true, refreshed: false });
  });

  test('tells whether an account is signed in', async () => {
    const { result } = await libResultOf(
      readWatchlist,
      [null, WAIT_MS, false],
      changed((win) => {
        inspectFakeWindow(win).state.pineEditor.signedIn = false;
      }, READY),
    );

    expect(result).toMatchObject({ signedIn: false, list: { id: '101' } });
  });

  test('answers no list for an active list of a kind it does not know', async () => {
    for (const active of [{ type: 'other', id: 1 }, 7, null]) {
      const { result } = await libResultOf(
        readWatchlist,
        [null, WAIT_MS, false],
        changed((win) => {
          moduleWith(win, 'getGlobalActiveSymbolList').getGlobalActiveSymbolList = () => active;
        }, READY),
      );

      expect(result, JSON.stringify(active)).toMatchObject({ list: null });
    }
  });

  test('is NOT_AVAILABLE while the symbol list service is not set up, without the selectors, or when one throws', async () => {
    for (const make of [
      ...UNREACHABLE,
      chart(fixture, { watchlists: { withoutSelectors: true } }),
    ]) {
      const { error } = await libFailureOfBoth(readWatchlist, ['101', WAIT_MS, false], make);

      expect(error.code).toBe('NOT_AVAILABLE');
    }
    for (const [thrown, said] of THROWN) {
      const { error } = await libFailureOfBoth(
        readWatchlist,
        ['101', WAIT_MS, false],
        changed((win) => {
          moduleWith(win, 'getCustomListById').getCustomListById = () => {
            throw thrown;
          };
        }, READY),
      );

      expect(error.message).toBe(`TradingView could not read its watchlists: ${said}`);
    }
  });

  test('says the refresh did not work when the refresh thunk throws or is late, and loads the lists when TradingView cannot say whether it has them', async () => {
    const throwing = await libResultOf(
      readWatchlist,
      ['101', WAIT_MS, true],
      changed((win) => {
        moduleWith(win, 'getCustomWatchlistsThunk').getCustomWatchlistsThunk = () => {
          throw new Error('No thunk');
        };
      }, READY),
    );
    const late = await libResultOf(
      readWatchlist,
      ['101', SHORT_WAIT_MS, true],
      changed((win) => {
        moduleWith(win, 'getCustomWatchlistsThunk').getCustomWatchlistsThunk = () => () =>
          new Promise(() => undefined);
      }, READY),
    );
    const unsure = await libResultOf(
      readWatchlist,
      ['101', WAIT_MS, false],
      changed((win) => {
        moduleWith(win, 'getIsReadyCustomLists').getIsReadyCustomLists = () => {
          throw new Error('Not ready');
        };
      }, READY),
    );

    expect(throwing.result).toMatchObject({ refreshed: false, list: { id: '101' } });
    expect(late.result).toMatchObject({ refreshed: false, list: { id: '101' } });
    expect(unsure.result).toMatchObject({ ready: false, refreshed: true, list: { id: '101' } });
  });

  test('reads odd answers of the app field by field, and finds no list where the app holds none', async () => {
    const read = async (listId: string, change: (win: FakeTvWindow) => void) =>
      (await libResultOf(readWatchlist, [listId, WAIT_MS, false], changed(change, READY))).result;

    expect(
      await read('101', (win) => {
        moduleWith(win, 'getCustomListById').getCustomListById = () => ({
          id: 101,
          name: 'Odd',
          symbols: 'none',
        });
      }),
    ).toMatchObject({ list: { id: '101', name: 'Odd', entries: [] } });
    expect(
      await read('101', (win) => {
        moduleWith(win, 'getCustomListById').getCustomListById = () => ({ id: null });
      }),
    ).toMatchObject({ list: null });
    expect(
      await read('deleted_symbols_list_id', (win) => {
        moduleWith(win, 'getCustomLists').getCustomLists = () => 'lists';
      }),
    ).toMatchObject({ list: null });
    expect(
      await read(
        'red',
        restaged((state) => ({
          ...state,
          markedLists: {
            ...state.markedLists,
            lists: { ...state.markedLists.lists, byColor: { red: null } },
          },
        })),
      ),
    ).toMatchObject({ list: null });
    expect(
      await read(
        '###HOT###US.gainers',
        restaged((state) => ({ ...state, hotLists: { lists: { '###HOT###US.gainers': null } } })),
      ),
    ).toMatchObject({ list: null });
    for (const untitled of [
      (win: FakeTvWindow) => {
        delete moduleWith(win, 'getColoredListTitle').getColoredListTitle;
      },
      (win: FakeTvWindow) => {
        moduleWith(win, 'getColoredListTitle').getColoredListTitle = () => {
          throw new Error('No title');
        };
      },
    ]) {
      expect(await read('red', untitled)).toMatchObject({ list: { id: 'red', name: null } });
    }
  });
});

describe('readWatchlistLimits', () => {
  test('reads the limit and the maximum the app checks when it adds to a watchlist', async () => {
    const { result: off } = await libResultOf(readWatchlistLimits, [], chart());
    const { result: on } = await libResultOf(
      readWatchlistLimits,
      [],
      chart({
        ...fixture,
        featureToggles: { ...fixture.featureToggles, watchlist_symbols_tiered_limits: true },
      }),
    );

    expect(off).toEqual({ limit: 1000, max: 1000 });
    expect(on).toEqual({ limit: 30, max: 1000 });
  });

  test('answers null for what cannot be read', async () => {
    const { result: missing } = await libResultOf(
      readWatchlistLimits,
      [],
      chart(fixture, { watchlists: { withoutLimits: true } }),
    );
    expect(missing).toEqual({ limit: null, max: null });
    for (const limit of [
      () => 0,
      () => -5,
      () => Number.NaN,
      () => '30',
      () => {
        throw new Error('Not ready');
      },
    ]) {
      const { result } = await libResultOf(
        readWatchlistLimits,
        [],
        changed((win) => {
          const limits = moduleWith(win, 'getWatchlistSymbolsLimit');
          limits.getWatchlistSymbolsLimit = limit;
          limits.MAX_WATCHLIST_LENGTH = Number.POSITIVE_INFINITY;
        }),
      );

      expect(result).toEqual({ limit: null, max: null });
    }
  });
});

describe('changeWatchlistViaApi', () => {
  test('adds and removes with the backend of the app, and answers what the server answered', async () => {
    const add = await libResultOf(
      changeWatchlistViaApi,
      ['add', 101, ['NYSE:IBM'], WAIT_MS],
      chart(),
    );
    const remove = await libResultOf(
      changeWatchlistViaApi,
      ['remove', 101, ['NASDAQ:AAPL'], WAIT_MS],
      chart(),
    );

    expect(add.result).toEqual({ sent: true, symbols: [...FIXTURE_ENTRIES, 'NYSE:IBM'] });
    expect(calls(add.win, 'symbolListBackend.addSymbols')).toEqual([[{ id: 101 }, ['NYSE:IBM']]]);
    expect(remove.result).toEqual({
      sent: true,
      symbols: ['###Tech', 'NASDAQ:MSFT', '###Crypto', 'BINANCE:BTCUSDT'],
    });
    expect(calls(remove.win, 'symbolListBackend.removeSymbols')).toEqual([
      [{ id: 101 }, ['NASDAQ:AAPL']],
    ]);
    // The store is left alone: the caller refreshes it.
    expect(calls(add.win, 'symbolListStore.dispatch')).toEqual([]);
  });

  test('answers no symbols when the server answers no list of symbols', async () => {
    const { result } = await libResultOf(
      changeWatchlistViaApi,
      ['add', 101, ['NYSE:IBM'], WAIT_MS],
      changed((win) => {
        backendOf(win).addSymbols = () => Promise.resolve(undefined);
      }),
    );

    expect(result).toEqual({ sent: true, symbols: null });
  });

  test('relays a refusal of the server with its code, in every shape a refusal comes in', async () => {
    const refusedWith = async (stage: (win: FakeTvWindow) => void) =>
      (
        await libResultOf(
          changeWatchlistViaApi,
          ['add', 101, ['NYSE:IBM'], WAIT_MS],
          changed(stage),
        )
      ).result;

    expect(
      await refusedWith((win) => {
        inspectFakeWindow(win).state.watchlists.errors.addSymbols = {
          code: 'plan_symbols_limit_reached',
          message: 'Too many',
        };
      }),
    ).toEqual({ refused: { code: 'plan_symbols_limit_reached', message: 'Too many' } });
    expect(
      await refusedWith((win) => {
        inspectFakeWindow(win).state.watchlists.errors.addSymbols = {
          code: null,
          message: 'Failed to fetch',
        };
      }),
    ).toEqual({ refused: { code: null, message: 'Failed to fetch' } });
    expect(
      await refusedWith((win) => {
        backendOf(win).addSymbols = () => {
          throw new Error('Synchronous');
        };
      }),
    ).toEqual({ refused: { code: null, message: 'Synchronous' } });
    expect(
      await refusedWith((win) => {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        backendOf(win).addSymbols = () => Promise.reject('plain text');
      }),
    ).toEqual({ refused: { code: null, message: 'plain text' } });
    expect(
      await refusedWith((win) => {
        backendOf(win).addSymbols = () => {
          const error = new Error('Empty code');
          error.name = 'ApiError:';
          return Promise.reject(error);
        };
      }),
    ).toEqual({ refused: { code: null, message: 'Empty code' } });
    expect(
      await refusedWith((win) => {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        backendOf(win).addSymbols = () => Promise.reject({ name: 7 });
      }),
    ).toEqual({ refused: { code: null, message: '[object Object]' } });
  });

  test('is TIMEOUT when the server does not answer within waitMs', async () => {
    const never = changed((win) => {
      const backend = backendOf(win);
      backend.addSymbols = () => new Promise(() => undefined);
      backend.removeSymbols = () => new Promise(() => undefined);
    });
    const { error: adding } = await libFailureOfBoth(
      changeWatchlistViaApi,
      ['add', 101, ['NYSE:IBM'], SHORT_WAIT_MS],
      never,
    );
    const { error: removing } = await libFailureOfBoth(
      changeWatchlistViaApi,
      ['remove', 101, ['NASDAQ:AAPL'], SHORT_WAIT_MS],
      never,
    );

    expect(adding.toPayload()).toEqual({
      code: 'TIMEOUT',
      message: `TradingView did not answer the change of the watchlist within ${String(SHORT_WAIT_MS)} ms`,
      hint: expect.stringMatching(/watchlist_get.*confirm: true/s) as string,
      details: { waitMs: SHORT_WAIT_MS },
    });
    expect(removing.toPayload()).toMatchObject({
      code: 'TIMEOUT',
      hint: expect.stringContaining('watchlist_get') as string,
    });
  });

  test('refuses before it sends anything: without the backend, while signed out, and while the list has open sections to save', async () => {
    const { error: noBackend } = await libFailureOfBoth(
      changeWatchlistViaApi,
      ['add', 101, ['NYSE:IBM'], WAIT_MS],
      chart(fixture, { watchlists: { withoutBackend: true } }),
    );
    const signedOut = await libFailureOfBoth(
      changeWatchlistViaApi,
      ['add', 101, ['NYSE:IBM'], WAIT_MS],
      changed((win) => {
        inspectFakeWindow(win).state.pineEditor.signedIn = false;
      }),
    );
    const pending = await libFailureOfBoth(
      changeWatchlistViaApi,
      ['remove', 101, ['NASDAQ:AAPL'], WAIT_MS],
      changed((win) => {
        inspectFakeWindow(win).state.watchlists.pendingOpenSeparators.add('101');
      }),
    );

    expect(noBackend.toPayload()).toMatchObject({
      code: 'NOT_AVAILABLE',
      hint: expect.stringContaining('ui_open_panel') as string,
    });
    expect(signedOut.error.toPayload()).toEqual({
      code: 'AUTH_REQUIRED',
      message: 'Editing a watchlist needs a signed-in TradingView account',
      hint: 'Sign in to TradingView, then try again.',
    });
    expect(pending.error.toPayload()).toMatchObject({ code: 'NOT_AVAILABLE' });
    for (const win of [signedOut.win, pending.win]) {
      expect(calls(win, 'symbolListBackend.addSymbols')).toEqual([]);
      expect(calls(win, 'symbolListBackend.removeSymbols')).toEqual([]);
    }
  });

  test('is NOT_AVAILABLE when the backend cannot be reached', async () => {
    for (const make of [
      withModules(
        {
          1: { hasService: () => true, service: () => ({}) },
          2: { SYMBOL_LIST_REPOSITORY_BACKEND_SERVICE: 'SymbolListRepositoryBackend' },
        },
        { is_authenticated: true },
      ),
      withModules(
        {
          1: {
            hasService: () => true,
            service: () => null,
            serviceOrNull: () => {
              throw new Error('Locked');
            },
          },
          2: { SYMBOL_LIST_REPOSITORY_BACKEND_SERVICE: 'SymbolListRepositoryBackend' },
        },
        { is_authenticated: true },
      ),
    ]) {
      const { error } = await libFailureOfBoth(
        changeWatchlistViaApi,
        ['add', 101, ['NYSE:IBM'], WAIT_MS],
        make,
      );

      expect(error.code).toBe('NOT_AVAILABLE');
    }
  });

  test('changes the list when the set of open sections cannot be asked', async () => {
    const { result } = await libResultOf(
      changeWatchlistViaApi,
      ['add', 101, ['NYSE:IBM'], WAIT_MS],
      changed((win) => {
        const module = moduleWith(win, 'pendingOpenSeparators');
        Object.defineProperty(module, 'pendingOpenSeparators', {
          value: {
            has: () => {
              throw new Error('Not a set');
            },
          },
        });
      }),
    );

    expect(result).toEqual({ sent: true, symbols: [...FIXTURE_ENTRIES, 'NYSE:IBM'] });
  });

  test('changes the list when the set of open sections cannot be found', async () => {
    const { result } = await libResultOf(
      changeWatchlistViaApi,
      ['add', 101, ['NYSE:IBM'], WAIT_MS],
      changed((win) => {
        const module = moduleWith(win, 'pendingOpenSeparators');
        delete module.pendingOpenSeparators;
      }),
    );

    expect(result).toEqual({ sent: true, symbols: [...FIXTURE_ENTRIES, 'NYSE:IBM'] });
  });
});
