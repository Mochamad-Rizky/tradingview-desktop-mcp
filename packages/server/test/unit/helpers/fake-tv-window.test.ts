import { setTimeout as delay } from 'node:timers/promises';
import vm from 'node:vm';
import {
  loadTvFixture,
  parseTvStateFixture,
  type TvStateFixture,
} from '../../helpers/fake-tv/fixture.js';
import { syntheticBars } from '../../helpers/fake-tv/synthetic-bars.js';
import type { FakeWebpackRequire } from '../../helpers/fake-tv/webpack.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeChartWidgetApi,
  type FakeMainSeries,
  type FakeTimeScale,
  type FakeTradingViewApi,
  type FakeTvWindow,
} from '../../helpers/fake-tv/window.js';

const DAY = 86_400;

// Throws instead of returning undefined, so tests read the API without optional chaining.
function apiOf(win: FakeTvWindow): FakeTradingViewApi {
  if (!win.TradingViewApi) {
    throw new Error('The fake window has no TradingViewApi');
  }
  return win.TradingViewApi;
}

function chartOf(win: FakeTvWindow): FakeChartWidgetApi {
  return apiOf(win).activeChart();
}

function seriesOf(win: FakeTvWindow): FakeMainSeries {
  return chartOf(win)._chartWidget.model().mainSeries();
}

function timeScaleOf(win: FakeTvWindow): FakeTimeScale {
  return chartOf(win)._chartWidget.model().model().timeScale();
}

// The first and the last bar index of a logical range, which the app answers as an object with
// left() and right().
function endsOf(range: { left(): number; right(): number } | null): [number, number] | null {
  return range === null ? null : [range.left(), range.right()];
}

describe('syntheticBars', () => {
  const spec = { count: 300, startTime: 1_704_153_600, stepSeconds: DAY, seed: 42 };

  test('syntheticBars is deterministic and well-formed', () => {
    const bars = syntheticBars(spec);

    expect(syntheticBars(spec)).toEqual(bars);
    expect(bars).toHaveLength(300);
    const malformed = bars.filter(([time, open, high, low, close, volume], index) => {
      const ohlc = [open, high, low, close];
      return !(
        time === spec.startTime + index * spec.stepSeconds &&
        ohlc.every((price) => Number.isFinite(price) && price > 0) &&
        high >= Math.max(open, close) &&
        low <= Math.min(open, close) &&
        Number.isInteger(volume) &&
        volume >= 0
      );
    });
    expect(malformed).toEqual([]);
  });

  test('gives different series for different seeds', () => {
    const other = syntheticBars({ ...spec, seed: 8 });

    expect(other).not.toEqual(syntheticBars(spec));
    expect(other.map(([time]) => time)).toEqual(syntheticBars(spec).map(([time]) => time));
  });

  test('walks continuously: every bar opens at the previous close', () => {
    const bars = syntheticBars(spec);

    const gaps = bars.filter((bar, index) => {
      const previous = bars[index - 1];
      return previous !== undefined && bar[1] !== previous[4];
    });
    expect(gaps).toEqual([]);
  });

  test('keeps the invariants on long walks and many seeds', () => {
    for (const seed of [0, 1, 99, 4_294_967_295, -3]) {
      const bars = syntheticBars({ count: 5_000, startTime: 0, stepSeconds: 60, seed });

      const broken = bars.filter(
        ([, open, high, low, close, volume]) =>
          !(
            low > 0 &&
            high >= Math.max(open, close) &&
            low <= Math.min(open, close) &&
            volume >= 0
          ),
      );
      expect(broken, `seed ${String(seed)}`).toEqual([]);
    }
  });

  test('is pinned, so a changed generator or an engine difference shows up here', () => {
    const bars = syntheticBars(spec);

    expect(bars[0]).toEqual([1_704_153_600, 100, 100.85, 99.15, 100.4, 7_027_606]);
    expect(bars[299]).toEqual([1_729_987_200, 103.58, 103.72, 102.91, 103.42, 4_035_204]);
  });

  test('returns no bars for an empty spec', () => {
    expect(syntheticBars({ ...spec, count: 0 })).toEqual([]);
  });

  test.each([
    ['a negative count', { count: -1 }],
    ['a fractional count', { count: 1.5 }],
    ['a zero step', { stepSeconds: 0 }],
    ['a negative step', { stepSeconds: -60 }],
    ['a non-finite start', { startTime: Number.NaN }],
    ['a non-finite seed', { seed: Number.POSITIVE_INFINITY }],
  ])('rejects %s', (_label, change) => {
    expect(() => syntheticBars({ ...spec, ...change })).toThrow(RangeError);
  });
});

describe('the chart-basic fixture', () => {
  test('describes the documented chart', () => {
    const fixture = loadTvFixture();

    expect(fixture).toMatchObject({
      buildTime: '2026-10-16T17:55:37',
      symbol: 'NASDAQ:AAPL',
      resolution: '1D',
      chartType: 1,
      layout: { type: 's', chartsCount: 1, name: 'Fixture Layout', id: 'FIXTURE1' },
      bars: { count: 300, stepSeconds: DAY },
    });
    expect(fixture.studies).toHaveLength(2);
    expect(fixture.studies.every((study) => study.plots.length > 0)).toBe(true);
    expect(fixture.shapes).toHaveLength(3);
    expect(fixture.knownSymbols).toContain(fixture.symbol);
    expect(fixture.intervals).toContain(fixture.resolution);
  });

  test('has a visible range that starts and ends on loaded bars', () => {
    const fixture = loadTvFixture();
    const times = syntheticBars(fixture.bars).map(([time]) => time);

    expect(times).toContain(fixture.visibleRange.from);
    expect(times).toContain(fixture.visibleRange.to);
    expect(fixture.visibleRange.from).toBeLessThan(fixture.visibleRange.to);
  });

  test('has a quote that describes the last synthetic bar', () => {
    const fixture = loadTvFixture();
    const bars = syntheticBars(fixture.bars);
    const last = bars[bars.length - 1];
    const previous = bars[bars.length - 2];
    if (!last || !previous) {
      throw new Error('The fixture needs at least two bars');
    }

    expect(fixture.quote).toMatchObject({
      last_price: last[4],
      open_price: last[1],
      high_price: last[2],
      low_price: last[3],
      volume: last[5],
      lp_time: last[0],
      prev_close_price: previous[4],
      currency_code: 'USD',
    });
    expect(fixture.quote.change).toBeCloseTo(last[4] - previous[4], 2);
  });

  test('parseTvStateFixture rejects documents with a missing or mistyped member', () => {
    const fixture = loadTvFixture();
    const withoutLayout = Object.fromEntries(
      Object.entries(fixture).filter(([key]) => key !== 'layout'),
    );

    expect(() => parseTvStateFixture(withoutLayout)).toThrow(/layout/);
    expect(() => parseTvStateFixture({ ...fixture, chartType: '1' })).toThrow(/chartType/);
    expect(() => parseTvStateFixture(null)).toThrow();
    expect(parseTvStateFixture(JSON.parse(JSON.stringify(fixture)))).toEqual(fixture);
  });

  test('loads another fixture by name and fails clearly for a missing one', () => {
    expect(loadTvFixture('chart-basic')).toEqual(loadTvFixture());
    expect(() => loadTvFixture('does-not-exist')).toThrow(/does-not-exist/);
  });
});

describe('createFakeTvWindow', () => {
  const fixture = loadTvFixture();

  test('exposes the TradingViewApi members the foundation uses, backed by the fixture', () => {
    const api = apiOf(createFakeTvWindow(fixture));

    expect(api.chartsCount()).toBe(1);
    expect(api.activeChartIndex()).toBe(0);
    expect(api.layout()).toBe('s');
    expect(api.layoutName()).toBe('Fixture Layout');
    expect(api.layoutId()).toBe('FIXTURE1');
    expect(api.isConnected()).toBe(true);
    expect(api.getIntervals()).toEqual(fixture.intervals);
    const chart = api.activeChart();
    expect(chart.symbol()).toBe('NASDAQ:AAPL');
    expect(chart.resolution()).toBe('1D');
    expect(chart.chartType()).toBe(1);
    expect(chart.getVisibleRange()).toEqual(fixture.visibleRange);
    expect(chart.getAllStudies()).toEqual(fixture.studies.map(({ id, name }) => ({ id, name })));
    expect(chart.getAllShapes()).toEqual(fixture.shapes);
  });

  test('returns the same chart widget from activeChart() and chart(0)', () => {
    const api = apiOf(createFakeTvWindow(fixture));

    expect(api.chart(0)).toBe(api.activeChart());
    expect(api.chart()).toBe(api.activeChart());
    expect(api.activeChart()).toBe(api.activeChart());
  });

  test('chart(i) throws for every index but 0, with the message of the real build', () => {
    const api = apiOf(createFakeTvWindow(fixture));

    expect(() => api.chart(1)).toThrow(new Error('Incorrect index: 1'));
    expect(() => api.chart(-1)).toThrow(new Error('Incorrect index: -1'));
    expect(() => api.chart(0.5)).toThrow(new Error('Incorrect index: 0.5'));
  });

  test('setActiveChart sets and records the index, and refuses an index outside the layout', () => {
    const twoCharts: TvStateFixture = {
      ...fixture,
      layout: { ...fixture.layout, chartsCount: 2 },
    };
    const win = createFakeTvWindow(twoCharts);
    const api = apiOf(win);
    const widget = api.activeChart();

    api.setActiveChart(1);

    expect(api.chartsCount()).toBe(2);
    expect(api.activeChartIndex()).toBe(1);
    expect(api.activeChart()).toBe(widget);
    expect(() => {
      api.setActiveChart(2);
    }).toThrow(new Error('Incorrect index: 2'));
    expect(api.activeChartIndex()).toBe(1);
    expect(inspectFakeWindow(win).callsTo('TradingViewApi.setActiveChart')).toEqual([[1], [2]]);
  });

  test('returns copies, so a caller cannot change the fixture-backed state', () => {
    const win = createFakeTvWindow(fixture);
    const chart = chartOf(win);

    chart.getAllStudies().pop();
    chart.getAllShapes().length = 0;
    apiOf(win).getIntervals().length = 0;
    chart.getVisibleRange().from = 0;
    const info = seriesOf(win).symbolInfo();
    if (info === null) {
      throw new Error('A booted fake series has symbol info');
    }
    info.name = 'changed';
    const quote = seriesOf(win).quotes();
    if (quote === null) {
      throw new Error('A booted fake series has a quote');
    }
    quote.last_price = 0;

    expect(chart.getAllStudies()).toHaveLength(2);
    expect(chart.getAllShapes()).toHaveLength(3);
    expect(apiOf(win).getIntervals()).toEqual(fixture.intervals);
    expect(chart.getVisibleRange()).toEqual(fixture.visibleRange);
    expect(seriesOf(win).symbolInfo()).toEqual(fixture.symbolInfo);
    expect(seriesOf(win).quotes()).toEqual(fixture.quote);
    expect(fixture).toEqual(loadTvFixture());
  });

  test('keeps windows independent of each other', async () => {
    const first = createFakeTvWindow(fixture);
    const second = createFakeTvWindow(fixture);

    await chartOf(first).setSymbol('NASDAQ:MSFT');
    await chartOf(first).setResolution('60');

    expect(chartOf(second).symbol()).toBe('NASDAQ:AAPL');
    expect(chartOf(second).resolution()).toBe('1D');
  });

  test('setVisibleRange throws Not implemented, like the real build, and is recorded', () => {
    const win = createFakeTvWindow(fixture);

    expect(() => chartOf(win).setVisibleRange({ from: 1, to: 2 })).toThrow(
      new Error('Not implemented'),
    );
    expect(inspectFakeWindow(win).callsTo('chart.setVisibleRange')).toEqual([[{ from: 1, to: 2 }]]);
    expect(chartOf(win).getVisibleRange()).toEqual(fixture.visibleRange);
  });

  describe('main series', () => {
    test('exposes the bar container members verified on the real app', () => {
      const bars = seriesOf(createFakeTvWindow(fixture)).bars();
      const expected = syntheticBars(fixture.bars);

      expect(bars.size()).toBe(300);
      expect(bars.firstIndex()).toBe(0);
      expect(bars.lastIndex()).toBe(299);
      expect(bars.valueAt(0)).toEqual(expected[0]);
      expect(bars.valueAt(150)).toEqual(expected[150]);
      expect(bars.valueAt(299)).toEqual(expected[299]);
      expect(bars.valueAt(300)).toBeNull();
      expect(bars.valueAt(-1)).toBeNull();
      expect(bars.valueAt(1.5)).toBeNull();
    });

    test('hands out copies of bars', () => {
      const bars = seriesOf(createFakeTvWindow(fixture)).bars();

      const bar = bars.valueAt(5);
      bar?.fill(0);

      expect(bars.valueAt(5)).toEqual(syntheticBars(fixture.bars)[5]);
    });

    test('does not model bars().search, whose behavior is unverified', () => {
      const bars = seriesOf(createFakeTvWindow(fixture)).bars();

      expect('search' in bars).toBe(false);
    });

    test('reports an empty bar container with null bounds', () => {
      const empty = createFakeTvWindow({ ...fixture, bars: { ...fixture.bars, count: 0 } });
      const bars = seriesOf(empty).bars();

      expect(bars.size()).toBe(0);
      expect(bars.firstIndex()).toBeNull();
      expect(bars.lastIndex()).toBeNull();
      expect(bars.valueAt(0)).toBeNull();
      expect(timeScaleOf(empty).timePointToIndex(fixture.visibleRange.from)).toBeNull();
      expect(timeScaleOf(empty).logicalRange()).toBeNull();
    });

    test('hands out the same model objects on every call, like the real widget', () => {
      const widget = chartOf(createFakeTvWindow(fixture))._chartWidget;

      expect(widget.model()).toBe(widget.model());
      expect(widget.model().model()).toBe(widget.model().model());
      expect(widget.model().mainSeries()).toBe(widget.model().mainSeries());
      expect(widget.model().model().timeScale()).toBe(widget.model().model().timeScale());
    });

    test('returns the symbol info and the quote of the fixture', () => {
      const series = seriesOf(createFakeTvWindow(fixture));

      expect(series.symbolInfo()).toEqual(fixture.symbolInfo);
      expect(series.quotes()).toEqual(fixture.quote);
      expect(series.isSymbolInvalid()).toBe(false);
    });
  });

  describe('time scale', () => {
    const times = syntheticBars(loadTvFixture().bars).map(([time]) => time);
    const timeAt = (index: number): number => {
      const time = times[index];
      if (time === undefined) {
        throw new Error(`No bar at index ${String(index)}`);
      }
      return time;
    };

    // As on the app: the first time point at or after the time, not the nearest one.
    test('maps a time to the first time point at or after it', () => {
      const scale = timeScaleOf(createFakeTvWindow(fixture));

      expect(scale.timePointToIndex(timeAt(10))).toBe(10);
      expect(scale.timePointToIndex(timeAt(10) + 100)).toBe(11);
      expect(scale.timePointToIndex(timeAt(10) - 50_000)).toBe(10);
      expect(scale.timePointToIndex(timeAt(0) - 5 * DAY)).toBe(0);
      expect(scale.timePointToIndex(timeAt(299) + 5 * DAY)).toBe(299);
      expect(scale.timePointToIndex(Number.POSITIVE_INFINITY)).toBe(299);
    });

    test('maps a time after the last bar to the time points after it, when there are some', () => {
      const scale = timeScaleOf(createFakeTvWindow(fixture, { futurePoints: 30 }));

      expect(scale.timePointToIndex(timeAt(299) + 5 * DAY)).toBe(304);
      expect(scale.timePointToIndex(timeAt(299) + 90 * DAY)).toBe(329);
    });

    test('has no index for a time that is not a number, or without bars', async () => {
      const win = createFakeTvWindow(fixture);

      expect(timeScaleOf(win).timePointToIndex(Number.NaN)).toBeNull();
      await chartOf(win).setSymbol('NOSUCH:SYMBOL');
      expect(timeScaleOf(win).timePointToIndex(timeAt(10))).toBeNull();
    });

    test('starts from the visible range of the fixture', () => {
      const win = createFakeTvWindow(fixture);

      expect(chartOf(win).getVisibleRange()).toEqual({ from: timeAt(200), to: timeAt(299) });
      expect(endsOf(timeScaleOf(win).logicalRange())).toEqual([200, 299]);
    });

    test('zoomToBarsRange moves the visible range to the bar times and records the call', () => {
      const win = createFakeTvWindow(fixture);

      timeScaleOf(win).zoomToBarsRange(250, 280);

      expect(chartOf(win).getVisibleRange()).toEqual({ from: timeAt(250), to: timeAt(280) });
      expect(endsOf(timeScaleOf(win).logicalRange())).toEqual([250, 280]);
      expect(inspectFakeWindow(win).callsTo('timeScale.zoomToBarsRange')).toEqual([[250, 280]]);
    });

    test('zoomToBarsRange stays within the loaded bars', () => {
      const win = createFakeTvWindow(fixture);

      timeScaleOf(win).zoomToBarsRange(-40, 500);

      expect(chartOf(win).getVisibleRange()).toEqual({ from: timeAt(0), to: timeAt(299) });
      expect(inspectFakeWindow(win).callsTo('timeScale.zoomToBarsRange')).toEqual([[-40, 500]]);
    });

    test('zoomToBarsRange rounds fractional indices to the nearest bar', () => {
      const win = createFakeTvWindow(fixture);

      timeScaleOf(win).zoomToBarsRange(10.4, 20.6);

      expect(endsOf(timeScaleOf(win).logicalRange())).toEqual([10, 21]);
    });

    test('zoomToBarsRange refuses an index that is not a number', () => {
      const win = createFakeTvWindow(fixture);

      expect(() => {
        timeScaleOf(win).zoomToBarsRange(Number.NaN, 5);
      }).toThrow(RangeError);
      expect(chartOf(win).getVisibleRange()).toEqual(fixture.visibleRange);
    });

    test('reports times a session offset before the rows of the bars, when asked to', () => {
      const offset = 48_600;
      const win = createFakeTvWindow(fixture, { sessionOffsetSeconds: offset });

      expect(seriesOf(win).bars().valueAt(10)?.[0]).toBe(timeAt(10));
      expect(chartOf(win)._convertIndexToPublicTime(10)).toBe(timeAt(10) - offset);
      expect(chartOf(win).getVisibleRange()).toEqual({
        from: timeAt(200) - offset,
        to: timeAt(299) - offset,
      });
      expect(endsOf(timeScaleOf(win).logicalRange())).toEqual([200, 299]);

      timeScaleOf(win).zoomToBarsRange(250, 280);

      expect(chartOf(win).getVisibleRange()).toEqual({
        from: timeAt(250) - offset,
        to: timeAt(280) - offset,
      });
      expect(endsOf(timeScaleOf(win).logicalRange())).toEqual([250, 280]);
    });

    test('keeps time points after the last bar, when asked to', () => {
      const win = createFakeTvWindow(fixture, { futurePoints: 30 });
      const scale = timeScaleOf(win);

      expect(scale.points().range().value()).toEqual({ firstIndex: 0, lastIndex: 329 });
      expect(chartOf(win)._convertIndexToPublicTime(310)).toBe(timeAt(299) + 11 * DAY);
      expect(seriesOf(win).bars().valueAt(310)).toBeNull();

      scale.zoomToBarsRange(250, 320);

      expect(chartOf(win).getVisibleRange()).toEqual({
        from: timeAt(250),
        to: timeAt(299) + 21 * DAY,
      });
      expect(endsOf(scale.logicalRange())).toEqual([250, 320]);

      scale.zoomToBarsRange(250, 400);

      expect(chartOf(win).getVisibleRange().to).toBe(timeAt(299) + 30 * DAY);
    });

    test('has time points up to the last bar by default, and none without bars', async () => {
      const win = createFakeTvWindow(fixture);

      expect(timeScaleOf(win).points().range().value()).toEqual({ firstIndex: 0, lastIndex: 299 });
      await chartOf(win).setSymbol('NOSUCH:SYMBOL');
      expect(timeScaleOf(win).points().range().value()).toBeNull();
      expect(chartOf(win)._convertIndexToPublicTime(10)).toBeNull();
    });

    test('zoomToBarsRange leaves the view alone when its ends are the wrong way round', () => {
      const win = createFakeTvWindow(fixture);

      timeScaleOf(win).zoomToBarsRange(280, 250);

      expect(chartOf(win).getVisibleRange()).toEqual(fixture.visibleRange);
      expect(inspectFakeWindow(win).callsTo('timeScale.zoomToBarsRange')).toEqual([[280, 250]]);
    });

    test('converts no index that has no bar', () => {
      const win = createFakeTvWindow(fixture);

      expect(chartOf(win)._convertIndexToPublicTime(10)).toBe(timeAt(10));
      expect(chartOf(win)._convertIndexToPublicTime(10.5)).toBeNull();
      expect(chartOf(win)._convertIndexToPublicTime(-1)).toBeNull();
      expect(chartOf(win)._convertIndexToPublicTime(300)).toBeNull();
    });

    test('scrollToBar records the call and leaves the range alone', () => {
      const win = createFakeTvWindow(fixture);

      timeScaleOf(win).scrollToBar(120);

      expect(inspectFakeWindow(win).callsTo('timeScale.scrollToBar')).toEqual([[120]]);
      expect(chartOf(win).getVisibleRange()).toEqual(fixture.visibleRange);
    });
  });

  describe('changing the chart', () => {
    test('setSymbol on a known symbol switches it and calls dataReady asynchronously', async () => {
      const win = createFakeTvWindow(fixture);
      const dataReady = vi.fn();

      const done = chartOf(win).setSymbol('NASDAQ:MSFT', { dataReady });

      expect(chartOf(win).symbol()).toBe('NASDAQ:MSFT');
      expect(dataReady).not.toHaveBeenCalled();
      await expect(done).resolves.toBe(true);
      expect(dataReady).toHaveBeenCalledOnce();
      expect(seriesOf(win).isSymbolInvalid()).toBe(false);
      expect(inspectFakeWindow(win).callsTo('chart.setSymbol')).toEqual([
        ['NASDAQ:MSFT', { dataReady }],
      ]);
    });

    test('fake setSymbol marks unknown symbols invalid', async () => {
      const win = createFakeTvWindow(fixture);
      const unknown = vi.fn();
      const known = vi.fn();

      await chartOf(win).setSymbol('NOSUCH:SYMBOL', { dataReady: unknown });
      await delay(20);

      // The real app keeps the requested symbol and flags the series, and never reports ready.
      expect(chartOf(win).symbol()).toBe('NOSUCH:SYMBOL');
      expect(seriesOf(win).isSymbolInvalid()).toBe(true);
      expect(unknown).not.toHaveBeenCalled();

      await chartOf(win).setSymbol('NASDAQ:AAPL', { dataReady: known });

      expect(chartOf(win).symbol()).toBe('NASDAQ:AAPL');
      expect(seriesOf(win).isSymbolInvalid()).toBe(false);
      expect(known).toHaveBeenCalledOnce();
    });

    test('names the symbol it shows in the symbol info', async () => {
      const win = createFakeTvWindow(fixture);

      await chartOf(win).setSymbol('NASDAQ:MSFT');

      expect(seriesOf(win).symbolInfo()).toMatchObject({
        name: 'MSFT',
        full_name: 'NASDAQ:MSFT',
        pro_name: 'NASDAQ:MSFT',
      });
    });

    test('names a symbol by the exchange of its data feed once loaded, when asked to', async () => {
      const win = createFakeTvWindow(fixture, { feeds: { 'NASDAQ:MSFT': 'BATS:MSFT' } });
      const shownAtDataReady: string[] = [];

      const done = chartOf(win).setSymbol('NASDAQ:MSFT', {
        dataReady: () => shownAtDataReady.push(chartOf(win).symbol()),
      });

      // As on the app: the symbol as set at once, and the feed's name once it is resolved.
      expect(chartOf(win).symbol()).toBe('NASDAQ:MSFT');
      await done;
      expect(shownAtDataReady).toEqual(['BATS:MSFT']);
      expect(seriesOf(win).symbolInfo()).toMatchObject({
        name: 'MSFT',
        full_name: 'BATS:MSFT',
        pro_name: 'NASDAQ:MSFT',
      });
    });

    test('starts on the data feed of the fixture symbol, and knows the feed as a symbol', async () => {
      const win = createFakeTvWindow(fixture, { feeds: { 'NASDAQ:AAPL': 'BATS:AAPL' } });

      expect(chartOf(win).symbol()).toBe('BATS:AAPL');
      expect(seriesOf(win).symbolInfo()).toMatchObject({ pro_name: 'NASDAQ:AAPL' });
      await chartOf(win).setSymbol('BATS:AAPL');
      expect(seriesOf(win).isSymbolInvalid()).toBe(false);
    });

    test('an unknown symbol leaves the series without bars, symbol info or visible range', async () => {
      const win = createFakeTvWindow(fixture);

      await chartOf(win).setSymbol('NOSUCH:SYMBOL');

      // As on the real app: the bars are gone, the symbol info is null, and getVisibleRange
      // answers zeros instead of a range.
      expect(seriesOf(win).bars().size()).toBe(0);
      expect(seriesOf(win).bars().firstIndex()).toBeNull();
      expect(seriesOf(win).bars().valueAt(0)).toBeNull();
      expect(seriesOf(win).symbolInfo()).toBeNull();
      expect(chartOf(win).getVisibleRange()).toEqual({ from: 0, to: 0 });

      await chartOf(win).setSymbol('NASDAQ:AAPL');

      expect(seriesOf(win).bars().size()).toBe(fixture.bars.count);
      expect(seriesOf(win).symbolInfo()).toEqual(fixture.symbolInfo);
      expect(chartOf(win).getVisibleRange()).toEqual(fixture.visibleRange);
    });

    // As on the app, where both call _activateChart unless doNotActivateChart is given.
    test('setSymbol and setResolution make their chart the active one unless told not to', async () => {
      const win = createFakeTvWindow(fixture);
      const state = inspectFakeWindow(win).state;

      state.activeChartIndex = 1;
      await chartOf(win).setSymbol('NASDAQ:MSFT', { doNotActivateChart: true });
      await chartOf(win).setResolution('60', { doNotActivateChart: true });
      expect(state.activeChartIndex).toBe(1);

      await chartOf(win).setSymbol('NASDAQ:NVDA');
      expect(state.activeChartIndex).toBe(0);
      state.activeChartIndex = 1;
      await chartOf(win).setResolution('240');
      expect(state.activeChartIndex).toBe(0);
    });

    test('setSymbol works without options', async () => {
      const win = createFakeTvWindow(fixture);

      await chartOf(win).setSymbol('NASDAQ:NVDA');
      await chartOf(win).setSymbol('NOSUCH:SYMBOL');

      expect(seriesOf(win).isSymbolInvalid()).toBe(true);
    });

    test('a dataReady callback that throws does not break the fake', async () => {
      const win = createFakeTvWindow(fixture);

      await chartOf(win).setSymbol('NASDAQ:MSFT', {
        dataReady: () => {
          throw new Error('callback failure');
        },
      });
      await delay(5);

      expect(chartOf(win).symbol()).toBe('NASDAQ:MSFT');
    });

    test('setResolution sets the resolution and calls dataReady asynchronously', async () => {
      const win = createFakeTvWindow(fixture);
      const dataReady = vi.fn();

      const done = chartOf(win).setResolution('60', { dataReady });

      expect(chartOf(win).resolution()).toBe('60');
      expect(dataReady).not.toHaveBeenCalled();
      await done;
      expect(dataReady).toHaveBeenCalledOnce();
      expect(inspectFakeWindow(win).callsTo('chart.setResolution')).toEqual([
        ['60', { dataReady }],
      ]);
    });

    test('setChartType sets the type and returns a resolved promise', async () => {
      const win = createFakeTvWindow(fixture);

      await expect(chartOf(win).setChartType(8)).resolves.toBeUndefined();

      expect(chartOf(win).chartType()).toBe(8);
      expect(inspectFakeWindow(win).callsTo('chart.setChartType')).toEqual([[8]]);
    });
  });

  describe('page globals', () => {
    test('exposes BUILD_TIME, the chart location and a visible document', () => {
      const win = createFakeTvWindow(fixture);

      expect(win.BUILD_TIME).toBe('2026-10-16T17:55:37');
      expect(win.location).toMatchObject({
        href: 'https://www.tradingview.com/chart/FIXTURE1/',
        origin: 'https://www.tradingview.com',
        hostname: 'www.tradingview.com',
        pathname: '/chart/FIXTURE1/',
      });
      expect(win.document.visibilityState).toBe('visible');
    });

    test('takes the visibility state from the options', () => {
      const hidden = createFakeTvWindow(fixture, { visibilityState: 'hidden' });

      expect(hidden.document.visibilityState).toBe('hidden');
      expect(inspectFakeWindow(hidden).state.visibilityState).toBe('hidden');
    });

    test('exposes an empty webpack chunk list and a TVD bridge that records reloadTab', () => {
      const win = createFakeTvWindow(fixture, { withoutWebpackRuntime: true });

      win.TVD.reloadTab();

      expect(win.webpackChunktradingview).toEqual([]);
      expect(Array.isArray(win.webpackChunktradingview)).toBe(true);
      expect(inspectFakeWindow(win).callsTo('TVD.reloadTab')).toEqual([[]]);
    });

    test('puts the plan feature and quote cache modules of the fixture in the webpack cache by default', () => {
      const win = createFakeTvWindow(fixture);
      let handed: FakeWebpackRequire | undefined;

      win.webpackChunktradingview.push([
        ['probe'],
        {},
        (given: FakeWebpackRequire) => (handed = given),
      ]);

      const exports = Object.values(handed?.c ?? {}).map((record) =>
        Object.keys(record.exports as object).sort(),
      );
      // In the order of the module IDs, which are integer keys.
      expect(exports).toEqual([
        ['ProductFeatures', 'ProductFeaturesEnum', 'UNLIMITED_FEATURE_LIMIT'],
        ['quoteSessionAdapters'],
        ['QUOTE_FIELDS_CACHE', 'snapshoter'],
        ['canUpgradePlan', 'enabled', 'getConfig', 'getProductFeaturesConfig'],
        ['getQuoteSessionInstance', 'getQuoteSessionNoEnsure'],
      ]);
    });

    test('puts a fake webpack runtime holding webpackModules behind the chunk list', () => {
      const exports = { studyMetaInfoRepository: {} };
      const win = createFakeTvWindow(fixture, { webpackModules: { 1: exports } });
      let handed: FakeWebpackRequire | undefined;

      win.webpackChunktradingview.push([
        ['probe'],
        {},
        (given: FakeWebpackRequire) => (handed = given),
      ]);

      expect(handed?.c[1]?.exports).toBe(exports);
      expect(win.webpackChunktradingview).toHaveLength(1);
    });

    test('withoutApi omits TradingViewApi but keeps the rest of the page', () => {
      const win = createFakeTvWindow(fixture, { withoutApi: true });

      expect('TradingViewApi' in win).toBe(false);
      expect(win.TradingViewApi).toBeUndefined();
      expect(win.BUILD_TIME).toBe('2026-10-16T17:55:37');
      expect(typeof win.TVD.reloadTab).toBe('function');
      expect(Array.isArray(win.webpackChunktradingview)).toBe(true);
    });
  });

  describe('inspection', () => {
    test('records mutating calls in order and exposes mutable state', async () => {
      const win = createFakeTvWindow(fixture);
      const fake = inspectFakeWindow(win);

      await chartOf(win).setResolution('60');
      await chartOf(win).setChartType(8);
      timeScaleOf(win).scrollToBar(3);

      expect(fake.calls.map((call) => call.name)).toEqual([
        'chart.setResolution',
        'chart.setChartType',
        'timeScale.scrollToBar',
      ]);
      expect(fake.calls[1]).toEqual({ name: 'chart.setChartType', args: [8] });
      expect(fake.state).toMatchObject({
        symbol: 'NASDAQ:AAPL',
        resolution: '60',
        chartType: 8,
        activeChartIndex: 0,
        symbolInvalid: false,
        connected: true,
        visibilityState: 'visible',
      });
    });

    test('lets a test flip the connection and visibility the page reads', () => {
      const win = createFakeTvWindow(fixture);
      const fake = inspectFakeWindow(win);

      fake.state.connected = false;
      fake.state.visibilityState = 'hidden';

      expect(apiOf(win).isConnected()).toBe(false);
      expect(win.document.visibilityState).toBe('hidden');
    });

    test('does not record reads', () => {
      const win = createFakeTvWindow(fixture);

      chartOf(win).symbol();
      seriesOf(win).bars().valueAt(0);
      timeScaleOf(win).timePointToIndex(0);

      expect(inspectFakeWindow(win).calls).toEqual([]);
    });

    test('refuses objects that are not fake windows', () => {
      expect(() => inspectFakeWindow({})).toThrow('not a fake TradingView window');
    });
  });

  describe('as the window of a vm context', () => {
    test('can be evaluated in a fresh context, like a page function guard does', () => {
      const win = createFakeTvWindow(fixture);

      const symbol: unknown = vm.runInNewContext('window.TradingViewApi.activeChart().symbol()', {
        window: win,
      });
      const size: unknown = vm.runInNewContext(
        '((win) => win.TradingViewApi.activeChart()._chartWidget.model().mainSeries().bars().size())(window)',
        { window: win },
      );

      expect(symbol).toBe('NASDAQ:AAPL');
      expect(size).toBe(300);
    });

    test('works with a promise created inside the context', async () => {
      const win = createFakeTvWindow(fixture);
      const source = `(async (win) => {
        const chart = win.TradingViewApi.activeChart();
        await new Promise((resolve) => { chart.setSymbol('NASDAQ:MSFT', { dataReady: () => resolve(true) }); });
        return chart.symbol();
      })(window)`;

      const result: unknown = await (vm.runInNewContext(source, {
        window: win,
      }) as Promise<unknown>);

      expect(result).toBe('NASDAQ:MSFT');
    });
  });
});

describe('history, quote caches and symbol search', () => {
  const fixture = loadTvFixture();
  const withHistory = (totalBars: number, endOfDataType = 'end'): TvStateFixture => ({
    ...fixture,
    history: { totalBars, endOfDataType },
  });

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

  test('requestMoreData loads older bars in front after the load time, up to the history', async () => {
    const win = createFakeTvWindow(withHistory(450));
    const series = seriesOf(win);
    const firstBefore = series.bars().valueAt(0);

    series.requestMoreData(100);

    expect([series.isLoading(), series.requestMoreDataAvailable(), series.status()]).toEqual([
      true,
      false,
      2,
    ]);
    expect(series.bars().size()).toBe(300);
    await delay(30);
    expect([series.isLoading(), series.requestMoreDataAvailable(), series.status()]).toEqual([
      false,
      true,
      3,
    ]);
    expect(series.bars().size()).toBe(400);
    expect(series.bars().valueAt(100)).toEqual(firstBefore);
    expect(series.bars().valueAt(0)?.[0]).toBe(fixture.bars.startTime - 100 * DAY);
    expect([series.endOfData(), series.endOfDataType()]).toEqual([false, null]);

    series.requestMoreData(100);
    await delay(30);

    // Only 50 older bars were left: the end of the data, with bars still added.
    expect(series.bars().size()).toBe(450);
    expect([series.endOfData(), series.endOfDataType()]).toEqual([true, 'end']);
    expect(inspectFakeWindow(win).callsTo('series.requestMoreData')).toEqual([[100], [100]]);
  });

  test('a request that finds no older bar ends the data and leaves requests unavailable', async () => {
    const series = seriesOf(createFakeTvWindow(withHistory(300, 'limit')));

    expect(series.endOfData()).toBe(false);
    series.requestMoreData(5000);
    await delay(30);

    expect(series.bars().size()).toBe(300);
    expect([series.endOfData(), series.endOfDataType()]).toEqual([true, 'limit']);
    expect([series.isLoading(), series.requestMoreDataAvailable()]).toEqual([false, false]);
  });

  test.each([
    ['without a count', undefined],
    ['with a count of zero', 0],
  ])('requestMoreData does nothing %s', (_case, count) => {
    const series = seriesOf(createFakeTvWindow(withHistory(450)));

    series.requestMoreData(count);

    expect([series.isLoading(), series.requestMoreDataAvailable()]).toEqual([false, true]);
  });

  test('requestMoreData does nothing while a request runs or the symbol is unknown', async () => {
    const win = createFakeTvWindow(withHistory(450), { historyLoadMs: 20 });
    const series = seriesOf(win);

    series.requestMoreData(10);
    series.requestMoreData(10);
    await delay(40);
    expect(series.bars().size()).toBe(310);

    await chartOf(win).setSymbol('NASDAQ:NOPE');
    series.requestMoreData(10);
    expect(series.isLoading()).toBe(false);
    expect(series.quotes()).toBeNull();
  });

  test('the time scale follows the bars that history loading adds', async () => {
    const win = createFakeTvWindow(withHistory(400));
    seriesOf(win).requestMoreData(100);
    await delay(30);

    expect(timeScaleOf(win).points().range().value()).toEqual({ firstIndex: 0, lastIndex: 399 });
    expect(chartOf(win)._convertIndexToPublicTime(0)).toBe(fixture.bars.startTime - 100 * DAY);
  });

  test('the quote field cache answers its entries, an empty one as an error', () => {
    const cache = exportsOf(createFakeTvWindow(fixture)).QUOTE_FIELDS_CACHE as {
      get(symbol: string): unknown;
      getTimes(symbol: string): Map<string, number> | null;
      fields(): string[];
    };

    expect(cache.get('NASDAQ:MSFT')).toEqual({
      symbolname: 'NASDAQ:MSFT',
      status: 'ok',
      values: fixture.quoteCache.fields['NASDAQ:MSFT'],
    });
    expect(cache.get('NASDAQ:NVDA')).toEqual({
      symbolname: 'NASDAQ:NVDA',
      status: 'error',
      values: {},
    });
    expect(cache.get('NYSE:IBM')).toBeNull();
    expect(cache.getTimes('NASDAQ:MSFT')?.has('last_price')).toBe(true);
    expect(cache.getTimes('NYSE:IBM')).toBeNull();
    expect(cache.fields()).toContain('last_price');
  });

  test('the full quote session and the watchlist cache hold their entries', () => {
    const exports = exportsOf(createFakeTvWindow(fixture));
    const noEnsure = exports.getQuoteSessionNoEnsure as (type?: string) => {
      internals(): { data(): Record<string, { values: unknown; subscribers_count: number }> };
    } | null;
    const adapters = exports.quoteSessionAdapters as {
      _lastSymbolData: Map<string, { values: unknown }>;
    };

    expect(noEnsure()?.internals().data()['NYSE:IBM']).toMatchObject({
      symbolname: 'NYSE:IBM',
      status: 'ok',
      subscribers_count: 1,
      values: fixture.quoteCache.full['NYSE:IBM'],
    });
    expect(noEnsure('watchlist')).toBeUndefined();
    expect(adapters._lastSymbolData.get('FX:EURUSD')?.values).toEqual(
      fixture.quoteCache.watchlist['FX:EURUSD'],
    );
  });

  test('the members that would create a quote session or send a request record their calls', async () => {
    const win = createFakeTvWindow(fixture);
    const exports = exportsOf(win);
    const session = (
      exports.getQuoteSessionInstance as (type?: string) => {
        snapshot(symbol: string): Promise<unknown>;
        subscribe(...args: unknown[]): void;
      }
    )();

    session.subscribe('client', ['NYSE:IBM']);
    await expect(session.snapshot('NYSE:IBM')).rejects.toThrow(/not received/);
    (exports.snapshoter as () => unknown)();
    (exports.quoteSessionAdapters as { get(id: string, type: string): unknown }).get('w', 'full');

    expect(inspectFakeWindow(win).calls.map(({ name }) => name)).toEqual([
      'getQuoteSessionInstance',
      'quoteSession.subscribe',
      'quoteSession.snapshot',
      'snapshoter',
      'quoteSessionAdapters.get',
    ]);
  });

  test('searchSymbols keeps the items that match, with their markup, and records the call', async () => {
    const win = createFakeTvWindow(fixture);

    const response = await apiOf(win).searchSymbols({ text: 'aapl', serverHighlight: false });

    expect(response.symbols.map((item) => item.exchange)).toEqual([
      'NASDAQ',
      'Cboe BZX',
      'BMFBOVESPA',
    ]);
    expect(response.symbols[0]?.symbol).toBe('<em>AAPL</em>');
    expect(response.symbols_remaining).toBe(37);
    expect(inspectFakeWindow(win).callsTo('TradingViewApi.searchSymbols')).toEqual([
      [{ text: 'aapl', serverHighlight: false }],
    ]);
  });

  test('searchSymbols filters by exchange or prefix and by type', async () => {
    const api = apiOf(createFakeTvWindow(fixture));

    const bats = await api.searchSymbols({ text: 'AAPL', exchange: 'BATS' });
    const crypto = await api.searchSymbols({ text: '', type: 'bitcoin,crypto' });

    expect(bats.symbols.map((item) => item.exchange)).toEqual(['Cboe BZX']);
    expect(crypto.symbols.map((item) => item.symbol)).toEqual(['BTCUSDT']);
  });

  test('searchSymbols rejects a type the app does not know, as the app does', async () => {
    await expect(
      apiOf(createFakeTvWindow(fixture)).searchSymbols({ text: 'x', type: 'crypto' }),
    ).rejects.toThrow('Value is undefined');
  });
});

test('a request brings at most historyBatchBars bars', async () => {
  const fixture = loadTvFixture();
  const win = createFakeTvWindow(
    { ...fixture, history: { totalBars: 1000, endOfDataType: 'end' } },
    { historyBatchBars: 50 },
  );
  const series = seriesOf(win);

  series.requestMoreData(500);
  await delay(30);

  expect(series.bars().size()).toBe(350);
  expect(series.requestMoreDataAvailable()).toBe(true);
});
