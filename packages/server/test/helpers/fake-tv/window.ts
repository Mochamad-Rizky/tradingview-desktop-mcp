import type { JsonValue } from '../../../src/utils/json.js';
import type { TvStateFixture } from './fixture.js';
import { syntheticBars, type SyntheticBar } from './synthetic-bars.js';

// A stand-in for the window of a TradingView chart tab, built from a TvStateFixture. It models
// only the members of TradingViewApi, the chart widget API and the chart model that the server
// uses (reverse-engineering notes, sections 4.2 to 4.4), with the quirks of the real build:
// setVisibleRange throws, chart(i) only knows index 0, and an unknown symbol is accepted but
// flags the series as invalid and never reports data ready. While the series is flagged it has no
// bars and no symbol info, and getVisibleRange answers zeros, as the real app does.
//
// Data is static per fixture. Bars are the same series whatever the symbol or resolution, and
// symbolInfo() and quotes() always describe the fixture symbol. The fake does not model
// per-symbol data, and bars() deliberately lacks search(), range() and each(), because their
// behavior is unverified on the real app and the server must not depend on them.
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
  logicalRange(): { from: number; to: number } | null;
}

export interface FakeMainSeries {
  bars(): FakeBars;
  symbolInfo(): Record<string, JsonValue> | null;
  quotes(): Record<string, JsonValue>;
  isSymbolInvalid(): boolean;
}

export interface FakeSetOptions {
  dataReady?: () => void;
  doNotActivateChart?: boolean;
}

export interface FakeChartWidgetApi {
  symbol(): string;
  resolution(): string;
  chartType(): number;
  getVisibleRange(): { from: number; to: number };
  getAllStudies(): { id: string; name: string }[];
  getAllShapes(): { id: string; name: string }[];
  setSymbol(symbol: string, options?: FakeSetOptions): Promise<true>;
  setResolution(resolution: string, options?: FakeSetOptions): Promise<true>;
  setChartType(chartType: number): Promise<void>;
  setVisibleRange(range: { from: number; to: number }): never;
  readonly _chartWidget: {
    model(): { mainSeries(): FakeMainSeries; model(): { timeScale(): FakeTimeScale } };
  };
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
// timeScale.zoomToBarsRange, timeScale.scrollToBar and TVD.reloadTab. A call is recorded
// before it is validated, so refused and throwing calls show up too. Reads are not recorded.
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
  visibleRange: { from: number; to: number };
  activeChartIndex: number;
  symbolInvalid: boolean;
  connected: boolean;
  visibilityState: VisibilityState;
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
  const bars = syntheticBars(fixture.bars);
  const times = bars.map((bar) => bar[0]);
  const knownSymbols = new Set(fixture.knownSymbols);
  const calls: FakeCall[] = [];
  const state: FakeTvState = {
    symbol: fixture.symbol,
    resolution: fixture.resolution,
    chartType: fixture.chartType,
    visibleRange: { ...fixture.visibleRange },
    activeChartIndex: 0,
    symbolInvalid: false,
    connected: true,
    visibilityState: overrides.visibilityState ?? 'visible',
  };

  const record = (name: string, args: readonly unknown[]): void => {
    calls.push({ name, args });
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

  // Index of the bar whose time is closest to `time`; the earlier bar wins a tie.
  const nearestIndex = (time: number): number | null => {
    if (times.length === 0 || !Number.isFinite(time)) {
      return null;
    }
    let low = 0;
    let high = times.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((times[middle] ?? Infinity) < time) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    const before = times[low - 1];
    const at = times[low];
    if (before !== undefined && at !== undefined && time - before <= at - time) {
      return low - 1;
    }
    return low;
  };

  // The bars a page sees: none while the series is flagged for an unknown symbol.
  const loaded = (): readonly SyntheticBar[] => (state.symbolInvalid ? [] : bars);

  // A zoom past the loaded history stays on the loaded bars. The real time scale can reach
  // beyond them, but there is no data to report a time for.
  const timeAtClamped = (index: number): number => {
    if (Number.isNaN(index)) {
      throw new RangeError('Bar index must be a number');
    }
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
      if (loaded().length > 0) {
        state.visibleRange = { from: timeAtClamped(fromIndex), to: timeAtClamped(toIndex) };
      }
    },
    scrollToBar(index) {
      record('timeScale.scrollToBar', [index]);
    },
    timePointToIndex: nearestIndex,
    logicalRange() {
      const from = nearestIndex(state.visibleRange.from);
      const to = nearestIndex(state.visibleRange.to);
      return from === null || to === null ? null : { from, to };
    },
  };

  const mainSeries: FakeMainSeries = {
    bars: () => barContainer,
    symbolInfo: () => (state.symbolInvalid ? null : structuredClone(fixture.symbolInfo)),
    quotes: () => structuredClone(fixture.quote),
    isSymbolInvalid: () => state.symbolInvalid,
  };

  // Stable like the model of the real widget: the same objects come back on every call.
  const coreModel = { timeScale: () => timeScale };
  const chartModel = { mainSeries: () => mainSeries, model: () => coreModel };

  const chart: FakeChartWidgetApi = {
    symbol: () => state.symbol,
    resolution: () => state.resolution,
    chartType: () => state.chartType,
    getVisibleRange: () => (state.symbolInvalid ? { from: 0, to: 0 } : { ...state.visibleRange }),
    getAllStudies: () => fixture.studies.map(({ id, name }) => ({ id, name })),
    getAllShapes: () => fixture.shapes.map(({ id, name }) => ({ id, name })),
    setSymbol(symbol, options) {
      record('chart.setSymbol', options === undefined ? [symbol] : [symbol, options]);
      // The requested symbol sticks even when it is unknown; only the series flag and the
      // missing dataReady tell the page it did not resolve.
      state.symbol = symbol;
      state.symbolInvalid = !knownSymbols.has(symbol);
      if (!state.symbolInvalid) {
        notifyDataReady(options);
      }
      return Promise.resolve(true);
    },
    setResolution(resolution, options) {
      record('chart.setResolution', options === undefined ? [resolution] : [resolution, options]);
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
  };

  const win: FakeTvWindow = {
    TVD: {
      reloadTab() {
        record('TVD.reloadTab', []);
      },
    },
    BUILD_TIME: fixture.buildTime,
    webpackChunktradingview: [],
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
