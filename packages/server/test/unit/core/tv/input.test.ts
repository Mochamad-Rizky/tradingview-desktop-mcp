import { setImmediate as settle } from 'node:timers/promises';
import type { CdpSession } from '../../../../src/core/cdp/types.js';
import { TimeoutError } from '../../../../src/core/errors.js';
import {
  clickElement,
  describeElement,
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
    const { page, sent } = pageWith([]);

    await expect(typeText(page, 'NASDAQ:AAPL')).resolves.toBeUndefined();

    expect(sent).toEqual([{ method: 'Input.insertText', params: { text: 'NASDAQ:AAPL' } }]);
  });

  test.each([
    'two words',
    'a "quoted" line\nand another',
    'é ñ 日本語',
    'emoji 😀',
    '  padded  ',
    '0',
  ])('inserts %j as it is', async (text) => {
    const { page, sent } = pageWith([]);

    await typeText(page, text);

    expect(sent).toEqual([{ method: 'Input.insertText', params: { text } }]);
  });

  test('sends nothing for empty text', async () => {
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
    const { page, sent } = pageWith([]);

    await expect(pressKey(page, 'Enter')).resolves.toBeUndefined();

    expect(sent).toEqual([keyDown('Enter', 'Enter', 13, '\r'), keyUp('Enter', 'Enter', 13)]);
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
    const { page, sent } = pageWith([]);

    await pressKey(page, key);

    expect(sent).toEqual([keyDown(key, key, keyCode), keyUp(key, key, keyCode)]);
  });

  test.each(
    Array.from({ length: 26 }, (_, index): [string, number] => [
      String.fromCharCode(97 + index),
      65 + index,
    ]),
  )(
    'sends the letter %s with virtual key code %i, and its upper case form likewise',
    async (letter, keyCode) => {
      const { page, sent } = pageWith([]);
      const upper = letter.toUpperCase();
      const code = `Key${upper}`;

      await pressKey(page, letter);
      await pressKey(page, upper);

      expect(sent).toEqual([
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
    const { page, sent } = pageWith([]);

    await pressKey(page, digit);

    expect(sent).toEqual([
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
    const { page, sent } = pageWith([]);

    await pressKey(page, 'Escape', modifiers);

    expect(sent).toEqual([
      keyDown('Escape', 'Escape', 27, undefined, mask),
      keyUp('Escape', 'Escape', 27, mask),
    ]);
  });

  test('counts a modifier once, however often it is listed', async () => {
    const { page, sent } = pageWith([]);

    await pressKey(page, 'Tab', ['Shift', 'Shift', 'Control', 'Shift']);

    expect(sent).toEqual([keyDown('Tab', 'Tab', 9, undefined, 10), keyUp('Tab', 'Tab', 9, 10)]);
  });

  test('upper-cases a letter held with Shift, the way a keyboard does', async () => {
    const { page, sent } = pageWith([]);

    await pressKey(page, 'a', ['Shift']);
    await pressKey(page, 'A', ['Shift']);

    expect(sent).toEqual([
      keyDown('A', 'KeyA', 65, 'A', 8),
      keyUp('A', 'KeyA', 65, 8),
      keyDown('A', 'KeyA', 65, 'A', 8),
      keyUp('A', 'KeyA', 65, 8),
    ]);
  });

  test('leaves a digit as it is under Shift, because the symbol depends on the keyboard layout', async () => {
    const { page, sent } = pageWith([]);

    await pressKey(page, '1', ['Shift']);

    expect(sent).toEqual([keyDown('1', 'Digit1', 49, '1', 8), keyUp('1', 'Digit1', 49, 8)]);
  });

  test.each<[string, KeyModifier[], number, string]>([
    ['Control', ['Control'], 2, 'a'],
    ['Alt', ['Alt'], 1, 'a'],
    ['Meta', ['Meta'], 4, 'a'],
    ['Control and Shift', ['Control', 'Shift'], 10, 'A'],
  ])(
    'sends a letter held with %s as a shortcut, without text to type',
    async (_label, modifiers, mask, key) => {
      const { page, sent } = pageWith([]);

      await pressKey(page, 'a', modifiers);

      expect(sent).toEqual([
        keyDown(key, 'KeyA', 65, undefined, mask),
        keyUp(key, 'KeyA', 65, mask),
      ]);
    },
  );

  test('sends Enter and a digit held with Control without text, and Enter with Shift with it', async () => {
    const { page, sent } = pageWith([]);

    await pressKey(page, 'Enter', ['Control']);
    await pressKey(page, '5', ['Alt']);
    await pressKey(page, 'Enter', ['Shift']);

    expect(sent).toEqual([
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
  ])('rejects the key %j with INVALID_INPUT, and sends nothing', async (key) => {
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
    'rejects the modifier %j with INVALID_INPUT, and sends nothing',
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
});
