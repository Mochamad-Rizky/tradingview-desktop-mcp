import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../../../src/config/schema.js';
import type { Logger } from '../../../src/core/logger.js';
import {
  describeElement,
  describeFocusedElement,
  findElements,
} from '../../../src/core/tv/input.js';
import { SELECTORS } from '../../../src/core/tv/selectors.js';
import { createMcpServer } from '../../../src/server.js';
import type { JsonValue } from '../../../src/utils/json.js';
import { layoutMetrics } from '../../helpers/fake-cdp/layout.js';
import { startFakeCdpServer, type FakeCdpServer } from '../../helpers/fake-cdp/server.js';
import { loadTargetsFixture } from '../../helpers/fake-cdp/targets.js';
import {
  createFakeDomWindow,
  fakeElement,
  type FakeDomOptions,
  type FakeDomWindow,
  type FakeElement,
  type FakeElementOptions,
  type FakeRect,
} from '../../helpers/fake-tv/dom.js';
import { loadTvFixture, type TvStateFixture } from '../../helpers/fake-tv/fixture.js';
import {
  createFakeRightToolbar,
  type FakeRightToolbar,
  type FakeRightToolbarOptions,
} from '../../helpers/fake-tv/right-toolbar.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTvOverrides,
  type FakeTvWindow,
} from '../../helpers/fake-tv/window.js';
import { callTool, connectInMemoryClient } from '../../helpers/mcp-client.js';
import {
  capturingLogger,
  quietLogger,
  refusingLauncher,
  testConfig,
} from '../../helpers/tool-context.js';

// The pointer tools through the whole server: an SDK client over the in-memory transport, the real
// registry, connection manager, discovery and CDP adapter, and the fake debug port of the app, whose
// chart tab and window chrome are pages with a DOM. What reached a page is what the fake debug port
// recorded, so the tests read the input events there.

// Nothing in this file may run a real program or start TradingView: the machine this suite runs on
// may have one open. No launcher here starts anything, and this is the second lock.
vi.mock('node:child_process', () => ({
  spawn: () => {
    throw new Error('A test tried to start a real program with spawn');
  },
  execFile: () => {
    throw new Error('A test tried to start a real program with execFile');
  },
}));

const CHART_ID = 'BBB144A7827AE55CBA0E74986FC9574C';
const CHROME_ID = 'EE67363DAA56C9940A709061CFAA2FFF';

const VIEWPORT = { width: 1280, height: 720 };
const SAVE = SELECTORS.header.saveLoad;
const PANE = SELECTORS.regions.paneCanvas;
const BUY = '[data-name="buy-order-button"]';
const ACTIVE_TAB = SELECTORS.windowChrome.activeTab;

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function connect(server: McpServer): Promise<Client> {
  const client = await connectInMemoryClient(server);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

function box(x: number, y: number, width: number, height: number): FakeRect {
  return { x, y, width, height };
}

// The chart tab: a background as large as the viewport, which a real page has in its html element,
// the save button of the header toolbar, the canvas of the pane, the buy button over the pane, and
// what a test adds.
function chartPage(extra: FakeElement[] = [], options: FakeDomOptions = {}): FakeDomWindow {
  const win = createFakeDomWindow(
    [
      fakeElement({ tag: 'html', rect: box(0, 0, VIEWPORT.width, VIEWPORT.height) }),
      fakeElement({
        tag: 'button',
        id: 'header-toolbar-save-load',
        matches: [SAVE],
        attributes: { 'aria-label': 'Save all charts' },
        rect: box(100, 50, 40, 20),
      }),
      fakeElement({
        tag: 'canvas',
        matches: [PANE],
        attributes: { 'data-name': 'pane-canvas' },
        rect: box(0, 100, 800, 400),
      }),
      fakeElement({
        tag: 'button',
        matches: [BUY],
        attributes: { 'data-name': 'buy-order-button', 'aria-label': 'Buy' },
        rect: box(300, 250, 80, 30),
        children: [fakeElement({ tag: 'span', text: 'Buy', rect: box(310, 255, 40, 20) })],
      }),
      ...extra,
    ],
    { viewport: VIEWPORT, ...options },
  );
  return win as unknown as FakeDomWindow;
}

// The window chrome: the strip with the tabs, 34 pixels high, with the active tab and the button
// that opens a new one.
function chromePage(): FakeDomWindow {
  const win = createFakeDomWindow(
    [
      fakeElement({ tag: 'html', rect: box(0, 0, VIEWPORT.width, 34) }),
      fakeElement({
        id: 'tab-1',
        matches: [ACTIVE_TAB, SELECTORS.windowChrome.tab],
        attributes: { draggable: 'true' },
        text: 'Layout',
        rect: box(80, 0, 200, 34),
      }),
      fakeElement({
        tag: 'button',
        matches: [SELECTORS.windowChrome.newTab, '[aria-label="New tab"]'],
        attributes: { 'aria-label': 'New tab' },
        rect: box(290, 5, 24, 24),
      }),
    ],
    { viewport: { width: VIEWPORT.width, height: 34 } },
  );
  return win as unknown as FakeDomWindow;
}

// The portal that dialogs and menus open in, with the item of an open menu over the middle of the
// pane.
function openMenu(): FakeElement {
  return fakeElement({
    matches: [SELECTORS.regions.overlapManagerRoot],
    rect: box(0, 0, 0, 0),
    children: [fakeElement({ id: 'menu-item', rect: box(350, 280, 100, 40) })],
  });
}

type Handlers = Record<string, (params: unknown) => unknown>;

interface HarnessOptions {
  // The window of the chart tab: a DOM page, or the shared fake of a chart for the tools that use
  // its API.
  win?: object;
  chrome?: FakeDomWindow;
  // Answers of the chart tab for single CDP commands: the page reacting to input.
  chartHandlers?: Handlers;
  // Settings of the server besides the port and the call timeout, such as allowEval.
  config?: Partial<Config>;
  logger?: Logger;
}

interface Harness {
  client: Client;
  app: FakeCdpServer;
}

// The real server over the real adapters, against a fake debug port.
async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const win = options.win ?? chartPage();
  const chrome = options.chrome ?? chromePage();
  const targets = loadTargetsFixture({ chartWindow: () => win, chromeWindow: () => chrome });
  const chart = targets.find(({ id }) => id === CHART_ID);
  if (chart !== undefined && options.chartHandlers !== undefined) {
    chart.handlers = options.chartHandlers;
  }
  const app = await startFakeCdpServer({ targets });
  cleanups.push(() => app.close());
  const config = testConfig({ ...options.config, cdpPort: app.port, callTimeoutMs: 5000 });
  const { server, ctx } = createMcpServer(config, {
    launcher: refusingLauncher(),
    logger: options.logger ?? quietLogger,
  });
  cleanups.push(() => ctx.connection.close());
  return { client: await connect(server), app };
}

interface Envelope {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; hint?: string; details?: Record<string, unknown> };
  meta: { via?: string; durationMs: number; warnings?: string[] };
}

const envelopeOf = (result: { structuredContent?: unknown }): Envelope =>
  result.structuredContent as Envelope;
const dataOf = (result: { structuredContent?: unknown }): unknown => envelopeOf(result).data;
const errorOf = (result: { structuredContent?: unknown }) => envelopeOf(result).error;
const warningsOf = (result: { structuredContent?: unknown }) => envelopeOf(result).meta.warnings;

// The commands a target received, in order.
function methodsOf(app: FakeCdpServer, targetId = CHART_ID): string[] {
  return app.calls.filter((call) => call.targetId === targetId).map(({ method }) => method);
}

// The mouse events a target received, as their parameters.
function mouseOf(app: FakeCdpServer, targetId = CHART_ID): Record<string, unknown>[] {
  return app.calls
    .filter((call) => call.targetId === targetId && call.method === 'Input.dispatchMouseEvent')
    .map(({ params }) => params as Record<string, unknown>);
}

const typesOf = (app: FakeCdpServer, targetId = CHART_ID): unknown[] =>
  mouseOf(app, targetId).map(({ type }) => type);

const inputCountOf = (app: FakeCdpServer): number =>
  app.calls.filter(({ method }) => method.startsWith('Input.')).length;

// A page that reacts to the pointer arriving the way `change` says, through the answer of the chart
// tab to the move.
function afterTheMove(change: () => void): Handlers {
  return {
    'Input.dispatchMouseEvent': (params) => {
      if ((params as { type: string }).type === 'mouseMoved') {
        change();
      }
      return {};
    },
  };
}

describe('ui_click', () => {
  test('ui_click at a point over the buy button sends no mouse press', async () => {
    const { client, app } = await startHarness();

    // (320, 260) is on the label inside the buy button, (370, 270) on the button beside it.
    const onLabel = await callTool(client, 'ui_click', { x: 320, y: 260 });
    const onButton = await callTool(client, 'ui_click', { x: 370, y: 270 });

    expect(onLabel.isError).toBe(true);
    expect(errorOf(onLabel)).toEqual({
      code: 'UNSAFE_ACTION_BLOCKED',
      message:
        'Refusing to click at (320, 260): what lies there is part of a broker trading control or holds one',
      hint: expect.stringMatching(/Trading controls are off limits/) as string,
      details: { x: 320, y: 260 },
    });
    expect(errorOf(onButton)).toMatchObject({ code: 'UNSAFE_ACTION_BLOCKED' });
    // No mouse press, and not even a move: the looks at the point are all the page saw.
    expect(mouseOf(app).filter(({ type }) => type === 'mousePressed')).toEqual([]);
    expect(methodsOf(app)).toEqual(['Runtime.evaluate', 'Runtime.evaluate']);
  });

  test('ui_click at a point on a container of a trading control refuses, as a click by selector does', async () => {
    const toolbar = fakeElement({
      matches: ['[data-name="toolbar"]'],
      rect: box(0, 0, VIEWPORT.width, 40),
      children: [
        fakeElement({ matches: ['[data-qa-id="trade-button"]'], rect: box(700, 5, 60, 30) }),
      ],
    });
    const { client, app } = await startHarness({ win: chartPage([toolbar]) });

    const atPoint = await callTool(client, 'ui_click', { x: 100, y: 20 });
    const bySelector = await callTool(client, 'ui_click', { selector: '[data-name="toolbar"]' });
    const hovered = await callTool(client, 'ui_hover', { x: 100, y: 20 });

    expect(errorOf(atPoint)).toMatchObject({
      code: 'UNSAFE_ACTION_BLOCKED',
      message:
        'Refusing to click at (100, 20): what lies there is part of a broker trading control or holds one',
    });
    expect(errorOf(bySelector)).toMatchObject({ code: 'UNSAFE_ACTION_BLOCKED' });
    // The pointer over the toolbar lands on the toolbar, so a hover there is no click on it.
    expect(hovered.isError).not.toBe(true);
    expect(typesOf(app)).toEqual(['mouseMoved']);
  });

  test('ui_click refuses a trading action by its name, whatever the target, and ui_hover does not', async () => {
    // The submit button of an order ticket carries no selector of the guard.
    const placeOrder = fakeElement({
      tag: 'button',
      id: 'ticket-submit',
      matches: ['#ticket-submit'],
      text: 'Place order',
      rect: box(500, 600, 100, 24),
    });
    const { client, app } = await startHarness({ win: chartPage([placeOrder]) });

    const byText = await callTool(client, 'ui_click', { text: 'place order' });
    const bySelector = await callTool(client, 'ui_click', { selector: '#ticket-submit' });
    const atPoint = await callTool(client, 'ui_click', { x: 550, y: 612 });
    const hovered = await callTool(client, 'ui_hover', { text: 'Place order' });

    for (const refused of [byText, bySelector, atPoint]) {
      expect(errorOf(refused)).toMatchObject({
        code: 'UNSAFE_ACTION_BLOCKED',
        hint: expect.stringMatching(/^Trading actions are never clicked/) as string,
        details: { name: 'Place order' },
      });
    }
    expect(errorOf(byText)?.message).toBe(
      'Refusing to click the element named "place order": the click would reach "Place order", a trading action',
    );
    expect(dataOf(hovered)).toEqual({ target: 'chart', by: 'text', point: { x: 550, y: 612 } });
    // The hover, and no button.
    expect(typesOf(app)).toEqual(['mouseMoved']);
  });

  test('ui_click refuses trading actions in a split label, under another aria-label and in an input button', async () => {
    const win = chartPage([
      // "Sell" and "100" in two spans side by side, with no space in the text between them.
      fakeElement({
        tag: 'button',
        id: 'split-sell',
        matches: ['#split-sell'],
        rect: box(100, 600, 100, 24),
        children: [
          fakeElement({ tag: 'span', text: 'Sell', rect: box(105, 602, 40, 20) }),
          fakeElement({ tag: 'span', text: '100', rect: box(150, 602, 40, 20) }),
        ],
      }),
      // Named "Confirm", and shows "Buy 100".
      fakeElement({
        tag: 'button',
        attributes: { 'aria-label': 'Confirm' },
        text: 'Buy 100',
        rect: box(250, 600, 100, 24),
      }),
      // A submit input whose label is its value.
      fakeElement({
        tag: 'input',
        attributes: { type: 'submit', value: 'Submit order' },
        rect: box(400, 600, 100, 24),
      }),
    ]);
    const { client, app } = await startHarness({ win });

    const split = await callTool(client, 'ui_click', { x: 170, y: 612 });
    const labelled = await callTool(client, 'ui_click', { text: 'Confirm' });
    const submit = await callTool(client, 'ui_click', { text: 'submit order' });

    expect(errorOf(split)).toMatchObject({
      code: 'UNSAFE_ACTION_BLOCKED',
      details: { x: 170, y: 612, name: 'Sell 100' },
    });
    expect(errorOf(labelled)).toMatchObject({
      code: 'UNSAFE_ACTION_BLOCKED',
      details: { text: 'Confirm', name: 'Buy 100' },
    });
    expect(errorOf(submit)).toMatchObject({
      code: 'UNSAFE_ACTION_BLOCKED',
      details: { text: 'submit order', name: 'Submit order' },
    });
    expect(inputCountOf(app)).toBe(0);
  });

  test('ui_click refuses a trading word that an element splits inside, and quotes it', async () => {
    // <button><u>S</u>ell 100</button>: the screen shows "Sell 100".
    const underlined = fakeElement({
      tag: 'button',
      rect: box(100, 600, 80, 24),
      nodes: [fakeElement({ tag: 'u', text: 'S', rect: box(102, 602, 8, 20) }), 'ell 100'],
    });
    const { client, app } = await startHarness({ win: chartPage([underlined]) });

    const result = await callTool(client, 'ui_click', { x: 150, y: 612 });

    expect(errorOf(result)).toMatchObject({
      code: 'UNSAFE_ACTION_BLOCKED',
      message:
        'Refusing to click at (150, 612): the click would reach "Sell 100", a trading action',
      details: { x: 150, y: 612, name: 'Sell 100' },
    });
    expect(inputCountOf(app)).toBe(0);
  });

  test('ui_click refuses the price inside a clickable div that only the pointer cursor marks, and not a span of a plain div', async () => {
    const span = (text: string, x: number, width: number) =>
      fakeElement({ tag: 'span', text, rect: box(x, 605, width, 20) });
    // A quote button without a role: the page makes the div clickable, and the cursor shows it.
    const quote = fakeElement({
      cursor: 'pointer',
      rect: box(100, 600, 200, 30),
      children: [span('Buy', 105, 40), span('|', 150, 10), span('1.0857', 165, 80)],
    });
    // A div with the default cursor that shows the word Buy beside the span that is clicked.
    const plain = fakeElement({
      cursor: 'default',
      rect: box(400, 600, 300, 30),
      children: [span('Buy', 405, 40), span('Details', 500, 80)],
    });
    const { client, app } = await startHarness({ win: chartPage([quote, plain]) });

    const onPrice = await callTool(client, 'ui_click', { x: 200, y: 615 });
    const onDetails = await callTool(client, 'ui_click', { x: 540, y: 615 });

    expect(errorOf(onPrice)).toMatchObject({
      code: 'UNSAFE_ACTION_BLOCKED',
      message:
        'Refusing to click at (200, 615): the click would reach "Buy | 1.0857", a trading action',
      details: { x: 200, y: 615, name: 'Buy | 1.0857' },
    });
    expect(dataOf(onDetails)).toEqual({ target: 'chart', by: 'point', point: { x: 540, y: 615 } });
    // The second click only.
    expect(typesOf(app)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
  });

  test('ui_click by selector refuses a target whose center a container of the trade button covers', async () => {
    const panel = fakeElement({
      attributes: { 'data-name': 'trading-panel' },
      rect: box(0, 100, 800, 400),
      children: [
        fakeElement({ matches: ['[data-qa-id="trade-button"]'], rect: box(700, 110, 60, 30) }),
      ],
    });
    const { client, app } = await startHarness({ win: chartPage([panel]) });

    const result = await callTool(client, 'ui_click', { selector: PANE });

    expect(errorOf(result)).toMatchObject({
      code: 'UNSAFE_ACTION_BLOCKED',
      details: { selector: PANE },
    });
    expect(inputCountOf(app)).toBe(0);
  });

  test('ui_click refuses a page that does not report its zoom, before any input', async () => {
    const metrics = layoutMetrics({
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      devicePixelRatio: 1,
    });
    const { client, app } = await startHarness({
      chartHandlers: {
        'Page.getLayoutMetrics': () => ({
          ...metrics,
          cssVisualViewport: { ...metrics.cssVisualViewport, zoom: undefined },
        }),
      },
    });

    const result = await callTool(client, 'ui_click', { selector: SAVE });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: 'The page did not report its zoom',
    });
    expect(inputCountOf(app)).toBe(0);
  });

  test('ui_click at a point under an open menu of the overlap root refuses with NOT_AVAILABLE', async () => {
    const { client, app } = await startHarness({ win: chartPage([openMenu()]) });

    const result = await callTool(client, 'ui_click', { x: 400, y: 300 });

    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: 'The point (400, 300) is covered by `div#menu-item`',
      details: { x: 400, y: 300, obscuredBy: 'div#menu-item' },
    });
    expect(errorOf(result)?.hint).toMatch(/selector or text/);
    expect(inputCountOf(app)).toBe(0);
  });

  test('ui_click at a point inside a frame refuses', async () => {
    const frame = fakeElement({ tag: 'iframe', id: 'ad', rect: box(350, 280, 100, 40) });
    const { client, app } = await startHarness({ win: chartPage([frame]) });

    const result = await callTool(client, 'ui_click', { x: 400, y: 300 });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      details: { x: 400, y: 300, obscuredBy: 'iframe#ad' },
    });
    expect(inputCountOf(app)).toBe(0);
  });

  test("ui_click by selector clicks the element's centre after the second look", async () => {
    const { client, app } = await startHarness();

    const result = await callTool(client, 'ui_click', { selector: SAVE });

    expect(result.isError).not.toBe(true);
    expect(dataOf(result)).toEqual({ target: 'chart', by: 'selector', point: { x: 120, y: 60 } });
    expect(envelopeOf(result).meta.via).toBe('cdp');
    // A look and the zoom, the move, the second look and the zoom, then the press and the release.
    expect(methodsOf(app)).toEqual([
      'Runtime.evaluate',
      'Page.getLayoutMetrics',
      'Input.dispatchMouseEvent',
      'Runtime.evaluate',
      'Page.getLayoutMetrics',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
    ]);
    expect(mouseOf(app)).toEqual([
      { type: 'mouseMoved', x: 120, y: 60 },
      { type: 'mousePressed', x: 120, y: 60, button: 'left', clickCount: 1 },
      { type: 'mouseReleased', x: 120, y: 60, button: 'left', clickCount: 1 },
    ]);
  });

  test('ui_click by selector stops after the move when a menu opens over the target', async () => {
    const menu = openMenu();
    const [item] = menu.children;
    const win = chartPage([menu]);
    const { client, app } = await startHarness({
      win,
      chartHandlers: afterTheMove(() => {
        win.document.elementFromPoint = () => item ?? null;
      }),
    });

    const result = await callTool(client, 'ui_click', { selector: SAVE });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      details: { selector: SAVE, obscuredBy: 'div#menu-item' },
    });
    expect(typesOf(app)).toEqual(['mouseMoved']);
  });

  test('ui_click by text clicks the first visible element with that name and refuses when it is unsafe', async () => {
    const apply = (rect: FakeRect, options: FakeElementOptions = {}) =>
      fakeElement({ tag: 'button', text: 'Apply', rect, ...options });
    const win = chartPage([
      apply(box(300, 600, 40, 20), { display: 'none' }),
      apply(box(100, 600, 40, 20)),
      apply(box(500, 600, 40, 20)),
    ]);
    const { client, app } = await startHarness({ win });

    const clicked = await callTool(client, 'ui_click', { text: '  apply ' });
    const refused = await callTool(client, 'ui_click', { text: 'buy' });

    expect(dataOf(clicked)).toEqual({ target: 'chart', by: 'text', point: { x: 120, y: 610 } });
    expect(errorOf(refused)).toEqual({
      code: 'UNSAFE_ACTION_BLOCKED',
      message:
        'Refusing to click the element named "buy": it is part of a broker trading control, holds one, or has one over it',
      hint: expect.any(String) as string,
      details: { text: 'buy' },
    });
    // The click on Apply, and nothing for the buy button.
    expect(typesOf(app)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    expect(mouseOf(app)[1]).toMatchObject({ x: 120, y: 610 });
  });

  test('ui_click by text points to ui_find_element when no visible element has the name', async () => {
    const { client, app } = await startHarness();

    const result = await callTool(client, 'ui_click', { text: 'Nothing like this' });

    expect(errorOf(result)).toMatchObject({
      code: 'INVALID_INPUT',
      message: 'No visible element is named "Nothing like this"',
      details: { text: 'Nothing like this' },
    });
    expect(errorOf(result)?.hint).toMatch(/ui_find_element/);
    expect(inputCountOf(app)).toBe(0);
  });

  test('ui_click sends the point in device-independent pixels on a zoomed page', async () => {
    const { client, app } = await startHarness({ win: chartPage([], { zoom: 1.25 }) });

    const result = await callTool(client, 'ui_click', { x: 120, y: 60 });

    // The page judged (120, 60) in CSS pixels, which the result reports; the window took (150, 75).
    expect(dataOf(result)).toEqual({ target: 'chart', by: 'point', point: { x: 120, y: 60 } });
    expect(mouseOf(app).map(({ x, y }) => [x, y])).toEqual([
      [150, 75],
      [150, 75],
      [150, 75],
    ]);
  });

  test.each<[string, Record<string, unknown>]>([
    ['nothing', {}],
    ['a selector and a text', { selector: SAVE, text: 'Save all charts' }],
    ['a selector and a point', { selector: SAVE, x: 10, y: 10 }],
    ['x without y', { x: 10 }],
    ['y without x', { y: 10 }],
    ['a text of spaces', { text: '   ' }],
  ])('ui_click refuses %s with INVALID_INPUT before it reaches the app', async (_case, args) => {
    const { client, app } = await startHarness();

    const result = await callTool(client, 'ui_click', args);

    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(app.calls).toEqual([]);
  });
});

describe('ui_hover', () => {
  test('ui_hover moves the pointer only', async () => {
    const { client, app } = await startHarness();

    const result = await callTool(client, 'ui_hover', { selector: SAVE });

    expect(result.isError).not.toBe(true);
    expect(dataOf(result)).toEqual({ target: 'chart', by: 'selector', point: { x: 120, y: 60 } });
    expect(warningsOf(result)).toEqual([]);
    // No button: the move, and the second look once the pointer is there.
    expect(mouseOf(app)).toEqual([{ type: 'mouseMoved', x: 120, y: 60 }]);
    expect(methodsOf(app)).toEqual([
      'Runtime.evaluate',
      'Page.getLayoutMetrics',
      'Input.dispatchMouseEvent',
      'Runtime.evaluate',
    ]);
  });

  test('ui_hover refuses unsafe targets the way ui_click does, without moving the pointer', async () => {
    const { client, app } = await startHarness({ win: chartPage([openMenu()]) });

    const byText = await callTool(client, 'ui_hover', { text: 'Buy' });
    const bySelector = await callTool(client, 'ui_hover', { selector: BUY });
    const atPoint = await callTool(client, 'ui_hover', { x: 370, y: 270 });
    const inMenu = await callTool(client, 'ui_hover', { x: 400, y: 300 });

    expect(errorOf(byText)).toMatchObject({ code: 'UNSAFE_ACTION_BLOCKED' });
    expect(errorOf(bySelector)).toMatchObject({
      code: 'UNSAFE_ACTION_BLOCKED',
      message: `Refusing to hover over \`${BUY}\`: it is part of a broker trading control or has one over it`,
    });
    expect(errorOf(atPoint)).toMatchObject({
      code: 'UNSAFE_ACTION_BLOCKED',
      message: 'Refusing to hover at (370, 270): a broker trading control lies there',
    });
    expect(errorOf(inMenu)).toMatchObject({ code: 'NOT_AVAILABLE' });
    expect(inputCountOf(app)).toBe(0);
  });

  test('ui_hover warns when a trading control lies under the pointer once it arrived', async () => {
    const buy = fakeElement({ tag: 'button', matches: [BUY], rect: box(100, 50, 40, 20) });
    const win = chartPage();
    const { client, app } = await startHarness({
      win,
      chartHandlers: afterTheMove(() => {
        win.document.elementFromPoint = () => buy;
      }),
    });

    const result = await callTool(client, 'ui_hover', { selector: SAVE });

    expect(result.isError).not.toBe(true);
    expect(dataOf(result)).toEqual({ target: 'chart', by: 'selector', point: { x: 120, y: 60 } });
    expect(warningsOf(result)).toEqual([
      'A broker trading control lies under the pointer since it arrived.',
    ]);
    expect(typesOf(app)).toEqual(['mouseMoved']);
  });
});

describe('ui_scroll', () => {
  test("ui_scroll sends one mouseWheel at the target's centre and refuses unsafe targets", async () => {
    const { client, app } = await startHarness();

    const scrolled = await callTool(client, 'ui_scroll', { selector: PANE, deltaY: 120 });
    const onButton = await callTool(client, 'ui_scroll', { selector: BUY, deltaY: 120 });
    const atButton = await callTool(client, 'ui_scroll', { x: 320, y: 260, deltaY: 120 });

    expect(dataOf(scrolled)).toEqual({
      target: 'chart',
      by: 'selector',
      point: { x: 400, y: 300 },
      deltaX: 0,
      deltaY: 120,
    });
    expect(errorOf(onButton)).toMatchObject({
      code: 'UNSAFE_ACTION_BLOCKED',
      message: `Refusing to scroll over \`${BUY}\`: it is part of a broker trading control or has one over it`,
    });
    expect(errorOf(atButton)).toMatchObject({ code: 'UNSAFE_ACTION_BLOCKED' });
    // One move and one turn of the wheel at the center of the pane, and no button, for the first
    // call; nothing for the other two.
    expect(mouseOf(app)).toEqual([
      { type: 'mouseMoved', x: 400, y: 300 },
      { type: 'mouseWheel', x: 400, y: 300, deltaX: 0, deltaY: 120 },
    ]);
  });

  test('ui_scroll over an open menu of the overlap root refuses with NOT_AVAILABLE', async () => {
    const { client, app } = await startHarness({ win: chartPage([openMenu()]) });

    const result = await callTool(client, 'ui_scroll', { x: 400, y: 300, deltaY: -100 });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      details: { x: 400, y: 300, obscuredBy: 'div#menu-item' },
    });
    expect(inputCountOf(app)).toBe(0);
  });

  test('ui_scroll scrolls the pane, although the pane holds the buy and sell buttons', async () => {
    const pane = fakeElement({
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
    const { client, app } = await startHarness({ win: chartPage([pane]) });

    const result = await callTool(client, 'ui_scroll', {
      selector: '[data-qa-id="pane"]',
      deltaX: -40,
      deltaY: 100,
    });

    expect(result.isError).not.toBe(true);
    expect(mouseOf(app).at(-1)).toEqual({
      type: 'mouseWheel',
      x: 400,
      y: 300,
      deltaX: -40,
      deltaY: 100,
    });
  });

  test.each<[string, Record<string, unknown>]>([
    ['no target', { deltaY: 100 }],
    ['a selector and a point', { selector: PANE, x: 10, y: 10, deltaY: 100 }],
    ['x without y', { x: 10, deltaY: 100 }],
  ])('ui_scroll refuses %s with INVALID_INPUT before it reaches the app', async (_case, args) => {
    const { client, app } = await startHarness();

    const result = await callTool(client, 'ui_scroll', args);

    expect(errorOf(result)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(app.calls).toEqual([]);
  });
});

describe('ui_find_element', () => {
  test('ui_find_element by text returns visible elements with rects and marks unsafe ones', async () => {
    const win = chartPage([
      fakeElement({
        tag: 'div',
        attributes: { role: 'menuitem' },
        text: 'Buy',
        rect: box(10, 600, 50, 20),
      }),
      fakeElement({ text: 'Buy', display: 'none', rect: box(10, 640, 50, 20) }),
    ]);
    const { client, app } = await startHarness({ win });

    const result = await callTool(client, 'ui_find_element', { text: 'buy' });

    expect(result.isError).not.toBe(true);
    // In document order: the buy button, its label, which sits inside it and so is unsafe too, and
    // the menu item. The hidden element is left out.
    expect(dataOf(result)).toEqual({
      elements: [
        {
          selector: BUY,
          tag: 'button',
          role: null,
          name: 'Buy',
          text: 'Buy',
          rect: box(300, 250, 80, 30),
          visible: true,
          unsafe: true,
          holdsUnsafe: false,
        },
        {
          selector: null,
          tag: 'span',
          role: null,
          name: 'Buy',
          text: 'Buy',
          rect: box(310, 255, 40, 20),
          visible: true,
          unsafe: true,
          holdsUnsafe: false,
        },
        {
          selector: null,
          tag: 'div',
          role: 'menuitem',
          name: 'Buy',
          text: 'Buy',
          rect: box(10, 600, 50, 20),
          visible: true,
          unsafe: false,
          holdsUnsafe: false,
        },
      ],
    });
    expect(envelopeOf(result).meta.via).toBe('dom');
    expect(warningsOf(result)).toEqual([]);
    // A look, and no input at all.
    expect(methodsOf(app)).toEqual(['Runtime.evaluate']);
  });

  test('ui_find_element by selector lists at most limit elements and warns when more match', async () => {
    const rows = ['One', 'Two', 'Three'].map((text, index) =>
      fakeElement({ matches: ['.row'], text, rect: box(10, 600 + index * 30, 100, 20) }),
    );
    const { client } = await startHarness({ win: chartPage(rows) });

    const two = await callTool(client, 'ui_find_element', { selector: '.row', limit: 2 });
    const all = await callTool(client, 'ui_find_element', { selector: '.row' });

    expect(
      (dataOf(two) as { elements: { text: string }[] }).elements.map(({ text }) => text),
    ).toEqual(['One', 'Two']);
    expect(warningsOf(two)).toEqual([
      'More elements match than the 2 listed. Raise limit (up to 50), or narrow the selector or the text.',
    ]);
    expect((dataOf(all) as { elements: unknown[] }).elements).toHaveLength(3);
    expect(warningsOf(all)).toEqual([]);
  });

  test('ui_find_element never returns what a field holds', async () => {
    const field = (options: FakeElementOptions): FakeElement => {
      const element = fakeElement({ matches: ['.field'], ...options });
      Object.defineProperty(element, 'value', {
        get() {
          throw new Error('The value of a field was read');
        },
      });
      return element;
    };
    // The dialog of an alert, whose message the user filled in, and a note typed into an editable
    // region of it: the textarea keeps its text as a text node of the dialog.
    const dialog = fakeElement({
      matches: ['.field'],
      attributes: { role: 'dialog' },
      rect: box(400, 520, 400, 190),
      children: [
        fakeElement({ tag: 'span', text: 'Alert message', rect: box(410, 525, 200, 20) }),
        field({ tag: 'textarea', text: 'a secret note', rect: box(410, 550, 380, 60) }),
        fakeElement({
          attributes: { contenteditable: 'true' },
          rect: box(410, 620, 380, 60),
          children: [fakeElement({ tag: 'p', text: 'a typed note', rect: box(415, 625, 200, 20) })],
        }),
      ],
    });
    const win = chartPage([
      field({
        tag: 'input',
        attributes: { type: 'password', 'aria-label': 'Password' },
        rect: box(10, 600, 100, 20),
      }),
      dialog,
    ]);
    const { client } = await startHarness({ win });

    const result = await callTool(client, 'ui_find_element', { selector: '.field' });

    expect(result.isError).not.toBe(true);
    expect(
      (dataOf(result) as { elements: { tag: string; name: string; text: string }[] }).elements.map(
        ({ tag, name, text }) => ({ tag, name, text }),
      ),
    ).toEqual([
      { tag: 'input', name: 'Password', text: '' },
      { tag: 'div', name: 'Alert message', text: 'Alert message' },
      { tag: 'textarea', name: '', text: '' },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/secret|typed note/);
  });

  test.each<[string, Record<string, unknown>]>([
    ['neither a selector nor a text', {}],
    ['a text of spaces', { text: '  ' }],
  ])(
    'ui_find_element refuses %s with INVALID_INPUT before it reaches the app',
    async (_case, args) => {
      const { client, app } = await startHarness();

      const result = await callTool(client, 'ui_find_element', args);

      expect(errorOf(result)).toMatchObject({ code: 'INVALID_INPUT' });
      expect(app.calls).toEqual([]);
    },
  );

  test('ui_find_element refuses a selector that is not valid CSS with INVALID_INPUT', async () => {
    const { client } = await startHarness();

    const result = await callTool(client, 'ui_find_element', { selector: '[data-name="open' });

    expect(errorOf(result)).toMatchObject({
      code: 'INVALID_INPUT',
      details: { selector: '[data-name="open' },
    });
  });
});

describe('the window chrome', () => {
  test('target window acts on the window chrome page', async () => {
    const { client, app } = await startHarness();

    const found = await callTool(client, 'ui_find_element', { text: 'new tab', target: 'window' });
    const clicked = await callTool(client, 'ui_click', { selector: ACTIVE_TAB, target: 'window' });
    const hovered = await callTool(client, 'ui_hover', { text: 'New tab', target: 'window' });

    expect(dataOf(found)).toEqual({
      elements: [
        {
          selector: '[aria-label="New tab"]',
          tag: 'button',
          role: null,
          name: 'New tab',
          text: '',
          rect: box(290, 5, 24, 24),
          visible: true,
          unsafe: false,
          holdsUnsafe: false,
        },
      ],
    });
    expect(dataOf(clicked)).toEqual({ target: 'window', by: 'selector', point: { x: 180, y: 17 } });
    expect(dataOf(hovered)).toEqual({ target: 'window', by: 'text', point: { x: 302, y: 17 } });
    expect(typesOf(app, CHROME_ID)).toEqual([
      'mouseMoved',
      'mousePressed',
      'mouseReleased',
      'mouseMoved',
    ]);
    // Nothing reached the chart tab.
    expect(methodsOf(app)).toEqual([]);
  });

  test('the window chrome is only read through the DOM page functions and sent input events', async () => {
    const { client, app } = await startHarness();

    await callTool(client, 'ui_find_element', { selector: ACTIVE_TAB, target: 'window' });
    await callTool(client, 'ui_click', { selector: ACTIVE_TAB, target: 'window' });
    await callTool(client, 'ui_scroll', {
      selector: ACTIVE_TAB,
      deltaX: 50,
      deltaY: 0,
      target: 'window',
    });
    await callTool(client, 'ui_press_key', { key: 'Escape', target: 'window' });
    // Nothing takes text there: the body has the focus.
    await callTool(client, 'ui_type_text', { text: 'x', target: 'window' });

    const calls = app.calls.filter(({ targetId }) => targetId === CHROME_ID);
    // The renderer of the window chrome has Node integration: what runs there is the source of the
    // page functions that read elements, and nothing else.
    expect(new Set(calls.map(({ method }) => method))).toEqual(
      new Set([
        'Runtime.evaluate',
        'Page.getLayoutMetrics',
        'Input.dispatchMouseEvent',
        'Input.dispatchKeyEvent',
      ]),
    );
    const sources = [describeElement, findElements, describeFocusedElement].map((fn) =>
      fn.toString(),
    );
    const evaluated = calls.filter(({ method }) => method === 'Runtime.evaluate');
    expect(evaluated.length).toBeGreaterThan(0);
    for (const { params } of evaluated) {
      const { expression } = params as { expression: string };
      const source = sources.find((candidate) =>
        expression.startsWith(`(${candidate})(window, ...`),
      );
      expect(source, 'one of the page functions that only read the DOM').toBeDefined();
      const prefix = `(${source ?? ''})(window, ...`;
      const args = JSON.parse(expression.slice(prefix.length, -1)) as JsonValue[];
      // Exactly (source)(window, ...args): no page library and nothing else around the function.
      expect(expression).toBe(`(${source ?? ''})(window, ...${JSON.stringify(args)})`);
      expect(expression).not.toContain('createPageLib');
    }
  });
});

describe('points outside the page', () => {
  test('coordinates outside the viewport are INVALID_INPUT', async () => {
    const { client, app } = await startHarness();

    const right = await callTool(client, 'ui_click', { x: 1300, y: 10 });
    const below = await callTool(client, 'ui_scroll', { x: 10, y: 800, deltaY: 100 });
    const negative = await callTool(client, 'ui_hover', { x: -1, y: 5 });
    const belowTheStrip = await callTool(client, 'ui_click', { x: 100, y: 40, target: 'window' });

    for (const result of [right, below, negative, belowTheStrip]) {
      expect(result.isError).toBe(true);
      expect(errorOf(result)?.code).toBe('INVALID_INPUT');
    }
    expect(errorOf(right)).toMatchObject({
      message: 'The point (1300, 10) is outside the visible part of the page',
      details: { x: 1300, y: 10 },
    });
    expect(inputCountOf(app)).toBe(0);
  });
});

// The key events a target received, as their parameters.
function keysOf(app: FakeCdpServer, targetId = CHART_ID): Record<string, unknown>[] {
  return app.calls
    .filter((call) => call.targetId === targetId && call.method === 'Input.dispatchKeyEvent')
    .map(({ params }) => params as Record<string, unknown>);
}

describe('ui_type_text and ui_press_key', () => {
  test('ui_type_text types only into a focused text field', async () => {
    const field = fakeElement({ tag: 'input', id: 'search', rect: box(500, 600, 200, 24) });
    const button = fakeElement({ tag: 'button', text: 'Apply', rect: box(750, 600, 60, 24) });
    const win = chartPage([field, button], { focus: field });
    const { client, app } = await startHarness({ win });

    const typed = await callTool(client, 'ui_type_text', { text: 'NASDAQ:AAPL' });
    win.document.activeElement = button;
    const onButton = await callTool(client, 'ui_type_text', { text: 'MSFT' });
    win.document.activeElement = null;
    const nowhere = await callTool(client, 'ui_type_text', { text: 'MSFT' });

    expect(envelopeOf(typed)).toMatchObject({
      ok: true,
      data: { target: 'chart', characters: 11 },
      meta: { via: 'cdp' },
    });
    expect(errorOf(onButton)).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: 'Cannot type text: the focus is on `button`, which is not a text field',
    });
    expect(errorOf(nowhere)).toMatchObject({ code: 'NOT_AVAILABLE' });
    // The one text that was typed, and no key event.
    expect(
      app.calls
        .filter(({ method }) => method.startsWith('Input.'))
        .map(({ method, params }) => ({
          method,
          params,
        })),
    ).toEqual([{ method: 'Input.insertText', params: { text: 'NASDAQ:AAPL' } }]);
  });

  test('ui_type_text refuses a field inside a trading control', async () => {
    const field = fakeElement({ tag: 'input', id: 'qty' });
    const group = fakeElement({
      matches: ['[data-name="buy-sell-buttons"]'],
      rect: box(500, 600, 200, 40),
      children: [field],
    });
    const { client, app } = await startHarness({ win: chartPage([group], { focus: field }) });

    const result = await callTool(client, 'ui_type_text', { text: '100' });

    expect(errorOf(result)).toMatchObject({
      code: 'UNSAFE_ACTION_BLOCKED',
      details: { action: 'typeText', focused: 'input#qty' },
    });
    expect(inputCountOf(app)).toBe(0);
  });

  test('ui_press_key refuses while a trading control has the focus', async () => {
    const buy = fakeElement({
      tag: 'button',
      matches: [BUY],
      attributes: { 'data-name': 'buy-order-button' },
      rect: box(300, 250, 80, 30),
    });
    // A button of an order ticket that carries no selector of the guard, named by its text.
    const ticketBuy = fakeElement({ tag: 'button', text: 'Buy 1', rect: box(500, 600, 80, 24) });
    const win = chartPage([buy, ticketBuy], { focus: buy });
    const { client, app } = await startHarness({ win });

    const onControl = await callTool(client, 'ui_press_key', { key: 'Enter' });
    win.document.activeElement = ticketBuy;
    const onTicket = await callTool(client, 'ui_press_key', { key: 'Enter' });

    expect(errorOf(onControl)).toMatchObject({
      code: 'UNSAFE_ACTION_BLOCKED',
      message:
        'Refusing to press a key: the focus is on `button[data-name="buy-order-button"]`, which is part of a broker trading control',
    });
    expect(errorOf(onTicket)).toMatchObject({
      code: 'UNSAFE_ACTION_BLOCKED',
      message:
        'Refusing to press a key: the focus is on `button`, and a key there would reach "Buy 1", a trading action',
      details: { action: 'pressKey', focused: 'button', name: 'Buy 1' },
    });
    expect(keysOf(app)).toEqual([]);
  });

  test('ui_press_key sends the key with its modifiers to the focused element, on the chart or the window chrome', async () => {
    const { client, app } = await startHarness();

    const escape = await callTool(client, 'ui_press_key', { key: 'Escape' });
    const undo = await callTool(client, 'ui_press_key', {
      key: 'z',
      modifiers: ['Control'],
      target: 'window',
    });

    expect(dataOf(escape)).toEqual({ target: 'chart', key: 'Escape', modifiers: [] });
    expect(dataOf(undo)).toEqual({ target: 'window', key: 'z', modifiers: ['Control'] });
    expect(keysOf(app).map(({ type, key }) => [type, key])).toEqual([
      ['rawKeyDown', 'Escape'],
      ['keyUp', 'Escape'],
    ]);
    expect(
      keysOf(app, CHROME_ID).map(({ type, key, modifiers }) => [type, key, modifiers]),
    ).toEqual([
      ['rawKeyDown', 'z', 2],
      ['keyUp', 'z', 2],
    ]);
  });

  test('ui_press_key refuses an unsupported key, and ui_type_text an empty or a long text, before anything is sent', async () => {
    const { client, app } = await startHarness();

    const key = await callTool(client, 'ui_press_key', { key: 'F5' });
    const empty = await callTool(client, 'ui_type_text', { text: '' });
    const long = await callTool(client, 'ui_type_text', { text: 'x'.repeat(1001) });

    expect(errorOf(key)).toMatchObject({ code: 'INVALID_INPUT', details: { key: 'F5' } });
    for (const result of [empty, long]) {
      expect(result.isError).toBe(true);
    }
    expect(app.calls).toEqual([]);
  });
});

// A chart page with the right toolbar of the app at its right edge, whose clicks the chart tab
// answers the way TradingView does (right-toolbar.ts).
function withToolbar(
  options: FakeRightToolbarOptions = {},
  extra: FakeElement[] = [],
): { win: FakeDomWindow; toolbar: FakeRightToolbar; chartHandlers: Handlers } {
  const toolbar = createFakeRightToolbar(options);
  return {
    win: chartPage([...extra, toolbar.element]),
    toolbar,
    chartHandlers: {
      'Input.dispatchMouseEvent': (params) => {
        const { type, x, y } = params as { type: string; x: number; y: number };
        if (type === 'mouseReleased') {
          toolbar.click(x, y);
        }
        return {};
      },
    },
  };
}

// Where a click went, as its point: the presses only.
const pressesOf = (app: FakeCdpServer): { x: unknown; y: unknown }[] =>
  mouseOf(app)
    .filter(({ type }) => type === 'mousePressed')
    .map(({ x, y }) => ({ x, y }));

// The centers of the buttons of the fake toolbar and of the tabs of the object tree panel.
const WATCHLIST_BUTTON = { x: 1257, y: 68 };
const ALERTS_BUTTON = { x: 1257, y: 108 };
const OBJECT_TREE_BUTTON = { x: 1257, y: 148 };
const OBJECT_TREE_TAB = { x: 960, y: 65 };
const DATA_WINDOW_TAB = { x: 1070, y: 65 };

describe('ui_open_panel', () => {
  test('ui_open_panel opens the watchlist through the right toolbar and reports it open', async () => {
    const { win, toolbar, chartHandlers } = withToolbar();
    const { client, app } = await startHarness({ win, chartHandlers });

    const result = await callTool(client, 'ui_open_panel', { panel: 'watchlist' });
    const state = await callTool(client, 'app_get_ui_state');

    expect(envelopeOf(result)).toMatchObject({
      ok: true,
      data: { panel: 'watchlist', open: true, changed: true },
      meta: { via: 'cdp' },
    });
    expect(pressesOf(app)).toEqual([WATCHLIST_BUTTON]);
    expect(toolbar.state.shown).toBe('watchlist');
    // app_get_ui_state reads the panel the same way.
    expect(dataOf(state)).toMatchObject({
      rightPanel: { open: true },
      panels: { watchlist: true, alerts: false, object_tree: false, data_window: false },
    });
  });

  test('ui_open_panel closing an already closed panel changes nothing', async () => {
    const { win, chartHandlers } = withToolbar({ shown: 'watchlist' });
    const { client, app } = await startHarness({ win, chartHandlers });

    const closed = await callTool(client, 'ui_open_panel', { panel: 'alerts', open: false });
    const open = await callTool(client, 'ui_open_panel', { panel: 'watchlist' });

    expect(dataOf(closed)).toEqual({ panel: 'alerts', open: false, changed: false });
    expect(dataOf(open)).toEqual({ panel: 'watchlist', open: true, changed: false });
    expect(inputCountOf(app)).toBe(0);
  });

  test('ui_open_panel switches the panel to another page, and collapses the one shown', async () => {
    const { win, toolbar, chartHandlers } = withToolbar({ shown: 'watchlist' });
    const { client, app } = await startHarness({ win, chartHandlers });

    const alerts = await callTool(client, 'ui_open_panel', { panel: 'alerts' });
    const closed = await callTool(client, 'ui_open_panel', { panel: 'alerts', open: false });

    expect(dataOf(alerts)).toEqual({ panel: 'alerts', open: true, changed: true });
    expect(dataOf(closed)).toEqual({ panel: 'alerts', open: false, changed: true });
    expect(pressesOf(app)).toEqual([ALERTS_BUTTON, ALERTS_BUTTON]);
    expect(toolbar.state.shown).toBeNull();
  });

  test('ui_open_panel opens the data window: the panel of the object tree, then its tab', async () => {
    const collapsed = withToolbar();
    const fromCollapsed = await startHarness({
      win: collapsed.win,
      chartHandlers: collapsed.chartHandlers,
    });
    const onTree = withToolbar({ shown: 'object_tree' });
    const fromTree = await startHarness({ win: onTree.win, chartHandlers: onTree.chartHandlers });

    const opened = await callTool(fromCollapsed.client, 'ui_open_panel', { panel: 'data_window' });
    const switched = await callTool(fromTree.client, 'ui_open_panel', { panel: 'data_window' });

    for (const result of [opened, switched]) {
      expect(dataOf(result)).toEqual({ panel: 'data_window', open: true, changed: true });
    }
    expect(pressesOf(fromCollapsed.app)).toEqual([OBJECT_TREE_BUTTON, DATA_WINDOW_TAB]);
    expect(pressesOf(fromTree.app)).toEqual([DATA_WINDOW_TAB]);
    for (const { toolbar } of [collapsed, onTree]) {
      expect(toolbar.state).toEqual({ shown: 'object_tree', dataWindow: true });
    }
  });

  test('ui_open_panel opens the object tree on its own tab when the panel remembers the data window', async () => {
    const { win, toolbar, chartHandlers } = withToolbar({ dataWindow: true });
    const { client, app } = await startHarness({ win, chartHandlers });

    const result = await callTool(client, 'ui_open_panel', { panel: 'object_tree' });

    expect(dataOf(result)).toEqual({ panel: 'object_tree', open: true, changed: true });
    expect(pressesOf(app)).toEqual([OBJECT_TREE_BUTTON, OBJECT_TREE_TAB]);
    expect(toolbar.state).toEqual({ shown: 'object_tree', dataWindow: false });
  });

  test('ui_open_panel closes the data window by collapsing its panel, and the object tree it does not show changes nothing', async () => {
    const { win, toolbar, chartHandlers } = withToolbar({ shown: 'object_tree', dataWindow: true });
    const { client, app } = await startHarness({ win, chartHandlers });

    const tree = await callTool(client, 'ui_open_panel', { panel: 'object_tree', open: false });
    const dataWindow = await callTool(client, 'ui_open_panel', {
      panel: 'data_window',
      open: false,
    });

    expect(dataOf(tree)).toEqual({ panel: 'object_tree', open: false, changed: false });
    expect(dataOf(dataWindow)).toEqual({ panel: 'data_window', open: false, changed: true });
    expect(pressesOf(app)).toEqual([OBJECT_TREE_BUTTON]);
    expect(toolbar.state.shown).toBeNull();
  });

  test('ui_open_panel says CAPABILITY_UNAVAILABLE for a data window the panel has no tab for, and collapses the panel it opened', async () => {
    const { win, toolbar, chartHandlers } = withToolbar({ withoutTabs: true });
    const { client, app } = await startHarness({ win, chartHandlers });

    const result = await callTool(client, 'ui_open_panel', { panel: 'data_window' });

    expect(errorOf(result)).toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      message: expect.stringMatching(/no tab for the data window/) as string,
    });
    // The panel of the object tree was opened to look for the tab, and collapsed again.
    expect(pressesOf(app)).toEqual([OBJECT_TREE_BUTTON, OBJECT_TREE_BUTTON]);
    expect(toolbar.state.shown).toBeNull();
  });

  test('ui_open_panel says CAPABILITY_UNAVAILABLE for a missing button, or one that does not say whether its panel is shown, before any input', async () => {
    const missing = withToolbar({ without: ['alerts'] });
    const unpressable = withToolbar({ unpressable: ['watchlist'] });
    const first = await startHarness({ win: missing.win, chartHandlers: missing.chartHandlers });
    const second = await startHarness({
      win: unpressable.win,
      chartHandlers: unpressable.chartHandlers,
    });

    const noButton = await callTool(first.client, 'ui_open_panel', { panel: 'alerts' });
    const noState = await callTool(second.client, 'ui_open_panel', { panel: 'watchlist' });

    expect(errorOf(noButton)).toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      details: { panel: 'alerts', selector: SELECTORS.buttons.alerts },
    });
    expect(errorOf(noState)).toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      details: { panel: 'watchlist', selector: SELECTORS.buttons.watchlist },
    });
    expect([inputCountOf(first.app), inputCountOf(second.app)]).toEqual([0, 0]);
  });

  test('ui_open_panel says NOT_AVAILABLE while the toolbar is hidden, as in fullscreen mode', async () => {
    const { win, chartHandlers } = withToolbar({ hidden: true });
    const { client, app } = await startHarness({ win, chartHandlers });

    const result = await callTool(client, 'ui_open_panel', { panel: 'watchlist' });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      hint: expect.stringMatching(/ui_fullscreen/) as string,
    });
    expect(inputCountOf(app)).toBe(0);
  });

  test('ui_open_panel reports TIMEOUT when the panel does not change after the click', async () => {
    const { win, chartHandlers } = withToolbar({ inert: true });
    const { client, app } = await startHarness({ win, chartHandlers });

    const result = await callTool(client, 'ui_open_panel', { panel: 'alerts' });

    expect(errorOf(result)).toMatchObject({
      code: 'TIMEOUT',
      details: { panel: 'alerts', open: true },
    });
    // One click, and no second one.
    expect(pressesOf(app)).toEqual([ALERTS_BUTTON]);
  });

  test('ui_open_panel reports TIMEOUT for a panel that does not close, or a panel of the object tree that does not open', async () => {
    const closing = withToolbar({ shown: 'alerts', inert: true });
    const opening = withToolbar({ inert: true });
    const first = await startHarness({ win: closing.win, chartHandlers: closing.chartHandlers });
    const second = await startHarness({ win: opening.win, chartHandlers: opening.chartHandlers });

    const closed = await callTool(first.client, 'ui_open_panel', { panel: 'alerts', open: false });
    const tree = await callTool(second.client, 'ui_open_panel', { panel: 'object_tree' });

    expect(errorOf(closed)).toMatchObject({
      code: 'TIMEOUT',
      message: expect.stringMatching(/^The alerts did not close within/) as string,
    });
    expect(errorOf(tree)).toMatchObject({
      code: 'TIMEOUT',
      message: expect.stringMatching(/^The object tree did not open within/) as string,
    });
    expect(pressesOf(second.app)).toEqual([OBJECT_TREE_BUTTON]);
  });

  test('ui_open_panel opens the data window with one click when its panel remembers it', async () => {
    const { win, toolbar, chartHandlers } = withToolbar({ dataWindow: true });
    const { client, app } = await startHarness({ win, chartHandlers });

    const result = await callTool(client, 'ui_open_panel', { panel: 'data_window' });

    expect(dataOf(result)).toEqual({ panel: 'data_window', open: true, changed: true });
    expect(pressesOf(app)).toEqual([OBJECT_TREE_BUTTON]);
    expect(toolbar.state).toEqual({ shown: 'object_tree', dataWindow: true });
  });

  test('ui_open_panel refuses a data window the open panel has no tab for, before any click', async () => {
    const { win, chartHandlers } = withToolbar({ shown: 'object_tree', withoutTabs: true });
    const { client, app } = await startHarness({ win, chartHandlers });

    const result = await callTool(client, 'ui_open_panel', { panel: 'data_window' });

    expect(errorOf(result)).toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      message: 'The panel of the object tree has no tab for the data window',
    });
    expect(inputCountOf(app)).toBe(0);
  });

  test('ui_open_panel says so when the panel it opened to look for the tab does not collapse again', async () => {
    const toolbar = createFakeRightToolbar({ withoutTabs: true });
    let taken = 0;
    // The page takes the first click only.
    const chartHandlers: Handlers = {
      'Input.dispatchMouseEvent': (params) => {
        const { type, x, y } = params as { type: string; x: number; y: number };
        if (type === 'mouseReleased' && taken === 0) {
          taken += 1;
          toolbar.click(x, y);
        }
        return {};
      },
    };
    const { client } = await startHarness({ win: chartPage([toolbar.element]), chartHandlers });

    const result = await callTool(client, 'ui_open_panel', { panel: 'data_window' });

    expect(errorOf(result)).toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      message:
        'The panel of the object tree has no tab for the data window, and it could not be collapsed again',
    });
    expect(toolbar.state.shown).toBe('object_tree');
  });

  test('ui_open_panel clicks the toolbar through the guard, which refuses a button that a menu covers', async () => {
    // A menu of the overlap root open over the button of the watchlist.
    const menu = fakeElement({
      matches: [SELECTORS.regions.overlapManagerRoot],
      rect: box(0, 0, 0, 0),
      children: [fakeElement({ id: 'menu', rect: box(1200, 40, 80, 100) })],
    });
    const toolbar = createFakeRightToolbar();
    const { client, app } = await startHarness({ win: chartPage([toolbar.element, menu]) });

    const result = await callTool(client, 'ui_open_panel', { panel: 'watchlist' });

    expect(errorOf(result)).toMatchObject({ code: 'NOT_AVAILABLE' });
    expect(errorOf(result)?.message).toMatch(/covered by/);
    expect(inputCountOf(app)).toBe(0);
  });
});

describe('ui_open_panel for the Pine Editor', () => {
  const fixture = loadTvFixture();
  const UNSAVED = '//@version=6\nindicator("Unsaved work")\nplot(open)\n';
  const withEditor = (): TvStateFixture => ({
    ...fixture,
    pineEditor: { ...fixture.pineEditor, open: 'dialog' },
  });

  async function pineHarness(from: TvStateFixture = fixture, overrides: FakeTvOverrides = {}) {
    const win = createFakeTvWindow(from, overrides);
    return { ...(await startHarness({ win })), win };
  }
  const callsOf = (win: FakeTvWindow, name: string) => inspectFakeWindow(win).callsTo(name);
  const editorOf = (win: FakeTvWindow) => inspectFakeWindow(win).state.pineEditor;

  test('ui_open_panel opens the Pine Editor the way its button does', async () => {
    const { client, win } = await pineHarness();

    const opened = await callTool(client, 'ui_open_panel', { panel: 'pine_editor' });
    const again = await callTool(client, 'ui_open_panel', { panel: 'pine_editor' });

    expect(envelopeOf(opened)).toMatchObject({
      ok: true,
      data: { panel: 'pine_editor', open: true, changed: true },
      meta: { via: 'internal' },
    });
    expect(dataOf(again)).toEqual({ panel: 'pine_editor', open: true, changed: false });
    expect(callsOf(win, 'pineEditorApi.open')).toHaveLength(1);
    expect(editorOf(win).placement).toBe('dialog');
  });

  test('ui_open_panel closes the Pine Editor without discarding its text, and changes nothing once it is closed', async () => {
    const { client, win } = await pineHarness(withEditor());
    editorOf(win).source = UNSAVED;

    const closed = await callTool(client, 'ui_open_panel', { panel: 'pine_editor', open: false });
    const again = await callTool(client, 'ui_open_panel', { panel: 'pine_editor', open: false });

    expect(dataOf(closed)).toEqual({ panel: 'pine_editor', open: false, changed: true });
    expect(dataOf(again)).toEqual({ panel: 'pine_editor', open: false, changed: false });
    // The side panel closed through the page layout service, and TradingView kept the text.
    expect(callsOf(win, 'pageLayout.closeSidePanel')).toEqual([['pine']]);
    expect(editorOf(win)).toMatchObject({ placement: null, unsavedKept: true, source: UNSAVED });
    // Nothing else that changes the editor was called.
    expect(
      inspectFakeWindow(win)
        .calls.map(({ name }) => name)
        .filter((name) => name.startsWith('pineFacade.') || name.startsWith('pineEditorApi.')),
    ).toEqual([]);
  });

  test('ui_open_panel hides the Pine Editor at the bottom, which stays registered', async () => {
    const atBottom: TvStateFixture = {
      ...fixture,
      pineEditor: { ...fixture.pineEditor, open: 'bottom', opensAt: 'bottom' },
    };
    const { client, win } = await pineHarness(atBottom);

    const result = await callTool(client, 'ui_open_panel', { panel: 'pine_editor', open: false });

    expect(dataOf(result)).toEqual({ panel: 'pine_editor', open: false, changed: true });
    expect(callsOf(win, 'bottomWidgetBar.close')).toEqual([[]]);
  });

  test('ui_open_panel reports TIMEOUT when the side panel of the Pine Editor does not close', async () => {
    const { client, win } = await pineHarness(withEditor(), { pineEditorCloseIgnored: true });

    const result = await callTool(client, 'ui_open_panel', { panel: 'pine_editor', open: false });

    expect(errorOf(result)).toMatchObject({
      code: 'TIMEOUT',
      message: 'The Pine Editor did not close',
    });
    expect(callsOf(win, 'pageLayout.closeSidePanel')).toEqual([['pine']]);
  });

  test('ui_open_panel refuses to close the Pine Editor where the close path is missing', async () => {
    const { client, win } = await pineHarness(withEditor(), { withoutPageLayoutService: true });

    const result = await callTool(client, 'ui_open_panel', { panel: 'pine_editor', open: false });

    expect(errorOf(result)).toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      hint: 'Close the Pine Editor in TradingView itself.',
    });
    expect(editorOf(win).placement).toBe('dialog');
  });
});

describe('ui_fullscreen', () => {
  const fixture = loadTvFixture();

  async function fullscreenHarness(overrides: FakeTvOverrides = {}) {
    const win = createFakeTvWindow(fixture, overrides);
    return { ...(await startHarness({ win })), win };
  }
  const callsOf = (win: FakeTvWindow, name: string) => inspectFakeWindow(win).callsTo(name);

  test('ui_fullscreen calls startFullscreen and reports observed null with a warning when the state cannot be read', async () => {
    const { client, win } = await fullscreenHarness({ fullscreen: { unreadable: true } });

    const result = await callTool(client, 'ui_fullscreen', { enabled: true });

    expect(envelopeOf(result)).toMatchObject({
      ok: true,
      data: { requested: true, observed: null, changed: true },
      meta: { via: 'api' },
    });
    expect(warningsOf(result)).toEqual([
      expect.stringMatching(/did not say whether its fullscreen mode is on/) as string,
    ]);
    expect(callsOf(win, 'TradingViewApi.startFullscreen')).toEqual([[]]);
  });

  test("ui_fullscreen turns TradingView's fullscreen mode on and off, and changes nothing when it already is as asked", async () => {
    const { client, win } = await fullscreenHarness();

    const on = await callTool(client, 'ui_fullscreen', { enabled: true });
    const again = await callTool(client, 'ui_fullscreen', { enabled: true });
    const off = await callTool(client, 'ui_fullscreen', { enabled: false });

    expect(dataOf(on)).toEqual({ requested: true, observed: true, changed: true });
    expect(dataOf(again)).toEqual({ requested: true, observed: true, changed: false });
    expect(dataOf(off)).toEqual({ requested: false, observed: false, changed: true });
    for (const result of [on, again, off]) {
      expect(warningsOf(result)).toEqual([]);
    }
    expect(callsOf(win, 'TradingViewApi.startFullscreen')).toHaveLength(1);
    expect(callsOf(win, 'TradingViewApi.exitFullscreen')).toHaveLength(1);
    expect(inspectFakeWindow(win).state.fullscreen.on).toBe(false);
  });

  test('ui_fullscreen warns when TradingView does not report the mode it was asked for', async () => {
    const { client, win } = await fullscreenHarness();
    // A start that does not take, as on a chart that cannot fill the tab.
    const api = win.TradingViewApi;
    if (api !== undefined) {
      api.startFullscreen = () => undefined;
    }

    const result = await callTool(client, 'ui_fullscreen', { enabled: true });

    expect(dataOf(result)).toEqual({ requested: true, observed: false, changed: true });
    expect(warningsOf(result)).toEqual([
      expect.stringMatching(/still reports its fullscreen mode off/) as string,
    ]);
  });

  test('ui_fullscreen warns when TradingView stays in its fullscreen mode after it was asked to leave it', async () => {
    const { client, win } = await fullscreenHarness({ fullscreen: { on: true } });
    const api = win.TradingViewApi;
    if (api !== undefined) {
      api.exitFullscreen = () => undefined;
    }

    const result = await callTool(client, 'ui_fullscreen', { enabled: false });

    expect(dataOf(result)).toEqual({ requested: false, observed: true, changed: true });
    expect(warningsOf(result)).toEqual([
      expect.stringMatching(/still reports its fullscreen mode on .* to turn it off\.$/) as string,
    ]);
  });

  test('ui_fullscreen says CAPABILITY_UNAVAILABLE on a page without the calls, and calls nothing', async () => {
    const { client, win } = await fullscreenHarness({ fullscreen: { withoutCalls: true } });

    const result = await callTool(client, 'ui_fullscreen', { enabled: true });

    expect(errorOf(result)).toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });
});

describe('ui_evaluate', () => {
  const ALLOW_EVAL: Partial<Config> = { allowEval: true };
  const evaluatesOf = (app: FakeCdpServer, targetId = CHART_ID) =>
    app.calls.filter((call) => call.targetId === targetId && call.method === 'Runtime.evaluate');

  test('ui_evaluate is refused with CAPABILITY_UNAVAILABLE unless TV_MCP_ALLOW_EVAL is true', async () => {
    const { client, app } = await startHarness();

    const result = await callTool(client, 'ui_evaluate', { expression: '1 + 1' });

    expect(errorOf(result)).toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      message: expect.stringMatching(/TV_MCP_ALLOW_EVAL=true/) as string,
    });
    // Not even the chart tab was looked up.
    expect(app.calls).toEqual([]);
  });

  test('ui_evaluate is not registered in the readonly profile', async () => {
    const { client } = await startHarness({ config: { ...ALLOW_EVAL, profile: 'readonly' } });

    const { tools } = await client.listTools();
    const names = tools.map(({ name }) => name);

    expect(names).not.toContain('ui_evaluate');
    for (const name of ['ui_type_text', 'ui_press_key', 'ui_open_panel', 'ui_fullscreen']) {
      expect(names).not.toContain(name);
    }
    expect(names).toContain('ui_find_element');
  });

  test('ui_evaluate runs in the chart page only, with returnByValue, awaitPromise and the call timeout', async () => {
    const { client, app } = await startHarness({ config: ALLOW_EVAL });

    const sum = await callTool(client, 'ui_evaluate', { expression: '1 + 1' });
    const awaited = await callTool(client, 'ui_evaluate', {
      expression: 'Promise.resolve([document.visibilityState, 3])',
    });

    expect(envelopeOf(sum)).toMatchObject({
      ok: true,
      data: { value: 2, truncated: false },
      meta: { via: 'cdp', warnings: [] },
    });
    expect(dataOf(awaited)).toEqual({ value: ['visible', 3], truncated: false });
    const evaluated = evaluatesOf(app);
    expect(evaluated).toHaveLength(2);
    for (const { params } of evaluated) {
      // The page stops the expression once the call would give up on it.
      expect(params).toMatchObject({ returnByValue: true, awaitPromise: true, timeout: 5000 });
    }
    // The window chrome has Node integration: nothing is evaluated there.
    expect(app.calls.filter(({ targetId }) => targetId === CHROME_ID)).toEqual([]);
  });

  test.each([
    ['tvd', 'TVD.getCredentials()'],
    ['tvd', "window [ 'TVD' ]"],
    ['identity', 'window.user'],
    ['identity', "window['user']"],
    ['identity', 'window [ "us" + "er" ].username'],
    ['cookies', 'document.cookie'],
    ['cookies', "document['coo' + 'kie']"],
    ['storage', 'localStorage.getItem("x")'],
    ['storage', "window['indexedDB']"],
    ['credentials', 'signIn()'],
    ['network', "fetch('/x')"],
    ['node', "require('fs')"],
  ])(
    'ui_evaluate refuses expressions that reach TVD credentials, window.user, cookies, storage or indexedDB: %s in %s',
    async (category, expression) => {
      const { client, app } = await startHarness({ config: ALLOW_EVAL });

      const result = await callTool(client, 'ui_evaluate', { expression });

      expect(errorOf(result)).toMatchObject({
        code: 'UNSAFE_ACTION_BLOCKED',
        details: { category },
      });
      // The refusal names the category, not what matched.
      expect(errorOf(result)?.message).not.toContain(expression);
      expect(app.calls).toEqual([]);
    },
  );

  test('ui_evaluate returns JSON-safe values and truncates beyond 100 kB', async () => {
    const save = fakeElement({
      tag: 'button',
      id: 'header-toolbar-save-load',
      matches: ['#save'],
      rect: box(100, 50, 40, 20),
    });
    // What Object.prototype.toString names a button of a page by, which the fake does not give.
    Object.defineProperty(save, Symbol.toStringTag, { value: 'HTMLButtonElement' });
    const { client } = await startHarness({ config: ALLOW_EVAL, win: chartPage([save]) });

    const shapes = await callTool(client, 'ui_evaluate', {
      expression:
        '({ missing: undefined, list: [undefined, NaN, 1], fn() {}, node: document.querySelector("#save"), when: new Date(0), self: window })',
    });
    const big = await callTool(client, 'ui_evaluate', { expression: "'x'.repeat(300000)" });
    const many = await callTool(client, 'ui_evaluate', {
      expression: 'Array.from({ length: 100000 }, (_, i) => i)',
    });

    expect(dataOf(shapes)).toEqual({
      value: {
        missing: null,
        list: [null, null, 1],
        fn: '[object Function]',
        node: '[object HTMLButtonElement]',
        when: '1970-01-01T00:00:00.000Z',
        self: '[object Window]',
      },
      truncated: false,
    });
    for (const result of [big, many]) {
      const data = dataOf(result) as { value: JsonValue; truncated: boolean };
      expect(data.truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(data.value))).toBeLessThanOrEqual(100_000);
      expect(Buffer.byteLength(JSON.stringify(data.value))).toBeGreaterThan(90_000);
      expect(warningsOf(result)).toEqual([expect.stringMatching(/100 kB/) as string]);
    }
    expect((dataOf(many) as { value: number[] }).value.slice(0, 3)).toEqual([0, 1, 2]);
  });

  test('ui_evaluate reports an exception as PAGE_EVALUATION_FAILED with its description and no stack', async () => {
    const { client } = await startHarness({ config: ALLOW_EVAL });

    const thrown = await callTool(client, 'ui_evaluate', {
      expression: 'null.symbol()',
    });
    const rejected = await callTool(client, 'ui_evaluate', {
      expression: 'Promise.reject(new RangeError("out of range"))',
    });
    const invalid = await callTool(client, 'ui_evaluate', { expression: 'let = ;' });

    expect(errorOf(thrown)).toMatchObject({
      code: 'PAGE_EVALUATION_FAILED',
      message: expect.stringMatching(/^The expression threw TypeError: /) as string,
    });
    expect(errorOf(rejected)?.message).toBe('The expression threw RangeError: out of range');
    expect(errorOf(invalid)?.message).toMatch(/^The expression threw SyntaxError: /);
    for (const result of [thrown, rejected, invalid]) {
      expect(JSON.stringify(errorOf(result))).not.toMatch(/\bat <anonymous>|\n\s+at /);
    }
  });

  test('ui_evaluate never returns the user object or the desktop bridge, even under a name built at run time', async () => {
    const win = Object.assign(chartPage(), {
      user: { id: 101, username: 'synthetic-user' },
      TVD: { getCredentials: () => 'synthetic-secret' },
    });
    const { client } = await startHarness({ config: ALLOW_EVAL, win });

    // The names are built from character codes, which no denylist of the text can see.
    const result = await callTool(client, 'ui_evaluate', {
      expression:
        '[String.fromCharCode(117, 115, 101, 114), String.fromCharCode(84, 86, 68)].map((name) => window[name])',
    });

    expect(dataOf(result)).toEqual({ value: ['[withheld]', '[withheld]'], truncated: false });
    expect(JSON.stringify(result)).not.toContain('synthetic-user');
  });

  test('ui_evaluate logs neither the expression nor its value', async () => {
    const { logger, lines } = capturingLogger();
    const { client } = await startHarness({ config: ALLOW_EVAL, logger });

    await callTool(client, 'ui_evaluate', { expression: '"marker-" + "of-the-value"' });
    await callTool(client, 'ui_evaluate', { expression: 'throw new Error("marker-of-a-failure")' });
    await callTool(client, 'ui_evaluate', { expression: 'document.cookie + "marker-refused"' });

    const logged = JSON.stringify(lines);
    for (const marker of ['marker-', 'of-the-value', 'marker-of-a-failure', 'marker-refused']) {
      expect(logged).not.toContain(marker);
    }
  });
});
