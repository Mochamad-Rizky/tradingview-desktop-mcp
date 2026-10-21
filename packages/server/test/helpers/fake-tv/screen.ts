import { SELECTORS } from '../../../src/core/tv/selectors.js';
import { fakeElement, type FakeElement, type FakeRect } from './dom.js';

// The screen of a fake chart tab: how big its viewport is, how many device pixels a CSS pixel
// takes, and the containers that hold the charts of the layout. A chart sits in a
// div.chart-container[data-qa-id="chart-container"], which the chart widget collection of the app
// hands out for each chart (seen on the app), and which the document lists in layout order too.
// Everything is in CSS pixels from the top left of the viewport. The shared fake window has no
// other DOM than this.

export interface FakeScreenOptions {
  // The viewport. Default 1280 by 720.
  width?: number;
  height?: number;
  // Device pixels for each CSS pixel: 1 on a plain display, 2 on a Retina display at the default
  // page zoom. Default 1.
  devicePixelRatio?: number;
  // The box of the container of each chart, in layout order. Default: the charts side by side in
  // the viewport, with room left around them for the toolbars. An empty list leaves the page
  // without any container, like a tab that shows no chart.
  charts?: readonly FakeRect[];
}

// What the chart widget collection holds for a chart: its container as a watched value.
export interface FakeChartWidgetDef {
  container: { value(): FakeElement };
}

export interface FakeScreen {
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
  // The chart containers, live: place() moves one the way the page does when its layout changes.
  readonly containers: FakeElement[];
  // The chart widget collection of the app, as far as the server reads it.
  readonly collection: { _chartWidgetsDefs: FakeChartWidgetDef[] };
  // document.querySelectorAll: the containers that match, in document order.
  querySelectorAll(selectors: string): FakeElement[];
}

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
// The room the toolbars and the panels take on the sides, at the top and at the bottom.
const MARGIN_X = 50;
const MARGIN_TOP = 40;
const MARGIN_BOTTOM = 40;

export function createFakeScreen(chartsCount: number, options: FakeScreenOptions = {}): FakeScreen {
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const area: FakeRect = {
    x: MARGIN_X,
    y: MARGIN_TOP,
    width: width - 2 * MARGIN_X,
    height: height - MARGIN_TOP - MARGIN_BOTTOM,
  };
  const boxes =
    options.charts ??
    Array.from({ length: chartsCount }, (_, index): FakeRect => ({
      x: area.x + (index * area.width) / chartsCount,
      y: area.y,
      width: area.width / chartsCount,
      height: area.height,
    }));
  const containers = boxes.map((rect) =>
    fakeElement({
      matches: [SELECTORS.regions.chartContainer],
      attributes: { 'data-qa-id': 'chart-container' },
      rect,
    }),
  );
  return {
    width,
    height,
    devicePixelRatio: options.devicePixelRatio ?? 1,
    containers,
    collection: {
      _chartWidgetsDefs: containers.map((container) => ({ container: { value: () => container } })),
    },
    querySelectorAll: (selectors) => containers.filter((container) => container.matches(selectors)),
  };
}
