import { z } from 'zod';
import { READ_ONLY } from '../annotations.js';
import { chartIndexInput } from '../chart/index.js';
import { resolveChartTarget } from '../chart/strategies.js';
import { defineTool, type AnyToolDefinition, type ToolContext } from '../types.js';
import { tableCellWarnings, toBoxes, toLabels, toLines, toTables } from './outputs-mappers.js';
import { readPineGraphics, type PineDrawingKind } from './outputs-page.js';

// The Pine output tools (design spec 7, domain Pine outputs): the lines, labels, boxes and tables
// that Pine scripts on a chart have drawn. They read what the app holds of them, in the graphics of
// each study, and change nothing, send no request and open nothing.

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

// The inputs the four tools share.
const outputInputs = () => ({
  studyId: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      'The id of a Pine script on the chart, from indicator_list. Default: every Pine script on ' +
        'the chart.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .default(DEFAULT_LIMIT)
    .describe(
      `How many drawings at most, in the order the description gives: 1 to ${String(MAX_LIMIT)}, ` +
        `${String(DEFAULT_LIMIT)} by default.`,
    ),
  chartIndex: chartIndexInput(),
});

// The sentences the descriptions of the tools share. What was not seen on the app (the order of
// drawings without ids, how the indices are counted, styles hidden in the settings) is said as such.
const SELECTION_TEXT =
  'Without studyId it reads every Pine script on the chart; with one (from indicator_list), only ' +
  'that script, and an id that is not on the chart or is not a Pine script fails with ' +
  'INVALID_INPUT. At most limit drawings are returned, and total is how many the scripts hold. ' +
  'The order is meant to put the newest first: by the id TradingView gives a drawing, highest ' +
  'first, when every drawing of a script has a whole-number id, and else in the reverse of the ' +
  'order TradingView keeps them in, which is not known to be the order they were drawn in; the ' +
  'drawings of a script that indicator_list lists later come first. A script that drew nothing ' +
  'gives an empty list, and a script whose drawings TradingView does not give yet is named in a ' +
  'warning. Drawings are read as the script holds them, so those of a style hidden in the ' +
  'settings of the indicator may be listed as well.';

const POINT_TEXT =
  'barIndex is the time-point index TradingView gives the bar, which grows to the right and goes ' +
  'on past the last bar into the empty space; time is Unix seconds in the bar times of ' +
  'data_get_ohlcv, with timeIso, and null when TradingView has no time for that index.';

const openEndText = (what: string) =>
  `A null barIndex means TradingView has no bar for that end, as for ${what} that runs on.`;

const idText = (name: string, example: string) =>
  `TradingView gives ${name} no id, so id is made up here from the style group of the drawing ` +
  `and its place in that group, such as ${example}, and is not stable between calls.`;

// What the script drew, read from the page, with a warning for each script it could not read.
async function readDrawings(
  kind: PineDrawingKind,
  studyId: string | undefined,
  chartIndex: number | undefined,
  ctx: ToolContext,
) {
  const page = await ctx.connection.chartPage();
  const target = await resolveChartTarget(page, chartIndex);
  const reading = await page.bridge.evaluate(readPineGraphics, [
    target.index,
    kind,
    studyId ?? null,
  ]);
  const warnings = reading.unreadable.map(
    (id) =>
      `The drawings of the study ${id} could not be read, so it adds none to the result. ` +
      'It may still be loading: try again in a moment.',
  );
  if (studyId === undefined && reading.studies.length === 0 && reading.unreadable.length === 0) {
    warnings.push('The chart has no Pine script, so there are no drawings to read.');
  }
  return { studies: reading.studies, warnings };
}

export const pineGetLines = defineTool({
  name: 'pine_get_lines',
  domain: 'pine',
  title: 'Read the lines drawn by Pine scripts',
  description:
    'Reads the lines that Pine scripts on a chart have drawn (line.new), and changes nothing. ' +
    'Returns lines, each with studyId, id (the id TradingView gives the line, as text), start ' +
    'and end (each a point: barIndex, time, timeIso and price), extend (none, left, right or ' +
    'both), color (a CSS color, null for a line without one), width and style (solid, dotted, ' +
    'dashed, arrow_left, arrow_right or arrow_both), and total. ' +
    `${POINT_TEXT} ${openEndText('a horizontal line')} ${SELECTION_TEXT}`,
  inputSchema: outputInputs(),
  annotations: READ_ONLY,
  async handler({ studyId, limit, chartIndex }, ctx) {
    const { studies, warnings } = await readDrawings('lines', studyId, chartIndex, ctx);
    return { data: toLines(studies, limit), via: 'internal', warnings };
  },
});

export const pineGetLabels = defineTool({
  name: 'pine_get_labels',
  domain: 'pine',
  title: 'Read the labels drawn by Pine scripts',
  description:
    'Reads the labels that Pine scripts on a chart have drawn (label.new), and changes nothing. ' +
    'Returns labels, each with studyId, id, barIndex, time and timeIso (the bar the label is at), ' +
    'price (null for a label above or below its bar, where TradingView ignores the price), yloc ' +
    '(above_bar, below_bar, price or auto), text, color and textColor (CSS colors, null for none), ' +
    'style (the name of the label.style_* constant without its prefix, such as label_down, ' +
    'circle, xcross or none), and total. ' +
    `${idText('labels', 'labels_a:2')} ${POINT_TEXT} ${SELECTION_TEXT}`,
  inputSchema: outputInputs(),
  annotations: READ_ONLY,
  async handler({ studyId, limit, chartIndex }, ctx) {
    const { studies, warnings } = await readDrawings('labels', studyId, chartIndex, ctx);
    return { data: toLabels(studies, limit), via: 'internal', warnings };
  },
});

export const pineGetBoxes = defineTool({
  name: 'pine_get_boxes',
  domain: 'pine',
  title: 'Read the boxes drawn by Pine scripts',
  description:
    'Reads the boxes that Pine scripts on a chart have drawn (box.new), and changes nothing. ' +
    'Returns boxes, each with studyId, id, left and right (the two ends in time: barIndex, time ' +
    'and timeIso), top and bottom (prices), extend (none, left, right or both), text, ' +
    'borderColor and bgColor (CSS colors, null for none), and total. ' +
    `${idText('boxes', 'boxes_a:2')} ${POINT_TEXT} ${openEndText('a box')} ${SELECTION_TEXT}`,
  inputSchema: outputInputs(),
  annotations: READ_ONLY,
  async handler({ studyId, limit, chartIndex }, ctx) {
    const { studies, warnings } = await readDrawings('boxes', studyId, chartIndex, ctx);
    return { data: toBoxes(studies, limit), via: 'internal', warnings };
  },
});

export const pineGetTables = defineTool({
  name: 'pine_get_tables',
  domain: 'pine',
  title: 'Read the tables drawn by Pine scripts',
  description:
    'Reads the tables that Pine scripts on a chart have drawn (table.new), and changes nothing. ' +
    'Returns tables, each with studyId, id (the id TradingView gives the table, as text), ' +
    'position (such as top_right or bottom_left), rows and columns (the size the script gave the ' +
    'table) and cells, and total, the number of tables. A cell is row, column (as TradingView ' +
    'holds them; Pine counts both from 0) and text, and the cells are listed by row and then ' +
    'column; a cell the script never set is not listed. A cell is joined to its table by the id ' +
    'of the table; one whose table the script does not have is left out, and a warning says how ' +
    'many there were. A table sits on the chart, not on a bar, so it has no bar index or time. ' +
    SELECTION_TEXT,
  inputSchema: outputInputs(),
  annotations: READ_ONLY,
  async handler({ studyId, limit, chartIndex }, ctx) {
    const { studies, warnings } = await readDrawings('tables', studyId, chartIndex, ctx);
    warnings.push(...tableCellWarnings(studies));
    return { data: toTables(studies, limit), via: 'internal', warnings };
  },
});

// In the order of the catalog (design spec 7).
export const pineOutputTools: AnyToolDefinition[] = [
  pineGetLines,
  pineGetLabels,
  pineGetBoxes,
  pineGetTables,
];
