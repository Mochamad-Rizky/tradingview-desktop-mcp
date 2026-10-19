import type { PageErrorSentinel } from '../../core/tv/page-bridge.js';
import type {
  BarsLike,
  ChartModelLike,
  ChartWidgetApiLike,
  LogicalRangeLike,
  SeriesLike,
  TimeScaleLike,
  TradingViewApiLike,
  TvWindow,
} from '../../core/tv/tv-window.js';

// The page functions of the chart tools. The page bridge sends the source text of each one into the
// page, so each uses nothing of this file, only its parameters and the globals of the page, and
// whatever it shares with another is written out in both.
//
// A chartIndex of null means the active chart; any other value has been checked against the layout
// by the caller (readChartLayout). A function that changes the chart answers CAPABILITY_UNAVAILABLE
// when a member it needs is missing, and does so before it has changed anything, because that is
// the one failure that lets another strategy take over.
//
// Members of the app are read defensively: another web build can drop or reshape any of them, and a
// read that throws (a getter of an app that is half built) counts as no answer.

// How many charts the layout has and which of them is active, for checking a chartIndex. A value the
// API does not answer with a number is null, for the caller to refuse.
export function readChartLayout(
  win: TvWindow,
): { chartsCount: number | null; activeChartIndex: number | null } | PageErrorSentinel {
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  if (typeof api?.chartsCount !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no chart API to count the charts of the layout with',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  const count: unknown = api.chartsCount();
  const active: unknown =
    typeof api.activeChartIndex === 'function' ? api.activeChartIndex() : null;
  return {
    chartsCount: typeof count === 'number' ? count : null,
    activeChartIndex: typeof active === 'number' ? active : null,
  };
}

// What chart_get_state reports, read in one go (design spec 7): the symbol, the resolution and the
// chart type, which the chart must answer, and the visible range (Unix seconds), the studies (id and
// name only), the number of drawings and the layout, each of which is null when the page cannot say.
// The names of the chart types are handed in, keyed by id as text, and an id without a name is
// "unknown".
export function readChartState(
  win: TvWindow,
  chartIndex: number | null,
  chartTypeNames: Record<string, string>,
):
  | {
      chartIndex: number | null;
      symbol: string;
      resolution: string;
      chartType: number;
      chartTypeName: string;
      visibleRange: { from: number | null; to: number | null };
      studies: { id: string; name: string }[] | null;
      drawingCount: number | null;
      layout: {
        type: string | null;
        chartsCount: number | null;
        activeChartIndex: number | null;
        name: string | null;
        id: string | null;
      };
    }
  | PageErrorSentinel {
  const attempt = (read: () => unknown): unknown => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  const number = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  const found = attempt(() =>
    chartIndex === null ? api?.activeChart?.() : api?.chart?.(chartIndex),
  ) as Partial<ChartWidgetApiLike> | null | undefined;
  if (
    typeof found?.symbol !== 'function' ||
    typeof found.resolution !== 'function' ||
    typeof found.chartType !== 'function'
  ) {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no chart API to read the chart from',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  // Checked above: the members called without a guard are there.
  const chart = found as ChartWidgetApiLike;
  const type = chart.chartType();
  const typeName = Object.hasOwn(chartTypeNames, String(type))
    ? chartTypeNames[String(type)]
    : undefined;
  const range = attempt(() => chart.getVisibleRange()) as
    { from?: unknown; to?: unknown } | null | undefined;
  const studies = attempt(() => chart.getAllStudies());
  const shapes = attempt(() => chart.getAllShapes());
  return {
    chartIndex: chartIndex ?? number(attempt(() => api?.activeChartIndex?.())),
    symbol: chart.symbol(),
    resolution: chart.resolution(),
    chartType: type,
    chartTypeName: typeName ?? 'unknown',
    visibleRange: { from: number(range?.from), to: number(range?.to) },
    // Only the id and the name: a study carries its inputs and styles too, which the indicator
    // tools report.
    studies: Array.isArray(studies)
      ? studies.map((study: unknown) => {
          const { id, name } = study as { id?: unknown; name?: unknown };
          return { id: String(id), name: String(name) };
        })
      : null,
    drawingCount: Array.isArray(shapes) ? shapes.length : null,
    layout: {
      type: text(attempt(() => api?.layout?.())),
      chartsCount: number(attempt(() => api?.chartsCount?.())),
      activeChartIndex: number(attempt(() => api?.activeChartIndex?.())),
      name: text(attempt(() => api?.layoutName?.())),
      id: text(attempt(() => api?.layoutId?.())),
    },
  };
}

// What the chart shows, for a strategy that changed it through the interface and has to see whether
// the change took: the symbol, the resolution, whether the series flags the symbol as unknown, the
// visible range, the symbol the series has resolved (the pro_name of its symbol info, or else the
// full_name), which names the new symbol once TradingView has found it, and how many bars the
// series holds. Each part is null (or false) when the page cannot say, and the whole is null when
// the chart cannot be reached. It never throws.
export function readChartSnapshot(
  win: TvWindow,
  chartIndex: number | null,
): {
  symbol: string | null;
  resolution: string | null;
  symbolInvalid: boolean;
  from: number | null;
  to: number | null;
  seriesSymbol: string | null;
  barCount: number | null;
} | null {
  const attempt = (read: () => unknown): unknown => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  const number = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  const chart = attempt(() =>
    chartIndex === null ? api?.activeChart?.() : api?.chart?.(chartIndex),
  ) as Partial<ChartWidgetApiLike> | null | undefined;
  if (chart === null || chart === undefined) {
    return null;
  }
  const range = attempt(() => chart.getVisibleRange?.()) as
    { from?: unknown; to?: unknown } | null | undefined;
  const series = attempt(() => chart._chartWidget?.model().mainSeries()) as
    Partial<SeriesLike> | undefined;
  const info = attempt(() => series?.symbolInfo?.()) as
    { pro_name?: unknown; full_name?: unknown } | null | undefined;
  return {
    symbol: text(attempt(() => chart.symbol?.())),
    resolution: text(attempt(() => chart.resolution?.())),
    symbolInvalid: attempt(() => series?.isSymbolInvalid?.()) === true,
    from: number(range?.from),
    to: number(range?.to),
    seriesSymbol: text(info?.pro_name) ?? text(info?.full_name),
    barCount: number(attempt(() => series?.bars?.().size())),
  };
}

// Switches the chart to `symbol` and resolves once its data has loaded, which the app reports with
// dataReady. An unknown symbol is accepted by setSymbol but never gets its data, so the series flag
// for an unknown symbol is watched as well, right after the call and then every 100 ms, and the
// answer is INVALID_INPUT as soon as it turns true (details: requested, previous). A flag that was
// already true before the call belongs to the symbol the chart showed then, so it says nothing about
// the new one, and only dataReady or the deadline can end the wait. Without either signal within
// `timeoutMs` the answer is TIMEOUT. A chart that shows the symbol already is left alone.
export function setSymbolViaApi(
  win: TvWindow,
  symbol: string,
  chartIndex: number | null,
  timeoutMs: number,
):
  | { symbol: string; previous: string; changed: boolean }
  | PageErrorSentinel
  | Promise<{ symbol: string; previous: string; changed: boolean } | PageErrorSentinel> {
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  let found: Partial<ChartWidgetApiLike> | null | undefined;
  try {
    found = chartIndex === null ? api?.activeChart?.() : api?.chart?.(chartIndex);
  } catch {
    found = undefined;
  }
  if (typeof found?.setSymbol !== 'function' || typeof found.symbol !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no chart API to change the symbol with',
      },
    };
  }
  // Checked above: the members called without a guard are there.
  const chart = found as ChartWidgetApiLike;
  const previous = chart.symbol();
  // TradingView writes symbols in capitals and reads them in any case, so case does not count.
  if (previous.toUpperCase() === symbol.toUpperCase()) {
    return { symbol: previous, previous, changed: false };
  }

  let series: Partial<SeriesLike> | undefined;
  try {
    series = chart._chartWidget?.model().mainSeries();
  } catch {
    series = undefined;
  }
  const isInvalid = (): boolean => {
    try {
      return series?.isSymbolInvalid?.() === true;
    } catch {
      return false;
    }
  };
  const wasInvalid = isInvalid();

  return new Promise<{ symbol: string; previous: string; changed: boolean } | PageErrorSentinel>(
    (resolve) => {
      let settled = false;
      // The watch starts before setSymbol is called, because dataReady can come during the call.
      const stop = (): void => {
        settled = true;
        clearInterval(poll);
        clearTimeout(deadline);
      };
      const finish = (
        value: { symbol: string; previous: string; changed: boolean } | PageErrorSentinel,
      ): void => {
        if (!settled) {
          stop();
          resolve(value);
        }
      };
      const failIfUnknown = (): boolean => {
        if (wasInvalid || !isInvalid()) {
          return false;
        }
        finish({
          __tvmcpError: {
            code: 'INVALID_INPUT',
            message: `Unknown symbol ${symbol}`,
            hint: 'Check the spelling, or use the EXCHANGE:SYMBOL form such as NASDAQ:AAPL.',
            details: { requested: symbol, previous },
          },
        });
        return true;
      };
      const poll = setInterval(failIfUnknown, 100);
      const deadline = setTimeout(() => {
        finish({
          __tvmcpError: {
            code: 'TIMEOUT',
            message: `The chart did not finish loading ${symbol} within ${String(timeoutMs)} ms`,
            hint:
              'TradingView may be slow or offline. Call chart_get_state to see which symbol the ' +
              'chart shows now.',
            details: { requested: symbol, previous, timeoutMs },
          },
        });
      }, timeoutMs);

      let result: unknown;
      try {
        result = chart.setSymbol(symbol, {
          dataReady: () => {
            if (!failIfUnknown()) {
              finish({ symbol: chart.symbol(), previous, changed: true });
            }
          },
        });
      } catch (error) {
        // The call failed, and with it the change: the watch ends, and the failure is the answer.
        stop();
        throw error;
      }
      // What the promise of setSymbol means is not recorded, so dataReady and the flag decide, and a
      // promise that fails must not end up as an unhandled rejection of the page.
      Promise.resolve(result).catch(() => undefined);
      failIfUnknown();
    },
  );
}

// Switches the chart to `resolution` and resolves once its data has loaded (dataReady), or answers
// TIMEOUT after `timeoutMs`. A chart that shows the resolution already is left alone; D, W and M
// count as 1D, 1W and 1M, since the app may write either.
export function setResolutionViaApi(
  win: TvWindow,
  resolution: string,
  chartIndex: number | null,
  timeoutMs: number,
):
  | { resolution: string; previous: string; changed: boolean }
  | PageErrorSentinel
  | Promise<{ resolution: string; previous: string; changed: boolean } | PageErrorSentinel> {
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  let found: Partial<ChartWidgetApiLike> | null | undefined;
  try {
    found = chartIndex === null ? api?.activeChart?.() : api?.chart?.(chartIndex);
  } catch {
    found = undefined;
  }
  if (typeof found?.setResolution !== 'function' || typeof found.resolution !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no chart API to change the timeframe with',
      },
    };
  }
  // Checked above: the members called without a guard are there.
  const chart = found as ChartWidgetApiLike;
  const previous = chart.resolution();
  const withCount = (value: string): string => (/^\d/.test(value) ? value : `1${value}`);
  if (withCount(previous) === withCount(resolution)) {
    return { resolution: previous, previous, changed: false };
  }

  return new Promise<
    { resolution: string; previous: string; changed: boolean } | PageErrorSentinel
  >((resolve) => {
    let settled = false;
    // The deadline starts before setResolution is called, because dataReady can come during the
    // call.
    const stop = (): void => {
      settled = true;
      clearTimeout(deadline);
    };
    const finish = (
      value: { resolution: string; previous: string; changed: boolean } | PageErrorSentinel,
    ): void => {
      if (!settled) {
        stop();
        resolve(value);
      }
    };
    const deadline = setTimeout(() => {
      finish({
        __tvmcpError: {
          code: 'TIMEOUT',
          message: `The chart did not finish loading the timeframe ${resolution} within ${String(timeoutMs)} ms`,
          hint:
            'TradingView may be slow or offline, or the timeframe may not be offered for this ' +
            'symbol or plan. Call chart_get_state to see which timeframe the chart shows now.',
          details: { requested: resolution, previous, timeoutMs },
        },
      });
    }, timeoutMs);

    let result: unknown;
    try {
      result = chart.setResolution(resolution, {
        dataReady: () => {
          finish({ resolution: chart.resolution(), previous, changed: true });
        },
      });
    } catch (error) {
      stop();
      throw error;
    }
    // As for setSymbol: dataReady decides, and a promise that fails is not left unhandled.
    Promise.resolve(result).catch(() => undefined);
  });
}

// Sets the chart type (style id) and reads back the type the chart shows. A build whose setChartType
// answers with a promise settles it once the type is applied, so that is waited for, but for a
// second at most: a promise that never settles must not hold the call. A promise that fails fails
// the call. A chart that shows the type already is left alone.
export async function setChartTypeViaApi(
  win: TvWindow,
  typeId: number,
  chartIndex: number | null,
): Promise<{ chartType: number; previous: number; changed: boolean } | PageErrorSentinel> {
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  let found: Partial<ChartWidgetApiLike> | null | undefined;
  try {
    found = chartIndex === null ? api?.activeChart?.() : api?.chart?.(chartIndex);
  } catch {
    found = undefined;
  }
  if (typeof found?.setChartType !== 'function' || typeof found.chartType !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no chart API to change the chart type with',
      },
    };
  }
  // Checked above: the members called without a guard are there.
  const chart = found as ChartWidgetApiLike;
  const previous = chart.chartType();
  if (previous === typeId) {
    return { chartType: previous, previous, changed: false };
  }
  const result: unknown = chart.setChartType(typeId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(result),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  const shown = chart.chartType();
  return { chartType: shown, previous, changed: shown !== previous };
}

// The visible range of the chart in Unix seconds, as getVisibleRange reports it. An end that is not
// a finite number is null.
export function readVisibleRange(
  win: TvWindow,
  chartIndex: number | null,
): { from: number | null; to: number | null } | PageErrorSentinel {
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  let found: Partial<ChartWidgetApiLike> | null | undefined;
  try {
    found = chartIndex === null ? api?.activeChart?.() : api?.chart?.(chartIndex);
  } catch {
    found = undefined;
  }
  if (typeof found?.getVisibleRange !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no chart API to read the visible range from',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  const number = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const range = found.getVisibleRange() as { from?: unknown; to?: unknown } | null | undefined;
  return { from: number(range?.from), to: number(range?.to) };
}

// Shows the bars from `from` to `to` (Unix seconds). The public setVisibleRange throws on the
// observed build, so the core time scale is used: each time is mapped to the index of the nearest
// loaded bar (the earlier one on a tie) by a binary search over the times of the bars, and the time
// scale is zoomed to that range of indices. The times are the ones the chart reports for its bars,
// in which getVisibleRange speaks too: the chart reports a daily bar as its day at 00:00 UTC, while
// the row of the bar holds the start of its session, 13:30 UTC for a US stock (seen on the app), so
// a search over the rows would land a day early. A build that cannot convert an index is searched
// by its rows. The start of a range is clamped to the loaded bars, and its end may reach into the
// empty space the chart keeps after the last bar, as far as the time scale goes; a time beyond
// either is clamped, with a warning. Answers the visible range afterwards, and NOT_AVAILABLE while
// no bar is loaded.
export function zoomToTimeRange(
  win: TvWindow,
  from: number,
  to: number,
  chartIndex: number | null,
): { from: number | null; to: number | null; warnings: string[] } | PageErrorSentinel {
  const attempt = (read: () => unknown): unknown => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const number = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  const chart = attempt(() =>
    chartIndex === null ? api?.activeChart?.() : api?.chart?.(chartIndex),
  ) as Partial<ChartWidgetApiLike> | null | undefined;
  const model = attempt(() => chart?._chartWidget?.model()) as Partial<ChartModelLike> | undefined;
  const bars = attempt(() => model?.mainSeries?.().bars()) as Partial<BarsLike> | undefined;
  const timeScale = attempt(() => model?.model?.().timeScale()) as
    Partial<TimeScaleLike> | undefined;
  if (
    typeof timeScale?.zoomToBarsRange !== 'function' ||
    typeof bars?.firstIndex !== 'function' ||
    typeof bars.lastIndex !== 'function' ||
    typeof bars.valueAt !== 'function'
  ) {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no chart time scale to move the chart with',
      },
    };
  }
  // Checked above: the members called without a guard are there.
  const loaded = bars as BarsLike;
  const scale = timeScale as TimeScaleLike;
  const first = loaded.firstIndex();
  const last = loaded.lastIndex();
  if (first === null || last === null || last < first) {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: 'The chart has no bars loaded yet',
        hint: 'Wait until the chart has loaded its data, then try again.',
      },
    };
  }
  // The time the chart reports for the bar at `index`, or else the time in its row.
  const convert = chart?._convertIndexToPublicTime;
  const timeAt = (index: number): number => {
    const reported =
      typeof convert === 'function' ? attempt(() => convert.call(chart, index)) : undefined;
    if (typeof reported === 'number' && Number.isFinite(reported)) {
      return reported;
    }
    const time: unknown = loaded.valueAt(index)?.[0];
    return typeof time === 'number' ? time : Number.NaN;
  };
  const firstTime = timeAt(first);
  const lastTime = timeAt(last);
  if (!Number.isFinite(firstTime) || !Number.isFinite(lastTime)) {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'The bars of the chart have no times this server can read',
      },
    };
  }
  // Whole seconds without milliseconds, the way the tools write every time.
  const iso = (time: number): string =>
    new Date(Math.floor(time) * 1000).toISOString().replace('.000Z', 'Z');
  // The index from `first` to `upper` whose time is nearest to `time`, the earlier one on a tie.
  const nearest = (time: number, upper: number): number => {
    if (!(time > firstTime)) {
      return first;
    }
    if (!(time < timeAt(upper))) {
      return upper;
    }
    // The point at `low` is earlier than `time`, and the point at `high` is not.
    let low = first;
    let high = upper;
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (timeAt(middle) < time) {
        low = middle;
      } else {
        high = middle;
      }
    }
    return time - timeAt(low) <= timeAt(high) - time ? low : high;
  };
  // The time scale keeps time points after the last bar for the empty space a chart shows there,
  // and getVisibleRange reports a range that reaches into it (seen on the app). The end of a range
  // may lie there too, so that a range read from the chart can be set again; only an end past the
  // last of those points is clamped. A build that does not say where its time points end, or that
  // cannot tell their times, ends a range at the last bar.
  const points = attempt(() => scale.points?.().range().value()) as
    { lastIndex?: unknown } | null | undefined;
  const lastPoint = points?.lastIndex;
  const reach =
    typeof lastPoint === 'number' &&
    Number.isInteger(lastPoint) &&
    lastPoint > last &&
    Number.isFinite(timeAt(lastPoint))
      ? lastPoint
      : last;
  const reachTime = timeAt(reach);

  const warnings: string[] = [];
  if (from < firstTime) {
    warnings.push(`History before ${iso(firstTime)} is not loaded; the range was clamped`);
  }
  if (to > reachTime) {
    warnings.push(
      reach === last
        ? `The chart has no bars after ${iso(lastTime)}; the range was clamped`
        : `The chart reaches no further than ${iso(reachTime)}; the range was clamped`,
    );
  }
  let fromIndex = nearest(from, last);
  let toIndex = nearest(to, reach);
  // Both ends on one bar would ask for a view without width, so the range gets the next bar too,
  // or the one before at the end of the data. A single loaded bar has neither, and the range stays
  // on it rather than reaching an index outside the loaded bars.
  if (toIndex <= fromIndex) {
    if (fromIndex < last) {
      toIndex = fromIndex + 1;
    } else if (toIndex > first) {
      fromIndex = toIndex - 1;
    }
  }
  scale.zoomToBarsRange(fromIndex, toIndex);
  const shown = attempt(() => chart?.getVisibleRange?.()) as
    { from?: unknown; to?: unknown } | null | undefined;
  return { from: number(shown?.from), to: number(shown?.to), warnings };
}

// Moves the chart so that the bar nearest to `time` (Unix seconds) is at the left edge, the center
// or the right edge of the view, and keeps the zoom: the view keeps its width in bars, read from the
// logical range of the time scale, which counts the empty space after the last bar too, or else
// from the visible range mapped to bars. Times are the ones the chart reports for its bars, as in
// zoomToTimeRange. It zooms the core time scale to the new range of indices,
// as zoomToTimeRange does, because where scrollToBar puts a bar is not recorded. The new range stays
// within the loaded bars: near either end the view is moved, and a view wider than the loaded bars
// is narrowed to them, each with a warning. A time outside the loaded bars goes to the first or the
// last of them, with a warning too. Answers the time of the bar and the visible range afterwards.
export function scrollToTime(
  win: TvWindow,
  time: number,
  align: 'left' | 'center' | 'right',
  chartIndex: number | null,
):
  { time: number; from: number | null; to: number | null; warnings: string[] } | PageErrorSentinel {
  const attempt = (read: () => unknown): unknown => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const number = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  const chart = attempt(() =>
    chartIndex === null ? api?.activeChart?.() : api?.chart?.(chartIndex),
  ) as Partial<ChartWidgetApiLike> | null | undefined;
  const model = attempt(() => chart?._chartWidget?.model()) as Partial<ChartModelLike> | undefined;
  const bars = attempt(() => model?.mainSeries?.().bars()) as Partial<BarsLike> | undefined;
  const timeScale = attempt(() => model?.model?.().timeScale()) as
    Partial<TimeScaleLike> | undefined;
  if (
    typeof timeScale?.zoomToBarsRange !== 'function' ||
    typeof bars?.firstIndex !== 'function' ||
    typeof bars.lastIndex !== 'function' ||
    typeof bars.valueAt !== 'function'
  ) {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no chart time scale to move the chart with',
      },
    };
  }
  // Checked above: the members called without a guard are there.
  const loaded = bars as BarsLike;
  const scale = timeScale as TimeScaleLike;
  const first = loaded.firstIndex();
  const last = loaded.lastIndex();
  if (first === null || last === null || last < first) {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: 'The chart has no bars loaded yet',
        hint: 'Wait until the chart has loaded its data, then try again.',
      },
    };
  }
  // The time the chart reports for the bar at `index`, or else the time in its row.
  const convert = chart?._convertIndexToPublicTime;
  const timeAt = (index: number): number => {
    const reported =
      typeof convert === 'function' ? attempt(() => convert.call(chart, index)) : undefined;
    if (typeof reported === 'number' && Number.isFinite(reported)) {
      return reported;
    }
    const barTime: unknown = loaded.valueAt(index)?.[0];
    return typeof barTime === 'number' ? barTime : Number.NaN;
  };
  const firstTime = timeAt(first);
  const lastTime = timeAt(last);
  if (!Number.isFinite(firstTime) || !Number.isFinite(lastTime)) {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'The bars of the chart have no times this server can read',
      },
    };
  }
  const iso = (seconds: number): string =>
    new Date(Math.floor(seconds) * 1000).toISOString().replace('.000Z', 'Z');
  const nearest = (target: number): number => {
    if (!(target > firstTime)) {
      return first;
    }
    if (!(target < lastTime)) {
      return last;
    }
    // The bar at `low` is earlier than `target`, and the bar at `high` is not.
    let low = first;
    let high = last;
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (timeAt(middle) < target) {
        low = middle;
      } else {
        high = middle;
      }
    }
    return target - timeAt(low) <= timeAt(high) - target ? low : high;
  };

  const warnings: string[] = [];
  if (time < firstTime) {
    warnings.push(
      `History before ${iso(firstTime)} is not loaded; the chart was scrolled to the first loaded bar`,
    );
  }
  if (time > lastTime) {
    warnings.push(
      `The chart has no bars after ${iso(lastTime)}; the chart was scrolled to the last bar`,
    );
  }
  // The logical range is the view in bar units: an object whose left() and right() give the first
  // and the last bar index of the view, fractional (seen on the app). It is used only when both
  // ends are numbers.
  const logical = attempt(() => scale.logicalRange()) as
    Partial<LogicalRangeLike> | null | undefined;
  const logicalFrom = number(attempt(() => logical?.left?.()));
  const logicalTo = number(attempt(() => logical?.right?.()));
  let width: number;
  if (logicalFrom !== null && logicalTo !== null && logicalTo >= logicalFrom) {
    width = Math.round(logicalTo - logicalFrom);
  } else {
    const view = attempt(() => chart?.getVisibleRange?.()) as
      { from?: unknown; to?: unknown } | null | undefined;
    const viewFrom = number(view?.from);
    const viewTo = number(view?.to);
    if (viewFrom === null || viewTo === null) {
      return {
        __tvmcpError: {
          code: 'CAPABILITY_UNAVAILABLE',
          message:
            'The chart reports neither a logical nor a visible range, so the zoom to keep is not known',
        },
      };
    }
    width = nearest(viewTo) - nearest(viewFrom);
  }

  const index = nearest(time);
  const wanted = Math.max(width, 1);
  const span = Math.min(wanted, last - first);
  let left = index - Math.floor(span / 2);
  if (align === 'left') {
    left = index;
  } else if (align === 'right') {
    left = index - span;
  }
  // Moves the range back inside the loaded bars; it fits, because it is no wider than they are.
  const shift = Math.max(first - left, 0) - Math.max(left + span - last, 0);
  left += shift;
  if (span < wanted) {
    const count = last - first + 1;
    warnings.push(
      `The chart has only ${String(count)} bar${count === 1 ? '' : 's'} loaded, so the view was narrowed to them`,
    );
  } else if (shift !== 0) {
    const place =
      align === 'left' ? 'the left edge' : align === 'right' ? 'the right edge' : 'the center';
    warnings.push(
      `The view was moved to stay within the loaded bars, so the bar is not at ${place} of it`,
    );
  }
  scale.zoomToBarsRange(left, left + span);
  const shown = attempt(() => chart?.getVisibleRange?.()) as
    { from?: unknown; to?: unknown } | null | undefined;
  return { time: timeAt(index), from: number(shown?.from), to: number(shown?.to), warnings };
}
