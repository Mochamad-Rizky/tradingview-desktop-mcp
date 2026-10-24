import { z } from 'zod';
import type { PageHandle } from '../../core/connection.js';
import { isTvMcpError, TvMcpError } from '../../core/errors.js';
import {
  getPlanConfig,
  getPlanFeaturesEnabled,
  inPlanLimitedTurn,
  requireBelowLimit,
} from '../../core/tv/plan-limits.js';
import { pollUntil } from '../../utils/poll.js';
import { parseTimeInput, toIso } from '../../utils/time.js';
import { DESTRUCTIVE, READ_ONLY } from '../annotations.js';
import { TIME_INPUT, timeInput } from '../chart/index.js';
import { sameSymbol } from '../chart/mappers.js';
import { CLIENT_SAFE_BUDGET_MS, pageWaitMs } from '../chart/strategies.js';
import { findListing, symbolSearchOn } from '../data/symbol-lookup.js';
import { listed } from '../drawing/mappers.js';
import { defineTool, type AnyToolDefinition, type ToolContext, type ToolOutput } from '../types.js';
import {
  ALERT_CONDITIONS,
  ALERT_STATUSES,
  alertCounts,
  CONDITION_TYPES,
  defaultMessage,
  expirationWindow,
  isSecondsResolution,
  notActiveYetWarning,
  notDeletedWarning,
  outOfTimeError,
  plainSymbol,
  refusalError,
  resolveExpiration,
  toAlertRecord,
  unreadableAlertsWarning,
} from './mappers.js';
import {
  createAlertViaApi,
  deleteAlertsViaApi,
  readAlertContext,
  readAlerts,
  type AlertRow,
} from './page.js';

// The alert tools (design spec 7, domain Alerts): alerts are objects of the user's account on the
// alerts server of TradingView, which the tools reach only through the alerts REST client of the
// app (reverse-engineering notes of Plan 3, section 2). A call of it is the request the app sends;
// the server never sends one of its own, and nothing opens a dialog: the alerts service of the app,
// its actions, its error presenter and the chart alerts facade, which present errors in dialogs and
// open the paywall for the limit codes, are never used.
//
// alert_create builds its payload with the converter of the alert dialog of the app and checks
// first what the app checks before it sends an alert: the expiration against the bounds of the
// plan, alerts on a timeframe in seconds against the plan, and the alert limits of the plan
// (SERVER_SIDE_ALERTS) against the alerts of the account, all in a turn of the plan-limited actions;
// a limit the server reports is relayed as PLAN_LIMIT unchanged (design spec 5.3, rule 3).
// alert_delete takes explicit ids only, and deleting an alert this session did not create needs
// confirm: true (design spec 5.3, rule 2). The messages of the user's alerts are returned to the
// client and never logged.

const MAX_MESSAGE = 400;
const MAX_DELETE = 50;
// The id of an alert of the server, a positive integer, as alert_list reports it.
const ALERT_ID = /^[1-9]\d{0,14}$/;
// How long alert_create waits for TradingView to list a new alert as active (about 1.5 s seen),
// how often it looks, and the least a listing meanwhile waits for its answer.
const ACTIVATION_WAIT_MS = 5000;
const ACTIVATION_POLL_MS = 250;
const MIN_LISTING_WAIT_MS = 1000;

const ACTIVE_LIMIT_HINT =
  'The plan allows that many active price alerts at a time. Delete one with alert_delete, or ' +
  'stop one in TradingView, then create the alert again.';
const OVERALL_LIMIT_HINT =
  'The plan counts every alert of the account against this limit, stopped and triggered ones ' +
  'included. Delete one with alert_delete first.';
const SECONDS_HINT =
  'Switch the chart to a timeframe of a minute or longer (chart_set_timeframe), then create the ' +
  'alert.';

// The alerts of the account. A refusal of TradingView fails with the error refusalError makes of it.
async function listAlerts(
  page: PageHandle,
  waitMs: number,
): Promise<{ alerts: AlertRow[]; unreadable: number }> {
  const listing = await page.bridge.evaluateWithLib(readAlerts, [waitMs]);
  if ('refused' in listing) {
    throw refusalError(listing.refused, 'list the alerts');
  }
  return listing;
}

// Fails unless the plan has room for one more price alert, as the app checks it before it sends
// one: the active price alerts against primitive_limit (limit when the plan has none), and every
// alert of the account against overall_limit. A limit or a list that cannot be read fails with
// NOT_AVAILABLE, a signed-out account with AUTH_REQUIRED.
async function requireAlertRoom(page: PageHandle, waitMs: number): Promise<void> {
  const listing = await page.bridge.evaluateWithLib(readAlerts, [waitMs]);
  if ('refused' in listing) {
    const { code, message } = listing.refused;
    if (code === 'unauthorized') {
      throw refusalError(listing.refused, 'list the alerts');
    }
    throw new TvMcpError(
      'NOT_AVAILABLE',
      'The alerts of the account could not be listed, so the plan limit SERVER_SIDE_ALERTS ' +
        `cannot be checked: ${message}${code === null ? '' : ` (${code})`}`,
      {
        hint: 'Nothing was created. Try again in a moment, or check app_health.',
        details: { feature: 'SERVER_SIDE_ALERTS', code },
      },
    );
  }
  const config = await getPlanConfig(page, 'SERVER_SIDE_ALERTS', [
    'limit',
    'primitive_limit',
    'overall_limit',
  ]);
  const counts = alertCounts(listing);
  requireBelowLimit(
    'SERVER_SIDE_ALERTS',
    counts.activePrice,
    config.primitive_limit ?? config.limit,
    ACTIVE_LIMIT_HINT,
  );
  requireBelowLimit('SERVER_SIDE_ALERTS', counts.all, config.overall_limit, OVERALL_LIMIT_HINT);
}

// Fails unless the plan allows an alert on `resolution`: one in seconds needs ALERTS_ON_SECONDS,
// which the app checks itself before it sends an alert, and turns into its paywall.
async function requireResolutionAllowed(page: PageHandle, resolution: string): Promise<void> {
  if (!isSecondsResolution(resolution)) {
    return;
  }
  const { ALERTS_ON_SECONDS: allowed } = await getPlanFeaturesEnabled(page, ['ALERTS_ON_SECONDS']);
  if (allowed === true) {
    return;
  }
  if (allowed === false) {
    throw new TvMcpError(
      'PLAN_LIMIT',
      `The plan does not allow alerts on a timeframe in seconds, and the chart is on ${resolution}`,
      { hint: SECONDS_HINT, details: { feature: 'ALERTS_ON_SECONDS' } },
    );
  }
  throw new TvMcpError(
    'NOT_AVAILABLE',
    'Whether the plan allows alerts on a timeframe in seconds cannot be read on this ' +
      `TradingView build, and the chart is on ${resolution}`,
    {
      hint:
        'Switch the chart to a timeframe of a minute or longer (chart_set_timeframe), or create ' +
        'the alert in TradingView itself.',
      details: { feature: 'ALERTS_ON_SECONDS' },
    },
  );
}

// The symbol an alert watches: as the chart gives it to an alert for the chart symbol (left out, or
// given by one of its names), else the given EXCHANGE:TICKER as the symbol search of TradingView
// knows it, which a full name of the chart symbol takes too when the chart does not give its alert
// symbol. sent is what the alert takes, plain the symbol the tools report.
async function alertSymbol(
  page: PageHandle,
  wanted: string | undefined,
  chart: { symbol: string | null; names: string[]; alertSymbol: string | null },
): Promise<{ sent: string; plain: string }> {
  const fromChart = (): { sent: string; plain: string } => {
    if (chart.alertSymbol === null) {
      throw new TvMcpError(
        'NOT_AVAILABLE',
        'The chart does not give its symbol the way an alert takes it',
        {
          hint:
            'Give the symbol as EXCHANGE:TICKER, as data_search_symbols reports it, to set the ' +
            'alert on it.',
        },
      );
    }
    return { sent: chart.alertSymbol, plain: plainSymbol(chart.alertSymbol) };
  };
  if (wanted === undefined) {
    return fromChart();
  }
  const names = [chart.symbol, ...chart.names].filter((name): name is string => name !== null);
  if (
    names.some((name) => sameSymbol(wanted, name)) &&
    (chart.alertSymbol !== null || !wanted.includes(':'))
  ) {
    return fromChart();
  }
  if (!wanted.includes(':')) {
    throw new TvMcpError(
      'INVALID_INPUT',
      `Give a symbol other than the chart symbol as EXCHANGE:TICKER, not ${wanted}`,
      {
        hint:
          'An exchange is needed to tell the listings of a ticker apart. data_search_symbols ' +
          'reports each symbol as EXCHANGE:TICKER.',
        details: { symbol: wanted },
      },
    );
  }
  const match = (await findListing(symbolSearchOn(page), wanted))?.result;
  if (match === undefined) {
    throw new TvMcpError('INVALID_INPUT', `The symbol search of TradingView found no ${wanted}`, {
      hint:
        'Check the spelling, or find the symbol with data_search_symbols and give it in the ' +
        'EXCHANGE:TICKER form it reports.',
      details: { symbol: wanted },
    });
  }
  return { sent: match.symbol, plain: match.symbol };
}

export const alertCreate = defineTool({
  name: 'alert_create',
  domain: 'alert',
  title: 'Create a price alert',
  description:
    "Creates a price alert in the user's TradingView account, on the alerts server, as the " +
    'alert dialog of TradingView would, and returns id (for alert_delete), symbol, condition, ' +
    'price and expiration (Unix seconds, with expirationIso). The alert watches symbol (the ' +
    'symbol of the active chart by default) on the timeframe of the active chart, fires once ' +
    'when the price meets condition against price (crossing in either direction, crossing_up, ' +
    'crossing_down, greater_than or less_than), and then stops; it shows a popup in TradingView ' +
    'with message (by default a short description such as "AAPL crossing 150"), with no sound, ' +
    'email, push or webhook. ' +
    'expiration is when the alert stops if it has not fired: by default the default of ' +
    'TradingView (30 days on a free plan), at most the longest the plan allows (30 days on a ' +
    'free plan, 60 otherwise); a time in the past or beyond that fails with INVALID_INPUT. The ' +
    'plan limit SERVER_SIDE_ALERTS is checked before anything is sent: when the active price ' +
    'alerts, or all alerts of the account, fill the plan, the call fails with PLAN_LIMIT and ' +
    'nothing is created, and a limit the alerts server reports is relayed as PLAN_LIMIT ' +
    'unchanged. A symbol other than the chart symbol must be known to the symbol search of ' +
    'TradingView, else the call fails with INVALID_INPUT. A chart ' +
    'on a timeframe in seconds needs a plan that allows alerts on seconds. No dialog opens. ' +
    'A call keeps within 45 s, so that no client gives up on it and creates the alert again: ' +
    'when too little of that is left before the alert is sent, it fails with TIMEOUT and nothing ' +
    'is created. TradingView activates a new alert a moment after it creates it, so the call ' +
    'answers once TradingView lists the alert as active, or as stopped when it fired at once ' +
    '(alert_list tells), waiting 5 s at most; past that it answers with a warning, the alert ' +
    'created all the same. alert_delete deletes what this tool created without confirm.',
  inputSchema: {
    symbol: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'What to watch: EXCHANGE:TICKER such as NASDAQ:AAPL, as data_search_symbols reports it. ' +
          'Default: the symbol of the active chart, which its ticker alone also names.',
      ),
    condition: z
      .enum(ALERT_CONDITIONS)
      .describe(
        'When the alert fires: crossing (the price crosses price either way), crossing_up, ' +
          'crossing_down, greater_than or less_than.',
      ),
    price: z.number().describe('The price the alert compares with, on the scale of the symbol.'),
    message: z
      .string()
      .min(1)
      .max(MAX_MESSAGE)
      .optional()
      .describe(
        `What the alert shows when it fires, up to ${String(MAX_MESSAGE)} characters. Default: a ` +
          'short description such as "AAPL crossing 150".',
      ),
    expiration: timeInput()
      .optional()
      .describe(
        `When the alert stops if it has not fired: ${TIME_INPUT}. Without an offset a time is ` +
          'UTC. Default: the default of TradingView (30 days on a free plan); at most the ' +
          'longest the plan allows.',
      ),
  },
  // It adds an alert; it changes or removes nothing.
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  core: true,
  // The message stays out of the tool events (redaction.ts): it can carry the secret of a webhook.
  handler: (input, ctx) => createAlert(input, ctx),
});

// What alert_create returns. A type alias, not an interface: it goes to the client as JSON.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
type CreatedAlert = {
  id: string;
  symbol: string;
  condition: (typeof ALERT_CONDITIONS)[number];
  price: number;
  expiration: number;
  expirationIso: string;
};

// What alert_create does, within budgetMs from its start, timed by now (a test gives its own). Each
// page call waits at most a third of the budget, so that the checks and the creation fit in it
// whatever the call timeout, and the creation is sent only while a page wait of the budget is left:
// a creation whose answer the call could not wait for might land after the call failed, and a
// client would create the alert again.
export async function createAlert(
  {
    symbol,
    condition,
    price,
    message,
    expiration,
  }: {
    symbol?: string | undefined;
    condition: (typeof ALERT_CONDITIONS)[number];
    price: number;
    message?: string | undefined;
    expiration?: string | number | undefined;
  },
  ctx: ToolContext,
  budgetMs: number = CLIENT_SAFE_BUDGET_MS,
  now: () => number = () => performance.now(),
): Promise<ToolOutput<CreatedAlert>> {
  const startedAt = now();
  const remainingMs = (): number => budgetMs - (now() - startedAt);
  // All of it before the app is asked anything.
  const wanted = symbol?.trim();
  if (wanted === '') {
    throw new TvMcpError('INVALID_INPUT', 'The symbol is blank', {
      hint: 'Give a symbol such as NASDAQ:AAPL, or leave it out for the chart symbol.',
    });
  }
  if (message?.trim() === '') {
    throw new TvMcpError('INVALID_INPUT', 'The message is blank', {
      hint:
        'Give a message with something to show, or leave message out for a short description ' +
        'of the alert.',
    });
  }
  const expiresAt = expiration === undefined ? undefined : parseTimeInput(expiration);
  const page = await ctx.connection.chartPage();
  const chart = await page.bridge.evaluateWithLib(readAlertContext, []);
  const { resolution } = chart;
  if (resolution === null) {
    throw new TvMcpError(
      'NOT_AVAILABLE',
      'The chart does not report its timeframe, which the alert would watch',
      { hint: 'Check app_health: the chart may still be loading.' },
    );
  }
  await requireResolutionAllowed(page, resolution);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresOn = resolveExpiration(
    expiresAt,
    nowSeconds,
    expirationWindow(nowSeconds, chart.maxExpiration, chart.defaultExpiration),
  );
  const target = await alertSymbol(page, wanted, chart);
  const waitMs = Math.min(pageWaitMs(ctx.config.callTimeoutMs), Math.floor(budgetMs / 3));
  // From the check of the limit to the end of the creation, the other actions on plan limits
  // wait.
  const outcome = await inPlanLimitedTurn(async () => {
    await requireAlertRoom(page, waitMs);
    if (remainingMs() < waitMs) {
      throw outOfTimeError(budgetMs);
    }
    const created = await page.bridge.evaluateWithLib(createAlertViaApi, [
      {
        symbol: target.sent,
        resolution,
        condition: CONDITION_TYPES[condition],
        price,
        message: message ?? defaultMessage(target.plain, condition, price),
        expiresAt: expiresOn,
      },
      waitMs,
    ]);
    if ('refused' in created) {
      throw refusalError(created.refused, 'create the alert');
    }
    ctx.session.createdAlertIds.add(created.id);
    // Within the turn, so that the next check of the limit counts the alert as active.
    const activation = await awaitActivation(
      page,
      created.id,
      waitMs,
      Math.min(ACTIVATION_WAIT_MS, remainingMs()),
      now,
    );
    return { id: created.id, activation };
  });
  return {
    data: {
      id: outcome.id,
      symbol: target.plain,
      condition,
      price,
      expiration: expiresOn,
      expirationIso: toIso(expiresOn),
    },
    via: 'internal',
    warnings: outcome.activation.settled ? [] : [notActiveYetWarning(outcome.activation.waitedMs)],
  };
}

// Waits, within limitMs, until TradingView lists the alert it just created (id) as active, or as
// stopped. Its alerts server answers the creation first and activates the alert a moment later
// (about 1.5 s seen), listing it as not active, with no stop reason, until then; alert_list would
// report it as stopped. An alert whose condition is met at once, such as greater_than at a price
// the symbol is above already, can fire and stop before it was ever listed as active: a stop reason
// settles the wait as well, and alert_list reports what became of it. Each listing waits at most
// pageWait, and no longer than the wait has left, but at least MIN_LISTING_WAIT_MS. An error of the
// app does not fail the call, since the alert exists and a failed call would invite creating it
// again: a listing that fails or is refused counts as not settled yet.
async function awaitActivation(
  page: PageHandle,
  id: string,
  pageWait: number,
  limitMs: number,
  now: () => number,
): Promise<{ settled: boolean; waitedMs: number }> {
  const wanted = Number(id);
  const startedAt = now();
  const listingWait = (): number =>
    Math.max(Math.min(pageWait, limitMs - (now() - startedAt)), MIN_LISTING_WAIT_MS);
  const result = await pollUntil(
    async () => {
      try {
        const listing = await page.bridge.evaluateWithLib(readAlerts, [listingWait()]);
        const row =
          'refused' in listing
            ? undefined
            : listing.alerts.find(({ id: rowId }) => rowId === wanted);
        return row !== undefined && (row.active === true || row.lastStopReason !== null);
      } catch (error) {
        if (isTvMcpError(error)) {
          return false;
        }
        throw error;
      }
    },
    (settled) => settled,
    { intervalMs: ACTIVATION_POLL_MS, timeoutMs: limitMs, now },
  );
  return { settled: result.satisfied, waitedMs: result.waitedMs };
}

export const alertList = defineTool({
  name: 'alert_list',
  domain: 'alert',
  title: 'List alerts',
  description:
    'Lists the alerts of the TradingView account, and changes nothing. Returns alerts, each ' +
    'with id, symbol (EXCHANGE:TICKER), kind (what the alert watches: price for the bars of ' +
    'the symbol, indicator for an indicator; another kind keeps the name TradingView gives it, ' +
    'and null when it cannot be read), condition (crossing, crossing_up, crossing_down, ' +
    'greater_than or less_than for a price or indicator alert; the name TradingView uses for ' +
    'any other condition), price (the price a price alert compares with; null for an alert ' +
    'that does not compare with a price), indicator (the indicator the condition names, as ' +
    'TradingView gives it, such as RSI@tv-basicstudies; null when it names none or does not ' +
    'say), value (the value an indicator alert compares the indicator with; null otherwise), ' +
    'message, status (active; triggered: it fired and stopped itself; or stopped), expiration ' +
    '(Unix seconds, with expirationIso; null when it never expires) and createdByServer ' +
    '(whether this session created it, so that deleting it needs no confirm).',
  inputSchema: {
    status: z
      .enum([...ALERT_STATUSES, 'all'])
      .default('all')
      .describe('Which alerts: active, stopped, triggered, or all (the default).'),
  },
  annotations: READ_ONLY,
  core: true,
  async handler({ status }, ctx) {
    const page = await ctx.connection.chartPage();
    const listing = await listAlerts(page, pageWaitMs(ctx.config.callTimeoutMs));
    const alerts = listing.alerts.map((row) => toAlertRecord(row, ctx.session.createdAlertIds));
    return {
      data: {
        alerts: status === 'all' ? alerts : alerts.filter((alert) => alert.status === status),
      },
      via: 'internal',
      warnings: listing.unreadable === 0 ? [] : [unreadableAlertsWarning(listing.unreadable)],
    };
  },
});

export const alertDelete = defineTool({
  name: 'alert_delete',
  domain: 'alert',
  title: 'Delete alerts',
  description:
    'Deletes alerts of the TradingView account by id, for good: TradingView has no undo for it. ' +
    `Give the ids from alert_list or alert_create, 1 to ${String(MAX_DELETE)} of them; there is ` +
    'no way to delete every alert at once. An id the account does not have fails with ' +
    'INVALID_INPUT (error.details.unknown lists them) and nothing is deleted. Alerts this ' +
    'session created with alert_create go without more ado; any other one is the ' +
    "user's and needs confirm: true, else the call fails with CONFIRMATION_REQUIRED and nothing " +
    'is deleted. Returns deleted, the ids TradingView no longer lists; one it still lists comes ' +
    'back as a warning.',
  inputSchema: {
    alertIds: z
      .array(z.string().regex(ALERT_ID))
      .min(1)
      .max(MAX_DELETE)
      .describe(
        `The ids of the alerts to delete, from alert_list or alert_create: 1 to ` +
          `${String(MAX_DELETE)} of them.`,
      ),
    confirm: z
      .boolean()
      .optional()
      .describe(
        "Must be true to delete an alert this session did not create, which was the user's. Not " +
          'needed for alerts made with alert_create in this session.',
      ),
  },
  annotations: DESTRUCTIVE,
  // Core creates alerts, which persist in the account, count against the plan and fire, so it can
  // delete them too.
  core: true,
  async handler({ alertIds, confirm }, ctx) {
    const ids = [...new Set(alertIds)];
    const page = await ctx.connection.chartPage();
    const waitMs = pageWaitMs(ctx.config.callTimeoutMs);
    const before = await listAlerts(page, waitMs);
    const known = new Set(before.alerts.map(({ id }) => String(id)));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new TvMcpError(
        'INVALID_INPUT',
        `The account has no ${unknown.length === 1 ? 'alert' : 'alerts'} ${listed(unknown)}`,
        {
          hint: 'Call alert_list for the ids of the alerts of the account. Nothing was deleted.',
          details: { unknown },
        },
      );
    }
    const foreign = ids.filter((id) => !ctx.session.createdAlertIds.has(id));
    if (foreign.length > 0 && confirm !== true) {
      const one = foreign.length === 1;
      throw new TvMcpError(
        'CONFIRMATION_REQUIRED',
        one
          ? `Deleting the alert ${listed(foreign)} needs confirmation: this session did not create it`
          : `Deleting the alerts ${listed(foreign)} needs confirmation: this session did not ` +
              'create them',
        {
          hint: one
            ? "The alert was in the account before, so it is the user's. Make sure the user " +
              'wants it gone, then call alert_delete again with confirm: true.'
            : "The alerts were in the account before, so they are the user's. Make sure the " +
              'user wants them gone, then call alert_delete again with confirm: true.',
          details: { ids: foreign },
        },
      );
    }
    const sent = await page.bridge.evaluateWithLib(deleteAlertsViaApi, [ids.map(Number), waitMs]);
    if ('refused' in sent) {
      throw refusalError(sent.refused, 'delete the alerts');
    }
    // What TradingView lists afterwards tells what went: the deletion answers nothing more.
    let remaining: Set<string>;
    try {
      const after = await listAlerts(page, waitMs);
      remaining = new Set(after.alerts.map(({ id }) => String(id)));
    } catch (error) {
      if (!isTvMcpError(error)) {
        throw error;
      }
      throw new TvMcpError(
        'NOT_AVAILABLE',
        `TradingView accepted the deletion of ${String(ids.length)} ` +
          `${ids.length === 1 ? 'alert' : 'alerts'}, but the alerts could not be listed ` +
          'afterwards to confirm it',
        { hint: 'Check alert_list.', details: { ids } },
      );
    }
    const deleted = ids.filter((id) => !remaining.has(id));
    const kept = ids.filter((id) => remaining.has(id));
    for (const id of deleted) {
      ctx.session.createdAlertIds.delete(id);
    }
    if (deleted.length === 0) {
      throw new TvMcpError(
        'NOT_AVAILABLE',
        `TradingView did not delete the ${ids.length === 1 ? 'alert' : 'alerts'} ${listed(ids)}`,
        { hint: 'Check alert_list, and try again.', details: { ids } },
      );
    }
    return {
      data: { deleted },
      via: 'internal',
      warnings: kept.length === 0 ? [] : [notDeletedWarning(kept)],
    };
  },
});

// In the order of the catalog (design spec 7).
export const alertTools: AnyToolDefinition[] = [alertCreate, alertList, alertDelete];
