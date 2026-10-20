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
  // The global of the app that holds its widgets (notes, section 4.1).
  TradingView?: TradingViewGlobalLike;
  // The desktop bridge the preload script exposes (notes, section 2.4).
  TVD?: TvdLike;
  // When the web app was built, such as "2026-10-16T17:55:37".
  BUILD_TIME?: string;
  // Whether an account is signed in. The app sends no request about saved Pine scripts and saves
  // none while it is false, and the facade of the Pine Editor asks the user to sign in instead.
  is_authenticated?: boolean;
  // The webpack chunk list, the way into the module registry (notes, section 4.7). Only the page
  // library (page-lib.ts) pushes to it.
  webpackChunktradingview?: WebpackChunkListLike;
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
  // The replay API (notes, section 4.5) is not described here, so page code can only check that it
  // is there.
  replayApi?(): Promise<unknown>;
  // The Pine Editor API (notes of Plan 2, section Q1), the same object on every call.
  pineEditorApi?(): PineEditorApiLike;
  // The symbol search of the app, the request its search dialog sends (an HTTP GET to the symbol
  // search service; no data session is involved). It rejects for a type it does not know and for
  // an answer that is not 2xx.
  searchSymbols?(options: SymbolSearchOptionsLike): Promise<SymbolSearchResponseLike>;
}

// The options of searchSymbols that page code passes. The app knows more (paging, language, broker
// filters), which the server leaves out. type is one of "", stocks, funds, futures, forex, cfd,
// "bitcoin,crypto", index, bond, economic and options. serverHighlight false asks for no markup;
// the dialog itself asks for <em> highlights in symbol and description.
export interface SymbolSearchOptionsLike {
  text: string;
  exchange?: string;
  type?: string;
  serverHighlight: boolean;
}

// What searchSymbols resolves with. The items were read from the consumers in the dialog, never
// observed (calling it sends a request), so they are typed loosely: symbol, description, exchange,
// prefix, type, typespecs, currency_code, country, full_name, and contracts for a futures root.
// symbols_remaining counts the results not returned yet.
export interface SymbolSearchResponseLike {
  symbols?: unknown;
  symbols_remaining?: unknown;
}

// The API of one chart, from activeChart() or chart(index) (notes, section 4.3).
export interface ChartWidgetApiLike {
  symbol(): string;
  resolution(): string;
  // 1 is candles.
  chartType(): number;
  // Unix seconds.
  getVisibleRange(): { from: number; to: number };
  // Every study on the chart, strategies included. name is the description of its metadata.
  getAllStudies(): { id: string; name: string }[];
  // The API of a study on the chart; throws "There is no such study" for any other id.
  getStudyById(id: string): StudyApiLike;
  getAllShapes(): { id: string; name: string }[];
  // Adds a study and resolves its id, or null (notes of Plan 2, section 7). A name is the
  // description of a built-in, compared lower case, and the first match counts, hidden built-ins
  // included; with options.checkLimit the app asks canCreateStudy and, when that fails, shows a
  // warning dialog and resolves null. A descriptor ignores every other argument, checkLimit
  // included: it always asks canCreateStudy and opens the paywall when that fails, it opens an
  // input dialog of the app for some studies, and it rejects with an insertion error code (a
  // string) when it cannot add the study.
  createStudy(
    nameOrDescriptor: string | StudyDescriptorLike,
    forceOverlay?: boolean,
    lock?: boolean,
    inputs?: Record<string, unknown>,
    overrides?: Record<string, unknown>,
    options?: { checkLimit?: boolean },
  ): Promise<string | null>;
  // Removes a study (any source) by id. By default as a command the user can undo; an id that is
  // not on the chart only makes the app warn.
  removeEntity(id: string, options?: { disableUndo?: boolean }): void;
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

// What createStudy takes instead of a name: a built-in by the id of its metadata, or a Pine script
// by its scriptIdPart and script version.
export type StudyDescriptorLike =
  { type: 'java'; studyId: string } | { type: 'pine'; pineId: string; pineVersion: string };

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
  // Whether a study with the id of this metadata (empty for Pine) may be added, read from the
  // counters and entitlements of the session without changing anything (notes of Plan 2, section
  // 7). reason general is the indicator limit of the plan, with the limit as limitValue. A build may
  // not have it. Its neighbor checkIfFeatureAvailable opens paywall dialogs and is left out on
  // purpose.
  canCreateStudy?(spec: { id: string }): CanCreateStudyLike;
}

// What canCreateStudy answers: success, or the reason it fails (general, child, fundamental or
// forecast) with limitValue for the general limit.
export interface CanCreateStudyLike {
  success: boolean;
  reason?: string;
  limitValue?: number;
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
  // The live quote: last_price, change, change_percent, bid, ask, bid_size, ask_size, open_price,
  // high_price, low_price, prev_close_price, volume, lp_time (Unix seconds), currency_code and
  // about a thousand fundamentals. It is the live object the app merges updates into, so page code
  // copies fields out of it. The wire names lp, ch and chp never appear: the app renames them
  // before it keeps a quote. Null while the series has no data.
  quotes(): Record<string, unknown> | null;
  // Whether the symbol the series was given could not be resolved, in which case dataReady does not
  // run: the series status is InvalidSymbol (seen on the app). It turns true about 150 ms after
  // setSymbol is given an unknown symbol, while symbol() keeps the text as set and symbolInfo()
  // stays null.
  isSymbolInvalid(): boolean;
  // Older history. requestMoreData asks for `count` more bars
  // before the first one and returns at once; it does nothing unless the series is ready, has bars
  // laid out on the chart and requestMoreDataAvailable() is true. A request that is sent makes
  // requestMoreDataAvailable() false and isLoading() true at once; the bars arrive at the front,
  // which makes it true again, and isLoading() turns false. A request that brings no bar leaves it
  // false for good. endOfData() tells that no more history comes, and endOfDataType() why: "end"
  // when the first bar of the symbol was reached, another text (not observed) for the history
  // limit of the plan, null before the end.
  requestMoreData(count?: number): void;
  requestMoreDataAvailable(): boolean;
  endOfData(): boolean;
  endOfDataType(): string | null;
  isLoading(): boolean;
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

// window.webpackChunktradingview (notes, section 4.7). The webpack runtime of the app replaces push
// on this list with its chunk callback. A chunk with a chunk ID the runtime has not seen gets its
// module factories registered and its callback called with the require function of the app. Either
// way the chunk is then appended to the list and its IDs count as loaded, so a chunk ID that comes
// back gets nothing. Before the runtime has loaded, the list is a plain array and push only
// appends.
export interface WebpackChunkListLike {
  push(chunk: WebpackChunk): unknown;
}

// A chunk as page code sends it: its IDs, no module factory (one would add a module to the app),
// and the callback that receives require.
export type WebpackChunk = [
  chunkIds: string[],
  factories: Record<string, never>,
  callback: (require: WebpackRequireLike) => void,
];

// The require function of the app, as far as page code may use it: its module cache, c, which maps
// module IDs to the records of the modules whose factories have run. Calling require for a module
// that is not cached runs the factory of that module, and so does calling a factory in m, so the
// function itself and m are left out on purpose.
export interface WebpackRequireLike {
  readonly c?: Readonly<Record<string, WebpackModuleLike | undefined>>;
}

// A record of the module cache, { id, loaded, exports } on the observed build. An ES module defines
// each export on its exports object as a getter, which throws while the module has not set up the
// binding behind it.
export interface WebpackModuleLike {
  readonly exports?: unknown;
}

// The quote caches of the app, which page code reads by the names of their webpack exports (section
// 4.7). None of the reads below creates a session or sends a request; the
// members next to them that would (getQuoteSessionInstance, snapshoter, quoteSessionAdapters.get,
// and the snapshot and subscribe of a session) are left out on purpose.
//
// An entry of a cache. values holds only the fields the app has received, and is empty for an
// entry whose status is "error".
export interface QuoteEntryLike {
  symbolname?: unknown;
  status?: unknown;
  values?: unknown;
}

// The export QUOTE_FIELDS_CACHE, which every quote session of the app feeds. It is keyed by the
// symbol as the app subscribed it: EXCHANGE:TICKER, or an encoded ={...} form.
export interface QuoteFieldsCacheLike {
  get(symbol: string): QuoteEntryLike | null;
}

// What the export getQuoteSessionNoEnsure answers for a session type such as "full": the session
// when the app created it, else undefined. data() maps a symbol to its entry.
export interface QuoteSessionLike {
  internals(): { data(): Record<string, QuoteEntryLike | undefined> };
}

// The export quoteSessionAdapters: only its cache of the watchlist widget, a Map from a symbol to
// its entry. Its own get(clientId, type) creates an adapter.
export interface QuoteSessionAdaptersLike {
  readonly _lastSymbolData?: {
    has(symbol: string): boolean;
    get(symbol: string): QuoteEntryLike | undefined;
  };
}

// The API of one study on the chart, from getStudyById (notes of Plan 2, section 5). Every member
// of the real class is a function; only those page code reads are described.
export interface StudyApiLike {
  // What the legend shows, such as "RSI 14 close".
  title(): string;
  isVisible(): boolean;
  // The inputs of the metadata with localizedName: every input, the hidden Pine internals (text,
  // pineId, pineVersion and more, with isHidden true) included.
  getInputsInfo(): StudyInputInfoLike[];
  // The value of each input, in the order of getInputsInfo, unwrapped.
  getInputValues(): { id: string; value: unknown }[];
  // Sets the value of each input by input id.
  setInputValues(values: { id: string; value: unknown }[]): void;
  setVisible(visible: boolean): void;
  // The study core, which holds the metadata and the rows.
  study(): StudyCoreLike;
}

// An input as getInputsInfo reports it. type is one of integer, float, price, bool, text, symbol,
// session, source, resolution, time, bar_time, color and text_area; options lists the choices of
// an input that has them, text or numbers. The inputs of a Pine script are isFake, which is normal
// for Pine. min and max bound a number; confirm makes the app ask for the value in a dialog when the
// study is added.
export interface StudyInputInfoLike {
  id: string;
  name: string;
  localizedName?: string;
  type: string;
  defval?: unknown;
  options?: (string | number)[];
  isHidden?: boolean;
  isFake?: boolean;
  min?: number;
  max?: number;
  confirm?: boolean;
}

// The study core, api.study(). A strategy carries the own flag isStudyStrategy, which indicators do
// not have, and the members strategyOrdersPaneView, ordersData and reportData, which the app tests
// for (not observed live).
export interface StudyCoreLike {
  id(): string;
  metaInfo(): StudyMetaInfoLike;
  // The rows of the study.
  data(): PlotListLike;
  readonly isStudyStrategy?: boolean;
}

// The metadata of a study, a class instance on the app. A Pine study has pine (its script version
// and digest) and scriptIdPart, such as STD;RSI; a built-in has neither. styles holds the title of
// each plot by plot id, HTML-entity encoded, and has no entry for a colorer; ohlcPlots holds the
// title of the bars that the ohlc_* plots with that target draw. The metadata of the study
// repository is the same class: is_hidden_study is there only when true, and extra.kind or
// isTVScriptStrategy mark a strategy.
export interface StudyMetaInfoLike {
  id?: string;
  description?: string;
  shortDescription?: string;
  plots?: StudyPlotLike[];
  styles?: Record<string, { title?: string } | undefined>;
  ohlcPlots?: Record<string, { title?: string } | undefined>;
  inputs?: StudyInputInfoLike[];
  pine?: { version: string; digest?: string };
  scriptIdPart?: string;
  is_hidden_study?: boolean;
  extra?: { kind?: string };
  isTVScriptStrategy?: boolean;
}

// A plot of a study. type is line, shapes, chars, arrows, data, dataoffset, alertcondition, one of
// the ohlc_* plots, or a colorer (colorer, bar_colorer, bg_colorer and the other *_colorer types),
// whose target is the plot or filled area it colors.
export interface StudyPlotLike {
  id: string;
  type: string;
  target?: string;
}

// The rows of a study, study().data(). A row is [time, ...one slot per plot]: slot k + 1 belongs to
// plot k, the time is in the time base of the bar rows, and a value that was not computed is
// undefined or NaN. Rows at the indices of the bars (firstPlottableIndex to lastIndex) follow
// pre-history rows at -1e6 and below, which page code skips. search finds the row at an index
// (mode 0), the nearest at or before it (-1) or at or after it (1); rangeIterator yields the rows
// whose indices lie between two indices.
export interface PlotListLike {
  firstPlottableIndex(): number | null;
  lastIndex(): number | null;
  valueAt(index: number): PlotRowLike | null;
  search(index: number, mode?: number): PlotItemLike | null;
  rangeIterator(from: number, to: number): Iterable<PlotItemLike>;
}

export type PlotRowLike = (number | null | undefined)[];

export interface PlotItemLike {
  index: number;
  value: PlotRowLike;
}

// The export studyMetaInfoRepository: a getter of the repository of study metadata. Once isReady
// is true, getInternalMetaInfoArray is the array of the metadata of the built-in studies, the
// hidden ones included, and findAllJavaStudies resolves with it from the cache. Before that,
// findAllJavaStudies requests the metadata from the data servers, once. findById, which can
// compile Pine, is left out on purpose.
export interface StudyMetaInfoRepositoryLike {
  isReady(): boolean;
  getInternalMetaInfoArray(): StudyMetaInfoLike[];
  findAllJavaStudies(): Promise<StudyMetaInfoLike[]>;
}

// An item of the list of standard Pine scripts that the export requestBuiltinScripts resolves with
// (a request to the pine facade, list?filter=standard, on every call). The shape is that of the
// saved script list of the same service, read from the consumers of both in the web build:
// scriptIdPart (STD;RSI), scriptName, version (the script version a Pine study descriptor takes as
// pineVersion) and extra.kind (study, strategy or library; study when missing). scriptTitle is
// not confirmed. Typed loosely because the list was never observed.
export interface StandardScriptLike {
  scriptIdPart?: unknown;
  scriptName?: unknown;
  scriptTitle?: unknown;
  version?: unknown;
  extra?: { kind?: unknown } | null;
}

// window.TVD. Only reloadTab, a last-resort recovery step, is described. The object also carries
// the user's credentials, which nothing in this server may touch (design spec, section 5.3), so
// those members are left out on purpose.
export interface TvdLike {
  reloadTab(): void;
}

// TradingViewApi.pineEditorApi() (notes of Plan 2, section Q1). Only the members page code uses
// are described. It has no close(), isOpen() or isVisible(). deleteScript and renameScript are
// left out on purpose: the server never deletes or renames a script, and so is saveExistingScript,
// which the server does not use.
export interface PineEditorApiLike {
  // Loads the chunk of the editor and opens it, as the side panel on the current layout. The Pine
  // button of the toolbar passes { scriptInfo: { script: null }, openSourceId: "main_button",
  // forceOpen: true }, which restores the script or draft the editor last held. Resolves once the
  // chunk has loaded, which may be before the editor is mounted.
  open(options?: PineEditorOpenOptions): Promise<void>;
  // The facade of the editor at a placement, or null when none is open there.
  getDialogFacade?(): PineEditorFacadeLike | null;
  getBottomFacade?(): PineEditorFacadeLike | null;
  // The same request as the export requestUserScripts: the saved scripts of the account.
  listSavedScripts?(): Promise<unknown>;
  // Saves a new script under name, with no dialog. It first runs the saved-script limit check of
  // the app, which opens the paywall when the limit is reached and then throws, so callers check
  // the limit themselves first. Rejects with a string, an Error or the compile errors when the pine
  // facade refuses the script.
  saveNewScript?(script: { source: string; name: string }): Promise<PineSaveResultLike>;
}

// What saveNewScript resolves with (handleSaveResult of the app).
export interface PineSaveResultLike {
  success?: boolean;
  metaInfo?: { scriptIdPart?: unknown; pine?: { version?: unknown } | null } | null;
  compileErrors?: PineCompileErrorsLike | null;
}

// The errors and warnings of a compilation. A diagnostic has a message and, when it has a place,
// a 1-based start line and column (0 for none).
export interface PineCompileErrorsLike {
  errors?: unknown;
  warnings?: unknown;
}

// An item of the saved scripts the export requestUserScripts resolves with (a request to the pine
// facade, list?filter=saved, memoised by the app; [] while signed out). A version whose major part
// is 0 is a server draft. modified orders the items; its unit is not known. kind was inferred from
// the type guards of the app ("study", "strategy" or "library") and may be missing. Typed loosely
// because the list was never observed.
export interface SavedPineScriptLike {
  scriptIdPart?: unknown;
  scriptName?: unknown;
  scriptTitle?: unknown;
  version?: unknown;
  modified?: unknown;
  kind?: unknown;
}

export interface PineEditorOpenOptions {
  scriptInfo?: { script: null };
  openSourceId?: string;
  forceOpen?: boolean;
}

// What the export getOpenPineEditor(placement) of the editor registry answers for "dialog" or
// "bottom" while an editor is open there, and null otherwise. The registry is a Map that only
// knows these two placements; the side panel of the current layout is taken to register as
// "dialog", which was inferred, not observed. getFacade is a pure getter.
export interface OpenPineEditorLike {
  getFacade(): PineEditorFacadeLike | null;
}

// The facade of an open editor. Only the members page code uses are described; the members that
// reset the script (releaseScript, destroy) and renameScript are left out on purpose.
export interface PineEditorFacadeLike {
  // Whether the text in the editor differs from the text of the script as it was opened or saved.
  isModified(): boolean;
  // Whether the script is new: no id, no version, or a version whose major part is 0 (a server
  // draft).
  isDraft(): boolean;
  // The id and version of the script, or null without an id. The version can be missing.
  getScriptIdVersion(): { scriptIdPart: string; version?: string | undefined } | null;
  // The text in the editor. Rejects while the code editor is not mounted.
  getSource(): Promise<string>;
  // Replaces the text with the template of a new script of the type, which names the account in a
  // comment. Any other type gives the indicator template.
  openNewScript?(type?: string): Promise<void>;
  // Replaces the text, keeping the script.
  setScript?(source: string): Promise<void>;
  // Opens a saved script, loading its text with a request, or with scriptSource as its text when
  // given. On any failure it opens a new script instead, which replaces the text too.
  openScript?(info: {
    scriptIdPart: string;
    version?: string;
    scriptSource?: string;
  }): Promise<void>;
  // Saves a new version of a saved script under its own name, with no dialog. For a draft it asks
  // the user for a name in a dialog, and signed out it asks the user to sign in. Rejects with
  // undefined when there is nothing to save, the save fails or the dialog is cancelled.
  saveScript?(): Promise<{
    compileErrors?: PineCompileErrorsLike | null | undefined;
    script?: unknown;
  }>;
}

// window.TradingView, as far as page code uses it.
export interface TradingViewGlobalLike {
  bottomWidgetBar?: BottomWidgetBarLike;
  // The same function as the export isFeatureEnabled of the feature toggles: whether a toggle of
  // the app is on.
  isFeatureEnabled?(name: string): unknown;
}

// The bar of widgets at the bottom of the chart page. close() minimizes it, which hides the widget
// it shows, a Pine Editor at the bottom placement among them, and keeps the widget with its text.
export interface BottomWidgetBarLike {
  close(): void;
}

// The service locator of the app, a module whose exports are found together (hasService, service
// and four more). service throws for a descriptor nothing is registered for, so page code asks
// hasService first, as the app does.
export interface ServiceLocatorLike {
  hasService(descriptor: unknown): boolean;
  service(descriptor: unknown): unknown;
}

// The page layout service, service(PAGE_LAYOUT_SERVICE), whose descriptor is the export
// PAGE_LAYOUT_SERVICE of its own module. It knows the side panels by id; the Pine Editor is "pine".
// closeSidePanel closes a panel, and does nothing for a panel that is not open.
export interface PageLayoutServiceLike {
  hasSidePanel?(id: string): boolean;
  closeSidePanel(id: string): void;
}
