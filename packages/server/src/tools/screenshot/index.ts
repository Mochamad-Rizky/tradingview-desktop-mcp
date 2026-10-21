import type { ImageContent } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { PageHandle } from '../../core/connection.js';
import { TvMcpError } from '../../core/errors.js';
import { SELECTORS } from '../../core/tv/selectors.js';
import { READ_ONLY } from '../annotations.js';
import { chartIndexInput } from '../chart/index.js';
import { resolveChartTarget } from '../chart/strategies.js';
import { defineTool, type AnyToolDefinition } from '../types.js';
import { captureScale, outputSize, viewportOf, type Box, type Viewport } from './mappers.js';
import { readChartBox } from './page.js';

// The tool that takes a picture of the app (design spec 7, domain Screenshot). The picture is a
// capture over CDP of what is on the screen: TradingView's own screenshot functions are not used,
// because the client one draws the name of the signed-in user into the image and the server one
// uploads the picture to TradingView. The server returns the picture to the client as image
// content and keeps it nowhere: it is not written to disk, logged or put into an event.

const TARGETS = ['chart', 'page', 'window'] as const;
const FORMATS = ['png', 'jpeg'] as const;

const MIME_TYPES = { png: 'image/png', jpeg: 'image/jpeg' } as const;

// The quality Chrome compresses a jpeg with, from 1 to 100. A png has none.
const JPEG_QUALITY = 80;

const MIN_MAX_WIDTH = 100;
const MAX_MAX_WIDTH = 4000;

// The viewport of a page and the device pixels for each of its CSS pixels. The page is asked and
// not evaluated in: the window chrome has Node integration, and no page code is run in it.
async function viewportOfPage(page: PageHandle): Promise<Viewport> {
  const metrics: unknown = await page.session.send('Page.getLayoutMetrics');
  const viewport = viewportOf(metrics);
  if (viewport === null) {
    throw new TvMcpError('NOT_AVAILABLE', 'The page did not report the size of its viewport', {
      hint: 'The tab may be hidden or still loading. Bring it to the front and try again.',
    });
  }
  return viewport;
}

export const screenshotCapture = defineTool({
  name: 'screenshot_capture',
  domain: 'screenshot',
  title: 'Take a screenshot',
  description:
    'Takes a screenshot of the TradingView app, as it is on the screen, and returns it as an ' +
    'image in front of the JSON result. It changes nothing, and the server does not keep the ' +
    'picture. target chart (default) is the chart container of the active chart, or of ' +
    'chartIndex: the chart with its legend, panes and scales, without the toolbars. target page ' +
    'is the chart tab as it is shown, toolbars, side panels and open dialogs included. target ' +
    'window is the window chrome, the strip with the tabs, which shows the titles of the open ' +
    'tabs (symbols and prices). chartIndex is only used with target chart. Returns target, ' +
    'format, width and height (the pixels of the image: a 2x display has two for each CSS ' +
    'pixel, so an image can be wider than the area looks) and bytes (the size of the encoded ' +
    'image). The image is a png, which keeps every pixel, or a jpeg of quality 80, which is ' +
    'smaller. maxWidth scales the image down to at most that many pixels wide, keeping its ' +
    'proportions, and never up; without it the image has the full resolution of the display, ' +
    'which for a large window on a 2x display is several megabytes, so give maxWidth (1200, ' +
    'say) or jpeg when the picture is for looking at. NOT_AVAILABLE when the page has no ' +
    'container for the chart, or the container has no size because the chart is not shown ' +
    '(another chart is maximized, or the tab is hidden).',
  inputSchema: {
    target: z
      .enum(TARGETS)
      .default('chart')
      .describe(
        'What to capture: chart (default) is the chart container of the active chart, or of ' +
          'chartIndex; page is the chart tab as it is shown, with its toolbars, panels and ' +
          'dialogs; window is the window chrome, the strip with the tabs.',
      ),
    format: z
      .enum(FORMATS)
      .default('png')
      .describe(
        'png (default) keeps every pixel. jpeg is smaller and has a quality of 80, which is ' +
          'enough to read a chart.',
      ),
    maxWidth: z
      .number()
      .int()
      .min(MIN_MAX_WIDTH)
      .max(MAX_MAX_WIDTH)
      .optional()
      .describe(
        'The widest the image may be, in pixels, from 100 to 4000. A wider capture is scaled ' +
          'down to this width, keeping its proportions, and a narrower one is left alone. ' +
          'Without it the image has the full resolution of the display, which is twice the CSS ' +
          'pixels on a 2x display.',
      ),
    chartIndex: chartIndexInput(),
  },
  annotations: READ_ONLY,
  async handler({ target, format, maxWidth, chartIndex }, ctx) {
    const warnings: string[] = [];
    if (target !== 'chart' && chartIndex !== undefined) {
      warnings.push(
        `chartIndex only applies to target "chart", so it was ignored for target "${target}".`,
      );
    }

    const page =
      target === 'window'
        ? await ctx.connection.windowChromePage()
        : await ctx.connection.chartPage();
    let box: Box | undefined;
    if (target === 'chart') {
      // The index is checked against the layout before anything is looked at or captured.
      const chart = await resolveChartTarget(page, chartIndex);
      const found = await page.bridge.evaluate(readChartBox, [
        chart.index,
        SELECTORS.regions.chartContainer,
      ]);
      box = found.box;
      if (found.byPosition) {
        warnings.push(
          'The app did not name the container of the chart, so the chart container at the same ' +
            'position in the page was captured. It may not be the chart you meant.',
        );
      }
    }
    const viewport = await viewportOfPage(page);
    // The box of the chart container for a chart, the whole viewport for the page and the window.
    const area: Box = box ?? { x: 0, y: 0, width: viewport.width, height: viewport.height };
    const scale = captureScale(area.width, viewport.devicePixelRatio, maxWidth);

    // The clip is in CSS pixels, as the page reports them, and the size of the image is the clip
    // times the pixel ratio times the scale. That is so at the default page zoom of the app. The
    // app can zoom a page from 0.2 to 5, which makes the pixel ratio that of the display times the
    // zoom, and how Chrome reads a clip then has not been checked on the real app.
    //
    // A clip is how Chrome is told which part to take and how much to scale it. Only a chart is a
    // part. The page and the window are taken as they are shown, unless they have to be scaled
    // down, and for that a clip of all of the viewport is the only way.
    const { data } = await page.session.send('Page.captureScreenshot', {
      format,
      ...(format === 'jpeg' ? { quality: JPEG_QUALITY } : {}),
      captureBeyondViewport: false,
      ...(box !== undefined || scale < 1 ? { clip: { ...area, scale } } : {}),
    });
    if (data === '') {
      throw new TvMcpError('NOT_AVAILABLE', 'The page answered the capture without an image', {
        hint: 'The tab may be hidden. Bring it to the front and try again.',
      });
    }

    const image: ImageContent = { type: 'image', data, mimeType: MIME_TYPES[format] };
    return {
      data: {
        target,
        format,
        ...outputSize(area, viewport.devicePixelRatio, scale),
        bytes: Buffer.byteLength(data, 'base64'),
      },
      via: 'cdp',
      warnings,
      images: [image],
    };
  },
});

export const screenshotTools: AnyToolDefinition[] = [screenshotCapture];
