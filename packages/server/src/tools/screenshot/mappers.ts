import type { Viewport } from '../../core/tv/viewport.js';

// The arithmetic of a screenshot: the part of the page that is on the screen, the clip that asks
// Chrome for it, the scale that keeps an image within a width, the size of the image that comes out,
// and where to read that size. The viewport of the page, and the kinds of pixel it is measured in,
// come from the core (core/tv/viewport.ts), which the input helpers share.

// An area of a page in CSS pixels, from the top left of the viewport.
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
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
