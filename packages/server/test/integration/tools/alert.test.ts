import { setTimeout as delay } from 'node:timers/promises';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../../../src/config/schema.js';
import { createMcpServer } from '../../../src/server.js';
import type { SessionState } from '../../../src/tools/types.js';
import { startFakeCdpServer } from '../../helpers/fake-cdp/server.js';
import { loadTargetsFixture } from '../../helpers/fake-cdp/targets.js';
import {
  loadTvFixture,
  type FixtureAlert,
  type TvStateFixture,
} from '../../helpers/fake-tv/fixture.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTvOverrides,
  type FakeTvWindow,
} from '../../helpers/fake-tv/window.js';
import { callTool, connectInMemoryClient, textOf } from '../../helpers/mcp-client.js';
import { quietLogger, refusingLauncher, testConfig } from '../../helpers/tool-context.js';

// The alert tools through the whole server: an SDK client over the in-memory transport, the real
// registry, connection manager and CDP adapter, and the fake debug port of the app with a fake
// chart and a fake alerts server behind it. The clock of the server is fixed. Values are synthetic.

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
const DAY = 86_400;
// 2026-10-22T12:00:00Z, the time of the clock in every test.
const NOW = Date.UTC(2026, 9, 22, 12) / 1000;
const CHART_ALERT_SYMBOL = '={"adjustment":"splits","currency-id":"USD","symbol":"NASDAQ:AAPL"}';

const cleanups: (() => Promise<void>)[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
});

afterEach(async () => {
  vi.useRealTimers();
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
  config: Partial<Config> = {},
): Promise<{ client: Client; win: FakeTvWindow; session: SessionState }> {
  const app = await startFakeCdpServer({ targets: loadTargetsFixture({ chartWindow: () => win }) });
  cleanups.push(() => app.close());
  const { server, ctx } = createMcpServer(
    testConfig({ cdpPort: app.port, callTimeoutMs: 5000, ...config }),
    { launcher: refusingLauncher(), logger: quietLogger },
  );
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

interface ListedAlert {
  id: string;
  symbol: string | null;
  kind: string | null;
  condition: string | null;
  price: number | null;
  indicator: string | null;
  value: number | null;
  message: string | null;
  status: string;
  expiration: number | null;
  expirationIso: string | null;
  createdByServer: boolean;
}

const envelopeOf = (result: { structuredContent?: unknown }): Envelope =>
  result.structuredContent as Envelope;
const dataOf = (result: { structuredContent?: unknown }) => envelopeOf(result).data ?? {};
const errorOf = (result: { structuredContent?: unknown }) => envelopeOf(result).error;
const warningsOf = (result: { structuredContent?: unknown }) =>
  envelopeOf(result).meta.warnings ?? [];
const alertsOf = (result: { structuredContent?: unknown }) =>
  (dataOf(result).alerts ?? []) as ListedAlert[];

const isoOf = (seconds: number) => new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');

const calls = (win: FakeTvWindow, name: string) => inspectFakeWindow(win).callsTo(name);
const sentPayloads = (win: FakeTvWindow) =>
  calls(win, 'alertsRestApi.createAlert').map(([payload]) => payload as Record<string, unknown>);
const idsOn = (win: FakeTvWindow) =>
  inspectFakeWindow(win).state.alerts.list.map(({ alert_id: id }) => id);

const withAlerts = (alerts: FixtureAlert[], from: TvStateFixture = fixture): TvStateFixture => ({
  ...from,
  alerts,
});

// A plan with room for ten active price alerts.
const ROOMY: TvStateFixture = {
  ...fixture,
  planConfigs: { SERVER_SIDE_ALERTS: { primitive_limit: 10, complex_limit: 0, overall_limit: 50 } },
};

// `count` active price alerts, with ids from `first`.
const activeAlerts = (count: number, first = 1): FixtureAlert[] =>
  Array.from({ length: count }, (_, index) => ({ id: first + index }));

// The payload the alerts service of the app sends for a price alert crossing 150 on the chart
// symbol, which expires on `time`.
function chartPayload(time: string, change: Record<string, unknown> = {}) {
  return {
    conditions: [
      {
        type: 'cross',
        frequency: 'on_first_fire',
        series: [{ type: 'barset' }, { type: 'value', value: 150 }],
        resolution: '1D',
      },
    ],
    symbol: CHART_ALERT_SYMBOL,
    resolution: '1D',
    message: 'AAPL crossing 150',
    sound_file: null,
    sound_duration: 0,
    popup: true,
    auto_deactivate: true,
    email: false,
    sms_over_email: false,
    mobile_push: false,
    web_hook: null,
    name: null,
    expiration_policy: { policy: 'fixed_date', time },
    active: true,
    ignore_warnings: true,
    ...change,
  };
}

interface RestApi {
  listAlerts: (...args: unknown[]) => Promise<unknown>;
  createAlert: (payload: unknown) => Promise<unknown>;
  deleteAlerts: (payload: { alert_ids: number[] }) => Promise<unknown>;
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

// The alerts client of the fake app, the same object the page reaches.
function restApiOf(win: FakeTvWindow): RestApi {
  return (moduleWith(win, 'getAlertsRestApi').getAlertsRestApi as () => RestApi)();
}

const chartOf = (win: FakeTvWindow) => {
  const api = win.TradingViewApi;
  if (api === undefined) {
    throw new Error('The fake window has no TradingViewApi');
  }
  return api.activeChart();
};

// Nothing of the alerts service of the app, its actions, its error presenter, the chart facade or
// the admin client was used, no dialog opened, and of the alerts client only the calls of the tools
// went out.
const UNTOUCHABLE =
  /^(alertsActions|alertsCollection|alertsPresenter|chartAlertsFacade|alertsAdminRestApi|dialog)\./;
const TOOL_CALLS = new Set([
  'alertsRestApi.listAlerts',
  'alertsRestApi.createAlert',
  'alertsRestApi.deleteAlerts',
]);

function expectNothingElseTouched(win: FakeTvWindow): void {
  const names = inspectFakeWindow(win).calls.map(({ name }) => name);
  expect(names.filter((name) => UNTOUCHABLE.test(name))).toEqual([]);
  expect(
    names.filter((name) => name.startsWith('alertsRestApi.') && !TOOL_CALLS.has(name)),
  ).toEqual([]);
}

describe('alert_create', () => {
  test("alert_create builds the payload the app's alert dialog sends", async () => {
    const { client, win, session } = await startHarness();

    const result = await callTool(client, 'alert_create', { condition: 'crossing', price: 150 });

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: {
        id: '9001',
        symbol: 'NASDAQ:AAPL',
        condition: 'crossing',
        price: 150,
        expiration: NOW + 30 * DAY,
        expirationIso: '2026-11-21T12:00:00Z',
      },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(JSON.parse(textOf(result))).toStrictEqual(result.structuredContent);
    // The fields the converter of the app makes of the state of the alert dialog, with active and
    // ignore_warnings as the alerts service adds them; the symbol is the chart's, as the chart
    // gives it to an alert; the alert expires after the default of TradingView.
    expect(sentPayloads(win)).toEqual([chartPayload('2026-11-21T12:00:00.000Z')]);
    const converted = calls(win, 'alerts.convertEditableAlertState');
    expect(converted).toHaveLength(1);
    expect(converted[0]?.[1]).toBe(false);
    // The id is recorded, so deleting the alert needs no confirm.
    expect(session.createdAlertIds).toEqual(new Set(['9001']));
    const listed = alertsOf(await callTool(client, 'alert_list'));
    expect(listed.map(({ id, createdByServer }) => [id, createdByServer])).toEqual([
      ['9001', true],
    ]);
    expectNothingElseTouched(win);
  });

  test('alert_create returns PLAN_LIMIT SERVER_SIDE_ALERTS when the active alerts fill the plan and sends nothing', async () => {
    const { client, win, session } = await startHarness(withAlerts(activeAlerts(3)));

    const result = await callTool(client, 'alert_create', { condition: 'crossing', price: 150 });

    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({
      code: 'PLAN_LIMIT',
      message: expect.stringContaining('SERVER_SIDE_ALERTS') as string,
      hint: expect.stringContaining('alert_delete') as string,
      details: { feature: 'SERVER_SIDE_ALERTS', limit: 3 },
    });
    expect(sentPayloads(win)).toEqual([]);
    expect(calls(win, 'alerts.convertEditableAlertState')).toEqual([]);
    expect(idsOn(win)).toEqual([1, 2, 3]);
    expect(session.createdAlertIds.size).toBe(0);
    expectNothingElseTouched(win);
  });

  test('alert_create refuses when the limit cannot be read', async () => {
    const withoutAlertLimits = { INDICATORS_ON_CHART: 2 };
    for (const plan of [
      { planLimits: withoutAlertLimits, planConfigs: {} },
      // The active limit alone, without the overall one.
      {
        planLimits: withoutAlertLimits,
        planConfigs: { SERVER_SIDE_ALERTS: { primitive_limit: 3 } },
      },
      // The overall limit alone, without the active one.
      {
        planLimits: withoutAlertLimits,
        planConfigs: { SERVER_SIDE_ALERTS: { overall_limit: 50 } },
      },
    ]) {
      const { client, win } = await startHarness({ ...fixture, ...plan });

      const result = await callTool(client, 'alert_create', { condition: 'crossing', price: 150 });

      expect(errorOf(result), JSON.stringify(plan)).toMatchObject({
        code: 'NOT_AVAILABLE',
        details: { feature: 'SERVER_SIDE_ALERTS' },
      });
      expect(sentPayloads(win)).toEqual([]);
    }
  });

  test('alert_create refuses NOT_AVAILABLE, and sends nothing, when the alerts of the account cannot be listed', async () => {
    const refusing = createFakeTvWindow(fixture);
    inspectFakeWindow(refusing).state.alerts.errors.listAlerts = {
      code: 'maintenance',
      message: 'Maintenance',
    };
    // A request that fails on the way, which has no code.
    const failing = createFakeTvWindow(fixture);
    restApiOf(failing).listAlerts = () => Promise.reject(new Error('Fetch Failed'));
    const { client: refusingClient } = await startHarnessWith(refusing);
    const { client: failingClient } = await startHarnessWith(failing);

    const refused = await callTool(refusingClient, 'alert_create', {
      condition: 'crossing',
      price: 150,
    });
    const failed = await callTool(failingClient, 'alert_create', {
      condition: 'crossing',
      price: 150,
    });

    expect(errorOf(refused)).toMatchObject({
      code: 'NOT_AVAILABLE',
      message:
        'The alerts of the account could not be listed, so the plan limit SERVER_SIDE_ALERTS ' +
        'cannot be checked: Maintenance (maintenance)',
      details: { feature: 'SERVER_SIDE_ALERTS', code: 'maintenance' },
    });
    expect(errorOf(failed)).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: expect.stringMatching(/cannot be checked: Fetch Failed$/) as string,
      details: { feature: 'SERVER_SIDE_ALERTS', code: null },
    });
    expect(sentPayloads(refusing)).toEqual([]);
    expect(sentPayloads(failing)).toEqual([]);
  });

  test('alert_create counts every alert of the account, active or not, against overall_limit', async () => {
    const { client, win } = await startHarness(
      withAlerts(Array.from({ length: 50 }, (_, index) => ({ id: index + 1, active: false }))),
    );

    const result = await callTool(client, 'alert_create', { condition: 'crossing', price: 150 });

    expect(errorOf(result)).toMatchObject({
      code: 'PLAN_LIMIT',
      hint: expect.stringContaining('stopped and triggered') as string,
      details: { feature: 'SERVER_SIDE_ALERTS', limit: 50 },
    });
    expect(sentPayloads(win)).toEqual([]);
  });

  test('alert_create counts the active price alerts against limit when the plan has no primitive_limit', async () => {
    const { client, win } = await startHarness({
      ...withAlerts(activeAlerts(2)),
      planLimits: { ...fixture.planLimits, SERVER_SIDE_ALERTS: 2 },
      planConfigs: { SERVER_SIDE_ALERTS: { overall_limit: 50 } },
    });

    const result = await callTool(client, 'alert_create', { condition: 'crossing', price: 150 });

    expect(errorOf(result)).toMatchObject({
      code: 'PLAN_LIMIT',
      details: { feature: 'SERVER_SIDE_ALERTS', limit: 2 },
    });
    expect(sentPayloads(win)).toEqual([]);
  });

  test('alert_create does not count stopped, triggered, complex or watchlist alerts against the active price alerts', async () => {
    const { client, win } = await startHarness(
      withAlerts([
        ...activeAlerts(2),
        { id: 3, active: false },
        { id: 4, active: false, lastStopReason: 'auto' },
        { id: 5, complexity: 'complex', price: null },
        { id: 6, kinds: ['watchlist'] },
      ]),
    );

    const result = await callTool(client, 'alert_create', { condition: 'crossing', price: 150 });

    expect(dataOf(result)).toMatchObject({ id: '9001' });
    expect(idsOn(win)).toEqual([1, 2, 3, 4, 5, 6, 9001]);
  });

  test('two parallel alert_create calls at limit − 1 create one alert', async () => {
    const win = createFakeTvWindow(withAlerts(activeAlerts(2)));
    const api = restApiOf(win);
    // A call that creates waits in createAlert until the other call has listed the alerts as well,
    // or for a while when the other call waits for its turn instead.
    const list = api.listAlerts.bind(api);
    let lists = 0;
    let listedTwice = (): void => undefined;
    const secondList = new Promise<void>((resolve) => {
      listedTwice = resolve;
    });
    api.listAlerts = (...args: unknown[]) => {
      lists += 1;
      if (lists === 2) {
        listedTwice();
      }
      return list(...args);
    };
    const create = api.createAlert.bind(api);
    api.createAlert = async (payload: unknown) => {
      await Promise.race([secondList, delay(300)]);
      return create(payload);
    };
    const { client } = await startHarnessWith(win);

    const results = await Promise.all([
      callTool(client, 'alert_create', { condition: 'crossing', price: 150 }),
      callTool(client, 'alert_create', { condition: 'crossing', price: 160 }),
    ]);

    expect(results.filter(({ isError }) => isError !== true)).toHaveLength(1);
    expect(results.map((result) => errorOf(result)?.code).filter(Boolean)).toEqual(['PLAN_LIMIT']);
    expect(results.map((result) => errorOf(result)?.details).filter(Boolean)).toEqual([
      { feature: 'SERVER_SIDE_ALERTS', limit: 3 },
    ]);
    // The second call checked the limit after the first one had created its alert, and sent
    // nothing.
    expect(calls(win, 'alertsRestApi.createAlert')).toHaveLength(1);
    expect(idsOn(win)).toEqual([1, 2, 9001]);
    expectNothingElseTouched(win);
  });

  test('a server-side refusal such as total_alerts_count_exceeded is relayed as PLAN_LIMIT unchanged', async () => {
    const win = createFakeTvWindow(fixture);
    inspectFakeWindow(win).state.alerts.errors.createAlert = {
      code: 'total_alerts_count_exceeded',
      message: 'Synthetic: the account has as many alerts as its plan allows',
    };
    const { client, session } = await startHarnessWith(win);

    const result = await callTool(client, 'alert_create', { condition: 'crossing', price: 150 });

    expect(errorOf(result)).toEqual({
      code: 'PLAN_LIMIT',
      message: 'Synthetic: the account has as many alerts as its plan allows',
      hint: expect.stringContaining('alert_delete') as string,
      details: { feature: 'SERVER_SIDE_ALERTS', code: 'total_alerts_count_exceeded' },
    });
    expect(session.createdAlertIds.size).toBe(0);
    // The error presenter of the app, which opens the paywall for such codes, is not used.
    expectNothingElseTouched(win);
  });

  test.each([
    'max_primitive_alerts_count_exceeded',
    'active_alerts_count_exceeded',
    'max_complex_alerts_count_exceeded',
  ])('the server-side limit code %s is relayed as PLAN_LIMIT unchanged too', async (code) => {
    const win = createFakeTvWindow(fixture);
    inspectFakeWindow(win).state.alerts.errors.createAlert = {
      code,
      message: `Synthetic text of ${code}`,
    };
    const { client } = await startHarnessWith(win);

    const result = await callTool(client, 'alert_create', { condition: 'crossing', price: 150 });

    expect(errorOf(result)).toMatchObject({
      code: 'PLAN_LIMIT',
      message: `Synthetic text of ${code}`,
      details: { feature: 'SERVER_SIDE_ALERTS', code },
    });
    expectNothingElseTouched(win);
  });

  test('a signed-out account is AUTH_REQUIRED, and another refusal PAGE_EVALUATION_FAILED with its code', async () => {
    const signedOut = createFakeTvWindow(fixture);
    inspectFakeWindow(signedOut).state.pineEditor.signedIn = false;
    const refusing = createFakeTvWindow(fixture);
    inspectFakeWindow(refusing).state.alerts.errors.createAlert = {
      code: 'no_permissions',
      message: 'Synthetic refusal',
    };
    const { client: signedOutClient } = await startHarnessWith(signedOut);
    const { client: refusingClient } = await startHarnessWith(refusing);

    const outcomes = [
      await callTool(signedOutClient, 'alert_create', { condition: 'crossing', price: 150 }),
      await callTool(refusingClient, 'alert_create', { condition: 'crossing', price: 150 }),
    ];

    expect(errorOf(outcomes[0] ?? {})).toMatchObject({
      code: 'AUTH_REQUIRED',
      hint: 'Sign in to TradingView, then try again.',
    });
    expect(errorOf(outcomes[1] ?? {})).toMatchObject({
      code: 'PAGE_EVALUATION_FAILED',
      message: 'TradingView did not create the alert: Synthetic refusal (no_permissions)',
      details: { code: 'no_permissions' },
    });
    expect(sentPayloads(signedOut)).toEqual([]);
    expectNothingElseTouched(signedOut);
    expectNothingElseTouched(refusing);
  });

  test("the symbol defaults to the chart's, which a name of the chart symbol also stands for", async () => {
    const { client, win } = await startHarness(ROOMY);

    for (const symbol of [undefined, 'AAPL', 'NASDAQ:AAPL', 'nasdaq:aapl ']) {
      const result = await callTool(client, 'alert_create', {
        ...(symbol === undefined ? {} : { symbol }),
        condition: 'greater_than',
        price: 101,
      });

      expect(dataOf(result), String(symbol)).toMatchObject({ symbol: 'NASDAQ:AAPL' });
    }
    expect(sentPayloads(win).map(({ symbol, message }) => [symbol, message])).toEqual(
      Array.from({ length: 4 }, () => [CHART_ALERT_SYMBOL, 'AAPL greater than 101']),
    );
    // The chart symbol is not searched for.
    expect(calls(win, 'TradingViewApi.searchSymbols')).toEqual([]);
  });

  test('another symbol is checked with the symbol search and sent as EXCHANGE:TICKER', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'alert_create', {
      symbol: 'nasdaq:msft',
      condition: 'crossing_up',
      price: 200,
    });

    expect(dataOf(result)).toMatchObject({
      symbol: 'NASDAQ:MSFT',
      condition: 'crossing_up',
      price: 200,
    });
    expect(calls(win, 'TradingViewApi.searchSymbols')).toEqual([
      [{ text: 'msft', serverHighlight: false }],
    ]);
    expect(sentPayloads(win)[0]).toMatchObject({
      symbol: 'NASDAQ:MSFT',
      message: 'MSFT crossing up 200',
      resolution: '1D',
      conditions: [
        { type: 'cross_up', series: [{ type: 'barset' }, { type: 'value', value: 200 }] },
      ],
    });
  });

  test('an unknown symbol is INVALID_INPUT, and nothing is listed or sent', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'alert_create', {
      symbol: 'NASDAQ:ZZZZ',
      condition: 'crossing',
      price: 1,
    });

    expect(errorOf(result)).toMatchObject({
      code: 'INVALID_INPUT',
      message: 'The symbol search of TradingView found no NASDAQ:ZZZZ',
      hint: expect.stringContaining('data_search_symbols') as string,
      details: { symbol: 'NASDAQ:ZZZZ' },
    });
    expect(calls(win, 'alertsRestApi.listAlerts')).toEqual([]);
    expect(sentPayloads(win)).toEqual([]);
  });

  test('a ticker without its exchange that is not the chart symbol is INVALID_INPUT, before any search', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'alert_create', {
      symbol: 'MSFT',
      condition: 'crossing',
      price: 1,
    });

    expect(errorOf(result)).toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('EXCHANGE:TICKER') as string,
      details: { symbol: 'MSFT' },
    });
    expect(calls(win, 'TradingViewApi.searchSymbols')).toEqual([]);
    expect(sentPayloads(win)).toEqual([]);
  });

  test('a blank symbol or message is INVALID_INPUT before TradingView is asked anything', async () => {
    const { client, win } = await startHarness();

    for (const change of [{ symbol: '   ' }, { message: ' \n ' }]) {
      const result = await callTool(client, 'alert_create', {
        condition: 'crossing',
        price: 1,
        ...change,
      });

      expect(errorOf(result), JSON.stringify(change)).toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('a message is sent as written', async () => {
    const { client, win } = await startHarness();

    await callTool(client, 'alert_create', {
      condition: 'less_than',
      price: 90,
      message: ' Buy the dip? Check the news first. ',
    });

    expect(sentPayloads(win)[0]).toMatchObject({
      message: ' Buy the dip? Check the news first. ',
      conditions: [{ type: 'less' }],
    });
  });

  test('an expiration in the past is INVALID_INPUT', async () => {
    const { client, win } = await startHarness();

    for (const expiration of ['2026-10-21T00:00:00Z', NOW, (NOW - 60) * 1000]) {
      const result = await callTool(client, 'alert_create', {
        condition: 'crossing',
        price: 150,
        expiration,
      });

      expect(errorOf(result), String(expiration)).toMatchObject({
        code: 'INVALID_INPUT',
        message: expect.stringContaining('is not in the future') as string,
      });
    }
    // Checked before the limit and before anything is sent.
    expect(calls(win, 'alertsRestApi.listAlerts')).toEqual([]);
    expect(sentPayloads(win)).toEqual([]);
  });

  test('an expiration beyond the longest the plan allows is INVALID_INPUT naming the maximum', async () => {
    const { client: freeClient, win: free } = await startHarness();
    const { client: proClient, win: pro } = await startHarness(fixture, {
      alerts: { product: 'pro' },
    });

    const outcomes = [
      await callTool(freeClient, 'alert_create', {
        condition: 'crossing',
        price: 150,
        expiration: isoOf(NOW + 31 * DAY),
      }),
      await callTool(proClient, 'alert_create', {
        condition: 'crossing',
        price: 150,
        expiration: isoOf(NOW + 61 * DAY),
      }),
      await callTool(proClient, 'alert_create', {
        condition: 'crossing',
        price: 150,
        expiration: isoOf(NOW + 45 * DAY),
      }),
    ];

    expect(errorOf(outcomes[0] ?? {})).toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('more than 30 days away') as string,
      details: { maximum: '30 days', latest: NOW + 30 * DAY },
    });
    expect(errorOf(outcomes[1] ?? {})).toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('more than 60 days away') as string,
      details: { maximum: '60 days' },
    });
    expect(dataOf(outcomes[2] ?? {})).toMatchObject({
      expiration: NOW + 45 * DAY,
      expirationIso: isoOf(NOW + 45 * DAY),
    });
    expect(sentPayloads(free)).toEqual([]);
    expect(sentPayloads(pro)).toHaveLength(1);
  });

  test('without an expiration the alert expires after the default of TradingView, 30 days without the alert config', async () => {
    const { client: proClient, win: pro } = await startHarness(fixture, {
      alerts: { product: 'pro' },
    });
    const { client: bareClient, win: bare } = await startHarness(fixture, {
      alerts: { product: 'pro', withoutConfig: true },
    });

    const proResult = await callTool(proClient, 'alert_create', {
      condition: 'crossing',
      price: 150,
    });
    const bareResult = await callTool(bareClient, 'alert_create', {
      condition: 'crossing',
      price: 150,
    });

    // One month on another product than the free one.
    expect(dataOf(proResult)).toMatchObject({
      expiration: Date.UTC(2026, 10, 22, 12) / 1000,
      expirationIso: '2026-11-22T12:00:00Z',
    });
    expect(sentPayloads(pro)[0]).toMatchObject({
      expiration_policy: { policy: 'fixed_date', time: '2026-11-22T12:00:00.000Z' },
    });
    expect(dataOf(bareResult)).toMatchObject({ expiration: NOW + 30 * DAY });
    expect(sentPayloads(bare)).toHaveLength(1);
  });

  test('a given expiration is sent as given, whether ISO, seconds or milliseconds', async () => {
    const { client, win } = await startHarness();
    const time = Date.UTC(2026, 10, 1, 8, 30) / 1000;

    for (const expiration of ['2026-11-01T08:30:00Z', time, time * 1000]) {
      const result = await callTool(client, 'alert_create', {
        condition: 'crossing',
        price: 150,
        expiration,
      });

      expect(dataOf(result)).toMatchObject({
        expiration: time,
        expirationIso: '2026-11-01T08:30:00Z',
      });
    }
    expect(sentPayloads(win).map((payload) => payload.expiration_policy)).toEqual(
      Array.from({ length: 3 }, () => ({ policy: 'fixed_date', time: '2026-11-01T08:30:00.000Z' })),
    );
  });

  test('the expiration goes the legacy way when the expiration toggle of the app is off', async () => {
    const { client, win } = await startHarness({ ...fixture, featureToggles: {} });

    await callTool(client, 'alert_create', { condition: 'crossing', price: 150 });

    const { expiration_policy: policy, ...rest } = chartPayload('');
    expect(policy).toBeDefined();
    expect(sentPayloads(win)).toEqual([{ ...rest, expiration: '2026-11-21T12:00:00.000Z' }]);
    expect(calls(win, 'alerts.convertEditableAlertState')[0]?.[1]).toBe(true);
  });

  test('a chart on seconds needs a plan that allows alerts on seconds', async () => {
    const onSeconds = { ...fixture, resolution: '5S' };
    const { client: refusedClient, win: refused } = await startHarness(onSeconds);
    const { client: allowedClient, win: allowed } = await startHarness({
      ...onSeconds,
      planConfigs: { ...fixture.planConfigs, ALERTS_ON_SECONDS: {} },
    });

    const refusal = await callTool(refusedClient, 'alert_create', {
      condition: 'crossing',
      price: 150,
    });
    const created = await callTool(allowedClient, 'alert_create', {
      condition: 'crossing',
      price: 150,
    });

    expect(errorOf(refusal)).toMatchObject({
      code: 'PLAN_LIMIT',
      message: expect.stringContaining('5S') as string,
      hint: expect.stringContaining('chart_set_timeframe') as string,
      details: { feature: 'ALERTS_ON_SECONDS' },
    });
    expect(sentPayloads(refused)).toEqual([]);
    expect(dataOf(created)).toMatchObject({ id: '9001' });
    expect(sentPayloads(allowed)[0]).toMatchObject({
      resolution: '5S',
      conditions: [{ resolution: '5S' }],
    });
  });

  test('a chart on seconds is refused when the plan cannot say whether it allows alerts on seconds', async () => {
    const win = createFakeTvWindow({ ...fixture, resolution: '5S' });
    delete moduleWith(win, 'getConfig').enabled;
    const { client } = await startHarnessWith(win);

    const result = await callTool(client, 'alert_create', { condition: 'crossing', price: 150 });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      details: { feature: 'ALERTS_ON_SECONDS' },
    });
    expect(sentPayloads(win)).toEqual([]);
  });

  test('a chart on range bars sends the resolution 1, as the app does', async () => {
    const { client, win } = await startHarness({ ...fixture, resolution: '10R' });

    await callTool(client, 'alert_create', { condition: 'crossing', price: 150 });

    expect(sentPayloads(win)[0]).toMatchObject({
      resolution: '1',
      conditions: [{ resolution: '1' }],
    });
  });

  test('alert_create refuses NOT_AVAILABLE when the chart does not give its symbol the way an alert takes it', async () => {
    const win = createFakeTvWindow(fixture);
    delete chartOf(win)._chartWidget.model().mainSeries().getAlertSymbolString;
    const { client } = await startHarnessWith(win);

    const result = await callTool(client, 'alert_create', { condition: 'crossing', price: 150 });
    const byTicker = await callTool(client, 'alert_create', {
      symbol: 'AAPL',
      condition: 'crossing',
      price: 150,
    });
    const other = await callTool(client, 'alert_create', {
      symbol: 'NYSE:IBM',
      condition: 'crossing',
      price: 150,
    });
    const chartByName = await callTool(client, 'alert_create', {
      symbol: 'NASDAQ:AAPL',
      condition: 'crossing',
      price: 150,
    });

    for (const refusal of [result, byTicker]) {
      expect(errorOf(refusal)).toMatchObject({
        code: 'NOT_AVAILABLE',
        hint: expect.stringContaining('EXCHANGE:TICKER') as string,
      });
    }
    // Another symbol needs nothing of the chart but its resolution, and so does the chart symbol
    // given as EXCHANGE:TICKER, as the hint says.
    expect(dataOf(other)).toMatchObject({ symbol: 'NYSE:IBM' });
    expect(dataOf(chartByName)).toMatchObject({ symbol: 'NASDAQ:AAPL' });
    expect(sentPayloads(win).map(({ symbol }) => symbol)).toEqual(['NYSE:IBM', 'NASDAQ:AAPL']);
  });

  test('alert_create refuses NOT_AVAILABLE when the chart does not report its resolution', async () => {
    const win = createFakeTvWindow(fixture);
    Object.assign(chartOf(win), { resolution: () => null });
    const { client } = await startHarnessWith(win);

    const result = await callTool(client, 'alert_create', { condition: 'crossing', price: 150 });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: 'The chart does not report its timeframe, which the alert would watch',
    });
    expect(sentPayloads(win)).toEqual([]);
  });

  test('alert_create times out without recording the alert, and says how to find it', async () => {
    const win = createFakeTvWindow(fixture);
    restApiOf(win).createAlert = () => new Promise(() => undefined);
    const { client, session } = await startHarnessWith(win, { callTimeoutMs: 1500 });

    const result = await callTool(client, 'alert_create', { condition: 'crossing', price: 150 });

    expect(errorOf(result)).toMatchObject({
      code: 'TIMEOUT',
      hint: expect.stringMatching(/alert_list.*confirm: true/) as string,
    });
    expect(session.createdAlertIds.size).toBe(0);
  });
});

describe('alert_list', () => {
  test('alert_list reports every alert in the terms of the tools', async () => {
    const { client } = await startHarness(
      withAlerts([
        { id: 1, price: 150.5, message: 'Breakout', expiration: '2026-11-21T12:00:00.000Z' },
        { id: 2, symbol: 'NYSE:IBM', condition: 'cross_up', active: false, lastStopReason: 'auto' },
        { id: 3, condition: 'cross_down', active: false, expiration: null },
        { id: 4, condition: 'greater', active: false, lastStopReason: 'expired' },
        {
          id: 5,
          condition: 'less',
          legacyExpiration: true,
          expiration: '2026-12-01T00:00:00.000Z',
        },
        { id: 6, condition: 'channel_in', price: null, legacyExpiration: true, expiration: null },
      ]),
    );

    const result = await callTool(client, 'alert_list');

    expect(envelopeOf(result).meta).toMatchObject({ via: 'internal', warnings: [] });
    expect(alertsOf(result)).toEqual([
      {
        id: '1',
        symbol: 'NASDAQ:AAPL',
        kind: 'price',
        condition: 'crossing',
        price: 150.5,
        indicator: null,
        value: null,
        message: 'Breakout',
        status: 'active',
        expiration: NOW + 30 * DAY,
        expirationIso: '2026-11-21T12:00:00Z',
        createdByServer: false,
      },
      {
        id: '2',
        symbol: 'NYSE:IBM',
        kind: 'price',
        condition: 'crossing_up',
        price: 100,
        indicator: null,
        value: null,
        message: 'Synthetic alert 2',
        status: 'triggered',
        expiration: Date.UTC(2030, 0, 1) / 1000,
        expirationIso: '2030-01-01T00:00:00Z',
        createdByServer: false,
      },
      expect.objectContaining({
        id: '3',
        condition: 'crossing_down',
        status: 'stopped',
        expiration: null,
        expirationIso: null,
      }),
      expect.objectContaining({ id: '4', condition: 'greater_than', status: 'stopped' }),
      expect.objectContaining({
        id: '5',
        condition: 'less_than',
        status: 'active',
        expiration: Date.UTC(2026, 11, 1) / 1000,
        expirationIso: '2026-12-01T00:00:00Z',
      }),
      // The price compared with an indicator: a price alert all the same.
      expect.objectContaining({
        id: '6',
        kind: 'price',
        condition: 'channel_in',
        price: null,
        indicator: 'RSI@tv-basicstudies',
        value: null,
        expiration: null,
      }),
    ]);
  });

  test('alert_list reports an indicator alert as such', async () => {
    // The condition compares an indicator, not the bars of the chart, with a value.
    const indicatorCondition = (type: string, value: number) => ({
      type,
      frequency: 'on_first_fire',
      series: [
        { type: 'study', study: 'RSI@tv-basicstudies', plot_id: 'plot_0' },
        { type: 'value', value },
      ],
      resolution: '1D',
    });
    const { client } = await startHarness(
      withAlerts([
        { id: 1, price: 150 },
        { id: 2, raw: { type: 'indicator', conditions: [indicatorCondition('cross_up', 70)] } },
        // A study series that does not say which indicator it is.
        {
          id: 3,
          raw: {
            type: 'indicator',
            conditions: [
              { type: 'less', series: [{ type: 'study' }, { type: 'value', value: 30 }] },
            ],
          },
        },
      ]),
    );

    const result = await callTool(client, 'alert_list');

    expect(alertsOf(result)).toEqual([
      expect.objectContaining({
        id: '1',
        kind: 'price',
        condition: 'crossing',
        price: 150,
        indicator: null,
        value: null,
      }),
      {
        id: '2',
        symbol: 'NASDAQ:AAPL',
        kind: 'indicator',
        condition: 'crossing_up',
        // Not a price: the level the indicator is compared with.
        price: null,
        indicator: 'RSI@tv-basicstudies',
        value: 70,
        message: 'Synthetic alert 2',
        status: 'active',
        expiration: Date.UTC(2030, 0, 1) / 1000,
        expirationIso: '2030-01-01T00:00:00Z',
        createdByServer: false,
      },
      expect.objectContaining({
        id: '3',
        kind: 'indicator',
        condition: 'less_than',
        price: null,
        indicator: null,
        value: 30,
      }),
    ]);
  });

  test('alert_list filters by status', async () => {
    const { client } = await startHarness(
      withAlerts([
        { id: 1 },
        { id: 2, active: false, lastStopReason: 'auto' },
        { id: 3, active: false },
        { id: 4 },
      ]),
    );
    const idsFor = async (status: string) =>
      alertsOf(await callTool(client, 'alert_list', { status })).map(({ id }) => id);

    expect(await idsFor('active')).toEqual(['1', '4']);
    expect(await idsFor('triggered')).toEqual(['2']);
    expect(await idsFor('stopped')).toEqual(['3']);
    expect(await idsFor('all')).toEqual(['1', '2', '3', '4']);
    expect(alertsOf(await callTool(client, 'alert_list')).map(({ id }) => id)).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
  });

  test('alert_list leaves out an alert it cannot read, and says so', async () => {
    const { client } = await startHarness(
      withAlerts([{ id: 1 }, { id: 2, raw: { alert_id: 'not a number' } }]),
    );

    const result = await callTool(client, 'alert_list');

    expect(alertsOf(result).map(({ id }) => id)).toEqual(['1']);
    expect(warningsOf(result)).toEqual([
      'TradingView listed 1 alert that could not be read, so it is left out.',
    ]);
  });

  test('alert_list signed out is AUTH_REQUIRED, and a refusal of TradingView PAGE_EVALUATION_FAILED with its code', async () => {
    const signedOut = createFakeTvWindow(fixture);
    inspectFakeWindow(signedOut).state.pineEditor.signedIn = false;
    const refusing = createFakeTvWindow(fixture);
    inspectFakeWindow(refusing).state.alerts.errors.listAlerts = {
      code: 'maintenance',
      message: 'Maintenance',
    };
    const { client: signedOutClient } = await startHarnessWith(signedOut);
    const { client: refusingClient } = await startHarnessWith(refusing);

    expect(errorOf(await callTool(signedOutClient, 'alert_list'))).toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    expect(errorOf(await callTool(refusingClient, 'alert_list'))).toMatchObject({
      code: 'PAGE_EVALUATION_FAILED',
      message: 'TradingView did not list the alerts: Maintenance (maintenance)',
      details: { code: 'maintenance' },
    });
    expectNothingElseTouched(signedOut);
  });
});

describe('alert_delete', () => {
  test('alert_delete of an alert this session did not create requires confirm', async () => {
    const { client, win, session } = await startHarness(withAlerts([{ id: 1 }, { id: 2 }]));

    const refused = await callTool(client, 'alert_delete', { alertIds: ['1'] });

    expect(refused.isError).toBe(true);
    expect(errorOf(refused)).toEqual({
      code: 'CONFIRMATION_REQUIRED',
      message: 'Deleting the alert 1 needs confirmation: this session did not create it',
      hint:
        "The alert was in the account before, so it is the user's. Make sure the user wants it " +
        'gone, then call alert_delete again with confirm: true.',
      details: { ids: ['1'] },
    });
    expect(calls(win, 'alertsRestApi.deleteAlerts')).toEqual([]);
    expect(idsOn(win)).toEqual([1, 2]);

    const confirmed = await callTool(client, 'alert_delete', { alertIds: ['1'], confirm: true });

    expect(envelopeOf(confirmed)).toStrictEqual({
      ok: true,
      data: { deleted: ['1'] },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(calls(win, 'alertsRestApi.deleteAlerts')).toEqual([[{ alert_ids: [1] }]]);
    expect(idsOn(win)).toEqual([2]);
    expect(session.createdAlertIds.size).toBe(0);
    expectNothingElseTouched(win);
  });

  test('alert_delete with ids the account does not have is INVALID_INPUT listing them', async () => {
    const { client, win } = await startHarness(withAlerts([{ id: 1 }, { id: 2 }]));

    const result = await callTool(client, 'alert_delete', {
      alertIds: ['1', '77', '88'],
      confirm: true,
    });

    expect(errorOf(result)).toEqual({
      code: 'INVALID_INPUT',
      message: 'The account has no alerts 77 and 88',
      hint: 'Call alert_list for the ids of the alerts of the account. Nothing was deleted.',
      details: { unknown: ['77', '88'] },
    });
    expect(errorOf(await callTool(client, 'alert_delete', { alertIds: ['5'] }))).toMatchObject({
      message: 'The account has no alert 5',
      details: { unknown: ['5'] },
    });
    expect(calls(win, 'alertsRestApi.deleteAlerts')).toEqual([]);
    expect(idsOn(win)).toEqual([1, 2]);
  });

  test('alert_delete deletes the alerts this session created without confirm', async () => {
    const { client, win, session } = await startHarness(withAlerts([{ id: 1 }]));
    await callTool(client, 'alert_create', { condition: 'crossing', price: 150 });
    await callTool(client, 'alert_create', { condition: 'crossing', price: 160 });

    const result = await callTool(client, 'alert_delete', { alertIds: ['9002', '9001'] });

    expect(dataOf(result)).toEqual({ deleted: ['9002', '9001'] });
    expect(idsOn(win)).toEqual([1]);
    expect(session.createdAlertIds.size).toBe(0);
  });

  test('alert_delete asks to confirm only the alerts the session did not create, and deletes none of them', async () => {
    const { client, win } = await startHarness(withAlerts([{ id: 1 }, { id: 2 }]));
    await callTool(client, 'alert_create', { condition: 'crossing', price: 150 });

    const result = await callTool(client, 'alert_delete', { alertIds: ['9001', '2', '1'] });

    expect(errorOf(result)).toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      message: 'Deleting the alerts 2 and 1 needs confirmation: this session did not create them',
      details: { ids: ['2', '1'] },
    });
    expect(idsOn(win)).toEqual([1, 2, 9001]);
  });

  test('alert_delete deletes each id once', async () => {
    const { client, win } = await startHarness(withAlerts([{ id: 1 }, { id: 2 }]));

    const result = await callTool(client, 'alert_delete', {
      alertIds: ['2', '2', '1'],
      confirm: true,
    });

    expect(dataOf(result)).toEqual({ deleted: ['2', '1'] });
    expect(calls(win, 'alertsRestApi.deleteAlerts')).toEqual([[{ alert_ids: [2, 1] }]]);
  });

  test('alert_delete reports the alerts TradingView kept', async () => {
    const win = createFakeTvWindow(withAlerts([{ id: 1 }, { id: 2 }, { id: 3 }]));
    const api = restApiOf(win);
    const remove = api.deleteAlerts.bind(api);
    api.deleteAlerts = (payload) => remove({ alert_ids: payload.alert_ids.slice(0, 1) });
    const { client } = await startHarnessWith(win);

    const result = await callTool(client, 'alert_delete', {
      alertIds: ['1', '2', '3'],
      confirm: true,
    });

    expect(dataOf(result)).toEqual({ deleted: ['1'] });
    expect(warningsOf(result)).toEqual([
      'TradingView still lists 2 of the alerts after the deletion: 2 and 3. alert_list shows ' +
        'what is left.',
    ]);
  });

  test('alert_delete fails NOT_AVAILABLE, and keeps the session ids, when TradingView deleted none of them', async () => {
    const { client, win, session } = await startHarness();
    await callTool(client, 'alert_create', { condition: 'crossing', price: 150 });
    await callTool(client, 'alert_create', { condition: 'crossing', price: 160 });
    inspectFakeWindow(win).state.alerts.deleteIgnored = true;

    const one = await callTool(client, 'alert_delete', { alertIds: ['9001'] });
    const two = await callTool(client, 'alert_delete', { alertIds: ['9001', '9002'] });

    expect(errorOf(one)).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: 'TradingView did not delete the alert 9001',
      details: { ids: ['9001'] },
    });
    expect(errorOf(two)).toMatchObject({
      message: 'TradingView did not delete the alerts 9001 and 9002',
      details: { ids: ['9001', '9002'] },
    });
    expect(session.createdAlertIds).toEqual(new Set(['9001', '9002']));
  });

  test('alert_delete fails NOT_AVAILABLE, and keeps the session ids, when the deletion cannot be confirmed', async () => {
    const { client, win, session } = await startHarness();
    for (const price of [150, 160, 170]) {
      await callTool(client, 'alert_create', { condition: 'crossing', price });
    }
    // Every list after a deletion fails on the way.
    const api = restApiOf(win);
    const list = api.listAlerts.bind(api);
    let lists = 0;
    api.listAlerts = (...args: unknown[]) => {
      lists += 1;
      return lists % 2 === 0 ? Promise.reject(new Error('Fetch Failed')) : list(...args);
    };

    const one = await callTool(client, 'alert_delete', { alertIds: ['9001'] });
    const two = await callTool(client, 'alert_delete', { alertIds: ['9002', '9003'] });

    expect(errorOf(one)).toMatchObject({
      code: 'NOT_AVAILABLE',
      message:
        'TradingView accepted the deletion of 1 alert, but the alerts could not be listed ' +
        'afterwards to confirm it',
      hint: 'Check alert_list.',
      details: { ids: ['9001'] },
    });
    expect(errorOf(two)).toMatchObject({
      message: expect.stringContaining('the deletion of 2 alerts') as string,
      details: { ids: ['9002', '9003'] },
    });
    expect(idsOn(win)).toEqual([]);
    expect(session.createdAlertIds).toEqual(new Set(['9001', '9002', '9003']));
  });

  test('alert_delete relays a refusal of TradingView, and nothing is deleted', async () => {
    const win = createFakeTvWindow(withAlerts([{ id: 1 }]));
    inspectFakeWindow(win).state.alerts.errors.deleteAlerts = {
      code: 'general',
      message: 'Synthetic failure',
    };
    const { client } = await startHarnessWith(win);

    const result = await callTool(client, 'alert_delete', { alertIds: ['1'], confirm: true });

    expect(errorOf(result)).toMatchObject({
      code: 'PAGE_EVALUATION_FAILED',
      message: 'TradingView did not delete the alerts: Synthetic failure (general)',
      details: { code: 'general' },
    });
    expect(idsOn(win)).toEqual([1]);
  });

  test('alert_delete has no input that deletes every alert', async () => {
    const { client, win } = await startHarness(withAlerts([{ id: 1 }, { id: 2 }]));

    // The MCP server refuses each of them against the input schema, before the tool runs.
    for (const args of [{ all: true, confirm: true }, { alertIds: [], confirm: true }, {}]) {
      const result = await callTool(client, 'alert_delete', args);

      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(textOf(result)).toContain('alertIds');
    }
    expect(inspectFakeWindow(win).calls).toEqual([]);
    expect(idsOn(win)).toEqual([1, 2]);
  });
});
