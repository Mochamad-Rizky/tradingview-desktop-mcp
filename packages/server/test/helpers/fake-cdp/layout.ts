// What Page.getLayoutMetrics answers, in the shape TradingView Desktop 3.4.1 was seen to answer
// with: six members, the layout viewport and the visual viewport and the size of the content, each
// in device pixels and in CSS pixels. The ones in device pixels are the deprecated members of the
// protocol, and the app still has them: they are the CSS ones times the pixel ratio of the page.

export interface LayoutSize {
  // The viewport in CSS pixels.
  width: number;
  height: number;
  // Device pixels for each CSS pixel: 2 on a Retina display at the default page zoom.
  devicePixelRatio: number;
}

// What a page that says nothing about its size has: a window of a plain laptop display.
const BLANK_SIZE: LayoutSize = { width: 1280, height: 720, devicePixelRatio: 1 };

// A number a window can report as a size or a ratio: anything else counts as not reported.
function reported(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

// The size of the viewport a window reports with innerWidth, innerHeight and devicePixelRatio.
export function layoutSizeOf(window: object): LayoutSize {
  return {
    width: reported(Reflect.get(window, 'innerWidth'), BLANK_SIZE.width),
    height: reported(Reflect.get(window, 'innerHeight'), BLANK_SIZE.height),
    devicePixelRatio: reported(
      Reflect.get(window, 'devicePixelRatio'),
      BLANK_SIZE.devicePixelRatio,
    ),
  };
}

// The layout viewport has whole numbers, as the protocol types it, and the visual viewport has
// not.
function layoutViewport(width: number, height: number) {
  return { pageX: 0, pageY: 0, clientWidth: Math.floor(width), clientHeight: Math.floor(height) };
}

// The scale is that of a page that is not pinched, and the zoom that of the page zoom of the app at
// its default (seen on the app); the pixel ratio of the display is in neither.
function visualViewport(width: number, height: number) {
  return {
    offsetX: 0,
    offsetY: 0,
    pageX: 0,
    pageY: 0,
    clientWidth: width,
    clientHeight: height,
    scale: 1,
    zoom: 1,
  };
}

function contentSize(width: number, height: number) {
  return { x: 0, y: 0, width, height };
}

export function layoutMetrics({ width, height, devicePixelRatio }: LayoutSize) {
  const deviceWidth = width * devicePixelRatio;
  const deviceHeight = height * devicePixelRatio;
  return {
    layoutViewport: layoutViewport(deviceWidth, deviceHeight),
    visualViewport: visualViewport(deviceWidth, deviceHeight),
    contentSize: contentSize(deviceWidth, deviceHeight),
    cssLayoutViewport: layoutViewport(width, height),
    cssVisualViewport: visualViewport(width, height),
    cssContentSize: contentSize(width, height),
  };
}
