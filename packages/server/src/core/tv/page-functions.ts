import {
  createAlertViaApi,
  deleteAlertsViaApi,
  readAlertContext,
  readAlerts,
} from '../../tools/alert/page.js';
import { readAppInfo, readUiState, reloadTab } from '../../tools/app/page.js';
import {
  readChartLayout,
  readChartSnapshot,
  readChartState,
  readVisibleRange,
  scrollToTime,
  setChartTypeViaApi,
  setResolutionViaApi,
  setSymbolViaApi,
  zoomToTimeRange,
} from '../../tools/chart/page.js';
import {
  readBarRows,
  readCachedQuote,
  readChartQuote,
  readChartSymbolInfo,
  readHistory,
  requestHistory,
  searchSymbolsViaApi,
} from '../../tools/data/page.js';
import {
  createDrawing,
  readDrawing,
  readDrawingIds,
  readDrawings,
  removeDrawing,
  removeDrawings,
} from '../../tools/drawing/page.js';
import {
  editStudyInputs,
  insertStudy,
  readStudies,
  readStudyCatalog,
  readStudyInsertContext,
  readStudyValues,
  removeStudy,
  setStudyVisibility,
} from '../../tools/indicator/page.js';
import {
  awaitChartData,
  checkLayoutPermission,
  createLayoutViaApi,
  loadLayoutInPlace,
  readLayoutState,
  readSavedLayouts,
} from '../../tools/layout/page.js';
import {
  awaitChartsData,
  focusChart,
  readChartSymbols,
  readLayoutCount,
  readPanes,
  setLayoutViaApi,
} from '../../tools/pane/page.js';
import { readPineGraphics } from '../../tools/pine/outputs-page.js';
import {
  addPineScriptToChart,
  changePineEditor,
  closePineEditor,
  compilePineSource,
  openPineEditor,
  readAddedPineStudy,
  readPineConsole,
  readPineConsoleDiagnostics,
  readPineEditorState,
  readPineOwnEdit,
  readPineSource,
  readSavedPineScripts,
  savePineScript,
} from '../../tools/pine/page.js';
import {
  leaveReplayViaApi,
  readReplayState,
  setAutoplayViaApi,
  startReplayViaApi,
  stepReplayViaApi,
} from '../../tools/replay/page.js';
import { readChartBox } from '../../tools/screenshot/page.js';
import { readStrategyReport } from '../../tools/strategy/page.js';
import { readTabs, readUnsavedLayout } from '../../tools/tab/page.js';
import {
  evaluateExpression,
  readFullscreen,
  readPanelControls,
  readPineEditorShown,
  setFullscreen,
} from '../../tools/ui/page.js';
import {
  changeWatchlistViaApi,
  readWatchlist,
  readWatchlistLimits,
  readWatchlists,
} from '../../tools/watchlist/page.js';
import { probeCapabilities } from './capabilities.js';
import { describeElement, describeFocusedElement, findElements } from './input.js';
import { createPageLib, type PageLib } from './page-lib.js';
import { readPlanConfig, readPlanFeaturesEnabled, readPlanLimits } from './plan-limits.js';
import { readAppState, readVisibilityState } from './probes.js';
import type { TvWindow } from './tv-window.js';

// Every function the page bridge sends into the page, so that the serializability test checks
// each one. A page function missing from both registries goes unchecked, so a module that defines
// page functions adds each to the registry of the way the bridge calls it, which is the way the
// test calls it too.

// Called with the window and their arguments: the PageFunctions that evaluate runs, and
// createPageLib, which the bridge calls with the window alone to build the page library.
export const pageFunctions: Record<string, (...args: never[]) => unknown> = {
  awaitChartData,
  awaitChartsData,
  createPageLib,
  describeElement,
  describeFocusedElement,
  editStudyInputs,
  evaluateExpression,
  findElements,
  focusChart,
  insertStudy,
  leaveReplayViaApi,
  loadLayoutInPlace,
  probeCapabilities,
  readAppInfo,
  readAddedPineStudy,
  readAppState,
  readBarRows,
  readChartBox,
  readChartLayout,
  readChartQuote,
  readChartSnapshot,
  readChartState,
  readChartSymbolInfo,
  readChartSymbols,
  readDrawing,
  readDrawingIds,
  readDrawings,
  readFullscreen,
  readHistory,
  readLayoutState,
  readPanelControls,
  readPanes,
  readPineGraphics,
  readReplayState,
  readSavedLayouts,
  readStrategyReport,
  readStudies,
  readStudyValues,
  readTabs,
  readUiState,
  readUnsavedLayout,
  readVisibilityState,
  readVisibleRange,
  reloadTab,
  removeDrawing,
  removeDrawings,
  removeStudy,
  requestHistory,
  scrollToTime,
  searchSymbolsViaApi,
  setAutoplayViaApi,
  setChartTypeViaApi,
  setFullscreen,
  setLayoutViaApi,
  setResolutionViaApi,
  setStudyVisibility,
  setSymbolViaApi,
  startReplayViaApi,
  stepReplayViaApi,
  zoomToTimeRange,
};

// Called with the window, the page library and their arguments: the PageLibFunctions that
// evaluateWithLib runs.
export const pageLibFunctions: Record<
  string,
  (win: TvWindow, lib: PageLib, ...args: never[]) => unknown
> = {
  addPineScriptToChart,
  changePineEditor,
  changeWatchlistViaApi,
  checkLayoutPermission,
  closePineEditor,
  compilePineSource,
  createAlertViaApi,
  createDrawing,
  createLayoutViaApi,
  deleteAlertsViaApi,
  openPineEditor,
  readAlertContext,
  readAlerts,
  readCachedQuote,
  readLayoutCount,
  readPineConsole,
  readPineConsoleDiagnostics,
  readPineEditorState,
  readPineOwnEdit,
  readPineEditorShown,
  readPineSource,
  readPlanConfig,
  readPlanFeaturesEnabled,
  readPlanLimits,
  readSavedPineScripts,
  readStudyCatalog,
  readStudyInsertContext,
  readWatchlist,
  readWatchlistLimits,
  readWatchlists,
  savePineScript,
};
