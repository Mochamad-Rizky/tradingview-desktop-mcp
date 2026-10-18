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
  test('inserts the text', async () => {
    const { server, page } = await openPage(createFakeDomWindow(chart()));

    await typeText(page, 'NASDAQ:AAPL');

    expect(inputOf(server)).toEqual([
      { method: 'Input.insertText', params: { text: 'NASDAQ:AAPL' } },
    ]);
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
});

test('drives the symbol search: click the button, type the symbol, press Enter', async () => {
  const { server, page } = await openPage(createFakeDomWindow(chart()));

  await clickElement(page, SYMBOL_SEARCH);
  await typeText(page, 'NASDAQ:MSFT');
  await pressKey(page, 'Enter');

  expect(methodsOf(server)).toEqual([
    'Runtime.evaluate',
    'Input.dispatchMouseEvent',
    'Input.dispatchMouseEvent',
    'Input.dispatchMouseEvent',
    'Input.insertText',
    'Input.dispatchKeyEvent',
    'Input.dispatchKeyEvent',
  ]);
});
