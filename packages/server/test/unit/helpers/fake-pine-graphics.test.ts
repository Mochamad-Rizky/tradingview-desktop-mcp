import {
  loadTvFixture,
  type FixtureGraphics,
  type TvStateFixture,
} from '../../helpers/fake-tv/fixture.js';
import type { FakePropertyNode } from '../../helpers/fake-tv/pine-graphics.js';
import { syntheticBars } from '../../helpers/fake-tv/synthetic-bars.js';
import { createFakeTvWindow, type FakeTvOverrides } from '../../helpers/fake-tv/window.js';

// The drawings of the Pine studies in the fake app (pine-graphics.ts), checked against the shapes
// the reverse-engineering notes of Plan 2 record for the app (section Q5): the core model that
// answers a study core by id, graphics() with its grouped and regular accessors, the property tree
// of the palette, and the time scale that gives the time of a time-point index. Values are
// synthetic.

const fixture = loadTvFixture();
const bars = syntheticBars(fixture.bars);
const DAY = 86_400;

function chartOf(win: ReturnType<typeof createFakeTvWindow>) {
  const api = win.TradingViewApi;
  if (api === undefined) {
    throw new Error('The fake window has no TradingViewApi');
  }
  return api.activeChart();
}

const coreModelOf = (win: ReturnType<typeof createFakeTvWindow>) =>
  chartOf(win)._chartWidget.model().model();

// The study STUDY01 of the fixture with `graphics` in place of its own.
function withGraphics(graphics: FixtureGraphics | undefined): TvStateFixture {
  return {
    ...fixture,
    studies: fixture.studies.map((study) =>
      study.id === 'STUDY01' ? { ...study, graphics } : study,
    ),
  };
}

function graphicsOf(win = createFakeTvWindow(fixture), id = 'STUDY01') {
  const core = coreModelOf(win).getStudyById(id);
  if (core === null) {
    throw new Error(`The fake chart has no study ${id}`);
  }
  return core.graphics();
}

describe('the core model of the fake app', () => {
  test('answers the core of a study by id, the same object the study API gives', () => {
    const win = createFakeTvWindow(fixture);

    for (const { id } of chartOf(win).getAllStudies()) {
      expect(coreModelOf(win).getStudyById(id)).toBe(chartOf(win).getStudyById(id).study());
    }
  });

  test('answers null for an id that is not a study of the chart, as the app does', () => {
    const win = createFakeTvWindow(fixture);

    expect(coreModelOf(win).getStudyById('NOPE')).toBeNull();
    expect(coreModelOf(win).getStudyById('')).toBeNull();
  });

  test('follows the studies the chart gains and loses', async () => {
    const win = createFakeTvWindow(fixture);
    const id = await chartOf(win).createStudy({ type: 'java', studyId: 'Volume@tv-basicstudies' });
    const added = coreModelOf(win).getStudyById(id ?? '');

    expect(added?.metaInfo().id).toBe('Volume@tv-basicstudies');

    chartOf(win).removeEntity(id ?? '');

    expect(coreModelOf(win).getStudyById(id ?? '')).toBeNull();
  });
});

describe('graphics() of a study', () => {
  test('is the same object on every call, as the app keeps one', () => {
    const win = createFakeTvWindow(fixture);
    const core = coreModelOf(win).getStudyById('STUDY01');

    expect(core?.graphics()).toBe(core?.graphics());
    expect(graphicsOf(win).dwglines()).toBe(graphicsOf(win).dwglines());
  });

  test('groups lines by style and by forceOverlay, in the order the drawings come', () => {
    const lines = graphicsOf().dwglines();

    expect([...lines.keys()]).toEqual(['lines_a', 'lines_b']);
    expect([...(lines.get('lines_a')?.keys() ?? [])]).toEqual([false, true]);
    expect([...(lines.get('lines_b')?.keys() ?? [])]).toEqual([false]);
    expect([...(lines.get('lines_a')?.get(false) ?? [])].map(({ id }) => id)).toEqual([101]);
    expect([...(lines.get('lines_a')?.get(true) ?? [])].map(({ id }) => id)).toEqual([102]);
    expect([...(lines.get('lines_b')?.get(false) ?? [])].map(({ id }) => id)).toEqual([103]);
  });

  test('materializes a line with the fields of the app, a missing time point as null', () => {
    const lines = graphicsOf().dwglines();

    expect([...(lines.get('lines_a')?.get(false) ?? [])]).toEqual([
      {
        id: 101,
        x1: 280,
        y1: 108.5,
        x2: 299,
        y2: 104.25,
        style: 'sol',
        extend: 'n',
        width: 2,
        colorIndex: 0,
        forceOverlay: false,
      },
    ]);
    expect([...(lines.get('lines_b')?.get(false) ?? [])]).toEqual([
      {
        id: 103,
        x1: null,
        y1: 102.5,
        x2: 299,
        y2: 102.5,
        style: 'dot',
        extend: 'l',
        width: 3,
        colorIndex: null,
        forceOverlay: false,
      },
    ]);
  });

  test('holds a label of every yloc, and a label has no id', () => {
    const labels = graphicsOf().dwglabels();
    const all = [...labels.values()].flatMap((byOverlay) =>
      [...byOverlay.values()].flatMap((set) => [...set]),
    );

    expect([...labels.keys()]).toEqual(['labels_a', 'labels_b']);
    expect(new Set(all.map(({ yloc }) => yloc))).toEqual(new Set(['ab', 'bl', 'pr', 'auto']));
    expect(all.some((label) => 'id' in label)).toBe(false);
    expect([...(labels.get('labels_a')?.get(false) ?? [])][0]).toEqual({
      x: 290,
      y: 108.28,
      yloc: 'ab',
      text: 'Peak',
      style: 'ldn',
      size: 'auto',
      colorIndex: 1,
      textColorIndex: 0,
      textAlign: 'center',
      tooltip: '',
      fontType: null,
      forceOverlay: false,
      textFormatting: 0,
    });
    // A label in the empty space after the last bar, and one that is forced onto the price pane.
    expect(all.map(({ x }) => x)).toContain(305);
    expect([...(labels.get('labels_a')?.get(true) ?? [])].map(({ text }) => text)).toEqual([
      'Level',
    ]);
  });

  test('holds boxes with open ends, and a box has no id', () => {
    const boxes = graphicsOf().dwgboxes();

    expect([...boxes.keys()]).toEqual(['boxes_a', 'boxes_b']);
    expect([...(boxes.get('boxes_a')?.get(false) ?? [])]).toEqual([
      {
        left: 270,
        right: 299,
        top: 110.5,
        bottom: 106,
        extend: 'n',
        text: 'Range',
        borderColorIndex: 0,
        backgroundColorIndex: 2,
        borderStyle: 'sol',
        borderWidth: 1,
        textFormatting: 0,
        horizontalTextAlignment: 'center',
        verticalTextAlignment: 'center',
        fontSize: 'auto',
        textColorIndex: null,
        fontType: null,
        forceOverlay: false,
      },
    ]);
    expect([...(boxes.get('boxes_b')?.get(false) ?? [])][0]).toMatchObject({
      left: null,
      right: 299,
    });
  });

  test('holds tables grouped like lines, and their cells by style only', () => {
    const graphics = graphicsOf();
    const tables = graphics.dwgtables();
    const cells = graphics.dwgtablecells();

    expect([...tables.keys()]).toEqual(['tables_a']);
    expect([...(tables.get('tables_a')?.keys() ?? [])]).toEqual([false, true]);
    expect([...(tables.get('tables_a')?.get(false) ?? [])]).toEqual([
      {
        id: 201,
        position: 'top_right',
        rows: 2,
        columns: 2,
        backgroundColorIndex: null,
        frameColorIndex: null,
        frameWidth: 0,
        borderColorIndex: null,
        borderWidth: 0,
        forceOverlay: false,
      },
    ]);
    // The cells are not grouped by forceOverlay and are not in the order of their positions.
    expect([...cells.keys()]).toEqual(['cells_a', 'cells_b']);
    expect(
      [...(cells.get('cells_a') ?? [])].map(({ tableId, row, column }) => [tableId, row, column]),
    ).toEqual([
      [201, 1, 1],
      [201, 0, 1],
      [201, 0, 0],
    ]);
    expect([...(cells.get('cells_b') ?? [])][0]).toEqual({
      tableId: 201,
      row: 1,
      column: 0,
      widthInPercentsOfPaneWidth: 0,
      heightInPercentOfPaneHeight: 0,
      text: 'Up',
      textColorIndex: null,
      horizontalTextAlignment: 'center',
      verticalTextAlignment: 'center',
      fontSize: 'normal',
      backgroundColorIndex: null,
      colSpan: 1,
      rowSpan: 1,
      tooltip: '',
      fontType: null,
      textFormatting: 0,
    });
  });

  test('is a set that iterates its items, and whose entries and keys throw as on the app', () => {
    const set = graphicsOf().dwglines().get('lines_a')?.get(false);
    if (set === undefined) {
      throw new Error('The fixture has no such set');
    }

    expect(set.size).toBe(1);
    expect([...set]).toEqual([...set.values()]);
    const seen: unknown[] = [];
    set.forEach((item) => seen.push(item));
    expect(seen).toEqual([...set]);
    expect(() => set.entries()).toThrow('Method not implemented.');
    expect(() => set.keys()).toThrow('Method not implemented.');
  });

  test('hands out copies, so what a page does to an item stays in the page', () => {
    const set = graphicsOf().dwglines().get('lines_a')?.get(false);
    const [item] = [...(set ?? [])];
    if (item === undefined) {
      throw new Error('The fixture has no such line');
    }

    item.y1 = 1;

    expect([...(set ?? [])][0]?.y1).toBe(108.5);
  });

  test('is made of empty maps for a study without drawings, built-ins and strategies included', () => {
    const custom: TvStateFixture = {
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
    const win = createFakeTvWindow(custom);

    for (const id of ['STUDY02', 'S3', 'S4']) {
      const graphics = graphicsOf(win, id);
      expect([
        graphics.dwglines().size,
        graphics.dwglabels().size,
        graphics.dwgboxes().size,
        graphics.dwgtables().size,
        graphics.dwgtablecells().size,
      ]).toEqual([0, 0, 0, 0, 0]);
    }
  });

  test('keeps a style with several drawings in the order they come', () => {
    const graphics = {
      lines: [10, 12, 11].map((id) => ({
        styleId: 'one',
        id,
        x1: id,
        y1: 1,
        x2: id + 1,
        y2: 2,
        style: 'sol',
        extend: 'n',
        width: 1,
        colorIndex: null,
      })),
    };

    const set = graphicsOf(createFakeTvWindow(withGraphics(graphics)))
      .dwglines()
      .get('one')
      ?.get(false);

    expect([...(set ?? [])].map(({ id }) => id)).toEqual([10, 12, 11]);
  });
});

describe('the palette of a study', () => {
  // The node at a path of child names, the way the renderers walk the tree with childs().
  const nodeAt = (root: FakePropertyNode | undefined, path: string[]) =>
    path.reduce<FakePropertyNode | undefined>((node, name) => node?.childs?.()[name], root);
  const colorOf = (win: ReturnType<typeof createFakeTvWindow>, index: number) =>
    nodeAt(coreModelOf(win).getStudyById('STUDY01')?.properties(), [
      'palettes',
      'palette_common',
      'colors',
      String(index),
      'color',
    ])?.value?.();

  test('is read the way the renderers read it, by color index', () => {
    const win = createFakeTvWindow(fixture);

    expect([0, 1, 2].map((index) => colorOf(win, index))).toEqual([
      '#2962FF',
      '#F23645',
      'rgba(8, 153, 129, 0.4)',
    ]);
    expect(colorOf(win, 3)).toBeUndefined();
  });

  test('is missing from a study without a palette, which then has no palette_common', () => {
    const win = createFakeTvWindow(withGraphics({ isRGB: true }));
    const core = coreModelOf(win).getStudyById('STUDY01');

    expect(nodeAt(core?.properties(), ['palettes'])?.childs?.()).toEqual({});
    expect(colorOf(win, 0)).toBeUndefined();
  });

  test('is there for a study without drawings, with no colors in it', () => {
    const core = coreModelOf(createFakeTvWindow(fixture)).getStudyById('STUDY02');

    expect(nodeAt(core?.properties(), ['palettes'])?.childs?.()).toEqual({});
  });
});

describe('the metadata of a study with drawings', () => {
  test('says nothing of isRGB when the colors are palette indices, as the app did', () => {
    const core = coreModelOf(createFakeTvWindow(fixture)).getStudyById('STUDY01');

    expect(core?.metaInfo()).not.toHaveProperty('isRGB');
  });

  test('says isRGB for a study whose colors are packed integers', () => {
    const core = coreModelOf(createFakeTvWindow(withGraphics({ isRGB: true }))).getStudyById(
      'STUDY01',
    );

    expect(core?.metaInfo().isRGB).toBe(true);
  });
});

describe('indexToTimePoint of the core time scale', () => {
  const scaleOf = (win: ReturnType<typeof createFakeTvWindow>) => coreModelOf(win).timeScale();

  test('equals the time in the bar row of every loaded index', () => {
    const win = createFakeTvWindow(fixture);
    const series = chartOf(win)._chartWidget.model().mainSeries();

    expect(series.bars().size()).toBe(bars.length);
    for (let index = 0; index < bars.length; index += 1) {
      expect(scaleOf(win).indexToTimePoint(index)).toBe(series.bars().valueAt(index)?.[0]);
    }
  });

  test('stays in the time base of the bar rows when the chart reports other public times', () => {
    const win = createFakeTvWindow(fixture, { sessionOffsetSeconds: 48_600 });
    const series = chartOf(win)._chartWidget.model().mainSeries();

    expect(scaleOf(win).indexToTimePoint(10)).toBe(series.bars().valueAt(10)?.[0]);
    expect(chartOf(win)._convertIndexToPublicTime(10)).toBe((bars[10]?.[0] ?? 0) - 48_600);
  });

  test('has no time for the indexes after the last bar by default', () => {
    const scale = scaleOf(createFakeTvWindow(fixture));

    expect(scale.indexToTimePoint(bars.length - 1)).toBe(bars.at(-1)?.[0]);
    expect(scale.indexToTimePoint(bars.length)).toBeNull();
    expect(scale.indexToTimePoint(305)).toBeNull();
  });

  test('covers the time points after the last bar, when the time scale keeps some', () => {
    const win = createFakeTvWindow(fixture, { futurePoints: 30 });
    const scale = scaleOf(win);
    const last = bars.at(-1)?.[0] ?? 0;

    expect(scale.indexToTimePoint(bars.length)).toBe(last + DAY);
    expect(scale.indexToTimePoint(305)).toBe(last + 6 * DAY);
    expect(scale.indexToTimePoint(bars.length + 29)).toBe(last + 30 * DAY);
    expect(scale.indexToTimePoint(bars.length + 30)).toBeNull();
    // It agrees with the index the time scale gives back for the time.
    expect(scale.timePointToIndex(last + 6 * DAY)).toBe(305);
  });

  test('has no time for an index that is not a whole number or lies before the first bar', () => {
    const scale = scaleOf(createFakeTvWindow(fixture));

    expect(scale.indexToTimePoint(-1)).toBeNull();
    expect(scale.indexToTimePoint(10.5)).toBeNull();
    expect(scale.indexToTimePoint(Number.NaN)).toBeNull();
  });

  test('has no time for any index while the series has no bars', async () => {
    const win = createFakeTvWindow(fixture, { futurePoints: 30 });
    await chartOf(win).setSymbol('NOSUCH:SYMBOL');

    expect(scaleOf(win).indexToTimePoint(10)).toBeNull();
    expect(scaleOf(win).indexToTimePoint(305)).toBeNull();
  });

  test('follows the bars when older history is loaded in front of them', async () => {
    // The fixture holds all the history there is, so older bars need a longer one.
    const longer: TvStateFixture = { ...fixture, history: { ...fixture.history, totalBars: 400 } };
    const overrides: FakeTvOverrides = { historyLoadMs: 1 };
    const win = createFakeTvWindow(longer, overrides);
    const series = chartOf(win)._chartWidget.model().mainSeries();
    const before = series.bars().size();

    series.requestMoreData(50);
    await vi.waitFor(() => {
      expect(series.bars().size()).toBe(before + 50);
    });

    expect(scaleOf(win).indexToTimePoint(0)).toBe(series.bars().valueAt(0)?.[0]);
    expect(scaleOf(win).indexToTimePoint(50)).toBe(bars[0]?.[0]);
  });
});
