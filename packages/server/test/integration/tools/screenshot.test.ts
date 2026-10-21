import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from '../../../src/core/logger.js';
import { createMcpServer } from '../../../src/server.js';
import { solidImage } from '../../helpers/fake-cdp/images.js';
import { CDP_ERROR } from '../../helpers/fake-cdp/protocol.js';
import {
  FakeCdpError,
  startFakeCdpServer,
  type FakeCdpServer,
} from '../../helpers/fake-cdp/server.js';
import { loadTargetsFixture } from '../../helpers/fake-cdp/targets.js';
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
// fake debug port recorded, so the tests read the parameters of the capture there. The picture the
// fake makes of a capture has the size Chrome would make of the clip, so the size the tool reports
// is checked against the header of the image it returns.

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
// The most the tool returns of an image, and the most it makes of one when maxWidth is left out.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_WIDTH = 1920;

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

// The image block of a result, which comes first.
function imageOf(result: CallToolResult) {
  const [block] = result.content;
  if (block?.type !== 'image') {
    throw new Error('The result has no image in front of the JSON');
  }
  return block;
}

const bytesOf = (result: CallToolResult): Buffer => Buffer.from(imageOf(result).data, 'base64');

// The size in the header of a picture, read here and not with the code under test: a png keeps it
// in its first chunk, a baseline jpeg in its frame header.
function headerSizeOf(bytes: Buffer): { width: number; height: number } {
  if (bytes.subarray(1, 4).toString('latin1') === 'PNG') {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  const frame = bytes.indexOf(Buffer.from([0xff, 0xc0]));
  return { width: bytes.readUInt16BE(frame + 7), height: bytes.readUInt16BE(frame + 5) };
}

// The image has the size asked for, in its header as well as in the JSON, and bytes is its length.
function expectImage(result: CallToolResult, size: { width: number; height: number }): void {
  expect(result.isError).not.toBe(true);
  const bytes = bytesOf(result);
  expect(headerSizeOf(bytes)).toEqual(size);
  expect(dataOf(result)).toMatchObject({ ...size, bytes: bytes.length });
}

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

// How wide Chrome makes the image of a clip: the clip, which is in DIPs, times the scale of the
// display and the scale of the clip. The scale of the display is the pixel ratio of the page over
// its zoom.
function widthOfClip(
  capture: CaptureParams | undefined,
  devicePixelRatio: number,
  zoom = 1,
): number {
  if (capture?.clip === undefined) {
    throw new Error('The capture has no clip');
  }
  return capture.clip.width * (devicePixelRatio / zoom) * capture.clip.scale;
}

// Every command that reached a target, by method.
function methodsOf(app: FakeCdpServer, targetId = CHART_ID): string[] {
  return app.calls.filter((call) => call.targetId === targetId).map((call) => call.method);
}

function screen(options: FakeScreenOptions, from = fixture) {
  return createFakeTvWindow(from, { screen: options });
}

// An answer to a capture with a picture of the given size, whatever was asked for.
function picture(format: 'png' | 'jpeg', width: number, height: number): Handlers {
  return { 'Page.captureScreenshot': () => ({ data: solidImage(format, width, height) }) };
}

describe('screenshot_capture', () => {
  test('screenshot_capture returns the chart container as a png, with its size in pixels', async () => {
    const { client, app } = await startHarness();

    const result = await callTool(client, 'screenshot_capture');

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toStrictEqual({
      ok: true,
      data: {
        target: 'chart',
        format: 'png',
        width: 1180,
        height: 640,
        bytes: bytesOf(result).length,
      },
      meta: { via: 'cdp', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expectImage(result, { width: 1180, height: 640 });
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
    expectImage(result, { width: 800, height: 500 });
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

      expect(capturesOf(app, targetId)).toEqual([
        { format: 'png', captureBeyondViewport: false, clip },
      ]);
      expectImage(result, size);
    },
  );

  test('a capture that is narrower than maxWidth is not scaled up', async () => {
    const win = screen({ width: 1600, height: 1000, devicePixelRatio: 2 });
    const { client, app } = await startHarness({ win });

    // 1600 CSS pixels are 3200 device pixels: 4000 leaves room.
    const result = await callTool(client, 'screenshot_capture', { target: 'page', maxWidth: 4000 });

    expect(capturesOf(app)).toEqual([{ format: 'png', captureBeyondViewport: false }]);
    expectImage(result, { width: 3200, height: 2000 });
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
    expectImage(second, { width: 600, height: 500 });
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

    expect(dataOf(page)).toMatchObject({ target: 'page' });
    expect(dataOf(chrome)).toMatchObject({ target: 'window' });
    expectImage(page, { width: 1280, height: 720 });
    expectImage(chrome, { width: 1280, height: 34 });
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
    // The image is labelled with the format it was asked in, and is one.
    expect(jpeg.content[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
    expect(png.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(byDefault.content[0]).toMatchObject({ mimeType: 'image/png' });
    expect(bytesOf(jpeg).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(bytesOf(png).subarray(1, 4).toString('latin1')).toBe('PNG');
    expectImage(jpeg, { width: 1280, height: 720 });
    expect(dataOf(jpeg)).toMatchObject({ format: 'jpeg' });
    expect(dataOf(chartJpeg)).toMatchObject({ target: 'chart', format: 'jpeg' });
  });

  test('the image block comes before the JSON block and the JSON carries no base64', async () => {
    const { client } = await startHarness();

    const result = await callTool(client, 'screenshot_capture', { target: 'page' });

    expect(result.content.map((block) => block.type)).toEqual(['image', 'text']);
    expect(imageOf(result)).toMatchObject({ mimeType: 'image/png' });
    // The text block and the structured content are the same envelope, and neither holds the picture.
    expect(JSON.parse(textOf(result))).toStrictEqual(result.structuredContent);
    expect(textOf(result)).not.toContain(imageOf(result).data);
    expect(JSON.stringify(result.structuredContent)).not.toContain(imageOf(result).data);
    expect(dataOf(result)).toStrictEqual({
      target: 'page',
      format: 'png',
      width: 1280,
      height: 720,
      bytes: bytesOf(result).length,
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
      const { client } = await startHarness({ chromeWindow: chromeOf(1280, 34, 1) });

      // The layout has one chart, so 5 would be refused for the chart target.
      const result = await callTool(client, 'screenshot_capture', { target, chartIndex: 5 });

      expect(result.isError).not.toBe(true);
      expect(warningsOf(result)).toEqual([
        `chartIndex only applies to target "chart", so it was ignored for target "${target}".`,
      ]);
    },
  );

  test('screenshot_capture only reads: the commands it sends are layout reads and the capture', async () => {
    const win = createFakeTvWindow(twoCharts, { screen: { charts: [LEFT, RIGHT] } });
    const { client, app } = await startHarness({ win });

    await callTool(client, 'screenshot_capture', { target: 'page' });
    // Whether the tab is shown, the layout metrics, the capture.
    expect(methodsOf(app)).toEqual([
      'Runtime.evaluate',
      'Page.getLayoutMetrics',
      'Page.captureScreenshot',
    ]);

    app.calls.length = 0;
    await callTool(client, 'screenshot_capture');
    // The container of the active chart and whether its tab is shown, the layout metrics, the
    // capture.
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

  test('the picture reaches the client and nothing else: it is not logged or put into an event', async () => {
    const { logger, lines } = capturingLogger();
    const { client, events } = await startHarness({ logger });

    const result = await callTool(client, 'screenshot_capture', { target: 'page' });
    const jpeg = await callTool(client, 'screenshot_capture', { target: 'page', format: 'jpeg' });
    await callTool(client, 'screenshot_capture', { chartIndex: 4 });

    expect(result.content[0]).toMatchObject({ type: 'image' });
    expect(lines.length).toBeGreaterThan(0);
    for (const seen of [JSON.stringify(lines), JSON.stringify(events())]) {
      expect(seen).not.toContain(imageOf(result).data);
      expect(seen).not.toContain(imageOf(jpeg).data);
    }
    expect(events().map(({ tool }) => tool)).toEqual(Array(6).fill('screenshot_capture'));
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
    for (const block of result.content.slice(0, 2)) {
      if (block.type === 'image') {
        expect(textOf(result)).not.toContain(block.data);
      }
    }
  });
});

describe('screenshot_capture at a page zoom other than 100%', () => {
  // The same window of 1600 by 1000 DIPs on a display with two device pixels for each DIP, at three
  // zooms: the page lays out more or fewer CSS pixels in it and says so with its pixel ratio, which
  // has the zoom in it. A chart sits at the same place of the window at each of them.
  const WINDOWS = [
    {
      zoom: 0.5,
      size: { width: 3200, height: 2000, devicePixelRatio: 1, zoom: 0.5 },
      chart: { x: 160, y: 100, width: 2500, height: 1500 },
    },
    {
      zoom: 1,
      size: { width: 1600, height: 1000, devicePixelRatio: 2, zoom: 1 },
      chart: { x: 80, y: 50, width: 1250, height: 750 },
    },
    {
      zoom: 1.25,
      size: { width: 1280, height: 800, devicePixelRatio: 2.5, zoom: 1.25 },
      chart: { x: 64, y: 40, width: 1000, height: 600 },
    },
  ];

  test.each(WINDOWS)(
    'at a zoom of $zoom the page is clipped in DIPs, so that the image is as wide as maxWidth',
    async ({ size }) => {
      const { client, app } = await startHarness({ win: screen(size) });

      const result = await callTool(client, 'screenshot_capture', {
        target: 'page',
        maxWidth: 800,
      });

      // The window is 1600 by 1000 DIPs whatever the zoom: that is what the clip asks for.
      expect(capturesOf(app)).toEqual([
        {
          format: 'png',
          captureBeyondViewport: false,
          clip: { x: 0, y: 0, width: 1600, height: 1000, scale: 0.25 },
        },
      ]);
      expectImage(result, { width: 800, height: 500 });
    },
  );

  test.each(WINDOWS)(
    'at a zoom of $zoom the chart is clipped in DIPs, so that the image is as wide as maxWidth',
    async ({ size, chart }) => {
      const { client, app } = await startHarness({ win: screen({ ...size, charts: [chart] }) });

      const result = await callTool(client, 'screenshot_capture', { maxWidth: 800 });

      // The chart is at 80, 50 and 1250 by 750 DIPs of the window at every zoom.
      expect(capturesOf(app)).toEqual([
        {
          format: 'png',
          captureBeyondViewport: false,
          clip: { x: 80, y: 50, width: 1250, height: 750, scale: 0.32 },
        },
      ]);
      expectImage(result, { width: 800, height: 480 });
    },
  );

  test.each(WINDOWS)(
    'at a zoom of $zoom the whole page without a clip is as big as the window in device pixels',
    async ({ size }) => {
      const { client, app } = await startHarness({ win: screen(size) });

      const result = await callTool(client, 'screenshot_capture', {
        target: 'page',
        maxWidth: 4000,
      });

      expect(capturesOf(app)).toEqual([{ format: 'png', captureBeyondViewport: false }]);
      expectImage(result, { width: 3200, height: 2000 });
    },
  );

  test('a page zoomed out never makes an image wider than maxWidth, which a clip in CSS pixels would', async () => {
    const win = screen({ width: 3200, height: 2000, devicePixelRatio: 1, zoom: 0.5 });
    const { client, app } = await startHarness({ win });

    const result = await callTool(client, 'screenshot_capture', { target: 'page', maxWidth: 800 });

    const [capture] = capturesOf(app);
    // The 3200 CSS pixels of the page are 1600 DIPs, and that is the width of the clip. Had it been
    // 3200, the image would have been 1600 pixels wide.
    expect(capture?.clip?.width).toBe(1600);
    expect(widthOfClip(capture, 1, 0.5)).toBeLessThanOrEqual(800);
    expectImage(result, { width: 800, height: 500 });
  });
});

describe('screenshot_capture on a page that is scrolled', () => {
  test('the clip of a chart starts where the chart is in the page, and not in the viewport', async () => {
    const win = screen({
      width: 1280,
      height: 720,
      devicePixelRatio: 2,
      scrollX: 100,
      scrollY: 200,
      charts: [{ x: 50, y: 40, width: 600, height: 500 }],
    });
    const { client, app } = await startHarness({ win });

    const result = await callTool(client, 'screenshot_capture');

    expect(capturesOf(app).map((capture) => capture.clip)).toEqual([
      { x: 150, y: 240, width: 600, height: 500, scale: 1 },
    ]);
    expectImage(result, { width: 1200, height: 1000 });
  });

  test('the clip of the page starts where the visible part is in the page', async () => {
    const win = screen({
      width: 1280,
      height: 720,
      devicePixelRatio: 2,
      scrollX: 100,
      scrollY: 200,
    });
    const { client, app } = await startHarness({ win });

    const result = await callTool(client, 'screenshot_capture', { target: 'page', maxWidth: 800 });

    expect(capturesOf(app).map((capture) => capture.clip)).toEqual([
      { x: 100, y: 200, width: 1280, height: 720, scale: 0.3125 },
    ]);
    expectImage(result, { width: 800, height: 450 });
  });

  test('the offset of the page is scaled by the zoom with the rest of the clip', async () => {
    const win = screen({
      width: 1280,
      height: 800,
      devicePixelRatio: 2.5,
      zoom: 1.25,
      scrollX: 100,
      scrollY: 200,
      charts: [{ x: 64, y: 40, width: 1000, height: 600 }],
    });
    const { client, app } = await startHarness({ win });

    const result = await callTool(client, 'screenshot_capture');

    // 1000 CSS pixels at 2.5 are 2500 device pixels, and the default cap brings them to 1920.
    expect(capturesOf(app).map((capture) => capture.clip)).toEqual([
      { x: 205, y: 300, width: 1250, height: 750, scale: 0.768 },
    ]);
    expectImage(result, { width: 1920, height: 1152 });
  });
});

describe('screenshot_capture on a chart that is not entirely in the viewport', () => {
  test('a chart that reaches over the right and the bottom is cut to the viewport, and the result says so', async () => {
    const win = screen({ charts: [{ x: 50, y: 40, width: 1400, height: 800 }] });
    const { client, app } = await startHarness({ win });

    const result = await callTool(client, 'screenshot_capture');

    expect(capturesOf(app).map((capture) => capture.clip)).toEqual([
      { x: 50, y: 40, width: 1230, height: 680, scale: 1 },
    ]);
    expectImage(result, { width: 1230, height: 680 });
    expect(warningsOf(result)).toEqual([
      'Part of the chart is outside the visible part of the page, so the image shows only the part ' +
        'that is visible.',
    ]);
  });

  test('a chart that reaches over the left and the top is cut as well, at a scale and a zoom', async () => {
    const win = screen({
      width: 1280,
      height: 800,
      devicePixelRatio: 2.5,
      zoom: 1.25,
      charts: [{ x: -80, y: -40, width: 1080, height: 800 }],
    });
    const { client, app } = await startHarness({ win });

    const result = await callTool(client, 'screenshot_capture', { maxWidth: 800 });

    // 1000 by 760 CSS pixels of it are in the viewport, which are 1250 by 950 DIPs.
    expect(capturesOf(app).map((capture) => capture.clip)).toEqual([
      { x: 0, y: 0, width: 1250, height: 950, scale: 0.32 },
    ]);
    expectImage(result, { width: 800, height: 608 });
    expect(warningsOf(result)).toHaveLength(1);
    expect(warningsOf(result)?.[0]).toMatch(/outside the visible part/);
  });

  test('a chart that is inside the viewport raises no warning, and neither does one that fills it', async () => {
    const inside = await startHarness({
      win: screen({ charts: [{ x: 1, y: 2, width: 30, height: 40 }] }),
    });
    const fills = await startHarness({
      win: screen({ charts: [{ x: 0, y: 0, width: 1280, height: 720 }] }),
    });

    const first = await callTool(inside.client, 'screenshot_capture');
    const second = await callTool(fills.client, 'screenshot_capture');

    expect(warningsOf(first)).toEqual([]);
    expect(warningsOf(second)).toEqual([]);
    expectImage(second, { width: 1280, height: 720 });
  });

  test.each([
    ['right of', { x: 1300, y: 40, width: 100, height: 100 }],
    ['below', { x: 40, y: 800, width: 100, height: 100 }],
    ['left of', { x: -300, y: 40, width: 100, height: 100 }],
    ['above', { x: 40, y: -300, width: 100, height: 100 }],
  ])(
    'a chart %s the viewport fails NOT_AVAILABLE, and nothing is captured',
    async (_where, chart) => {
      const { client, app } = await startHarness({ win: screen({ charts: [chart] }) });

      const result = await callTool(client, 'screenshot_capture');

      expect(errorOf(result)).toMatchObject({
        code: 'NOT_AVAILABLE',
        message: 'The chart is outside the visible part of the page',
      });
      expect(errorOf(result)?.hint).toMatch(/in view/);
      expect(capturesOf(app)).toEqual([]);
    },
  );
});

describe('screenshot_capture on a tab that is hidden', () => {
  test.each(['chart', 'page'])(
    'the %s target fails NOT_AVAILABLE before anything is captured',
    async (target) => {
      const win = createFakeTvWindow(fixture, { visibilityState: 'hidden' });
      const { client, app } = await startHarness({ win });

      const result = await callTool(client, 'screenshot_capture', { target });

      expect(result.isError).toBe(true);
      expect(errorOf(result)).toMatchObject({
        code: 'NOT_AVAILABLE',
        message: 'The chart tab is hidden',
      });
      expect(errorOf(result)?.hint).toMatch(/front/);
      // Only the page was asked, whether it is shown: not its layout, and nothing was captured.
      expect(methodsOf(app)).toEqual(['Runtime.evaluate']);
      expect(capturesOf(app)).toEqual([]);
    },
  );

  test('a tab that turns visible again can be captured', async () => {
    const win = createFakeTvWindow(fixture, { visibilityState: 'hidden' });
    const { client } = await startHarness({ win });
    const hidden = await callTool(client, 'screenshot_capture', { target: 'page' });

    inspectFakeWindow(win).state.visibilityState = 'visible';
    const shown = await callTool(client, 'screenshot_capture', { target: 'page' });

    expect(hidden.isError).toBe(true);
    expectImage(shown, { width: 1280, height: 720 });
  });

  test('the window chrome does not depend on the chart tab being in front', async () => {
    const win = createFakeTvWindow(fixture, { visibilityState: 'hidden' });
    const { client, app } = await startHarness({ win, chromeWindow: chromeOf(1280, 34, 1) });

    const result = await callTool(client, 'screenshot_capture', { target: 'window' });

    expectImage(result, { width: 1280, height: 34 });
    expect(methodsOf(app, CHART_ID)).toEqual([]);
  });
});

describe('screenshot_capture and the size of the image', () => {
  test('without maxWidth an image is at most 1920 pixels wide', async () => {
    const win = screen({
      width: 1600,
      height: 1000,
      devicePixelRatio: 2,
      charts: [{ x: 52, y: 44, width: 1403, height: 757 }],
    });
    const { client, app } = await startHarness({ win });

    const page = await callTool(client, 'screenshot_capture', { target: 'page' });
    const chart = await callTool(client, 'screenshot_capture', { target: 'chart' });

    // 3200 and 2806 device pixels, brought to 1920.
    expect(capturesOf(app).map((capture) => capture.clip)).toEqual([
      { x: 0, y: 0, width: 1600, height: 1000, scale: 0.6 },
      { x: 52, y: 44, width: 1403, height: 757, scale: 1920 / 2806 },
    ]);
    expectImage(page, { width: DEFAULT_MAX_WIDTH, height: 1200 });
    expectImage(chart, { width: DEFAULT_MAX_WIDTH, height: 1036 });
  });

  test('a capture under 1920 pixels wide is left as it is when maxWidth is left out', async () => {
    const { client, app } = await startHarness({ chromeWindow: chromeOf(1280, 34, 1) });

    const page = await callTool(client, 'screenshot_capture', { target: 'page' });
    const chrome = await callTool(client, 'screenshot_capture', { target: 'window' });

    expectImage(page, { width: 1280, height: 720 });
    expectImage(chrome, { width: 1280, height: 34 });
    expect(capturesOf(app).concat(capturesOf(app, CHROME_ID))).toEqual([
      { format: 'png', captureBeyondViewport: false },
      { format: 'png', captureBeyondViewport: false },
    ]);
  });

  test('a maxWidth over 1920 lifts the cap', async () => {
    const win = screen({ width: 1600, height: 1000, devicePixelRatio: 2 });
    const { client } = await startHarness({ win });

    const result = await callTool(client, 'screenshot_capture', { target: 'page', maxWidth: 3000 });

    expectImage(result, { width: 3000, height: 1875 });
  });

  // A picture of a size that the fake would not make, with padding after its end to a given length.
  function paddedPng(length: number): string {
    const png = Buffer.from(solidImage('png', 1, 1), 'base64');
    return Buffer.concat([png, Buffer.alloc(length - png.length)]).toString('base64');
  }

  test('an image of exactly 8 MB is returned', async () => {
    const data = paddedPng(MAX_IMAGE_BYTES);
    const { client } = await startHarness({
      handlers: { [CHART_ID]: { 'Page.captureScreenshot': () => ({ data }) } },
    });

    const result = await callTool(client, 'screenshot_capture', { target: 'page' });

    expect(result.isError).not.toBe(true);
    expect(dataOf(result)).toMatchObject({ bytes: MAX_IMAGE_BYTES });
    expect(imageOf(result).data).toBe(data);
  });

  test('an image of more than 8 MB is refused with a hint, and not returned', async () => {
    const { client } = await startHarness({
      handlers: {
        [CHART_ID]: { 'Page.captureScreenshot': () => ({ data: paddedPng(MAX_IMAGE_BYTES + 1) }) },
      },
    });

    const result = await callTool(client, 'screenshot_capture', { target: 'page' });

    expect(result.isError).toBe(true);
    expect(result.content.map((block) => block.type)).toEqual(['text']);
    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      details: { bytes: MAX_IMAGE_BYTES + 1, maxBytes: MAX_IMAGE_BYTES },
    });
    expect(errorOf(result)?.message).toMatch(/^The image is [\d.]+ MB, over the 8 MB/);
    expect(errorOf(result)?.hint).toMatch(/jpeg/);
    expect(errorOf(result)?.hint).toMatch(/maxWidth/);
  });

  test('a refusal for size lets the next capture through, so a batch goes on with its other steps', async () => {
    let calls = 0;
    const { client } = await startHarness({
      handlers: {
        [CHART_ID]: {
          'Page.captureScreenshot': () => {
            calls += 1;
            return {
              data: calls === 1 ? paddedPng(MAX_IMAGE_BYTES + 1) : solidImage('png', 40, 30),
            };
          },
        },
      },
    });

    const result = await callTool(client, 'batch_run', {
      stopOnError: false,
      steps: [
        { tool: 'screenshot_capture', arguments: { target: 'page' } },
        { tool: 'screenshot_capture', arguments: { target: 'page' } },
      ],
    });

    expect(result.content.map((block) => block.type)).toEqual(['image', 'text']);
    expect(dataOf(result)).toMatchObject({
      completed: 2,
      steps: [
        { ok: false, error: { code: 'NOT_AVAILABLE' } },
        { ok: true, data: { width: 40, height: 30 } },
      ],
    });
  });

  test('the size of a png is read from the image, not worked out from the clip', async () => {
    const { client } = await startHarness({
      handlers: { [CHART_ID]: picture('png', 321, 123) },
    });

    const result = await callTool(client, 'screenshot_capture', { target: 'page' });

    // The page is 1280 by 720, but the picture that came back is what it is.
    expect(dataOf(result)).toMatchObject({ format: 'png', width: 321, height: 123 });
    expect(warningsOf(result)).toEqual([]);
  });

  test('the size of a jpeg is read from the image as well', async () => {
    const { client } = await startHarness({
      handlers: { [CHART_ID]: picture('jpeg', 77, 55) },
    });

    const result = await callTool(client, 'screenshot_capture', { target: 'page', format: 'jpeg' });

    expect(dataOf(result)).toMatchObject({ format: 'jpeg', width: 77, height: 55 });
    expect(warningsOf(result)).toEqual([]);
  });

  test('an image whose size cannot be read is returned with the size that was asked for, and a warning', async () => {
    const { client } = await startHarness({
      handlers: { [CHART_ID]: { 'Page.captureScreenshot': () => ({ data: 'AAAA' }) } },
    });

    const result = await callTool(client, 'screenshot_capture', { target: 'page', maxWidth: 800 });

    expect(result.isError).not.toBe(true);
    // 3 bytes, which no reader can find a size in. The size is the one worked out from the clip.
    expect(dataOf(result)).toMatchObject({ width: 800, height: 450, bytes: 3 });
    expect(warningsOf(result)).toEqual([
      'The size of the image could not be read from it, so width and height are the size that ' +
        'was asked of Chrome.',
    ]);
    expect(imageOf(result).data).toBe('AAAA');
  });

  test('a jpeg asked for but a png returned is a size that cannot be read', async () => {
    const { client } = await startHarness({ handlers: { [CHART_ID]: picture('png', 50, 40) } });

    const result = await callTool(client, 'screenshot_capture', { target: 'page', format: 'jpeg' });

    expect(dataOf(result)).toMatchObject({ format: 'jpeg', width: 1280, height: 720 });
    expect(warningsOf(result)).toHaveLength(1);
  });
});
