import { PlanLimitError } from '../../../../src/core/errors.js';
import { createPageBridge } from '../../../../src/core/tv/page-bridge.js';
import { createPageLib } from '../../../../src/core/tv/page-lib.js';
import {
  getPlanLimits,
  PLAN_FEATURES,
  readPlanLimits,
  requireBelowLimit,
} from '../../../../src/core/tv/plan-limits.js';
import type { TvWindow } from '../../../../src/core/tv/tv-window.js';
import { createPageRuntime } from '../../../helpers/fake-cdp/runtime.js';
import { loadTvFixture } from '../../../helpers/fake-tv/fixture.js';
import { createPlanLimitModules } from '../../../helpers/fake-tv/plan-limits.js';
import { createFakeTvWindow } from '../../../helpers/fake-tv/window.js';
import type { CdpSession } from '../../../../src/core/cdp/types.js';
import type { PageHandle } from '../../../../src/core/connection.js';

// readPlanLimits is called directly, which is what the coverage of the module measures, and run
// as source text in a page through getPlanLimits, where a function that leans on anything of its
// module would fail. The limits are synthetic.

const fixture = loadTvFixture();

function libOf(overrides: Parameters<typeof createFakeTvWindow>[1] = {}) {
  const win = createFakeTvWindow(fixture, overrides) as unknown as TvWindow;
  return { win, lib: createPageLib(win) };
}

describe('readPlanLimits', () => {
  test('reads limits through ProductFeatures and getConfig', () => {
    const { win, lib } = libOf();

    expect(readPlanLimits(win, lib, ['INDICATORS_ON_CHART'])).toEqual({ INDICATORS_ON_CHART: 2 });
  });

  test('reports null for unknown features', () => {
    const { win, lib } = libOf();

    expect(
      readPlanLimits(win, lib, [
        'SAVED_PINE_SCRIPTS',
        // Not an enum member.
        'NO_SUCH_FEATURE',
        // An enum member getConfig throws for.
        'CHART_STORAGE',
      ]),
    ).toEqual({ SAVED_PINE_SCRIPTS: 1, NO_SUCH_FEATURE: null, CHART_STORAGE: null });
  });

  test('reports null for every feature when the modules are missing', () => {
    for (const overrides of [{ webpackModules: {} }, { withoutWebpackRuntime: true }]) {
      const { win, lib } = libOf(overrides);

      expect(readPlanLimits(win, lib, ['INDICATORS_ON_CHART', 'SAVED_PINE_SCRIPTS'])).toEqual({
        INDICATORS_ON_CHART: null,
        SAVED_PINE_SCRIPTS: null,
      });
    }
  });

  test('reports null when only one of the two modules is there', () => {
    const [features, config] = Object.values(createPlanLimitModules({ INDICATORS_ON_CHART: 2 }));
    for (const modules of [{ 1: features ?? {} }, { 1: config ?? {} }]) {
      const { win, lib } = libOf({ webpackModules: modules });

      expect(readPlanLimits(win, lib, ['INDICATORS_ON_CHART'])).toEqual({
        INDICATORS_ON_CHART: null,
      });
    }
  });

  test('finds getConfig by the pair of names, not by the common name alone', () => {
    // Another module exports a getConfig of its own and comes first in the cache.
    const modules = {
      1: { getConfig: () => ({ limit: 7 }) },
      ...createPlanLimitModules({ INDICATORS_ON_CHART: 2 }),
    };
    const { win, lib } = libOf({ webpackModules: modules });

    expect(readPlanLimits(win, lib, ['INDICATORS_ON_CHART'])).toEqual({ INDICATORS_ON_CHART: 2 });
  });

  test('reports null for a limit that is not a number, and for a config that throws', () => {
    const modules = {
      1: { ProductFeatures: { A: 'a', B: 'b', C: 'c' } },
      2: {
        getProductFeaturesConfig: () => ({}),
        getConfig: (value: string) => {
          if (value === 'a') {
            return { limit: '3' };
          }
          if (value === 'b') {
            return null;
          }
          throw new Error('boom');
        },
      },
    };
    const { win, lib } = libOf({ webpackModules: modules });

    expect(readPlanLimits(win, lib, ['A', 'B', 'C'])).toEqual({ A: null, B: null, C: null });
  });
});

describe('getPlanLimits', () => {
  function pageOn(win: object): PageHandle {
    const runtime = createPageRuntime(win);
    const session: CdpSession = {
      targetId: 'PAGE1',
      isClosed: false,
      send: (method: string, params?: unknown) =>
        method === 'Runtime.evaluate'
          ? runtime.evaluate(params as Record<string, unknown>)
          : Promise.reject(new Error(`Unexpected command ${method}`)),
      onClose: () => undefined,
      close: () => Promise.resolve(),
    };
    const bridge = createPageBridge(session, { timeoutMs: 1000 });
    return { target: { id: 'PAGE1' }, session, bridge } as unknown as PageHandle;
  }

  test('runs in the page and answers the limits asked for', async () => {
    const win = createFakeTvWindow(fixture);

    const limits = await getPlanLimits(pageOn(win), ['INDICATORS_ON_CHART', 'HISTORICAL_BARS']);

    expect(limits).toEqual({ INDICATORS_ON_CHART: 2, HISTORICAL_BARS: null });
  });
});

describe('PLAN_FEATURES', () => {
  test('lists the features the tools check', () => {
    expect([...PLAN_FEATURES]).toEqual([
      'INDICATORS_ON_CHART',
      'SAVED_PINE_SCRIPTS',
      'CHART_STORAGE',
      'MULTIPLE_CHARTS',
      'SERVER_SIDE_ALERTS',
      'WATCHLIST_SYMBOLS',
      'STUDY_TEMPLATES',
      'HISTORICAL_BARS',
    ]);
  });
});

describe('requireBelowLimit', () => {
  test('throws PLAN_LIMIT with feature and limit at the limit', () => {
    let thrown: unknown;
    try {
      requireBelowLimit('INDICATORS_ON_CHART', 2, 2, 'Remove an indicator first.');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PlanLimitError);
    expect((thrown as PlanLimitError).toPayload()).toEqual({
      code: 'PLAN_LIMIT',
      message: expect.stringContaining('INDICATORS_ON_CHART') as string,
      details: { feature: 'INDICATORS_ON_CHART', limit: 2 },
      hint: 'Remove an indicator first.',
    });
    expect((thrown as PlanLimitError).message).toMatch(/plan allows 2/);
  });

  test('throws above the limit as well', () => {
    expect(() => {
      requireBelowLimit('SAVED_PINE_SCRIPTS', 3, 1, 'hint');
    }).toThrow(PlanLimitError);
  });

  test('passes below the limit', () => {
    expect(() => {
      requireBelowLimit('INDICATORS_ON_CHART', 1, 2, 'hint');
    }).not.toThrow();
  });

  test('passes when the limit is unknown', () => {
    expect(() => {
      requireBelowLimit('INDICATORS_ON_CHART', 50, null, 'hint');
    }).not.toThrow();
    expect(() => {
      requireBelowLimit('INDICATORS_ON_CHART', 50, undefined, 'hint');
    }).not.toThrow();
  });
});
