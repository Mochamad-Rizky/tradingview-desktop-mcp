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
import { probeCapabilities } from './capabilities.js';
import { describeElement, describeFocusedElement } from './input.js';
import { readAppState, readVisibilityState } from './probes.js';

// Every function the page bridge sends into the page, so that the serializability test checks
// each one. A page function missing from here goes unchecked, so a module that defines page
// functions adds them here.
export const pageFunctions: Record<string, (...args: never[]) => unknown> = {
  describeElement,
  describeFocusedElement,
  probeCapabilities,
  readAppInfo,
  readAppState,
  readChartLayout,
  readChartSnapshot,
  readChartState,
  readUiState,
  readVisibilityState,
  readVisibleRange,
  reloadTab,
  scrollToTime,
  setChartTypeViaApi,
  setResolutionViaApi,
  setSymbolViaApi,
  zoomToTimeRange,
};
