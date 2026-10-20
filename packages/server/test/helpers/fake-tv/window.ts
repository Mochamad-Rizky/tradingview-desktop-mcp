import type { JsonValue } from '../../../src/utils/json.js';
import type { TvStateFixture } from './fixture.js';
import { createFakeHistory } from './history.js';
import { createPlanLimitModules } from './plan-limits.js';
import { createQuoteModules } from './quotes.js';
import { createFakeSearch, type FakeSearchOptions, type FakeSearchResponse } from './search.js';
import {
  createFakeStudies,
  createStudyCatalogModules,
  type FakeCanCreateStudy,
  type FakeStudies,
  type FakeStudyApi,
} from './studies.js';
import type { SyntheticBar } from './synthetic-bars.js';
import { createFakeWebpack } from './webpack.js';

// A stand-in for the window of a TradingView chart tab, built from a TvStateFixture. It models
// only the members of TradingViewApi, the chart widget API and the chart model that the server
// uses (reverse-engineering notes, sections 4.2 to 4.4), with the quirks of the real build:
// setVisibleRange throws, chart(i) only knows index 0, and an unknown symbol is accepted but
// flags the series as invalid and never reports data ready. While the series is flagged it has no
// bars and no symbol info, and getVisibleRange answers zeros, as the real app does.
//
// Data is static per fixture. Bars are the same series whatever the symbol or resolution, and
// symbolInfo() and quotes() describe the fixture symbol, apart from the names in the symbol info,
// which follow the symbol the chart shows. The fake does not model
// per-symbol data, and bars() deliberately lacks search(), range() and each(), because their
// behavior is unverified on the real app and the server must not depend on them. The one change
// to the bars is older history, which requestMoreData loads up to the history of the fixture
// (history.ts). quotes() is null while the series has no data, as for an unknown symbol.
//
// The webpack chunk list is the one of the fake runtime of webpack.ts. Its cache holds the two
// modules of the plan features, driven by the planLimits of the fixture (plan-limits.ts), and the
// three modules of the quote caches, driven by its quoteCache (quotes.ts), and the two modules of
// the indicator catalog, driven by its studyCatalog (studies.ts), unless the webpackModules option
// puts other modules there. The studies on the chart, with their inputs, plots and rows, come from
// the studies of the fixture (studies.ts) and follow the bars. createStudy, removeEntity and the
// setters of the study API change them, and the chart model checks the indicator limit of the plan
// with canCreateStudy, which a test can replace or delete on the model (studies.ts). A plain empty list, as before the webpack
// runtime has loaded, is what withoutWebpackRuntime asks for. TradingViewApi.searchSymbols answers
// from the search items of the fixture (search.ts).
//
// One caveat about vm contexts: this object lives in the host realm. Errors it throws are not
// instances of the Error of a context that evaluates page code, so page code must not rely on
// `instanceof Error` for them. Arrays and promises it returns are fine for Array.isArray and
// await.
//
// Inspection: the window is a plain object with nothing test-only on it. inspectFakeWindow(win)
// returns the recorded calls and the live state of the window it was created for.

export type VisibilityState = 'visible' | 'hidden';

export interface FakeTvOverrides {
  visibilityState?: VisibilityState;
  // Leaves TradingViewApi out, like the page before the app has booted.
  withoutApi?: boolean;
  // How many seconds the time the chart reports for a bar (getVisibleRange,
  // _convertIndexToPublicTime) lies before the time in its row (bars().valueAt). The app reports a
  // daily bar as its day at 00:00 UTC while the row holds the start of its session, 13:30 UTC for
  // a US stock (seen on the app), which 48_600 models. Default 0, where both are the same, as for
  // intraday bars. The visible range of the fixture is given in the times of the rows.
  sessionOffsetSeconds?: number;
  // How many time points the time scale keeps after the last bar, for the empty space a chart
  // shows there; dozens were seen on the app. They follow the last bar by the bar step. Default
  // 0: the time scale ends at the last bar.
  futurePoints?: number;
  // What chart.symbol() shows for a symbol once TradingView has resolved it, by the symbol as it
  // was set: the chart names a symbol by the exchange of its data feed, which the symbol info calls
  // full_name, while pro_name keeps the listing. { 'NASDAQ:AAPL': 'BATS:AAPL' } models an account
  // whose US stock data comes from Cboe (seen on the app). A chart starts on the feed of the fixture
  // symbol, and a feed name is a known symbol too. Default: every symbol shows as it was set.
  feeds?: Readonly<Record<string, string>>;
  // The modules in the cache of the webpack registry, by module ID, each given as its exports
  // object. They replace the default ones, the plan feature modules of the fixture; {} gives a
  // runtime whose cache is empty. The chunk list is the one of a fake webpack runtime
  // (createFakeWebpack), which hands the page library a require whose cache holds these modules.
  webpackModules?: Record<string, Record<string, unknown>>;
  // A plain empty chunk list, where a push hands nothing back, as before the webpack runtime has
  // loaded. Wins over webpackModules.
  withoutWebpackRuntime?: boolean;
  // How long a requestMoreData call takes to bring its bars. Default 10 ms.
  historyLoadMs?: number;
  // The most bars one requestMoreData call brings. Default: as many as were asked for.
  historyBatchBars?: number;
  // A requestMoreData call that brings no bar sets no end flag (history.ts). Default false.
  historyEndUnflagged?: boolean;
  // Whether the study repository has its metadata already. Default true (studies.ts).
  studyRepositoryReady?: boolean;
  // The message requestBuiltinScripts rejects with. Default: it answers (studies.ts).
  builtinScriptsError?: string;
}

export interface FakeBars {
  size(): number;
  firstIndex(): number | null;
  lastIndex(): number | null;
  valueAt(index: number): SyntheticBar | null;
}

export interface FakeTimeScale {
  zoomToBarsRange(fromIndex: number, toIndex: number): void;
  scrollToBar(index: number): void;
  timePointToIndex(time: number): number | null;
  logicalRange(): { left(): number; right(): number } | null;
  // The indices of the time points, bars and the points after them.
  points(): { range(): { value(): { firstIndex: number; lastIndex: number } | null } };
}

export interface FakeMainSeries {
  bars(): FakeBars;
  symbolInfo(): Record<string, JsonValue> | null;
  quotes(): Record<string, JsonValue> | null;
  isSymbolInvalid(): boolean;
  requestMoreData(count?: number): void;
  requestMoreDataAvailable(): boolean;
  endOfData(): boolean;
  endOfDataType(): string | null;
  isLoading(): boolean;
  status(): number;
}

export interface FakeSetOptions {
  dataReady?: () => void;
  doNotActivateChart?: boolean;
}

// The chart model, _chartWidget.model(). canCreateStudy is optional so that a test can delete it, as
// on a build without it.
export interface FakeChartModel {
  mainSeries(): FakeMainSeries;
  model(): { timeScale(): FakeTimeScale };
  canCreateStudy?: (spec: { id: string }) => FakeCanCreateStudy;
}

export interface FakeChartWidgetApi {
  symbol(): string;
  resolution(): string;
  chartType(): number;
  getVisibleRange(): { from: number; to: number };
  getAllStudies(): { id: string; name: string }[];
  // Throws "There is no such study" for an id that is not on the chart.
  getStudyById(id: string): FakeStudyApi;
  getAllShapes(): { id: string; name: string }[];
  createStudy: FakeStudies['createStudy'];
  removeEntity: FakeStudies['removeEntity'];
  setSymbol(symbol: string, options?: FakeSetOptions): Promise<true>;
  setResolution(resolution: string, options?: FakeSetOptions): Promise<true>;
  setChartType(chartType: number): Promise<void>;
  setVisibleRange(range: { from: number; to: number }): never;
  // The time the chart reports for the time point at an index, or null for an index without one.
  _convertIndexToPublicTime(index: number): number | null;
  readonly _chartWidget: { model(): FakeChartModel };
}

export interface FakeTradingViewApi {
  activeChart(): FakeChartWidgetApi;
  chart(index?: number): FakeChartWidgetApi;
  chartsCount(): number;
  activeChartIndex(): number;
  setActiveChart(index: number): void;
  layout(): string;
  layoutName(): string;
  layoutId(): string;
  isConnected(): boolean;
  getIntervals(): string[];
  searchSymbols(options: FakeSearchOptions): Promise<FakeSearchResponse>;
}

export interface FakeLocation {
  href: string;
  origin: string;
  protocol: string;
  host: string;
  hostname: string;
  pathname: string;
  search: string;
  hash: string;
}

export interface FakeTvWindow {
  TradingViewApi?: FakeTradingViewApi;
  TVD: { reloadTab(): void };
  BUILD_TIME: string;
  webpackChunktradingview: unknown[];
  document: { readonly visibilityState: VisibilityState };
  location: FakeLocation;
}

// One mutating call, by the dotted name of the member: TradingViewApi.setActiveChart,
// chart.setSymbol, chart.setResolution, chart.setChartType, chart.setVisibleRange,
// timeScale.zoomToBarsRange, timeScale.scrollToBar, series.requestMoreData and TVD.reloadTab.
// Calls that send a request are recorded too: TradingViewApi.searchSymbols, the members of the
// quote modules that would create a quote session or send a request (quotes.ts), and
// requestBuiltinScripts and studyMetaInfoRepository.requestMetaInfo (studies.ts). So are the changes
// to studies, chart.createStudy, chart.removeEntity, study.setInputValues and study.setVisible
// (each with the study id first), and the dialogs the app would open on the way, as dialog.paywall,
// dialog.tooManyStudies and dialog.studyInputs (studies.ts). A call is
// recorded before it is validated, so refused and throwing calls show up too. Reads are not
// recorded.
export interface FakeCall {
  readonly name: string;
  readonly args: readonly unknown[];
}

// The live state behind the window. Tests may assign to it to stage a situation, for example
// connected = false to simulate a dropped data connection.
export interface FakeTvState {
  symbol: string;
  resolution: string;
  chartType: number;
  // In the times the chart reports (see sessionOffsetSeconds).
  visibleRange: { from: number; to: number };
  activeChartIndex: number;
  symbolInvalid: boolean;
  connected: boolean;
  visibilityState: VisibilityState;
  // Every study removeEntity removed, in order, and whether the removal can be undone.
  removedStudies: { id: string; undoable: boolean }[];
}

export interface FakeTvInspector {
  readonly calls: FakeCall[];
  readonly state: FakeTvState;
  // The argument lists of every recorded call with this name, in order.
  callsTo(name: string): (readonly unknown[])[];
}

const inspectors = new WeakMap<object, FakeTvInspector>();

export function inspectFakeWindow(window: object): FakeTvInspector {
  const inspector = inspectors.get(window);
  if (!inspector) {
    throw new Error('The object is not a fake TradingView window');
  }
  return inspector;
}

function createLocation(href: string): FakeLocation {
  const url = new URL(href);
  return {
    href: url.href,
    origin: url.origin,
    protocol: url.protocol,
    host: url.host,
    hostname: url.hostname,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
  };
}

function copyBar(bar: SyntheticBar): SyntheticBar {
  return [bar[0], bar[1], bar[2], bar[3], bar[4], bar[5]];
}

export function createFakeTvWindow(
  fixture: TvStateFixture,
  overrides: FakeTvOverrides = {},
): FakeTvWindow {
  const feeds = new Map(Object.entries(overrides.feeds ?? {}));
  // The listing a symbol the chart shows stands for: the symbol whose feed it is, or itself.
  const listingOf = (shown: string): string =>
    [...feeds].find(([, feed]) => feed === shown)?.[0] ?? shown;
  const offset = overrides.sessionOffsetSeconds ?? 0;
  const knownSymbols = new Set([
    ...fixture.knownSymbols,
    ...(overrides.feeds ? Object.values(overrides.feeds) : []),
  ]);
  const calls: FakeCall[] = [];
  const state: FakeTvState = {
    symbol: feeds.get(fixture.symbol) ?? fixture.symbol,
    resolution: fixture.resolution,
    chartType: fixture.chartType,
    visibleRange: {
      from: fixture.visibleRange.from - offset,
      to: fixture.visibleRange.to - offset,
    },
    activeChartIndex: 0,
    symbolInvalid: false,
    connected: true,
    visibilityState: overrides.visibilityState ?? 'visible',
    removedStudies: [],
  };

  const record = (name: string, args: readonly unknown[]): void => {
    calls.push({ name, args });
  };

  // The bars of the series, which grow at the front as older history loads. A request needs bars
  // to load in front of.
  const history = createFakeHistory(fixture, {
    loadMs: overrides.historyLoadMs ?? 10,
    batchBars: overrides.historyBatchBars ?? Infinity,
    endUnflagged: overrides.historyEndUnflagged ?? false,
    canRequest: () => !state.symbolInvalid,
    record,
  });
  // The times of the time points: the bars, then the points after the last one.
  const pointTimes = (): number[] => {
    const times = history.bars().map((bar) => bar[0]);
    const lastTime = times.at(-1);
    return lastTime === undefined
      ? []
      : [
          ...times,
          ...Array.from(
            { length: overrides.futurePoints ?? 0 },
            (_, index) => lastTime + (index + 1) * fixture.bars.stepSeconds,
          ),
        ];
  };
  // The times the chart reports for the time points: getVisibleRange speaks in these.
  const publicTimes = (): number[] => pointTimes().map((time) => time - offset);

  // setSymbol and setResolution make their chart the active one unless told not to, as the app
  // does. The fake has one chart, at index 0.
  const activate = (options: FakeSetOptions | undefined): void => {
    if (options?.doNotActivateChart !== true) {
      state.activeChartIndex = 0;
    }
  };

  // The app reports readiness later than the call that asked for it, and a callback of the
  // page that throws is the page's own problem, not the caller's.
  const notifyDataReady = (options: FakeSetOptions | undefined): void => {
    const dataReady = options?.dataReady;
    if (typeof dataReady !== 'function') {
      return;
    }
    queueMicrotask(() => {
      try {
        dataReady();
      } catch {
        // Swallowed on purpose, like an uncaught error in the callback of the real app.
      }
    });
  };

  // Index of the time in `list` that is closest to `time`; the earlier one wins a tie.
  const nearestIn = (list: readonly number[], time: number): number | null => {
    if (list.length === 0 || !Number.isFinite(time)) {
      return null;
    }
    let low = 0;
    let high = list.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((list[middle] ?? Infinity) < time) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    const before = list[low - 1];
    const at = list[low];
    if (before !== undefined && at !== undefined && time - before <= at - time) {
      return low - 1;
    }
    return low;
  };

  // The bars a page sees: none while the series is flagged for an unknown symbol.
  const loaded = (): readonly SyntheticBar[] => (state.symbolInvalid ? [] : history.bars());
  // The time points a page sees, which go with the bars.
  const points = (): readonly number[] => (loaded().length === 0 ? [] : publicTimes());

  // What timePointToIndex answers on the app, for a time in the time base of the rows: the index of
  // the first time point at or after the time, the last point for a time after every point, and
  // null when there are no points or the time is not a number.
  const firstPointAtOrAfter = (time: number): number | null => {
    const internal = loaded().length === 0 ? [] : pointTimes();
    if (internal.length === 0 || Number.isNaN(time)) {
      return null;
    }
    const index = internal.findIndex((pointTime) => pointTime >= time);
    return index === -1 ? internal.length - 1 : index;
  };

  // The time the chart reports for the time point nearest to an index. A zoom past the time points
  // stays on them. The real time scale can reach beyond them, but there is no time to report.
  const timeAtClamped = (index: number): number => {
    if (Number.isNaN(index)) {
      throw new RangeError('Bar index must be a number');
    }
    const times = publicTimes();
    const clamped = Math.min(Math.max(Math.round(index), 0), times.length - 1);
    return times[clamped] ?? Number.NaN;
  };

  const barContainer: FakeBars = {
    size: () => loaded().length,
    firstIndex: () => (loaded().length === 0 ? null : 0),
    lastIndex: () => (loaded().length === 0 ? null : loaded().length - 1),
    valueAt(index) {
      const bar = Number.isInteger(index) ? loaded()[index] : undefined;
      return bar ? copyBar(bar) : null;
    },
  };

  const timeScale: FakeTimeScale = {
    zoomToBarsRange(fromIndex, toIndex) {
      record('timeScale.zoomToBarsRange', [fromIndex, toIndex]);
      // The app ignores a range whose ends are the wrong way round.
      if (loaded().length > 0 && !(toIndex < fromIndex)) {
        state.visibleRange = { from: timeAtClamped(fromIndex), to: timeAtClamped(toIndex) };
      }
    },
    scrollToBar(index) {
      record('timeScale.scrollToBar', [index]);
    },
    timePointToIndex: firstPointAtOrAfter,
    // An object with left() and right(), the shape of the app's logical range.
    logicalRange() {
      if (loaded().length === 0) {
        return null;
      }
      const from = nearestIn(points(), state.visibleRange.from);
      const to = nearestIn(points(), state.visibleRange.to);
      return from === null || to === null ? null : { left: () => from, right: () => to };
    },
    points: () => ({
      range: () => ({
        value: () =>
          points().length === 0 ? null : { firstIndex: 0, lastIndex: points().length - 1 },
      }),
    }),
  };

  const mainSeries: FakeMainSeries = {
    bars: () => barContainer,
    symbolInfo: () => {
      if (state.symbolInvalid) {
        return null;
      }
      const listing = listingOf(state.symbol);
      return {
        ...structuredClone(fixture.symbolInfo),
        name: listing.slice(listing.lastIndexOf(':') + 1),
        full_name: state.symbol,
        pro_name: listing,
      };
    },
    quotes: () => (state.symbolInvalid ? null : structuredClone(fixture.quote)),
    isSymbolInvalid: () => state.symbolInvalid,
    requestMoreData: (count) => {
      history.requestMoreData(count);
    },
    requestMoreDataAvailable: () => history.requestMoreDataAvailable(),
    endOfData: () => history.endOfData(),
    endOfDataType: () => history.endOfDataType(),
    isLoading: () => history.isLoading(),
    status: () => history.status(),
  };

  // Stable like the model of the real widget: the same objects come back on every call.
  const coreModel = { timeScale: () => timeScale };
  const chartModel: FakeChartModel = { mainSeries: () => mainSeries, model: () => coreModel };
  const studies = createFakeStudies(fixture, loaded, {
    record,
    canCreateStudy: (spec) => chartModel.canCreateStudy?.(spec),
    removed: state.removedStudies,
  });
  chartModel.canCreateStudy = (spec) => studies.canCreateStudy(spec);

  const chart: FakeChartWidgetApi = {
    symbol: () => state.symbol,
    resolution: () => state.resolution,
    chartType: () => state.chartType,
    getVisibleRange: () => (state.symbolInvalid ? { from: 0, to: 0 } : { ...state.visibleRange }),
    getAllStudies: () => studies.getAllStudies(),
    getStudyById: (id) => studies.getStudyById(id),
    getAllShapes: () => fixture.shapes.map(({ id, name }) => ({ id, name })),
    createStudy: (...args) => studies.createStudy(...args),
    removeEntity: (id, options) => {
      studies.removeEntity(id, options);
    },
    setSymbol(symbol, options) {
      record('chart.setSymbol', options === undefined ? [symbol] : [symbol, options]);
      activate(options);
      // The requested symbol sticks even when it is unknown; only the series flag and the
      // missing dataReady tell the page it did not resolve.
      state.symbol = symbol;
      state.symbolInvalid = !knownSymbols.has(symbol);
      if (!state.symbolInvalid) {
        // Once resolved, the chart shows the symbol by its data feed, before dataReady runs.
        const feed = feeds.get(symbol);
        if (feed !== undefined) {
          queueMicrotask(() => {
            if (state.symbol === symbol) {
              state.symbol = feed;
            }
          });
        }
        notifyDataReady(options);
      }
      return Promise.resolve(true);
    },
    setResolution(resolution, options) {
      record('chart.setResolution', options === undefined ? [resolution] : [resolution, options]);
      activate(options);
      state.resolution = resolution;
      notifyDataReady(options);
      return Promise.resolve(true);
    },
    setChartType(chartType) {
      record('chart.setChartType', [chartType]);
      state.chartType = chartType;
      return Promise.resolve();
    },
    setVisibleRange(range) {
      record('chart.setVisibleRange', [range]);
      throw new Error('Not implemented');
    },
    _convertIndexToPublicTime: (index) =>
      Number.isInteger(index) ? (points()[index] ?? null) : null,
    _chartWidget: { model: () => chartModel },
  };

  const api: FakeTradingViewApi = {
    activeChart: () => chart,
    // The real build builds one widget per layout slot; the fake models a single chart and
    // refuses the rest with the message of the real build.
    chart(index = 0) {
      if (index !== 0) {
        throw new Error(`Incorrect index: ${String(index)}`);
      }
      return chart;
    },
    chartsCount: () => fixture.layout.chartsCount,
    activeChartIndex: () => state.activeChartIndex,
    setActiveChart(index) {
      record('TradingViewApi.setActiveChart', [index]);
      if (!Number.isInteger(index) || index < 0 || index >= fixture.layout.chartsCount) {
        throw new Error(`Incorrect index: ${String(index)}`);
      }
      state.activeChartIndex = index;
    },
    layout: () => fixture.layout.type,
    layoutName: () => fixture.layout.name,
    layoutId: () => fixture.layout.id,
    isConnected: () => state.connected,
    getIntervals: () => [...fixture.intervals],
    searchSymbols: createFakeSearch(fixture.search, record),
  };

  const win: FakeTvWindow = {
    TVD: {
      reloadTab() {
        record('TVD.reloadTab', []);
      },
    },
    BUILD_TIME: fixture.buildTime,
    webpackChunktradingview:
      overrides.withoutWebpackRuntime === true
        ? []
        : createFakeWebpack(
            overrides.webpackModules ?? {
              ...createPlanLimitModules(fixture.planLimits),
              ...createQuoteModules(fixture.quoteCache, record),
              ...createStudyCatalogModules(fixture.studyCatalog, {
                repositoryReady: overrides.studyRepositoryReady ?? true,
                builtinScriptsError: overrides.builtinScriptsError,
                record,
              }),
            },
          ),
    document: {
      get visibilityState() {
        return state.visibilityState;
      },
    },
    location: createLocation(
      `https://www.tradingview.com/chart/${encodeURIComponent(fixture.layout.id)}/`,
    ),
  };
  if (overrides.withoutApi !== true) {
    win.TradingViewApi = api;
  }

  inspectors.set(win, {
    calls,
    state,
    callsTo: (name) => calls.filter((call) => call.name === name).map((call) => call.args),
  });
  return win;
}
