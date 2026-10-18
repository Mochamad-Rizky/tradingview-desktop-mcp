import { createCriConnector } from '../../src/core/cdp/cri-connector.js';
import { createHttpDiscovery } from '../../src/core/cdp/discovery.js';
import { clickElement, pressKey, typeText, type InputPage } from '../../src/core/tv/input.js';
import { createPageBridge } from '../../src/core/tv/page-bridge.js';
import { SELECTORS, UNSAFE_SELECTORS } from '../../src/core/tv/selectors.js';
import { failureOf } from '../helpers/failure-of.js';
import { startFakeCdpServer, type FakeCdpServer } from '../helpers/fake-cdp/server.js';
import { loadTargetsFixture } from '../helpers/fake-cdp/targets.js';
import {
  createFakeDomWindow,
  fakeElement,
  type FakeElement,
  type FakeRect,
} from '../helpers/fake-tv/dom.js';
import { loadTvFixture } from '../helpers/fake-tv/fixture.js';
import { createFakeTvWindow } from '../helpers/fake-tv/window.js';

const CHART_ID = 'BBB144A7827AE55CBA0E74986FC9574C';
const CALL_TIMEOUT_MS = 5000;

const SYMBOL_SEARCH = SELECTORS.header.symbolSearch;
const PANE = SELECTORS.regions.paneCanvas;
const BUY = '[data-name="buy-order-button"]';

// Everything a test starts is registered here, because a server that is still listening or a
// socket that is still open keeps the vitest worker from exiting.
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function box(x: number, y: number, width: number, height: number): FakeRect {
  return { x, y, width, height };
}

// The portal that dialogs and menus open in, holding `layers`. It has no box of its own.
function overlapRoot(layers: FakeElement[]): FakeElement {
  return fakeElement({
    matches: [SELECTORS.regions.overlapManagerRoot],
    rect: box(0, 0, 0, 0),
    children: layers,
  });
}

// The chart tab as the tests below want it: the symbol search button of the header toolbar, and
// the canvas of the pane, plus whatever else a test puts on the page.
function chart(extra: FakeElement[] = []): FakeElement[] {
  return [
    fakeElement({ matches: [SYMBOL_SEARCH], rect: box(100, 50, 40, 20) }),
    fakeElement({ matches: [PANE], rect: box(0, 100, 800, 400) }),
    ...extra,
  ];
}

interface Page {
  server: FakeCdpServer;
  page: InputPage;
}

// A session to the chart tab of the observed target list, which shows `win`, and the page bridge
// on it, the way the connection manager hands them out.
async function openPage(win: object): Promise<Page> {
  const server = await startFakeCdpServer({
    targets: loadTargetsFixture({ chartWindow: () => win }),
  });
  cleanups.push(() => server.close());
  const discovery = createHttpDiscovery({
    host: server.host,
    port: server.port,
    timeoutMs: CALL_TIMEOUT_MS,
  });
  const target = (await discovery.targets()).find((candidate) => candidate.id === CHART_ID);
  if (target === undefined) {
    throw new Error(`The fake server does not list ${CHART_ID}`);
  }
  const connector = createCriConnector({
    host: server.host,
    port: server.port,
    defaultTimeoutMs: CALL_TIMEOUT_MS,
  });
  const session = await connector.connect(target);
  cleanups.push(() => session.close());
  return {
    server,
    page: { session, bridge: createPageBridge(session, { timeoutMs: CALL_TIMEOUT_MS }) },
  };
}

// What reached the page, as the method of each command.
function methodsOf(server: FakeCdpServer): string[] {
  return server.calls.map(({ method }) => method);
}

// What reached the page, minus the lookups: the commands that act on it.
function inputOf(server: FakeCdpServer): { method: string; params: unknown }[] {
  return server.calls
    .filter(({ method }) => method.startsWith('Input.'))
    .map(({ method, params }) => ({ method, params }));
}

describe('clickElement over CDP', () => {
  test('clicks at the center of the element', async () => {
    const { server, page } = await openPage(createFakeDomWindow(chart()));

    await clickElement(page, SYMBOL_SEARCH);

    expect(server.calls.map(({ targetId, method }) => [targetId, method])).toEqual([
      [CHART_ID, 'Runtime.evaluate'],
      [CHART_ID, 'Input.dispatchMouseEvent'],
      [CHART_ID, 'Input.dispatchMouseEvent'],
      [CHART_ID, 'Input.dispatchMouseEvent'],
    ]);
    expect(inputOf(server).map(({ params }) => params)).toEqual([
      { type: 'mouseMoved', x: 120, y: 60 },
      { type: 'mousePressed', x: 120, y: 60, button: 'left', clickCount: 1 },
      { type: 'mouseReleased', x: 120, y: 60, button: 'left', clickCount: 1 },
    ]);
  });

  test('refuses the buy order button, and no input reaches the page', async () => {
    const { server, page } = await openPage(
      createFakeDomWindow([fakeElement({ matches: [BUY], rect: box(300, 250, 80, 30) })]),
    );

    const error = await failureOf(clickElement(page, BUY));

    expect(error.toPayload()).toEqual({
      code: 'UNSAFE_ACTION_BLOCKED',
      message: expect.stringContaining(BUY) as unknown,
      hint: expect.any(String) as unknown,
      details: { selector: BUY },
    });
    // The lookup is all the page ever saw.
    expect(methodsOf(server)).toEqual(['Runtime.evaluate']);
  });

  test.each(UNSAFE_SELECTORS)('refuses a control that matches %s', async (selector) => {
    const { server, page } = await openPage(
      createFakeDomWindow([fakeElement({ matches: [selector] })]),
    );

    const error = await failureOf(clickElement(page, selector));

    expect(error.code).toBe('UNSAFE_ACTION_BLOCKED');
    expect(methodsOf(server)).toEqual(['Runtime.evaluate']);
  });

  test('refuses a pane that an order ticket floats over, at the point the click would land on', async () => {
    const ticket = fakeElement({
      matches: ['[data-name="order-ticket"]'],
      rect: box(300, 250, 200, 100),
      children: [fakeElement({ matches: [BUY], rect: box(350, 280, 100, 40) })],
    });
    const { server, page } = await openPage(createFakeDomWindow(chart([ticket])));

    const error = await failureOf(clickElement(page, PANE));

    expect(error.code).toBe('UNSAFE_ACTION_BLOCKED');
    expect(methodsOf(server)).toEqual(['Runtime.evaluate']);
    // The same page is still clickable where nothing unsafe lies.
    await clickElement(page, SYMBOL_SEARCH);
    expect(inputOf(server)).toHaveLength(3);
  });

  test('refuses a target that a dialog or a menu covers, and names what covers it', async () => {
    const menu = fakeElement({
      attributes: { 'data-name': 'context-menu' },
      rect: box(350, 280, 100, 40),
    });
    const { server, page } = await openPage(createFakeDomWindow(chart([overlapRoot([menu])])));

    const error = await failureOf(clickElement(page, PANE));

    expect(error.toPayload()).toEqual({
      code: 'NOT_AVAILABLE',
      message: `The element \`${PANE}\` is covered by \`div[data-name="context-menu"]\``,
      hint: 'Close the dialog or menu that covers it first.',
      details: { selector: PANE, obscuredBy: 'div[data-name="context-menu"]' },
    });
    // The lookup is all the page ever saw: the mouse did not move.
    expect(methodsOf(server)).toEqual(['Runtime.evaluate']);
  });

  test('refuses a target that a frame covers, and clicks one that a stacked canvas covers', async () => {
    const ad = fakeElement({ tag: 'iframe', id: 'ad', rect: box(350, 280, 100, 40) });
    const stacked = fakeElement({
      tag: 'canvas',
      matches: ['canvas[data-name="overlay-canvas"]'],
      rect: box(0, 100, 800, 400),
    });
    const covered = await openPage(createFakeDomWindow(chart([ad])));
    const stackedOver = await openPage(createFakeDomWindow(chart([stacked])));

    const error = await failureOf(clickElement(covered.page, PANE));
    await clickElement(stackedOver.page, PANE);

    expect(error.details).toEqual({ selector: PANE, obscuredBy: 'iframe#ad' });
    expect(methodsOf(covered.server)).toEqual(['Runtime.evaluate']);
    expect(inputOf(stackedOver.server)).toHaveLength(3);
  });

  test('refuses a target when the page cannot say what lies over it', async () => {
    const { server, page } = await openPage(
      createFakeDomWindow(chart(), { without: ['elementFromPoint'] }),
    );

    const error = await failureOf(clickElement(page, SYMBOL_SEARCH));

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(error.details).toEqual({ selector: SYMBOL_SEARCH, reason: 'hit-test-unavailable' });
    expect(methodsOf(server)).toEqual(['Runtime.evaluate']);
  });

  test('reports an element that is not shown as NOT_AVAILABLE, and sends no input', async () => {
    const { server, page } = await openPage(
      createFakeDomWindow(
        chart([fakeElement({ matches: ['[data-name="hidden"]'], display: 'none' })]),
      ),
    );

    const hidden = await failureOf(clickElement(page, '[data-name="hidden"]'));
    const missing = await failureOf(clickElement(page, '[data-name="missing"]'));

    expect(hidden.toPayload()).toMatchObject({
      code: 'NOT_AVAILABLE',
      details: { selector: '[data-name="hidden"]', found: true, visible: false },
    });
    expect(missing.toPayload()).toMatchObject({
      code: 'NOT_AVAILABLE',
      details: { selector: '[data-name="missing"]', found: false, visible: false },
    });
    expect(methodsOf(server)).toEqual(['Runtime.evaluate', 'Runtime.evaluate']);
  });

  test('reports a selector that is not valid CSS as INVALID_INPUT', async () => {
    const { server, page } = await openPage(createFakeDomWindow(chart()));

    const error = await failureOf(clickElement(page, '[data-name="open'));

    expect(error.toPayload()).toMatchObject({
      code: 'INVALID_INPUT',
      details: { selector: '[data-name="open' },
    });
    expect(methodsOf(server)).toEqual(['Runtime.evaluate']);
  });

  test('reports a page without a DOM as NOT_AVAILABLE instead of failing the evaluation', async () => {
    const { server, page } = await openPage(createFakeTvWindow(loadTvFixture()));

    const error = await failureOf(clickElement(page, SYMBOL_SEARCH));

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(methodsOf(server)).toEqual(['Runtime.evaluate']);
  });
});

describe('typeText over CDP', () => {
  test('looks at the focus, then inserts the text', async () => {
    const field = fakeElement({ tag: 'input', id: 'symbol-search-input' });
    const { server, page } = await openPage(createFakeDomWindow(chart([field]), { focus: field }));

    await typeText(page, 'NASDAQ:AAPL');

    expect(methodsOf(server)).toEqual(['Runtime.evaluate', 'Input.insertText']);
    expect(inputOf(server)).toEqual([
      { method: 'Input.insertText', params: { text: 'NASDAQ:AAPL' } },
    ]);
  });

  test('refuses when focus is inside a buy-sell control', async () => {
    const field = fakeElement({ tag: 'input', id: 'quantity' });
    const group = fakeElement({ matches: ['[data-name="buy-sell-buttons"]'], children: [field] });
    const { server, page } = await openPage(createFakeDomWindow(chart([group]), { focus: field }));

    const error = await failureOf(typeText(page, 'NASDAQ:AAPL'));

    expect(error.toPayload()).toEqual({
      code: 'UNSAFE_ACTION_BLOCKED',
      message: expect.stringContaining('`input#quantity`') as unknown,
      hint: expect.any(String) as unknown,
      details: { action: 'typeText', focused: 'input#quantity' },
    });
    // The lookup of the focus is all the page ever saw.
    expect(methodsOf(server)).toEqual(['Runtime.evaluate']);
  });

  test('types into a field in a container that holds trading buttons', async () => {
    const group = fakeElement({
      matches: ['[data-name="buy-sell-buttons"]'],
      children: [fakeElement({ tag: 'button', matches: [BUY] })],
    });
    const field = fakeElement({ tag: 'input', id: 'note' });
    const pane = fakeElement({ matches: ['[data-qa-id="pane"]'], children: [group, field] });
    const { server, page } = await openPage(createFakeDomWindow([pane], { focus: field }));

    await typeText(page, 'NASDAQ:AAPL');

    expect(methodsOf(server)).toEqual(['Runtime.evaluate', 'Input.insertText']);
  });

  test('types into a focused search input and into a contenteditable element', async () => {
    const search = fakeElement({ tag: 'input', attributes: { type: 'search' } });
    const editor = fakeElement({ contentEditable: true });
    const first = await openPage(createFakeDomWindow([search, editor], { focus: search }));
    const second = await openPage(createFakeDomWindow([search, editor], { focus: editor }));

    await typeText(first.page, 'NASDAQ:AAPL');
    await typeText(second.page, 'plot(close)');

    expect(methodsOf(first.server)).toEqual(['Runtime.evaluate', 'Input.insertText']);
    expect(methodsOf(second.server)).toEqual(['Runtime.evaluate', 'Input.insertText']);
  });

  test('refuses when focus is not an editable element', async () => {
    const button = fakeElement({ tag: 'button', id: 'header-toolbar-symbol-search' });
    const pane = fakeElement({ attributes: { 'data-qa-id': 'pane' } });
    const { server, page } = await openPage(createFakeDomWindow([button, pane], { focus: pane }));

    const error = await failureOf(typeText(page, 'NASDAQ:AAPL'));

    expect(error.toPayload()).toEqual({
      code: 'NOT_AVAILABLE',
      message:
        'Cannot type text: the focus is on `div[data-qa-id="pane"]`, which is not a text field',
      hint: 'Focus a text field first, for example click the symbol search box.',
      details: { action: 'typeText', focused: 'div[data-qa-id="pane"]' },
    });
    // The lookup of the focus is all the page ever saw.
    expect(methodsOf(server)).toEqual(['Runtime.evaluate']);
  });

  test('refuses when the focus is on a safe button, even with a trading field on the page', async () => {
    // Chrome types at the caret, which can stay in a trading field after the focus moved on to a
    // button. No caret is modeled here: no text is sent while the focus is on a button.
    const quantity = fakeElement({ tag: 'input', id: 'quantity' });
    const group = fakeElement({
      matches: ['[data-name="buy-sell-buttons"]'],
      children: [quantity],
    });
    const button = fakeElement({ tag: 'button', matches: [SYMBOL_SEARCH] });
    const { server, page } = await openPage(
      createFakeDomWindow([group, button], { focus: button }),
    );

    const error = await failureOf(typeText(page, '1000'));

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(methodsOf(server)).toEqual(['Runtime.evaluate']);
  });

  test('fails closed without a DOM', async () => {
    const { server, page } = await openPage(createFakeTvWindow(loadTvFixture()));

    const error = await failureOf(typeText(page, 'NASDAQ:AAPL'));

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(methodsOf(server)).toEqual(['Runtime.evaluate']);
  });

  test('sends nothing for empty text', async () => {
    const { server, page } = await openPage(createFakeDomWindow(chart()));

    await typeText(page, '');

    expect(server.calls).toEqual([]);
  });
});

describe('pressKey over CDP', () => {
  test('presses Enter: keyDown, then keyUp, with its key codes', async () => {
    const { server, page } = await openPage(createFakeDomWindow(chart()));

    await pressKey(page, 'Enter');

    expect(methodsOf(server)).toEqual([
      'Runtime.evaluate',
      'Input.dispatchKeyEvent',
      'Input.dispatchKeyEvent',
    ]);
    expect(inputOf(server)).toEqual([
      {
        method: 'Input.dispatchKeyEvent',
        params: {
          type: 'keyDown',
          modifiers: 0,
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          text: '\r',
        },
      },
      {
        method: 'Input.dispatchKeyEvent',
        params: {
          type: 'keyUp',
          modifiers: 0,
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
        },
      },
    ]);
  });

  test('presses a shortcut: Control and A', async () => {
    const { server, page } = await openPage(createFakeDomWindow(chart()));

    await pressKey(page, 'a', ['Control']);

    expect(inputOf(server).map(({ params }) => params)).toEqual([
      { type: 'rawKeyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 },
      { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 },
    ]);
  });

  test('rejects an unsupported key before anything reaches the page', async () => {
    const { server, page } = await openPage(createFakeDomWindow(chart()));

    const error = await failureOf(pressKey(page, 'F5'));

    expect(error.code).toBe('INVALID_INPUT');
    expect(server.calls).toEqual([]);
  });

  test('refuses when a trading button has focus', async () => {
    const buy = fakeElement({
      tag: 'button',
      matches: [BUY],
      attributes: { 'data-name': 'buy-order-button' },
    });
    const { server, page } = await openPage(createFakeDomWindow(chart([buy]), { focus: buy }));

    const error = await failureOf(pressKey(page, 'Enter'));

    expect(error.toPayload()).toEqual({
      code: 'UNSAFE_ACTION_BLOCKED',
      message: expect.stringContaining('`button[data-name="buy-order-button"]`') as unknown,
      hint: expect.any(String) as unknown,
      details: { action: 'pressKey', focused: 'button[data-name="buy-order-button"]' },
    });
    // Not a key down and not a key up: the lookup of the focus is all the page ever saw.
    expect(methodsOf(server)).toEqual(['Runtime.evaluate']);
  });

  test('proceeds when the chart canvas has focus', async () => {
    const canvas = fakeElement({
      tag: 'canvas',
      matches: [PANE],
      rect: box(0, 100, 800, 400),
      attributes: { 'data-name': 'pane-canvas' },
    });
    // A trading control elsewhere on the page does not matter: only what has the focus does.
    const ticket = fakeElement({ matches: [BUY], rect: box(900, 20, 60, 30) });
    const { server, page } = await openPage(
      createFakeDomWindow([canvas, ticket], { focus: canvas }),
    );

    await pressKey(page, 'Enter');

    expect(methodsOf(server)).toEqual([
      'Runtime.evaluate',
      'Input.dispatchKeyEvent',
      'Input.dispatchKeyEvent',
    ]);
  });

  test('proceeds when focus is on a container that holds trading buttons', async () => {
    // The pane of the chart holds the buy and sell buttons shown on it, and the keys go to the pane.
    const group = fakeElement({
      matches: ['[data-name="buy-sell-buttons"]'],
      children: [fakeElement({ tag: 'button', matches: [BUY] })],
    });
    const pane = fakeElement({ matches: ['[data-qa-id="pane"]'], children: [group] });
    const { server, page } = await openPage(createFakeDomWindow([pane], { focus: pane }));

    await pressKey(page, 'Escape');

    expect(methodsOf(server)).toEqual([
      'Runtime.evaluate',
      'Input.dispatchKeyEvent',
      'Input.dispatchKeyEvent',
    ]);
  });

  test('fails closed without a DOM', async () => {
    const { server, page } = await openPage(createFakeTvWindow(loadTvFixture()));

    const error = await failureOf(pressKey(page, 'Enter'));

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(methodsOf(server)).toEqual(['Runtime.evaluate']);
  });
});

test('drives the symbol search: click the button, type the symbol, press Enter', async () => {
  // The dialog that the click opens puts the focus in its text field. The fake page does not
  // open dialogs, so the field has the focus from the start.
  const field = fakeElement({ tag: 'input', id: 'symbol-search-input' });
  const { server, page } = await openPage(createFakeDomWindow(chart([field]), { focus: field }));

  await clickElement(page, SYMBOL_SEARCH);
  await typeText(page, 'NASDAQ:MSFT');
  await pressKey(page, 'Enter');

  // Each step looks at the page first: the target of the click, then the focus for the text, then
  // the focus for the key.
  expect(methodsOf(server)).toEqual([
    'Runtime.evaluate',
    'Input.dispatchMouseEvent',
    'Input.dispatchMouseEvent',
    'Input.dispatchMouseEvent',
    'Runtime.evaluate',
    'Input.insertText',
    'Runtime.evaluate',
    'Input.dispatchKeyEvent',
    'Input.dispatchKeyEvent',
  ]);
});
