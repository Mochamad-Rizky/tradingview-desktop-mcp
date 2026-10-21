// The arithmetic of a screenshot: the viewport of a page as Page.getLayoutMetrics reports it, the
// part of the page that is on the screen, the clip that asks Chrome for it, the scale that keeps an
// image within a width, the size of the image that comes out, and where to read that size.
//
// Two kinds of pixel are at work. A CSS pixel is what the page lays out in and getBoundingClientRect
// reports. A DIP, a device-independent pixel, is what the window is made of and what the clip of
// Page.captureScreenshot is in: a CSS pixel takes `zoom` of them, where zoom is the page zoom of
// the app (0.2 to 5, 1 at 100%). A device pixel is what the image is made of: the pixel ratio the
// page reports (window.devicePixelRatio) is the device pixels for each CSS pixel, and has the zoom
// in it, so the display has that ratio over the zoom of them for each DIP.

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

// An edge of the box that lies this far out of the viewport, in CSS pixels, is the rounding of the
// layout and not a cut.
const EDGE_TOLERANCE = 0.01;

// The part of the box that lies in the viewport, and whether that is less than the box, or null when
// none of it does. A capture that does not go beyond the viewport shows no more than that.
export function clampToViewport(
  box: Box,
  viewport: Pick<Viewport, 'width' | 'height'>,
): { box: Box; clamped: boolean } | null {
  const left = Math.max(box.x, 0);
  const top = Math.max(box.y, 0);
  const right = Math.min(box.x + box.width, viewport.width);
  const bottom = Math.min(box.y + box.height, viewport.height);
  if (right - left <= 0 || bottom - top <= 0) {
    return null;
  }
  const clamped =
    left - box.x > EDGE_TOLERANCE ||
    top - box.y > EDGE_TOLERANCE ||
    box.x + box.width - right > EDGE_TOLERANCE ||
    box.y + box.height - bottom > EDGE_TOLERANCE;
  return {
    box: clamped ? { x: left, y: top, width: right - left, height: bottom - top } : box,
    clamped,
  };
}

// The clip of Page.captureScreenshot for a box of the visible part: in the space of the page, so the
// box is moved by where the page is scrolled to, and in DIPs, so everything is multiplied by the
// zoom. The scale is the one that captureScale worked out.
export function clipOf(
  box: Box,
  viewport: Pick<Viewport, 'zoom' | 'pageX' | 'pageY'>,
  scale: number,
): Box & { scale: number } {
  const { zoom } = viewport;
  return {
    x: (box.x + viewport.pageX) * zoom,
    y: (box.y + viewport.pageY) * zoom,
    width: box.width * zoom,
    height: box.height * zoom,
    scale,
  };
}

// The scale of the clip that brings an image of `width` CSS pixels, which is `width` times the
// pixel ratio device pixels wide, within `maxWidth`. An image is never scaled up. The image Chrome
// makes of a clip in DIPs is the clip times the ratio of the display times this scale, which is
// `width` times the pixel ratio times it, so the zoom does not enter.
export function captureScale(width: number, devicePixelRatio: number, maxWidth: number): number {
  return Math.min(1, maxWidth / (width * devicePixelRatio));
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

function sizeOrNull(width: number, height: number): { width: number; height: number } | null {
  return width > 0 && height > 0 ? { width, height } : null;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// The type of the first chunk of a png, IHDR, and the length of its data.
const PNG_HEADER_TYPE = 0x49484452;
const PNG_HEADER_LENGTH = 13;

// A png starts with a signature and the header chunk, whose data begins with the width and the
// height as 32 bit numbers: 8 bytes of signature, then the length and the type of the chunk, then
// the data.
function pngSize(image: Uint8Array, view: DataView): { width: number; height: number } | null {
  if (image.length < 24 || !PNG_SIGNATURE.every((byte, at) => image[at] === byte)) {
    return null;
  }
  if (view.getUint32(8) !== PNG_HEADER_LENGTH || view.getUint32(12) !== PNG_HEADER_TYPE) {
    return null;
  }
  return sizeOrNull(view.getUint32(16), view.getUint32(20));
}

// The markers that start the frame header of a jpeg (SOF0 to SOF15), apart from the three in that
// range that are no frame: the Huffman tables, a reserved marker and the arithmetic coding
// conditioning.
function isFrameMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

// A jpeg is a run of segments, each a marker (0xFF and a code) and a length that counts its own two
// bytes. The frame header is the one whose code is SOF: precision (1 byte), then the height and the
// width as 16 bit numbers. It comes before the scan, so the walk ends there.
function jpegSize(image: Uint8Array, view: DataView): { width: number; height: number } | null {
  if (image.length < 4 || view.getUint16(0) !== 0xffd8) {
    return null;
  }
  let at = 2;
  while (at + 4 <= image.length) {
    if (view.getUint8(at) !== 0xff) {
      return null;
    }
    const marker = view.getUint8(at + 1);
    if (marker === 0xff) {
      // A fill byte before the marker.
      at += 1;
    } else if (isFrameMarker(marker)) {
      return at + 9 <= image.length
        ? sizeOrNull(view.getUint16(at + 7), view.getUint16(at + 5))
        : null;
    } else if (marker === 0xda || marker === 0xd9) {
      // The scan or the end of the image, with no frame header before it.
      return null;
    } else if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      // Markers that stand alone, with no length.
      at += 2;
    } else {
      const length = view.getUint16(at + 2);
      if (length < 2) {
        return null;
      }
      at += 2 + length;
    }
  }
  return null;
}

// The size of the image in its own header, or null when it cannot be read there, such as when the
// bytes are not an image of that format. This is the size the image has, whatever the clip asked for.
export function imageSizeOf(
  image: Uint8Array,
  format: 'png' | 'jpeg',
): { width: number; height: number } | null {
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  return format === 'png' ? pngSize(image, view) : jpegSize(image, view);
}
