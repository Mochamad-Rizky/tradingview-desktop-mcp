import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpServer } from '../../../src/server.js';
import type { SessionState } from '../../../src/tools/types.js';
import { startFakeCdpServer } from '../../helpers/fake-cdp/server.js';
import { loadTargetsFixture } from '../../helpers/fake-cdp/targets.js';
import type { FixtureShape } from '../../helpers/fake-tv/fixture.js';
import { loadTvFixture, type TvStateFixture } from '../../helpers/fake-tv/fixture.js';
import { syntheticBars } from '../../helpers/fake-tv/synthetic-bars.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTvOverrides,
  type FakeTvWindow,
} from '../../helpers/fake-tv/window.js';
import { callTool, connectInMemoryClient, textOf } from '../../helpers/mcp-client.js';
import { quietLogger, refusingLauncher, testConfig } from '../../helpers/tool-context.js';

// The drawing tools through the whole server: an SDK client over the in-memory transport, the real
// registry, connection manager and CDP adapter, and the fake debug port of the app with a fake
// chart behind it. Values are synthetic.

// Nothing in this file may run a real program or start TradingView.
vi.mock('node:child_process', () => ({
  spawn: () => {
    throw new Error('A test tried to start a real program with spawn');
  },
  execFile: () => {
    throw new Error('A test tried to start a real program with execFile');
  },
}));

const fixture = loadTvFixture();
const bars = syntheticBars(fixture.bars);

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function connect(server: McpServer): Promise<Client> {
  const client = await connectInMemoryClient(server);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

// A server behind a fake app showing `win`, with the session state of the server.
async function startHarnessWith(
  win: FakeTvWindow,
): Promise<{ client: Client; win: FakeTvWindow; session: SessionState }> {
  const app = await startFakeCdpServer({ targets: loadTargetsFixture({ chartWindow: () => win }) });
  cleanups.push(() => app.close());
  const config = testConfig({ cdpPort: app.port, callTimeoutMs: 5000 });
  const { server, ctx } = createMcpServer(config, {
    launcher: refusingLauncher(),
    logger: quietLogger,
  });
  cleanups.push(() => ctx.connection.close());
  return { client: await connect(server), win, session: ctx.session };
}

function startHarness(
  from: TvStateFixture = fixture,
  overrides: FakeTvOverrides = {},
): Promise<{ client: Client; win: FakeTvWindow; session: SessionState }> {
  return startHarnessWith(createFakeTvWindow(from, overrides));
}

interface Envelope {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; hint?: string; details?: Record<string, unknown> };
  meta: { via?: string; durationMs: number; warnings?: string[] };
}

interface ListedDrawing {
  id: string;
  shape: string;
  points: { time: number; timeIso: string; price: number }[];
  text: string | null;
  createdByServer: boolean;
}

const envelopeOf = (result: { structuredContent?: unknown }): Envelope =>
  result.structuredContent as Envelope;
const dataOf = (result: { structuredContent?: unknown }) => envelopeOf(result).data ?? {};
const errorOf = (result: { structuredContent?: unknown }) => envelopeOf(result).error;
const warningsOf = (result: { structuredContent?: unknown }) =>
  envelopeOf(result).meta.warnings ?? [];
const drawingsOf = (result: { structuredContent?: unknown }) =>
  (dataOf(result).drawings ?? []) as ListedDrawing[];

const isoOf = (time: number) => new Date(time * 1000).toISOString().replace('.000Z', 'Z');
const timeOf = (index: number): number => bars[index]?.[0] ?? Number.NaN;
const closeOf = (index: number): number => bars[index]?.[4] ?? Number.NaN;

const calls = (win: FakeTvWindow, name: string) => inspectFakeWindow(win).callsTo(name);
const shapesOn = (win: FakeTvWindow) =>
  inspectFakeWindow(win).state.drawings.list.map(({ id }) => id);

// n points on consecutive bars from bar 10.
const pointsOf = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    time: timeOf(10 + index),
    price: 100 + index,
  }));

// The drawings of a user's chart: count of them, of several types, every seventh one locked.
function userShapes(count: number): FixtureShape[] {
  const types = ['trend_line', 'horizontal_line', 'rectangle', 'text', 'brush', 'fib_retracement'];
  return Array.from({ length: count }, (_, index) => ({
    id: `USR${String(index + 1).padStart(3, '0')}`,
    name: types[index % types.length] ?? 'trend_line',
    ...(index % 7 === 0 ? { properties: { frozen: true } } : {}),
  }));
}

// The properties of a shape like the rectangle of the fake app, without `key`.
function withoutKey(key: string): Record<string, string | number | boolean> {
  const properties: Record<string, string | number | boolean> = {
    color: '#9C27B0',
    linewidth: 2,
    linestyle: 0,
    fontSize: 14,
    text: '',
    frozen: false,
    visible: true,
  };
  return Object.fromEntries(Object.entries(properties).filter(([name]) => name !== key));
}

describe('drawing_create', () => {
  test('drawing_create validates the point count per shape', async () => {
    const { client, win } = await startHarness();

    for (const [shape, given, expected] of [
      ['trend_line', 1, 2],
      ['triangle', 2, 3],
      ['horizontal_line', 2, 1],
      ['parallel_channel', 4, 3],
    ] as const) {
      const result = await callTool(client, 'drawing_create', { shape, points: pointsOf(given) });

      expect(result.isError).toBe(true);
      expect(errorOf(result)).toMatchObject({
        code: 'INVALID_INPUT',
        message: expect.stringContaining(`${shape} takes ${String(expected)} point`) as string,
        details: { shape, expected, given },
      });
    }
    // Checked before the app is asked anything.
    expect(inspectFakeWindow(win).calls).toEqual([]);
    expect(shapesOn(win)).toEqual(['SHAPE01', 'SHAPE02', 'SHAPE03']);
  });

  test('creates a trend line and records its id in the session', async () => {
    const { client, win, session } = await startHarness();

    const result = await callTool(client, 'drawing_create', {
      shape: 'trend_line',
      points: [
        { time: timeOf(10), price: 100 },
        { time: timeOf(20), price: 104.5 },
      ],
    });

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: { id: 'DRW001', shape: 'trend_line' },
      meta: { via: 'api', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(JSON.parse(textOf(result))).toStrictEqual(result.structuredContent);
    expect(session.createdDrawingIds).toEqual(new Set(['DRW001']));
    // Drawn the way the user could undo: nothing in the options bypasses the undo history.
    expect(calls(win, 'chart.createMultipointShape')).toEqual([
      [
        [
          { time: timeOf(10), price: 100 },
          { time: timeOf(20), price: 104.5 },
        ],
        { shape: 'trend_line' },
      ],
    ]);
    expect(shapesOn(win)).toEqual(['SHAPE01', 'SHAPE02', 'SHAPE03', 'DRW001']);
    const listed = drawingsOf(await callTool(client, 'drawing_list'));
    expect(listed.map(({ id, createdByServer }) => [id, createdByServer])).toEqual([
      ['SHAPE01', false],
      ['SHAPE02', false],
      ['SHAPE03', false],
      ['DRW001', true],
    ]);
  });

  test('drawing_create applies text and style through the creation options, not afterwards', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'drawing_create', {
      shape: 'horizontal_line',
      points: [{ time: timeOf(30), price: 102.5 }],
      text: 'Resistance',
      style: { color: '#FF5500', lineWidth: 3, lineStyle: 'dashed', fontSize: 18 },
    });

    expect(dataOf(result)).toEqual({ id: 'DRW001', shape: 'horizontal_line' });
    expect(warningsOf(result)).toEqual([]);
    expect(calls(win, 'chart.createShape')).toEqual([
      [
        { time: timeOf(30), price: 102.5 },
        {
          shape: 'horizontal_line',
          text: 'Resistance',
          overrides: { linecolor: '#FF5500', linewidth: 3, linestyle: 2, fontsize: 18 },
        },
      ],
    ]);
    expect(calls(win, 'shape.setProperties')).toEqual([]);
    expect(calls(win, 'shape.setPoints')).toEqual([]);
    expect(dataOf(await callTool(client, 'drawing_get', { id: 'DRW001' }))).toMatchObject({
      text: 'Resistance',
      style: { color: '#FF5500', lineWidth: 3, lineStyle: 'dashed', fontSize: 18 },
    });
  });

  test('drawing_create sends a style to the keys of each kind of shape', async () => {
    const { client, win } = await startHarness();
    const style = { color: '#00AA00', lineWidth: 2, lineStyle: 'dotted', fontSize: 12 };

    await callTool(client, 'drawing_create', { shape: 'rectangle', points: pointsOf(2), style });
    const text = await callTool(client, 'drawing_create', {
      shape: 'text',
      points: pointsOf(1),
      text: 'Breakout',
      style,
    });

    expect(calls(win, 'chart.createMultipointShape')[0]?.[1]).toEqual({
      shape: 'rectangle',
      overrides: { color: '#00AA00', linewidth: 2, linestyle: 1, fontSize: 12 },
    });
    expect(calls(win, 'chart.createShape')[0]?.[1]).toEqual({
      shape: 'text',
      text: 'Breakout',
      overrides: { color: '#00AA00', fontsize: 12 },
    });
    // A text has no line, so its line width and style are not sent, and the result says so.
    expect(warningsOf(text)).toEqual([
      'style.lineWidth was not applied: a text drawing has no line width.',
      'style.lineStyle was not applied: a text drawing has no line style.',
    ]);
  });

  test('times above 1e11 are milliseconds, ISO strings are accepted, and points are reported in seconds with ISO', async () => {
    const { client, win } = await startHarness();

    const created = await callTool(client, 'drawing_create', {
      shape: 'trend_line',
      points: [
        { time: timeOf(40) * 1000, price: 99.5 },
        { time: isoOf(timeOf(45)), price: 101 },
      ],
    });

    expect(created.isError).not.toBe(true);
    expect(calls(win, 'chart.createMultipointShape')[0]?.[0]).toEqual([
      { time: timeOf(40), price: 99.5 },
      { time: timeOf(45), price: 101 },
    ]);
    const expected = [
      { time: timeOf(40), timeIso: isoOf(timeOf(40)), price: 99.5 },
      { time: timeOf(45), timeIso: isoOf(timeOf(45)), price: 101 },
    ];
    expect(dataOf(await callTool(client, 'drawing_get', { id: 'DRW001' })).points).toEqual(
      expected,
    );
    expect(
      drawingsOf(await callTool(client, 'drawing_list')).find(({ id }) => id === 'DRW001')?.points,
    ).toEqual(expected);
  });

  test('drawing_create refuses a time it cannot read before asking the app', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'drawing_create', {
      shape: 'horizontal_line',
      points: [{ time: '20240131', price: 1 }],
    });

    expect(errorOf(result)?.code).toBe('INVALID_INPUT');
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('drawing_create checks chartIndex against the layout', async () => {
    const { client } = await startHarness();

    const result = await callTool(client, 'drawing_create', {
      shape: 'horizontal_line',
      points: pointsOf(1),
      chartIndex: 2,
    });

    expect(errorOf(result)?.code).toBe('INVALID_INPUT');
  });
});

describe('the gate of drawings', () => {
  test('drawing_create refuses a signed-out account with AUTH_REQUIRED, and no sign-in wall opens', async () => {
    const { client, win, session } = await startHarness();
    inspectFakeWindow(win).state.pineEditor.signedIn = false;

    const result = await callTool(client, 'drawing_create', {
      shape: 'horizontal_line',
      points: pointsOf(1),
    });

    expect(errorOf(result)?.code).toBe('AUTH_REQUIRED');
    expect(calls(win, 'chart.createShape')).toEqual([]);
    expect(calls(win, 'dialog.signIn')).toEqual([]);
    expect(session.createdDrawingIds.size).toBe(0);
  });

  test('drawing_create refuses with NOT_AVAILABLE where TradingView gates drawings, and no paywall opens', async () => {
    const { client, win } = await startHarness(fixture, {
      drawings: { experiment: 'treatment' },
    });

    const result = await callTool(client, 'drawing_create', {
      shape: 'trend_line',
      points: pointsOf(2),
    });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      hint: expect.stringMatching(/gated on this account/) as string,
    });
    expect(calls(win, 'chart.createMultipointShape')).toEqual([]);
    expect(calls(win, 'dialog.paywall')).toEqual([]);
  });

  test('drawing_create refuses with NOT_AVAILABLE when it cannot tell whether drawings are gated', async () => {
    const { client, win } = await startHarness(fixture, {
      drawings: { withoutExperiment: true },
    });

    const result = await callTool(client, 'drawing_create', {
      shape: 'horizontal_line',
      points: pointsOf(1),
    });

    expect(errorOf(result)?.code).toBe('NOT_AVAILABLE');
    expect(calls(win, 'chart.createShape')).toEqual([]);
  });
});

describe('texts', () => {
  test('drawing_create refuses a text for a shape that takes none, and a text or note without one', async () => {
    const { client, win } = await startHarness();

    const flag = await callTool(client, 'drawing_create', {
      shape: 'flag',
      points: pointsOf(1),
      text: 'Entry',
    });
    const text = await callTool(client, 'drawing_create', { shape: 'text', points: pointsOf(1) });
    const note = await callTool(client, 'drawing_create', {
      shape: 'note',
      points: pointsOf(1),
      text: '  ',
    });

    expect(errorOf(flag)).toMatchObject({
      code: 'INVALID_INPUT',
      message: 'A flag drawing takes no text',
    });
    expect(errorOf(text)).toMatchObject({
      code: 'INVALID_INPUT',
      message: 'A text drawing needs a text',
    });
    expect(errorOf(note)).toMatchObject({ code: 'INVALID_INPUT', message: 'The text is blank' });
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('drawing_create relays as INVALID_INPUT a text TradingView refuses for its tool, and nothing is drawn', async () => {
    const triangle = withoutKey('text');
    const { client, win, session } = await startHarness(fixture, {
      drawings: { classes: { LineToolTriangle: { properties: triangle } } },
    });

    const result = await callTool(client, 'drawing_create', {
      shape: 'triangle',
      points: pointsOf(3),
      text: 'Pattern',
    });

    expect(errorOf(result)).toMatchObject({
      code: 'INVALID_INPUT',
      message: 'TradingView takes no text for a triangle drawing',
    });
    expect(shapesOn(win)).toEqual(['SHAPE01', 'SHAPE02', 'SHAPE03']);
    expect(session.createdDrawingIds.size).toBe(0);
  });
});

describe('styles', () => {
  test('drawing_create warns about a style TradingView did not apply, and keeps the drawing', async () => {
    const { client, session } = await startHarness(fixture, {
      drawings: {
        classes: {
          LineToolTrendLine: {
            properties: { linecolor: '#2962FF', linestyle: 0, text: '', frozen: false },
          },
        },
      },
    });

    const result = await callTool(client, 'drawing_create', {
      shape: 'trend_line',
      points: pointsOf(2),
      style: { color: '#FF5500', lineWidth: 3 },
    });

    expect(dataOf(result)).toEqual({ id: 'DRW001', shape: 'trend_line' });
    expect(warningsOf(result)).toEqual([
      'style.lineWidth was not applied: TradingView has no linewidth property for a trend_line ' +
        'drawing.',
    ]);
    expect(session.createdDrawingIds).toEqual(new Set(['DRW001']));
  });
});

describe('point counts', () => {
  test('drawing_create refuses a shape whose point count the line-tool registry disputes, naming both counts', async () => {
    const { client, win } = await startHarness(fixture, {
      drawings: { classes: { LineToolEllipse: { pointsCount: 3 } } },
    });

    const result = await callTool(client, 'drawing_create', {
      shape: 'ellipse',
      points: pointsOf(2),
    });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: 'TradingView takes 3 points for an ellipse drawing, where this server expects 2',
      details: { shape: 'ellipse', expected: 2, reported: 3 },
    });
    expect(calls(win, 'chart.createMultipointShape')).toEqual([]);
    expect(shapesOn(win)).toEqual(['SHAPE01', 'SHAPE02', 'SHAPE03']);
  });

  test('drawing_create confirms unverified point counts with the registry and skips those seen on the app', async () => {
    const { client, win } = await startHarness();

    await callTool(client, 'drawing_create', { shape: 'horizontal_line', points: pointsOf(1) });
    await callTool(client, 'drawing_create', { shape: 'rectangle', points: pointsOf(2) });
    await callTool(client, 'drawing_create', { shape: 'text', points: pointsOf(1), text: 'a' });
    expect(calls(win, 'lineTools.ensureLineToolLoaded')).toEqual([]);

    const triangle = await callTool(client, 'drawing_create', {
      shape: 'triangle',
      points: pointsOf(3),
    });

    expect(dataOf(triangle)).toEqual({ id: 'DRW004', shape: 'triangle' });
    expect(calls(win, 'lineTools.ensureLineToolLoaded')).toEqual([['LineToolTriangle']]);
  });
});

describe('drawing_list', () => {
  test('drawing_list pages with offset and limit and reports total', async () => {
    const { client } = await startHarness({ ...fixture, shapes: userShapes(12) });
    await callTool(client, 'drawing_create', {
      shape: 'horizontal_line',
      points: [{ time: timeOf(50), price: 103 }],
      text: 'R1',
    });

    const first = await callTool(client, 'drawing_list', { limit: 5 });
    const last = await callTool(client, 'drawing_list', { offset: 10, limit: 5 });
    const beyond = await callTool(client, 'drawing_list', { offset: 20 });

    expect(dataOf(first).total).toBe(13);
    expect(drawingsOf(first).map(({ id }) => id)).toEqual([
      'USR001',
      'USR002',
      'USR003',
      'USR004',
      'USR005',
    ]);
    expect(drawingsOf(first)[1]).toEqual({
      id: 'USR002',
      shape: 'horizontal_line',
      points: [{ time: timeOf(3), timeIso: isoOf(timeOf(3)), price: closeOf(3) }],
      text: null,
      createdByServer: false,
    });
    expect(dataOf(last).total).toBe(13);
    expect(drawingsOf(last)).toEqual([
      expect.objectContaining({ id: 'USR011', createdByServer: false }),
      expect.objectContaining({ id: 'USR012', createdByServer: false }),
      {
        id: 'DRW001',
        shape: 'horizontal_line',
        points: [{ time: timeOf(50), timeIso: isoOf(timeOf(50)), price: 103 }],
        text: 'R1',
        createdByServer: true,
      },
    ]);
    expect(dataOf(beyond)).toEqual({ total: 13, drawings: [] });
  });

  test('drawing_list only reads', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'drawing_list');

    expect(envelopeOf(result)).toMatchObject({ ok: true, meta: { via: 'api', warnings: [] } });
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('drawing_list warns about a drawing it could not read', async () => {
    const win = createFakeTvWindow(fixture);
    const { client } = await startHarnessWith(win);
    const chart = win.TradingViewApi?.activeChart();
    if (chart === undefined) {
      throw new Error('The fake window has no chart');
    }
    chart.getShapeById = () => {
      throw new Error('There is no such shape');
    };

    const result = await callTool(client, 'drawing_list');

    expect(drawingsOf(result)).toHaveLength(3);
    expect(warningsOf(result)).toEqual([
      'The drawings SHAPE01, SHAPE02 and SHAPE03 could not be read, so their points and text ' +
        'are left out.',
    ]);
  });
});

describe('drawing_get', () => {
  test('drawing_get reports the points, text and style of a drawing, and whether it is locked or hidden', async () => {
    const { client, win } = await startHarness({
      ...fixture,
      shapes: [
        {
          id: 'USR001',
          name: 'rectangle',
          points: [
            { time: timeOf(60), price: 98 },
            { time: timeOf(70), price: 104 },
          ],
          properties: {
            color: '#00AA00',
            linewidth: 1,
            text: 'Zone',
            frozen: true,
            visible: false,
          },
        },
      ],
    });

    const result = await callTool(client, 'drawing_get', { id: 'USR001' });

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: {
        id: 'USR001',
        shape: 'rectangle',
        points: [
          { time: timeOf(60), timeIso: isoOf(timeOf(60)), price: 98 },
          { time: timeOf(70), timeIso: isoOf(timeOf(70)), price: 104 },
        ],
        text: 'Zone',
        style: { color: '#00AA00', lineWidth: 1, lineStyle: 'solid', fontSize: 14 },
        locked: true,
        hidden: true,
        createdByServer: false,
      },
      meta: { via: 'api', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('drawing_get of an unknown id is INVALID_INPUT with the hint drawing_list', async () => {
    const { client } = await startHarness();

    const result = await callTool(client, 'drawing_get', { id: 'NOPE01' });

    expect(errorOf(result)).toMatchObject({
      code: 'INVALID_INPUT',
      hint: expect.stringMatching(/drawing_list/) as string,
    });
  });
});

describe('drawing_remove', () => {
  test('drawing_remove of a drawing the session did not create requires confirm', async () => {
    const { client, win } = await startHarness();

    const refused = await callTool(client, 'drawing_remove', { id: 'SHAPE02' });

    expect(errorOf(refused)).toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      details: { id: 'SHAPE02', shape: 'horizontal_line' },
    });
    expect(calls(win, 'chart.removeEntity')).toEqual([]);
    expect(shapesOn(win)).toEqual(['SHAPE01', 'SHAPE02', 'SHAPE03']);

    const removed = await callTool(client, 'drawing_remove', { id: 'SHAPE02', confirm: true });

    expect(dataOf(removed)).toEqual({ removed: 'SHAPE02' });
    expect(calls(win, 'chart.removeEntity')).toEqual([['SHAPE02']]);
    expect(inspectFakeWindow(win).state.drawings.removed).toEqual([
      { id: 'SHAPE02', undoable: true },
    ]);
  });

  test('drawing_remove of an unknown id is INVALID_INPUT with the hint drawing_list', async () => {
    const { client, win } = await startHarness();

    for (const confirm of [false, true]) {
      const result = await callTool(client, 'drawing_remove', { id: 'NOPE01', confirm });

      expect(errorOf(result)).toMatchObject({
        code: 'INVALID_INPUT',
        hint: expect.stringMatching(/drawing_list/) as string,
        details: { id: 'NOPE01' },
      });
    }
    expect(calls(win, 'chart.removeEntity')).toEqual([]);
  });

  test('drawing_remove of a drawing the session created needs no confirm, and the session forgets it', async () => {
    const { client, win, session } = await startHarness();
    await callTool(client, 'drawing_create', { shape: 'horizontal_line', points: pointsOf(1) });

    const result = await callTool(client, 'drawing_remove', { id: 'DRW001' });

    expect(dataOf(result)).toEqual({ removed: 'DRW001' });
    expect(session.createdDrawingIds.size).toBe(0);
    expect(shapesOn(win)).toEqual(['SHAPE01', 'SHAPE02', 'SHAPE03']);
  });
});

describe('drawing_clear_all', () => {
  test("clear_all created_by_mcp removes only this session's drawings and leaves the 50 pre-existing ones", async () => {
    const existing = userShapes(50);
    const { client, win, session } = await startHarness({ ...fixture, shapes: existing });
    for (const args of [
      { shape: 'trend_line', points: pointsOf(2) },
      { shape: 'horizontal_line', points: pointsOf(1), text: 'R1' },
      { shape: 'rectangle', points: pointsOf(2) },
    ]) {
      expect((await callTool(client, 'drawing_create', args)).isError).not.toBe(true);
    }

    const result = await callTool(client, 'drawing_clear_all', { scope: 'created_by_mcp' });

    expect(dataOf(result)).toEqual({ removed: 3, failed: [] });
    expect(warningsOf(result)).toEqual([]);
    expect(calls(win, 'chart.removeEntity')).toEqual([['DRW001'], ['DRW002'], ['DRW003']]);
    expect(shapesOn(win)).toEqual(existing.map(({ id }) => id));
    expect(calls(win, 'chart.removeAllShapes')).toEqual([]);
    expect(session.createdDrawingIds.size).toBe(0);
    const listed = await callTool(client, 'drawing_list', { limit: 500 });
    expect(dataOf(listed).total).toBe(50);
    expect(drawingsOf(listed).every(({ createdByServer }) => !createdByServer)).toBe(true);
  });

  test('clear_all created_by_mcp keeps the ids of drawings that are not on the chart', async () => {
    const { client, win, session } = await startHarness();
    await callTool(client, 'drawing_create', { shape: 'horizontal_line', points: pointsOf(1) });
    // Gone from this chart: the user removed it, or it is on another chart or symbol.
    session.createdDrawingIds.add('ELSE01');

    const result = await callTool(client, 'drawing_clear_all', { scope: 'created_by_mcp' });

    expect(dataOf(result)).toEqual({ removed: 1, failed: [] });
    expect(calls(win, 'chart.removeEntity')).toEqual([['DRW001']]);
    expect(session.createdDrawingIds).toEqual(new Set(['ELSE01']));
  });

  test('clear_all all requires confirm', async () => {
    const { client, win, session } = await startHarness();
    await callTool(client, 'drawing_create', { shape: 'horizontal_line', points: pointsOf(1) });

    const result = await callTool(client, 'drawing_clear_all', { scope: 'all' });

    expect(errorOf(result)).toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      details: { scope: 'all', total: 4, createdByServer: 1 },
    });
    expect(calls(win, 'chart.removeEntity')).toEqual([]);
    expect(calls(win, 'chart.removeAllShapes')).toEqual([]);
    expect(shapesOn(win)).toEqual(['SHAPE01', 'SHAPE02', 'SHAPE03', 'DRW001']);
    expect(session.createdDrawingIds).toEqual(new Set(['DRW001']));
  });

  test('clear_all all with confirm removes every drawing', async () => {
    const { client, win, session } = await startHarness({
      ...fixture,
      shapes: [
        ...fixture.shapes,
        { id: 'LCK001', name: 'text', properties: { frozen: true } },
        { id: 'LCK002', name: 'trend_line', editable: false },
      ],
    });
    await callTool(client, 'drawing_create', { shape: 'horizontal_line', points: pointsOf(1) });

    const result = await callTool(client, 'drawing_clear_all', { scope: 'all', confirm: true });

    expect(dataOf(result)).toEqual({ removed: 6, failed: [] });
    expect(shapesOn(win)).toEqual([]);
    expect(calls(win, 'chart.removeEntity')).toEqual([
      ['SHAPE01'],
      ['SHAPE02'],
      ['SHAPE03'],
      ['LCK001'],
      ['LCK002'],
      ['DRW001'],
    ]);
    // Never through removeAllShapes, which opens a confirmation dialog over a locked drawing.
    expect(calls(win, 'chart.removeAllShapes')).toEqual([]);
    expect(calls(win, 'dialog.confirmRemovingLockedLineTools')).toEqual([]);
    expect(session.createdDrawingIds.size).toBe(0);
  });

  test('drawing_clear_all names the drawings TradingView would not remove', async () => {
    const win = createFakeTvWindow(fixture);
    const chart = win.TradingViewApi?.activeChart();
    if (chart === undefined) {
      throw new Error('The fake window has no chart');
    }
    const remove = chart.removeEntity.bind(chart);
    chart.removeEntity = (id, options) => {
      if (id !== 'SHAPE02') {
        remove(id, options);
      }
    };
    const { client } = await startHarnessWith(win);

    const result = await callTool(client, 'drawing_clear_all', { scope: 'all', confirm: true });

    expect(dataOf(result)).toEqual({ removed: 2, failed: ['SHAPE02'] });
    expect(warningsOf(result)).toEqual([
      'TradingView did not remove 1 drawing: SHAPE02. drawing_list shows what is left.',
    ]);
  });
});
