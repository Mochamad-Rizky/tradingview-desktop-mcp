import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpServer } from '../../../src/server.js';
import { startFakeCdpServer } from '../../helpers/fake-cdp/server.js';
import { loadTargetsFixture } from '../../helpers/fake-cdp/targets.js';
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

// The tools that report what Pine scripts have drawn (pine_get_lines, pine_get_labels,
// pine_get_boxes and pine_get_tables) through the whole server: an SDK client over the in-memory
// transport, the real registry, connection manager and CDP adapter, and the fake debug port of the
// app with a fake chart behind it, whose first Pine study holds synthetic drawings. Values are
// synthetic.

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

async function startHarness(
  from: TvStateFixture = fixture,
  overrides: FakeTvOverrides = {},
  win: FakeTvWindow = createFakeTvWindow(from, overrides),
): Promise<{ client: Client; win: FakeTvWindow }> {
  const app = await startFakeCdpServer({ targets: loadTargetsFixture({ chartWindow: () => win }) });
  cleanups.push(() => app.close());
  const config = testConfig({ cdpPort: app.port, callTimeoutMs: 5000 });
  const { server, ctx } = createMcpServer(config, {
    launcher: refusingLauncher(),
    logger: quietLogger,
  });
  cleanups.push(() => ctx.connection.close());
  return { client: await connect(server), win };
}

interface Envelope {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; hint?: string; details?: Record<string, unknown> };
  meta: { via?: string; durationMs: number; warnings?: string[] };
}

const envelopeOf = (result: { structuredContent?: unknown }): Envelope =>
  result.structuredContent as Envelope;
const dataOf = (result: { structuredContent?: unknown }) => envelopeOf(result).data ?? {};
const errorOf = (result: { structuredContent?: unknown }) => envelopeOf(result).error;
const warningsOf = (result: { structuredContent?: unknown }) =>
  envelopeOf(result).meta.warnings ?? [];

const timeOf = (index: number): number => bars[index]?.[0] ?? Number.NaN;
const isoOf = (time: number) => new Date(time * 1000).toISOString().replace('.000Z', 'Z');
// The point of the bar at an index, as the tools report it.
const barAt = (index: number) => ({
  barIndex: index,
  time: timeOf(index),
  timeIso: isoOf(timeOf(index)),
});
const NO_TIME = { time: null, timeIso: null };

const TOOLS = ['pine_get_lines', 'pine_get_labels', 'pine_get_boxes', 'pine_get_tables'] as const;
const LIST_OF: Record<(typeof TOOLS)[number], string> = {
  pine_get_lines: 'lines',
  pine_get_labels: 'labels',
  pine_get_boxes: 'boxes',
  pine_get_tables: 'tables',
};

// The fixture with only the built-in study Volume on the chart.
const withoutPine: TvStateFixture = {
  ...fixture,
  studies: [{ id: 'VOL01', name: 'Volume', plots: ['plot_0'] }],
};

// The fixture with a built-in study next to its Pine studies.
const withBuiltin: TvStateFixture = {
  ...fixture,
  studies: [...fixture.studies, { id: 'VOL01', name: 'Volume', plots: ['plot_0'] }],
};

// The study core of a study of the fake chart.
function coreOf(win: FakeTvWindow, id: string) {
  const core = win.TradingViewApi?.activeChart().getStudyById(id).study();
  if (core === undefined) {
    throw new Error('The fake window has no chart');
  }
  return core;
}

describe('pine_get_lines', () => {
  test('pine_get_lines returns the lines the Pine scripts drew, newest first', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'pine_get_lines');

    expect(result.isError).not.toBe(true);
    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: {
        lines: [
          {
            studyId: 'STUDY01',
            id: '103',
            start: { barIndex: null, ...NO_TIME, price: 102.5 },
            end: { ...barAt(299), price: 102.5 },
            extend: 'left',
            color: null,
            width: 3,
            style: 'dotted',
          },
          {
            studyId: 'STUDY01',
            id: '102',
            start: { ...barAt(290), price: 106 },
            // In the empty space after the last bar, where the chart has no time point.
            end: { barIndex: 305, ...NO_TIME, price: 106 },
            extend: 'right',
            color: '#F23645',
            width: 1,
            style: 'dashed',
          },
          {
            studyId: 'STUDY01',
            id: '101',
            start: { ...barAt(280), price: 108.5 },
            end: { ...barAt(299), price: 104.25 },
            extend: 'none',
            color: '#2962FF',
            width: 2,
            style: 'solid',
          },
        ],
        total: 3,
      },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(JSON.parse(textOf(result))).toStrictEqual(result.structuredContent);
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('pine_get_lines gives a time to a point in the empty space the time scale keeps', async () => {
    const { client } = await startHarness(fixture, { futurePoints: 30 });

    const result = await callTool(client, 'pine_get_lines', { studyId: 'STUDY01' });

    const last = timeOf(299);
    expect((dataOf(result).lines as { id: string; end: unknown }[])[1]).toMatchObject({
      id: '102',
      end: {
        barIndex: 305,
        time: last + 6 * 86_400,
        timeIso: isoOf(last + 6 * 86_400),
        price: 106,
      },
    });
  });

  test('pine_get_lines with an unknown studyId fails INVALID_INPUT', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'pine_get_lines', { studyId: 'NOPE01' });

    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringMatching(/NOPE01/) as string,
      hint: expect.stringMatching(/indicator_list/) as string,
      details: { id: 'NOPE01' },
    });
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('pine_get_lines with the id of a study that is not a Pine script fails INVALID_INPUT', async () => {
    const { client } = await startHarness(withBuiltin);

    const result = await callTool(client, 'pine_get_lines', { studyId: 'VOL01' });

    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringMatching(/VOL01.*not a Pine script/) as string,
      hint: expect.stringMatching(/indicator_list/) as string,
    });
  });

  test('pine_get_lines reads one study when it is given one, and skips a study that is not Pine otherwise', async () => {
    const { client } = await startHarness(withBuiltin);

    const one = await callTool(client, 'pine_get_lines', { studyId: 'STUDY01' });
    const all = await callTool(client, 'pine_get_lines');

    expect(dataOf(one).total).toBe(3);
    expect(dataOf(all)).toStrictEqual(dataOf(one));
    expect(warningsOf(all)).toEqual([]);
  });

  test('pine_get_lines counts a script that indicator_list lists later as newer', async () => {
    const drawn: TvStateFixture = {
      ...fixture,
      studies: fixture.studies.map((study) =>
        study.id === 'STUDY02'
          ? {
              ...study,
              graphics: {
                palette: ['#00FF00'],
                lines: [
                  {
                    styleId: 'rsi_lines',
                    id: 1,
                    x1: 100,
                    y1: 50,
                    x2: 200,
                    y2: 60,
                    style: 'ar',
                    extend: 'b',
                    width: 4,
                    colorIndex: 0,
                  },
                ],
              },
            }
          : study,
      ),
    };
    const { client } = await startHarness(drawn);

    const all = await callTool(client, 'pine_get_lines');
    const two = await callTool(client, 'pine_get_lines', { limit: 2 });

    const keys = (result: { structuredContent?: unknown }) =>
      (dataOf(result).lines as { studyId: string; id: string }[]).map(
        ({ studyId, id }) => `${studyId}:${id}`,
      );
    expect(keys(all)).toEqual(['STUDY02:1', 'STUDY01:103', 'STUDY01:102', 'STUDY01:101']);
    expect(keys(two)).toEqual(['STUDY02:1', 'STUDY01:103']);
    expect(dataOf(two).total).toBe(4);
    expect((dataOf(all).lines as unknown[])[0]).toMatchObject({
      start: { barIndex: 100, time: timeOf(100), price: 50 },
      end: { barIndex: 200, time: timeOf(200), price: 60 },
      extend: 'both',
      color: '#00FF00',
      width: 4,
      style: 'arrow_right',
    });
  });

  test('pine_get_lines reports the colors of a script that sets them as packed integers', async () => {
    const packed = (red: number, green: number, blue: number, alpha: number): number =>
      red + 256 * green + 65_536 * blue + 16_777_216 * alpha;
    const colored: TvStateFixture = {
      ...fixture,
      studies: fixture.studies.map((study) =>
        study.id === 'STUDY01'
          ? {
              ...study,
              graphics: {
                isRGB: true,
                lines: [255, 128].map((alpha, id) => ({
                  styleId: 'lines_a',
                  id,
                  x1: 280,
                  y1: 100,
                  x2: 299,
                  y2: 101,
                  style: 'sol',
                  extend: 'n',
                  width: 1,
                  colorIndex: packed(41, 98, 255, alpha),
                })),
              },
            }
          : study,
      ),
    };
    const { client } = await startHarness(colored);

    const result = await callTool(client, 'pine_get_lines');

    expect((dataOf(result).lines as { color: string }[]).map(({ color }) => color)).toEqual([
      `rgba(41,98,255,${String(128 / 255)})`,
      'rgba(41,98,255,1)',
    ]);
  });

  test('pine_get_lines keeps the newest lines within the limit and counts them all', async () => {
    const { client } = await startHarness();

    const result = await callTool(client, 'pine_get_lines', { limit: 2 });

    expect((dataOf(result).lines as { id: string }[]).map(({ id }) => id)).toEqual(['103', '102']);
    expect(dataOf(result).total).toBe(3);
    expect(warningsOf(result)).toEqual([]);
  });
});

describe('pine_get_labels', () => {
  test('pine_get_labels returns the labels the Pine scripts drew, the last the app keeps first', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'pine_get_labels');

    expect(result.isError).not.toBe(true);
    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: {
        labels: [
          {
            studyId: 'STUDY01',
            id: 'labels_b:1',
            barIndex: 305,
            ...NO_TIME,
            price: 104,
            yloc: 'price',
            text: 'Next',
            color: '#2962FF',
            textColor: null,
            style: 'flag',
          },
          {
            studyId: 'STUDY01',
            id: 'labels_b:0',
            ...barAt(299),
            price: 103.42,
            yloc: 'auto',
            text: 'Last',
            color: null,
            textColor: '#F23645',
            style: 'none',
          },
          {
            studyId: 'STUDY01',
            id: 'labels_a:2',
            ...barAt(295),
            price: 105.5,
            yloc: 'price',
            text: 'Level',
            color: 'rgba(8, 153, 129, 0.4)',
            textColor: '#2962FF',
            style: 'label_center',
          },
          {
            studyId: 'STUDY01',
            id: 'labels_a:1',
            ...barAt(285),
            // Below its bar, where the price of the label means nothing.
            price: null,
            yloc: 'below_bar',
            text: 'Dip',
            color: '#2962FF',
            textColor: '#F23645',
            style: 'label_up',
          },
          {
            studyId: 'STUDY01',
            id: 'labels_a:0',
            ...barAt(290),
            price: null,
            yloc: 'above_bar',
            text: 'Peak',
            color: '#F23645',
            textColor: '#2962FF',
            style: 'label_down',
          },
        ],
        total: 5,
      },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('pine_get_labels keeps the newest labels within the limit', async () => {
    const { client } = await startHarness();

    const result = await callTool(client, 'pine_get_labels', { limit: 2 });

    expect((dataOf(result).labels as { text: string }[]).map(({ text }) => text)).toEqual([
      'Next',
      'Last',
    ]);
    expect(dataOf(result).total).toBe(5);
  });
});

describe('pine_get_boxes', () => {
  test('pine_get_boxes returns the boxes the Pine scripts drew, the last the app keeps first', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'pine_get_boxes');

    expect(result.isError).not.toBe(true);
    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: {
        boxes: [
          {
            studyId: 'STUDY01',
            id: 'boxes_b:0',
            // A box that runs on to the left has no first end.
            left: { barIndex: null, ...NO_TIME },
            right: barAt(299),
            top: 108,
            bottom: 107,
            extend: 'left',
            text: 'Floor',
            borderColor: null,
            bgColor: 'rgba(8, 153, 129, 0.4)',
          },
          {
            studyId: 'STUDY01',
            id: 'boxes_a:1',
            left: barAt(285),
            right: { barIndex: 305, ...NO_TIME },
            top: 104,
            bottom: 102,
            extend: 'right',
            text: '',
            borderColor: '#F23645',
            bgColor: null,
          },
          {
            studyId: 'STUDY01',
            id: 'boxes_a:0',
            left: barAt(270),
            right: barAt(299),
            top: 110.5,
            bottom: 106,
            extend: 'none',
            text: 'Range',
            borderColor: '#2962FF',
            bgColor: 'rgba(8, 153, 129, 0.4)',
          },
        ],
        total: 3,
      },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });
});

describe('pine_get_tables', () => {
  test('pine_get_tables returns the tables the Pine scripts drew with their cells, newest first', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'pine_get_tables');

    expect(result.isError).not.toBe(true);
    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: {
        tables: [
          {
            studyId: 'STUDY01',
            id: '202',
            position: 'bottom_left',
            rows: 1,
            columns: 1,
            cells: [{ row: 0, column: 0, text: 'Note' }],
          },
          {
            studyId: 'STUDY01',
            id: '201',
            position: 'top_right',
            rows: 2,
            columns: 2,
            // By row and column, whatever the order the cells were set in.
            cells: [
              { row: 0, column: 0, text: 'Trend' },
              { row: 0, column: 1, text: 'Bias' },
              { row: 1, column: 0, text: 'Up' },
              { row: 1, column: 1, text: 'Short' },
            ],
          },
        ],
        total: 2,
      },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('pine_get_tables joins the cells to tables whose ids are text, and warns about cells of no table', async () => {
    const custom = structuredClone(fixture);
    const [first] = custom.studies;
    if (first === undefined) {
      throw new Error('The fixture must hold a study');
    }
    first.graphics = {
      tables: [{ styleId: 'tables_a', id: 't1', position: 'top_right', rows: 1, columns: 2 }],
      tableCells: [
        { styleId: 'cells_a', tableId: 't1', row: 0, column: 1, text: 'Two' },
        { styleId: 'cells_a', tableId: 't1', row: 0, column: 0, text: 'One' },
        { styleId: 'cells_a', tableId: 'gone', row: 0, column: 0, text: 'Lost' },
      ],
    };
    const { client } = await startHarness(custom);

    const result = await callTool(client, 'pine_get_tables');

    expect(dataOf(result)).toStrictEqual({
      tables: [
        {
          studyId: 'STUDY01',
          id: 't1',
          position: 'top_right',
          rows: 1,
          columns: 2,
          cells: [
            { row: 0, column: 0, text: 'One' },
            { row: 0, column: 1, text: 'Two' },
          ],
        },
      ],
      total: 1,
    });
    expect(warningsOf(result)).toEqual([
      expect.stringMatching(/STUDY01 holds 1 table cell that belongs to no table it has/),
    ]);
  });

  test('pine_get_tables keeps the newest table within the limit', async () => {
    const { client } = await startHarness();

    const result = await callTool(client, 'pine_get_tables', { limit: 1 });

    expect((dataOf(result).tables as { id: string }[]).map(({ id }) => id)).toEqual(['202']);
    expect(dataOf(result).total).toBe(2);
  });
});

describe('the four tools', () => {
  test('pine outputs report an empty list for a study without drawings', async () => {
    const { client } = await startHarness();

    for (const tool of TOOLS) {
      const result = await callTool(client, tool, { studyId: 'STUDY02' });

      expect(result.isError).not.toBe(true);
      expect(envelopeOf(result)).toStrictEqual({
        ok: true,
        data: { [LIST_OF[tool]]: [], total: 0 },
        meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
      });
    }
  });

  test('pine outputs report an empty list, and say why, on a chart without a Pine script', async () => {
    const { client } = await startHarness(withoutPine);

    for (const tool of TOOLS) {
      const result = await callTool(client, tool);

      expect(dataOf(result)).toStrictEqual({ [LIST_OF[tool]]: [], total: 0 });
      expect(warningsOf(result)).toEqual([expect.stringMatching(/no Pine script/i) as string]);
    }
  });

  test('pine outputs fail INVALID_INPUT for an unknown studyId or a study that is not Pine', async () => {
    const { client } = await startHarness(withBuiltin);

    for (const tool of TOOLS) {
      const unknown = await callTool(client, tool, { studyId: 'NOPE01' });
      const builtin = await callTool(client, tool, { studyId: 'VOL01' });

      expect(errorOf(unknown)).toMatchObject({ code: 'INVALID_INPUT' });
      expect(errorOf(builtin)).toMatchObject({ code: 'INVALID_INPUT' });
    }
  });

  test('pine outputs change nothing and send nothing', async () => {
    const { client, win } = await startHarness();

    for (const tool of TOOLS) {
      await callTool(client, tool, { limit: 500 });
      await callTool(client, tool, { studyId: 'STUDY01', chartIndex: 0 });
    }

    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('pine outputs read the chart of the index they are given, and refuse one the layout lacks', async () => {
    const { client } = await startHarness();

    for (const tool of TOOLS) {
      const first = await callTool(client, tool, { chartIndex: 0 });
      const second = await callTool(client, tool, { chartIndex: 1 });

      expect(dataOf(first).total).toBeGreaterThan(0);
      expect(errorOf(second)).toMatchObject({
        code: 'INVALID_INPUT',
        details: { chartIndex: 1, chartsCount: 1 },
      });
    }
  });

  test.each([
    ['0', { limit: 0 }],
    ['501', { limit: 501 }],
    ['1.5', { limit: 1.5 }],
  ])('pine outputs refuse a limit of %s', async (_case, args) => {
    const { client } = await startHarness();

    for (const tool of TOOLS) {
      const result = await callTool(client, tool, args);

      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/limit/);
    }
  });

  test('pine outputs take a limit of 1 and of 500', async () => {
    const { client } = await startHarness();

    for (const tool of TOOLS) {
      for (const limit of [1, 500]) {
        const result = await callTool(client, tool, { limit });

        expect(result.isError).not.toBe(true);
      }
    }
  });

  test('pine outputs fail CAPABILITY_UNAVAILABLE, and report nothing, when a build has no graphics()', async () => {
    const win = createFakeTvWindow(fixture);
    Reflect.deleteProperty(coreOf(win, 'STUDY01'), 'graphics');
    const { client } = await startHarness(fixture, {}, win);

    for (const tool of TOOLS) {
      const all = await callTool(client, tool);
      const one = await callTool(client, tool, { studyId: 'STUDY01' });

      for (const result of [all, one]) {
        expect(result.isError).toBe(true);
        expect(errorOf(result)).toMatchObject({
          code: 'CAPABILITY_UNAVAILABLE',
          hint: expect.stringMatching(/app_health/) as string,
        });
      }
    }
  });

  test('pine outputs warn about a Pine study they could not read, and report the others', async () => {
    const win = createFakeTvWindow(fixture);
    coreOf(win, 'STUDY02').graphics = () => {
      throw new Error('No graphics yet');
    };
    const { client } = await startHarness(fixture, {}, win);

    for (const tool of TOOLS) {
      const result = await callTool(client, tool);

      expect(dataOf(result).total).toBeGreaterThan(0);
      expect(warningsOf(result)).toEqual([
        expect.stringMatching(/STUDY02.*could not be read/) as string,
      ]);
    }
  });

  test('pine outputs report the drawings of a Pine study that is hidden on the chart as well', async () => {
    const hidden: TvStateFixture = {
      ...fixture,
      studies: fixture.studies.map((study) => ({ ...study, visible: false })),
    };
    const { client } = await startHarness(hidden);

    const result = await callTool(client, 'pine_get_boxes');

    expect(dataOf(result).total).toBe(3);
  });

  test('pine outputs say that they only read', async () => {
    const { client } = await startHarness();

    const { tools } = await client.listTools();
    const wanted = tools.filter(({ name }) => (TOOLS as readonly string[]).includes(name));

    expect(wanted.map(({ name }) => name)).toEqual([...TOOLS]);
    for (const { annotations, description } of wanted) {
      expect(annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(description).toMatch(/changes nothing/);
      expect(description).toMatch(/studyId/);
      expect(description).toMatch(/limit/);
    }
  });
});
