import { setTimeout as delay } from 'node:timers/promises';
import type { FakePaneApi } from '../../helpers/fake-tv/charts.js';
import { loadTvFixture, type TvStateFixture } from '../../helpers/fake-tv/fixture.js';
import type { FakeWebpackRequire } from '../../helpers/fake-tv/webpack.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTradingViewApi,
  type FakeTvOverrides,
  type FakeTvWindow,
} from '../../helpers/fake-tv/window.js';
import { withChartLimit, withTwoCharts } from '../../helpers/pane-fixtures.js';

// The charts of the layout, their panes and the layout functions of the fake app (charts.ts),
// checked against what the reverse-engineering notes of Plan 3 (section 2) and the web build record
// for the app. Values are synthetic.

const fixture = loadTvFixture();
// Two charts side by side, on the plan of the fixture, which allows one chart.
const twoCharts = withTwoCharts(fixture);

// A layout of one chart that keeps a second one hidden, as the app does after a layout of two
// charts became a layout of one until the layout is saved.
const oneShownOfTwo: TvStateFixture = {
  ...twoCharts,
  layout: { ...fixture.layout, type: 's', chartsCount: 1 },
};

// How long the tests wait for setLayout and for the data of a new chart (10 ms each by default).
const SETTLE_MS = 40;

// The exports of the default webpack cache, by name. Each look pushes a chunk of its own: the runtime
// hands nothing to a chunk ID it has seen.
let probes = 0;
function exportsOf(win: FakeTvWindow): Record<string, unknown> {
  let handed: FakeWebpackRequire | undefined;
  probes += 1;
  (win.webpackChunktradingview as { push(chunk: unknown): unknown }).push([
    [`charts${String(probes)}`],
    {},
    (given: FakeWebpackRequire) => (handed = given),
  ]);
  const found: Record<string, unknown> = {};
  for (const record of Object.values(handed?.c ?? {})) {
    Object.assign(found, record.exports);
  }
  return found;
}

function windowWith(from: TvStateFixture = fixture, overrides: FakeTvOverrides = {}): FakeTvWindow {
  return createFakeTvWindow(from, overrides);
}

function apiOf(win: FakeTvWindow): FakeTradingViewApi {
  if (win.TradingViewApi === undefined) {
    throw new Error('The fake window has no TradingViewApi');
  }
  return win.TradingViewApi;
}

const calls = (win: FakeTvWindow, name: string) => inspectFakeWindow(win).callsTo(name);
const callNames = (win: FakeTvWindow) => inspectFakeWindow(win).calls.map(({ name }) => name);
const paywalls = (win: FakeTvWindow) => calls(win, 'dialog.paywall');

// What a pane reports through its API.
function paneOf(pane: FakePaneApi) {
  return {
    index: pane.paneIndex(),
    height: pane.getHeight(),
    hasMainSeries: pane.hasMainSeries(),
    entities: pane.getAllEntities(),
  };
}

// The layout as the API reports it: its type, how many charts it shows and the active one.
function layoutOf(win: FakeTvWindow) {
  const api = apiOf(win);
  return { layout: api.layout(), chartsCount: api.chartsCount(), active: api.activeChartIndex() };
}

// Whether a promise settles within a few milliseconds.
async function settlesSoon(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([promise.then(() => true), delay(SETTLE_MS).then(() => false)]);
}

describe('the charts of the layout', () => {
  test('the default window shows the chart of the fixture alone, in one pane that holds everything', () => {
    const win = windowWith();
    const api = apiOf(win);

    expect(layoutOf(win)).toEqual({ layout: 's', chartsCount: 1, active: 0 });
    expect(api.chart(0)).toBe(api.activeChart());
    expect(() => api.chart(1)).toThrow(new Error('Incorrect index: 1'));
    expect(api.chart(0).getPanes().map(paneOf)).toEqual([
      {
        index: 0,
        height: 600,
        hasMainSeries: true,
        entities: [
          { id: 'MAINSERIES', name: 'Main Series' },
          { id: 'STUDY01', name: 'Moving Average' },
          { id: 'STUDY02', name: 'Relative Strength Index' },
          { id: 'SHAPE01', name: 'trend_line' },
          { id: 'SHAPE02', name: 'horizontal_line' },
          { id: 'SHAPE03', name: 'rectangle' },
        ],
      },
    ]);
  });

  test('the fixture places studies in panes of their own; the first pane keeps the main series, the other studies and the drawings', () => {
    const api = apiOf(windowWith(twoCharts));

    expect(api.chart(0).getPanes().map(paneOf)).toEqual([
      {
        index: 0,
        height: 420,
        hasMainSeries: true,
        entities: [
          { id: 'MAINSERIES', name: 'Main Series' },
          { id: 'STUDY01', name: 'Moving Average' },
          { id: 'SHAPE01', name: 'trend_line' },
          { id: 'SHAPE02', name: 'horizontal_line' },
          { id: 'SHAPE03', name: 'rectangle' },
        ],
      },
      {
        index: 1,
        height: 180,
        hasMainSeries: false,
        entities: [{ id: 'STUDY02', name: 'Relative Strength Index' }],
      },
    ]);
  });

  test('a pane whose studies are all gone disappears, as the app removes an empty pane', () => {
    const api = apiOf(windowWith(twoCharts));

    api.chart(0).removeEntity('STUDY02');

    expect(
      api
        .chart(0)
        .getPanes()
        .map((pane) => pane.paneIndex()),
    ).toEqual([0]);
  });

  test('the other charts of the fixture report their symbol, resolution, studies, drawings and panes', () => {
    const win = windowWith(twoCharts);
    const other = apiOf(win).chart(1);

    expect(layoutOf(win)).toEqual({ layout: '2h', chartsCount: 2, active: 0 });
    expect([other.symbol(), other.resolution(), other.chartType()]).toEqual([
      'NASDAQ:MSFT',
      '60',
      1,
    ]);
    expect(other.getAllStudies()).toEqual([
      { id: 'C1STUDY1', name: 'Volume' },
      { id: 'C1STUDY2', name: 'Relative Strength Index' },
    ]);
    expect(other.getAllShapes()).toEqual([{ id: 'C1SHAPE1', name: 'trend_line' }]);
    expect(other.getPanes().map(paneOf)).toEqual([
      {
        index: 0,
        height: 400,
        hasMainSeries: true,
        entities: [
          { id: 'MAINSERIES', name: 'Main Series' },
          { id: 'C1STUDY1', name: 'Volume' },
          { id: 'C1SHAPE1', name: 'trend_line' },
        ],
      },
      {
        index: 1,
        height: 200,
        hasMainSeries: false,
        entities: [{ id: 'C1STUDY2', name: 'Relative Strength Index' }],
      },
    ]);
    expect(other.getPanes()[0]?.getAllEntities()).not.toBe(other.getPanes()[0]?.getAllEntities());
    expect(other.symbol()).not.toBe(apiOf(win).chart(0).symbol());
  });

  test('an other chart has the main series of its symbol, and throws for what the fake does not model', async () => {
    const other = apiOf(windowWith(twoCharts)).chart(1);
    const series = other._chartWidget.model().mainSeries();

    expect(series.symbolInfo()).toMatchObject({
      name: 'MSFT',
      full_name: 'NASDAQ:MSFT',
      pro_name: 'NASDAQ:MSFT',
    });
    expect([series.isSymbolInvalid(), series.interval()]).toEqual([false, '60']);
    expect(series.bars().size()).toBe(fixture.bars.count);
    await expect(other.dataReady()).resolves.toBe(true);
    expect(() => other.getVisibleRange()).toThrow(/not modeled on the other charts/);
    expect(() => other._chartWidget.model().model().timeScale()).toThrow(/not modeled/);
  });

  test('a chart the layout hides is out of reach, and a layout that counts more charts than the fixture declares reaches chart 0 alone', () => {
    const hidden = apiOf(windowWith(oneShownOfTwo));
    const undeclared = apiOf(
      windowWith({ ...fixture, layout: { ...fixture.layout, chartsCount: 2 } }),
    );

    expect(hidden.chartsCount()).toBe(1);
    expect(() => hidden.chart(1)).toThrow(new Error('Incorrect index: 1'));
    expect(undeclared.chartsCount()).toBe(2);
    expect(() => undeclared.chart(1)).toThrow(new Error('Incorrect index: 1'));
  });
});

describe('the active chart', () => {
  test('setActiveChart makes a chart of the layout the active one, which activeChart() then answers', () => {
    const win = windowWith(twoCharts);
    const api = apiOf(win);

    api.setActiveChart(1);

    expect(api.activeChartIndex()).toBe(1);
    expect(api.activeChart()).toBe(api.chart(1));
    expect(calls(win, 'TradingViewApi.setActiveChart')).toEqual([[1]]);
  });

  test('setActiveChart ignores an index the layout does not show, as the app does', () => {
    const win = windowWith(twoCharts);
    const api = apiOf(win);

    for (const index of [2, -1, 0.5]) {
      api.setActiveChart(index);
    }

    expect(api.activeChartIndex()).toBe(0);
    expect(calls(win, 'TradingViewApi.setActiveChart')).toEqual([[2], [-1], [0.5]]);
  });

  test('activeChart() answers chart 0 while the active index names a chart the fixture does not declare', () => {
    const win = windowWith({ ...fixture, layout: { ...fixture.layout, chartsCount: 2 } });
    const api = apiOf(win);

    api.setActiveChart(1);

    expect(api.activeChartIndex()).toBe(1);
    expect(api.activeChart()).toBe(api.chart(0));
  });
});

describe('the symbol of an other chart', () => {
  test('setSymbol records itself, makes the chart the active one and runs dataReady', async () => {
    const win = windowWith(twoCharts);
    const other = apiOf(win).chart(1);
    let ready = false;

    await other.setSymbol('NASDAQ:NVDA', { dataReady: () => (ready = true) });
    await delay(1);

    expect([other.symbol(), ready]).toEqual(['NASDAQ:NVDA', true]);
    expect(apiOf(win).activeChartIndex()).toBe(1);
    expect(apiOf(win).chart(0).symbol()).toBe('NASDAQ:AAPL');
    expect(calls(win, 'chart(1).setSymbol')).toEqual([
      ['NASDAQ:NVDA', { dataReady: expect.any(Function) as unknown }],
    ]);
    expect(calls(win, 'chart.setSymbol')).toEqual([]);
  });

  test('setSymbol and setResolution leave the active chart alone with doNotActivateChart', async () => {
    const win = windowWith(twoCharts);
    const other = apiOf(win).chart(1);

    await other.setSymbol('NASDAQ:NVDA', { doNotActivateChart: true });
    await other.setResolution('240', { doNotActivateChart: true });

    expect([other.symbol(), other.resolution()]).toEqual(['NASDAQ:NVDA', '240']);
    expect(apiOf(win).activeChartIndex()).toBe(0);
    await other.setResolution('1D');
    expect(apiOf(win).activeChartIndex()).toBe(1);
    expect(calls(win, 'chart(1).setResolution')).toEqual([
      ['240', { doNotActivateChart: true }],
      ['1D'],
    ]);
  });

  test('an unknown symbol flags the series, which has no data then, and never reports data ready', async () => {
    const other = apiOf(windowWith(twoCharts)).chart(1);
    let ready = false;

    await other.setSymbol('NOSUCH:SYMBOL', { dataReady: () => (ready = true) });

    const series = other._chartWidget.model().mainSeries();
    expect(other.symbol()).toBe('NOSUCH:SYMBOL');
    expect([series.isSymbolInvalid(), series.symbolInfo(), series.bars().size()]).toEqual([
      true,
      null,
      0,
    ]);
    expect(await settlesSoon(other.dataReady())).toBe(false);
    expect(ready).toBe(false);
  });

  test('a symbol shown through its data feed is renamed to the feed once resolved, as on chart 0', async () => {
    const other = apiOf(windowWith(twoCharts, { feeds: { 'NASDAQ:NVDA': 'BATS:NVDA' } })).chart(1);

    await other.setSymbol('NASDAQ:NVDA');
    await delay(1);

    expect(other.symbol()).toBe('BATS:NVDA');
    expect(other._chartWidget.model().mainSeries().symbolInfo()).toMatchObject({
      full_name: 'BATS:NVDA',
      pro_name: 'NASDAQ:NVDA',
    });
  });

  test('with symbol sync, a symbol set on one chart is set on every chart the layout shows, without calls of their own', async () => {
    const synced: TvStateFixture = {
      ...twoCharts,
      charts: { ...twoCharts.charts, symbolSync: true },
    };
    const win = windowWith(synced);
    const api = apiOf(win);

    await api.chart(1).setSymbol('NASDAQ:NVDA', { doNotActivateChart: true });

    expect([api.chart(0).symbol(), api.chart(1).symbol()]).toEqual(['NASDAQ:NVDA', 'NASDAQ:NVDA']);
    expect(callNames(win)).toEqual(['chart(1).setSymbol']);

    await api.chart(0).setSymbol('NYSE:IBM');

    expect([api.chart(0).symbol(), api.chart(1).symbol()]).toEqual(['NYSE:IBM', 'NYSE:IBM']);
    expect(callNames(win)).toEqual(['chart(1).setSymbol', 'chart.setSymbol']);
  });

  test('without symbol sync, a symbol set on one chart stays on it', async () => {
    const api = apiOf(windowWith(twoCharts));

    await api.chart(0).setSymbol('NYSE:IBM');

    expect([api.chart(0).symbol(), api.chart(1).symbol()]).toEqual(['NYSE:IBM', 'NASDAQ:MSFT']);
  });
});

describe('setLayout', () => {
  test('records itself with its arguments as given and returns nothing', () => {
    const win = windowWith(withChartLimit(2, fixture));
    // Typed to answer something, so that what it answers can be looked at.
    const api: { setLayout(...args: unknown[]): unknown } = apiOf(win);

    expect(api.setLayout('2h', { withUndo: true })).toBeUndefined();

    expect(calls(win, 'TradingViewApi.setLayout')).toEqual([['2h', { withUndo: true }]]);
  });

  test('a layout within the plan is shown a moment later, with new charts on the symbol of the active chart that get their data after that', async () => {
    const win = windowWith(withChartLimit(2, fixture), { charts: { layoutMs: 10, dataMs: 30 } });
    const api = apiOf(win);

    api.setLayout('2h', { withUndo: true });

    expect(layoutOf(win)).toEqual({ layout: 's', chartsCount: 1, active: 0 });
    await delay(20);
    expect(layoutOf(win)).toEqual({ layout: '2h', chartsCount: 2, active: 0 });
    const added = api.chart(1);
    expect([added.symbol(), added.resolution(), added.getAllStudies()]).toEqual([
      'NASDAQ:AAPL',
      '1D',
      [],
    ]);
    expect(added.getPanes().map(paneOf)).toEqual([
      {
        index: 0,
        height: 600,
        hasMainSeries: true,
        entities: [{ id: 'MAINSERIES', name: 'Main Series' }],
      },
    ]);
    expect(await settlesSoon(added.dataReady())).toBe(true);
    expect(paywalls(win)).toEqual([]);
  });

  test('the data of a new chart never comes with a data time of Infinity', async () => {
    const win = windowWith(withChartLimit(2, fixture), { charts: { dataMs: Infinity } });

    apiOf(win).setLayout('2h', { withUndo: true });
    await delay(SETTLE_MS);

    expect(await settlesSoon(apiOf(win).chart(1).dataReady())).toBe(false);
  });

  test('with withUndo the layout shown already changes nothing', async () => {
    const win = windowWith(twoCharts);

    apiOf(win).setLayout('2h', { withUndo: true });
    await delay(SETTLE_MS);

    expect(layoutOf(win)).toEqual({ layout: '2h', chartsCount: 2, active: 0 });
    expect(callNames(win)).toEqual(['TradingViewApi.setLayout']);
  });

  test('with withUndo a layout beyond the plan, while the layout holds more charts than the plan allows, opens the paywall and changes nothing', async () => {
    // The plan allows one chart, and the layout holds two.
    const win = windowWith(twoCharts);

    apiOf(win).setLayout('3h', { withUndo: true });
    await delay(SETTLE_MS);

    expect(paywalls(win)).toEqual([['PAYWALL_MULTIPLE_CHARTS', { limit: 3 }]]);
    expect(layoutOf(win)).toEqual({ layout: '2h', chartsCount: 2, active: 0 });
  });

  test('with withUndo a layout beyond the plan opens the paywall and shows the largest layout the plan allows instead', async () => {
    const win = windowWith(withChartLimit(2, fixture));

    apiOf(win).setLayout('3h', { withUndo: true });
    await delay(SETTLE_MS);

    expect(paywalls(win)).toEqual([['PAYWALL_MULTIPLE_CHARTS', { limit: 3 }]]);
    expect(layoutOf(win)).toEqual({ layout: '2h', chartsCount: 2, active: 0 });
  });

  test('on a plan of one chart a multi-chart layout opens the paywall, and the layout stays a single chart', async () => {
    const win = windowWith();

    apiOf(win).setLayout('2h', { withUndo: true });
    await delay(SETTLE_MS);

    expect(paywalls(win)).toEqual([['PAYWALL_MULTIPLE_CHARTS', { limit: 2 }]]);
    expect(layoutOf(win)).toEqual({ layout: 's', chartsCount: 1, active: 0 });
  });

  test('the plan limit is the app formula: off is one chart, a configuration without a limit one, and a limit below one one', async () => {
    const configured = (config: Record<string, number>): TvStateFixture => ({
      ...fixture,
      planConfigs: { ...fixture.planConfigs, MULTIPLE_CHARTS: config },
    });
    for (const from of [fixture, configured({}), withChartLimit(0, fixture)]) {
      const win = windowWith(from);

      apiOf(win).setLayout('2v', { withUndo: true });
      await delay(SETTLE_MS);

      expect(paywalls(win)).toEqual([['PAYWALL_MULTIPLE_CHARTS', { limit: 2 }]]);
      expect(apiOf(win).layout()).toBe('s');
    }
    const roomy = windowWith(configured({ limit: 4 }));
    apiOf(roomy).setLayout('4', { withUndo: true });
    await delay(SETTLE_MS);
    expect([paywalls(roomy), apiOf(roomy).chartsCount()]).toEqual([[], 4]);
  });

  test('with withUndo a type the table does not know changes nothing', async () => {
    const win = windowWith(withChartLimit(4, fixture));

    apiOf(win).setLayout('nope', { withUndo: true });
    await delay(SETTLE_MS);

    expect(layoutOf(win)).toEqual({ layout: 's', chartsCount: 1, active: 0 });
  });

  test('without withUndo an unknown type becomes a single chart', async () => {
    const win = windowWith(twoCharts);

    apiOf(win).setLayout('nope');
    await delay(SETTLE_MS);

    expect(layoutOf(win)).toEqual({ layout: 's', chartsCount: 1, active: 0 });
  });

  test('without withUndo a layout beyond the plan whose charts the layout holds is shown locked, with the count of the plan and no paywall', async () => {
    const win = windowWith(twoCharts);

    apiOf(win).setLayout('2v');
    await delay(SETTLE_MS);

    expect(layoutOf(win)).toEqual({ layout: '2v', chartsCount: 1, active: 0 });
    expect(paywalls(win)).toEqual([]);
  });

  test('without withUndo a layout beyond the plan otherwise opens the paywall and shows the largest one the plan allows', async () => {
    const win = windowWith(withChartLimit(2, fixture));

    apiOf(win).setLayout('4');
    await delay(SETTLE_MS);

    expect(paywalls(win)).toEqual([['PAYWALL_MULTIPLE_CHARTS', { limit: 4 }]]);
    expect(layoutOf(win)).toEqual({ layout: '2h', chartsCount: 2, active: 0 });
  });

  test('a smaller layout hides the charts beyond its count and keeps them, so a larger one shows them again', async () => {
    const win = windowWith(withChartLimit(2, twoCharts));
    const api = apiOf(win);
    api.setActiveChart(1);

    api.setLayout('s', { withUndo: true });
    await delay(SETTLE_MS);

    // The active chart was hidden, so the last chart the layout shows is the active one.
    expect(layoutOf(win)).toEqual({ layout: 's', chartsCount: 1, active: 0 });
    expect(() => api.chart(1)).toThrow(new Error('Incorrect index: 1'));

    api.setLayout('2v', { withUndo: true });
    await delay(SETTLE_MS);

    expect(layoutOf(win)).toEqual({ layout: '2v', chartsCount: 2, active: 0 });
    expect(api.chart(1).symbol()).toBe('NASDAQ:MSFT');
    expect(paywalls(win)).toEqual([]);
  });
});

describe('the table of layouts', () => {
  const tableOf = (win: FakeTvWindow) =>
    exportsOf(win).layouts as Record<string, { title: string; count: number; layoutType: string }>;

  test('the default cache holds the table of the 55 layouts of the app, with the helpers of its module', () => {
    const win = windowWith();
    const found = exportsOf(win);
    const table = tableOf(win);

    expect(Object.keys(table)).toHaveLength(55);
    expect(table['2h']).toEqual({ title: '2 charts', count: 2, layoutType: '2h' });
    expect(table.s?.count).toBe(1);
    expect(table['16c4']?.count).toBe(16);
    expect(typeof found.isMultipleLayout).toBe('function');
    expect(typeof found.isSupportedLayout).toBe('function');
    expect(typeof found.tryGuessingTheMostSuitableLayout).toBe('function');
    const isMultiple = found.isMultipleLayout as (code: string) => boolean;
    const isSupported = found.isSupportedLayout as (code: string) => boolean;
    expect([isMultiple('s'), isMultiple('2h'), isSupported('2h'), isSupported('nope')]).toEqual([
      false,
      true,
      true,
      false,
    ]);
  });

  test('the charts option leaves codes out of the table, which setLayout then does not know either', async () => {
    const win = windowWith(withChartLimit(4, twoCharts), { charts: { withoutCodes: ['2-2-l'] } });

    expect(tableOf(win)['2-2-l']).toBeUndefined();
    expect(Object.keys(tableOf(win))).toHaveLength(54);
    apiOf(win).setLayout('2-2-l');
    await delay(SETTLE_MS);
    expect(apiOf(win).layout()).toBe('s');
  });

  test('the charts option can leave the module out of the cache', () => {
    const win = windowWith(fixture, { charts: { withoutLayoutTable: true } });

    expect(exportsOf(win).layouts).toBeUndefined();
    expect(exportsOf(win).isMultipleLayout).toBeUndefined();
  });
});
