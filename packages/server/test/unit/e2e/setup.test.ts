import type { TvWindow } from '../../../src/core/tv/tv-window.js';
import { missingChartMembers, restorabilityProblems } from '../../e2e/setup.js';
import { loadTvFixture } from '../../helpers/fake-tv/fixture.js';
import { createFakeTvWindow } from '../../helpers/fake-tv/window.js';

// The checks the end-to-end chart suite makes, by reading only, before it changes the user's chart:
// that the tools can put the chart back as it is, and that the chart API has what the tools use, so
// that none of them falls back to clicks and typing. Either failing skips the suite.

const fixture = loadTvFixture();

const STATE = {
  symbol: 'NASDAQ:AAPL',
  resolution: '1D',
  chartType: 1,
  visibleRange: {
    from: 1_721_433_600,
    to: 1_729_987_200,
    fromIso: '2024-07-20T00:00:00Z',
    toIso: '2024-10-27T00:00:00Z',
  },
};

const range = (from: number, to: number) => ({ from, to, fromIso: '', toIso: '' });

describe('restorabilityProblems', () => {
  test('finds nothing to object to in a chart the tools can put back', () => {
    expect(restorabilityProblems(STATE)).toEqual([]);
    // A resolution TradingView writes without a count is the same timeframe the tools set.
    expect(restorabilityProblems({ ...STATE, resolution: 'D' })).toEqual([]);
    expect(restorabilityProblems({ ...STATE, resolution: '100T', chartType: 8 })).toEqual([]);
  });

  test.each([
    ['a chart type without a name (11)', { chartType: 11 }, /chart type 11/],
    ['a chart type the tools do not know', { chartType: 99 }, /chart type 99/],
    ['a timeframe the tools cannot read', { resolution: '1D,2' }, /timeframe "1D,2"/],
    ['a timeframe longer than the tool takes', { resolution: '1'.repeat(17) }, /timeframe/],
    ['an empty symbol', { symbol: '' }, /symbol ""/],
    ['a blank symbol', { symbol: '   ' }, /symbol " {3}"/],
    ['a symbol longer than the tool takes', { symbol: 'X'.repeat(201) }, /symbol/],
    ['no visible range', { visibleRange: null }, /no visible range/],
    [
      'a range whose ends are the wrong way round',
      { visibleRange: range(1_729_987_200, 1_721_433_600) },
      /range/,
    ],
    ['a range of one instant', { visibleRange: range(1_721_433_600, 1_721_433_600) }, /range/],
    [
      'a range in milliseconds',
      { visibleRange: range(1_721_433_600_000, 1_729_987_200_000) },
      /range/,
    ],
    ['a range that starts in 1970', { visibleRange: range(0, 1_729_987_200) }, /range/],
    [
      'a range with an end that is not a number',
      { visibleRange: range(1_721_433_600, Number.NaN) },
      /range/,
    ],
  ])('objects to %s', (_case, change, problem) => {
    const problems = restorabilityProblems({ ...STATE, ...change });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(problem);
  });

  test('lists every problem it finds', () => {
    expect(
      restorabilityProblems({ symbol: '', resolution: '?', chartType: 11, visibleRange: null }),
    ).toHaveLength(4);
  });
});

describe('missingChartMembers', () => {
  test('finds nothing missing on a chart with the API and the time scale', () => {
    expect(missingChartMembers(createFakeTvWindow(fixture) as unknown as TvWindow)).toEqual([]);
  });

  test('names a setter the chart API lacks, whose tool would fall back to the interface', () => {
    const win = createFakeTvWindow(fixture);
    Reflect.deleteProperty(win.TradingViewApi?.activeChart() ?? {}, 'setSymbol');

    expect(missingChartMembers(win as unknown as TvWindow)).toEqual(['activeChart().setSymbol']);
  });

  test('names everything on a page whose app has not booted, or whose chart cannot be reached', () => {
    const everything = [
      'activeChart().symbol',
      'activeChart().resolution',
      'activeChart().chartType',
      'activeChart().getVisibleRange',
      'activeChart().setSymbol',
      'activeChart().setResolution',
      'activeChart().setChartType',
      'timeScale().zoomToBarsRange',
      'bars().firstIndex',
      'bars().lastIndex',
      'bars().valueAt',
    ];
    const booting = createFakeTvWindow(fixture, { withoutApi: true }) as unknown as TvWindow;
    const throwing = {
      ...booting,
      TradingViewApi: {
        activeChart: () => {
          throw new Error('No chart is active');
        },
      },
    } as unknown as TvWindow;

    expect(missingChartMembers(booting)).toEqual(everything);
    expect(missingChartMembers(throwing)).toEqual(everything);
  });
});
