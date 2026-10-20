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
  editStudyInputs,
  insertStudy,
  readStudies,
  readStudyCatalog,
  readStudyInsertContext,
  readStudyValues,
  removeStudy,
  setStudyVisibility,
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

// A chart with room for `limit` counted studies; the fixture holds two, which is its limit.
const roomy = (limit = 5): TvStateFixture => ({
  ...fixture,
  planLimits: { ...fixture.planLimits, INDICATORS_ON_CHART: limit },
});

// A page built anew for each call, so that a change made by one run is not seen by the other.
const fresh = (build: () => object): Make => build;

// A page whose active chart is made of `members` and whose webpack registry holds `modules`.
const withChartAndModules = (
  members: () => object,
  modules: Record<string, Record<string, unknown>> = {},
): Make =>
  fresh(() => ({
    TradingViewApi: { activeChart: members },
    webpackChunktradingview: createFakeWebpack(modules),
  }));

const repositoryOf = (items: unknown) => ({
  1: {
    studyMetaInfoRepository: () => ({ isReady: () => true, getInternalMetaInfoArray: () => items }),
  },
});

describe('readStudyInsertContext', () => {
  test('reads the count, the check of the model and the metadata of a built-in', async () => {
    const { result, win } = await libResultOf(
      readStudyInsertContext,
      [null, 'Volume@tv-basicstudies'],
      chart(roomy()),
    );

    expect(result).toStrictEqual({
      chartIndex: 0,
      count: 2,
      check: { success: true, reason: null, limitValue: null },
      builtin: {
        description: 'Volume',
        firstMatch: true,
        confirm: false,
        // The hidden symbol input is left out.
        inputs: [
          {
            id: 'length',
            name: 'MA Length',
            type: 'integer',
            value: 20,
            options: null,
            min: 1,
            max: 2000,
          },
          {
            id: 'col_prev_close',
            name: 'Color based on previous close',
            type: 'bool',
            value: false,
            options: null,
            min: null,
            max: null,
          },
        ],
      },
    });
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('answers for Pine without the repository, with the check of a full chart', async () => {
    const { result } = await libResultOf(readStudyInsertContext, [0, ''], chart());

    expect(result).toStrictEqual({
      chartIndex: 0,
      count: 2,
      check: { success: false, reason: 'general', limitValue: 2 },
      builtin: null,
    });
  });

  test('tells when another study comes first by description, and when an input asks for confirmation', async () => {
    const custom = roomy();
    custom.studyCatalog = {
      ...custom.studyCatalog,
      builtins: [
        { id: 'Old@x', description: 'twin', shortDescription: 'T', hidden: true },
        {
          id: 'New@x',
          description: 'Twin',
          shortDescription: 'T',
          inputs: [
            { id: 'start', name: 'Start', type: 'time', value: 0, confirm: true, isHidden: true },
          ],
        },
      ],
    };

    const { result } = await libResultOf(readStudyInsertContext, [null, 'New@x'], chart(custom));

    expect(result.builtin).toStrictEqual({
      description: 'Twin',
      firstMatch: false,
      confirm: true,
      inputs: [],
    });
  });

  test('asks a repository that is not ready for its metadata', async () => {
    const { result, win } = await libResultOf(
      readStudyInsertContext,
      [null, 'VbPFixed@tv-volumebyprice'],
      chart(roomy(), { studyRepositoryReady: false }),
    );

    expect(result.builtin).toMatchObject({ description: 'Volume Profile Fixed Range' });
    expect(inspectFakeWindow(win).callsTo('studyMetaInfoRepository.requestMetaInfo')).toEqual([[]]);
  });

  test('answers no check without canCreateStudy, when it throws or answers oddly, and no count without a list', async () => {
    const members = (model: unknown) => () => ({
      createStudy: () => Promise.resolve(null),
      getAllStudies: () => 'none',
      _chartWidget: { model: () => model },
    });

    const { result: missing } = await libResultOf(
      readStudyInsertContext,
      [null, ''],
      withChartAndModules(members({})),
    );
    const { result: thrown } = await libResultOf(
      readStudyInsertContext,
      [null, ''],
      withChartAndModules(
        members({
          canCreateStudy: () => {
            throw new Error('No session');
          },
        }),
      ),
    );
    const { result: odd } = await libResultOf(
      readStudyInsertContext,
      [null, ''],
      withChartAndModules(members({ canCreateStudy: () => ({ success: 'yes' }) })),
    );
    const { result: noWidget } = await libResultOf(
      readStudyInsertContext,
      [null, ''],
      withChartAndModules(() => ({ createStudy: () => null, getAllStudies: () => [] })),
    );

    expect(missing).toStrictEqual({ chartIndex: null, count: null, check: null, builtin: null });
    expect(thrown.check).toBeNull();
    expect(odd.check).toBeNull();
    expect(noWidget).toStrictEqual({ chartIndex: null, count: 0, check: null, builtin: null });
  });

  test('answers no built-in without a repository, for an unknown id, or when the repository fails', async () => {
    const members = () => ({ createStudy: () => null, getAllStudies: () => [] });

    const { result: noRepository } = await libResultOf(
      readStudyInsertContext,
      [null, 'A@x'],
      withChartAndModules(members),
    );
    const { result: unknown } = await libResultOf(
      readStudyInsertContext,
      [null, 'A@x'],
      withChartAndModules(members, repositoryOf([{ id: 'B@x', description: 'B' }, null])),
    );
    const { result: nameless } = await libResultOf(
      readStudyInsertContext,
      [null, 'A@x'],
      withChartAndModules(members, repositoryOf([{ id: 'A@x' }])),
    );
    const { result: notAList } = await libResultOf(
      readStudyInsertContext,
      [null, 'A@x'],
      withChartAndModules(members, repositoryOf('none')),
    );
    const { result: failed } = await libResultOf(
      readStudyInsertContext,
      [null, 'A@x'],
      withChartAndModules(members, {
        1: {
          studyMetaInfoRepository: () => ({
            isReady: () => false,
            findAllJavaStudies: () => Promise.reject(new Error('offline')),
          }),
        },
      }),
    );

    for (const result of [noRepository, unknown, nameless, notAList, failed]) {
      expect(result.builtin).toBeNull();
    }
  });

  test('reads the inputs of the metadata defensively', async () => {
    const item = {
      id: 'A@x',
      description: 'Alpha',
      inputs: [
        {
          id: 'a',
          localizedName: 'Local',
          type: 'text',
          defval: { nested: true },
          options: ['x', 1],
        },
        {
          id: 'b',
          defval: Number.NaN,
          options: ['x', null],
          min: 'low',
          max: Number.POSITIVE_INFINITY,
        },
        { name: 'No id' },
        null,
      ],
    };
    const { result } = await libResultOf(
      readStudyInsertContext,
      [null, 'A@x'],
      withChartAndModules(
        () => ({ createStudy: () => null, getAllStudies: () => [] }),
        repositoryOf([item]),
      ),
    );
    const { result: noInputs } = await libResultOf(
      readStudyInsertContext,
      [null, 'A@x'],
      withChartAndModules(
        () => ({ createStudy: () => null, getAllStudies: () => [] }),
        repositoryOf([{ id: 'A@x', description: 'Alpha', inputs: 'none' }]),
      ),
    );

    expect(result.builtin?.inputs).toStrictEqual([
      {
        id: 'a',
        name: 'Local',
        type: 'text',
        value: null,
        options: ['x', 1],
        min: null,
        max: null,
      },
      { id: 'b', name: 'b', type: '', value: null, options: null, min: null, max: null },
    ]);
    expect(noInputs.builtin?.inputs).toEqual([]);
  });

  test.each([
    ...NO_CHART,
    ['a chart without createStudy', withChart({ getAllStudies: () => [] })] as [string, Make],
  ])('fails CAPABILITY_UNAVAILABLE on %s', async (_name, make) => {
    const error = await libFailureOfBoth(readStudyInsertContext, [null, ''], make);

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
  });
});

describe('insertStudy', () => {
  test('adds a built-in by description with the limit check of the app, and answers its id', async () => {
    const { result, win } = await resultOf(
      insertStudy,
      [null, { kind: 'description', description: 'Volume' }, true, 1000],
      chart(roomy()),
    );

    expect(result).toEqual({ id: 'NEW001' });
    expect(inspectFakeWindow(win).callsTo('chart.createStudy')).toEqual([
      ['Volume', true, false, undefined, undefined, { checkLimit: true }],
    ]);
  });

  test('adds a built-in or a Pine script by descriptor, with nothing else', async () => {
    const { result: java, win: javaWin } = await resultOf(
      insertStudy,
      [0, { kind: 'java', studyId: 'VbPFixed@tv-volumebyprice' }, true, 1000],
      chart(roomy()),
    );
    const { result: pine, win: pineWin } = await resultOf(
      insertStudy,
      [null, { kind: 'pine', pineId: 'STD;MACD', pineVersion: '28.0' }, false, 1000],
      chart(roomy()),
    );

    expect([java, pine]).toEqual([{ id: 'NEW001' }, { id: 'NEW001' }]);
    expect(inspectFakeWindow(javaWin).callsTo('chart.createStudy')).toEqual([
      [{ type: 'java', studyId: 'VbPFixed@tv-volumebyprice' }],
    ]);
    expect(inspectFakeWindow(pineWin).callsTo('chart.createStudy')).toEqual([
      [{ type: 'pine', pineId: 'STD;MACD', pineVersion: '28.0' }],
    ]);
  });

  const answering = (createStudy: () => unknown): Make => withChart({ createStudy });
  const byName = { kind: 'description', description: 'Volume' } as const;

  test.each([
    ['a null answer', () => Promise.resolve(null), 'NOT_AVAILABLE', null],
    [
      'a rejection with an insertion code',
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      () => Promise.reject('cannot_be_child'),
      'NOT_AVAILABLE',
      'cannot_be_child',
    ],
    [
      'a rejection with an Error',
      () => Promise.reject(new Error('unexpected study id:volume')),
      'NOT_AVAILABLE',
      'unexpected study id:volume',
    ],
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    ['a rejection with something else', () => Promise.reject(42), 'NOT_AVAILABLE', '42'],
    [
      'a call that throws',
      () => {
        throw new Error('Unknown priceScale');
      },
      'NOT_AVAILABLE',
      'Unknown priceScale',
    ],
    [
      'a call that throws something else',
      () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'broken';
      },
      'NOT_AVAILABLE',
      'broken',
    ],
    ['an answer that is not an id', () => Promise.resolve(42), 'PAGE_EVALUATION_FAILED', undefined],
    ['an empty id', () => '', 'PAGE_EVALUATION_FAILED', undefined],
  ])('fails on %s', async (_name, createStudy, code, reason) => {
    const { error } = await failureOfBoth(
      insertStudy,
      [null, byName, false, 1000],
      answering(createStudy),
    );

    expect(error.code).toBe(code);
    if (reason !== undefined) {
      expect(error.details).toEqual({ reason });
    }
  });

  test('stops waiting after waitMs and says the indicator may still appear', async () => {
    const { error } = await failureOfBoth(
      insertStudy,
      [null, byName, false, 20],
      answering(() => new Promise(() => undefined)),
    );

    expect(error).toMatchObject({
      code: 'TIMEOUT',
      details: { waitMs: 20 },
      hint: expect.stringMatching(/indicator_list/) as string,
    });
  });

  test.each(NO_CHART)('fails CAPABILITY_UNAVAILABLE on %s', async (_name, make) => {
    const { error } = await failureOfBoth(insertStudy, [null, byName, false, 1000], make);

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
  });
});

describe('editStudyInputs', () => {
  test('reads the inputs the user sees, with their bounds, and changes nothing', async () => {
    const { result, win } = await resultOf(editStudyInputs, [null, 'STUDY01', null], chart());

    expect(result).toStrictEqual({
      inputs: [
        { id: 'in_0', name: 'Length', type: 'integer', value: 9, options: null, min: 1, max: 5000 },
        {
          id: 'in_1',
          name: 'Source',
          type: 'source',
          value: 'close',
          options: null,
          min: null,
          max: null,
        },
        {
          id: 'in_2',
          name: 'Offset',
          type: 'integer',
          value: 0,
          options: null,
          min: -500,
          max: 500,
        },
      ],
    });
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('sets the values first and reads the inputs afterwards', async () => {
    const { result, win } = await resultOf(
      editStudyInputs,
      [0, 'STUDY02', [{ id: 'in_2', value: 'EMA' }]],
      chart(),
    );

    expect(result.inputs[2]).toEqual({
      id: 'in_2',
      name: 'Type',
      type: 'text',
      value: 'EMA',
      options: ['None', 'SMA', 'EMA'],
      min: null,
      max: null,
    });
    expect(inspectFakeWindow(win).callsTo('study.setInputValues')).toEqual([
      ['STUDY02', [{ id: 'in_2', value: 'EMA' }]],
    ]);
  });

  test('reads the inputs defensively', async () => {
    const api = {
      getInputsInfo: () => [
        { id: 'a', localizedName: 'Local', type: 'integer', options: [1, 2], min: Number.NaN },
        { id: 'b', name: 'B', options: [{}] },
        { id: 'c', name: 'C', isHidden: true },
        { id: 'd' },
        { name: 'No id' },
        null,
      ],
      getInputValues: () => [{ id: 'a', value: 2 }, { id: 'b', value: [1] }, { value: 3 }, null],
    };
    const { result } = await resultOf(editStudyInputs, [null, 'S1', null], withStudy(api));
    const { result: empty } = await resultOf(
      editStudyInputs,
      [null, 'S1', null],
      withStudy({ getInputsInfo: () => 'none', getInputValues: () => 'none' }),
    );

    expect(result.inputs).toStrictEqual([
      { id: 'a', name: 'Local', type: 'integer', value: 2, options: [1, 2], min: null, max: null },
      { id: 'b', name: 'B', type: '', value: null, options: null, min: null, max: null },
      { id: 'd', name: 'd', type: '', value: null, options: null, min: null, max: null },
    ]);
    expect(empty.inputs).toEqual([]);
  });

  test('fails INVALID_INPUT for an id that is not on the chart, or that the app does not know', async () => {
    const { error } = await failureOfBoth(editStudyInputs, [null, 'NOPE01', null], chart());
    const { error: unknown } = await failureOfBoth(
      editStudyInputs,
      [null, 'S1', null],
      withChart({
        getAllStudies: () => [{ id: 'S1', name: 'Study' }],
        getStudyById: () => {
          throw new Error('There is no such study');
        },
      }),
    );

    expect(error).toMatchObject({
      code: 'INVALID_INPUT',
      hint: expect.stringMatching(/indicator_list/) as string,
    });
    expect(unknown.code).toBe('INVALID_INPUT');
  });

  test('fails CAPABILITY_UNAVAILABLE before acting when the study cannot read or set inputs', async () => {
    const setInputValues = vi.fn();
    const { error: unreadable } = await failureOfBoth(
      editStudyInputs,
      [null, 'S1', [{ id: 'a', value: 1 }]],
      withStudy({ setInputValues }),
    );
    const { error: unsettable } = await failureOfBoth(
      editStudyInputs,
      [null, 'S1', [{ id: 'a', value: 1 }]],
      withStudy({ getInputsInfo: () => [] }),
    );
    // Reading needs no setter.
    const { result } = await resultOf(
      editStudyInputs,
      [null, 'S1', null],
      withStudy({ getInputsInfo: () => [] }),
    );

    expect(unreadable).toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      message: expect.stringMatching(/set/) as string,
    });
    expect(unsettable.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(setInputValues).not.toHaveBeenCalled();
    expect(result).toEqual({ inputs: [] });
  });

  test('reports a study without a reader as unreadable', async () => {
    const { error } = await failureOfBoth(editStudyInputs, [null, 'S1', null], withStudy({}));

    expect(error.message).toMatch(/cannot be read/);
  });

  test.each(NO_CHART)('fails CAPABILITY_UNAVAILABLE on %s', async (_name, make) => {
    const { error } = await failureOfBoth(editStudyInputs, [null, 'S1', null], make);

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
  });
});

describe('setStudyVisibility', () => {
  test('shows a hidden study and answers its visibility before and after', async () => {
    const { result, win } = await resultOf(setStudyVisibility, [0, 'STUDY02', true], chart());

    expect(result).toEqual({ previous: false, visible: true });
    expect(inspectFakeWindow(win).callsTo('study.setVisible')).toEqual([['STUDY02', true]]);
  });

  test('takes a visibility that cannot be read as hidden', async () => {
    const { result } = await resultOf(
      setStudyVisibility,
      [null, 'S1', false],
      fresh(() => {
        const api = {
          isVisible: () => {
            throw new Error('Not ready');
          },
          setVisible: () => undefined,
        };
        return {
          TradingViewApi: {
            activeChart: () => ({ getAllStudies: () => [{ id: 'S1' }], getStudyById: () => api }),
          },
        };
      }),
    );

    expect(result).toEqual({ previous: false, visible: false });
  });

  test('fails INVALID_INPUT for an id that is not on the chart', async () => {
    const { error } = await failureOfBoth(setStudyVisibility, [null, 'NOPE01', false], chart());

    expect(error).toMatchObject({ code: 'INVALID_INPUT', details: { id: 'NOPE01' } });
  });

  test('fails CAPABILITY_UNAVAILABLE before acting for a study without setVisible', async () => {
    const { error } = await failureOfBoth(
      setStudyVisibility,
      [null, 'S1', false],
      withStudy({ isVisible: () => true }),
    );
    const { error: unknown } = await failureOfBoth(
      setStudyVisibility,
      [null, 'S1', false],
      withChart({ getAllStudies: () => 'none', getStudyById: () => ({}) }),
    );

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(unknown.code).toBe('INVALID_INPUT');
  });

  test.each(NO_CHART)('fails CAPABILITY_UNAVAILABLE on %s', async (_name, make) => {
    const { error } = await failureOfBoth(setStudyVisibility, [null, 'S1', true], make);

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
  });
});

describe('removeStudy', () => {
  test('only checks without confirmed, and changes nothing', async () => {
    const { result, win } = await resultOf(removeStudy, [null, 'STUDY01', false], chart());

    expect(result).toEqual({ removed: false, name: 'Moving Average' });
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('removes the study undoably when confirmed', async () => {
    const { result, win } = await resultOf(removeStudy, [0, 'STUDY02', true], chart());

    expect(result).toEqual({ removed: true, name: 'Relative Strength Index' });
    expect(inspectFakeWindow(win).callsTo('chart.removeEntity')).toEqual([['STUDY02']]);
    expect(inspectFakeWindow(win).state.removedStudies).toEqual([
      { id: 'STUDY02', undoable: true },
    ]);
  });

  test('names a study without a name by its id', async () => {
    const { result } = await resultOf(
      removeStudy,
      [null, 'S1', false],
      withChart({ getAllStudies: () => [null, { id: 'S1' }], removeEntity: () => undefined }),
    );

    expect(result).toEqual({ removed: false, name: 'S1' });
  });

  test('fails INVALID_INPUT for an id that is not on the chart, confirmed or not', async () => {
    const removeEntity = vi.fn();
    const make = withChart({ getAllStudies: () => 'none', removeEntity });

    const { error } = await failureOfBoth(removeStudy, [null, 'NOPE01', true], chart());
    const { error: unlisted } = await failureOfBoth(removeStudy, [null, 'S1', false], make);

    expect(error).toMatchObject({
      code: 'INVALID_INPUT',
      hint: expect.stringMatching(/indicator_list/) as string,
    });
    expect(unlisted.code).toBe('INVALID_INPUT');
    expect(removeEntity).not.toHaveBeenCalled();
  });

  test('fails NOT_AVAILABLE when the study is still listed afterwards', async () => {
    const { error } = await failureOfBoth(
      removeStudy,
      [null, 'S1', true],
      withChart({
        getAllStudies: () => [{ id: 'S1', name: 'Locked' }],
        removeEntity: () => undefined,
      }),
    );

    expect(error).toMatchObject({ code: 'NOT_AVAILABLE', details: { id: 'S1' } });
  });

  test.each([
    ...NO_CHART,
    ['a chart without removeEntity', withChart({ getAllStudies: () => [] })] as [string, Make],
  ])('fails CAPABILITY_UNAVAILABLE on %s', async (_name, make) => {
    const { error } = await failureOfBoth(removeStudy, [null, 'S1', true], make);

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
  });
});
