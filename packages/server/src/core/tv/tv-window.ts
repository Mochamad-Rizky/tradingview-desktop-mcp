// The window of a TradingView chart tab, as far as page functions use it: globals of the web app
// (reverse-engineering notes, sections 4.1 to 4.4) and the browser members read next to them. It
// records what TradingView Desktop 3.4.1 showed with the web build of 2026-10-16. None of it is a
// published API, so any web build can rename or drop a member.
//
// Page functions get the real window, and their tests get the shared fake window, which has to
// stay assignable to these interfaces. The interfaces describe live objects of the page: page
// functions read them and return JSON built from what they read, never the objects themselves.
//
// The globals of the app are optional because a tab that is still loading, or a page that is not
// a chart, has none of them. Result types follow the notes where they record one, and otherwise
// what the name of the member makes plain (a count is a number). Where neither says enough, the
// result is typed loosely (unknown, Record<string, unknown>) so that page code checks a value
// before relying on it.
export interface TvWindow {
  TradingViewApi?: TradingViewApiLike;
  // The desktop bridge the preload script exposes (notes, section 2.4).
  TVD?: TvdLike;
  // When the web app was built, such as "2026-10-16T17:55:37".
  BUILD_TIME?: string;
  // The webpack chunk list, the way into the module registry (notes, section 4.7). Typed as a
  // plain list because nothing pushes to it yet.
  webpackChunktradingview?: unknown[];
  // A real page has all of these. The DOM members are optional because the shared fake window
  // models the chart API and no DOM, so page code checks for a member before it relies on it.
  // querySelector is declared with the one signature page code uses: the DOM lib types it with a
  // deprecated overload as well, and the linter reports any reference to a member like that.
  document: Pick<Document, 'visibilityState'> & {
    querySelector?(selectors: string): Element | null;
    elementFromPoint?(x: number, y: number): Element | null;
    // The element that fills the screen in the browser's fullscreen mode, or null when none does.
    fullscreenElement?: Element | null;
    // The element that has the focus: the body when nothing was focused, and null in a document
    // that has no body.
    activeElement?: Element | null;
  };
  getComputedStyle?: Window['getComputedStyle'];
  location: Pick<
    Location,
    'href' | 'origin' | 'protocol' | 'host' | 'hostname' | 'pathname' | 'search' | 'hash'
  >;
}

// window.TradingViewApi, a superset of the Charting Library widget API (notes, section 4.2).
export interface TradingViewApiLike {
  activeChart(): ChartWidgetApiLike;
  // The charts of a multi-chart layout, counted from 0.
  chart(index?: number): ChartWidgetApiLike;
  chartsCount(): number;
  activeChartIndex(): number;
  setActiveChart(index: number): void;
  // The layout type, such as "s" for a single chart.
  layout(): string;
  layoutName(): string;
  layoutId(): string;
  // Whether the app is connected to the TradingView data servers. The app counts as ready once
  // this is true.
  isConnected(): boolean;
  getIntervals(): string[];
  // The replay and Pine editor APIs (notes, sections 4.5 and 4.6) are not described here, so page
  // code can only check that they are there.
  replayApi?(): Promise<unknown>;
  pineEditorApi?(): unknown;
}

// The API of one chart, from activeChart() or chart(index) (notes, section 4.3).
export interface ChartWidgetApiLike {
  symbol(): string;
  resolution(): string;
  // 1 is candles.
  chartType(): number;
  // Unix seconds.
  getVisibleRange(): { from: number; to: number };
  getAllStudies(): { id: string; name: string }[];
  getAllShapes(): { id: string; name: string }[];
  // What these return is not recorded. A change is complete when dataReady runs.
  setSymbol(symbol: string, options?: ChartChangeOptions): unknown;
  setResolution(resolution: string, options?: ChartChangeOptions): unknown;
  setChartType(type: number): unknown;
  // Throws "Not implemented" on the observed build. The core time scale sets ranges instead.
  setVisibleRange(range: { from: number; to: number }): unknown;
  // The widget behind the API. It is internal, so a build may not have it.
  readonly _chartWidget?: ChartWidgetLike;
  // The time the chart reports for the bar at an index, the one getVisibleRange speaks in: for
  // daily and longer bars the day at 00:00 UTC, while bars().valueAt() holds the start of the
  // session (13:30 UTC for a US stock). It answers for the time points after the last bar too, and
  // null while the series has no symbol info (seen on the app). Internal as well.
  _convertIndexToPublicTime?(index: number): number | null;
}

// The options of setSymbol and setResolution.
export interface ChartChangeOptions {
  // Runs once the data for the new symbol or resolution has loaded.
  dataReady?: () => void;
  doNotActivateChart?: boolean;
}

// activeChart()._chartWidget, the way to the chart model that was verified on the app. The public
// chartWidget() and chartModel() accessors probably lead to the same objects, but nobody checked.
export interface ChartWidgetLike {
  model(): ChartModelLike;
}

// _chartWidget.model() (notes, section 4.4).
export interface ChartModelLike {
  mainSeries(): SeriesLike;
  // The core model under the chart model, which owns the time scale.
  model(): CoreModelLike;
}

export interface CoreModelLike {
  timeScale(): TimeScaleLike;
}

// The main series of a chart.
export interface SeriesLike {
  bars(): BarsLike;
  // 51 fields were seen, among them name, full_name, pro_name, exchange, listed_exchange,
  // description, type, typespecs, currency_code, pricescale, minmov, pointvalue, session,
  // subsessions, timezone, has_intraday, has_extended_hours, is_replayable, variable_tick_size
  // and isin. Null from the moment a symbol is set until it is resolved, and for good when it
  // cannot be (seen on the app).
  symbolInfo(): Record<string, unknown> | null;
  // The live quote: last_price, bid, ask, bid_size, ask_size, change, change_percent, low_price,
  // lp_time, currency_code and fundamentals.
  quotes(): Record<string, unknown>;
  // Whether the last symbol change failed to resolve, in which case dataReady does not run. The
  // notes do not record this member: it models how the app treats an unknown symbol, and is still
  // to be confirmed on the real app.
  isSymbolInvalid(): boolean;
}

// mainSeries().bars(): the loaded bars, oldest first. The real container also has search(),
// range() and each(), whose behavior is unverified, so they are left out and nothing can come to
// depend on them.
export interface BarsLike {
  size(): number;
  // Can be null when no bar is loaded.
  firstIndex(): number | null;
  lastIndex(): number | null;
  valueAt(index: number): BarRow | null;
}

// One bar, as valueAt returns it. The time is in Unix seconds.
export type BarRow = [
  time: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
];

// model().model().timeScale(): the core time scale, which works in bar indices.
export interface TimeScaleLike {
  zoomToBarsRange(fromIndex: number, toIndex: number): void;
  scrollToBar(index: number): void;
  // The index of the first time point at or after a time in Unix seconds, in the time base of the
  // bar rows: the last point for a time after every point, and null without points (seen on the
  // app). A time between two bars gives the later one.
  timePointToIndex(time: number): number | null;
  // The indices of the time points: the bars, then the points the time scale keeps after the last
  // bar for the empty space a chart shows there (dozens were seen). Internal, like the time
  // scale.
  points?(): TimePointsLike;
  // The view in bar units, or null before the chart has laid out its bars.
  logicalRange(): LogicalRangeLike | null;
}

export interface TimePointsLike {
  range(): { value(): { firstIndex: number; lastIndex: number } | null };
}

// What logicalRange() answers on the app: left() and right() are the first and the last bar index
// of the view, fractional, and right() reaches past the last bar while the chart keeps empty space
// after it. The object has no from or to.
export interface LogicalRangeLike {
  left(): number;
  right(): number;
}

// window.TVD. Only reloadTab, a last-resort recovery step, is described. The object also carries
// the user's credentials, which nothing in this server may touch (design spec, section 5.3), so
// those members are left out on purpose.
export interface TvdLike {
  reloadTab(): void;
}
