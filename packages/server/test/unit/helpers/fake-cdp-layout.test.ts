import { layoutMetrics, layoutSizeOf } from '../../helpers/fake-cdp/layout.js';

// The answer of Page.getLayoutMetrics that the fake debug port gives, in the shape the app was seen
// to answer with: the same six members, the metrics of the layout viewport and of the visual
// viewport in device pixels and in CSS pixels, and the size of the content.

describe('layoutMetrics', () => {
  test('layoutMetrics has the six members the app answers with', () => {
    const metrics = layoutMetrics({ width: 1600, height: 1000, devicePixelRatio: 2 });

    expect(Object.keys(metrics).sort()).toEqual([
      'contentSize',
      'cssContentSize',
      'cssLayoutViewport',
      'cssVisualViewport',
      'layoutViewport',
      'visualViewport',
    ]);
  });

  test('layoutMetrics gives the CSS viewport as it is and the device viewport times the pixel ratio', () => {
    const metrics = layoutMetrics({ width: 1600, height: 1000, devicePixelRatio: 2 });

    expect(metrics.cssLayoutViewport).toEqual({
      pageX: 0,
      pageY: 0,
      clientWidth: 1600,
      clientHeight: 1000,
    });
    expect(metrics.layoutViewport).toEqual({
      pageX: 0,
      pageY: 0,
      clientWidth: 3200,
      clientHeight: 2000,
    });
    expect(metrics.cssContentSize).toEqual({ x: 0, y: 0, width: 1600, height: 1000 });
    expect(metrics.contentSize).toEqual({ x: 0, y: 0, width: 3200, height: 2000 });
  });

  test('layoutMetrics gives the visual viewport with a scale and a zoom of 1, as the app does at its default', () => {
    const { cssVisualViewport, visualViewport } = layoutMetrics({
      width: 1600,
      height: 1000,
      devicePixelRatio: 2,
    });

    // The zoom is the page zoom of the app, so the pixel ratio of the display is not part of it.
    expect(cssVisualViewport).toEqual({
      offsetX: 0,
      offsetY: 0,
      pageX: 0,
      pageY: 0,
      clientWidth: 1600,
      clientHeight: 1000,
      scale: 1,
      zoom: 1,
    });
    expect(visualViewport).toEqual({ ...cssVisualViewport, clientWidth: 3200, clientHeight: 2000 });
  });

  test('layoutMetrics keeps fractions in the visual viewport and whole numbers in the layout viewport', () => {
    const metrics = layoutMetrics({ width: 1303.5, height: 713.25, devicePixelRatio: 1.25 });

    expect(metrics.cssVisualViewport).toMatchObject({ clientWidth: 1303.5, clientHeight: 713.25 });
    expect(metrics.visualViewport).toMatchObject({
      clientWidth: 1303.5 * 1.25,
      clientHeight: 713.25 * 1.25,
    });
    expect(metrics.cssLayoutViewport).toMatchObject({ clientWidth: 1303, clientHeight: 713 });
    expect(metrics.layoutViewport).toMatchObject({ clientWidth: 1629, clientHeight: 891 });
  });
});

describe('layoutSizeOf', () => {
  test('layoutSizeOf reads the size and the pixel ratio a window reports', () => {
    const win = { innerWidth: 1600, innerHeight: 1000, devicePixelRatio: 2 };

    expect(layoutSizeOf(win)).toEqual({ width: 1600, height: 1000, devicePixelRatio: 2 });
  });

  test('layoutSizeOf reads a getter of the window as well', () => {
    const win = {
      get innerWidth() {
        return 640;
      },
      innerHeight: 480,
      devicePixelRatio: 1.5,
    };

    expect(layoutSizeOf(win)).toEqual({ width: 640, height: 480, devicePixelRatio: 1.5 });
  });

  test('layoutSizeOf gives a blank viewport of 1280 by 720 at ratio 1 for what the window leaves out', () => {
    expect(layoutSizeOf({})).toEqual({ width: 1280, height: 720, devicePixelRatio: 1 });
    expect(layoutSizeOf({ innerWidth: 800 })).toEqual({
      width: 800,
      height: 720,
      devicePixelRatio: 1,
    });
  });

  test.each([
    ['text', '1600'],
    ['not a number', Number.NaN],
    ['infinite', Infinity],
    ['zero', 0],
    ['negative', -2],
    ['nothing', undefined],
    ['null', null],
  ])('layoutSizeOf ignores a size that is %s', (_case, value) => {
    const win = { innerWidth: value, innerHeight: value, devicePixelRatio: value };

    expect(layoutSizeOf(win)).toEqual({ width: 1280, height: 720, devicePixelRatio: 1 });
  });
});
