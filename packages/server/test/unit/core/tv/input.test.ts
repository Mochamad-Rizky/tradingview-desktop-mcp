import { setImmediate as settle } from 'node:timers/promises';
import type { CdpSession } from '../../../../src/core/cdp/types.js';
import { TimeoutError } from '../../../../src/core/errors.js';
import {
  clickElement,
  describeElement,
  describeFocusedElement,
  pressKey,
  typeText,
  type InputPage,
  type KeyModifier,
} from '../../../../src/core/tv/input.js';
import { createPageBridge } from '../../../../src/core/tv/page-bridge.js';
import { SELECTORS, UNSAFE_SELECTORS } from '../../../../src/core/tv/selectors.js';
import type { TvWindow } from '../../../../src/core/tv/tv-window.js';
import { failureOf } from '../../../helpers/failure-of.js';
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

// describeElement as the bridge calls it: with the real lists of selectors to refuse and of the
// layers that cover a page.
function look(win: TvWindow, selector: string) {
  return describeElement(win, selector, [...UNSAFE_SELECTORS], [OVERLAP_ROOT]);
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
// real bridge, and every other command goes to `handleInput`, which may reject or wait.
function pageOver(
  win: object,
  handleInput: (command: SentCommand) => unknown = () => ({}),
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
): FakePage {
  return pageOver(createFakeDomWindow(elements, options), handleInput);
}

// The window as the fake really is, with its own elements, so that a test can move the focus.
function dom(win: TvWindow): FakeDomWindow {
  return win as unknown as FakeDomWindow;
}

function mouseEvent(type: string, x: number, y: number): SentCommand {
  const pressed = type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 };
  return { method: 'Input.dispatchMouseEvent', params: { type, x, y, ...pressed } };
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

  test('does not flag a safe element for an unsafe control elsewhere on the page', () => {
    // The ticket covers the center of the pane, but it is not a trading control itself, and the
    // control it holds lies elsewhere: only what the click would hit counts as unsafe. Being
    // covered is a different matter, and is reported on its own.
    const ticket = fakeElement({
      attributes: { 'data-name': 'order-ticket' },
      rect: box(300, 250, 200, 100),
      children: [fakeElement({ matches: [BUY], rect: box(700, 20, 60, 30) })],
    });
    const win = createFakeDomWindow(chart([overlapRoot([ticket])]));

    expect(look(win, PANE)).toMatchObject({
      found: true,
      visible: true,
      unsafe: false,
      coverage: 'obscured',
      obscuredBy: 'div[data-name="order-ticket"]',
    });
    expect(look(win, SAVE)).toMatchObject({ unsafe: false, coverage: 'clear', obscuredBy: '' });
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

    expect(() => describeElement(win, BUY, [], [OVERLAP_ROOT])).toThrow(/unsafe/);
  });

  test('refuses to judge without the selectors of the layers that cover a page', () => {
    const win = createFakeDomWindow([fakeElement({ matches: [BUY] })]);

    expect(() => describeElement(win, BUY, [...UNSAFE_SELECTORS], [])).toThrow(/cover/);
  });
});

describe('describeFocusedElement', () => {
  // As the bridge calls it: with the real list of selectors to refuse.
  function focusOf(win: TvWindow) {
    return describeFocusedElement(win, [...UNSAFE_SELECTORS]);
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

    expect(() => describeFocusedElement(win, [])).toThrow(/unsafe/);
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

    expect(sent.map(({ method }) => method)).toEqual([
      'Runtime.evaluate',
      'Input.dispatchMouseEvent',
      'Runtime.evaluate',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
    ]);
  });

  describe('when the pointer arriving changes the page', () => {
    // A hover that opens a flyout, or moves the target, is how the page changes between the first
    // lookup and the press. The fake session plays the page: when the pointer moves it runs
    // `change`, and the second lookup sees the result.
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
      // The click: its lookup, the move, its second lookup, the press and the release.
      'Runtime.evaluate',
      'Input.dispatchMouseEvent',
      'Runtime.evaluate',
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
