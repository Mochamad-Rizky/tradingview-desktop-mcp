import {
  availabilityOf,
  availabilityRefusal,
  isDailyOrLonger,
  replayTimeOf,
  requireWithinHistory,
  speedDelayOf,
  speedLabelOf,
  startOf,
} from '../../../../src/tools/replay/mappers.js';
import { failureOf } from '../../../helpers/failure-of.js';

// The pure parts of the replay tools: timeframes, times, speeds, availability and the start point.
// Values are synthetic.

const SPEEDS = [
  { label: '10x', value: 100 },
  { label: '5x', value: 200 },
  { label: '1x', value: 1000 },
  { label: '0.5x', value: 2000 },
];

// An available daily chart, which availabilityRefusal changes field by field.
const DAILY = {
  available: true,
  chartAvailable: true,
  unavailableReason: null,
  resolution: '1D',
} as const;

// The error a synchronous call throws.
function thrownBy(call: () => unknown) {
  return failureOf(Promise.resolve().then(call));
}

test.each([['1D'], ['D'], ['W'], ['1W'], ['M'], ['3M'], ['12M']])(
  'isDailyOrLonger counts %s as a daily, weekly or monthly timeframe',
  (resolution) => {
    expect(isDailyOrLonger(resolution)).toBe(true);
  },
);

test.each([
  ['1'],
  ['15'],
  ['60'],
  ['240'],
  ['1S'],
  ['30S'],
  ['1T'],
  ['100R'],
  ['1d'],
  [''],
  [null],
])('isDailyOrLonger counts %s as intraday, or not known', (resolution) => {
  expect(isDailyOrLonger(resolution)).toBe(false);
});

test('replayTimeOf answers Unix seconds and ISO, reads milliseconds, and null for what is no time', () => {
  expect(replayTimeOf(1712707200)).toEqual({ date: 1712707200, dateIso: '2024-04-10T00:00:00Z' });
  expect(replayTimeOf(1712707200.9)).toEqual({ date: 1712707200, dateIso: '2024-04-10T00:00:00Z' });
  expect(replayTimeOf(1712707200000)).toEqual({
    date: 1712707200,
    dateIso: '2024-04-10T00:00:00Z',
  });
  for (const value of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e300]) {
    expect(replayTimeOf(value)).toEqual({ date: null, dateIso: null });
  }
});

test('speedLabelOf names the speed of a delay, and null for a delay TradingView does not list', () => {
  expect(speedLabelOf(200, SPEEDS)).toBe('5x');
  expect(speedLabelOf(250, SPEEDS)).toBeNull();
  expect(speedLabelOf(null, SPEEDS)).toBeNull();
});

test('speedDelayOf takes a label in any case and with spaces around it', () => {
  expect(speedDelayOf('5x', SPEEDS)).toBe(200);
  expect(speedDelayOf(' 0.5X ', SPEEDS)).toBe(2000);
});

test('speedDelayOf refuses an unknown label with INVALID_INPUT listing the speeds', async () => {
  const error = await thrownBy(() => speedDelayOf('2x', SPEEDS));

  expect(error.toPayload()).toEqual({
    code: 'INVALID_INPUT',
    message: 'Unknown replay speed "2x": TradingView plays replay at 10x, 5x, 1x or 0.5x',
    hint: 'Give one of these speeds, as replay_status names the current one.',
    details: { speed: '2x', speeds: ['10x', '5x', '1x', '0.5x'] },
  });
});

test('speedDelayOf names a single speed on its own', async () => {
  const error = await thrownBy(() => speedDelayOf('2x', [{ label: '1x', value: 1000 }]));

  expect(error.message).toBe('Unknown replay speed "2x": TradingView plays replay at 1x');
});

test('speedDelayOf refuses NOT_AVAILABLE when TradingView lists no speed', async () => {
  const error = await thrownBy(() => speedDelayOf('1x', []));

  expect(error.code).toBe('NOT_AVAILABLE');
  expect(error.hint).toMatch(/Leave speed out/);
});

describe('availabilityRefusal', () => {
  test('passes an available daily chart without asking the plan', () => {
    expect(availabilityRefusal(DAILY, null)).toBeNull();
  });

  test('refuses a chart TradingView cannot replay with NOT_AVAILABLE naming the timeframe and the reason', () => {
    const off = availabilityRefusal({ ...DAILY, available: false }, null);
    const chartOff = availabilityRefusal(
      { ...DAILY, chartAvailable: false, unavailableReason: 'Range bars' },
      null,
    );

    expect(off?.toPayload()).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: 'TradingView cannot replay the chart on its 1D timeframe',
      details: { resolution: '1D', reason: null },
    });
    expect(chartOff?.toPayload()).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: 'TradingView cannot replay the chart on its 1D timeframe: Range bars',
      details: { resolution: '1D', reason: 'Range bars' },
    });
    expect(
      availabilityRefusal({ ...DAILY, available: false, resolution: null }, null)?.message,
    ).toBe('TradingView cannot replay the chart');
  });

  test('refuses when TradingView does not tell whether it can replay the chart', () => {
    expect(availabilityRefusal({ ...DAILY, available: null }, null)?.toPayload()).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: expect.stringContaining('does not tell whether it can replay the chart') as string,
    });
  });

  test('refuses an intraday chart with PLAN_LIMIT on a plan without BAR_REPLAY_INTRADAY', () => {
    expect(availabilityRefusal({ ...DAILY, resolution: '15' }, false)?.toPayload()).toEqual({
      code: 'PLAN_LIMIT',
      message:
        'The plan does not include bar replay on intraday timeframes (BAR_REPLAY_INTRADAY), and ' +
        'the chart is on 15',
      hint:
        'Switch the chart to a daily, weekly or monthly timeframe with chart_set_timeframe to ' +
        'replay it, or upgrade the plan in TradingView.',
      details: { feature: 'BAR_REPLAY_INTRADAY', resolution: '15' },
    });
  });

  test('refuses an intraday chart with NOT_AVAILABLE when the plan cannot be read, and passes it on a plan with the feature', () => {
    expect(availabilityRefusal({ ...DAILY, resolution: '15' }, null)?.toPayload()).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: expect.stringContaining('cannot be read') as string,
      details: { feature: 'BAR_REPLAY_INTRADAY', resolution: '15' },
    });
    expect(availabilityRefusal({ ...DAILY, resolution: '15' }, true)).toBeNull();
  });

  test('says so when neither the timeframe nor the plan can be read', () => {
    expect(availabilityRefusal({ ...DAILY, resolution: null }, null)?.message).toMatch(
      /cannot be read on this TradingView build, and the chart is on a timeframe it does not report$/,
    );
  });

  test('refuses a chart that does not report its timeframe unless the plan replays every timeframe', () => {
    expect(availabilityRefusal({ ...DAILY, resolution: null }, false)?.toPayload()).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: expect.stringContaining('does not report its timeframe') as string,
      details: { feature: 'BAR_REPLAY_INTRADAY' },
    });
    expect(availabilityRefusal({ ...DAILY, resolution: null }, true)).toBeNull();
  });

  test('availabilityOf answers available, or the message of the refusal as the reason', () => {
    expect(availabilityOf(DAILY, null)).toEqual({ available: true, reason: null });
    expect(availabilityOf({ ...DAILY, resolution: '15' }, false)).toEqual({
      available: false,
      reason: expect.stringContaining('BAR_REPLAY_INTRADAY') as string,
    });
  });
});

describe('startOf', () => {
  test('starts at a random bar without a date, as the Random bar of TradingView', () => {
    expect(startOf(undefined)).toEqual({ start: 'random' });
  });

  test('takes first and random in any case and with spaces around them', () => {
    expect(startOf('first')).toEqual({ start: 'first' });
    expect(startOf(' Random ')).toEqual({ start: 'random' });
  });

  test('reads any other value as a time, in Unix seconds', () => {
    expect(startOf('2024-04-11')).toEqual({ start: 'date', seconds: 1712793600 });
    expect(startOf(1712793600000)).toEqual({ start: 'date', seconds: 1712793600 });
  });

  test('refuses what is neither a time nor first or random, naming both', async () => {
    const error = await thrownBy(() => startOf('yesterday'));

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toMatch(/^Invalid time "yesterday"/);
    expect(error.hint).toMatch(/^Give 'first', 'random' or a time\. Use an ISO 8601 date/);
  });
});

describe('requireWithinHistory', () => {
  const history = { first: 1704153600, last: 1729987200 };

  test('passes a time from the first loaded bar to the last', () => {
    expect(() => {
      requireWithinHistory(1704153600, history);
      requireWithinHistory(1729987200, history);
    }).not.toThrow();
  });

  test.each([
    ['before the first loaded bar', 1704153599],
    ['after the last loaded bar', 1729987201],
  ])('refuses a time %s with INVALID_INPUT naming the loaded bars', async (_case, seconds) => {
    const error = await thrownBy(() => {
      requireWithinHistory(seconds, history);
    });

    expect(error.toPayload()).toEqual({
      code: 'INVALID_INPUT',
      message: expect.stringMatching(
        /is outside the loaded bars of the chart, from 2024-01-02T00:00:00Z to 2024-10-27T00:00:00Z$/,
      ) as string,
      hint:
        "Give a time within the loaded bars, or 'first' for the first bar replay can reach, or " +
        "'random'.",
      details: { date: seconds, first: history.first, last: history.last },
    });
  });

  test('refuses NOT_AVAILABLE when the chart has no loaded bars', async () => {
    const error = await thrownBy(() => {
      requireWithinHistory(1712793600, null);
    });

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(error.hint).toMatch(/app_health/);
  });
});
