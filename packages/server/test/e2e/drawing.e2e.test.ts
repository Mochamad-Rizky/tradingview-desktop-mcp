import type { PageLib } from '../../src/core/tv/page-lib.js';
import type { TvWindow } from '../../src/core/tv/tv-window.js';
import { DRAWING_SHAPE_NAMES, DRAWING_SHAPES } from '../../src/tools/drawing/mappers.js';
import {
  callFailure,
  callOk,
  describeFailure,
  e2eEnabled,
  HarnessError,
  observe,
  sameJson,
  startE2eServer,
  ToolCallError,
  type E2eServer,
  type ToolSuccess,
} from './setup.js';

// The drawing tools against the real TradingView Desktop. The chart holds the user's own drawings,
// often many, which no test touches: the suite draws three drawings of its own (a horizontal line, a
// trend line and a text), reads them back and removes exactly those, by their ids, however the test
// ended, after a timeout too. drawing_clear_all runs only with scope created_by_mcp, which removes the
// drawings of the session and no other. The points and prices of the drawings, the drawings of the
// user and their texts are compared without being printed.

// The text of the test's own text drawing, by which a drawing a failed call left behind is told
// apart from the user's.
const TEST_TEXT = 'tradingview-mcp E2E drawing (safe to delete)';

interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface ListedDrawing {
  id: string;
  shape: string;
  points: { time: number; timeIso: string; price: number }[];
  text: string | null;
  createdByServer: boolean;
}

interface DrawingDetail extends ListedDrawing {
  style: {
    color: string | null;
    lineWidth: number | null;
    lineStyle: string | null;
    fontSize: number | null;
  };
  locked: boolean;
  hidden: boolean;
}

// One drawing the test asks for: what drawing_create takes, and so the style it should read back.
interface Planned {
  shape: 'horizontal_line' | 'trend_line' | 'text';
  points: { time: number; price: number }[];
  text?: string;
  style: {
    color?: string;
    lineWidth?: number;
    lineStyle?: 'solid' | 'dotted' | 'dashed';
    fontSize?: number;
  };
}

interface Created {
  id: string;
  planned: Planned;
  warnings: string[];
}

// The point count TradingView reports for the class of each curated shape, as the line-tool registry
// of the app gives it once the class is loaded (the registry loads it the way createShape does on its
// way), and the class supportedLineTools names for the shape. Only constants of the app: nothing of
// the user. A class that does not load in time, or a count that is no number, reads as null.
function lineToolCounts(
  _win: TvWindow,
  lib: PageLib,
  shapes: string[],
  waitMs: number,
): Promise<Record<string, { className: string | null; pointsCount: number | null }>> {
  const supported = lib.findExport('supportedLineTools') as Record<string, unknown> | null;
  const registry = lib.findModuleWith(['ensureLineToolLoaded', 'getLoadedLineTool']) as {
    ensureLineToolLoaded?: (name: string) => unknown;
    getLoadedLineTool?: (name: string) => { prototype: { pointsCount(): unknown } };
  } | null;
  const settle = (call: () => unknown): Promise<boolean> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(false);
      }, waitMs);
      Promise.resolve()
        .then(call)
        .then(
          () => {
            clearTimeout(timer);
            resolve(true);
          },
          () => {
            clearTimeout(timer);
            resolve(false);
          },
        );
    });
  return Promise.all(
    shapes.map(async (shape) => {
      const entry = supported?.[shape] as { name?: unknown } | undefined;
      const className = typeof entry?.name === 'string' ? entry.name : null;
      if (className === null || typeof registry?.ensureLineToolLoaded !== 'function') {
        return [shape, { className, pointsCount: null }] as const;
      }
      const loaded = await settle(() => registry.ensureLineToolLoaded?.(className));
      let count: unknown = null;
      if (loaded) {
        try {
          count = registry.getLoadedLineTool?.(className).prototype.pointsCount();
        } catch {
          count = null;
        }
      }
      return [
        shape,
        {
          className,
          pointsCount: typeof count === 'number' && Number.isFinite(count) ? count : null,
        },
      ] as const;
    }),
  ).then((entries) =>
    Object.fromEntries<{ className: string | null; pointsCount: number | null }>(entries),
  );
}

// The undo history of the app as undoRedoState() gives it: how many steps it holds and the text of
// the last one, which names the kind of step (such as a creation), never what the user drew. Null
// when the app does not give it. It only reads.
function readUndoState(win: TvWindow): { undoCount: number; undoText: string | null } | null {
  try {
    const state = (
      win.TradingViewApi as unknown as {
        undoRedoState?: () => { undoCommandCount?: unknown; undoText?: unknown };
      }
    ).undoRedoState?.();
    if (typeof state?.undoCommandCount !== 'number') {
      return null;
    }
    return {
      undoCount: state.undoCommandCount,
      undoText: typeof state.undoText === 'string' ? state.undoText : null,
    };
  } catch {
    return null;
  }
}

// What has the focus of the chart page, by its kind only: its tag, whether it takes text and whether
// it lies in the overlap root of the app (dialogs, menus, inline editors). It only reads.
function readFocusKind(win: TvWindow): { tag: string; editable: boolean; inOverlap: boolean } {
  const active = win.document.activeElement as HTMLElement | null;
  if (active === null) {
    return { tag: 'none', editable: false, inOverlap: false };
  }
  return {
    tag: active.tagName.toLowerCase(),
    editable:
      active.isContentEditable || active.tagName === 'TEXTAREA' || active.tagName === 'INPUT',
    inOverlap: active.closest('#overlap-manager-root') !== null,
  };
}

describe.skipIf(!e2eEnabled())('the drawing tools against TradingView Desktop', () => {
  let e2e: E2eServer | undefined;

  beforeAll(async () => {
    e2e = await startE2eServer();
  });

  afterAll(async () => {
    await e2e?.close();
  });

  function server(): E2eServer {
    if (e2e === undefined) {
      throw new Error('The server did not start');
    }
    return e2e;
  }

  // Every drawing of the chart, page by page, as one listing shows at most 500.
  async function listAll(): Promise<{ total: number; drawings: ListedDrawing[] }> {
    const drawings: ListedDrawing[] = [];
    for (;;) {
      const page = await callOk<{ total: number; drawings: ListedDrawing[] }>(
        server().client,
        'drawing_list',
        { limit: 500, offset: drawings.length },
      );
      drawings.push(...page.data.drawings);
      if (page.data.drawings.length === 0 || drawings.length >= page.data.total) {
        return { total: page.data.total, drawings };
      }
    }
  }

  // Removes what the test drew, however it ended: its own drawings, each by its id, one that is gone
  // already (INVALID_INPUT) being no failure, and a drawing a failed creation left behind, which is
  // new, of a shape the test drew, at the prices it gave (and with its text, for a text), and no more
  // of those than creations failed. Answers the failures, by tool and code only.
  async function removeOwnDrawings(
    beforeIds: ReadonlySet<string>,
    created: readonly Created[],
    planned: readonly Planned[],
    unanswered: number,
    tolerance: number,
  ): Promise<string[]> {
    const { client } = server();
    const failures: string[] = [];
    for (const { id } of created) {
      try {
        await callOk(client, 'drawing_remove', { id });
      } catch (error) {
        if (!(error instanceof ToolCallError && error.code === 'INVALID_INPUT')) {
          failures.push(describeFailure(error));
        }
      }
    }
    const now = await listAll();
    const strays = now.drawings.filter(
      (drawing) =>
        !beforeIds.has(drawing.id) &&
        !created.some(({ id }) => id === drawing.id) &&
        planned.some(
          (plan) =>
            plan.shape === drawing.shape &&
            (plan.text === undefined || drawing.text === plan.text) &&
            plan.points.length === drawing.points.length &&
            plan.points.every(
              (point, index) =>
                Math.abs((drawing.points[index]?.price ?? Number.NaN) - point.price) <= tolerance,
            ),
        ),
    );
    if (strays.length > unanswered) {
      failures.push(
        `${String(strays.length)} new drawings look like the test's, more than the ` +
          `${String(unanswered)} creations that failed, so none of them was removed: check the chart`,
      );
    } else {
      for (const { id } of strays) {
        try {
          // The session could not record a drawing whose creation did not answer.
          await callOk(client, 'drawing_remove', { id, confirm: true });
        } catch (error) {
          failures.push(describeFailure(error));
        }
      }
    }
    return failures;
  }

  test('lists the drawings of the chart and reads one', async () => {
    const { client } = server();
    const { data, warnings } = await callOk<{ total: number; drawings: ListedDrawing[] }>(
      client,
      'drawing_list',
      { limit: 500 },
    );
    expect(data.total).toBeGreaterThanOrEqual(data.drawings.length);
    expect(data.drawings.every(({ createdByServer }) => !createdByServer)).toBe(true);
    const state = await callOk<{ drawingCount: number | null }>(client, 'chart_get_state');
    expect(state.data.drawingCount === data.total, 'chart_get_state counts the same drawings').toBe(
      true,
    );
    const page = await callOk<{ total: number; drawings: ListedDrawing[] }>(
      client,
      'drawing_list',
      { limit: 2, offset: 1 },
    );
    expect(page.data.total).toBe(data.total);
    expect(page.data.drawings.length).toBe(Math.max(0, Math.min(2, data.total - 1)));
    const [first] = data.drawings;
    let detail: DrawingDetail | undefined;
    if (first !== undefined) {
      detail = (await callOk<DrawingDetail>(client, 'drawing_get', { id: first.id })).data;
      expect(detail.id).toBe(first.id);
      expect(typeof detail.locked).toBe('boolean');
      expect(typeof detail.hidden).toBe('boolean');
    }
    const shapes = [...new Set(data.drawings.map(({ shape }) => shape))];
    observe('drawings on the chart', {
      total: data.total,
      shapes: shapes.length,
      shapesKnownToTheTools: shapes.filter((shape) =>
        (DRAWING_SHAPE_NAMES as readonly string[]).includes(shape),
      ).length,
      withText: data.drawings.filter(({ text }) => text !== null).length,
      pointCounts: [...new Set(data.drawings.map(({ points }) => points.length))].sort(),
      timesAreDayStarts: data.drawings.every(({ points }) =>
        points.every(({ time }) => time % 86_400 === 0),
      ),
      unreadableWarnings: warnings.length,
      firstStyleKeys:
        detail === undefined
          ? null
          : Object.entries(detail.style)
              .filter(([, value]) => value !== null)
              .map(([key]) => key),
    });
  });

  test('the line-tool registry reports the point counts the server expects', async () => {
    const { ctx } = server();
    const page = await ctx.connection.chartPage();
    const counts = await page.bridge.evaluateWithLib(lineToolCounts, [
      [...DRAWING_SHAPE_NAMES],
      10_000,
    ]);
    const mismatches = DRAWING_SHAPE_NAMES.filter((shape) => {
      const reported = counts[shape]?.pointsCount ?? null;
      return reported !== null && reported !== -1 && reported !== DRAWING_SHAPES[shape].points;
    });
    observe('line-tool point counts', {
      shapes: DRAWING_SHAPE_NAMES.length,
      read: DRAWING_SHAPE_NAMES.filter((shape) => (counts[shape]?.pointsCount ?? null) !== null)
        .length,
      classNamesAsTheTable: DRAWING_SHAPE_NAMES.filter(
        (shape) => counts[shape]?.className === DRAWING_SHAPES[shape].className,
      ).length,
      counts: Object.fromEntries(
        DRAWING_SHAPE_NAMES.map((shape) => [shape, counts[shape]?.pointsCount ?? null]),
      ),
      mismatches,
    });
    expect(mismatches, 'every count the registry reports is the one of the table').toEqual([]);
  });

  test('draws a horizontal line, a trend line and a text, reads them back and removes them', async () => {
    const { client, ctx } = server();
    const page = await ctx.connection.chartPage();
    const before = await listAll();
    const beforeIds = new Set(before.drawings.map(({ id }) => id));
    const { data: ohlcv } = await callOk<{ bars: Bar[] }>(client, 'data_get_ohlcv', { count: 30 });
    const bars = ohlcv.bars;
    expect(bars.length, 'the chart has bars to draw on').toBeGreaterThanOrEqual(10);
    const high = Math.max(...bars.map((bar) => bar.high));
    const low = Math.min(...bars.map((bar) => bar.low));
    const span = high - low || Math.abs(high) * 0.01 || 1;
    const tolerance = span * 0.01;
    const timeAt = (index: number): number => bars[Math.min(index, bars.length - 1)]?.time ?? 0;
    // The longest gap between two bars, weekends and holidays included.
    const step = Math.max(
      ...bars.slice(1).map((bar, index) => bar.time - (bars[index]?.time ?? bar.time)),
    );
    const planned: Planned[] = [
      {
        shape: 'horizontal_line',
        points: [{ time: timeAt(20), price: low + span * 0.5 }],
        style: { color: '#2962ff', lineWidth: 2, lineStyle: 'dashed' },
      },
      {
        shape: 'trend_line',
        points: [
          { time: timeAt(5), price: low + span * 0.25 },
          { time: timeAt(25), price: low + span * 0.75 },
        ],
        style: { color: '#e91e63', lineWidth: 3 },
      },
      {
        shape: 'text',
        points: [{ time: timeAt(15), price: low + span * 0.6 }],
        text: TEST_TEXT,
        style: { color: '#ff9800', fontSize: 14 },
      },
    ];

    const created: Created[] = [];
    // Creations that failed without an id, which may still have drawn something.
    let unanswered = 0;
    // However the test ends, after a timeout too: the drawings of the test go, and the chart holds
    // the drawings of before, and only they.
    onTestFinished(async () => {
      let failures: string[];
      try {
        failures = await removeOwnDrawings(beforeIds, created, planned, unanswered, tolerance);
        const left = await listAll();
        if (!sameJson(left.drawings.map(({ id }) => id).sort(), [...beforeIds].sort())) {
          failures.push(
            `The chart holds ${String(left.total)} drawings after the test and held ` +
              `${String(before.total)} before, or other ones`,
          );
        }
      } catch (error) {
        failures = [describeFailure(error)];
      }
      if (failures.length > 0) {
        throw new HarnessError(`The drawing test could not clean up: ${failures.join('; ')}`);
      }
    });
    const undoBefore = await page.bridge.evaluate(readUndoState, []);
    for (const plan of planned) {
      let made: ToolSuccess<{ id: string; shape: string }>;
      try {
        made = await callOk<{ id: string; shape: string }>(client, 'drawing_create', {
          shape: plan.shape,
          points: plan.points,
          ...(plan.text === undefined ? {} : { text: plan.text }),
          style: plan.style,
        });
      } catch (error) {
        unanswered += 1;
        throw error;
      }
      created.push({ id: made.data.id, planned: plan, warnings: made.warnings });
      expect(made.data.shape).toBe(plan.shape);
    }
    const undoAfter = await page.bridge.evaluate(readUndoState, []);
    const focus = await page.bridge.evaluate(readFocusKind, []);
    const ui = await callOk<{ dialogs: string[] }>(client, 'app_get_ui_state');

    const after = await listAll();
    expect(after.total).toBe(before.total + planned.length);
    const timeBases: { shape: string; dayStarts: boolean; equalToSent: boolean }[] = [];
    for (const { id, planned: plan } of created) {
      const listed = after.drawings.find((drawing) => drawing.id === id);
      expect(listed?.createdByServer, 'drawing_list marks the drawing as made by the session').toBe(
        true,
      );
      const detail = (await callOk<DrawingDetail>(client, 'drawing_get', { id })).data;
      expect(detail.shape).toBe(plan.shape);
      expect(detail.points.length).toBe(plan.points.length);
      expect(detail.locked).toBe(false);
      expect(detail.hidden).toBe(false);
      expect(detail.createdByServer).toBe(true);
      expect(detail.text === (plan.text ?? null), 'the text reads back').toBe(true);
      detail.points.forEach((point, index) => {
        const sent = plan.points[index];
        expect(
          sent !== undefined && Math.abs(point.price - sent.price) <= tolerance,
          'a point reads back at its price',
        ).toBe(true);
        expect(
          sent !== undefined && Math.abs(point.time - sent.time) <= step,
          'a point reads back within a bar of its time',
        ).toBe(true);
      });
      timeBases.push({
        shape: plan.shape,
        dayStarts: detail.points.every(({ time }) => time % 86_400 === 0),
        equalToSent: detail.points.every(({ time }, index) => plan.points[index]?.time === time),
      });
      if (plan.style.color !== undefined) {
        expect(detail.style.color?.toLowerCase()).toBe(plan.style.color);
      }
      if (plan.style.lineWidth !== undefined) {
        expect(detail.style.lineWidth).toBe(plan.style.lineWidth);
      }
      if (plan.style.lineStyle !== undefined) {
        expect(detail.style.lineStyle).toBe(plan.style.lineStyle);
      }
      if (plan.style.fontSize !== undefined) {
        expect(detail.style.fontSize).toBe(plan.style.fontSize);
      }
    }
    observe('drawing creation', {
      idsAreSixAlphanumerics: created.every(({ id }) => /^[A-Za-z0-9]{6}$/.test(id)),
      warnings: created.map(({ planned: plan, warnings }) => ({ shape: plan.shape, warnings })),
      undoStepsAdded:
        undoBefore === null || undoAfter === null
          ? null
          : undoAfter.undoCount - undoBefore.undoCount,
      undoTextChanged:
        undoBefore === null || undoAfter === null
          ? null
          : undoAfter.undoText !== undoBefore.undoText,
      focusAfterText: focus,
      dialogsAfterCreation: ui.data.dialogs.length,
      timeBases,
    });
    expect(ui.data.dialogs.length, 'no dialog opened').toBe(0);
    expect(
      created.every(({ warnings }) => warnings.length === 0),
      'every style was applied',
    ).toBe(true);

    // Two go one by one, the third with the scope of the session's own drawings.
    for (const own of created.slice(0, 2)) {
      const removed = await callOk<{ removed: string }>(client, 'drawing_remove', { id: own.id });
      expect(removed.data.removed).toBe(own.id);
    }
    const cleared = await callOk<{ removed: number; failed: string[] }>(
      client,
      'drawing_clear_all',
      { scope: 'created_by_mcp' },
    );
    expect(cleared.data).toEqual({ removed: 1, failed: [] });
    const undoRemoved = await page.bridge.evaluate(readUndoState, []);
    observe('drawing removal', {
      undoStepsAddedByRemovals:
        undoAfter === null || undoRemoved === null
          ? null
          : undoRemoved.undoCount - undoAfter.undoCount,
    });
    const left = await listAll();
    expect(left.total).toBe(before.total);
    expect(
      left.drawings.every(({ id }) => beforeIds.has(id)),
      'the drawings of before are left, and only they',
    ).toBe(true);

    // An id that is not on the chart any more.
    const gone = await callFailure(client, 'drawing_remove', { id: created[0]?.id ?? 'zz9zz9' });
    expect(gone.code).toBe('INVALID_INPUT');
  });
});
