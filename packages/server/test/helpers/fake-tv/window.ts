import type { JsonValue } from '../../../src/utils/json.js';
import {
  createFakeAlerts,
  encodeAlertSymbol,
  type FakeAlertsOptions,
  type FakeAlertsState,
} from './alerts.js';
import {
  createFakeCharts,
  type FakeChartsApi,
  type FakeChartsOptions,
  type FakeChartsState,
  type FakePaneApi,
} from './charts.js';
import type { FakeElement } from './dom.js';
import {
  createFakeDrawings,
  type FakeDrawingsOptions,
  type FakeDrawingsState,
  type FakeLineDataSourceApi,
} from './drawings.js';
import type { TvStateFixture } from './fixture.js';
import {
  createFakeFullscreen,
  type FakeFullscreenOptions,
  type FakeFullscreenState,
} from './fullscreen.js';
import { createFakeHistory } from './history.js';
import {
  createFakeLayouts,
  type FakeLayoutsApi,
  type FakeLayoutsOptions,
  type FakeLayoutsState,
} from './layouts.js';
import {
  createFakePineEditor,
  type FakeBottomWidgetBar,
  type FakePineEditorApi,
  type FakePineEditorState,
} from './pine-editor.js';
import { createFeatureToggleModules, createPlanLimitModules } from './plan-limits.js';
import { createQuoteModules } from './quotes.js';
import {
  createFakeReplay,
  initialReplayState,
  type FakeReplayApi,
  type FakeReplayCollection,
  type FakeReplayOptions,
  type FakeReplayState,
} from './replay.js';
import { createFakeScreen, type FakeChartWidgetDef, type FakeScreenOptions } from './screen.js';
import { createFakeSearch, type FakeSearchOptions, type FakeSearchResponse } from './search.js';
import { createFakeServiceLocator } from './service-locator.js';
import {
  createFakeStudies,
  createStudyCatalogModules,
  type FakeCanCreateStudy,
  type FakeStudies,
  type FakeStudyApi,
  type FakeStudyCore,
} from './studies.js';
import type { SyntheticBar } from './synthetic-bars.js';
import {
  createFakeWatchlists,
  type FakeWatchlistsOptions,
  type FakeWatchlistsState,
} from './watchlists.js';
import { createFakeWebpack } from './webpack.js';

// A stand-in for the window of a TradingView chart tab, built from a TvStateFixture. It models
// only the members of TradingViewApi, the chart widget API and the chart model that the server
// uses (reverse-engineering notes, sections 4.2 to 4.4), with the quirks of the real build:
// setVisibleRange throws, chart(i) throws for an index the layout does not show, and an unknown
// symbol is accepted but flags the series as invalid and never reports data ready. While the series
// is flagged it has no bars and no symbol info, and getVisibleRange answers zeros, as the real app
// does. The chart of the fixture is chart 0, the one everything below describes.
//
// The charts of the layout (charts.ts) come from the layout and the charts of the fixture: the
// other charts from chart 1 on, with their symbols, studies, drawings and panes, the panes of chart
// 0, the active chart, setActiveChart, layout() and setLayout, which changes the layout the way the
// app does, the MULTIPLE_CHARTS paywall included, and the table of the layouts of the app, which is
// in the default webpack cache. A fixture without other charts reaches chart 0 alone, whatever its
// chartsCount, as before the other charts were modeled. state.charts holds the layout and the other
// charts; the charts option sets how long a change of the layout and the data of a new chart take,
// and leaves codes or the table out.
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
// The core model also answers the study core of a study on the chart by id, the same object the
// study API gives, and the core time scale gives the time of a time point by its index, in the time
// base of the bar rows, the points after the last bar included (futurePoints). The drawings a Pine
// study holds come with its core (pine-graphics.ts), and the report of a strategy with its core too
// (strategy.ts). The core model reports the active strategy source as a watched value, null unless
// a strategy of the fixture is flagged active.
//
// The Pine Editor comes from the pineEditor of the fixture (pine-editor.ts): its registry and the
// descriptor of the page layout service are in the default webpack cache, the page layout service is
// registered with the service locator of the app (service-locator.ts), whose module is in the cache
// too, TradingViewApi.pineEditorApi() opens it, and TradingView.bottomWidgetBar
// closes it at the bottom placement. Its live state is state.pineEditor, which also holds the saved
// scripts of the account, listed by the export requestUserScripts of the cache, and whether the
// account is signed in, which window.is_authenticated reports. The module of the feature toggles
// (isFeatureEnabled) is in the default cache too, driven by the featureToggles of the fixture.
//
// The screen (screen.ts): the window has an innerWidth and an innerHeight, an outerWidth (which is
// wider than the inner one by the page zoom), a devicePixelRatio and a scroll position, which the
// fake debug port answers Page.getLayoutMetrics and Page.captureScreenshot from, and the
// containers that hold the charts of the layout, one for each chart. The chart widget collection of
// the app hands them out (TradingViewApi._chartWidgetCollection), and document.querySelectorAll
// lists them in document order, which is all of the DOM the window has. A test moves one with
// place() on the elements of state.chartContainers.
//
// TradingView's own fullscreen mode (fullscreen.ts): TradingViewApi.startFullscreen and
// exitFullscreen turn it on and off, the collection of the charts reports it, and state.fullscreen
// holds it.
//
// The drawings (drawings.ts) come from the shapes of the fixture: getAllShapes and getShapeById
// read them, createShape and createMultipointShape add them behind the gate of the app (signed in,
// the drawings experiment), removeEntity removes a drawing as it removes a study, and
// removeAllShapes opens a confirmation dialog when a drawing is locked. The line tools of the app,
// supportedLineTools, the line-tool registry and the gate of drawings, are in the default webpack
// cache. state.drawings holds the drawings, the removals and the experiment variation; the drawings
// option sets the variation, leaves it out, or gives a class of the registry another point count or
// other properties.
//
// The alerts (alerts.ts) come from the alerts of the fixture: the alerts REST client of the app
// (getAlertsRestApi), the converter of the alert dialog, the alert config and the alert modules the
// tools must never use, which only record their calls, are in the default webpack cache. The client
// refuses while no account is signed in and holds the account to the alert limits of the plan of
// the fixture (planLimits and planConfigs of SERVER_SIDE_ALERTS), which the plan modules serve as
// well. state.alerts holds the alerts, the errors a test stages for the methods of the client and
// whether deleteAlerts is ignored; the alerts option sets the product, which sets the expirations of
// the alert config, or leaves a module out. The main series gives the chart symbol the way an alert
// takes it (getAlertSymbolString).
//
// The watchlists (watchlists.ts) come from the watchlists of the fixture: the symbol list service with
// its store and the backend service with the lists of the watchlist server are registered with the
// service locator, and the selectors, the refresh thunk, the limits, the set of lists with open
// sections to save and the watchlist functions the tools must never use, which only record their
// calls, are in the default webpack cache. The WATCHLIST_SYMBOLS limit of the plan applies while the
// feature toggle watchlist_symbols_tiered_limits is on, as on the app. state.watchlists holds the
// lists of the server, the state of the store, the errors a test stages for the backend, the limit
// of the server and the open sections; the watchlists option leaves a service or a module out.
// TVD.getActiveWatchlistId resolves undefined, as it did on the app, and records itself.
//
// The layouts (layouts.ts) come from the savedLayouts and the layout of the fixture: the members of
// TradingViewApi that list, read and load layouts, layoutId and layoutName among them, follow the
// layout the chart shows, which loadLayoutFromServerByLayoutId changes in place, and
// activeChart().dataReady() resolves once its chart has its data (never while the symbol is
// unknown). The main series reports its interval. createNewChart and hasPermissionsToCreateNewChart,
// with openNewChart, are in the default webpack cache, backed by the layouts server of state.layouts,
// which holds the saved layouts to the CHART_STORAGE limit of the plan; state.layouts also holds the
// layout on the chart, its unsaved changes, whether its chart has its data, whether a load hangs and
// the errors a test stages. The layouts option sets how long a load and its data take, or leaves an
// export out.
//
// Bar replay (replay.ts): TradingViewApi.replayApi() resolves the replay API of the app, with its
// watched values, the selects that start replay, doStep, autoplay and leaveReplay, which saves the
// replay session in the layout, where the chart widget collection keeps it
// (_chartWidgetCollection.replaySessionState and updateReplaySessionState); the internal replay
// controller answers the availability of chart 0 by the id of its chart model (model().id()). An
// intraday chart replays only on a plan with BAR_REPLAY_INTRADAY, which the plan modules serve as
// well. state.replay holds replay, its settings and the saved session; the replay option sets how
// long a start and a step take, or leaves a member out.
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
  // How long after pineEditorApi().open() the Pine Editor is mounted, so that getSource answers.
  // Infinity: never. Default 20 ms (pine-editor.ts).
  pineEditorReadyMs?: number;
  // The message pineEditorApi().open() rejects with. Default: it opens the editor.
  pineEditorOpenError?: string;
  // Leaves the page layout service out of the service locator, so the side panel cannot be closed.
  withoutPageLayoutService?: boolean;
  // Makes a close of the Pine Editor change nothing, in the side panel or at the bottom
  // (pine-editor.ts).
  pineEditorCloseIgnored?: boolean;
  // Leaves TradingView.bottomWidgetBar out.
  withoutBottomWidgetBar?: boolean;
  // The viewport, its pixel ratio and the boxes of the chart containers (screen.ts).
  screen?: FakeScreenOptions;
  // Leaves the chart widget collection out of TradingViewApi, as a build without it. The containers
  // stay in the page.
  withoutChartCollection?: boolean;
  // TradingView's own fullscreen mode: whether it is on, and whether the page can read it and turn
  // it on and off (fullscreen.ts).
  fullscreen?: FakeFullscreenOptions;
  // The gate of drawings and the classes of the line-tool registry (drawings.ts).
  drawings?: FakeDrawingsOptions;
  // The product of the account and the alert modules left out (alerts.ts).
  alerts?: FakeAlertsOptions;
  // The watchlist services and modules left out (watchlists.ts).
  watchlists?: FakeWatchlistsOptions;
  // How long a load of a layout and its data take, and the layout exports left out (layouts.ts).
  layouts?: FakeLayoutsOptions;
  // How long a change of the layout and the data of a chart it adds take, and the codes of the
  // table of layouts, or the table, left out (charts.ts).
  charts?: FakeChartsOptions;
  // How long a start of replay, its point and a step take, and the replay members left out
  // (replay.ts).
  replay?: FakeReplayOptions;
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
  // The time of the time point at an index, in the time base of the bar rows: the bar times, then
  // the points after the last bar. Null for an index without a point.
  indexToTimePoint(index: number): number | null;
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
  // The interval of the series, which the Create new layout dialog of the app reads (layouts.ts).
  interval(): string;
  // The listing of the chart symbol, encoded the way an alert takes it (alerts.ts). Optional, so
  // that a test can delete it, as on a build without it.
  getAlertSymbolString?: () => string;
}

export interface FakeSetOptions {
  dataReady?: () => void;
  doNotActivateChart?: boolean;
}

// The chart model, _chartWidget.model(). canCreateStudy is optional so that a test can delete it, as
// on a build without it.
export interface FakeChartModel {
  // The id of the chart model, which keys the replay availability of the charts (replay.ts). Only
  // chart 0 has it.
  id?: () => string;
  mainSeries(): FakeMainSeries;
  // The core model: the time scale, the cores of the studies by id (null for any other id) and the
  // active strategy source, whose value is the core of the strategy the Strategy Tester shows, or
  // null.
  model(): {
    timeScale(): FakeTimeScale;
    getStudyById(id: string): FakeStudyCore | null;
    activeStrategySource(): { value(): FakeStudyCore | null };
  };
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
  // Throws "There is no such shape" for an id that is not a drawing on the chart.
  getShapeById(id: string): FakeLineDataSourceApi;
  createShape(point: unknown, options?: unknown): Promise<string>;
  createMultipointShape(points: unknown, options?: unknown): Promise<string>;
  removeAllShapes(): void;
  createStudy: FakeStudies['createStudy'];
  // Removes a drawing or a study. A property, so that a test can keep the original to call it.
  removeEntity: (id: string, options?: { disableUndo?: boolean }) => void;
  setSymbol(symbol: string, options?: FakeSetOptions): Promise<true>;
  setResolution(resolution: string, options?: FakeSetOptions): Promise<true>;
  setChartType(chartType: number): Promise<void>;
  setVisibleRange(range: { from: number; to: number }): never;
  // Resolves with true once the chart has its data, at once when it has it; never while the symbol
  // is unknown (layouts.ts).
  dataReady(): Promise<true>;
  // The panes of the chart, top to bottom (charts.ts).
  getPanes(): FakePaneApi[];
  // The time the chart reports for the time point at an index, or null for an index without one.
  _convertIndexToPublicTime(index: number): number | null;
  readonly _chartWidget: { model(): FakeChartModel };
}

// The members that concern layouts (layoutName, layoutId, getSavedCharts, hasChartChanges,
// shouldBeSaved and the loaders) come from layouts.ts, and those that concern the charts of the
// layout (chart, activeChart, chartsCount, activeChartIndex, setActiveChart, layout and setLayout)
// from charts.ts.
export interface FakeTradingViewApi extends FakeLayoutsApi, FakeChartsApi {
  isConnected(): boolean;
  getIntervals(): string[];
  searchSymbols(options: FakeSearchOptions): Promise<FakeSearchResponse>;
  pineEditorApi(): FakePineEditorApi;
  // TradingView's own fullscreen mode (fullscreen.ts).
  startFullscreen?(): void;
  exitFullscreen?(): void;
  // The replay API (replay.ts).
  replayApi?(): Promise<FakeReplayApi>;
  // One definition for each chart container (screen.ts), the fullscreen mode as a watched value
  // (fullscreen.ts) and the replay session saved in the layout (replay.ts).
  _chartWidgetCollection?: {
    _chartWidgetsDefs: FakeChartWidgetDef[];
    fullscreen?(): { value(): boolean };
  } & FakeReplayCollection;
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
  // Whether an account is signed in (state.pineEditor.signedIn).
  readonly is_authenticated: boolean;
  // The global of the app that holds its widgets; left out with TradingViewApi.
  TradingView?: { bottomWidgetBar?: FakeBottomWidgetBar };
  TVD: { reloadTab(): void; getActiveWatchlistId(): Promise<undefined> };
  BUILD_TIME: string;
  webpackChunktradingview: unknown[];
  // The size of the viewport in CSS pixels, the size of the window in DIPs (which is the viewport
  // times the page zoom), the device pixels for each CSS pixel, and how far the page is scrolled.
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly outerWidth: number;
  readonly outerHeight: number;
  readonly devicePixelRatio: number;
  readonly scrollX: number;
  readonly scrollY: number;
  document: {
    readonly visibilityState: VisibilityState;
    // The chart containers that match, in document order.
    querySelectorAll(selectors: string): FakeElement[];
  };
  location: FakeLocation;
}

// One mutating call, by the dotted name of the member: TradingViewApi.setActiveChart,
// TradingViewApi.setLayout (with its arguments as given), chart.setSymbol, chart.setResolution
// (chart(i).setSymbol and chart(i).setResolution on another chart i of the layout, and the
// paywall a change of the layout opens, dialog.paywall, charts.ts), chart.setChartType,
// chart.setVisibleRange,
// timeScale.zoomToBarsRange, timeScale.scrollToBar, series.requestMoreData, TVD.reloadTab, and
// TradingViewApi.startFullscreen and TradingViewApi.exitFullscreen.
// Calls that send a request are recorded too: TradingViewApi.searchSymbols, the members of the
// quote modules that would create a quote session or send a request (quotes.ts), and
// requestBuiltinScripts and studyMetaInfoRepository.requestMetaInfo (studies.ts). So are the changes
// to studies, chart.createStudy, chart.removeEntity, study.setInputValues and study.setVisible
// (each with the study id first), and the dialogs the app would open on the way, as dialog.paywall,
// dialog.tooManyStudies and dialog.studyInputs (studies.ts). So are the changes to drawings,
// chart.createShape, chart.createMultipointShape, chart.removeEntity, chart.removeAllShapes and
// the setters shape.setProperties and shape.setPoints (with the drawing id first), the loading of
// a line tool, lineTools.ensureLineToolLoaded, the gate drawingGate.ensureDrawingCreationAllowed,
// and the dialogs on the way, dialog.signIn, dialog.paywall and
// dialog.confirmRemovingLockedLineTools (drawings.ts). So are the calls of the Pine Editor
// that change it, send a request or open or close a panel: pineEditorApi.*, pineFacade.*,
// pageLayout.*, bottomWidgetBar.close, requestUserScripts and the dialogs dialog.paywall,
// dialog.signIn, dialog.renameScript and dialog.confirmSaveChanges the app would open, and
// translateScriptAsync, which sends a compile request (pine-editor.ts). So are the calls of the
// alerts REST client, alertsRestApi.* (each sends a request), the converter of the alert dialog,
// alerts.convertEditableAlertState, which changes nothing but tells that the payload came from it,
// and every call of the alert modules the tools must never use: alertsActions.*,
// alertsCollection.*, alertsPresenter.*, chartAlertsFacade.* and alertsAdminRestApi.* (alerts.ts).
// So are the calls of the watchlist backend, symbolListBackend.* (each sends a request), the plain
// actions dispatched to the store of the symbol list service, symbolListStore.dispatch (with the
// type of the action), the refresh thunk getCustomWatchlistsThunk (with its signal), the warning
// dialog dialog.watchlistMaxLimit, every call of the watchlist
// functions the tools must never use, watchlistThunks.*, watchlistWidget.*,
// symbolListService.actions.* and initSymbolListService (watchlists.ts), TVD.getActiveWatchlistId,
// and registerService and unregisterService of the service locator (service-locator.ts). So are the
// calls about layouts that send a request, load a layout or open a dialog:
// TradingViewApi.getSavedCharts, TradingViewApi.loadLayoutFromServerByLayoutId (with its arguments
// as given), createNewChart, hasPermissionsToCreateNewChart and the request it sends,
// getChartsCount, the new tab backend.openLayoutLink, the dialogs dialog.paywall (with the paywall),
// dialog.warning and dialog.unsavedChanges, and every call of the layout functions the tools must
// never use, TradingViewApi.loadChartFromServer, TradingViewApi.createNewLayout and openNewChart
// (layouts.ts). So are the calls of the replay API that change replay, replayApi.* (the selects,
// doStep, toggleAutoplay, changeAutoplayDelay, leaveReplay and stopReplay, each with its arguments
// as given), the settings they keep, settings.setValue (with the name of the setting and its value),
// chartWidgetCollection.updateReplaySessionState, the dialogs dialog.signIn, dialog.continueReplay,
// dialog.paywall and dialog.leaveReplay, the notification notification.replayTimePointCorrected,
// and every call the tools must never make: replayApi.buy, replayApi.sell, replayApi.closePosition,
// replayApi.goToRealtime and tradingService (replay.ts).
// A call is recorded before it is validated, so refused and throwing calls show up too. Reads are
// not recorded.
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
  // The Pine Editor (pine-editor.ts).
  pineEditor: FakePineEditorState;
  // The containers of the charts, in layout order (screen.ts).
  chartContainers: FakeElement[];
  // TradingView's own fullscreen mode (fullscreen.ts).
  fullscreen: FakeFullscreenState;
  // The drawings on the chart, their removals and the drawings experiment (drawings.ts).
  drawings: FakeDrawingsState;
  // The alerts of the account, the errors staged for the alerts client and whether it ignores a
  // deletion (alerts.ts).
  alerts: FakeAlertsState;
  // The watchlists of the server and of the store, the errors staged for the backend, the limit of
  // the server and the lists with open sections to save (watchlists.ts).
  watchlists: FakeWatchlistsState;
  // The saved layouts of the server, the layout on the chart, its unsaved changes, whether its chart
  // has its data, whether a load hangs and the errors staged for the requests (layouts.ts).
  layouts: FakeLayoutsState;
  // The type of the layout, how many charts it shows, the charts after chart 0 and whether the
  // layout syncs their symbol (charts.ts).
  charts: FakeChartsState;
  // Bar replay, its settings and the replay session saved in the layout (replay.ts).
  replay: FakeReplayState;
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

// The id of the chart model of chart 0, synthetic.
export const CHART_MODEL_ID = 'chartmodel0';

export function createFakeTvWindow(
  fixture: TvStateFixture,
  overrides: FakeTvOverrides = {},
): FakeTvWindow {
  const feeds = new Map(Object.entries(overrides.feeds ?? {}));
  // The listing a symbol the chart shows stands for: the symbol whose feed it is, or itself.
  const listingOf = (shown: string): string =>
    [...feeds].find(([, feed]) => feed === shown)?.[0] ?? shown;
  // The currency an alert symbol names: that of the fixture symbol.
  const currency =
    typeof fixture.symbolInfo.currency_code === 'string' ? fixture.symbolInfo.currency_code : 'USD';
  const offset = overrides.sessionOffsetSeconds ?? 0;
  const knownSymbols = new Set([
    ...fixture.knownSymbols,
    ...(overrides.feeds ? Object.values(overrides.feeds) : []),
  ]);
  const calls: FakeCall[] = [];
  const record = (name: string, args: readonly unknown[]): void => {
    calls.push({ name, args });
  };
  const locator = createFakeServiceLocator(record);
  const pine = createFakePineEditor(fixture.pineEditor, {
    readyMs: overrides.pineEditorReadyMs ?? 20,
    openError: overrides.pineEditorOpenError,
    withoutPageLayoutService: overrides.withoutPageLayoutService,
    provideService: locator.provide,
    closeIgnored: overrides.pineEditorCloseIgnored,
    savedScriptsLimit: fixture.planLimits.SAVED_PINE_SCRIPTS,
    isFeatureEnabled: (name) => fixture.featureToggles[name] === true,
    record,
    // The studies are built further down; the editor reaches them only when it adds a script.
    canAddStudy: () => chartModel.canCreateStudy?.({ id: '' }).success !== false,
    addStudy: (script) => studies.addUserScript(script),
  });
  const screen = createFakeScreen(fixture.layout.chartsCount, overrides.screen);
  const fullscreen = createFakeFullscreen(overrides.fullscreen, record);
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
    pineEditor: pine.state,
    chartContainers: screen.containers,
    fullscreen: fullscreen.state,
    // Filled with the drawings of the fixture once the bars are there (drawings.ts).
    drawings: { list: [], removed: [], experiment: null },
    // Filled with the alerts of the fixture (alerts.ts).
    alerts: { list: [], errors: {}, deleteIgnored: false },
    // Filled with the watchlists of the fixture (watchlists.ts).
    watchlists: {
      server: [],
      store: {
        customLists: { lists: { ids: [], byId: {} }, timestamp: null },
        markedLists: {
          lists: { colors: [], byColor: {}, bySymbol: {} },
          commands: [],
          timestamp: null,
        },
        hotLists: { lists: {} },
        activeSymbolList: null,
        widgets: {},
        positions: {},
        isAuthenticated: false,
        collapsedSeparators: {},
      },
      errors: {},
      serverLimit: null,
      pendingOpenSeparators: new Set(),
    },
    // Filled with the saved layouts and the layout of the fixture (layouts.ts).
    layouts: {
      saved: [],
      current: { id: null, uid: null, name: null },
      unsaved: false,
      dataReady: true,
      loadHangs: false,
      errors: {},
    },
    // Filled with the layout and the charts of the fixture (charts.ts).
    charts: { layout: 's', count: 1, others: [], symbolSync: false },
    replay: initialReplayState(),
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
  // does. This is chart 0; the other charts of the layout are in charts.ts.
  const activate = (options: FakeSetOptions | undefined): void => {
    if (options?.doNotActivateChart !== true) {
      state.activeChartIndex = 0;
    }
  };

  // The requested symbol sticks even when it is unknown; only the series flag and the missing
  // dataReady tell the page it did not resolve. Once resolved, the chart shows the symbol by its
  // data feed, before dataReady runs. setSymbol does this, and so does symbol sync, without a call.
  const takeSymbol = (symbol: string): void => {
    state.symbol = symbol;
    state.symbolInvalid = !knownSymbols.has(symbol);
    const feed = state.symbolInvalid ? undefined : feeds.get(symbol);
    if (feed !== undefined) {
      queueMicrotask(() => {
        if (state.symbol === symbol) {
          state.symbol = feed;
        }
      });
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
  // Their times in the time base of the rows.
  const rowPointTimes = (): readonly number[] => (loaded().length === 0 ? [] : pointTimes());

  // What timePointToIndex answers on the app, for a time in the time base of the rows: the index of
  // the first time point at or after the time, the last point for a time after every point, and
  // null when there are no points or the time is not a number.
  const firstPointAtOrAfter = (time: number): number | null => {
    const internal = rowPointTimes();
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
    indexToTimePoint: (index) =>
      Number.isInteger(index) ? (rowPointTimes()[index] ?? null) : null,
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
    interval: () => state.resolution,
    getAlertSymbolString: () => encodeAlertSymbol(listingOf(state.symbol), currency),
  };

  // Stable like the model of the real widget: the same objects come back on every call.
  const coreModel = {
    timeScale: () => timeScale,
    // The studies are built below; the model reaches them when it is asked.
    getStudyById: (id: string) => studies.getStudyCore(id),
    activeStrategySource: () => ({ value: () => studies.getActiveStrategyCore() }),
  };
  const chartModel: FakeChartModel = {
    id: () => CHART_MODEL_ID,
    mainSeries: () => mainSeries,
    model: () => coreModel,
  };
  const studies = createFakeStudies(fixture, loaded, {
    record,
    canCreateStudy: (spec) => chartModel.canCreateStudy?.(spec),
    removed: state.removedStudies,
  });
  chartModel.canCreateStudy = (spec) => studies.canCreateStudy(spec);
  const drawings = createFakeDrawings(fixture.shapes, {
    state: state.drawings,
    record,
    signedIn: () => pine.state.signedIn,
    bars: loaded,
    offsetSeconds: offset,
    stepSeconds: fixture.bars.stepSeconds,
    options: overrides.drawings,
  });
  // The server holds the account to the alert limits of the plan: the active price alerts to
  // primitive_limit (or limit without it), and every alert to overall_limit.
  const alertConfig = fixture.planConfigs?.SERVER_SIDE_ALERTS ?? {};
  const alerts = createFakeAlerts(fixture.alerts ?? [], {
    state: state.alerts,
    record,
    signedIn: () => pine.state.signedIn,
    defaultSymbol: encodeAlertSymbol(fixture.symbol, currency),
    limits: {
      primitive: alertConfig.primitive_limit ?? fixture.planLimits.SERVER_SIDE_ALERTS ?? null,
      overall: alertConfig.overall_limit ?? null,
    },
    options: overrides.alerts,
  });
  const watchlists = createFakeWatchlists(fixture.watchlists, {
    state: state.watchlists,
    record,
    signedIn: () => pine.state.signedIn,
    isFeatureEnabled: (name) => fixture.featureToggles[name] === true,
    planLimit: fixture.planLimits.WATCHLIST_SYMBOLS,
    provideService: locator.provide,
    options: overrides.watchlists,
  });
  const layouts = createFakeLayouts(fixture.savedLayouts, {
    state: state.layouts,
    record,
    signedIn: () => pine.state.signedIn,
    planLimit: fixture.planLimits.CHART_STORAGE,
    layout: fixture.layout,
    symbol: fixture.symbol,
    interval: fixture.resolution,
    options: overrides.layouts,
  });
  const charts = createFakeCharts({
    state: state.charts,
    record,
    // Chart 0 is built below; the charts reach it when they are asked.
    main: {
      chart: () => chart,
      studies: () => studies.getAllStudies(),
      shapes: () => drawings.getAllShapes(),
      syncSymbol: takeSymbol,
    },
    active: {
      get: () => state.activeChartIndex,
      set: (index) => {
        state.activeChartIndex = index;
      },
    },
    isKnown: (symbol) => knownSymbols.has(symbol),
    feedOf: (symbol) => feeds.get(symbol),
    listingOf,
    bars: () => history.bars(),
    symbolInfo: () => fixture.symbolInfo,
    planLimit: fixture.planLimits.MULTIPLE_CHARTS,
    planConfig: fixture.planConfigs?.MULTIPLE_CHARTS,
    layout: fixture.layout,
    fixture: fixture.charts,
    options: overrides.charts,
  });
  const replay = createFakeReplay({
    state: state.replay,
    record,
    signedIn: () => pine.state.signedIn,
    bars: loaded,
    chart: () => ({ symbol: state.symbol, interval: state.resolution }),
    // A plan has the feature when it configures it, as enabled() of the plan modules answers.
    planIntraday:
      fixture.planLimits.BAR_REPLAY_INTRADAY !== undefined ||
      fixture.planConfigs?.BAR_REPLAY_INTRADAY !== undefined,
    modelId: CHART_MODEL_ID,
    markLayoutChanged: () => {
      state.layouts.unsaved = true;
    },
    options: overrides.replay,
  });

  const chart: FakeChartWidgetApi = {
    symbol: () => state.symbol,
    resolution: () => state.resolution,
    chartType: () => state.chartType,
    getVisibleRange: () => (state.symbolInvalid ? { from: 0, to: 0 } : { ...state.visibleRange }),
    getAllStudies: () => studies.getAllStudies(),
    getStudyById: (id) => studies.getStudyById(id),
    getAllShapes: () => drawings.getAllShapes(),
    getShapeById: (id) => drawings.getShapeById(id),
    createShape: (point, options) => drawings.createShape(point, options),
    createMultipointShape: (points, options) => drawings.createMultipointShape(points, options),
    removeAllShapes: () => {
      drawings.removeAllShapes();
    },
    createStudy: (...args) => studies.createStudy(...args),
    // One member for every source on the chart, as on the app.
    removeEntity: (id, options) => {
      if (drawings.has(id)) {
        drawings.removeEntity(id, options);
      } else {
        studies.removeEntity(id, options);
      }
    },
    setSymbol(symbol, options) {
      record('chart.setSymbol', options === undefined ? [symbol] : [symbol, options]);
      activate(options);
      takeSymbol(symbol);
      charts.syncFromMain(symbol);
      if (!state.symbolInvalid) {
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
    // The series of an unknown symbol never gets data, so the promise never settles then.
    dataReady: () =>
      state.symbolInvalid ? new Promise<true>(() => undefined) : layouts.whenDataReady(),
    getPanes: () => charts.mainPanes(),
    _convertIndexToPublicTime: (index) =>
      Number.isInteger(index) ? (points()[index] ?? null) : null,
    _chartWidget: { model: () => chartModel },
  };

  const api: FakeTradingViewApi = {
    ...charts.api,
    ...layouts.api,
    isConnected: () => state.connected,
    getIntervals: () => [...fixture.intervals],
    searchSymbols: createFakeSearch(fixture.search, record),
    pineEditorApi: () => pine.api,
    ...fullscreen.api,
    ...(replay.replayApi === undefined ? {} : { replayApi: replay.replayApi }),
    ...(overrides.withoutChartCollection === true
      ? {}
      : {
          _chartWidgetCollection: {
            ...screen.collection,
            ...fullscreen.collection,
            ...replay.collection,
          },
        }),
  };

  const win: FakeTvWindow = {
    get is_authenticated() {
      return pine.state.signedIn;
    },
    TVD: {
      reloadTab() {
        record('TVD.reloadTab', []);
      },
      getActiveWatchlistId() {
        record('TVD.getActiveWatchlistId', []);
        return Promise.resolve(undefined);
      },
    },
    BUILD_TIME: fixture.buildTime,
    webpackChunktradingview:
      overrides.withoutWebpackRuntime === true
        ? []
        : createFakeWebpack(
            overrides.webpackModules ?? {
              ...createPlanLimitModules(fixture.planLimits, fixture.planConfigs),
              ...createFeatureToggleModules(fixture.featureToggles),
              ...createQuoteModules(fixture.quoteCache, record),
              ...createStudyCatalogModules(fixture.studyCatalog, {
                repositoryReady: overrides.studyRepositoryReady ?? true,
                builtinScriptsError: overrides.builtinScriptsError,
                record,
              }),
              ...locator.modules,
              ...pine.modules,
              ...drawings.modules,
              ...alerts.modules,
              ...watchlists.modules,
              ...layouts.modules,
              ...charts.modules,
              ...replay.modules,
            },
          ),
    innerWidth: screen.width,
    innerHeight: screen.height,
    outerWidth: screen.outerWidth,
    outerHeight: screen.outerHeight,
    devicePixelRatio: screen.devicePixelRatio,
    scrollX: screen.scrollX,
    scrollY: screen.scrollY,
    document: {
      get visibilityState() {
        return state.visibilityState;
      },
      querySelectorAll: (selectors) => screen.querySelectorAll(selectors),
    },
    location: createLocation(
      `https://www.tradingview.com/chart/${encodeURIComponent(fixture.layout.id)}/`,
    ),
  };
  if (overrides.withoutApi !== true) {
    win.TradingViewApi = api;
    win.TradingView =
      overrides.withoutBottomWidgetBar === true ? {} : { bottomWidgetBar: pine.bottomWidgetBar };
  }

  inspectors.set(win, {
    calls,
    state,
    callsTo: (name) => calls.filter((call) => call.name === name).map((call) => call.args),
  });
  return win;
}
