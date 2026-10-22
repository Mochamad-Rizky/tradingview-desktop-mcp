import type { CdpSession } from '../../../../src/core/cdp/types.js';
import {
  createPageBridge,
  type PageBridge,
  type PageErrorSentinel,
} from '../../../../src/core/tv/page-bridge.js';
import type { TvWindow } from '../../../../src/core/tv/tv-window.js';
import { createPageLib } from '../../../../src/core/tv/page-lib.js';
import { SELECTORS, UNSAFE_SELECTORS } from '../../../../src/core/tv/selectors.js';
import {
  PANEL_CONTROLS,
  readFullscreen,
  readPanelControls,
  readPineEditorShown,
  setFullscreen,
} from '../../../../src/tools/ui/page.js';
import type { JsonValue } from '../../../../src/utils/json.js';
import { failureOf } from '../../../helpers/failure-of.js';
import { createPageRuntime } from '../../../helpers/fake-cdp/runtime.js';
import { createFakeDomWindow, fakeElement } from '../../../helpers/fake-tv/dom.js';
import { loadTvFixture, type TvStateFixture } from '../../../helpers/fake-tv/fixture.js';
import {
  createFakeRightToolbar,
  type FakeRightToolbarOptions,
} from '../../../helpers/fake-tv/right-toolbar.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTvOverrides,
  type FakeTvWindow,
} from '../../../helpers/fake-tv/window.js';

// The page functions of the panel and fullscreen tools. Each runs the way the server runs it, as
// source text through the real page bridge, and directly, on a second window made the same way:
// the two answers must agree.

const fixture = loadTvFixture();
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
  return createPageBridge(session, { timeoutMs: 1000 });
}

// A page function run through the bridge and directly, on two windows `make` makes alike; the
// answers must agree. Answers the one of the bridge, typed as the function types it.
async function bothWays<A extends JsonValue[], R>(
  fn: (win: TvWindow, ...args: A) => R,
  args: A,
  make: () => object,
): Promise<Exclude<R, PageErrorSentinel>> {
  const viaPage: unknown = await bridgeTo(make()).evaluate(fn as never, args as never);
  expect(fn(make() as TvWindow, ...args)).toEqual(viaPage);
  return viaPage as Exclude<R, PageErrorSentinel>;
}

describe('PANEL_CONTROLS', () => {
  test('are the buttons of the right toolbar and the tabs of the object tree panel of the notes', () => {
    // Written out by hand from section 6.1 of the notes of Plan 3.
    expect(PANEL_CONTROLS).toEqual({
      buttons: {
        watchlist: '[data-name="base"]',
        alerts: '[data-name="alerts"]',
        object_tree: '[data-name="object_tree"]',
      },
      tabs: {
        object_tree:
          '[data-qa-id="union-object-tree-widget-switcher"] button#object_tree[role="tab"]',
        data_window:
          '[data-qa-id="union-object-tree-widget-switcher"] button#data-window[role="tab"]',
      },
    });
    const texts = JSON.stringify(PANEL_CONTROLS);
    for (const unsafe of UNSAFE_SELECTORS) {
      expect(texts).not.toContain(unsafe);
    }
  });
});

describe('readPanelControls', () => {
  const toolbarPage =
    (options: FakeRightToolbarOptions = {}) =>
    () =>
      createFakeDomWindow([createFakeRightToolbar(options).element]);

  test('reads the buttons of a collapsed panel, and the tabs it remembers', async () => {
    const controls = await bothWays(readPanelControls, [PANEL_CONTROLS], toolbarPage());

    const button = { found: true, shown: true, pressed: false };
    expect(controls).toEqual({
      buttons: { watchlist: button, alerts: button, object_tree: button },
      tabs: {
        object_tree: { shown: false, selected: true },
        data_window: { shown: false, selected: false },
      },
    });
  });

  test('reads the panel of the object tree that shows the data window', async () => {
    const controls = await bothWays(
      readPanelControls,
      [PANEL_CONTROLS],
      toolbarPage({ shown: 'object_tree', dataWindow: true }),
    );

    expect(controls).toMatchObject({
      buttons: { object_tree: { pressed: true }, watchlist: { pressed: false } },
      tabs: {
        object_tree: { shown: true, selected: false },
        data_window: { shown: true, selected: true },
      },
    });
  });

  test('tells a missing button, one that does not say whether it is pressed, and a hidden one', async () => {
    const missing = await bothWays(
      readPanelControls,
      [PANEL_CONTROLS],
      toolbarPage({ without: ['alerts'], unpressable: ['watchlist'] }),
    );
    const hidden = await bothWays(
      readPanelControls,
      [PANEL_CONTROLS],
      toolbarPage({ hidden: true, withoutTabs: true }),
    );

    expect(missing.buttons).toMatchObject({
      alerts: { found: false, shown: false, pressed: null },
      watchlist: { found: true, shown: true, pressed: null },
    });
    expect(hidden.buttons.watchlist).toEqual({ found: true, shown: false, pressed: false });
    expect(hidden.tabs).toEqual({
      object_tree: { shown: false, selected: false },
      data_window: { shown: false, selected: false },
    });
  });

  test('says NOT_AVAILABLE on a page without a DOM', async () => {
    const win = createFakeTvWindow(fixture);

    const error = await failureOf(bridgeTo(win).evaluate(readPanelControls, [PANEL_CONTROLS]));

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(readPanelControls(createFakeTvWindow(fixture), PANEL_CONTROLS)).toEqual({
      __tvmcpError: error.toPayload(),
    });
  });
});

describe('setFullscreen and readFullscreen', () => {
  const tab =
    (overrides: FakeTvOverrides = {}, change: (win: FakeTvWindow) => void = () => undefined) =>
    () => {
      const win = createFakeTvWindow(fixture, overrides);
      change(win);
      return win;
    };

  test('setFullscreen enters and leaves the mode, and calls nothing when it already is as asked', async () => {
    const off = createFakeTvWindow(fixture);
    const on = createFakeTvWindow(fixture, { fullscreen: { on: true } });

    expect(await bridgeTo(off).evaluate(setFullscreen, [true])).toEqual({ changed: true });
    expect(await bridgeTo(off).evaluate(setFullscreen, [true])).toEqual({ changed: false });
    expect(setFullscreen(on, false)).toEqual({ changed: true });
    expect(setFullscreen(on, false)).toEqual({ changed: false });

    expect(inspectFakeWindow(off).callsTo('TradingViewApi.startFullscreen')).toEqual([[]]);
    expect(inspectFakeWindow(on).callsTo('TradingViewApi.exitFullscreen')).toEqual([[]]);
    expect([
      inspectFakeWindow(off).state.fullscreen.on,
      inspectFakeWindow(on).state.fullscreen.on,
    ]).toEqual([true, false]);
  });

  test('setFullscreen asks for the mode when the page cannot say which one it is in', async () => {
    const make = tab({ fullscreen: { unreadable: true } });

    expect(await bothWays(setFullscreen, [true], make)).toEqual({ changed: true });
  });

  test('setFullscreen says CAPABILITY_UNAVAILABLE without the call, and NOT_AVAILABLE when it throws', async () => {
    const withoutCalls = tab({ fullscreen: { withoutCalls: true } });
    const withoutApi = tab({ withoutApi: true });
    const throwing = tab({}, (win) => {
      if (win.TradingViewApi !== undefined) {
        win.TradingViewApi.startFullscreen = () => {
          throw new Error('No chart to fill the tab with');
        };
      }
    });

    for (const make of [withoutCalls, withoutApi]) {
      const error = await failureOf(bridgeTo(make()).evaluate(setFullscreen, [true]));
      expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
      expect(setFullscreen(make(), true)).toEqual({ __tvmcpError: error.toPayload() });
    }
    const error = await failureOf(bridgeTo(throwing()).evaluate(setFullscreen, [true]));
    expect(error.toPayload()).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: 'TradingView did not enter its fullscreen mode: No chart to fill the tab with',
    });
    expect(setFullscreen(throwing(), true)).toEqual({ __tvmcpError: error.toPayload() });
  });

  test('setFullscreen names the call it lacks or that refused when leaving the mode', async () => {
    const withoutCalls = tab({ fullscreen: { on: true, withoutCalls: true } });
    const refusing = tab({ fullscreen: { on: true } }, (win) => {
      if (win.TradingViewApi !== undefined) {
        win.TradingViewApi.exitFullscreen = () => {
          // A page can throw anything, not only an error.
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'refused';
        };
      }
    });

    const missing = await failureOf(bridgeTo(withoutCalls()).evaluate(setFullscreen, [false]));
    const refused = await failureOf(bridgeTo(refusing()).evaluate(setFullscreen, [false]));

    expect(missing.message).toBe(
      'This page has no TradingViewApi.exitFullscreen to leave the fullscreen mode of TradingView with',
    );
    expect(refused.message).toBe('TradingView did not leave its fullscreen mode: refused');
    expect(setFullscreen(withoutCalls(), false)).toEqual({ __tvmcpError: missing.toPayload() });
    expect(setFullscreen(refusing(), false)).toEqual({ __tvmcpError: refused.toPayload() });
  });

  test('setFullscreen asks for the mode when reading it throws', async () => {
    const make = tab({}, (win) => {
      const collection = win.TradingViewApi?._chartWidgetCollection;
      if (collection !== undefined) {
        collection.fullscreen = () => {
          throw new Error('No charts yet');
        };
      }
    });
    const win = make();

    expect(await bothWays(setFullscreen, [true], make)).toEqual({ changed: true });
    expect(setFullscreen(win, true)).toEqual({ changed: true });
    expect(inspectFakeWindow(win).callsTo('TradingViewApi.startFullscreen')).toEqual([[]]);
  });

  test('readFullscreen reads the mode, and null when the page cannot say', async () => {
    const throwingCollection = tab({}, (win) => {
      const collection = win.TradingViewApi?._chartWidgetCollection;
      if (collection !== undefined) {
        collection.fullscreen = () => {
          throw new Error('No charts yet');
        };
      }
    });
    const notBoolean = tab({}, (win) => {
      const collection = win.TradingViewApi?._chartWidgetCollection;
      if (collection !== undefined) {
        collection.fullscreen = () => ({ value: () => 'on' as unknown as boolean });
      }
    });

    expect(await bothWays(readFullscreen, [], tab({ fullscreen: { on: true } }))).toEqual({
      on: true,
    });
    expect(await bothWays(readFullscreen, [], tab())).toEqual({ on: false });
    for (const make of [
      tab({ fullscreen: { unreadable: true } }),
      tab({ withoutApi: true }),
      throwingCollection,
      notBoolean,
    ]) {
      expect(await bothWays(readFullscreen, [], make)).toEqual({ on: null });
    }
  });
});

describe('readPineEditorShown', () => {
  const PINE_BUTTON = SELECTORS.buttons.pineEditor;
  // The shared fake of a chart whose Pine Editor is `open` (and opens) at a placement, with the Pine
  // Editor button in its DOM when `pressed` is given (null: a button without aria-pressed).
  const tab =
    (
      open: 'dialog' | 'bottom' | null,
      pressed?: string | null,
      change: (win: FakeTvWindow) => void = () => undefined,
    ) =>
    () => {
      const from: TvStateFixture = {
        ...fixture,
        pineEditor: { ...fixture.pineEditor, open, opensAt: open ?? 'dialog' },
      };
      const win = createFakeTvWindow(from);
      if (pressed !== undefined) {
        const button = fakeElement({
          tag: 'button',
          matches: [PINE_BUTTON],
          attributes: pressed === null ? {} : { 'aria-pressed': pressed },
        });
        Object.assign(win, { document: createFakeDomWindow([button]).document });
      }
      change(win);
      return win;
    };

  async function shownOf(make: () => object) {
    const viaPage = await bridgeTo(make()).evaluateWithLib(readPineEditorShown, [PINE_BUTTON]);
    const other = make() as TvWindow;
    expect(readPineEditorShown(other, createPageLib(other), PINE_BUTTON)).toEqual(viaPage);
    return viaPage;
  }

  test('takes the word of the Pine Editor button when it says', async () => {
    expect(await shownOf(tab(null, 'true'))).toEqual({ shown: true, placement: null });
    expect(await shownOf(tab('dialog', 'false'))).toEqual({ shown: false, placement: 'dialog' });
  });

  test('where the button does not say, counts a registered side panel, and an editor at the bottom while the bar shows it', async () => {
    const hiddenAtBottom = tab('bottom', null, (win) => {
      win.TradingView?.bottomWidgetBar?.close();
    });

    expect(await shownOf(tab('dialog'))).toEqual({ shown: true, placement: 'dialog' });
    expect(await shownOf(tab('bottom', null))).toEqual({ shown: true, placement: 'bottom' });
    expect(await shownOf(hiddenAtBottom)).toEqual({ shown: false, placement: 'bottom' });
    expect(await shownOf(tab(null))).toEqual({ shown: false, placement: null });
  });

  test('says it cannot tell whether an editor at the bottom is shown when the bar does not say', async () => {
    const barWithout = (visible?: () => unknown) =>
      tab('bottom', undefined, (win) => {
        const bar = win.TradingView?.bottomWidgetBar as { isVisible?: unknown } | undefined;
        if (bar !== undefined) {
          if (visible === undefined) {
            delete bar.isVisible;
          } else {
            bar.isVisible = visible;
          }
        }
      });

    expect(await shownOf(barWithout())).toEqual({ shown: null, placement: 'bottom' });
    expect(
      await shownOf(
        barWithout(() => {
          throw new Error('No bar yet');
        }),
      ),
    ).toEqual({ shown: null, placement: 'bottom' });
    expect(await shownOf(barWithout(() => ({ value: () => 'yes' })))).toEqual({
      shown: null,
      placement: 'bottom',
    });
  });

  test('takes a registry lookup that throws as no editor', async () => {
    const throwingRegistry = () =>
      createFakeTvWindow(fixture, {
        webpackModules: {
          1: {
            getOpenPineEditor: () => {
              throw new Error('No registry yet');
            },
          },
        },
      });

    expect(await shownOf(throwingRegistry)).toEqual({ shown: false, placement: null });
  });

  test('says CAPABILITY_UNAVAILABLE with neither a button that says nor a registry, and takes the button without one', async () => {
    const bare = () => createFakeTvWindow(fixture, { withoutWebpackRuntime: true });
    const pressedWithoutRegistry = () => {
      const win = bare();
      const button = fakeElement({
        tag: 'button',
        matches: [PINE_BUTTON],
        attributes: { 'aria-pressed': 'true' },
      });
      Object.assign(win, { document: createFakeDomWindow([button]).document });
      return win;
    };

    const error = await failureOf(
      bridgeTo(bare()).evaluateWithLib(readPineEditorShown, [PINE_BUTTON]),
    );
    const other = bare() as TvWindow;

    expect(error.toPayload()).toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      message: 'This page has no registry of open Pine editors',
    });
    expect(readPineEditorShown(other, createPageLib(other), PINE_BUTTON)).toEqual({
      __tvmcpError: error.toPayload(),
    });
    expect(await shownOf(pressedWithoutRegistry)).toEqual({ shown: true, placement: null });
  });
});
