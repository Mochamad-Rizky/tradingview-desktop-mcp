import type { CdpSession } from '../../../../src/core/cdp/types.js';
import { createPageBridge, type PageBridge } from '../../../../src/core/tv/page-bridge.js';
import { SELECTORS, UNSAFE_SELECTORS } from '../../../../src/core/tv/selectors.js';
import type { TvWindow } from '../../../../src/core/tv/tv-window.js';
import {
  readAppInfo,
  readUiState,
  reloadTab,
  UI_STATE_SELECTORS,
} from '../../../../src/tools/app/page.js';
import { failureOf } from '../../../helpers/failure-of.js';
import { createPageRuntime } from '../../../helpers/fake-cdp/runtime.js';
import {
  createFakeDomWindow,
  fakeElement,
  type FakeDomOptions,
  type FakeElement,
  type FakeElementOptions,
  type FakeRect,
} from '../../../helpers/fake-tv/dom.js';
import { loadTvFixture } from '../../../helpers/fake-tv/fixture.js';
import { createFakeTvWindow, inspectFakeWindow } from '../../../helpers/fake-tv/window.js';

// The page functions of the app tools. Each is run the way the server runs it, as source text in a
// page whose window is the one under test, through the real page bridge: a page function that leans
// on anything of its module would pass a direct call and fail there. It is also called directly,
// which is what the coverage of the module measures, and the two answers must agree.

const fixture = loadTvFixture();
const OVERLAP_ROOT = SELECTORS.regions.overlapManagerRoot;

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

function box(x: number, y: number, width: number, height: number): FakeRect {
  return { x, y, width, height };
}

const NO_BOX = box(0, 0, 0, 0);

describe('readAppInfo', () => {
  // A page whose TradingViewApi and BUILD_TIME are whatever the test needs, to show how the page
  // function copes with builds that differ from the one that was observed.
  function pageWith(api: unknown, buildTime?: unknown): TvWindow {
    return {
      TradingViewApi: api,
      BUILD_TIME: buildTime,
      location: { href: 'https://www.tradingview.com/chart/FIXTURE1/' },
    } as unknown as TvWindow;
  }

  async function infoOf(win: TvWindow) {
    const viaPage = await bridgeTo(win).evaluate(readAppInfo, []);
    expect(readAppInfo(win)).toEqual(viaPage);
    return viaPage;
  }

  test('readAppInfo returns BUILD_TIME and the connection flag', async () => {
    const win = createFakeTvWindow(fixture);

    await expect(infoOf(win)).resolves.toEqual({
      buildTime: fixture.buildTime,
      connected: true,
      layoutType: fixture.layout.type,
      url: 'https://www.tradingview.com/chart/FIXTURE1/',
    });
  });

  test('readAppInfo reports an app that lost its connection', async () => {
    const win = createFakeTvWindow(fixture);
    inspectFakeWindow(win).state.connected = false;

    await expect(infoOf(win)).resolves.toMatchObject({
      buildTime: fixture.buildTime,
      connected: false,
    });
  });

  test('readAppInfo reads the connection on every call', async () => {
    const win = createFakeTvWindow(fixture);
    await expect(infoOf(win)).resolves.toMatchObject({ connected: true });

    inspectFakeWindow(win).state.connected = false;

    await expect(infoOf(win)).resolves.toMatchObject({ connected: false });
  });

  test('readAppInfo reports a page whose app has not booted, with what it already knows', async () => {
    const win = createFakeTvWindow(fixture, { withoutApi: true });

    await expect(infoOf(win)).resolves.toEqual({
      buildTime: fixture.buildTime,
      connected: false,
      layoutType: null,
      url: 'https://www.tradingview.com/chart/FIXTURE1/',
    });
  });

  test.each([
    [
      'throws',
      () => ({
        isConnected: () => {
          throw new Error('not ready');
        },
      }),
    ],
    ['is missing', () => ({})],
    ['answers undefined', () => ({ isConnected: () => undefined })],
    ['answers a string', () => ({ isConnected: () => 'true' })],
    ['answers a number', () => ({ isConnected: () => 1 })],
  ])('readAppInfo does not count the app as connected when isConnected %s', async (_case, make) => {
    const win = pageWith({ layout: () => 's', ...make() }, 'build');

    await expect(infoOf(win)).resolves.toMatchObject({ connected: false, layoutType: 's' });
  });

  test.each([
    [
      'throws',
      () => ({
        layout: () => {
          throw new Error('not ready');
        },
      }),
    ],
    ['is missing', () => ({})],
    ['answers undefined', () => ({ layout: () => undefined })],
    ['answers a number', () => ({ layout: () => 1 })],
  ])('readAppInfo reports no layout type when layout %s', async (_case, make) => {
    const win = pageWith({ isConnected: () => true, ...make() }, 'build');

    await expect(infoOf(win)).resolves.toMatchObject({ connected: true, layoutType: null });
  });

  test.each([
    ['is missing', undefined],
    ['is null', null],
    ['is a number', 20261016],
    ['is an object', { at: '2026-10-16' }],
  ])('readAppInfo reports no build time when BUILD_TIME %s', async (_case, buildTime) => {
    const win = pageWith({ isConnected: () => true, layout: () => 's' }, buildTime);

    await expect(infoOf(win)).resolves.toMatchObject({ buildTime: null });
  });
});

describe('reloadTab', () => {
  test('reloadTab asks the desktop bridge to reload the tab, and does nothing else', async () => {
    const win = createFakeTvWindow(fixture);

    const result = await bridgeTo(win).evaluate(reloadTab, []);

    expect(result).toEqual({ requested: true });
    // Every mutating call of the page is recorded, so this is all that happened.
    expect(inspectFakeWindow(win).calls).toEqual([{ name: 'TVD.reloadTab', args: [] }]);
  });

  test('reloadTab leaves the rest of the desktop bridge alone, credentials above all', async () => {
    const members = {
      reloadTab: vi.fn<() => void>(),
      getCredentials: vi.fn<() => unknown>(),
      setCredentials: vi.fn<() => unknown>(),
      insertCredentialsText: vi.fn<() => unknown>(),
      signIn: vi.fn<() => unknown>(),
      openNewWindow: vi.fn<() => unknown>(),
    };
    const read: string[] = [];
    const tvd = new Proxy(members, {
      get(target, name, receiver) {
        read.push(String(name));
        return Reflect.get(target, name, receiver) as unknown;
      },
    });

    await bridgeTo({ TVD: tvd }).evaluate(reloadTab, []);

    expect(members.reloadTab).toHaveBeenCalledTimes(1);
    // Not called, and not even looked at: some of its members hold the credentials of the user.
    expect(new Set(read)).toEqual(new Set(['reloadTab']));
    for (const [name, member] of Object.entries(members)) {
      if (name !== 'reloadTab') {
        expect(member, name).not.toHaveBeenCalled();
      }
    }
  });

  test('reloadTab, called directly, reloads once or says that it cannot', () => {
    const win = createFakeTvWindow(fixture);

    expect(reloadTab(win)).toEqual({ requested: true });
    expect(inspectFakeWindow(win).callsTo('TVD.reloadTab')).toEqual([[]]);
    expect(reloadTab({} as TvWindow)).toMatchObject({
      __tvmcpError: { code: 'CAPABILITY_UNAVAILABLE' },
    });
  });

  test.each([
    ['has no desktop bridge', {}],
    ['has a desktop bridge without reloadTab', { TVD: { signIn: () => undefined } }],
    ['has a reloadTab that is not a function', { TVD: { reloadTab: 'yes' } }],
    ['has a null desktop bridge', { TVD: null }],
  ])('reloadTab is unavailable on a page that %s', async (_case, win) => {
    const error = await failureOf(bridgeTo(win).evaluate(reloadTab, []));

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(error.hint).toBeTruthy();
  });
});

describe('readUiState', () => {
  // The names of the things the page function reads: the attributes that name an overlay.
  const LABELS = ['data-name', 'aria-label', 'role'];

  // An element that carries some of the attributes that name an overlay. The fake finds an
  // element by the selectors it says it matches, so this one matches the selector of each of the
  // attributes it has, the way an attribute selector would.
  function named(
    attributes: Record<string, string>,
    options: FakeElementOptions = {},
  ): FakeElement {
    const matches = Object.keys(attributes)
      .filter((name) => LABELS.includes(name))
      .map((name) => `[${name}]`);
    return fakeElement({ attributes, matches, ...options });
  }

  // The portal that dialogs and menus open in, holding `layers`.
  function overlapRoot(layers: FakeElement[]): FakeElement {
    return fakeElement({ matches: [OVERLAP_ROOT], rect: NO_BOX, children: layers });
  }

  const widgetBar = (options: FakeElementOptions = {}) =>
    fakeElement({ matches: [SELECTORS.widgets.widgetBar], ...options });
  const widget = (selector: string, options: FakeElementOptions = {}) =>
    fakeElement({ matches: [selector], ...options });
  const bottomArea = (options: FakeElementOptions = {}) =>
    fakeElement({ matches: [SELECTORS.regions.bottomArea], ...options });
  const toggle = (selector: string, attributes: Record<string, string>) =>
    fakeElement({ tag: 'button', matches: [selector], attributes });

  async function stateOf(win: TvWindow) {
    const viaPage = await bridgeTo(win).evaluate(readUiState, [UI_STATE_SELECTORS]);
    expect(readUiState(win, UI_STATE_SELECTORS)).toEqual(viaPage);
    return viaPage;
  }
  const stateOfPage = (elements: FakeElement[], options: FakeDomOptions = {}) =>
    stateOf(createFakeDomWindow(elements, options));

  test('readUiState reports open dialogs from #overlap-manager-root', async () => {
    const state = await stateOfPage([
      overlapRoot([
        named({ 'data-name': 'indicators-dialog', role: 'dialog' }),
        named({ 'aria-label': 'Create alert' }),
        named({ role: 'dialog' }),
      ]),
    ]);

    expect(state.dialogs).toEqual(['indicators-dialog', 'Create alert', 'dialog']);
  });

  test('readUiState reports a page where nothing is open', async () => {
    const state = await stateOfPage([
      fakeElement({ matches: [SELECTORS.regions.chartContainer] }),
      overlapRoot([]),
    ]);

    expect(state).toEqual({
      rightPanel: { open: false, activeWidget: null },
      bottomPanelOpen: false,
      dialogs: [],
      fullscreen: false,
      replayToolbarVisible: false,
      pineEditorOpen: false,
    });
  });

  test('readUiState reports no dialogs when the page has no portal for them', async () => {
    const state = await stateOfPage([fakeElement({ matches: [SELECTORS.regions.chartContainer] })]);

    expect(state.dialogs).toEqual([]);
  });

  test('readUiState names a dialog by data-name, then aria-label, then role', async () => {
    const state = await stateOfPage([
      overlapRoot([
        named({ 'data-name': 'first', 'aria-label': 'Second', role: 'dialog' }),
        named({ 'aria-label': 'Second', role: 'dialog' }),
        named({ role: 'dialog' }),
        // An empty attribute names nothing, so the next one is used.
        named({ 'data-name': '  ', 'aria-label': 'Third', role: 'dialog' }),
        named({ 'data-name': '', 'aria-label': '', role: 'alertdialog' }),
      ]),
    ]);

    expect(state.dialogs).toEqual(['first', 'Second', 'dialog', 'Third', 'alertdialog']);
  });

  test('readUiState names a dialog after the first named element inside, when the wrapper has no name', async () => {
    const state = await stateOfPage([
      overlapRoot([
        fakeElement({
          children: [
            fakeElement({
              children: [
                named({ 'aria-label': 'Symbol Search' }, { children: [named({ role: 'button' })] }),
              ],
            }),
          ],
        }),
        // The wrapper itself is named, so what is inside it does not matter.
        named({ 'data-name': 'go-to-date-dialog' }, { children: [named({ 'aria-label': 'Go' })] }),
      ]),
    ]);

    expect(state.dialogs).toEqual(['Symbol Search', 'go-to-date-dialog']);
  });

  test('readUiState lists menus and popups with the dialogs, because they cover the chart as well', async () => {
    const state = await stateOfPage([
      overlapRoot([named({ role: 'dialog' }), named({ role: 'menu' }), named({ role: 'listbox' })]),
    ]);

    expect(state.dialogs).toEqual(['dialog', 'menu', 'listbox']);
  });

  test('readUiState lists a dialog that nothing names as unnamed', async () => {
    const state = await stateOfPage([
      overlapRoot([
        fakeElement({ children: [fakeElement(), fakeElement()] }),
        // The attribute that would name it is there and empty.
        fakeElement({ children: [named({ 'aria-label': ' ' })] }),
      ]),
    ]);

    expect(state.dialogs).toEqual(['unnamed', 'unnamed']);
  });

  test('readUiState leaves out what is in the portal but not open', async () => {
    const state = await stateOfPage([
      overlapRoot([
        // A wrapper that holds nothing.
        fakeElement(),
        // A dialog that is not shown.
        named({ 'data-name': 'display-none' }, { display: 'none' }),
        named({ 'data-name': 'visibility-hidden' }, { visibility: 'hidden' }),
        named({ 'data-name': 'no-box' }, { rect: NO_BOX }),
        named({ 'data-name': 'detached' }, { connected: false }),
        // A wrapper with something in it that is not shown.
        fakeElement({ children: [named({ 'aria-label': 'Hidden inside' }, { display: 'none' })] }),
        named({ 'data-name': 'open-one' }),
      ]),
    ]);

    expect(state.dialogs).toEqual(['open-one']);
  });

  test('readUiState keeps the labels short and on one line', async () => {
    const state = await stateOfPage([
      overlapRoot([
        named({ 'aria-label': '  Create\n   alert\ton   BTCUSD  ' }),
        named({ 'aria-label': 'x'.repeat(200) }),
        // The cut falls on the space, which must not stay at the end.
        named({ 'aria-label': `${'x'.repeat(59)} tail` }),
      ]),
    ]);

    expect(state.dialogs).toEqual(['Create alert on BTCUSD', 'x'.repeat(60), 'x'.repeat(59)]);
  });

  test('readUiState names dialogs from three attributes and never reads text', async () => {
    const attributesRead: string[] = [];
    const textReads: string[] = [];
    // The page function must not read what a dialog says: it can hold the name of a layout or of
    // a script. Reading any of these members, or any attribute but the three, shows here.
    function guarded(element: FakeElement): FakeElement {
      const original = element.getAttribute.bind(element);
      element.getAttribute = (name: string) => {
        attributesRead.push(name);
        return original(name);
      };
      for (const member of [
        'textContent',
        'innerText',
        'innerHTML',
        'outerHTML',
        'title',
        'value',
      ]) {
        Object.defineProperty(element, member, {
          get() {
            textReads.push(member);
            return 'a private layout name';
          },
        });
      }
      for (const child of element.children) {
        guarded(child);
      }
      return element;
    }
    const personal = {
      title: 'My private layout',
      'aria-description': 'Rename My private layout',
      'data-title': 'Secret script',
    };
    const state = await stateOfPage([
      overlapRoot([
        guarded(
          named({ 'data-name': 'rename-dialog', ...personal }, { children: [named(personal)] }),
        ),
        // Nothing here names it, although everything about it is personal.
        guarded(
          fakeElement({ attributes: personal, children: [fakeElement({ attributes: personal })] }),
        ),
      ]),
    ]);

    expect(state.dialogs).toEqual(['rename-dialog', 'unnamed']);
    expect(textReads).toEqual([]);
    expect(new Set(attributesRead)).toEqual(new Set(LABELS));
    expect(JSON.stringify(state)).not.toMatch(/private|secret/i);
  });

  test.each([
    ['watchlist', SELECTORS.widgets.watchlist],
    ['alerts', SELECTORS.widgets.alerts],
    ['object_tree', SELECTORS.widgets.objectTree],
    ['pine_logs', SELECTORS.widgets.pineLogs],
    ['detail', SELECTORS.widgets.detail],
  ])('readUiState reports the %s widget of the open right panel', async (name, selector) => {
    const state = await stateOfPage([widgetBar({ children: [widget(selector)] })]);

    expect(state.rightPanel).toEqual({ open: true, activeWidget: name });
  });

  test('readUiState reports an open right panel that shows no known widget', async () => {
    const state = await stateOfPage([widgetBar({ children: [fakeElement()] })]);

    expect(state.rightPanel).toEqual({ open: true, activeWidget: null });
  });

  test('readUiState reports the watchlist when the details of a symbol show next to it', async () => {
    const state = await stateOfPage([
      widgetBar({
        children: [widget(SELECTORS.widgets.detail), widget(SELECTORS.widgets.watchlist)],
      }),
    ]);

    expect(state.rightPanel.activeWidget).toBe('watchlist');
  });

  test('readUiState skips a widget that is not shown', async () => {
    const state = await stateOfPage([
      widgetBar({
        children: [
          widget(SELECTORS.widgets.watchlist, { display: 'none' }),
          widget(SELECTORS.widgets.alerts, { rect: NO_BOX }),
          widget(SELECTORS.widgets.objectTree),
        ],
      }),
    ]);

    expect(state.rightPanel).toEqual({ open: true, activeWidget: 'object_tree' });
  });

  test.each([
    ['has no box', { rect: NO_BOX }],
    ['is display: none', { display: 'none' }],
    ['is visibility: hidden', { visibility: 'hidden' }],
    ['is detached', { connected: false }],
  ])('readUiState reports the right panel as closed when its bar %s', async (_case, hide) => {
    // The widget inside is still there, as it can be in a bar that was only collapsed.
    const state = await stateOfPage([
      widgetBar({ ...hide, children: [widget(SELECTORS.widgets.watchlist)] }),
    ]);

    expect(state.rightPanel).toEqual({ open: false, activeWidget: null });
  });

  test('readUiState reports the right panel as closed when the page has no widget bar', async () => {
    const state = await stateOfPage([widget(SELECTORS.widgets.watchlist)]);

    expect(state.rightPanel).toEqual({ open: false, activeWidget: null });
  });

  test('readUiState reports the bottom panel as open while its area is shown', async () => {
    expect((await stateOfPage([bottomArea()])).bottomPanelOpen).toBe(true);
    expect((await stateOfPage([bottomArea({ rect: NO_BOX })])).bottomPanelOpen).toBe(false);
    expect((await stateOfPage([bottomArea({ display: 'none' })])).bottomPanelOpen).toBe(false);
    expect((await stateOfPage([fakeElement()])).bottomPanelOpen).toBe(false);
  });

  test('readUiState judges a page without getComputedStyle by the boxes alone', async () => {
    const without: FakeDomOptions = { without: ['getComputedStyle'] };

    const state = await stateOfPage(
      [bottomArea({ display: 'none' }), widgetBar({ rect: NO_BOX })],
      without,
    );

    expect(state.bottomPanelOpen).toBe(true);
    expect(state.rightPanel.open).toBe(false);
  });

  test.each([
    ['fullscreen', SELECTORS.header.fullscreen],
    ['replayToolbarVisible', SELECTORS.header.replay],
    ['pineEditorOpen', SELECTORS.buttons.pineEditor],
  ] as const)('readUiState reads %s from its button', async (field, selector) => {
    const pressed = await stateOfPage([toggle(selector, { 'aria-pressed': 'true' })]);
    const selected = await stateOfPage([toggle(selector, { 'aria-selected': 'true' })]);
    const released = await stateOfPage([toggle(selector, { 'aria-pressed': 'false' })]);
    const plain = await stateOfPage([toggle(selector, {})]);
    const missing = await stateOfPage([fakeElement()]);

    expect(pressed[field]).toBe(true);
    expect(selected[field]).toBe(true);
    expect(released[field]).toBe(false);
    expect(plain[field]).toBe(false);
    expect(missing[field]).toBe(false);
    // The other two are not touched by this button.
    const others = Object.entries(pressed).filter(([name]) => name !== field);
    expect(others.some(([, value]) => value === true)).toBe(false);
  });

  test('readUiState reads a button that is on even while the page hides it', async () => {
    // Fullscreen mode hides the toolbars, and their buttons still tell what is on.
    const state = await stateOfPage([
      fakeElement({
        tag: 'button',
        matches: [SELECTORS.header.fullscreen],
        attributes: { 'aria-pressed': 'true' },
        display: 'none',
      }),
    ]);

    expect(state.fullscreen).toBe(true);
  });

  test('readUiState reports fullscreen when an element of the page is in fullscreen', async () => {
    const chart = fakeElement({ matches: [SELECTORS.regions.chartContainer] });

    const state = await stateOfPage([chart], { fullscreen: chart });

    expect(state.fullscreen).toBe(true);
  });

  test('readUiState copes with a page that cannot say which element is in fullscreen', async () => {
    const state = await stateOfPage([fakeElement()], { without: ['fullscreenElement'] });

    expect(state.fullscreen).toBe(false);
  });

  test('readUiState reads the page on every call', async () => {
    const bar = widgetBar({ children: [widget(SELECTORS.widgets.watchlist)] });
    const win = createFakeDomWindow([bar]);
    const first = await stateOf(win);

    bar.place(NO_BOX);

    const second = await stateOf(win);
    expect(first.rightPanel.open).toBe(true);
    expect(second.rightPanel.open).toBe(false);
  });

  test('readUiState reports NOT_AVAILABLE on a page without a DOM', async () => {
    const shared = await failureOf(stateOf(createFakeTvWindow(fixture)));
    const bare = await failureOf(
      stateOf(createFakeDomWindow([fakeElement()], { without: ['querySelector'] })),
    );

    for (const error of [shared, bare]) {
      expect(error.code).toBe('NOT_AVAILABLE');
      expect(error.hint).toContain('TradingView');
    }
    // Called directly, the function returns the sentinel that the bridge turns into that error.
    expect(readUiState(createFakeTvWindow(fixture), UI_STATE_SELECTORS)).toMatchObject({
      __tvmcpError: { code: 'NOT_AVAILABLE' },
    });
  });
});

describe('UI_STATE_SELECTORS', () => {
  test('are the selectors of the notes for the parts the page function reads', () => {
    // Written out by hand from sections 5.1 to 5.4 of the reverse-engineering notes, so that a typo
    // in the constant does not also sit in the assertion.
    expect(UI_STATE_SELECTORS).toEqual({
      widgetBar: '[data-name="widgetbar-wrap"]',
      widgets: {
        watchlist: '[data-test-id-widget-type="watchlist"]',
        alerts: '[data-test-id-widget-type="alerts"]',
        object_tree: '[data-test-id-widget-type="object_tree"]',
        pine_logs: '[data-test-id-widget-type="pine_logs"]',
        detail: '[data-test-id-widget-type="detail"]',
      },
      bottomArea: '#bottom-area',
      overlapRoot: '#overlap-manager-root',
      labelAttributes: ['data-name', 'aria-label', 'role'],
      fullscreenButton: '#header-toolbar-fullscreen',
      replayButton: '#header-toolbar-replay',
      pineEditorButton: '[data-name="pine-dialog-button"]',
    });
  });

  test('list the widgets with the details of a symbol last, behind the watchlist it sits next to', () => {
    expect(Object.keys(UI_STATE_SELECTORS.widgets)).toEqual([
      'watchlist',
      'alerts',
      'object_tree',
      'pine_logs',
      'detail',
    ]);
  });

  test('reach no trading control, and cross the page as JSON', () => {
    const texts = JSON.stringify(UI_STATE_SELECTORS);

    for (const unsafe of UNSAFE_SELECTORS) {
      expect(texts).not.toContain(unsafe);
    }
    expect(JSON.parse(texts)).toEqual(UI_STATE_SELECTORS);
  });
});
