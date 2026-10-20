import {
  loadTvFixture,
  parseTvStateFixture,
  type FixtureStudy,
  type TvStateFixture,
} from '../../helpers/fake-tv/fixture.js';
import { createFakeTvWindow, type FakeTvWindow } from '../../helpers/fake-tv/window.js';
import {
  SAMPLE_FILLS,
  SAMPLE_PERFORMANCE,
  SAMPLE_STRATEGY,
  SAMPLE_TRADES,
  SECOND_STRATEGY,
  strategyWith,
  withStudies,
} from '../../helpers/strategy-fixtures.js';

// The reports of strategies in the fake app (strategy.ts), checked against the shapes the
// reverse-engineering notes of Plan 2 record for the app (section Q6): the members of the study
// core of a strategy, the raw keys of its report, and the active strategy source of the core model.
// Values are synthetic.

const fixture = loadTvFixture();

function chartOf(win: FakeTvWindow) {
  const api = win.TradingViewApi;
  if (api === undefined) {
    throw new Error('The fake window has no TradingViewApi');
  }
  return api.activeChart();
}

const coreModelOf = (win: FakeTvWindow) => chartOf(win)._chartWidget.model().model();

function strategyCore(from: TvStateFixture, id = 'STRAT01') {
  return chartOf(createFakeTvWindow(from)).getStudyById(id).study();
}

describe('the report of a strategy', () => {
  const withSample = withStudies(fixture, SAMPLE_STRATEGY);

  test('reportData answers the raw keys of the report the notes record', () => {
    const report = strategyCore(withSample).reportData?.();

    expect(report).toStrictEqual({
      currency: 'USD',
      position: { price: 0, qty: 0, openPL: 0 },
      activeOrders: [],
      performance: SAMPLE_PERFORMANCE,
      trades: SAMPLE_TRADES,
      // The abbreviated keys of the app, without the bar index, and with the position as tm. A key
      // the sample leaves out is not there.
      filledOrders: [
        { id: 'Long', b: true, e: true, p: 100, q: 10, tm: 0 },
        { id: 'Exit long', b: false, e: false, p: 110, q: 10, c: 'Take profit', tm: 1 },
        { id: 'Short', b: false, p: 120, q: 10, tm: 2 },
        { id: 'Exit short', b: true, e: false, p: 125, q: 10, tm: 3 },
        { id: 'Long', b: true, p: 105, q: 10, tm: 4 },
        { id: 'Exit long', b: false, e: false, p: 115.5, q: 10, tm: 5 },
        { id: 'Long', b: true, p: 130, q: 10, c: 'Breakout', tm: 6 },
      ],
    });
  });

  test('ordersData answers the filled orders of the report, and barsIndexes their bar indexes', () => {
    const core = strategyCore(withSample);

    expect(core.ordersData?.()).toStrictEqual(core.reportData?.()?.filledOrders);
    expect(core.barsIndexes?.()).toEqual(SAMPLE_FILLS.map(({ barIndex }) => barIndex));
    // barsIndexes[i] = indexes[filledOrders[i].tm]: tm is the position in the indexes.
    const indexes = core.barsIndexes?.() ?? [];
    for (const [position, order] of (core.ordersData?.() ?? []).entries()) {
      expect(order.tm).toBe(position);
      expect(indexes[order.tm]).toBe(SAMPLE_FILLS[position]?.barIndex);
    }
  });

  test('every read answers a copy, as what a page does to it stays in the page', () => {
    const core = strategyCore(withSample);

    const first = core.reportData?.();
    Object.assign(first ?? {}, { currency: 'EUR' });
    (first?.filledOrders ?? []).length = 0;
    core.barsIndexes?.().push(999);

    expect(core.reportData?.()?.currency).toBe('USD');
    expect(core.reportData?.()?.filledOrders).toHaveLength(SAMPLE_FILLS.length);
    expect(core.barsIndexes?.()).toHaveLength(SAMPLE_FILLS.length);
  });

  test('a strategy with no report has none yet: null, and no orders', () => {
    const core = strategyCore(withStudies(fixture, { ...SAMPLE_STRATEGY, report: undefined }));

    expect(core.reportData?.()).toBeNull();
    expect(core.ordersData?.()).toBeNull();
    expect(core.barsIndexes?.()).toEqual([]);
  });

  test('a report keeps out the members it lacks', () => {
    const core = strategyCore(
      withStudies(
        fixture,
        strategyWith({ performance: undefined, trades: undefined, filledOrders: undefined }),
      ),
    );

    const report = core.reportData?.();

    expect(report).toStrictEqual({
      currency: 'USD',
      position: { price: 0, qty: 0, openPL: 0 },
      activeOrders: [],
    });
    expect(core.ordersData?.()).toBeNull();
    expect(core.barsIndexes?.()).toEqual([]);
  });

  test('a report can hold trades of any shape, or none at all', () => {
    for (const trades of [[], [{ foo: 1 }], null, 5, 'many']) {
      const core = strategyCore(withStudies(fixture, strategyWith({ trades })));

      expect(core.reportData?.()).toHaveProperty('trades', trades);
    }
  });

  test('a strategy carries the members the duck test of the app looks for', () => {
    const core = strategyCore(withSample);

    expect(core.isStudyStrategy).toBe(true);
    expect(
      ['strategyOrdersPaneView', 'ordersData', 'reportData', 'barsIndexes'].every(
        (key) => key in core,
      ),
    ).toBe(true);
    expect(core.strategyOrdersPaneView?.()).toBeNull();
  });

  test('an indicator has none of the members of a strategy', () => {
    const core = chartOf(createFakeTvWindow(withSample)).getStudyById('STUDY01').study();

    for (const key of [
      'isStudyStrategy',
      'strategyOrdersPaneView',
      'ordersData',
      'reportData',
      'barsIndexes',
    ]) {
      expect(core, key).not.toHaveProperty(key);
    }
  });

  test('the report of a study that is not a strategy is not modelled', () => {
    const notStrategy: FixtureStudy = { ...SAMPLE_STRATEGY, strategy: undefined };
    const core = strategyCore(withStudies(fixture, notStrategy));

    expect(core).not.toHaveProperty('reportData');
  });
});

describe('the initial capital input of a strategy', () => {
  test('carries the internal id the app gives it, in the inputs and in the metadata', () => {
    const study = chartOf(createFakeTvWindow(withStudies(fixture, SAMPLE_STRATEGY))).getStudyById(
      'STRAT01',
    );

    const info = study.getInputsInfo().find(({ id }) => id === 'in_1');

    expect(info).toMatchObject({ id: 'in_1', internalID: 'initial_capital', type: 'float' });
    expect(
      study
        .study()
        .metaInfo()
        .inputs.find(({ id }) => id === 'in_1'),
    ).toMatchObject({
      internalID: 'initial_capital',
    });
    expect(study.getInputValues().find(({ id }) => id === 'in_1')).toEqual({
      id: 'in_1',
      value: 10_000,
    });
    // An input without one has none, instead of an undefined member.
    expect(study.getInputsInfo().find(({ id }) => id === 'in_0')).not.toHaveProperty('internalID');
  });
});

describe('the active strategy source of the core model', () => {
  const two = withStudies(fixture, SAMPLE_STRATEGY, SECOND_STRATEGY);

  test('is empty unless a strategy is flagged active, on every chart, strategies or none', () => {
    for (const from of [fixture, withStudies(fixture, SAMPLE_STRATEGY), two]) {
      expect(coreModelOf(createFakeTvWindow(from)).activeStrategySource().value()).toBeNull();
    }
  });

  test('answers the core of the strategy flagged active, the same object the study API gives', () => {
    const win = createFakeTvWindow(
      withStudies(fixture, SAMPLE_STRATEGY, { ...SECOND_STRATEGY, activeStrategy: true }),
    );

    const active = coreModelOf(win).activeStrategySource().value();

    expect(active).toBe(chartOf(win).getStudyById('STRAT02').study());
    expect(active?.id()).toBe('STRAT02');
  });

  test('counts only the first strategy flagged, and no study that is not a strategy', () => {
    const win = createFakeTvWindow(
      withStudies(
        {
          ...fixture,
          studies: fixture.studies.map((study) => ({ ...study, activeStrategy: true })),
        },
        { ...SAMPLE_STRATEGY, activeStrategy: true },
        { ...SECOND_STRATEGY, activeStrategy: true },
      ),
    );

    expect(coreModelOf(win).activeStrategySource().value()?.id()).toBe('STRAT01');
  });

  test('follows the strategy being removed from the chart', () => {
    const win = createFakeTvWindow(
      withStudies(fixture, { ...SAMPLE_STRATEGY, activeStrategy: true }),
    );
    expect(coreModelOf(win).activeStrategySource().value()?.id()).toBe('STRAT01');

    chartOf(win).removeEntity('STRAT01');

    expect(coreModelOf(win).activeStrategySource().value()).toBeNull();
  });
});

describe('the fixture of a strategy', () => {
  // The fixture as JSON text would carry it.
  const asJson = (from: TvStateFixture): unknown => JSON.parse(JSON.stringify(from));

  test('is read from JSON with its report, its active flag and the internal id of an input', () => {
    const staged = withStudies(fixture, { ...SAMPLE_STRATEGY, activeStrategy: true });

    const parsed = parseTvStateFixture(asJson(staged));

    expect(parsed.studies.at(-1)).toEqual({ ...SAMPLE_STRATEGY, activeStrategy: true });
  });

  test('refuses a member of a report it does not know, so a recording cannot slip one past', () => {
    const staged = asJson(withStudies(fixture, SAMPLE_STRATEGY)) as {
      studies: { report?: Record<string, unknown> }[];
    };
    const report = staged.studies.at(-1)?.report;
    if (report === undefined) {
      throw new Error('The staged strategy has no report');
    }
    report.surprise = 1;

    expect(() => parseTvStateFixture(staged)).toThrow(/surprise/);
  });

  test('refuses a filled order that lacks a field, or has one it does not know', () => {
    for (const change of [
      (order: Record<string, unknown>) => Reflect.deleteProperty(order, 'barIndex'),
      (order: Record<string, unknown>) => Object.assign(order, { tm: 1 }),
    ]) {
      const staged = asJson(withStudies(fixture, SAMPLE_STRATEGY)) as {
        studies: { report?: { filledOrders?: Record<string, unknown>[] } }[];
      };
      const order = staged.studies.at(-1)?.report?.filledOrders?.[0];
      if (order === undefined) {
        throw new Error('The staged strategy has no filled order');
      }
      change(order);

      expect(() => parseTvStateFixture(staged)).toThrow(/filledOrders/);
    }
  });
});
