import type { CdpSession } from '../../../../src/core/cdp/types.js';
import { readViewport, viewportOf } from '../../../../src/core/tv/viewport.js';
import { failureOf } from '../../../helpers/failure-of.js';
import { layoutMetrics } from '../../../helpers/fake-cdp/layout.js';

// What Page.getLayoutMetrics says about a page: the size of its viewport in CSS pixels, the device
// pixels for each of them and the page zoom, which the screenshot tool and the input helpers read.

describe('viewportOf', () => {
  test('viewportOf reads the CSS size of the viewport and the pixel ratio from the layout metrics', () => {
    const metrics = layoutMetrics({ width: 1600, height: 1000, devicePixelRatio: 2 });

    expect(viewportOf(metrics)).toEqual({
      width: 1600,
      height: 1000,
      devicePixelRatio: 2,
      zoom: 1,
      zoomReported: true,
      pageX: 0,
      pageY: 0,
    });
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
      cssLayoutViewport: { pageX: 7, pageY: 7, clientWidth: 1, clientHeight: 1 },
      layoutViewport: { pageX: 7, pageY: 7, clientWidth: 9, clientHeight: 9 },
      cssContentSize: { x: 0, y: 0, width: 5, height: 5 },
    };

    expect(viewportOf(metrics)).toEqual({
      width: 1600,
      height: 1000,
      devicePixelRatio: 2,
      zoom: 1,
      zoomReported: true,
      pageX: 0,
      pageY: 0,
    });
  });

  test('viewportOf reads the page zoom of the app and where the page is scrolled to', () => {
    // 125% of a display with two device pixels for each DIP: the window of 1600 by 1000 DIPs lays
    // out 1280 by 800 CSS pixels with 2.5 device pixels for each.
    const metrics = layoutMetrics({
      width: 1280,
      height: 800,
      devicePixelRatio: 2.5,
      zoom: 1.25,
      pageX: 100,
      pageY: 200,
    });

    expect(viewportOf(metrics)).toEqual({
      width: 1280,
      height: 800,
      devicePixelRatio: 2.5,
      zoom: 1.25,
      zoomReported: true,
      pageX: 100,
      pageY: 200,
    });
  });

  const good = layoutMetrics({ width: 800, height: 600, devicePixelRatio: 1 });
  const visual = { clientWidth: 800, clientHeight: 600, scale: 1 };

  test.each([
    ['no zoom', undefined],
    ['a zoom of zero', 0],
    ['a negative zoom', -1.25],
    ['a zoom that is text', '1.25'],
    ['a zoom that is not a number', NaN],
    ['an infinite zoom', Infinity],
    ['a zoom that is null', null],
  ])('viewportOf takes a zoom of 1 for %s, and says the page did not report one', (_case, zoom) => {
    const metrics = { ...good, cssVisualViewport: { ...visual, zoom } };

    expect(viewportOf(metrics)).toMatchObject({ zoom: 1, zoomReported: false });
  });

  test('viewportOf says the page reported a zoom of 1 when it did', () => {
    const metrics = { ...good, cssVisualViewport: { ...visual, zoom: 1 } };

    expect(viewportOf(metrics)).toMatchObject({ zoom: 1, zoomReported: true });
  });

  test.each([
    ['no page offset', undefined],
    ['a page offset that is text', '100'],
    ['a page offset that is not a number', NaN],
    ['an infinite page offset', Infinity],
    ['a page offset that is null', null],
  ])('viewportOf takes a page offset of 0 for %s', (_case, offset) => {
    const metrics = { ...good, cssVisualViewport: { ...visual, pageX: offset, pageY: offset } };

    expect(viewportOf(metrics)).toMatchObject({ pageX: 0, pageY: 0 });
  });

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

describe('readViewport', () => {
  // A session that answers every command with `answer` and records what it was asked.
  function sessionAnswering(answer: unknown): { session: CdpSession; sent: string[] } {
    const sent: string[] = [];
    const session: CdpSession = {
      targetId: 'PAGE1',
      isClosed: false,
      send: ((method: string) => {
        sent.push(method);
        return Promise.resolve(answer);
      }) as CdpSession['send'],
      onClose: () => undefined,
      close: () => Promise.resolve(),
    };
    return { session, sent };
  }

  test('readViewport asks the page for its layout metrics, and runs no code in it', async () => {
    const { session, sent } = sessionAnswering(
      layoutMetrics({ width: 1280, height: 800, devicePixelRatio: 2.5, zoom: 1.25 }),
    );

    await expect(readViewport(session)).resolves.toEqual({
      width: 1280,
      height: 800,
      devicePixelRatio: 2.5,
      zoom: 1.25,
      zoomReported: true,
      pageX: 0,
      pageY: 0,
    });
    expect(sent).toEqual(['Page.getLayoutMetrics']);
  });

  test('readViewport refuses with NOT_AVAILABLE when the page reports no usable viewport', async () => {
    const { session } = sessionAnswering({});

    const error = await failureOf(readViewport(session));

    expect(error.toPayload()).toEqual({
      code: 'NOT_AVAILABLE',
      message: 'The page did not report the size of its viewport',
      hint: 'The tab may be hidden or still loading. Bring it to the front and try again.',
    });
  });
});
