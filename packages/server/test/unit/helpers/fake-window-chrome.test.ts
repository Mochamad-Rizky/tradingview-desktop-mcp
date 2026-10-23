import { setTimeout as delay } from 'node:timers/promises';
import { SELECTORS } from '../../../src/core/tv/selectors.js';
import type { FakeDomWindow, FakeElement } from '../../helpers/fake-tv/dom.js';
import {
  CHROME_SELECTORS,
  createFakeWindowChrome,
  STRIP_HEIGHT,
  tabPartSelector,
  type FakeWindowChromeOptions,
} from '../../helpers/fake-tv/window-chrome.js';

// The fake window chrome has to show the tab strip and answer clicks the way the notes of Plan 3
// (section 3) record that TradingView Desktop does, since the tests of the tab tools trust it to.
// Values are synthetic.

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

// Longer than the 5 ms the shell takes by default to show a change.
const SETTLE_MS = 30;

function chromeWith(options: Partial<FakeWindowChromeOptions> = {}) {
  return createFakeWindowChrome({
    tabs: [
      { id: A, title: ['AAPL', '123.45', '+0.67%', 'Morning plan'] },
      { id: B, title: ['MSFT', '234.56', '-0.12%', 'Second layout'] },
      { id: C, title: ['New tab'] },
    ],
    active: A,
    ...options,
  });
}

type Chrome = ReturnType<typeof chromeWith>;

function pageOf(chrome: Chrome): FakeDomWindow {
  return chrome.window as FakeDomWindow;
}

function find(chrome: Chrome, selector: string): FakeElement | null {
  return pageOf(chrome).document.querySelector?.(selector) ?? null;
}

function found(chrome: Chrome, selector: string): FakeElement {
  const element = find(chrome, selector);
  if (element === null) {
    throw new Error(`Nothing matches ${selector}`);
  }
  return element;
}

function centerOf(element: FakeElement): { x: number; y: number } {
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x: x + width / 2, y: y + height / 2 };
}

// A press and a release of a button, as Input.dispatchMouseEvent takes them.
function click(
  chrome: Chrome,
  at: { x: number; y: number },
  button = 'left',
  clickCount = 1,
): void {
  for (const type of ['mousePressed', 'mouseReleased']) {
    chrome.dispatchMouseEvent({ type, ...at, button, clickCount });
  }
}

const ids = (chrome: Chrome) =>
  (pageOf(chrome).document.querySelectorAll?.(CHROME_SELECTORS.tabs) ?? []).map(({ id }) => id);

test('shows the tabs in the order of the strip, the active one marked, with the new-tab button after them', () => {
  const chrome = chromeWith();

  expect(ids(chrome)).toEqual([A, B, C]);
  expect(found(chrome, SELECTORS.windowChrome.activeTab).id).toBe(A);
  expect(found(chrome, tabPartSelector(A, CHROME_SELECTORS.title)).textContent).toBe(
    'AAPL123.45+0.67%Morning plan',
  );
  expect(found(chrome, SELECTORS.windowChrome.newTab).getAttribute('aria-label')).toBe('New tab');
  // The button comes after the last tab.
  const lastTab = found(chrome, `div.tab[id="${C}"]`).getBoundingClientRect();
  expect(found(chrome, SELECTORS.windowChrome.newTab).getBoundingClientRect().x).toBeGreaterThan(
    lastTab.x + lastTab.width,
  );
  // The page spans the whole window, and the strip only its top, as seen on the app.
  expect(pageOf(chrome).innerHeight).toBe(800);
  expect(found(chrome, SELECTORS.windowChrome.strip).getBoundingClientRect()).toMatchObject({
    x: 0,
    y: 0,
    height: STRIP_HEIGHT,
  });
});

test('renders the close button with the rule of the app', () => {
  const closable = (chrome: Chrome) =>
    [A, B, C].filter((id) => find(chrome, tabPartSelector(id, CHROME_SELECTORS.closeButton)));

  // At the normal size, every tab that is not pinned.
  expect(closable(chromeWith())).toEqual([A, B, C]);
  expect(
    closable(
      chromeWith({
        tabs: [
          { id: A, title: ['AAPL'], pinned: true },
          { id: B, title: ['MSFT'] },
        ],
      }),
    ),
  ).toEqual([B]);
  // At a small size, only the active tab.
  for (const size of ['small', 'xsmall', 'xxsmall'] as const) {
    expect(closable(chromeWith({ size, active: B })), size).toEqual([B]);
  }
  // The only tab of the last window has none, and the only tab of another window has one.
  const only = { tabs: [{ id: A, title: ['AAPL'] }], active: A };
  expect(closable(chromeWith(only))).toEqual([]);
  expect(closable(chromeWith({ ...only, isLastWindow: false }))).toEqual([A]);
  expect(
    found(chromeWith(), tabPartSelector(A, CHROME_SELECTORS.closeButton)).getAttribute(
      'aria-label',
    ),
  ).toBe('Close');
});

test('a click on the title of a tab makes it the active tab, once the shell has answered', async () => {
  const changed: unknown[] = [];
  const chrome = chromeWith({ hooks: { changed: (action) => changed.push(action) } });

  click(chrome, centerOf(found(chrome, tabPartSelector(B, CHROME_SELECTORS.title))));
  // The shell answers over IPC, a moment later.
  expect(chrome.state.active).toBe(A);
  await delay(SETTLE_MS);

  expect(chrome.state.active).toBe(B);
  expect(found(chrome, SELECTORS.windowChrome.activeTab).id).toBe(B);
  expect(chrome.actions).toEqual([{ action: 'switch', tabId: B }]);
  expect(changed).toEqual([{ action: 'switch', tabId: B }]);
  expect(chrome.clicks).toEqual([
    { type: 'mousePressed', button: 'left', clickCount: 1, on: 'title', tabId: B },
    { type: 'mouseReleased', button: 'left', clickCount: 1, on: 'title', tabId: B },
  ]);
  expect(chrome.hazards).toEqual([]);
});

test('a click on a close button closes the tab, and the tab after it takes the front', async () => {
  const chrome = chromeWith();

  click(chrome, centerOf(found(chrome, tabPartSelector(A, CHROME_SELECTORS.closeButton))));
  await delay(SETTLE_MS);

  expect(ids(chrome)).toEqual([B, C]);
  expect(chrome.state.active).toBe(B);
  expect(chrome.actions).toEqual([{ action: 'close', tabId: A }]);
  expect(chrome.clicks.map(({ on }) => on)).toEqual(['close', 'close']);
});

test('closing the last tab of the strip while it is in front hands the front to the one before it', async () => {
  const chrome = chromeWith({ active: C });

  click(chrome, centerOf(found(chrome, tabPartSelector(C, CHROME_SELECTORS.closeButton))));
  await delay(SETTLE_MS);

  expect(ids(chrome)).toEqual([A, B]);
  expect(chrome.state.active).toBe(B);
});

test('a tab whose page asks to save opens the "Close tab?" dialog instead of closing', async () => {
  const chrome = chromeWith({ hooks: { asksToSave: ({ id }) => id === A } });

  click(chrome, centerOf(found(chrome, tabPartSelector(A, CHROME_SELECTORS.closeButton))));
  await delay(SETTLE_MS);

  expect(ids(chrome)).toEqual([A, B, C]);
  expect(chrome.actions).toEqual([{ action: 'closeDialog', tabId: A }]);
});

test('a click on the new-tab button opens a tab at the end of the strip, in front', async () => {
  const chrome = chromeWith({ newTabIds: ['44444444-4444-4444-8444-444444444444'] });

  click(chrome, centerOf(found(chrome, SELECTORS.windowChrome.newTab)));
  await delay(SETTLE_MS);
  click(chrome, centerOf(found(chrome, SELECTORS.windowChrome.newTab)));
  await delay(SETTLE_MS);

  const [fourth, fifth] = ids(chrome).slice(3);
  expect(fourth).toBe('44444444-4444-4444-8444-444444444444');
  expect(fifth).toMatch(/^00000000-0000-4000-8000-[0-9a-f]{12}$/);
  expect(chrome.state.active).toBe(fifth);
  expect(found(chrome, tabPartSelector(fifth ?? '', CHROME_SELECTORS.title)).textContent).toBe(
    'New tab',
  );
});

test('records double, middle and right clicks as hazards, and does nothing else with them', async () => {
  const chrome = chromeWith();
  const onB = centerOf(found(chrome, tabPartSelector(B, CHROME_SELECTORS.title)));

  click(chrome, onB, 'left', 2);
  click(chrome, onB, 'middle');
  click(chrome, onB, 'right');
  await delay(SETTLE_MS);

  expect(chrome.hazards).toEqual([
    { kind: 'double-click', tabId: B },
    { kind: 'middle-click', tabId: B },
    { kind: 'right-click', tabId: B },
  ]);
  expect(chrome.actions).toEqual([]);
  expect(ids(chrome)).toEqual([A, B, C]);
});

test('a press on one part and a release on another is no click', async () => {
  const chrome = chromeWith();

  chrome.dispatchMouseEvent({
    type: 'mousePressed',
    ...centerOf(found(chrome, tabPartSelector(B, CHROME_SELECTORS.title))),
    button: 'left',
    clickCount: 1,
  });
  chrome.dispatchMouseEvent({
    type: 'mouseReleased',
    ...centerOf(found(chrome, tabPartSelector(B, CHROME_SELECTORS.closeButton))),
    button: 'left',
    clickCount: 1,
  });
  // Moves and wheels are not clicks either.
  chrome.dispatchMouseEvent({ type: 'mouseMoved', x: 100, y: 10 });
  chrome.dispatchMouseEvent({ type: 'mouseWheel', x: 100, y: 10, deltaX: 0, deltaY: 50 });
  await delay(SETTLE_MS);

  expect(chrome.actions).toEqual([]);
});

test('a close button laid over the title takes a click at the center of the title', async () => {
  const chrome = chromeWith({ closeButtonOverTitle: true });

  click(chrome, centerOf(found(chrome, tabPartSelector(B, CHROME_SELECTORS.title))));
  await delay(SETTLE_MS);

  expect(chrome.clicks.map(({ on }) => on)).toEqual(['close', 'close']);
  expect(chrome.actions).toEqual([{ action: 'close', tabId: B }]);
});

test('a shell that never answers changes nothing', async () => {
  const chrome = chromeWith({ changeMs: Infinity });

  click(chrome, centerOf(found(chrome, tabPartSelector(B, CHROME_SELECTORS.title))));
  await delay(SETTLE_MS);

  expect(chrome.state.active).toBe(A);
  expect(chrome.actions).toEqual([]);
});

test('reports itself visible while the window is in view, and hidden while it is not', () => {
  const visibility = (chrome: Chrome) =>
    (chrome.window as { document: { visibilityState: string } }).document.visibilityState;
  const chrome = chromeWith();

  expect(visibility(chrome)).toBe('visible');
  chrome.state.inView = false;
  expect(visibility(chrome)).toBe('hidden');
  expect(visibility(chromeWith({ inView: false }))).toBe('hidden');
});

test('records every use of require and process in the page, which has Node integration', () => {
  const chrome = chromeWith();
  const win = chrome.window as { require(name: string): unknown; process: unknown };

  expect(() => win.require('fs')).toThrow(/require\(fs\) was called in the window chrome/);
  expect(win.process).toBeUndefined();
  expect(chrome.nodeAccess).toEqual(['require', 'process']);
});

test('shows a change of the state that a test makes once it renders again', () => {
  const chrome = chromeWith();

  chrome.state.tabs.reverse();
  chrome.render();

  expect(ids(chrome)).toEqual([C, B, A]);
});
