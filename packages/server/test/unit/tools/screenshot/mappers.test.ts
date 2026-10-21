import { captureScale, outputSize, viewportOf } from '../../../../src/tools/screenshot/mappers.js';
import { layoutMetrics } from '../../../helpers/fake-cdp/layout.js';

// The arithmetic of a capture: what Page.getLayoutMetrics says about the page, the scale that keeps
// an image within maxWidth, and the size of the image that comes out of it.

describe('viewportOf', () => {
  test('viewportOf reads the CSS size of the viewport and the pixel ratio from the layout metrics', () => {
    const metrics = layoutMetrics({ width: 1600, height: 1000, devicePixelRatio: 2 });

    expect(viewportOf(metrics)).toEqual({ width: 1600, height: 1000, devicePixelRatio: 2 });
  });

  test('viewportOf keeps fractions of the size and of the ratio', () => {
    const viewport = viewportOf(
      layoutMetrics({ width: 1303.5, height: 713.25, devicePixelRatio: 1.25 }),
    );

    expect(viewport?.width).toBe(1303.5);
    expect(viewport?.height).toBe(713.25);
    expect(viewport?.devicePixelRatio).toBeCloseTo(1.25, 10);
  });

  test('viewportOf reads the visual viewport, in CSS pixels and in device pixels', () => {
    const metrics = {
      ...layoutMetrics({ width: 1600, height: 1000, devicePixelRatio: 2 }),
      // The layout viewport and the content are left out of the reading: only the visual viewport
      // is the part of the page that is shown.
      cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 1, clientHeight: 1 },
      layoutViewport: { pageX: 0, pageY: 0, clientWidth: 9, clientHeight: 9 },
      cssContentSize: { x: 0, y: 0, width: 5, height: 5 },
    };

    expect(viewportOf(metrics)).toEqual({ width: 1600, height: 1000, devicePixelRatio: 2 });
  });

  const good = layoutMetrics({ width: 800, height: 600, devicePixelRatio: 1 });
  const visual = { clientWidth: 800, clientHeight: 600, scale: 1 };

  test.each([
    ['nothing', undefined],
    ['null', null],
    ['a string', 'metrics'],
    ['a list', []],
    ['an empty object', {}],
    [
      'metrics without the visual viewport in CSS pixels',
      { ...good, cssVisualViewport: undefined },
    ],
    [
      'metrics without the visual viewport in device pixels',
      { ...good, visualViewport: undefined },
    ],
    ['a visual viewport that is not an object', { ...good, cssVisualViewport: 800 }],
    ['a width that is a string', { ...good, cssVisualViewport: { ...visual, clientWidth: '800' } }],
    ['a width of zero', { ...good, cssVisualViewport: { ...visual, clientWidth: 0 } }],
    ['a negative height', { ...good, cssVisualViewport: { ...visual, clientHeight: -1 } }],
    [
      'a height that is not a number',
      { ...good, cssVisualViewport: { ...visual, clientHeight: NaN } },
    ],
    ['an infinite width', { ...good, cssVisualViewport: { ...visual, clientWidth: Infinity } }],
    [
      'no width in device pixels',
      { ...good, visualViewport: { ...visual, clientWidth: undefined } },
    ],
    [
      'a width in device pixels of zero',
      { ...good, visualViewport: { ...visual, clientWidth: 0 } },
    ],
  ])('viewportOf gives nothing for %s', (_case, metrics) => {
    expect(viewportOf(metrics)).toBeNull();
  });
});

describe('captureScale', () => {
  test('captureScale is 1 without a maxWidth', () => {
    expect(captureScale(1600, 2, undefined)).toBe(1);
  });

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

describe('captureScale and outputSize together', () => {
  const widths = [100, 101, 333.5, 800, 1180.25, 1403, 1303.75, 1600, 2560, 5120];
  const ratios = [1, 1.25, 1.5, 2, 2.5, 3];
  const limits = [100, 799, 800, 1234, 4000];

  test('the image is never wider than maxWidth, and is exactly as wide when it was scaled down', () => {
    for (const width of widths) {
      for (const ratio of ratios) {
        for (const maxWidth of limits) {
          const scale = captureScale(width, ratio, maxWidth);
          const { width: pixels } = outputSize({ width, height: 600 }, ratio, scale);
          const label = `${String(width)} px at ${String(ratio)}x within ${String(maxWidth)}`;

          expect(pixels, label).toBeLessThanOrEqual(maxWidth);
          if (scale < 1) {
            expect(pixels, label).toBe(maxWidth);
          } else {
            expect(pixels, label).toBe(Math.max(1, Math.round(width * ratio)));
          }
        }
      }
    }
  });
});
