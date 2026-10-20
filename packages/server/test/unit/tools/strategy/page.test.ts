import type { CdpSession } from '../../../../src/core/cdp/types.js';
import type { TvMcpError } from '../../../../src/core/errors.js';
import {
  createPageBridge,
  type PageBridge,
  type PageFunction,
} from '../../../../src/core/tv/page-bridge.js';
import type { TvWindow } from '../../../../src/core/tv/tv-window.js';
import { readStrategyReport } from '../../../../src/tools/strategy/page.js';
import type { JsonValue } from '../../../../src/utils/json.js';
import { failureOf } from '../../../helpers/failure-of.js';
import { createPageRuntime } from '../../../helpers/fake-cdp/runtime.js';
import { loadTvFixture, type TvStateFixture } from '../../../helpers/fake-tv/fixture.js';
import { createFakeTvWindow, type FakeTvOverrides } from '../../../helpers/fake-tv/window.js';
import {
  barTime,
  SAMPLE_REPORT,
  SAMPLE_STRATEGY,
  SECOND_STRATEGY,
  strategyWith,
  withStudies,
} from '../../../helpers/strategy-fixtures.js';

// The page function that reads the report of a strategy, run the way the server runs it, as source
// text in a page through the real page bridge, and called directly on a second window built the
// same way, which is what the coverage of the module measures. The two answers must agree. Values
// are synthetic.

const fixture = loadTvFixture();
const sample = withStudies(fixture, SAMPLE_STRATEGY);

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
});

function bridgeTo(win: object): PageBridge {
  const runtime = createPageRuntime(win);
  disposers.push(() => {
    runtime.dispose();
  });
  const send = (method: string, params?: unknown): Promise<unknown> =>
    method === 'Runtime.evaluate'
      ? runtime.evaluate(params as Record<string, unknown>)
      : Promise.reject(new Error(`Unexpected command ${method}`));
  const session: CdpSession = {
    targetId: 'PAGE1',
    isClosed: false,
    send: send as CdpSession['send'],
    onClose: () => undefined,
    close: () => Promise.resolve(),
  };
  return createPageBridge(session, { timeoutMs: 5000 });
}

type Make = () => object;

const chart =
  (from: TvStateFixture = sample, overrides: FakeTvOverrides = {}): Make =>
  () =>
    createFakeTvWindow(from, overrides);

const plain =
  (win: object): Make =>
  () =>
    win;

async function resultOf<A extends JsonValue[], R extends JsonValue | null>(
  fn: PageFunction<A, R>,
  args: A,
  make: Make,
): Promise<R> {
  const result = await bridgeTo(make()).evaluate(fn, args);
  const direct = await fn(make() as TvWindow, ...args);
  expect(direct).toEqual(result);
  return result;
}

async function failureOfBoth<A extends JsonValue[], R extends JsonValue | null>(
  fn: PageFunction<A, R>,
  args: A,
  make: Make,
): Promise<TvMcpError> {
  const error = await failureOf(bridgeTo(make()).evaluate(fn, args));
  const direct = await fn(make() as TvWindow, ...args);
  expect(direct).toEqual({ __tvmcpError: error.toPayload() });
  return error;
}

// The arguments: the chart index (null for the active chart), the study id (null for the choice of
// the page), and the part of the report to read.
type Part = 'results' | 'trades';
const read = (make: Make, studyId: string | null = null, part: Part = 'results') =>
  resultOf(readStrategyReport, [null, studyId, part], make);
const fail = (make: Make, studyId: string | null = null, part: Part = 'results') =>
  failureOfBoth(readStrategyReport, [null, studyId, part], make);

// A page whose chart lists `cores` (in the order of the keys) and whose core model answers them by
// id, with the study API, bars and active strategy source the spec gives. Nothing else of the app
// is there.
interface Wiring {
  // The value of activeStrategySource(); the member is missing when this is not given.
  active?: unknown;
  // The study API by id, as the chart API gives it.
  apis?: Record<string, unknown>;
  bars?: unknown;
  names?: Record<string, string>;
}

function withCores(cores: Record<string, unknown>, wiring: Wiring = {}): Make {
  const core = {
    getStudyById: (id: string) => cores[id] ?? null,
    ...('active' in wiring ? { activeStrategySource: () => ({ value: () => wiring.active }) } : {}),
  };
  return plain({
    TradingViewApi: {
      activeChart: () => ({
        getAllStudies: () =>
          Object.keys(cores).map((id) => ({ id, name: wiring.names?.[id] ?? `Name of ${id}` })),
        getStudyById: (id: string) => wiring.apis?.[id],
        _chartWidget: {
          model: () => ({
            mainSeries: () => ({ bars: () => wiring.bars ?? {} }),
            model: () => core,
          }),
        },
      }),
    },
  });
}

// A strategy core whose report is `report`.
const strategyCore = (report: unknown, more: object = {}) => ({
  isStudyStrategy: true,
  reportData: () => report,
  ...more,
});

const NO_PERFORMANCE = { all: {}, long: {}, short: {} };

// What the page reads of the sample strategy: the performance of the part 'results'.
const SAMPLE_RESULTS = {
  strategy: { id: 'STRAT01', name: 'RSI Strategy' },
  currency: 'USD',
  initialCapital: 10_000,
  performance: {
    all: {
      // Next to all, long and short in the report.
      buyHoldReturn: -120.5,
      initialCapital: 10_000,
      netProfit: 155,
      netProfitPercent: 1.55,
      // A numeric string.
      grossProfit: 205,
      grossLoss: -50,
      openPL: -20,
      totalTrades: 3,
      totalOpenTrades: 1,
      numberOfWiningTrades: 2,
      numberOfLosingTrades: 1,
      percentProfitable: 66.67,
      avgLosTrade: -50,
      profitFactor: 4.1,
      maxStrategyDrawDown: 60,
    },
    long: { netProfit: 205, totalTrades: 2, numberOfWiningTrades: 2, percentProfitable: 100 },
    short: {
      netProfit: -50,
      totalTrades: 1,
      numberOfWiningTrades: 0,
      numberOfLosingTrades: 1,
      percentProfitable: 0,
    },
  },
  trades: null,
  fills: [],
};

const NO_CHART: [string, Make][] = [
  ['a page without TradingViewApi', plain({})],
  ['a page whose app has not booted', chart(sample, { withoutApi: true })],
  [
    'a page whose activeChart throws',
    plain({
      TradingViewApi: {
        activeChart: () => {
          throw new Error('No chart is active');
        },
      },
    }),
  ],
  ['a chart without getAllStudies', plain({ TradingViewApi: { activeChart: () => ({}) } })],
];

describe('readStrategyReport', () => {
  describe('choosing the strategy', () => {
    test('reads the only strategy on the chart when no id is given', async () => {
      expect(await read(chart())).toStrictEqual(SAMPLE_RESULTS);
    });

    test('reads the strategy of the id it is given, whichever others there are', async () => {
      const two = withStudies(fixture, SAMPLE_STRATEGY, SECOND_STRATEGY);

      const result = await read(chart(two), 'STRAT02');

      expect(result).toMatchObject({
        strategy: { id: 'STRAT02', name: 'MACD Strategy' },
        initialCapital: 5000,
        performance: { all: { initialCapital: 5000, netProfit: 25, totalTrades: 2 } },
      });
    });

    test('reads the active strategy when several are on the chart, and no id is given', async () => {
      const two = withStudies(fixture, SAMPLE_STRATEGY, {
        ...SECOND_STRATEGY,
        activeStrategy: true,
      });

      expect(await read(chart(two))).toMatchObject({ strategy: { id: 'STRAT02' } });
    });

    test('prefers the id it is given to the active strategy', async () => {
      const two = withStudies(fixture, SAMPLE_STRATEGY, {
        ...SECOND_STRATEGY,
        activeStrategy: true,
      });

      expect(await read(chart(two), 'STRAT01')).toMatchObject({ strategy: { id: 'STRAT01' } });
    });

    test('reads the only strategy when the active source is none of the strategies on the chart', async () => {
      // A source the chart does not list, as an internal one such as the strategy of the replay,
      // and a source that cannot be named.
      for (const active of [
        { id: () => 'HIDDEN01' },
        { id: () => 42 },
        { id: () => undefined },
        { id: () => 'STUDY01' },
        {},
        'STRAT01',
        7,
        null,
        undefined,
        {
          id: () => {
            throw new Error('Not a source');
          },
        },
      ]) {
        const make = withCores(
          { ONE: strategyCore({ currency: 'USD', performance: {} }) },
          { active },
        );

        expect(await read(make), JSON.stringify(active)).toMatchObject({ strategy: { id: 'ONE' } });
      }
    });

    test('names an active source by a number id as the chart lists it', async () => {
      const make = withCores(
        {
          A: strategyCore({ currency: 'USD', performance: {} }),
          '42': strategyCore({ currency: 'EUR', performance: {} }),
        },
        { active: { id: () => 42 } },
      );

      expect(await read(make)).toMatchObject({ strategy: { id: '42' }, currency: 'EUR' });
    });

    test('reads the only strategy on a build that has no active strategy source at all', async () => {
      const make = withCores({ ONE: strategyCore({ currency: 'USD', performance: {} }) });

      expect(await read(make)).toMatchObject({ strategy: { id: 'ONE' } });
    });

    test('fails INVALID_INPUT, naming the ids, when several strategies are on the chart and none is active', async () => {
      const error = await fail(chart(withStudies(fixture, SAMPLE_STRATEGY, SECOND_STRATEGY)));

      expect(error.toPayload()).toEqual({
        code: 'INVALID_INPUT',
        message: expect.stringMatching(
          /2 strategies.*none is the active one: STRAT01, STRAT02/,
        ) as string,
        hint: expect.stringMatching(/studyId.*indicator_list/) as string,
        details: { ids: ['STRAT01', 'STRAT02'] },
      });
    });

    test('fails NOT_AVAILABLE, with how to add a strategy, when the chart has none', async () => {
      const error = await fail(chart(fixture));

      expect(error.toPayload()).toEqual({
        code: 'NOT_AVAILABLE',
        message: 'The chart has no strategy',
        hint: expect.stringMatching(/pine_new.*strategy.*pine_compile.*addToChart/s) as string,
      });
    });

    test('fails INVALID_INPUT for an id that is not a study of the chart', async () => {
      const error = await fail(chart(), 'NOPE01');

      expect(error.toPayload()).toEqual({
        code: 'INVALID_INPUT',
        message: 'The chart has no study with the id NOPE01',
        hint: expect.stringMatching(/indicator_list/) as string,
        details: { id: 'NOPE01' },
      });
    });

    test('fails INVALID_INPUT for the id of a study that is not a strategy', async () => {
      const error = await fail(chart(), 'STUDY01');

      expect(error.toPayload()).toEqual({
        code: 'INVALID_INPUT',
        message: expect.stringMatching(/STUDY01.*Moving Average.*not a strategy/) as string,
        hint: expect.stringMatching(/indicator_list.*isStrategy/) as string,
        details: { id: 'STUDY01' },
      });
    });

    test('takes a study for a strategy by the members the app tests, as it does without the flag', async () => {
      const members = {
        strategyOrdersPaneView: () => null,
        ordersData: () => null,
        reportData: () => ({ currency: 'USD', performance: {} }),
      };
      const make = withCores({
        IND: { reportData: () => ({ currency: 'EUR' }) },
        DUCK: members,
        HALF: { strategyOrdersPaneView: () => null, ordersData: () => null },
      });

      expect(await read(make)).toMatchObject({ strategy: { id: 'DUCK' }, currency: 'USD' });
      expect((await fail(make, 'HALF')).code).toBe('INVALID_INPUT');
      expect((await fail(make, 'IND')).code).toBe('INVALID_INPUT');
    });

    test('passes over a study the model does not know when it looks for the only strategy', async () => {
      const make = plain({
        TradingViewApi: {
          activeChart: () => ({
            getAllStudies: () => [
              { id: 'GONE', name: 'Gone' },
              { id: 'BROKEN', name: 'Broken' },
              { id: 'ONE', name: 'One' },
            ],
            _chartWidget: {
              model: () => ({
                model: () => ({
                  getStudyById: (id: string) => {
                    if (id === 'BROKEN') {
                      throw new Error('Not ready');
                    }
                    return id === 'ONE' ? strategyCore({ currency: 'USD', performance: {} }) : null;
                  },
                }),
              }),
            },
          }),
        },
      });

      expect(await read(make)).toMatchObject({ strategy: { id: 'ONE', name: 'One' } });
    });

    test('names the strategy by the name the chart lists, or by its id without one', async () => {
      const make = plain({
        TradingViewApi: {
          activeChart: () => ({
            getAllStudies: () => [{ id: 'ONE' }],
            _chartWidget: {
              model: () => ({
                model: () => ({
                  getStudyById: () => strategyCore({ currency: 'USD', performance: {} }),
                }),
              }),
            },
          }),
        },
      });

      expect(await read(make)).toMatchObject({ strategy: { id: 'ONE', name: 'ONE' } });
    });

    test('finds no strategy on a chart whose list of studies is no list, or cannot be had', async () => {
      for (const getAllStudies of [
        () => 'none',
        () => null,
        () => {
          throw new Error('No studies yet');
        },
      ]) {
        const make = plain({
          TradingViewApi: {
            activeChart: () => ({
              getAllStudies,
              _chartWidget: { model: () => ({ model: () => ({ getStudyById: () => null }) }) },
            }),
          },
        });

        const error = await fail(make);

        expect(error.toPayload()).toMatchObject({
          code: 'NOT_AVAILABLE',
          message: 'The chart has no strategy',
        });
      }
    });

    test('lists a study by a number id as its text, as the other tools do', async () => {
      const make = plain({
        TradingViewApi: {
          activeChart: () => ({
            getAllStudies: () => [{ id: 7, name: 'Seven' }, { id: null }, null],
            _chartWidget: {
              model: () => ({
                model: () => ({
                  getStudyById: (id: string) =>
                    id === '7' ? strategyCore({ currency: 'USD', performance: {} }) : null,
                }),
              }),
            },
          }),
        },
      });

      expect(await read(make)).toMatchObject({ strategy: { id: '7', name: 'Seven' } });
    });

    test('reads the chart of the index it is given', async () => {
      const result = await resultOf(readStrategyReport, [0, null, 'results'], chart());

      expect(result).toMatchObject({ strategy: { id: 'STRAT01' } });
      const missing = await failureOfBoth(readStrategyReport, [1, null, 'results'], chart());
      expect(missing.code).toBe('CAPABILITY_UNAVAILABLE');
    });
  });

  describe('the results', () => {
    test('reads all, long and short as numbers, parsing numeric strings and dropping what is no number', async () => {
      const result = await read(chart());

      // The sample holds a numeric string, a text, a boolean, an object and a null in all.
      expect(result.performance.all).toMatchObject({ grossProfit: 205, percentProfitable: 66.67 });
      for (const dropped of ['notAvailable', 'inUse', 'nested', 'gone']) {
        expect(result.performance.all, dropped).not.toHaveProperty(dropped);
      }
      expect(result.performance.short.percentProfitable).toBe(0);
    });

    test('puts the metrics that sit next to all, long and short into all, where all has its own', async () => {
      const make = withCores({
        ONE: strategyCore({
          currency: 'USD',
          performance: {
            all: { netProfit: 5, sharpeRatio: '1.5' },
            long: { netProfit: 3 },
            short: { netProfit: 2 },
            netProfit: 99,
            buyHoldReturn: 7,
            profitFactor: 'x',
          },
        }),
      });

      expect((await read(make)).performance).toStrictEqual({
        all: { netProfit: 5, sharpeRatio: 1.5, buyHoldReturn: 7 },
        long: { netProfit: 3 },
        short: { netProfit: 2 },
      });
    });

    test('reads all from the top of the performance when the report has no all', async () => {
      const make = withCores({
        ONE: strategyCore({
          currency: 'USD',
          performance: { netProfit: 4, long: { netProfit: 1 } },
        }),
      });

      expect((await read(make)).performance).toStrictEqual({
        all: { netProfit: 4 },
        long: { netProfit: 1 },
        short: {},
      });
    });

    test('reads only text that is wholly a number, and numbers JSON can carry', async () => {
      const values = {
        plain: '12',
        signed: ' -3.5 ',
        fraction: '.5',
        trailingDot: '7.',
        exponent: '1e3',
        partly: '12abc',
        thousands: '1,234.5',
        percent: '12%',
        empty: '',
        blank: '  ',
        hex: '0x10',
        infinite: '1e999',
        notANumber: Number.NaN,
        infinity: Number.POSITIVE_INFINITY,
      };
      const make = withCores({
        ONE: strategyCore({ currency: 'USD', performance: { all: values } }),
      });

      const { all } = (await read(make)).performance;

      expect(all).toEqual({
        plain: 12,
        signed: -3.5,
        fraction: 0.5,
        trailingDot: 7,
        exponent: 1000,
      });
    });

    test('does not read the performance as a list or a text', async () => {
      const make = withCores({
        ONE: strategyCore({
          currency: 'USD',
          performance: { all: [1, 2], long: 'many', short: null },
        }),
      });

      expect((await read(make)).performance).toStrictEqual(NO_PERFORMANCE);
    });

    test('reports the currency as it is, NONE included, and none when it is no text', async () => {
      const currencyOf = async (currency: unknown) =>
        (await read(withCores({ ONE: strategyCore({ currency, performance: {} }) }), null))
          .currency;

      expect(await currencyOf('NONE')).toBe('NONE');
      expect(await currencyOf('EUR')).toBe('EUR');
      expect(await currencyOf(5)).toBeNull();
      expect(await currencyOf(undefined)).toBeNull();
    });

    test('fails NOT_AVAILABLE when the report has no performance yet', async () => {
      for (const performance of [undefined, null, 'soon', [1]]) {
        const make = withCores({ ONE: strategyCore({ currency: 'USD', performance }) });

        const error = await fail(make);

        expect(error.toPayload(), String(performance)).toEqual({
          code: 'NOT_AVAILABLE',
          message: expect.stringMatching(/ONE.*no performance/) as string,
          hint: expect.stringMatching(/again/) as string,
          details: { id: 'ONE' },
        });
      }
    });

    test('reads nothing of the trades and the orders for the results', async () => {
      const result = await read(chart());

      expect(result.trades).toBeNull();
      expect(result.fills).toEqual([]);
    });
  });

  describe('the initial capital', () => {
    // The sample with a performance that has the members given, and the input of the capital.
    const capitalOf = async (performance: JsonValue, input: JsonValue | undefined) => {
      const study = {
        ...SAMPLE_STRATEGY,
        report: { ...SAMPLE_REPORT, performance: performance as Record<string, JsonValue> },
        inputs:
          input === undefined
            ? []
            : [
                {
                  id: 'in_1',
                  name: 'Initial capital',
                  internalID: 'initial_capital',
                  type: 'float',
                  value: input,
                },
              ],
      };
      return (await read(chart(withStudies(fixture, study)))).initialCapital;
    };

    test('is initialCapital of the all column of the report, not the input of the strategy', async () => {
      expect(await capitalOf({ all: { initialCapital: 10_000 } }, 99_999)).toBe(10_000);
    });

    test('is initialCapital at the top of the performance when all lacks it', async () => {
      expect(await capitalOf({ all: { netProfit: 1 }, initialCapital: '2500.5' }, 99_999)).toBe(
        2500.5,
      );
      expect(await capitalOf({ initialCapital: 2500 }, 99_999)).toBe(2500);
    });

    test('is a numeric string of the report, read as a number', async () => {
      expect(await capitalOf({ all: { initialCapital: '7500' } }, undefined)).toBe(7500);
    });

    test('is the input of the strategy with the internal id initial_capital when the report lacks it', async () => {
      expect(await capitalOf({ all: { netProfit: 1 } }, 25_000)).toBe(25_000);
      expect(await capitalOf({ all: { initialCapital: 'n/a' } }, 25_000)).toBe(25_000);
    });

    test('is null when neither the report nor an input holds it', async () => {
      expect(await capitalOf({ all: { netProfit: 1 } }, undefined)).toBeNull();
    });

    test('is null when the input is not a number', async () => {
      expect(await capitalOf({ all: {} }, 'a lot')).toBeNull();
      expect(await capitalOf({ all: {} }, true)).toBeNull();
      expect(await capitalOf({ all: {} }, null)).toBeNull();
    });

    test('is also read for the trades, whose performance is left empty', async () => {
      const result = await read(chart(), null, 'trades');

      expect(result.initialCapital).toBe(10_000);
      expect(result.performance).toStrictEqual(NO_PERFORMANCE);
    });

    // A strategy whose study API lists inputs and values, and whose metadata lists inputs.
    const withInputs = (infos: unknown, values: unknown, metaInputs: unknown) =>
      withCores(
        {
          ONE: strategyCore(
            { currency: 'USD', performance: { all: {} } },
            { metaInfo: () => ({ inputs: metaInputs }) },
          ),
        },
        { apis: { ONE: { getInputsInfo: () => infos, getInputValues: () => values } } },
      );
    const CAPITAL = { id: 'in_9', internalID: 'initial_capital' };

    test('finds the input in the metadata when the study API does not list it', async () => {
      const make = withInputs([{ id: 'in_9' }], [{ id: 'in_9', value: 3000 }], [CAPITAL]);

      expect((await read(make)).initialCapital).toBe(3000);
    });

    test('finds the input in the study API', async () => {
      const make = withInputs(
        [{ id: 'in_0', internalID: 'pyramiding' }, CAPITAL],
        [
          { id: 'in_0', value: 1 },
          { id: 'in_9', value: 4000 },
        ],
        undefined,
      );

      expect((await read(make)).initialCapital).toBe(4000);
    });

    test('is null when the value of the input is not listed, or the inputs cannot be read', async () => {
      for (const make of [
        withInputs([CAPITAL], [{ id: 'in_0', value: 1 }], undefined),
        withInputs([CAPITAL], 'nothing', undefined),
        withInputs([CAPITAL], undefined, undefined),
        withInputs([{ id: 9, internalID: 'initial_capital' }], [{ id: 9, value: 4000 }], undefined),
        withInputs('nothing', undefined, 'nothing'),
        withInputs(undefined, undefined, [null, 5, { internalID: 'other' }]),
        withCores({ ONE: strategyCore({ currency: 'USD', performance: { all: {} } }) }),
        withCores(
          { ONE: strategyCore({ currency: 'USD', performance: { all: {} } }) },
          {
            apis: {
              ONE: {
                getInputsInfo: () => {
                  throw new Error('No inputs');
                },
              },
            },
          },
        ),
      ]) {
        expect((await read(make)).initialCapital).toBeNull();
      }
    });
  });

  describe('the trades', () => {
    test('reads the trades of the report in the shape of the Strategy Tester', async () => {
      const result = await read(chart(), null, 'trades');

      expect(result.trades).toStrictEqual([
        {
          tradeNumber: 1,
          isOpen: false,
          entry: { type: 'le', time: barTime(20), price: 100, id: 'Long' },
          exit: { type: 'lx', time: barTime(30), price: 110, id: 'Exit long' },
          quantity: 10,
          profit: 100,
          profitPercent: 10,
          cumulativeProfit: 100,
          runup: 120,
          drawdown: 20,
        },
        {
          // Stamped in milliseconds, which the page passes on as it is.
          tradeNumber: 2,
          isOpen: false,
          entry: { type: 'se', time: barTime(50) * 1000, price: 120, id: 'Short' },
          exit: { type: 'sx', time: barTime(62) * 1000, price: 125, id: 'Exit short' },
          quantity: 10,
          profit: -50,
          profitPercent: -4.2,
          cumulativeProfit: 50,
          runup: 10,
          drawdown: 60,
        },
        {
          tradeNumber: 3,
          isOpen: false,
          entry: { type: 'le', time: barTime(80), price: 105, id: 'Long' },
          exit: { type: 'lx', time: barTime(95), price: 115.5, id: 'Exit long' },
          quantity: 10,
          profit: 105,
          profitPercent: 10,
          cumulativeProfit: 155,
          runup: 110,
          drawdown: 5,
        },
        {
          tradeNumber: 4,
          isOpen: true,
          entry: { type: 'le', time: barTime(250), price: 130, id: 'Long' },
          exit: { type: 'lx', time: barTime(299), price: 128, id: 'Open' },
          quantity: 10,
          profit: -20,
          profitPercent: -1.5,
          cumulativeProfit: 135,
          runup: 15,
          drawdown: 40,
        },
      ]);
      // The orders are read only when the report has no trades.
      expect(result.fills).toEqual([]);
    });

    test('reads a trade with the fields it has, and null for the rest', async () => {
      const make = withCores({
        ONE: strategyCore({
          currency: 'USD',
          trades: [
            { entry: { price: '101.5' } },
            {
              entry: { type: 5, time: 'soon', price: Number.NaN, id: 7 },
              exit: 'later',
              isOpen: 'yes',
              tradeNumber: '9',
              quantity: null,
              profit: 5,
              runup: { value: 'x', percentValue: 1 },
              drawdown: { percentValue: 2 },
              cumulativeProfit: [],
            },
          ],
        }),
      });

      const { trades } = await read(make, null, 'trades');

      const NO_LEG = { type: null, time: null, price: null, id: null };
      const NO_AMOUNTS = {
        quantity: null,
        profit: null,
        profitPercent: null,
        cumulativeProfit: null,
        runup: null,
        drawdown: null,
      };
      expect(trades).toStrictEqual([
        {
          tradeNumber: null,
          isOpen: false,
          entry: { ...NO_LEG, price: 101.5 },
          exit: null,
          ...NO_AMOUNTS,
        },
        { tradeNumber: 9, isOpen: false, entry: NO_LEG, exit: null, ...NO_AMOUNTS },
      ]);
    });

    test('reads the amount of a profit that has no percentage, and the percentage of a profit that has one', async () => {
      const make = withCores({
        ONE: strategyCore({
          currency: 'USD',
          trades: [
            { entry: {}, profit: { value: 5 } },
            { entry: {}, profit: { percentValue: '2.5' } },
          ],
        }),
      });

      const { trades } = await read(make, null, 'trades');

      expect(trades?.map(({ profit, profitPercent }) => [profit, profitPercent])).toEqual([
        [5, null],
        [null, 2.5],
      ]);
    });

    test('falls back to the filled orders when the report has no trades member', async () => {
      const result = await read(
        chart(withStudies(fixture, strategyWith({ trades: undefined }))),
        null,
        'trades',
      );

      expect(result.trades).toBeNull();
      expect(result.fills).toHaveLength(7);
    });

    test('falls back to the filled orders when the trades are not in the shape of the Strategy Tester', async () => {
      for (const trades of [
        null,
        5,
        'many',
        { entry: {} },
        [{ foo: 1 }],
        [{ entry: {} }, 3],
        [{ entry: 'now' }],
        [[]],
      ]) {
        const result = await read(
          chart(withStudies(fixture, strategyWith({ trades }))),
          null,
          'trades',
        );

        expect(result.trades, JSON.stringify(trades)).toBeNull();
        expect(result.fills, JSON.stringify(trades)).toHaveLength(7);
      }
    });

    test('falls back to the filled orders when the trades are empty but orders were filled', async () => {
      const result = await read(
        chart(withStudies(fixture, strategyWith({ trades: [] }))),
        null,
        'trades',
      );

      expect(result.trades).toBeNull();
      expect(result.fills).toHaveLength(7);
    });

    test('reads an empty list of trades when there are neither trades nor orders', async () => {
      for (const filledOrders of [[], undefined]) {
        const study = strategyWith({ trades: [], filledOrders });
        const result = await read(chart(withStudies(fixture, study)), null, 'trades');

        expect(result.trades).toEqual([]);
        expect(result.fills).toEqual([]);
      }
    });

    test('reads the performance as empty for the trades', async () => {
      expect((await read(chart(), null, 'trades')).performance).toStrictEqual(NO_PERFORMANCE);
    });
  });

  describe('the filled orders', () => {
    const fillsOf = async (
      from: TvStateFixture = withStudies(fixture, strategyWith({ trades: undefined })),
    ) => (await read(chart(from), null, 'trades')).fills;

    test('reads the buy flag, the entry flag, the price, the quantity, the comment, the bar and its time', async () => {
      const fills = await fillsOf();

      expect(fills).toStrictEqual([
        {
          id: 'Long',
          isBuy: true,
          isEntry: true,
          price: 100,
          quantity: 10,
          comment: null,
          barIndex: 20,
          time: barTime(20),
        },
        {
          id: 'Exit long',
          isBuy: false,
          isEntry: false,
          price: 110,
          quantity: 10,
          comment: 'Take profit',
          barIndex: 30,
          time: barTime(30),
        },
        // e is left out for an entry, and an order that does not say it is an exit is an entry.
        {
          id: 'Short',
          isBuy: false,
          isEntry: true,
          price: 120,
          quantity: 10,
          comment: null,
          barIndex: 50,
          time: barTime(50),
        },
        {
          id: 'Exit short',
          isBuy: true,
          isEntry: false,
          price: 125,
          quantity: 10,
          comment: null,
          barIndex: 62,
          time: barTime(62),
        },
        {
          id: 'Long',
          isBuy: true,
          isEntry: true,
          price: 105,
          quantity: 10,
          comment: null,
          barIndex: 80,
          time: barTime(80),
        },
        {
          id: 'Exit long',
          isBuy: false,
          isEntry: false,
          price: 115.5,
          quantity: 10,
          comment: null,
          barIndex: 95,
          time: barTime(95),
        },
        {
          id: 'Long',
          isBuy: true,
          isEntry: true,
          price: 130,
          quantity: 10,
          comment: 'Breakout',
          barIndex: 250,
          time: barTime(250),
        },
      ]);
    });

    // A strategy without trades whose report holds `orders`, on a page whose bars are `bars` and
    // whose barsIndexes answers `indexes`.
    const withOrders = (orders: unknown, indexes: unknown, bars: unknown = {}) =>
      withCores(
        {
          ONE: strategyCore(
            { currency: 'USD', filledOrders: orders },
            { barsIndexes: typeof indexes === 'function' ? indexes : () => indexes },
          ),
        },
        { bars },
      );
    const ORDER = { id: 'Buy', b: true, p: 1, q: 2 };
    const rowsOf = (rows: Record<number, unknown>) => ({ valueAt: (index: number) => rows[index] });

    test('leaves the bar and its time out when barsIndexes is not a list, or fails', async () => {
      for (const indexes of [
        undefined,
        null,
        'none',
        () => {
          throw new Error('No indexes');
        },
      ]) {
        const { fills } = await read(withOrders([ORDER], indexes), null, 'trades');

        expect(fills, String(indexes)).toEqual([
          {
            id: 'Buy',
            isBuy: true,
            isEntry: true,
            price: 1,
            quantity: 2,
            comment: null,
            barIndex: null,
            time: null,
          },
        ]);
      }
    });

    test('leaves the bar out for an order barsIndexes has no index for', async () => {
      const { fills } = await read(withOrders([ORDER, ORDER, ORDER], [4, 'x']), null, 'trades');

      expect(fills.map(({ barIndex }) => barIndex)).toEqual([4, null, null]);
    });

    test('leaves the time of an order out when the chart has no row for its bar', async () => {
      const bars = rowsOf({ 4: [1_700_000_000, 1, 2, 3, 4, 5], 5: 'row', 6: [Number.NaN] });
      const { fills } = await read(
        withOrders([ORDER, ORDER, ORDER, ORDER], [4, 5, 6, 7], bars),
        null,
        'trades',
      );

      expect(fills.map(({ barIndex, time }) => [barIndex, time])).toEqual([
        [4, 1_700_000_000],
        [5, null],
        [6, null],
        [7, null],
      ]);
    });

    test('leaves the time out on a page whose chart has no bars', async () => {
      const failing = {
        valueAt: () => {
          throw new Error('No bars');
        },
      };
      for (const bars of [undefined, {}, failing]) {
        const { fills } = await read(withOrders([ORDER], [4], bars), null, 'trades');

        expect(fills[0], JSON.stringify(bars)).toMatchObject({ barIndex: 4, time: null });
      }
    });

    test('reads an order whose buy flag is no boolean as having none, and an entry flag only false makes an exit', async () => {
      const { fills } = await read(
        withOrders(
          [
            { id: 'A', p: 1, q: 1 },
            { id: 'B', b: 'yes', e: 0, p: 'x', q: null, c: 5 },
            { id: 'C', b: false, e: false },
            { id: 'D', b: true, e: true },
          ],
          [1, 2, 3, 4],
        ),
        null,
        'trades',
      );

      expect(fills.map(({ isBuy, isEntry }) => [isBuy, isEntry])).toEqual([
        [null, true],
        [null, true],
        [false, false],
        [true, true],
      ]);
      expect(fills[1]).toMatchObject({ price: null, quantity: null, comment: null });
    });

    test('skips what is not an order, keeping the place of the others among the bar indexes', async () => {
      const { fills } = await read(
        withOrders(
          [null, 5, 'order', ORDER, [ORDER], { ...ORDER, id: 'Last' }],
          [10, 11, 12, 13, 14, 15],
        ),
        null,
        'trades',
      );

      expect(fills.map(({ id, barIndex }) => [id, barIndex])).toEqual([
        ['Buy', 13],
        ['Last', 15],
      ]);
    });

    test('reads no orders when the report has none, or has them in no list', async () => {
      for (const orders of [undefined, null, 'none', {}]) {
        const { trades, fills } = await read(withOrders(orders, []), null, 'trades');

        // Without trades either, there is no list of trades to read, and no orders to read instead.
        expect(trades, JSON.stringify(orders)).toBeNull();
        expect(fills, JSON.stringify(orders)).toEqual([]);
      }
    });
  });

  describe('what it cannot read', () => {
    test.each(NO_CHART)('fails CAPABILITY_UNAVAILABLE on %s', async (_case, make) => {
      const error = await fail(make);

      expect(error.toPayload()).toEqual({
        code: 'CAPABILITY_UNAVAILABLE',
        message: expect.stringMatching(/no chart API/) as string,
        hint: expect.stringMatching(/app_health/) as string,
      });
    });

    test('fails CAPABILITY_UNAVAILABLE on a chart whose model has no study lookup', async () => {
      const listing = { getAllStudies: () => [{ id: 'ONE', name: 'One' }] };
      for (const _chartWidget of [
        undefined,
        { model: () => undefined },
        { model: () => ({}) },
        { model: () => ({ model: () => ({}) }) },
        {
          model: () => {
            throw new Error('No model');
          },
        },
      ]) {
        const error = await fail(
          plain({ TradingViewApi: { activeChart: () => ({ ...listing, _chartWidget }) } }),
        );

        expect(error.toPayload(), JSON.stringify(_chartWidget)).toEqual({
          code: 'CAPABILITY_UNAVAILABLE',
          message: expect.stringMatching(/no study model/) as string,
          hint: expect.stringMatching(/app_health/) as string,
        });
      }
    });

    test('fails CAPABILITY_UNAVAILABLE for a strategy whose report cannot be asked for', async () => {
      const make = withCores({ ONE: { isStudyStrategy: true } });

      const error = await fail(make);

      expect(error.toPayload()).toEqual({
        code: 'CAPABILITY_UNAVAILABLE',
        message: expect.stringMatching(/report of the strategy ONE.*cannot be read/) as string,
        hint: expect.stringMatching(/app_health/) as string,
        details: { id: 'ONE' },
      });
    });

    test('fails CAPABILITY_UNAVAILABLE for an id the chart lists but its model does not know', async () => {
      const make = plain({
        TradingViewApi: {
          activeChart: () => ({
            getAllStudies: () => [{ id: 'GHOST', name: 'Ghost' }],
            _chartWidget: { model: () => ({ model: () => ({ getStudyById: () => null }) }) },
          }),
        },
      });

      const error = await fail(make, 'GHOST');

      expect(error.toPayload()).toEqual({
        code: 'CAPABILITY_UNAVAILABLE',
        message: expect.stringMatching(/GHOST.*could not be read/) as string,
        hint: expect.stringMatching(/again.*app_health/s) as string,
        details: { id: 'GHOST' },
      });
    });

    test('fails NOT_AVAILABLE, saying the report is not ready, while the strategy has none', async () => {
      const make = chart(withStudies(fixture, { ...SAMPLE_STRATEGY, report: undefined }));

      for (const part of ['results', 'trades'] as const) {
        const error = await fail(make, null, part);

        expect(error.toPayload(), part).toEqual({
          code: 'NOT_AVAILABLE',
          message: expect.stringMatching(
            /report of the strategy STRAT01.*RSI Strategy.*not ready/,
          ) as string,
          hint: expect.stringMatching(/Wait.*call again/s) as string,
          details: { id: 'STRAT01' },
        });
      }
    });

    test('treats a report that cannot be read, or is no object, as not ready', async () => {
      for (const report of [
        undefined,
        null,
        'ready',
        7,
        [],
        () => {
          throw new Error('Not computed');
        },
      ]) {
        const core =
          typeof report === 'function'
            ? { isStudyStrategy: true, reportData: report }
            : strategyCore(report);

        const error = await fail(withCores({ ONE: core }));

        expect(error.code, String(report)).toBe('NOT_AVAILABLE');
        expect(error.message, String(report)).toMatch(/not ready/);
      }
    });
  });
});
