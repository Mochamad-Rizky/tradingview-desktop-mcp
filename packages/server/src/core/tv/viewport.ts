import type { CdpSession } from '../cdp/types.js';
import { TvMcpError } from '../errors.js';

// The viewport of a page as Page.getLayoutMetrics reports it, which the screenshot tool needs to cut
// and scale a capture and the input helpers need to send the pointer where a page has looked.
//
// Two kinds of pixel are at work. A CSS pixel is what the page lays out in and getBoundingClientRect
// reports. A DIP, a device-independent pixel, is what the window is made of, what the clip of
// Page.captureScreenshot is in, and what the points of Input.dispatchMouseEvent are in: a CSS pixel
// takes `zoom` of them, where zoom is the page zoom of the app (0.2 to 5, 1 at 100%). A device pixel
// is what an image is made of: the pixel ratio the page reports (window.devicePixelRatio) is the
// device pixels for each CSS pixel, and has the zoom in it, so the display has that ratio over the
// zoom of them for each DIP.

// A page's visible area in CSS pixels, with what is needed to ask Chrome for parts of it.
export interface Viewport {
  width: number;
  height: number;
  // Device pixels for each CSS pixel.
  devicePixelRatio: number;
  // DIPs for each CSS pixel: the page zoom of the app.
  zoom: number;
  // Where the visible part starts in the document, in CSS pixels: how far the page is scrolled. 0
  // for a page that does not scroll, which the chart page does not (seen on the app).
  pageX: number;
  pageY: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// The viewport that Page.getLayoutMetrics reports, or null when it does not report a usable one.
// The answer is read as it comes, not as the protocol types it: the visual viewport is the part of
// the page that is shown, and it comes twice, in CSS pixels (cssVisualViewport) and in device
// pixels (visualViewport, which the protocol marks as deprecated, but which the app still answers
// with and which is the only place that says how many device pixels a CSS pixel takes). The pixel
// ratio is their quotient. In the chart tab that is what window.devicePixelRatio says (seen on the
// app), and the window chrome, whose code must not be run, can be asked for it in this way too.
//
// The zoom is the one cssVisualViewport carries (seen as 1 at the default zoom of the app on a
// display with a pixel ratio of 2, so it does not hold the ratio of the display), and the page
// offset is the position of the visual viewport in the document. A zoom that is missing is 1, and
// an offset that is missing is 0: a page that does not say is taken as not zoomed and not scrolled.
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
  return {
    width,
    height,
    devicePixelRatio: deviceWidth / width,
    zoom: positive(css.zoom) ?? 1,
    pageX: finite(css.pageX) ?? 0,
    pageY: finite(css.pageY) ?? 0,
  };
}

// The viewport of a page, its zoom and the device pixels for each of its CSS pixels. The page is
// asked and not evaluated in: the window chrome has Node integration, and no page code is run in it
// for this. NOT_AVAILABLE when the page does not report a usable viewport.
export async function readViewport(session: CdpSession): Promise<Viewport> {
  const metrics: unknown = await session.send('Page.getLayoutMetrics');
  const viewport = viewportOf(metrics);
  if (viewport === null) {
    throw new TvMcpError('NOT_AVAILABLE', 'The page did not report the size of its viewport', {
      hint: 'The tab may be hidden or still loading. Bring it to the front and try again.',
    });
  }
  return viewport;
}
