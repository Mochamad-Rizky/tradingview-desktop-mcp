import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SELECTORS } from '../../../src/core/tv/selectors.js';
import { createMcpServer } from '../../../src/server.js';
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
import { callTool, connectInMemoryClient } from '../../helpers/mcp-client.js';
import { quietLogger, refusingLauncher, testConfig } from '../../helpers/tool-context.js';

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
  win?: FakeDomWindow;
  chrome?: FakeDomWindow;
  // Answers of the chart tab for single CDP commands: the page reacting to input.
  chartHandlers?: Handlers;
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
  const config = testConfig({ cdpPort: app.port, callTimeoutMs: 5000 });
  const { server, ctx } = createMcpServer(config, {
    launcher: refusingLauncher(),
    logger: quietLogger,
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
      message: 'Refusing to click at (320, 260): a broker trading control lies there',
      hint: expect.stringMatching(/Trading controls are off limits/) as string,
      details: { x: 320, y: 260 },
    });
    expect(errorOf(onButton)).toMatchObject({ code: 'UNSAFE_ACTION_BLOCKED' });
    // No mouse press, and not even a move: the looks at the point are all the page saw.
    expect(mouseOf(app).filter(({ type }) => type === 'mousePressed')).toEqual([]);
    expect(methodsOf(app)).toEqual(['Runtime.evaluate', 'Runtime.evaluate']);
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
    const win = chartPage([
      field({
        tag: 'input',
        attributes: { type: 'password', 'aria-label': 'Password' },
        rect: box(10, 600, 100, 20),
      }),
      field({ tag: 'textarea', text: 'a secret note', rect: box(10, 630, 100, 40) }),
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
      { tag: 'textarea', name: '', text: '' },
    ]);
    expect(JSON.stringify(result)).not.toContain('secret');
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

    const calls = app.calls.filter(({ targetId }) => targetId === CHROME_ID);
    // The renderer of the window chrome has Node integration: what runs there is the source of the
    // page functions that read elements, and nothing else.
    expect(new Set(calls.map(({ method }) => method))).toEqual(
      new Set(['Runtime.evaluate', 'Page.getLayoutMetrics', 'Input.dispatchMouseEvent']),
    );
    for (const { method, params } of calls) {
      if (method === 'Runtime.evaluate') {
        expect((params as { expression: string }).expression).toMatch(
          /function (describeElement|findElements)\(/,
        );
      }
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
