// The two webpack modules of the app that hold the plan features, as the captured web build splits
// them (reverse-engineering notes, section 7): one exports ProductFeatures, the enum-like object
// from a feature name to its value, with ProductFeaturesEnum and UNLIMITED_FEATURE_LIMIT; the
// other exports getConfig, which answers for a feature value with an object whose limit is a
// number for a limited feature, with getProductFeaturesConfig and a few more. getConfig is a
// common export name, which is why the module is found by the pair of names. Values are synthetic.

// Features the enum knows although the fake plan sets no limit for them: getConfig throws for
// these, as it can for a value the plan does not configure.
const UNCONFIGURED_FEATURES = ['CHART_STORAGE', 'MULTIPLE_CHARTS'];

export const UNLIMITED_FEATURE_LIMIT = 99999;

export function createPlanLimitModules(
  limits: Readonly<Record<string, number>>,
): Record<string, Record<string, unknown>> {
  const names = [...Object.keys(limits), ...UNCONFIGURED_FEATURES];
  // A value is not the name, so that a reader of the fake cannot confuse the two.
  const productFeatures: Record<string, string> = {};
  for (const name of names) {
    productFeatures[name] = `pf:${name.toLowerCase()}`;
  }
  const limitOf = new Map(
    Object.entries(limits).map(([name, limit]) => [`pf:${name.toLowerCase()}`, limit]),
  );
  const getConfig = (value: unknown): { limit: number } => {
    const limit = typeof value === 'string' ? limitOf.get(value) : undefined;
    if (limit === undefined) {
      throw new Error(`No configuration for the product feature ${String(value)}`);
    }
    return { limit };
  };
  return {
    // Module IDs are arbitrary numbers, as in a production build.
    '40117': {
      ProductFeatures: productFeatures,
      ProductFeaturesEnum: productFeatures,
      UNLIMITED_FEATURE_LIMIT,
    },
    '58204': {
      getConfig,
      getProductFeaturesConfig: () => ({}),
      canUpgradePlan: () => false,
      enabled: () => true,
    },
  };
}

// The module of the feature toggles of the app (reverse-engineering notes of Plan 2, section Q1):
// isFeatureEnabled(name) answers whether a toggle is on, and onFeaturesStateChanged hands out the
// delegate that fires when one changes. The app also puts isFeatureEnabled on window.TradingView.
// A toggle the fixture does not list is off.
export function createFeatureToggleModules(
  toggles: Readonly<Record<string, boolean>>,
): Record<string, Record<string, unknown>> {
  return {
    // Module IDs are arbitrary numbers, as in a production build.
    '60412': {
      isFeatureEnabled: (name: unknown) => typeof name === 'string' && toggles[name] === true,
      onFeaturesStateChanged: () => ({ subscribe: () => undefined }),
    },
  };
}
