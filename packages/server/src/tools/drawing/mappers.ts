import { TvMcpError } from '../../core/errors.js';
import { toIso } from '../../utils/time.js';

// The pure parts of the drawing tools: the curated shapes with the number of points each takes, the
// rules for texts, the property keys a style goes to for each shape, the warnings for what
// TradingView did not apply, and the points and style the readers report.

export const DRAWING_SHAPE_NAMES = [
  'horizontal_line',
  'vertical_line',
  'horizontal_ray',
  'trend_line',
  'ray',
  'extended',
  'arrow',
  'rectangle',
  'circle',
  'ellipse',
  'triangle',
  'parallel_channel',
  'fib_retracement',
  'text',
  'note',
  'price_label',
  'arrow_up',
  'arrow_down',
  'flag',
] as const;

export type DrawingShape = (typeof DRAWING_SHAPE_NAMES)[number];

export const LINE_STYLES = { solid: 0, dotted: 1, dashed: 2 } as const;

export type LineStyleName = keyof typeof LINE_STYLES;

// The style drawing_create takes. The fields admit undefined, which is what the schema gives for a
// field that is left out.
export interface DrawingStyle {
  color?: string | undefined;
  lineWidth?: number | undefined;
  lineStyle?: LineStyleName | undefined;
  fontSize?: number | undefined;
}

type StyleField = keyof DrawingStyle;

const STYLE_FIELDS: readonly StyleField[] = ['color', 'lineWidth', 'lineStyle', 'fontSize'];

const FIELD_WORDS: Record<StyleField, string> = {
  color: 'color',
  lineWidth: 'line width',
  lineStyle: 'line style',
  fontSize: 'font size',
};

// The property key each field of a style goes to (reverse-engineering notes of Plan 3, section
// 1.3), null for a field the tool has no property for. The keys of the horizontal line, the
// rectangle and the text were read on the app; the other tools follow one of them by the
// convention of the notes: the lines the horizontal line, the shapes the rectangle, and the note
// and the price label the text. The markers (arrow_up, arrow_down, flag) and fib_retracement have
// sets of their own that the notes do not know, and get the keys of a line, so that a key their
// tool lacks is dropped and reported rather than given to another property.
const STYLE_KEYS = {
  line: {
    color: 'linecolor',
    lineWidth: 'linewidth',
    lineStyle: 'linestyle',
    fontSize: 'fontsize',
  },
  shape: { color: 'color', lineWidth: 'linewidth', lineStyle: 'linestyle', fontSize: 'fontSize' },
  text: { color: 'color', lineWidth: null, lineStyle: null, fontSize: 'fontsize' },
} as const satisfies Record<string, Record<StyleField, string | null>>;

type StyleFamily = keyof typeof STYLE_KEYS;

// Whether a shape needs a text, may have one, or has no text property: TradingView removes a text
// drawing whose text is empty once it is deselected, and refuses a text for a tool without a text
// property.
type TextUse = 'required' | 'optional' | 'none';

interface DrawingShapeSpec {
  // How many points the shape takes.
  points: number;
  // The class of its tool, LineTool<Name>, for when the page has no supportedLineTools to tell.
  className: string;
  // Whether the point count was seen on the app. A count that was not is confirmed with the
  // line-tool registry of the app before anything is drawn.
  verified: boolean;
  text: TextUse;
  style: StyleFamily;
}

// A shape whose point count the notes record as seen on the app, and one they record by the
// convention of the charting library.
const seen = (
  points: number,
  className: string,
  text: TextUse,
  style: StyleFamily,
): DrawingShapeSpec => ({ points, className, verified: true, text, style });
const assumed = (
  points: number,
  className: string,
  text: TextUse,
  style: StyleFamily,
): DrawingShapeSpec => ({ points, className, verified: false, text, style });

// The curated shapes (notes, section 1.2). The line-tool registry of the app reported these point
// counts for every one of them on the app, the ellipse taking three points (two for its axis and one
// for its width); the counts not seen in a drawing stay confirmed with the registry before drawing.
// Of the texts, the notes saw the text property on the horizontal line, the rectangle and the text;
// the others are by convention, and a tool that turns out to lack the property refuses the text
// before anything is drawn.
export const DRAWING_SHAPES: Readonly<Record<DrawingShape, DrawingShapeSpec>> = {
  horizontal_line: seen(1, 'LineToolHorzLine', 'optional', 'line'),
  vertical_line: assumed(1, 'LineToolVertLine', 'optional', 'line'),
  horizontal_ray: assumed(1, 'LineToolHorzRay', 'optional', 'line'),
  trend_line: assumed(2, 'LineToolTrendLine', 'optional', 'line'),
  ray: assumed(2, 'LineToolRay', 'optional', 'line'),
  extended: assumed(2, 'LineToolExtended', 'optional', 'line'),
  arrow: assumed(2, 'LineToolArrow', 'optional', 'line'),
  rectangle: seen(2, 'LineToolRectangle', 'optional', 'shape'),
  circle: assumed(2, 'LineToolCircle', 'optional', 'shape'),
  ellipse: assumed(3, 'LineToolEllipse', 'optional', 'shape'),
  triangle: assumed(3, 'LineToolTriangle', 'optional', 'shape'),
  parallel_channel: assumed(3, 'LineToolParallelChannel', 'optional', 'line'),
  fib_retracement: assumed(2, 'LineToolFibRetracement', 'none', 'line'),
  text: seen(1, 'LineToolText', 'required', 'text'),
  note: assumed(1, 'LineToolNote', 'required', 'text'),
  price_label: assumed(1, 'LineToolPriceLabel', 'none', 'text'),
  arrow_up: assumed(1, 'LineToolArrowMarkUp', 'optional', 'line'),
  arrow_down: assumed(1, 'LineToolArrowMarkDown', 'optional', 'line'),
  flag: assumed(1, 'LineToolFlagMark', 'none', 'line'),
};

// The properties drawing_get reads for the style of a drawing: the keys of every family, since a
// drawing of the user can be of any tool.
export const DRAWING_PROPERTY_KEYS: readonly string[] = [
  'linecolor',
  'color',
  'linewidth',
  'linestyle',
  'fontsize',
  'fontSize',
];

// The names of the line styles of the app (its LINESTYLE_* constants) by value.
const LINE_STYLE_NAMES: Record<number, string> = {
  0: 'solid',
  1: 'dotted',
  2: 'dashed',
  4: 'sparse_dotted',
};

// The largest time a Date can hold, in seconds.
const MAX_DATE_SECONDS = 8.64e12;

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? '' : 's'}`;
}

function isDrawingShape(name: string): name is DrawingShape {
  return Object.hasOwn(DRAWING_SHAPES, name);
}

// "A", "A and B", "A, B and C".
export function listed(items: readonly string[]): string {
  const last = items.at(-1);
  return items.length < 2 || last === undefined
    ? items.join('')
    : `${items.slice(0, -1).join(', ')} and ${last}`;
}

// Fails with INVALID_INPUT unless `count` is how many points the shape takes. TradingView checks the
// count only after it has made the drawing, and a wrong count can leave a half-made one behind, so
// this runs before anything is sent.
export function requirePointCount(shape: DrawingShape, count: number): void {
  const expected = DRAWING_SHAPES[shape].points;
  if (count !== expected) {
    throw new TvMcpError(
      'INVALID_INPUT',
      `${shape} takes ${plural(expected, 'point')}, not ${String(count)}`,
      {
        hint:
          `Give ${shape} exactly ${plural(expected, 'point')}, each { time, price }. The ` +
          'description of drawing_create says how many points each shape takes.',
        details: { shape, expected, given: count },
      },
    );
  }
}

// The text to draw with, null for none. Fails with INVALID_INPUT for a text or note without a text,
// a text for a shape that takes none, and a blank text, which TradingView would drop. A text is
// sent as it was written.
export function drawingText(shape: DrawingShape, text: string | undefined): string | null {
  const use = DRAWING_SHAPES[shape].text;
  if (text === undefined) {
    if (use === 'required') {
      throw new TvMcpError(
        'INVALID_INPUT',
        `${capitalized(article(shape))} ${shape} drawing needs a text`,
        {
          hint:
            'TradingView removes a text drawing without a text as soon as it is deselected. Give ' +
            'the text to show.',
          details: { shape },
        },
      );
    }
    return null;
  }
  if (use === 'none') {
    throw new TvMcpError(
      'INVALID_INPUT',
      `${capitalized(article(shape))} ${shape} drawing takes no text`,
      {
        hint: 'Leave text out, or draw a text or note next to it.',
        details: { shape },
      },
    );
  }
  if (text.trim() === '') {
    throw new TvMcpError('INVALID_INPUT', 'The text is blank', {
      hint: 'Give a text with something to show, or leave text out where the shape allows it.',
      details: { shape },
    });
  }
  return text;
}

function capitalized(word: string): string {
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}

// The overrides that carry a style, by the property keys of the shape, and the fields of the style
// the shape has no property for, which are not sent.
export function styleOverrides(
  shape: DrawingShape,
  style: DrawingStyle,
): { overrides: Record<string, string | number>; skipped: StyleField[] } {
  const keys = STYLE_KEYS[DRAWING_SHAPES[shape].style];
  const values: Record<StyleField, string | number | undefined> = {
    color: style.color,
    lineWidth: style.lineWidth,
    lineStyle: style.lineStyle === undefined ? undefined : LINE_STYLES[style.lineStyle],
    fontSize: style.fontSize,
  };
  const overrides: Record<string, string | number> = {};
  const skipped: StyleField[] = [];
  for (const field of STYLE_FIELDS) {
    const value = values[field];
    if (value === undefined) {
      continue;
    }
    const key = keys[field];
    if (key === null) {
      skipped.push(field);
    } else {
      overrides[key] = value;
    }
  }
  return { overrides, skipped };
}

// A color may come back in other letters.
function sameValue(read: string | number | boolean | undefined, sent: string | number): boolean {
  return typeof read === 'string' && typeof sent === 'string'
    ? read.toLowerCase() === sent.toLowerCase()
    : read === sent;
}

// The warnings for a new drawing: a field of the style the shape has no property for, a property
// TradingView dropped (it drops a key the tool does not have without a word) or that reads back
// with another value, a text that did not stick, and properties that could not be read back at
// all. readBack holds the properties read from the new drawing, null when they could not be read.
export function creationWarnings(
  shape: DrawingShape,
  sent: {
    overrides: Readonly<Record<string, string | number>>;
    skipped: readonly StyleField[];
    text: string | null;
  },
  readBack: Readonly<Record<string, string | number | boolean>> | null,
): string[] {
  const warnings = sent.skipped.map(
    (field) =>
      `style.${field} was not applied: ${article(shape)} ${shape} drawing has no ` +
      `${FIELD_WORDS[field]}.`,
  );
  if (readBack === null) {
    if (Object.keys(sent.overrides).length > 0 || sent.text !== null) {
      warnings.push(
        'The properties of the new drawing could not be read back, so whether its style and ' +
          'text were applied is not known.',
      );
    }
    return warnings;
  }
  const keys = STYLE_KEYS[DRAWING_SHAPES[shape].style];
  for (const field of STYLE_FIELDS) {
    const key = keys[field];
    const wanted = key === null ? undefined : sent.overrides[key];
    if (key === null || wanted === undefined) {
      continue;
    }
    if (!Object.hasOwn(readBack, key)) {
      warnings.push(
        `style.${field} was not applied: TradingView has no ${key} property for ` +
          `${article(shape)} ${shape} drawing.`,
      );
    } else if (!sameValue(readBack[key], wanted)) {
      warnings.push(
        `style.${field} was not applied: ${key} reads back as ${String(readBack[key])}.`,
      );
    }
  }
  if (sent.text !== null && readBack.text !== sent.text) {
    warnings.push('The text was not applied: TradingView kept another text for the drawing.');
  }
  return warnings;
}

// The points of a drawing as the tools report them, in Unix seconds with the ISO form. A time no
// date can hold is left out.
export function toDrawingPoints(
  points: readonly { time: number; price: number }[],
): { time: number; timeIso: string; price: number }[] {
  return points
    .filter(({ time }) => Math.abs(time) <= MAX_DATE_SECONDS)
    .map(({ time, price }) => ({ time, timeIso: toIso(time), price }));
}

// The style of a drawing as drawing_get reports it, from the properties read: by the keys of its
// family for a curated shape, and else from whichever keys of every family the drawing has. A value
// of the wrong type, or a line style the app has no name for, reads as null.
export function readStyle(
  shape: string,
  properties: Readonly<Record<string, string | number | boolean>>,
): {
  color: string | null;
  lineWidth: number | null;
  lineStyle: string | null;
  fontSize: number | null;
} {
  const keys = isDrawingShape(shape) ? STYLE_KEYS[DRAWING_SHAPES[shape].style] : null;
  const text = (candidates: readonly string[]): string | null => {
    for (const key of candidates) {
      const value = properties[key];
      if (typeof value === 'string') {
        return value;
      }
    }
    return null;
  };
  const number = (candidates: readonly (string | null)[]): number | null => {
    for (const key of candidates) {
      const value = key === null ? undefined : properties[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
    }
    return null;
  };
  const lineStyle = number(keys === null ? ['linestyle'] : [keys.lineStyle]);
  return {
    color: text(keys === null ? ['linecolor', 'color'] : [keys.color]),
    lineWidth: number(keys === null ? ['linewidth'] : [keys.lineWidth]),
    lineStyle: lineStyle === null ? null : (LINE_STYLE_NAMES[lineStyle] ?? null),
    fontSize: number(keys === null ? ['fontsize', 'fontSize'] : [keys.fontSize]),
  };
}

// The warning of drawing_list for the drawings it could not read.
export function unreadableWarning(ids: readonly string[]): string {
  return ids.length === 1
    ? `The drawing ${listed(ids)} could not be read, so its points and text are left out.`
    : `The drawings ${listed(ids)} could not be read, so their points and text are left out.`;
}

// The warning of drawing_clear_all for the drawings TradingView kept.
export function notRemovedWarning(ids: readonly string[]): string {
  return (
    `TradingView did not remove ${plural(ids.length, 'drawing')}: ${listed(ids)}. drawing_list ` +
    'shows what is left.'
  );
}
