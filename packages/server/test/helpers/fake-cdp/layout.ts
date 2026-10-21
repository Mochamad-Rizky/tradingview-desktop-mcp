// What Page.getLayoutMetrics answers, in the shape TradingView Desktop 3.4.1 was seen to answer
// with: six members, the layout viewport and the visual viewport and the size of the content, each
// in device pixels and in CSS pixels. The ones in device pixels are the deprecated members of the
// protocol, and the app still has them: they are the CSS ones times the pixel ratio of the page.

export interface LayoutSize {
  // The viewport in CSS pixels.
  width: number;
  height: number;
  // Device pixels for each CSS pixel, as the page reports it (window.devicePixelRatio): the ratio
  // of the display times the page zoom. 2 on a Retina display at the default zoom.
  devicePixelRatio: number;
  // The page zoom of the app: how many device-independent pixels (DIPs) a CSS pixel takes, 1 at
  // 100%. The window spans the viewport times this many DIPs. Default 1.
  zoom?: number;
  // Where the visible part of the page starts in the document, in CSS pixels: how far the page is
  // scrolled. Default 0.
  pageX?: number;
  pageY?: number;
}

// What a page that says nothing about its size has: a window of a plain laptop display.
const BLANK_SIZE: Required<LayoutSize> = {
  width: 1280,
  height: 720,
  devicePixelRatio: 1,
  zoom: 1,
  pageX: 0,
  pageY: 0,
};

// A number a window can report as a size or a ratio: anything else counts as not reported.
function reported(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

// A scroll position can be 0, which a size cannot.
function scrolled(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

// The size of the viewport a window reports with innerWidth, innerHeight and devicePixelRatio. Its
// zoom is how much wider the window is in DIPs, which outerWidth counts, than the viewport in CSS
// pixels, and the position of the page is scrollX and scrollY.
export function layoutSizeOf(window: object): Required<LayoutSize> {
  const width = reported(Reflect.get(window, 'innerWidth'), BLANK_SIZE.width);
  const outerWidth = reported(Reflect.get(window, 'outerWidth'), width);
  return {
    width,
    height: reported(Reflect.get(window, 'innerHeight'), BLANK_SIZE.height),
    devicePixelRatio: reported(
      Reflect.get(window, 'devicePixelRatio'),
      BLANK_SIZE.devicePixelRatio,
    ),
    // Rounded, since a width that was multiplied by a zoom and divided by it again is not exactly
    // what it was.
    zoom: Math.round((outerWidth / width) * 1e6) / 1e6,
    pageX: scrolled(Reflect.get(window, 'scrollX')),
    pageY: scrolled(Reflect.get(window, 'scrollY')),
  };
}

// The layout viewport has whole numbers, as the protocol types it, and the visual viewport has
// not.
function layoutViewport(width: number, height: number, pageX: number, pageY: number) {
  return {
    pageX: Math.floor(pageX),
    pageY: Math.floor(pageY),
    clientWidth: Math.floor(width),
    clientHeight: Math.floor(height),
  };
}

// The scale is that of a page that is not pinched, and the zoom that of the page zoom of the app
// (seen at its default on the app, where it was 1 with a display ratio of 2: it does not hold the
// ratio of the display).
function visualViewport(width: number, height: number, pageX: number, pageY: number, zoom: number) {
  return {
    offsetX: 0,
    offsetY: 0,
    pageX,
    pageY,
    clientWidth: width,
    clientHeight: height,
    scale: 1,
    zoom,
  };
}

function contentSize(width: number, height: number) {
  return { x: 0, y: 0, width, height };
}

export function layoutMetrics({
  width,
  height,
  devicePixelRatio,
  zoom = 1,
  pageX = 0,
  pageY = 0,
}: LayoutSize) {
  const deviceWidth = width * devicePixelRatio;
  const deviceHeight = height * devicePixelRatio;
  const devicePageX = pageX * devicePixelRatio;
  const devicePageY = pageY * devicePixelRatio;
  return {
    layoutViewport: layoutViewport(deviceWidth, deviceHeight, devicePageX, devicePageY),
    visualViewport: visualViewport(deviceWidth, deviceHeight, devicePageX, devicePageY, zoom),
    contentSize: contentSize(deviceWidth, deviceHeight),
    cssLayoutViewport: layoutViewport(width, height, pageX, pageY),
    cssVisualViewport: visualViewport(width, height, pageX, pageY, zoom),
    cssContentSize: contentSize(width, height),
  };
}
