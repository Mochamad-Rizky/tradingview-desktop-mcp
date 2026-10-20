import { PlanLimitError, TvMcpError } from '../../../../src/core/errors.js';
import { createPageBridge } from '../../../../src/core/tv/page-bridge.js';
import { createPageLib } from '../../../../src/core/tv/page-lib.js';
import {
  getPlanLimits,
  inPlanLimitedTurn,
  PLAN_FEATURES,
  readPlanLimits,
  requireBelowLimit,
  unreadableLimitError,
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

  test('passes any count under the unlimited value of the app', () => {
    expect(() => {
      requireBelowLimit('INDICATORS_ON_CHART', 500, 99999, 'hint');
    }).not.toThrow();
  });

  test.each([
    ['the limit is unknown', 1, null],
    ['the limit is not reported', 1, undefined],
    ['the count is unknown', null, 2],
  ] as const)('fails NOT_AVAILABLE, naming the feature, when %s', (_case, used, limit) => {
    let thrown: unknown;
    try {
      requireBelowLimit('INDICATORS_ON_CHART', used, limit, 'Remove an indicator first.');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TvMcpError);
    expect((thrown as TvMcpError).toPayload()).toEqual({
      code: 'NOT_AVAILABLE',
      message: expect.stringContaining('INDICATORS_ON_CHART') as string,
      hint: expect.stringMatching(
        /cannot be read on this TradingView build.*TradingView itself/,
      ) as string,
      details: { feature: 'INDICATORS_ON_CHART' },
    });
  });
});

test('unreadableLimitError says the limit cannot be read and that TradingView itself can do it', () => {
  expect(unreadableLimitError('SAVED_PINE_SCRIPTS').toPayload()).toEqual({
    code: 'NOT_AVAILABLE',
    message: expect.stringContaining('SAVED_PINE_SCRIPTS') as string,
    hint: expect.stringMatching(
      /cannot be read on this TradingView build.*TradingView itself/,
    ) as string,
    details: { feature: 'SAVED_PINE_SCRIPTS' },
  });
});

describe('inPlanLimitedTurn', () => {
  test('runs one action at a time, in the order they came, each to its end', async () => {
    const steps: string[] = [];
    const action = (name: string, ms: number) => async () => {
      steps.push(`${name} starts`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      steps.push(`${name} ends`);
      return name;
    };

    const results = await Promise.all([
      inPlanLimitedTurn(action('first', 30)),
      inPlanLimitedTurn(action('second', 1)),
      inPlanLimitedTurn(action('third', 1)),
    ]);

    expect(results).toEqual(['first', 'second', 'third']);
    expect(steps).toEqual([
      'first starts',
      'first ends',
      'second starts',
      'second ends',
      'third starts',
      'third ends',
    ]);
  });

  test('passes on the failure of an action, and the next action still gets its turn', async () => {
    const failure = new Error('the add failed');

    const failed = inPlanLimitedTurn(() => Promise.reject(failure));
    const next = inPlanLimitedTurn(() => Promise.resolve('next'));

    await expect(failed).rejects.toBe(failure);
    await expect(next).resolves.toBe('next');
  });
});
