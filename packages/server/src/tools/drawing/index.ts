import { z } from 'zod';
import { TvMcpError } from '../../core/errors.js';
import { parseTimeInput } from '../../utils/time.js';
import { READ_ONLY } from '../annotations.js';
import { chartIndexInput, TIME_INPUT, timeInput } from '../chart/index.js';
import { pageWaitMs, resolveChartTarget } from '../chart/strategies.js';
import { defineTool, type AnyToolDefinition } from '../types.js';
import {
  creationWarnings,
  DRAWING_PROPERTY_KEYS,
  DRAWING_SHAPE_NAMES,
  DRAWING_SHAPES,
  drawingText,
  LINE_STYLES,
  notRemovedWarning,
  readStyle,
  requirePointCount,
  styleOverrides,
  toDrawingPoints,
  unreadableWarning,
  type LineStyleName,
} from './mappers.js';
import {
  createDrawing,
  readDrawing,
  readDrawingIds,
  readDrawings,
  removeDrawing,
  removeDrawings,
} from './page.js';

// The drawing tools (design spec 7, domain Drawings), all through the chart API of the app:
// createShape and createMultipointShape, getAllShapes, getShapeById and removeEntity
// (reverse-engineering notes of Plan 3, section 1).
//
// The chart holds the user's own drawings, often many of them, so the tools keep to these rules:
// a drawing goes into the undo history of TradingView like one the user drew; the point count of a
// shape is checked before anything is drawn, since TradingView checks it only after it has made
// the drawing; drawing_create reads the gate of drawings of the app (signed in, the drawings
// experiment) first and refuses rather than let TradingView open its sign-in wall or paywall;
// removing a drawing this session did not draw needs confirm: true (design spec 5.3, rule 2), and
// every removal goes through removeEntity, one drawing at a time, never removeAllShapes, which opens
// a confirmation dialog over a locked drawing. The text of the user's drawings is returned to the
// client and never logged.

const MAX_POINTS = 10;
const MAX_TEXT = 5000;
const MAX_LIST = 500;
const DEFAULT_LIST = 100;
const MAX_OFFSET = 100_000;

// #RRGGBB, rgb(r, g, b) or rgba(r, g, b, a), the forms TradingView keeps its colors in.
const COLOR_PATTERN =
  /^(?:#[0-9a-fA-F]{6}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+|1\.0+)\s*)?\))$/;

const LINE_STYLE_NAMES = Object.keys(LINE_STYLES) as [LineStyleName, ...LineStyleName[]];

const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const idInput = () =>
  z.string().min(1).max(64).describe('The id of the drawing, from drawing_list or drawing_create.');

// The shapes by the number of points they take, as the descriptions list them.
const shapesTaking = (count: number): string =>
  DRAWING_SHAPE_NAMES.filter((shape) => DRAWING_SHAPES[shape].points === count).join(', ');

export const drawingCreate = defineTool({
  name: 'drawing_create',
  domain: 'drawing',
  title: 'Create a drawing',
  description:
    'Draws on a chart, as the drawing tools of TradingView would, and returns id (for the other ' +
    'drawing tools) and shape. How many points each shape takes: ' +
    `${shapesTaking(1)} take 1; ${shapesTaking(2)} take 2; ${shapesTaking(3)} take 3. Another ` +
    'number of points fails with INVALID_INPUT, and nothing is drawn. A point is { time, price }; ' +
    'it lands on the bar at or before its time. text labels the drawing: text and note need one, ' +
    'flag, price_label and fib_retracement take none. style sets color, lineWidth, lineStyle and ' +
    'fontSize as far as the shape has them; a part of the style TradingView did not apply comes ' +
    'back as a warning, and the drawing stays. The drawing goes into the undo history of ' +
    'TradingView like one the user drew. Signed out, the call fails with AUTH_REQUIRED; where ' +
    'TradingView gates drawings on the account, or when this TradingView build cannot confirm ' +
    'the point count of the shape, with NOT_AVAILABLE; either way nothing is drawn and no dialog ' +
    'opens. drawing_remove and drawing_clear_all remove what this tool drew without confirm.',
  inputSchema: {
    shape: z.enum(DRAWING_SHAPE_NAMES).describe('What to draw, one of the curated shapes.'),
    points: z
      .array(
        z.object({
          time: timeInput().describe(`When: ${TIME_INPUT}. Without an offset a time is UTC.`),
          price: z.number().describe('The price, on the price scale of the chart.'),
        }),
      )
      .min(1)
      .max(MAX_POINTS)
      .describe('Where to draw, as many points as the shape takes (see the description).'),
    text: z
      .string()
      .min(1)
      .max(MAX_TEXT)
      .optional()
      .describe(
        'The text of the drawing: needed for text and note, refused for flag, price_label and ' +
          'fib_retracement, a label on the others. Default: none.',
      ),
    style: z
      .object({
        color: z
          .string()
          .regex(COLOR_PATTERN)
          .optional()
          .describe(
            'The color: #RRGGBB, rgb(r, g, b) or rgba(r, g, b, a). The line of a line or shape, ' +
              'the text of a text, note or price label.',
          ),
        lineWidth: z.number().int().min(1).max(4).optional().describe('The line width, 1 to 4.'),
        lineStyle: z.enum(LINE_STYLE_NAMES).optional().describe('solid, dotted or dashed.'),
        fontSize: z.number().int().min(8).max(40).optional().describe('The font size, 8 to 40.'),
      })
      .optional()
      .describe('The look of the drawing. Default: the defaults of TradingView for the shape.'),
    chartIndex: chartIndexInput(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  async handler({ shape, points, text, style, chartIndex }, ctx) {
    // All of it before the app is asked anything.
    requirePointCount(shape, points.length);
    const written = drawingText(shape, text);
    const at = points.map((point) => ({ time: parseTimeInput(point.time), price: point.price }));
    const { overrides, skipped } = styleOverrides(shape, style ?? {});
    const spec = DRAWING_SHAPES[shape];
    const page = await ctx.connection.chartPage();
    const target = await resolveChartTarget(page, chartIndex);
    const created = await page.bridge.evaluateWithLib(createDrawing, [
      target.index,
      {
        shape,
        className: spec.className,
        points: at,
        text: written,
        overrides,
        verifyCount: spec.verified ? null : spec.points,
        readKeys: [...Object.keys(overrides), ...(written === null ? [] : ['text'])],
      },
      pageWaitMs(ctx.config.callTimeoutMs),
    ]);
    ctx.session.createdDrawingIds.add(created.id);
    return {
      data: { id: created.id, shape },
      via: 'api',
      warnings: creationWarnings(shape, { overrides, skipped, text: written }, created.properties),
    };
  },
});

export const drawingList = defineTool({
  name: 'drawing_list',
  domain: 'drawing',
  title: 'List drawings',
  description:
    'Lists the drawings on a chart, a page at a time, and changes nothing. Returns total (every ' +
    'drawing on the chart) and drawings, from offset, at most limit, in the order TradingView ' +
    'keeps them: id, shape (the name of its tool, which can be one drawing_create does not ' +
    'draw), points (time in Unix seconds with timeIso, and price), text (null for none) and ' +
    'createdByServer (whether this session drew it, so that removing it needs no confirm). ' +
    'drawing_get reads the style of one drawing.',
  inputSchema: {
    chartIndex: chartIndexInput(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIST)
      .default(DEFAULT_LIST)
      .describe(
        `How many drawings at most: 1 to ${String(MAX_LIST)}, ${String(DEFAULT_LIST)} by default.`,
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .max(MAX_OFFSET)
      .default(0)
      .describe(
        'How many drawings to pass over first, 0 by default. total says how many there are.',
      ),
  },
  annotations: READ_ONLY,
  async handler({ chartIndex, limit, offset }, ctx) {
    const page = await ctx.connection.chartPage();
    const target = await resolveChartTarget(page, chartIndex);
    const read = await page.bridge.evaluate(readDrawings, [target.index, offset, limit]);
    return {
      data: {
        total: read.total,
        drawings: read.drawings.map((drawing) => ({
          id: drawing.id,
          shape: drawing.shape,
          points: toDrawingPoints(drawing.points),
          text: drawing.text,
          createdByServer: ctx.session.createdDrawingIds.has(drawing.id),
        })),
      },
      via: 'api',
      warnings: read.unreadable.length === 0 ? [] : [unreadableWarning(read.unreadable)],
    };
  },
});

export const drawingGet = defineTool({
  name: 'drawing_get',
  domain: 'drawing',
  title: 'Read a drawing',
  description:
    'Reads one drawing on a chart and changes nothing. Returns id, shape, points (time in Unix ' +
    'seconds with timeIso, and price), text (null for none), style (color, lineWidth, lineStyle ' +
    'and fontSize, each null where the drawing has none), locked (locked in TradingView, or ' +
    'locked against the user), hidden and createdByServer. An id that is not a drawing on the ' +
    'chart fails with INVALID_INPUT; take ids from drawing_list.',
  inputSchema: { id: idInput(), chartIndex: chartIndexInput() },
  annotations: READ_ONLY,
  async handler({ id, chartIndex }, ctx) {
    const page = await ctx.connection.chartPage();
    const target = await resolveChartTarget(page, chartIndex);
    const read = await page.bridge.evaluate(readDrawing, [
      target.index,
      id,
      [...DRAWING_PROPERTY_KEYS],
    ]);
    return {
      data: {
        id: read.id,
        shape: read.shape,
        points: toDrawingPoints(read.points),
        text: read.text,
        style: readStyle(read.shape, read.properties),
        locked: read.locked,
        hidden: read.hidden,
        createdByServer: ctx.session.createdDrawingIds.has(read.id),
      },
      via: 'api',
    };
  },
});

export const drawingRemove = defineTool({
  name: 'drawing_remove',
  domain: 'drawing',
  title: 'Remove a drawing',
  description:
    'Removes one drawing from a chart, the way the user could undo in TradingView, locked or ' +
    'not, and without a dialog. A drawing this session drew with drawing_create goes without ' +
    "more ado; any other one was the user's and needs confirm: true, else the call fails with " +
    'CONFIRMATION_REQUIRED and changes nothing. Returns removed, the id. An id that is not a ' +
    'drawing on the chart fails with INVALID_INPUT; take ids from drawing_list.',
  inputSchema: {
    id: idInput(),
    confirm: z
      .boolean()
      .optional()
      .describe(
        "Must be true to remove a drawing this session did not draw, which was the user's. Not " +
          'needed for drawings made with drawing_create in this session.',
      ),
    chartIndex: chartIndexInput(),
  },
  annotations: DESTRUCTIVE,
  async handler({ id, confirm, chartIndex }, ctx) {
    const page = await ctx.connection.chartPage();
    const target = await resolveChartTarget(page, chartIndex);
    const confirmed = confirm === true || ctx.session.createdDrawingIds.has(id);
    // Unconfirmed, this only checks that the drawing is there, so an unknown id is reported first.
    const { removed, shape } = await page.bridge.evaluate(removeDrawing, [
      target.index,
      id,
      confirmed,
    ]);
    if (!removed) {
      throw new TvMcpError(
        'CONFIRMATION_REQUIRED',
        `Removing the ${shape} drawing ${id} needs confirmation: this session did not draw it`,
        {
          hint:
            "The drawing was on the chart before, so it is the user's. Make sure the user wants " +
            'it gone, then call drawing_remove again with confirm: true.',
          details: { id, shape },
        },
      );
    }
    ctx.session.createdDrawingIds.delete(id);
    return { data: { removed: id }, via: 'api' };
  },
});

export const drawingClearAll = defineTool({
  name: 'drawing_clear_all',
  domain: 'drawing',
  title: 'Remove drawings',
  description:
    'Removes drawings from a chart, one by one, the way the user could undo each in ' +
    'TradingView, locked ones included, and without a dialog. scope created_by_mcp removes only ' +
    'the drawings this session drew that are on the chart; scope all removes every drawing ' +
    "drawing_list reports, the user's own among them, and needs confirm: true, else the call " +
    'fails with CONFIRMATION_REQUIRED (error.details says how many drawings there are, and how ' +
    'many this session drew) and changes nothing. Returns removed, how many drawings went, and ' +
    'failed, the ids of drawings TradingView kept.',
  inputSchema: {
    scope: z
      .enum(['created_by_mcp', 'all'])
      .describe(
        "created_by_mcp for the drawings this session drew, all for every drawing, the user's " +
          'too.',
      ),
    confirm: z
      .boolean()
      .optional()
      .describe('Must be true with scope all. Not needed for scope created_by_mcp.'),
    chartIndex: chartIndexInput(),
  },
  annotations: DESTRUCTIVE,
  async handler({ scope, confirm, chartIndex }, ctx) {
    const page = await ctx.connection.chartPage();
    const target = await resolveChartTarget(page, chartIndex);
    if (scope === 'all' && confirm !== true) {
      const { ids } = await page.bridge.evaluate(readDrawingIds, [target.index]);
      const own = ids.filter((id) => ctx.session.createdDrawingIds.has(id)).length;
      throw new TvMcpError(
        'CONFIRMATION_REQUIRED',
        `Removing every drawing of the chart needs confirmation: ${String(ids.length - own)} of ` +
          `the ${String(ids.length)} were not drawn by this session`,
        {
          hint:
            "Drawings this session did not draw are the user's. Make sure the user wants every " +
            'drawing gone, then call drawing_clear_all again with confirm: true; scope ' +
            'created_by_mcp removes only the drawings this session drew.',
          details: { scope, total: ids.length, createdByServer: own },
        },
      );
    }
    const { removed, failed } = await page.bridge.evaluate(removeDrawings, [
      target.index,
      scope === 'all' ? null : [...ctx.session.createdDrawingIds],
    ]);
    for (const id of removed) {
      ctx.session.createdDrawingIds.delete(id);
    }
    return {
      data: { removed: removed.length, failed },
      via: 'api',
      warnings: failed.length === 0 ? [] : [notRemovedWarning(failed)],
    };
  },
});

// In the order of the catalog (design spec 7).
export const drawingTools: AnyToolDefinition[] = [
  drawingCreate,
  drawingList,
  drawingGet,
  drawingRemove,
  drawingClearAll,
];
