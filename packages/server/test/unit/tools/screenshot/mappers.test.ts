import {
  captureScale,
  clampToViewport,
  clipOf,
  imageSizeOf,
  outputSize,
} from '../../../../src/tools/screenshot/mappers.js';
import { solidImage } from '../../../helpers/fake-cdp/images.js';

// The arithmetic of a capture: the part of the page that is on the screen, the clip that asks
// Chrome for it and the scale that keeps the image within a width, the size of the image that comes
// out, and where to read that size. What Page.getLayoutMetrics says about the page is read in the
// core (test/unit/core/tv/viewport.test.ts).

describe('captureScale', () => {
  test('captureScale brings an image of width times pixel ratio down to maxWidth', () => {
    // 1600 CSS pixels are 3200 device pixels on a 2x display: a quarter of that is 800.
    expect(captureScale(1600, 2, 800)).toBe(0.25);
    expect(captureScale(1000, 1, 500)).toBe(0.5);
    expect(captureScale(1403, 2, 800)).toBeCloseTo(800 / 2806, 12);
  });

  test('captureScale never scales up', () => {
    expect(captureScale(500, 1, 4000)).toBe(1);
    expect(captureScale(1600, 2, 3200)).toBe(1);
    expect(captureScale(100, 1, 100)).toBe(1);
  });
});

describe('outputSize', () => {
  test('outputSize is the box in device pixels, scaled', () => {
    expect(outputSize({ width: 1600, height: 1000 }, 2, 0.25)).toEqual({ width: 800, height: 500 });
    expect(outputSize({ width: 1180, height: 640 }, 1, 1)).toEqual({ width: 1180, height: 640 });
    expect(outputSize({ width: 100, height: 50 }, 1.5, 1)).toEqual({ width: 150, height: 75 });
  });

  test('outputSize rounds to whole pixels', () => {
    expect(outputSize({ width: 1403, height: 757 }, 2, 800 / 2806)).toEqual({
      width: 800,
      height: 432,
    });
    expect(outputSize({ width: 10.4, height: 10.5 }, 1, 1)).toEqual({ width: 10, height: 11 });
  });

  test('outputSize leaves an image at least one pixel in each direction', () => {
    expect(outputSize({ width: 1500, height: 34 }, 2, 0.001)).toEqual({ width: 3, height: 1 });
    expect(outputSize({ width: 1, height: 1 }, 1, 0.01)).toEqual({ width: 1, height: 1 });
  });
});

describe('clampToViewport', () => {
  const viewport = { width: 1280, height: 720 };

  test('clampToViewport leaves a box inside the viewport as it is', () => {
    const box = { x: 50, y: 40, width: 1180, height: 640 };

    expect(clampToViewport(box, viewport)).toEqual({ box, clamped: false });
  });

  test('clampToViewport leaves a box that is the whole viewport as it is', () => {
    const box = { x: 0, y: 0, width: 1280, height: 720 };

    expect(clampToViewport(box, viewport)).toEqual({ box, clamped: false });
  });

  test.each([
    [
      'the right and the bottom',
      { x: 50, y: 40, width: 1400, height: 800 },
      { x: 50, y: 40, width: 1230, height: 680 },
    ],
    [
      'the left and the top',
      { x: -30, y: -20, width: 400, height: 300 },
      { x: 0, y: 0, width: 370, height: 280 },
    ],
    [
      'every side',
      { x: -10, y: -10, width: 2000, height: 2000 },
      { x: 0, y: 0, width: 1280, height: 720 },
    ],
    [
      'the right only',
      { x: 1000, y: 100, width: 400, height: 200 },
      { x: 1000, y: 100, width: 280, height: 200 },
    ],
  ])('clampToViewport cuts a box that reaches over %s to the viewport', (_where, box, cut) => {
    expect(clampToViewport(box, viewport)).toEqual({ box: cut, clamped: true });
  });

  test.each([
    ['right of', { x: 1280, y: 40, width: 100, height: 100 }],
    ['far right of', { x: 1500, y: 40, width: 100, height: 100 }],
    ['below', { x: 40, y: 720, width: 100, height: 100 }],
    ['left of', { x: -200, y: 40, width: 100, height: 100 }],
    ['above', { x: 40, y: -300, width: 100, height: 100 }],
    ['at the left edge of', { x: -100, y: 40, width: 100, height: 100 }],
  ])('clampToViewport gives nothing for a box that is %s the viewport', (_where, box) => {
    expect(clampToViewport(box, viewport)).toBeNull();
  });

  test('clampToViewport gives nothing for a box with no area', () => {
    expect(clampToViewport({ x: 10, y: 10, width: 0, height: 50 }, viewport)).toBeNull();
    expect(clampToViewport({ x: 10, y: 10, width: 50, height: 0 }, viewport)).toBeNull();
  });

  test('clampToViewport does not call rounding of the layout a cut', () => {
    // These edges add up to a hair more than the width of the viewport in floating point.
    const box = { x: 56.3, y: 40, width: 1223.7000000000003, height: 680.0000000000001 };
    expect(box.x + box.width).toBeGreaterThan(1280);
    expect(box.y + box.height).toBeGreaterThan(720);

    expect(clampToViewport(box, viewport)).toEqual({ box, clamped: false });
    // A thousandth of a CSS pixel over the edge is no cut either; a third of one is.
    expect(clampToViewport({ ...box, width: 1223.701 }, viewport)).toEqual({
      box: { ...box, width: 1223.701 },
      clamped: false,
    });
    expect(clampToViewport({ ...box, width: 1224 }, viewport)).toEqual({
      box: { x: 56.3, y: 40, width: 1280 - 56.3, height: 680 },
      clamped: true,
    });
  });
});

describe('clipOf', () => {
  const box = { x: 50, y: 40, width: 600, height: 500 };

  test('clipOf is the box with a scale at the default zoom of a page that is not scrolled', () => {
    expect(clipOf(box, { zoom: 1, pageX: 0, pageY: 0 }, 0.5)).toEqual({ ...box, scale: 0.5 });
  });

  test('clipOf gives the box in DIPs, which are the CSS pixels times the zoom', () => {
    expect(clipOf(box, { zoom: 1.25, pageX: 0, pageY: 0 }, 1)).toEqual({
      x: 62.5,
      y: 50,
      width: 750,
      height: 625,
      scale: 1,
    });
    expect(clipOf(box, { zoom: 0.5, pageX: 0, pageY: 0 }, 0.25)).toEqual({
      x: 25,
      y: 20,
      width: 300,
      height: 250,
      scale: 0.25,
    });
  });

  test('clipOf puts the box in the space of the page: the offset of the visible part is added first', () => {
    expect(clipOf(box, { zoom: 1, pageX: 100, pageY: 200 }, 1)).toEqual({
      x: 150,
      y: 240,
      width: 600,
      height: 500,
      scale: 1,
    });
    // The offset is in CSS pixels as well, so the zoom scales it with the box.
    expect(clipOf(box, { zoom: 1.25, pageX: 100, pageY: 200 }, 1)).toEqual({
      x: 187.5,
      y: 300,
      width: 750,
      height: 625,
      scale: 1,
    });
  });

  test('clipOf leaves the scale alone', () => {
    expect(clipOf(box, { zoom: 2, pageX: 0, pageY: 0 }, 0.3333).scale).toBe(0.3333);
  });
});

describe('the clip, the scale and the size of the image together', () => {
  // What Chrome makes of a clip (Chromium, page_handler.cc): the clip is in DIPs, and the image is
  // the clip times the device scale factor of the display times the scale of the clip. The pixel
  // ratio a page reports has the zoom in it, so the factor of the display is that ratio over the
  // zoom.
  function chromeWidth(clip: { width: number; scale: number }, displayScale: number): number {
    return Math.max(1, Math.round(clip.width * displayScale * clip.scale));
  }

  const zooms = [0.25, 0.5, 1, 1.25, 2, 5];
  const displays = [1, 1.5, 2, 3];
  const widths = [100, 333.5, 800, 1403, 2560, 5120];
  const limits = [100, 799, 800, 1920, 4000];

  test('the image is never wider than maxWidth at any zoom, and the size predicted is the size Chrome makes', () => {
    for (const zoom of zooms) {
      for (const display of displays) {
        for (const width of widths) {
          for (const maxWidth of limits) {
            const devicePixelRatio = display * zoom;
            const scale = captureScale(width, devicePixelRatio, maxWidth);
            const box = { x: 0, y: 0, width, height: 600 };
            const clip = clipOf(box, { zoom, pageX: 0, pageY: 0 }, scale);
            const label = `${String(width)} px at zoom ${String(zoom)} on ${String(display)}x within ${String(maxWidth)}`;

            const made = chromeWidth(clip, display);

            expect(made, label).toBeLessThanOrEqual(maxWidth);
            expect(made, label).toBe(outputSize(box, devicePixelRatio, scale).width);
          }
        }
      }
    }
  });

  test('a clip in CSS pixels instead of DIPs misses the mark, which is what the zoom is there for', () => {
    // At a zoom of 50% a CSS pixel is half a DIP: the clip of the whole page, in CSS pixels, is
    // twice as wide as the window, and the image twice as wide as maxWidth.
    const devicePixelRatio = 1;
    const scale = captureScale(3200, devicePixelRatio, 800);

    const inCssPixels = { x: 0, y: 0, width: 3200, height: 2000, scale };
    const inDips = clipOf(inCssPixels, { zoom: 0.5, pageX: 0, pageY: 0 }, scale);

    expect(chromeWidth(inCssPixels, 2)).toBe(1600);
    expect(chromeWidth(inDips, 2)).toBe(800);
  });
});

describe('imageSizeOf', () => {
  const png = (width: number, height: number): Buffer =>
    Buffer.from(solidImage('png', width, height), 'base64');
  const jpeg = (width: number, height: number): Buffer =>
    Buffer.from(solidImage('jpeg', width, height), 'base64');

  test('imageSizeOf reads the size of a png from its header', () => {
    expect(imageSizeOf(png(321, 123), 'png')).toEqual({ width: 321, height: 123 });
    expect(imageSizeOf(png(1, 1), 'png')).toEqual({ width: 1, height: 1 });
    expect(imageSizeOf(png(3200, 2000), 'png')).toEqual({ width: 3200, height: 2000 });
  });

  test('imageSizeOf reads the size of a baseline jpeg from its frame header', () => {
    expect(imageSizeOf(jpeg(77, 55), 'jpeg')).toEqual({ width: 77, height: 55 });
    expect(imageSizeOf(jpeg(3200, 2000), 'jpeg')).toEqual({ width: 3200, height: 2000 });
  });

  test('imageSizeOf reads the size of a progressive jpeg, whose frame header is SOF2', () => {
    const image = jpeg(640, 480);
    const frame = image.indexOf(Buffer.from([0xff, 0xc0]));
    image[frame + 1] = 0xc2;

    expect(imageSizeOf(image, 'jpeg')).toEqual({ width: 640, height: 480 });
  });

  test('imageSizeOf goes past the segments that come before the frame header', () => {
    const body = jpeg(90, 60);
    const frame = body.indexOf(Buffer.from([0xff, 0xc0]));
    const segment = (marker: number, length: number): Buffer =>
      Buffer.concat([
        Buffer.from([0xff, marker, length >> 8, length & 0xff]),
        Buffer.alloc(length - 2),
      ]);
    // A JFIF header, an Exif block, a comment and a fill byte, as an encoder may write them.
    const image = Buffer.concat([
      body.subarray(0, 2),
      segment(0xe0, 16),
      segment(0xe1, 300),
      segment(0xfe, 9),
      Buffer.from([0xff]),
      body.subarray(2, frame),
      body.subarray(frame),
    ]);

    expect(imageSizeOf(image, 'jpeg')).toEqual({ width: 90, height: 60 });
  });

  test('imageSizeOf goes past a standalone marker', () => {
    const body = jpeg(90, 60);
    const image = Buffer.concat([body.subarray(0, 2), Buffer.from([0xff, 0x01]), body.subarray(2)]);

    expect(imageSizeOf(image, 'jpeg')).toEqual({ width: 90, height: 60 });
  });

  test('imageSizeOf does not take a Huffman table, a reserved marker or an arithmetic conditioning for a frame header', () => {
    const body = jpeg(90, 60);
    const segment = (marker: number, length: number): Buffer =>
      Buffer.concat([
        Buffer.from([0xff, marker, length >> 8, length & 0xff]),
        Buffer.alloc(length - 2, 0x11),
      ]);
    // The ranges SOF0 to SOF15 hold these three markers (DHT, JPG and DAC) as well.
    const image = Buffer.concat([
      body.subarray(0, 2),
      segment(0xc4, 20),
      segment(0xc8, 6),
      segment(0xcc, 4),
      body.subarray(2),
    ]);

    expect(imageSizeOf(image, 'jpeg')).toEqual({ width: 90, height: 60 });
  });

  const ok = png(10, 10);

  test.each([
    ['nothing', Buffer.alloc(0), 'png'],
    ['a png cut short in its header', ok.subarray(0, 20), 'png'],
    [
      'a png with another signature',
      Buffer.concat([Buffer.from('GIF89a  '), ok.subarray(8)]),
      'png',
    ],
    [
      'a png whose first chunk is not IHDR',
      Buffer.concat([ok.subarray(0, 12), Buffer.from('IDAT'), ok.subarray(16)]),
      'png',
    ],
    [
      'a png whose header chunk has the wrong length',
      Buffer.concat([ok.subarray(0, 8), Buffer.from([0, 0, 0, 12]), ok.subarray(12)]),
      'png',
    ],
    ['a png of no width', png(1, 1).fill(0, 16, 20), 'png'],
    ['a png of no height', png(1, 1).fill(0, 20, 24), 'png'],
    ['a jpeg read as a png', jpeg(10, 10), 'png'],
    ['a png read as a jpeg', ok, 'jpeg'],
    ['a jpeg cut short before its frame header', jpeg(10, 10).subarray(0, 30), 'jpeg'],
    [
      'a jpeg cut short inside its frame header',
      Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00]),
      'jpeg',
    ],
    ['a jpeg that is only a start marker', Buffer.from([0xff, 0xd8]), 'jpeg'],
    [
      'a jpeg that reaches its scan before a frame header',
      Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0]),
      'jpeg',
    ],
    ['a jpeg that ends before a frame header', Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0, 0]), 'jpeg'],
    ['a jpeg that loses its markers', Buffer.from([0xff, 0xd8, 0x12, 0x34, 0x56, 0x78]), 'jpeg'],
    [
      'a jpeg with a segment that is shorter than its own length field',
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0, 0, 0, 0]),
      'jpeg',
    ],
    [
      'a jpeg with a segment that runs past its end',
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xf0, 0, 0, 0, 0]),
      'jpeg',
    ],
  ] as const)('imageSizeOf gives nothing for %s', (_case, image, format) => {
    expect(imageSizeOf(image, format)).toBeNull();
  });

  // The frame header of a baseline jpeg: marker, length, precision, then the height and the width.
  test.each([
    ['no height', 5],
    ['no width', 7],
  ])('imageSizeOf gives nothing for a jpeg of %s', (_case, at) => {
    const image = jpeg(10, 10);
    const frame = image.indexOf(Buffer.from([0xff, 0xc0]));
    image.fill(0, frame + at, frame + at + 2);

    expect(imageSizeOf(image, 'jpeg')).toBeNull();
  });
});
