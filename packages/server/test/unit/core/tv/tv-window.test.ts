import type { ReplayApiLike, TvWindow } from '../../../../src/core/tv/tv-window.js';
import { loadTvFixture } from '../../../helpers/fake-tv/fixture.js';
import { syntheticBars } from '../../../helpers/fake-tv/synthetic-bars.js';
import { createFakeTvWindow, inspectFakeWindow } from '../../../helpers/fake-tv/window.js';
import { SAMPLE_STRATEGY, withStudies } from '../../../helpers/strategy-fixtures.js';

// Page functions are written against TvWindow and tested against the shared fake window. These
// tests fail to compile when the two drift apart, and walk the paths page code takes through the
// contract to show that the fake answers on each of them.

describe('the TvWindow contract', () => {
  const fixture = loadTvFixture();

  test('is satisfied by the shared fake window, on every path the contract describes', () => {
    const win: TvWindow = createFakeTvWindow(fixture);
    const bars = syntheticBars(fixture.bars);

    const api = win.TradingViewApi;
    const chart = api?.activeChart();
    const model = chart?._chartWidget?.model();
    const series = model?.mainSeries();
    const timeScale = model?.model().timeScale();

    expect(api?.chart(0)).toBe(chart);
    expect([api?.chartsCount(), api?.activeChartIndex(), api?.isConnected()]).toEqual([1, 0, true]);
    expect([api?.layout(), api?.layoutName(), api?.layoutId()]).toEqual([
      fixture.layout.type,
      fixture.layout.name,
      fixture.layout.id,
    ]);
    expect(api?.getIntervals()).toEqual(fixture.intervals);
    expect([chart?.symbol(), chart?.resolution(), chart?.chartType()]).toEqual([
      fixture.symbol,
      fixture.resolution,
      fixture.chartType,
    ]);
    expect(chart?.getVisibleRange()).toEqual(fixture.visibleRange);
    expect(chart?.getAllStudies()).toHaveLength(fixture.studies.length);
    expect(chart?.getAllShapes()).toHaveLength(fixture.shapes.length);
    const study = chart?.getStudyById('STUDY02');
    const core = study?.study();
    const rows = core?.data();
    expect([study?.title(), study?.isVisible()]).toEqual(['RSI 14 close', false]);
    expect(study?.getInputsInfo().filter(({ isHidden }) => isHidden !== true)).toHaveLength(3);
    expect(study?.getInputValues()).toHaveLength(6);
    expect([core?.id(), core?.isStudyStrategy, core?.metaInfo().pine?.version]).toEqual([
      'STUDY02',
      undefined,
      '41.0',
    ]);
    expect(core?.metaInfo().plots?.map(({ type }) => type)).toEqual(['line', 'line', 'bg_colorer']);
    expect([rows?.firstPlottableIndex(), rows?.lastIndex()]).toEqual([0, bars.length - 1]);
    expect(rows?.valueAt(0)?.[0]).toBe(bars[0]?.[0]);
    expect(rows?.search(1000, -1)?.index).toBe(bars.length - 1);
    expect([...(rows?.rangeIterator(0, 1) ?? [])].map(({ index }) => index)).toEqual([0, 1]);
    expect(series?.bars().size()).toBe(bars.length);
    expect(series?.bars().valueAt(0)).toEqual(bars[0]);
    expect([series?.bars().firstIndex(), series?.bars().lastIndex()]).toEqual([0, bars.length - 1]);
    expect(series?.symbolInfo()).toEqual(fixture.symbolInfo);
    expect(series?.quotes()).toEqual(fixture.quote);
    expect(series?.isSymbolInvalid()).toBe(false);
    expect(timeScale?.timePointToIndex(fixture.visibleRange.to)).toBe(bars.length - 1);
    expect(timeScale?.indexToTimePoint?.(0)).toBe(bars[0]?.[0]);
    expect(timeScale?.indexToTimePoint?.(bars.length)).toBeNull();
    // The core model answers the same core as the study API, and its graphics are the maps the
    // renderers of the app read.
    const drawn = model?.model().getStudyById?.('STUDY01');
    expect(drawn).toBe(chart?.getStudyById('STUDY01').study());
    expect(model?.model().getStudyById?.('NOPE')).toBeNull();
    const graphics = drawn?.graphics?.();
    expect(typeof graphics?.dwglines).toBe('function');
    expect(typeof graphics?.dwglabels).toBe('function');
    expect(typeof graphics?.dwgboxes).toBe('function');
    expect(typeof graphics?.dwgtables).toBe('function');
    expect(typeof graphics?.dwgtablecells).toBe('function');
    expect(typeof drawn?.properties?.().childs).toBe('function');
    expect(drawn?.metaInfo().isRGB).toBeUndefined();
    const logical = timeScale?.logicalRange();
    expect([logical?.left(), logical?.right()]).toEqual([200, 299]);
    expect(win.BUILD_TIME).toBe(fixture.buildTime);
    expect(Array.isArray(win.webpackChunktradingview)).toBe(true);
    expect(typeof win.TVD?.reloadTab).toBe('function');
    const pine = api?.pineEditorApi?.();
    expect(typeof pine?.open).toBe('function');
    expect([pine?.getDialogFacade?.(), pine?.getBottomFacade?.()]).toEqual([null, null]);
    expect(typeof win.TradingView?.bottomWidgetBar?.close).toBe('function');
    expect(win.document.visibilityState).toBe('visible');
    expect(win.location.href).toBe('https://www.tradingview.com/chart/FIXTURE1/');
  });

  test('is satisfied by the shared fake window for the containers of the charts of the layout', () => {
    const win: TvWindow = createFakeTvWindow(fixture);

    const definitions = win.TradingViewApi?._chartWidgetCollection?._chartWidgetsDefs;
    const container = definitions?.[0]?.container?.value();
    const found = win.document.querySelectorAll?.('[data-qa-id="chart-container"]');

    expect(definitions).toHaveLength(1);
    expect(found).toHaveLength(1);
    // The chart API and the document name the same element, whose box is where the chart is.
    expect(found?.[0]).toBe(container);
    expect(found?.[0]?.getBoundingClientRect()).toMatchObject({
      x: 50,
      y: 40,
      width: 1180,
      height: 640,
    });
  });

  test('is satisfied by the shared fake window for what the shell asks before it closes a tab', () => {
    const win: TvWindow = createFakeTvWindow(fixture);

    expect(win.TradingViewApi?.shouldBeSaved?.()).toBe(false);
    inspectFakeWindow(win).state.layouts.unsaved = true;
    expect(win.TradingViewApi?.shouldBeSaved?.()).toBe(true);
  });

  test("is satisfied by the shared fake window for TradingView's own fullscreen mode", () => {
    const win: TvWindow = createFakeTvWindow(fixture);
    const api = win.TradingViewApi;
    const mode = () => api?._chartWidgetCollection?.fullscreen?.().value();

    expect(mode()).toBe(false);
    api?.startFullscreen?.();
    expect(mode()).toBe(true);
    api?.exitFullscreen?.();
    expect(mode()).toBe(false);
  });

  test('is satisfied by the shared fake window for a strategy, its report and the active source', () => {
    const win: TvWindow = createFakeTvWindow(
      withStudies(fixture, { ...SAMPLE_STRATEGY, activeStrategy: true }),
    );

    const chart = win.TradingViewApi?.activeChart();
    const model = chart?._chartWidget?.model().model();
    const core = model?.getStudyById?.('STRAT01');

    expect(core?.isStudyStrategy).toBe(true);
    expect(core).toBe(chart?.getStudyById('STRAT01').study());
    expect(core?.reportData?.()).toMatchObject({ currency: 'USD' });
    expect(core?.ordersData?.()).toHaveLength(7);
    expect(core?.barsIndexes?.()).toHaveLength(7);
    // The active source is a watched value whose value is the core of the strategy.
    expect(model?.activeStrategySource?.().value?.()).toBe(core);
    // The input of the initial capital carries the internal id the app gives it.
    expect(
      chart
        ?.getStudyById('STRAT01')
        .getInputsInfo()
        .find(({ id }) => id === 'in_1')?.internalID,
    ).toBe('initial_capital');
  });

  test('is satisfied by the shared fake window for the charts of a layout, their panes and its type', () => {
    const win: TvWindow = createFakeTvWindow({
      ...fixture,
      layout: { ...fixture.layout, type: '2h', chartsCount: 2 },
      charts: {
        others: [{ symbol: 'NASDAQ:MSFT', resolution: '60', studies: [], shapes: [] }],
      },
    });
    const api = win.TradingViewApi;

    const panes = api?.chart(0).getPanes?.();
    const pane = panes?.[0];
    expect(panes).toHaveLength(1);
    expect([pane?.paneIndex(), pane?.getHeight(), pane?.hasMainSeries()]).toEqual([0, 600, true]);
    expect(pane?.getAllEntities().map(({ id }) => id)).toEqual([
      'MAINSERIES',
      'STUDY01',
      'STUDY02',
      'SHAPE01',
      'SHAPE02',
      'SHAPE03',
    ]);
    expect([api?.chart(1).symbol(), api?.layout(), api?.chartsCount()]).toEqual([
      'NASDAQ:MSFT',
      '2h',
      2,
    ]);
    api?.setActiveChart(1);
    expect(api?.activeChartIndex()).toBe(1);
    api?.setLayout?.('s', { withUndo: true });
    expect(inspectFakeWindow(win).callsTo('TradingViewApi.setLayout')).toEqual([
      ['s', { withUndo: true }],
    ]);
  });

  test('is satisfied by the shared fake window for bar replay and the replay session it saves', async () => {
    const fake = createFakeTvWindow(fixture);
    const win: TvWindow = fake;
    const replay: ReplayApiLike | undefined = await fake.TradingViewApi?.replayApi?.();
    const modelId = win.TradingViewApi?.activeChart()._chartWidget?.model().id?.();

    expect([replay?.isReplayAvailable().value(), replay?.isReplayStarted().value()]).toEqual([
      true,
      false,
    ]);
    expect([replay?.isAutoplayStarted().value(), replay?.isReplayToolbarVisible().value()]).toEqual(
      [false, false],
    );
    expect(replay?.currentDate().value()).toBeNull();
    expect([replay?.autoplayDelay(), replay?.autoplayDelayList()]).toEqual([
      1000,
      expect.arrayContaining([
        { label: '1x', description: expect.any(String) as string, value: 1000 },
      ]),
    ]);
    expect(replay?.replayTimingMode().value()).toBe('manual');
    expect(replay?.position().value()).toBeNull();
    // A Map from the id of the chart model, which the contract types loosely.
    const availability = replay?._replayUIController?.replayAvailability?.() as
      Map<unknown, unknown> | undefined;
    expect(availability?.get(modelId)).toEqual({ isAvailable: true, unavailabilityReason: '' });
    expect(replay?._replayUIController?._replayManager?.isReplayFinished?.()).toBe(false);
    expect(win.TradingViewApi?._chartWidgetCollection?.replaySessionState?.()).toBeNull();
    win.TradingViewApi?._chartWidgetCollection?.updateReplaySessionState?.(null);
    expect(
      inspectFakeWindow(fake).callsTo('chartWidgetCollection.updateReplaySessionState'),
    ).toEqual([[null]]);
  });

  test('is satisfied by a fake tab whose app has not booted', () => {
    const win: TvWindow = createFakeTvWindow(fixture, { withoutApi: true });

    expect(win.TradingViewApi).toBeUndefined();
    expect(win.location.hostname).toBe('www.tradingview.com');
  });
});
