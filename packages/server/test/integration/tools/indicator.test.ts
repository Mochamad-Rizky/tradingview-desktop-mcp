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

// The indicator tools through the whole server: an SDK client over the in-memory transport,
// the real registry, connection manager and CDP adapter, and the fake debug port of the app with a
// fake chart behind it. Values are synthetic.

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

const isoOf = (time: number) => new Date(time * 1000).toISOString().replace('.000Z', 'Z');
const timeOf = (index: number): number => bars[index]?.[0] ?? Number.NaN;
const closeOf = (index: number): number => bars[index]?.[4] ?? Number.NaN;
const round = (value: number) => Math.round(value * 100) / 100;

describe('indicator_list', () => {
  test('indicator_list returns studies with inputs and visibility', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'indicator_list');

    expect(result.isError).not.toBe(true);
    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: {
        studies: [
          {
            id: 'STUDY01',
            name: 'Moving Average',
            title: 'MA 9 close',
            visible: true,
            isPine: true,
            isStrategy: false,
            inputs: [
              { id: 'in_0', name: 'Length', type: 'integer', value: 9, options: null },
              { id: 'in_1', name: 'Source', type: 'source', value: 'close', options: null },
              { id: 'in_2', name: 'Offset', type: 'integer', value: 0, options: null },
            ],
          },
          {
            id: 'STUDY02',
            name: 'Relative Strength Index',
            title: 'RSI 14 close',
            visible: false,
            isPine: true,
            isStrategy: false,
            inputs: [
              { id: 'in_0', name: 'RSI Length', type: 'integer', value: 14, options: null },
              { id: 'in_1', name: 'Source', type: 'source', value: 'close', options: null },
              {
                id: 'in_2',
                name: 'Type',
                type: 'text',
                value: 'SMA',
                options: ['None', 'SMA', 'EMA'],
              },
            ],
          },
        ],
      },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(JSON.parse(textOf(result))).toStrictEqual(result.structuredContent);
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('indicator_list reports a strategy and a built-in study', async () => {
    const { client } = await startHarness({
      ...fixture,
      studies: [
        { id: 'S1', name: 'Volume', plots: ['plot_0'] },
        {
          id: 'S2',
          name: 'RSI Strategy',
          plots: [],
          strategy: true,
          pine: { scriptIdPart: 'STD;RSI%1Strategy', version: '12.0' },
        },
      ],
    });

    const result = await callTool(client, 'indicator_list', { chartIndex: 0 });

    expect(dataOf(result).studies).toMatchObject([
      { id: 'S1', isPine: false, isStrategy: false },
      { id: 'S2', isPine: true, isStrategy: true },
    ]);
  });

  test('indicator_list checks chartIndex against the layout', async () => {
    const { client } = await startHarness();

    const result = await callTool(client, 'indicator_list', { chartIndex: 2 });

    expect(errorOf(result)?.code).toBe('INVALID_INPUT');
  });
  test('indicator_list warns about a study it could not read', async () => {
    const win = createFakeTvWindow(fixture);
    const chart = win.TradingViewApi?.activeChart();
    if (chart === undefined) {
      throw new Error('The fake window has no chart');
    }
    chart.getStudyById = () => {
      throw new Error('There is no such study');
    };
    const { client } = await startHarness(fixture, {}, win);

    const result = await callTool(client, 'indicator_list');

    expect(dataOf(result).studies).toMatchObject([
      { id: 'STUDY01', title: 'Moving Average', inputs: [] },
      { id: 'STUDY02', title: 'Relative Strength Index', inputs: [] },
    ]);
    expect(warningsOf(result)).toEqual([
      expect.stringMatching(/STUDY01 could not be read/),
      expect.stringMatching(/STUDY02 could not be read/),
    ]);
  });
});

describe('indicator_search', () => {
  test('indicator_search finds Relative Strength Index by "rsi"', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'indicator_search', { query: 'rsi' });

    expect(result.isError).not.toBe(true);
    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: {
        results: [
          {
            name: 'Relative Strength Index',
            shortName: 'RSI',
            id: 'STD;RSI',
            kind: 'pine',
            isStrategy: false,
          },
          {
            name: 'RSI Strategy',
            shortName: 'RSI Strategy',
            id: 'STD;RSI%1Strategy',
            kind: 'pine',
            isStrategy: true,
          },
        ],
      },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    // The hidden legacy RSI of the built-ins is left out, and the only request is the list of
    // standard scripts the app itself asks for.
    expect(inspectFakeWindow(win).calls.map(({ name }) => name)).toEqual(['requestBuiltinScripts']);
  });

  test('indicator_search lists Pine scripts before built-ins and keeps to the limit', async () => {
    const { client } = await startHarness();

    const all = await callTool(client, 'indicator_search', { query: 'Volume' });
    const one = await callTool(client, 'indicator_search', { query: 'v', limit: 1 });

    expect(
      (dataOf(all).results as { id: string; kind: string }[]).map(({ id, kind }) => [id, kind]),
    ).toEqual([
      ['Volume@tv-basicstudies', 'builtin'],
      ['VbPFixed@tv-volumebyprice', 'builtin'],
      ['VbPVisible@tv-volumebyprice', 'builtin'],
    ]);
    expect(dataOf(one).results).toEqual([
      {
        name: 'Moving Average Convergence Divergence',
        shortName: 'MACD',
        id: 'STD;MACD',
        kind: 'pine',
        isStrategy: false,
      },
    ]);
  });

  test('indicator_search returns the built-ins with a warning when the standard scripts fail', async () => {
    const { client } = await startHarness(fixture, { builtinScriptsError: 'Network error' });

    const result = await callTool(client, 'indicator_search', { query: 'vol' });

    expect(result.isError).not.toBe(true);
    expect(
      (dataOf(result).results as { kind: string }[]).every(({ kind }) => kind === 'builtin'),
    ).toBe(true);
    expect(warningsOf(result)).toEqual([
      expect.stringMatching(/standard Pine scripts.*Network error/),
    ]);
  });

  test('indicator_search warns when this build has no study repository', async () => {
    const { client } = await startHarness(fixture, {
      webpackModules: { 1: { requestBuiltinScripts: () => Promise.resolve([]) } },
    });

    const result = await callTool(client, 'indicator_search', { query: 'rsi' });

    expect(dataOf(result).results).toEqual([]);
    expect(warningsOf(result)).toEqual([expect.stringMatching(/built-in/)]);
  });

  test('indicator_search fails CAPABILITY_UNAVAILABLE when neither source is there', async () => {
    const { client } = await startHarness(fixture, { webpackModules: {} });

    const result = await callTool(client, 'indicator_search', { query: 'rsi' });

    expect(errorOf(result)?.code).toBe('CAPABILITY_UNAVAILABLE');
  });

  test('indicator_search refuses a blank query', async () => {
    const { client } = await startHarness();

    const result = await callTool(client, 'indicator_search', { query: '   ' });

    expect(errorOf(result)?.code).toBe('INVALID_INPUT');
  });
});

describe('indicator_get_values', () => {
  test('indicator_get_values reads the last value of each plot by title', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'indicator_get_values', { id: 'STUDY02' });

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: {
        id: 'STUDY02',
        plots: ['RSI', 'RSI-based MA'],
        rows: [
          {
            time: timeOf(299),
            timeIso: isoOf(timeOf(299)),
            values: { RSI: closeOf(299), 'RSI-based MA': round(closeOf(299) + 1) },
          },
        ],
      },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('indicator_get_values at a time returns the bar at or before it', async () => {
    const { client } = await startHarness();
    const between = timeOf(150) + 3600;

    const result = await callTool(client, 'indicator_get_values', {
      id: 'STUDY01',
      at: isoOf(between),
      count: 3,
    });
    const exact = await callTool(client, 'indicator_get_values', {
      id: 'STUDY01',
      at: timeOf(150),
    });

    expect(dataOf(result)).toStrictEqual({
      id: 'STUDY01',
      plots: ['MA'],
      rows: [148, 149, 150].map((index) => ({
        time: timeOf(index),
        timeIso: isoOf(timeOf(index)),
        values: { MA: closeOf(index) },
      })),
    });
    expect((dataOf(exact).rows as { time: number }[]).map(({ time }) => time)).toEqual([
      timeOf(150),
    ]);
  });

  test('indicator_get_values keys plots stably and maps NaN to null', async () => {
    const { client } = await startHarness({
      ...fixture,
      studies: [
        {
          id: 'EMA2',
          name: 'EMA Cross',
          plots: ['plot_0', 'plot_1', { id: 'plot_2', type: 'colorer', target: 'plot_0' }],
          styles: { plot_0: 'EMA', plot_1: 'EMA' },
          warmup: 1,
        },
      ],
    });

    const result = await callTool(client, 'indicator_get_values', {
      id: 'EMA2',
      at: timeOf(1),
      count: 2,
    });

    expect(dataOf(result)).toStrictEqual({
      id: 'EMA2',
      plots: ['EMA', 'EMA#2'],
      rows: [
        { time: timeOf(0), timeIso: isoOf(timeOf(0)), values: { EMA: null, 'EMA#2': null } },
        {
          time: timeOf(1),
          timeIso: isoOf(timeOf(1)),
          values: { EMA: closeOf(1), 'EMA#2': round(closeOf(1) + 1) },
        },
      ],
    });
  });

  test('indicator_get_values says when the indicator has no values yet', async () => {
    const win = createFakeTvWindow(fixture);
    inspectFakeWindow(win).state.symbolInvalid = true;
    const { client } = await startHarness(fixture, {}, win);

    const result = await callTool(client, 'indicator_get_values', { id: 'STUDY01' });

    expect(dataOf(result)).toStrictEqual({ id: 'STUDY01', plots: ['MA'], rows: [] });
    expect(warningsOf(result)).toEqual([expect.stringMatching(/no values yet/)]);
  });

  test('indicator_get_values says when no bar lies at or before the time', async () => {
    const { client } = await startHarness();

    const result = await callTool(client, 'indicator_get_values', {
      id: 'STUDY02',
      at: timeOf(0) - 86_400,
    });

    expect(dataOf(result).rows).toEqual([]);
    expect(warningsOf(result)).toEqual([expect.stringMatching(/No bar of the chart/)]);
  });

  test('indicator_get_values fails INVALID_INPUT for an unknown id', async () => {
    const { client } = await startHarness();

    const result = await callTool(client, 'indicator_get_values', { id: 'NOPE01' });

    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringMatching(/NOPE01/) as string,
      hint: expect.stringMatching(/indicator_list/) as string,
    });
  });

  test('indicator_get_values refuses a time that is not one', async () => {
    const { client } = await startHarness();

    const result = await callTool(client, 'indicator_get_values', { id: 'STUDY01', at: 'soon' });

    expect(errorOf(result)?.code).toBe('INVALID_INPUT');
  });
});

// A chart with room for `limit` counted studies; the fixture holds two, which is its limit.
const roomy = (limit = 5, from: TvStateFixture = fixture): TvStateFixture => ({
  ...from,
  planLimits: { ...from.planLimits, INDICATORS_ON_CHART: limit },
});

// The chart of a fake window, to stage a situation on it.
function chartOf(win: FakeTvWindow) {
  const chart = win.TradingViewApi?.activeChart();
  if (chart === undefined) {
    throw new Error('The fake window has no chart');
  }
  return chart;
}

// The dialogs the app would have opened.
const dialogsOf = (win: FakeTvWindow) =>
  inspectFakeWindow(win).calls.filter(({ name }) => name.startsWith('dialog.'));

// The changes the server made to the studies.
const changesOf = (win: FakeTvWindow) =>
  inspectFakeWindow(win)
    .calls.filter(({ name }) => name.startsWith('chart.') || name.startsWith('study.'))
    .map(({ name, args }) => [name, ...args]);

describe('indicator_add', () => {
  test('indicator_add returns PLAN_LIMIT and adds nothing when the chart is full', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'indicator_add', { name: 'RSI' });

    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({
      code: 'PLAN_LIMIT',
      details: { feature: 'INDICATORS_ON_CHART', limit: 2 },
      hint: expect.stringMatching(/indicator_remove/) as string,
    });
    expect(inspectFakeWindow(win).callsTo('chart.createStudy')).toEqual([]);
    expect(dialogsOf(win)).toEqual([]);
    expect(chartOf(win).getAllStudies()).toHaveLength(2);
  });

  test('indicator_add passes checkLimit and records the id in the session', async () => {
    const { client, win } = await startHarness(roomy());

    const added = await callTool(client, 'indicator_add', { name: 'Volume' });
    const removed = await callTool(client, 'indicator_remove', { id: 'NEW001' });

    expect(envelopeOf(added)).toStrictEqual({
      ok: true,
      data: { id: 'NEW001', name: 'Volume', chartIndex: 0 },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(inspectFakeWindow(win).callsTo('chart.createStudy')).toEqual([
      ['Volume', false, false, undefined, undefined, { checkLimit: true }],
    ]);
    // Added by this session, so it goes without confirm.
    expect(dataOf(removed)).toEqual({ removed: 'NEW001' });
    expect(dialogsOf(win)).toEqual([]);
  });

  test('indicator_add inserts a standard Pine script by name, short name or id, with its version', async () => {
    const { client, win } = await startHarness(roomy());

    const byName = await callTool(client, 'indicator_add', { name: 'relative strength index' });
    const byShortName = await callTool(client, 'indicator_add', { name: 'macd', chartIndex: 0 });
    const byId = await callTool(client, 'indicator_add', { name: 'STD;SMA' });

    expect(dataOf(byName)).toEqual({
      id: 'NEW001',
      name: 'Relative Strength Index',
      chartIndex: 0,
    });
    expect(dataOf(byShortName)).toEqual({
      id: 'NEW002',
      name: 'Moving Average Convergence Divergence',
      chartIndex: 0,
    });
    expect(dataOf(byId)).toMatchObject({ id: 'NEW003', name: 'Moving Average' });
    expect(inspectFakeWindow(win).callsTo('chart.createStudy')).toEqual([
      [{ type: 'pine', pineId: 'STD;RSI', pineVersion: '41.0' }],
      [{ type: 'pine', pineId: 'STD;MACD', pineVersion: '28.0' }],
      [{ type: 'pine', pineId: 'STD;SMA', pineVersion: '36.0' }],
    ]);
  });

  test('indicator_add uses the java descriptor when a hidden study comes first by description', async () => {
    const custom = roomy();
    custom.studyCatalog = {
      ...custom.studyCatalog,
      builtins: [
        {
          id: 'VbPFixedLegacy@tv-volumebyprice',
          description: 'Volume Profile Fixed Range',
          shortDescription: 'VPFR',
          hidden: true,
        },
        ...custom.studyCatalog.builtins,
      ],
    };
    const { client, win } = await startHarness(custom);

    const result = await callTool(client, 'indicator_add', { name: 'VPFR', overlay: true });

    expect(dataOf(result)).toEqual({
      id: 'NEW001',
      name: 'Volume Profile Fixed Range',
      chartIndex: 0,
    });
    expect(inspectFakeWindow(win).callsTo('chart.createStudy')).toEqual([
      [{ type: 'java', studyId: 'VbPFixed@tv-volumebyprice' }],
    ]);
    expect(warningsOf(result)).toEqual([expect.stringMatching(/overlay was not applied/)]);
  });

  test('indicator_add honors overlay on the description path', async () => {
    const { client, win } = await startHarness(roomy());

    const result = await callTool(client, 'indicator_add', { name: 'vol', overlay: true });

    expect(warningsOf(result)).toEqual([]);
    expect(inspectFakeWindow(win).callsTo('chart.createStudy')).toEqual([
      ['Volume', true, false, undefined, undefined, { checkLimit: true }],
    ]);
  });

  test('indicator_add fails INVALID_INPUT for an unknown indicator name', async () => {
    const { client, win } = await startHarness(roomy());

    const unknown = await callTool(client, 'indicator_add', { name: 'No Such Indicator' });
    // A hidden built-in is never chosen, not even by its id.
    const hidden = await callTool(client, 'indicator_add', { name: 'RSI@tv-basicstudies' });

    for (const result of [unknown, hidden]) {
      expect(errorOf(result)).toMatchObject({
        code: 'INVALID_INPUT',
        hint: expect.stringMatching(/indicator_search/) as string,
      });
    }
    expect(inspectFakeWindow(win).callsTo('chart.createStudy')).toEqual([]);
  });

  test('indicator_add refuses indicators that need the input dialog of TradingView', async () => {
    const custom = roomy();
    custom.studyCatalog = {
      ...custom.studyCatalog,
      builtins: [
        { id: 'Spread@tv-basicstudies', description: 'Spread', shortDescription: 'Spread' },
        {
          id: 'Anchored@tv-synthetic',
          description: 'Anchored Line',
          shortDescription: 'AL',
          inputs: [{ id: 'start', name: 'Start', type: 'time', value: 0, confirm: true }],
        },
      ],
    };
    const { client, win } = await startHarness(custom);

    const spread = await callTool(client, 'indicator_add', { name: 'Spread' });
    const anchored = await callTool(client, 'indicator_add', { name: 'Anchored Line' });

    for (const result of [spread, anchored]) {
      expect(errorOf(result)).toMatchObject({
        code: 'NOT_AVAILABLE',
        hint: expect.stringMatching(/input dialog/) as string,
      });
    }
    expect(inspectFakeWindow(win).callsTo('chart.createStudy')).toEqual([]);
    expect(dialogsOf(win)).toEqual([]);
  });

  test('indicator_add takes the limit from canCreateStudy, else from the plan', async () => {
    const win = createFakeTvWindow(roomy());
    const model = chartOf(win)._chartWidget.model();
    const answers = [
      { success: false, reason: 'general', limitValue: 7 },
      { success: false, reason: 'general' },
    ];
    model.canCreateStudy = () => answers.shift() ?? { success: true };
    const { client } = await startHarness(fixture, {}, win);

    const fromCheck = await callTool(client, 'indicator_add', { name: 'RSI' });
    const fromPlan = await callTool(client, 'indicator_add', { name: 'RSI' });

    expect(errorOf(fromCheck)).toMatchObject({
      code: 'PLAN_LIMIT',
      details: { feature: 'INDICATORS_ON_CHART', limit: 7 },
    });
    expect(errorOf(fromPlan)).toMatchObject({
      code: 'PLAN_LIMIT',
      details: { feature: 'INDICATORS_ON_CHART', limit: 5 },
    });
    expect(inspectFakeWindow(win).callsTo('chart.createStudy')).toEqual([]);
  });

  test('indicator_add fails PLAN_LIMIT without a limit when neither the check nor the plan gives one', async () => {
    const otherLimits = Object.fromEntries(
      Object.entries(fixture.planLimits).filter(([feature]) => feature !== 'INDICATORS_ON_CHART'),
    );
    const win = createFakeTvWindow({ ...fixture, planLimits: otherLimits });
    chartOf(win)._chartWidget.model().canCreateStudy = () => ({
      success: false,
      reason: 'general',
    });
    const { client } = await startHarness(fixture, {}, win);

    const result = await callTool(client, 'indicator_add', { name: 'RSI' });

    expect(errorOf(result)).toMatchObject({
      code: 'PLAN_LIMIT',
      details: { feature: 'INDICATORS_ON_CHART' },
    });
    expect(errorOf(result)?.details).not.toHaveProperty('limit');
    expect(inspectFakeWindow(win).callsTo('chart.createStudy')).toEqual([]);
  });

  test('indicator_add asks canCreateStudy with the java id, or an empty id for Pine, and never the paywall check', async () => {
    const win = createFakeTvWindow(roomy());
    const model = chartOf(win)._chartWidget.model();
    const asked: unknown[] = [];
    const paywall = vi.fn();
    model.canCreateStudy = (spec) => {
      asked.push({ ...spec });
      return { success: true };
    };
    Object.assign(model, { checkIfFeatureAvailable: paywall });
    const { client } = await startHarness(fixture, {}, win);

    await callTool(client, 'indicator_add', { name: 'Volume' });
    await callTool(client, 'indicator_add', { name: 'RSI' });

    // Each is asked by the server before it adds anything, then by the check of the app.
    expect(asked).toEqual([
      { id: 'Volume@tv-basicstudies' },
      { id: 'Volume@tv-basicstudies' },
      { id: '' },
      { id: '' },
    ]);
    expect(inspectFakeWindow(win).callsTo('chart.createStudy')).toHaveLength(2);
    expect(paywall).not.toHaveBeenCalled();
  });

  test('indicator_add fails NOT_AVAILABLE for a study the plan does not allow for another reason', async () => {
    const win = createFakeTvWindow(roomy());
    const answers = [{ success: false, reason: 'fundamental' }, { success: false }];
    chartOf(win)._chartWidget.model().canCreateStudy = () => answers.shift() ?? { success: true };
    const { client } = await startHarness(fixture, {}, win);

    const result = await callTool(client, 'indicator_add', { name: 'RSI' });
    const unexplained = await callTool(client, 'indicator_add', { name: 'RSI' });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: expect.stringMatching(/fundamental/) as string,
      details: { reason: 'fundamental' },
    });
    expect(errorOf(unexplained)).toMatchObject({
      code: 'NOT_AVAILABLE',
      details: { reason: 'unknown' },
    });
    expect(inspectFakeWindow(win).callsTo('chart.createStudy')).toEqual([]);
  });

  test('indicator_add counts the studies against the plan when the model cannot check', async () => {
    const full = createFakeTvWindow(fixture);
    delete chartOf(full)._chartWidget.model().canCreateStudy;
    const room = createFakeTvWindow(roomy(3));
    delete chartOf(room)._chartWidget.model().canCreateStudy;
    const { client: fullClient } = await startHarness(fixture, {}, full);
    const { client: roomClient } = await startHarness(fixture, {}, room);

    const refused = await callTool(fullClient, 'indicator_add', { name: 'RSI' });
    const added = await callTool(roomClient, 'indicator_add', { name: 'RSI' });

    expect(errorOf(refused)).toMatchObject({
      code: 'PLAN_LIMIT',
      details: { feature: 'INDICATORS_ON_CHART', limit: 2 },
    });
    expect(inspectFakeWindow(full).callsTo('chart.createStudy')).toEqual([]);
    expect(dataOf(added)).toMatchObject({ id: 'NEW001' });
  });

  test('indicator_add applies inputs by id or name after the insert', async () => {
    const { client, win } = await startHarness(roomy());

    const result = await callTool(client, 'indicator_add', {
      name: 'Volume',
      inputs: { 'ma length': 50, col_prev_close: true },
    });

    expect(dataOf(result)).toMatchObject({ id: 'NEW001' });
    expect(changesOf(win)).toEqual([
      ['chart.createStudy', 'Volume', false, false, undefined, undefined, { checkLimit: true }],
      [
        'study.setInputValues',
        'NEW001',
        [
          { id: 'length', value: 50 },
          { id: 'col_prev_close', value: true },
        ],
      ],
    ]);
  });

  test('indicator_add checks the inputs of a built-in before it inserts anything', async () => {
    const { client, win } = await startHarness(roomy());

    const result = await callTool(client, 'indicator_add', {
      name: 'Volume',
      inputs: { 'MA Length': 0 },
    });

    expect(errorOf(result)).toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringMatching(/MA Length/) as string,
    });
    expect(changesOf(win)).toEqual([]);
  });

  test('indicator_add removes a Pine study again when its inputs turn out invalid', async () => {
    const { client, win } = await startHarness(roomy());

    const result = await callTool(client, 'indicator_add', {
      name: 'MACD',
      inputs: { 'Fast Length': 'fast' },
    });
    const list = await callTool(client, 'indicator_list');

    expect(errorOf(result)).toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringMatching(/Fast Length/) as string,
    });
    expect(changesOf(win)).toEqual([
      ['chart.createStudy', { type: 'pine', pineId: 'STD;MACD', pineVersion: '28.0' }],
      ['chart.removeEntity', 'NEW001'],
    ]);
    expect((dataOf(list).studies as { id: string }[]).map(({ id }) => id)).toEqual([
      'STUDY01',
      'STUDY02',
    ]);
  });

  test('indicator_add takes the study off again when its inputs cannot be set', async () => {
    const win = createFakeTvWindow(roomy());
    const chart = chartOf(win);
    const getStudyById = chart.getStudyById.bind(chart);
    chart.getStudyById = (id) => ({
      ...getStudyById(id),
      setInputValues: () => {
        throw new Error('The study is read-only');
      },
    });
    const { client } = await startHarness(fixture, {}, win);

    const result = await callTool(client, 'indicator_add', {
      name: 'Volume',
      inputs: { 'MA Length': 30 },
    });

    expect(errorOf(result)?.code).toBe('PAGE_EVALUATION_FAILED');
    expect(inspectFakeWindow(win).callsTo('chart.removeEntity')).toEqual([['NEW001']]);
    expect(chart.getAllStudies()).toHaveLength(2);
  });

  test('indicator_add reports the input error even when the study cannot be taken off again', async () => {
    const win = createFakeTvWindow(roomy());
    const chart = chartOf(win);
    const removeEntity = chart.removeEntity;
    chart.removeEntity = () => {
      throw new Error('Busy');
    };
    const { client } = await startHarness(fixture, {}, win);

    const result = await callTool(client, 'indicator_add', {
      name: 'MACD',
      inputs: { 'Fast Length': 99 },
    });
    chart.removeEntity = removeEntity;
    // Still a study this session added, so it goes without confirm.
    const removed = await callTool(client, 'indicator_remove', { id: 'NEW001' });

    expect(errorOf(result)).toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringMatching(/from 1 to 50/) as string,
    });
    expect(dataOf(removed)).toEqual({ removed: 'NEW001' });
  });

  test('indicator_add fails NOT_AVAILABLE when TradingView adds nothing', async () => {
    const win = createFakeTvWindow(roomy());
    const chart = chartOf(win);
    const answers: (() => Promise<string | null>)[] = [
      () => Promise.resolve(null),
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      () => Promise.reject('cannot_compile_pub'),
    ];
    chart.createStudy = () => answers.shift()?.() ?? Promise.resolve(null);
    const { client } = await startHarness(fixture, {}, win);

    const empty = await callTool(client, 'indicator_add', { name: 'Volume' });
    const rejected = await callTool(client, 'indicator_add', { name: 'RSI' });

    expect(errorOf(empty)).toMatchObject({ code: 'NOT_AVAILABLE' });
    expect(errorOf(rejected)).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: expect.stringMatching(/cannot_compile_pub/) as string,
      details: { reason: 'cannot_compile_pub' },
    });
  });

  test('indicator_add checks chartIndex against the layout', async () => {
    const { client, win } = await startHarness(roomy());

    const result = await callTool(client, 'indicator_add', { name: 'RSI', chartIndex: 1 });

    expect(errorOf(result)?.code).toBe('INVALID_INPUT');
    expect(changesOf(win)).toEqual([]);
  });
});

describe('indicator_remove', () => {
  test('indicator_remove requires confirm for an indicator the session did not create', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'indicator_remove', { id: 'STUDY01' });

    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      hint: expect.stringMatching(/confirm: true/) as string,
    });
    expect(inspectFakeWindow(win).callsTo('chart.removeEntity')).toEqual([]);
    expect(chartOf(win).getAllStudies()).toHaveLength(2);
  });

  test('indicator_remove removes a study this session added without confirm', async () => {
    const { client, win } = await startHarness(roomy());
    await callTool(client, 'indicator_add', { name: 'RSI' });

    const removed = await callTool(client, 'indicator_remove', { id: 'NEW001' });
    const again = await callTool(client, 'indicator_remove', { id: 'NEW001' });

    expect(envelopeOf(removed)).toStrictEqual({
      ok: true,
      data: { removed: 'NEW001' },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(inspectFakeWindow(win).state.removedStudies).toEqual([{ id: 'NEW001', undoable: true }]);
    expect(errorOf(again)?.code).toBe('INVALID_INPUT');
  });

  test('indicator_remove removes an earlier study with confirm, undoably', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'indicator_remove', { id: 'STUDY01', confirm: true });

    expect(dataOf(result)).toEqual({ removed: 'STUDY01' });
    expect(inspectFakeWindow(win).callsTo('chart.removeEntity')).toEqual([['STUDY01']]);
    expect(inspectFakeWindow(win).state.removedStudies).toEqual([
      { id: 'STUDY01', undoable: true },
    ]);
    expect(
      chartOf(win)
        .getAllStudies()
        .map(({ id }) => id),
    ).toEqual(['STUDY02']);
  });

  test('indicator_remove fails INVALID_INPUT for an unknown id before it asks for confirm', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'indicator_remove', { id: 'NOPE01' });

    expect(errorOf(result)).toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringMatching(/NOPE01/) as string,
      hint: expect.stringMatching(/indicator_list/) as string,
    });
    expect(inspectFakeWindow(win).callsTo('chart.removeEntity')).toEqual([]);
  });

  test('indicator_remove fails when the study is still on the chart afterwards', async () => {
    const win = createFakeTvWindow(fixture);
    chartOf(win).removeEntity = () => undefined;
    const { client } = await startHarness(fixture, {}, win);

    const result = await callTool(client, 'indicator_remove', { id: 'STUDY01', confirm: true });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: expect.stringMatching(/STUDY01/) as string,
    });
  });
});

describe('indicator_set_inputs', () => {
  test('indicator_set_inputs accepts input ids or names and returns previous values', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'indicator_set_inputs', {
      id: 'STUDY01',
      inputs: { in_0: 21, source: 'hl2' },
    });

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: {
        id: 'STUDY01',
        previous: [
          { id: 'in_0', name: 'Length', type: 'integer', value: 9, options: null },
          { id: 'in_1', name: 'Source', type: 'source', value: 'close', options: null },
          { id: 'in_2', name: 'Offset', type: 'integer', value: 0, options: null },
        ],
        current: [
          { id: 'in_0', name: 'Length', type: 'integer', value: 21, options: null },
          { id: 'in_1', name: 'Source', type: 'source', value: 'hl2', options: null },
          { id: 'in_2', name: 'Offset', type: 'integer', value: 0, options: null },
        ],
      },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(changesOf(win)).toEqual([
      [
        'study.setInputValues',
        'STUDY01',
        [
          { id: 'in_0', value: 21 },
          { id: 'in_1', value: 'hl2' },
        ],
      ],
    ]);
  });

  test('indicator_set_inputs rejects unknown inputs and wrong types with INVALID_INPUT', async () => {
    const { client, win } = await startHarness();

    const mixed = await callTool(client, 'indicator_set_inputs', {
      id: 'STUDY01',
      inputs: { Length: 'long', nope: 1, in_2: 3 },
    });
    const bounds = await callTool(client, 'indicator_set_inputs', {
      id: 'STUDY01',
      inputs: { Length: 0 },
    });
    const fraction = await callTool(client, 'indicator_set_inputs', {
      id: 'STUDY01',
      inputs: { Length: 1.5 },
    });
    const option = await callTool(client, 'indicator_set_inputs', {
      id: 'STUDY02',
      inputs: { Type: 'WMA' },
    });
    // A hidden input of a Pine script is not an input the user can set.
    const hidden = await callTool(client, 'indicator_set_inputs', {
      id: 'STUDY02',
      inputs: { pineId: 'STD;Other' },
    });

    expect(errorOf(mixed)).toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringMatching(/Length.*nope|nope.*Length/s) as string,
      details: {
        validInputs: [
          { id: 'in_0', name: 'Length', type: 'integer' },
          { id: 'in_1', name: 'Source', type: 'source' },
          { id: 'in_2', name: 'Offset', type: 'integer' },
        ],
      },
    });
    for (const result of [bounds, fraction, option, hidden]) {
      expect(errorOf(result)?.code).toBe('INVALID_INPUT');
    }
    expect(errorOf(option)?.message).toMatch(/None, SMA, EMA/);
    // Nothing was set, not even the valid in_2 of the first call.
    expect(changesOf(win)).toEqual([]);
  });

  test('indicator_set_inputs refuses an empty set of inputs and an unknown id', async () => {
    const { client, win } = await startHarness();

    const empty = await callTool(client, 'indicator_set_inputs', { id: 'STUDY01', inputs: {} });
    const unknown = await callTool(client, 'indicator_set_inputs', {
      id: 'NOPE01',
      inputs: { Length: 3 },
    });

    expect(errorOf(empty)?.code).toBe('INVALID_INPUT');
    expect(errorOf(unknown)).toMatchObject({
      code: 'INVALID_INPUT',
      hint: expect.stringMatching(/indicator_list/) as string,
    });
    expect(changesOf(win)).toEqual([]);
  });
});

describe('indicator_set_visibility', () => {
  test('indicator_set_visibility hides and shows a study', async () => {
    const { client, win } = await startHarness();

    const hidden = await callTool(client, 'indicator_set_visibility', {
      id: 'STUDY01',
      visible: false,
    });
    const shown = await callTool(client, 'indicator_set_visibility', {
      id: 'STUDY01',
      visible: true,
      chartIndex: 0,
    });

    expect(envelopeOf(hidden)).toStrictEqual({
      ok: true,
      data: { id: 'STUDY01', visible: false, previous: true },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(dataOf(shown)).toEqual({ id: 'STUDY01', visible: true, previous: false });
    expect(changesOf(win)).toEqual([
      ['study.setVisible', 'STUDY01', false],
      ['study.setVisible', 'STUDY01', true],
    ]);
  });

  test('indicator_set_visibility fails INVALID_INPUT for an unknown id', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'indicator_set_visibility', {
      id: 'NOPE01',
      visible: false,
    });

    expect(errorOf(result)).toMatchObject({
      code: 'INVALID_INPUT',
      hint: expect.stringMatching(/indicator_list/) as string,
    });
    expect(changesOf(win)).toEqual([]);
  });
});
