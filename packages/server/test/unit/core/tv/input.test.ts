import { setImmediate as settle } from 'node:timers/promises';
import type { CdpSession } from '../../../../src/core/cdp/types.js';
import { TimeoutError, type TvMcpError } from '../../../../src/core/errors.js';
import {
  clickElement,
  clickPoint,
  clickTarget,
  describeElement,
  describeFocusedElement,
  findElements,
  hoverElement,
  hoverPoint,
  hoverTarget,
  pressKey,
  scrollAt,
  typeText,
  type InputPage,
  type KeyModifier,
  type PointerAction,
  type PointerTarget,
} from '../../../../src/core/tv/input.js';
import { createPageBridge, type PageFunction } from '../../../../src/core/tv/page-bridge.js';
import {
  SELECTORS,
  TRADING_ACTION_NAMES,
  UNSAFE_SELECTORS,
} from '../../../../src/core/tv/selectors.js';
import type { TvWindow } from '../../../../src/core/tv/tv-window.js';
import type { JsonValue } from '../../../../src/utils/json.js';
import { failureOf } from '../../../helpers/failure-of.js';
import { layoutMetrics, layoutSizeOf } from '../../../helpers/fake-cdp/layout.js';
import { createPageRuntime } from '../../../helpers/fake-cdp/runtime.js';
import {
  createFakeDomWindow,
  fakeElement,
  type FakeDomOptions,
  type FakeDomWindow,
  type FakeElement,
  type FakeElementOptions,
  type FakeRect,
} from '../../../helpers/fake-tv/dom.js';
import { loadTvFixture } from '../../../helpers/fake-tv/fixture.js';
import { createFakeTvWindow } from '../../../helpers/fake-tv/window.js';

const BUY = '[data-name="buy-order-button"]';
const TRADE_BUTTON = '[data-qa-id="trade-button"]';
const TRADE_IN_HEADER = '#header-toolbar-trade-desktop';
const PANE = 'canvas[data-name="pane-canvas"]';
const SAVE = '#header-toolbar-save-load';
const OVERLAP_ROOT = SELECTORS.regions.overlapManagerRoot;

function box(x: number, y: number, width: number, height: number): FakeRect {
  return { x, y, width, height };
}

// A tab of the chart with a header button and a pane, the way most tests below want one.
function chart(extra: FakeElement[] = [], saveOptions: FakeElementOptions = {}): FakeElement[] {
  return [
    fakeElement({ matches: [SAVE], rect: box(100, 50, 40, 20), ...saveOptions }),
    fakeElement({ matches: [PANE], rect: box(0, 100, 800, 400) }),
    ...extra,
  ];
}

// The portal that dialogs and menus open in, holding `layers`. A portal has no box of its own by
// default, so nothing hits it. Give it one to show that hitting the portal is not the same as being
// covered by what it holds.
function overlapRoot(layers: FakeElement[], rect: FakeRect = box(0, 0, 0, 0)): FakeElement {
  return fakeElement({ matches: [OVERLAP_ROOT], rect, children: layers });
}

// describeElement as the bridge calls it for a click: with the real lists of selectors to refuse
// and of the layers that cover a page, and the names of trading actions.
function look(win: TvWindow, selector: string) {
  return describeElement(
    win,
    selector,
    [...UNSAFE_SELECTORS],
    [OVERLAP_ROOT],
    TRADING_ACTION_NAMES,
    'click',
    false,
  );
}

interface SentCommand {
  method: string;
  params: unknown;
}

interface FakePage {
  page: InputPage;
  // Everything sent to the session, in order.
  sent: SentCommand[];
  // The input events among them: what a page would react to.
  input: () => SentCommand[];
  // The type of each input event, such as mousePressed or keyUp.
  types: () => unknown[];
}

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
});

// A session to a page that is `win`: Runtime.evaluate runs the page function in it, through the
// real bridge, Page.getLayoutMetrics answers what `answerLayout` gives, by default the viewport and
// the zoom the window reports, as the fake debug port answers it, and every other command goes to
// `handleInput`, which may reject or wait.
function pageOver(
  win: object,
  handleInput: (command: SentCommand) => unknown = () => ({}),
  answerLayout: () => unknown = () => layoutMetrics(layoutSizeOf(win)),
): FakePage {
  const runtime = createPageRuntime(win);
  disposers.push(() => {
    runtime.dispose();
  });
  const sent: SentCommand[] = [];
  const send = (method: string, params?: unknown): Promise<unknown> => {
    const command: SentCommand = { method, params };
    sent.push(command);
    if (method === 'Runtime.evaluate') {
      return runtime.evaluate(params as Record<string, unknown>);
    }
    if (method === 'Page.getLayoutMetrics') {
      return Promise.resolve().then(answerLayout);
    }
    return Promise.resolve().then(() => handleInput(command));
  };
  const session: CdpSession = {
    targetId: 'PAGE1',
    isClosed: false,
    // The protocol typings of send are generic over every CDP method; this fake answers a few.
    send: send as CdpSession['send'],
    onClose: () => undefined,
    close: () => Promise.resolve(),
  };
  const input = () => sent.filter(({ method }) => method.startsWith('Input.'));
  return {
    page: { session, bridge: createPageBridge(session, { timeoutMs: 1000 }) },
    sent,
    input,
    types: () => input().map(({ params }) => (params as { type: string }).type),
  };
}

function pageWith(
  elements: FakeElement[],
  options: FakeDomOptions = {},
  handleInput?: (command: SentCommand) => unknown,
  answerLayout?: () => unknown,
): FakePage {
  return pageOver(createFakeDomWindow(elements, options), handleInput, answerLayout);
}

// The window as the fake really is, with its own elements, so that a test can move the focus.
function dom(win: TvWindow): FakeDomWindow {
  return win as unknown as FakeDomWindow;
}

function mouseEvent(type: string, x: number, y: number): SentCommand {
  const pressed = type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 };
  return { method: 'Input.dispatchMouseEvent', params: { type, x, y, ...pressed } };
}

// A hover that opens a flyout, or moves the target, is how the page changes between the first
// lookup and the press. The fake session plays the page: when the pointer moves it runs `change`,
// and the second lookup sees the result.
function afterTheMove(change: () => void) {
  return ({ method, params }: SentCommand): unknown => {
    if (
      method === 'Input.dispatchMouseEvent' &&
      (params as { type: string }).type === 'mouseMoved'
    ) {
      change();
    }
    return {};
  };
}

describe('describeElement', () => {
  test('flags the buy order button as unsafe', () => {
    const win = createFakeDomWindow([fakeElement({ matches: [BUY], rect: box(300, 250, 80, 30) })]);

    expect(look(win, BUY)).toEqual({
      found: true,
      visible: true,
      unsafe: true,
      coverage: 'not-checked',
      obscuredBy: '',
      rect: box(300, 250, 80, 30),
    });
  });

  test.each(UNSAFE_SELECTORS)('flags an element that matches %s', (selector) => {
    const win = createFakeDomWindow([fakeElement({ matches: [selector] })]);

    expect(look(win, selector)).toMatchObject({ found: true, unsafe: true });
  });

  test('flags an element that holds an unsafe control, however deep', () => {
    const control = fakeElement({ matches: [TRADE_BUTTON] });
    const toolbar = fakeElement({
      matches: ['[data-name="toolbar"]'],
      children: [fakeElement({ children: [fakeElement({ children: [control] })] })],
    });

    // The page cannot say what lies at the center, so the structure alone has to flag it.
    const win = createFakeDomWindow([toolbar], { without: ['elementFromPoint'] });

    expect(look(win, '[data-name="toolbar"]')).toMatchObject({ unsafe: true });
  });

  test('does not look at what lies at the center of an element that is already unsafe', () => {
    // The verdict is final, and what covers a trading control is of no interest.
    const toolbar = fakeElement({
      matches: ['[data-name="toolbar"]'],
      children: [fakeElement({ matches: [TRADE_BUTTON], rect: box(700, 20, 60, 30) })],
    });
    const win = createFakeDomWindow([toolbar]);

    expect(look(win, '[data-name="toolbar"]')).toMatchObject({
      unsafe: true,
      coverage: 'not-checked',
      obscuredBy: '',
    });
  });

  test('flags an element that sits inside an unsafe control', () => {
    const label = fakeElement({ matches: ['[data-name="label"]'] });
    const control = fakeElement({
      matches: [TRADE_IN_HEADER],
      children: [fakeElement({ children: [label] })],
    });

    // The page cannot say what lies at the center, so the structure alone has to flag it.
    const win = createFakeDomWindow([control], { without: ['elementFromPoint'] });

    expect(look(win, '[data-name="label"]')).toMatchObject({ unsafe: true });
  });

  test('flags an element whose center lies under an unsafe control', () => {
    const ticket = fakeElement({
      matches: ['[data-name="order-ticket"]'],
      rect: box(300, 250, 200, 100),
      children: [fakeElement({ matches: [BUY], rect: box(350, 280, 100, 40) })],
    });
    // Neither contains the other: the ticket floats over the pane.
    const win = createFakeDomWindow(chart([ticket]));

    expect(look(win, PANE)).toMatchObject({ found: true, visible: true, unsafe: true });
  });

  test('flags an element whose center lies under a part of an unsafe control', () => {
    // The label is not the control, but a click on it is a click on the control.
    const label = fakeElement({ matches: ['[data-name="label"]'], rect: box(350, 280, 100, 40) });
    const ticket = fakeElement({
      matches: [BUY],
      rect: box(300, 250, 200, 100),
      children: [label],
    });
    const win = createFakeDomWindow(chart([ticket]));

    expect(look(win, PANE)).toMatchObject({ found: true, visible: true, unsafe: true });
  });

  test('flags a target for a click when what covers its center holds a trading control, and no target elsewhere', () => {
    // The ticket covers the center of the pane and holds a trading control, which lies elsewhere.
    // The click would land on the ticket, and a click on an element that holds a trading control is
    // refused: that is reported as unsafe, which comes before being covered. The header button lies
    // away from the ticket and is not flagged for the control on the page.
    const ticket = fakeElement({
      attributes: { 'data-name': 'order-ticket' },
      rect: box(300, 250, 200, 100),
      children: [fakeElement({ matches: [BUY], rect: box(700, 20, 60, 30) })],
    });
    const win = createFakeDomWindow(chart([overlapRoot([ticket])]));

    expect(look(win, PANE)).toMatchObject({
      found: true,
      visible: true,
      unsafe: true,
      coverage: 'not-checked',
      obscuredBy: '',
    });
    expect(look(win, SAVE)).toMatchObject({ unsafe: false, coverage: 'clear', obscuredBy: '' });
  });

  test('reports a target whose center a layer covers that holds no trading control as obscured, not unsafe', () => {
    // Being covered is a different matter from being unsafe, and is reported on its own.
    const ticket = fakeElement({
      attributes: { 'data-name': 'order-ticket' },
      rect: box(300, 250, 200, 100),
      children: [fakeElement({ tag: 'button', id: 'submit-order', rect: box(700, 20, 60, 30) })],
    });
    const win = createFakeDomWindow(chart([overlapRoot([ticket])]));

    expect(look(win, PANE)).toMatchObject({
      unsafe: false,
      coverage: 'obscured',
      obscuredBy: 'div[data-name="order-ticket"]',
    });
  });

  test.each<[string, (layer: FakeElement) => FakeElement[]]>([
    ['a dialog in the overlap root', (layer) => [overlapRoot([layer])]],
    [
      'a menu item deep in the overlap root',
      (layer) => [overlapRoot([fakeElement({ children: [fakeElement({ children: [layer] })] })])],
    ],
  ])('reports a target that %s lies over as obscured', (_label, place) => {
    const layer = fakeElement({ id: 'menu-item', rect: box(350, 280, 100, 40) });
    const win = createFakeDomWindow(chart(place(layer)));

    expect(look(win, PANE)).toMatchObject({
      found: true,
      visible: true,
      unsafe: false,
      coverage: 'obscured',
      obscuredBy: 'div#menu-item',
    });
  });

  test('names what covers the target by its tag, id, data-qa-id and data-name, cut at 120', () => {
    const named = fakeElement({
      tag: 'section',
      id: 'popup',
      attributes: { 'data-qa-id': 'popup-qa', 'data-name': 'popup-name' },
      rect: box(350, 280, 100, 40),
    });
    const long = fakeElement({ id: 'x'.repeat(300), rect: box(350, 280, 100, 40) });

    expect(look(createFakeDomWindow(chart([overlapRoot([named])])), PANE)).toMatchObject({
      obscuredBy: 'section#popup[data-qa-id="popup-qa"][data-name="popup-name"]',
    });
    expect(look(createFakeDomWindow(chart([overlapRoot([long])])), PANE)).toMatchObject({
      obscuredBy: `div#${'x'.repeat(116)}`,
    });
  });

  test.each(['iframe', 'frame', 'object', 'embed'])(
    'reports a target covered by a <%s> as obscured',
    (tag) => {
      // The page cannot look into a frame, so whatever it shows there is out of sight.
      const frame = fakeElement({ tag, id: 'ad', rect: box(350, 280, 100, 40) });
      const win = createFakeDomWindow(chart([frame]));

      expect(look(win, PANE)).toMatchObject({
        unsafe: false,
        coverage: 'obscured',
        obscuredBy: `${tag}#ad`,
      });
    },
  );

  test('does not count an element stacked over the target outside the overlap root', () => {
    // The chart draws several canvases on top of each other, and a click on the one underneath
    // reaches the page through the one on top.
    const stacked = fakeElement({
      tag: 'canvas',
      matches: ['canvas[data-name="overlay-canvas"]'],
      rect: box(0, 100, 800, 400),
    });
    const win = createFakeDomWindow(chart([stacked]));

    expect(look(win, PANE)).toMatchObject({ unsafe: false, coverage: 'clear', obscuredBy: '' });
  });

  test('does not count the target itself, what it holds, or the overlap root as covering', () => {
    const inner = fakeElement({ rect: box(350, 280, 100, 40) });
    const dialogButton = fakeElement({
      matches: ['[data-name="dialog-button"]'],
      rect: box(300, 250, 200, 100),
      children: [inner],
    });
    // A portal as large as the page, which is what a hit on the portal itself would look like.
    const portal = overlapRoot([dialogButton], box(0, 0, 1000, 700));
    const win = createFakeDomWindow(chart([portal]));

    // The inner element is what lies at the center of the button, and it is part of the button.
    expect(look(win, '[data-name="dialog-button"]')).toMatchObject({ coverage: 'clear' });
    // Nothing but the portal lies over the center of the header button, and the portal is not a
    // layer of itself.
    expect(look(win, SAVE)).toMatchObject({ coverage: 'clear', obscuredBy: '' });
  });

  test('reports a target in the overlap root that another layer of the root lies over', () => {
    const button = fakeElement({
      matches: ['[data-name="dialog-button"]'],
      rect: box(300, 250, 200, 100),
    });
    const menu = fakeElement({ id: 'context-menu', rect: box(350, 280, 100, 40) });
    const win = createFakeDomWindow(chart([overlapRoot([button, menu])]));

    expect(look(win, '[data-name="dialog-button"]')).toMatchObject({
      coverage: 'obscured',
      obscuredBy: 'div#context-menu',
    });
  });

  test('does not count a covering layer that is not shown', () => {
    const hidden = fakeElement({ rect: box(350, 280, 100, 40), visibility: 'hidden' });
    const gone = fakeElement({ rect: box(350, 280, 100, 40), display: 'none' });
    const win = createFakeDomWindow(chart([overlapRoot([hidden, gone])]));

    expect(look(win, PANE)).toMatchObject({ coverage: 'clear' });
  });

  test('reports the unsafe verdict, and not the covering, when the layer holds a trading control', () => {
    const ticket = fakeElement({
      rect: box(300, 250, 200, 100),
      children: [fakeElement({ matches: [BUY], rect: box(350, 280, 100, 40) })],
    });
    const win = createFakeDomWindow(chart([overlapRoot([ticket])]));

    expect(look(win, PANE)).toMatchObject({ unsafe: true, obscuredBy: '' });
  });

  test('judges the whole point a click would land on, the center rounded to whole pixels', () => {
    // The center is (26.9, 29.1), which a click rounds to (27, 29).
    const target = fakeElement({
      matches: ['[data-name="target"]'],
      rect: box(10.4, 20.6, 33, 17),
    });
    // A control one pixel wide, with its left edge at x, over the row of that point.
    const withControlAt = (x: number) =>
      look(
        createFakeDomWindow([target, fakeElement({ matches: [BUY], rect: box(x, 29, 1, 1) })]),
        '[data-name="target"]',
      );

    expect(withControlAt(27)).toMatchObject({ unsafe: true });
    // 26 holds the unrounded center, and 28 the rounded-up neighbor: neither is where a click goes.
    expect(withControlAt(26)).toMatchObject({ unsafe: false });
    expect(withControlAt(28)).toMatchObject({ unsafe: false });
  });

  test('does not look at what lies at the center of an element that is not shown', () => {
    const covering = fakeElement({ matches: [BUY], rect: box(0, 0, 100, 100) });
    const hidden = fakeElement({
      matches: ['[data-name="hidden"]'],
      rect: box(25, 25, 50, 50),
      display: 'none',
    });
    const flat = fakeElement({ matches: ['[data-name="flat"]'], rect: box(0, 0, 0, 0) });

    const win = createFakeDomWindow([hidden, flat, covering]);

    expect(look(win, '[data-name="hidden"]')).toMatchObject({
      visible: false,
      unsafe: false,
      coverage: 'not-checked',
    });
    expect(look(win, '[data-name="flat"]')).toMatchObject({
      visible: false,
      unsafe: false,
      coverage: 'not-checked',
    });
  });

  test('reports that the click cannot be judged when the page cannot say what lies at the center', () => {
    const ticket = fakeElement({ matches: [BUY], rect: box(300, 250, 200, 100) });
    const win = createFakeDomWindow(chart([ticket]), { without: ['elementFromPoint'] });

    expect(look(win, PANE)).toMatchObject({
      visible: true,
      unsafe: false,
      coverage: 'hit-test-unavailable',
    });
    // What the element holds or sits in is still judged.
    expect(look(win, BUY)).toMatchObject({ unsafe: true });
  });

  test('reports that the click cannot be judged when the center is outside the viewport', () => {
    const offscreen = fakeElement({
      matches: ['[data-name="offscreen"]'],
      rect: box(900, 50, 200, 20),
    });
    const win = createFakeDomWindow([offscreen], { viewport: { width: 1000, height: 700 } });

    // The box is partly on the page, but its center, (1000, 60), is not.
    expect(look(win, '[data-name="offscreen"]')).toMatchObject({
      found: true,
      visible: true,
      unsafe: false,
      coverage: 'center-outside-viewport',
    });
  });

  test('reports an element that is not there as not found, without a box', () => {
    const win = createFakeDomWindow(chart());

    const missing = look(win, '[data-name="missing"]');

    expect(missing).toEqual({
      found: false,
      visible: false,
      unsafe: false,
      coverage: 'not-checked',
      obscuredBy: '',
    });
    expect(missing).not.toHaveProperty('rect');
  });

  test('reports a shown element with its box in viewport pixels, as the page gives it', () => {
    const win = createFakeDomWindow([
      fakeElement({ matches: [SAVE], rect: box(10.25, 20.75, 33.5, 17.125) }),
    ]);

    expect(look(win, SAVE)).toEqual({
      found: true,
      visible: true,
      unsafe: false,
      coverage: 'clear',
      obscuredBy: '',
      rect: box(10.25, 20.75, 33.5, 17.125),
    });
  });

  test.each<[string, FakeElementOptions]>([
    ['has no width', { rect: box(10, 10, 0, 40) }],
    ['has no height', { rect: box(10, 10, 100, 0) }],
    ['is display: none', { display: 'none' }],
    ['is visibility: hidden', { visibility: 'hidden' }],
    ['is not connected', { connected: false }],
  ])('finds an element that %s, and reports it as not visible', (_label, options) => {
    const rect = options.rect ?? box(10, 10, 100, 40);
    const win = createFakeDomWindow([fakeElement({ matches: [SAVE], rect, ...options })]);

    expect(look(win, SAVE)).toEqual({
      found: true,
      visible: false,
      unsafe: false,
      coverage: 'not-checked',
      obscuredBy: '',
      rect,
    });
  });

  test.each(['block', 'inline-block', 'flex', 'grid', 'inline'])(
    'counts display: %s as shown',
    (display) => {
      const win = createFakeDomWindow([fakeElement({ matches: [SAVE], display })]);

      expect(look(win, SAVE)).toMatchObject({ visible: true });
    },
  );

  test('judges visibility by the box alone when the page has no getComputedStyle', () => {
    const win = createFakeDomWindow(
      [
        fakeElement({ matches: [SAVE], display: 'none' }),
        fakeElement({ matches: [PANE], rect: box(0, 0, 0, 0) }),
      ],
      { without: ['getComputedStyle'] },
    );

    expect(look(win, SAVE)).toMatchObject({ visible: true });
    expect(look(win, PANE)).toMatchObject({ visible: false });
  });

  test('describes the first element that matches, as querySelector picks it', () => {
    const win = createFakeDomWindow([
      fakeElement({ matches: ['.row'], rect: box(1, 2, 3, 4) }),
      fakeElement({ matches: ['.row'], rect: box(5, 6, 7, 8) }),
    ]);

    expect(look(win, '.row')).toMatchObject({ rect: box(1, 2, 3, 4) });
  });

  test('returns NOT_AVAILABLE, and does not throw, on a page without a DOM', () => {
    const noDom = createFakeDomWindow(chart(), { without: ['querySelector'] });
    // The shared fake of a chart tab models the chart API and has no DOM at all.
    const chartTab = createFakeTvWindow(loadTvFixture());

    for (const win of [noDom, chartTab]) {
      expect(look(win, SAVE)).toEqual({
        __tvmcpError: {
          code: 'NOT_AVAILABLE',
          message: expect.stringContaining('DOM') as unknown,
          hint: expect.any(String) as unknown,
        },
      });
    }
  });

  test.each(['', '[', 'div,', '[data-name="open'])(
    'returns INVALID_INPUT for the selector %j, which is not valid CSS',
    (selector) => {
      const win = createFakeDomWindow(chart());

      expect(look(win, selector)).toEqual({
        __tvmcpError: {
          code: 'INVALID_INPUT',
          message: expect.stringContaining('selector') as unknown,
          hint: expect.any(String) as unknown,
          details: { selector },
        },
      });
    },
  );

  test('refuses to judge without the selectors to treat as unsafe', () => {
    const win = createFakeDomWindow([fakeElement({ matches: [BUY] })]);

    expect(() =>
      describeElement(win, BUY, [], [OVERLAP_ROOT], TRADING_ACTION_NAMES, 'click', false),
    ).toThrow(/unsafe/);
  });

  test('refuses to judge without the selectors of the layers that cover a page', () => {
    const win = createFakeDomWindow([fakeElement({ matches: [BUY] })]);

    expect(() =>
      describeElement(win, BUY, [...UNSAFE_SELECTORS], [], TRADING_ACTION_NAMES, 'click', false),
    ).toThrow(/cover/);
  });
});

describe('describeFocusedElement', () => {
  // As the bridge calls it: with the real list of selectors to refuse and the names of trading
  // actions.
  function focusOf(win: TvWindow) {
    return describeFocusedElement(win, [...UNSAFE_SELECTORS], TRADING_ACTION_NAMES);
  }

  test('flags a trading button that has the focus, and says which element it is', () => {
    const buy = fakeElement({
      tag: 'button',
      matches: [BUY],
      attributes: { 'data-name': 'buy-order-button' },
    });
    const win = createFakeDomWindow([buy], { focus: buy });

    expect(focusOf(win)).toEqual({
      unsafe: true,
      editable: false,
      opaque: false,
      focused: 'button[data-name="buy-order-button"]',
    });
  });

  test.each(UNSAFE_SELECTORS)('flags a focused element that matches %s', (selector) => {
    const control = fakeElement({ matches: [selector] });
    const win = createFakeDomWindow([control], { focus: control });

    expect(focusOf(win)).toMatchObject({ unsafe: true });
  });

  test('does not flag a focused element that only holds an unsafe control, however deep', () => {
    // Key events go to the focused element and not to its descendants, and the pane of the chart,
    // where the focus usually is, always holds the buy and sell buttons shown on it.
    const control = fakeElement({ matches: [TRADE_BUTTON] });
    const pane = fakeElement({
      attributes: { 'data-qa-id': 'pane' },
      children: [fakeElement({ children: [fakeElement({ children: [control] })] })],
    });
    const win = createFakeDomWindow([pane], { focus: pane });

    expect(focusOf(win)).toEqual({
      unsafe: false,
      editable: false,
      opaque: false,
      focused: 'div[data-qa-id="pane"]',
    });
  });

  test('flags a focused element that sits inside an unsafe control, however deep', () => {
    const field = fakeElement({ tag: 'input' });
    const group = fakeElement({
      matches: ['[data-name="buy-sell-buttons"]'],
      children: [fakeElement({ children: [fakeElement({ children: [field] })] })],
    });
    const win = createFakeDomWindow([group], { focus: field });

    expect(focusOf(win)).toEqual({
      unsafe: true,
      editable: true,
      opaque: false,
      focused: 'input',
    });
  });

  test('does not flag the chart canvas, whatever else the page holds', () => {
    const canvas = fakeElement({ tag: 'canvas', attributes: { 'data-name': 'pane-canvas' } });
    const ticket = fakeElement({ children: [fakeElement({ matches: [BUY] })] });
    const win = createFakeDomWindow([canvas, ticket], { focus: canvas });

    expect(focusOf(win)).toEqual({
      unsafe: false,
      editable: false,
      opaque: false,
      focused: 'canvas[data-name="pane-canvas"]',
    });
  });

  test('counts the body and the html element as safe, although they hold the whole page', () => {
    const control = fakeElement({ matches: [BUY] });
    const body = fakeElement({ tag: 'body', children: [control] });
    const html = fakeElement({ tag: 'html', children: [body] });

    expect(focusOf(createFakeDomWindow([control], { focus: body }))).toEqual({
      unsafe: false,
      editable: false,
      opaque: false,
      focused: 'body',
    });
    expect(focusOf(createFakeDomWindow([control], { focus: html }))).toEqual({
      unsafe: false,
      editable: false,
      opaque: false,
      focused: 'html',
    });
  });

  test('counts the body that a page focuses when nothing else has the focus as safe', () => {
    // The default of the fake: the body, which holds the trading control.
    const win = createFakeDomWindow([fakeElement({ matches: [BUY] })]);

    expect(focusOf(win)).toEqual({
      unsafe: false,
      editable: false,
      opaque: false,
      focused: 'body',
    });
  });

  test('counts no focused element at all as safe', () => {
    const win = createFakeDomWindow([fakeElement({ matches: [BUY] })], { focus: null });

    expect(focusOf(win)).toEqual({ unsafe: false, editable: false, opaque: false, focused: '' });
  });

  test('describes the element by its tag, id, data-qa-id and data-name, in that order', () => {
    const describe = (element: FakeElement) =>
      focusOf(createFakeDomWindow([element], { focus: element }));

    expect(describe(fakeElement())).toEqual({
      unsafe: false,
      editable: false,
      opaque: false,
      focused: 'div',
    });
    expect(describe(fakeElement({ tag: 'span', id: 'label' }))).toMatchObject({
      focused: 'span#label',
    });
    expect(describe(fakeElement({ attributes: { 'data-qa-id': 'legend' } }))).toMatchObject({
      focused: 'div[data-qa-id="legend"]',
    });
    expect(describe(fakeElement({ attributes: { 'data-name': 'alerts' } }))).toMatchObject({
      focused: 'div[data-name="alerts"]',
    });
    expect(
      describe(
        fakeElement({
          tag: 'input',
          id: 'qty',
          attributes: { 'data-name': 'quantity', 'data-qa-id': 'qty-input', title: 'ignored' },
        }),
      ),
    ).toMatchObject({ focused: 'input#qty[data-qa-id="qty-input"][data-name="quantity"]' });
  });

  test('cuts a descriptor that is longer than 120 characters', () => {
    const element = fakeElement({ id: 'x'.repeat(300) });

    const { focused } = focusOf(createFakeDomWindow([element], { focus: element })) as {
      focused: string;
    };

    expect(focused).toBe(`div#${'x'.repeat(116)}`);
  });

  test.each<[string, boolean, FakeElementOptions]>([
    ['an input without a type', true, { tag: 'input' }],
    ['an input of type text', true, { tag: 'input', attributes: { type: 'text' } }],
    ['an input of type search', true, { tag: 'input', attributes: { type: 'search' } }],
    ['an input of type email', true, { tag: 'input', attributes: { type: 'email' } }],
    ['an input of type url', true, { tag: 'input', attributes: { type: 'url' } }],
    ['an input of type tel', true, { tag: 'input', attributes: { type: 'tel' } }],
    ['an input of type password', true, { tag: 'input', attributes: { type: 'password' } }],
    ['an input of type number', true, { tag: 'input', attributes: { type: 'number' } }],
    [
      'an input of type SEARCH, in capitals',
      true,
      { tag: 'input', attributes: { type: 'SEARCH' } },
    ],
    // A page treats a type it does not know as text.
    ['an input of a type nobody knows', true, { tag: 'input', attributes: { type: 'foo' } }],
    ['a textarea', true, { tag: 'textarea' }],
    ['a content-editable div', true, { contentEditable: true }],
    ['an input of type checkbox', false, { tag: 'input', attributes: { type: 'checkbox' } }],
    ['an input of type radio', false, { tag: 'input', attributes: { type: 'radio' } }],
    ['an input of type button', false, { tag: 'input', attributes: { type: 'button' } }],
    ['an input of type submit', false, { tag: 'input', attributes: { type: 'submit' } }],
    ['an input of type reset', false, { tag: 'input', attributes: { type: 'reset' } }],
    ['an input of type file', false, { tag: 'input', attributes: { type: 'file' } }],
    ['an input of type range', false, { tag: 'input', attributes: { type: 'range' } }],
    ['an input of type color', false, { tag: 'input', attributes: { type: 'color' } }],
    ['an input of type date', false, { tag: 'input', attributes: { type: 'date' } }],
    ['an input of type time', false, { tag: 'input', attributes: { type: 'time' } }],
    ['an input of type hidden', false, { tag: 'input', attributes: { type: 'hidden' } }],
    ['a button', false, { tag: 'button' }],
    ['a select', false, { tag: 'select' }],
    // A link reports its type attribute as a type, which is no reason to type into it.
    ['a link with a type attribute of text', false, { tag: 'a', attributes: { type: 'text' } }],
    ['a canvas', false, { tag: 'canvas' }],
    ['a div', false, {}],
  ])('reports %s as editable: %s', (_label, editable, options) => {
    const element = fakeElement(options);
    const win = createFakeDomWindow([element], { focus: element });

    expect(focusOf(win)).toMatchObject({ unsafe: false, editable });
  });

  test.each(['iframe', 'frame', 'object', 'embed'])(
    'reports a focus on a <%s> as one that cannot be judged',
    (tag) => {
      // The page cannot look into a frame, so what has the focus in there is out of sight.
      const frame = fakeElement({ tag, id: 'ad' });
      const win = createFakeDomWindow([frame], { focus: frame });

      expect(focusOf(win)).toEqual({
        unsafe: false,
        editable: false,
        opaque: true,
        focused: `${tag}#ad`,
      });
    },
  );

  test('reports a focus held inside a shadow root as one that cannot be judged', () => {
    const inner = fakeElement({ tag: 'input' });
    const host = fakeElement({ id: 'host', shadowFocus: inner });
    const win = createFakeDomWindow([host], { focus: host });

    expect(focusOf(win)).toEqual({
      unsafe: false,
      editable: false,
      opaque: true,
      focused: 'div#host',
    });
  });

  test('does not mind a shadow root that holds no focus, or an element that has none', () => {
    const quiet = fakeElement({ id: 'quiet', shadowFocus: null });
    const plain = fakeElement({ id: 'plain' });

    expect(focusOf(createFakeDomWindow([quiet], { focus: quiet }))).toMatchObject({
      opaque: false,
    });
    expect(focusOf(createFakeDomWindow([plain], { focus: plain }))).toMatchObject({
      opaque: false,
    });
  });

  test('reports a focus on a trading control in a frame as unsafe and as one that cannot be judged', () => {
    const frame = fakeElement({ tag: 'iframe', matches: [BUY] });
    const win = createFakeDomWindow([frame], { focus: frame });

    expect(focusOf(win)).toMatchObject({ unsafe: true, opaque: true });
  });

  test('reports a trading field as both unsafe and editable', () => {
    const field = fakeElement({ tag: 'input', matches: [BUY] });
    const win = createFakeDomWindow([field], { focus: field });

    expect(focusOf(win)).toMatchObject({ unsafe: true, editable: true });
  });

  test('returns NOT_AVAILABLE, and does not throw, when the page cannot say what has the focus', () => {
    const windows = {
      'a document without activeElement': createFakeDomWindow(chart(), {
        without: ['activeElement'],
      }),
      // The shared fake of a chart tab models the chart API and has no DOM at all.
      'the shared fake of a chart tab': createFakeTvWindow(loadTvFixture()),
      'a window without a document': {} as unknown as TvWindow,
    };

    for (const [label, win] of Object.entries(windows)) {
      expect(focusOf(win), label).toEqual({
        __tvmcpError: {
          code: 'NOT_AVAILABLE',
          message: expect.stringContaining('focus') as unknown,
          hint: expect.any(String) as unknown,
        },
      });
    }
  });

  test('refuses to judge without the selectors to treat as unsafe', () => {
    const win = createFakeDomWindow(chart());

    expect(() => describeFocusedElement(win, [], TRADING_ACTION_NAMES)).toThrow(/unsafe/);
  });
});

describe('clickElement', () => {
  test('refuses unsafe targets with UNSAFE_ACTION_BLOCKED', async () => {
    const { page, input } = pageWith([
      fakeElement({ matches: [BUY], rect: box(300, 250, 80, 30) }),
    ]);

    const error = await failureOf(clickElement(page, BUY));

    expect(error.code).toBe('UNSAFE_ACTION_BLOCKED');
    expect(error.details).toEqual({ selector: BUY });
    expect(error.message).toBe(
      `Refusing to click \`${BUY}\`: it is part of a broker trading control, holds one, or has one over it`,
    );
    expect(error.hint).toEqual(expect.any(String));
    // Not one input event: not even a mouse move over the control.
    expect(input()).toEqual([]);
  });

  test.each(UNSAFE_SELECTORS)('refuses a target that matches %s', async (selector) => {
    const { page, input } = pageWith([fakeElement({ matches: [selector] })]);

    const error = await failureOf(clickElement(page, selector));

    expect(error.code).toBe('UNSAFE_ACTION_BLOCKED');
    expect(input()).toEqual([]);
  });

  test('refuses a target that holds an unsafe control', async () => {
    const toolbar = fakeElement({
      matches: ['[data-name="toolbar"]'],
      children: [fakeElement({ matches: ['[data-name="buy-sell-buttons"]'] })],
    });
    // Without a hit test, so that the structure alone has to refuse it.
    const { page, input } = pageWith([toolbar], { without: ['elementFromPoint'] });

    const error = await failureOf(clickElement(page, '[data-name="toolbar"]'));

    expect(error.code).toBe('UNSAFE_ACTION_BLOCKED');
    expect(error.details).toEqual({ selector: '[data-name="toolbar"]' });
    expect(input()).toEqual([]);
  });

  test('refuses a target that sits inside an unsafe control', async () => {
    const label = fakeElement({ matches: ['[data-name="label"]'] });
    const control = fakeElement({ matches: [TRADE_IN_HEADER], children: [label] });
    // Without a hit test, so that the structure alone has to refuse it.
    const { page, input } = pageWith([control], { without: ['elementFromPoint'] });

    const error = await failureOf(clickElement(page, '[data-name="label"]'));

    expect(error.code).toBe('UNSAFE_ACTION_BLOCKED');
    expect(input()).toEqual([]);
  });

  test('refuses a target with an unsafe control over its center, which would take the click', async () => {
    const ticket = fakeElement({
      matches: ['[data-name="order-ticket"]'],
      rect: box(300, 250, 200, 100),
      children: [fakeElement({ matches: [BUY], rect: box(350, 280, 100, 40) })],
    });
    const { page, input } = pageWith(chart([ticket]));

    const error = await failureOf(clickElement(page, PANE));

    expect(error.code).toBe('UNSAFE_ACTION_BLOCKED');
    expect(error.details).toEqual({ selector: PANE });
    // The control lies over the target, and the message says so that way round.
    expect(error.message).toBe(
      `Refusing to click \`${PANE}\`: it is part of a broker trading control, holds one, or has one over it`,
    );
    expect(input()).toEqual([]);
  });

  test('refuses a target that a dialog or a menu covers, and names what covers it', async () => {
    const menu = fakeElement({
      attributes: { 'data-name': 'context-menu' },
      rect: box(350, 280, 100, 40),
    });
    const { page, sent, input } = pageWith(chart([overlapRoot([menu])]));

    const error = await failureOf(clickElement(page, PANE));

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(error.details).toEqual({ selector: PANE, obscuredBy: 'div[data-name="context-menu"]' });
    expect(error.message).toBe(
      `The element \`${PANE}\` is covered by \`div[data-name="context-menu"]\``,
    );
    expect(error.hint).toBe('Close the dialog or menu that covers it first.');
    // The page was looked at, and not so much as the mouse moved.
    expect(input()).toEqual([]);
    expect(sent.map(({ method }) => method)).toEqual(['Runtime.evaluate']);
  });

  test('refuses a target that a floating order ticket covers, even if the ticket holds no unsafe selector', async () => {
    // A ticket has no stable selector yet, so what covers the target is judged by being a layer of
    // the overlap root and not by what it is.
    const ticket = fakeElement({
      attributes: { 'data-name': 'order-ticket' },
      rect: box(300, 250, 200, 100),
      children: [fakeElement({ tag: 'button', id: 'submit-order', rect: box(350, 280, 100, 40) })],
    });
    const { page, input } = pageWith(chart([overlapRoot([ticket])]));

    const error = await failureOf(clickElement(page, PANE));

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(error.details).toEqual({ selector: PANE, obscuredBy: 'button#submit-order' });
    expect(input()).toEqual([]);
  });

  test.each(['iframe', 'frame', 'object', 'embed'])(
    'refuses a target covered by a <%s>',
    async (tag) => {
      const frame = fakeElement({ tag, id: 'ad', rect: box(350, 280, 100, 40) });
      const { page, input } = pageWith(chart([frame]));

      const error = await failureOf(clickElement(page, PANE));

      expect(error.code).toBe('NOT_AVAILABLE');
      expect(error.details).toEqual({ selector: PANE, obscuredBy: `${tag}#ad` });
      expect(input()).toEqual([]);
    },
  );

  test('clicks a target that an unrelated element is stacked over', async () => {
    const stacked = fakeElement({
      tag: 'canvas',
      matches: ['canvas[data-name="overlay-canvas"]'],
      rect: box(0, 100, 800, 400),
    });
    const { page, input } = pageWith(chart([stacked]));

    await clickElement(page, PANE);

    expect(input()).toHaveLength(3);
  });

  test('reports an unsafe control as unsafe, not as covering, when a layer holds it over the target', async () => {
    const ticket = fakeElement({
      rect: box(300, 250, 200, 100),
      children: [fakeElement({ matches: [BUY], rect: box(350, 280, 100, 40) })],
    });
    const { page, input } = pageWith(chart([overlapRoot([ticket])]));

    const error = await failureOf(clickElement(page, PANE));

    expect(error.code).toBe('UNSAFE_ACTION_BLOCKED');
    expect(input()).toEqual([]);
  });

  test('refuses a target when the page cannot say what lies over it', async () => {
    const { page, sent, input } = pageWith(chart(), { without: ['elementFromPoint'] });

    const error = await failureOf(clickElement(page, SAVE));

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(error.details).toEqual({ selector: SAVE, reason: 'hit-test-unavailable' });
    expect(error.message).toBe(`The page cannot say what lies over \`${SAVE}\``);
    expect(error.hint).toBe(
      'Make sure the target is a loaded TradingView page, not a blank or helper page.',
    );
    expect(input()).toEqual([]);
    expect(sent.map(({ method }) => method)).toEqual(['Runtime.evaluate']);
  });

  test('refuses a target whose center is outside the viewport', async () => {
    const offscreen = fakeElement({
      matches: ['[data-name="offscreen"]'],
      rect: box(900, 50, 200, 20),
    });
    const { page, input } = pageWith([offscreen], { viewport: { width: 1000, height: 700 } });

    const error = await failureOf(clickElement(page, '[data-name="offscreen"]'));

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(error.details).toEqual({
      selector: '[data-name="offscreen"]',
      reason: 'center-outside-viewport',
    });
    expect(error.message).toBe(
      'The center of `[data-name="offscreen"]` is outside the visible part of the page',
    );
    expect(error.hint).toBe('Bring the element into view first.');
    expect(input()).toEqual([]);
  });

  test('refuses an unsafe control that is not shown, rather than reporting it as missing', async () => {
    const { page, input } = pageWith([fakeElement({ matches: [BUY], display: 'none' })]);

    const error = await failureOf(clickElement(page, BUY));

    expect(error.code).toBe('UNSAFE_ACTION_BLOCKED');
    expect(input()).toEqual([]);
  });

  test('dispatches press and release at the element center', async () => {
    const { page, input } = pageWith(chart());

    await expect(clickElement(page, SAVE)).resolves.toBeUndefined();

    // The box is (100, 50) to (140, 70), so its center is (120, 60). The mouse moves there first,
    // so that the page sees the pointer arrive before the button goes down.
    expect(input()).toEqual([
      mouseEvent('mouseMoved', 120, 60),
      mouseEvent('mousePressed', 120, 60),
      mouseEvent('mouseReleased', 120, 60),
    ]);
  });

  test('rounds the center to whole pixels', async () => {
    const { page, input } = pageWith([
      fakeElement({ matches: [SAVE], rect: box(10.4, 20.6, 33, 17) }),
    ]);

    await clickElement(page, SAVE);

    // (26.9, 29.1) becomes (27, 29).
    expect(input()).toEqual([
      mouseEvent('mouseMoved', 27, 29),
      mouseEvent('mousePressed', 27, 29),
      mouseEvent('mouseReleased', 27, 29),
    ]);
  });

  test('clicks the first element that matches', async () => {
    const { page, input } = pageWith([
      fakeElement({ matches: ['.row'], rect: box(0, 0, 10, 10) }),
      fakeElement({ matches: ['.row'], rect: box(100, 100, 10, 10) }),
    ]);

    await clickElement(page, '.row');

    expect(input().map(({ params }) => params)).toEqual([
      { type: 'mouseMoved', x: 5, y: 5 },
      { type: 'mousePressed', x: 5, y: 5, button: 'left', clickCount: 1 },
      { type: 'mouseReleased', x: 5, y: 5, button: 'left', clickCount: 1 },
    ]);
  });

  test('looks at the target before the pointer moves and again before the button goes down', async () => {
    const { page, sent } = pageWith(chart());

    await clickElement(page, SAVE);

    // Each look is the page function, then the zoom of the page, which the point is sent in.
    expect(sent.map(({ method }) => method)).toEqual([
      'Runtime.evaluate',
      'Page.getLayoutMetrics',
      'Input.dispatchMouseEvent',
      'Runtime.evaluate',
      'Page.getLayoutMetrics',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
    ]);
  });

  test('sends the click in device-independent pixels, the CSS pixels of the page times its zoom', async () => {
    // At 125% the center the page reports, (120, 60) in CSS pixels, is (150, 75) in the window.
    const { page, input } = pageWith(chart(), { zoom: 1.25 });

    await clickElement(page, SAVE);

    expect(input()).toEqual([
      mouseEvent('mouseMoved', 150, 75),
      mouseEvent('mousePressed', 150, 75),
      mouseEvent('mouseReleased', 150, 75),
    ]);
  });

  test('sends the click at the CSS pixels of the page at a zoom of 1', async () => {
    const { page, input } = pageWith(chart(), { zoom: 1 });

    await clickElement(page, SAVE);

    expect(input()).toEqual([
      mouseEvent('mouseMoved', 120, 60),
      mouseEvent('mousePressed', 120, 60),
      mouseEvent('mouseReleased', 120, 60),
    ]);
  });

  test('refuses to click, and sends no input, when the page does not report its viewport', async () => {
    // Without the zoom, the point the page judged could not be told in the window, and a click
    // could land on another element.
    const { page, input } = pageWith(chart(), {}, undefined, () => ({}));

    const error = await failureOf(clickElement(page, SAVE));

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(error.message).toBe('The page did not report the size of its viewport');
    expect(input()).toEqual([]);
  });

  describe('when the pointer arriving changes the page', () => {
    test('stops with only the move sent when a trading control opens under the pointer', async () => {
      const win = createFakeDomWindow(chart());
      const buy = fakeElement({ tag: 'button', matches: [BUY], rect: box(100, 50, 40, 20) });
      const { page, types, sent } = pageOver(
        win,
        afterTheMove(() => {
          dom(win).document.elementFromPoint = () => buy;
        }),
      );

      const error = await failureOf(clickElement(page, SAVE));

      expect(error.code).toBe('UNSAFE_ACTION_BLOCKED');
      expect(error.details).toEqual({ selector: SAVE });
      expect(types()).toEqual(['mouseMoved']);
      expect(sent.map(({ method }) => method)).toEqual([
        'Runtime.evaluate',
        'Page.getLayoutMetrics',
        'Input.dispatchMouseEvent',
        'Runtime.evaluate',
      ]);
    });

    test('stops with only the move sent when a menu opens over the target', async () => {
      // The menu item is in the overlap root from the start, but lies elsewhere until the pointer
      // arrives.
      const item = fakeElement({ id: 'menu-item', rect: box(500, 400, 40, 20) });
      const win = createFakeDomWindow(chart([overlapRoot([item])]));
      const { page, types } = pageOver(
        win,
        afterTheMove(() => {
          dom(win).document.elementFromPoint = () => item;
        }),
      );

      const error = await failureOf(clickElement(page, SAVE));

      expect(error.code).toBe('NOT_AVAILABLE');
      expect(error.details).toEqual({ selector: SAVE, obscuredBy: 'div#menu-item' });
      expect(types()).toEqual(['mouseMoved']);
    });

    test('stops with only the move sent when the target is gone', async () => {
      const win = createFakeDomWindow(chart());
      const { page, types } = pageOver(
        win,
        afterTheMove(() => {
          dom(win).document.querySelector = () => null;
        }),
      );

      const error = await failureOf(clickElement(page, SAVE));

      expect(error.code).toBe('NOT_AVAILABLE');
      expect(error.details).toEqual({ selector: SAVE, found: false, visible: false });
      expect(types()).toEqual(['mouseMoved']);
    });

    test('presses at the center the target has after the move, not where it was before', async () => {
      const target = fakeElement({ matches: [SAVE], rect: box(100, 50, 40, 20) });
      const win = createFakeDomWindow([target]);
      const { page, input } = pageOver(
        win,
        afterTheMove(() => {
          target.place(box(300, 80, 40, 20));
        }),
      );

      await clickElement(page, SAVE);

      // The pointer was moved to (120, 60), where the target was. The button goes down where the
      // second lookup found it, (320, 90), which is also the point that lookup judged.
      expect(input().map(({ params }) => params)).toEqual([
        { type: 'mouseMoved', x: 120, y: 60 },
        { type: 'mousePressed', x: 320, y: 90, button: 'left', clickCount: 1 },
        { type: 'mouseReleased', x: 320, y: 90, button: 'left', clickCount: 1 },
      ]);
    });

    test('presses at the zoom the page has after the move, which the second look reads anew', async () => {
      // The page is zoomed to 150% while the pointer arrives. That reflows it: the second look finds
      // the target at a new place in CSS pixels, and the press goes there in DIPs of the new zoom.
      const target = fakeElement({ matches: [SAVE], rect: box(100, 50, 40, 20) });
      const win = createFakeDomWindow([target], { zoom: 1 });
      const { page, input } = pageOver(
        win,
        afterTheMove(() => {
          dom(win).outerWidth = 1280 * 1.5;
          target.place(box(80, 40, 40, 20));
        }),
      );

      await clickElement(page, SAVE);

      // The center (100, 50) times 1.5.
      expect(input().map(({ params }) => params)).toEqual([
        { type: 'mouseMoved', x: 120, y: 60 },
        { type: 'mousePressed', x: 150, y: 75, button: 'left', clickCount: 1 },
        { type: 'mouseReleased', x: 150, y: 75, button: 'left', clickCount: 1 },
      ]);
    });
  });

  test('reports an element that is not there as NOT_AVAILABLE, without any input', async () => {
    const { page, input } = pageWith(chart());

    const error = await failureOf(clickElement(page, '[data-name="missing"]'));

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(error.details).toEqual({
      selector: '[data-name="missing"]',
      found: false,
      visible: false,
    });
    expect(error.message).toBe('No element matches `[data-name="missing"]`');
    expect(error.hint).toEqual(expect.any(String));
    expect(input()).toEqual([]);
  });

  test.each<[string, FakeElementOptions]>([
    ['without a size', { rect: box(10, 10, 0, 0) }],
    ['with display: none', { display: 'none' }],
    ['with visibility: hidden', { visibility: 'hidden' }],
    ['that is not connected', { connected: false }],
  ])('reports an element %s as NOT_AVAILABLE, without any input', async (_label, options) => {
    const { page, input } = pageWith(chart([], options));

    const error = await failureOf(clickElement(page, SAVE));

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(error.details).toEqual({ selector: SAVE, found: true, visible: false });
    expect(error.message).toBe(`The element \`${SAVE}\` is not visible`);
    expect(input()).toEqual([]);
  });

  test('reports a page without a DOM as NOT_AVAILABLE, without any input', async () => {
    const { page, input } = pageOver(createFakeTvWindow(loadTvFixture()));

    const error = await failureOf(clickElement(page, SAVE));

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(input()).toEqual([]);
  });

  test('reports a selector that is not valid CSS as INVALID_INPUT, without any input', async () => {
    const { page, input } = pageWith(chart());

    const error = await failureOf(clickElement(page, '[data-name="open'));

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details).toEqual({ selector: '[data-name="open' });
    expect(input()).toEqual([]);
  });

  test('sends the events one at a time, each after the one before has been answered', async () => {
    const gates: (() => void)[] = [];
    const { page, types } = pageWith(chart(), {}, () => {
      return new Promise((resolve) => {
        gates.push(() => {
          resolve({});
        });
      });
    });

    const click = clickElement(page, SAVE);
    await settle();
    expect(types()).toEqual(['mouseMoved']);

    gates.shift()?.();
    await settle();
    expect(types()).toEqual(['mouseMoved', 'mousePressed']);

    gates.shift()?.();
    await settle();
    expect(types()).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);

    gates.shift()?.();
    await expect(click).resolves.toBeUndefined();
  });

  test.each([
    ['mouseMoved', ['mouseMoved']],
    ['mousePressed', ['mouseMoved', 'mousePressed']],
    ['mouseReleased', ['mouseMoved', 'mousePressed', 'mouseReleased']],
  ])('stops when the %s event fails and passes its error on', async (failing, sentTypes) => {
    const timeout = new TimeoutError('CDP Input.dispatchMouseEvent on PAGE1', 5000);
    const { page, types } = pageWith(chart(), {}, ({ params }) => {
      if ((params as { type: string }).type === failing) {
        throw timeout;
      }
      return {};
    });

    await expect(clickElement(page, SAVE)).rejects.toBe(timeout);

    expect(types()).toEqual(sentTypes);
  });
});

describe('typeText', () => {
  // A page whose focus is on a text field, which is where typeText needs it to be.
  function pageWithFocusedField(handleInput?: (command: SentCommand) => unknown): FakePage {
    const field = fakeElement({ tag: 'input', id: 'symbol-search-input' });
    return pageWith([field], { focus: field }, handleInput);
  }

  test('inserts the text with Input.insertText', async () => {
    const { page, input } = pageWithFocusedField();

    await expect(typeText(page, 'NASDAQ:AAPL')).resolves.toBeUndefined();

    expect(input()).toEqual([{ method: 'Input.insertText', params: { text: 'NASDAQ:AAPL' } }]);
  });

  test.each([
    'two words',
    'a "quoted" line\nand another',
    'é ñ 日本語',
    'emoji 😀',
    '  padded  ',
    '0',
  ])('inserts %j as it is', async (text) => {
    const { page, input } = pageWithFocusedField();

    await typeText(page, text);

    expect(input()).toEqual([{ method: 'Input.insertText', params: { text } }]);
  });

  test('sends nothing, and does not look at the page, for empty text', async () => {
    const { page, sent } = pageWith([]);

    await expect(typeText(page, '')).resolves.toBeUndefined();

    expect(sent).toEqual([]);
  });

  test('passes on the error of the session', async () => {
    const timeout = new TimeoutError('CDP Input.insertText on PAGE1', 5000);
    const { page } = pageWithFocusedField(() => {
      throw timeout;
    });

    await expect(typeText(page, 'x')).rejects.toBe(timeout);
  });

  test('types into a focused search input', async () => {
    const search = fakeElement({
      tag: 'input',
      id: 'symbol-search-input',
      attributes: { type: 'search' },
    });
    const { page, sent } = pageWith([search], { focus: search });

    await typeText(page, 'NASDAQ:AAPL');

    expect(sent.map(({ method }) => method)).toEqual(['Runtime.evaluate', 'Input.insertText']);
  });

  test('types into a contenteditable element', async () => {
    const editor = fakeElement({ id: 'editor', contentEditable: true });
    const { page, sent } = pageWith([editor], { focus: editor });

    await typeText(page, 'plot(close)');

    expect(sent.map(({ method }) => method)).toEqual(['Runtime.evaluate', 'Input.insertText']);
  });

  test('types into a field in a container that holds trading buttons', async () => {
    // What the container holds does not matter, only the field that has the focus.
    const group = fakeElement({
      matches: ['[data-name="buy-sell-buttons"]'],
      children: [fakeElement({ tag: 'button', matches: [BUY] })],
    });
    const field = fakeElement({ tag: 'input', id: 'note' });
    const pane = fakeElement({ matches: ['[data-qa-id="pane"]'], children: [group, field] });
    const { page, sent } = pageWith([pane], { focus: field });

    await typeText(page, 'NASDAQ:AAPL');

    expect(sent.map(({ method }) => method)).toEqual(['Runtime.evaluate', 'Input.insertText']);
  });

  test('refuses when focus is inside a buy-sell control', async () => {
    const field = fakeElement({ tag: 'input', id: 'quantity' });
    const group = fakeElement({ matches: ['[data-name="buy-sell-buttons"]'], children: [field] });
    const { page, sent, input } = pageWith([group], { focus: field });

    const error = await failureOf(typeText(page, 'NASDAQ:AAPL'));

    expect(error.code).toBe('UNSAFE_ACTION_BLOCKED');
    expect(error.details).toEqual({ action: 'typeText', focused: 'input#quantity' });
    expect(error.message).toBe(
      'Refusing to type text: the focus is on `input#quantity`, which is part of a broker trading control',
    );
    expect(error.hint).toEqual(expect.any(String));
    // The focus was looked at, and then nothing was sent to the page.
    expect(input()).toEqual([]);
    expect(sent.map(({ method }) => method)).toEqual(['Runtime.evaluate']);
  });

  test.each(['iframe', 'frame', 'object', 'embed'])(
    'refuses when the focus is on a <%s>, which cannot be looked into',
    async (tag) => {
      const frame = fakeElement({ tag, id: 'ad' });
      const { page, sent, input } = pageWith([frame], { focus: frame });

      const error = await failureOf(typeText(page, 'NASDAQ:AAPL'));

      expect(error.code).toBe('NOT_AVAILABLE');
      expect(error.details).toEqual({ action: 'typeText', focused: `${tag}#ad` });
      expect(error.message).toBe(
        `Cannot type text: the focus is inside \`${tag}#ad\`, which this server cannot look into`,
      );
      expect(error.hint).toBe('Move the focus to an element of the page itself first.');
      expect(input()).toEqual([]);
      expect(sent.map(({ method }) => method)).toEqual(['Runtime.evaluate']);
    },
  );

  test('refuses when the focus is inside a shadow root, which cannot be looked into', async () => {
    // Even if the host is an input, what has the focus is something in its shadow tree.
    const host = fakeElement({
      tag: 'input',
      id: 'host',
      shadowFocus: fakeElement({ tag: 'input' }),
    });
    const { page, input } = pageWith([host], { focus: host });

    const error = await failureOf(typeText(page, 'NASDAQ:AAPL'));

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(error.details).toEqual({ action: 'typeText', focused: 'input#host' });
    expect(input()).toEqual([]);
  });

  test('refuses when focus is not an editable element', async () => {
    // Input.insertText types at the caret, which is only known to be in the focused element when
    // that element is a text field.
    const button = fakeElement({ tag: 'button', id: 'header-toolbar-symbol-search' });
    const pane = fakeElement({
      attributes: { 'data-qa-id': 'pane' },
      children: [fakeElement({ tag: 'input', id: 'inside-the-pane' })],
    });
    const canvas = fakeElement({ tag: 'canvas', attributes: { 'data-name': 'pane-canvas' } });
    const checkbox = fakeElement({ tag: 'input', id: 'agree', attributes: { type: 'checkbox' } });
    const everything = [button, pane, canvas, checkbox];
    const cases: [string, FakeDomOptions, string][] = [
      ['a button', { focus: button }, 'button#header-toolbar-symbol-search'],
      ['the body, which has the focus when nothing else has it', {}, 'body'],
      ['a container that holds a text field', { focus: pane }, 'div[data-qa-id="pane"]'],
      ['a canvas', { focus: canvas }, 'canvas[data-name="pane-canvas"]'],
      ['a checkbox', { focus: checkbox }, 'input#agree'],
      ['no element at all', { focus: null }, ''],
    ];

    for (const [label, options, focused] of cases) {
      const { page, sent, input } = pageWith(everything, options);

      const error = await failureOf(typeText(page, 'NASDAQ:AAPL'));

      expect(error.code, label).toBe('NOT_AVAILABLE');
      expect(error.details, label).toEqual({ action: 'typeText', focused });
      expect(error.message, label).toBe(
        focused === ''
          ? 'Cannot type text: no element has the focus'
          : `Cannot type text: the focus is on \`${focused}\`, which is not a text field`,
      );
      expect(error.hint, label).toBe(
        'Focus a text field first, for example click the symbol search box.',
      );
      expect(input(), label).toEqual([]);
      expect(
        sent.map(({ method }) => method),
        label,
      ).toEqual(['Runtime.evaluate']);
    }
  });

  test('refuses when the focus is on a safe button, even with a trading field on the page', async () => {
    // Chrome types at the caret, and a field keeps the caret when the focus moves on to a button
    // (seen in Chrome 155, also after a real click on a toolbar button), so text could still reach
    // a trading field. Nothing here models a caret. The test shows that no text is sent while the
    // focus is on a button, which is what keeps the text away from such a field.
    const quantity = fakeElement({ tag: 'input', id: 'quantity' });
    const group = fakeElement({
      matches: ['[data-name="buy-sell-buttons"]'],
      children: [quantity],
    });
    const toolbarButton = fakeElement({ tag: 'button', id: 'header-toolbar-symbol-search' });
    const { page, input } = pageWith([group, toolbarButton], { focus: toolbarButton });

    const error = await failureOf(typeText(page, '1000'));

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(input()).toEqual([]);
  });

  test('fails closed without a DOM', async () => {
    const windows = {
      'a document without activeElement': createFakeDomWindow(chart(), {
        without: ['activeElement'],
      }),
      'the shared fake of a chart tab': createFakeTvWindow(loadTvFixture()),
      'a window without a document': {} as unknown as TvWindow,
    };

    for (const [label, win] of Object.entries(windows)) {
      const { page, input } = pageOver(win);

      const error = await failureOf(typeText(page, 'NASDAQ:AAPL'));

      expect(error.code, label).toBe('NOT_AVAILABLE');
      expect(input(), label).toEqual([]);
    }
  });
});

describe('pressKey', () => {
  function keyDown(key: string, code: string, keyCode: number, text?: string, modifiers = 0) {
    return {
      method: 'Input.dispatchKeyEvent',
      params:
        text === undefined
          ? { type: 'rawKeyDown', modifiers, key, code, windowsVirtualKeyCode: keyCode }
          : { type: 'keyDown', modifiers, key, code, windowsVirtualKeyCode: keyCode, text },
    };
  }

  function keyUp(key: string, code: string, keyCode: number, modifiers = 0) {
    return {
      method: 'Input.dispatchKeyEvent',
      params: { type: 'keyUp', modifiers, key, code, windowsVirtualKeyCode: keyCode },
    };
  }

  test("sends keyDown and keyUp with Enter's key codes", async () => {
    const { page, input } = pageWith([]);

    await expect(pressKey(page, 'Enter')).resolves.toBeUndefined();

    expect(input()).toEqual([keyDown('Enter', 'Enter', 13, '\r'), keyUp('Enter', 'Enter', 13)]);
  });

  test.each([
    ['Escape', 27],
    ['Tab', 9],
    ['Backspace', 8],
    ['Delete', 46],
    ['ArrowLeft', 37],
    ['ArrowUp', 38],
    ['ArrowRight', 39],
    ['ArrowDown', 40],
    ['PageUp', 33],
    ['PageDown', 34],
    ['End', 35],
    ['Home', 36],
  ])('sends %s as a raw key with virtual key code %i and no text', async (key, keyCode) => {
    const { page, input } = pageWith([]);

    await pressKey(page, key);

    expect(input()).toEqual([keyDown(key, key, keyCode), keyUp(key, key, keyCode)]);
  });

  test.each(
    Array.from({ length: 26 }, (_, index): [string, number] => [
      String.fromCharCode(97 + index),
      65 + index,
    ]),
  )(
    'sends the letter %s with virtual key code %i, and its upper case form likewise',
    async (letter, keyCode) => {
      const { page, input } = pageWith([]);
      const upper = letter.toUpperCase();
      const code = `Key${upper}`;

      await pressKey(page, letter);
      await pressKey(page, upper);

      expect(input()).toEqual([
        keyDown(letter, code, keyCode, letter),
        keyUp(letter, code, keyCode),
        keyDown(upper, code, keyCode, upper),
        keyUp(upper, code, keyCode),
      ]);
    },
  );

  test.each(
    Array.from({ length: 10 }, (_, index): [string, number] => [String(index), 48 + index]),
  )('sends the digit %s with virtual key code %i', async (digit, keyCode) => {
    const { page, input } = pageWith([]);

    await pressKey(page, digit);

    expect(input()).toEqual([
      keyDown(digit, `Digit${digit}`, keyCode, digit),
      keyUp(digit, `Digit${digit}`, keyCode),
    ]);
  });

  test.each<[KeyModifier[], number]>([
    [[], 0],
    [['Alt'], 1],
    [['Control'], 2],
    [['Meta'], 4],
    [['Shift'], 8],
    [['Control', 'Shift'], 10],
    [['Shift', 'Control'], 10],
    [['Alt', 'Meta'], 5],
    [['Alt', 'Control', 'Meta', 'Shift'], 15],
  ])('sends the modifiers %j as the bit field %i on both events', async (modifiers, mask) => {
    const { page, input } = pageWith([]);

    await pressKey(page, 'Escape', modifiers);

    expect(input()).toEqual([
      keyDown('Escape', 'Escape', 27, undefined, mask),
      keyUp('Escape', 'Escape', 27, mask),
    ]);
  });

  test('counts a modifier once, however often it is listed', async () => {
    const { page, input } = pageWith([]);

    await pressKey(page, 'Tab', ['Shift', 'Shift', 'Control', 'Shift']);

    expect(input()).toEqual([keyDown('Tab', 'Tab', 9, undefined, 10), keyUp('Tab', 'Tab', 9, 10)]);
  });

  test('upper-cases a letter held with Shift, the way a keyboard does', async () => {
    const { page, input } = pageWith([]);

    await pressKey(page, 'a', ['Shift']);
    await pressKey(page, 'A', ['Shift']);

    expect(input()).toEqual([
      keyDown('A', 'KeyA', 65, 'A', 8),
      keyUp('A', 'KeyA', 65, 8),
      keyDown('A', 'KeyA', 65, 'A', 8),
      keyUp('A', 'KeyA', 65, 8),
    ]);
  });

  test('leaves a digit as it is under Shift, because the symbol depends on the keyboard layout', async () => {
    const { page, input } = pageWith([]);

    await pressKey(page, '1', ['Shift']);

    expect(input()).toEqual([keyDown('1', 'Digit1', 49, '1', 8), keyUp('1', 'Digit1', 49, 8)]);
  });

  test.each<[string, KeyModifier[], number, string]>([
    ['Control', ['Control'], 2, 'a'],
    ['Alt', ['Alt'], 1, 'a'],
    ['Meta', ['Meta'], 4, 'a'],
    ['Control and Shift', ['Control', 'Shift'], 10, 'A'],
  ])(
    'sends a letter held with %s as a shortcut, without text to type',
    async (_label, modifiers, mask, key) => {
      const { page, input } = pageWith([]);

      await pressKey(page, 'a', modifiers);

      expect(input()).toEqual([
        keyDown(key, 'KeyA', 65, undefined, mask),
        keyUp(key, 'KeyA', 65, mask),
      ]);
    },
  );

  test('sends Enter and a digit held with Control without text, and Enter with Shift with it', async () => {
    const { page, input } = pageWith([]);

    await pressKey(page, 'Enter', ['Control']);
    await pressKey(page, '5', ['Alt']);
    await pressKey(page, 'Enter', ['Shift']);

    expect(input()).toEqual([
      keyDown('Enter', 'Enter', 13, undefined, 2),
      keyUp('Enter', 'Enter', 13, 2),
      keyDown('5', 'Digit5', 53, undefined, 1),
      keyUp('5', 'Digit5', 53, 1),
      keyDown('Enter', 'Enter', 13, '\r', 8),
      keyUp('Enter', 'Enter', 13, 8),
    ]);
  });

  test.each([
    '',
    'F5',
    'enter',
    'ENTER',
    'Esc',
    'Return',
    'ab',
    '10',
    ' ',
    'Space',
    'é',
    // Letters that a case-insensitive match would take for 's' and 'k': the long s and the Kelvin sign.
    '\u017f',
    '\u212a',
    '😀',
    'Control',
    'Shift',
    'constructor',
    '__proto__',
    'toString',
    'hasOwnProperty',
  ])('rejects the key %j with INVALID_INPUT, before it looks at the page', async (key) => {
    const { page, sent } = pageWith([]);

    const error = await failureOf(pressKey(page, key));

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details).toEqual({ key });
    expect(sent).toEqual([]);
  });

  test('lists the supported keys when it rejects one', async () => {
    const { page } = pageWith([]);

    const error = await failureOf(pressKey(page, 'F5'));

    expect(error.message).toContain('`F5`');
    for (const supported of [
      'Enter',
      'Escape',
      'Tab',
      'Backspace',
      'Delete',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Home',
      'End',
      'PageUp',
      'PageDown',
      'a-z',
      'A-Z',
      '0-9',
    ]) {
      expect(error.hint, supported).toContain(supported);
    }
  });

  test.each([['Ctrl'], ['shift'], ['constructor'], ['__proto__'], ['']])(
    'rejects the modifier %j with INVALID_INPUT, before it looks at the page',
    async (modifier) => {
      const { page, sent } = pageWith([]);

      const error = await failureOf(pressKey(page, 'a', ['Shift', modifier as KeyModifier]));

      expect(error.code).toBe('INVALID_INPUT');
      expect(error.message).toBe(`Unsupported modifier \`${modifier}\``);
      expect(error.hint).toContain('Alt, Control, Meta or Shift');
      expect(error.details).toEqual({ modifier });
      expect(sent).toEqual([]);
    },
  );

  test('sends keyUp only after keyDown has been answered', async () => {
    const gates: (() => void)[] = [];
    const { page, types } = pageWith([], {}, () => {
      return new Promise((resolve) => {
        gates.push(() => {
          resolve({});
        });
      });
    });

    const press = pressKey(page, 'Enter');
    await settle();
    expect(types()).toEqual(['keyDown']);

    gates.shift()?.();
    await settle();
    expect(types()).toEqual(['keyDown', 'keyUp']);

    gates.shift()?.();
    await expect(press).resolves.toBeUndefined();
  });

  test('passes on the error of the session', async () => {
    const timeout = new TimeoutError('CDP Input.dispatchKeyEvent on PAGE1', 5000);
    const { page } = pageWith([], {}, () => {
      throw timeout;
    });

    await expect(pressKey(page, 'Enter')).rejects.toBe(timeout);
  });

  test('refuses when a trading button has focus', async () => {
    const buy = fakeElement({
      tag: 'button',
      matches: [BUY],
      attributes: { 'data-name': 'buy-order-button' },
    });
    const { page, sent, input } = pageWith([buy], { focus: buy });

    const error = await failureOf(pressKey(page, 'Enter'));

    expect(error.code).toBe('UNSAFE_ACTION_BLOCKED');
    expect(error.details).toEqual({
      action: 'pressKey',
      focused: 'button[data-name="buy-order-button"]',
    });
    expect(error.message).toBe(
      'Refusing to press a key: the focus is on `button[data-name="buy-order-button"]`, which is part of a broker trading control',
    );
    expect(error.hint).toEqual(expect.any(String));
    // Not a key down, and no key up either: the focus was looked at, and that is all.
    expect(input()).toEqual([]);
    expect(sent.map(({ method }) => method)).toEqual(['Runtime.evaluate']);
  });

  test('proceeds when focus is on a container that holds trading buttons', async () => {
    // The pane of the chart holds the buy and sell buttons shown on it. Keys go to the pane and
    // not to the buttons, so they are not refused. Refusing them would refuse every key aimed at
    // the chart.
    const group = fakeElement({
      matches: ['[data-name="buy-sell-buttons"]'],
      children: [
        fakeElement({ tag: 'button', matches: [BUY] }),
        fakeElement({ tag: 'button', matches: ['[data-name="sell-order-button"]'] }),
      ],
    });
    const pane = fakeElement({ matches: ['[data-qa-id="pane"]'], children: [group] });
    const { page, sent, input } = pageWith([pane], { focus: pane });

    await pressKey(page, 'Escape');

    expect(sent.map(({ method }) => method)).toEqual([
      'Runtime.evaluate',
      'Input.dispatchKeyEvent',
      'Input.dispatchKeyEvent',
    ]);
    expect(input().map(({ params }) => (params as { type: string }).type)).toEqual([
      'rawKeyDown',
      'keyUp',
    ]);
  });

  test.each(['iframe', 'frame', 'object', 'embed'])(
    'refuses when the focus is on a <%s>, which cannot be looked into',
    async (tag) => {
      const frame = fakeElement({ tag, id: 'ad' });
      const { page, sent, input } = pageWith([frame], { focus: frame });

      const error = await failureOf(pressKey(page, 'Enter'));

      expect(error.code).toBe('NOT_AVAILABLE');
      expect(error.details).toEqual({ action: 'pressKey', focused: `${tag}#ad` });
      expect(error.message).toBe(
        `Cannot press a key: the focus is inside \`${tag}#ad\`, which this server cannot look into`,
      );
      expect(error.hint).toBe('Move the focus to an element of the page itself first.');
      expect(input()).toEqual([]);
      expect(sent.map(({ method }) => method)).toEqual(['Runtime.evaluate']);
    },
  );

  test('refuses when the focus is inside a shadow root, which cannot be looked into', async () => {
    const host = fakeElement({ id: 'host', shadowFocus: fakeElement({ tag: 'button' }) });
    const { page, input } = pageWith([host], { focus: host });

    const error = await failureOf(pressKey(page, 'Enter'));

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(error.details).toEqual({ action: 'pressKey', focused: 'div#host' });
    expect(input()).toEqual([]);
  });

  test('refuses a shortcut as well', async () => {
    const buy = fakeElement({ tag: 'button', matches: [BUY] });
    const { page, input } = pageWith([buy], { focus: buy });

    const error = await failureOf(pressKey(page, 'b', ['Alt', 'Shift']));

    expect(error.code).toBe('UNSAFE_ACTION_BLOCKED');
    expect(input()).toEqual([]);
  });

  test('proceeds when the chart canvas has focus', async () => {
    const canvas = fakeElement({
      tag: 'canvas',
      matches: [PANE],
      attributes: { 'data-name': 'pane-canvas' },
    });
    // A trading control elsewhere on the page does not matter: only what has the focus does.
    const ticket = fakeElement({ matches: [BUY], rect: box(900, 20, 60, 30) });
    const { page, sent, input } = pageWith([canvas, ticket], { focus: canvas });

    await pressKey(page, 'Enter');

    expect(sent.map(({ method }) => method)).toEqual([
      'Runtime.evaluate',
      'Input.dispatchKeyEvent',
      'Input.dispatchKeyEvent',
    ]);
    expect(input()).toEqual([keyDown('Enter', 'Enter', 13, '\r'), keyUp('Enter', 'Enter', 13)]);
  });

  test('proceeds when nothing is focused, which is the body', async () => {
    const { page, input } = pageWith(chart([fakeElement({ matches: [BUY] })]));

    await pressKey(page, 'Escape');

    expect(input()).toHaveLength(2);
  });

  test('fails closed without a DOM', async () => {
    const windows = {
      'a document without activeElement': createFakeDomWindow(chart(), {
        without: ['activeElement'],
      }),
      'the shared fake of a chart tab': createFakeTvWindow(loadTvFixture()),
      'a window without a document': {} as unknown as TvWindow,
    };

    for (const [label, win] of Object.entries(windows)) {
      const { page, input } = pageOver(win);

      const error = await failureOf(pressKey(page, 'Enter'));

      expect(error.code, label).toBe('NOT_AVAILABLE');
      expect(input(), label).toEqual([]);
    }
  });
});

describe('keys and text while a trading control has the focus', () => {
  const actions: [string, (page: InputPage) => Promise<void>][] = [
    ['pressKey', (page) => pressKey(page, 'Enter')],
    ['typeText', (page) => typeText(page, 'x')],
  ];
  const cases = actions.flatMap(([action, run]) =>
    UNSAFE_SELECTORS.map((selector): [string, string, (page: InputPage) => Promise<void>] => [
      action,
      selector,
      run,
    ]),
  );

  test.each(cases)(
    '%s refuses a focused element that matches %s',
    async (action, selector, run) => {
      const control = fakeElement({ matches: [selector] });
      const { page, input } = pageWith([control], { focus: control });

      const error = await failureOf(run(page));

      expect(error.code).toBe('UNSAFE_ACTION_BLOCKED');
      expect(error.details).toMatchObject({ action });
      expect(input()).toEqual([]);
    },
  );

  test('say that a trading control is unsafe even when the focus is in a frame inside it', async () => {
    const frame = fakeElement({ tag: 'iframe', id: 'ad' });
    const group = fakeElement({ matches: ['[data-name="buy-sell-buttons"]'], children: [frame] });
    const { page, input } = pageWith([group], { focus: frame });

    const key = await failureOf(pressKey(page, 'Enter'));
    const text = await failureOf(typeText(page, 'x'));

    expect(key.code).toBe('UNSAFE_ACTION_BLOCKED');
    expect(text.code).toBe('UNSAFE_ACTION_BLOCKED');
    expect(input()).toEqual([]);
  });

  test('look at the focus again for every key and every text', async () => {
    const canvas = fakeElement({ tag: 'canvas', matches: [PANE] });
    const buy = fakeElement({ tag: 'button', matches: [BUY] });
    const field = fakeElement({ tag: 'input', id: 'symbol-search-input' });
    const win = createFakeDomWindow([canvas, buy, field], { focus: canvas });
    const { page, input } = pageOver(win);

    await pressKey(page, 'Escape');
    dom(win).document.activeElement = buy;
    const refusedKey = await failureOf(pressKey(page, 'Escape'));
    const refusedText = await failureOf(typeText(page, 'x'));
    dom(win).document.activeElement = field;
    await typeText(page, 'x');

    expect(refusedKey.details).toMatchObject({ action: 'pressKey' });
    expect(refusedText.details).toMatchObject({ action: 'typeText' });
    expect(input().map(({ method }) => method)).toEqual([
      'Input.dispatchKeyEvent',
      'Input.dispatchKeyEvent',
      'Input.insertText',
    ]);
  });
});

describe('one call at a time per page', () => {
  const methods = (sent: SentCommand[]) => sent.map(({ method }) => method);

  // A session that answers an input event only when the test says so, to hold a call in the
  // middle of its events.
  function gatedPage(elements: FakeElement[] = [], options: FakeDomOptions = {}) {
    const gates: (() => void)[] = [];
    const answers = pageWith(elements, options, () => {
      return new Promise((resolve) => {
        gates.push(() => {
          resolve({});
        });
      });
    });
    return { ...answers, answerNext: () => gates.shift()?.() };
  }

  test('does not start the lookup of a second key press before the first has sent its last event', async () => {
    const { page, sent, answerNext } = gatedPage();

    // The second key is Enter, which lands on whatever the first key leaves the focus on.
    const tab = pressKey(page, 'Tab');
    const enter = pressKey(page, 'Enter');
    await settle();
    expect(methods(sent)).toEqual(['Runtime.evaluate', 'Input.dispatchKeyEvent']);

    answerNext();
    await settle();
    expect(methods(sent)).toEqual([
      'Runtime.evaluate',
      'Input.dispatchKeyEvent',
      'Input.dispatchKeyEvent',
    ]);

    // Only when the last event of the first call has been answered does the second call begin.
    answerNext();
    await settle();
    expect(methods(sent)).toEqual([
      'Runtime.evaluate',
      'Input.dispatchKeyEvent',
      'Input.dispatchKeyEvent',
      'Runtime.evaluate',
      'Input.dispatchKeyEvent',
    ]);

    answerNext();
    await settle();
    answerNext();
    await Promise.all([tab, enter]);
    expect(methods(sent)).toEqual([
      'Runtime.evaluate',
      'Input.dispatchKeyEvent',
      'Input.dispatchKeyEvent',
      'Runtime.evaluate',
      'Input.dispatchKeyEvent',
      'Input.dispatchKeyEvent',
    ]);
  });

  test('runs a click, a key press and a text one after the other, in the order they were made', async () => {
    const button = fakeElement({ matches: [SAVE], rect: box(100, 50, 40, 20) });
    const field = fakeElement({ tag: 'input', id: 'symbol-search-input' });
    const { page, sent } = pageWith([button, field], { focus: field });

    await Promise.all([
      clickElement(page, SAVE),
      pressKey(page, 'Escape'),
      typeText(page, 'NASDAQ:AAPL'),
    ]);

    expect(methods(sent)).toEqual([
      // The click: its lookup and the zoom, the move, its second lookup and the zoom, the press and
      // the release.
      'Runtime.evaluate',
      'Page.getLayoutMetrics',
      'Input.dispatchMouseEvent',
      'Runtime.evaluate',
      'Page.getLayoutMetrics',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      // The key press: the focus, then down and up.
      'Runtime.evaluate',
      'Input.dispatchKeyEvent',
      'Input.dispatchKeyEvent',
      // The text: the focus, then the text.
      'Runtime.evaluate',
      'Input.insertText',
    ]);
  });

  test('keeps the order of the calls, three key presses', async () => {
    const { page, input } = pageWith([]);

    await Promise.all([pressKey(page, 'Tab'), pressKey(page, 'Enter'), pressKey(page, 'Escape')]);

    expect(input().map(({ params }) => (params as { key: string }).key)).toEqual([
      'Tab',
      'Tab',
      'Enter',
      'Enter',
      'Escape',
      'Escape',
    ]);
  });

  test('lets the next call run when a call fails on an event', async () => {
    const timeout = new TimeoutError('CDP Input.dispatchKeyEvent on PAGE1', 5000);
    let failTheFirstEvent = true;
    const { page, sent } = pageWith([], {}, () => {
      if (failTheFirstEvent) {
        failTheFirstEvent = false;
        throw timeout;
      }
      return {};
    });

    const first = pressKey(page, 'Enter');
    const second = pressKey(page, 'Escape');

    await expect(first).rejects.toBe(timeout);
    await expect(second).resolves.toBeUndefined();
    expect(methods(sent)).toEqual([
      'Runtime.evaluate',
      'Input.dispatchKeyEvent',
      'Runtime.evaluate',
      'Input.dispatchKeyEvent',
      'Input.dispatchKeyEvent',
    ]);
  });

  test('lets the next call run when a call is refused at its lookup', async () => {
    const { page, input } = pageWith(chart());

    const refused = failureOf(clickElement(page, '[data-name="missing"]'));
    const key = pressKey(page, 'Escape');

    expect((await refused).code).toBe('NOT_AVAILABLE');
    await expect(key).resolves.toBeUndefined();
    expect(input()).toHaveLength(2);
  });

  test('lets the next call run when a click is refused for a trading control', async () => {
    const { page, input } = pageWith([
      fakeElement({ matches: [BUY], rect: box(300, 250, 80, 30) }),
      fakeElement({ matches: [SAVE], rect: box(100, 50, 40, 20) }),
    ]);

    const refused = failureOf(clickElement(page, BUY));
    const click = clickElement(page, SAVE);

    expect((await refused).code).toBe('UNSAFE_ACTION_BLOCKED');
    await expect(click).resolves.toBeUndefined();
    expect(input()).toHaveLength(3);
  });

  test('does not make the calls of another page wait', async () => {
    const busy = gatedPage();
    const other = pageWith([]);

    const stuck = pressKey(busy.page, 'Tab');
    await settle();
    // The first page is held in the middle of its events. The other page does not care.
    await pressKey(other.page, 'Enter');

    expect(methods(busy.sent)).toEqual(['Runtime.evaluate', 'Input.dispatchKeyEvent']);
    expect(other.input()).toHaveLength(2);

    busy.answerNext();
    await settle();
    busy.answerNext();
    await stuck;
  });

  test('queues the calls of two handles that share a session', async () => {
    const { page, sent, answerNext } = gatedPage();
    const sameSession: InputPage = { session: page.session, bridge: page.bridge };

    const first = pressKey(page, 'Tab');
    const second = pressKey(sameSession, 'Enter');
    await settle();
    expect(methods(sent)).toEqual(['Runtime.evaluate', 'Input.dispatchKeyEvent']);

    answerNext();
    await settle();
    answerNext();
    await settle();
    answerNext();
    await settle();
    answerNext();
    await Promise.all([first, second]);
  });

  test('does not queue empty text, or a key that cannot be sent, behind a call in progress', async () => {
    const { page, answerNext } = gatedPage();

    const stuck = pressKey(page, 'Tab');
    await settle();
    // Neither of these touches the page, so neither has to wait for the call that holds it.
    await expect(typeText(page, '')).resolves.toBeUndefined();
    const refused = await failureOf(pressKey(page, 'F5'));

    expect(refused.code).toBe('INVALID_INPUT');
    answerNext();
    await settle();
    answerNext();
    await stuck;
  });
});

// The pointer tools: a click, a hover and a scroll at an element, an element named by its text, or
// a point, all through the same look at the target.

const VIEWPORT = { width: 1280, height: 720 };
const TRADING_HINT =
  'Trading controls are off limits to this server. Place orders in the TradingView window yourself.';

// What a real page has under everything else, its html element, which every point of the viewport
// hits at least.
function background(): FakeElement {
  return fakeElement({ tag: 'html', rect: box(0, 0, VIEWPORT.width, VIEWPORT.height) });
}

// A page of the viewport's size with the header button and the pane of the chart, plus what
// `extra` builds. A maker, so that every window gets elements of its own.
function screen(
  extra: () => FakeElement[] = () => [],
  options: FakeDomOptions = {},
): () => TvWindow {
  return () =>
    createFakeDomWindow([background(), ...chart(), ...extra()], {
      viewport: VIEWPORT,
      ...options,
    });
}

// The buy button with a label in it, over the pane: its label covers (310, 255) to (350, 275), and
// the rest of the button the box around it.
function buyButton(attributes: Record<string, string> = {}): FakeElement {
  return fakeElement({
    tag: 'button',
    matches: [BUY],
    attributes,
    rect: box(300, 250, 80, 30),
    children: [fakeElement({ tag: 'span', rect: box(310, 255, 40, 20) })],
  });
}

// A menu of the overlap root, with its item where a point in the middle of the pane lands.
function openMenu(): FakeElement {
  return overlapRoot([fakeElement({ id: 'menu-item', rect: box(350, 280, 100, 40) })]);
}

// The pane of the chart as TradingView builds it: it holds the buy and sell buttons, which lie away
// from its center.
function paneWithTradingButtons(): FakeElement {
  return fakeElement({
    matches: ['[data-qa-id="pane"]'],
    rect: box(0, 100, 800, 400),
    children: [
      fakeElement({
        matches: ['[data-name="buy-sell-buttons"]'],
        rect: box(20, 110, 160, 40),
        children: [fakeElement({ tag: 'button', matches: [BUY], rect: box(100, 115, 70, 30) })],
      }),
    ],
  });
}

// A page function run the way the server runs it, as source text through the real bridge, and
// called directly on a second window built the same way. The two answers must agree.
async function bothWays<A extends JsonValue[], R extends JsonValue | null>(
  fn: PageFunction<A, R>,
  args: A,
  make: () => TvWindow,
): Promise<R> {
  const result = await pageOver(make()).page.bridge.evaluate(fn, args);
  expect(await fn(make(), ...args)).toEqual(result);
  return result;
}

// A failure the page function reports with a sentinel: the bridge turns it into the error, and a
// direct call returns the sentinel itself.
async function failureBothWays<A extends JsonValue[], R extends JsonValue | null>(
  fn: PageFunction<A, R>,
  args: A,
  make: () => TvWindow,
): Promise<TvMcpError> {
  const error = await failureOf(pageOver(make()).page.bridge.evaluate(fn, args));
  expect(await fn(make(), ...args)).toEqual({ __tvmcpError: error.toPayload() });
  return error;
}

const methodsOf = (sent: SentCommand[]) => sent.map(({ method }) => method);

// The arguments of a page function after the window, as the bridge takes them.
type ArgsOf<F> = F extends (win: TvWindow, ...args: infer A) => unknown ? A : never;

describe('describeElement with a point', () => {
  const at = (
    x: number,
    y: number,
    action: PointerAction = 'click',
  ): ArgsOf<typeof describeElement> => [
    { x, y },
    [...UNSAFE_SELECTORS],
    [OVERLAP_ROOT],
    TRADING_ACTION_NAMES,
    action,
    false,
  ];

  test('judges what lies at a point, which is the target itself', async () => {
    const result = await bothWays(describeElement, [...at(120, 60)], screen());

    // A point has no box: the page judges the point it was given.
    expect(result).toEqual({
      found: true,
      visible: true,
      unsafe: false,
      coverage: 'clear',
      obscuredBy: '',
    });
  });

  test('flags a point over a trading control, and over a part of one', async () => {
    const make = screen(() => [buyButton()]);

    // On the label inside the button, and on the button beside the label.
    expect(await bothWays(describeElement, [...at(320, 260)], make)).toMatchObject({
      unsafe: true,
      coverage: 'not-checked',
    });
    expect(await bothWays(describeElement, [...at(370, 270)], make)).toMatchObject({
      unsafe: true,
    });
  });

  test('flags a point on a container that holds a trading control for a click, and not for a hover or a scroll', async () => {
    // The element at the point is the target of a click there, and a click is refused on a target
    // that holds a trading control, as it is when a selector names the container. The pointer over
    // the container lands on the container, so a hover or a scroll only minds what is at the point.
    const toolbar = () =>
      fakeElement({
        attributes: { 'data-name': 'toolbar' },
        rect: box(0, 0, 1280, 40),
        children: [fakeElement({ matches: [BUY], rect: box(700, 5, 60, 30) })],
      });
    const make = screen(() => [toolbar()]);

    expect(await bothWays(describeElement, [...at(100, 20)], make)).toMatchObject({
      unsafe: true,
      coverage: 'not-checked',
    });
    expect(await bothWays(describeElement, [...at(100, 20, 'hover')], make)).toMatchObject({
      unsafe: false,
      coverage: 'clear',
    });
    expect(await bothWays(describeElement, [...at(100, 20, 'scroll')], make)).toMatchObject({
      unsafe: false,
      coverage: 'clear',
    });
  });

  test('does not flag a point on the chart canvas, which holds nothing, beside a trading control', async () => {
    // The buy button lies over the pane, at (300, 250) to (380, 280); (100, 400) is on the canvas.
    const result = await bothWays(
      describeElement,
      [...at(100, 400)],
      screen(() => [buyButton()]),
    );

    expect(result).toEqual({
      found: true,
      visible: true,
      unsafe: false,
      coverage: 'clear',
      obscuredBy: '',
    });
  });

  test('reports a point in a layer of the overlap root as obscured, whatever the layer is', async () => {
    const result = await bothWays(
      describeElement,
      [...at(400, 300)],
      screen(() => [openMenu()]),
    );

    // The point is not on any element the caller named, so a menu there is what would be clicked,
    // and what it is cannot be told.
    expect(result).toEqual({
      found: true,
      visible: true,
      unsafe: false,
      coverage: 'obscured',
      obscuredBy: 'div#menu-item',
    });
  });

  test('does not count a point on the overlap root itself as covered', async () => {
    const portal = () => overlapRoot([], box(0, 0, VIEWPORT.width, VIEWPORT.height));

    const result = await bothWays(
      describeElement,
      [...at(600, 600)],
      screen(() => [portal()]),
    );

    expect(result).toMatchObject({ coverage: 'clear', obscuredBy: '' });
  });

  test.each(['iframe', 'frame', 'object', 'embed'])(
    'reports a point on a <%s> as obscured',
    async (tag) => {
      const frame = () => fakeElement({ tag, id: 'ad', rect: box(350, 280, 100, 40) });

      const result = await bothWays(
        describeElement,
        [...at(400, 300)],
        screen(() => [frame()]),
      );

      expect(result).toMatchObject({
        unsafe: false,
        coverage: 'obscured',
        obscuredBy: `${tag}#ad`,
      });
    },
  );

  test('reports a point outside the viewport', async () => {
    const result = await bothWays(describeElement, [...at(1300, 10)], screen());

    expect(result).toMatchObject({ unsafe: false, coverage: 'center-outside-viewport' });
  });

  test('reports that a point cannot be judged when the page cannot say what lies there', async () => {
    const make = screen(() => [buyButton()], { without: ['elementFromPoint'] });

    const result = await bothWays(describeElement, [...at(320, 260)], make);

    expect(result).toMatchObject({ unsafe: false, coverage: 'hit-test-unavailable' });
  });

  test('returns NOT_AVAILABLE for a point on a page without a DOM', async () => {
    const error = await failureBothWays(
      describeElement,
      [...at(120, 60)],
      screen(() => [], { without: ['querySelector'] }),
    );

    expect(error.code).toBe('NOT_AVAILABLE');
  });
});

describe('describeElement with a text', () => {
  const named = (text: string, action: PointerAction = 'click'): ArgsOf<typeof describeElement> => [
    { text },
    [...UNSAFE_SELECTORS],
    [OVERLAP_ROOT],
    TRADING_ACTION_NAMES,
    action,
    false,
  ];
  const notFound = {
    found: false,
    visible: false,
    unsafe: false,
    coverage: 'not-checked',
    obscuredBy: '',
  };

  test('finds the visible element whose aria-label is the text, ignoring case', async () => {
    const button = () =>
      fakeElement({
        tag: 'button',
        attributes: { 'aria-label': 'Save layout' },
        rect: box(500, 10, 30, 30),
      });

    const result = await bothWays(
      describeElement,
      [...named('save LAYOUT')],
      screen(() => [button()]),
    );

    expect(result).toEqual({
      found: true,
      visible: true,
      unsafe: false,
      coverage: 'clear',
      obscuredBy: '',
      rect: box(500, 10, 30, 30),
    });
  });

  test('names an element without an aria-label by its text, trimmed', async () => {
    const label = () =>
      fakeElement({ tag: 'span', text: '  Indicators  ', rect: box(600, 10, 60, 20) });

    const result = await bothWays(
      describeElement,
      [...named('indicators')],
      screen(() => [label()]),
    );

    expect(result).toMatchObject({ found: true, rect: box(600, 10, 60, 20) });
  });

  test('takes the first visible element in document order when several have the name', async () => {
    const apply = (rect: FakeRect, options: FakeElementOptions = {}) =>
      fakeElement({ tag: 'button', text: 'Apply', rect, ...options });
    const both = () => [apply(box(100, 600, 40, 20)), apply(box(300, 600, 40, 20))];
    const firstHidden = () => [
      apply(box(100, 600, 40, 20), { display: 'none' }),
      apply(box(300, 600, 40, 20)),
    ];
    // A wrapper whose whole text is the name comes before the element inside it.
    const wrapped = () => [
      fakeElement({
        attributes: { 'data-name': 'wrapper' },
        rect: box(100, 600, 60, 24),
        children: [fakeElement({ tag: 'span', text: 'Apply', rect: box(105, 602, 40, 20) })],
      }),
    ];

    expect(await bothWays(describeElement, [...named('Apply')], screen(both))).toMatchObject({
      rect: box(100, 600, 40, 20),
    });
    expect(await bothWays(describeElement, [...named('Apply')], screen(firstHidden))).toMatchObject(
      { rect: box(300, 600, 40, 20) },
    );
    expect(await bothWays(describeElement, [...named('Apply')], screen(wrapped))).toMatchObject({
      rect: box(100, 600, 60, 24),
    });
  });

  test('names an element that has an aria-label by it, and not by its text', async () => {
    const close = () =>
      fakeElement({
        tag: 'button',
        attributes: { 'aria-label': 'Close' },
        text: '×',
        rect: box(700, 10, 20, 20),
      });

    expect(
      await bothWays(
        describeElement,
        [...named('×')],
        screen(() => [close()]),
      ),
    ).toEqual(notFound);
    expect(
      await bothWays(
        describeElement,
        [...named('close')],
        screen(() => [close()]),
      ),
    ).toMatchObject({ found: true });
  });

  test('names an element that nothing else names by its title, as browsers do, and no other by it', async () => {
    const buttons = () => [
      // Named by its title alone: no aria-label, no value, no text.
      fakeElement({
        tag: 'button',
        attributes: { title: 'Indicators' },
        rect: box(600, 10, 30, 30),
        children: [fakeElement({ tag: 'svg', rect: box(605, 15, 20, 20) })],
      }),
      // Its text names it, so its title does not.
      fakeElement({
        tag: 'button',
        attributes: { title: 'Compare symbols' },
        text: 'Compare',
        rect: box(700, 10, 60, 30),
      }),
    ];

    expect(
      await bothWays(describeElement, [...named('indicators')], screen(buttons)),
    ).toMatchObject({ found: true, rect: box(600, 10, 30, 30) });
    expect(await bothWays(describeElement, [...named('compare symbols')], screen(buttons))).toEqual(
      notFound,
    );
    expect(await bothWays(describeElement, [...named('compare')], screen(buttons))).toMatchObject({
      found: true,
      rect: box(700, 10, 60, 30),
    });
  });

  test('names a field by its aria-label alone, never by what it holds', async () => {
    const fields = () => [
      fakeElement({ tag: 'textarea', text: 'a note of the user', rect: box(10, 600, 200, 60) }),
      fakeElement({
        tag: 'input',
        attributes: { 'aria-label': 'Quantity' },
        rect: box(300, 600, 80, 20),
      }),
    ];

    expect(
      await bothWays(describeElement, [...named('a note of the user')], screen(fields)),
    ).toEqual(notFound);
    expect(await bothWays(describeElement, [...named('quantity')], screen(fields))).toMatchObject({
      found: true,
      rect: box(300, 600, 80, 20),
    });
  });

  test('leaves out elements that are not shown', async () => {
    const hidden = () => [
      fakeElement({ text: 'Hidden', display: 'none', rect: box(10, 600, 60, 20) }),
      fakeElement({ text: 'Hidden', visibility: 'hidden', rect: box(10, 600, 60, 20) }),
      fakeElement({ text: 'Hidden', rect: box(10, 600, 0, 0) }),
    ];

    expect(await bothWays(describeElement, [...named('Hidden')], screen(hidden))).toEqual(notFound);
  });

  test('flags a named element that is, holds or sits inside a trading control', async () => {
    const panel = () =>
      fakeElement({
        attributes: { 'aria-label': 'Order panel' },
        rect: box(900, 100, 300, 300),
        children: [fakeElement({ matches: [BUY], rect: box(1100, 350, 80, 30) })],
      });
    // A label inside the sell button, which is named "Confirm" and so no trading action by itself.
    // The button has a name of its own, so the label is the first element named "Confirm".
    const sellButton = () =>
      fakeElement({
        tag: 'button',
        matches: ['[data-name="sell-order-button"]'],
        attributes: { 'aria-label': 'Sell order' },
        rect: box(500, 250, 80, 30),
        children: [fakeElement({ tag: 'span', text: 'Confirm', rect: box(510, 255, 40, 20) })],
      });
    const make = screen(() => [buyButton({ 'aria-label': 'Buy' }), panel(), sellButton()]);

    expect(await bothWays(describeElement, [...named('buy')], make)).toMatchObject({
      unsafe: true,
    });
    expect(await bothWays(describeElement, [...named('order panel')], make)).toMatchObject({
      unsafe: true,
      coverage: 'not-checked',
    });
    expect(await bothWays(describeElement, [...named('confirm')], make)).toMatchObject({
      found: true,
      unsafe: true,
      rect: box(510, 255, 40, 20),
    });
    // What the element holds counts only for a click: a hover or a scroll over the panel lands on
    // the panel, and its center is clear of the button.
    expect(await bothWays(describeElement, [...named('order panel', 'hover')], make)).toMatchObject(
      {
        unsafe: false,
        coverage: 'clear',
      },
    );
    expect(await bothWays(describeElement, [...named('buy', 'scroll')], make)).toMatchObject({
      unsafe: true,
    });
  });

  test('judges the center of a named element like that of an element named by a selector', async () => {
    const make = screen(() => [
      fakeElement({ tag: 'button', text: 'Apply', rect: box(350, 280, 100, 40) }),
      openMenu(),
    ]);

    expect(await bothWays(describeElement, [...named('Apply')], make)).toMatchObject({
      found: true,
      unsafe: false,
      coverage: 'obscured',
      obscuredBy: 'div#menu-item',
    });
  });

  test('returns NOT_AVAILABLE for a text on a page that cannot list its elements', async () => {
    const error = await failureBothWays(
      describeElement,
      [...named('Apply')],
      screen(() => [], { without: ['querySelectorAll'] }),
    );

    expect(error.code).toBe('NOT_AVAILABLE');
  });
});

describe('describeElement for a hover or a scroll', () => {
  const PANE_QA = '[data-qa-id="pane"]';
  const of = (selector: string, action: PointerAction): ArgsOf<typeof describeElement> => [
    { selector },
    [...UNSAFE_SELECTORS],
    [OVERLAP_ROOT],
    TRADING_ACTION_NAMES,
    action,
    false,
  ];

  test('does not flag an element that only holds a trading control', async () => {
    const make = screen(() => [paneWithTradingButtons()]);

    // A click on the pane is refused, because the pane holds the buttons. The pointer over the pane
    // lands on the pane, and its center is clear of them.
    expect(await bothWays(describeElement, [...of(PANE_QA, 'click')], make)).toMatchObject({
      unsafe: true,
    });
    expect(await bothWays(describeElement, [...of(PANE_QA, 'hover')], make)).toMatchObject({
      unsafe: false,
      coverage: 'clear',
    });
  });

  test('still flags an element that is a trading control or sits inside one', async () => {
    const label = () =>
      fakeElement({
        matches: [BUY],
        rect: box(300, 250, 80, 30),
        children: [fakeElement({ matches: ['[data-name="label"]'], rect: box(310, 255, 40, 20) })],
      });
    const make = screen(() => [label()]);

    expect(await bothWays(describeElement, [...of(BUY, 'scroll')], make)).toMatchObject({
      unsafe: true,
    });
    expect(
      await bothWays(describeElement, [...of('[data-name="label"]', 'hover')], make),
    ).toMatchObject({ unsafe: true });
  });
});

describe('clickPoint and clickTarget', () => {
  const pageOn = (make: () => TvWindow, handleInput?: (command: SentCommand) => unknown) =>
    pageOver(make(), handleInput);

  test('clickPoint at a point over the buy button sends no mouse event at all', async () => {
    const { page, sent, input } = pageOn(screen(() => [buyButton()]));

    const error = await failureOf(clickPoint(page, { x: 320, y: 260 }));

    expect(error.toPayload()).toEqual({
      code: 'UNSAFE_ACTION_BLOCKED',
      message:
        'Refusing to click at (320, 260): what lies there is part of a broker trading control or holds one',
      hint: TRADING_HINT,
      details: { x: 320, y: 260 },
    });
    // The look at the point is all the page saw: not a move, and no press.
    expect(input()).toEqual([]);
    expect(methodsOf(sent)).toEqual(['Runtime.evaluate']);
  });

  test('clickPoint at a point on a toolbar that holds the trade button sends no mouse event, as a click by selector does not', async () => {
    const toolbar = () =>
      fakeElement({
        matches: ['[data-name="toolbar"]'],
        rect: box(0, 0, 1280, 40),
        children: [fakeElement({ matches: [TRADE_BUTTON], rect: box(700, 5, 60, 30) })],
      });
    const byPoint = pageOn(screen(() => [toolbar()]));
    const bySelector = pageOn(screen(() => [toolbar()]));

    const atPoint = await failureOf(clickPoint(byPoint.page, { x: 100, y: 20 }));
    const onElement = await failureOf(clickElement(bySelector.page, '[data-name="toolbar"]'));

    expect(atPoint.toPayload()).toEqual({
      code: 'UNSAFE_ACTION_BLOCKED',
      message:
        'Refusing to click at (100, 20): what lies there is part of a broker trading control or holds one',
      hint: TRADING_HINT,
      details: { x: 100, y: 20 },
    });
    expect(onElement.code).toBe('UNSAFE_ACTION_BLOCKED');
    expect(byPoint.input()).toEqual([]);
    expect(bySelector.input()).toEqual([]);
  });

  test('clickPoint clicks a point on the chart canvas, which holds nothing', async () => {
    const { page, input } = pageOn(screen(() => [buyButton()]));

    await clickPoint(page, { x: 100, y: 400 });

    expect(input()).toEqual([
      mouseEvent('mouseMoved', 100, 400),
      mouseEvent('mousePressed', 100, 400),
      mouseEvent('mouseReleased', 100, 400),
    ]);
  });

  test('a hover and a scroll at a point on a container that holds a trading control are not refused', async () => {
    const toolbar = () =>
      fakeElement({
        matches: ['[data-name="toolbar"]'],
        rect: box(0, 0, 1280, 40),
        children: [fakeElement({ matches: [TRADE_BUTTON], rect: box(700, 5, 60, 30) })],
      });
    const { page, types } = pageOn(screen(() => [toolbar()]));

    await hoverPoint(page, { x: 100, y: 20 });
    await scrollAt(page, { x: 100, y: 20 }, { x: 0, y: 100 });

    expect(types()).toEqual(['mouseMoved', 'mouseMoved', 'mouseWheel']);
  });

  test('clickPoint at a point in an open menu of the overlap root refuses with NOT_AVAILABLE', async () => {
    const { page, input } = pageOn(screen(() => [openMenu()]));

    const error = await failureOf(clickPoint(page, { x: 400, y: 300 }));

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(error.message).toBe('The point (400, 300) is covered by `div#menu-item`');
    expect(error.details).toEqual({ x: 400, y: 300, obscuredBy: 'div#menu-item' });
    expect(error.hint).toMatch(/selector or text/);
    expect(input()).toEqual([]);
  });

  test.each(['iframe', 'frame', 'object', 'embed'])(
    'clickPoint at a point on a <%s> refuses with NOT_AVAILABLE',
    async (tag) => {
      const frame = () => fakeElement({ tag, id: 'ad', rect: box(350, 280, 100, 40) });
      const { page, input } = pageOn(screen(() => [frame()]));

      const error = await failureOf(clickPoint(page, { x: 400, y: 300 }));

      expect(error.code).toBe('NOT_AVAILABLE');
      expect(error.details).toEqual({ x: 400, y: 300, obscuredBy: `${tag}#ad` });
      expect(input()).toEqual([]);
    },
  );

  test('clickPoint refuses a point when the page cannot say what lies there', async () => {
    const { page, input } = pageOn(screen(() => [], { without: ['elementFromPoint'] }));

    const error = await failureOf(clickPoint(page, { x: 120, y: 60 }));

    expect(error.toPayload()).toEqual({
      code: 'NOT_AVAILABLE',
      message: 'The page cannot say what lies at (120, 60)',
      hint: 'Make sure the target is a loaded TradingView page, not a blank or helper page.',
      details: { x: 120, y: 60, reason: 'hit-test-unavailable' },
    });
    expect(input()).toEqual([]);
  });

  test('clickPoint moves the pointer, looks again and clicks at the point', async () => {
    const { page, sent, input } = pageOn(screen());

    await expect(clickPoint(page, { x: 120, y: 60 })).resolves.toBeUndefined();

    expect(methodsOf(sent)).toEqual([
      'Runtime.evaluate',
      'Page.getLayoutMetrics',
      'Input.dispatchMouseEvent',
      'Runtime.evaluate',
      'Page.getLayoutMetrics',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
    ]);
    expect(input()).toEqual([
      mouseEvent('mouseMoved', 120, 60),
      mouseEvent('mousePressed', 120, 60),
      mouseEvent('mouseReleased', 120, 60),
    ]);
  });

  test('clickPoint sends the point in device-independent pixels, at 1 and at 1.25', async () => {
    const plain = pageOn(screen(() => [], { zoom: 1 }));
    const zoomed = pageOn(screen(() => [], { zoom: 1.25 }));

    await clickPoint(plain.page, { x: 120, y: 60 });
    await clickPoint(zoomed.page, { x: 120, y: 60 });

    expect(plain.input()).toEqual([
      mouseEvent('mouseMoved', 120, 60),
      mouseEvent('mousePressed', 120, 60),
      mouseEvent('mouseReleased', 120, 60),
    ]);
    // The page judged (120, 60) in CSS pixels, which is (150, 75) in the window at 125%.
    expect(zoomed.input()).toEqual([
      mouseEvent('mouseMoved', 150, 75),
      mouseEvent('mousePressed', 150, 75),
      mouseEvent('mouseReleased', 150, 75),
    ]);
  });

  test('clickPoint rounds the point to whole pixels, which the page judges and the click goes to', async () => {
    // (119.6, 60.4) is (120, 60), the center of the header button.
    const { page, input } = pageOn(screen());

    await clickPoint(page, { x: 119.6, y: 60.4 });

    expect(input().map(({ params }) => params)).toEqual([
      { type: 'mouseMoved', x: 120, y: 60 },
      { type: 'mousePressed', x: 120, y: 60, button: 'left', clickCount: 1 },
      { type: 'mouseReleased', x: 120, y: 60, button: 'left', clickCount: 1 },
    ]);
  });

  test('clickPoint refuses a point outside the viewport with INVALID_INPUT, without any input', async () => {
    const { page, sent, input } = pageOn(screen());

    const error = await failureOf(clickPoint(page, { x: 1300, y: 10 }));

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe('The point (1300, 10) is outside the visible part of the page');
    expect(error.details).toEqual({ x: 1300, y: 10 });
    expect(error.hint).toMatch(/CSS pixels/);
    expect(input()).toEqual([]);
    expect(methodsOf(sent)).toEqual(['Runtime.evaluate']);
  });

  test('clickPoint refuses a negative point with INVALID_INPUT before it looks at the page', async () => {
    const { page, sent } = pageOn(screen());

    const error = await failureOf(clickPoint(page, { x: -5, y: 10 }));

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details).toEqual({ x: -5, y: 10 });
    expect(sent).toEqual([]);
  });

  test.each([
    ['x', { x: Number.NaN, y: 10 }],
    ['y', { x: 10, y: Number.POSITIVE_INFINITY }],
  ])(
    'clickPoint refuses a point whose %s is not a finite number before it looks at the page',
    async (_axis, point) => {
      const { page, sent } = pageOn(screen());

      const error = await failureOf(clickPoint(page, point));

      expect(error.code).toBe('INVALID_INPUT');
      expect(sent).toEqual([]);
    },
  );

  test('clickPoint stops with only the move sent when a trading control opens under the pointer', async () => {
    const win = screen()();
    const buy = fakeElement({ tag: 'button', matches: [BUY], rect: box(100, 50, 40, 20) });
    const { page, types } = pageOver(
      win,
      afterTheMove(() => {
        dom(win).document.elementFromPoint = () => buy;
      }),
    );

    const error = await failureOf(clickPoint(page, { x: 120, y: 60 }));

    expect(error.code).toBe('UNSAFE_ACTION_BLOCKED');
    expect(types()).toEqual(['mouseMoved']);
  });

  test('clickTarget returns where the button went down, in CSS pixels', async () => {
    const { page } = pageOn(screen(() => [], { zoom: 1.25 }));

    await expect(clickTarget(page, { selector: SAVE })).resolves.toEqual({ x: 120, y: 60 });
  });

  test('clickTarget by text clicks the first visible element with that name', async () => {
    const buttons = () => [
      fakeElement({ tag: 'button', text: 'Apply', rect: box(300, 600, 40, 20), display: 'none' }),
      fakeElement({ tag: 'button', text: 'Apply', rect: box(100, 600, 40, 20) }),
      fakeElement({ tag: 'button', text: 'Apply', rect: box(500, 600, 40, 20) }),
    ];
    const { page, input } = pageOn(screen(buttons));

    await expect(clickTarget(page, { text: 'apply' })).resolves.toEqual({ x: 120, y: 610 });

    expect(input()).toEqual([
      mouseEvent('mouseMoved', 120, 610),
      mouseEvent('mousePressed', 120, 610),
      mouseEvent('mouseReleased', 120, 610),
    ]);
  });

  test('clickTarget by text refuses an element with that name that is a trading control', async () => {
    const { page, input } = pageOn(screen(() => [buyButton({ 'aria-label': 'Buy' })]));

    const error = await failureOf(clickTarget(page, { text: 'Buy' }));

    expect(error.toPayload()).toEqual({
      code: 'UNSAFE_ACTION_BLOCKED',
      message:
        'Refusing to click the element named "Buy": it is part of a broker trading control, holds one, or has one over it',
      hint: TRADING_HINT,
      details: { text: 'Buy' },
    });
    expect(input()).toEqual([]);
  });

  test('clickTarget by text reports a text no visible element has as INVALID_INPUT and points to ui_find_element', async () => {
    const { page, sent } = pageOn(screen());

    const error = await failureOf(clickTarget(page, { text: 'Nothing' }));

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe('No visible element is named "Nothing"');
    expect(error.hint).toMatch(/ui_find_element/);
    expect(error.details).toEqual({ text: 'Nothing' });
    expect(methodsOf(sent)).toEqual(['Runtime.evaluate']);
  });

  test('clickTarget by text refuses a named element that a menu covers', async () => {
    const make = screen(() => [
      fakeElement({ tag: 'button', text: 'Apply', rect: box(350, 280, 100, 40) }),
      openMenu(),
    ]);
    const { page, input } = pageOn(make);

    const error = await failureOf(clickTarget(page, { text: 'Apply' }));

    expect(error.toPayload()).toEqual({
      code: 'NOT_AVAILABLE',
      message: 'The element named "Apply" is covered by `div#menu-item`',
      hint: 'Close the dialog or menu that covers it first.',
      details: { text: 'Apply', obscuredBy: 'div#menu-item' },
    });
    expect(input()).toEqual([]);
  });

  test('clickTarget refuses an empty text before it looks at the page', async () => {
    const { page, sent } = pageOn(screen());

    const error = await failureOf(clickTarget(page, { text: '   ' }));

    expect(error.code).toBe('INVALID_INPUT');
    expect(sent).toEqual([]);
  });
});

describe('hoverElement, hoverPoint and hoverTarget', () => {
  test('hoverElement moves the pointer only, and looks again once it is there', async () => {
    const { page, sent, input } = pageWith(chart());

    await expect(hoverElement(page, SAVE)).resolves.toEqual({
      point: { x: 120, y: 60 },
      warning: null,
    });

    expect(methodsOf(sent)).toEqual([
      'Runtime.evaluate',
      'Page.getLayoutMetrics',
      'Input.dispatchMouseEvent',
      'Runtime.evaluate',
    ]);
    expect(input()).toEqual([mouseEvent('mouseMoved', 120, 60)]);
  });

  test('hoverElement refuses a trading control the way a click does, without moving the pointer', async () => {
    const { page, sent, input } = pageWith([buyButton()]);

    const error = await failureOf(hoverElement(page, BUY));

    expect(error.toPayload()).toEqual({
      code: 'UNSAFE_ACTION_BLOCKED',
      message: `Refusing to hover over \`${BUY}\`: it is part of a broker trading control or has one over it`,
      hint: TRADING_HINT,
      details: { selector: BUY },
    });
    expect(input()).toEqual([]);
    expect(methodsOf(sent)).toEqual(['Runtime.evaluate']);
  });

  test('hoverPoint refuses a point over a trading control and a point in an open menu', async () => {
    const overButton = pageOver(screen(() => [buyButton()])());
    const inMenu = pageOver(screen(() => [openMenu()])());

    const unsafe = await failureOf(hoverPoint(overButton.page, { x: 320, y: 260 }));
    const covered = await failureOf(hoverPoint(inMenu.page, { x: 400, y: 300 }));

    expect(unsafe.message).toBe(
      'Refusing to hover at (320, 260): a broker trading control lies there',
    );
    expect(unsafe.code).toBe('UNSAFE_ACTION_BLOCKED');
    expect(covered.code).toBe('NOT_AVAILABLE');
    expect(overButton.input()).toEqual([]);
    expect(inMenu.input()).toEqual([]);
  });

  test('hoverElement goes over an element that only holds trading controls, such as the pane', async () => {
    const { page, input } = pageWith([paneWithTradingButtons()]);

    await hoverElement(page, '[data-qa-id="pane"]');

    expect(input()).toEqual([mouseEvent('mouseMoved', 400, 300)]);
  });

  test('a hover reports a trading control that lies under the pointer once it arrived, and sends nothing more', async () => {
    const win = createFakeDomWindow(chart());
    const buy = fakeElement({ tag: 'button', matches: [BUY], rect: box(100, 50, 40, 20) });
    const { page, sent, types } = pageOver(
      win,
      afterTheMove(() => {
        dom(win).document.elementFromPoint = () => buy;
      }),
    );

    await expect(hoverElement(page, SAVE)).resolves.toEqual({
      point: { x: 120, y: 60 },
      warning: 'A broker trading control lies under the pointer since it arrived.',
    });

    expect(types()).toEqual(['mouseMoved']);
    expect(methodsOf(sent)).toEqual([
      'Runtime.evaluate',
      'Page.getLayoutMetrics',
      'Input.dispatchMouseEvent',
      'Runtime.evaluate',
    ]);
  });

  test('a hover reports a menu that opened over the point as the pointer arrived', async () => {
    const item = fakeElement({ id: 'menu-item', rect: box(500, 400, 40, 20) });
    const win = createFakeDomWindow(chart([overlapRoot([item])]));
    const { page, types } = pageOver(
      win,
      afterTheMove(() => {
        dom(win).document.elementFromPoint = () => item;
      }),
    );

    const result = await hoverElement(page, SAVE);

    expect(result).toEqual({
      point: { x: 120, y: 60 },
      warning: `After the pointer arrived: The element \`${SAVE}\` is covered by \`div#menu-item\``,
    });
    expect(types()).toEqual(['mouseMoved']);
  });

  test('a hover follows a target that moved as the pointer arrived', async () => {
    const target = fakeElement({ matches: [SAVE], rect: box(100, 50, 40, 20) });
    const win = createFakeDomWindow([target]);
    const { page, sent, input } = pageOver(
      win,
      afterTheMove(() => {
        target.place(box(300, 80, 40, 20));
      }),
    );

    await expect(hoverElement(page, SAVE)).resolves.toEqual({
      point: { x: 320, y: 90 },
      warning: null,
    });

    // The pointer goes on to where the second look found the target, the way a click presses there.
    expect(input()).toEqual([mouseEvent('mouseMoved', 120, 60), mouseEvent('mouseMoved', 320, 90)]);
    expect(methodsOf(sent)).toEqual([
      'Runtime.evaluate',
      'Page.getLayoutMetrics',
      'Input.dispatchMouseEvent',
      'Runtime.evaluate',
      'Page.getLayoutMetrics',
      'Input.dispatchMouseEvent',
    ]);
  });

  test('a hover sends the pointer in device-independent pixels and reports CSS pixels', async () => {
    const { page, input } = pageWith(chart(), { zoom: 1.25 });

    await expect(hoverElement(page, SAVE)).resolves.toEqual({
      point: { x: 120, y: 60 },
      warning: null,
    });

    expect(input()).toEqual([mouseEvent('mouseMoved', 150, 75)]);
  });

  test('hoverTarget by text goes to the first visible element with that name', async () => {
    const make = screen(() => [
      fakeElement({ tag: 'span', text: 'Apply', rect: box(100, 600, 40, 20) }),
    ]);
    const { page, input } = pageOver(make());

    await expect(hoverTarget(page, { text: 'APPLY' })).resolves.toEqual({
      point: { x: 120, y: 610 },
      warning: null,
    });
    expect(input()).toEqual([mouseEvent('mouseMoved', 120, 610)]);
  });
});

describe('scrollAt', () => {
  function wheel(x: number, y: number, deltaX: number, deltaY: number): SentCommand {
    return {
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseWheel', x, y, deltaX, deltaY },
    };
  }

  test('scrollAt sends one mouseWheel at the center of the target, after the move and a second look', async () => {
    const { page, sent, input } = pageWith(chart());

    await expect(scrollAt(page, { selector: PANE }, { x: 0, y: 120 })).resolves.toEqual({
      x: 400,
      y: 300,
    });

    expect(methodsOf(sent)).toEqual([
      'Runtime.evaluate',
      'Page.getLayoutMetrics',
      'Input.dispatchMouseEvent',
      'Runtime.evaluate',
      'Page.getLayoutMetrics',
      'Input.dispatchMouseEvent',
    ]);
    // No button goes down.
    expect(input()).toEqual([mouseEvent('mouseMoved', 400, 300), wheel(400, 300, 0, 120)]);
  });

  test('scrollAt sends the point in device-independent pixels and the deltas in CSS pixels, as given', async () => {
    // At 125% the center of the pane, (400, 300), is (500, 375) in the window. The protocol takes
    // the deltas of the wheel in CSS pixels, so they go out as the caller gave them.
    const { page, input } = pageWith(chart(), { zoom: 1.25 });

    await scrollAt(page, { selector: PANE }, { x: -20, y: 120 });

    expect(input()).toEqual([mouseEvent('mouseMoved', 500, 375), wheel(500, 375, -20, 120)]);
  });

  test('scrollAt scrolls at a point', async () => {
    const { page, input } = pageOver(screen()());

    await scrollAt(page, { x: 200, y: 200 }, { x: 0, y: -100 });

    expect(input()).toEqual([mouseEvent('mouseMoved', 200, 200), wheel(200, 200, 0, -100)]);
  });

  test('scrollAt refuses a trading control and a point over one, without any input', async () => {
    const byButton = pageOver(screen(() => [buyButton()])());
    const byPoint = pageOver(screen(() => [buyButton()])());

    const onButton = await failureOf(scrollAt(byButton.page, { selector: BUY }, { x: 0, y: 100 }));
    const atPoint = await failureOf(scrollAt(byPoint.page, { x: 320, y: 260 }, { x: 0, y: 100 }));

    expect(onButton.message).toBe(
      `Refusing to scroll over \`${BUY}\`: it is part of a broker trading control or has one over it`,
    );
    expect(onButton.code).toBe('UNSAFE_ACTION_BLOCKED');
    expect(atPoint.message).toBe(
      'Refusing to scroll at (320, 260): a broker trading control lies there',
    );
    expect(atPoint.code).toBe('UNSAFE_ACTION_BLOCKED');
    expect(byButton.input()).toEqual([]);
    expect(byPoint.input()).toEqual([]);
  });

  test('scrollAt refuses a point over a menu of the overlap root, without any input', async () => {
    const { page, input } = pageOver(screen(() => [openMenu()])());

    const error = await failureOf(scrollAt(page, { x: 400, y: 300 }, { x: 0, y: 100 }));

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(error.details).toEqual({ x: 400, y: 300, obscuredBy: 'div#menu-item' });
    expect(input()).toEqual([]);
  });

  test('scrollAt scrolls the pane, although it holds the buy and sell buttons', async () => {
    const { page, input } = pageWith([paneWithTradingButtons()]);

    await scrollAt(page, { selector: '[data-qa-id="pane"]' }, { x: 0, y: 100 });

    expect(input()).toEqual([mouseEvent('mouseMoved', 400, 300), wheel(400, 300, 0, 100)]);
  });

  test('scrollAt stops with only the move sent when a menu opens over the target as the pointer arrives', async () => {
    const item = fakeElement({ id: 'menu-item', rect: box(500, 400, 40, 20) });
    const win = createFakeDomWindow(chart([overlapRoot([item])]));
    const { page, types } = pageOver(
      win,
      afterTheMove(() => {
        dom(win).document.elementFromPoint = () => item;
      }),
    );

    const error = await failureOf(scrollAt(page, { selector: PANE }, { x: 0, y: 100 }));

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(types()).toEqual(['mouseMoved']);
  });

  test.each([
    ['deltaX', { x: Number.NaN, y: 100 }],
    ['deltaY', { x: 0, y: Number.NEGATIVE_INFINITY }],
  ])(
    'scrollAt refuses a %s that is not a finite number before it looks at the page',
    async (_name, delta) => {
      const { page, sent } = pageWith(chart());

      const error = await failureOf(scrollAt(page, { selector: PANE }, delta));

      expect(error.code).toBe('INVALID_INPUT');
      expect(sent).toEqual([]);
    },
  );
});

describe('findElements', () => {
  const find = (
    selector: string | null,
    text: string | null,
    limit = 10,
  ): ArgsOf<typeof findElements> => [{ selector, text }, limit, [...UNSAFE_SELECTORS]];

  test('findElements by text returns the visible elements with that name, with their boxes, and marks trading controls unsafe', async () => {
    const make = screen(() => [
      buyButton({ 'aria-label': 'Buy', 'data-name': 'buy-order-button' }),
      fakeElement({
        tag: 'span',
        attributes: { role: 'menuitem' },
        text: 'Buy',
        rect: box(10, 600, 50, 20),
      }),
      fakeElement({ text: 'Buy', display: 'none', rect: box(10, 640, 50, 20) }),
    ]);

    const result = await bothWays(findElements, [...find(null, 'buy')], make);

    expect(result).toEqual({
      elements: [
        {
          selector: BUY,
          tag: 'button',
          role: null,
          name: 'Buy',
          text: '',
          rect: box(300, 250, 80, 30),
          visible: true,
          unsafe: true,
          holdsUnsafe: false,
        },
        {
          selector: null,
          tag: 'span',
          role: 'menuitem',
          name: 'Buy',
          text: 'Buy',
          rect: box(10, 600, 50, 20),
          visible: true,
          unsafe: false,
          holdsUnsafe: false,
        },
      ],
      more: false,
    });
  });

  test('findElements names an element by its title when nothing else names it', async () => {
    const make = screen(() => [
      fakeElement({
        tag: 'button',
        attributes: { title: 'Take a snapshot' },
        rect: box(800, 10, 30, 30),
        children: [fakeElement({ tag: 'svg', rect: box(805, 15, 20, 20) })],
      }),
    ]);

    const result = await bothWays(findElements, [...find(null, 'take a snapshot')], make);

    expect(result).toEqual({
      elements: [
        {
          selector: null,
          tag: 'button',
          role: null,
          name: 'Take a snapshot',
          text: '',
          rect: box(800, 10, 30, 30),
          visible: true,
          unsafe: false,
          holdsUnsafe: false,
        },
      ],
      more: false,
    });
  });

  test('findElements says whether an element is or sits inside a trading control, and whether it holds one', async () => {
    const make = screen(() => [paneWithTradingButtons()]);

    const result = await bothWays(
      findElements,
      [...find(`[data-name="buy-sell-buttons"], [data-qa-id="pane"], ${SAVE}`, null)],
      make,
    );

    // Listed in document order: the save button, which is neither; the pane, which holds the group
    // and so refuses a click but not a hover or a scroll; and the group, which is a trading control
    // and holds the buy button.
    expect(result.elements.map(({ unsafe, holdsUnsafe }) => ({ unsafe, holdsUnsafe }))).toEqual([
      { unsafe: false, holdsUnsafe: false },
      { unsafe: false, holdsUnsafe: true },
      { unsafe: true, holdsUnsafe: true },
    ]);
  });

  test('findElements by selector lists the visible elements that match, in document order, at most limit of them', async () => {
    const rows = () => [
      fakeElement({ matches: ['.row'], text: 'One', rect: box(10, 600, 100, 20) }),
      fakeElement({
        matches: ['.row'],
        text: 'Hidden',
        rect: box(10, 620, 100, 20),
        display: 'none',
      }),
      fakeElement({ matches: ['.row'], text: 'Two', rect: box(10, 640, 100, 20) }),
      fakeElement({ matches: ['.row'], text: 'Three', rect: box(10, 660, 100, 20) }),
    ];

    const two = await bothWays(findElements, [...find('.row', null, 2)], screen(rows));
    const all = await bothWays(findElements, [...find('.row', null)], screen(rows));

    expect(two.elements.map(({ text }) => text)).toEqual(['One', 'Two']);
    expect(two.more).toBe(true);
    expect(all.elements.map(({ text }) => text)).toEqual(['One', 'Two', 'Three']);
    expect(all.more).toBe(false);
  });

  test('findElements with a selector and a text keeps the elements that match both', async () => {
    const rows = () => [
      fakeElement({ matches: ['.row'], text: 'One', rect: box(10, 600, 100, 20) }),
      fakeElement({ matches: ['.row'], text: 'Two', rect: box(10, 640, 100, 20) }),
      fakeElement({ tag: 'span', text: 'Two', rect: box(200, 640, 100, 20) }),
    ];

    const result = await bothWays(findElements, [...find('.row', 'TWO')], screen(rows));

    expect(result.elements).toEqual([
      expect.objectContaining({ text: 'Two', rect: box(10, 640, 100, 20) }),
    ]);
  });

  test('findElements gives each element a selector that picks it: its id, data-qa-id, data-name or aria-label', async () => {
    const at = (y: number) => box(10, y, 100, 20);
    const make = screen(() => [
      fakeElement({
        id: 'save',
        matches: ['.item', '#save'],
        attributes: { 'data-name': 'x' },
        rect: at(400),
      }),
      fakeElement({
        matches: ['.item', '[data-qa-id="legend"]'],
        attributes: { 'data-qa-id': 'legend' },
        rect: at(430),
      }),
      fakeElement({
        matches: ['.item', '[data-name="alerts"]'],
        attributes: { 'data-name': 'alerts' },
        rect: at(460),
      }),
      fakeElement({
        matches: ['.item', '[aria-label="Close"]'],
        attributes: { 'aria-label': 'Close' },
        rect: at(490),
      }),
      // Its data-name picks the element above it first, so its aria-label is what picks it.
      fakeElement({
        matches: ['.item', '[data-name="alerts"]', '[aria-label="Alerts list"]'],
        attributes: { 'data-name': 'alerts', 'aria-label': 'Alerts list' },
        rect: at(520),
      }),
      // Nothing of it picks it first, and it has nothing else.
      fakeElement({
        matches: ['.item', '[data-name="alerts"]'],
        attributes: { 'data-name': 'alerts' },
        rect: at(550),
      }),
      fakeElement({ matches: ['.item'], text: 'plain', rect: at(580) }),
    ]);

    const result = await bothWays(findElements, [...find('.item', null)], make);

    expect(result.elements.map(({ selector }) => selector)).toEqual([
      '#save',
      '[data-qa-id="legend"]',
      '[data-name="alerts"]',
      '[aria-label="Close"]',
      '[aria-label="Alerts list"]',
      null,
      null,
    ]);
  });

  test('findElements writes an id that is no CSS identifier, and quotes in a value, so the selector still parses', async () => {
    const make = screen(() => [
      fakeElement({
        id: '3f9c-tab',
        matches: ['.item', '[id="3f9c-tab"]'],
        rect: box(10, 400, 100, 20),
      }),
      fakeElement({
        matches: ['.item', String.raw`[data-name="say \"hi\""]`],
        attributes: { 'data-name': 'say "hi"' },
        rect: box(10, 430, 100, 20),
      }),
      fakeElement({
        matches: ['.item', String.raw`[data-qa-id="a\\b"]`],
        attributes: { 'data-qa-id': String.raw`a\b` },
        rect: box(10, 460, 100, 20),
      }),
    ]);

    const result = await bothWays(findElements, [...find('.item', null)], make);

    expect(result.elements.map(({ selector }) => selector)).toEqual([
      '[id="3f9c-tab"]',
      String.raw`[data-name="say \"hi\""]`,
      String.raw`[data-qa-id="a\\b"]`,
    ]);
  });

  test('findElements never reads what a field holds: inputs, text areas and selects come without text', async () => {
    // A field whose value is read fails the test: its getter throws.
    const field = (options: FakeElementOptions) => {
      const element = fakeElement({ matches: ['.field'], ...options });
      Object.defineProperty(element, 'value', {
        get() {
          throw new Error('The value of a field was read');
        },
      });
      return element;
    };
    const make = screen(() => [
      field({
        tag: 'input',
        attributes: { type: 'password', 'aria-label': 'Password' },
        rect: box(10, 400, 100, 20),
      }),
      field({ tag: 'textarea', text: 'a secret note', rect: box(10, 430, 100, 40) }),
      field({ tag: 'select', text: 'First choice', rect: box(10, 480, 100, 20) }),
      field({ tag: 'input', attributes: { type: 'text' }, rect: box(10, 510, 100, 20) }),
    ]);

    const result = await bothWays(findElements, [...find('.field', null)], make);

    expect(result.elements.map(({ tag, name, text }) => ({ tag, name, text }))).toEqual([
      { tag: 'input', name: 'Password', text: '' },
      { tag: 'textarea', name: '', text: '' },
      { tag: 'select', name: '', text: '' },
      { tag: 'input', name: '', text: '' },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/secret|First choice/);
  });

  test('findElements cuts the text and the name of an element at 200 characters', async () => {
    const make = screen(() => [
      fakeElement({ matches: ['.long'], text: 'x'.repeat(300), rect: box(10, 400, 100, 20) }),
    ]);

    const [element] = (await bothWays(findElements, [...find('.long', null)], make)).elements;

    expect(element?.text).toBe('x'.repeat(200));
    expect(element?.name).toBe('x'.repeat(200));
  });

  test('findElements refuses a selector that is not valid CSS with INVALID_INPUT', async () => {
    const error = await failureBothWays(
      findElements,
      [...find('[data-name="open', null)],
      screen(),
    );

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details).toEqual({ selector: '[data-name="open' });
  });

  test('findElements returns NOT_AVAILABLE on a page that cannot list its elements', async () => {
    const error = await failureBothWays(
      findElements,
      [...find(null, 'Apply')],
      screen(() => [], { without: ['querySelectorAll'] }),
    );

    expect(error.code).toBe('NOT_AVAILABLE');
  });

  test('findElements does not cut a character made of two halves in two', async () => {
    // The 200th unit is the first half of an emoji, so the cut comes one unit earlier.
    const text = `${'x'.repeat(199)}😀${'y'.repeat(20)}`;
    const make = screen(() => [
      fakeElement({ matches: ['.long'], text, rect: box(10, 400, 100, 20) }),
    ]);

    const [element] = (await bothWays(findElements, [...find('.long', null)], make)).elements;

    expect(element?.text).toBe('x'.repeat(199));
  });

  test('findElements writes a control character of a value as a CSS escape', async () => {
    const make = screen(() => [
      fakeElement({
        matches: ['.item', String.raw`[data-name="two\a lines"]`],
        attributes: { 'data-name': 'two\nlines' },
        rect: box(10, 400, 100, 20),
      }),
    ]);

    const result = await bothWays(findElements, [...find('.item', null)], make);

    expect(result.elements.map(({ selector }) => selector)).toEqual([
      String.raw`[data-name="two\a lines"]`,
    ]);
  });

  test('findElements leaves out elements without a size, and judges by the box alone without getComputedStyle', async () => {
    const make = screen(
      () => [
        fakeElement({ matches: ['.item'], text: 'flat', rect: box(10, 400, 0, 20) }),
        fakeElement({
          matches: ['.item'],
          text: 'styled away',
          display: 'none',
          rect: box(10, 430, 100, 20),
        }),
      ],
      { without: ['getComputedStyle'] },
    );

    const result = await bothWays(findElements, [...find('.item', null)], make);

    expect(result.elements.map(({ text }) => text)).toEqual(['styled away']);
  });

  test('findElements refuses to look without the selectors to treat as unsafe', () => {
    expect(() => findElements(screen()(), { selector: '.item', text: null }, 10, [])).toThrow(
      /unsafe/,
    );
  });

  test('findElements and a click by text agree on which element has a name', async () => {
    const make = screen(() => [
      fakeElement({
        tag: 'button',
        text: 'Apply',
        rect: box(300, 600, 40, 20),
        visibility: 'hidden',
      }),
      fakeElement({ attributes: { 'aria-label': 'apply' }, rect: box(100, 600, 40, 20) }),
      fakeElement({ tag: 'button', text: 'Apply', rect: box(500, 600, 40, 20) }),
    ]);

    const [first] = (await bothWays(findElements, [...find(null, 'Apply')], make)).elements;
    const clicked = await clickTarget(pageOver(make()).page, { text: 'Apply' });

    expect(first?.rect).toEqual(box(100, 600, 40, 20));
    expect(clicked).toEqual({ x: 120, y: 610 });
  });
});

describe('the pointer calls of one page', () => {
  test('run a click at a point, a hover and a scroll one after the other, in the order they were made', async () => {
    const { page, sent } = pageWith(chart());

    await Promise.all([
      clickPoint(page, { x: 120, y: 60 }),
      hoverElement(page, SAVE),
      scrollAt(page, { selector: PANE }, { x: 0, y: 100 }),
    ]);

    expect(methodsOf(sent)).toEqual([
      // The click: two looks with the zoom, the move, the press and the release.
      'Runtime.evaluate',
      'Page.getLayoutMetrics',
      'Input.dispatchMouseEvent',
      'Runtime.evaluate',
      'Page.getLayoutMetrics',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      // The hover: a look with the zoom, the move and the second look.
      'Runtime.evaluate',
      'Page.getLayoutMetrics',
      'Input.dispatchMouseEvent',
      'Runtime.evaluate',
      // The scroll: two looks with the zoom, the move and the wheel.
      'Runtime.evaluate',
      'Page.getLayoutMetrics',
      'Input.dispatchMouseEvent',
      'Runtime.evaluate',
      'Page.getLayoutMetrics',
      'Input.dispatchMouseEvent',
    ]);
  });

  test('let the next call run when a hover is refused', async () => {
    const { page, input } = pageWith([buyButton(), ...chart()]);

    const refused = failureOf(hoverElement(page, BUY));
    const click = clickElement(page, SAVE);

    expect((await refused).code).toBe('UNSAFE_ACTION_BLOCKED');
    await expect(click).resolves.toBeUndefined();
    expect(input()).toHaveLength(3);
  });
});

describe('the text of fields and editable regions', () => {
  // The dialog of an alert whose message the user has typed: a textarea keeps its text as a text
  // node, which the text content of the dialog includes, and an editable region holds what was
  // typed into it as text nodes as well.
  const dialog = () =>
    fakeElement({
      matches: ['.dialog'],
      attributes: { role: 'dialog' },
      rect: box(400, 200, 400, 300),
      children: [
        fakeElement({ tag: 'span', text: 'Alert message', rect: box(410, 210, 200, 20) }),
        fakeElement({ tag: 'textarea', text: 'a secret note', rect: box(410, 240, 380, 100) }),
        fakeElement({
          attributes: { contenteditable: 'true' },
          rect: box(410, 350, 380, 60),
          children: [
            fakeElement({
              tag: 'p',
              matches: ['.typed'],
              text: 'typed words',
              rect: box(415, 355, 200, 20),
            }),
          ],
        }),
      ],
    });
  const findArgs = (selector: string): ArgsOf<typeof findElements> => [
    { selector, text: null },
    10,
    [...UNSAFE_SELECTORS],
  ];
  const nameArgs = (text: string): ArgsOf<typeof describeElement> => [
    { text },
    [...UNSAFE_SELECTORS],
    [OVERLAP_ROOT],
    TRADING_ACTION_NAMES,
    'click',
    false,
  ];

  test('findElements leaves what was typed into a field or an editable region out of the elements around it', async () => {
    const result = await bothWays(
      findElements,
      [...findArgs('.dialog, .typed')],
      screen(() => [dialog()]),
    );

    // The dialog shows its heading; the paragraph inside the editable region shows nothing.
    expect(result.elements.map(({ name, text }) => ({ name, text }))).toEqual([
      { name: 'Alert message', text: 'Alert message' },
      { name: '', text: '' },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/secret|typed words/);
  });

  test('a target named by its text is named without what was typed into it', async () => {
    const make = screen(() => [dialog()]);

    // The dialog comes before the heading inside it, and is named by the heading alone.
    expect(await bothWays(describeElement, [...nameArgs('Alert message')], make)).toMatchObject({
      found: true,
      rect: box(400, 200, 400, 300),
    });
    for (const typed of ['Alert message a secret note', 'a secret note', 'typed words']) {
      expect(await bothWays(describeElement, [...nameArgs(typed)], make), typed).toMatchObject({
        found: false,
      });
    }
  });
});

test("the options of a select show nothing: what is chosen in a field is the user's", async () => {
  const make = screen(() => [
    fakeElement({
      tag: 'select',
      matches: ['.choice'],
      rect: box(100, 600, 120, 24),
      children: [
        fakeElement({
          tag: 'option',
          matches: ['.choice'],
          text: 'Option A',
          rect: box(100, 624, 120, 20),
        }),
        fakeElement({
          tag: 'option',
          matches: ['.choice'],
          text: 'Option B',
          rect: box(100, 644, 120, 20),
        }),
      ],
    }),
  ]);

  const found = await bothWays(
    findElements,
    [{ selector: '.choice', text: null }, 10, [...UNSAFE_SELECTORS]],
    make,
  );
  const byText = await bothWays(
    describeElement,
    [
      { text: 'Option B' },
      [...UNSAFE_SELECTORS],
      [OVERLAP_ROOT],
      TRADING_ACTION_NAMES,
      'click',
      false,
    ],
    make,
  );

  expect(found.elements.map(({ tag, name, text }) => ({ tag, name, text }))).toEqual([
    { tag: 'select', name: '', text: '' },
    { tag: 'option', name: '', text: '' },
    { tag: 'option', name: '', text: '' },
  ]);
  expect(byText).toMatchObject({ found: false });
});

describe('a page that does not report its zoom', () => {
  // Layout metrics whose visual viewport says nothing about the zoom.
  const withoutZoom = () => {
    const metrics = layoutMetrics({ width: 1280, height: 720, devicePixelRatio: 1 });
    return { ...metrics, cssVisualViewport: { ...metrics.cssVisualViewport, zoom: undefined } };
  };

  test('is refused a click, a hover and a scroll with NOT_AVAILABLE, without any input', async () => {
    const { page, input } = pageWith(chart(), {}, undefined, withoutZoom);

    const refusals = [
      await failureOf(clickElement(page, SAVE)),
      await failureOf(clickPoint(page, { x: 120, y: 60 })),
      await failureOf(hoverElement(page, SAVE)),
      await failureOf(scrollAt(page, { selector: PANE }, { x: 0, y: 100 })),
    ];

    for (const error of refusals) {
      expect(error.code).toBe('NOT_AVAILABLE');
      expect(error.message).toBe('The page did not report its zoom');
    }
    expect(input()).toEqual([]);
  });

  test('is refused the move that follows a target that moved, when the zoom is gone by then', async () => {
    const target = fakeElement({ matches: [SAVE], rect: box(100, 50, 40, 20) });
    let zoomed = true;
    const { page, input } = pageOver(
      createFakeDomWindow([target]),
      afterTheMove(() => {
        target.place(box(300, 80, 40, 20));
        zoomed = false;
      }),
      () =>
        zoomed ? layoutMetrics({ width: 1280, height: 720, devicePixelRatio: 1 }) : withoutZoom(),
    );

    const error = await failureOf(hoverElement(page, SAVE));

    expect(error.message).toBe('The page did not report its zoom');
    expect(input()).toEqual([mouseEvent('mouseMoved', 120, 60)]);
  });
});

describe('trading actions by name', () => {
  // Trading buttons that carry no selector of the guard, as those of an order ticket do: they are
  // known by their names alone. "Sell 100" is two spans side by side, with no space in the text
  // between them, and "Place order" is named by its aria-label and shows a mark.
  const tradingButtons = (): FakeElement[] => [
    fakeElement({ tag: 'button', text: 'Buy', rect: box(100, 600, 60, 24) }),
    fakeElement({
      tag: 'button',
      id: 'order-sell',
      matches: ['#order-sell'],
      rect: box(200, 600, 80, 24),
      children: [
        fakeElement({ tag: 'span', text: 'Sell', rect: box(205, 602, 30, 20) }),
        fakeElement({ tag: 'span', text: '100', rect: box(240, 602, 30, 20) }),
      ],
    }),
    fakeElement({
      tag: 'button',
      attributes: { 'aria-label': 'Place order' },
      rect: box(300, 600, 100, 24),
      children: [fakeElement({ tag: 'span', text: 'Go', rect: box(305, 602, 40, 20) })],
    }),
    fakeElement({ tag: 'button', text: 'Buyback chart', rect: box(500, 600, 100, 24) }),
    fakeElement({ tag: 'button', text: 'Sellers', rect: box(650, 600, 80, 24) }),
  ];
  const make = screen(tradingButtons);
  const TRADING_ACTION_HINT = /^Trading actions are never clicked/;

  test('a click by text on a button named "Buy" is refused, although it carries no selector of the guard', async () => {
    const { page, input } = pageOver(make());

    const error = await failureOf(clickTarget(page, { text: 'buy' }));

    expect(error.code).toBe('UNSAFE_ACTION_BLOCKED');
    expect(error.message).toBe(
      'Refusing to click the element named "buy": the click would reach "Buy", a trading action',
    );
    expect(error.hint).toMatch(TRADING_ACTION_HINT);
    expect(error.details).toEqual({ text: 'buy', name: 'Buy' });
    expect(input()).toEqual([]);
  });

  test('a click by selector on "Sell 100", and at a point on its label, is refused', async () => {
    const bySelector = pageOver(make());
    const atLabel = pageOver(make());

    const onButton = await failureOf(clickElement(bySelector.page, '#order-sell'));
    // The label shows "100", but a click on it activates the button.
    const onLabel = await failureOf(clickPoint(atLabel.page, { x: 255, y: 612 }));

    expect(onButton.toPayload()).toMatchObject({
      code: 'UNSAFE_ACTION_BLOCKED',
      details: { selector: '#order-sell', name: 'Sell 100' },
    });
    expect(onLabel.toPayload()).toMatchObject({
      code: 'UNSAFE_ACTION_BLOCKED',
      message:
        'Refusing to click at (255, 612): the click would reach "Sell 100", a trading action',
      details: { x: 255, y: 612, name: 'Sell 100' },
    });
    expect(onLabel.hint).toMatch(TRADING_ACTION_HINT);
    expect(bySelector.input()).toEqual([]);
    expect(atLabel.input()).toEqual([]);
  });

  test('a click at a point on the mark of "Place order" is refused, by the name of its button', async () => {
    const { page, input } = pageOver(make());

    const error = await failureOf(clickPoint(page, { x: 320, y: 612 }));

    expect(error.code).toBe('UNSAFE_ACTION_BLOCKED');
    expect(error.details).toEqual({ x: 320, y: 612, name: 'Place order' });
    expect(input()).toEqual([]);
  });

  test('a click by selector is refused when a trading action lies at the point it would land on', async () => {
    // A button of an order ticket floats over the middle of the pane, outside the overlap root.
    const floating = () => [
      fakeElement({ tag: 'button', text: 'Buy', rect: box(380, 290, 40, 20) }),
    ];
    const { page, input } = pageOver(screen(floating)());

    const error = await failureOf(clickElement(page, PANE));

    expect(error.toPayload()).toMatchObject({
      code: 'UNSAFE_ACTION_BLOCKED',
      details: { selector: PANE, name: 'Buy' },
    });
    expect(input()).toEqual([]);
  });

  test('"Buyback chart" and "Sellers" are clicked: buy and sell count only as whole words', async () => {
    const { page, types } = pageOver(make());

    await expect(clickTarget(page, { text: 'Buyback chart' })).resolves.toEqual({
      x: 550,
      y: 612,
    });
    await expect(clickTarget(page, { text: 'Sellers' })).resolves.toEqual({ x: 690, y: 612 });

    expect(types()).toEqual([
      'mouseMoved',
      'mousePressed',
      'mouseReleased',
      'mouseMoved',
      'mousePressed',
      'mouseReleased',
    ]);
  });

  test('a hover and a scroll over a trading action are not refused for its name', async () => {
    const { page, types } = pageOver(make());

    await expect(hoverTarget(page, { text: 'Buy' })).resolves.toEqual({
      point: { x: 130, y: 612 },
      warning: null,
    });
    await scrollAt(page, { selector: '#order-sell' }, { x: 0, y: 100 });
    await hoverPoint(page, { x: 320, y: 612 });

    expect(types()).toEqual(['mouseMoved', 'mouseMoved', 'mouseWheel', 'mouseMoved']);
  });

  test('describeElement names the trading action a click would reach, and only for a click', async () => {
    const args = (action: PointerAction): ArgsOf<typeof describeElement> => [
      { selector: '#order-sell' },
      [...UNSAFE_SELECTORS],
      [OVERLAP_ROOT],
      TRADING_ACTION_NAMES,
      action,
      false,
    ];

    expect(await bothWays(describeElement, [...args('click')], make)).toMatchObject({
      unsafe: false,
      tradingAction: 'Sell 100',
    });
    expect(await bothWays(describeElement, [...args('hover')], make)).not.toHaveProperty(
      'tradingAction',
    );
  });
});

describe('trading actions in split labels, input buttons and the text shown', () => {
  const clickArgs = (
    target: { selector: string } | { text: string },
  ): ArgsOf<typeof describeElement> => [
    target,
    [...UNSAFE_SELECTORS],
    [OVERLAP_ROOT],
    TRADING_ACTION_NAMES,
    'click',
    false,
  ];

  test('a label split into spans side by side is read with a space between them', async () => {
    const buttons = () => [
      fakeElement({
        tag: 'button',
        matches: ['#ticket-buy'],
        rect: box(100, 600, 200, 24),
        children: [
          fakeElement({ tag: 'span', text: 'Buy', rect: box(105, 602, 30, 20) }),
          fakeElement({ tag: 'span', text: '1 AAPL @ 150 MKT', rect: box(140, 602, 150, 20) }),
        ],
      }),
      fakeElement({
        tag: 'button',
        matches: ['#quote-sell'],
        rect: box(400, 600, 120, 24),
        children: [
          fakeElement({ tag: 'span', text: '1.08571', rect: box(405, 602, 60, 20) }),
          fakeElement({ tag: 'span', text: 'Sell', rect: box(470, 602, 40, 20) }),
        ],
      }),
    ];
    const make = screen(buttons);

    expect(
      await bothWays(describeElement, [...clickArgs({ selector: '#ticket-buy' })], make),
    ).toMatchObject({
      tradingAction: 'Buy 1 AAPL @ 150 MKT',
    });
    expect(
      await bothWays(describeElement, [...clickArgs({ selector: '#quote-sell' })], make),
    ).toMatchObject({
      tradingAction: '1.08571 Sell',
    });
    // At a point on the second span of the first button, which a click on activates the button.
    const { page, input } = pageOver(make());
    const error = await failureOf(clickPoint(page, { x: 200, y: 612 }));
    expect(error.toPayload()).toMatchObject({
      code: 'UNSAFE_ACTION_BLOCKED',
      details: { x: 200, y: 612, name: 'Buy 1 AAPL @ 150 MKT' },
    });
    expect(input()).toEqual([]);
  });

  test('the text shown is matched even when an aria-label says something else', async () => {
    const make = screen(() => [
      fakeElement({
        tag: 'button',
        attributes: { 'aria-label': 'Confirm' },
        text: 'Buy 100',
        rect: box(100, 600, 80, 24),
      }),
    ]);
    const { page, input } = pageOver(make());

    // The button is named "Confirm", and shows "Buy 100".
    const error = await failureOf(clickTarget(page, { text: 'confirm' }));

    expect(error.toPayload()).toMatchObject({
      code: 'UNSAFE_ACTION_BLOCKED',
      details: { text: 'confirm', name: 'Buy 100' },
    });
    expect(input()).toEqual([]);
  });

  test('a trading action named only by a title is refused, and a title beside a name is not read', async () => {
    const make = screen(() => [
      fakeElement({
        tag: 'button',
        matches: ['#title-only'],
        attributes: { title: 'Buy market' },
        rect: box(100, 600, 30, 24),
        children: [fakeElement({ tag: 'svg', rect: box(105, 602, 20, 20) })],
      }),
      fakeElement({
        tag: 'button',
        matches: ['#named'],
        attributes: { title: 'Sell everything' },
        text: 'Chart',
        rect: box(250, 600, 60, 24),
      }),
    ]);

    expect(
      await bothWays(describeElement, [...clickArgs({ selector: '#title-only' })], make),
    ).toMatchObject({ tradingAction: 'Buy market' });
    expect(
      await bothWays(describeElement, [...clickArgs({ selector: '#named' })], make),
    ).not.toHaveProperty('tradingAction');
    const { page, input } = pageOver(make());
    const error = await failureOf(clickTarget(page, { text: 'buy market' }));
    expect(error.toPayload()).toMatchObject({
      code: 'UNSAFE_ACTION_BLOCKED',
      details: { text: 'buy market', name: 'Buy market' },
    });
    expect(input()).toEqual([]);
  });

  test('the value of an input button is its label, and a trading one is refused', async () => {
    const make = screen(() => [
      fakeElement({
        tag: 'input',
        matches: ['#submit-order'],
        attributes: { type: 'submit', value: 'Place order' },
        rect: box(100, 600, 100, 24),
      }),
      fakeElement({
        tag: 'input',
        matches: ['#sell-button'],
        attributes: { type: 'BUTTON', value: 'Sell' },
        rect: box(250, 600, 60, 24),
      }),
      fakeElement({
        tag: 'input',
        matches: ['#reset'],
        attributes: { type: 'reset', value: 'Reset form' },
        rect: box(350, 600, 80, 24),
      }),
    ]);

    expect(
      await bothWays(describeElement, [...clickArgs({ text: 'place order' })], make),
    ).toMatchObject({
      found: true,
      tradingAction: 'Place order',
    });
    expect(
      await bothWays(describeElement, [...clickArgs({ selector: '#sell-button' })], make),
    ).toMatchObject({
      tradingAction: 'Sell',
    });
    // The label of a button that names no trading action is a name like any other.
    const { page, types } = pageOver(make());
    await expect(clickTarget(page, { text: 'reset form' })).resolves.toEqual({ x: 390, y: 612 });
    expect(types()).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
  });

  test('findElements names an input button by its value, and an input without a type by nothing', async () => {
    const make = screen(() => [
      fakeElement({
        tag: 'input',
        matches: ['.control'],
        attributes: { type: 'submit', value: '  Place   order ' },
        rect: box(100, 600, 100, 24),
      }),
      fakeElement({
        tag: 'input',
        matches: ['.control'],
        attributes: { value: 'typed by the user' },
        rect: box(250, 600, 100, 24),
      }),
    ]);

    const found = await bothWays(
      findElements,
      [{ selector: '.control', text: null }, 10, [...UNSAFE_SELECTORS]],
      make,
    );

    // An input without a type takes text, so its value is the user's and is not read.
    expect(found.elements.map(({ name, text }) => ({ name, text }))).toEqual([
      { name: 'Place order', text: '' },
      { name: '', text: '' },
    ]);
  });

  test('the value of an input of another type is never read, not even for a trading name', async () => {
    // What a field holds is the user's: its value is neither a name nor a reason to refuse.
    const quantity = fakeElement({
      tag: 'input',
      matches: ['#quantity'],
      attributes: { type: 'text', value: 'Buy 100' },
      rect: box(100, 600, 100, 24),
    });
    Object.defineProperty(quantity, 'value', {
      get() {
        throw new Error('The value of a field was read');
      },
    });
    const make = screen(() => [quantity]);

    const look = await bothWays(describeElement, [...clickArgs({ selector: '#quantity' })], make);
    const found = await bothWays(
      findElements,
      [{ selector: '#quantity', text: null }, 10, [...UNSAFE_SELECTORS]],
      make,
    );

    expect(look).not.toHaveProperty('tradingAction');
    expect(found.elements).toEqual([expect.objectContaining({ name: '', text: '' })]);
    expect(JSON.stringify(found)).not.toContain('Buy 100');
  });

  test('a button inside a contenteditable="false" block of an editable region is named and checked', async () => {
    const editor = () =>
      fakeElement({
        attributes: { contenteditable: 'true' },
        rect: box(100, 550, 400, 120),
        children: [
          fakeElement({ tag: 'p', text: 'a typed note', rect: box(105, 555, 200, 20) }),
          fakeElement({
            attributes: { contenteditable: 'false' },
            rect: box(105, 600, 200, 40),
            children: [
              fakeElement({
                tag: 'button',
                matches: ['#widget-buy'],
                text: 'Buy',
                rect: box(110, 605, 60, 24),
              }),
            ],
          }),
        ],
      });
    const make = screen(() => [editor()]);

    expect(
      await bothWays(describeElement, [...clickArgs({ selector: '#widget-buy' })], make),
    ).toMatchObject({
      tradingAction: 'Buy',
    });
    // The typed paragraph of the region is still no name.
    expect(
      await bothWays(describeElement, [...clickArgs({ text: 'a typed note' })], make),
    ).toMatchObject({
      found: false,
    });
  });

  test('a click by selector is refused when what covers its center holds a trading control', async () => {
    // A trading panel lies over the canvas of the pane, outside the overlap root, and holds the
    // trade button away from the center of the canvas. The click would land on the panel.
    const panel = () =>
      fakeElement({
        attributes: { 'data-name': 'trading-panel' },
        rect: box(0, 100, 800, 400),
        children: [fakeElement({ matches: [TRADE_BUTTON], rect: box(700, 110, 60, 30) })],
      });
    const clicked = pageOver(screen(() => [panel()])());
    const hovered = pageOver(screen(() => [panel()])());

    const error = await failureOf(clickElement(clicked.page, PANE));
    await hoverElement(hovered.page, PANE);

    expect(error.toPayload()).toMatchObject({
      code: 'UNSAFE_ACTION_BLOCKED',
      details: { selector: PANE },
    });
    expect(clicked.input()).toEqual([]);
    // The pointer over the panel lands on the panel, so a hover there is no click on it.
    expect(hovered.types()).toEqual(['mouseMoved']);
  });

  test('names read the same way for a click by text and for findElements', async () => {
    // A menu item whose label and shortcut stand apart, in two spans.
    const make = screen(() => [
      fakeElement({
        matches: ['.item'],
        attributes: { role: 'menuitem' },
        rect: box(100, 600, 200, 24),
        children: [
          fakeElement({ tag: 'span', text: 'Undo', rect: box(105, 602, 40, 20) }),
          fakeElement({ tag: 'span', text: 'Ctrl+Z', rect: box(240, 602, 50, 20) }),
        ],
      }),
    ]);

    const found = await bothWays(
      findElements,
      [{ selector: '.item', text: null }, 10, [...UNSAFE_SELECTORS]],
      make,
    );
    const clicked = await clickTarget(pageOver(make()).page, { text: '  undo   CTRL+Z ' });

    expect(found.elements.map(({ name, text }) => ({ name, text }))).toEqual([
      { name: 'Undo Ctrl+Z', text: 'Undo Ctrl+Z' },
    ]);
    expect(clicked).toEqual({ x: 200, y: 612 });
  });
});

describe('trading words split by elements inside them', () => {
  // Words that the screen shows whole, split in the page by an element inside them: an underlined
  // first letter, two spans, a line break opportunity, and a span that makes no box of its own.
  const splitWords = (): FakeElement[] => [
    fakeElement({
      tag: 'button',
      matches: ['#underlined'],
      rect: box(100, 560, 80, 24),
      nodes: [fakeElement({ tag: 'u', text: 'S', rect: box(102, 562, 8, 20) }), 'ell 100'],
    }),
    fakeElement({
      matches: ['#two-spans'],
      rect: box(200, 560, 60, 24),
      children: [
        fakeElement({ tag: 'span', text: 'B', rect: box(202, 562, 10, 20) }),
        fakeElement({ tag: 'span', text: 'uy', rect: box(212, 562, 20, 20) }),
      ],
    }),
    fakeElement({
      tag: 'button',
      matches: ['#break'],
      rect: box(300, 560, 60, 24),
      nodes: ['Se', fakeElement({ tag: 'wbr', rect: box(320, 562, 0, 0) }), 'll'],
    }),
    fakeElement({
      tag: 'button',
      matches: ['#contents'],
      rect: box(400, 560, 80, 24),
      nodes: [
        fakeElement({
          tag: 'span',
          attributes: { style: 'display:contents' },
          text: 'Se',
          rect: box(0, 0, 0, 0),
        }),
        'll 100',
      ],
    }),
    // The same two spans inside a button, for a point on the second one.
    fakeElement({
      tag: 'button',
      rect: box(500, 560, 60, 24),
      children: [
        fakeElement({ tag: 'span', text: 'B', rect: box(502, 562, 10, 20) }),
        fakeElement({ tag: 'span', text: 'uy', rect: box(512, 562, 30, 20) }),
      ],
    }),
  ];
  const make = screen(splitWords);

  test.each([
    ['an underlined first letter', '#underlined', 'Sell 100'],
    ['two spans', '#two-spans', 'Buy'],
    ['a line break opportunity', '#break', 'Sell'],
    ['a span of display: contents', '#contents', 'Sell 100'],
  ])('a click on a word split by %s is refused', async (_case, selector, name) => {
    const { page, input } = pageOver(make());

    const error = await failureOf(clickElement(page, selector));

    expect(error.toPayload()).toMatchObject({
      code: 'UNSAFE_ACTION_BLOCKED',
      details: { selector, name },
    });
    expect(input()).toEqual([]);
  });

  test('a click at a point on the second span of a split word is refused by the word of its button', async () => {
    const { page, input } = pageOver(make());

    const error = await failureOf(clickPoint(page, { x: 525, y: 572 }));

    expect(error.details).toEqual({ x: 525, y: 572, name: 'Buy' });
    expect(input()).toEqual([]);
  });

  test('names shown keep the text with its parts apart', async () => {
    const found = await bothWays(
      findElements,
      [{ selector: '#underlined, #two-spans, #break', text: null }, 10, [...UNSAFE_SELECTORS]],
      make,
    );

    expect(found.elements.map(({ name }) => name)).toEqual(['S ell 100', 'B uy', 'Se ll']);
  });

  test('a refusal quotes the words around the trading action, not the whole text', async () => {
    // A panel whose long text holds the word Sell in the middle.
    const text = `${'a'.repeat(40)} Sell ${'b'.repeat(40)}`;
    const panel = () => [fakeElement({ matches: ['#panel'], text, rect: box(100, 600, 400, 60) })];
    const { page } = pageOver(screen(panel)());

    const error = await failureOf(clickPoint(page, { x: 300, y: 630 }));

    expect(error.details).toEqual({
      x: 300,
      y: 630,
      name: `…${'a'.repeat(19)} Sell ${'b'.repeat(19)}…`,
    });
    expect(error.message).toBe(
      `Refusing to click at (300, 630): the click would reach "…${'a'.repeat(19)} Sell ${'b'.repeat(19)}…", a trading action`,
    );
    // The page function quotes it so, run either way.
    const look = await bothWays(
      describeElement,
      [
        { selector: '#panel' },
        [...UNSAFE_SELECTORS],
        [OVERLAP_ROOT],
        TRADING_ACTION_NAMES,
        'click',
        false,
      ],
      screen(panel),
    );
    expect(look).toMatchObject({ tradingAction: `…${'a'.repeat(19)} Sell ${'b'.repeat(19)}…` });
  });
});

describe('clickable elements that the pointer cursor marks', () => {
  // A quote button of an order panel the way a page can build one: a div without a role, which a
  // handler of the page makes clickable and the pointer cursor shows as such, with the side and the
  // price in spans of their own. The spans declare no cursor and show the pointer of the div.
  const quoteButton = (children?: FakeElement[]): FakeElement =>
    fakeElement({
      id: 'quote-buy',
      matches: ['#quote-buy'],
      cursor: 'pointer',
      rect: box(100, 600, 200, 30),
      children: children ?? [
        fakeElement({ tag: 'span', text: 'Buy', rect: box(105, 605, 40, 20) }),
        fakeElement({ tag: 'span', text: '|', rect: box(150, 605, 10, 20) }),
        fakeElement({
          tag: 'span',
          id: 'quote-price',
          matches: ['#quote-price'],
          text: '1.0857',
          rect: box(165, 605, 80, 20),
        }),
      ],
    });
  const make = screen(() => [quoteButton()]);
  const clickArgs = (target: PointerTarget, action: PointerAction = 'click') =>
    [target, [...UNSAFE_SELECTORS], [OVERLAP_ROOT], TRADING_ACTION_NAMES, action, false] as ArgsOf<
      typeof describeElement
    >;

  test('a click at a point on the price inside a role-less clickable div labelled "Buy | 1.0857" is refused', async () => {
    const { page, input } = pageOver(make());

    const error = await failureOf(clickPoint(page, { x: 200, y: 615 }));

    expect(error.toPayload()).toMatchObject({
      code: 'UNSAFE_ACTION_BLOCKED',
      message:
        'Refusing to click at (200, 615): the click would reach "Buy | 1.0857", a trading action',
      details: { x: 200, y: 615, name: 'Buy | 1.0857' },
    });
    expect(input()).toEqual([]);
  });

  test('a click by selector on the price span is refused by the name of the clickable div', async () => {
    const { page, input } = pageOver(make());

    const error = await failureOf(clickElement(page, '#quote-price'));

    expect(error.toPayload()).toMatchObject({
      code: 'UNSAFE_ACTION_BLOCKED',
      details: { selector: '#quote-price', name: 'Buy | 1.0857' },
    });
    expect(input()).toEqual([]);
  });

  test('describeElement names the clickable div, run either way, for a click only', async () => {
    expect(await bothWays(describeElement, clickArgs({ x: 200, y: 615 }), make)).toMatchObject({
      unsafe: false,
      tradingAction: 'Buy | 1.0857',
    });
    expect(
      await bothWays(describeElement, clickArgs({ x: 200, y: 615 }, 'hover'), make),
    ).not.toHaveProperty('tradingAction');
  });

  test('the clickable element is where the run of pointer cursors ends, not the first element in it', async () => {
    // The cursor is inherited, so the wrapper around the price shows the pointer too. Taken as the
    // control, it would name the price alone.
    const nested = screen(() => [
      quoteButton([
        fakeElement({ tag: 'span', text: 'Buy', rect: box(105, 605, 40, 20) }),
        fakeElement({
          rect: box(160, 602, 100, 26),
          children: [fakeElement({ tag: 'span', text: '1.0857', rect: box(165, 605, 80, 20) })],
        }),
      ]),
    ]);
    const { page, input } = pageOver(nested());

    const error = await failureOf(clickPoint(page, { x: 200, y: 615 }));

    expect(error.details).toEqual({ x: 200, y: 615, name: 'Buy 1.0857' });
    expect(input()).toEqual([]);
  });

  test('a span that declares a cursor of its own inside a clickable div still reaches the div', async () => {
    const own = screen(() => [
      quoteButton([
        fakeElement({ tag: 'span', text: 'Buy', rect: box(105, 605, 40, 20) }),
        fakeElement({ tag: 'span', text: '1.0857', cursor: 'text', rect: box(165, 605, 80, 20) }),
      ]),
    ]);
    const { page, input } = pageOver(own());

    const error = await failureOf(clickPoint(page, { x: 200, y: 615 }));

    expect(error.details).toMatchObject({ name: 'Buy 1.0857' });
    expect(input()).toEqual([]);
  });

  test('a span inside a div with the default cursor is not refused for a trading word elsewhere in the div', async () => {
    const plain = screen(() => [
      fakeElement({
        cursor: 'default',
        rect: box(100, 600, 300, 30),
        children: [
          fakeElement({ tag: 'span', text: 'Buy', rect: box(105, 605, 40, 20) }),
          fakeElement({ tag: 'span', text: 'Details', rect: box(200, 605, 80, 20) }),
        ],
      }),
    ]);
    const { page, types } = pageOver(plain());

    await expect(clickTarget(page, { x: 240, y: 615 })).resolves.toEqual({ x: 240, y: 615 });

    expect(types()).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
  });

  // Six levels of wrappers, each of which shows the pointer it inherits, between the price and a
  // clickable div that names a trading action.
  function deepQuote(levels: number): () => TvWindow {
    let inner = fakeElement({ tag: 'span', text: '1.0857', rect: box(165, 605, 80, 20) });
    for (let level = 0; level < levels; level += 1) {
      inner = fakeElement({ rect: box(160, 602, 100, 26), children: [inner] });
    }
    return screen(() => [
      quoteButton([fakeElement({ tag: 'span', text: 'Buy', rect: box(105, 605, 40, 20) }), inner]),
    ]);
  }

  test('the clickable element counts up to six levels above what the click lands on', async () => {
    // Five wrappers put the div six levels up.
    const { page, input } = pageOver(deepQuote(5)());

    const error = await failureOf(clickPoint(page, { x: 200, y: 615 }));

    expect(error.details).toMatchObject({ name: 'Buy 1.0857' });
    expect(input()).toEqual([]);
  });

  test('a clickable element further up than six levels is not looked for', async () => {
    // Six wrappers put the div seven levels up: the run of pointers ends at the sixth wrapper, which
    // names the price alone.
    const { page, types } = pageOver(deepQuote(6)());

    await clickPoint(page, { x: 200, y: 615 });

    expect(types()).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
  });

  test('a page whose getComputedStyle throws, or that has none, is judged as before', async () => {
    const throwing = (): TvWindow => {
      const win = make();
      dom(win).getComputedStyle = () => {
        throw new Error('No style for this element');
      };
      return win;
    };
    const withoutStyle = screen(() => [quoteButton()], { without: ['getComputedStyle'] });

    for (const maker of [throwing, withoutStyle]) {
      const { page, types } = pageOver(maker());

      // The price is named "1.0857", and no control holds it but the div the cursor tells.
      await clickPoint(page, { x: 200, y: 615 });

      expect(types()).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
      expect(await bothWays(describeElement, clickArgs({ x: 200, y: 615 }), maker)).toEqual({
        found: true,
        visible: true,
        unsafe: false,
        coverage: 'clear',
        obscuredBy: '',
      });
    }
  });

  test('a hover over the price of the clickable div is not refused for its name', async () => {
    const { page, types } = pageOver(make());

    await expect(hoverPoint(page, { x: 200, y: 615 })).resolves.toEqual({
      point: { x: 200, y: 615 },
      warning: null,
    });

    expect(types()).toEqual(['mouseMoved']);
  });
});

describe('keys on a focused trading action', () => {
  const KEY_HINT = /^A key on a trading action would click it/;
  // describeFocusedElement as the bridge calls it.
  const focusArgs = (): ArgsOf<typeof describeFocusedElement> => [
    [...UNSAFE_SELECTORS],
    TRADING_ACTION_NAMES,
  ];

  test('Enter on a focused <button>Buy 1</button> with no data-name is refused, with no key event sent', async () => {
    const buy = fakeElement({ tag: 'button', text: 'Buy 1' });
    const { page, input } = pageWith([buy], { focus: buy });

    const error = await failureOf(pressKey(page, 'Enter'));

    expect(error.toPayload()).toEqual({
      code: 'UNSAFE_ACTION_BLOCKED',
      message:
        'Refusing to press a key: the focus is on `button`, and a key there would reach "Buy 1", a trading action',
      hint: expect.stringMatching(KEY_HINT) as string,
      details: { action: 'pressKey', focused: 'button', name: 'Buy 1' },
    });
    expect(input()).toEqual([]);
  });

  test.each<[string, () => { focus: FakeElement; elements: FakeElement[] }]>([
    [
      'a control named by its aria-label',
      () => {
        const focus = fakeElement({ tag: 'button', attributes: { 'aria-label': 'Place order' } });
        return { focus, elements: [focus] };
      },
    ],
    [
      'an input button named by its value',
      () => {
        const focus = fakeElement({
          tag: 'input',
          attributes: { type: 'submit', value: 'Close position' },
        });
        return { focus, elements: [focus] };
      },
    ],
    [
      'a button whose label is split into spans',
      () => {
        const focus = fakeElement({
          tag: 'button',
          children: [fakeElement({ tag: 'span', text: 'Sell' }), fakeElement({ text: '100' })],
        });
        return { focus, elements: [focus] };
      },
    ],
    [
      'a button whose word an element splits inside',
      () => {
        const focus = fakeElement({
          tag: 'button',
          nodes: [fakeElement({ tag: 'u', text: 'S' }), 'ell'],
        });
        return { focus, elements: [focus] };
      },
    ],
    [
      'a span inside a button named after a trading action',
      () => {
        const focus = fakeElement({ tag: 'span', text: '1.0857' });
        return {
          focus,
          elements: [
            fakeElement({ tag: 'button', children: [fakeElement({ text: 'Buy' }), focus] }),
          ],
        };
      },
    ],
    [
      'a span inside a role-less div the pointer cursor shows as clickable',
      () => {
        const focus = fakeElement({ tag: 'span', text: '1.0857' });
        return {
          focus,
          elements: [
            fakeElement({ cursor: 'pointer', children: [fakeElement({ text: 'Sell' }), focus] }),
          ],
        };
      },
    ],
  ])('any key is refused while the focus is on %s', async (_case, build) => {
    const { focus, elements } = build();
    const { page, input } = pageWith(elements, { focus });

    for (const key of ['Enter', 'Escape', 'a']) {
      const error = await failureOf(pressKey(page, key));
      expect(error.code, key).toBe('UNSAFE_ACTION_BLOCKED');
      expect(error.details, key).toMatchObject({ action: 'pressKey' });
    }
    expect(input()).toEqual([]);
  });

  test('a focused container is not refused for the trading words of what it holds, and neither is the body', async () => {
    // Key events go to the focused element and not to its descendants: the text a container shows
    // is what it holds.
    const pane = fakeElement({
      attributes: { 'data-qa-id': 'pane' },
      children: [fakeElement({ tag: 'button', text: 'Buy' }), fakeElement({ text: 'Sell 100' })],
    });
    const onPane = pageWith([pane], { focus: pane });
    const onBody = pageWith([fakeElement({ tag: 'button', text: 'Sell' })]);

    await pressKey(onPane.page, 'Escape');
    await pressKey(onBody.page, 'Enter');

    expect(onPane.types()).toEqual(['rawKeyDown', 'keyUp']);
    expect(onBody.types()).toEqual(['keyDown', 'keyUp']);
  });

  test('typing into a text field is unaffected by a trading name around it, while a key there is refused', async () => {
    // A label activates its field, so it is the control of the field.
    const field = fakeElement({ tag: 'input', id: 'qty' });
    const label = fakeElement({
      tag: 'label',
      children: [fakeElement({ text: 'Buy quantity' }), field],
    });
    const { page, input } = pageWith([label], { focus: field });

    await typeText(page, '100');
    const error = await failureOf(pressKey(page, '5'));

    expect(error.details).toEqual({
      action: 'pressKey',
      focused: 'input#qty',
      name: 'Buy quantity',
    });
    expect(input()).toEqual([{ method: 'Input.insertText', params: { text: '100' } }]);
  });

  test('the value typed into a focused field is never read as a name', async () => {
    const field = fakeElement({ tag: 'input', attributes: { type: 'text', value: 'Buy 100' } });
    const { page, types } = pageWith([field], { focus: field });

    await pressKey(page, 'Backspace');

    expect(types()).toEqual(['rawKeyDown', 'keyUp']);
  });

  // An order ticket made as a form: Enter in its quantity field submits the form, which clicks its
  // default button, the first submit button of the form.
  function ticket(buttons: FakeElement[]): { field: FakeElement; elements: FakeElement[] } {
    const field = fakeElement({ tag: 'input', id: 'qty', attributes: { type: 'number' } });
    return {
      field,
      elements: [fakeElement({ tag: 'form', matches: ['form'], children: [field, ...buttons] })],
    };
  }

  test('Enter in a field of a form whose default button is a trading action is refused, other keys are not', async () => {
    const { field, elements } = ticket([fakeElement({ tag: 'button', text: 'Place order' })]);
    const { page, input, types } = pageWith(elements, { focus: field });

    const error = await failureOf(pressKey(page, 'Enter'));
    const shifted = await failureOf(pressKey(page, 'Enter', ['Shift']));
    await pressKey(page, '5');

    expect(error.toPayload()).toEqual({
      code: 'UNSAFE_ACTION_BLOCKED',
      message:
        'Refusing to press Enter: the focus is in a field of a form whose default button is "Place order", a trading action, which Enter would click',
      hint: expect.stringMatching(KEY_HINT) as string,
      details: { action: 'pressKey', focused: 'input#qty', name: 'Place order' },
    });
    expect(shifted.code).toBe('UNSAFE_ACTION_BLOCKED');
    expect(types()).toEqual(['keyDown', 'keyUp']);
    expect(input()).toHaveLength(2);
  });

  test.each<[string, boolean, () => FakeElement[]]>([
    [
      'a submit input',
      true,
      () => [fakeElement({ tag: 'input', attributes: { type: 'submit', value: 'Buy' } })],
    ],
    [
      'a button of type submit inside a wrapper',
      true,
      () => [
        fakeElement({
          children: [
            fakeElement({ tag: 'button', attributes: { type: 'submit' }, text: 'Sell 1' }),
          ],
        }),
      ],
    ],
    [
      'a plain button before it, which is no submit button',
      true,
      () => [
        fakeElement({ tag: 'button', attributes: { type: 'button' }, text: 'Cancel' }),
        fakeElement({ tag: 'button', text: 'Buy' }),
      ],
    ],
    [
      'a first submit button that names no trading action',
      false,
      () => [
        fakeElement({ tag: 'button', text: 'Search' }),
        fakeElement({ tag: 'button', text: 'Buy' }),
      ],
    ],
    [
      'no submit button at all',
      false,
      () => [fakeElement({ tag: 'button', attributes: { type: 'reset' }, text: 'Sell' })],
    ],
  ])('Enter in a form with %s is refused: %s', async (_case, refused, buttons) => {
    const { field, elements } = ticket(buttons());
    const { page, types } = pageWith(elements, { focus: field });

    const outcome = await pressKey(page, 'Enter').then(
      () => 'sent',
      (error: unknown) => (error as TvMcpError).code,
    );

    expect(outcome).toBe(refused ? 'UNSAFE_ACTION_BLOCKED' : 'sent');
    expect(types()).toEqual(refused ? [] : ['keyDown', 'keyUp']);
  });

  test('Enter is refused in an input that names a form it does not sit in, whose default button is a trading action', async () => {
    // <input form="ticket"> outside the form: a page gives the input its form as the form property.
    const make = (): TvWindow => {
      const form = fakeElement({
        tag: 'form',
        children: [fakeElement({ tag: 'button', text: 'Buy' })],
      });
      const field = fakeElement({ tag: 'input', id: 'qty' });
      Object.defineProperty(field, 'form', { value: form });
      return createFakeDomWindow([form, field], { focus: field });
    };
    const { page, input } = pageOver(make());

    const error = await failureOf(pressKey(page, 'Enter'));

    expect(error.details).toEqual({ action: 'pressKey', focused: 'input#qty', name: 'Buy' });
    expect(input()).toEqual([]);
    expect(await bothWays(describeFocusedElement, focusArgs(), make)).toMatchObject({
      formSubmit: 'Buy',
    });
  });

  test('describeFocusedElement reports the trading action a key would reach, and the one Enter would submit to, run either way', async () => {
    const buy = fakeElement({ tag: 'button', text: 'Buy 1' });
    const onButton = () => createFakeDomWindow([buy], { focus: buy });
    const form = () => {
      const { field, elements } = ticket([fakeElement({ tag: 'button', text: 'Sell 2' })]);
      return createFakeDomWindow(elements, { focus: field });
    };
    const plain = () => createFakeDomWindow([fakeElement({ tag: 'button', text: 'Save' })]);

    expect(await bothWays(describeFocusedElement, focusArgs(), onButton)).toEqual({
      unsafe: false,
      editable: false,
      opaque: false,
      focused: 'button',
      tradingAction: 'Buy 1',
    });
    expect(await bothWays(describeFocusedElement, focusArgs(), form)).toEqual({
      unsafe: false,
      editable: true,
      opaque: false,
      focused: 'input#qty',
      formSubmit: 'Sell 2',
    });
    expect(await bothWays(describeFocusedElement, focusArgs(), plain)).toEqual({
      unsafe: false,
      editable: false,
      opaque: false,
      focused: 'body',
    });
  });

  test('a focus on a trading control is reported unsafe before its name is', async () => {
    const buy = fakeElement({ tag: 'button', matches: [BUY], text: 'Buy' });
    const { page } = pageWith([buy], { focus: buy });

    const error = await failureOf(pressKey(page, 'Enter'));

    expect(error.message).toMatch(/part of a broker trading control/);
  });
});

describe('describeFocusedElement reads names the way describeElement does', () => {
  const args = (): ArgsOf<typeof describeFocusedElement> => [
    [...UNSAFE_SELECTORS],
    TRADING_ACTION_NAMES,
  ];
  // A page whose focus is on the element `build` names, among the elements it gives.
  const focusing =
    (build: () => { focus: FakeElement; elements: FakeElement[] }, options: FakeDomOptions = {}) =>
    (): TvWindow => {
      const { focus, elements } = build();
      return createFakeDomWindow(elements, { ...options, focus });
    };
  const alone = (focus: FakeElement) => ({ focus, elements: [focus] });
  const inside = (wrap: (focus: FakeElement) => FakeElement) => () => {
    const focus = fakeElement({ tag: 'span', text: '1.0857' });
    return { focus, elements: [wrap(focus)] };
  };
  const withoutStyle: FakeDomOptions = { without: ['getComputedStyle'] };
  const throwingStyle = (make: () => TvWindow) => (): TvWindow => {
    const win = make();
    dom(win).getComputedStyle = () => {
      throw new Error('No style for this element');
    };
    return win;
  };
  const pointerDiv = (focus: FakeElement) =>
    fakeElement({ cursor: 'pointer', children: [fakeElement({ text: 'Sell' }), focus] });
  const long = `${'a'.repeat(30)} Buy ${'b'.repeat(30)}`;

  test.each<[string, () => TvWindow, Record<string, string>]>([
    [
      'the aria-label of the focused element',
      focusing(() =>
        alone(fakeElement({ tag: 'div', attributes: { 'aria-label': 'Place order' } })),
      ),
      { tradingAction: 'Place order' },
    ],
    [
      'the value of an input button',
      focusing(() =>
        alone(fakeElement({ tag: 'input', attributes: { type: 'reset', value: 'Close all' } })),
      ),
      { tradingAction: 'Close all' },
    ],
    [
      'the title of a focused control that nothing else names',
      focusing(() =>
        alone(fakeElement({ tag: 'button', attributes: { title: 'Close position' } })),
      ),
      { tradingAction: 'Close position' },
    ],
    [
      'no title of a focused control that its text names',
      focusing(() =>
        alone(fakeElement({ tag: 'button', attributes: { title: 'Sell all' }, text: 'Chart' })),
      ),
      {},
    ],
    [
      'a label split into spans, with a space between them',
      focusing(() =>
        alone(
          fakeElement({
            tag: 'button',
            children: [fakeElement({ text: 'Sell' }), fakeElement({ text: '100' })],
          }),
        ),
      ),
      { tradingAction: 'Sell 100' },
    ],
    [
      'a word an element splits inside, run together',
      focusing(() =>
        alone(fakeElement({ tag: 'button', nodes: [fakeElement({ tag: 'u', text: 'B' }), 'uy'] })),
      ),
      { tradingAction: 'Buy' },
    ],
    [
      'the button the focused span sits in, without the field inside the button',
      focusing(
        inside((focus) =>
          fakeElement({
            tag: 'button',
            children: [fakeElement({ text: 'Buy' }), fakeElement({ tag: 'input' }), focus],
          }),
        ),
      ),
      { tradingAction: 'Buy 1.0857' },
    ],
    [
      'the clickable div the pointer cursor shows',
      focusing(inside(pointerDiv)),
      { tradingAction: 'Sell 1.0857' },
    ],
    [
      'the clickable div, where the run of pointer cursors ends below an element that shows another',
      focusing(
        inside((focus) => fakeElement({ cursor: 'default', children: [pointerDiv(focus)] })),
      ),
      { tradingAction: 'Sell 1.0857' },
    ],
    [
      'no clickable div on a page without getComputedStyle',
      focusing(inside(pointerDiv), withoutStyle),
      {},
    ],
    [
      'no clickable div on a page whose getComputedStyle throws',
      throwingStyle(focusing(inside(pointerDiv))),
      {},
    ],
    [
      'the words around a trading action in a long label',
      focusing(() => alone(fakeElement({ tag: 'button', text: long }))),
      { tradingAction: `…${'a'.repeat(19)} Buy ${'b'.repeat(19)}…` },
    ],
    [
      'no text of a control inside a field',
      focusing(() => {
        const focus = fakeElement({ tag: 'span', attributes: { role: 'option' }, text: 'Sell' });
        return { focus, elements: [fakeElement({ tag: 'select', children: [focus] })] };
      }),
      {},
    ],
    [
      'the default button of the form, inside a wrapper',
      focusing(() => {
        const focus = fakeElement({ tag: 'input', attributes: { type: 'search' } });
        return {
          focus,
          elements: [
            fakeElement({
              tag: 'form',
              matches: ['form'],
              children: [
                focus,
                fakeElement({ children: [fakeElement({ tag: 'button', text: 'Sell 5' })] }),
              ],
            }),
          ],
        };
      }),
      { formSubmit: 'Sell 5' },
    ],
    [
      'the default button of the form, an input of type image named by its aria-label',
      focusing(() => {
        const focus = fakeElement({ tag: 'input' });
        return {
          focus,
          elements: [
            fakeElement({
              tag: 'form',
              matches: ['form'],
              children: [
                focus,
                fakeElement({
                  tag: 'input',
                  attributes: { type: 'image', 'aria-label': 'Buy now' },
                }),
              ],
            }),
          ],
        };
      }),
      { formSubmit: 'Buy now' },
    ],
    [
      'no default button for an input that is a button itself',
      focusing(() => {
        const focus = fakeElement({ tag: 'input', attributes: { type: 'submit', value: 'Go' } });
        return {
          focus,
          elements: [
            fakeElement({
              tag: 'form',
              matches: ['form'],
              children: [focus, fakeElement({ tag: 'button', text: 'Buy' })],
            }),
          ],
        };
      }),
      {},
    ],
    [
      'no form for an input that sits in none',
      focusing(() => alone(fakeElement({ tag: 'input' }))),
      {},
    ],
  ])('%s', async (_case, make, expected) => {
    const found = await bothWays(describeFocusedElement, args(), make);

    const { tradingAction, formSubmit } = found as { tradingAction?: string; formSubmit?: string };
    expect({
      ...(tradingAction === undefined ? {} : { tradingAction }),
      ...(formSubmit === undefined ? {} : { formSubmit }),
    }).toEqual(expected);
  });
});

describe('the options of a click that only the tools of this server pass', () => {
  // A tab of the window chrome: the title shows the symbol and the layout name of the user, "Sell
  // the rally", and the close button lies beside the title, or over the middle of it in a strip
  // squeezed narrow.
  const TITLE = '#title';
  const strip =
    (closeOverTitle = false): (() => TvWindow) =>
    () =>
      createFakeDomWindow(
        [
          background(),
          fakeElement({
            id: 'tab',
            rect: box(80, 0, 200, 34),
            children: [
              fakeElement({
                id: 'title',
                matches: [TITLE],
                rect: box(90, 4, 160, 26),
                children: [
                  fakeElement({ tag: 'span', text: 'AAPL', rect: box(90, 8, 60, 18) }),
                  fakeElement({ tag: 'span', text: 'Sell the rally', rect: box(150, 8, 100, 18) }),
                ],
              }),
              fakeElement({
                tag: 'button',
                id: 'close',
                attributes: { 'aria-label': 'Close' },
                rect: closeOverTitle ? box(160, 7, 20, 20) : box(254, 7, 20, 20),
              }),
            ],
          }),
        ],
        { viewport: VIEWPORT },
      );
  // The title spans (90, 4) to (250, 30), so a click lands on its center, (170, 17).
  const clickAtTitle = [
    mouseEvent('mouseMoved', 170, 17),
    mouseEvent('mousePressed', 170, 17),
    mouseEvent('mouseReleased', 170, 17),
  ];

  test('a click on an element named after a trading action is refused by default, and goes through with skipTradingNames', async () => {
    const refused = pageOver(strip()());
    const allowed = pageOver(strip()());

    const error = await failureOf(clickElement(refused.page, TITLE));
    await clickElement(allowed.page, TITLE, { skipTradingNames: true });

    expect(error.code).toBe('UNSAFE_ACTION_BLOCKED');
    expect(error.details).toEqual({ selector: TITLE, name: 'AAPL Sell the rally' });
    expect(refused.input()).toEqual([]);
    expect(allowed.input()).toEqual(clickAtTitle);
  });

  test('skipTradingNames leaves every other guard in place', async () => {
    const unsafe = pageOver(screen(() => [buyButton()])());
    const covered = pageOver(screen(() => [openMenu()])());
    const unzoomed = pageWith(chart(), {}, undefined, () => ({}));
    const zoomed = pageWith(chart(), { zoom: 1.25 });

    const onTradingControl = await failureOf(
      clickElement(unsafe.page, BUY, { skipTradingNames: true }),
    );
    const underMenu = await failureOf(clickElement(covered.page, PANE, { skipTradingNames: true }));
    const withoutZoom = await failureOf(
      clickElement(unzoomed.page, SAVE, { skipTradingNames: true }),
    );
    await clickElement(zoomed.page, SAVE, { skipTradingNames: true });

    expect(onTradingControl.code).toBe('UNSAFE_ACTION_BLOCKED');
    expect(underMenu.toPayload()).toMatchObject({
      code: 'NOT_AVAILABLE',
      details: { selector: PANE, obscuredBy: 'div#menu-item' },
    });
    expect(withoutZoom.code).toBe('NOT_AVAILABLE');
    for (const { input } of [unsafe, covered, unzoomed]) {
      expect(input()).toEqual([]);
    }
    // The point goes out in DIPs, as for any click: (120, 60) at 125%.
    expect(zoomed.input()).toEqual([
      mouseEvent('mouseMoved', 150, 75),
      mouseEvent('mousePressed', 150, 75),
      mouseEvent('mouseReleased', 150, 75),
    ]);
  });

  test('skipTradingNames still looks again once the pointer is there, and presses only on a look as clean as the first', async () => {
    const item = fakeElement({ id: 'menu-item', rect: box(500, 500, 40, 20) });
    const win = strip()();
    const { page, types } = pageOver(
      win,
      afterTheMove(() => {
        dom(win).document.elementFromPoint = () => buyButton();
      }),
    );
    const menuWin = createFakeDomWindow([background(), overlapRoot([item]), ...chart()], {
      viewport: VIEWPORT,
    });
    const menu = pageOver(
      menuWin,
      afterTheMove(() => {
        dom(menuWin).document.elementFromPoint = () => item;
      }),
    );

    const onTradingControl = await failureOf(clickElement(page, TITLE, { skipTradingNames: true }));
    const underMenu = await failureOf(clickElement(menu.page, SAVE, { skipTradingNames: true }));

    expect(onTradingControl.code).toBe('UNSAFE_ACTION_BLOCKED');
    expect(underMenu.code).toBe('NOT_AVAILABLE');
    expect(types()).toEqual(['mouseMoved']);
    expect(menu.types()).toEqual(['mouseMoved']);
  });

  test('skipTradingNames keeps the turn of the page: a second call waits for the first', async () => {
    const { page, types } = pageOver(strip()());

    await Promise.all([
      clickElement(page, TITLE, { skipTradingNames: true }),
      clickElement(page, TITLE, { skipTradingNames: true }),
    ]);

    expect(types()).toEqual([
      'mouseMoved',
      'mousePressed',
      'mouseReleased',
      'mouseMoved',
      'mousePressed',
      'mouseReleased',
    ]);
  });

  test('onTargetOnly refuses a click whose center lies on another element, before anything is sent', async () => {
    const strict = pageOver(strip(true)());
    const plain = pageOver(strip(true)());

    const error = await failureOf(
      clickElement(strict.page, TITLE, { skipTradingNames: true, onTargetOnly: true }),
    );
    // Without it, an element stacked over the target that is no layer does not stop a click.
    await clickElement(plain.page, TITLE, { skipTradingNames: true });

    expect(error.toPayload()).toEqual({
      code: 'NOT_AVAILABLE',
      message: 'Something else lies at the center of `#title`: `button#close`',
      hint:
        'Nothing was clicked: the click has to land on the element itself. Try again once the ' +
        'page has settled.',
      details: { selector: TITLE, obscuredBy: 'button#close' },
    });
    expect(strict.input()).toEqual([]);
    expect(plain.types()).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
  });

  test('onTargetOnly clicks a target whose center lies on something inside it', async () => {
    const { page, input } = pageOver(strip()());

    await clickElement(page, TITLE, { skipTradingNames: true, onTargetOnly: true });

    expect(input()).toEqual(clickAtTitle);
  });

  test('onTargetOnly looks again once the pointer is there: an element that moved over the center stops the press', async () => {
    const win = strip()();
    const close = fakeElement({ tag: 'button', id: 'close', rect: box(160, 7, 20, 20) });
    const { page, types } = pageOver(
      win,
      afterTheMove(() => {
        dom(win).document.elementFromPoint = () => close;
      }),
    );

    const error = await failureOf(
      clickElement(page, TITLE, { skipTradingNames: true, onTargetOnly: true }),
    );

    expect(error.toPayload()).toMatchObject({
      code: 'NOT_AVAILABLE',
      details: { selector: TITLE, obscuredBy: 'button#close' },
    });
    expect(types()).toEqual(['mouseMoved']);
  });

  test('describeElement reports a center that lies on another element only when asked to, run either way', async () => {
    const args = (
      target: { selector: string } | { x: number; y: number },
      onTargetOnly: boolean,
    ): ArgsOf<typeof describeElement> => [
      target,
      [...UNSAFE_SELECTORS],
      [OVERLAP_ROOT],
      TRADING_ACTION_NAMES,
      'click',
      onTargetOnly,
    ];

    expect(
      await bothWays(describeElement, [...args({ selector: TITLE }, true)], strip(true)),
    ).toEqual({
      found: true,
      visible: true,
      unsafe: false,
      coverage: 'off-target',
      obscuredBy: 'button#close',
      rect: box(90, 4, 160, 26),
      tradingAction: 'AAPL Sell the rally',
    });
    expect(
      await bothWays(describeElement, [...args({ selector: TITLE }, false)], strip(true)),
    ).toMatchObject({ coverage: 'clear', obscuredBy: '' });
    expect(
      await bothWays(describeElement, [...args({ selector: TITLE }, true)], strip()),
    ).toMatchObject({ coverage: 'clear', obscuredBy: '' });
    // A point is the target itself, so there is nothing else for it to land on.
    expect(
      await bothWays(describeElement, [...args({ x: 170, y: 17 }, true)], strip(true)),
    ).toMatchObject({ coverage: 'clear' });
  });
});
