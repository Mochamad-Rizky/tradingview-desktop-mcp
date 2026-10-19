import type { TvWindow } from '../../../../src/core/tv/tv-window.js';
import { loadTvFixture } from '../../../helpers/fake-tv/fixture.js';
import { syntheticBars } from '../../../helpers/fake-tv/synthetic-bars.js';
import { createFakeTvWindow } from '../../../helpers/fake-tv/window.js';

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
    expect(series?.bars().size()).toBe(bars.length);
    expect(series?.bars().valueAt(0)).toEqual(bars[0]);
    expect([series?.bars().firstIndex(), series?.bars().lastIndex()]).toEqual([0, bars.length - 1]);
    expect(series?.symbolInfo()).toEqual(fixture.symbolInfo);
    expect(series?.quotes()).toEqual(fixture.quote);
    expect(series?.isSymbolInvalid()).toBe(false);
    expect(timeScale?.timePointToIndex(fixture.visibleRange.to)).toBe(bars.length - 1);
    const logical = timeScale?.logicalRange();
    expect([logical?.left(), logical?.right()]).toEqual([200, 299]);
    expect(win.BUILD_TIME).toBe(fixture.buildTime);
    expect(win.webpackChunktradingview).toEqual([]);
    expect(typeof win.TVD?.reloadTab).toBe('function');
    expect(win.document.visibilityState).toBe('visible');
    expect(win.location.href).toBe('https://www.tradingview.com/chart/FIXTURE1/');
  });

  test('is satisfied by a fake tab whose app has not booted', () => {
    const win: TvWindow = createFakeTvWindow(fixture, { withoutApi: true });

    expect(win.TradingViewApi).toBeUndefined();
    expect(win.location.hostname).toBe('www.tradingview.com');
  });
});
