import { readFileSync } from 'node:fs';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from '../../../src/core/logger.js';
import { createMcpServer } from '../../../src/server.js';
import { CDP_ERROR } from '../../helpers/fake-cdp/protocol.js';
import {
  FakeCdpError,
  startFakeCdpServer,
  type FakeCdpServer,
} from '../../helpers/fake-cdp/server.js';
import { loadTargetsFixture } from '../../helpers/fake-cdp/targets.js';
import { fixturePath } from '../../helpers/fixture-path.js';
import type { FakeRect } from '../../helpers/fake-tv/dom.js';
import { loadTvFixture, type TvStateFixture } from '../../helpers/fake-tv/fixture.js';
import type { FakeScreenOptions } from '../../helpers/fake-tv/screen.js';
import { createFakeTvWindow, inspectFakeWindow } from '../../helpers/fake-tv/window.js';
import { callTool, connectInMemoryClient, textOf } from '../../helpers/mcp-client.js';
import {
  capturingLogger,
  quietLogger,
  refusingLauncher,
  testConfig,
} from '../../helpers/tool-context.js';

// The screenshot tool through the whole server: an SDK client over the in-memory transport, the real
// registry, connection manager, discovery and CDP adapter, and the fake debug port of the app with
// a fake chart tab and a fake window chrome behind it. What the tool asks of the page is what the
// fake debug port recorded, so the tests read the parameters of the capture there.

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
const CHROME_ID = 'EE67363DAA56C9940A709061CFAA2FFF';
const PNG = readFileSync(fixturePath('png/1x1.png'));
const JPEG = readFileSync(fixturePath('jpeg/1x1.jpg'));
const PNG_BASE64 = PNG.toString('base64');
const JPEG_BASE64 = JPEG.toString('base64');

const twoCharts: TvStateFixture = {
  ...fixture,
  layout: { ...fixture.layout, type: '2h', chartsCount: 2 },
};
const LEFT: FakeRect = { x: 50, y: 40, width: 600, height: 500 };
const RIGHT: FakeRect = { x: 660, y: 40, width: 600, height: 500 };

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

interface HarnessOptions {
  // The window of the chart tab. By default a booted chart on the default screen of the fake.
  win?: object;
  // The window of the window chrome page. By default a blank page.
  chromeWindow?: () => object;
  // Answers of single targets for single CDP commands, by target id.
  handlers?: Record<string, Handlers>;
  // An app that lists no window chrome.
  withoutChrome?: boolean;
  logger?: Logger;
}

interface Harness {
  client: Client;
  app: FakeCdpServer;
  events: () => { tool: string; args?: unknown }[];
}

// The real server over the real adapters, against a fake debug port.
async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const win = options.win ?? createFakeTvWindow(fixture);
  const targets = loadTargetsFixture({
    chartWindow: () => win,
    ...(options.chromeWindow === undefined ? {} : { chromeWindow: options.chromeWindow }),
  }).filter(({ id }) => !(options.withoutChrome === true && id === CHROME_ID));
  for (const target of targets) {
    const handlers = options.handlers?.[target.id];
    if (handlers !== undefined) {
      target.handlers = handlers;
    }
  }
  const app = await startFakeCdpServer({ targets });
  cleanups.push(() => app.close());
  const config = testConfig({ cdpPort: app.port, callTimeoutMs: 5000 });
  const { server, ctx } = createMcpServer(config, {
    launcher: refusingLauncher(),
    logger: options.logger ?? quietLogger,
  });
  cleanups.push(() => ctx.connection.close());
  return { client: await connect(server), app, events: () => ctx.events.recent() };
}

// A window chrome page of the given size, which has nothing of the chart API: should the tool run
// page code in it, the fake debug port would show an evaluation.
function chromeOf(width: number, height: number, devicePixelRatio: number): () => object {
  return () => ({
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio,
    location: { href: 'file:///app.asar/app/window/index.html' },
    document: { visibilityState: 'visible' },
  });
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

interface CaptureParams {
  format?: string;
  quality?: number;
  captureBeyondViewport?: boolean;
  clip?: { x: number; y: number; width: number; height: number; scale: number };
}

// What the tool asked a target to capture, in order.
function capturesOf(app: FakeCdpServer, targetId = CHART_ID): CaptureParams[] {
  return app.calls
    .filter((call) => call.targetId === targetId && call.method === 'Page.captureScreenshot')
    .map((call) => call.params as CaptureParams);
}

// How wide Chrome makes the image of a clip: the clip times its scale times the pixel ratio of the
// display.
function widthOfClip(capture: CaptureParams | undefined, devicePixelRatio: number): number {
  if (capture?.clip === undefined) {
    throw new Error('The capture has no clip');
  }
  return capture.clip.width * capture.clip.scale * devicePixelRatio;
}

// Every command that reached a target, by method.
function methodsOf(app: FakeCdpServer, targetId = CHART_ID): string[] {
  return app.calls.filter((call) => call.targetId === targetId).map((call) => call.method);
}

function screen(options: FakeScreenOptions, from = fixture) {
  return createFakeTvWindow(from, { screen: options });
}

describe('screenshot_capture', () => {
  test('screenshot_capture returns the chart container as a png, with its size in pixels', async () => {
    const { client, app } = await startHarness();

    const result = await callTool(client, 'screenshot_capture');

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toStrictEqual({
      ok: true,
      data: { target: 'chart', format: 'png', width: 1180, height: 640, bytes: PNG.length },
      meta: { via: 'cdp', durationMs: expect.any(Number) as number, warnings: [] },
    });
    // The default screen of the fake puts the only chart in a box of 1180 by 640 CSS pixels.
    expect(capturesOf(app)).toEqual([
      {
        format: 'png',
        captureBeyondViewport: false,
        clip: { x: 50, y: 40, width: 1180, height: 640, scale: 1 },
      },
    ]);
  });

  test('screenshot_capture with maxWidth 800 on a 2x display returns an image at most 800 px wide', async () => {
    const win = screen({ width: 1600, height: 1000, devicePixelRatio: 2 });
    const { client, app } = await startHarness({ win });

    const result = await callTool(client, 'screenshot_capture', { target: 'page', maxWidth: 800 });

    expect(result.isError).not.toBe(true);
    const captures = capturesOf(app);
    expect(captures).toHaveLength(1);
    // The clip is the page in CSS pixels, 1600 by 1000, and a 2x display makes it 3200 by 2000
    // device pixels: the scale of the clip brings the image down to 800.
    expect(captures[0]?.clip).toEqual({ x: 0, y: 0, width: 1600, height: 1000, scale: 0.25 });
    expect(widthOfClip(captures[0], 2)).toBeLessThanOrEqual(800);
    // width and height are the size of the image that comes out, not of the clip.
    expect(dataOf(result)).toMatchObject({ target: 'page', width: 800, height: 500 });
  });

  test.each([
    {
      target: 'chart',
      targetId: CHART_ID,
      options: (): HarnessOptions => ({
        win: screen({
          width: 1600,
          height: 1000,
          devicePixelRatio: 2,
          charts: [{ x: 52, y: 44, width: 1403, height: 757 }],
        }),
      }),
      clip: { x: 52, y: 44, width: 1403, height: 757, scale: 800 / 2806 },
      size: { width: 800, height: 432 },
    },
    {
      target: 'window',
      targetId: CHROME_ID,
      options: (): HarnessOptions => ({ chromeWindow: chromeOf(1600, 34, 2) }),
      clip: { x: 0, y: 0, width: 1600, height: 34, scale: 0.25 },
      size: { width: 800, height: 17 },
    },
  ])(
    'maxWidth brings a capture of the $target on a 2x display down to the width asked for',
    async ({ target, targetId, options, clip, size }) => {
      const { client, app } = await startHarness(options());

      const result = await callTool(client, 'screenshot_capture', { target, maxWidth: 800 });

      expect(result.isError).not.toBe(true);
      expect(capturesOf(app, targetId)).toEqual([
        { format: 'png', captureBeyondViewport: false, clip },
      ]);
      expect(dataOf(result)).toMatchObject(size);
    },
  );

  test('a capture that is narrower than maxWidth is not scaled up', async () => {
    const win = screen({ width: 1600, height: 1000, devicePixelRatio: 2 });
    const { client, app } = await startHarness({ win });

    // 1600 CSS pixels are 3200 device pixels: 4000 leaves room.
    const result = await callTool(client, 'screenshot_capture', { target: 'page', maxWidth: 4000 });

    expect(capturesOf(app)).toEqual([{ format: 'png', captureBeyondViewport: false }]);
    expect(dataOf(result)).toMatchObject({ width: 3200, height: 2000 });
  });

  test('a capture without maxWidth is at the full resolution of the display', async () => {
    const win = screen({
      width: 1600,
      height: 1000,
      devicePixelRatio: 2,
      charts: [{ x: 52, y: 44, width: 1403, height: 757 }],
    });
    const { client, app } = await startHarness({ win });

    const chart = await callTool(client, 'screenshot_capture', { target: 'chart' });
    const page = await callTool(client, 'screenshot_capture', { target: 'page' });

    expect(dataOf(chart)).toMatchObject({ width: 2806, height: 1514 });
    expect(dataOf(page)).toMatchObject({ width: 3200, height: 2000 });
    // The page is asked for as it is shown, without a clip; the chart needs one for its box.
    expect(capturesOf(app)).toEqual([
      {
        format: 'png',
        captureBeyondViewport: false,
        clip: { x: 52, y: 44, width: 1403, height: 757, scale: 1 },
      },
      { format: 'png', captureBeyondViewport: false },
    ]);
  });

  test('chart target clips to the chart container of the chosen chart', async () => {
    const win = screen({ charts: [LEFT, RIGHT] }, twoCharts);
    const { client, app } = await startHarness({ win });

    const second = await callTool(client, 'screenshot_capture', { chartIndex: 1 });
    const first = await callTool(client, 'screenshot_capture', { chartIndex: 0 });
    const active = await callTool(client, 'screenshot_capture');
    inspectFakeWindow(win).state.activeChartIndex = 1;
    const nowActive = await callTool(client, 'screenshot_capture');

    for (const result of [second, first, active, nowActive]) {
      expect(result.isError).not.toBe(true);
    }
    expect(capturesOf(app).map((capture) => capture.clip)).toEqual([
      { ...RIGHT, scale: 1 },
      { ...LEFT, scale: 1 },
      { ...LEFT, scale: 1 },
      { ...RIGHT, scale: 1 },
    ]);
    expect(dataOf(second)).toMatchObject({ width: 600, height: 500 });
  });

  test('a chartIndex that the layout does not have is refused before anything is captured', async () => {
    const win = screen({ charts: [LEFT, RIGHT] }, twoCharts);
    const { client, app } = await startHarness({ win });

    const result = await callTool(client, 'screenshot_capture', { chartIndex: 2 });

    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({
      code: 'INVALID_INPUT',
      details: { chartIndex: 2, chartsCount: 2 },
    });
    expect(capturesOf(app)).toEqual([]);
  });

  test('page captures the whole chart tab and window captures the window chrome target', async () => {
    const win = screen({ width: 1280, height: 720, devicePixelRatio: 1 });
    const { client, app } = await startHarness({ win, chromeWindow: chromeOf(1280, 34, 1) });

    const page = await callTool(client, 'screenshot_capture', { target: 'page' });
    const chrome = await callTool(client, 'screenshot_capture', { target: 'window' });

    expect(page.isError).not.toBe(true);
    expect(chrome.isError).not.toBe(true);
    expect(dataOf(page)).toMatchObject({ target: 'page', width: 1280, height: 720 });
    expect(dataOf(chrome)).toMatchObject({ target: 'window', width: 1280, height: 34 });
    // Each is captured in its own target, as the page shows itself.
    expect(capturesOf(app, CHART_ID)).toEqual([{ format: 'png', captureBeyondViewport: false }]);
    expect(capturesOf(app, CHROME_ID)).toEqual([{ format: 'png', captureBeyondViewport: false }]);
  });

  test('window evaluates nothing in the window chrome, which has Node integration', async () => {
    const { client, app } = await startHarness({ chromeWindow: chromeOf(1280, 34, 1) });

    await callTool(client, 'screenshot_capture', { target: 'window', maxWidth: 400 });

    expect(methodsOf(app, CHROME_ID)).toEqual(['Page.getLayoutMetrics', 'Page.captureScreenshot']);
    // Nor did it open a session to the chart tab for it.
    expect(methodsOf(app, CHART_ID)).toEqual([]);
  });

  test('jpeg uses quality 80 and png none', async () => {
    const { client, app } = await startHarness();

    const jpeg = await callTool(client, 'screenshot_capture', { target: 'page', format: 'jpeg' });
    const png = await callTool(client, 'screenshot_capture', { target: 'page', format: 'png' });
    const byDefault = await callTool(client, 'screenshot_capture', { target: 'page' });
    const chartJpeg = await callTool(client, 'screenshot_capture', { format: 'jpeg' });

    const captures = capturesOf(app);
    expect(captures[0]).toEqual({ format: 'jpeg', quality: 80, captureBeyondViewport: false });
    expect(captures[1]).toEqual({ format: 'png', captureBeyondViewport: false });
    expect(captures[2]).toEqual({ format: 'png', captureBeyondViewport: false });
    expect(captures[3]).toMatchObject({ format: 'jpeg', quality: 80 });
    for (const capture of [captures[1], captures[2]]) {
      expect(capture).not.toHaveProperty('quality');
    }
    // The image is labelled with the format it was asked in.
    expect(jpeg.content[0]).toEqual({ type: 'image', data: JPEG_BASE64, mimeType: 'image/jpeg' });
    expect(png.content[0]).toEqual({ type: 'image', data: PNG_BASE64, mimeType: 'image/png' });
    expect(byDefault.content[0]).toMatchObject({ mimeType: 'image/png' });
    expect(dataOf(jpeg)).toMatchObject({ format: 'jpeg', bytes: JPEG.length });
    expect(dataOf(chartJpeg)).toMatchObject({ target: 'chart', format: 'jpeg' });
  });

  test('the image block comes before the JSON block and the JSON carries no base64', async () => {
    const { client } = await startHarness();

    const result = await callTool(client, 'screenshot_capture', { target: 'page' });

    expect(result.content.map((block) => block.type)).toEqual(['image', 'text']);
    expect(result.content[0]).toEqual({ type: 'image', data: PNG_BASE64, mimeType: 'image/png' });
    // The text block and the structured content are the same envelope, and neither holds the picture.
    expect(JSON.parse(textOf(result))).toStrictEqual(result.structuredContent);
    expect(textOf(result)).not.toContain(PNG_BASE64);
    expect(JSON.stringify(result.structuredContent)).not.toContain(PNG_BASE64);
    expect(dataOf(result)).toStrictEqual({
      target: 'page',
      format: 'png',
      width: 1280,
      height: 720,
      bytes: 69,
    });
  });

  test('a page without a chart container fails NOT_AVAILABLE', async () => {
    const win = screen({ charts: [] });
    const { client, app } = await startHarness({ win });

    const result = await callTool(client, 'screenshot_capture');

    expect(result.isError).toBe(true);
    expect(result.content.map((block) => block.type)).toEqual(['text']);
    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: 'The page shows no container for the active chart',
    });
    expect(capturesOf(app)).toEqual([]);
  });

  test('a chart whose container has no size fails NOT_AVAILABLE, and nothing is captured', async () => {
    const win = screen({ charts: [LEFT, { ...RIGHT, width: 0 }] }, twoCharts);
    const { client, app } = await startHarness({ win });

    const result = await callTool(client, 'screenshot_capture', { chartIndex: 1 });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: 'The container of chart 1 has no size',
    });
    expect(capturesOf(app)).toEqual([]);
  });

  test('a container that the app does not name is found by its position, and the result says so', async () => {
    const win = createFakeTvWindow(twoCharts, {
      screen: { charts: [LEFT, RIGHT] },
      withoutChartCollection: true,
    });
    const { client, app } = await startHarness({ win });

    const result = await callTool(client, 'screenshot_capture', { chartIndex: 1 });

    expect(result.isError).not.toBe(true);
    expect(capturesOf(app).map((capture) => capture.clip)).toEqual([{ ...RIGHT, scale: 1 }]);
    expect(warningsOf(result)).toHaveLength(1);
    expect(warningsOf(result)?.[0]).toMatch(/position/);
    expect(warningsOf(result)?.[0]).toMatch(/chart container/);
  });

  test.each(['page', 'window'])(
    'chartIndex is ignored for the %s target, with a warning',
    async (target) => {
      const { client, app } = await startHarness({ chromeWindow: chromeOf(1280, 34, 1) });

      // The layout has one chart, so 5 would be refused for the chart target.
      const result = await callTool(client, 'screenshot_capture', { target, chartIndex: 5 });

      expect(result.isError).not.toBe(true);
      expect(warningsOf(result)).toEqual([
        `chartIndex only applies to target "chart", so it was ignored for target "${target}".`,
      ]);
      expect(methodsOf(app)).not.toContain('Runtime.evaluate');
    },
  );

  test('screenshot_capture only reads: the commands it sends are layout reads and the capture', async () => {
    const win = createFakeTvWindow(twoCharts, { screen: { charts: [LEFT, RIGHT] } });
    const { client, app } = await startHarness({ win });

    await callTool(client, 'screenshot_capture', { target: 'page' });
    expect(methodsOf(app)).toEqual(['Page.getLayoutMetrics', 'Page.captureScreenshot']);

    app.calls.length = 0;
    await callTool(client, 'screenshot_capture');
    // The container of the active chart, the layout metrics, the capture.
    expect(methodsOf(app)).toEqual([
      'Runtime.evaluate',
      'Page.getLayoutMetrics',
      'Page.captureScreenshot',
    ]);

    app.calls.length = 0;
    await callTool(client, 'screenshot_capture', { chartIndex: 1 });
    // The same, after the layout was asked how many charts it has.
    expect(methodsOf(app)).toEqual([
      'Runtime.evaluate',
      'Runtime.evaluate',
      'Page.getLayoutMetrics',
      'Page.captureScreenshot',
    ]);
    // Neither the page nor the app was changed.
    expect(inspectFakeWindow(win).calls).toEqual([]);
    expect(inspectFakeWindow(win).state.activeChartIndex).toBe(0);
  });

  test('a page that does not report the size of its viewport fails NOT_AVAILABLE', async () => {
    const { client, app } = await startHarness({
      handlers: { [CHART_ID]: { 'Page.getLayoutMetrics': () => ({}) } },
    });

    for (const target of ['page', 'chart']) {
      const result = await callTool(client, 'screenshot_capture', { target });

      expect(errorOf(result), target).toMatchObject({ code: 'NOT_AVAILABLE' });
    }
    expect(capturesOf(app)).toEqual([]);
  });

  test('an answer without an image fails NOT_AVAILABLE instead of returning an empty picture', async () => {
    const { client } = await startHarness({
      handlers: { [CHART_ID]: { 'Page.captureScreenshot': () => ({ data: '' }) } },
    });

    const result = await callTool(client, 'screenshot_capture', { target: 'page' });

    expect(result.isError).toBe(true);
    expect(result.content.map((block) => block.type)).toEqual(['text']);
    expect(errorOf(result)).toMatchObject({ code: 'NOT_AVAILABLE' });
  });

  test('a capture that the app refuses is reported with the command that failed', async () => {
    const { client } = await startHarness({
      handlers: {
        [CHART_ID]: {
          'Page.captureScreenshot': () => {
            throw new FakeCdpError(CDP_ERROR.serverError, 'Unable to capture screenshot');
          },
        },
      },
    });

    const result = await callTool(client, 'screenshot_capture', { target: 'page' });

    expect(errorOf(result)).toMatchObject({
      code: 'PAGE_EVALUATION_FAILED',
      details: { method: 'Page.captureScreenshot' },
    });
  });

  test('window fails TARGET_NOT_FOUND when the app lists no window chrome', async () => {
    const { client, app } = await startHarness({ withoutChrome: true });

    const result = await callTool(client, 'screenshot_capture', { target: 'window' });

    expect(errorOf(result)).toMatchObject({ code: 'TARGET_NOT_FOUND' });
    expect(capturesOf(app)).toEqual([]);
  });

  test('batch_run puts the images of its screenshot steps in front of the outcomes', async () => {
    const { client } = await startHarness();

    const result = await callTool(client, 'batch_run', {
      steps: [
        { tool: 'screenshot_capture', arguments: { target: 'page', maxWidth: 400 } },
        { tool: 'screenshot_capture', arguments: { target: 'page', format: 'jpeg' } },
      ],
    });

    expect(result.content.map((block) => block.type)).toEqual(['image', 'image', 'text']);
    expect(result.content[0]).toMatchObject({ mimeType: 'image/png' });
    expect(result.content[1]).toMatchObject({ mimeType: 'image/jpeg' });
    expect(dataOf(result)).toMatchObject({
      completed: 2,
      steps: [
        { tool: 'screenshot_capture', ok: true, data: { format: 'png', width: 400, height: 225 } },
        {
          tool: 'screenshot_capture',
          ok: true,
          data: { format: 'jpeg', width: 1280, height: 720 },
        },
      ],
    });
    expect(textOf(result)).not.toContain(PNG_BASE64);
    expect(textOf(result)).not.toContain(JPEG_BASE64);
  });

  test('the picture reaches the client and nothing else: it is not logged or put into an event', async () => {
    const { logger, lines } = capturingLogger();
    const { client, events } = await startHarness({ logger });

    const result = await callTool(client, 'screenshot_capture', { target: 'page' });
    await callTool(client, 'screenshot_capture', { target: 'page', format: 'jpeg' });
    await callTool(client, 'screenshot_capture', { chartIndex: 4 });

    expect(result.content[0]).toMatchObject({ type: 'image' });
    expect(lines.length).toBeGreaterThan(0);
    for (const seen of [JSON.stringify(lines), JSON.stringify(events())]) {
      expect(seen).not.toContain(PNG_BASE64);
      expect(seen).not.toContain(JPEG_BASE64);
    }
    expect(events().map(({ tool }) => tool)).toEqual(Array(6).fill('screenshot_capture'));
  });
});
