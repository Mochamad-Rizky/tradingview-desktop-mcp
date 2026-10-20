import type { CdpSession } from '../../../../src/core/cdp/types.js';
import type { TvMcpError } from '../../../../src/core/errors.js';
import {
  createPageBridge,
  type PageBridge,
  type PageFunction,
  type PageLibFunction,
} from '../../../../src/core/tv/page-bridge.js';
import { createPageLib } from '../../../../src/core/tv/page-lib.js';
import type { TvWindow } from '../../../../src/core/tv/tv-window.js';
import {
  readStudies,
  readStudyCatalog,
  readStudyValues,
} from '../../../../src/tools/indicator/page.js';
import type { JsonValue } from '../../../../src/utils/json.js';
import { failureOf } from '../../../helpers/failure-of.js';
import { createPageRuntime } from '../../../helpers/fake-cdp/runtime.js';
import { loadTvFixture, type TvStateFixture } from '../../../helpers/fake-tv/fixture.js';
import { syntheticBars } from '../../../helpers/fake-tv/synthetic-bars.js';
import { createFakeWebpack } from '../../../helpers/fake-tv/webpack.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTvOverrides,
} from '../../../helpers/fake-tv/window.js';

// The page functions of the indicator tools, run the way the server runs them, as source text in a
// page through the real page bridge, and called directly on a second window built the same way,
// which is what the coverage of the module measures. The two answers must agree. Values are
// synthetic.

const fixture = loadTvFixture();
const bars = syntheticBars(fixture.bars);

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

const plain =
  (win: object): Make =>
  () =>
    win;

async function resultOf<A extends JsonValue[], R extends JsonValue | null>(
  fn: PageFunction<A, R>,
  args: A,
  make: Make,
): Promise<{ result: R; win: object }> {
  const win = make();
  const result = await bridgeTo(win).evaluate(fn, args);
  const direct = await fn(make() as TvWindow, ...args);
  expect(direct).toEqual(result);
  return { result, win };
}

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

async function failureOfBoth<A extends JsonValue[], R extends JsonValue | null>(
  fn: PageFunction<A, R>,
  args: A,
  make: Make,
): Promise<{ error: TvMcpError; win: object }> {
  const win = make();
  const error = await failureOf(bridgeTo(win).evaluate(fn, args));
  const direct = await fn(make() as TvWindow, ...args);
  expect(direct).toEqual({ __tvmcpError: error.toPayload() });
  return { error, win };
}

async function libFailureOfBoth<A extends JsonValue[], R extends JsonValue | null>(
  fn: PageLibFunction<A, R>,
  args: A,
  make: Make,
): Promise<TvMcpError> {
  const error = await failureOf(bridgeTo(make()).evaluateWithLib(fn, args));
  const other = make() as TvWindow;
  expect(await fn(other, createPageLib(other), ...args)).toEqual({
    __tvmcpError: error.toPayload(),
  });
  return error;
}

// A page whose active chart is made of `members`, and nothing else of the app.
function withChart(members: object): Make {
  return plain({ TradingViewApi: { activeChart: () => members } });
}

// A chart with one study, id S1, made of `api`.
function withStudy(api: object, name = 'Study'): Make {
  return withChart({
    getAllStudies: () => [{ id: 'S1', name }],
    getStudyById: (id: string) => {
      if (id !== 'S1') {
        throw new Error('There is no such study');
      }
      return api;
    },
  });
}

// A plot list over `items`, sorted by index, with search done the way the app does it.
function plotListOf(items: { index: number; value: unknown[] }[]) {
  const search = (index: number, mode = 0) => {
    const found =
      mode < 0
        ? items.findLast((item) => item.index <= index)
        : mode > 0
          ? items.find((item) => item.index >= index)
          : items.find((item) => item.index === index);
    return found ?? null;
  };
  return {
    firstPlottableIndex: () => items.find((item) => item.index > -1_000_000)?.index ?? null,
    lastIndex: () => items.at(-1)?.index ?? null,
    valueAt: (index: number) => search(index)?.value ?? null,
    search,
    rangeIterator: (from: number, to: number) =>
      items.filter((item) => item.index >= from && item.index <= to)[Symbol.iterator](),
  };
}

// A study API whose core has `metaInfo` and the rows `items`.
function studyWith(metaInfo: object, items: { index: number; value: unknown[] }[]) {
  return { study: () => ({ metaInfo: () => metaInfo, data: () => plotListOf(items) }) };
}

const NO_CHART: [string, Make][] = [
  ['a page without TradingViewApi', plain({})],
  ['a page whose app has not booted', chart(fixture, { withoutApi: true })],
  [
    'a page whose activeChart throws',
    plain({
      TradingViewApi: {
        activeChart: () => {
          throw new Error('No chart is active');
        },
      },
    }),
  ],
  ['a chart without getAllStudies', withChart({ getStudyById: () => ({}) })],
];

describe('readStudies', () => {
  test('reads each study with its title, visibility, kind and the inputs the user sees', async () => {
    const { result, win } = await resultOf(readStudies, [null], chart());

    expect(result).toStrictEqual({
      studies: [
        {
          id: 'STUDY01',
          name: 'Moving Average',
          title: 'MA 9 close',
          visible: true,
          isPine: true,
          isStrategy: false,
          inputs: [
            { id: 'in_0', name: 'Length', type: 'integer', value: 9, options: null },
            { id: 'in_1', name: 'Source', type: 'source', value: 'close', options: null },
            { id: 'in_2', name: 'Offset', type: 'integer', value: 0, options: null },
          ],
        },
        {
          id: 'STUDY02',
          name: 'Relative Strength Index',
          title: 'RSI 14 close',
          visible: false,
          isPine: true,
          isStrategy: false,
          inputs: [
            { id: 'in_0', name: 'RSI Length', type: 'integer', value: 14, options: null },
            { id: 'in_1', name: 'Source', type: 'source', value: 'close', options: null },
            {
              id: 'in_2',
              name: 'Type',
              type: 'text',
              value: 'SMA',
              options: ['None', 'SMA', 'EMA'],
            },
          ],
        },
      ],
      unreadable: [],
    });
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('tells a built-in from Pine, and a strategy by its flag', async () => {
    const custom: TvStateFixture = {
      ...fixture,
      studies: [
        { id: 'S1', name: 'Volume', plots: ['plot_0'] },
        {
          id: 'S2',
          name: 'RSI Strategy',
          plots: [],
          strategy: true,
          pine: { scriptIdPart: 'STD;RSI%1Strategy', version: '12.0' },
        },
      ],
    };

    const { result } = await resultOf(readStudies, [0], chart(custom));

    expect(result).toMatchObject({
      studies: [
        { id: 'S1', title: 'Volume', isPine: false, isStrategy: false, inputs: [] },
        { id: 'S2', isPine: true, isStrategy: true },
      ],
    });
  });

  test('takes a strategy by the duck test of the app when the flag is missing', async () => {
    const core = {
      metaInfo: () => ({}),
      strategyOrdersPaneView: () => null,
      ordersData: () => null,
      reportData: () => null,
    };

    const { result } = await resultOf(
      readStudies,
      [null],
      withStudy({ title: () => 'S', isVisible: () => true, study: () => core }),
    );

    expect(result).toMatchObject({ studies: [{ isStrategy: true, isPine: false }] });
  });

  test('joins values to inputs by id, copies only text, numbers and booleans, and keeps options that are lists of text', async () => {
    const api = {
      title: () => 7,
      isVisible: () => 'yes',
      getInputsInfo: () => [
        { id: 'a', name: 'A', type: 'float', options: ['x', 1] },
        { id: 'b', localizedName: 'B', type: 'bool' },
        { id: 'c', name: 'C', type: 'color', options: ['red', 'blue'] },
        { id: 'd', name: 'D', type: 'source' },
        { id: 'h', name: 'H', type: 'text', isHidden: true },
        { name: 'no id' },
        null,
      ],
      getInputValues: () => [
        { id: 'b', value: true },
        { id: 'a', value: Number.NaN },
        { id: 'c', value: '#ff0000' },
        { id: 'd', value: { nested: true } },
        { id: 'h', value: 'secret' },
      ],
      study: () => ({ metaInfo: () => ({ pine: { version: '1.0' } }) }),
    };

    const { result } = await resultOf(readStudies, [null], withStudy(api, 'Custom'));

    expect(result).toStrictEqual({
      studies: [
        {
          id: 'S1',
          name: 'Custom',
          title: 'Custom',
          visible: false,
          isPine: true,
          isStrategy: false,
          inputs: [
            { id: 'a', name: 'A', type: 'float', value: null, options: null },
            { id: 'b', name: 'B', type: 'bool', value: true, options: null },
            { id: 'c', name: 'C', type: 'color', value: '#ff0000', options: ['red', 'blue'] },
            { id: 'd', name: 'D', type: 'source', value: null, options: null },
          ],
        },
      ],
      unreadable: [],
    });
  });

  test('reports a study it cannot read by its name, and lists it as unreadable', async () => {
    const make = withChart({
      getAllStudies: () => [
        { id: 'S1', name: 'Broken' },
        { id: 'S2', name: 'Inputs throw' },
      ],
      getStudyById: (id: string) => {
        if (id === 'S1') {
          throw new Error('There is no such study');
        }
        return {
          title: () => 'T',
          isVisible: () => true,
          getInputsInfo: () => {
            throw new Error('boom');
          },
          study: () => {
            throw new Error('boom');
          },
        };
      },
    });

    const { result } = await resultOf(readStudies, [null], make);

    expect(result).toStrictEqual({
      studies: [
        {
          id: 'S1',
          name: 'Broken',
          title: 'Broken',
          visible: true,
          isPine: false,
          isStrategy: false,
          inputs: [],
        },
        {
          id: 'S2',
          name: 'Inputs throw',
          title: 'T',
          visible: true,
          isPine: false,
          isStrategy: false,
          inputs: [],
        },
      ],
      unreadable: ['S1'],
    });
  });

  test('names studies and inputs by what they have, and passes over values without an id', async () => {
    const api = {
      title: () => null,
      isVisible: () => true,
      getInputsInfo: () => [{ id: 'x' }],
      getInputValues: () => [null, { id: 3, value: 1 }, { id: 'x', value: 2 }],
      study: () => ({ metaInfo: () => null }),
    };
    const make = withChart({
      getAllStudies: () => [null, { id: 5 }, { id: 'S1' }],
      getStudyById: (id: string) => {
        if (id !== 'S1') {
          throw new Error('There is no such study');
        }
        return api;
      },
    });

    const { result } = await resultOf(readStudies, [null], make);

    expect(result).toMatchObject({
      studies: [
        { id: '', name: '' },
        { id: '5', name: '5' },
        {
          id: 'S1',
          name: 'S1',
          title: 'S1',
          isPine: false,
          inputs: [{ id: 'x', name: 'x', type: '', value: 2, options: null }],
        },
      ],
      unreadable: ['', '5'],
    });
  });

  test('reads no studies from a chart whose list is not a list', async () => {
    const { result } = await resultOf(
      readStudies,
      [null],
      withChart({ getAllStudies: () => 'none', getStudyById: () => ({}) }),
    );

    expect(result).toStrictEqual({ studies: [], unreadable: [] });
  });

  test.each(NO_CHART)('fails CAPABILITY_UNAVAILABLE on %s', async (_name, make) => {
    const { error } = await failureOfBoth(readStudies, [null], make);

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
  });
});

describe('readStudyValues', () => {
  test('reads the last rows of a study with its plots and titles, skipping pre-history', async () => {
    const { result, win } = await resultOf(readStudyValues, [null, 'STUDY02', 2, null], chart());

    const row = (index: number) => {
      const close = bars[index]?.[4] ?? 0;
      return [bars[index]?.[0], close, Math.round((close + 1) * 100) / 100, 0];
    };
    expect(result).toStrictEqual({
      plots: [
        { id: 'plot_0', type: 'line', target: null },
        { id: 'plot_1', type: 'line', target: null },
        { id: 'plot_2', type: 'bg_colorer', target: null },
      ],
      styles: { plot_0: { title: 'RSI' }, plot_1: { title: 'RSI-based MA' } },
      ohlcPlots: {},
      rows: [row(298), row(299)],
    });
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('never reaches into the pre-history rows, however many rows are asked for', async () => {
    const { result } = await resultOf(readStudyValues, [null, 'STUDY02', 500, null], chart());

    expect(result).toMatchObject({ rows: expect.any(Array) as unknown[] });
    const rows = (result as { rows: (number | null)[][] }).rows;
    expect(rows).toHaveLength(300);
    expect(rows[0]?.[0]).toBe(bars[0]?.[0]);
    // Before the warmup the values are NaN, which JSON carries as null.
    expect(rows[0]?.slice(1)).toEqual([null, null, 0]);
  });

  test('reads the rows that end at the bar at or before a time', async () => {
    const at = (bars[100]?.[0] ?? 0) + 3600;

    const { result } = await resultOf(readStudyValues, [null, 'STUDY01', 2, at], chart());
    const { result: exact } = await resultOf(
      readStudyValues,
      [0, 'STUDY01', 1, bars[100]?.[0] ?? 0],
      chart(),
    );
    const { result: early } = await resultOf(
      readStudyValues,
      [null, 'STUDY02', 1, (bars[0]?.[0] ?? 0) - 1],
      chart(),
    );
    const { result: late } = await resultOf(
      readStudyValues,
      [null, 'STUDY01', 1, (bars[299]?.[0] ?? 0) + 10_000_000],
      chart(),
    );

    const times = (value: unknown) =>
      (value as { rows: (number | null)[][] }).rows.map((row) => row[0]);
    expect(times(result)).toEqual([bars[99]?.[0], bars[100]?.[0]]);
    expect(times(exact)).toEqual([bars[100]?.[0]]);
    // Only pre-history lies before the first bar, so no row.
    expect(times(early)).toEqual([]);
    expect(times(late)).toEqual([bars[299]?.[0]]);
  });

  test('copies values that are not finite numbers as null, and passes over rows without a time', async () => {
    const meta = {
      plots: [
        { id: 'plot_0', type: 'line' },
        { id: 'plot_1', type: 'ohlc_open', target: 'plotcandle_0' },
        { id: 7 },
        null,
      ],
      styles: { plot_0: { title: 'A' }, plot_9: { title: 5 }, plot_8: null },
      ohlcPlots: { plotcandle_0: { title: 'C' } },
    };
    const items = [
      { index: 0, value: [100, Number.NaN, undefined, null, 'x'] },
      { index: 1, value: [null, 1, 2] },
      { index: 2, value: [300, Infinity, 3.5] },
    ];

    const { result } = await resultOf(
      readStudyValues,
      [null, 'S1', 10, null],
      withStudy(studyWith(meta, items)),
    );

    expect(result).toStrictEqual({
      plots: [
        { id: 'plot_0', type: 'line', target: null },
        { id: 'plot_1', type: 'ohlc_open', target: 'plotcandle_0' },
        { id: '7', type: '', target: null },
        { id: '', type: '', target: null },
      ],
      styles: { plot_0: { title: 'A' } },
      ohlcPlots: { plotcandle_0: { title: 'C' } },
      rows: [
        [100, null, null, null, null],
        [300, null, 3.5, null, null],
      ],
    });
  });

  test('passes over items whose value is not a row, and reads a study whose metadata throws', async () => {
    const study = {
      study: () => ({
        metaInfo: () => {
          throw new Error('boom');
        },
        data: () =>
          plotListOf([
            { index: 0, value: [100, 1] },
            { index: 1, value: 'x' as unknown as unknown[] },
          ]),
      }),
    };

    const { result } = await resultOf(readStudyValues, [null, 'S1', 5, null], withStudy(study));

    expect(result).toStrictEqual({ plots: [], styles: {}, ohlcPlots: {}, rows: [[100]] });
  });

  test('reads no rows from a study without plottable rows, or without a list of plots', async () => {
    const { result } = await resultOf(
      readStudyValues,
      [null, 'S1', 5, null],
      withStudy(studyWith({}, [{ index: -1_000_001, value: [1, 2] }])),
    );
    const { result: at } = await resultOf(
      readStudyValues,
      [null, 'S1', 5, 1000],
      withStudy(studyWith({ plots: 'none' }, [])),
    );

    expect(result).toStrictEqual({ plots: [], styles: {}, ohlcPlots: {}, rows: [] });
    expect(at).toStrictEqual({ plots: [], styles: {}, ohlcPlots: {}, rows: [] });
  });

  test('fails INVALID_INPUT for an id that is not on the chart, pointing at indicator_list', async () => {
    const { error } = await failureOfBoth(readStudyValues, [null, 'NOPE', 1, null], chart());

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toMatch(/NOPE/);
    expect(error.hint).toMatch(/indicator_list/);
    expect(error.details).toEqual({ id: 'NOPE' });
  });

  test('fails INVALID_INPUT for a listed study the app does not know', async () => {
    const make = withChart({
      getAllStudies: () => [{ id: 'S1', name: 'Ghost' }],
      getStudyById: () => {
        throw new Error('There is no such study');
      },
    });

    const { error } = await failureOfBoth(readStudyValues, [null, 'S1', 1, null], make);

    expect(error.code).toBe('INVALID_INPUT');
  });

  test('fails CAPABILITY_UNAVAILABLE for a study whose rows cannot be read', async () => {
    const { error } = await failureOfBoth(
      readStudyValues,
      [null, 'S1', 1, null],
      withStudy({ study: () => ({ metaInfo: () => ({}), data: () => ({}) }) }),
    );

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(error.message).toMatch(/S1/);
  });

  test.each(NO_CHART)('fails CAPABILITY_UNAVAILABLE on %s', async (_name, make) => {
    const { error } = await failureOfBoth(readStudyValues, [null, 'S1', 1, null], make);

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
  });
});

describe('readStudyCatalog', () => {
  test('reads the standard scripts without libraries, and the visible built-ins', async () => {
    const { result, win } = await libResultOf(readStudyCatalog, [], chart());

    expect(result).toStrictEqual({
      scripts: [
        {
          id: 'STD;MACD',
          name: 'Moving Average Convergence Divergence',
          shortName: 'MACD',
          version: '28.0',
          isStrategy: false,
        },
        {
          id: 'STD;RSI',
          name: 'Relative Strength Index',
          shortName: 'RSI',
          version: '41.0',
          isStrategy: false,
        },
        {
          id: 'STD;SMA',
          name: 'Moving Average',
          shortName: 'MA',
          version: '36.0',
          isStrategy: false,
        },
        {
          id: 'STD;RSI%1Strategy',
          name: 'RSI Strategy',
          shortName: 'RSI Strategy',
          version: '12.0',
          isStrategy: true,
        },
      ],
      scriptsError: null,
      builtins: [
        { id: 'Volume@tv-basicstudies', name: 'Volume', shortName: 'Vol', isStrategy: false },
        {
          id: 'VbPFixed@tv-volumebyprice',
          name: 'Volume Profile Fixed Range',
          shortName: 'VPFR',
          isStrategy: false,
        },
        {
          id: 'VbPVisible@tv-volumebyprice',
          name: 'Volume Profile Visible Range',
          shortName: 'VPVR',
          isStrategy: false,
        },
      ],
    });
    // The list of standard scripts is the one request; the repository reads its cache.
    expect(inspectFakeWindow(win).calls.map(({ name }) => name)).toEqual(['requestBuiltinScripts']);
  });

  test('asks a repository that is not ready for its metadata', async () => {
    const { result, win } = await libResultOf(
      readStudyCatalog,
      [],
      chart(fixture, { studyRepositoryReady: false }),
    );

    expect((result as { builtins: unknown[] }).builtins).toHaveLength(3);
    expect(inspectFakeWindow(win).callsTo('studyMetaInfoRepository.requestMetaInfo')).toEqual([[]]);
  });

  test('reports why the standard scripts are missing, and keeps the built-ins', async () => {
    const { result } = await libResultOf(
      readStudyCatalog,
      [],
      chart(fixture, { builtinScriptsError: 'Network error' }),
    );

    expect(result).toMatchObject({
      scripts: null,
      scriptsError: 'Network error',
      builtins: expect.any(Array) as unknown[],
    });
  });

  // A page whose webpack cache holds `modules` only.
  const withModules = (modules: Record<string, Record<string, unknown>>): Make =>
    plain({ webpackChunktradingview: createFakeWebpack(modules) });

  test('names an item without a name by its id, and reads an error without a message', async () => {
    const failure = new Error('ignored');
    Object.defineProperty(failure, 'message', { value: 42 });

    const { result } = await libResultOf(
      readStudyCatalog,
      [],
      withModules({
        1: {
          studyMetaInfoRepository: () => ({
            isReady: () => true,
            getInternalMetaInfoArray: () => [{ id: 'A@x' }],
          }),
        },
        2: { requestBuiltinScripts: () => Promise.reject(failure) },
      }),
    );
    const { result: unnamed } = await libResultOf(
      readStudyCatalog,
      [],
      withModules({ 2: { requestBuiltinScripts: () => Promise.resolve([{ scriptIdPart: 'S' }]) } }),
    );

    expect(result).toStrictEqual({
      scripts: null,
      scriptsError: 'Error: 42',
      builtins: [{ id: 'A@x', name: 'A@x', shortName: 'A@x', isStrategy: false }],
    });
    expect(unnamed).toMatchObject({ scripts: [{ id: 'S', name: 'S', shortName: 'S' }] });
  });

  test('reads the items defensively: kind from extra, shortName from the title or the name', async () => {
    const repository = {
      isReady: () => true,
      getInternalMetaInfoArray: () => [
        { id: 'A@x', description: 'Alpha', shortDescription: 'A', extra: { kind: 'strategy' } },
        { id: 'B@x', description: 'Beta', isTVScriptStrategy: true },
        { id: 'C@x', description: 'Gamma', shortDescription: 'G', is_hidden_study: true },
        { description: 'No id' },
        null,
      ],
    };
    const scripts = [
      { scriptIdPart: 'USER;1', scriptName: 'One', version: 2, extra: {} },
      { scriptIdPart: 'USER;2', scriptName: 'Two', scriptTitle: '', kind: 'strategy' },
      { scriptName: 'No id' },
      'junk',
    ];

    const { result } = await libResultOf(
      readStudyCatalog,
      [],
      withModules({
        1: { studyMetaInfoRepository: () => repository },
        2: { requestBuiltinScripts: () => Promise.resolve(scripts) },
      }),
    );

    expect(result).toStrictEqual({
      scripts: [
        { id: 'USER;1', name: 'One', shortName: 'One', version: null, isStrategy: false },
        { id: 'USER;2', name: 'Two', shortName: 'Two', version: null, isStrategy: false },
      ],
      scriptsError: null,
      builtins: [
        { id: 'A@x', name: 'Alpha', shortName: 'A', isStrategy: true },
        { id: 'B@x', name: 'Beta', shortName: 'Beta', isStrategy: true },
      ],
    });
  });

  test('reports a script list that is not a list, or a request that throws, as missing', async () => {
    const repository = { isReady: () => true, getInternalMetaInfoArray: () => 'none' };

    const { result } = await libResultOf(
      readStudyCatalog,
      [],
      withModules({
        1: { studyMetaInfoRepository: () => repository },
        2: { requestBuiltinScripts: () => Promise.resolve({ error: true }) },
      }),
    );
    const { result: thrown } = await libResultOf(
      readStudyCatalog,
      [],
      withModules({
        1: { studyMetaInfoRepository: () => repository },
        2: {
          requestBuiltinScripts: () => {
            throw new Error('refused');
          },
        },
      }),
    );

    expect(result).toStrictEqual({
      scripts: null,
      scriptsError: 'TradingView answered with no list of scripts',
      builtins: [],
    });
    expect(thrown).toMatchObject({ scripts: null, scriptsError: 'refused' });
  });

  test('reads only one of the two sources when the other is missing', async () => {
    const { result: noScripts } = await libResultOf(
      readStudyCatalog,
      [],
      withModules({
        1: {
          studyMetaInfoRepository: () => ({
            isReady: () => false,
            findAllJavaStudies: () => Promise.reject(new Error('offline')),
          }),
        },
      }),
    );
    const { result: noBuiltins } = await libResultOf(
      readStudyCatalog,
      [],
      withModules({ 2: { requestBuiltinScripts: () => Promise.resolve([]) } }),
    );

    expect(noScripts).toStrictEqual({
      scripts: null,
      scriptsError: 'This TradingView build has no list of standard scripts to read',
      builtins: null,
    });
    expect(noBuiltins).toStrictEqual({ scripts: [], scriptsError: null, builtins: null });
  });

  test('fails CAPABILITY_UNAVAILABLE on a page that has neither source', async () => {
    const error = await libFailureOfBoth(readStudyCatalog, [], withModules({}));

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
  });
});
