import { setTimeout as delay } from 'node:timers/promises';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../../../src/config/schema.js';
import type { Logger } from '../../../src/core/logger.js';
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
import {
  capturingLogger,
  quietLogger,
  refusingLauncher,
  testConfig,
} from '../../helpers/tool-context.js';

// The layout tools through the whole server: an SDK client over the in-memory transport, the real
// registry, connection manager and CDP adapter, and the fake debug port of the app with a fake chart
// and a fake layouts server behind it. Values are synthetic.

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
// The names of the saved layouts of the fixture, and the name the tests give a new one.
const LAYOUT_NAMES = ['Fixture Layout', 'Second Layout', 'Locked Layout'];
const NEW_NAME = 'Example Layout';
// What the Create new layout dialog of the app would send for the chart of the fixture.
const DIALOG_OPTIONS = {
  symbol: 'NASDAQ:AAPL',
  short_name: 'AAPL',
  symbol_type: 'stock',
  exchange: 'NASDAQ',
  interval: '1D',
};

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
  logger: Logger = quietLogger,
): Promise<{ client: Client; win: FakeTvWindow }> {
  const app = await startFakeCdpServer({ targets: loadTargetsFixture({ chartWindow: () => win }) });
  cleanups.push(() => app.close());
  const { server, ctx } = createMcpServer(
    testConfig({ cdpPort: app.port, callTimeoutMs: 5000, ...config }),
    { launcher: refusingLauncher(), logger },
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

// A plan that lets the account save `limit` layouts; the fixture has three saved.
function withChartStorage(limit: number, from: TvStateFixture = fixture): TvStateFixture {
  return { ...from, planLimits: { ...from.planLimits, CHART_STORAGE: limit } };
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
const layoutsOf = (win: FakeTvWindow) => inspectFakeWindow(win).state.layouts;
const loads = (win: FakeTvWindow) => calls(win, 'TradingViewApi.loadLayoutFromServerByLayoutId');
const creations = (win: FakeTvWindow) => calls(win, 'createNewChart');

function apiOf(win: FakeTvWindow): FakeTradingViewApi {
  if (win.TradingViewApi === undefined) {
    throw new Error('The fake window has no TradingViewApi');
  }
  return win.TradingViewApi;
}

// The module of a fake window whose exports include `name`, which a test changes in place.
let probes = 0;
function moduleWith(win: FakeTvWindow, name: string): Record<string, unknown> {
  let handed: { c: Record<string, { exports: Record<string, unknown> }> } | undefined;
  probes += 1;
  (win.webpackChunktradingview as { push(chunk: unknown): unknown }).push([
    [`probe${String(probes)}`],
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

// The calls the tools never make: the loader that asks about unsaved changes in a dialog, the call
// that rewrites the URL of the page without loading the layout, the flow that navigates the tab, a
// load in a new tab and every dialog. Every load is in place, discarding without a dialog.
const UNTOUCHABLE =
  /^(dialog|backend)\.|^(TradingViewApi\.loadChartFromServer|TradingViewApi\.createNewLayout|openNewChart)$/;

function expectNothingElseTouched(win: FakeTvWindow): void {
  expect(callNames(win).filter((name) => UNTOUCHABLE.test(name))).toEqual([]);
  expect(
    loads(win).filter(
      (args) =>
        args.length !== 3 || typeof args[0] !== 'string' || args[1] !== false || args[2] !== true,
    ),
  ).toEqual([]);
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

describe('layout_list', () => {
  test('layout_list reports the current layout and every saved layout in the order TradingView gives them', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'layout_list');

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: {
        current: { id: 'FIXTURE1', name: 'Fixture Layout' },
        layouts: [
          {
            id: 'FIXTURE1',
            name: 'Fixture Layout',
            modified: 1767225600,
            modifiedIso: '2026-01-01T00:00:00Z',
          },
          {
            id: 'FIXTURE2',
            name: 'Second Layout',
            modified: 1767312000,
            modifiedIso: '2026-01-02T00:00:00Z',
          },
          {
            id: 'FIXTURE3',
            name: 'Locked Layout',
            modified: 1764547200,
            modifiedIso: '2025-12-01T00:00:00Z',
            overLimit: true,
          },
        ],
      },
      meta: { via: 'api', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(JSON.parse(textOf(result))).toStrictEqual(result.structuredContent);
    // The one request the layouts menu of TradingView sends, and nothing else.
    expect(callNames(win)).toEqual(['TradingViewApi.getSavedCharts']);
    expect(calls(win, 'TradingViewApi.getSavedCharts')).toEqual([[]]);
  });

  test('layout_list reports a layout that was never saved as current with a null id and name', async () => {
    const win = createFakeTvWindow(fixture);
    layoutsOf(win).current = { id: null, uid: null, name: null };
    const { client } = await startHarnessWith(win);

    const result = await callTool(client, 'layout_list');

    expect(dataOf(result).current).toEqual({ id: null, name: null });
    expect((dataOf(result).layouts as unknown[]).length).toBe(3);
  });

  test('layout_list leaves out a saved layout that comes without an id, with a warning, and reads a time in milliseconds', async () => {
    const win = createFakeTvWindow(fixture);
    apiOf(win).getSavedCharts = () =>
      Promise.resolve([
        { id: 1, url: 'FIXTURE1', name: 'Fixture Layout', modified_iso: 1767225600000 },
        { id: 2, name: 'Second Layout', modified_iso: 1767312000 },
      ]);
    const { client } = await startHarnessWith(win);

    const result = await callTool(client, 'layout_list');

    expect(dataOf(result).layouts).toEqual([
      {
        id: 'FIXTURE1',
        name: 'Fixture Layout',
        modified: 1767225600,
        modifiedIso: '2026-01-01T00:00:00Z',
      },
    ]);
    expect(warningsOf(result)).toEqual([expect.stringMatching(/^1 saved layout came without/)]);
  });

  test('layout_list fails NOT_AVAILABLE when TradingView cannot list the saved layouts', async () => {
    const win = createFakeTvWindow(fixture);
    layoutsOf(win).errors.getSavedCharts = {
      status: 500,
      code: null,
      message: 'Getting my charts response was not OK',
    };
    const { client } = await startHarnessWith(win);

    expect(errorOf(await callTool(client, 'layout_list'))).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: expect.stringContaining('Getting my charts response was not OK') as string,
    });
  });
});

describe('signed out', () => {
  test('the layout tools refuse AUTH_REQUIRED while signed out, and send nothing', async () => {
    const win = createFakeTvWindow(withChartStorage(10));
    inspectFakeWindow(win).state.pineEditor.signedIn = false;
    // Signed out is told first, before the unsaved changes.
    layoutsOf(win).unsaved = true;
    const { client } = await startHarnessWith(win);

    for (const [tool, args] of [
      ['layout_list', {}],
      ['layout_new', { name: NEW_NAME }],
      ['layout_new', { name: NEW_NAME, confirm: true }],
      ['layout_switch', { layoutId: 'FIXTURE2' }],
      ['layout_switch', { layoutId: 'FIXTURE2', confirm: true }],
      ['layout_switch', { layoutId: 'FIXTURE1' }],
    ] as const) {
      expect(errorOf(await callTool(client, tool, args)), tool).toMatchObject({
        code: 'AUTH_REQUIRED',
      });
    }
    expect(inspectFakeWindow(win).calls).toEqual([]);
    expect(apiOf(win).layoutId()).toBe('FIXTURE1');
  });
});

describe('layout_switch', () => {
  test('layout_switch with unsaved changes requires confirm', async () => {
    const win = createFakeTvWindow(fixture);
    layoutsOf(win).unsaved = true;
    const { client } = await startHarnessWith(win);

    const refused = await callTool(client, 'layout_switch', { layoutId: 'FIXTURE2' });

    expect(errorOf(refused)).toEqual({
      code: 'CONFIRMATION_REQUIRED',
      message: expect.stringMatching(/unsaved changes.*discard/) as string,
      hint: expect.stringMatching(/Save the layout in TradingView.*confirm: true/s) as string,
      details: { unsavedChanges: true },
    });
    expect(loads(win)).toEqual([]);
    expect(apiOf(win).layoutId()).toBe('FIXTURE1');
    expect(layoutsOf(win).unsaved).toBe(true);

    const confirmed = await callTool(client, 'layout_switch', {
      layoutId: 'FIXTURE2',
      confirm: true,
    });

    expect(envelopeOf(confirmed)).toStrictEqual({
      ok: true,
      data: { id: 'FIXTURE2', name: 'Second Layout', changed: true },
      meta: { via: 'api', durationMs: expect.any(Number) as number, warnings: [] },
    });
    // Loaded in place, discarding the changes without the dialog of the app.
    expect(loads(win)).toEqual([['FIXTURE2', false, true]]);
    expect(apiOf(win).layoutId()).toBe('FIXTURE2');
    expect(layoutsOf(win).unsaved).toBe(false);
    expectNothingElseTouched(win);
  });

  test('layout_switch requires confirm when TradingView does not tell whether the layout has unsaved changes', async () => {
    const win = createFakeTvWindow(fixture);
    apiOf(win).hasChartChanges = () => {
      throw new Error('Not ready');
    };
    const { client } = await startHarnessWith(win);

    expect(
      errorOf(await callTool(client, 'layout_switch', { layoutId: 'FIXTURE2' })),
    ).toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      message: expect.stringMatching(/does not tell whether/) as string,
      details: { unsavedChanges: null },
    });
    expect(loads(win)).toEqual([]);
    expect(
      dataOf(await callTool(client, 'layout_switch', { layoutId: 'FIXTURE2', confirm: true })),
    ).toEqual({ id: 'FIXTURE2', name: 'Second Layout', changed: true });
  });

  test('layout_switch to the current layout changes nothing', async () => {
    const win = createFakeTvWindow(fixture);
    // Not even unsaved changes stand in the way: nothing is loaded.
    layoutsOf(win).unsaved = true;
    const { client } = await startHarnessWith(win);

    const result = await callTool(client, 'layout_switch', { layoutId: 'FIXTURE1' });

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: { id: 'FIXTURE1', name: 'Fixture Layout', changed: false },
      meta: { via: 'api', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(inspectFakeWindow(win).calls).toEqual([]);
    expect(layoutsOf(win).unsaved).toBe(true);
  });

  test('layout_switch to an unknown id is INVALID_INPUT with the hint layout_list', async () => {
    const { client, win } = await startHarness();

    for (const layoutId of ['NOSUCH01', 'constructor', 'fixture2']) {
      expect(errorOf(await callTool(client, 'layout_switch', { layoutId })), layoutId).toEqual({
        code: 'INVALID_INPUT',
        message: `The account has no saved layout ${layoutId}`,
        hint: expect.stringContaining('layout_list') as string,
        details: { layoutId },
      });
    }
    // The in-place loader would have loaded nothing for it without a word.
    expect(loads(win)).toEqual([]);
    expect(apiOf(win).layoutId()).toBe('FIXTURE1');
  });

  test("layout_switch waits until the new layout's chart is ready and reports it", async () => {
    const { client, win } = await startHarness(fixture, { layouts: { loadMs: 50, dataMs: 400 } });

    const result = await callTool(client, 'layout_switch', { layoutId: 'FIXTURE2' });

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: { id: 'FIXTURE2', name: 'Second Layout', changed: true },
      meta: { via: 'api', durationMs: expect.any(Number) as number, warnings: [] },
    });
    // It answered once the chart had its data, not when the layout was switched.
    expect(layoutsOf(win).dataReady).toBe(true);
    expect(envelopeOf(result).meta.durationMs).toBeGreaterThanOrEqual(400);
    // The wait polled with plain page functions: none of them pushed a chunk to look up a module.
    expect(win.webpackChunktradingview).toHaveLength(0);
    expect(dataOf(await callTool(client, 'layout_list')).current).toEqual({
      id: 'FIXTURE2',
      name: 'Second Layout',
    });
    expectNothingElseTouched(win);

    // A chart whose data does not come in time: switched all the same, with a warning.
    const { client: slow } = await startHarness(
      fixture,
      { layouts: { dataMs: Infinity } },
      { callTimeoutMs: 2000 },
    );
    const late = await callTool(slow, 'layout_switch', { layoutId: 'FIXTURE2' });

    expect(dataOf(late)).toEqual({ id: 'FIXTURE2', name: 'Second Layout', changed: true });
    expect(warningsOf(late)).toEqual([
      expect.stringMatching(/did not report its data as loaded.*chart_get_state/) as string,
    ]);
  });

  test('layout_switch reports a layout TradingView switched to but did not finish loading, with a warning', async () => {
    const { client, win } = await startHarness(
      fixture,
      { layouts: { loadMs: 60_000 } },
      { callTimeoutMs: 2000 },
    );

    const result = await callTool(client, 'layout_switch', { layoutId: 'FIXTURE2' });

    expect(dataOf(result)).toEqual({ id: 'FIXTURE2', name: 'Second Layout', changed: true });
    expect(warningsOf(result)).toEqual([
      expect.stringMatching(/did not report that it finished loading it/) as string,
    ]);
    expectNothingElseTouched(win);
  });

  test('layout_switch to a layout over the plan limit is PLAN_LIMIT CHART_STORAGE and opens nothing', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'layout_switch', { layoutId: 'FIXTURE3', confirm: true });

    expect(errorOf(result)).toMatchObject({
      code: 'PLAN_LIMIT',
      details: { feature: 'CHART_STORAGE', layoutId: 'FIXTURE3' },
    });
    expect(loads(win)).toEqual([]);
    expectNothingElseTouched(win);
  });

  test('layout_switch fails NOT_AVAILABLE with the hint layout_list when TradingView does not open the layout', async () => {
    const hanging = createFakeTvWindow(fixture);
    layoutsOf(hanging).loadHangs = true;
    const failing = createFakeTvWindow(fixture);
    layoutsOf(failing).errors.loadLayout = { status: 500, code: null, message: 'Server error' };
    const { client: hangs } = await startHarnessWith(hanging, { callTimeoutMs: 2000 });
    const { client: fails } = await startHarnessWith(failing);

    expect(errorOf(await callTool(hangs, 'layout_switch', { layoutId: 'FIXTURE2' }))).toEqual({
      code: 'NOT_AVAILABLE',
      message: 'TradingView did not open the layout FIXTURE2',
      hint: expect.stringContaining('layout_list') as string,
      details: { layoutId: 'FIXTURE2' },
    });
    expect(errorOf(await callTool(fails, 'layout_switch', { layoutId: 'FIXTURE2' }))).toMatchObject(
      {
        code: 'NOT_AVAILABLE',
        message: expect.stringMatching(/did not open the layout FIXTURE2: .*500/) as string,
        hint: expect.stringContaining('layout_list') as string,
      },
    );
    for (const win of [hanging, failing]) {
      expect(apiOf(win).layoutId()).toBe('FIXTURE1');
      expectNothingElseTouched(win);
    }
  });

  test('layout_switch names the layout as layout_list does when the chart gives no name', async () => {
    const win = createFakeTvWindow(fixture);
    const { client } = await startHarnessWith(win);
    apiOf(win).layoutName = () => null;

    expect(dataOf(await callTool(client, 'layout_switch', { layoutId: 'FIXTURE2' }))).toEqual({
      id: 'FIXTURE2',
      name: 'Second Layout',
      changed: true,
    });
  });

  test('layout_switch waits for the turn of the plan-limited actions', async () => {
    const { client, win } = await startHarness();
    const release = holdPlanLimitedTurn();

    const switching = callTool(client, 'layout_switch', { layoutId: 'FIXTURE2' });
    await delay(150);

    expect(inspectFakeWindow(win).calls).toEqual([]);
    release();
    expect(dataOf(await switching)).toEqual({
      id: 'FIXTURE2',
      name: 'Second Layout',
      changed: true,
    });
  });
});

describe('layout_new', () => {
  test('layout_new creates the layout with the options of the Create new layout dialog and opens it in place', async () => {
    const { client, win } = await startHarness(withChartStorage(5));

    const result = await callTool(client, 'layout_new', { name: NEW_NAME });

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: { id: 'NEW00001', name: NEW_NAME, opened: true },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(creations(win)).toEqual([[{ name: NEW_NAME, ...DIALOG_OPTIONS }]]);
    expect(calls(win, 'hasPermissionsToCreateNewChart')).toEqual([[]]);
    expect(loads(win)).toEqual([['NEW00001', false, true]]);
    const listed = dataOf(await callTool(client, 'layout_list'));
    expect(listed.current).toEqual({ id: 'NEW00001', name: NEW_NAME });
    expect((listed.layouts as { id: string }[]).map(({ id }) => id)).toEqual([
      'FIXTURE1',
      'FIXTURE2',
      'FIXTURE3',
      'NEW00001',
    ]);
    expectNothingElseTouched(win);
  });

  test('layout_new trims the name and takes 1 to 64 characters', async () => {
    const { client, win } = await startHarness(withChartStorage(10));

    expect(dataOf(await callTool(client, 'layout_new', { name: '  Padded Name  ' }))).toMatchObject(
      {
        name: 'Padded Name',
        opened: true,
      },
    );
    expect(dataOf(await callTool(client, 'layout_new', { name: 'x'.repeat(64) }))).toMatchObject({
      name: 'x'.repeat(64),
    });
    // 64 characters once trimmed.
    expect(
      dataOf(await callTool(client, 'layout_new', { name: ` ${'y'.repeat(64)} ` })),
    ).toMatchObject({ name: 'y'.repeat(64) });
    expect(creations(win)).toHaveLength(3);

    expect(errorOf(await callTool(client, 'layout_new', { name: 'z'.repeat(65) }))).toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('65') as string,
      details: { length: 65, max: 64 },
    });
    for (const name of ['   ', '\t\n']) {
      expect(errorOf(await callTool(client, 'layout_new', { name })), name).toMatchObject({
        code: 'INVALID_INPUT',
      });
    }
    expect(creations(win)).toHaveLength(3);
  });

  test('layout_new returns PLAN_LIMIT CHART_STORAGE when the saved layouts fill the plan and creates nothing', async () => {
    const { client, win } = await startHarness(withChartStorage(3));

    const result = await callTool(client, 'layout_new', { name: NEW_NAME });

    expect(errorOf(result)).toEqual({
      code: 'PLAN_LIMIT',
      message: 'Plan limit reached for CHART_STORAGE: the plan allows 3 and 3 are in use',
      hint: expect.stringContaining('layout_switch') as string,
      details: { feature: 'CHART_STORAGE', limit: 3 },
    });
    expect(creations(win)).toEqual([]);
    expect(calls(win, 'hasPermissionsToCreateNewChart')).toEqual([]);
    expect(loads(win)).toEqual([]);
    expect(layoutsOf(win).saved).toHaveLength(3);
    expectNothingElseTouched(win);
  });

  test('layout_new refuses when the limit cannot be read', async () => {
    // The plan of the fixture configures no CHART_STORAGE, so the app has no limit to give.
    const { client: unconfigured, win } = await startHarness();
    // A build whose plan modules are not loaded.
    const { client: unloaded, win: bare } = await startHarness(withChartStorage(5), {
      webpackModules: {},
    });

    for (const client of [unconfigured, unloaded]) {
      expect(errorOf(await callTool(client, 'layout_new', { name: NEW_NAME }))).toMatchObject({
        code: 'NOT_AVAILABLE',
        details: { feature: 'CHART_STORAGE' },
      });
    }
    for (const fake of [win, bare]) {
      expect(creations(fake)).toEqual([]);
      expect(loads(fake)).toEqual([]);
      expect(layoutsOf(fake).saved).toHaveLength(3);
    }
  });

  test('layout_new with unsaved changes requires confirm and creates nothing', async () => {
    const win = createFakeTvWindow(withChartStorage(5));
    layoutsOf(win).unsaved = true;
    const { client } = await startHarnessWith(win);

    const refused = await callTool(client, 'layout_new', { name: NEW_NAME });

    expect(errorOf(refused)).toEqual({
      code: 'CONFIRMATION_REQUIRED',
      message: expect.stringMatching(
        /unsaved changes.*opening the new layout would discard/,
      ) as string,
      hint: expect.stringMatching(
        /Save the layout in TradingView.*confirm: true.*Nothing was created/s,
      ) as string,
      details: { unsavedChanges: true },
    });
    expect(inspectFakeWindow(win).calls).toEqual([]);

    const confirmed = await callTool(client, 'layout_new', { name: NEW_NAME, confirm: true });

    expect(dataOf(confirmed)).toEqual({ id: 'NEW00001', name: NEW_NAME, opened: true });
    expect(layoutsOf(win).unsaved).toBe(false);
    expectNothingElseTouched(win);
  });

  test('layout_new refuses PLAN_LIMIT when the permission check of TradingView says no, and creates nothing', async () => {
    const win = createFakeTvWindow(withChartStorage(5));
    // The count request the check sends is refused, which the app takes for no.
    layoutsOf(win).errors.getChartsCount = { status: 403, code: null, message: 'Forbidden' };
    const { client } = await startHarnessWith(win);

    expect(errorOf(await callTool(client, 'layout_new', { name: NEW_NAME }))).toMatchObject({
      code: 'PLAN_LIMIT',
      details: { feature: 'CHART_STORAGE', limit: 5 },
    });
    expect(creations(win)).toEqual([]);
    expectNothingElseTouched(win);
  });

  test('layout_new refuses when the permission check of TradingView fails, and creates nothing', async () => {
    const win = createFakeTvWindow(withChartStorage(5));
    layoutsOf(win).errors.getChartsCount = { status: 500, code: null, message: 'Server error' };
    const { client } = await startHarnessWith(win);

    expect(errorOf(await callTool(client, 'layout_new', { name: NEW_NAME }))).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: expect.stringContaining('Server error') as string,
      details: { feature: 'CHART_STORAGE' },
    });
    expect(creations(win)).toEqual([]);
  });

  test('layout_new relies on its own check of the limit on a build without the permission check of TradingView', async () => {
    const { client, win } = await startHarness(withChartStorage(5), {
      layouts: { withoutPermissionCheck: true },
    });

    expect(dataOf(await callTool(client, 'layout_new', { name: NEW_NAME }))).toEqual({
      id: 'NEW00001',
      name: NEW_NAME,
      opened: true,
    });
    expect(creations(win)).toHaveLength(1);
  });

  test('layout_new fails NOT_AVAILABLE when TradingView does not create the layout, and says TradingView may show why', async () => {
    const win = createFakeTvWindow(withChartStorage(5));
    layoutsOf(win).errors.createNewChart = { status: 500, code: null, message: 'Server error' };
    const { client } = await startHarnessWith(win);

    expect(errorOf(await callTool(client, 'layout_new', { name: NEW_NAME }))).toEqual({
      code: 'NOT_AVAILABLE',
      message: 'TradingView did not create the layout',
      hint: expect.stringMatching(/may show a message/) as string,
    });
    expect(creations(win)).toHaveLength(1);
    expect(loads(win)).toEqual([]);
    expect(layoutsOf(win).saved).toHaveLength(3);
    // The warning TradingView shows for a failure the checks before cannot foresee: the residual
    // risk the description of layout_new names.
    expect(calls(win, 'dialog.warning')).toEqual([['Server error']]);
  });

  test('layout_new on a build without createNewChart fails NOT_AVAILABLE and creates nothing', async () => {
    const { client, win } = await startHarness(withChartStorage(5), {
      layouts: { withoutCreateNewChart: true },
    });

    expect(errorOf(await callTool(client, 'layout_new', { name: NEW_NAME }))).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: expect.stringContaining('createNewChart') as string,
    });
    expect(layoutsOf(win).saved).toHaveLength(3);
    expectNothingElseTouched(win);
  });

  test('layout_new reports a layout it created but could not open as created, with opened false and the hint layout_switch', async () => {
    const failing = createFakeTvWindow(withChartStorage(5));
    layoutsOf(failing).errors.loadLayout = { status: 500, code: null, message: 'Server error' };
    const hanging = createFakeTvWindow(withChartStorage(5));
    layoutsOf(hanging).loadHangs = true;
    const { client: fails } = await startHarnessWith(failing);
    const { client: hangs } = await startHarnessWith(hanging, { callTimeoutMs: 2000 });

    for (const [client, win] of [
      [fails, failing],
      [hangs, hanging],
    ] as const) {
      const result = await callTool(client, 'layout_new', { name: NEW_NAME });

      expect(envelopeOf(result)).toStrictEqual({
        ok: true,
        data: { id: 'NEW00001', name: NEW_NAME, opened: false },
        meta: {
          via: 'internal',
          durationMs: expect.any(Number) as number,
          warnings: [expect.stringMatching(/layout_switch.*NEW00001.*not.*layout_new again/s)],
        },
      });
      expect(layoutsOf(win).saved.map(({ url }) => url)).toContain('NEW00001');
      expect(apiOf(win).layoutId()).toBe('FIXTURE1');
      expectNothingElseTouched(win);
    }
  });

  test('layout_new reports the layout it created as created when the page cannot open it in place', async () => {
    const win = createFakeTvWindow(withChartStorage(5));
    Reflect.deleteProperty(apiOf(win), 'loadLayoutFromServerByLayoutId');
    const { client } = await startHarnessWith(win);

    const result = await callTool(client, 'layout_new', { name: NEW_NAME });

    expect(dataOf(result)).toEqual({ id: 'NEW00001', name: NEW_NAME, opened: false });
    expect(warningsOf(result)).toEqual([
      expect.stringMatching(
        /NEW00001 but did not open it in time \(This page has no layout API/,
      ) as string,
    ]);
    expect(layoutsOf(win).saved.map(({ url }) => url)).toContain('NEW00001');
  });

  test('layout_new reports the layout as opened, with a warning, when its chart has no data in time', async () => {
    const { client } = await startHarness(
      withChartStorage(5),
      { layouts: { dataMs: Infinity } },
      { callTimeoutMs: 2000 },
    );

    const result = await callTool(client, 'layout_new', { name: NEW_NAME });

    expect(dataOf(result)).toEqual({ id: 'NEW00001', name: NEW_NAME, opened: true });
    expect(warningsOf(result)).toEqual([
      expect.stringMatching(/did not report its data as loaded/) as string,
    ]);
  });

  test('layout_new reports a layout TradingView created without an id it can read as created, and opens nothing', async () => {
    const win = createFakeTvWindow(withChartStorage(5));
    moduleWith(win, 'createNewChart').createNewChart = () =>
      Promise.resolve('https://www.tradingview.com/somewhere-else/');
    const { client } = await startHarnessWith(win);

    const result = await callTool(client, 'layout_new', { name: NEW_NAME });

    expect(dataOf(result)).toEqual({ id: null, name: NEW_NAME, opened: false });
    expect(warningsOf(result)).toEqual([
      expect.stringMatching(/did not say its id.*layout_list.*layout_switch/s) as string,
    ]);
    expect(loads(win)).toEqual([]);
  });

  test('two layout_new calls at the limit less one create one layout', async () => {
    const { client, win } = await startHarness(withChartStorage(4));

    const results = await Promise.all([
      callTool(client, 'layout_new', { name: 'First Example' }),
      callTool(client, 'layout_new', { name: 'Second Example' }),
    ]);

    expect(results.map((result) => envelopeOf(result).ok).sort()).toEqual([false, true]);
    expect(results.map((result) => errorOf(result)?.code).filter(Boolean)).toEqual(['PLAN_LIMIT']);
    expect(creations(win)).toHaveLength(1);
    expect(layoutsOf(win).saved).toHaveLength(4);
  });

  test('layout_new waits for the turn of the plan-limited actions', async () => {
    const { client, win } = await startHarness(withChartStorage(5));
    const release = holdPlanLimitedTurn();

    const creating = callTool(client, 'layout_new', { name: NEW_NAME });
    await delay(150);

    expect(inspectFakeWindow(win).calls).toEqual([]);
    release();
    expect(dataOf(await creating)).toEqual({ id: 'NEW00001', name: NEW_NAME, opened: true });
  });
});

describe('privacy', () => {
  test('the layout tools log no layout name', async () => {
    const { logger, lines } = capturingLogger();
    const win = createFakeTvWindow(withChartStorage(5));
    const { client } = await startHarnessWith(win, {}, logger);

    await callTool(client, 'layout_list');
    await callTool(client, 'layout_new', { name: NEW_NAME });
    await callTool(client, 'layout_switch', { layoutId: 'FIXTURE2' });
    layoutsOf(win).unsaved = true;
    await callTool(client, 'layout_switch', { layoutId: 'FIXTURE1' });
    await callTool(client, 'layout_new', { name: NEW_NAME });
    await callTool(client, 'layout_switch', { layoutId: 'NOSUCH01' });

    expect(lines.length).toBeGreaterThan(0);
    const logged = JSON.stringify(lines);
    for (const name of [...LAYOUT_NAMES, NEW_NAME]) {
      expect(logged, name).not.toContain(name);
    }
  });
});
