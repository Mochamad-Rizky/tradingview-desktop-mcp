import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TvWindow } from '../../src/core/tv/tv-window.js';
import { callTool } from '../helpers/mcp-client.js';
import {
  callFailure,
  e2eEnabled,
  observe,
  readChartVisibility,
  readWindowVisibility,
  sameJson,
  startE2eServer,
  type E2eServer,
  type ToolFailure,
} from './setup.js';

// screenshot_capture against the real TradingView Desktop. A capture shows the user's chart, prices
// and, for the window, the titles of the tabs, and the chart's own header draws the name of the
// account: the tests read the size of an image and never keep, save or print the image itself. A
// capture changes nothing, which the tests check by the box of the chart and its view.

interface Capture {
  target: string;
  format: string;
  width: number;
  height: number;
  bytes: number;
}

// The box of the active chart's container in CSS pixels, the pixel ratio of the page, its zoom (the
// outer width over the inner one) and how far it is scrolled, and the logical range of the time
// scale: what a capture must leave as it is. It only reads.
function readChartBox(win: TvWindow): {
  box: { x: number; y: number; width: number; height: number } | null;
  devicePixelRatio: number;
  zoom: number | null;
  scrolled: boolean;
  view: { left: number; right: number } | null;
} {
  const container = (win.document as unknown as Document).querySelector(
    '.chart-container.active[data-qa-id="chart-container"], [data-qa-id="chart-container"]',
  );
  const rect = container?.getBoundingClientRect();
  let view: { left: number; right: number } | null;
  try {
    const range = (
      win.TradingViewApi?.activeChart()._chartWidget?.model().model().timeScale() as unknown as {
        logicalRange(): { left(): number; right(): number } | null;
      }
    ).logicalRange();
    view = range === null ? null : { left: range.left(), right: range.right() };
  } catch {
    view = null;
  }
  const page = win as unknown as {
    innerWidth: number;
    outerWidth: number;
    scrollX: number;
    scrollY: number;
    devicePixelRatio: number;
  };
  return {
    box:
      rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    devicePixelRatio: page.devicePixelRatio,
    zoom: page.innerWidth > 0 ? page.outerWidth / page.innerWidth : null,
    scrolled: page.scrollX !== 0 || page.scrollY !== 0,
    view,
  };
}

// The image of a capture, checked without keeping it: its type and whether it has data.
function imageOf(result: CallToolResult): { mimeType: string; hasData: boolean } | null {
  const image = result.content.find((block) => block.type === 'image');
  return image?.type === 'image'
    ? { mimeType: image.mimeType, hasData: image.data.length > 0 }
    : null;
}

function captureOf(result: CallToolResult): Capture {
  const envelope = result.structuredContent as { ok: boolean; data?: Capture; error?: ToolFailure };
  if (result.isError === true || envelope.data === undefined) {
    throw new Error(`screenshot_capture failed with ${envelope.error?.code ?? 'UNKNOWN'}`);
  }
  return envelope.data;
}

describe.skipIf(!e2eEnabled())('screenshot_capture against TradingView Desktop', () => {
  let e2e: E2eServer | undefined;

  beforeAll(async () => {
    e2e = await startE2eServer();
  });

  afterAll(async () => {
    await e2e?.close();
  });

  function server(): E2eServer {
    if (e2e === undefined) {
      throw new Error('The server did not start');
    }
    return e2e;
  }

  async function chartBox() {
    const page = await server().ctx.connection.chartPage();
    return page.bridge.evaluate(readChartBox, []);
  }

  // Skips the test while the chart tab is hidden (its window covered or minimized), after checking
  // that the capture refuses then, which is what the tool does for a hidden tab.
  async function skipWhileHidden(
    context: { skip: (note?: string) => void },
    target: 'chart' | 'page',
  ): Promise<boolean> {
    const { client, ctx } = server();
    if ((await readChartVisibility(ctx)) !== 'hidden') {
      return false;
    }
    const refused = await callFailure(client, 'screenshot_capture', { target });
    expect(refused.code).toBe('NOT_AVAILABLE');
    observe(`screenshot_capture of target ${target} while the chart tab is hidden`, {
      code: refused.code,
      windowChrome: await readWindowVisibility(ctx),
    });
    context.skip(
      'The chart tab is hidden (the TradingView window is covered or minimized), so ' +
        'screenshot_capture refuses, as checked; the capture itself needs the window in view',
    );
    return true;
  }

  test('captures the chart as a png the size of its container, changing nothing', async (context) => {
    if (await skipWhileHidden(context, 'chart')) {
      return;
    }
    const { client } = server();
    const before = await chartBox();
    const result = await callTool(client, 'screenshot_capture', {});
    const capture = captureOf(result);
    const after = await chartBox();
    expect(imageOf(result)).toEqual({ mimeType: 'image/png', hasData: true });
    expect(capture.target).toBe('chart');
    expect(capture.format).toBe('png');
    expect(capture.bytes).toBeGreaterThan(0);
    const box = before.box;
    expect(box).not.toBeNull();
    if (box !== null) {
      const full = box.width * before.devicePixelRatio;
      const scale = Math.min(1, 1920 / full);
      expect(Math.abs(capture.width - Math.round(full * scale))).toBeLessThanOrEqual(2);
      expect(
        Math.abs(capture.height - Math.round(box.height * before.devicePixelRatio * scale)),
      ).toBeLessThanOrEqual(2);
    }
    expect(sameJson(after.box, before.box), 'the chart keeps its box').toBe(true);
    expect(sameJson(after.view, before.view), 'the chart keeps its view').toBe(true);
    observe('screenshot of the chart', {
      width: capture.width,
      height: capture.height,
      bytes: capture.bytes,
      cssBox: box === null ? null : { width: box.width, height: box.height },
      devicePixelRatio: before.devicePixelRatio,
      zoom: before.zoom,
      scrolled: before.scrolled,
      relayout: !sameJson(after.box, before.box) || !sameJson(after.view, before.view),
      warnings:
        (result.structuredContent as { meta?: { warnings?: string[] } }).meta?.warnings ?? [],
    });
  });

  test('captures the page as a jpeg within maxWidth', async (context) => {
    if (await skipWhileHidden(context, 'page')) {
      return;
    }
    const { client } = server();
    const result = await callTool(client, 'screenshot_capture', {
      target: 'page',
      format: 'jpeg',
      maxWidth: 800,
    });
    const capture = captureOf(result);
    expect(imageOf(result)).toEqual({ mimeType: 'image/jpeg', hasData: true });
    expect(capture.width).toBeLessThanOrEqual(800);
    expect(capture.height).toBeGreaterThan(0);
    observe('screenshot of the page', {
      width: capture.width,
      height: capture.height,
      bytes: capture.bytes,
    });
  });

  test('captures the window chrome', async (context) => {
    const { client, ctx } = server();
    const visibility = await readWindowVisibility(ctx);
    const startedAt = performance.now();
    const result = await callTool(client, 'screenshot_capture', { target: 'window' });
    const ms = Math.round(performance.now() - startedAt);
    if (visibility !== 'visible') {
      // What a capture of a covered or minimized window gives, recorded either way.
      const envelope = result.structuredContent as { data?: Capture; error?: ToolFailure };
      observe('screenshot of the window chrome while it is out of view', {
        visibility,
        ok: result.isError !== true,
        code: envelope.error?.code ?? null,
        height: envelope.data?.height ?? null,
        ms,
      });
      return context.skip(
        'The TradingView window is out of view (its window chrome reports hidden), so what a ' +
          'capture of it shows is only recorded',
      );
    }
    const capture = captureOf(result);
    expect(imageOf(result)).toEqual({ mimeType: 'image/png', hasData: true });
    expect(capture.target).toBe('window');
    expect(capture.width).toBeGreaterThan(capture.height);
    observe('screenshot of the window chrome', {
      width: capture.width,
      height: capture.height,
      bytes: capture.bytes,
      ms,
    });
  });
});
