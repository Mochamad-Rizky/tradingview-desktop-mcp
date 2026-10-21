// The arithmetic of a screenshot: the viewport of a page as Page.getLayoutMetrics reports it, the
// scale that keeps an image within a width, and the size of the image that comes out.

// A page's visible area in CSS pixels, and the device pixels for each of them.
export interface Viewport {
  width: number;
  height: number;
  devicePixelRatio: number;
}

// An area of a page in CSS pixels, from the top left of the viewport.
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

// The viewport that Page.getLayoutMetrics reports, or null when it does not report a usable one.
// The answer is read as it comes, not as the protocol types it: the visual viewport is the part of
// the page that is shown, and it comes twice, in CSS pixels (cssVisualViewport) and in device
// pixels (visualViewport, which the protocol marks as deprecated, but which the app still answers
// with and which is the only place that says how many device pixels a CSS pixel takes). The pixel
// ratio is their quotient. In the chart tab that is what window.devicePixelRatio says (seen on the
// app), and the window chrome, whose code must not be run, can be asked for it in this way too.
export function viewportOf(metrics: unknown): Viewport | null {
  if (!isRecord(metrics)) {
    return null;
  }
  const { cssVisualViewport: css, visualViewport: device } = metrics;
  if (!isRecord(css) || !isRecord(device)) {
    return null;
  }
  const width = positive(css.clientWidth);
  const height = positive(css.clientHeight);
  const deviceWidth = positive(device.clientWidth);
  if (width === null || height === null || deviceWidth === null) {
    return null;
  }
  return { width, height, devicePixelRatio: deviceWidth / width };
}

// The scale of the clip that brings an image of `width` CSS pixels, which is `width` times the
// pixel ratio device pixels wide, within `maxWidth`. An image is never scaled up.
export function captureScale(
  width: number,
  devicePixelRatio: number,
  maxWidth: number | undefined,
): number {
  return maxWidth === undefined ? 1 : Math.min(1, maxWidth / (width * devicePixelRatio));
}

// The size of the image Chrome makes of a box: its size in device pixels, scaled, rounded to whole
// pixels, and at least one in each direction.
export function outputSize(
  box: Pick<Box, 'width' | 'height'>,
  devicePixelRatio: number,
  scale: number,
): { width: number; height: number } {
  const pixels = (cssPixels: number): number =>
    Math.max(1, Math.round(cssPixels * devicePixelRatio * scale));
  return { width: pixels(box.width), height: pixels(box.height) };
}
