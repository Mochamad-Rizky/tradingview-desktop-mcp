import { SELECTORS } from '../../../src/core/tv/selectors.js';
import { createFakeDomWindow, type FakeElement } from '../../helpers/fake-tv/dom.js';
import { createFakeRightToolbar } from '../../helpers/fake-tv/right-toolbar.js';

// The fake right toolbar has to answer clicks the way the notes of Plan 3 (section 6.1) record that
// TradingView does, since the tests of ui_open_panel trust it to.

function find(toolbar: { element: FakeElement }, selector: string): FakeElement {
  const win = createFakeDomWindow([toolbar.element]) as unknown as {
    document: { querySelector(selector: string): FakeElement | null };
  };
  const found = win.document.querySelector(selector);
  if (found === null) {
    throw new Error(`Nothing matches ${selector}`);
  }
  return found;
}

const center = (element: FakeElement) => {
  const { x, y, width, height } = element.getBoundingClientRect();
  return [x + width / 2, y + height / 2] as const;
};

test('a click on the button of a hidden panel shows it, and one on the shown panel collapses it', () => {
  const toolbar = createFakeRightToolbar();
  const watchlist = find(toolbar, SELECTORS.buttons.watchlist);
  const alerts = find(toolbar, SELECTORS.buttons.alerts);
  const pages = find(toolbar, SELECTORS.widgets.widgetBarTabs);

  expect([watchlist.getAttribute('aria-pressed'), pages.getBoundingClientRect().width]).toEqual([
    'false',
    1,
  ]);
  toolbar.click(...center(watchlist));
  expect([watchlist.getAttribute('aria-pressed'), pages.getBoundingClientRect().width]).toEqual([
    'true',
    334,
  ]);
  toolbar.click(...center(alerts));
  expect([watchlist.getAttribute('aria-pressed'), alerts.getAttribute('aria-pressed')]).toEqual([
    'false',
    'true',
  ]);
  toolbar.click(...center(alerts));
  expect(toolbar.state.shown).toBeNull();
  expect(alerts.getAttribute('aria-pressed')).toBe('false');
});

test('the tabs of the object tree show with its panel, and remember the data window', () => {
  const toolbar = createFakeRightToolbar();
  const objectTree = find(toolbar, SELECTORS.buttons.objectTree);
  const dataWindowTab = find(toolbar, SELECTORS.widgets.dataWindowTab);

  expect(dataWindowTab.getBoundingClientRect().width).toBe(0);
  toolbar.click(...center(objectTree));
  expect(dataWindowTab.getBoundingClientRect().width).toBeGreaterThan(0);
  toolbar.click(...center(dataWindowTab));
  expect(dataWindowTab.getAttribute('aria-selected')).toBe('true');
  toolbar.click(...center(objectTree));
  toolbar.click(...center(objectTree));
  expect(toolbar.state).toEqual({ shown: 'object_tree', dataWindow: true });
});

test('the options leave buttons and tabs out, take the pressed state away, hide the toolbar or ignore clicks', () => {
  const without = createFakeRightToolbar({ without: ['alerts'], withoutTabs: true });
  const unpressable = createFakeRightToolbar({ unpressable: ['watchlist'] });
  const hidden = createFakeRightToolbar({ hidden: true });
  const inert = createFakeRightToolbar({ inert: true });

  expect(() => find(without, SELECTORS.buttons.alerts)).toThrow(/Nothing matches/);
  expect(() => find(without, SELECTORS.widgets.dataWindowTab)).toThrow(/Nothing matches/);
  expect(find(unpressable, SELECTORS.buttons.watchlist).getAttribute('aria-pressed')).toBeNull();
  expect(find(hidden, SELECTORS.buttons.watchlist).display).toBe('none');
  inert.click(...center(find(inert, SELECTORS.buttons.watchlist)));
  expect(inert.state.shown).toBeNull();
});
