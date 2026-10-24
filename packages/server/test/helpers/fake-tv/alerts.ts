import type { JsonValue } from '../../../src/utils/json.js';
import type { FixtureAlert } from './fixture.js';

// The alerts of the account and the alert modules of the app, built from the alerts of the fixture
// (reverse-engineering notes of Plan 3, section 2, and module 534745 of the web build for the
// converter). Values are synthetic.
//
// - getAlertsRestApi() is a call-once factory: every call answers the same client, whose
//   listAlerts(), createAlert(payload) and deleteAlerts({ alert_ids }) answer from the alerts of the
//   account (state.alerts.list), kept as the server records them (snake_case, alert_id a number).
//   Each call records itself (alertsRestApi.<method>) and answers on a later tick. A refusal rejects
//   with an error named AlertsRestApiError that carries code and message, as the client of the app
//   does: unauthorized while no account is signed in, the error a test stages in
//   state.alerts.errors for the method, invalid_request for a payload without conditions, symbol,
//   resolution, message, active or an expiration (expiration_policy, or the legacy expiration), and
//   the limit codes of the server when the plan is full: total_alerts_count_exceeded when every
//   alert of the account, active or not, fills overall_limit, max_primitive_alerts_count_exceeded
//   when the active price alerts (primitive, not on a watchlist) fill primitive_limit, or limit when
//   the plan has no primitive_limit. A created alert is stored as sent, with the next id after the
//   largest one (9001 at the least), and its record is the answer; ignore_warnings is not kept.
//   The alerts server of the app activates a new alert a moment after it answers its creation
//   (about 1.5 s seen) and lists it with active false and no stop reason until then: the next
//   state.alerts.activationListings answers of listAlerts after a creation (0 by default) list the
//   new alert that way, and later ones as it was sent. While state.alerts.firesAtCreation is set, a
//   new alert fires at once, as one whose condition the price meets already, and is stored as
//   fired and stopped by itself (active false, last_stop_reason auto) without ever listing as
//   active.
//   deleteAlerts deletes the ids the account has and passes over the others, and deletes nothing
//   while state.alerts.deleteIgnored is set. The other methods of the client only record
//   themselves.
// - convertEditableAlertState(state, sendLegacyExpiration = true) is a copy of the converter of
//   the app for the price conditions (cross, cross_up, cross_down, greater, less), with the
//   assertions of the app: the camelCase state of the alert dialog becomes the snake_case payload;
//   a range resolution becomes "1"; a symbol object is encoded with sorted keys; a schedule that is
//   not null is converted (an undefined one becomes notification_schedule: null); the expiration
//   becomes expiration_policy, or the legacy expiration (an ISO time, or null for never) when told
//   to, and its time must be a Date. It records its calls (alerts.convertEditableAlertState), which
//   change nothing, so that a test can tell the payload came from it.
// - getAlertConfig() answers the alert config of the app: at most 30 days and 30 days by default
//   for the free product, 60 days and one month for any other (options.product).
// - The modules the tools must never use, whose functions open dialogs or the paywall on the app,
//   only record each call by module and export name: the actions of the alerts service
//   (alertsActions.*), the alerts collection (alertsCollection.*), its error presenter
//   (alertsPresenter.*), the chart alerts facade and its helpers (chartAlertsFacade.*) and the admin
//   client (alertsAdminRestApi.*).

export interface FakeAlertsOptions {
  // The product of the account, which sets the expirations of the alert config. Default free.
  product?: 'free' | 'pro';
  // Leave a module out of the cache, as a build without it.
  withoutRestApi?: boolean;
  withoutConverter?: boolean;
  withoutConfig?: boolean;
}

// An error of the server: what the client of the app rejects with.
export interface FakeAlertsError {
  code: string;
  message: string;
}

export type FakeAlertsMethod = 'listAlerts' | 'createAlert' | 'deleteAlerts';

// The live state of the alerts. Tests may assign to it, for example to stage the error a method
// rejects with.
export interface FakeAlertsState {
  // The alerts of the account, as listAlerts answers them.
  list: Record<string, JsonValue>[];
  // The error each call of a method rejects with, until a test removes it.
  errors: Partial<Record<FakeAlertsMethod, FakeAlertsError>>;
  // Whether deleteAlerts answers without deleting anything.
  deleteIgnored: boolean;
  // How many answers of listAlerts after a creation list the new alert as not active yet.
  activationListings: number;
  // Whether a new alert fires at once and is stored as stopped by itself.
  firesAtCreation: boolean;
}

export interface FakeAlertsDeps {
  state: FakeAlertsState;
  record: (name: string, args: readonly unknown[]) => void;
  signedIn: () => boolean;
  // The symbol of a fixture alert that names none: the chart symbol of the fixture as an alert
  // takes it (encodeAlertSymbol).
  defaultSymbol: string;
  // The limits the server holds the account to, null for one the plan does not configure.
  limits: { primitive: number | null; overall: number | null };
  options?: FakeAlertsOptions | undefined;
}

export interface FakeAlerts {
  readonly modules: Record<string, Record<string, unknown>>;
}

// A symbol the way the main series gives it to an alert: an encoded extended symbol with sorted
// keys (seen on the app with adjustment, currency-id and symbol).
export function encodeAlertSymbol(symbol: string, currency: string): string {
  return `=${JSON.stringify({ adjustment: 'splits', 'currency-id': currency, symbol })}`;
}

const FIRST_NEW_ID = 9001;
// When the alerts of the fixture were created and, unless one says otherwise, when they expire.
const FIXTURE_CREATED = '2024-10-01T00:00:00.000Z';
const FIXTURE_EXPIRES = '2030-01-01T00:00:00.000Z';

const PRICE_CONDITIONS = new Set(['cross', 'cross_up', 'cross_down', 'greater', 'less']);

const ERROR_CODES = {
  General: 'general',
  InvalidRequest: 'invalid_request',
  Unauthorized: 'unauthorized',
  TotalAlertsCountExceeded: 'total_alerts_count_exceeded',
  PrimitiveAlertsCountExceeded: 'max_primitive_alerts_count_exceeded',
  ActiveAlertsCountExceeded: 'active_alerts_count_exceeded',
  ComplexAlertsCountExceeded: 'max_complex_alerts_count_exceeded',
};

// What the client of the app rejects with (module 415687 of the web build).
class FakeAlertsRestApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AlertsRestApiError';
    this.code = code;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// What JSON keeps of a value, as the wire between the client and the server does.
function overTheWire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// An alert of the fixture as the server records it.
function fromFixture(alert: FixtureAlert, defaultSymbol: string): Record<string, JsonValue> {
  const symbol = alert.symbol ?? defaultSymbol;
  const active = alert.active ?? true;
  const price = alert.price === undefined ? 100 : alert.price;
  const expires = alert.expiration === undefined ? FIXTURE_EXPIRES : alert.expiration;
  const expiration: Record<string, JsonValue> =
    alert.legacyExpiration === true
      ? { expiration: expires }
      : {
          expiration_policy:
            expires === null ? { policy: 'never' } : { policy: 'fixed_date', time: expires },
        };
  return {
    alert_id: alert.id,
    symbol,
    pro_symbol: symbol,
    type: price === null ? 'indicator' : 'price',
    kinds: alert.kinds ?? ['regular'],
    active,
    last_stop_reason:
      alert.lastStopReason === undefined ? (active ? null : 'manual') : alert.lastStopReason,
    last_error: null,
    create_time: FIXTURE_CREATED,
    last_fire_time: null,
    last_fire_bar_time: null,
    ...expiration,
    resolution: '1D',
    cross_interval: false,
    complexity: alert.complexity ?? 'primitive',
    conditions: [
      {
        type: alert.condition ?? 'cross',
        frequency: 'on_first_fire',
        series: [
          { type: 'barset' },
          price === null
            ? { type: 'study', study: 'RSI@tv-basicstudies', plot_id: 'plot_0' }
            : { type: 'value', value: price },
        ],
        resolution: '1D',
      },
    ],
    message: alert.message ?? `Synthetic alert ${String(alert.id)}`,
    name: null,
    sound_file: null,
    sound_duration: 0,
    popup: true,
    auto_deactivate: true,
    email: false,
    sms_over_email: false,
    mobile_push: false,
    web_hook: null,
    ...structuredClone(alert.raw ?? {}),
  };
}

// Whether a payload has what the server needs of a price alert.
function isWellFormed(payload: Record<string, unknown> | null): boolean {
  if (payload === null) {
    return false;
  }
  const { conditions, symbol, resolution, message, active } = payload;
  const hasExpiration =
    record(payload.expiration_policy) !== null ||
    payload.expiration === null ||
    typeof payload.expiration === 'string';
  return (
    Array.isArray(conditions) &&
    conditions.length > 0 &&
    typeof symbol === 'string' &&
    symbol !== '' &&
    typeof resolution === 'string' &&
    typeof message === 'string' &&
    typeof active === 'boolean' &&
    hasExpiration
  );
}

// Whether an alert counts against the active price alerts: active, a price alert (primitive) and
// not on a watchlist (deriveAlertLimitKind of the app).
function isActivePriceAlert(alert: Record<string, JsonValue>): boolean {
  const kinds = alert.kinds;
  return (
    alert.active === true &&
    alert.complexity !== 'complex' &&
    !(Array.isArray(kinds) && kinds.includes('watchlist'))
  );
}

// Interval.isRange of the app: a resolution of range bars, such as 1R.
function isRange(resolution: unknown): boolean {
  return /^\d*R$/.test(String(resolution).toUpperCase().split(',')[0] ?? '');
}

// The copy of the converter of the app (convertEditableAlertState, module 534745), for price
// conditions.
function convertCondition(condition: Record<string, unknown>): Record<string, unknown> {
  const { type, frequency, series } = condition;
  if (typeof type !== 'string' || !PRICE_CONDITIONS.has(type) || !Array.isArray(series)) {
    throw new Error(`The fake converter knows price conditions only, not ${String(type)}`);
  }
  const [first, second] = series as unknown[];
  const firstType = record(first)?.type;
  if (firstType === 'barset') {
    if (record(second)?.type === 'barset') {
      throw new Error('Assertion failed');
    }
  } else if (firstType !== 'study') {
    throw new Error(`${String(firstType)} is expected to be one of barset,study`);
  }
  return { type, frequency, series: [{ ...record(first) }, { ...record(second) }] };
}

function convertSchedule(schedule: unknown): JsonValue {
  const given = record(schedule);
  return given === null ? null : (overTheWire(given) as JsonValue);
}

function encodeSymbol(symbol: unknown): string {
  if (typeof symbol === 'string') {
    return symbol;
  }
  const given = record(symbol) ?? {};
  const sorted = Object.fromEntries(
    Object.keys(given)
      .sort()
      .map((key) => [key, given[key]]),
  );
  return `=${JSON.stringify(sorted)}`;
}

export function createFakeAlerts(
  alerts: readonly FixtureAlert[],
  deps: FakeAlertsDeps,
): FakeAlerts {
  const options = deps.options ?? {};
  const { state } = deps;
  state.list.splice(
    0,
    state.list.length,
    ...alerts.map((alert) => fromFixture(alert, deps.defaultSymbol)),
  );
  state.errors = {};
  state.deleteIgnored = false;
  state.activationListings = 0;
  state.firesAtCreation = false;
  // The created alerts the server has not activated yet, by id, with how many more answers of
  // listAlerts list them as not active.
  const inactiveFor = new Map<number, number>();

  const nextId = (): number => {
    const ids = state.list.flatMap(({ alert_id: id }) => (typeof id === 'number' ? [id] : []));
    return Math.max(FIRST_NEW_ID - 1, ...ids) + 1;
  };

  // Runs a call the way the client of the app does: on a later tick, refused while no account is
  // signed in or when a test staged an error for the method.
  const answer = <T>(method: FakeAlertsMethod, act: () => T): Promise<T> =>
    Promise.resolve().then(() => {
      const staged = state.errors[method];
      if (staged !== undefined) {
        throw new FakeAlertsRestApiError(staged.code, staged.message);
      }
      if (!deps.signedIn()) {
        throw new FakeAlertsRestApiError(ERROR_CODES.Unauthorized, 'Unauthorized');
      }
      return act();
    });

  const recordedOnly = (name: string) => (payload?: unknown) => {
    deps.record(`alertsRestApi.${name}`, payload === undefined ? [] : [payload]);
    return Promise.resolve(undefined);
  };

  const api = {
    listAlerts(signal?: unknown, initiator?: unknown): Promise<Record<string, JsonValue>[]> {
      deps.record(
        'alertsRestApi.listAlerts',
        [signal, initiator].filter((arg) => arg !== undefined),
      );
      return answer('listAlerts', () =>
        overTheWire(state.list).map((alert) => {
          const id = alert.alert_id as number;
          const left = inactiveFor.get(id);
          if (left === undefined) {
            return alert;
          }
          if (left <= 1) {
            inactiveFor.delete(id);
          } else {
            inactiveFor.set(id, left - 1);
          }
          return { ...alert, active: false };
        }),
      );
    },
    createAlert(payload: unknown): Promise<Record<string, JsonValue>> {
      deps.record('alertsRestApi.createAlert', [payload]);
      return answer('createAlert', () => {
        const sent = record(payload);
        if (sent === null || !isWellFormed(sent)) {
          throw new FakeAlertsRestApiError(ERROR_CODES.InvalidRequest, 'Invalid request');
        }
        const { overall, primitive } = deps.limits;
        if (overall !== null && state.list.length >= overall) {
          throw new FakeAlertsRestApiError(
            ERROR_CODES.TotalAlertsCountExceeded,
            'The account has as many alerts as its plan allows',
          );
        }
        if (primitive !== null && state.list.filter(isActivePriceAlert).length >= primitive) {
          throw new FakeAlertsRestApiError(
            ERROR_CODES.PrimitiveAlertsCountExceeded,
            'The account has as many active price alerts as its plan allows',
          );
        }
        const fields = Object.fromEntries(
          Object.entries(overTheWire(sent) as Record<string, JsonValue>).filter(
            ([key]) => key !== 'ignore_warnings',
          ),
        );
        const created: Record<string, JsonValue> = {
          alert_id: nextId(),
          pro_symbol: fields.symbol ?? null,
          type: 'price',
          kinds: ['regular'],
          last_stop_reason: null,
          last_error: null,
          create_time: new Date().toISOString(),
          last_fire_time: null,
          last_fire_bar_time: null,
          cross_interval: false,
          complexity: 'primitive',
          ...fields,
        };
        if (state.firesAtCreation && created.active === true) {
          Object.assign(created, {
            active: false,
            last_stop_reason: 'auto',
            last_fire_time: created.create_time ?? null,
          });
        }
        state.list.push(created);
        if (state.activationListings > 0 && created.active === true) {
          inactiveFor.set(created.alert_id as number, state.activationListings);
        }
        return overTheWire(created);
      });
    },
    deleteAlerts(payload: unknown): Promise<undefined> {
      deps.record('alertsRestApi.deleteAlerts', [payload]);
      return answer('deleteAlerts', () => {
        const ids = record(payload)?.alert_ids;
        if (!Array.isArray(ids) || !ids.every((id) => Number.isInteger(id))) {
          throw new FakeAlertsRestApiError(ERROR_CODES.InvalidRequest, 'Invalid request');
        }
        if (!state.deleteIgnored) {
          const doomed = new Set(ids as number[]);
          const kept = state.list.filter(({ alert_id: id }) => !doomed.has(id as number));
          state.list.splice(0, state.list.length, ...kept);
        }
        return undefined;
      });
    },
    getAlerts: recordedOnly('getAlerts'),
    stopAlerts: recordedOnly('stopAlerts'),
    restartAlerts: recordedOnly('restartAlerts'),
    modifyRestartAlert: recordedOnly('modifyRestartAlert'),
    cloneAlerts: recordedOnly('cloneAlerts'),
    deleteAllFires: recordedOnly('deleteAllFires'),
  };

  const convertEditableAlertState = (
    given: unknown,
    sendLegacyExpiration = true,
  ): Record<string, unknown> => {
    deps.record('alerts.convertEditableAlertState', [given, sendLegacyExpiration]);
    const editable = given as Record<string, unknown>;
    const schedule =
      editable.notificationSchedule !== null
        ? { notification_schedule: convertSchedule(editable.notificationSchedule) }
        : {};
    const conditions = editable.conditions as Record<string, unknown>[];
    const converted = {
      conditions: conditions.map((condition) => ({
        ...convertCondition(condition),
        resolution: isRange(condition.resolution) ? '1' : condition.resolution,
      })),
      symbol: encodeSymbol(editable.symbol),
      resolution: isRange(editable.resolution) ? '1' : editable.resolution,
      message: editable.message,
      sound_file: editable.soundFile,
      sound_duration: editable.soundDuration,
      popup: editable.popup,
      auto_deactivate: editable.autoDeactivate,
      email: editable.email,
      sms_over_email: editable.smsOverEmail,
      mobile_push: editable.mobilePush,
      web_hook: editable.webhook,
      name: editable.name,
      ...schedule,
    };
    const policy = editable.expirationPolicy as {
      policy: string;
      time?: { toISOString(): string };
    };
    if (sendLegacyExpiration && policy.policy !== 'new_report') {
      return {
        ...converted,
        expiration: policy.policy === 'fixed_date' ? policy.time?.toISOString() : null,
      };
    }
    return {
      ...converted,
      expiration_policy:
        policy.policy === 'fixed_date'
          ? { ...policy, time: (policy.time as { toISOString(): string }).toISOString() }
          : { ...policy },
    };
  };

  // Call-once, as in the app: the same object on every call. The app keeps the address of the
  // alerts server and its retry counts next to these, which no page function reads.
  const alertConfig =
    options.product === 'pro'
      ? {
          maxAlertExpiration: { type: 'days', count: 60 },
          defaultAlertExpiration: { type: 'months', count: 1 },
        }
      : {
          maxAlertExpiration: { type: 'days', count: 30 },
          defaultAlertExpiration: { type: 'days', count: 30 },
        };

  // Functions that only record a call, by module and export name.
  const untouchable = (prefix: string, names: readonly string[]): Record<string, unknown> =>
    Object.fromEntries(
      names.map((name) => [
        name,
        function recorded(...args: unknown[]): undefined {
          deps.record(`${prefix}.${name}`, args);
          return undefined;
        },
      ]),
    );

  const modules: Record<string, Record<string, unknown>> = {
    // Module IDs are arbitrary numbers, as in a production build.
    '20090': {
      ...untouchable('alertsCollection', ['getAlertsCollection', 'isAlertsCollectionError']),
      AlertsCollectionErrorCode: { ...ERROR_CODES },
    },
    '21979': untouchable('alertsActions', ['getAlertsActions', 'getFiresActions']),
    '50982': untouchable('alertsPresenter', ['getAlertErrorPresenter']),
    '94760': untouchable('chartAlertsFacade', ['ChartAlertsFacade']),
    '11584': untouchable('chartAlertsFacade', [
      'getChartAlertsFacade',
      'initAlerts',
      'preloadChartAlertsFacade',
      'registerChartAlertsFacade',
    ]),
  };
  if (options.withoutRestApi !== true) {
    modules['33361'] = {
      getAlertsRestApi: () => api,
      ...untouchable('alertsAdminRestApi', ['getAlertsAdminRestApi']),
      AlertsRestApiError: FakeAlertsRestApiError,
      ErrorCode: { ...ERROR_CODES },
      Status: { Ok: 'ok', Error: 'error' },
    };
  }
  if (options.withoutConverter !== true) {
    modules['53474'] = {
      convertEditableAlertState,
      convertClientNotificationSchedule: convertSchedule,
      deriveSymbolStyle: () => undefined,
    };
  }
  if (options.withoutConfig !== true) {
    modules['49274'] = { getAlertConfig: () => alertConfig };
  }
  return { modules };
}
