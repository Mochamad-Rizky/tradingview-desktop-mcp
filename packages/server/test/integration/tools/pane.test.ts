import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../../../src/config/schema.js';
import { inPlanLimitedTurn } from '../../../src/core/tv/plan-limits.js';
import { createMcpServer } from '../../../src/server.js';
import { startFakeCdpServer } from '../../helpers/fake-cdp/server.js';
import { loadTargetsFixture } from '../../helpers/fake-cdp/targets.js';
import { loadTvFixture, type TvStateFixture } from '../../helpers/fake-tv/fixture.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTradingViewApi,
  type FakeTvOverrides,
  type FakeTvWindow,
} from '../../helpers/fake-tv/window.js';
import { callTool, connectInMemoryClient, textOf } from '../../helpers/mcp-client.js';
import { withChartLimit, withLockedTwoCharts, withTwoCharts } from '../../helpers/pane-fixtures.js';
import { quietLogger, refusingLauncher, testConfig } from '../../helpers/tool-context.js';

// The pane tools through the whole server: an SDK client over the in-memory transport, the real
// registry, connection manager and CDP adapter, and the fake debug port of the app with a fake chart
// tab whose layout holds one chart or more behind it. Values are synthetic.

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

// Two charts side by side, both shown, on the plan of the fixture, which allows one chart: the
// tests that change the layout give it a plan of their own (withChartLimit). The way TradingView
// loads a layout of two charts on a plan of one is lockedTwoCharts.
const twoCharts = withTwoCharts(fixture);
// A layout of two charts saved on a larger plan, as TradingView loads it on a plan of one chart,
// which is the plan of the real account (MULTIPLE_CHARTS on, with a limit of 1): it keeps the type
// 2h and shows one chart.
const lockedTwoCharts = withChartLimit(1, withLockedTwoCharts(fixture));

// A plan that configures MULTIPLE_CHARTS with `config` and no limit of the plan limits.
function withChartConfig(config: Record<string, number>): TvStateFixture {
  return { ...fixture, planConfigs: { ...fixture.planConfigs, MULTIPLE_CHARTS: config } };
}

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

// A server behind a fake app showing `win`.
async function startHarnessWith(
  win: FakeTvWindow,
  config: Partial<Config> = {},
): Promise<{ client: Client; win: FakeTvWindow }> {
  const app = await startFakeCdpServer({ targets: loadTargetsFixture({ chartWindow: () => win }) });
  cleanups.push(() => app.close());
  const { server, ctx } = createMcpServer(
    testConfig({ cdpPort: app.port, callTimeoutMs: 5000, ...config }),
    { launcher: refusingLauncher(), logger: quietLogger },
  );
  cleanups.push(() => ctx.connection.close());
  return { client: await connect(server), win };
}

function startHarness(
  from: TvStateFixture = fixture,
  overrides: FakeTvOverrides = {},
  config: Partial<Config> = {},
): Promise<{ client: Client; win: FakeTvWindow }> {
  return startHarnessWith(createFakeTvWindow(from, overrides), config);
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

const calls = (win: FakeTvWindow, name: string) => inspectFakeWindow(win).callsTo(name);
const callNames = (win: FakeTvWindow) => inspectFakeWindow(win).calls.map(({ name }) => name);
const dialogs = (win: FakeTvWindow) => callNames(win).filter((name) => name.startsWith('dialog.'));

function apiOf(win: FakeTvWindow): FakeTradingViewApi {
  if (win.TradingViewApi === undefined) {
    throw new Error('The fake window has no TradingViewApi');
  }
  return win.TradingViewApi;
}

// The layout as the fake app shows it: its type, how many charts it shows and the active one.
function layoutOf(win: FakeTvWindow) {
  const api = apiOf(win);
  return { layout: api.layout(), chartsCount: api.chartsCount(), active: api.activeChartIndex() };
}

// The module of a fake window whose exports include `name`, which a test changes in place.
let probes = 0;
function moduleWith(win: FakeTvWindow, name: string): Record<string, unknown> {
  let handed: { c: Record<string, { exports: Record<string, unknown> }> } | undefined;
  probes += 1;
  (win.webpackChunktradingview as { push(chunk: unknown): unknown }).push([
    [`pane${String(probes)}`],
    {},
    (given: typeof handed) => (handed = given),
  ]);
  const found = Object.values(handed?.c ?? {}).find((record) =>
    Object.hasOwn(record.exports, name),
  );
  if (found === undefined) {
    throw new Error(`No module exports ${name}`);
  }
  return found.exports;
}

// Holds the turn of the plan-limited actions until the returned function is called, or the test
// ends: a test that fails before it lets go must not hold up the plan-limited actions of the next.
function holdPlanLimitedTurn(): () => void {
  let release = (): void => undefined;
  void inPlanLimitedTurn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const letGo = (): void => {
    release();
  };
  cleanups.push(() => {
    letGo();
    return Promise.resolve();
  });
  return letGo;
}

describe('pane_list', () => {
  test("pane_list reports each chart's panes and studies", async () => {
    const win = createFakeTvWindow(twoCharts);
    const { client } = await startHarnessWith(win);

    const result = await callTool(client, 'pane_list');

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: {
        layout: '2h',
        charts: [
          {
            index: 0,
            symbol: 'NASDAQ:AAPL',
            resolution: '1D',
            active: true,
            panes: [
              { index: 0, height: 420, studyIds: ['STUDY01'], hasMainSeries: true },
              { index: 1, height: 180, studyIds: ['STUDY02'], hasMainSeries: false },
            ],
          },
          {
            index: 1,
            symbol: 'NASDAQ:MSFT',
            resolution: '60',
            active: false,
            panes: [
              { index: 0, height: 400, studyIds: ['C1STUDY1'], hasMainSeries: true },
              { index: 1, height: 200, studyIds: ['C1STUDY2'], hasMainSeries: false },
            ],
          },
        ],
      },
      meta: { via: 'api', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(JSON.parse(textOf(result))).toStrictEqual(result.structuredContent);
    // It reads, and calls nothing.
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('pane_list reports the active chart, and leaves the main series and the drawings out of studyIds', async () => {
    const win = createFakeTvWindow(twoCharts);
    inspectFakeWindow(win).state.activeChartIndex = 1;
    const { client } = await startHarnessWith(win);

    const { charts } = dataOf(await callTool(client, 'pane_list')) as {
      charts: { active: boolean; panes: { studyIds: string[] }[] }[];
    };

    expect(charts.map(({ active }) => active)).toEqual([false, true]);
    const ids = charts.flatMap(({ panes }) => panes.flatMap(({ studyIds }) => studyIds));
    expect(ids).toEqual(['STUDY01', 'STUDY02', 'C1STUDY1', 'C1STUDY2']);
  });

  test('pane_list reports a layout of one chart in one pane', async () => {
    const { client } = await startHarness();

    expect(dataOf(await callTool(client, 'pane_list'))).toEqual({
      layout: 's',
      charts: [
        {
          index: 0,
          symbol: 'NASDAQ:AAPL',
          resolution: '1D',
          active: true,
          panes: [{ index: 0, height: 600, studyIds: ['STUDY01', 'STUDY02'], hasMainSeries: true }],
        },
      ],
    });
  });

  test('pane_list reports null, with a warning, for what a chart does not report', async () => {
    const win = createFakeTvWindow(twoCharts);
    const second = apiOf(win).chart(1);
    Reflect.deleteProperty(second, 'getPanes');
    apiOf(win).chart(0).getAllStudies = () => {
      throw new Error('The studies are not ready');
    };
    const { client } = await startHarnessWith(win);

    const result = await callTool(client, 'pane_list');

    const { charts } = dataOf(result) as {
      charts: { panes: { studyIds: string[] | null }[] | null }[];
    };
    expect(charts[0]?.panes?.map(({ studyIds }) => studyIds)).toEqual([null, null]);
    expect(charts[1]?.panes).toBeNull();
    expect(warningsOf(result)).toEqual([
      expect.stringMatching(/^Chart 0 did not report which studies are in its panes/),
      expect.stringMatching(/^Chart 1 did not report its panes/),
    ]);
  });

  test('pane_list fails NOT_AVAILABLE when the layout does not report how many charts it has', async () => {
    const win = createFakeTvWindow(twoCharts);
    apiOf(win).chartsCount = () => Number.NaN;
    const { client } = await startHarnessWith(win);

    expect(errorOf(await callTool(client, 'pane_list'))).toMatchObject({ code: 'NOT_AVAILABLE' });
  });
});

describe('pane_set_layout', () => {
  test('pane_set_layout to a multi-chart layout returns PLAN_LIMIT MULTIPLE_CHARTS on a one-chart plan and changes nothing', async () => {
    // The plan of the real account: MULTIPLE_CHARTS on, with a limit of 1.
    const { client, win } = await startHarness(withChartLimit(1, fixture));

    const result = await callTool(client, 'pane_set_layout', { layout: '2h' });

    expect(errorOf(result)).toMatchObject({
      code: 'PLAN_LIMIT',
      message: expect.stringMatching(
        /^The layout 2h has 2 charts, and the plan allows 1 chart in a layout/,
      ) as string,
      details: { feature: 'MULTIPLE_CHARTS', limit: 1 },
    });
    expect(errorOf(result)?.hint).toMatch(/single chart \(layout s\)/);
    expect(calls(win, 'TradingViewApi.setLayout')).toEqual([]);
    expect(dialogs(win)).toEqual([]);
    expect(layoutOf(win)).toEqual({ layout: 's', chartsCount: 1, active: 0 });
  });

  test('pane_set_layout to s on a one-chart layout changes nothing', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'pane_set_layout', { layout: 's' });

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: { layout: 's', chartsCount: 1, changed: false },
      meta: { via: 'api', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('pane_set_layout changes the layout within the plan, and waits until it shows its charts with their data', async () => {
    const { client, win } = await startHarness(withChartLimit(2, fixture), {
      charts: { dataMs: 50 },
    });

    const result = await callTool(client, 'pane_set_layout', { layout: '2h' });

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: { layout: '2h', chartsCount: 2, changed: true },
      meta: { via: 'api', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(calls(win, 'TradingViewApi.setLayout')).toEqual([['2h', { withUndo: true }]]);
    expect(layoutOf(win)).toEqual({ layout: '2h', chartsCount: 2, active: 0 });
    expect(inspectFakeWindow(win).state.charts.others.map(({ dataReady }) => dataReady)).toEqual([
      true,
    ]);
    expect(dialogs(win)).toEqual([]);
  });

  test.each([
    ['the plan has MULTIPLE_CHARTS off', fixture],
    ['the plan configures MULTIPLE_CHARTS without a limit', withChartConfig({})],
    ['the plan limits MULTIPLE_CHARTS to 0', withChartLimit(0, fixture)],
  ])(
    'pane_set_layout counts one chart as the limit, as TradingView does, when %s',
    async (_case, from) => {
      const { client, win } = await startHarness(from);

      const result = await callTool(client, 'pane_set_layout', { layout: '2v' });

      expect(errorOf(result)).toMatchObject({
        code: 'PLAN_LIMIT',
        details: { feature: 'MULTIPLE_CHARTS', limit: 1 },
      });
      expect(calls(win, 'TradingViewApi.setLayout')).toEqual([]);
      expect(dialogs(win)).toEqual([]);
    },
  );

  test('pane_set_layout refuses a 3-chart layout on a plan of 2 charts, and takes a 2-chart one', async () => {
    const { client, win } = await startHarness(withChartLimit(2, fixture));

    const refused = await callTool(client, 'pane_set_layout', { layout: '3h' });
    const taken = await callTool(client, 'pane_set_layout', { layout: '2v' });

    expect(errorOf(refused)).toMatchObject({
      code: 'PLAN_LIMIT',
      message: expect.stringMatching(
        /^The layout 3h has 3 charts, and the plan allows 2 charts in a layout/,
      ) as string,
      details: { feature: 'MULTIPLE_CHARTS', limit: 2 },
    });
    expect(dataOf(taken)).toEqual({ layout: '2v', chartsCount: 2, changed: true });
    expect(calls(win, 'TradingViewApi.setLayout')).toEqual([['2v', { withUndo: true }]]);
    expect(dialogs(win)).toEqual([]);
  });

  test('pane_set_layout takes the count of a layout from the table of TradingView, which can differ from the counts of the server', async () => {
    const win = createFakeTvWindow(withChartLimit(2, fixture));
    // A build whose 3h holds two charts.
    const table = moduleWith(win, 'layouts').layouts as Record<string, { count: number }>;
    table['3h'] = { ...table['3h'], count: 2 };
    const { client } = await startHarnessWith(win);

    const result = await callTool(client, 'pane_set_layout', { layout: '3h' });

    expect(errorOf(result)).toBeUndefined();
    expect(calls(win, 'TradingViewApi.setLayout')).toEqual([['3h', { withUndo: true }]]);
    expect(dialogs(win)).toEqual([]);
  });

  test('pane_set_layout refuses NOT_AVAILABLE a layout this TradingView build does not know, which it cannot change to', async () => {
    const { client, win } = await startHarness(withChartLimit(4, fixture), {
      charts: { withoutCodes: ['2-2-l'] },
    });

    const result = await callTool(client, 'pane_set_layout', { layout: '2-2-l' });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: expect.stringMatching(/does not know the layout 2-2-l/) as string,
      details: { layout: '2-2-l' },
    });
    expect(calls(win, 'TradingViewApi.setLayout')).toEqual([]);
  });

  test('pane_set_layout refuses NOT_AVAILABLE a layout whose count TradingView does not say', async () => {
    const win = createFakeTvWindow(withChartLimit(4, fixture));
    const table = moduleWith(win, 'layouts').layouts as Record<string, unknown>;
    table['2v'] = { title: '2 charts', layoutType: '2v' };
    const { client } = await startHarnessWith(win);

    const result = await callTool(client, 'pane_set_layout', { layout: '2v' });

    expect(errorOf(result)).toMatchObject({ code: 'NOT_AVAILABLE', details: { layout: '2v' } });
    expect(calls(win, 'TradingViewApi.setLayout')).toEqual([]);
  });

  test('pane_set_layout counts the charts of a layout itself when TradingView has no table of layouts to find', async () => {
    const { client, win } = await startHarness(withChartLimit(2, fixture), {
      charts: { withoutLayoutTable: true },
    });

    const refused = await callTool(client, 'pane_set_layout', { layout: '3v' });
    const taken = await callTool(client, 'pane_set_layout', { layout: '2h' });

    expect(errorOf(refused)).toMatchObject({ code: 'PLAN_LIMIT', details: { limit: 2 } });
    expect(dataOf(taken)).toEqual({ layout: '2h', chartsCount: 2, changed: true });
    expect(calls(win, 'TradingViewApi.setLayout')).toEqual([['2h', { withUndo: true }]]);
    expect(dialogs(win)).toEqual([]);
  });

  test('pane_set_layout refuses NOT_AVAILABLE when the plan module cannot be read, and changes nothing', async () => {
    const win = createFakeTvWindow(withChartLimit(4, fixture));
    Reflect.deleteProperty(moduleWith(win, 'getConfig'), 'enabled');
    const { client } = await startHarnessWith(win);

    const result = await callTool(client, 'pane_set_layout', { layout: '2h' });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      details: { feature: 'MULTIPLE_CHARTS' },
    });
    expect(calls(win, 'TradingViewApi.setLayout')).toEqual([]);
    expect(layoutOf(win)).toEqual({ layout: 's', chartsCount: 1, active: 0 });
  });

  test('pane_set_layout refuses NOT_AVAILABLE when no module of the app can be read', async () => {
    const { client, win } = await startHarness(withChartLimit(4, fixture), { webpackModules: {} });

    const result = await callTool(client, 'pane_set_layout', { layout: '2h' });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      details: { feature: 'MULTIPLE_CHARTS' },
    });
    expect(calls(win, 'TradingViewApi.setLayout')).toEqual([]);
  });

  test('pane_set_layout to a layout of fewer charts fails CONFIRMATION_REQUIRED without confirm, and changes nothing', async () => {
    const { client, win } = await startHarness(withChartLimit(2, twoCharts));

    const result = await callTool(client, 'pane_set_layout', { layout: 's' });

    expect(errorOf(result)).toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      message: expect.stringMatching(
        /^The layout s shows 1 chart, fewer than the 2 the layout shows now: TradingView saves only the charts a layout shows, so its next save.*drops chart 1 with its symbol, indicators and drawings$/,
      ) as string,
      details: { layout: 's', chartsCount: 1, currentChartsCount: 2 },
    });
    expect(errorOf(result)?.hint).toMatch(/confirm: true/);
    expect(calls(win, 'TradingViewApi.setLayout')).toEqual([]);
    expect(layoutOf(win)).toEqual({ layout: '2h', chartsCount: 2, active: 0 });
  });

  test('pane_set_layout to a layout of fewer charts changes it with confirm', async () => {
    const { client, win } = await startHarness(withChartLimit(2, twoCharts));

    const result = await callTool(client, 'pane_set_layout', { layout: 's', confirm: true });

    expect(dataOf(result)).toEqual({ layout: 's', chartsCount: 1, changed: true });
    expect(calls(win, 'TradingViewApi.setLayout')).toEqual([['s', { withUndo: true }]]);
    expect(layoutOf(win)).toEqual({ layout: 's', chartsCount: 1, active: 0 });
    expect(dialogs(win)).toEqual([]);
  });

  test('pane_set_layout to s needs no plan check, so a plan module that cannot be read does not stop two charts from becoming one', async () => {
    const win = createFakeTvWindow(twoCharts);
    Reflect.deleteProperty(moduleWith(win, 'getConfig'), 'enabled');
    const { client } = await startHarnessWith(win);

    const result = await callTool(client, 'pane_set_layout', { layout: 's', confirm: true });

    expect(dataOf(result)).toEqual({ layout: 's', chartsCount: 1, changed: true });
    expect(dialogs(win)).toEqual([]);
  });

  test('pane_set_layout looks at the charts again right before the change, and refuses a layout that became a reduction', async () => {
    const win = createFakeTvWindow(withChartLimit(4, twoCharts));
    // The user adds two charts while the server reads the plan: every look after the first one
    // finds four.
    let looks = 0;
    apiOf(win).chartsCount = () => {
      looks += 1;
      return looks === 1 ? 2 : 4;
    };
    const { client } = await startHarnessWith(win);

    const result = await callTool(client, 'pane_set_layout', { layout: '3h' });

    expect(errorOf(result)).toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      details: { layout: '3h', chartsCount: 3, currentChartsCount: 4 },
    });
    expect(calls(win, 'TradingViewApi.setLayout')).toEqual([]);
  });

  test('pane_set_layout warns about each chart whose data does not load in time', async () => {
    const { client, win } = await startHarness(
      withChartLimit(4, fixture),
      { charts: { dataMs: Infinity } },
      { callTimeoutMs: 2000 },
    );

    const result = await callTool(client, 'pane_set_layout', { layout: '3h' });

    expect(dataOf(result)).toEqual({ layout: '3h', chartsCount: 3, changed: true });
    expect(warningsOf(result)).toEqual([
      expect.stringMatching(/^The data of charts 1 and 2 did not load within \d+ ms/),
    ]);
    expect(layoutOf(win)).toEqual({ layout: '3h', chartsCount: 3, active: 0 });
    expect(dialogs(win)).toEqual([]);
  });

  test('pane_set_layout fails TIMEOUT when TradingView does not show the layout in time', async () => {
    const { client, win } = await startHarness(
      withChartLimit(2, fixture),
      { charts: { layoutMs: 10_000 } },
      { callTimeoutMs: 2000 },
    );

    const result = await callTool(client, 'pane_set_layout', { layout: '2h' });

    expect(errorOf(result)).toMatchObject({
      code: 'TIMEOUT',
      details: { layout: '2h', chartsCount: 2, shownLayout: 's', shownChartsCount: 1 },
    });
    expect(errorOf(result)?.hint).toMatch(/pane_list/);
    // The checks of the app come before its change, so a paywall would show already.
    expect(dialogs(win)).toEqual([]);
  });

  test('pane_set_layout is CAPABILITY_UNAVAILABLE on a build without setLayout', async () => {
    const win = createFakeTvWindow(withChartLimit(2, fixture));
    Reflect.deleteProperty(apiOf(win), 'setLayout');
    const { client } = await startHarnessWith(win);

    const result = await callTool(client, 'pane_set_layout', { layout: '2h' });

    expect(errorOf(result)).toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
    expect(layoutOf(win)).toEqual({ layout: 's', chartsCount: 1, active: 0 });
  });

  test.each([
    [
      'no type',
      (api: FakeTradingViewApi) => {
        api.layout = () => '';
      },
    ],
    [
      'no count of charts',
      (api: FakeTradingViewApi) => {
        api.chartsCount = () => 0;
      },
    ],
  ])(
    'pane_set_layout refuses NOT_AVAILABLE when the layout reports %s, and changes nothing',
    async (_case, change) => {
      const win = createFakeTvWindow(withChartLimit(2, fixture));
      change(apiOf(win));
      const { client } = await startHarnessWith(win);

      const result = await callTool(client, 'pane_set_layout', { layout: '2h' });

      expect(errorOf(result)).toMatchObject({ code: 'NOT_AVAILABLE' });
      expect(calls(win, 'TradingViewApi.setLayout')).toEqual([]);
    },
  );

  test.each([
    // The count TradingView reports then, as for a layout it keeps locked to the plan's count.
    ['a count of charts', 1, 1],
    // The count of the layout asked for.
    ['no count of charts', Number.NaN, 2],
  ])(
    'pane_set_layout answers changed: false for a layout the tab showed by the time of the change, with %s',
    async (_case, laterCount, reported) => {
      const win = createFakeTvWindow(withChartLimit(2, fixture));
      const api = apiOf(win);
      // The user picks 2h in TradingView while the server reads the plan.
      let looks = 0;
      api.layout = () => {
        looks += 1;
        return looks === 1 ? 's' : '2h';
      };
      let counts = 0;
      api.chartsCount = () => {
        counts += 1;
        return counts === 1 ? 1 : laterCount;
      };
      const { client } = await startHarnessWith(win);

      const result = await callTool(client, 'pane_set_layout', { layout: '2h' });

      expect(dataOf(result)).toEqual({ layout: '2h', chartsCount: reported, changed: false });
      expect(calls(win, 'TradingViewApi.setLayout')).toEqual([]);
    },
  );

  test('pane_set_layout waits for the turn of the plan-limited actions', async () => {
    const { client, win } = await startHarness(withChartLimit(2, fixture));
    const letGo = holdPlanLimitedTurn();

    const call = callTool(client, 'pane_set_layout', { layout: '2h' });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(calls(win, 'TradingViewApi.setLayout')).toEqual([]);
    letGo();
    expect(dataOf(await call)).toEqual({ layout: '2h', chartsCount: 2, changed: true });
    expect(dialogs(win)).toEqual([]);
  });

  test('pane_set_layout refuses a layout code it does not know before it looks at the app', async () => {
    const { client, win } = await startHarness(withChartLimit(4, fixture));

    const result = await callTool(client, 'pane_set_layout', { layout: '5x' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/layout/);
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });
});

describe('a layout of two charts saved on a larger plan, which TradingView shows with one chart', () => {
  test('pane_list reports its type, 2h, with the one chart it shows', async () => {
    const { client } = await startHarness(lockedTwoCharts);

    const { layout, charts } = dataOf(await callTool(client, 'pane_list')) as {
      layout: string;
      charts: { index: number; symbol: string }[];
    };

    expect(layout).toBe('2h');
    expect(charts.map(({ index, symbol }) => [index, symbol])).toEqual([[0, 'NASDAQ:AAPL']]);
  });

  test('pane_set_layout to s changes it without confirm: the layout shows no fewer charts, and the hidden chart stays to be saved', async () => {
    const { client, win } = await startHarness(lockedTwoCharts);

    const result = await callTool(client, 'pane_set_layout', { layout: 's' });

    expect(dataOf(result)).toEqual({ layout: 's', chartsCount: 1, changed: true });
    expect(calls(win, 'TradingViewApi.setLayout')).toEqual([['s', { withUndo: true }]]);
    expect(inspectFakeWindow(win).state.charts.others.map(({ symbol }) => symbol)).toEqual([
      'NASDAQ:MSFT',
    ]);
    expect(dialogs(win)).toEqual([]);
  });

  test('pane_set_layout to another layout of two charts is PLAN_LIMIT, and changes nothing', async () => {
    const { client, win } = await startHarness(lockedTwoCharts);

    const result = await callTool(client, 'pane_set_layout', { layout: '2v' });

    expect(errorOf(result)).toMatchObject({
      code: 'PLAN_LIMIT',
      details: { feature: 'MULTIPLE_CHARTS', limit: 1 },
    });
    expect(calls(win, 'TradingViewApi.setLayout')).toEqual([]);
    expect(dialogs(win)).toEqual([]);
    expect(layoutOf(win)).toEqual({ layout: '2h', chartsCount: 1, active: 0 });
  });

  test('pane_focus of the hidden chart is INVALID_INPUT naming the one chart shown', async () => {
    const { client, win } = await startHarness(lockedTwoCharts);

    const result = await callTool(client, 'pane_focus', { chartIndex: 1 });

    expect(errorOf(result)).toMatchObject({
      code: 'INVALID_INPUT',
      message: 'chartIndex 1 is out of range: the layout has 1 chart, so chartIndex must be 0',
      details: { chartIndex: 1, chartsCount: 1 },
    });
    expect(calls(win, 'TradingViewApi.setActiveChart')).toEqual([]);
  });
});

describe('pane_focus', () => {
  test('pane_focus activates the chart', async () => {
    const { client, win } = await startHarness(twoCharts);

    const result = await callTool(client, 'pane_focus', { chartIndex: 1 });

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: { chartIndex: 1, changed: true },
      meta: { via: 'api', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(calls(win, 'TradingViewApi.setActiveChart')).toEqual([[1]]);
    expect(apiOf(win).activeChartIndex()).toBe(1);
  });

  test('pane_focus an index outside the layout is INVALID_INPUT naming the range', async () => {
    const { client, win } = await startHarness(twoCharts);

    const result = await callTool(client, 'pane_focus', { chartIndex: 2 });

    expect(errorOf(result)).toMatchObject({
      code: 'INVALID_INPUT',
      message:
        'chartIndex 2 is out of range: the layout has 2 charts, so chartIndex must be from 0 to 1',
      details: { chartIndex: 2, chartsCount: 2 },
    });
    expect(errorOf(result)?.hint).toMatch(/pane_list/);
    expect(errorOf(result)?.hint).not.toMatch(/Leave chartIndex out/);
    expect(calls(win, 'TradingViewApi.setActiveChart')).toEqual([]);
  });

  test('pane_focus leaves the active chart as it is and says so', async () => {
    const { client, win } = await startHarness(twoCharts);

    const result = await callTool(client, 'pane_focus', { chartIndex: 0 });

    expect(dataOf(result)).toEqual({ chartIndex: 0, changed: false });
    expect(calls(win, 'TradingViewApi.setActiveChart')).toEqual([]);
  });

  test('pane_focus fails NOT_AVAILABLE when TradingView does not make the chart the active one', async () => {
    const win = createFakeTvWindow(twoCharts);
    apiOf(win).setActiveChart = () => undefined;
    const { client } = await startHarnessWith(win);

    const result = await callTool(client, 'pane_focus', { chartIndex: 1 });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      details: { chartIndex: 1, activeChartIndex: 0 },
    });
  });

  test('pane_focus waits for TradingView to make the chart the active one', async () => {
    const win = createFakeTvWindow(twoCharts);
    const api = apiOf(win);
    const setActiveChart = api.setActiveChart.bind(api);
    // As while the active chart is maximized, the chart becomes the active one a moment later.
    api.setActiveChart = (index) => {
      setTimeout(() => {
        setActiveChart(index);
      }, 50);
    };
    const { client } = await startHarnessWith(win);

    const result = await callTool(client, 'pane_focus', { chartIndex: 1 });

    expect(dataOf(result)).toEqual({ chartIndex: 1, changed: true });
    expect(api.activeChartIndex()).toBe(1);
  });

  test('pane_focus answers changed: false for a chart that became the active one by the time of the change', async () => {
    const win = createFakeTvWindow(twoCharts);
    const api = apiOf(win);
    // The user clicks chart 1 while the server checks the index.
    let looks = 0;
    api.activeChartIndex = () => {
      looks += 1;
      return looks === 1 ? 0 : 1;
    };
    const { client } = await startHarnessWith(win);

    const result = await callTool(client, 'pane_focus', { chartIndex: 1 });

    expect(dataOf(result)).toEqual({ chartIndex: 1, changed: false });
    expect(calls(win, 'TradingViewApi.setActiveChart')).toEqual([]);
  });

  test('pane_focus and pane_set_symbol fail NOT_AVAILABLE, with a hint that fits, when the layout does not count its charts', async () => {
    const win = createFakeTvWindow(twoCharts);
    apiOf(win).chartsCount = () => Number.NaN;
    const { client } = await startHarnessWith(win);

    for (const [tool, args] of [
      ['pane_focus', { chartIndex: 1 }],
      ['pane_set_symbol', { chartIndex: 1, symbol: 'NASDAQ:NVDA' }],
    ] as const) {
      const error = errorOf(await callTool(client, tool, args));

      expect(error, tool).toMatchObject({
        code: 'NOT_AVAILABLE',
        message: 'The layout did not report how many charts it has',
        details: { chartIndex: 1 },
      });
      expect(error?.hint, tool).toMatch(/app_health/);
      expect(error?.hint, tool).not.toMatch(/Leave chartIndex out/);
    }
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('pane_focus passes on the CAPABILITY_UNAVAILABLE of a page without the charts of the layout', async () => {
    const win = createFakeTvWindow(twoCharts);
    Reflect.deleteProperty(apiOf(win), 'chartsCount');
    const { client } = await startHarnessWith(win);

    const result = await callTool(client, 'pane_focus', { chartIndex: 1 });

    expect(errorOf(result)).toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
  });
});

describe('pane_set_symbol', () => {
  test('pane_set_symbol changes only that chart and does not activate it', async () => {
    const { client, win } = await startHarness(twoCharts);

    const result = await callTool(client, 'pane_set_symbol', {
      chartIndex: 1,
      symbol: 'NASDAQ:NVDA',
    });

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: { chartIndex: 1, symbol: 'NASDAQ:NVDA', previous: 'NASDAQ:MSFT', changed: true },
      meta: { via: 'api', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(calls(win, 'chart(1).setSymbol')).toEqual([
      ['NASDAQ:NVDA', { doNotActivateChart: true, dataReady: expect.any(Function) as unknown }],
    ]);
    expect(calls(win, 'chart.setSymbol')).toEqual([]);
    expect([apiOf(win).chart(0).symbol(), apiOf(win).chart(1).symbol()]).toEqual([
      'NASDAQ:AAPL',
      'NASDAQ:NVDA',
    ]);
    expect(apiOf(win).activeChartIndex()).toBe(0);
  });

  test('pane_set_symbol warns about the other charts a layout that syncs symbols changed too', async () => {
    const synced: TvStateFixture = {
      ...twoCharts,
      charts: { ...twoCharts.charts, symbolSync: true },
    };
    const { client, win } = await startHarness(synced);

    const result = await callTool(client, 'pane_set_symbol', {
      chartIndex: 1,
      symbol: 'NASDAQ:NVDA',
    });

    expect(dataOf(result)).toEqual({
      chartIndex: 1,
      symbol: 'NASDAQ:NVDA',
      previous: 'NASDAQ:MSFT',
      changed: true,
    });
    expect(warningsOf(result)).toEqual([
      'The layout changed the symbol of chart 0 too, from NASDAQ:AAPL to NASDAQ:NVDA: it syncs ' +
        'the symbol of its charts. pane_list shows what each chart shows.',
    ]);
    expect(apiOf(win).activeChartIndex()).toBe(0);
  });

  test('pane_set_symbol switches the chart back from a symbol TradingView does not know, as chart_set_symbol does', async () => {
    const { client, win } = await startHarness(twoCharts);

    const result = await callTool(client, 'pane_set_symbol', {
      chartIndex: 1,
      symbol: 'NOSUCH:SYMBOL',
    });

    expect(errorOf(result)).toMatchObject({
      code: 'INVALID_INPUT',
      message: 'Unknown symbol NOSUCH:SYMBOL',
      details: { requested: 'NOSUCH:SYMBOL', kept: 'NASDAQ:MSFT' },
    });
    expect(calls(win, 'chart(1).setSymbol').map(([symbol]) => symbol)).toEqual([
      'NOSUCH:SYMBOL',
      'NASDAQ:MSFT',
    ]);
    expect([apiOf(win).chart(0).symbol(), apiOf(win).chart(1).symbol()]).toEqual([
      'NASDAQ:AAPL',
      'NASDAQ:MSFT',
    ]);
    expect(apiOf(win).activeChartIndex()).toBe(0);
  });

  test('pane_set_symbol refuses a blank symbol before it looks at the app', async () => {
    const { client, win } = await startHarness(twoCharts);

    const result = await callTool(client, 'pane_set_symbol', { chartIndex: 1, symbol: '   ' });

    expect(errorOf(result)).toMatchObject({
      code: 'INVALID_INPUT',
      message: 'The symbol is blank',
    });
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('pane_set_symbol refuses an index outside the layout, naming the range', async () => {
    const { client, win } = await startHarness(twoCharts);

    const result = await callTool(client, 'pane_set_symbol', {
      chartIndex: 5,
      symbol: 'NASDAQ:NVDA',
    });

    expect(errorOf(result)).toMatchObject({
      code: 'INVALID_INPUT',
      message:
        'chartIndex 5 is out of range: the layout has 2 charts, so chartIndex must be from 0 to 1',
    });
    expect(errorOf(result)?.hint).toMatch(/pane_list/);
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('pane_set_symbol requires a chartIndex', async () => {
    const { client, win } = await startHarness(twoCharts);

    const result = await callTool(client, 'pane_set_symbol', { symbol: 'NASDAQ:NVDA' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/chartIndex/);
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('pane_set_symbol on the active chart keeps it active, and changes it through the chart API', async () => {
    const { client, win } = await startHarness(twoCharts);
    apiOf(win).setActiveChart(1);

    const result = await callTool(client, 'pane_set_symbol', {
      chartIndex: 1,
      symbol: 'NYSE:IBM',
    });

    expect(dataOf(result)).toMatchObject({ chartIndex: 1, symbol: 'NYSE:IBM', changed: true });
    expect(envelopeOf(result).meta.via).toBe('api');
    expect(apiOf(win).activeChartIndex()).toBe(1);
  });
});
