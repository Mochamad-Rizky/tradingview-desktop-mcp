import { PlanLimitError } from '../errors.js';
import type { PageHandle } from '../connection.js';
import type { PageLib } from './page-lib.js';
import type { TvWindow } from './tv-window.js';

// What the plan of the signed-in account allows, as the app itself reports it (reverse-engineering
// notes, section 7). The tools check a limit before they act, so that they fail with PLAN_LIMIT
// instead of letting TradingView open a paywall dialog; none of them works around a limit.

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

// Fails with PLAN_LIMIT when `used` has reached `limit`. An unknown limit passes: the app then
// applies its own check, which is the last word. `hint` says what the caller can do about it.
export function requireBelowLimit(
  feature: PlanFeature,
  used: number,
  limit: number | null | undefined,
  hint: string,
): void {
  if (typeof limit === 'number' && used >= limit) {
    throw new PlanLimitError(
      feature,
      limit,
      `Plan limit reached for ${feature}: the plan allows ${String(limit)} and ${String(used)} ` +
        'are in use',
      hint,
    );
  }
}
