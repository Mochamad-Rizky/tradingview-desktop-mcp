import { loadTvFixture, type TvStateFixture } from '../../helpers/fake-tv/fixture.js';
import type { FakeWebpackRequire } from '../../helpers/fake-tv/webpack.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTvOverrides,
  type FakeTvWindow,
} from '../../helpers/fake-tv/window.js';

// The alerts of the fake account and the alert modules of the fake app (alerts.ts), checked against
// what the reverse-engineering notes of Plan 3 (section 2) and the web build record for the app.
// Values are synthetic.

const fixture = loadTvFixture();
const CHART_ALERT_SYMBOL = '={"adjustment":"splits","currency-id":"USD","symbol":"NASDAQ:AAPL"}';

interface RestApi {
  listAlerts(signal?: unknown, initiator?: string): Promise<Record<string, unknown>[]>;
  createAlert(payload: unknown): Promise<Record<string, unknown>>;
  deleteAlerts(payload: unknown): Promise<unknown>;
  stopAlerts(payload: unknown): Promise<unknown>;
}

type Converter = (state: unknown, sendLegacyExpiration?: boolean) => Record<string, unknown>;

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

function apiOf(win: FakeTvWindow): RestApi {
  return (exportsOf(win).getAlertsRestApi as () => RestApi)();
}

function converterOf(win: FakeTvWindow): Converter {
  return exportsOf(win).convertEditableAlertState as Converter;
}

function windowWith(from: TvStateFixture = fixture, overrides: FakeTvOverrides = {}): FakeTvWindow {
  return createFakeTvWindow(from, overrides);
}

// What a promise rejected with, as a plain object of the members page code reads.
async function rejectionOf(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    const { name, code, message } = error as Record<string, unknown>;
    return { name, code, message };
  }
  throw new Error('Expected the promise to reject');
}

// The editable state of a price alert, the camelCase state the alert dialog keeps, with the input
// the research ran the converter of the app on.
function editableState(change: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conditions: [
      {
        type: 'cross',
        frequency: 'on_first_fire',
        series: [{ type: 'barset' }, { type: 'value', value: 100.5 }],
        resolution: '1D',
      },
    ],
    symbol: '={"adjustment":"splits","currency-id":"USD","symbol":"EXAMPLE:TEST"}',
    resolution: '1D',
    message: 'synthetic',
    soundFile: null,
    soundDuration: 0,
    popup: true,
    autoDeactivate: true,
    email: false,
    smsOverEmail: false,
    mobilePush: false,
    webhook: null,
    name: null,
    notificationSchedule: null,
    expirationPolicy: { policy: 'fixed_date', time: new Date('2030-01-01T00:00:00.000Z') },
    ...change,
  };
}

// What the converter of the app returned for that input (notes of Plan 3, section 2.3).
const CONVERTED = {
  conditions: [
    {
      type: 'cross',
      frequency: 'on_first_fire',
      series: [{ type: 'barset' }, { type: 'value', value: 100.5 }],
      resolution: '1D',
    },
  ],
  symbol: '={"adjustment":"splits","currency-id":"USD","symbol":"EXAMPLE:TEST"}',
  resolution: '1D',
  message: 'synthetic',
  sound_file: null,
  sound_duration: 0,
  popup: true,
  auto_deactivate: true,
  email: false,
  sms_over_email: false,
  mobile_push: false,
  web_hook: null,
  name: null,
  expiration_policy: { policy: 'fixed_date', time: '2030-01-01T00:00:00.000Z' },
};

// A payload as the alerts service of the app sends it: the converted state, active and
// ignore_warnings.
function payload(change: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...CONVERTED,
    symbol: CHART_ALERT_SYMBOL,
    active: true,
    ignore_warnings: true,
    ...change,
  };
}

describe('the alerts REST client', () => {
  test('listAlerts lists the alerts of the fixture as the server records them', async () => {
    const win = windowWith({
      ...fixture,
      alerts: [
        { id: 11, price: 150.5, message: 'Breakout' },
        {
          id: 12,
          symbol: 'NYSE:IBM',
          condition: 'greater',
          active: false,
          lastStopReason: 'auto',
          expiration: null,
        },
      ],
    });

    const listed = await apiOf(win).listAlerts();

    expect(listed).toEqual([
      {
        alert_id: 11,
        symbol: CHART_ALERT_SYMBOL,
        pro_symbol: CHART_ALERT_SYMBOL,
        type: 'price',
        kinds: ['regular'],
        active: true,
        last_stop_reason: null,
        last_error: null,
        create_time: '2024-10-01T00:00:00.000Z',
        last_fire_time: null,
        last_fire_bar_time: null,
        expiration_policy: { policy: 'fixed_date', time: '2030-01-01T00:00:00.000Z' },
        resolution: '1D',
        cross_interval: false,
        complexity: 'primitive',
        conditions: [
          {
            type: 'cross',
            frequency: 'on_first_fire',
            series: [{ type: 'barset' }, { type: 'value', value: 150.5 }],
            resolution: '1D',
          },
        ],
        message: 'Breakout',
        name: null,
        sound_file: null,
        sound_duration: 0,
        popup: true,
        auto_deactivate: true,
        email: false,
        sms_over_email: false,
        mobile_push: false,
        web_hook: null,
      },
      expect.objectContaining({
        alert_id: 12,
        symbol: 'NYSE:IBM',
        active: false,
        last_stop_reason: 'auto',
        expiration_policy: { policy: 'never' },
        conditions: [expect.objectContaining({ type: 'greater' })],
        message: 'Synthetic alert 12',
      }),
    ]);
    // A copy each time: changing an answer changes nothing on the server.
    listed.pop();
    expect(await apiOf(win).listAlerts()).toHaveLength(2);
    expect(inspectFakeWindow(win).callsTo('alertsRestApi.listAlerts')).toHaveLength(2);
  });

  test('a fixture alert can be stopped by hand, watch an indicator, keep the legacy expiration or carry raw fields', async () => {
    const win = windowWith({
      ...fixture,
      alerts: [
        { id: 21, active: false },
        { id: 22, price: null, complexity: 'complex', kinds: ['regular'] },
        { id: 23, legacyExpiration: true, expiration: '2030-02-01T00:00:00.000Z' },
        { id: 24, legacyExpiration: true, expiration: null },
        { id: 25, raw: { alert_id: 'not a number', message: 'raw' } },
      ],
    });

    const listed = await apiOf(win).listAlerts();

    expect(listed[0]).toMatchObject({ active: false, last_stop_reason: 'manual' });
    expect(listed[1]).toMatchObject({
      type: 'indicator',
      complexity: 'complex',
      conditions: [{ series: [{ type: 'barset' }, { type: 'study' }] }],
    });
    expect(listed[2]).toMatchObject({ expiration: '2030-02-01T00:00:00.000Z' });
    expect(listed[2]).not.toHaveProperty('expiration_policy');
    expect(listed[3]).toMatchObject({ expiration: null });
    expect(listed[4]).toMatchObject({ alert_id: 'not a number', message: 'raw' });
  });

  test('getAlertsRestApi is a call-once factory: every call answers the same client', () => {
    const win = windowWith();
    const factory = exportsOf(win).getAlertsRestApi as () => RestApi;

    expect(factory()).toBe(factory());
  });

  test('createAlert stores the alert as sent, answers its record with a new id, and listAlerts then lists it', async () => {
    const win = windowWith({ ...fixture, alerts: [{ id: 9005 }] });
    const api = apiOf(win);

    const created = await api.createAlert(payload());

    expect(created).toMatchObject({
      alert_id: 9006,
      symbol: CHART_ALERT_SYMBOL,
      pro_symbol: CHART_ALERT_SYMBOL,
      type: 'price',
      kinds: ['regular'],
      active: true,
      last_stop_reason: null,
      complexity: 'primitive',
      conditions: CONVERTED.conditions,
      message: 'synthetic',
      expiration_policy: CONVERTED.expiration_policy,
      auto_deactivate: true,
      popup: true,
    });
    expect(created).not.toHaveProperty('ignore_warnings');
    expect(typeof created.create_time).toBe('string');
    expect((await api.listAlerts()).map(({ alert_id: id }) => id)).toEqual([9005, 9006]);
    expect(inspectFakeWindow(win).callsTo('alertsRestApi.createAlert')).toEqual([[payload()]]);
    // The next alert gets the next id.
    expect((await api.createAlert(payload())).alert_id).toBe(9007);
  });

  test('createAlert refuses a payload the server would not take', async () => {
    const win = windowWith();
    const api = apiOf(win);

    for (const bad of [
      null,
      payload({ conditions: [] }),
      payload({ symbol: '' }),
      payload({ resolution: 1 }),
      payload({ message: undefined }),
      payload({ active: 'yes' }),
      payload({ expiration_policy: undefined }),
    ]) {
      expect(await rejectionOf(api.createAlert(bad))).toEqual({
        name: 'AlertsRestApiError',
        code: 'invalid_request',
        message: 'Invalid request',
      });
    }
    // A legacy expiration stands in for the policy.
    await api.createAlert(payload({ expiration_policy: undefined, expiration: null }));
    expect(inspectFakeWindow(win).state.alerts.list).toHaveLength(1);
  });

  test('createAlert enforces the alert limits of the plan the way the server reports them', async () => {
    // Three active price alerts fill the plan of the fixture; the stopped, complex and watchlist
    // ones do not count against it.
    const full = windowWith({
      ...fixture,
      alerts: [
        { id: 1 },
        { id: 2 },
        { id: 3 },
        { id: 4, active: false },
        { id: 5, complexity: 'complex' },
        { id: 6, kinds: ['watchlist'] },
      ],
    });
    const roomy = windowWith({
      ...fixture,
      alerts: [{ id: 1 }, { id: 2 }, { id: 4, active: false }],
    });
    const overall = windowWith({
      ...fixture,
      alerts: Array.from({ length: 50 }, (_, index) => ({ id: index + 1, active: false })),
    });

    expect(await rejectionOf(apiOf(full).createAlert(payload()))).toMatchObject({
      name: 'AlertsRestApiError',
      code: 'max_primitive_alerts_count_exceeded',
    });
    expect(await rejectionOf(apiOf(overall).createAlert(payload()))).toMatchObject({
      code: 'total_alerts_count_exceeded',
    });
    expect(await apiOf(roomy).createAlert(payload())).toMatchObject({ alert_id: 9001 });
    expect(inspectFakeWindow(full).state.alerts.list).toHaveLength(6);
    expect(inspectFakeWindow(overall).state.alerts.list).toHaveLength(50);
  });

  test('createAlert enforces no limit the plan does not configure', async () => {
    const withoutAlertLimits = windowWith({
      ...fixture,
      planLimits: { INDICATORS_ON_CHART: 2 },
      planConfigs: {},
      alerts: Array.from({ length: 60 }, (_, index) => ({ id: index + 1 })),
    });

    expect(await apiOf(withoutAlertLimits).createAlert(payload())).toMatchObject({
      alert_id: 9001,
    });
  });

  test('deleteAlerts deletes the listed ids and passes over the others, unless the server ignores it', async () => {
    const win = windowWith({ ...fixture, alerts: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    const api = apiOf(win);

    expect(await api.deleteAlerts({ alert_ids: [1, 3, 99] })).toBeUndefined();
    expect((await api.listAlerts()).map(({ alert_id: id }) => id)).toEqual([2]);
    expect(inspectFakeWindow(win).callsTo('alertsRestApi.deleteAlerts')).toEqual([
      [{ alert_ids: [1, 3, 99] }],
    ]);
    expect(await rejectionOf(api.deleteAlerts({ alert_ids: ['2'] }))).toMatchObject({
      code: 'invalid_request',
    });

    inspectFakeWindow(win).state.alerts.deleteIgnored = true;
    await api.deleteAlerts({ alert_ids: [2] });
    expect((await api.listAlerts()).map(({ alert_id: id }) => id)).toEqual([2]);
  });

  test('every call rejects with unauthorized while no account is signed in', async () => {
    const win = windowWith({ ...fixture, alerts: [{ id: 1 }] });
    inspectFakeWindow(win).state.pineEditor.signedIn = false;
    const api = apiOf(win);

    for (const call of [
      api.listAlerts(),
      api.createAlert(payload()),
      api.deleteAlerts({ alert_ids: [1] }),
    ]) {
      expect(await rejectionOf(call)).toEqual({
        name: 'AlertsRestApiError',
        code: 'unauthorized',
        message: 'Unauthorized',
      });
    }
    expect(inspectFakeWindow(win).state.alerts.list).toHaveLength(1);
  });

  test('a call rejects with the error the test stages for its method, and changes nothing', async () => {
    const win = windowWith({ ...fixture, alerts: [{ id: 1 }] });
    const { errors } = inspectFakeWindow(win).state.alerts;
    errors.createAlert = { code: 'total_alerts_count_exceeded', message: 'Synthetic limit text' };
    errors.deleteAlerts = { code: 'general', message: 'Synthetic failure' };
    errors.listAlerts = { code: 'maintenance', message: 'Maintenance' };
    const api = apiOf(win);

    expect(await rejectionOf(api.createAlert(payload()))).toEqual({
      name: 'AlertsRestApiError',
      code: 'total_alerts_count_exceeded',
      message: 'Synthetic limit text',
    });
    expect(await rejectionOf(api.deleteAlerts({ alert_ids: [1] }))).toMatchObject({
      code: 'general',
    });
    expect(await rejectionOf(api.listAlerts())).toMatchObject({ code: 'maintenance' });
    expect(inspectFakeWindow(win).state.alerts.list).toHaveLength(1);
  });

  test('the other methods of the client only record themselves', async () => {
    const win = windowWith();

    await apiOf(win).stopAlerts({ alert_ids: [1] });

    expect(inspectFakeWindow(win).callsTo('alertsRestApi.stopAlerts')).toEqual([
      [{ alert_ids: [1] }],
    ]);
  });
});

describe('the converter of the alert dialog', () => {
  test('converts the editable state of a price alert exactly as the app did for the research', () => {
    const convert = converterOf(windowWith());

    expect(convert(editableState(), false)).toEqual(CONVERTED);
  });

  test('sends the expiration the legacy way when told to, which is its default', () => {
    const convert = converterOf(windowWith());
    const rest = Object.fromEntries(
      Object.entries(CONVERTED).filter(([key]) => key !== 'expiration_policy'),
    );

    expect(convert(editableState(), true)).toEqual({
      ...rest,
      expiration: '2030-01-01T00:00:00.000Z',
    });
    expect(convert(editableState())).toHaveProperty('expiration', '2030-01-01T00:00:00.000Z');
    // Never, the legacy way, is a null expiration.
    expect(convert(editableState({ expirationPolicy: { policy: 'never' } }), true)).toHaveProperty(
      'expiration',
      null,
    );
    expect(convert(editableState({ expirationPolicy: { policy: 'never' } }), false)).toHaveProperty(
      'expiration_policy',
      { policy: 'never' },
    );
  });

  test('sends a range resolution as 1, encodes a symbol object and adds a missing schedule as null', () => {
    const convert = converterOf(windowWith());
    const state = editableState({
      resolution: '10R',
      conditions: [
        {
          type: 'greater',
          frequency: 'on_first_fire',
          series: [{ type: 'barset' }, { type: 'value', value: 1 }],
          resolution: '10r',
        },
      ],
      symbol: { symbol: 'NASDAQ:AAPL', adjustment: 'splits' },
      notificationSchedule: undefined,
    });

    const converted = convert(state, false);

    expect(converted).toMatchObject({
      resolution: '1',
      conditions: [{ type: 'greater', resolution: '1' }],
      symbol: '={"adjustment":"splits","symbol":"NASDAQ:AAPL"}',
      notification_schedule: null,
    });
  });

  test('fails the way the app does on a state it cannot convert', () => {
    const convert = converterOf(windowWith());

    // The time must be a Date.
    expect(() =>
      convert(editableState({ expirationPolicy: { policy: 'fixed_date', time: '2030' } }), false),
    ).toThrow(TypeError);
    // A comparison needs a bar set or a study first, and a value second.
    expect(() =>
      convert(
        editableState({
          conditions: [
            {
              type: 'cross',
              frequency: 'on_first_fire',
              series: [
                { type: 'value', value: 1 },
                { type: 'value', value: 2 },
              ],
              resolution: '1D',
            },
          ],
        }),
        false,
      ),
    ).toThrow(/expected to be one of/);
    expect(() =>
      convert(
        editableState({
          conditions: [
            {
              type: 'cross',
              frequency: 'on_first_fire',
              series: [{ type: 'barset' }, { type: 'barset' }],
              resolution: '1D',
            },
          ],
        }),
        false,
      ),
    ).toThrow(/Assertion/);
  });

  test('records its calls, so that a test can tell the payload came from it', () => {
    const win = windowWith();

    converterOf(win)(editableState(), false);

    const calls = inspectFakeWindow(win).callsTo('alerts.convertEditableAlertState');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toBe(false);
  });
});

describe('the alert config and the plan', () => {
  test('getAlertConfig gives a free account at most 30 days and 30 by default, another product 60 and a month', () => {
    const free = exportsOf(windowWith()).getAlertConfig as () => Record<string, unknown>;
    const pro = exportsOf(windowWith(fixture, { alerts: { product: 'pro' } }))
      .getAlertConfig as () => Record<string, unknown>;

    expect(free()).toMatchObject({
      maxAlertExpiration: { type: 'days', count: 30 },
      defaultAlertExpiration: { type: 'days', count: 30 },
    });
    expect(pro()).toMatchObject({
      maxAlertExpiration: { type: 'days', count: 60 },
      defaultAlertExpiration: { type: 'months', count: 1 },
    });
    expect(free()).toBe(free());
  });

  test('getConfig answers the whole alert configuration of the plan, and enabled() the features the plan configures', () => {
    const exports = exportsOf(windowWith());
    const features = exports.ProductFeatures as Record<string, string>;
    const getConfig = exports.getConfig as (value: string) => unknown;
    const enabled = exports.enabled as (value: string) => boolean;
    const withSeconds = exportsOf(
      windowWith({
        ...fixture,
        planConfigs: { ...fixture.planConfigs, ALERTS_ON_SECONDS: {} },
      }),
    );

    expect(getConfig(features.SERVER_SIDE_ALERTS ?? '')).toEqual({
      limit: 3,
      primitive_limit: 3,
      complex_limit: 0,
      overall_limit: 50,
    });
    expect(enabled(features.SERVER_SIDE_ALERTS ?? '')).toBe(true);
    expect(enabled(features.ALERTS_ON_SECONDS ?? '')).toBe(false);
    expect(enabled('pf:unknown')).toBe(false);
    const secondsFeatures = withSeconds.ProductFeatures as Record<string, string>;
    expect(
      (withSeconds.enabled as (value: string) => boolean)(secondsFeatures.ALERTS_ON_SECONDS ?? ''),
    ).toBe(true);
  });

  test('the feature toggle of the expiration policy is on, as on the app', () => {
    const isFeatureEnabled = exportsOf(windowWith()).isFeatureEnabled as (name: string) => boolean;

    expect(isFeatureEnabled('alerts-on-lollipop')).toBe(true);
  });
});

describe('the alert symbol of the chart', () => {
  test('the main series gives the chart symbol encoded the way an alert takes it, and follows the chart', async () => {
    const win = windowWith(fixture, { feeds: { 'NASDAQ:MSFT': 'BATS:MSFT' } });
    const chart = win.TradingViewApi?.activeChart();
    const series = chart?._chartWidget.model().mainSeries();

    expect(series?.getAlertSymbolString?.()).toBe(CHART_ALERT_SYMBOL);
    await chart?.setSymbol('NASDAQ:MSFT');
    await Promise.resolve();
    // The listing, not the feed the chart shows it by.
    expect(series?.getAlertSymbolString?.()).toBe(
      '={"adjustment":"splits","currency-id":"USD","symbol":"NASDAQ:MSFT"}',
    );
  });
});

describe('the alert modules the tools must never use', () => {
  test('every call of the alerts service, its actions, its error presenter and the chart facade is recorded', async () => {
    const win = windowWith();
    const exports = exportsOf(win);
    const call = (name: string): unknown => (exports[name] as () => unknown)();

    call('getAlertsActions');
    call('getFiresActions');
    call('getAlertsCollection');
    call('getAlertErrorPresenter');
    call('getChartAlertsFacade');
    call('initAlerts');
    call('getAlertsAdminRestApi');
    new (exports.ChartAlertsFacade as new () => unknown)();
    await Promise.resolve();

    expect(inspectFakeWindow(win).calls.map(({ name }) => name)).toEqual([
      'alertsActions.getAlertsActions',
      'alertsActions.getFiresActions',
      'alertsCollection.getAlertsCollection',
      'alertsPresenter.getAlertErrorPresenter',
      'chartAlertsFacade.getChartAlertsFacade',
      'chartAlertsFacade.initAlerts',
      'alertsAdminRestApi.getAlertsAdminRestApi',
      'chartAlertsFacade.ChartAlertsFacade',
    ]);
  });
});

describe('options', () => {
  test('a module can be left out of the cache, as a build without it', () => {
    const exportsWithout = (alerts: NonNullable<FakeTvOverrides['alerts']>) =>
      exportsOf(windowWith(fixture, { alerts }));

    expect(exportsWithout({ withoutRestApi: true })).not.toHaveProperty('getAlertsRestApi');
    expect(exportsWithout({ withoutConverter: true })).not.toHaveProperty(
      'convertEditableAlertState',
    );
    expect(exportsWithout({ withoutConfig: true })).not.toHaveProperty('getAlertConfig');
    expect(exportsWithout({})).toHaveProperty('getAlertsRestApi');
  });
});
