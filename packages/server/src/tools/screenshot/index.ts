import type { ImageContent } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { TvMcpError } from '../../core/errors.js';
import { readVisibilityState } from '../../core/tv/probes.js';
import { SELECTORS } from '../../core/tv/selectors.js';
import { readViewport } from '../../core/tv/viewport.js';
import { READ_ONLY } from '../annotations.js';
import { chartIndexInput } from '../chart/index.js';
import { resolveChartTarget } from '../chart/strategies.js';
import { defineTool, type AnyToolDefinition } from '../types.js';
import {
  captureScale,
  clampToViewport,
  clipOf,
  imageSizeOf,
  outputSize,
  type Box,
} from './mappers.js';
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
// How wide an image is at most when the caller gives no maxWidth: a screenshot of a large window on
// a 2x display is several megabytes at full size.
const DEFAULT_MAX_WIDTH = 1920;

// The most of an image that is returned. A client gets the image in one message, and batch_run can
// put the images of twenty steps into one, so the payload has a bound of its own whatever maxWidth
// allows.
const BYTES_PER_MB = 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * BYTES_PER_MB;

// The same refusal as readChartBox gives for a chart, for a capture of the page.
function tabHidden(): TvMcpError {
  return new TvMcpError('NOT_AVAILABLE', 'The chart tab is hidden', {
    hint: 'Bring the TradingView tab to the front and try again.',
  });
}

function outsideTheViewport(): TvMcpError {
  return new TvMcpError('NOT_AVAILABLE', 'The chart is outside the visible part of the page', {
    hint:
      'The chart may be scrolled out of view, or the window may be too small for the layout. ' +
      'Get the chart in view and try again.',
  });
}

function tooLarge(bytes: number): TvMcpError {
  const size = (bytes / BYTES_PER_MB).toFixed(1);
  return new TvMcpError(
    'NOT_AVAILABLE',
    `The image is ${size} MB, over the ${String(MAX_IMAGE_BYTES / BYTES_PER_MB)} MB the tool returns`,
    {
      hint: 'Use jpeg, which is smaller, or a smaller maxWidth.',
      details: { bytes, maxBytes: MAX_IMAGE_BYTES },
    },
  );
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
    'format, width and height (the pixels of the image, read from the image itself: a 2x ' +
    'display has two for each CSS pixel, so an image can be wider than the area looks) and ' +
    'bytes (the size of the encoded image). The image is a png, which keeps every pixel, or a ' +
    'jpeg of quality 80, which is smaller. maxWidth scales the image down to at most that many ' +
    'pixels wide, keeping its proportions, and never up; without it the limit is 1920 pixels, ' +
    'and a maxWidth up to 4000 lifts it. An image of more than 8 MB is refused with ' +
    'NOT_AVAILABLE: use jpeg or a smaller maxWidth. Also NOT_AVAILABLE when the chart tab is ' +
    'hidden (target chart and page), when the page has no container for the chart, when the ' +
    'container has no size because the chart is not shown (another chart is maximized), and ' +
    'when the chart is outside the visible part of the page; a chart that is partly outside it ' +
    'is cut to the part that is visible, with a warning.',
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
      .default(DEFAULT_MAX_WIDTH)
      .describe(
        'The widest the image may be, in pixels, from 100 to 4000 (default 1920). A wider ' +
          'capture is scaled down to this width, keeping its proportions, and a narrower one is ' +
          'left alone. On a 2x display a 1000 pixel wide chart is an image of 2000 pixels, so ' +
          'raise it to keep that. An image of more than 8 MB is refused whatever this is.',
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
    // What the caller asked for, in CSS pixels from the top left of the viewport: the box of the
    // chart for a chart, and the whole viewport otherwise (which takes the viewport to know).
    let chartBox: Box | undefined;
    if (target === 'chart') {
      // The index is checked against the layout before anything is looked at or captured, and
      // readChartBox refuses a hidden tab before it looks for the chart.
      const chart = await resolveChartTarget(page, chartIndex);
      const found = await page.bridge.evaluate(readChartBox, [
        chart.index,
        SELECTORS.regions.chartContainer,
      ]);
      chartBox = found.box;
      if (found.byPosition) {
        warnings.push(
          'The app did not name the container of the chart, so the chart container at the same ' +
            'position in the page was captured. It may not be the chart you meant.',
        );
      }
    } else if (
      target === 'page' &&
      (await page.bridge.evaluate(readVisibilityState, [])) === 'hidden'
    ) {
      throw tabHidden();
    }
    const viewport = await readViewport(page.session);

    // A capture does not go beyond the viewport, so a chart that reaches out of it is cut to it.
    const wanted = chartBox ?? { x: 0, y: 0, width: viewport.width, height: viewport.height };
    const visible = clampToViewport(wanted, viewport);
    if (visible === null) {
      throw outsideTheViewport();
    }
    if (visible.clamped) {
      warnings.push(
        'Part of the chart is outside the visible part of the page, so the image shows only the ' +
          'part that is visible.',
      );
    }
    const area = visible.box;
    const scale = captureScale(area.width, viewport.devicePixelRatio, maxWidth);

    // A clip is how Chrome is told which part to take and how much to scale it. Only a chart is a
    // part. The page and the window are taken as they are shown, unless they have to be scaled
    // down, and for that a clip of all of the viewport is the only way. The clip is in DIPs and in
    // the space of the page (see clipOf), which at the default zoom of an unscrolled page are the
    // CSS pixels of the viewport. That Chrome reads a clip so, and that the zoom of the metrics is
    // the DIPs in a CSS pixel, is what the protocol and the source of Chrome say; on the real app
    // only the default zoom, where it makes no difference, has been tried.
    const { data } = await page.session.send('Page.captureScreenshot', {
      format,
      ...(format === 'jpeg' ? { quality: JPEG_QUALITY } : {}),
      captureBeyondViewport: false,
      ...(chartBox !== undefined || scale < 1 ? { clip: clipOf(area, viewport, scale) } : {}),
    });
    if (data === '') {
      throw new TvMcpError('NOT_AVAILABLE', 'The page answered the capture without an image', {
        hint: 'The tab may be hidden. Bring it to the front and try again.',
      });
    }
    const encoded = Buffer.byteLength(data, 'base64');
    if (encoded > MAX_IMAGE_BYTES) {
      throw tooLarge(encoded);
    }

    // The size of the image is read from the image. What the clip works out to is the fallback, for
    // an image that does not say.
    const measured = imageSizeOf(Buffer.from(data, 'base64'), format);
    if (measured === null) {
      warnings.push(
        'The size of the image could not be read from it, so width and height are the size that ' +
          'was asked of Chrome.',
      );
    }
    const size = measured ?? outputSize(area, viewport.devicePixelRatio, scale);

    const image: ImageContent = { type: 'image', data, mimeType: MIME_TYPES[format] };
    return {
      data: { target, format, ...size, bytes: encoded },
      via: 'cdp',
      warnings,
      images: [image],
    };
  },
});

export const screenshotTools: AnyToolDefinition[] = [screenshotCapture];
