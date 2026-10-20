import {
  toBoxes,
  toLabels,
  toLines,
  toTables,
} from '../../../../src/tools/pine/outputs-mappers.js';

// How what a page reads of the drawings of Pine scripts (readPineGraphics) becomes what the output
// tools return: the names of the codes of the app, the times and their ISO forms, the ids, the
// cells of a table, and which drawings the limit keeps. Values are synthetic.

type Studies = Parameters<typeof toLines>[0];
type Study = Studies[number];
type Line = Study['lines'][number];
type Label = Study['labels'][number];
type Box = Study['boxes'][number];
type Table = Study['tables'][number];

// The time of the bar at an index of a daily series that starts on 2024-01-02.
const START = 1_704_153_600;
const DAY = 86_400;
const timeOf = (index: number): number => START + index * DAY;

// A point as the page reads it: the index, and the time of the bar at it unless one is given.
const point = (
  barIndex: number | null,
  time: number | null = barIndex === null ? null : timeOf(barIndex),
) => ({ barIndex, time });

const study = (studyId: string, drawings: Partial<Omit<Study, 'studyId'>> = {}): Study => ({
  studyId,
  lines: [],
  labels: [],
  boxes: [],
  tables: [],
  cells: [],
  ...drawings,
});

const line = (overrides: Partial<Line> = {}): Line => ({
  styleId: 'lines_a',
  id: 1,
  x1: point(10),
  y1: 100.5,
  x2: point(20),
  y2: 101.5,
  extend: 'n',
  style: 'sol',
  width: 1,
  color: '#2962FF',
  ...overrides,
});

const label = (overrides: Partial<Label> = {}): Label => ({
  styleId: 'labels_a',
  x: point(10),
  y: 100.5,
  yloc: 'pr',
  text: 'Hi',
  style: 'ldn',
  color: '#F23645',
  textColor: '#2962FF',
  ...overrides,
});

const box = (overrides: Partial<Box> = {}): Box => ({
  styleId: 'boxes_a',
  left: point(10),
  right: point(20),
  top: 102,
  bottom: 100,
  extend: 'n',
  text: 'Range',
  borderColor: '#2962FF',
  bgColor: 'rgba(8, 153, 129, 0.4)',
  ...overrides,
});

const table = (overrides: Partial<Table> = {}): Table => ({
  styleId: 'tables_a',
  id: 7,
  position: 'top_right',
  rows: 2,
  columns: 2,
  ...overrides,
});

describe('toLines', () => {
  test('lines convert bar indices to times', () => {
    const { lines, total } = toLines([study('S1', { lines: [line()] })], 100);

    expect(total).toBe(1);
    expect(lines).toStrictEqual([
      {
        studyId: 'S1',
        id: '1',
        start: { barIndex: 10, time: timeOf(10), timeIso: '2024-01-12T00:00:00Z', price: 100.5 },
        end: { barIndex: 20, time: timeOf(20), timeIso: '2024-01-22T00:00:00Z', price: 101.5 },
        extend: 'none',
        color: '#2962FF',
        width: 1,
        style: 'solid',
      },
    ]);
  });

  test('a point past the last loaded bar keeps its barIndex and a null time', () => {
    const { lines } = toLines([study('S1', { lines: [line({ x2: point(305, null) })] })], 100);

    expect(lines[0]?.end).toStrictEqual({
      barIndex: 305,
      time: null,
      timeIso: null,
      price: 101.5,
    });
    expect(lines[0]?.start.time).toBe(timeOf(10));
  });

  test('a point the app has no index for has no time either, and a line may still run on from it', () => {
    const { lines } = toLines(
      [study('S1', { lines: [line({ x1: point(null), extend: 'l' })] })],
      100,
    );

    expect(lines[0]?.start).toStrictEqual({
      barIndex: null,
      time: null,
      timeIso: null,
      price: 100.5,
    });
    expect(lines[0]?.extend).toBe('left');
  });

  test('a time that no date can show is dropped, and the barIndex stays', () => {
    const { lines } = toLines(
      [study('S1', { lines: [line({ x1: point(10, 1e20), x2: point(20, Number.NaN) })] })],
      100,
    );

    expect(lines[0]?.start).toMatchObject({ barIndex: 10, time: null, timeIso: null });
    expect(lines[0]?.end).toMatchObject({ barIndex: 20, time: null, timeIso: null });
  });

  test('a price, a width, a color or a code the page could not read stays null', () => {
    const { lines } = toLines(
      [
        study('S1', {
          lines: [
            line({ y1: null, y2: null, width: null, color: null, extend: null, style: null }),
          ],
        }),
      ],
      100,
    );

    expect(lines[0]).toMatchObject({
      start: { price: null },
      end: { price: null },
      width: null,
      color: null,
      extend: null,
      style: null,
    });
  });

  test.each([
    ['n', 'none'],
    ['l', 'left'],
    ['r', 'right'],
    ['b', 'both'],
  ])('names the extend code %s %s', (code, name) => {
    const { lines } = toLines([study('S1', { lines: [line({ extend: code })] })], 100);

    expect(lines[0]?.extend).toBe(name);
  });

  test.each([
    ['sol', 'solid'],
    ['dot', 'dotted'],
    ['dsh', 'dashed'],
    ['al', 'arrow_left'],
    ['ar', 'arrow_right'],
    ['ab', 'arrow_both'],
  ])('names the line style code %s %s', (code, name) => {
    const { lines } = toLines([study('S1', { lines: [line({ style: code })] })], 100);

    expect(lines[0]?.style).toBe(name);
  });

  test.each(['zig', 'constructor', '__proto__', 'toString', 'hasOwnProperty', ''])(
    'passes a code it does not know, %j, through unchanged',
    (code) => {
      const { lines } = toLines(
        [study('S1', { lines: [line({ extend: code, style: code })] })],
        100,
      );

      expect(lines[0]?.extend).toBe(code);
      expect(lines[0]?.style).toBe(code);
    },
  );

  test('gives JSON and nothing else', () => {
    const output = toLines([study('S1', { lines: [line({ x1: point(null) })] })], 100);

    expect(JSON.parse(JSON.stringify(output))).toStrictEqual(output);
  });
});

describe('toLabels', () => {
  test('labels map yloc above-bar and below-bar with a null price', () => {
    const { labels } = toLabels(
      [
        study('S1', {
          labels: [
            label({ yloc: 'ab', text: 'above' }),
            label({ yloc: 'bl', text: 'below' }),
            label({ yloc: 'pr', text: 'priced' }),
            label({ yloc: 'auto', text: 'auto' }),
          ],
        }),
      ],
      100,
    );

    // Newest first.
    expect(labels.map(({ text, yloc, price }) => [text, yloc, price])).toEqual([
      ['auto', 'auto', 100.5],
      ['priced', 'price', 100.5],
      ['below', 'below_bar', null],
      ['above', 'above_bar', null],
    ]);
  });

  test('reports a label with its bar, price, colors and style', () => {
    const { labels, total } = toLabels([study('S1', { labels: [label()] })], 100);

    expect(total).toBe(1);
    expect(labels).toStrictEqual([
      {
        studyId: 'S1',
        id: 'labels_a:0',
        barIndex: 10,
        time: timeOf(10),
        timeIso: '2024-01-12T00:00:00Z',
        price: 100.5,
        yloc: 'price',
        text: 'Hi',
        color: '#F23645',
        textColor: '#2962FF',
        style: 'label_down',
      },
    ]);
  });

  test('a label past the last loaded bar keeps its barIndex and a null time', () => {
    const { labels } = toLabels([study('S1', { labels: [label({ x: point(305, null) })] })], 100);

    expect(labels[0]).toMatchObject({ barIndex: 305, time: null, timeIso: null });
  });

  test('a price of a label the page could not read is null even where it would be shown', () => {
    const { labels } = toLabels(
      [study('S1', { labels: [label({ y: null, yloc: 'pr' }), label({ y: null, yloc: 'ab' })] })],
      100,
    );

    expect(labels.map(({ price }) => price)).toEqual([null, null]);
  });

  test('a yloc it does not know is passed through, and its price is the y', () => {
    const { labels } = toLabels([study('S1', { labels: [label({ yloc: 'zz' })] })], 100);

    expect(labels[0]).toMatchObject({ yloc: 'zz', price: 100.5 });
  });

  test('a yloc, text, color and style the page could not read stay null', () => {
    const { labels } = toLabels(
      [
        study('S1', {
          labels: [label({ yloc: null, text: null, color: null, textColor: null, style: null })],
        }),
      ],
      100,
    );

    expect(labels[0]).toMatchObject({
      yloc: null,
      text: null,
      color: null,
      textColor: null,
      style: null,
    });
  });

  test.each([
    ['xcr', 'xcross'],
    ['cr', 'cross'],
    ['tup', 'triangleup'],
    ['tdn', 'triangledown'],
    ['flg', 'flag'],
    ['cir', 'circle'],
    ['aup', 'arrowup'],
    ['adn', 'arrowdown'],
    ['lup', 'label_up'],
    ['ldn', 'label_down'],
    ['llf', 'label_left'],
    ['lrg', 'label_right'],
    ['lcn', 'label_center'],
    ['luplf', 'label_upper_left'],
    ['llwlf', 'label_lower_left'],
    ['luprg', 'label_upper_right'],
    ['llwrg', 'label_lower_right'],
    ['sq', 'square'],
    ['dia', 'diamond'],
    ['to', 'text_outline'],
    ['n', 'none'],
  ])('names the label style code %s %s', (code, name) => {
    const { labels } = toLabels([study('S1', { labels: [label({ style: code })] })], 100);

    expect(labels[0]?.style).toBe(name);
  });

  test('passes a label style it does not know through unchanged', () => {
    const { labels } = toLabels(
      [study('S1', { labels: [label({ style: 'constructor' }), label({ style: 'new' })] })],
      100,
    );

    expect(labels.map(({ style }) => style)).toEqual(['new', 'constructor']);
  });
});

describe('toBoxes', () => {
  test('reports a box with both ends as points, and its colors', () => {
    const { boxes, total } = toBoxes([study('S1', { boxes: [box()] })], 100);

    expect(total).toBe(1);
    expect(boxes).toStrictEqual([
      {
        studyId: 'S1',
        id: 'boxes_a:0',
        left: { barIndex: 10, time: timeOf(10), timeIso: '2024-01-12T00:00:00Z' },
        right: { barIndex: 20, time: timeOf(20), timeIso: '2024-01-22T00:00:00Z' },
        top: 102,
        bottom: 100,
        extend: 'none',
        text: 'Range',
        borderColor: '#2962FF',
        bgColor: 'rgba(8, 153, 129, 0.4)',
      },
    ]);
  });

  test('an end past the last loaded bar keeps its barIndex and a null time, an open end has none', () => {
    const { boxes } = toBoxes(
      [study('S1', { boxes: [box({ left: point(null), right: point(305, null), extend: 'l' })] })],
      100,
    );

    expect(boxes[0]).toMatchObject({
      left: { barIndex: null, time: null, timeIso: null },
      right: { barIndex: 305, time: null, timeIso: null },
      extend: 'left',
    });
  });

  test.each([
    ['n', 'none'],
    ['l', 'left'],
    ['r', 'right'],
    ['b', 'both'],
    ['zz', 'zz'],
  ])('names the extend code %s %s', (code, name) => {
    const { boxes } = toBoxes([study('S1', { boxes: [box({ extend: code })] })], 100);

    expect(boxes[0]?.extend).toBe(name);
  });

  test('a price, text and color the page could not read stay null', () => {
    const { boxes } = toBoxes(
      [
        study('S1', {
          boxes: [
            box({
              top: null,
              bottom: null,
              extend: null,
              text: null,
              borderColor: null,
              bgColor: null,
            }),
          ],
        }),
      ],
      100,
    );

    expect(boxes[0]).toMatchObject({
      top: null,
      bottom: null,
      extend: null,
      text: null,
      borderColor: null,
      bgColor: null,
    });
  });
});

describe('toTables', () => {
  test('tables gather cells by row and column', () => {
    const cells = [
      { tableId: 7, row: 1, column: 1, text: 'd' },
      { tableId: 7, row: 0, column: 1, text: 'b' },
      { tableId: 8, row: 0, column: 0, text: 'of another table' },
      { tableId: 7, row: 0, column: 0, text: 'a' },
      { tableId: 7, row: 1, column: 0, text: 'c' },
    ];

    const { tables, total } = toTables([study('S1', { tables: [table()], cells })], 100);

    expect(total).toBe(1);
    expect(tables).toStrictEqual([
      {
        studyId: 'S1',
        id: '7',
        position: 'top_right',
        rows: 2,
        columns: 2,
        cells: [
          { row: 0, column: 0, text: 'a' },
          { row: 0, column: 1, text: 'b' },
          { row: 1, column: 0, text: 'c' },
          { row: 1, column: 1, text: 'd' },
        ],
      },
    ]);
  });

  test('gives each table the cells of its own id, and none to a table without cells', () => {
    const { tables } = toTables(
      [
        study('S1', {
          tables: [table({ id: 7 }), table({ id: 8, position: 'bottom_left' }), table({ id: 9 })],
          cells: [
            { tableId: 8, row: 0, column: 0, text: 'eight' },
            { tableId: 7, row: 0, column: 0, text: 'seven' },
            { tableId: 99, row: 0, column: 0, text: 'of no table' },
          ],
        }),
      ],
      100,
    );

    expect(tables.map(({ id, cells }) => [id, cells.map(({ text }) => text)])).toEqual([
      ['9', []],
      ['8', ['eight']],
      ['7', ['seven']],
    ]);
  });

  test('a cell set twice at one place keeps the last one, as the renderer does', () => {
    const { tables } = toTables(
      [
        study('S1', {
          tables: [table()],
          cells: [
            { tableId: 7, row: 0, column: 0, text: 'first' },
            { tableId: 7, row: 1, column: 0, text: 'below' },
            { tableId: 7, row: 0, column: 0, text: 'last' },
          ],
        }),
      ],
      100,
    );

    expect(tables[0]?.cells).toEqual([
      { row: 0, column: 0, text: 'last' },
      { row: 1, column: 0, text: 'below' },
    ]);
  });

  test('leaves out a cell the page could not place, and keeps one whose text it could not read', () => {
    const { tables } = toTables(
      [
        study('S1', {
          tables: [table()],
          cells: [
            { tableId: 7, row: null, column: 0, text: 'no row' },
            { tableId: 7, row: 0, column: null, text: 'no column' },
            { tableId: null, row: 0, column: 0, text: 'no table' },
            { tableId: 7, row: 1, column: 1, text: null },
          ],
        }),
      ],
      100,
    );

    expect(tables[0]?.cells).toEqual([{ row: 1, column: 1, text: null }]);
  });

  test('a table the page could not read keeps its nulls', () => {
    const { tables } = toTables(
      [study('S1', { tables: [table({ position: null, rows: null, columns: null })] })],
      100,
    );

    expect(tables[0]).toMatchObject({ position: null, rows: null, columns: null, cells: [] });
  });

  test('counts tables, not cells', () => {
    const cells = Array.from({ length: 6 }, (_, column) => ({
      tableId: 7,
      row: 0,
      column,
      text: String(column),
    }));

    const { tables, total } = toTables([study('S1', { tables: [table()], cells })], 1);

    expect(total).toBe(1);
    expect(tables[0]?.cells).toHaveLength(6);
  });

  test('the cells of the table of one study never go to a table of another', () => {
    const { tables } = toTables(
      [
        study('S1', {
          tables: [table({ id: 7 })],
          cells: [{ tableId: 7, row: 0, column: 0, text: 'one' }],
        }),
        study('S2', {
          tables: [table({ id: 7 })],
          cells: [{ tableId: 7, row: 0, column: 0, text: 'two' }],
        }),
      ],
      100,
    );

    expect(tables.map(({ studyId, cells }) => [studyId, cells[0]?.text])).toEqual([
      ['S2', 'two'],
      ['S1', 'one'],
    ]);
  });
});

describe('ids', () => {
  test('a line keeps the id of the app, written as text', () => {
    const { lines } = toLines(
      [study('S1', { lines: [line({ id: 101 }), line({ id: 102 })] })],
      100,
    );

    expect(lines.map(({ id }) => id)).toEqual(['102', '101']);
  });

  test('a drawing without an id is named by its style and its place among the drawings of that style', () => {
    const { labels } = toLabels(
      [
        study('S1', {
          labels: [
            label({ styleId: 'labels_a', text: 'a0' }),
            label({ styleId: 'labels_a', text: 'a1' }),
            label({ styleId: 'labels_b', text: 'b0' }),
            label({ styleId: 'labels_a', text: 'a2' }),
          ],
        }),
      ],
      100,
    );

    expect(labels.map(({ id, text }) => [id, text])).toEqual([
      ['labels_a:2', 'a2'],
      ['labels_b:0', 'b0'],
      ['labels_a:1', 'a1'],
      ['labels_a:0', 'a0'],
    ]);
  });

  test('a line without an id is named the same way', () => {
    const { lines } = toLines(
      [study('S1', { lines: [line({ id: null }), line({ id: null, styleId: 'lines_b' })] })],
      100,
    );

    expect(lines.map(({ id }) => id)).toEqual(['lines_b:0', 'lines_a:0']);
  });

  test('the place in the name is counted before the limit cuts, and per study', () => {
    const labels = Array.from({ length: 5 }, (_, index) => label({ text: String(index) }));

    const kept = toLabels([study('S1', { labels }), study('S2', { labels: [label()] })], 3);

    expect(kept.labels.map(({ studyId, id }) => [studyId, id])).toEqual([
      ['S2', 'labels_a:0'],
      ['S1', 'labels_a:4'],
      ['S1', 'labels_a:3'],
    ]);
  });
});

describe('the limit', () => {
  test('keeps the newest drawings by id, newest first, and counts every drawing', () => {
    // The ids do not come in order: the highest ones are the newest.
    const { lines, total } = toLines(
      [study('S1', { lines: [30, 10, 40, 20].map((id) => line({ id })) })],
      2,
    );

    expect(total).toBe(4);
    expect(lines.map(({ id }) => id)).toEqual(['40', '30']);
  });

  test('keeps the drawings that come last when they have no ids', () => {
    const { boxes, total } = toBoxes(
      [study('S1', { boxes: ['a', 'b', 'c', 'd'].map((text) => box({ text })) })],
      3,
    );

    expect(total).toBe(4);
    expect(boxes.map(({ text }) => text)).toEqual(['d', 'c', 'b']);
  });

  test('keeps the order of the app for lines of which some have no id', () => {
    const { lines } = toLines(
      [
        study('S1', {
          lines: [line({ id: 9 }), line({ id: null, styleId: 'x' }), line({ id: 3 })],
        }),
      ],
      100,
    );

    expect(lines.map(({ id }) => id)).toEqual(['3', 'x:0', '9']);
  });

  test('counts a later study as newer than an earlier one', () => {
    const { lines, total } = toLines(
      [
        study('S1', { lines: [line({ id: 5 }), line({ id: 6 })] }),
        study('S2', { lines: [line({ id: 1 }), line({ id: 2 })] }),
      ],
      3,
    );

    expect(total).toBe(4);
    expect(lines.map(({ studyId, id }) => [studyId, id])).toEqual([
      ['S2', '2'],
      ['S2', '1'],
      ['S1', '6'],
    ]);
  });

  test('returns everything when the limit is above the count', () => {
    const { labels, total } = toLabels([study('S1', { labels: [label(), label()] })], 500);

    expect(total).toBe(2);
    expect(labels).toHaveLength(2);
  });

  test('has nothing to give for no studies, or studies that drew nothing', () => {
    expect(toLines([], 100)).toEqual({ lines: [], total: 0 });
    expect(toLabels([study('S1')], 100)).toEqual({ labels: [], total: 0 });
    expect(toBoxes([study('S1'), study('S2')], 100)).toEqual({ boxes: [], total: 0 });
    expect(toTables([study('S1')], 100)).toEqual({ tables: [], total: 0 });
  });
});
