import { loadTvFixture, type TvStateFixture } from '../../helpers/fake-tv/fixture.js';
import { syntheticBars } from '../../helpers/fake-tv/synthetic-bars.js';
import type { FakeWebpackRequire } from '../../helpers/fake-tv/webpack.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTvOverrides,
  type FakeTvWindow,
} from '../../helpers/fake-tv/window.js';

// The drawings on the fake chart and the line tools of the fake app (drawings.ts), checked against
// what the reverse-engineering notes of Plan 3 (section 1) record for the app. Values are
// synthetic.

const fixture = loadTvFixture();
const bars = syntheticBars(fixture.bars);
const DAY = 86_400;
const timeOf = (index: number): number => bars[index]?.[0] ?? Number.NaN;

function chartOf(win: FakeTvWindow) {
  const api = win.TradingViewApi;
  if (api === undefined) {
    throw new Error('The fake window has no TradingViewApi');
  }
  return api.activeChart();
}

// The exports of the default webpack cache, by name. Each look pushes a chunk of its own: the runtime
// hands nothing to a chunk ID it has seen.
let probes = 0;
function exportsOf(win: FakeTvWindow): Record<string, unknown> {
  let handed: FakeWebpackRequire | undefined;
  probes += 1;
  (win.webpackChunktradingview as { push(chunk: unknown): unknown }).push([
    [`probe${String(probes)}`],
    {},
    (given: FakeWebpackRequire) => (handed = given),
  ]);
  const found: Record<string, unknown> = {};
  for (const record of Object.values(handed?.c ?? {})) {
    Object.assign(found, record.exports);
  }
  return found;
}

interface LineToolRegistry {
  getLoadedLineTool(className: string): { prototype: { pointsCount(): number } };
  ensureLineToolLoaded(className: string): Promise<unknown>;
  isLineToolLoaded(className: string): boolean;
}

function registryOf(win: FakeTvWindow): LineToolRegistry {
  return exportsOf(win) as unknown as LineToolRegistry;
}

function windowWith(
  from: TvStateFixture = fixture,
  overrides: FakeTvOverrides = {},
): { win: FakeTvWindow; chart: ReturnType<typeof chartOf> } {
  const win = createFakeTvWindow(from, overrides);
  return { win, chart: chartOf(win) };
}

describe('drawings on the chart', () => {
  test('getAllShapes lists the drawings of the fixture by id and API name', () => {
    const { chart } = windowWith();

    expect(chart.getAllShapes()).toEqual([
      { id: 'SHAPE01', name: 'trend_line' },
      { id: 'SHAPE02', name: 'horizontal_line' },
      { id: 'SHAPE03', name: 'rectangle' },
    ]);
  });

  test('getShapeById answers the points, the flat properties and the flags of a drawing', () => {
    const { chart } = windowWith({
      ...fixture,
      shapes: [
        {
          id: 'AbC123',
          name: 'rectangle',
          points: [
            { time: timeOf(10), price: 101.5 },
            { time: timeOf(20), price: 99.25 },
          ],
          properties: { text: 'zone', frozen: true, visible: false },
          editable: false,
        },
      ],
    });

    const shape = chart.getShapeById('AbC123');

    expect(shape.getPoints()).toEqual([
      { time: timeOf(10), price: 101.5 },
      { time: timeOf(20), price: 99.25 },
    ]);
    expect(shape.getProperties()).toMatchObject({
      color: expect.any(String) as string,
      linewidth: expect.any(Number) as number,
      fontSize: expect.any(Number) as number,
      text: 'zone',
      frozen: true,
      visible: false,
    });
    expect(shape.isUserEditEnabled()).toBe(false);
    expect(shape.isHidden()).toBe(true);
    expect(() => chart.getShapeById('NOPE01')).toThrow(new Error('There is no such shape'));
  });

  test('a drawing of the fixture without points lies on loaded bars, as many as its tool takes', () => {
    const { chart } = windowWith();

    const points = (id: string) => chart.getShapeById(id).getPoints();

    expect(points('SHAPE01')).toHaveLength(2);
    expect(points('SHAPE02')).toHaveLength(1);
    expect(points('SHAPE03')).toHaveLength(2);
    const times = new Set(bars.map(([time]) => time));
    for (const { time } of [...points('SHAPE01'), ...points('SHAPE02'), ...points('SHAPE03')]) {
      expect(times.has(time)).toBe(true);
    }
  });

  test('the properties of each tool follow the keys the notes record for it', () => {
    const { chart } = windowWith();

    expect(Object.keys(chart.getShapeById('SHAPE02').getProperties()).sort()).toEqual(
      [
        'linecolor',
        'textcolor',
        'linewidth',
        'linestyle',
        'showPrice',
        'fontsize',
        'bold',
        'italic',
        'horzLabelsAlign',
        'vertLabelsAlign',
        'text',
        'frozen',
        'visible',
      ].sort(),
    );
    expect(chart.getShapeById('SHAPE03').getProperties()).toMatchObject({
      color: expect.any(String) as string,
      textColor: expect.any(String) as string,
      fontSize: expect.any(Number) as number,
      linestyle: 0,
    });
  });

  test('reads return copies, so a caller cannot change a drawing', () => {
    const { chart } = windowWith();

    chart.getAllShapes().length = 0;
    chart.getShapeById('SHAPE01').getPoints().length = 0;
    chart.getShapeById('SHAPE01').getProperties().linewidth = 99;

    expect(chart.getAllShapes()).toHaveLength(3);
    expect(chart.getShapeById('SHAPE01').getPoints()).toHaveLength(2);
    expect(chart.getShapeById('SHAPE01').getProperties().linewidth).not.toBe(99);
  });

  test('setProperties and setPoints of a drawing record themselves', () => {
    const { win, chart } = windowWith();

    chart.getShapeById('SHAPE01').setProperties({ linewidth: 3 });
    chart.getShapeById('SHAPE01').setPoints([{ time: timeOf(1), price: 1 }]);

    expect(inspectFakeWindow(win).callsTo('shape.setProperties')).toEqual([
      ['SHAPE01', { linewidth: 3 }],
    ]);
    expect(inspectFakeWindow(win).callsTo('shape.setPoints')).toEqual([
      ['SHAPE01', [{ time: timeOf(1), price: 1 }]],
    ]);
  });
});

describe('creating drawings', () => {
  test('createMultipointShape adds the drawing and resolves an id of six letters and digits', async () => {
    const { win, chart } = windowWith();
    const options = {
      shape: 'trend_line',
      text: 'support',
      overrides: { linecolor: '#ff0000', linewidth: 3, nonsense: 1 },
    };

    const id = await chart.createMultipointShape(
      [
        { time: timeOf(5), price: 100 },
        { time: timeOf(9), price: 105 },
      ],
      options,
    );

    expect(id).toMatch(/^[A-Za-z0-9]{6}$/);
    expect(chart.getAllShapes().at(-1)).toEqual({ id, name: 'trend_line' });
    const shape = chart.getShapeById(id);
    expect(shape.getPoints()).toEqual([
      { time: timeOf(5), price: 100 },
      { time: timeOf(9), price: 105 },
    ]);
    // Known keys are merged, unknown keys are dropped without a word.
    expect(shape.getProperties()).toMatchObject({
      linecolor: '#ff0000',
      linewidth: 3,
      text: 'support',
    });
    expect(shape.getProperties()).not.toHaveProperty('nonsense');
    expect(shape.isUserEditEnabled()).toBe(true);
    expect(inspectFakeWindow(win).callsTo('chart.createMultipointShape')).toEqual([
      [
        [
          { time: timeOf(5), price: 100 },
          { time: timeOf(9), price: 105 },
        ],
        options,
      ],
    ]);
  });

  test('createShape adds a drawing of one point, and ids differ from one drawing to the next', async () => {
    const { win, chart } = windowWith();

    const first = await chart.createShape(
      { time: timeOf(3), price: 98 },
      { shape: 'horizontal_line' },
    );
    const second = await chart.createShape({ time: timeOf(4), price: 97 }, { shape: 'text' });

    expect(first).not.toBe(second);
    expect(chart.getShapeById(first).getPoints()).toEqual([{ time: timeOf(3), price: 98 }]);
    expect(chart.getAllShapes().slice(-2)).toEqual([
      { id: first, name: 'horizontal_line' },
      { id: second, name: 'text' },
    ]);
    expect(inspectFakeWindow(win).callsTo('chart.createShape')).toHaveLength(2);
  });

  test('a time between bars lies on the bar at or before it, and a time past the bars on the bar grid', async () => {
    const { chart } = windowWith();
    const last = timeOf(bars.length - 1);

    const id = await chart.createMultipointShape(
      [
        { time: timeOf(7) + 3600, price: 1 },
        { time: last + 2 * DAY + 60, price: 2 },
      ],
      { shape: 'trend_line' },
    );

    expect(
      chart
        .getShapeById(id)
        .getPoints()
        .map(({ time }) => time),
    ).toEqual([timeOf(7), last + 2 * DAY]);
  });

  test('an unknown or missing shape becomes a flag, without an error', async () => {
    const { chart } = windowWith();

    const unknown = await chart.createShape({ time: timeOf(1), price: 1 }, { shape: 'nonsense' });
    const missing = await chart.createShape({ time: timeOf(2), price: 1 }, {});

    expect(chart.getAllShapes().slice(-2)).toEqual([
      { id: unknown, name: 'flag' },
      { id: missing, name: 'flag' },
    ]);
  });

  test('a wrong point count rejects after the tool was created, which leaves it on the chart', async () => {
    const { chart } = windowWith();

    await expect(
      chart.createMultipointShape(
        [
          { time: timeOf(1), price: 1 },
          { time: timeOf(2), price: 2 },
        ],
        { shape: 'triangle' },
      ),
    ).rejects.toThrow(new Error('Wrong points count for triangle. Required 3'));
    expect(chart.getAllShapes()).toHaveLength(4);
    expect(chart.getAllShapes().at(-1)?.name).toBe('triangle');
  });

  test('a text for a tool without a text property rejects before anything is created', async () => {
    const { chart } = windowWith();

    await expect(
      chart.createShape({ time: timeOf(1), price: 1 }, { shape: 'flag', text: 'x' }),
    ).rejects.toThrow(new Error('Value is undefined'));
    expect(chart.getAllShapes()).toHaveLength(3);
  });

  test('signed out, creating opens the sign-in wall and rejects', async () => {
    const { win, chart } = windowWith();
    inspectFakeWindow(win).state.pineEditor.signedIn = false;

    await expect(
      chart.createShape({ time: timeOf(1), price: 1 }, { shape: 'horizontal_line' }),
    ).rejects.toThrow(new Error('Cannot create "horizontal_line" shape'));
    expect(inspectFakeWindow(win).callsTo('dialog.signIn')).toEqual([[]]);
    expect(chart.getAllShapes()).toHaveLength(3);
  });

  test('in the treatment of the drawings experiment, creating opens the paywall and rejects', async () => {
    const { win, chart } = windowWith(fixture, { drawings: { experiment: 'treatment' } });

    await expect(
      chart.createShape({ time: timeOf(1), price: 1 }, { shape: 'horizontal_line' }),
    ).rejects.toThrow(new Error('Cannot create "horizontal_line" shape'));
    expect(inspectFakeWindow(win).callsTo('dialog.paywall')).toEqual([['drawings']]);
    expect(chart.getAllShapes()).toHaveLength(3);
  });

  test('a chart without bars cannot create a drawing', async () => {
    const { win, chart } = windowWith({ ...fixture, bars: { ...fixture.bars, count: 0 } });

    await expect(
      chart.createShape({ time: timeOf(1), price: 1 }, { shape: 'horizontal_line' }),
    ).rejects.toThrow(new Error('Cannot create "horizontal_line" shape'));
    expect(chartOf(win).getAllShapes()).toHaveLength(3);
  });

  test('creating loads the class of the tool, as the app does on the way', async () => {
    const { win, chart } = windowWith();
    const registry = registryOf(win);

    expect(registry.isLineToolLoaded('LineToolEllipse')).toBe(false);
    await chart.createMultipointShape(
      [
        { time: timeOf(1), price: 1 },
        { time: timeOf(2), price: 2 },
        { time: timeOf(3), price: 3 },
      ],
      { shape: 'ellipse' },
    );

    expect(registry.isLineToolLoaded('LineToolEllipse')).toBe(true);
  });
});

describe('removing drawings', () => {
  test('removeEntity removes a drawing, undoable unless told otherwise, and only warns for an unknown id', () => {
    const { win, chart } = windowWith();

    chart.removeEntity('SHAPE01');
    chart.removeEntity('NOPE01');
    chart.removeEntity('SHAPE02', { disableUndo: true });

    expect(chart.getAllShapes()).toEqual([{ id: 'SHAPE03', name: 'rectangle' }]);
    expect(inspectFakeWindow(win).state.drawings.removed).toEqual([
      { id: 'SHAPE01', undoable: true },
      { id: 'SHAPE02', undoable: false },
    ]);
    expect(inspectFakeWindow(win).callsTo('chart.removeEntity')).toEqual([
      ['SHAPE01'],
      ['NOPE01'],
      ['SHAPE02', { disableUndo: true }],
    ]);
    expect(() => chart.getShapeById('SHAPE01')).toThrow(new Error('There is no such shape'));
  });

  test('removeEntity also removes a locked drawing and one the user cannot delete', () => {
    const { chart } = windowWith({
      ...fixture,
      shapes: [
        { id: 'LCK001', name: 'trend_line', properties: { frozen: true } },
        { id: 'LCK002', name: 'trend_line', editable: false },
      ],
    });

    chart.removeEntity('LCK001');
    chart.removeEntity('LCK002');

    expect(chart.getAllShapes()).toEqual([]);
  });

  test('removeEntity still removes studies', () => {
    const { chart } = windowWith();

    chart.removeEntity('STUDY01');

    expect(chart.getAllStudies().map(({ id }) => id)).toEqual(['STUDY02']);
    expect(chart.getAllShapes()).toHaveLength(3);
  });

  test('removeAllShapes asks for confirmation in a dialog when a drawing is locked, and removes nothing', () => {
    const { win, chart } = windowWith({
      ...fixture,
      shapes: [...fixture.shapes, { id: 'LCK001', name: 'text', properties: { frozen: true } }],
    });

    chart.removeAllShapes();

    expect(inspectFakeWindow(win).callsTo('chart.removeAllShapes')).toEqual([[]]);
    expect(inspectFakeWindow(win).callsTo('dialog.confirmRemovingLockedLineTools')).toEqual([[]]);
    expect(chart.getAllShapes()).toHaveLength(4);
  });

  test('removeAllShapes without a locked drawing removes the drawings the user can delete', () => {
    const { win, chart } = windowWith({
      ...fixture,
      shapes: [...fixture.shapes, { id: 'KEEP01', name: 'text', editable: false }],
    });

    chart.removeAllShapes();

    expect(chart.getAllShapes()).toEqual([{ id: 'KEEP01', name: 'text' }]);
    expect(inspectFakeWindow(win).callsTo('dialog.confirmRemovingLockedLineTools')).toEqual([]);
  });
});

describe('the line tools of the app', () => {
  test('supportedLineTools maps each API name to the class of its tool', () => {
    const tools = exportsOf(createFakeTvWindow(fixture)).supportedLineTools as Record<
      string,
      { name: string }
    >;

    expect(tools.horizontal_line).toEqual({ name: 'LineToolHorzLine' });
    expect(tools.rectangle).toEqual({ name: 'LineToolRectangle' });
    expect(tools.text).toEqual({ name: 'LineToolText' });
    expect(tools.trend_line).toEqual({ name: 'LineToolTrendLine' });
    expect(tools.arrow_up).toEqual({ name: 'LineToolArrowMarkUp' });
    expect(tools.flag).toEqual({ name: 'LineToolFlagMark' });
    expect(Object.keys(tools)).toHaveLength(20);
  });

  test('only the classes of tools on the chart are loaded, and ensureLineToolLoaded loads another', async () => {
    const win = createFakeTvWindow(fixture);
    const registry = registryOf(win);

    expect(registry.getLoadedLineTool('LineToolTrendLine').prototype.pointsCount()).toBe(2);
    expect(registry.getLoadedLineTool('LineToolHorzLine').prototype.pointsCount()).toBe(1);
    expect(() => registry.getLoadedLineTool('LineToolTriangle')).toThrow(
      new Error('Line tool LineToolTriangle is undefined'),
    );

    await registry.ensureLineToolLoaded('LineToolTriangle');

    expect(registry.getLoadedLineTool('LineToolTriangle').prototype.pointsCount()).toBe(3);
    expect(inspectFakeWindow(win).callsTo('lineTools.ensureLineToolLoaded')).toEqual([
      ['LineToolTriangle'],
    ]);
    await expect(registry.ensureLineToolLoaded('LineToolNonsense')).rejects.toThrow(
      new Error('Line tool LineToolNonsense is undefined'),
    );
  });

  test('a test can give a class another point count or other properties', async () => {
    const win = createFakeTvWindow(fixture, {
      drawings: {
        classes: {
          LineToolCircle: { pointsCount: 3 },
          LineToolTrendLine: { properties: { linecolor: '#000000', frozen: false } },
        },
      },
    });
    const registry = registryOf(win);

    await registry.ensureLineToolLoaded('LineToolCircle');

    expect(registry.getLoadedLineTool('LineToolCircle').prototype.pointsCount()).toBe(3);
    expect(Object.keys(chartOf(win).getShapeById('SHAPE01').getProperties()).sort()).toEqual([
      'frozen',
      'linecolor',
    ]);
  });

  test('a brush takes any number of points', async () => {
    const { win, chart } = windowWith();
    await registryOf(win).ensureLineToolLoaded('LineToolBrush');

    expect(registryOf(win).getLoadedLineTool('LineToolBrush').prototype.pointsCount()).toBe(-1);
    const id = await chart.createMultipointShape(
      [1, 2, 3, 4].map((index) => ({ time: timeOf(index), price: index })),
      { shape: 'brush' },
    );
    expect(chart.getShapeById(id).getPoints()).toHaveLength(4);
  });

  test('getDrawingsExperimentVariation answers the variation, null by default, and can be left out', () => {
    const variation = (overrides: FakeTvOverrides = {}): unknown =>
      exportsOf(createFakeTvWindow(fixture, overrides)).getDrawingsExperimentVariation;

    expect((variation() as () => unknown)()).toBeNull();
    expect((variation({ drawings: { experiment: 'treatment' } }) as () => unknown)()).toBe(
      'treatment',
    );
    expect(variation({ drawings: { withoutExperiment: true } })).toBeUndefined();
  });

  test('the variation follows the live state', () => {
    const win = createFakeTvWindow(fixture);
    const read = exportsOf(win).getDrawingsExperimentVariation as () => unknown;

    inspectFakeWindow(win).state.drawings.experiment = 'treatment';

    expect(read()).toBe('treatment');
  });
});
