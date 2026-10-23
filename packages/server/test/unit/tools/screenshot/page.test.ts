import type { CdpSession } from '../../../../src/core/cdp/types.js';
import type { TvMcpError } from '../../../../src/core/errors.js';
import {
  createPageBridge,
  type PageBridge,
  type PageFunction,
} from '../../../../src/core/tv/page-bridge.js';
import { SELECTORS } from '../../../../src/core/tv/selectors.js';
import type { TvWindow } from '../../../../src/core/tv/tv-window.js';
import { readChartBox, readStripBox } from '../../../../src/tools/screenshot/page.js';
import type { JsonValue } from '../../../../src/utils/json.js';
import { failureOf } from '../../../helpers/failure-of.js';
import { createPageRuntime } from '../../../helpers/fake-cdp/runtime.js';
import { createFakeDomWindow, fakeElement, type FakeRect } from '../../../helpers/fake-tv/dom.js';
import { loadTvFixture, type TvStateFixture } from '../../../helpers/fake-tv/fixture.js';
import { createFakeWindowChrome, STRIP_HEIGHT } from '../../../helpers/fake-tv/window-chrome.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTvOverrides,
  type FakeTvWindow,
} from '../../../helpers/fake-tv/window.js';

// The page function of the screenshot tool. It is run the way the server runs it, as source text in
// a page whose window is the one under test, through the real page bridge: a page function that
// leans on anything of its module would pass a direct call and fail there. It is also called
// directly, which is what the coverage of the module measures, on a second window built the same
// way. The two answers must agree.

const fixture = loadTvFixture();
const twoCharts: TvStateFixture = {
  ...fixture,
  layout: { ...fixture.layout, type: '2h', chartsCount: 2 },
};
const SELECTOR = SELECTORS.regions.chartContainer;
const LEFT: FakeRect = { x: 50, y: 40, width: 600, height: 500 };
const RIGHT: FakeRect = { x: 660, y: 40, width: 600, height: 500 };
const SIDE_BY_SIDE: FakeTvOverrides = { screen: { charts: [LEFT, RIGHT] } };

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
});

function bridgeTo(win: object): PageBridge {
  const runtime = createPageRuntime(win);
  disposers.push(() => {
    runtime.dispose();
  });
  const send = (method: string, params?: unknown): Promise<unknown> =>
    method === 'Runtime.evaluate'
      ? runtime.evaluate(params as Record<string, unknown>)
      : Promise.reject(new Error(`Unexpected command ${method}`));
  const session: CdpSession = {
    targetId: 'PAGE1',
    isClosed: false,
    // The protocol typings of send are generic over every CDP method; this fake answers one.
    send: send as CdpSession['send'],
    onClose: () => undefined,
    close: () => Promise.resolve(),
  };
  return createPageBridge(session, { timeoutMs: 5000 });
}

type Make = () => object;

// A fake chart tab, reshaped by `patch`, made anew for every run.
function tab(
  from: TvStateFixture,
  overrides: FakeTvOverrides = {},
  patch?: (win: FakeTvWindow) => void,
): Make {
  return () => {
    const win = createFakeTvWindow(from, overrides);
    patch?.(win);
    return win;
  };
}

function apiOf(win: FakeTvWindow) {
  if (win.TradingViewApi === undefined) {
    throw new Error('The fake window has no TradingViewApi');
  }
  return win.TradingViewApi;
}

function definitionsOf(win: FakeTvWindow) {
  const collection = apiOf(win)._chartWidgetCollection;
  if (collection === undefined) {
    throw new Error('The fake window has no chart widget collection');
  }
  return collection._chartWidgetsDefs;
}

async function resultOf<A extends JsonValue[], R extends JsonValue | null>(
  fn: PageFunction<A, R>,
  args: A,
  make: Make,
): Promise<R> {
  const result = await bridgeTo(make()).evaluate(fn, args);
  const direct = await fn(make() as TvWindow, ...args);
  expect(direct).toEqual(result);
  return result;
}

// A failure the page function reports with a sentinel: the bridge turns it into the error, and a
// direct call returns the sentinel itself.
async function failureOfBoth<A extends JsonValue[], R extends JsonValue | null>(
  fn: PageFunction<A, R>,
  args: A,
  make: Make,
): Promise<TvMcpError> {
  const error = await failureOf(bridgeTo(make()).evaluate(fn, args));
  const direct = await fn(make() as TvWindow, ...args);
  expect(direct).toEqual({ __tvmcpError: error.toPayload() });
  return error;
}

describe('readChartBox, with the chart widget collection of the app', () => {
  test('readChartBox returns the box of the container of the only chart, as the page reports it', async () => {
    const result = await resultOf(readChartBox, [null, SELECTOR], tab(fixture));

    // The default screen of the fake window puts the chart in a box of its own.
    expect(result).toEqual({
      box: { x: 50, y: 40, width: 1180, height: 640 },
      byPosition: false,
    });
  });

  test('readChartBox returns the box of the active chart when no chart is named', async () => {
    const first = await resultOf(readChartBox, [null, SELECTOR], tab(twoCharts, SIDE_BY_SIDE));
    const second = await resultOf(
      readChartBox,
      [null, SELECTOR],
      tab(twoCharts, SIDE_BY_SIDE, (win) => {
        inspectFakeWindow(win).state.activeChartIndex = 1;
      }),
    );

    expect(first).toEqual({ box: LEFT, byPosition: false });
    expect(second).toEqual({ box: RIGHT, byPosition: false });
  });

  test('readChartBox returns the box of the chart it is asked for, whichever chart is active', async () => {
    const make = tab(twoCharts, SIDE_BY_SIDE, (win) => {
      inspectFakeWindow(win).state.activeChartIndex = 1;
    });

    await expect(resultOf(readChartBox, [0, SELECTOR], make)).resolves.toEqual({
      box: LEFT,
      byPosition: false,
    });
    await expect(resultOf(readChartBox, [1, SELECTOR], make)).resolves.toEqual({
      box: RIGHT,
      byPosition: false,
    });
  });

  test('readChartBox reads the box again every time, so a chart that moved is found where it is', async () => {
    const moved: FakeRect = { x: 70, y: 60, width: 400, height: 300 };
    const make = tab(fixture, {}, (win) => {
      inspectFakeWindow(win).state.chartContainers[0]?.place(moved);
    });

    await expect(resultOf(readChartBox, [null, SELECTOR], make)).resolves.toEqual({
      box: moved,
      byPosition: false,
    });
  });

  test('readChartBox gives only the four numbers of the box, not the other sides of the rectangle', async () => {
    const result = await resultOf(readChartBox, [null, SELECTOR], tab(fixture));

    expect(Object.keys(result.box).sort()).toEqual(['height', 'width', 'x', 'y']);
  });
});

describe('readChartBox, by the position of the container in the page', () => {
  test('readChartBox takes the container at the position of the active chart when the app does not name it', async () => {
    const make = tab(twoCharts, { ...SIDE_BY_SIDE, withoutChartCollection: true });

    await expect(resultOf(readChartBox, [null, SELECTOR], make)).resolves.toEqual({
      box: LEFT,
      byPosition: true,
    });
  });

  test('readChartBox takes the container at the position of the chart it is asked for', async () => {
    const make = tab(twoCharts, { ...SIDE_BY_SIDE, withoutChartCollection: true });

    await expect(resultOf(readChartBox, [1, SELECTOR], make)).resolves.toEqual({
      box: RIGHT,
      byPosition: true,
    });
  });

  test('readChartBox follows the active chart to its position', async () => {
    const make = tab(twoCharts, { ...SIDE_BY_SIDE, withoutChartCollection: true }, (win) => {
      inspectFakeWindow(win).state.activeChartIndex = 1;
    });

    await expect(resultOf(readChartBox, [null, SELECTOR], make)).resolves.toEqual({
      box: RIGHT,
      byPosition: true,
    });
  });

  test('readChartBox finds the only container of a page whose app has not booted', async () => {
    const make = tab(fixture, { withoutApi: true });

    await expect(resultOf(readChartBox, [null, SELECTOR], make)).resolves.toEqual({
      box: { x: 50, y: 40, width: 1180, height: 640 },
      byPosition: true,
    });
  });

  test('readChartBox does not guess among several containers when the app cannot name the active chart', async () => {
    const make = tab(twoCharts, { ...SIDE_BY_SIDE, withoutApi: true });

    const error = await failureOfBoth(readChartBox, [null, SELECTOR], make);

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(error.message).toMatch(/did not say which chart is active/);
    expect(error.message).toMatch(/2 chart containers/);
    expect(error.hint).toMatch(/chartIndex/);
  });

  test('readChartBox still takes the container at a named position on a page whose app has not booted', async () => {
    const make = tab(twoCharts, { ...SIDE_BY_SIDE, withoutApi: true });

    await expect(resultOf(readChartBox, [1, SELECTOR], make)).resolves.toEqual({
      box: RIGHT,
      byPosition: true,
    });
  });

  test.each([
    [
      'the active chart is asked for and throws',
      (win: FakeTvWindow) => {
        apiOf(win).activeChartIndex = () => {
          throw new Error('not ready');
        };
      },
    ],
    [
      'the active chart is asked for and is no number',
      (win: FakeTvWindow) => {
        Reflect.set(apiOf(win), 'activeChartIndex', () => 'first');
      },
    ],
    [
      'the active chart is a negative number',
      (win: FakeTvWindow) => {
        Reflect.set(apiOf(win), 'activeChartIndex', () => -1);
      },
    ],
    [
      'the active chart is a fraction',
      (win: FakeTvWindow) => {
        Reflect.set(apiOf(win), 'activeChartIndex', () => 0.5);
      },
    ],
    [
      'the active chart cannot be asked for',
      (win: FakeTvWindow) => {
        Reflect.deleteProperty(apiOf(win), 'activeChartIndex');
      },
    ],
  ])('readChartBox takes the only container when %s', async (_case, patch) => {
    // One chart, so there is nothing to choose between, with the collection of the app and without.
    for (const overrides of [{}, { withoutChartCollection: true }]) {
      await expect(
        resultOf(readChartBox, [null, SELECTOR], tab(fixture, overrides, patch)),
      ).resolves.toEqual({
        box: { x: 50, y: 40, width: 1180, height: 640 },
        byPosition: true,
      });
    }
  });

  test.each([
    [
      'its definition list is not a list',
      (win: FakeTvWindow) => {
        const collection = apiOf(win)._chartWidgetCollection;
        Reflect.set(collection ?? {}, '_chartWidgetsDefs', 'none');
      },
    ],
    [
      'its definition list is missing',
      (win: FakeTvWindow) => {
        Reflect.deleteProperty(apiOf(win)._chartWidgetCollection ?? {}, '_chartWidgetsDefs');
      },
    ],
    [
      'the definition of the chart is missing',
      (win: FakeTvWindow) => {
        definitionsOf(win).length = 0;
      },
    ],
    [
      'the definition has no container',
      (win: FakeTvWindow) => {
        Reflect.deleteProperty(definitionsOf(win)[0] ?? {}, 'container');
      },
    ],
    [
      'the container throws when it is asked for',
      (win: FakeTvWindow) => {
        Reflect.set(definitionsOf(win)[0]?.container ?? {}, 'value', () => {
          throw new Error('not mounted');
        });
      },
    ],
    [
      'the container is nothing yet',
      (win: FakeTvWindow) => {
        Reflect.set(definitionsOf(win)[0]?.container ?? {}, 'value', () => null);
      },
    ],
    [
      'the container is not an element',
      (win: FakeTvWindow) => {
        Reflect.set(definitionsOf(win)[0]?.container ?? {}, 'value', () => 'div');
      },
    ],
    [
      'the container cannot say where it is',
      (win: FakeTvWindow) => {
        Reflect.set(definitionsOf(win)[0]?.container ?? {}, 'value', () => ({}));
      },
    ],
    [
      'the container throws when asked where it is',
      (win: FakeTvWindow) => {
        Reflect.set(definitionsOf(win)[0]?.container ?? {}, 'value', () => ({
          getBoundingClientRect: () => {
            throw new Error('detached');
          },
        }));
      },
    ],
    [
      'the container reports a box that is not made of numbers',
      (win: FakeTvWindow) => {
        Reflect.set(definitionsOf(win)[0]?.container ?? {}, 'value', () => ({
          getBoundingClientRect: () => ({ x: 1, y: 2, width: '3', height: 4 }),
        }));
      },
    ],
  ])('readChartBox falls back to the position in the page when %s', async (_case, patch) => {
    const result = await resultOf(readChartBox, [null, SELECTOR], tab(fixture, {}, patch));

    expect(result).toEqual({
      box: { x: 50, y: 40, width: 1180, height: 640 },
      byPosition: true,
    });
  });
});

describe('readChartBox, when there is nothing to capture', () => {
  test('readChartBox fails NOT_AVAILABLE on a page without a chart container', async () => {
    const error = await failureOfBoth(
      readChartBox,
      [null, SELECTOR],
      tab(fixture, { screen: { charts: [] } }),
    );

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(error.message).toBe('The page shows no container for the active chart');
    expect(error.hint).toMatch(/Open a chart in the tab/);
  });

  test('readChartBox fails NOT_AVAILABLE for a chart that has no container in the page', async () => {
    const error = await failureOfBoth(readChartBox, [1, SELECTOR], tab(fixture));

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(error.message).toBe('The page shows no container for chart 1');
  });

  test('readChartBox fails NOT_AVAILABLE on a page that has neither the chart API nor a DOM', async () => {
    const make = tab(fixture, { withoutApi: true }, (win) => {
      Reflect.deleteProperty(win.document, 'querySelectorAll');
    });

    const error = await failureOfBoth(readChartBox, [null, SELECTOR], make);

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(error.message).toBe('The page shows no container for the active chart');
  });

  test('readChartBox fails NOT_AVAILABLE for a container with no size, since the chart is not shown', async () => {
    for (const hidden of [
      { x: 50, y: 40, width: 0, height: 640 },
      { x: 50, y: 40, width: 1180, height: 0 },
      { x: 50, y: 40, width: -5, height: 640 },
    ]) {
      const make = tab(fixture, {}, (win) => {
        inspectFakeWindow(win).state.chartContainers[0]?.place(hidden);
      });

      const error = await failureOfBoth(readChartBox, [null, SELECTOR], make);

      expect(error.code, JSON.stringify(hidden)).toBe('NOT_AVAILABLE');
      expect(error.message).toBe('The container of the active chart has no size');
      expect(error.hint).toMatch(/maximized/);
    }
  });

  test('readChartBox names the chart whose container has no size', async () => {
    const make = tab(twoCharts, SIDE_BY_SIDE, (win) => {
      inspectFakeWindow(win).state.chartContainers[1]?.place({ ...RIGHT, width: 0 });
    });

    const error = await failureOfBoth(readChartBox, [1, SELECTOR], make);

    expect(error.message).toBe('The container of chart 1 has no size');
    // The chart next to it is still there.
    await expect(resultOf(readChartBox, [0, SELECTOR], make)).resolves.toEqual({
      box: LEFT,
      byPosition: false,
    });
  });
});

describe('readChartBox, when the tab is hidden', () => {
  test('readChartBox fails NOT_AVAILABLE while the tab is hidden', async () => {
    const make = tab(fixture, { visibilityState: 'hidden' });

    const error = await failureOfBoth(readChartBox, [null, SELECTOR], make);

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(error.message).toBe('The chart tab is hidden');
    expect(error.hint).toMatch(/front/);
  });

  test('readChartBox says that the tab is hidden before it looks for the chart', async () => {
    // Neither a page without a container nor a container without a size is why nothing can be
    // captured, if the tab is hidden.
    const noContainer = tab(fixture, { visibilityState: 'hidden', screen: { charts: [] } });
    const noSize = tab(fixture, { visibilityState: 'hidden' }, (win) => {
      inspectFakeWindow(win).state.chartContainers[0]?.place({ x: 0, y: 0, width: 0, height: 0 });
    });

    for (const make of [noContainer, noSize]) {
      const error = await failureOfBoth(readChartBox, [null, SELECTOR], make);

      expect(error.message).toBe('The chart tab is hidden');
    }
  });

  test('readChartBox goes on when the tab is shown', async () => {
    await expect(
      resultOf(readChartBox, [null, SELECTOR], tab(fixture, { visibilityState: 'visible' })),
    ).resolves.toMatchObject({ byPosition: false });
  });

  test('readChartBox reads whether the tab is shown every time', async () => {
    const win = createFakeTvWindow(fixture);
    const bridge = bridgeTo(win);
    await expect(bridge.evaluate(readChartBox, [null, SELECTOR])).resolves.toMatchObject({
      byPosition: false,
    });

    inspectFakeWindow(win).state.visibilityState = 'hidden';

    await expect(bridge.evaluate(readChartBox, [null, SELECTOR])).rejects.toMatchObject({
      code: 'NOT_AVAILABLE',
    });
  });

  test.each([
    [
      'says nothing',
      (win: FakeTvWindow) => Reflect.deleteProperty(win.document, 'visibilityState'),
    ],
    [
      'throws when it is read',
      (win: FakeTvWindow) => {
        Reflect.defineProperty(win.document, 'visibilityState', {
          get: () => {
            throw new Error('no document yet');
          },
        });
      },
    ],
    [
      'says something that is neither state',
      (win: FakeTvWindow) => {
        Reflect.defineProperty(win.document, 'visibilityState', { get: () => 'prerender' });
      },
    ],
  ])('readChartBox goes on when the tab %s', async (_case, patch) => {
    await expect(
      resultOf(readChartBox, [null, SELECTOR], tab(fixture, {}, patch)),
    ).resolves.toMatchObject({ byPosition: false });
  });
});

test('readChartBox changes nothing on the page', async () => {
  const win = createFakeTvWindow(twoCharts, SIDE_BY_SIDE);

  await bridgeTo(win).evaluate(readChartBox, [1, SELECTOR]);
  await bridgeTo(win).evaluate(readChartBox, [null, SELECTOR]);

  expect(inspectFakeWindow(win).calls).toEqual([]);
  expect(inspectFakeWindow(win).state.activeChartIndex).toBe(0);
});

describe('readStripBox', () => {
  const STRIP = SELECTORS.windowChrome.strip;
  const chrome = () =>
    createFakeWindowChrome({ tabs: [{ id: 'TAB1', title: ['AAPL', 'Layout'] }], active: 'TAB1' });
  // A window chrome whose strip is `strip`, or that has none.
  const pageWith =
    (strip: ReturnType<typeof fakeElement> | null): Make =>
    () =>
      createFakeDomWindow(strip === null ? [] : [strip], {
        viewport: { width: 1280, height: 800 },
      });

  test('returns the box of the tab strip at the top of the window chrome, which spans the window', async () => {
    expect(await resultOf(readStripBox, [STRIP], () => chrome().window)).toEqual({
      box: { x: 0, y: 0, width: 1280, height: STRIP_HEIGHT },
    });
  });

  test('fails NOT_AVAILABLE on a window chrome without a strip, or with one of no size', async () => {
    const pages = [
      pageWith(null),
      pageWith(
        fakeElement({
          tag: 'header',
          matches: [STRIP],
          rect: { x: 0, y: 0, width: 1280, height: 0 },
        }),
      ),
      () => ({ document: { visibilityState: 'visible' } }),
    ];
    for (const make of pages) {
      const error = await failureOfBoth(readStripBox, [STRIP], make);

      expect(error.toPayload()).toEqual({
        code: 'NOT_AVAILABLE',
        message: 'The window chrome shows no tab strip to capture',
        hint: 'Check app_health: the window of TradingView may still be loading.',
      });
    }
  });

  test('reads the DOM only, and nothing of Node, in the window chrome', async () => {
    const page = chrome();

    await bridgeTo(page.window).evaluate(readStripBox, [STRIP]);
    readStripBox(page.window as TvWindow, STRIP);

    expect(page.nodeAccess).toEqual([]);
  });
});
