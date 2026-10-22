// The two webpack modules of the app that hold the plan features, as the captured web build splits
// them (reverse-engineering notes, section 7): one exports ProductFeatures, the enum-like object
// from a feature name to its value, with ProductFeaturesEnum and UNLIMITED_FEATURE_LIMIT; the
// other exports getConfig, which answers for a feature value with the configuration the plan holds
// for it, an object whose limit is a number for a limited feature, with getProductFeaturesConfig,
// enabled and a few more. getConfig is a common export name, which is why the module is found by
// the pair of names. Values are synthetic.
//
// A configuration is the limit of the feature together with its other fields (the configs, such as
// primitive_limit and overall_limit of SERVER_SIDE_ALERTS). enabled(value) answers whether the plan
// configures the feature at all, which is how the app tells a feature that is on or off, such as
// ALERTS_ON_SECONDS (the app also turns some off on trials and lite plans, which the fake does not
// model).

// Features the enum knows although the fake plan sets no limit for them: getConfig throws for
// these, as it can for a value the plan does not configure, and enabled() is false for them.
const UNCONFIGURED_FEATURES = [
  'CHART_STORAGE',
  'MULTIPLE_CHARTS',
  'ALERTS_ON_SECONDS',
  'ALERTS_NO_EXPIRATION',
  'ALERTS_WEBHOOK',
];

export const UNLIMITED_FEATURE_LIMIT = 99999;

export function createPlanLimitModules(
  limits: Readonly<Record<string, number>>,
  configs: Readonly<Record<string, Readonly<Record<string, number>>>> = {},
): Record<string, Record<string, unknown>> {
  const names = [
    ...new Set([...Object.keys(limits), ...Object.keys(configs), ...UNCONFIGURED_FEATURES]),
  ];
  // A value is not the name, so that a reader of the fake cannot confuse the two.
  const valueOf = (name: string): string => `pf:${name.toLowerCase()}`;
  const productFeatures: Record<string, string> = {};
  for (const name of names) {
    productFeatures[name] = valueOf(name);
  }
  const configOf = new Map<string, Record<string, number>>();
  for (const name of names) {
    const limit = limits[name];
    const config = configs[name];
    if (limit !== undefined || config !== undefined) {
      configOf.set(valueOf(name), { ...(limit === undefined ? {} : { limit }), ...config });
    }
  }
  const getConfig = (value: unknown): Record<string, number> => {
    const config = typeof value === 'string' ? configOf.get(value) : undefined;
    if (config === undefined) {
      throw new Error(`No configuration for the product feature ${String(value)}`);
    }
    return { ...config };
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
      enabled: (value: unknown) => typeof value === 'string' && configOf.has(value),
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
