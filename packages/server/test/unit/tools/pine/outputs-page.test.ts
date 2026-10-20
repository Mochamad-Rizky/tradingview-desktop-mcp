import type { CdpSession } from '../../../../src/core/cdp/types.js';
import type { TvMcpError } from '../../../../src/core/errors.js';
import {
  createPageBridge,
  type PageBridge,
  type PageFunction,
} from '../../../../src/core/tv/page-bridge.js';
import type { TvWindow } from '../../../../src/core/tv/tv-window.js';
import { readPineGraphics } from '../../../../src/tools/pine/outputs-page.js';
import type { JsonValue } from '../../../../src/utils/json.js';
import { failureOf } from '../../../helpers/failure-of.js';
import { createPageRuntime } from '../../../helpers/fake-cdp/runtime.js';
import {
  loadTvFixture,
  type FixtureGraphics,
  type TvStateFixture,
} from '../../../helpers/fake-tv/fixture.js';
import { createPrimitiveSet } from '../../../helpers/fake-tv/pine-graphics.js';
import { syntheticBars } from '../../../helpers/fake-tv/synthetic-bars.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTvOverrides,
} from '../../../helpers/fake-tv/window.js';

// The page function that reads the drawings of Pine scripts, run the way the server runs it, as
// source text in a page through the real page bridge, and called directly on a second window built
// the same way, which is what the coverage of the module measures. The two answers must agree.
// Values are synthetic.

const fixture = loadTvFixture();
const bars = syntheticBars(fixture.bars);
const timeOf = (index: number): number => bars[index]?.[0] ?? Number.NaN;
const DAY = 86_400;

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
});

function bridgeTo(win: object): PageBridge {
  const runtime = createPageRuntime(win);
  disposers.push(() => {
    runtime.dispose();
  });
  const send = (method: string, params?: unknown): Promise<unknown> =>
    method === 'Runtime.evaluate'
      ? runtime.evaluate(params as Record<string, unknown>)
      : Promise.reject(new Error(`Unexpected command ${method}`));
  const session: CdpSession = {
    targetId: 'PAGE1',
    isClosed: false,
    send: send as CdpSession['send'],
    onClose: () => undefined,
    close: () => Promise.resolve(),
  };
  return createPageBridge(session, { timeoutMs: 5000 });
}

type Make = () => object;

const chart =
  (from: TvStateFixture = fixture, overrides: FakeTvOverrides = {}): Make =>
  () =>
    createFakeTvWindow(from, overrides);

const plain =
  (win: object): Make =>
  () =>
    win;

async function resultOf<A extends JsonValue[], R extends JsonValue | null>(
  fn: PageFunction<A, R>,
  args: A,
  make: Make,
): Promise<{ result: R; win: object }> {
  const win = make();
  const result = await bridgeTo(win).evaluate(fn, args);
  const direct = await fn(make() as TvWindow, ...args);
  expect(direct).toEqual(result);
  return { result, win };
}

async function failureOfBoth<A extends JsonValue[], R extends JsonValue | null>(
  fn: PageFunction<A, R>,
  args: A,
  make: Make,
): Promise<TvMcpError> {
  const error = await failureOf(bridgeTo(make()).evaluate(fn, args));
  const direct = await fn(make() as TvWindow, ...args);
  expect(direct).toEqual({ __tvmcpError: error.toPayload() });
  return error;
}

// The fixture with `graphics` as the drawings of the study STUDY01.
function withGraphics(graphics: FixtureGraphics): TvStateFixture {
  return {
    ...fixture,
    studies: fixture.studies.map((study) =>
      study.id === 'STUDY01' ? { ...study, graphics } : study,
    ),
  };
}

// The fixture with a built-in study S3 and a Pine strategy S4 next to its two Pine studies.
const mixed: TvStateFixture = {
  ...fixture,
  studies: [
    ...fixture.studies,
    { id: 'S3', name: 'Volume', plots: ['plot_0'] },
    {
      id: 'S4',
      name: 'RSI Strategy',
      plots: [],
      strategy: true,
      pine: { scriptIdPart: 'STD;RSI%1Strategy', version: '12.0' },
    },
  ],
};

// A page whose chart lists `cores` and whose core model answers them by id, with bars and a time
// scale of their own. Nothing else of the app is there.
function withCores(
  cores: Record<string, unknown>,
  wiring: { bars?: unknown; timeScale?: unknown; model?: unknown } = {},
): Make {
  const core = {
    timeScale: () => wiring.timeScale ?? {},
    getStudyById: (id: string) => cores[id] ?? null,
  };
  return plain({
    TradingViewApi: {
      activeChart: () => ({
        getAllStudies: () => Object.keys(cores).map((id) => ({ id, name: id })),
        _chartWidget: {
          model: () =>
            wiring.model ?? {
              mainSeries: () => ({ bars: () => wiring.bars ?? {} }),
              model: () => core,
            },
        },
      }),
    },
  });
}

// A Pine study core whose graphics() is `graphics`.
const pineCore = (graphics: unknown, more: object = {}) => ({
  metaInfo: () => ({ pine: { version: '1' } }),
  graphics: () => graphics,
  properties: () => ({ childs: () => ({}) }),
  ...more,
});

// Graphics with one set of items for dwglines, as the app groups them.
const linesOf = (items: unknown[]) => ({
  dwglines: () => new Map([['style', new Map([[false, createPrimitiveSet(items as object[])]])]]),
});

const SOME_LINE = { id: 1, x1: 5, y1: 1, x2: 6, y2: 2, style: 'sol', extend: 'n', width: 1 };
const NO_DRAWINGS = { lines: [], labels: [], boxes: [], tables: [], cells: [] };

const NO_CHART: [string, Make][] = [
  ['a page without TradingViewApi', plain({})],
  ['a page whose app has not booted', chart(fixture, { withoutApi: true })],
  [
    'a page whose activeChart throws',
    plain({
      TradingViewApi: {
        activeChart: () => {
          throw new Error('No chart is active');
        },
      },
    }),
  ],
  ['a chart without getAllStudies', plain({ TradingViewApi: { activeChart: () => ({}) } })],
];

describe('readPineGraphics', () => {
  describe('lines', () => {
    test('reads the lines of every Pine study with their points, times and palette colors', async () => {
      const { result, win } = await resultOf(readPineGraphics, [null, 'lines', null], chart());

      expect(result).toStrictEqual({
        studies: [
          {
            studyId: 'STUDY01',
            ...NO_DRAWINGS,
            lines: [
              {
                styleId: 'lines_a',
                id: '101',
                x1: { barIndex: 280, time: timeOf(280) },
                y1: 108.5,
                x2: { barIndex: 299, time: timeOf(299) },
                y2: 104.25,
                extend: 'n',
                style: 'sol',
                width: 2,
                color: '#2962FF',
              },
              {
                styleId: 'lines_a',
                id: '102',
                x1: { barIndex: 290, time: timeOf(290) },
                y1: 106,
                // In the empty space after the last bar, where the time scale has no point.
                x2: { barIndex: 305, time: null },
                y2: 106,
                extend: 'r',
                style: 'dsh',
                width: 1,
                color: '#F23645',
              },
              {
                styleId: 'lines_b',
                id: '103',
                x1: { barIndex: null, time: null },
                y1: 102.5,
                x2: { barIndex: 299, time: timeOf(299) },
                y2: 102.5,
                extend: 'l',
                style: 'dot',
                width: 3,
                color: null,
              },
            ],
          },
          // A Pine study that drew nothing is read all the same.
          { studyId: 'STUDY02', ...NO_DRAWINGS },
        ],
        unreadable: [],
      });
      // Reading changes nothing and sends nothing.
      expect(inspectFakeWindow(win).calls).toEqual([]);
    });

    test('reads a point in the empty space after the last bar from the time scale', async () => {
      const { result } = await resultOf(
        readPineGraphics,
        [null, 'lines', 'STUDY01'],
        chart(fixture, { futurePoints: 30 }),
      );

      expect(result.studies[0]?.lines.map(({ x2 }) => x2)).toEqual([
        { barIndex: 299, time: timeOf(299) },
        { barIndex: 305, time: timeOf(299) + 6 * DAY },
        { barIndex: 299, time: timeOf(299) },
      ]);
    });

    test('takes a time of the loaded bars from their rows, in the time base of data_get_ohlcv', async () => {
      // The chart reports other public times, and the time scale gives the time of the rows.
      const { result } = await resultOf(
        readPineGraphics,
        [null, 'lines', 'STUDY01'],
        chart(fixture, { sessionOffsetSeconds: 48_600 }),
      );

      expect(result.studies[0]?.lines[0]).toMatchObject({
        x1: { barIndex: 280, time: timeOf(280) },
        x2: { barIndex: 299, time: timeOf(299) },
      });
    });

    test('reads only the study asked for', async () => {
      const { result } = await resultOf(readPineGraphics, [null, 'lines', 'STUDY02'], chart());

      expect(result).toStrictEqual({
        studies: [{ studyId: 'STUDY02', ...NO_DRAWINGS }],
        unreadable: [],
      });
    });

    test('reads the chart of the index it is given', async () => {
      const { result } = await resultOf(readPineGraphics, [0, 'lines', 'STUDY01'], chart());

      expect(result.studies[0]?.lines).toHaveLength(3);
    });

    test('fails CAPABILITY_UNAVAILABLE for a chart the layout does not have', async () => {
      const error = await failureOfBoth(readPineGraphics, [3, 'lines', null], chart());

      expect(error).toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
    });
  });

  describe('labels', () => {
    test('reads the labels of every yloc, with their colors from the palette', async () => {
      const { result } = await resultOf(readPineGraphics, [null, 'labels', 'STUDY01'], chart());

      expect(result.studies).toStrictEqual([
        {
          studyId: 'STUDY01',
          ...NO_DRAWINGS,
          labels: [
            {
              styleId: 'labels_a',
              x: { barIndex: 290, time: timeOf(290) },
              y: 108.28,
              yloc: 'ab',
              text: 'Peak',
              style: 'ldn',
              color: '#F23645',
              textColor: '#2962FF',
            },
            {
              styleId: 'labels_a',
              x: { barIndex: 285, time: timeOf(285) },
              y: 102.81,
              yloc: 'bl',
              text: 'Dip',
              style: 'lup',
              color: '#2962FF',
              textColor: '#F23645',
            },
            {
              styleId: 'labels_a',
              x: { barIndex: 295, time: timeOf(295) },
              y: 105.5,
              yloc: 'pr',
              text: 'Level',
              style: 'lcn',
              color: 'rgba(8, 153, 129, 0.4)',
              textColor: '#2962FF',
            },
            {
              styleId: 'labels_b',
              x: { barIndex: 299, time: timeOf(299) },
              y: 103.42,
              yloc: 'auto',
              text: 'Last',
              style: 'n',
              color: null,
              textColor: '#F23645',
            },
            {
              styleId: 'labels_b',
              x: { barIndex: 305, time: null },
              y: 104,
              yloc: 'pr',
              text: 'Next',
              style: 'flg',
              color: '#2962FF',
              textColor: null,
            },
          ],
        },
      ]);
    });
  });

  describe('boxes', () => {
    test('reads the boxes with open ends and their colors', async () => {
      const { result } = await resultOf(readPineGraphics, [null, 'boxes', 'STUDY01'], chart());

      expect(result.studies).toStrictEqual([
        {
          studyId: 'STUDY01',
          ...NO_DRAWINGS,
          boxes: [
            {
              styleId: 'boxes_a',
              left: { barIndex: 270, time: timeOf(270) },
              right: { barIndex: 299, time: timeOf(299) },
              top: 110.5,
              bottom: 106,
              extend: 'n',
              text: 'Range',
              borderColor: '#2962FF',
              bgColor: 'rgba(8, 153, 129, 0.4)',
            },
            {
              styleId: 'boxes_a',
              left: { barIndex: 285, time: timeOf(285) },
              right: { barIndex: 305, time: null },
              top: 104,
              bottom: 102,
              extend: 'r',
              text: '',
              borderColor: '#F23645',
              bgColor: null,
            },
            {
              styleId: 'boxes_b',
              left: { barIndex: null, time: null },
              right: { barIndex: 299, time: timeOf(299) },
              top: 108,
              bottom: 107,
              extend: 'l',
              text: 'Floor',
              borderColor: null,
              bgColor: 'rgba(8, 153, 129, 0.4)',
            },
          ],
        },
      ]);
    });
  });

  describe('tables', () => {
    test('reads the tables and, apart from them, all cells in the order the app keeps them', async () => {
      const { result } = await resultOf(readPineGraphics, [null, 'tables', 'STUDY01'], chart());

      expect(result.studies).toStrictEqual([
        {
          studyId: 'STUDY01',
          ...NO_DRAWINGS,
          // The ids as text, which is how the cells are joined to their table.
          tables: [
            { styleId: 'tables_a', id: '201', position: 'top_right', rows: 2, columns: 2 },
            { styleId: 'tables_a', id: '202', position: 'bottom_left', rows: 1, columns: 1 },
          ],
          cells: [
            { tableId: '201', row: 1, column: 1, text: 'Short' },
            { tableId: '201', row: 0, column: 1, text: 'Bias' },
            { tableId: '201', row: 0, column: 0, text: 'Trend' },
            { tableId: '201', row: 1, column: 0, text: 'Up' },
            { tableId: '202', row: 0, column: 0, text: 'Note' },
          ],
        },
      ]);
    });

    test('reads the ids of tables and the table ids of cells as text, from a number or a text', async () => {
      const { result } = await resultOf(
        readPineGraphics,
        [null, 'tables', 'STUDY01'],
        chart(
          withGraphics({
            tables: [
              { styleId: 'tables_a', id: 't1', position: 'top_right', rows: 1, columns: 1 },
              { styleId: 'tables_a', id: 7, position: 'bottom_left', rows: 1, columns: 1 },
            ],
            tableCells: [
              { styleId: 'cells_a', tableId: 't1', row: 0, column: 0, text: 'text id' },
              { styleId: 'cells_a', tableId: 7, row: 0, column: 0, text: 'number id' },
            ],
          }),
        ),
      );

      expect(result.studies[0]).toMatchObject({
        tables: [{ id: 't1' }, { id: '7' }],
        cells: [
          { tableId: 't1', text: 'text id' },
          { tableId: '7', text: 'number id' },
        ],
      });
    });

    test('reads no cells for another kind, and no tables for a script that has no cells', async () => {
      const lines = await resultOf(readPineGraphics, [null, 'lines', 'STUDY01'], chart());
      const bare = await resultOf(
        readPineGraphics,
        [null, 'tables', 'STUDY01'],
        chart(withGraphics({ tables: [] })),
      );

      expect(lines.result.studies[0]?.cells).toEqual([]);
      expect(bare.result.studies[0]).toMatchObject({ tables: [], cells: [] });
    });
  });

  describe('colors', () => {
    // The colors of a study with packed integers: r + 256g + 65536b + 16777216a, a in 0 to 255.
    const packed = (red: number, green: number, blue: number, alpha: number): number =>
      red + 256 * green + 65_536 * blue + 16_777_216 * alpha;
    const rgbLine = (colorIndex: number | null) => ({
      styleId: 'lines_a',
      id: 1,
      x1: 280,
      y1: 100,
      x2: 299,
      y2: 101,
      style: 'sol',
      extend: 'n',
      width: 1,
      colorIndex,
    });
    const colorsOf = async (colorIndexes: (number | null)[], isRGB = true) => {
      const { result } = await resultOf(
        readPineGraphics,
        [null, 'lines', 'STUDY01'],
        chart(withGraphics({ isRGB, lines: colorIndexes.map(rgbLine) })),
      );
      return result.studies[0]?.lines.map(({ color }) => color);
    };

    test('turns a packed integer into the CSS color the app writes for it', async () => {
      expect(
        await colorsOf([
          packed(41, 98, 255, 255),
          packed(242, 54, 69, 128),
          packed(0, 0, 0, 0),
          packed(255, 255, 255, 255),
        ]),
      ).toEqual([
        'rgba(41,98,255,1)',
        `rgba(242,54,69,${String(128 / 255)})`,
        'rgba(0,0,0,0)',
        'rgba(255,255,255,1)',
      ]);
    });

    test('rounds a packed integer like the app, and has no color for one that is none', async () => {
      expect(
        await colorsOf([
          packed(1, 2, 3, 255) + 0.4,
          null,
          -1,
          16_777_216 * 256,
          Number.MAX_SAFE_INTEGER,
        ]),
      ).toEqual(['rgba(1,2,3,1)', null, null, null, null]);
    });

    test('reads no palette for a study with packed integers, even when it has one', async () => {
      const { result } = await resultOf(
        readPineGraphics,
        [null, 'lines', 'STUDY01'],
        chart(
          withGraphics({
            isRGB: true,
            palette: ['#000000'],
            lines: [rgbLine(packed(1, 2, 3, 255))],
          }),
        ),
      );

      expect(result.studies[0]?.lines[0]?.color).toBe('rgba(1,2,3,1)');
    });

    test('has no color for a palette index the palette lacks, or for a study without a palette', async () => {
      expect(await colorsOf([0, 3, 7], false)).toEqual([null, null, null]);

      const { result } = await resultOf(
        readPineGraphics,
        [null, 'lines', 'STUDY01'],
        chart(withGraphics({ palette: ['#0A0B0C'], lines: [rgbLine(0), rgbLine(1), rgbLine(-1)] })),
      );
      expect(result.studies[0]?.lines.map(({ color }) => color)).toEqual(['#0A0B0C', null, null]);
    });

    test('has no color for a palette entry that is no text or cannot be read', async () => {
      const palette = {
        childs: () => ({
          palettes: {
            childs: () => ({
              palette_common: {
                childs: () => ({
                  colors: {
                    childs: () => ({
                      '0': { childs: () => ({ color: { value: () => 5 } }) },
                      '1': { childs: () => ({ color: { value: () => 'red' } }) },
                      '2': {
                        childs: () => {
                          throw new Error('Unreadable');
                        },
                      },
                      '3': {},
                    }),
                  },
                }),
              },
            }),
          },
        }),
      };
      const make = withCores({
        S1: pineCore(linesOf([0, 1, 2, 3, 4].map((colorIndex) => ({ ...SOME_LINE, colorIndex }))), {
          properties: () => palette,
        }),
      });

      const { result } = await resultOf(readPineGraphics, [null, 'lines', null], make);

      expect(result.studies[0]?.lines.map(({ color }) => color)).toEqual([
        null,
        'red',
        null,
        null,
        null,
      ]);
    });

    test('has no color when the palette tree cannot be reached at all', async () => {
      const make = withCores({
        S1: pineCore(linesOf([{ ...SOME_LINE, colorIndex: 0 }]), {
          properties: () => {
            throw new Error('No properties');
          },
        }),
        S2: pineCore(linesOf([{ ...SOME_LINE, colorIndex: 0 }]), { properties: undefined }),
      });

      const { result } = await resultOf(readPineGraphics, [null, 'lines', null], make);

      expect(result.studies.map(({ lines }) => lines.map(({ color }) => color))).toEqual([
        [null],
        [null],
      ]);
    });
  });

  describe('times', () => {
    const rows: Record<number, unknown> = {
      10: [1000, 1, 2, 3, 4, 5],
      11: [Number.NaN, 1, 2, 3, 4, 5],
      12: 'row',
    };
    const lineAt = (...x: unknown[]) => ({ ...SOME_LINE, x1: x[0], x2: x[1] });

    test('prefers the row of a loaded bar to the time scale', async () => {
      const make = withCores(
        { S1: pineCore(linesOf([lineAt(10, 20)])) },
        {
          bars: { valueAt: (index: number) => rows[index] ?? null },
          timeScale: { indexToTimePoint: (index: number) => 5000 + index },
        },
      );

      const { result } = await resultOf(readPineGraphics, [null, 'lines', null], make);

      // Index 10 is a loaded bar; the time scale gives the time of index 20.
      expect(result.studies[0]?.lines[0]).toMatchObject({
        x1: { barIndex: 10, time: 1000 },
        x2: { barIndex: 20, time: 5020 },
      });
    });

    test('falls back to the time scale for a row that has no time', async () => {
      const make = withCores(
        { S1: pineCore(linesOf([lineAt(11, 12)])) },
        {
          bars: { valueAt: (index: number) => rows[index] ?? null },
          timeScale: { indexToTimePoint: (index: number) => 5000 + index },
        },
      );

      const { result } = await resultOf(readPineGraphics, [null, 'lines', null], make);

      expect(result.studies[0]?.lines[0]).toMatchObject({
        x1: { barIndex: 11, time: 5011 },
        x2: { barIndex: 12, time: 5012 },
      });
    });

    test.each([
      ['answers nothing', () => undefined],
      ['answers null', () => null],
      ['answers not a number', () => Number.NaN],
      ['answers a text', () => '1730505600'],
      ['answers infinity', () => Number.POSITIVE_INFINITY],
      [
        'throws',
        () => {
          throw new Error('No such point');
        },
      ],
    ])('has no time when the time scale %s and no bar holds the index', async (_case, answer) => {
      const make = withCores(
        { S1: pineCore(linesOf([lineAt(305, 306)])) },
        {
          bars: {
            valueAt: () => {
              throw new Error('No such bar');
            },
          },
          timeScale: { indexToTimePoint: answer },
        },
      );

      const { result } = await resultOf(readPineGraphics, [null, 'lines', null], make);

      expect(result.studies[0]?.lines[0]).toMatchObject({
        x1: { barIndex: 305, time: null },
        x2: { barIndex: 306, time: null },
      });
    });

    test('has no time, only the barIndex, on a page without bars and without a time scale', async () => {
      const make = withCores({ S1: pineCore(linesOf([lineAt(10, 20)])) });

      const { result } = await resultOf(readPineGraphics, [null, 'lines', null], make);

      expect(result.studies[0]?.lines[0]).toMatchObject({
        x1: { barIndex: 10, time: null },
        x2: { barIndex: 20, time: null },
      });
    });

    test('reads an x that is no finite number as no point', async () => {
      const make = withCores(
        { S1: pineCore(linesOf([lineAt(null, undefined), lineAt(Number.NaN, '5')])) },
        { bars: { valueAt: () => [1000] } },
      );

      const { result } = await resultOf(readPineGraphics, [null, 'lines', null], make);

      expect(result.studies[0]?.lines.map(({ x1, x2 }) => [x1, x2])).toEqual([
        [
          { barIndex: null, time: null },
          { barIndex: null, time: null },
        ],
        [
          { barIndex: null, time: null },
          { barIndex: null, time: null },
        ],
      ]);
    });
  });

  describe('items of other shapes', () => {
    test('reads what is not a finite number, a text or a known code as null', async () => {
      const make = withCores({
        S1: pineCore(
          linesOf([
            {
              id: { value: 12 },
              x1: 5,
              y1: Number.NaN,
              x2: 6,
              y2: Number.POSITIVE_INFINITY,
              style: 7,
              extend: null,
              width: 'wide',
              colorIndex: 'blue',
            },
          ]),
        ),
      });

      const { result } = await resultOf(readPineGraphics, [null, 'lines', null], make);

      expect(result.studies[0]?.lines).toEqual([
        {
          styleId: 'style',
          id: null,
          x1: { barIndex: 5, time: null },
          y1: null,
          x2: { barIndex: 6, time: null },
          y2: null,
          extend: null,
          style: null,
          width: null,
          color: null,
        },
      ]);
    });

    test('reads the id of a line as text, whether the app gives a number or a text', async () => {
      const make = withCores({
        S1: pineCore(
          linesOf([
            { ...SOME_LINE, id: 12 },
            { ...SOME_LINE, id: 'l12' },
          ]),
        ),
      });

      const { result } = await resultOf(readPineGraphics, [null, 'lines', null], make);

      expect(result.studies[0]?.lines.map(({ id }) => id)).toEqual(['12', 'l12']);
    });

    test('passes over an item that is not an object, and reads an object without fields as empty', async () => {
      const make = withCores({
        S1: pineCore({
          dwglabels: () => new Map([['s', new Map([[false, [null, 7, 'text', {}]]])]]),
        }),
      });

      const { result } = await resultOf(readPineGraphics, [null, 'labels', null], make);

      expect(result.studies[0]?.labels).toEqual([
        {
          styleId: 's',
          x: { barIndex: null, time: null },
          y: null,
          yloc: null,
          text: null,
          style: null,
          color: null,
          textColor: null,
        },
      ]);
    });

    test('reads a set that only iterates, as well as one with values()', async () => {
      const iterating = { [Symbol.iterator]: () => [{ x: 2, y: 2 }][Symbol.iterator]() };
      const make = withCores({
        S1: pineCore({
          dwglabels: () =>
            new Map([
              ['only_iterator', new Map<boolean, unknown>([[false, iterating]])],
              ['an_array', new Map<boolean, unknown>([[false, [{ x: 3, y: 3 }]]])],
            ]),
        }),
      });

      const { result } = await resultOf(readPineGraphics, [null, 'labels', null], make);

      expect(result.studies[0]?.labels.map(({ styleId, x }) => [styleId, x.barIndex])).toEqual([
        ['only_iterator', 2],
        ['an_array', 3],
      ]);
    });

    test('lists a study whose set fails while it is read, and keeps nothing of it', async () => {
      const failing = {
        *[Symbol.iterator]() {
          yield { x: 1, y: 1 };
          throw new Error('Broken set');
        },
      };
      const withSet = (set: unknown) =>
        pineCore({ dwglabels: () => new Map([['s', new Map<boolean, unknown>([[false, set]])]]) });
      const make = withCores({
        FAILS_MIDWAY: withSet(failing),
        NUMBER: withSet(5),
        NULL: withSet(null),
        NO_OVERLAY_MAP: pineCore({ dwglabels: () => new Map([['s', 5]]) }),
        GOOD: withSet(createPrimitiveSet([{ x: 4, y: 4 }])),
      });

      const { result } = await resultOf(readPineGraphics, [null, 'labels', null], make);

      expect(result.studies.map(({ studyId, labels }) => [studyId, labels.length])).toEqual([
        ['GOOD', 1],
      ]);
      expect(result.unreadable).toEqual(['FAILS_MIDWAY', 'NUMBER', 'NULL', 'NO_OVERLAY_MAP']);
    });

    test('names a style that is no text by its string form', async () => {
      const make = withCores({
        S1: pineCore({
          dwglabels: () =>
            new Map<unknown, unknown>([
              [7, new Map([[false, createPrimitiveSet([{ x: 1, y: 1 }])]])],
              ['empty', new Map()],
            ]),
        }),
      });

      const { result } = await resultOf(readPineGraphics, [null, 'labels', null], make);

      expect(result.studies[0]?.labels.map(({ styleId }) => styleId)).toEqual(['7']);
    });

    test('reads the items of a map group that holds a set per overlay in any order', async () => {
      const make = withCores({
        S1: pineCore({
          dwgboxes: () =>
            new Map([
              [
                's',
                new Map([
                  [
                    true,
                    createPrimitiveSet([{ left: 1, right: 2, top: 3, bottom: 2, text: 'on' }]),
                  ],
                  [
                    false,
                    createPrimitiveSet([{ left: 1, right: 2, top: 3, bottom: 2, text: 'off' }]),
                  ],
                ]),
              ],
            ]),
        }),
      });

      const { result } = await resultOf(readPineGraphics, [null, 'boxes', null], make);

      expect(result.studies[0]?.boxes.map(({ text }) => text)).toEqual(['on', 'off']);
    });
  });

  describe('selection', () => {
    test('reads only the Pine studies when no study is asked for, strategies included', async () => {
      const { result } = await resultOf(readPineGraphics, [null, 'lines', null], chart(mixed));

      expect(result.studies.map(({ studyId }) => studyId)).toEqual(['STUDY01', 'STUDY02', 'S4']);
      expect(result.unreadable).toEqual([]);
    });

    test('fails INVALID_INPUT for an id that is not a study of the chart', async () => {
      const error = await failureOfBoth(readPineGraphics, [null, 'lines', 'NOPE'], chart());

      expect(error).toMatchObject({
        code: 'INVALID_INPUT',
        message: 'The chart has no study with the id NOPE',
        details: { id: 'NOPE' },
      });
      expect(error.hint).toContain('indicator_list');
    });

    test('fails INVALID_INPUT for a study that is not a Pine script', async () => {
      const error = await failureOfBoth(readPineGraphics, [null, 'lines', 'S3'], chart(mixed));

      expect(error).toMatchObject({
        code: 'INVALID_INPUT',
        message: 'The study S3 (Volume) is not a Pine script, so it has no Pine drawings',
        details: { id: 'S3' },
      });
      expect(error.hint).toContain('indicator_list');
    });

    test('reads the id of a study the chart lists as a number, and passes over entries without one', async () => {
      const listed = plain({
        TradingViewApi: {
          activeChart: () => ({
            getAllStudies: () => [{ id: 12, name: 'Numbered' }, { id: null }, null],
            _chartWidget: {
              model: () => ({
                mainSeries: () => ({}),
                model: () => ({
                  getStudyById: (id: string) =>
                    id === '12' ? pineCore(linesOf([SOME_LINE])) : null,
                }),
              }),
            },
          }),
        },
      });

      const { result } = await resultOf(readPineGraphics, [null, 'lines', null], listed);

      expect(result.studies.map(({ studyId }) => studyId)).toEqual(['12']);
      expect(result.unreadable).toEqual([]);
    });
  });

  describe('what cannot be read', () => {
    test('reads no study from a chart whose list of studies is no list', async () => {
      const make = plain({
        TradingViewApi: {
          activeChart: () => ({
            getAllStudies: () => 5,
            _chartWidget: { model: () => ({ model: () => ({ getStudyById: () => null }) }) },
          }),
        },
      });

      const none = await resultOf(readPineGraphics, [null, 'lines', null], make);
      const error = await failureOfBoth(readPineGraphics, [null, 'lines', 'S1'], make);

      expect(none.result).toStrictEqual({ studies: [], unreadable: [] });
      expect(error).toMatchObject({ code: 'INVALID_INPUT', details: { id: 'S1' } });
    });

    test('names a study by its id when the chart gives it no name', async () => {
      const make = plain({
        TradingViewApi: {
          activeChart: () => ({
            getAllStudies: () => [{ id: 'V1', name: 7 }],
            _chartWidget: {
              model: () => ({ model: () => ({ getStudyById: () => ({ metaInfo: () => ({}) }) }) }),
            },
          }),
        },
      });

      const error = await failureOfBoth(readPineGraphics, [null, 'lines', 'V1'], make);

      expect(error).toMatchObject({
        code: 'INVALID_INPUT',
        message: 'The study V1 (V1) is not a Pine script, so it has no Pine drawings',
      });
    });

    test('lists a study whose map holds entries that are not pairs', async () => {
      const make = withCores({
        S1: pineCore({ dwglines: () => [1, 2] }),
        S2: pineCore({ dwglines: () => new Map([['s', [1, 2]]]) }),
      });

      const { result } = await resultOf(readPineGraphics, [null, 'lines', null], make);

      expect(result).toStrictEqual({ studies: [], unreadable: ['S1', 'S2'] });
    });

    test('lists a study whose table cells cannot be read, and keeps the tables of the others', async () => {
      const cell = { tableId: 1, row: 0, column: 0, text: 'x' };
      const tables = () => new Map([['t', new Map([[false, createPrimitiveSet([{ id: 1 }])]])]]);
      const make = withCores({
        NO_ACCESSOR: pineCore({ dwgtables: tables }),
        ACCESSOR_THROWS: pineCore({
          dwgtables: tables,
          dwgtablecells: () => {
            throw new Error('No cells yet');
          },
        }),
        NOT_ITERABLE: pineCore({ dwgtables: tables, dwgtablecells: () => 5 }),
        SET_NOT_ITERABLE: pineCore({
          dwgtables: tables,
          dwgtablecells: () => new Map([['c', 5]]),
        }),
        TABLES_FAIL: pineCore({
          dwgtables: () => 5,
          dwgtablecells: () => new Map([['c', createPrimitiveSet([cell])]]),
        }),
        GOOD: pineCore({
          dwgtables: tables,
          dwgtablecells: () => new Map([['c', [cell, null, 4]]]),
        }),
      });

      const { result } = await resultOf(readPineGraphics, [null, 'tables', null], make);

      expect(result.studies).toStrictEqual([
        {
          ...NO_DRAWINGS,
          studyId: 'GOOD',
          tables: [{ styleId: 't', id: '1', position: null, rows: null, columns: null }],
          cells: [{ tableId: '1', row: 0, column: 0, text: 'x' }],
        },
      ]);
      expect(result.unreadable).toEqual([
        'NO_ACCESSOR',
        'ACCESSOR_THROWS',
        'NOT_ITERABLE',
        'SET_NOT_ITERABLE',
        'TABLES_FAIL',
      ]);
    });

    test.each(NO_CHART)('fails CAPABILITY_UNAVAILABLE on %s', async (_case, make) => {
      const error = await failureOfBoth(readPineGraphics, [null, 'lines', null], make);

      expect(error).toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
      expect(error.hint).toContain('app_health');
    });

    test.each([
      [
        'a chart without a chart widget',
        plain({
          TradingViewApi: { activeChart: () => ({ getAllStudies: () => [] }) },
        }),
      ],
      [
        'a chart widget whose model has no core model',
        withCores({}, { model: { mainSeries: () => ({}) } }),
      ],
      [
        'a core model without getStudyById',
        plain({
          TradingViewApi: {
            activeChart: () => ({
              getAllStudies: () => [],
              _chartWidget: { model: () => ({ model: () => ({ timeScale: () => ({}) }) }) },
            }),
          },
        }),
      ],
    ])('fails CAPABILITY_UNAVAILABLE on %s', async (_case, make) => {
      const error = await failureOfBoth(readPineGraphics, [null, 'lines', null], make);

      expect(error).toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
      expect(error.hint).toContain('app_health');
    });

    test('fails CAPABILITY_UNAVAILABLE, and reads nothing, when a Pine study has no graphics()', async () => {
      const make = withCores({
        GOOD: pineCore(linesOf([SOME_LINE])),
        BAD: pineCore(undefined, { graphics: undefined }),
      });

      const error = await failureOfBoth(readPineGraphics, [null, 'lines', null], make);

      expect(error).toMatchObject({ code: 'CAPABILITY_UNAVAILABLE', details: { id: 'BAD' } });
    });

    test('fails CAPABILITY_UNAVAILABLE for the Pine study asked for that has no graphics()', async () => {
      const make = withCores({ BAD: pineCore(undefined, { graphics: undefined }) });

      const error = await failureOfBoth(readPineGraphics, [null, 'lines', 'BAD'], make);

      expect(error).toMatchObject({ code: 'CAPABILITY_UNAVAILABLE', details: { id: 'BAD' } });
    });

    test('does not mind a study that is not Pine having no graphics()', async () => {
      const make = withCores({
        VOL: { metaInfo: () => ({}) },
        PINE: pineCore(linesOf([SOME_LINE])),
      });

      const { result } = await resultOf(readPineGraphics, [null, 'lines', null], make);

      expect(result.studies.map(({ studyId }) => studyId)).toEqual(['PINE']);
    });

    test('lists the studies it could not read, and reads the others', async () => {
      const make = withCores({
        BROKEN_META: {
          metaInfo: () => {
            throw new Error('No metadata');
          },
        },
        NO_META: {},
        THROWS: pineCore(undefined, {
          graphics: () => {
            throw new Error('No graphics yet');
          },
        }),
        NO_OBJECT: pineCore(null),
        NO_ACCESSOR: pineCore({}),
        ACCESSOR_THROWS: pineCore({
          dwglines: () => {
            throw new Error('No lines yet');
          },
        }),
        NOT_ITERABLE: pineCore({ dwglines: () => 5 }),
        EMPTY: pineCore({ dwglines: () => new Map() }),
        GOOD: pineCore(linesOf([SOME_LINE])),
      });

      const { result } = await resultOf(readPineGraphics, [null, 'lines', null], make);

      expect(result.studies.map(({ studyId, lines }) => [studyId, lines.length])).toEqual([
        ['EMPTY', 0],
        ['GOOD', 1],
      ]);
      expect(result.unreadable).toEqual([
        'BROKEN_META',
        'NO_META',
        'THROWS',
        'NO_OBJECT',
        'NO_ACCESSOR',
        'ACCESSOR_THROWS',
        'NOT_ITERABLE',
      ]);
    });

    test('lists a study the core model does not know, though the chart lists it', async () => {
      const make = plain({
        TradingViewApi: {
          activeChart: () => ({
            getAllStudies: () => [{ id: 'GONE', name: 'Gone' }],
            _chartWidget: { model: () => ({ model: () => ({ getStudyById: () => null }) }) },
          }),
        },
      });

      const { result } = await resultOf(readPineGraphics, [null, 'lines', null], make);

      expect(result).toStrictEqual({ studies: [], unreadable: ['GONE'] });
    });

    test('fails CAPABILITY_UNAVAILABLE for a study asked for that cannot be read', async () => {
      const make = withCores({
        THROWS: pineCore(undefined, {
          graphics: () => {
            throw new Error('No graphics yet');
          },
        }),
        BROKEN_META: {
          metaInfo: () => {
            throw new Error('No metadata');
          },
        },
        GONE: null,
      });

      for (const id of ['THROWS', 'BROKEN_META', 'GONE']) {
        const error = await failureOfBoth(readPineGraphics, [null, 'lines', id], make);

        expect(error).toMatchObject({ code: 'CAPABILITY_UNAVAILABLE', details: { id } });
      }
    });
  });
});
