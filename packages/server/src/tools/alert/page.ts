import type { ErrorCode } from '../../core/errors.js';
import type { PageErrorSentinel } from '../../core/tv/page-bridge.js';
import type { PageLib } from '../../core/tv/page-lib.js';
import type {
  AlertConfigLike,
  AlertsRestApiLike,
  ChartWidgetApiLike,
  EditableAlertStateLike,
  SeriesLike,
  TradingViewApiLike,
  TvWindow,
} from '../../core/tv/tv-window.js';
import type { JsonObject } from '../../utils/json.js';

// The page functions of the alert tools (reverse-engineering notes of Plan 3, section 2). The page
// bridge sends the source text of each one into the page, so each uses nothing of this file, only
// its parameters and the globals of the page, and whatever it shares with another is written out
// in each. Types are erased, so the type imports above are fine.
//
// Alerts are objects of the account on the alerts server of TradingView, which the page reaches
// only through the alerts REST client of the app (getAlertsRestApi, found by the name of its
// export): a call of it is the request the app sends, and it opens nothing. A refusal of the server
// comes back as { refused: { code, message } }, for the server to map: the client rejects with an
// AlertsRestApiError whose code is the code of the server and whose message is its text. Nothing
// here uses the alerts service of the app, its actions, its error presenter or the chart alerts
// facade, which present errors in dialogs (the presenter opens the paywall for the limit codes).
// The readers change nothing; createAlertViaApi creates and deleteAlertsViaApi deletes, and each
// says CAPABILITY_UNAVAILABLE or NOT_AVAILABLE only before it acts.

// An alert as the tools read it from its record: alert_id, the symbol it watches (EXCHANGE:TICKER
// or an encoded ={...} form), its kinds, whether it is active, why it stopped (last_stop_reason),
// its complexity (primitive for a price alert), the type of its first condition, the price of that
// condition (its second series, when that is a value), its message and when it expires: the time of
// a fixed-date expiration_policy, or else the legacy expiration, as the record gives it (an ISO time
// on the app), null for never. A field the record does not have, or has with another type, is null.
// A type alias, not an interface: it comes back from the page as JSON, which a type must satisfy
// JsonValue for.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type AlertRow = {
  id: number;
  symbol: string | null;
  kinds: string[];
  active: boolean | null;
  lastStopReason: string | null;
  complexity: string | null;
  condition: string | null;
  price: number | null;
  message: string | null;
  expires: string | number | null;
};

// Why the alerts client of the app refused a call: the code of the server, null without one (a
// request that failed on the way), and its message.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type AlertRefusal = { code: string | null; message: string };

// What alert_create asks createAlertViaApi for: the symbol as the alert takes it (the alert symbol
// of the chart, or EXCHANGE:TICKER), the resolution of the chart, the condition type of the app, the
// price, the message and when the alert expires, in Unix seconds.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type AlertRequest = {
  symbol: string;
  resolution: string;
  condition: string;
  price: number;
  message: string;
  expiresAt: number;
};

// A span of the alert config of the app, such as { type: "days", count: 30 }.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type ExpirationSpan = { type: string; count: number };

// The alerts of the account with listAlerts, each as an AlertRow. An item without a numeric
// alert_id is not listed and counts in unreadable. A list that does not come within waitMs is
// TIMEOUT, an answer that is no list NOT_AVAILABLE, and a page without the client
// CAPABILITY_UNAVAILABLE.
export function readAlerts(
  _win: TvWindow,
  lib: PageLib,
  waitMs: number,
):
  | Promise<
      { alerts: AlertRow[]; unreadable: number } | { refused: AlertRefusal } | PageErrorSentinel
    >
  | PageErrorSentinel {
  const factory = lib.findExport('getAlertsRestApi');
  let client: Partial<AlertsRestApiLike> | null | undefined;
  try {
    client =
      typeof factory === 'function'
        ? (factory as () => Partial<AlertsRestApiLike> | null | undefined)()
        : undefined;
  } catch {
    client = undefined;
  }
  if (typeof client?.listAlerts !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no alerts client of TradingView to ask',
        hint: 'Check app_health: the app may still be loading, or the tab does not show a chart.',
      },
    };
  }
  const api = client as Pick<AlertsRestApiLike, 'listAlerts'>;
  // How the call ended, or late when it did not end within waitMs.
  const settle = (
    call: () => unknown,
  ): Promise<{ value: unknown } | { error: unknown } | { late: true }> => {
    let ended: Promise<{ value: unknown } | { error: unknown }>;
    try {
      ended = Promise.resolve(call()).then(
        (value: unknown) => ({ value }),
        (error: unknown) => ({ error }),
      );
    } catch (error) {
      ended = Promise.resolve({ error });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<{ late: true }>((resolve) => {
      timer = setTimeout(() => {
        resolve({ late: true });
      }, waitMs);
    });
    return Promise.race([ended, late]).then((outcome) => {
      clearTimeout(timer);
      return outcome;
    });
  };
  const refusal = (error: unknown): { refused: AlertRefusal } => {
    const { code, message } = (typeof error === 'object' && error !== null ? error : {}) as {
      code?: unknown;
      message?: unknown;
    };
    return {
      refused: {
        code: typeof code === 'string' && code !== '' ? code : null,
        message:
          typeof message === 'string' ? message : typeof error === 'string' ? error : String(error),
      },
    };
  };
  const text = (value: unknown): string | null =>
    typeof value === 'string' && value !== '' ? value : null;
  const timeOf = (value: unknown): string | number | null =>
    typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
      ? value
      : null;

  return settle(() => api.listAlerts()).then(
    (
      outcome,
    ):
      | { alerts: AlertRow[]; unreadable: number }
      | { refused: AlertRefusal }
      | PageErrorSentinel => {
      if ('late' in outcome) {
        return {
          __tvmcpError: {
            code: 'TIMEOUT',
            message: `TradingView did not list the alerts within ${String(waitMs)} ms`,
            hint: 'Try again in a moment, or check app_health.',
            details: { waitMs },
          },
        };
      }
      if ('error' in outcome) {
        return refusal(outcome.error);
      }
      if (!Array.isArray(outcome.value)) {
        return {
          __tvmcpError: {
            code: 'NOT_AVAILABLE',
            message: 'TradingView answered with no list of alerts',
            hint: 'Try again in a moment, or check app_health.',
          },
        };
      }
      const alerts: AlertRow[] = [];
      let unreadable = 0;
      for (const item of outcome.value as unknown[]) {
        const record =
          typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : null;
        const id = record?.alert_id;
        if (record === null || typeof id !== 'number' || !Number.isFinite(id)) {
          unreadable += 1;
          continue;
        }
        const { conditions, kinds, expiration_policy: policy } = record;
        const first = (Array.isArray(conditions) ? conditions[0] : undefined) as
          { type?: unknown; series?: unknown } | null | undefined;
        const series = first?.series;
        const second = (Array.isArray(series) ? series[1] : undefined) as
          { type?: unknown; value?: unknown } | null | undefined;
        const value = second?.value;
        let expires: string | number | null;
        if (typeof policy === 'object' && policy !== null) {
          const { policy: kind, time } = policy as { policy?: unknown; time?: unknown };
          expires = kind === 'fixed_date' ? timeOf(time) : null;
        } else {
          expires = timeOf(record.expiration);
        }
        alerts.push({
          id,
          symbol: text(record.symbol),
          kinds: Array.isArray(kinds)
            ? (kinds as unknown[]).filter((kind): kind is string => typeof kind === 'string')
            : [],
          active: typeof record.active === 'boolean' ? record.active : null,
          lastStopReason: text(record.last_stop_reason),
          complexity: text(record.complexity),
          condition: text(first?.type),
          price:
            second?.type === 'value' && typeof value === 'number' && Number.isFinite(value)
              ? value
              : null,
          message: typeof record.message === 'string' ? record.message : null,
          expires,
        });
      }
      return { alerts, unreadable };
    },
  );
}

// What an alert on the active chart starts from, read without changing anything: the symbol the
// chart shows, the other names of that symbol (the listing, pro_name, and full_name of its symbol
// info), the symbol as the chart gives it to an alert (getAlertSymbolString of the main series), the
// resolution of the chart and the bounds of an expiration in the alert config of the app (the
// longest the plan allows and the default). What the page cannot tell is null. A page without a
// chart is CAPABILITY_UNAVAILABLE.
export function readAlertContext(
  win: TvWindow,
  lib: PageLib,
):
  | {
      symbol: string | null;
      names: string[];
      alertSymbol: string | null;
      resolution: string | null;
      maxExpiration: ExpirationSpan | null;
      defaultExpiration: ExpirationSpan | null;
    }
  | PageErrorSentinel {
  const configOf = lib.findExport('getAlertConfig');
  const attempt = (read: () => unknown): unknown => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  const found = attempt(() => api?.activeChart?.()) as
    Partial<ChartWidgetApiLike> | null | undefined;
  if (typeof found !== 'object' || found === null) {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no chart to set an alert on',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  const chart = found;
  const text = (value: unknown): string | null =>
    typeof value === 'string' && value !== '' ? value : null;
  const spanOf = (value: unknown): ExpirationSpan | null => {
    const { type, count } = (value ?? {}) as { type?: unknown; count?: unknown };
    return typeof type === 'string' && typeof count === 'number' && Number.isFinite(count)
      ? { type, count }
      : null;
  };
  const series = attempt(() => chart._chartWidget?.model().mainSeries()) as
    Partial<SeriesLike> | null | undefined;
  const info = attempt(() => series?.symbolInfo?.()) as Record<string, unknown> | null | undefined;
  const names = [text(info?.pro_name), text(info?.full_name)].filter(
    (name): name is string => name !== null,
  );
  const config = attempt(() =>
    typeof configOf === 'function' ? (configOf as () => unknown)() : undefined,
  ) as AlertConfigLike | null | undefined;
  return {
    symbol: text(attempt(() => chart.symbol?.())),
    names: [...new Set(names)],
    alertSymbol: text(attempt(() => series?.getAlertSymbolString?.())),
    resolution: text(attempt(() => chart.resolution?.())),
    maxExpiration: spanOf(config?.maxAlertExpiration),
    defaultExpiration: spanOf(config?.defaultAlertExpiration),
  };
}

// Creates a price alert the way the alerts service of the app does when the alert dialog sends one:
// the state of the dialog goes through the converter of the app (convertEditableAlertState, found
// by the name of its export), told to send the legacy expiration exactly when the feature toggle
// alerts-on-lollipop is off, as the app decides it; the payload then gets active and
// ignore_warnings, and goes to createAlert of the alerts client. symbol_style, which the service
// adds as well, is undefined for a price alert and so not sent. The alert fires once, when the price
// meets the condition (on_first_fire), stops itself then (autoDeactivate) and shows a popup in
// TradingView: no sound, email, push, webhook or name. Answers the id of the new alert. Before
// anything is sent, a page without the client is CAPABILITY_UNAVAILABLE, and one without the
// converter, or whose toggle cannot be read, NOT_AVAILABLE; a converter that throws, or answers no
// object, is PAGE_EVALUATION_FAILED. An answer that does not come within waitMs is TIMEOUT, and one
// without an alert id (a positive integer) PAGE_EVALUATION_FAILED.
export function createAlertViaApi(
  win: TvWindow,
  lib: PageLib,
  request: AlertRequest,
  waitMs: number,
): Promise<{ id: string } | { refused: AlertRefusal } | PageErrorSentinel> | PageErrorSentinel {
  // Looked up first, all of them, before anything is asked.
  const factory = lib.findExport('getAlertsRestApi');
  const convert = lib.findExport('convertEditableAlertState');
  const toggles = lib.findModuleWith(['isFeatureEnabled', 'onFeaturesStateChanged']);
  const refuse = (
    code: ErrorCode,
    message: string,
    hint: string,
    details?: JsonObject,
  ): PageErrorSentinel => ({
    __tvmcpError: { code, message, hint, ...(details === undefined ? {} : { details }) },
  });
  const reasonOf = (error: unknown): string => {
    const message: unknown = (error as { message?: unknown } | null | undefined)?.message;
    return typeof error === 'string'
      ? error
      : typeof message === 'string'
        ? message
        : String(error);
  };

  let client: Partial<AlertsRestApiLike> | null | undefined;
  try {
    client =
      typeof factory === 'function'
        ? (factory as () => Partial<AlertsRestApiLike> | null | undefined)()
        : undefined;
  } catch {
    client = undefined;
  }
  if (typeof client?.createAlert !== 'function') {
    return refuse(
      'CAPABILITY_UNAVAILABLE',
      'This page has no alerts client of TradingView to ask',
      'Check app_health: the app may still be loading, or the tab does not show a chart.',
    );
  }
  const api = client as Pick<AlertsRestApiLike, 'createAlert'>;
  if (typeof convert !== 'function') {
    return refuse(
      'NOT_AVAILABLE',
      'This TradingView build has no convertEditableAlertState, which builds an alert the way ' +
        'the alert dialog of TradingView does, so nothing was created',
      'Create the alert in TradingView itself.',
    );
  }
  // The export, else the same function on window.TradingView, called as a method of its owner.
  let owner: unknown = toggles;
  if (typeof toggles?.isFeatureEnabled !== 'function') {
    try {
      owner = win.TradingView;
    } catch {
      owner = undefined;
    }
  }
  let policyToggle: unknown;
  try {
    const toggleOwner = owner as { isFeatureEnabled?: unknown } | null | undefined;
    policyToggle =
      typeof toggleOwner?.isFeatureEnabled === 'function'
        ? (toggleOwner as { isFeatureEnabled: (name: string) => unknown }).isFeatureEnabled(
            'alerts-on-lollipop',
          )
        : undefined;
  } catch {
    policyToggle = undefined;
  }
  if (typeof policyToggle !== 'boolean') {
    return refuse(
      'NOT_AVAILABLE',
      'This TradingView build does not say how its alerts send an expiration, so nothing was ' +
        'created',
      'Create the alert in TradingView itself.',
    );
  }

  const { symbol, resolution, condition, price, message, expiresAt } = request;
  const state: EditableAlertStateLike = {
    conditions: [
      {
        type: condition,
        frequency: 'on_first_fire',
        series: [{ type: 'barset' }, { type: 'value', value: price }],
        resolution,
      },
    ],
    symbol,
    resolution,
    message,
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
    expirationPolicy: { policy: 'fixed_date', time: new Date(expiresAt * 1000) },
  };
  let converted: unknown;
  try {
    converted = (convert as (state: EditableAlertStateLike, legacy: boolean) => unknown)(
      state,
      !policyToggle,
    );
  } catch (error) {
    return refuse(
      'PAGE_EVALUATION_FAILED',
      `The alert converter of TradingView refused the alert: ${reasonOf(error)}`,
      'Nothing was created.',
    );
  }
  if (typeof converted !== 'object' || converted === null) {
    return refuse(
      'PAGE_EVALUATION_FAILED',
      'The alert converter of TradingView answered with no alert',
      'Nothing was created.',
    );
  }
  const payload = {
    ...(converted as Record<string, unknown>),
    active: true,
    ignore_warnings: true,
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ late: true }>((resolve) => {
    timer = setTimeout(() => {
      resolve({ late: true });
    }, waitMs);
  });
  let ended: Promise<{ value: unknown } | { error: unknown }>;
  try {
    ended = Promise.resolve(api.createAlert(payload)).then(
      (value: unknown) => ({ value }),
      (error: unknown) => ({ error }),
    );
  } catch (error) {
    ended = Promise.resolve({ error });
  }
  return Promise.race([ended, late]).then(
    (outcome): { id: string } | { refused: AlertRefusal } | PageErrorSentinel => {
      clearTimeout(timer);
      if ('late' in outcome) {
        return refuse(
          'TIMEOUT',
          `TradingView did not answer the creation of the alert within ${String(waitMs)} ms`,
          'The alert may still appear: check alert_list. This session could not record it, so ' +
            'alert_delete needs confirm: true for it.',
          { waitMs },
        );
      }
      if ('error' in outcome) {
        const { error } = outcome;
        const { code } = (typeof error === 'object' && error !== null ? error : {}) as {
          code?: unknown;
        };
        return {
          refused: {
            code: typeof code === 'string' && code !== '' ? code : null,
            message: reasonOf(error),
          },
        };
      }
      const id: unknown = (outcome.value as { alert_id?: unknown } | null | undefined)?.alert_id;
      if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
        return refuse(
          'PAGE_EVALUATION_FAILED',
          'TradingView answered the creation of the alert without an alert id',
          'The alert may have been created all the same: check alert_list. This session could ' +
            'not record it, so alert_delete needs confirm: true for it.',
        );
      }
      return { id: String(id) };
    },
  );
}

// Deletes the alerts of `ids` with deleteAlerts of the alerts client, for good: the app has no undo
// for it. The caller has checked the ids against the alerts of the account. Answers that the
// request was sent and accepted; whether the alerts are gone is for the caller to read. An answer
// that does not come within waitMs is TIMEOUT, and a page without the client
// CAPABILITY_UNAVAILABLE.
export function deleteAlertsViaApi(
  _win: TvWindow,
  lib: PageLib,
  ids: number[],
  waitMs: number,
): Promise<{ sent: true } | { refused: AlertRefusal } | PageErrorSentinel> | PageErrorSentinel {
  const factory = lib.findExport('getAlertsRestApi');
  let client: Partial<AlertsRestApiLike> | null | undefined;
  try {
    client =
      typeof factory === 'function'
        ? (factory as () => Partial<AlertsRestApiLike> | null | undefined)()
        : undefined;
  } catch {
    client = undefined;
  }
  if (typeof client?.deleteAlerts !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no alerts client of TradingView to ask',
        hint: 'Check app_health: the app may still be loading, or the tab does not show a chart.',
      },
    };
  }
  const api = client as Pick<AlertsRestApiLike, 'deleteAlerts'>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ late: true }>((resolve) => {
    timer = setTimeout(() => {
      resolve({ late: true });
    }, waitMs);
  });
  let ended: Promise<{ value: unknown } | { error: unknown }>;
  try {
    ended = Promise.resolve(api.deleteAlerts({ alert_ids: ids })).then(
      (value: unknown) => ({ value }),
      (error: unknown) => ({ error }),
    );
  } catch (error) {
    ended = Promise.resolve({ error });
  }
  return Promise.race([ended, late]).then(
    (outcome): { sent: true } | { refused: AlertRefusal } | PageErrorSentinel => {
      clearTimeout(timer);
      if ('late' in outcome) {
        return {
          __tvmcpError: {
            code: 'TIMEOUT',
            message: `TradingView did not answer the deletion of the alerts within ${String(waitMs)} ms`,
            hint: 'Some of the alerts may be gone all the same: check alert_list.',
            details: { waitMs },
          },
        };
      }
      if ('error' in outcome) {
        const { error } = outcome;
        const { code, message } = (typeof error === 'object' && error !== null ? error : {}) as {
          code?: unknown;
          message?: unknown;
        };
        return {
          refused: {
            code: typeof code === 'string' && code !== '' ? code : null,
            message:
              typeof message === 'string'
                ? message
                : typeof error === 'string'
                  ? error
                  : String(error),
          },
        };
      }
      return { sent: true };
    },
  );
}
