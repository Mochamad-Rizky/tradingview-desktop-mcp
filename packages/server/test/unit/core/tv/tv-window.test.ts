import type { TvWindow } from '../../../../src/core/tv/tv-window.js';
import { loadTvFixture } from '../../../helpers/fake-tv/fixture.js';
import { syntheticBars } from '../../../helpers/fake-tv/synthetic-bars.js';
import { createFakeTvWindow } from '../../../helpers/fake-tv/window.js';
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

  test('is satisfied by a fake tab whose app has not booted', () => {
    const win: TvWindow = createFakeTvWindow(fixture, { withoutApi: true });

    expect(win.TradingViewApi).toBeUndefined();
    expect(win.location.hostname).toBe('www.tradingview.com');
  });
});
