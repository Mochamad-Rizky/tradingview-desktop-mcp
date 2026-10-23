import type { TvMcpError } from '../../../../src/core/errors.js';
import {
  creationWarnings,
  DRAWING_SHAPE_NAMES,
  drawingText,
  listed,
  notRemovedWarning,
  readStyle,
  requirePointCount,
  styleOverrides,
  toDrawingPoints,
  unreadableWarning,
  type DrawingShape,
} from '../../../../src/tools/drawing/mappers.js';

// The pure parts of the drawing tools: the curated shapes with their point counts, the rules for
// texts, the property keys a style goes to for each shape, the warnings for a style TradingView did
// not apply, and the points and style the readers report. Values are synthetic.

function thrown(run: () => unknown): TvMcpError {
  try {
    run();
  } catch (error) {
    return error as TvMcpError;
  }
  throw new Error('Expected the call to throw');
}

// The point counts of the plan, which the research notes confirm or record by convention.
const POINT_COUNTS: [DrawingShape, number][] = [
  ['horizontal_line', 1],
  ['vertical_line', 1],
  ['horizontal_ray', 1],
  ['trend_line', 2],
  ['ray', 2],
  ['extended', 2],
  ['arrow', 2],
  ['rectangle', 2],
  ['circle', 2],
  ['ellipse', 3],
  ['triangle', 3],
  ['parallel_channel', 3],
  ['fib_retracement', 2],
  ['text', 1],
  ['note', 1],
  ['price_label', 1],
  ['arrow_up', 1],
  ['arrow_down', 1],
  ['flag', 1],
];

describe('the curated shapes', () => {
  test('are the nineteen shapes of the plan', () => {
    expect([...DRAWING_SHAPE_NAMES].sort()).toEqual(POINT_COUNTS.map(([shape]) => shape).sort());
  });

  test.each(POINT_COUNTS)(
    '%s takes %i point(s), and any other count is refused',
    (shape, count) => {
      expect(() => {
        requirePointCount(shape, count);
      }).not.toThrow();
      for (const wrong of [count - 1, count + 1]) {
        const error = thrown(() => {
          requirePointCount(shape, wrong);
        });
        expect(error.code).toBe('INVALID_INPUT');
        expect(error.message).toContain(`${shape} takes ${String(count)} point`);
        expect(error.details).toEqual({ shape, expected: count, given: wrong });
      }
    },
  );
});

describe('drawingText', () => {
  test('a text and a note need a text', () => {
    for (const shape of ['text', 'note'] as const) {
      const error = thrown(() => drawingText(shape, undefined));
      expect(error.code, shape).toBe('INVALID_INPUT');
      expect(error.message).toBe(`A ${shape} drawing needs a text`);
      expect(drawingText(shape, 'Breakout')).toBe('Breakout');
    }
  });

  test('a blank text is refused, since TradingView drops an empty text drawing', () => {
    for (const shape of ['text', 'trend_line'] as const) {
      const error = thrown(() => drawingText(shape, '   '));
      expect(error.code, shape).toBe('INVALID_INPUT');
      expect(error.message).toBe('The text is blank');
    }
  });

  test('a flag, a price label and a Fibonacci retracement take no text', () => {
    for (const shape of ['flag', 'price_label', 'fib_retracement'] as const) {
      const error = thrown(() => drawingText(shape, 'x'));
      expect(error.code, shape).toBe('INVALID_INPUT');
      expect(error.message).toBe(`A ${shape} drawing takes no text`);
      expect(error.details).toEqual({ shape });
      expect(drawingText(shape, undefined)).toBeNull();
    }
  });

  test('the other shapes take a text when one is given, and none otherwise', () => {
    expect(drawingText('horizontal_line', 'Resistance')).toBe('Resistance');
    expect(drawingText('rectangle', undefined)).toBeNull();
    // Sent as it was written: a text may start or end with spaces on purpose.
    expect(drawingText('arrow_up', ' Buy zone ')).toBe(' Buy zone ');
  });
});

describe('styleOverrides', () => {
  test('a line takes linecolor, linewidth, linestyle and fontsize', () => {
    expect(
      styleOverrides('horizontal_line', {
        color: '#FF5500',
        lineWidth: 3,
        lineStyle: 'dashed',
        fontSize: 18,
      }),
    ).toEqual({
      overrides: { linecolor: '#FF5500', linewidth: 3, linestyle: 2, fontsize: 18 },
      skipped: [],
    });
    expect(styleOverrides('trend_line', { lineStyle: 'dotted' }).overrides).toEqual({
      linestyle: 1,
    });
  });

  test('a rectangle and the other shapes take color, linewidth, linestyle and fontSize', () => {
    for (const shape of ['rectangle', 'circle', 'ellipse', 'triangle'] as const) {
      expect(
        styleOverrides(shape, { color: '#00AA00', lineWidth: 1, lineStyle: 'solid', fontSize: 9 }),
        shape,
      ).toEqual({
        overrides: { color: '#00AA00', linewidth: 1, linestyle: 0, fontSize: 9 },
        skipped: [],
      });
    }
  });

  test('a text takes color and fontsize, and has no line to give a width or a style', () => {
    expect(
      styleOverrides('text', { color: '#0000FF', lineWidth: 2, lineStyle: 'dashed', fontSize: 20 }),
    ).toEqual({
      overrides: { color: '#0000FF', fontsize: 20 },
      skipped: ['lineWidth', 'lineStyle'],
    });
  });

  test('without a style there is nothing to send', () => {
    expect(styleOverrides('rectangle', {})).toEqual({ overrides: {}, skipped: [] });
  });
});

describe('creationWarnings', () => {
  test('says nothing when every property reads back as it was sent', () => {
    expect(
      creationWarnings(
        'horizontal_line',
        { overrides: { linecolor: '#FF5500', linewidth: 3 }, skipped: [], text: 'R1' },
        // A color may come back in other letters.
        { linecolor: '#ff5500', linewidth: 3, text: 'R1' },
      ),
    ).toEqual([]);
  });

  test('names a field of the style the shape has no property for', () => {
    expect(
      creationWarnings(
        'text',
        { overrides: {}, skipped: ['lineWidth', 'lineStyle'], text: 'a' },
        { text: 'a' },
      ),
    ).toEqual([
      'style.lineWidth was not applied: a text drawing has no line width.',
      'style.lineStyle was not applied: a text drawing has no line style.',
    ]);
  });

  test('names a property TradingView dropped, and one that kept another value', () => {
    expect(
      creationWarnings(
        'flag',
        { overrides: { linecolor: '#FF5500', linewidth: 3 }, skipped: [], text: null },
        { linewidth: 1 },
      ),
    ).toEqual([
      'style.color was not applied: TradingView has no linecolor property for a flag drawing.',
      'style.lineWidth was not applied: linewidth reads back as 1.',
    ]);
  });

  test('names a shape that starts with a vowel with an', () => {
    expect(
      creationWarnings(
        'ellipse',
        { overrides: { color: '#FF5500' }, skipped: [], text: null },
        { linewidth: 1 },
      ),
    ).toEqual([
      'style.color was not applied: TradingView has no color property for an ellipse drawing.',
    ]);
  });

  test('says when the text did not stick', () => {
    expect(
      creationWarnings('trend_line', { overrides: {}, skipped: [], text: 'R1' }, { text: '' }),
    ).toEqual(['The text was not applied: TradingView kept another text for the drawing.']);
  });

  test('says when the properties could not be read back', () => {
    expect(
      creationWarnings(
        'trend_line',
        { overrides: { linewidth: 2 }, skipped: [], text: null },
        null,
      ),
    ).toEqual([
      'The properties of the new drawing could not be read back, so whether its style and text ' +
        'were applied is not known.',
    ]);
    expect(
      creationWarnings('trend_line', { overrides: {}, skipped: [], text: null }, null),
    ).toEqual([]);
  });
});

describe('toDrawingPoints', () => {
  test('reports each point in Unix seconds with its ISO form', () => {
    expect(
      toDrawingPoints([
        { time: 1_709_251_200, price: 101.5 },
        { time: 1_709_337_600.5, price: 99 },
      ]),
    ).toEqual([
      { time: 1_709_251_200, timeIso: '2024-03-01T00:00:00Z', price: 101.5 },
      { time: 1_709_337_600.5, timeIso: '2024-03-02T00:00:00Z', price: 99 },
    ]);
  });

  test('leaves out a point whose time no date can hold', () => {
    expect(
      toDrawingPoints([
        { time: 1e15, price: 1 },
        { time: 1_709_251_200, price: 2 },
      ]),
    ).toEqual([{ time: 1_709_251_200, timeIso: '2024-03-01T00:00:00Z', price: 2 }]);
  });
});

describe('readStyle', () => {
  test('reads the style of each kind of shape from its own keys', () => {
    expect(
      readStyle('horizontal_line', {
        linecolor: '#FF5500',
        color: '#000000',
        linewidth: 2,
        linestyle: 1,
        fontsize: 12,
      }),
    ).toEqual({ color: '#FF5500', lineWidth: 2, lineStyle: 'dotted', fontSize: 12 });
    expect(
      readStyle('rectangle', {
        color: '#00AA00',
        linewidth: 3,
        linestyle: 2,
        fontSize: 14,
        fontsize: 99,
      }),
    ).toEqual({ color: '#00AA00', lineWidth: 3, lineStyle: 'dashed', fontSize: 14 });
    expect(readStyle('text', { color: '#0000FF', fontsize: 20, linewidth: 1 })).toEqual({
      color: '#0000FF',
      lineWidth: null,
      lineStyle: null,
      fontSize: 20,
    });
  });

  test('reads a shape outside the curated ones from whichever keys it has', () => {
    expect(
      readStyle('fib_speed_resistance_fan', { color: '#123456', linewidth: 1, fontSize: 10 }),
    ).toEqual({ color: '#123456', lineWidth: 1, lineStyle: null, fontSize: 10 });
    expect(readStyle('brush', { linecolor: '#654321', linestyle: 0 })).toEqual({
      color: '#654321',
      lineWidth: null,
      lineStyle: 'solid',
      fontSize: null,
    });
  });

  test('names the line styles the app has, and reads others and wrong types as null', () => {
    expect(readStyle('trend_line', { linestyle: 4 }).lineStyle).toBe('sparse_dotted');
    expect(readStyle('trend_line', { linestyle: 7 }).lineStyle).toBeNull();
    expect(
      readStyle('trend_line', { linecolor: 5, linewidth: '2', linestyle: '0', fontsize: true }),
    ).toEqual({ color: null, lineWidth: null, lineStyle: null, fontSize: null });
  });
});

describe('the warnings of the readers and removals', () => {
  test('list ids the way a sentence does', () => {
    expect(listed([])).toBe('');
    expect(listed(['AbC123'])).toBe('AbC123');
    expect(listed(['AbC123', 'DeF456'])).toBe('AbC123 and DeF456');
    expect(listed(['AbC123', 'DeF456', 'GhI789'])).toBe('AbC123, DeF456 and GhI789');
  });

  test('name the drawings that could not be read, one or more', () => {
    expect(unreadableWarning(['AbC123'])).toBe(
      'The drawing AbC123 could not be read, so its points and text are left out.',
    );
    expect(unreadableWarning(['AbC123', 'DeF456'])).toBe(
      'The drawings AbC123 and DeF456 could not be read, so their points and text are left out.',
    );
  });

  test('name the drawings TradingView kept, with how many there are', () => {
    expect(notRemovedWarning(['AbC123', 'DeF456'])).toBe(
      'TradingView did not remove 2 drawings: AbC123 and DeF456. drawing_list shows what is left.',
    );
  });
});
