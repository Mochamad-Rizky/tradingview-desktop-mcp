import { SELECTORS } from '../../../src/core/tv/selectors.js';
import { fakeElement, type FakeElement, type FakeRect } from './dom.js';

// The screen of a fake chart tab: how big its viewport is, how many device pixels a CSS pixel
// takes, how far the page is zoomed and scrolled, and the containers that hold the charts of the
// layout. A chart sits in a div.chart-container[data-qa-id="chart-container"], which the chart
// widget collection of the app hands out for each chart (seen on the app for the one chart of a
// layout), and which the document lists as well. The charts are taken to come in layout order in
// both, which was not seen with more than one chart. Everything is in CSS pixels from the top left
// of the viewport. The shared fake window has no other DOM than this.

export interface FakeScreenOptions {
  // The viewport. Default 1280 by 720.
  width?: number;
  height?: number;
  // Device pixels for each CSS pixel, as the page reports it (window.devicePixelRatio): the ratio of
  // the display, 1 on a plain one and 2 on a Retina display, times the zoom. Default 1.
  devicePixelRatio?: number;
  // The page zoom of the app, 1 at 100%. The window spans the viewport times this many DIPs
  // (device-independent pixels), which the outer width of the window counts. Default 1.
  zoom?: number;
  // How far the page is scrolled, in CSS pixels. Default 0.
  scrollX?: number;
  scrollY?: number;
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
  readonly outerWidth: number;
  readonly outerHeight: number;
  readonly devicePixelRatio: number;
  readonly scrollX: number;
  readonly scrollY: number;
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
  const zoom = options.zoom ?? 1;
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
    outerWidth: width * zoom,
    outerHeight: height * zoom,
    devicePixelRatio: options.devicePixelRatio ?? 1,
    scrollX: options.scrollX ?? 0,
    scrollY: options.scrollY ?? 0,
    containers,
    collection: {
      _chartWidgetsDefs: containers.map((container) => ({ container: { value: () => container } })),
    },
    querySelectorAll: (selectors) => containers.filter((container) => container.matches(selectors)),
  };
}
