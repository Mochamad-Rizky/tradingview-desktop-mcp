import { SELECTORS } from '../../../src/core/tv/selectors.js';
import { fakeElement, type FakeElement, type FakeRect } from './dom.js';

// The right edge of a fake chart tab, the way the notes of Plan 3 (section 6.1) record it: the
// widget bar holds the right toolbar and the pages of the right panel. The buttons of the toolbar
// open the panels (the watchlist, whose page is named base, the alerts, the object tree and the Pine
// Editor) and say with aria-pressed which one is shown. A click on the button of a panel that is
// not shown shows it, and a click on the button of the panel that is shown collapses the panel. The
// panel of the object tree has two tabs, the object tree and the data window, which show while
// that panel does and say with aria-selected which one it shows; the panel remembers its tab while
// it is collapsed. The pages are a border of 1 px while the panel is collapsed.
//
// The elements go into a DOM page (dom.ts), and a test hands the clicks the page receives to
// click, in CSS pixels, the way its answer to Input.dispatchMouseEvent would.

export type FakeToolbarPanel = 'watchlist' | 'alerts' | 'object_tree' | 'pine_editor';

export interface FakeRightToolbarOptions {
  // The panel shown when the page opens, null for a collapsed panel. Default null.
  shown?: FakeToolbarPanel | null;
  // Whether the panel of the object tree shows the data window rather than the object tree.
  // Default false.
  dataWindow?: boolean;
  // Leaves the tabs out of the panel of the object tree, as a build without a data window.
  withoutTabs?: boolean;
  // Buttons left out of the toolbar.
  without?: readonly FakeToolbarPanel[];
  // Buttons that carry no aria-pressed, and so do not say whether their panel is shown.
  unpressable?: readonly FakeToolbarPanel[];
  // Whether a click changes nothing, as a page that does not take it. Default false.
  inert?: boolean;
  // Whether the toolbar is hidden, as TradingView hides its toolbars in its fullscreen mode: its
  // buttons are not shown, though they still say which panel is shown. Default false.
  hidden?: boolean;
}

export interface FakeRightToolbarState {
  shown: FakeToolbarPanel | null;
  dataWindow: boolean;
}

export interface FakeRightToolbar {
  // The widget bar with everything in it, to put on the page.
  readonly element: FakeElement;
  readonly state: FakeRightToolbarState;
  // What a click at (x, y), in CSS pixels of the viewport, does.
  click(x: number, y: number): void;
}

// Where the parts are in a viewport of 1280 by 720 CSS pixels.
const TOOLBAR: FakeRect = { x: 1235, y: 40, width: 45, height: 660 };
const PAGES_OPEN: FakeRect = { x: 900, y: 40, width: 334, height: 660 };
const PAGES_COLLAPSED: FakeRect = { x: 1234, y: 40, width: 1, height: 660 };
const OBJECT_TREE_TAB: FakeRect = { x: 910, y: 50, width: 100, height: 30 };
const DATA_WINDOW_TAB: FakeRect = { x: 1020, y: 50, width: 100, height: 30 };
const HIDDEN: FakeRect = { x: 0, y: 0, width: 0, height: 0 };

const BUTTONS: readonly {
  panel: FakeToolbarPanel;
  selector: string;
  name: string;
  label: string;
}[] = [
  {
    panel: 'watchlist',
    selector: SELECTORS.buttons.watchlist,
    name: 'base',
    label: 'Watchlist, details, and news',
  },
  { panel: 'alerts', selector: SELECTORS.buttons.alerts, name: 'alerts', label: 'Alerts' },
  {
    panel: 'object_tree',
    selector: SELECTORS.buttons.objectTree,
    name: 'object_tree',
    label: 'Object tree and data window',
  },
  {
    panel: 'pine_editor',
    selector: SELECTORS.buttons.pineEditor,
    name: 'pine-dialog-button',
    label: 'Pine Editor',
  },
];

function within(rect: FakeRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

export function createFakeRightToolbar(options: FakeRightToolbarOptions = {}): FakeRightToolbar {
  const state: FakeRightToolbarState = {
    shown: options.shown ?? null,
    dataWindow: options.dataWindow ?? false,
  };
  const without = new Set(options.without);
  const unpressable = new Set(options.unpressable);

  const hidden = options.hidden === true;
  const buttons = BUTTONS.filter(({ panel }) => !without.has(panel)).map((button, index) => ({
    ...button,
    rect: { x: 1239, y: 50 + index * 40, width: 36, height: 36 },
    element: fakeElement({
      tag: 'button',
      matches: [button.selector],
      attributes: { 'data-name': button.name, 'aria-label': button.label },
      cursor: 'pointer',
      rect: hidden ? HIDDEN : { x: 1239, y: 50 + index * 40, width: 36, height: 36 },
      display: hidden ? 'none' : 'block',
      // The icon, which a click at the center of the button lands on.
      children: [
        fakeElement({ tag: 'span', rect: { x: 1247, y: 58 + index * 40, width: 20, height: 20 } }),
      ],
    }),
  }));
  const tab = (selector: string, id: string, text: string) =>
    fakeElement({
      tag: 'button',
      id,
      matches: [selector],
      attributes: { role: 'tab' },
      text,
    });
  const tabs =
    options.withoutTabs === true
      ? null
      : {
          objectTree: tab(SELECTORS.widgets.objectTreeTab, 'object_tree', 'Object tree'),
          dataWindow: tab(SELECTORS.widgets.dataWindowTab, 'data-window', 'Data window'),
        };
  const pages = fakeElement({
    matches: [SELECTORS.widgets.widgetBarTabs],
    attributes: { 'data-name': 'widgetbar-pages-with-tabs' },
    rect: PAGES_COLLAPSED,
    children:
      tabs === null
        ? []
        : [
            fakeElement({
              attributes: { 'data-qa-id': 'union-object-tree-widget-switcher', role: 'tablist' },
              rect: { x: 905, y: 45, width: 320, height: 40 },
              children: [tabs.objectTree, tabs.dataWindow],
            }),
          ],
  });
  const element = fakeElement({
    matches: [SELECTORS.widgets.widgetBar],
    attributes: { 'data-name': 'widgetbar-wrap' },
    rect: { x: 900, y: 40, width: 380, height: 660 },
    children: [
      fakeElement({
        matches: [SELECTORS.widgets.rightToolbar],
        attributes: { 'data-name': 'right-toolbar' },
        rect: TOOLBAR,
        children: buttons.map(({ element: button }) => button),
      }),
      pages,
    ],
  });

  // Shows on the page what the state says.
  const render = (): void => {
    for (const button of buttons) {
      if (!unpressable.has(button.panel)) {
        button.element.setAttribute('aria-pressed', String(state.shown === button.panel));
      }
    }
    pages.place(state.shown === null ? PAGES_COLLAPSED : PAGES_OPEN);
    if (tabs !== null) {
      const treeShown = state.shown === 'object_tree';
      tabs.objectTree.place(treeShown ? OBJECT_TREE_TAB : HIDDEN);
      tabs.dataWindow.place(treeShown ? DATA_WINDOW_TAB : HIDDEN);
      tabs.objectTree.setAttribute('aria-selected', String(!state.dataWindow));
      tabs.dataWindow.setAttribute('aria-selected', String(state.dataWindow));
    }
  };
  render();

  return {
    element,
    state,
    click(x, y) {
      if (options.inert === true) {
        return;
      }
      const button = buttons.find(({ rect }) => within(rect, x, y));
      if (button !== undefined) {
        state.shown = state.shown === button.panel ? null : button.panel;
      } else if (tabs !== null && state.shown === 'object_tree') {
        if (within(OBJECT_TREE_TAB, x, y)) {
          state.dataWindow = false;
        } else if (within(DATA_WINDOW_TAB, x, y)) {
          state.dataWindow = true;
        }
      }
      render();
    },
  };
}
