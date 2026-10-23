import { SELECTORS } from '../../../src/core/tv/selectors.js';
import {
  createFakeDomWindow,
  fakeElement,
  type FakeDomWindow,
  type FakeElement,
  type FakeRect,
} from './dom.js';

// The window chrome of TradingView Desktop, the page that holds the tab strip, and the shell that
// answers a click on it (reverse-engineering notes of Plan 3, section 3, and the shell files the
// notes cite). Values are synthetic.
//
// The strip, as the notes record it: header.header holds the traffic lights (div.darwin, 76 px),
// then div.tabs with div.tabs-container, which holds a div.tab[id] for each tab in the order of the
// strip, the active one with the class active, then the button that opens a new tab
// (button.create-new-tab-button, "New tab"), and at the right end the buttons of a new window and
// of the main menu. A tab holds its title (.tab-title, whose pieces are the symbol in span.symbol,
// the last price, the change and the name of the layout in span.layout-name, or, on a New tab page,
// a title of its own and no span.symbol, as seen on the app) and its close button
// (button.tab-close-button, "Close"), which the shell renders the way the app does: not on a pinned
// tab, not on the only tab of the last window, and on a tab that is not active only at the normal
// size. The page is 34 CSS pixels high, at a zoom of 1 (the app keeps its local pages at 1).
//
// The shell, as the notes record it (section 3.1): a left click on a tab, pressed and released on
// it once, makes it the active tab; a left click on its close button closes it, unless its page
// would ask whether to save its layout, which opens the "Close tab?" dialog of the shell instead
// (recorded as closeDialog; nothing closes); a left click on the new-tab button opens a new tab, at
// the end of the strip and in front. A closed tab that was in front hands the front to the tab that
// takes its place in the strip, or to the one before it when it was the last. The shell shows a
// change changeMs after the click that asks for it, as it answers over IPC.
//
// What the tools must never send is recorded as a hazard and does nothing else: a press with a
// clickCount of 2 or more (the app duplicates the tab that was clicked last on one), a middle click
// (its mouseup closes the tab) and a right click (it opens the tab menu of the shell). Every press
// and release is recorded with what it landed on, so a test can tell a click on a title from one on
// a close button.
//
// The page is a DOM page of dom.ts, built again from the state on every change behind a window that
// stays the same object, which the fake debug port runs page functions in. It reports itself visible
// while the window is in view (inView), and hidden while the window is covered by others or
// minimized, as every page of the window then does (seen on the app). The renderer of the window
// chrome has Node integration, so the window also has require and process, which record every use:
// nothing of the server may reach them.

export type FakeTabSize = 'normal' | 'small' | 'xsmall' | 'xxsmall';

// A tab of the strip. title holds the pieces the title shows, in order; a tab on the New tab page
// shows them without a symbol.
export interface FakeChromeTab {
  readonly id: string;
  title: string[];
  pinned: boolean;
  newTabPage: boolean;
}

// The live state of the strip. A test may change it and call render to show the change.
export interface FakeWindowChromeState {
  tabs: FakeChromeTab[];
  active: string | null;
  size: FakeTabSize;
  // Whether this is the last window of the app: its only tab then shows no close button.
  isLastWindow: boolean;
  // Whether the window is in view, neither covered by other windows nor minimized.
  inView: boolean;
}

// What the shell did, in order: made a tab active, closed one, opened the "Close tab?" dialog for
// one instead of closing it, or opened a new one.
export type FakeShellAction =
  | { action: 'switch'; tabId: string }
  | { action: 'close'; tabId: string }
  | { action: 'closeDialog'; tabId: string }
  | { action: 'new'; tabId: string };

// What a press or a release landed on: the title of a tab, its close button, another part of a tab,
// the new-tab button, or anything else of the page.
export type FakeChromePart = 'title' | 'close' | 'tab' | 'new-tab' | 'other';

export interface FakeChromeClick {
  type: 'mousePressed' | 'mouseReleased';
  button: string;
  clickCount: number;
  on: FakeChromePart;
  tabId: string | null;
}

export interface FakeChromeHazard {
  kind: 'double-click' | 'middle-click' | 'right-click';
  tabId: string | null;
}

// How the shell asks about the page of a tab, and tells about its changes. The pages are not part of
// the window chrome: the fake app that holds them answers.
export interface FakeShellHooks {
  // Whether closing the tab makes its page ask whether to save its layout (its beforeunload
  // handler, then TradingViewApi.shouldBeSaved(), notes section 3.4). Default: never.
  asksToSave?: (tab: FakeChromeTab) => boolean;
  // Called once the strip shows a change.
  changed?: (action: FakeShellAction) => void;
}

export interface FakeWindowChromeOptions {
  tabs: { id: string; title: string[]; pinned?: boolean; newTabPage?: boolean }[];
  // The id of the tab in front.
  active: string;
  size?: FakeTabSize;
  isLastWindow?: boolean;
  // Default true.
  inView?: boolean;
  // Lays the close button of each tab over the middle of its title, as a strip squeezed narrow
  // might, so that a click at the center of a title would land on the close button.
  closeButtonOverTitle?: boolean;
  // How long after a click the strip shows what it changed. Default 5 ms; Infinity: never.
  changeMs?: number;
  // The ids the shell gives the tabs it opens, in order; synthetic UUIDs after those.
  newTabIds?: string[];
  hooks?: FakeShellHooks;
}

export interface FakeWindowChrome {
  // The page, for the window factory of the fake debug port.
  readonly window: object;
  readonly state: FakeWindowChromeState;
  readonly actions: FakeShellAction[];
  readonly clicks: FakeChromeClick[];
  readonly hazards: FakeChromeHazard[];
  // Every use of require or process in the page, by name.
  readonly nodeAccess: string[];
  // Takes the parameters of Input.dispatchMouseEvent, in DIPs, which are CSS pixels at the zoom
  // of 1 the page has.
  dispatchMouseEvent(params: unknown): void;
  // Builds the page again from the state, for a test that changed the state.
  render(): void;
}

// The selectors of the strip the page answers, as the notes record its DOM: the server reads the
// strip and aims its clicks with these.
export const CHROME_SELECTORS = {
  tabs: SELECTORS.windowChrome.tabs,
  title: SELECTORS.windowChrome.tabTitle,
  closeButton: SELECTORS.windowChrome.tabCloseButton,
} as const;

// An id in double quotes for an attribute selector, with a double quote, a backslash and the
// control characters escaped, the way CSS reads them.
function quotedId(tabId: string): string {
  let escaped = '';
  for (const character of tabId) {
    const code = character.charCodeAt(0);
    if (character === '"' || character === '\\') {
      escaped += `\\${character}`;
    } else if (code < 0x20 || code === 0x7f) {
      escaped += `\\${code.toString(16)} `;
    } else {
      escaped += character;
    }
  }
  return `"${escaped}"`;
}

// The selector of a part of one tab, as the server builds it from the id of the tab.
export function tabPartSelector(tabId: string, part: string): string {
  return `div.tab[id=${quotedId(tabId)}] ${part}`;
}

const VIEWPORT = { width: 1280, height: 34 };
const TRAFFIC_LIGHTS = 76;
const TAB_WIDTH: Record<FakeTabSize, number> = {
  normal: 200,
  small: 140,
  xsmall: 110,
  xxsmall: 90,
};
const SIZE_CLASS: Record<FakeTabSize, string> = {
  normal: '',
  small: 'small',
  xsmall: 'xsmall',
  xxsmall: 'xxsmall',
};

function box(x: number, y: number, width: number, height: number): FakeRect {
  return { x, y, width, height };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// A synthetic UUID of version 4, made from a counter.
function syntheticUuid(count: number): string {
  const hex = count.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

export function createFakeWindowChrome(options: FakeWindowChromeOptions): FakeWindowChrome {
  const state: FakeWindowChromeState = {
    tabs: options.tabs.map(({ id, title, pinned, newTabPage }) => ({
      id,
      title: [...title],
      pinned: pinned === true,
      newTabPage: newTabPage === true,
    })),
    active: options.active,
    size: options.size ?? 'normal',
    isLastWindow: options.isLastWindow ?? true,
    inView: options.inView ?? true,
  };
  const changeMs = options.changeMs ?? 5;
  const hooks = options.hooks ?? {};
  const newTabIds = [...(options.newTabIds ?? [])];
  let opened = 0;
  const actions: FakeShellAction[] = [];
  const clicks: FakeChromeClick[] = [];
  const hazards: FakeChromeHazard[] = [];
  const nodeAccess: string[] = [];
  let pressed: { on: FakeChromePart; tabId: string | null } | null = null;

  // The rule of the app (asar:app/window/bundle.js@18262).
  const showsCloseButton = (tab: FakeChromeTab): boolean =>
    !tab.pinned &&
    !(state.isLastWindow && state.tabs.length === 1) &&
    (tab.id === state.active || state.size === 'normal');

  const tabElement = (tab: FakeChromeTab, index: number): FakeElement => {
    const width = TAB_WIDTH[state.size];
    const x = TRAFFIC_LIGHTS + index * width;
    const active = tab.id === state.active;
    const title = box(x + 10, 4, width - 40, 26);
    const closeAt =
      options.closeButtonOverTitle === true
        ? box(title.x + title.width / 2 - 10, 7, 20, 20)
        : box(x + width - 26, 7, 20, 20);
    // The pieces of the title side by side, each as wide as its share of the title.
    const pieceWidth = title.width / Math.max(tab.title.length, 1);
    const pieceClasses = [
      'span.symbol',
      'span.last-price',
      'span.price-change',
      'span.layout-name',
    ];
    const pieces = tab.title.map((text, at) =>
      fakeElement({
        tag: 'span',
        matches: [tab.newTabPage ? 'span' : (pieceClasses[at] ?? 'span')],
        text,
        rect: box(title.x + at * pieceWidth, 8, pieceWidth, 18),
      }),
    );
    const closeContainer = fakeElement({
      matches: ['div.tab-close-button-container'],
      rect: closeAt,
      children: [
        fakeElement({ matches: ['div.fadeout'], rect: box(closeAt.x - 12, 4, 12, 26) }),
        ...(showsCloseButton(tab)
          ? [
              fakeElement({
                tag: 'button',
                matches: [
                  CHROME_SELECTORS.closeButton,
                  tabPartSelector(tab.id, CHROME_SELECTORS.closeButton),
                ],
                attributes: {
                  type: 'button',
                  title: 'Close',
                  'aria-label': 'Close',
                  tabindex: '-1',
                },
                rect: closeAt,
                children: [
                  fakeElement({
                    tag: 'svg',
                    rect: box(closeAt.x + 3, closeAt.y + 3, 14, 14),
                  }),
                ],
              }),
            ]
          : []),
      ],
    });
    return fakeElement({
      id: tab.id,
      matches: [
        CHROME_SELECTORS.tabs,
        SELECTORS.windowChrome.tab,
        `div.tab[id=${quotedId(tab.id)}]`,
        ...(active ? [SELECTORS.windowChrome.activeTab] : []),
      ],
      attributes: {
        draggable: 'true',
        class: ['tab', active ? 'active' : '', SIZE_CLASS[state.size]]
          .filter((name) => name !== '')
          .join(' '),
      },
      rect: box(x, 0, width, 34),
      children: [
        fakeElement({ matches: ['div.tab-link-indicator'], rect: box(x, 31, width, 3) }),
        fakeElement({
          matches: [CHROME_SELECTORS.title, tabPartSelector(tab.id, CHROME_SELECTORS.title)],
          rect: title,
          children: [
            fakeElement({ matches: ['div.title-container'], rect: title, children: pieces }),
          ],
        }),
        closeContainer,
        fakeElement({ matches: ['div.tab-panel-divider'], rect: box(x + width - 1, 8, 1, 18) }),
      ],
    });
  };

  const build = (): FakeDomWindow => {
    const width = TAB_WIDTH[state.size];
    const stripEnd = TRAFFIC_LIGHTS + state.tabs.length * width;
    const page = createFakeDomWindow(
      [
        fakeElement({ tag: 'html', rect: box(0, 0, VIEWPORT.width, VIEWPORT.height) }),
        fakeElement({
          tag: 'header',
          matches: ['header.header'],
          rect: box(0, 0, VIEWPORT.width, VIEWPORT.height),
          children: [
            fakeElement({ matches: ['div.darwin'], rect: box(0, 0, TRAFFIC_LIGHTS, 34) }),
            fakeElement({
              matches: ['div.tabs'],
              rect: box(TRAFFIC_LIGHTS, 0, VIEWPORT.width - TRAFFIC_LIGHTS - 80, 34),
              children: [
                fakeElement({
                  matches: ['div.tabs-container'],
                  rect: box(TRAFFIC_LIGHTS, 0, stripEnd - TRAFFIC_LIGHTS, 34),
                  children: state.tabs.map(tabElement),
                }),
                fakeElement({
                  matches: ['div.create-new-tab-button-container'],
                  rect: box(stripEnd + 4, 5, 24, 24),
                  children: [
                    fakeElement({
                      tag: 'button',
                      matches: [SELECTORS.windowChrome.newTab],
                      attributes: { title: 'New tab', 'aria-label': 'New tab', tabindex: '-1' },
                      rect: box(stripEnd + 4, 5, 24, 24),
                    }),
                  ],
                }),
                fakeElement({
                  matches: ['div.draggable-area'],
                  rect: box(stripEnd + 32, 0, VIEWPORT.width - 80 - stripEnd - 32, 34),
                }),
              ],
            }),
            fakeElement({
              matches: ['div.tab-panel-actions'],
              rect: box(VIEWPORT.width - 80, 0, 80, 34),
              children: [
                fakeElement({
                  tag: 'button',
                  id: 'new-window-button',
                  matches: [SELECTORS.windowChrome.newWindow],
                  rect: box(VIEWPORT.width - 76, 5, 24, 24),
                }),
                fakeElement({
                  tag: 'button',
                  id: 'main-menu-button',
                  matches: [SELECTORS.windowChrome.mainMenu],
                  rect: box(VIEWPORT.width - 36, 5, 24, 24),
                }),
              ],
            }),
          ],
        }),
      ],
      { viewport: VIEWPORT },
    );
    return page as unknown as FakeDomWindow;
  };

  let current = build();

  // The window stays the same object, and its members answer from the page as it is now.
  const window: Record<string, unknown> = {
    innerWidth: VIEWPORT.width,
    innerHeight: VIEWPORT.height,
    outerWidth: VIEWPORT.width,
    outerHeight: VIEWPORT.height,
    devicePixelRatio: 2,
    location: {
      href: 'file:///Applications/TradingView.app/Contents/Resources/app.asar/app/window/index.html',
    },
    document: {
      get visibilityState() {
        return state.inView ? 'visible' : 'hidden';
      },
      querySelector: (selectors: string) => current.document.querySelector?.(selectors) ?? null,
      querySelectorAll: (selectors: string) => current.document.querySelectorAll?.(selectors) ?? [],
      elementFromPoint: (x: number, y: number) => current.document.elementFromPoint?.(x, y) ?? null,
      get activeElement() {
        return current.document.activeElement;
      },
    },
    getComputedStyle: (element: FakeElement) => current.getComputedStyle?.(element),
    require: (...args: unknown[]) => {
      nodeAccess.push('require');
      throw new Error(`require(${args.map(String).join(', ')}) was called in the window chrome`);
    },
  };
  Object.defineProperty(window, 'process', {
    get() {
      nodeAccess.push('process');
      return undefined;
    },
    enumerable: false,
    configurable: true,
  });

  const render = (): void => {
    current = build();
  };

  const tabOf = (element: FakeElement | null): string | null =>
    element?.closest(CHROME_SELECTORS.tabs)?.id ?? null;

  const partOf = (element: FakeElement | null): FakeChromePart => {
    if (element === null) {
      return 'other';
    }
    if (element.closest(CHROME_SELECTORS.closeButton) !== null) {
      return 'close';
    }
    if (element.closest(CHROME_SELECTORS.title) !== null) {
      return 'title';
    }
    if (element.closest(CHROME_SELECTORS.tabs) !== null) {
      return 'tab';
    }
    return element.closest(SELECTORS.windowChrome.newTab) !== null ? 'new-tab' : 'other';
  };

  const later = (change: () => void): void => {
    if (changeMs === Infinity) {
      return;
    }
    setTimeout(change, changeMs).unref();
  };

  const tell = (action: FakeShellAction): void => {
    actions.push(action);
    render();
    hooks.changed?.(action);
  };

  const makeActive = (tabId: string): void => {
    if (state.active === tabId || !state.tabs.some(({ id }) => id === tabId)) {
      return;
    }
    state.active = tabId;
    tell({ action: 'switch', tabId });
  };

  const close = (tabId: string): void => {
    const at = state.tabs.findIndex(({ id }) => id === tabId);
    const tab = state.tabs[at];
    if (tab === undefined) {
      return;
    }
    if (hooks.asksToSave?.(tab) === true) {
      actions.push({ action: 'closeDialog', tabId });
      return;
    }
    state.tabs.splice(at, 1);
    if (state.active === tabId) {
      state.active = (state.tabs[at] ?? state.tabs[at - 1])?.id ?? null;
    }
    tell({ action: 'close', tabId });
  };

  const open = (): void => {
    opened += 1;
    const tabId = newTabIds.shift() ?? syntheticUuid(opened);
    state.tabs.push({ id: tabId, title: ['New tab'], pinned: false, newTabPage: true });
    state.active = tabId;
    tell({ action: 'new', tabId });
  };

  return {
    window,
    state,
    actions,
    clicks,
    hazards,
    nodeAccess,
    render,
    dispatchMouseEvent(params) {
      if (!isRecord(params)) {
        return;
      }
      const { type, x, y } = params;
      if ((type !== 'mousePressed' && type !== 'mouseReleased') || typeof x !== 'number') {
        return;
      }
      const button = typeof params.button === 'string' ? params.button : 'none';
      const clickCount = typeof params.clickCount === 'number' ? params.clickCount : 0;
      const hit = current.document.elementFromPoint?.(x, typeof y === 'number' ? y : 0) ?? null;
      const on = partOf(hit);
      const tabId = tabOf(hit);
      clicks.push({ type, button, clickCount, on, tabId });

      if (type === 'mousePressed' && clickCount >= 2) {
        hazards.push({ kind: 'double-click', tabId });
      }
      if (type === 'mousePressed' && button === 'right') {
        hazards.push({ kind: 'right-click', tabId });
      }
      if (type === 'mouseReleased' && button === 'middle') {
        hazards.push({ kind: 'middle-click', tabId });
      }
      if (button !== 'left' || clickCount !== 1) {
        return;
      }
      if (type === 'mousePressed') {
        pressed = { on, tabId };
        return;
      }
      // A click is a press and a release on the same part.
      const clicked = pressed !== null && pressed.on === on && pressed.tabId === tabId;
      pressed = null;
      if (!clicked) {
        return;
      }
      if ((on === 'title' || on === 'tab') && tabId !== null) {
        later(() => {
          makeActive(tabId);
        });
      } else if (on === 'close' && tabId !== null) {
        later(() => {
          close(tabId);
        });
      } else if (on === 'new-tab') {
        later(open);
      }
    },
  };
}
