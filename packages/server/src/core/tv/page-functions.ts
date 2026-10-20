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
  editStudyInputs,
  insertStudy,
  readStudies,
  readStudyCatalog,
  readStudyInsertContext,
  readStudyValues,
  removeStudy,
  setStudyVisibility,
} from '../../tools/indicator/page.js';
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
  readPineSource,
  readSavedPineScripts,
  savePineScript,
} from '../../tools/pine/page.js';
import { probeCapabilities } from './capabilities.js';
import { describeElement, describeFocusedElement } from './input.js';
import { createPageLib, type PageLib } from './page-lib.js';
import { readPlanLimits } from './plan-limits.js';
import { readAppState, readVisibilityState } from './probes.js';
import type { TvWindow } from './tv-window.js';

// Every function the page bridge sends into the page, so that the serializability test checks
// each one. A page function missing from both registries goes unchecked, so a module that defines
// page functions adds each to the registry of the way the bridge calls it, which is the way the
// test calls it too.

// Called with the window and their arguments: the PageFunctions that evaluate runs, and
// createPageLib, which the bridge calls with the window alone to build the page library.
export const pageFunctions: Record<string, (...args: never[]) => unknown> = {
  createPageLib,
  describeElement,
  describeFocusedElement,
  editStudyInputs,
  insertStudy,
  probeCapabilities,
  readAppInfo,
  readAddedPineStudy,
  readAppState,
  readBarRows,
  readChartLayout,
  readChartQuote,
  readChartSnapshot,
  readChartState,
  readChartSymbolInfo,
  readHistory,
  readPineGraphics,
  readStudies,
  readStudyValues,
  readUiState,
  readVisibilityState,
  readVisibleRange,
  reloadTab,
  removeStudy,
  requestHistory,
  scrollToTime,
  searchSymbolsViaApi,
  setChartTypeViaApi,
  setResolutionViaApi,
  setStudyVisibility,
  setSymbolViaApi,
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
  closePineEditor,
  compilePineSource,
  openPineEditor,
  readCachedQuote,
  readPineConsole,
  readPineConsoleDiagnostics,
  readPineEditorState,
  readPineSource,
  readPlanLimits,
  readSavedPineScripts,
  readStudyCatalog,
  readStudyInsertContext,
  savePineScript,
};
