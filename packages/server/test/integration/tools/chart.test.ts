import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SELECTORS } from '../../../src/core/tv/selectors.js';
import { createMcpServer } from '../../../src/server.js';
import { chartTools } from '../../../src/tools/chart/index.js';
import { CDP_ERROR } from '../../helpers/fake-cdp/protocol.js';
import {
  FakeCdpError,
  startFakeCdpServer,
  type FakeCdpServer,
} from '../../helpers/fake-cdp/server.js';
import { loadTargetsFixture } from '../../helpers/fake-cdp/targets.js';
import {
  createFakeDomWindow,
  fakeElement,
  type FakeDomWindow,
  type FakeElement,
  type FakeRect,
} from '../../helpers/fake-tv/dom.js';
import { loadTvFixture } from '../../helpers/fake-tv/fixture.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTvWindow,
} from '../../helpers/fake-tv/window.js';
import { callTool, connectInMemoryClient, textOf } from '../../helpers/mcp-client.js';
import {
  quietLogger,
  refusingLauncher,
  testConfig,
  unreachableConnection,
} from '../../helpers/tool-context.js';

// The chart tools through the whole server: an SDK client over the in-memory transport, the real
// registry, connection manager, discovery and CDP adapter, and the fake debug port of the app with
// a fake chart behind it. Where a test needs the page to answer input the way TradingView does,
// the fake debug port answers the input events with a script of the page.

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

const fixture = loadTvFixture();
const CHART_ID = 'BBB144A7827AE55CBA0E74986FC9574C';
const STATE_URI = 'tradingview://chart/state';
const DAY = 86_400;
const barTime = (index: number): number => fixture.bars.startTime + index * DAY;
const LAST = fixture.bars.count - 1;

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

type Handlers = Record<string, (params: unknown) => unknown>;

interface Harness {
  client: Client;
  app: FakeCdpServer;
}

interface HarnessOptions {
  // The window of the chart tab. By default a booted chart.
  win?: object;
  // Answers of the chart tab for single CDP commands: the page reacting to input.
  handlers?: Handlers;
  callTimeoutMs?: number;
}

// The real server over the real adapters, against a fake debug port.
async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const win = options.win ?? createFakeTvWindow(fixture);
  const targets = loadTargetsFixture({ chartWindow: () => win });
  const chartTarget = targets.find(({ id }) => id === CHART_ID);
  if (chartTarget !== undefined && options.handlers !== undefined) {
    chartTarget.handlers = options.handlers;
  }
  const app = await startFakeCdpServer({ targets });
  cleanups.push(() => app.close());
  const config = testConfig({ cdpPort: app.port, callTimeoutMs: options.callTimeoutMs ?? 5000 });
  const { server, ctx } = createMcpServer(config, {
    launcher: refusingLauncher(),
    logger: quietLogger,
  });
  cleanups.push(() => ctx.connection.close());
  return { client: await connect(server), app };
}

async function startOffline(): Promise<Client> {
  const { server } = createMcpServer(testConfig(), {
    connection: unreachableConnection(),
    launcher: refusingLauncher(),
    logger: quietLogger,
  });
  return connect(server);
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
const viaOf = (result: { structuredContent?: unknown }) => envelopeOf(result).meta.via;
const warningsOf = (result: { structuredContent?: unknown }) => envelopeOf(result).meta.warnings;

// The input events that reached the chart tab, which is everything a strategy of the interface
// does to the page.
function inputOf(app: FakeCdpServer): { method: string; params: unknown }[] {
  return app.calls
    .filter(({ method }) => method.startsWith('Input.'))
    .map(({ method, params }) => ({ method, params }));
}

function chartOf(win: FakeTvWindow) {
  const api = win.TradingViewApi;
  if (api === undefined) {
    throw new Error('The fake window has no TradingViewApi');
  }
  return { api, chart: api.activeChart() };
}

function box(x: number, y: number, width: number, height: number): FakeRect {
  return { x, y, width, height };
}

describe('chart_get_state', () => {
  test('chart_get_state returns the fixture state', async () => {
    const { client } = await startHarness();

    const result = await callTool(client, 'chart_get_state');

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toStrictEqual({
      ok: true,
      data: {
        chartIndex: 0,
        symbol: 'NASDAQ:AAPL',
        resolution: '1D',
        chartType: 1,
        chartTypeName: 'candles',
        visibleRange: {
          from: 1721433600,
          to: 1729987200,
          fromIso: '2024-07-20T00:00:00Z',
          toIso: '2024-10-27T00:00:00Z',
        },
        studies: [
          { id: 'STUDY01', name: 'Moving Average' },
          { id: 'STUDY02', name: 'Relative Strength Index' },
        ],
        drawingCount: 3,
        layout: {
          type: 's',
          chartsCount: 1,
          activeChartIndex: 0,
          name: 'Fixture Layout',
          id: 'FIXTURE1',
        },
      },
      meta: { via: 'api', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(JSON.parse(textOf(result))).toStrictEqual(result.structuredContent);
  });

  test('chart_get_state only reads, so the page is left as it was', async () => {
    const win = createFakeTvWindow(fixture);
    const { client } = await startHarness({ win });

    await callTool(client, 'chart_get_state', { chartIndex: 0 });

    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('chart_get_state warns about the parts the chart could not report', async () => {
    const win = createFakeTvWindow(fixture);
    const { chart } = chartOf(win);
    Object.assign(chart, {
      getVisibleRange: () => ({ from: Number.NaN, to: Number.NaN }),
      getAllStudies: () => {
        throw new Error('Not ready');
      },
    });
    const { client } = await startHarness({ win });

    const result = await callTool(client, 'chart_get_state');

    expect(dataOf(result)).toMatchObject({
      symbol: 'NASDAQ:AAPL',
      visibleRange: null,
      studies: null,
      drawingCount: 3,
    });
    expect(warningsOf(result)).toEqual([
      expect.stringMatching(/visible range/),
      expect.stringMatching(/studies/),
    ]);
  });

  test('chart_get_state reports no visible range while the chart has no data to show', async () => {
    const win = createFakeTvWindow(fixture);
    inspectFakeWindow(win).state.symbolInvalid = true;
    const { client } = await startHarness({ win });

    const result = await callTool(client, 'chart_get_state');

    expect(dataOf(result)).toMatchObject({ visibleRange: null });
    expect(warningsOf(result)).toEqual([expect.stringMatching(/visible range/)]);
  });

  test('chart_get_state warns when the chart does not report its drawings', async () => {
    const win = createFakeTvWindow(fixture);
    Object.assign(chartOf(win).chart, { getAllShapes: () => undefined });
    const { client } = await startHarness({ win });

    const result = await callTool(client, 'chart_get_state');

    expect(dataOf(result)).toMatchObject({ drawingCount: null, studies: [{ id: 'STUDY01' }, {}] });
    expect(warningsOf(result)).toEqual([expect.stringMatching(/drawings/)]);
  });

  test('chart_get_state refuses a chartIndex beyond the charts of the layout and lists the valid ones', async () => {
    const { client } = await startHarness();

    const result = await callTool(client, 'chart_get_state', { chartIndex: 1 });

    expect(result.isError).toBe(true);
    expect(errorOf(result)).toStrictEqual({
      code: 'INVALID_INPUT',
      message: 'chartIndex 1 is out of range: the layout has 1 chart, so chartIndex must be 0',
      hint: expect.stringMatching(/Leave chartIndex out/) as string,
      details: { chartIndex: 1, chartsCount: 1 },
    });
  });

  test('chart_get_state lists the range of chart indices of a multi-chart layout', async () => {
    const win = createFakeTvWindow(fixture);
    const { api } = chartOf(win);
    win.TradingViewApi = { ...api, chartsCount: () => 4 };
    const { client } = await startHarness({ win });

    const result = await callTool(client, 'chart_get_state', { chartIndex: 4 });

    expect(errorOf(result)).toMatchObject({
      code: 'INVALID_INPUT',
      message:
        'chartIndex 4 is out of range: the layout has 4 charts, so chartIndex must be from 0 to 3',
      details: { chartIndex: 4, chartsCount: 4 },
    });
  });

  test('chart_get_state says that the layout did not report its charts', async () => {
    const win = createFakeTvWindow(fixture);
    const { api } = chartOf(win);
    win.TradingViewApi = { ...api, chartsCount: () => 0 };
    const { client } = await startHarness({ win });

    const result = await callTool(client, 'chart_get_state', { chartIndex: 0 });

    expect(errorOf(result)).toMatchObject({ code: 'NOT_AVAILABLE' });
  });

  test('chart_get_state is unavailable on a page whose app has not booted', async () => {
    const { client } = await startHarness({
      win: createFakeTvWindow(fixture, { withoutApi: true }),
    });

    const result = await callTool(client, 'chart_get_state');

    expect(errorOf(result)).toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      hint: expect.stringMatching(/app_health/) as string,
    });
  });

  test('chart_get_state fails with CDP_UNREACHABLE when TradingView is down', async () => {
    const client = await startOffline();

    const result = await callTool(client, 'chart_get_state');

    expect(errorOf(result)).toMatchObject({ code: 'CDP_UNREACHABLE' });
  });
});

describe('chart_set_symbol through the chart API', () => {
  test('chart_set_symbol switches symbol via api', async () => {
    const win = createFakeTvWindow(fixture);
    const { client, app } = await startHarness({ win });

    const result = await callTool(client, 'chart_set_symbol', { symbol: 'NASDAQ:MSFT' });

    expect(result.structuredContent).toStrictEqual({
      ok: true,
      data: { symbol: 'NASDAQ:MSFT', previous: 'NASDAQ:AAPL', changed: true },
      meta: { via: 'api', durationMs: expect.any(Number) as number, warnings: [] },
    });
    const inspector = inspectFakeWindow(win);
    expect(inspector.callsTo('chart.setSymbol').map(([symbol]) => symbol)).toEqual(['NASDAQ:MSFT']);
    expect(inspector.state.symbol).toBe('NASDAQ:MSFT');
    expect(inputOf(app)).toEqual([]);
  });

  test('chart_set_symbol rejects an unknown symbol', async () => {
    const win = createFakeTvWindow(fixture);
    const { client, app } = await startHarness({ win });

    const result = await callTool(client, 'chart_set_symbol', { symbol: 'NASDAQ:NOPE' });

    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error).toMatchObject({
      code: 'INVALID_INPUT',
      message: 'Unknown symbol NASDAQ:NOPE',
      hint: expect.stringContaining('NASDAQ:AAPL') as string,
    });
    expect(error?.details).toStrictEqual({ requested: 'NASDAQ:NOPE', kept: 'NASDAQ:AAPL' });
    // Found out from the series at once, not by waiting for data that never comes.
    expect(envelopeOf(result).meta.durationMs).toBeLessThan(3000);
    // The chart was switched back, and nothing else was tried.
    const inspector = inspectFakeWindow(win);
    expect(inspector.callsTo('chart.setSymbol').map(([symbol]) => symbol)).toEqual([
      'NASDAQ:NOPE',
      'NASDAQ:AAPL',
    ]);
    expect(inspector.state.symbol).toBe('NASDAQ:AAPL');
    expect(inspector.state.symbolInvalid).toBe(false);
    expect(inputOf(app)).toEqual([]);
  });

  test('chart_set_symbol says so when switching back after an unknown symbol fails too', async () => {
    const win = createFakeTvWindow(fixture);
    const { chart } = chartOf(win);
    const original = chart.setSymbol.bind(chart);
    let calls = 0;
    Object.assign(chart, {
      setSymbol: (symbol: string, options?: { dataReady?: () => void }) => {
        calls += 1;
        if (calls > 1) {
          throw new Error('The data connection dropped');
        }
        return original(symbol, options);
      },
    });
    const { client } = await startHarness({ win });

    const result = await callTool(client, 'chart_set_symbol', { symbol: 'NASDAQ:NOPE' });

    const error = errorOf(result);
    expect(error).toMatchObject({ code: 'INVALID_INPUT', message: 'Unknown symbol NASDAQ:NOPE' });
    expect(error?.details).toStrictEqual({
      requested: 'NASDAQ:NOPE',
      kept: null,
      previous: 'NASDAQ:AAPL',
      revertFailed: true,
      revertError: 'PAGE_EVALUATION_FAILED',
    });
    expect(error?.hint).toMatch(/may still show NASDAQ:NOPE/);
    expect(error?.hint).toMatch(/chart_set_symbol with NASDAQ:AAPL/);
  });

  test('chart_set_symbol warns when the chart API settles on another symbol than the one asked for', async () => {
    const win = createFakeTvWindow(fixture);
    const { chart } = chartOf(win);
    const original = chart.setSymbol.bind(chart);
    Object.assign(chart, {
      setSymbol: (_symbol: string, options?: { dataReady?: () => void }) =>
        original('NYSE:IBM', options),
    });
    const { client } = await startHarness({ win });

    const result = await callTool(client, 'chart_set_symbol', { symbol: 'NASDAQ:MSFT' });

    expect(viaOf(result)).toBe('api');
    expect(dataOf(result)).toMatchObject({ symbol: 'NYSE:IBM', changed: true });
    expect(warningsOf(result)).toEqual([
      expect.stringMatching(/shows NYSE:IBM instead of NASDAQ:MSFT/),
    ]);
  });

  test('chart_set_symbol leaves the chart alone when it shows the symbol already', async () => {
    const win = createFakeTvWindow(fixture);
    const { client } = await startHarness({ win });

    const result = await callTool(client, 'chart_set_symbol', { symbol: 'NASDAQ:AAPL' });

    expect(dataOf(result)).toStrictEqual({
      symbol: 'NASDAQ:AAPL',
      previous: 'NASDAQ:AAPL',
      changed: false,
    });
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('chart_set_symbol trims the symbol and refuses one that is blank', async () => {
    const win = createFakeTvWindow(fixture);
    const { client, app } = await startHarness({ win });

    const trimmed = await callTool(client, 'chart_set_symbol', { symbol: '  NASDAQ:MSFT ' });
    const blank = await callTool(client, 'chart_set_symbol', { symbol: '   ' });

    expect(dataOf(trimmed)).toMatchObject({ symbol: 'NASDAQ:MSFT' });
    expect(errorOf(blank)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(app.connectionCount()).toBe(1);
  });

  test('chart_set_symbol times out without trying another way when the data never comes', async () => {
    const win = createFakeTvWindow(fixture);
    Object.assign(chartOf(win).chart, { setSymbol: () => Promise.resolve(true) });
    const { client, app } = await startHarness({ win, callTimeoutMs: 1000 });

    const result = await callTool(client, 'chart_set_symbol', { symbol: 'NASDAQ:SLOW' });

    expect(errorOf(result)).toMatchObject({
      code: 'TIMEOUT',
      details: { requested: 'NASDAQ:SLOW', previous: 'NASDAQ:AAPL' },
    });
    expect(inputOf(app)).toEqual([]);
  });

  test('chart_set_symbol switches the chart at chartIndex', async () => {
    const win = createFakeTvWindow(fixture);
    const { client } = await startHarness({ win });

    const result = await callTool(client, 'chart_set_symbol', {
      symbol: 'NYSE:IBM',
      chartIndex: 0,
    });

    expect(dataOf(result)).toMatchObject({ symbol: 'NYSE:IBM', changed: true });
  });

  test('chart_set_symbol refuses a chartIndex beyond the charts of the layout before it acts', async () => {
    const win = createFakeTvWindow(fixture);
    const { client } = await startHarness({ win });

    const result = await callTool(client, 'chart_set_symbol', {
      symbol: 'NYSE:IBM',
      chartIndex: 2,
    });

    expect(errorOf(result)).toMatchObject({
      code: 'INVALID_INPUT',
      details: { chartIndex: 2, chartsCount: 1 },
    });
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });
});

// A chart tab with a DOM and a chart API, whose page answers input the way TradingView does: the
// symbol search button opens a dialog with a focused text field, a letter typed on the chart opens
// the same dialog and a digit the dialog of intervals, Enter applies what the field holds, the
// interval buttons and the date range presets change the chart at once.
interface ChartUiOptions {
  searchButton?: boolean;
  intervalButtons?: string[];
  presets?: string[];
  // Whether a click on the symbol search button opens its dialog. Default true.
  opensOnClick?: boolean;
  // What Enter does in a dialog: apply what was typed (the default), nothing, or flag the symbol
  // as unknown while the chart keeps showing the one it had.
  enter?: 'applies' | 'ignored' | 'flags-unknown';
  // Whether the interval buttons and the presets change the chart. Default true.
  buttonsApply?: boolean;
  // Whether the page loses its chart API once an input has taken effect, as a page that reloads.
  dropsApi?: boolean;
  // How the symbol search button can be out of reach: under a dialog, inside a trading control
  // (the buy and sell buttons), or off the visible part of the page.
  searchButtonIs?: 'covered' | 'in-trading-control' | 'off-screen';
  // A page that cannot say what lies at a point.
  withoutHitTest?: boolean;
  // An input event the page does not know, as a CDP method it answers with "not found": the text,
  // or the press of the mouse button halfway through a click.
  failsOn?: 'insertText' | 'mousePressed';
  // What Enter in the symbol search applies for a typed text, when it is not the text itself: the
  // highlighted result of the search.
  enterApplies?: Record<string, string>;
  // How long after an unknown symbol is applied the series flags it. By default at once.
  flagLagMs?: number;
  // Whether the series resolves a symbol it knows, so that its symbol info names it. Default true.
  resolvesSymbols?: boolean;
  // Where the focus goes once Enter has closed a dialog: back where it was (the default), or into
  // a text field outside any dialog.
  focusAfterEnter?: 'outside-field';
  // The chart API of the page: complete, without the members named, or none at all.
  api?: 'complete' | 'none' | { without: string[]; chartsCount?: number };
  // A text field outside any dialog that has the focus at the start.
  focusedField?: boolean;
}

interface ChartUi {
  win: object;
  tv: FakeTvWindow;
  handlers: Handlers;
  // What the text field of the open dialog holds.
  typed(): string;
}

const PRESET_RANGE = { from: barTime(209), to: barTime(LAST) };

function chartUi(options: ChartUiOptions = {}): ChartUi {
  const tv = createFakeTvWindow(fixture);
  const state = inspectFakeWindow(tv).state;
  const field = fakeElement({
    tag: 'input',
    attributes: { type: 'text' },
    rect: box(300, 200, 200, 30),
  });
  const elements: FakeElement[] = [
    fakeElement({
      tag: 'canvas',
      matches: [SELECTORS.regions.paneCanvas],
      rect: box(0, 100, 800, 400),
    }),
  ];
  if (options.searchButton === true) {
    const button = fakeElement({
      tag: 'button',
      matches: [SELECTORS.header.symbolSearch],
      rect: options.searchButtonIs === 'off-screen' ? box(10, -100, 80, 30) : box(10, 10, 80, 30),
    });
    elements.push(
      options.searchButtonIs === 'in-trading-control'
        ? fakeElement({
            matches: ['[data-name="buy-sell-buttons"]'],
            rect: box(0, 0, 400, 60),
            children: [button],
          })
        : button,
    );
  }
  for (const [position, resolution] of (options.intervalButtons ?? []).entries()) {
    elements.push(
      fakeElement({
        tag: 'button',
        matches: [`${SELECTORS.header.intervals} [data-value="${resolution}"]`],
        attributes: { 'data-value': resolution },
        rect: box(100 + position * 40, 10, 36, 30),
      }),
    );
  }
  const presetSelectors: Record<string, string> = SELECTORS.buttons.dateRange;
  for (const [position, preset] of (options.presets ?? []).entries()) {
    const selector = presetSelectors[preset];
    if (selector !== undefined) {
      elements.push(
        fakeElement({
          tag: 'button',
          matches: [selector],
          rect: box(10 + position * 40, 520, 36, 24),
        }),
      );
    }
  }
  const outsideField = fakeElement({
    tag: 'input',
    attributes: { type: 'search' },
    rect: box(600, 10, 100, 30),
  });
  if (options.focusedField === true || options.focusAfterEnter === 'outside-field') {
    elements.push(outsideField);
  }
  // A dialog of the portal, open over the header toolbar.
  const cover = fakeElement({ attributes: { role: 'dialog' }, rect: box(0, 0, 200, 60) });
  elements.push(
    fakeElement({
      matches: [SELECTORS.regions.overlapManagerRoot],
      rect: box(0, 0, 0, 0),
      children: options.searchButtonIs === 'covered' ? [field, cover] : [field],
    }),
  );

  const page = createFakeDomWindow(elements, {
    ...(options.focusedField === true ? { focus: outsideField } : {}),
    ...(options.withoutHitTest === true ? { without: ['elementFromPoint'] as const } : {}),
    ...(options.searchButtonIs === 'off-screen' ? { viewport: { width: 1200, height: 800 } } : {}),
  }) as unknown as FakeDomWindow;
  const resting = page.document.activeElement ?? null;
  // The symbol the series has resolved, which its symbol info names: it follows a symbol the app
  // knows, and stays on the last one it found for a symbol it does not.
  let resolved = fixture.symbol;
  Object.assign(chartOf(tv).chart._chartWidget.model().mainSeries(), {
    symbolInfo: () => ({ ...fixture.symbolInfo, pro_name: resolved, full_name: resolved }),
  });
  let dialog: 'symbol' | 'interval' | null = null;
  let typed = '';
  const open = (kind: 'symbol' | 'interval', text: string): void => {
    dialog = kind;
    typed = text;
    page.document.activeElement = field;
  };
  const tookEffect = (): void => {
    if (options.dropsApi === true) {
      Reflect.deleteProperty(page, 'TradingViewApi');
    }
  };

  const api = options.api ?? 'complete';
  if (api !== 'none') {
    const { api: complete } = chartOf(tv);
    if (api === 'complete') {
      Object.assign(page, { TradingViewApi: complete });
    } else {
      const reduced: Record<string, unknown> = { ...complete.activeChart() };
      for (const name of api.without) {
        Reflect.deleteProperty(reduced, name);
      }
      Object.assign(page, {
        TradingViewApi: {
          ...complete,
          activeChart: () => reduced,
          chart: () => reduced,
          chartsCount: () => api.chartsCount ?? 1,
        },
      });
    }
  }

  const handlers: Handlers = {
    'Input.dispatchMouseEvent': (params) => {
      const { type, x, y } = params as { type: string; x: number; y: number };
      if (type === 'mousePressed' && options.failsOn === 'mousePressed') {
        throw new FakeCdpError(CDP_ERROR.methodNotFound, "'Input.dispatchMouseEvent' wasn't found");
      }
      if (type !== 'mouseReleased') {
        return {};
      }
      const hit = page.document.elementFromPoint?.(x, y) ?? null;
      if (hit === null) {
        return {};
      }
      if (hit.matches(SELECTORS.header.symbolSearch) && options.opensOnClick !== false) {
        open('symbol', '');
      }
      if (options.buttonsApply === false) {
        return {};
      }
      const value = hit.getAttribute('data-value');
      if (value !== null) {
        state.resolution = value;
        tookEffect();
      }
      if (Object.values(SELECTORS.buttons.dateRange).some((selector) => hit.matches(selector))) {
        state.visibleRange = { ...PRESET_RANGE };
        state.resolution = '60';
        tookEffect();
      }
      return {};
    },
    'Input.insertText': (params) => {
      if (options.failsOn === 'insertText') {
        throw new FakeCdpError(CDP_ERROR.methodNotFound, "'Input.insertText' wasn't found");
      }
      if (page.document.activeElement === field) {
        typed += (params as { text: string }).text;
      }
      return {};
    },
    'Input.dispatchKeyEvent': (params) => {
      const { type, key, text } = params as { type: string; key: string; text?: string };
      if (type !== 'keyDown' && type !== 'rawKeyDown') {
        return {};
      }
      if (page.document.activeElement !== field) {
        if (text !== undefined && /^[A-Za-z]$/.test(text)) {
          open('symbol', text);
        } else if (text !== undefined && /^\d$/.test(text)) {
          open('interval', text);
        }
        return {};
      }
      const enter = options.enter ?? 'applies';
      if (key === 'Enter' && enter !== 'ignored') {
        if (enter === 'flags-unknown') {
          state.symbolInvalid = true;
        } else if (dialog === 'symbol') {
          const applied = options.enterApplies?.[typed] ?? typed;
          state.symbol = applied;
          if (fixture.knownSymbols.includes(applied)) {
            state.symbolInvalid = false;
            if (options.resolvesSymbols !== false) {
              resolved = applied;
            }
          } else if (options.flagLagMs === undefined) {
            state.symbolInvalid = true;
          } else {
            state.symbolInvalid = false;
            setTimeout(() => {
              state.symbolInvalid = true;
            }, options.flagLagMs);
          }
        } else if (dialog === 'interval') {
          state.resolution = typed;
        }
        dialog = null;
        page.document.activeElement =
          options.focusAfterEnter === 'outside-field' ? outsideField : resting;
        tookEffect();
      }
      return {};
    },
  };
  return { win: page, tv, handlers, typed: () => typed };
}

async function startUi(ui: ChartUi, callTimeoutMs?: number): Promise<Harness> {
  return startHarness({
    win: ui.win,
    handlers: ui.handlers,
    ...(callTimeoutMs === undefined ? {} : { callTimeoutMs }),
  });
}

const methodsOf = (app: FakeCdpServer): string[] => inputOf(app).map(({ method }) => method);
const keysOf = (app: FakeCdpServer): string[] =>
  inputOf(app)
    .filter(
      ({ method, params }) =>
        method === 'Input.dispatchKeyEvent' && (params as { type: string }).type !== 'keyUp',
    )
    .map(({ params }) => (params as { key: string }).key);
const textsOf = (app: FakeCdpServer): string[] =>
  inputOf(app)
    .filter(({ method }) => method === 'Input.insertText')
    .map(({ params }) => (params as { text: string }).text);

describe('chart_set_symbol through the interface', () => {
  test('chart_set_symbol uses the symbol search dialog when the chart API cannot change the symbol', async () => {
    const ui = chartUi({ searchButton: true, api: { without: ['setSymbol'] } });
    const { client, app } = await startUi(ui);

    const result = await callTool(client, 'chart_set_symbol', { symbol: 'NASDAQ:MSFT' });

    expect(result.structuredContent).toStrictEqual({
      ok: true,
      data: { symbol: 'NASDAQ:MSFT', previous: 'NASDAQ:AAPL', changed: true },
      meta: { via: 'dom', durationMs: expect.any(Number) as number, warnings: [] },
    });
    // A click on the button, the symbol typed into the dialog, and Enter.
    expect(methodsOf(app)).toEqual([
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      'Input.insertText',
      'Input.dispatchKeyEvent',
      'Input.dispatchKeyEvent',
    ]);
    expect(textsOf(app)).toEqual(['NASDAQ:MSFT']);
    expect(keysOf(app)).toEqual(['Enter']);
    expect(inspectFakeWindow(ui.tv).state.symbol).toBe('NASDAQ:MSFT');
  });

  test('chart_set_symbol types the symbol on the chart when there is no symbol search button either', async () => {
    const ui = chartUi({ api: { without: ['setSymbol'] } });
    const { client, app } = await startUi(ui);

    const result = await callTool(client, 'chart_set_symbol', { symbol: 'NASDAQ:MSFT' });

    expect(viaOf(result)).toBe('keyboard');
    expect(dataOf(result)).toStrictEqual({
      symbol: 'NASDAQ:MSFT',
      previous: 'NASDAQ:AAPL',
      changed: true,
    });
    // The first letter opens the dialog, the rest is typed into it, and Enter applies it.
    expect(keysOf(app)).toEqual(['N', 'Enter']);
    expect(textsOf(app)).toEqual(['ASDAQ:MSFT']);
    expect(ui.typed()).toBe('NASDAQ:MSFT');
  });

  test('chart_set_symbol does not type a symbol that starts with a digit, which would open the intervals', async () => {
    const ui = chartUi({ api: { without: ['setSymbol'] } });
    const { client, app } = await startUi(ui);

    const result = await callTool(client, 'chart_set_symbol', { symbol: '7203' });

    expect(errorOf(result)).toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      hint: expect.stringMatching(/app_health/) as string,
      details: { attempts: ['chart api', 'symbol search', 'typing on the chart'] },
    });
    expect(inputOf(app)).toEqual([]);
  });

  test('chart_set_symbol does not type on the chart while a text field has the focus', async () => {
    const ui = chartUi({ api: { without: ['setSymbol'] }, focusedField: true });
    const { client, app } = await startUi(ui);

    const result = await callTool(client, 'chart_set_symbol', { symbol: 'NASDAQ:MSFT' });

    expect(errorOf(result)).toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
    expect(inputOf(app)).toEqual([]);
  });

  test('chart_set_symbol does not use the interface for a chart that is not the active one', async () => {
    const ui = chartUi({ searchButton: true, api: { without: ['setSymbol'], chartsCount: 2 } });
    const { client, app } = await startUi(ui);

    const result = await callTool(client, 'chart_set_symbol', {
      symbol: 'NASDAQ:MSFT',
      chartIndex: 1,
    });

    expect(errorOf(result)).toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
    expect(inputOf(app)).toEqual([]);
  });

  test('chart_set_symbol reports an unknown symbol typed into the dialog, and switches back through the dialog', async () => {
    const ui = chartUi({ searchButton: true, api: { without: ['setSymbol'] } });
    const { client, app } = await startUi(ui);

    const result = await callTool(client, 'chart_set_symbol', { symbol: 'NASDAQ:NOPE' });

    const error = errorOf(result);
    expect(error).toMatchObject({ code: 'INVALID_INPUT', message: 'Unknown symbol NASDAQ:NOPE' });
    expect(error?.details).toStrictEqual({ requested: 'NASDAQ:NOPE', kept: 'NASDAQ:AAPL' });
    expect(textsOf(app)).toEqual(['NASDAQ:NOPE', 'NASDAQ:AAPL']);
    expect(inspectFakeWindow(ui.tv).state.symbol).toBe('NASDAQ:AAPL');
  });

  // The chart shows the new symbol at once, and the series flags it as unknown only after that.
  test.each([
    ['the symbol search', { searchButton: true }, ['NASDAQ:NOPE', 'NASDAQ:AAPL']],
    ['typing on the chart', {}, ['ASDAQ:NOPE', 'ASDAQ:AAPL']],
  ])(
    'chart_set_symbol through %s reports a symbol whose unknown flag comes after the switch, and switches back',
    async (_case, options, texts) => {
      const ui = chartUi({ ...options, flagLagMs: 150, api: { without: ['setSymbol'] } });
      const { client, app } = await startUi(ui);

      const result = await callTool(client, 'chart_set_symbol', { symbol: 'NASDAQ:NOPE' });

      const error = errorOf(result);
      expect(error).toMatchObject({ code: 'INVALID_INPUT', message: 'Unknown symbol NASDAQ:NOPE' });
      expect(error?.details).toStrictEqual({ requested: 'NASDAQ:NOPE', kept: 'NASDAQ:AAPL' });
      expect(textsOf(app)).toEqual(texts);
      const state = inspectFakeWindow(ui.tv).state;
      expect(state.symbol).toBe('NASDAQ:AAPL');
      expect(state.symbolInvalid).toBe(false);
    },
  );

  test('chart_set_symbol says that switching back failed when the interface cannot be used for it', async () => {
    const ui = chartUi({
      searchButton: true,
      focusAfterEnter: 'outside-field',
      api: { without: ['setSymbol'] },
    });
    const { client } = await startUi(ui);

    const result = await callTool(client, 'chart_set_symbol', { symbol: 'NASDAQ:NOPE' });

    expect(errorOf(result)?.details).toStrictEqual({
      requested: 'NASDAQ:NOPE',
      kept: null,
      previous: 'NASDAQ:AAPL',
      revertFailed: true,
      revertError: 'CAPABILITY_UNAVAILABLE',
    });
  });

  test('chart_set_symbol warns when TradingView neither confirms nor flags the new symbol within the wait', async () => {
    const ui = chartUi({
      searchButton: true,
      resolvesSymbols: false,
      api: { without: ['setSymbol'] },
    });
    const { client } = await startUi(ui, 1000);

    const result = await callTool(client, 'chart_set_symbol', { symbol: 'NASDAQ:MSFT' });

    expect(viaOf(result)).toBe('dom');
    expect(dataOf(result)).toStrictEqual({
      symbol: 'NASDAQ:MSFT',
      previous: 'NASDAQ:AAPL',
      changed: true,
    });
    expect(warningsOf(result)).toEqual([expect.stringMatching(/did not confirm/)]);
    // The switch was seen at once, and the new symbol still got at least a second and a half.
    expect(envelopeOf(result).meta.durationMs).toBeGreaterThanOrEqual(1500);
  });

  test('chart_set_symbol times out when the chart keeps its symbol after the dialog', async () => {
    const ui = chartUi({
      searchButton: true,
      enter: 'ignored',
      api: { without: ['setSymbol'] },
    });
    const { client } = await startUi(ui, 1000);

    const result = await callTool(client, 'chart_set_symbol', { symbol: 'NASDAQ:MSFT' });

    expect(errorOf(result)).toMatchObject({
      code: 'TIMEOUT',
      hint: expect.stringMatching(/dialog/) as string,
    });
  });

  test('chart_set_symbol stops when the symbol search dialog does not open, before it types', async () => {
    const ui = chartUi({
      searchButton: true,
      opensOnClick: false,
      api: { without: ['setSymbol'] },
    });
    const { client, app } = await startUi(ui, 1000);

    const result = await callTool(client, 'chart_set_symbol', { symbol: 'NASDAQ:MSFT' });

    expect(errorOf(result)).toMatchObject({ code: 'NOT_AVAILABLE' });
    expect(textsOf(app)).toEqual([]);
    expect(keysOf(app)).toEqual([]);
  });

  test('chart_set_symbol says that it could not check the change on a page without the chart API', async () => {
    const ui = chartUi({ searchButton: true, api: 'none' });
    const { client } = await startUi(ui);

    const result = await callTool(client, 'chart_set_symbol', { symbol: 'NASDAQ:MSFT' });

    expect(viaOf(result)).toBe('dom');
    expect(dataOf(result)).toStrictEqual({ symbol: null, previous: null, changed: null });
    expect(warningsOf(result)).toEqual([expect.stringMatching(/could not be checked/)]);
    expect(ui.typed()).toBe('NASDAQ:MSFT');
  });

  test('chart_set_symbol says that it could not check the change when the chart API goes away', async () => {
    const ui = chartUi({ searchButton: true, dropsApi: true, api: { without: ['setSymbol'] } });
    const { client } = await startUi(ui);

    const result = await callTool(client, 'chart_set_symbol', { symbol: 'NASDAQ:MSFT' });

    expect(viaOf(result)).toBe('dom');
    expect(dataOf(result)).toStrictEqual({ symbol: null, previous: null, changed: null });
    expect(warningsOf(result)).toEqual([expect.stringMatching(/could not be checked/)]);
  });

  test('chart_set_symbol reports a symbol the chart flags as unknown while it keeps the old one', async () => {
    const ui = chartUi({
      searchButton: true,
      enter: 'flags-unknown',
      api: { without: ['setSymbol'] },
    });
    const { client } = await startUi(ui);

    const result = await callTool(client, 'chart_set_symbol', { symbol: 'NASDAQ:NOPE' });

    // The chart never left the old symbol, so switching back had nothing to do.
    expect(errorOf(result)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(errorOf(result)?.details).toStrictEqual({
      requested: 'NASDAQ:NOPE',
      kept: 'NASDAQ:AAPL',
    });
  });

  test('chart_set_symbol leaves the chart alone through the interface when it shows the symbol already', async () => {
    const ui = chartUi({ searchButton: true, api: { without: ['setSymbol'] } });
    const { client, app } = await startUi(ui);

    const result = await callTool(client, 'chart_set_symbol', { symbol: 'nasdaq:aapl' });

    expect(viaOf(result)).toBe('dom');
    expect(dataOf(result)).toStrictEqual({
      symbol: 'NASDAQ:AAPL',
      previous: 'NASDAQ:AAPL',
      changed: false,
    });
    expect(inputOf(app)).toEqual([]);
  });

  test.each([
    ['is covered by a dialog', { searchButtonIs: 'covered' as const }],
    ['is off the visible part of the page', { searchButtonIs: 'off-screen' as const }],
    ['is on a page that cannot say what lies over it', { withoutHitTest: true }],
  ])(
    'chart_set_symbol types on the chart when the symbol search button %s',
    async (_case, options) => {
      const ui = chartUi({ searchButton: true, api: { without: ['setSymbol'] }, ...options });
      const { client, app } = await startUi(ui);

      const result = await callTool(client, 'chart_set_symbol', { symbol: 'NASDAQ:MSFT' });

      // Nothing was clicked: the button was found out of reach before anything was sent.
      expect(viaOf(result)).toBe('keyboard');
      expect(dataOf(result)).toMatchObject({ symbol: 'NASDAQ:MSFT', changed: true });
      expect(methodsOf(app)).not.toContain('Input.dispatchMouseEvent');
      expect(keysOf(app)).toEqual(['N', 'Enter']);
    },
  );

  test('chart_set_symbol stops, without trying another way, when the symbol search button sits in a trading control', async () => {
    const ui = chartUi({
      searchButton: true,
      searchButtonIs: 'in-trading-control',
      api: { without: ['setSymbol'] },
    });
    const { client, app } = await startUi(ui);

    const result = await callTool(client, 'chart_set_symbol', { symbol: 'NASDAQ:MSFT' });

    expect(errorOf(result)).toMatchObject({ code: 'UNSAFE_ACTION_BLOCKED' });
    expect(inputOf(app)).toEqual([]);
  });

  // Once a strategy has sent input, a CDP method that turns out to be missing must end the operation:
  // the next strategy would carry it out a second time.
  test('chart_set_symbol stops, and tries no other way, when the page refuses the text after the click', async () => {
    const ui = chartUi({
      searchButton: true,
      failsOn: 'insertText',
      api: { without: ['setSymbol'] },
    });
    const { client, app } = await startUi(ui);

    const result = await callTool(client, 'chart_set_symbol', { symbol: 'NASDAQ:MSFT' });

    expect(errorOf(result)).toMatchObject({
      code: 'PAGE_EVALUATION_FAILED',
      details: { strategy: 'symbol search', stage: 'type' },
      hint: expect.stringMatching(/chart_get_state/) as string,
    });
    expect(methodsOf(app)).toEqual([
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      'Input.insertText',
    ]);
    // Typing on the chart, the next way, never ran.
    expect(keysOf(app)).toEqual([]);
  });

  test('chart_set_symbol stops when the page refuses the text after the first key typed on the chart', async () => {
    const ui = chartUi({ failsOn: 'insertText', api: { without: ['setSymbol'] } });
    const { client, app } = await startUi(ui);

    const result = await callTool(client, 'chart_set_symbol', { symbol: 'NASDAQ:MSFT' });

    expect(errorOf(result)).toMatchObject({
      code: 'PAGE_EVALUATION_FAILED',
      details: { strategy: 'typing on the chart', stage: 'type' },
    });
    expect(keysOf(app)).toEqual(['N']);
  });

  test('chart_set_symbol warns when Enter applies another search result than the symbol typed', async () => {
    const ui = chartUi({
      searchButton: true,
      enterApplies: { 'NASDAQ:MSFT': 'NYSE:IBM' },
      api: { without: ['setSymbol'] },
    });
    const { client } = await startUi(ui);

    const result = await callTool(client, 'chart_set_symbol', { symbol: 'NASDAQ:MSFT' });

    expect(viaOf(result)).toBe('dom');
    expect(dataOf(result)).toStrictEqual({
      symbol: 'NYSE:IBM',
      previous: 'NASDAQ:AAPL',
      changed: true,
    });
    expect(warningsOf(result)).toEqual([
      expect.stringMatching(/shows NYSE:IBM instead of NASDAQ:MSFT/),
    ]);
  });

  test('chart_set_symbol takes a bare ticker that TradingView qualifies with its exchange as asked for', async () => {
    const ui = chartUi({
      searchButton: true,
      enterApplies: { MSFT: 'NASDAQ:MSFT' },
      api: { without: ['setSymbol'] },
    });
    const { client } = await startUi(ui);

    const result = await callTool(client, 'chart_set_symbol', { symbol: 'MSFT' });

    expect(dataOf(result)).toMatchObject({ symbol: 'NASDAQ:MSFT', changed: true });
    expect(warningsOf(result)).toEqual([]);
  });

  test('chart_set_symbol is unavailable on a page that has neither the setter nor a DOM', async () => {
    const win = createFakeTvWindow(fixture);
    Reflect.deleteProperty(chartOf(win).chart, 'setSymbol');
    const { client, app } = await startHarness({ win });

    const result = await callTool(client, 'chart_set_symbol', { symbol: 'NASDAQ:MSFT' });

    expect(errorOf(result)).toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      details: { attempts: ['chart api', 'symbol search', 'typing on the chart'] },
    });
    expect(inputOf(app)).toEqual([]);
  });
});

describe('chart_set_timeframe', () => {
  test('chart_set_timeframe normalizes 1h to 60', async () => {
    const win = createFakeTvWindow(fixture);
    const { client } = await startHarness({ win });

    const result = await callTool(client, 'chart_set_timeframe', { timeframe: '1h' });

    expect(result.structuredContent).toStrictEqual({
      ok: true,
      data: { resolution: '60', previous: '1D', changed: true },
      meta: { via: 'api', durationMs: expect.any(Number) as number, warnings: [] },
    });
    const inspector = inspectFakeWindow(win);
    expect(inspector.callsTo('chart.setResolution').map(([resolution]) => resolution)).toEqual([
      '60',
    ]);
    expect(inspector.state.resolution).toBe('60');
  });

  test('chart_set_timeframe refuses an unknown timeframe before it looks at TradingView', async () => {
    const { client, app } = await startHarness();

    const result = await callTool(client, 'chart_set_timeframe', { timeframe: '7x' });

    expect(errorOf(result)).toMatchObject({
      code: 'INVALID_INPUT',
      hint: expect.stringContaining('uppercase M is months') as string,
    });
    expect(app.connectionCount()).toBe(0);
  });

  test('chart_set_timeframe leaves the chart alone when it shows the timeframe already', async () => {
    const win = createFakeTvWindow(fixture);
    const { client } = await startHarness({ win });

    const result = await callTool(client, 'chart_set_timeframe', { timeframe: 'D' });

    expect(dataOf(result)).toStrictEqual({ resolution: '1D', previous: '1D', changed: false });
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('chart_set_timeframe times out when the data never comes', async () => {
    const win = createFakeTvWindow(fixture);
    Object.assign(chartOf(win).chart, { setResolution: () => Promise.resolve(true) });
    const { client, app } = await startHarness({ win, callTimeoutMs: 1000 });

    const result = await callTool(client, 'chart_set_timeframe', { timeframe: '4h' });

    expect(errorOf(result)).toMatchObject({ code: 'TIMEOUT', details: { requested: '240' } });
    expect(inputOf(app)).toEqual([]);
  });

  test('chart_set_timeframe warns when the chart settles on another timeframe', async () => {
    const win = createFakeTvWindow(fixture);
    const { chart } = chartOf(win);
    const original = chart.setResolution.bind(chart);
    Object.assign(chart, {
      setResolution: (_resolution: string, options?: { dataReady?: () => void }) =>
        original('240', options),
    });
    const { client } = await startHarness({ win });

    const result = await callTool(client, 'chart_set_timeframe', { timeframe: '15m' });

    expect(dataOf(result)).toMatchObject({ resolution: '240', changed: true });
    expect(warningsOf(result)).toEqual([expect.stringMatching(/240.*15/)]);
  });

  test('chart_set_timeframe clicks the interval button of the header toolbar when the chart API cannot change it', async () => {
    const ui = chartUi({
      intervalButtons: ['15', '60', '1D'],
      api: { without: ['setResolution'] },
    });
    const { client, app } = await startUi(ui);

    const result = await callTool(client, 'chart_set_timeframe', { timeframe: '1h' });

    expect(viaOf(result)).toBe('dom');
    expect(dataOf(result)).toStrictEqual({ resolution: '60', previous: '1D', changed: true });
    expect(methodsOf(app)).toEqual([
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
    ]);
  });

  test('chart_set_timeframe types the interval on the chart when no button shows it', async () => {
    const ui = chartUi({ intervalButtons: ['15'], api: { without: ['setResolution'] } });
    const { client, app } = await startUi(ui);

    const result = await callTool(client, 'chart_set_timeframe', { timeframe: '4h' });

    expect(viaOf(result)).toBe('keyboard');
    expect(dataOf(result)).toStrictEqual({ resolution: '240', previous: '1D', changed: true });
    expect(keysOf(app)).toEqual(['2', 'Enter']);
    expect(textsOf(app)).toEqual(['40']);
  });

  test('chart_set_timeframe stops, and does not type on the chart, when a click fails halfway', async () => {
    const ui = chartUi({
      intervalButtons: ['60'],
      failsOn: 'mousePressed',
      api: { without: ['setResolution'] },
    });
    const { client, app } = await startUi(ui);

    const result = await callTool(client, 'chart_set_timeframe', { timeframe: '1h' });

    expect(errorOf(result)).toMatchObject({
      code: 'PAGE_EVALUATION_FAILED',
      details: { strategy: 'interval button', stage: 'click' },
    });
    // The pointer had moved onto the button when the press failed; nothing was typed afterwards.
    expect(methodsOf(app)).toEqual(['Input.dispatchMouseEvent', 'Input.dispatchMouseEvent']);
    expect(keysOf(app)).toEqual([]);
  });

  test('chart_set_timeframe leaves the chart alone through the interface when it shows the timeframe already', async () => {
    const ui = chartUi({ intervalButtons: ['1D'], api: { without: ['setResolution'] } });
    const { client, app } = await startUi(ui);

    const result = await callTool(client, 'chart_set_timeframe', { timeframe: 'D' });

    expect(viaOf(result)).toBe('dom');
    expect(dataOf(result)).toStrictEqual({ resolution: '1D', previous: '1D', changed: false });
    expect(inputOf(app)).toEqual([]);
  });

  test('chart_set_timeframe times out when the interval button does not change the chart', async () => {
    const ui = chartUi({
      intervalButtons: ['60'],
      buttonsApply: false,
      api: { without: ['setResolution'] },
    });
    const { client } = await startUi(ui, 1000);

    const result = await callTool(client, 'chart_set_timeframe', { timeframe: '60' });

    expect(errorOf(result)).toMatchObject({
      code: 'TIMEOUT',
      details: { requested: '60', previous: '1D' },
    });
  });

  test.each([
    ['a page without the chart API', { api: 'none' as const }],
    ['a chart API that goes away', { dropsApi: true, api: { without: ['setResolution'] } }],
  ])(
    'chart_set_timeframe says that it could not check the change on %s',
    async (_case, options) => {
      const ui = chartUi({ intervalButtons: ['60'], ...options });
      const { client } = await startUi(ui);

      const result = await callTool(client, 'chart_set_timeframe', { timeframe: '1h' });

      expect(viaOf(result)).toBe('dom');
      expect(dataOf(result)).toStrictEqual({ resolution: null, previous: null, changed: null });
      expect(warningsOf(result)).toEqual([expect.stringMatching(/could not be checked/)]);
    },
  );
});

describe('chart_set_type', () => {
  test('chart_set_type sets heikin_ashi (8)', async () => {
    const win = createFakeTvWindow(fixture);
    const { client } = await startHarness({ win });

    const result = await callTool(client, 'chart_set_type', { type: 'heikin_ashi' });

    expect(result.structuredContent).toStrictEqual({
      ok: true,
      data: {
        chartType: 8,
        chartTypeName: 'heikin_ashi',
        previous: { chartType: 1, chartTypeName: 'candles' },
        changed: true,
      },
      meta: { via: 'api', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(inspectFakeWindow(win).callsTo('chart.setChartType')).toEqual([[8]]);
  });

  test('chart_set_type warns when the chart does not show the new type right away', async () => {
    const win = createFakeTvWindow(fixture);
    Object.assign(chartOf(win).chart, { setChartType: () => undefined });
    const { client } = await startHarness({ win });

    const result = await callTool(client, 'chart_set_type', { type: 'renko' });

    expect(dataOf(result)).toMatchObject({
      chartType: 1,
      chartTypeName: 'candles',
      changed: false,
    });
    expect(warningsOf(result)).toEqual([expect.stringMatching(/renko.*candles|candles.*renko/)]);
  });

  test('chart_set_type refuses a type it does not know', async () => {
    const win = createFakeTvWindow(fixture);
    const { client } = await startHarness({ win });

    const result = await callTool(client, 'chart_set_type', { type: 'pie' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('type');
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('chart_set_type is unavailable on a page whose app has not booted', async () => {
    const { client } = await startHarness({
      win: createFakeTvWindow(fixture, { withoutApi: true }),
    });

    const result = await callTool(client, 'chart_set_type', { type: 'line' });

    expect(errorOf(result)).toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      hint: expect.stringMatching(/app_health/) as string,
      details: { attempts: ['chart api'] },
    });
  });
});

describe('chart_get_visible_range', () => {
  test('chart_get_visible_range returns the visible range in Unix seconds and ISO', async () => {
    const { client } = await startHarness();

    const result = await callTool(client, 'chart_get_visible_range');

    expect(result.structuredContent).toStrictEqual({
      ok: true,
      data: {
        from: 1721433600,
        to: 1729987200,
        fromIso: '2024-07-20T00:00:00Z',
        toIso: '2024-10-27T00:00:00Z',
      },
      meta: { via: 'api', durationMs: expect.any(Number) as number, warnings: [] },
    });
  });

  test('chart_get_visible_range answers NOT_AVAILABLE while the chart shows a symbol TradingView could not find', async () => {
    const win = createFakeTvWindow(fixture);
    inspectFakeWindow(win).state.symbolInvalid = true;
    const { client } = await startHarness({ win });

    const result = await callTool(client, 'chart_get_visible_range');

    // The chart answers zeros then, which are not a range of 1970.
    expect(errorOf(result)).toMatchObject({ code: 'NOT_AVAILABLE' });
  });

  test('chart_get_visible_range answers NOT_AVAILABLE when the chart reports no usable range', async () => {
    const win = createFakeTvWindow(fixture);
    Object.assign(chartOf(win).chart, { getVisibleRange: () => ({ from: null, to: 5 }) });
    const { client } = await startHarness({ win });

    const result = await callTool(client, 'chart_get_visible_range', { chartIndex: 0 });

    expect(errorOf(result)).toMatchObject({ code: 'NOT_AVAILABLE' });
  });
});

describe('chart_set_visible_range', () => {
  test('chart_set_visible_range uses the internal time scale because setVisibleRange is not implemented', async () => {
    const win = createFakeTvWindow(fixture);
    const { client } = await startHarness({ win });

    const result = await callTool(client, 'chart_set_visible_range', {
      from: '2024-03-01T10:00:00Z',
      to: '2024-03-31T20:00:00Z',
    });

    expect(result.structuredContent).toStrictEqual({
      ok: true,
      data: {
        from: barTime(59),
        to: barTime(90),
        fromIso: '2024-03-01T00:00:00Z',
        toIso: '2024-04-01T00:00:00Z',
      },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    const inspector = inspectFakeWindow(win);
    expect(inspector.callsTo('timeScale.zoomToBarsRange')).toEqual([[59, 90]]);
    expect(inspector.callsTo('chart.setVisibleRange')).toEqual([]);
  });

  test('chart_set_visible_range takes Unix seconds and milliseconds as well', async () => {
    const win = createFakeTvWindow(fixture);
    const { client } = await startHarness({ win });

    const result = await callTool(client, 'chart_set_visible_range', {
      from: barTime(59) + 36_000,
      to: String((barTime(89) + 72_000) * 1000),
    });

    expect(dataOf(result)).toMatchObject({ from: barTime(59), to: barTime(90) });
  });

  test('chart_set_visible_range clamps to loaded history and warns', async () => {
    const { client } = await startHarness();

    const result = await callTool(client, 'chart_set_visible_range', {
      from: '2023-06-01',
      to: '2024-02-01',
    });

    expect(dataOf(result)).toMatchObject({ from: barTime(0), to: barTime(30) });
    expect(warningsOf(result)).toEqual([
      'History before 2024-01-02T00:00:00Z is not loaded; the range was clamped',
    ]);
  });

  test.each([
    ['neither a range nor a preset', {}],
    ['from without to', { from: '2024-03-01' }],
    ['to without from', { to: '2024-03-01' }],
    ['a range and a preset', { from: '2024-03-01', to: '2024-04-01', preset: '3M' }],
    ['a preset and from', { from: '2024-03-01', preset: '3M' }],
    ['from after to', { from: '2024-04-01', to: '2024-03-01' }],
    ['from equal to to', { from: '2024-04-01', to: '2024-04-01T00:00:00Z' }],
    ['a compact date', { from: '20240301', to: '2024-04-01' }],
  ])('chart_set_visible_range refuses %s before it looks at TradingView', async (_case, args) => {
    const { client, app } = await startHarness();

    const result = await callTool(client, 'chart_set_visible_range', args);

    expect(errorOf(result)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(app.connectionCount()).toBe(0);
  });

  test('chart_set_visible_range clicks a date range preset and reports the range and the timeframe it led to', async () => {
    const ui = chartUi({ presets: ['1M', '3M', '12M'] });
    const { client, app } = await startUi(ui);

    const result = await callTool(client, 'chart_set_visible_range', { preset: '3M' });

    expect(result.structuredContent).toStrictEqual({
      ok: true,
      data: {
        from: PRESET_RANGE.from,
        to: PRESET_RANGE.to,
        fromIso: '2024-07-29T00:00:00Z',
        toIso: '2024-10-27T00:00:00Z',
        preset: '3M',
        resolution: '60',
      },
      meta: {
        via: 'dom',
        durationMs: expect.any(Number) as number,
        warnings: ['The preset also changed the timeframe from 1D to 60'],
      },
    });
    expect(methodsOf(app)).toEqual([
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
    ]);
  });

  test('chart_set_visible_range is unavailable when the date range bar has no such preset', async () => {
    const ui = chartUi({ presets: ['1M'] });
    const { client, app } = await startUi(ui);

    const result = await callTool(client, 'chart_set_visible_range', { preset: 'YTD' });

    expect(errorOf(result)).toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      hint: expect.stringMatching(/from and to/) as string,
      details: { attempts: ['date range preset'] },
    });
    expect(inputOf(app)).toEqual([]);
  });

  test('chart_set_visible_range stops with a terminal error when the click on a preset fails halfway', async () => {
    const ui = chartUi({ presets: ['3M'], failsOn: 'mousePressed' });
    const { client } = await startUi(ui);

    const result = await callTool(client, 'chart_set_visible_range', { preset: '3M' });

    expect(errorOf(result)).toMatchObject({
      code: 'PAGE_EVALUATION_FAILED',
      details: { strategy: 'date range preset', stage: 'click' },
    });
  });

  test('chart_set_visible_range warns when a preset leaves the range as it was', async () => {
    const ui = chartUi({ presets: ['3M'], buttonsApply: false });
    const { client } = await startUi(ui, 1000);

    const result = await callTool(client, 'chart_set_visible_range', { preset: '3M' });

    expect(dataOf(result)).toMatchObject({
      from: fixture.visibleRange.from,
      to: fixture.visibleRange.to,
      preset: '3M',
      resolution: '1D',
    });
    expect(warningsOf(result)).toEqual([expect.stringMatching(/did not change/)]);
  });

  test.each([
    ['a page without the chart API', { api: 'none' as const }],
    ['a chart API that goes away', { dropsApi: true }],
  ])(
    'chart_set_visible_range says that it could not check a preset on %s',
    async (_case, options) => {
      const ui = chartUi({ presets: ['3M'], ...options });
      const { client } = await startUi(ui);

      const result = await callTool(client, 'chart_set_visible_range', { preset: '3M' });

      expect(viaOf(result)).toBe('dom');
      expect(dataOf(result)).toStrictEqual({
        from: null,
        to: null,
        fromIso: null,
        toIso: null,
        preset: '3M',
        resolution: null,
      });
      expect(warningsOf(result)).toEqual([expect.stringMatching(/could not be checked/)]);
    },
  );

  test('chart_set_visible_range warns when the chart does not report the range it moved to', async () => {
    const win = createFakeTvWindow(fixture);
    Object.assign(chartOf(win).chart, { getVisibleRange: () => ({ from: Number.NaN, to: 1 }) });
    const { client } = await startHarness({ win });

    const result = await callTool(client, 'chart_set_visible_range', {
      from: '2024-03-01',
      to: '2024-04-01',
    });

    expect(viaOf(result)).toBe('internal');
    expect(dataOf(result)).toStrictEqual({ from: null, to: null, fromIso: null, toIso: null });
    expect(warningsOf(result)).toEqual([expect.stringMatching(/did not report its visible range/)]);
    expect(inspectFakeWindow(win).callsTo('timeScale.zoomToBarsRange')).toEqual([[59, 90]]);
  });
});

describe('chart_scroll_to_date', () => {
  test('chart_scroll_to_date accepts ISO and Unix inputs', async () => {
    const { client } = await startHarness();
    const expected = {
      time: 1712707200,
      timeIso: '2024-04-10T00:00:00Z',
      align: 'center',
      from: barTime(50),
      to: barTime(149),
      fromIso: '2024-02-21T00:00:00Z',
      toIso: '2024-05-30T00:00:00Z',
    };

    for (const date of ['2024-04-10', '2024-04-10T02:00:00+02:00', 1712707200, 1712707200000]) {
      const result = await callTool(client, 'chart_scroll_to_date', { date });

      expect(viaOf(result), String(date)).toBe('internal');
      expect(dataOf(result), String(date)).toStrictEqual(expected);
    }
  });

  test('chart_scroll_to_date puts the bar at the edge it is asked for, and warns about a date past the last bar', async () => {
    const win = createFakeTvWindow(fixture);
    const { client } = await startHarness({ win });

    const right = await callTool(client, 'chart_scroll_to_date', {
      date: '2024-04-10',
      align: 'right',
    });
    const late = await callTool(client, 'chart_scroll_to_date', { date: '2026-01-01' });

    expect(dataOf(right)).toMatchObject({ align: 'right', from: barTime(0), to: barTime(99) });
    // The view ends at the last bar instead of reaching past the data.
    expect(dataOf(late)).toMatchObject({
      time: barTime(LAST),
      from: barTime(LAST - 99),
      to: barTime(LAST),
    });
    expect(warningsOf(late)).toEqual([
      'The chart has no bars after 2024-10-27T00:00:00Z; the chart was scrolled to the last bar',
      'The view was moved to stay within the loaded bars, so the bar is not at the center of it',
    ]);
    expect(inspectFakeWindow(win).callsTo('timeScale.zoomToBarsRange')).toEqual([
      [0, 99],
      [LAST - 99, LAST],
    ]);
    expect(inspectFakeWindow(win).callsTo('timeScale.scrollToBar')).toEqual([]);
  });

  test('chart_scroll_to_date refuses a compact date before it looks at TradingView', async () => {
    const { client, app } = await startHarness();

    const result = await callTool(client, 'chart_scroll_to_date', { date: '20240410' });

    expect(errorOf(result)).toMatchObject({
      code: 'INVALID_INPUT',
      hint: expect.stringContaining('looks like a year or compact date') as string,
    });
    expect(app.connectionCount()).toBe(0);
  });

  test('chart_scroll_to_date warns about what the chart did not report after the scroll', async () => {
    const win = createFakeTvWindow(fixture);
    const { chart } = chartOf(win);
    // The width of the view comes from the logical range of the time scale, so the visible range is
    // only read after the scroll, and that read fails.
    Object.assign(chart, { getVisibleRange: () => ({ from: Number.NaN, to: Number.NaN }) });
    const series = chart._chartWidget.model().mainSeries();
    const bars = series.bars();
    Object.assign(series, {
      bars: () => ({
        ...bars,
        valueAt: (index: number) => (index === 99 ? null : bars.valueAt(index)),
      }),
    });
    const { client } = await startHarness({ win });

    const result = await callTool(client, 'chart_scroll_to_date', { date: '2024-04-10' });

    expect(dataOf(result)).toStrictEqual({
      time: null,
      timeIso: null,
      align: 'center',
      from: null,
      to: null,
      fromIso: null,
      toIso: null,
    });
    expect(warningsOf(result)).toEqual([
      expect.stringMatching(/time of the bar/),
      expect.stringMatching(/did not report its visible range/),
    ]);
  });
});

describe('the chart state resource', () => {
  test('reads the chart state resource', async () => {
    const { client } = await startHarness();

    const { resources } = await client.listResources();
    const read = await client.readResource({ uri: STATE_URI });
    const tool = await callTool(client, 'chart_get_state');

    expect(resources).toContainEqual(
      expect.objectContaining({ uri: STATE_URI, mimeType: 'application/json' }),
    );
    expect(read.contents).toHaveLength(1);
    const [content] = read.contents;
    expect(content).toMatchObject({ uri: STATE_URI, mimeType: 'application/json' });
    const text = content !== undefined && 'text' in content ? content.text : '';
    expect(JSON.parse(text)).toStrictEqual(dataOf(tool));
  });

  test('the chart state resource fails with the code of the failure when TradingView is down', async () => {
    const client = await startOffline();

    await expect(client.readResource({ uri: STATE_URI })).rejects.toMatchObject({
      data: { code: 'CDP_UNREACHABLE' },
    });
  });
});

describe('the chart tools as a client sees them', () => {
  test('are listed in the order of the catalog, with their annotations and described inputs', async () => {
    const { client } = await startHarness();

    const { tools } = await client.listTools();

    const listed = tools.filter(({ name }) => name.startsWith('chart_'));
    expect(listed.map(({ name }) => name)).toEqual([
      'chart_get_state',
      'chart_set_symbol',
      'chart_set_timeframe',
      'chart_set_type',
      'chart_get_visible_range',
      'chart_set_visible_range',
      'chart_scroll_to_date',
    ]);
    expect(listed.map(({ name }) => name)).toEqual(chartTools.map(({ name }) => name));
    for (const tool of listed) {
      const readOnly = tool.name.startsWith('chart_get_');
      expect(tool.annotations, tool.name).toEqual({
        readOnlyHint: readOnly,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(tool.description?.length, tool.name).toBeGreaterThan(100);
      const properties = (tool.inputSchema.properties ?? {}) as Record<
        string,
        { description?: string }
      >;
      expect(properties, tool.name).toHaveProperty('chartIndex');
      for (const [field, schema] of Object.entries(properties)) {
        expect(schema.description, `${tool.name}.${field}`).toBeTruthy();
      }
    }
    const visible = listed.find(({ name }) => name === 'chart_set_visible_range');
    expect(visible?.inputSchema.required ?? []).toEqual([]);
    expect(visible?.inputSchema.properties).toMatchObject({
      preset: { enum: ['1D', '5D', '1M', '3M', '6M', 'YTD', '12M', '60M', 'ALL'] },
    });
  });

  test('the readonly profile offers the chart tools that only read', async () => {
    const { server } = createMcpServer(testConfig({ profile: 'readonly' }), {
      connection: unreachableConnection(),
      launcher: refusingLauncher(),
      logger: quietLogger,
    });
    const client = await connect(server);

    const { tools } = await client.listTools();

    expect(tools.map(({ name }) => name).filter((name) => name.startsWith('chart_'))).toEqual([
      'chart_get_state',
      'chart_get_visible_range',
    ]);
  });
});
