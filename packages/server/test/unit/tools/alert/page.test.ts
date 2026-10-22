import type { CdpSession } from '../../../../src/core/cdp/types.js';
import type { TvMcpError } from '../../../../src/core/errors.js';
import {
  createPageBridge,
  type PageBridge,
  type PageLibFunction,
} from '../../../../src/core/tv/page-bridge.js';
import { createPageLib } from '../../../../src/core/tv/page-lib.js';
import type { TvWindow } from '../../../../src/core/tv/tv-window.js';
import {
  createAlertViaApi,
  deleteAlertsViaApi,
  readAlertContext,
  readAlerts,
  type AlertRequest,
} from '../../../../src/tools/alert/page.js';
import type { JsonValue } from '../../../../src/utils/json.js';
import { failureOf } from '../../../helpers/failure-of.js';
import { createPageRuntime } from '../../../helpers/fake-cdp/runtime.js';
import { loadTvFixture, type TvStateFixture } from '../../../helpers/fake-tv/fixture.js';
import { createFeatureToggleModules } from '../../../helpers/fake-tv/plan-limits.js';
import { createFakeWebpack } from '../../../helpers/fake-tv/webpack.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTvOverrides,
  type FakeTvWindow,
} from '../../../helpers/fake-tv/window.js';

// The page functions of the alert tools, run the way the server runs them, as source text in a page
// through the real page bridge, and called directly on a second window built the same way, which is
// what the coverage of the module measures. The two answers must agree. Values are synthetic.

const fixture = loadTvFixture();
const WAIT_MS = 2000;
const ENCODED = '={"adjustment":"splits","currency-id":"USD","symbol":"NASDAQ:AAPL"}';
// 2030-01-01T00:00:00Z
const EXPIRES = Date.UTC(2030, 0, 1) / 1000;

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
});

function bridgeTo(win: object): PageBridge {
  const runtime = createPageRuntime(win);
  disposers.push(() => {
    runtime.dispose();
  });
  const send = (method: string, params?: unknown): Promise<unknown> =>
    method === 'Runtime.evaluate'
      ? runtime.evaluate(params as Record<string, unknown>)
      : Promise.reject(new Error(`Unexpected command ${method}`));
  const session: CdpSession = {
    targetId: 'PAGE1',
    isClosed: false,
    send: send as CdpSession['send'],
    onClose: () => undefined,
    close: () => Promise.resolve(),
  };
  return createPageBridge(session, { timeoutMs: 5000 });
}

type Make = () => object;

const chart =
  (from: TvStateFixture = fixture, overrides: FakeTvOverrides = {}): Make =>
  () =>
    createFakeTvWindow(from, overrides);

// A fake chart changed by `change` after it is built.
const changed =
  (
    change: (win: FakeTvWindow) => void,
    from: TvStateFixture = fixture,
    overrides: FakeTvOverrides = {},
  ): Make =>
  () => {
    const win = createFakeTvWindow(from, overrides);
    change(win);
    return win;
  };

// A page with the webpack cache `modules` and the members of `page`.
const withModules =
  (modules: Record<string, Record<string, unknown>>, page: Record<string, unknown> = {}): Make =>
  () => ({ webpackChunktradingview: createFakeWebpack(modules), ...page });

async function libResultOf<A extends JsonValue[], R extends JsonValue | null>(
  fn: PageLibFunction<A, R>,
  args: A,
  make: Make,
): Promise<{ result: R; win: object }> {
  const win = make();
  const result = await bridgeTo(win).evaluateWithLib(fn, args);
  const other = make() as TvWindow;
  const direct = await fn(other, createPageLib(other), ...args);
  expect(direct).toEqual(result);
  return { result, win };
}

async function libFailureOfBoth<A extends JsonValue[], R extends JsonValue | null>(
  fn: PageLibFunction<A, R>,
  args: A,
  make: Make,
): Promise<{ error: TvMcpError; win: object }> {
  const win = make();
  const error = await failureOf(bridgeTo(win).evaluateWithLib(fn, args));
  const other = make() as TvWindow;
  expect(await fn(other, createPageLib(other), ...args)).toEqual({
    __tvmcpError: error.toPayload(),
  });
  return { error, win };
}

const calls = (win: object, name: string) => inspectFakeWindow(win).callsTo(name);

// The exports of the default webpack cache of a fake window, by name.
let probes = 0;
function exportsOf(win: FakeTvWindow): Record<string, unknown> {
  let handed: { c: Record<string, { exports: object }> } | undefined;
  probes += 1;
  (win.webpackChunktradingview as { push(chunk: unknown): unknown }).push([
    [`probe${String(probes)}`],
    {},
    (given: typeof handed) => (handed = given),
  ]);
  const found: Record<string, unknown> = {};
  for (const record of Object.values(handed?.c ?? {})) {
    Object.assign(found, record.exports);
  }
  return found;
}

interface RestApi {
  listAlerts: (...args: unknown[]) => Promise<unknown>;
  createAlert: (payload: unknown) => Promise<unknown>;
  deleteAlerts: (payload: unknown) => Promise<unknown>;
}

function restApiOf(win: FakeTvWindow): RestApi {
  return (exportsOf(win).getAlertsRestApi as () => RestApi)();
}

// The module of a fake window whose exports include `name`, to change it in place.
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

function request(change: Partial<AlertRequest> = {}): AlertRequest {
  return {
    symbol: ENCODED,
    resolution: '1D',
    condition: 'cross',
    price: 150,
    message: 'AAPL crossing 150',
    expiresAt: EXPIRES,
    ...change,
  };
}

// The payload the alerts service of the app sends for request().
const PAYLOAD = {
  conditions: [
    {
      type: 'cross',
      frequency: 'on_first_fire',
      series: [{ type: 'barset' }, { type: 'value', value: 150 }],
      resolution: '1D',
    },
  ],
  symbol: ENCODED,
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
  expiration_policy: { policy: 'fixed_date', time: '2030-01-01T00:00:00.000Z' },
  active: true,
  ignore_warnings: true,
};

// A client of the app made of `members`, as the export getAlertsRestApi hands it out.
const clientModule = (members: Record<string, unknown>) => ({
  1: { getAlertsRestApi: () => members },
});

describe('readAlerts', () => {
  test('lists the alerts of the account, each as a row of what the tools read', async () => {
    const { result } = await libResultOf(
      readAlerts,
      [WAIT_MS],
      chart({
        ...fixture,
        alerts: [
          { id: 1, price: 150.5, message: 'Breakout' },
          {
            id: 2,
            symbol: 'NYSE:IBM',
            condition: 'greater',
            active: false,
            lastStopReason: 'auto',
            expiration: null,
          },
          { id: 3, price: null, complexity: 'complex', kinds: ['regular', 'multicondition'] },
          { id: 4, legacyExpiration: true, expiration: '2030-02-01T00:00:00.000Z' },
          { id: 5, legacyExpiration: true, expiration: null },
        ],
      }),
    );

    expect(result).toEqual({
      alerts: [
        {
          id: 1,
          symbol: ENCODED,
          kinds: ['regular'],
          active: true,
          lastStopReason: null,
          complexity: 'primitive',
          condition: 'cross',
          price: 150.5,
          message: 'Breakout',
          expires: '2030-01-01T00:00:00.000Z',
        },
        {
          id: 2,
          symbol: 'NYSE:IBM',
          kinds: ['regular'],
          active: false,
          lastStopReason: 'auto',
          complexity: 'primitive',
          condition: 'greater',
          price: 100,
          message: 'Synthetic alert 2',
          expires: null,
        },
        expect.objectContaining({
          id: 3,
          kinds: ['regular', 'multicondition'],
          complexity: 'complex',
          price: null,
        }),
        expect.objectContaining({ id: 4, expires: '2030-02-01T00:00:00.000Z' }),
        expect.objectContaining({ id: 5, expires: null }),
      ],
      unreadable: 0,
    });
  });

  test('reads only what it knows of a record, and counts an item without an alert id', async () => {
    const odd = [
      null,
      5,
      { alert_id: 'x' },
      { alert_id: Number.POSITIVE_INFINITY },
      {
        alert_id: 9,
        symbol: 7,
        kinds: ['regular', 3],
        active: 'yes',
        last_stop_reason: 1,
        complexity: false,
        conditions: [{ type: 2, series: [{ type: 'barset' }, { type: 'value', value: 'x' }] }],
        message: 4,
        expiration_policy: { policy: 'fixed_date', time: { at: 1 } },
      },
      { alert_id: 10, conditions: 'none', expiration_policy: { policy: 'never' } },
      { alert_id: 11, conditions: [{ series: 'none' }], expiration: 1_900_000_000_000 },
      {
        alert_id: 12,
        conditions: [],
        kinds: 'regular',
        expiration_policy: { policy: 'fixed_date', time: 1_900_000_000 },
      },
    ];
    const { result } = await libResultOf(
      readAlerts,
      [WAIT_MS],
      withModules(clientModule({ listAlerts: () => Promise.resolve(odd) })),
    );

    expect(result).toEqual({
      alerts: [
        {
          id: 9,
          symbol: null,
          kinds: ['regular'],
          active: null,
          lastStopReason: null,
          complexity: null,
          condition: null,
          price: null,
          message: null,
          expires: null,
        },
        expect.objectContaining({ id: 10, condition: null, price: null, expires: null }),
        expect.objectContaining({ id: 11, condition: null, expires: 1_900_000_000_000 }),
        expect.objectContaining({ id: 12, kinds: [], expires: 1_900_000_000 }),
      ],
      unreadable: 4,
    });
  });

  test('a refusal of TradingView comes back with its code and message', async () => {
    const { result, win } = await libResultOf(
      readAlerts,
      [WAIT_MS],
      changed((win) => {
        inspectFakeWindow(win).state.alerts.errors.listAlerts = {
          code: 'maintenance',
          message: 'Maintenance',
        };
      }),
    );

    expect(result).toEqual({ refused: { code: 'maintenance', message: 'Maintenance' } });
    expect(calls(win, 'alertsRestApi.listAlerts')).toEqual([[]]);
  });

  test('a refusal without a code comes back with what it says', async () => {
    const failing = (reason: unknown) =>
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      withModules(clientModule({ listAlerts: () => Promise.reject(reason) }));

    for (const [reason, message] of [
      [new Error('Fetch Failed'), 'Fetch Failed'],
      ['offline', 'offline'],
      [{ code: '', message: 'empty code' }, 'empty code'],
      [{ code: 5 }, '[object Object]'],
    ] as const) {
      const { result } = await libResultOf(readAlerts, [WAIT_MS], failing(reason));

      expect(result).toEqual({ refused: { code: null, message } });
    }
  });

  test('a client that throws instead of rejecting is refused the same way', async () => {
    const { result } = await libResultOf(
      readAlerts,
      [WAIT_MS],
      withModules(
        clientModule({
          listAlerts: () => {
            throw new Error('Synchronous failure');
          },
        }),
      ),
    );

    expect(result).toEqual({ refused: { code: null, message: 'Synchronous failure' } });
  });

  test('an answer that is no list is NOT_AVAILABLE', async () => {
    const { error } = await libFailureOfBoth(
      readAlerts,
      [WAIT_MS],
      withModules(clientModule({ listAlerts: () => Promise.resolve({ alerts: [] }) })),
    );

    expect(error.toPayload()).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: 'TradingView answered with no list of alerts',
    });
  });

  test('a page without the alerts client of the app is CAPABILITY_UNAVAILABLE', async () => {
    for (const make of [
      chart(fixture, { alerts: { withoutRestApi: true } }),
      withModules({
        1: {
          getAlertsRestApi: () => {
            throw new Error('No session');
          },
        },
      }),
      withModules({ 1: { getAlertsRestApi: () => null } }),
      withModules(clientModule({})),
    ]) {
      const { error } = await libFailureOfBoth(readAlerts, [WAIT_MS], make);

      expect(error.toPayload()).toMatchObject({
        code: 'CAPABILITY_UNAVAILABLE',
        message: expect.stringMatching(/^This page has no alerts client of TradingView/) as string,
      });
    }
  });

  test('TIMEOUT when TradingView does not answer within the wait', async () => {
    const { error } = await libFailureOfBoth(
      readAlerts,
      [50],
      withModules(clientModule({ listAlerts: () => new Promise(() => undefined) })),
    );

    expect(error.toPayload()).toEqual({
      code: 'TIMEOUT',
      message: 'TradingView did not list the alerts within 50 ms',
      hint: 'Try again in a moment, or check app_health.',
      details: { waitMs: 50 },
    });
  });
});

describe('readAlertContext', () => {
  test('reads the chart symbol and its names, the alert symbol, the resolution and the expiration bounds', async () => {
    const { result } = await libResultOf(readAlertContext, [], chart());

    expect(result).toEqual({
      symbol: 'NASDAQ:AAPL',
      names: ['NASDAQ:AAPL'],
      alertSymbol: ENCODED,
      resolution: '1D',
      maxExpiration: { type: 'days', count: 30 },
      defaultExpiration: { type: 'days', count: 30 },
    });
  });

  test('reads the bounds of another product, and the names of a symbol the chart shows by its feed', async () => {
    const { result } = await libResultOf(
      readAlertContext,
      [],
      chart(
        { ...fixture, symbol: 'NASDAQ:MSFT' },
        { alerts: { product: 'pro' }, feeds: { 'NASDAQ:MSFT': 'BATS:MSFT' } },
      ),
    );

    expect(result).toMatchObject({
      symbol: 'BATS:MSFT',
      names: ['NASDAQ:MSFT', 'BATS:MSFT'],
      alertSymbol: '={"adjustment":"splits","currency-id":"USD","symbol":"NASDAQ:MSFT"}',
      maxExpiration: { type: 'days', count: 60 },
      defaultExpiration: { type: 'months', count: 1 },
    });
  });

  test('answers null for what the page cannot tell', async () => {
    const withoutAlertSymbol = changed(
      (win) => {
        delete win.TradingViewApi?.activeChart()._chartWidget.model().mainSeries()
          .getAlertSymbolString;
      },
      fixture,
      { alerts: { withoutConfig: true } },
    );
    const throwing = changed((win) => {
      const series = win.TradingViewApi?.activeChart()._chartWidget.model().mainSeries();
      if (series !== undefined) {
        series.getAlertSymbolString = () => {
          throw new Error('Not resolved');
        };
      }
      moduleWith(win, 'getAlertConfig').getAlertConfig = () => {
        throw new Error('No init data');
      };
    });
    const oddConfig = changed((win) => {
      moduleWith(win, 'getAlertConfig').getAlertConfig = () => ({
        maxAlertExpiration: { type: 'days', count: '30' },
        defaultAlertExpiration: null,
      });
    });

    for (const make of [withoutAlertSymbol, throwing]) {
      const { result } = await libResultOf(readAlertContext, [], make);

      expect(result).toMatchObject({
        symbol: 'NASDAQ:AAPL',
        alertSymbol: null,
        maxExpiration: null,
        defaultExpiration: null,
      });
    }
    // Spans that are not { type, count } with a numeric count.
    expect((await libResultOf(readAlertContext, [], oddConfig)).result).toMatchObject({
      alertSymbol: ENCODED,
      maxExpiration: null,
      defaultExpiration: null,
    });
  });

  test('a chart without a series still answers its symbol and resolution', async () => {
    const { result } = await libResultOf(readAlertContext, [], () => ({
      TradingViewApi: { activeChart: () => ({ symbol: () => 'FX:EURUSD', resolution: () => 60 }) },
      webpackChunktradingview: createFakeWebpack({}),
    }));

    expect(result).toEqual({
      symbol: 'FX:EURUSD',
      names: [],
      alertSymbol: null,
      resolution: null,
      maxExpiration: null,
      defaultExpiration: null,
    });
  });

  test('a page without a chart is CAPABILITY_UNAVAILABLE', async () => {
    const { error } = await libFailureOfBoth(
      readAlertContext,
      [],
      chart(fixture, { withoutApi: true }),
    );

    expect(error.toPayload()).toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      message: 'This page has no chart to set an alert on',
    });
  });
});

describe('createAlertViaApi', () => {
  test('builds the payload with the converter of the app, adds active and ignore_warnings, and answers the new id', async () => {
    const { result, win } = await libResultOf(createAlertViaApi, [request(), WAIT_MS], chart());

    expect(result).toEqual({ id: '9001' });
    expect(calls(win, 'alertsRestApi.createAlert')).toEqual([[PAYLOAD]]);
    // The converter of the app built it, told to send expiration_policy.
    const converted = calls(win, 'alerts.convertEditableAlertState');
    expect(converted).toHaveLength(1);
    expect(converted[0]?.[1]).toBe(false);
    expect(inspectFakeWindow(win).state.alerts.list).toHaveLength(1);
  });

  test('sends the legacy expiration when the expiration toggle is off, as the app does', async () => {
    const { win } = await libResultOf(
      createAlertViaApi,
      [request(), WAIT_MS],
      chart({ ...fixture, featureToggles: {} }),
    );

    const sent = calls(win, 'alertsRestApi.createAlert')[0]?.[0] as Record<string, unknown>;
    expect(sent.expiration).toBe('2030-01-01T00:00:00.000Z');
    expect(sent).not.toHaveProperty('expiration_policy');
    expect(calls(win, 'alerts.convertEditableAlertState')[0]?.[1]).toBe(true);
  });

  test('reads the expiration toggle from window.TradingView when the toggle module is missing', async () => {
    const created: unknown[] = [];
    const modules = {
      1: {
        getAlertsRestApi: () => ({
          createAlert: (payload: unknown) => {
            created.push(payload);
            return Promise.resolve({ alert_id: 77 });
          },
        }),
      },
      2: { convertEditableAlertState: (state: unknown, legacy: boolean) => ({ state, legacy }) },
    };

    const { result } = await libResultOf(
      createAlertViaApi,
      [request(), WAIT_MS],
      withModules(modules, { TradingView: { isFeatureEnabled: () => false } }),
    );

    expect(result).toEqual({ id: '77' });
    expect(created[0]).toMatchObject({ legacy: true, active: true, ignore_warnings: true });
  });

  test('refuses NOT_AVAILABLE, and sends nothing, when the expiration toggle cannot be read', async () => {
    const withoutToggles = changed((win) => {
      const toggles = moduleWith(win, 'isFeatureEnabled');
      delete toggles.isFeatureEnabled;
    });
    const oddToggle = changed((win) => {
      moduleWith(win, 'isFeatureEnabled').isFeatureEnabled = () => 'yes';
    });
    const throwingToggle = changed((win) => {
      moduleWith(win, 'isFeatureEnabled').isFeatureEnabled = () => {
        throw new Error('Not ready');
      };
    });

    for (const make of [withoutToggles, oddToggle, throwingToggle]) {
      const { error, win } = await libFailureOfBoth(createAlertViaApi, [request(), WAIT_MS], make);

      expect(error.toPayload()).toMatchObject({
        code: 'NOT_AVAILABLE',
        message:
          'This TradingView build does not say how its alerts send an expiration, so nothing was ' +
          'created',
      });
      expect(calls(win, 'alertsRestApi.createAlert')).toEqual([]);
    }
  });

  test('refuses NOT_AVAILABLE, and sends nothing, without the converter of the app', async () => {
    const { error, win } = await libFailureOfBoth(
      createAlertViaApi,
      [request(), WAIT_MS],
      chart(fixture, { alerts: { withoutConverter: true } }),
    );

    expect(error.toPayload()).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: expect.stringContaining('convertEditableAlertState') as string,
    });
    expect(calls(win, 'alertsRestApi.createAlert')).toEqual([]);
  });

  test('a state the converter refuses is PAGE_EVALUATION_FAILED, and nothing is sent', async () => {
    const { error, win } = await libFailureOfBoth(
      createAlertViaApi,
      [request({ condition: 'channel_in' }), WAIT_MS],
      chart(),
    );

    expect(error.toPayload()).toMatchObject({
      code: 'PAGE_EVALUATION_FAILED',
      message: expect.stringMatching(
        /^The alert converter of TradingView refused the alert: /,
      ) as string,
    });
    expect(calls(win, 'alertsRestApi.createAlert')).toEqual([]);
  });

  test('a page without the alerts client of the app is CAPABILITY_UNAVAILABLE, and nothing is converted', async () => {
    const { error, win } = await libFailureOfBoth(
      createAlertViaApi,
      [request(), WAIT_MS],
      chart(fixture, { alerts: { withoutRestApi: true } }),
    );

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(calls(win, 'alerts.convertEditableAlertState')).toEqual([]);
  });

  test('a refusal of TradingView comes back with its code and message', async () => {
    const { result, win } = await libResultOf(
      createAlertViaApi,
      [request(), WAIT_MS],
      changed((win) => {
        inspectFakeWindow(win).state.alerts.errors.createAlert = {
          code: 'total_alerts_count_exceeded',
          message: 'Synthetic limit text',
        };
      }),
    );

    expect(result).toEqual({
      refused: { code: 'total_alerts_count_exceeded', message: 'Synthetic limit text' },
    });
    expect(inspectFakeWindow(win).state.alerts.list).toEqual([]);
  });

  test('TIMEOUT when TradingView does not answer, with the way to find the alert', async () => {
    const { error } = await libFailureOfBoth(
      createAlertViaApi,
      [request(), 50],
      changed((win) => {
        restApiOf(win).createAlert = () => new Promise(() => undefined);
      }),
    );

    expect(error.toPayload()).toEqual({
      code: 'TIMEOUT',
      message: 'TradingView did not answer the creation of the alert within 50 ms',
      hint:
        'The alert may still appear: check alert_list. This session could not record it, so ' +
        'alert_delete needs confirm: true for it.',
      details: { waitMs: 50 },
    });
  });

  test('an answer without an alert id is PAGE_EVALUATION_FAILED', async () => {
    for (const answer of [undefined, { alert_id: 'x' }, { alert_id: 1.5 }, { alert_id: 0 }]) {
      const { error } = await libFailureOfBoth(
        createAlertViaApi,
        [request(), WAIT_MS],
        changed((win) => {
          restApiOf(win).createAlert = () => Promise.resolve(answer);
        }),
      );

      expect(error.toPayload()).toMatchObject({
        code: 'PAGE_EVALUATION_FAILED',
        message: 'TradingView answered the creation of the alert without an alert id',
        hint: expect.stringContaining('alert_list') as string,
      });
    }
  });

  // A page whose alerts client creates with `create`, whose converter answers what `convert` makes
  // of the state, and whose expiration toggle is on.
  const creating = (
    create: (payload: unknown) => unknown,
    convert: (state: unknown) => unknown = () => ({ converted: true }),
    page: Record<string, unknown> = {},
  ): Make =>
    withModules(
      {
        1: { getAlertsRestApi: () => ({ createAlert: create }) },
        2: { convertEditableAlertState: convert },
        ...createFeatureToggleModules({ 'alerts-on-lollipop': true }),
      },
      page,
    );

  test('a refusal of any shape comes back with what it says', async () => {
    for (const [create, refused] of [
      [rejecting(new Error('Fetch Failed')), { code: null, message: 'Fetch Failed' }],
      [rejecting('offline'), { code: null, message: 'offline' }],
      [rejecting({ code: '', message: 'empty code' }), { code: null, message: 'empty code' }],
      [rejecting({ code: 5 }), { code: null, message: '[object Object]' }],
      [
        () => {
          throw new Error('Synchronous failure');
        },
        { code: null, message: 'Synchronous failure' },
      ],
    ] as const) {
      const { result } = await libResultOf(
        createAlertViaApi,
        [request(), WAIT_MS],
        creating(create),
      );

      expect(result).toEqual({ refused });
    }
  });

  test('a converter that throws something else than an error, or answers no alert, is refused, and nothing is sent', async () => {
    const sent: unknown[] = [];
    const create = (payload: unknown) => {
      sent.push(payload);
      return Promise.resolve({ alert_id: 1 });
    };
    const throwsText = (): never => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'bad state';
    };
    const throwsObject = (): never => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw {};
    };

    for (const [convert, message] of [
      [throwsText, 'The alert converter of TradingView refused the alert: bad state'],
      [throwsObject, 'The alert converter of TradingView refused the alert: [object Object]'],
      [() => undefined, 'The alert converter of TradingView answered with no alert'],
    ] as const) {
      const { error } = await libFailureOfBoth(
        createAlertViaApi,
        [request(), WAIT_MS],
        creating(create, convert),
      );

      expect(error.toPayload()).toEqual({
        code: 'PAGE_EVALUATION_FAILED',
        message,
        hint: 'Nothing was created.',
      });
    }
    expect(sent).toEqual([]);
  });

  test('a client factory that throws is CAPABILITY_UNAVAILABLE', async () => {
    const { error } = await libFailureOfBoth(
      createAlertViaApi,
      [request(), WAIT_MS],
      withModules({
        1: {
          getAlertsRestApi: () => {
            throw new Error('No session');
          },
        },
      }),
    );

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
  });

  test('a window.TradingView that cannot be read leaves the expiration toggle unread', async () => {
    const make = (): object => {
      const page = {
        webpackChunktradingview: createFakeWebpack({
          1: { getAlertsRestApi: () => ({ createAlert: () => Promise.resolve({ alert_id: 1 }) }) },
          2: { convertEditableAlertState: () => ({}) },
        }),
      };
      Object.defineProperty(page, 'TradingView', {
        get() {
          throw new Error('Not ready');
        },
      });
      return page;
    };

    const { error } = await libFailureOfBoth(createAlertViaApi, [request(), WAIT_MS], make);

    expect(error.code).toBe('NOT_AVAILABLE');
  });
});

// A call that rejects with `reason`, which a test picks to be no error on purpose.
function rejecting(reason: unknown): () => Promise<never> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
  return () => Promise.reject(reason);
}

describe('deleteAlertsViaApi', () => {
  test('sends the ids to deleteAlerts', async () => {
    const { result, win } = await libResultOf(
      deleteAlertsViaApi,
      [[1, 3], WAIT_MS],
      chart({ ...fixture, alerts: [{ id: 1 }, { id: 2 }, { id: 3 }] }),
    );

    expect(result).toEqual({ sent: true });
    expect(calls(win, 'alertsRestApi.deleteAlerts')).toEqual([[{ alert_ids: [1, 3] }]]);
    expect(inspectFakeWindow(win).state.alerts.list.map(({ alert_id: id }) => id)).toEqual([2]);
  });

  test('a refusal of TradingView comes back with its code and message', async () => {
    const { result } = await libResultOf(
      deleteAlertsViaApi,
      [[1], WAIT_MS],
      changed(
        (win) => {
          inspectFakeWindow(win).state.alerts.errors.deleteAlerts = {
            code: 'general',
            message: 'Synthetic failure',
          };
        },
        { ...fixture, alerts: [{ id: 1 }] },
      ),
    );

    expect(result).toEqual({ refused: { code: 'general', message: 'Synthetic failure' } });
  });

  test('TIMEOUT when TradingView does not answer', async () => {
    const { error } = await libFailureOfBoth(
      deleteAlertsViaApi,
      [[1], 50],
      withModules(clientModule({ deleteAlerts: () => new Promise(() => undefined) })),
    );

    expect(error.toPayload()).toEqual({
      code: 'TIMEOUT',
      message: 'TradingView did not answer the deletion of the alerts within 50 ms',
      hint: 'Some of the alerts may be gone all the same: check alert_list.',
      details: { waitMs: 50 },
    });
  });

  test('a page without the alerts client of the app is CAPABILITY_UNAVAILABLE', async () => {
    for (const make of [
      withModules({ ...createFeatureToggleModules({}) }),
      withModules({
        1: {
          getAlertsRestApi: () => {
            throw new Error('No session');
          },
        },
      }),
    ]) {
      const { error } = await libFailureOfBoth(deleteAlertsViaApi, [[1], WAIT_MS], make);

      expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
    }
  });

  test('a refusal of any shape comes back with what it says', async () => {
    for (const [remove, refused] of [
      [rejecting(new Error('Fetch Failed')), { code: null, message: 'Fetch Failed' }],
      [rejecting('offline'), { code: null, message: 'offline' }],
      [rejecting({ code: '', message: 'empty code' }), { code: null, message: 'empty code' }],
      [rejecting({ code: 5 }), { code: null, message: '[object Object]' }],
      [
        () => {
          throw new Error('Synchronous failure');
        },
        { code: null, message: 'Synchronous failure' },
      ],
    ] as const) {
      const { result } = await libResultOf(
        deleteAlertsViaApi,
        [[1], WAIT_MS],
        withModules(clientModule({ deleteAlerts: remove })),
      );

      expect(result).toEqual({ refused });
    }
  });
});
