import { setTimeout as delay } from 'node:timers/promises';
import { loadTvFixture, type TvStateFixture } from '../../helpers/fake-tv/fixture.js';
import type { FakePlotItem } from '../../helpers/fake-tv/studies.js';
import { syntheticBars } from '../../helpers/fake-tv/synthetic-bars.js';
import type { FakeWebpackRequire } from '../../helpers/fake-tv/webpack.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTvOverrides,
  type FakeTvWindow,
} from '../../helpers/fake-tv/window.js';

// The studies on the fake chart and the indicator catalog of the fake app (studies.ts), checked
// against the shapes the reverse-engineering notes record for the app. Values are synthetic.

const fixture = loadTvFixture();
const bars = syntheticBars(fixture.bars);
const DAY = 86_400;

function chartOf(win: FakeTvWindow) {
  const api = win.TradingViewApi;
  if (api === undefined) {
    throw new Error('The fake window has no TradingViewApi');
  }
  return api.activeChart();
}

// The exports of the default webpack cache, by name.
function exportsOf(win: FakeTvWindow): Record<string, unknown> {
  let handed: FakeWebpackRequire | undefined;
  (win.webpackChunktradingview as { push(chunk: unknown): unknown }).push([
    ['probe'],
    {},
    (given: FakeWebpackRequire) => (handed = given),
  ]);
  const found: Record<string, unknown> = {};
  for (const record of Object.values(handed?.c ?? {})) {
    Object.assign(found, record.exports);
  }
  return found;
}

interface Repository {
  isReady(): boolean;
  getInternalMetaInfoArray(): Record<string, unknown>[];
  findAllJavaStudies(): Promise<Record<string, unknown>[]>;
}

function catalogOf(overrides: FakeTvOverrides = {}) {
  const win = createFakeTvWindow(fixture, overrides);
  const found = exportsOf(win);
  return {
    win,
    repository: (found.studyMetaInfoRepository as () => Repository)(),
    requestBuiltinScripts: found.requestBuiltinScripts as () => Promise<unknown>,
  };
}

describe('studies on the chart', () => {
  test('getStudyById answers the API of a study, and throws for an id not on the chart', () => {
    const chart = chartOf(createFakeTvWindow(fixture));

    const api = chart.getStudyById('STUDY02');

    expect(api.title()).toBe('RSI 14 close');
    expect(api.isVisible()).toBe(false);
    expect(chart.getStudyById('STUDY01').isVisible()).toBe(true);
    expect(api.study().id()).toBe('STUDY02');
    expect(api.study()).toBe(api.study());
    expect(() => chart.getStudyById('NOPE')).toThrow(new Error('There is no such study'));
  });

  test('a Pine study has the hidden internals in front of its inputs, and values by input id', () => {
    const api = chartOf(createFakeTvWindow(fixture)).getStudyById('STUDY02');

    const info = api.getInputsInfo();

    expect(info.map(({ id, isHidden }) => [id, isHidden ?? false])).toEqual([
      ['text', true],
      ['pineId', true],
      ['pineVersion', true],
      ['in_0', false],
      ['in_1', false],
      ['in_2', false],
    ]);
    expect(info[5]).toEqual({
      id: 'in_2',
      name: 'Type',
      localizedName: 'Type',
      type: 'text',
      defval: 'SMA',
      options: ['None', 'SMA', 'EMA'],
      isFake: true,
    });
    expect(api.getInputValues()).toEqual([
      { id: 'text', value: 'synthetic-script-blob' },
      { id: 'pineId', value: 'STD;RSI' },
      { id: 'pineVersion', value: '41.0' },
      { id: 'in_0', value: 14 },
      { id: 'in_1', value: 'close' },
      { id: 'in_2', value: 'SMA' },
    ]);
  });

  test('metaInfo describes the plots, their titles and the Pine script', () => {
    const meta = chartOf(createFakeTvWindow(fixture)).getStudyById('STUDY02').study().metaInfo();

    expect(meta).toMatchObject({
      id: 'Script$STD;RSI@tv-scripting',
      description: 'Relative Strength Index',
      plots: [
        { id: 'plot_0', type: 'line' },
        { id: 'plot_1', type: 'line' },
        { id: 'plot_2', type: 'bg_colorer' },
      ],
      styles: { plot_0: { title: 'RSI' }, plot_1: { title: 'RSI-based MA' } },
      ohlcPlots: {},
      pine: { version: '41.0', digest: 'synthetic-digest' },
      scriptIdPart: 'STD;RSI',
      isTVScript: true,
    });
  });

  test('a built-in study has no pine and no hidden inputs, and a strategy carries its flags', () => {
    const custom: TvStateFixture = {
      ...fixture,
      studies: [
        { id: 'S1', name: 'Volume', plots: ['plot_0'], inputs: [] },
        {
          id: 'S2',
          name: 'RSI Strategy',
          plots: [],
          strategy: true,
          pine: { scriptIdPart: 'STD;RSI%1Strategy', version: '12.0' },
        },
      ],
    };
    const chart = chartOf(createFakeTvWindow(custom));

    const builtin = chart.getStudyById('S1');
    const strategy = chart.getStudyById('S2').study();

    expect(builtin.study().metaInfo()).not.toHaveProperty('pine');
    expect(builtin.study().metaInfo().id).toBe('Volume@tv-basicstudies');
    expect(builtin.getInputsInfo()).toEqual([]);
    expect(builtin.title()).toBe('Volume');
    expect(builtin.study()).not.toHaveProperty('isStudyStrategy');
    expect(strategy.isStudyStrategy).toBe(true);
    expect(
      ['strategyOrdersPaneView', 'ordersData', 'reportData'].every((key) => key in strategy),
    ).toBe(true);
  });

  test('the rows follow the bars, after the pre-history rows, with NaN before the warmup', () => {
    const data = chartOf(createFakeTvWindow(fixture)).getStudyById('STUDY02').study().data();

    expect(data.size()).toBe(305);
    expect(data.firstIndex()).toBe(-1_000_005);
    expect(data.firstPlottableIndex()).toBe(0);
    expect(data.lastIndex()).toBe(299);
    const firstClose = bars[0]?.[4] ?? 0;
    // Pre-history rows carry real values, at times before the first bar.
    expect(data.valueAt(-1_000_001)).toEqual([
      (bars[0]?.[0] ?? 0) - DAY,
      firstClose,
      Math.round((firstClose + 1) * 100) / 100,
      0,
    ]);
    expect(data.valueAt(-1_000_005)?.[0]).toBe((bars[0]?.[0] ?? 0) - 5 * DAY);
    expect(data.valueAt(0)).toEqual([bars[0]?.[0], NaN, NaN, 0]);
    const last = bars[299];
    expect(data.valueAt(299)).toEqual([
      last?.[0],
      last?.[4],
      Math.round(((last?.[4] ?? 0) + 1) * 100) / 100,
      0,
    ]);
    expect(data.valueAt(12)?.[1]).toBeNaN();
    expect(data.valueAt(13)?.[1]).toBe(bars[13]?.[4]);
    expect(data.valueAt(0.5)).toBeNull();
    expect(data.first()?.index).toBe(-1_000_005);
    expect(data.last()?.index).toBe(299);
  });

  test('search finds the row at, before or after an index, and rangeIterator yields items', () => {
    const data = chartOf(createFakeTvWindow(fixture)).getStudyById('STUDY01').study().data();

    expect(data.search(10)?.index).toBe(10);
    expect(data.search(500)).toBeNull();
    expect(data.search(500, -1)?.index).toBe(299);
    expect(data.search(-5, 1)?.index).toBe(0);
    expect(data.search(-5, -1)).toBeNull();
    const items: FakePlotItem[] = [...data.rangeIterator(297, 400)];
    expect(items.map(({ index }) => index)).toEqual([297, 298, 299]);
    expect(items[2]?.value).toEqual(data.valueAt(299));
  });

  test('ohlc plots hold the prices of the bar, and plots without values hold nothing', () => {
    const custom: TvStateFixture = {
      ...fixture,
      studies: [
        {
          id: 'S1',
          name: 'Candles',
          plots: [
            { id: 'plot_0', type: 'ohlc_open', target: 'plotcandle_0' },
            { id: 'plot_1', type: 'ohlc_high', target: 'plotcandle_0' },
            { id: 'plot_2', type: 'ohlc_low', target: 'plotcandle_0' },
            { id: 'plot_3', type: 'ohlc_close', target: 'plotcandle_0' },
            { id: 'plot_4', type: 'alertcondition' },
            { id: 'plot_5', type: 'dataoffset' },
          ],
          ohlcPlots: { plotcandle_0: 'Candles' },
        },
      ],
    };
    const study = chartOf(createFakeTvWindow(custom)).getStudyById('S1').study();
    const bar = bars[5];

    expect(study.data().valueAt(5)).toEqual([...(bar ?? []).slice(0, 5), undefined, undefined]);
    expect(study.metaInfo().ohlcPlots).toEqual({ plotcandle_0: { title: 'Candles' } });
  });

  test('the rows grow with older history and vanish while the symbol is unknown', async () => {
    const win = createFakeTvWindow({
      ...fixture,
      history: { totalBars: 310, endOfDataType: 'end' },
    });
    const chart = chartOf(win);
    chart._chartWidget.model().mainSeries().requestMoreData(10);
    await delay(30);

    const data = chart.getStudyById('STUDY01').study().data();
    expect(data.lastIndex()).toBe(309);
    expect(data.valueAt(10)?.[0]).toBe(bars[0]?.[0]);

    await chart.setSymbol('NOPE:NOPE');
    expect(chart.getStudyById('STUDY02').study().data().size()).toBe(0);
  });
});

describe('the indicator catalog', () => {
  test('the study repository is ready and holds the built-in metadata, hidden ones flagged', async () => {
    const { win, repository } = catalogOf();

    expect(repository.isReady()).toBe(true);
    const items = repository.getInternalMetaInfoArray();
    expect(items.map(({ id }) => id)).toEqual(fixture.studyCatalog.builtins.map(({ id }) => id));
    expect(items[1]).toMatchObject({
      id: 'RSI@tv-basicstudies',
      description: 'Relative strength index',
      shortDescription: 'RSI',
      is_hidden_study: true,
    });
    expect(items[0]).not.toHaveProperty('is_hidden_study');
    expect(await repository.findAllJavaStudies()).toBe(items);
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('a repository that is not ready requests its metadata in findAllJavaStudies', async () => {
    const { win, repository } = catalogOf({ studyRepositoryReady: false });

    expect(repository.isReady()).toBe(false);
    expect(repository.getInternalMetaInfoArray()).toEqual([]);
    expect(await repository.findAllJavaStudies()).toHaveLength(4);
    expect(repository.isReady()).toBe(true);
    expect(inspectFakeWindow(win).callsTo('studyMetaInfoRepository.requestMetaInfo')).toEqual([[]]);
  });

  test('requestBuiltinScripts answers the standard scripts with their kind and short name in extra, and records itself', async () => {
    const { win, requestBuiltinScripts } = catalogOf();

    const scripts = (await requestBuiltinScripts()) as Record<string, unknown>[];

    expect(scripts).toHaveLength(5);
    expect(scripts[1]).toEqual({
      scriptIdPart: 'STD;RSI',
      scriptName: 'Relative Strength Index',
      version: '41.0',
      extra: { kind: 'study', shortDescription: 'RSI' },
    });
    expect(inspectFakeWindow(win).callsTo('requestBuiltinScripts')).toEqual([[]]);
  });

  test('requestBuiltinScripts rejects with the error it is given', async () => {
    const { requestBuiltinScripts } = catalogOf({ builtinScriptsError: 'Network error' });

    await expect(requestBuiltinScripts()).rejects.toThrow('Network error');
  });
});

describe('changes to the studies', () => {
  // A chart with room for `limit` counted studies; the fixture holds two.
  const roomy = (limit = 5): TvStateFixture => ({
    ...fixture,
    planLimits: { ...fixture.planLimits, INDICATORS_ON_CHART: limit },
  });
  const dialogsOf = (win: FakeTvWindow) =>
    inspectFakeWindow(win).calls.filter(({ name }) => name.startsWith('dialog.'));

  test('createStudy by description adds the first built-in of that description, with its inputs', async () => {
    const win = createFakeTvWindow(roomy());
    const chart = chartOf(win);

    const id = await chart.createStudy('volume', true, false, undefined, undefined, {
      checkLimit: true,
    });

    expect(id).toBe('NEW001');
    expect(chart.getAllStudies().at(-1)).toEqual({ id: 'NEW001', name: 'Volume' });
    const api = chart.getStudyById('NEW001');
    expect(api.study().metaInfo().id).toBe('Volume@tv-basicstudies');
    expect(api.title()).toBe('Vol');
    expect(api.getInputValues()).toEqual([
      { id: 'length', value: 20 },
      { id: 'col_prev_close', value: false },
      { id: 'symbol', value: '' },
    ]);
    expect(api.getInputsInfo()[0]).toEqual({
      id: 'length',
      name: 'MA Length',
      localizedName: 'MA Length',
      type: 'integer',
      defval: 20,
      min: 1,
      max: 2000,
    });
    expect(inspectFakeWindow(win).callsTo('chart.createStudy')).toEqual([
      ['volume', true, false, undefined, undefined, { checkLimit: true }],
    ]);
    // The first match counts, even when it is hidden.
    await chart.createStudy('Relative Strength Index');
    expect(chart.getStudyById('NEW002').study().metaInfo().id).toBe('RSI@tv-basicstudies');
    await expect(chart.createStudy('No Such Study')).rejects.toThrow(
      'unexpected study id:no such study',
    );
  });

  test('createStudy by description with checkLimit shows the limit warning and resolves null', async () => {
    const win = createFakeTvWindow(fixture);
    const chart = chartOf(win);

    const refused = await chart.createStudy(
      'Relative Strength Index',
      false,
      false,
      undefined,
      undefined,
      {
        checkLimit: true,
      },
    );

    expect(refused).toBeNull();
    expect(dialogsOf(win)).toEqual([{ name: 'dialog.tooManyStudies', args: [2] }]);
    expect(chart.getAllStudies()).toHaveLength(2);
    // A study the app does not count passes, and without checkLimit nothing on the client blocks.
    expect(
      await chart.createStudy('Volume', false, false, undefined, undefined, { checkLimit: true }),
    ).toBe('NEW001');
    expect(await chart.createStudy('Relative Strength Index')).toBe('NEW002');
  });

  test('createStudy with a descriptor adds a standard script or a built-in and ignores the rest', async () => {
    const win = createFakeTvWindow(roomy());
    const chart = chartOf(win);

    const pine = await chart.createStudy({ type: 'pine', pineId: 'STD;MACD', pineVersion: 'last' });
    const java = await chart.createStudy({ type: 'java', studyId: 'VbPFixed@tv-volumebyprice' });

    expect([pine, java]).toEqual(['NEW001', 'NEW002']);
    const macd = chart.getStudyById('NEW001');
    expect(chart.getAllStudies().slice(2)).toEqual([
      { id: 'NEW001', name: 'Moving Average Convergence Divergence' },
      { id: 'NEW002', name: 'Volume Profile Fixed Range' },
    ]);
    expect(macd.study().metaInfo()).toMatchObject({
      pine: { version: '28.0' },
      scriptIdPart: 'STD;MACD',
    });
    expect(macd.getInputsInfo().filter(({ isHidden }) => isHidden !== true)).toHaveLength(4);
    expect(chart.getStudyById('NEW002').study().metaInfo().id).toBe('VbPFixed@tv-volumebyprice');
    await expect(
      chart.createStudy({ type: 'pine', pineId: 'STD;Nope', pineVersion: '1.0' }),
    ).rejects.toBe('cannot_get_metainfo');
    expect(dialogsOf(win)).toEqual([]);
  });

  test('createStudy with a descriptor opens the paywall on a full chart and rejects', async () => {
    const win = createFakeTvWindow(fixture);

    await expect(
      chartOf(win).createStudy({ type: 'pine', pineId: 'STD;MACD', pineVersion: '28.0' }),
    ).rejects.toBe('Failed to create study');

    expect(dialogsOf(win)).toEqual([{ name: 'dialog.paywall', args: ['studyLimit'] }]);
  });

  test('createStudy with a descriptor waits on the inputs dialog for studies that need one', async () => {
    const custom = roomy();
    custom.studyCatalog = {
      ...custom.studyCatalog,
      builtins: [
        { id: 'Spread@tv-basicstudies', description: 'Spread', shortDescription: 'Spread' },
        {
          id: 'Anchored@tv-basicstudies',
          description: 'Anchored',
          shortDescription: 'Anchored',
          inputs: [{ id: 'start', name: 'Start', type: 'time', value: 0, confirm: true }],
        },
      ],
    };
    const win = createFakeTvWindow(custom);
    const chart = chartOf(win);

    const outcomes = await Promise.race([
      Promise.allSettled([
        chart.createStudy({ type: 'java', studyId: 'Spread@tv-basicstudies' }),
        chart.createStudy({ type: 'java', studyId: 'Anchored@tv-basicstudies' }),
      ]),
      delay(30).then(() => 'pending'),
    ]);

    expect(outcomes).toBe('pending');
    expect(dialogsOf(win)).toEqual([
      { name: 'dialog.studyInputs', args: ['Spread@tv-basicstudies'] },
      { name: 'dialog.studyInputs', args: ['Anchored@tv-basicstudies'] },
    ]);
    expect(chart.getAllStudies()).toHaveLength(2);
  });

  test('canCreateStudy counts the studies against the limit, apart from those the app does not count', async () => {
    const win = createFakeTvWindow(roomy(3));
    const chart = chartOf(win);
    const model = chart._chartWidget.model();

    expect(model.canCreateStudy?.({ id: '' })).toEqual({ success: true });
    await chart.createStudy('Volume');
    expect(model.canCreateStudy?.({ id: '' })).toEqual({ success: true });
    await chart.createStudy('Relative Strength Index');
    expect(model.canCreateStudy?.({ id: '' })).toEqual({
      success: false,
      reason: 'general',
      limitValue: 3,
    });
    expect(model.canCreateStudy?.({ id: 'VbPFixed@tv-volumebyprice' })).toEqual({ success: true });
    expect(inspectFakeWindow(win).callsTo('chart.createStudy')).toHaveLength(2);
  });

  test('createStudy asks the canCreateStudy of the model, which a test can replace', async () => {
    const win = createFakeTvWindow(roomy());
    const chart = chartOf(win);
    chart._chartWidget.model().canCreateStudy = () => ({ success: false, reason: 'forecast' });

    // A forecast refusal passes checkLimit on the string path, and fails the descriptor path
    // without the paywall.
    expect(
      await chart.createStudy('Volume', false, false, undefined, undefined, { checkLimit: true }),
    ).toBe('NEW001');
    await expect(
      chart.createStudy({ type: 'pine', pineId: 'STD;MACD', pineVersion: '28.0' }),
    ).rejects.toBe('Failed to create study');
    expect(dialogsOf(win)).toEqual([]);
  });

  test('removeEntity removes a study undoably, and does nothing for an id not on the chart', () => {
    const win = createFakeTvWindow(fixture);
    const chart = chartOf(win);

    chart.removeEntity('STUDY01');
    chart.removeEntity('NOPE01');
    chart.removeEntity('STUDY02', { disableUndo: true });

    expect(chart.getAllStudies()).toEqual([]);
    expect(() => chart.getStudyById('STUDY01')).toThrow('There is no such study');
    expect(inspectFakeWindow(win).state.removedStudies).toEqual([
      { id: 'STUDY01', undoable: true },
      { id: 'STUDY02', undoable: false },
    ]);
    expect(inspectFakeWindow(win).callsTo('chart.removeEntity')).toEqual([
      ['STUDY01'],
      ['NOPE01'],
      ['STUDY02', { disableUndo: true }],
    ]);
  });

  test('setInputValues sets the inputs it has and setVisible shows or hides the study', () => {
    const win = createFakeTvWindow(fixture);
    const api = chartOf(win).getStudyById('STUDY01');

    api.setInputValues([
      { id: 'in_0', value: 21 },
      { id: 'nope', value: 1 },
    ]);
    api.setVisible(false);

    expect(api.getInputValues().find(({ id }) => id === 'in_0')).toEqual({ id: 'in_0', value: 21 });
    expect(api.isVisible()).toBe(false);
    expect(inspectFakeWindow(win).calls).toEqual([
      {
        name: 'study.setInputValues',
        args: [
          'STUDY01',
          [
            { id: 'in_0', value: 21 },
            { id: 'nope', value: 1 },
          ],
        ],
      },
      { name: 'study.setVisible', args: ['STUDY01', false] },
    ]);
  });
});
