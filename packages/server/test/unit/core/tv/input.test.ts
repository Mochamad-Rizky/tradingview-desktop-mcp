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
import { UNSAFE_SELECTORS } from '../../../../src/core/tv/selectors.js';
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

// describeElement as the bridge calls it: with the real list of selectors to refuse.
function look(win: TvWindow, selector: string) {
  return describeElement(win, selector, [...UNSAFE_SELECTORS]);
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
    // control it holds lies elsewhere: only what the click would hit counts.
    const ticket = fakeElement({
      matches: ['[data-name="order-ticket"]'],
      rect: box(300, 250, 200, 100),
      children: [fakeElement({ matches: [BUY], rect: box(700, 20, 60, 30) })],
    });
    const win = createFakeDomWindow(chart([ticket]));

    expect(look(win, PANE)).toMatchObject({ found: true, visible: true, unsafe: false });
    expect(look(win, SAVE)).toMatchObject({ unsafe: false });
  });

  test('does not flag a safe element for a safe overlay at its center', () => {
    const tooltip = fakeElement({
      matches: ['[data-name="tooltip"]'],
      rect: box(350, 280, 100, 40),
    });
    const win = createFakeDomWindow(chart([tooltip]));

    expect(look(win, PANE)).toMatchObject({ unsafe: false });
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

    expect(look(win, '[data-name="hidden"]')).toMatchObject({ visible: false, unsafe: false });
    expect(look(win, '[data-name="flat"]')).toMatchObject({ visible: false, unsafe: false });
  });

  test('skips the check of what lies at the center when the page cannot say', () => {
    const ticket = fakeElement({ matches: [BUY], rect: box(300, 250, 200, 100) });
    const win = createFakeDomWindow(chart([ticket]), { without: ['elementFromPoint'] });

    expect(look(win, PANE)).toMatchObject({ visible: true, unsafe: false });
    // What the element holds or sits in is still judged.
    expect(look(win, BUY)).toMatchObject({ unsafe: true });
  });

  test('reports an element that is not there as not found, without a box', () => {
    const win = createFakeDomWindow(chart());

    const missing = look(win, '[data-name="missing"]');

    expect(missing).toEqual({ found: false, visible: false, unsafe: false });
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

    expect(look(win, SAVE)).toEqual({ found: true, visible: false, unsafe: false, rect });
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

    expect(() => describeElement(win, BUY, [])).toThrow(/unsafe/);
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

    expect(focusOf(win)).toEqual({ unsafe: true, focused: 'button[data-name="buy-order-button"]' });
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

    expect(focusOf(win)).toEqual({ unsafe: false, focused: 'div[data-qa-id="pane"]' });
  });

  test('flags a focused element that sits inside an unsafe control, however deep', () => {
    const field = fakeElement({ tag: 'input' });
    const group = fakeElement({
      matches: ['[data-name="buy-sell-buttons"]'],
      children: [fakeElement({ children: [fakeElement({ children: [field] })] })],
    });
    const win = createFakeDomWindow([group], { focus: field });

    expect(focusOf(win)).toEqual({ unsafe: true, focused: 'input' });
  });

  test('does not flag the chart canvas, whatever else the page holds', () => {
    const canvas = fakeElement({ tag: 'canvas', attributes: { 'data-name': 'pane-canvas' } });
    const ticket = fakeElement({ children: [fakeElement({ matches: [BUY] })] });
    const win = createFakeDomWindow([canvas, ticket], { focus: canvas });

    expect(focusOf(win)).toEqual({ unsafe: false, focused: 'canvas[data-name="pane-canvas"]' });
  });

  test('counts the body and the html element as safe, although they hold the whole page', () => {
    const control = fakeElement({ matches: [BUY] });
    const body = fakeElement({ tag: 'body', children: [control] });
    const html = fakeElement({ tag: 'html', children: [body] });

    expect(focusOf(createFakeDomWindow([control], { focus: body }))).toEqual({
      unsafe: false,
      focused: 'body',
    });
    expect(focusOf(createFakeDomWindow([control], { focus: html }))).toEqual({
      unsafe: false,
      focused: 'html',
    });
  });

  test('counts the body that a page focuses when nothing else has the focus as safe', () => {
    // The default of the fake: the body, which holds the trading control.
    const win = createFakeDomWindow([fakeElement({ matches: [BUY] })]);

    expect(focusOf(win)).toEqual({ unsafe: false, focused: 'body' });
  });

  test('counts no focused element at all as safe', () => {
    const win = createFakeDomWindow([fakeElement({ matches: [BUY] })], { focus: null });

    expect(focusOf(win)).toEqual({ unsafe: false, focused: '' });
  });

  test('describes the element by its tag, id, data-qa-id and data-name, in that order', () => {
    const describe = (element: FakeElement) =>
      focusOf(createFakeDomWindow([element], { focus: element }));

    expect(describe(fakeElement())).toEqual({ unsafe: false, focused: 'div' });
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
    expect(error.message).toContain(BUY);
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

  test('sends the page one lookup and nothing but the three mouse events', async () => {
    const { page, sent } = pageWith(chart());

    await clickElement(page, SAVE);

    expect(sent.map(({ method }) => method)).toEqual([
      'Runtime.evaluate',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
    ]);
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
  test('inserts the text with Input.insertText', async () => {
    const { page, input } = pageWith([]);

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
    const { page, input } = pageWith([]);

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
    const { page } = pageWith([], {}, () => {
      throw timeout;
    });

    await expect(typeText(page, 'x')).rejects.toBe(timeout);
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

  test('inserts the text when focus is on a container that holds trading buttons', async () => {
    const group = fakeElement({
      matches: ['[data-name="buy-sell-buttons"]'],
      children: [fakeElement({ tag: 'button', matches: [BUY] })],
    });
    const pane = fakeElement({ matches: ['[data-qa-id="pane"]'], children: [group] });
    const { page, sent } = pageWith([pane], { focus: pane });

    await typeText(page, 'NASDAQ:AAPL');

    expect(sent.map(({ method }) => method)).toEqual(['Runtime.evaluate', 'Input.insertText']);
  });

  test('inserts the text when a field that is no trading control has the focus', async () => {
    const field = fakeElement({ tag: 'input', id: 'symbol-search' });
    const { page, sent } = pageWith([field], { focus: field });

    await typeText(page, 'NASDAQ:AAPL');

    expect(sent.map(({ method }) => method)).toEqual(['Runtime.evaluate', 'Input.insertText']);
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

  test('look at the focus again for every key and every text', async () => {
    const canvas = fakeElement({ tag: 'canvas', matches: [PANE] });
    const buy = fakeElement({ tag: 'button', matches: [BUY] });
    const win = createFakeDomWindow([canvas, buy], { focus: canvas });
    const { page, input } = pageOver(win);

    await pressKey(page, 'Escape');
    dom(win).document.activeElement = buy;
    const refusedKey = await failureOf(pressKey(page, 'Escape'));
    const refusedText = await failureOf(typeText(page, 'x'));
    dom(win).document.activeElement = canvas;
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
