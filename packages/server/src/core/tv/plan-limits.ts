import { PlanLimitError, TvMcpError } from '../errors.js';
import type { PageHandle } from '../connection.js';
import type { PageLib } from './page-lib.js';
import type { TvWindow } from './tv-window.js';

// What the plan of the signed-in account allows, as the app itself reports it (reverse-engineering
// notes, section 7). The tools check a limit before they act, so that they fail with PLAN_LIMIT
// instead of letting TradingView open a paywall dialog, and a limit they cannot read stops them as
// well; none of them works around a limit.

// The plan features the tools check or report. The names are those of the ProductFeatures enum of
// the app.
export const PLAN_FEATURES = [
  'INDICATORS_ON_CHART',
  'SAVED_PINE_SCRIPTS',
  'CHART_STORAGE',
  'MULTIPLE_CHARTS',
  'SERVER_SIDE_ALERTS',
  'WATCHLIST_SYMBOLS',
  'STUDY_TEMPLATES',
  'HISTORICAL_BARS',
] as const;

export type PlanFeature = (typeof PLAN_FEATURES)[number];

// A page function (see page-bridge.ts), so it uses nothing of this module. The limits come from
// two modules of the app, found by the names of their exports: one exports ProductFeatures, an
// object from a feature name to its value, and the other getConfig, which answers for such a value
// with an object whose limit is a number for a limited feature. getConfig is a common export name,
// so the second module is found by it together with getProductFeaturesConfig. Both lookups come
// before any feature is read.
//
// A feature the app does not know, a getConfig that throws for it, and a limit that is not a
// number all give null, and so does every feature when a module is not loaded: the answer is
// "not known", never a guess. It changes nothing in the app.
export function readPlanLimits(
  _win: TvWindow,
  lib: PageLib,
  features: string[],
): Record<string, number | null> {
  const productFeatures = lib.findExport('ProductFeatures');
  const configModule = lib.findModuleWith(['getConfig', 'getProductFeaturesConfig']);
  const limits: Record<string, number | null> = {};
  for (const feature of features) {
    limits[feature] = null;
    try {
      if (
        typeof productFeatures !== 'object' ||
        productFeatures === null ||
        configModule === null
      ) {
        continue;
      }
      const value = (productFeatures as Record<string, unknown>)[feature];
      const getConfig = configModule.getConfig;
      if (value === undefined || typeof getConfig !== 'function') {
        continue;
      }
      const config = (getConfig as (value: unknown) => unknown).call(configModule, value);
      const limit =
        typeof config === 'object' && config !== null
          ? (config as Record<string, unknown>).limit
          : undefined;
      if (typeof limit === 'number' && Number.isFinite(limit)) {
        limits[feature] = limit;
      }
    } catch {
      // getConfig throws for a value it has no configuration for: no limit is known.
    }
  }
  return limits;
}

// The limits of the plan for `features`, null for one the app does not report.
export async function getPlanLimits(
  page: PageHandle,
  features: readonly PlanFeature[],
): Promise<Partial<Record<PlanFeature, number | null>>> {
  return page.bridge.evaluateWithLib(readPlanLimits, [[...features]]);
}

// The actions that use up a plan limit (adding a study, adding a script to the chart, saving a
// script) take turns within the process, each from its check of the limit to its end: tool calls
// run concurrently (several calls of one client, several HTTP sessions), and two that checked the
// same free slot would both act, the second one into the check of the app and its paywall. The
// turn after a failed action still comes. A turn is not re-entrant: an action that started another
// one would wait for itself, so none does.
let planLimitedTurns: Promise<void> = Promise.resolve();

export function inPlanLimitedTurn<T>(action: () => Promise<T>): Promise<T> {
  const turn = planLimitedTurns.then(action);
  planLimitedTurns = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}

// The error of a tool that cannot tell whether a plan limit leaves room for what it would do. It
// does not act then: TradingView would check the limit itself, and its check opens a paywall or a
// limit dialog when the limit is reached.
export function unreadableLimitError(feature: PlanFeature): TvMcpError {
  return new TvMcpError(
    'NOT_AVAILABLE',
    `The plan limit ${feature} cannot be checked on this TradingView build, so nothing was done`,
    {
      hint:
        'The plan limit cannot be read on this TradingView build, and TradingView would check it ' +
        'with a dialog of its own: do this in TradingView itself.',
      details: { feature },
    },
  );
}

// Fails with PLAN_LIMIT when `used` has reached `limit`, and with NOT_AVAILABLE when either is not
// known (unreadableLimitError): a tool never acts on a limit it could not read. A limit at the
// unlimited value of the app (99999) leaves room for any count. `hint` says what the caller can do
// about a reached limit.
export function requireBelowLimit(
  feature: PlanFeature,
  used: number | null,
  limit: number | null | undefined,
  hint: string,
): void {
  if (used === null || typeof limit !== 'number') {
    throw unreadableLimitError(feature);
  }
  if (used >= limit) {
    throw new PlanLimitError(
      feature,
      limit,
      `Plan limit reached for ${feature}: the plan allows ${String(limit)} and ${String(used)} ` +
        'are in use',
      hint,
    );
  }
}
