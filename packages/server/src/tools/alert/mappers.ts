import { TvMcpError } from '../../core/errors.js';
import { MILLISECONDS_ABOVE, toIso } from '../../utils/time.js';
import { listed } from '../drawing/mappers.js';
import type { AlertRefusal, AlertRow, ExpirationSpan } from './page.js';

// The pure parts of the alert tools: the conditions and their names in the app, the records the
// tools report, the counts the plan limit is checked against, the errors a refusal of TradingView
// becomes, and the bounds of an expiration.

export const ALERT_CONDITIONS = [
  'crossing',
  'crossing_up',
  'crossing_down',
  'greater_than',
  'less_than',
] as const;

export type AlertCondition = (typeof ALERT_CONDITIONS)[number];

export const ALERT_STATUSES = ['active', 'stopped', 'triggered'] as const;

export type AlertStatus = (typeof ALERT_STATUSES)[number];

// The condition type of the app for each condition of the tools (its ConditionType, notes of Plan
// 3, section 2.3).
export const CONDITION_TYPES: Readonly<Record<AlertCondition, string>> = {
  crossing: 'cross',
  crossing_up: 'cross_up',
  crossing_down: 'cross_down',
  greater_than: 'greater',
  less_than: 'less',
};

// The other way: the condition of the tools by the condition type of the app. A Map, so that a name
// every object inherits finds nothing.
const CONDITION_NAMES = new Map<string, AlertCondition>(
  ALERT_CONDITIONS.map((condition) => [CONDITION_TYPES[condition], condition]),
);

const CONDITION_WORDS: Readonly<Record<AlertCondition, string>> = {
  crossing: 'crossing',
  crossing_up: 'crossing up',
  crossing_down: 'crossing down',
  greater_than: 'greater than',
  less_than: 'less than',
};

// The codes of the alerts server for a full plan, which are relayed as PLAN_LIMIT with the message of
// the server (design spec 5.3, rule 3).
const LIMIT_CODES = new Set([
  'total_alerts_count_exceeded',
  'max_primitive_alerts_count_exceeded',
  'active_alerts_count_exceeded',
  'max_complex_alerts_count_exceeded',
]);

const DAY = 86_400;
// The bound of an expiration when the alert config of the app cannot be read: the shortest the app
// allows on any plan, 30 days, which is both the longest and the default on the free product.
const FALLBACK_SPAN: ExpirationSpan = { type: 'days', count: 30 };
// The largest time a Date can hold, in milliseconds.
const MAX_DATE_MS = 8.64e15;

// What an alert is called in a message: the ticker of its symbol, the condition and the price, such
// as "AAPL crossing 150".
export function defaultMessage(symbol: string, condition: AlertCondition, price: number): string {
  const ticker = symbol.slice(symbol.lastIndexOf(':') + 1);
  return `${ticker} ${CONDITION_WORDS[condition]} ${String(price)}`;
}

// The symbol of an encoded extended symbol (={...}, as the app keeps the symbol of an alert on the
// chart), else the symbol as it is: what cannot be decoded stays as it is.
export function plainSymbol(symbol: string): string {
  if (!symbol.startsWith('=')) {
    return symbol;
  }
  try {
    const decoded: unknown = JSON.parse(symbol.slice(1));
    const inner: unknown =
      typeof decoded === 'object' && decoded !== null
        ? (decoded as { symbol?: unknown }).symbol
        : undefined;
    return typeof inner === 'string' && inner !== '' ? inner : symbol;
  } catch {
    return symbol;
  }
}

// active while the alert is active; triggered when it fired once and stopped itself (stop reason
// auto); stopped otherwise, by hand, on expiry or for any other reason.
export function alertStatus(row: Pick<AlertRow, 'active' | 'lastStopReason'>): AlertStatus {
  if (row.active === true) {
    return 'active';
  }
  return row.lastStopReason === 'auto' ? 'triggered' : 'stopped';
}

// A time of an alert record in Unix seconds: an ISO time, or a timestamp (milliseconds above 1e11,
// seconds otherwise). Null for anything else, and for a time no Date can hold.
export function alertTime(value: string | number | null): number | null {
  if (value === null) {
    return null;
  }
  const ms =
    typeof value === 'string'
      ? Date.parse(value)
      : value > MILLISECONDS_ABOVE
        ? value
        : value * 1000;
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS ? Math.floor(ms / 1000) : null;
}

// What an alert watches, by the type of the first series of its condition: the bars of the chart
// for a price alert, an indicator for an indicator alert. Any other type keeps the name of the app.
const ALERT_KINDS = new Map<string, string>([
  ['barset', 'price'],
  ['study', 'indicator'],
]);

// An alert as the tools report it.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type AlertRecord = {
  id: string;
  symbol: string | null;
  kind: string | null;
  condition: string | null;
  price: number | null;
  indicator: string | null;
  value: number | null;
  message: string | null;
  status: AlertStatus;
  expiration: number | null;
  expirationIso: string | null;
  createdByServer: boolean;
};

// An alert in the terms of the tools: its id as text, its plain symbol, what it watches (kind), its
// condition by the name of the tools (another condition type of the app keeps the name of the app),
// the price a price alert compares with, the indicator the condition names, the value an indicator
// alert compares with, and whether this session created it (`created` holds those ids). Only an
// alert that watches the bars of the chart is a price alert: the value an indicator is compared
// with is no price.
export function toAlertRecord(row: AlertRow, created: ReadonlySet<string>): AlertRecord {
  const id = String(row.id);
  const expiration = alertTime(row.expires);
  const kind = row.series === null ? null : (ALERT_KINDS.get(row.series) ?? row.series);
  return {
    id,
    symbol: row.symbol === null ? null : plainSymbol(row.symbol),
    kind,
    condition:
      row.condition === null ? null : (CONDITION_NAMES.get(row.condition) ?? row.condition),
    price: row.series === 'barset' ? row.value : null,
    indicator: row.study,
    value: row.series === 'study' ? row.value : null,
    message: row.message,
    status: alertStatus(row),
    expiration,
    expirationIso: expiration === null ? null : toIso(expiration),
    createdByServer: created.has(id),
  };
}

// What the alert limits of the plan are checked against, as the app counts it before it sends an
// alert: every alert of the account, active or not, for overall_limit; and the active price alerts,
// those that are primitive and not on a watchlist, for primitive_limit. An alert that could not be
// read counts in both, and so does a field that could not be read, so that a count is never too
// low.
export function alertCounts(listing: { alerts: readonly AlertRow[]; unreadable: number }): {
  all: number;
  activePrice: number;
} {
  const activePrice = listing.alerts.filter(
    (row) =>
      row.active !== false && row.complexity !== 'complex' && !row.kinds.includes('watchlist'),
  ).length;
  return {
    all: listing.alerts.length + listing.unreadable,
    activePrice: activePrice + listing.unreadable,
  };
}

// The error of a refusal of the alerts client. A limit code of the server is PLAN_LIMIT with the
// message of the server unchanged (design spec 5.3, rule 3); unauthorized, an account that is not
// signed in, AUTH_REQUIRED; any other refusal PAGE_EVALUATION_FAILED with its code. `action` says
// what was asked, such as "create the alert".
export function refusalError(refusal: AlertRefusal, action: string): TvMcpError {
  const { code, message } = refusal;
  if (code !== null && LIMIT_CODES.has(code)) {
    return new TvMcpError(
      'PLAN_LIMIT',
      message === '' ? `TradingView refused to ${action}: ${code}` : message,
      {
        hint:
          'TradingView refused it for the alert limits of the plan of the account. alert_list ' +
          'shows the alerts; delete one with alert_delete first.',
        details: { feature: 'SERVER_SIDE_ALERTS', code },
      },
    );
  }
  if (code === 'unauthorized') {
    return new TvMcpError('AUTH_REQUIRED', 'Alerts need a signed-in TradingView account', {
      hint: 'Sign in to TradingView, then try again.',
      details: { code },
    });
  }
  const said = message === '' ? '' : `: ${message}`;
  return new TvMcpError(
    'PAGE_EVALUATION_FAILED',
    `TradingView did not ${action}${said}${code === null ? '' : ` (${code})`}`,
    {
      hint:
        code === null
          ? 'Check alert_list: TradingView may have acted despite the error.'
          : 'TradingView refused it, so nothing changed.',
      details: { code },
    },
  );
}

// `seconds` moved on by a span of the alert config: days, weeks, or calendar months, which end on
// the last day of a shorter month. Null for a span of another type or without a whole positive
// count.
export function addSpan(seconds: number, span: ExpirationSpan): number | null {
  const { type, count } = span;
  if (!Number.isInteger(count) || count <= 0) {
    return null;
  }
  switch (type) {
    case 'days':
      return seconds + count * DAY;
    case 'weeks':
      return seconds + count * 7 * DAY;
    case 'months': {
      const from = new Date(seconds * 1000);
      const target = new Date(from.getTime());
      target.setUTCDate(1);
      target.setUTCMonth(target.getUTCMonth() + count);
      const lastDay = new Date(
        Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
      ).getUTCDate();
      target.setUTCDate(Math.min(from.getUTCDate(), lastDay));
      return Math.floor(target.getTime() / 1000);
    }
    default:
      return null;
  }
}

// A span addSpan takes (days, weeks or months) as a message names it: "30 days", "1 month".
function spanLabel(span: ExpirationSpan): string {
  return `${String(span.count)} ${span.type.slice(0, -1)}${span.count === 1 ? '' : 's'}`;
}

// When an alert created at `now` may expire at the latest, and when it expires without a given
// expiration, by the bounds of the alert config of the app: the longest expiration (`max`) and the
// default (`byDefault`), each falling back to 30 days when it cannot be read, and the default never
// beyond the latest. maximum names the longest.
export function expirationWindow(
  now: number,
  max: ExpirationSpan | null,
  byDefault: ExpirationSpan | null,
): { latest: number; byDefault: number; maximum: string } {
  const fallback = now + FALLBACK_SPAN.count * DAY;
  const fromMax = max === null ? null : addSpan(now, max);
  const latest = fromMax ?? fallback;
  const defaultTime = (byDefault === null ? null : addSpan(now, byDefault)) ?? fallback;
  return {
    latest,
    byDefault: Math.min(defaultTime, latest),
    maximum: spanLabel(fromMax === null || max === null ? FALLBACK_SPAN : max),
  };
}

// The expiration of a new alert, in Unix seconds: the default of the window without `given`, else
// `given` when it lies after `now` and not beyond the latest. Fails with INVALID_INPUT otherwise,
// before anything is sent: a time that is not in the future, or one beyond the longest the plan
// allows, which the error names.
export function resolveExpiration(
  given: number | undefined,
  now: number,
  window: { latest: number; byDefault: number; maximum: string },
): number {
  if (given === undefined) {
    return window.byDefault;
  }
  const details = { expiration: given, expirationIso: toIso(given) };
  if (given <= now) {
    throw new TvMcpError('INVALID_INPUT', `The expiration ${toIso(given)} is not in the future`, {
      hint: 'Give a time in the future, or leave expiration out for the default of TradingView.',
      details,
    });
  }
  if (given > window.latest) {
    throw new TvMcpError(
      'INVALID_INPUT',
      `The expiration ${toIso(given)} is more than ${window.maximum} away, the longest ` +
        'TradingView allows for an alert on this plan',
      {
        hint:
          `Give an expiration up to ${toIso(window.latest)}, or leave it out for the default of ` +
          'TradingView.',
        details: {
          ...details,
          latest: window.latest,
          latestIso: toIso(window.latest),
          maximum: window.maximum,
        },
      },
    );
  }
  return given;
}

// Interval.isSeconds of the app: a resolution in seconds, such as 5S. The app reads a resolution up
// to its first comma.
export function isSecondsResolution(resolution: string): boolean {
  return /^\d*S(?:,|$)/.test(resolution.toUpperCase());
}

// The warning of alert_list for the alerts it could not read.
export function unreadableAlertsWarning(count: number): string {
  return count === 1
    ? 'TradingView listed 1 alert that could not be read, so it is left out.'
    : `TradingView listed ${String(count)} alerts that could not be read, so they are left out.`;
}

// The refusal of alert_create when too little of its time is left to wait for the answer to the
// creation: nothing was sent.
export function outOfTimeError(budgetMs: number): TvMcpError {
  return new TvMcpError(
    'TIMEOUT',
    'Too little of the time alert_create allows itself was left to send the alert, so nothing ' +
      'was created',
    {
      hint: 'Nothing was created, so it is safe to call alert_create again.',
      details: { budgetMs },
    },
  );
}

// The warning of alert_delete for the alerts TradingView still lists after the deletion.
export function notDeletedWarning(ids: readonly string[]): string {
  return (
    `TradingView still lists ${String(ids.length)} of the alerts after the deletion: ` +
    `${listed(ids)}. alert_list shows what is left.`
  );
}
