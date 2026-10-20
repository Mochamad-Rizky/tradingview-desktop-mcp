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

// The indicator read tools through the whole server: an SDK client over the in-memory transport,
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
