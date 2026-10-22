import type { FixtureChart, TvStateFixture } from './fake-tv/fixture.js';

// Layouts of more than one chart for the tests of the pane tools and of the fake that holds the
// charts of a layout (fake-tv/charts.ts), built on a fixture such as chart-basic. Values are
// synthetic.

// The second chart of the layouts below: another symbol, a study in each of its two panes and a
// drawing in the first.
export const SECOND_CHART: FixtureChart = {
  symbol: 'NASDAQ:MSFT',
  resolution: '60',
  studies: [
    { id: 'C1STUDY1', name: 'Volume' },
    { id: 'C1STUDY2', name: 'Relative Strength Index' },
  ],
  shapes: [{ id: 'C1SHAPE1', name: 'trend_line' }],
  panes: [
    { height: 400, studies: ['C1STUDY1'] },
    { height: 200, studies: ['C1STUDY2'] },
  ],
};

// Two charts side by side, both shown: the chart of the base fixture, with its moving average in
// its first pane and its RSI in a pane of its own, and SECOND_CHART. The plan of the base fixture is
// kept, which allows one chart for chart-basic: a test that changes the layout gives it a plan of its
// own with withChartLimit.
export function withTwoCharts(base: TvStateFixture): TvStateFixture {
  return {
    ...base,
    layout: { ...base.layout, type: '2h', chartsCount: 2 },
    charts: {
      panes: [
        { height: 420, studies: ['STUDY01'] },
        { height: 180, studies: ['STUDY02'] },
      ],
      others: [SECOND_CHART],
    },
  };
}

// The same layout as TradingView loads it on a plan of one chart after it was saved on a plan with
// more: layout() keeps its type, 2h, while chartsCount() is the count of the plan, and the second
// chart is kept hidden, to be saved with the layout. Give it a plan with withChartLimit.
export function withLockedTwoCharts(base: TvStateFixture): TvStateFixture {
  const layout = withTwoCharts(base);
  return { ...layout, layout: { ...layout.layout, chartsCount: 1 } };
}

// A plan that allows `limit` charts in a layout (the MULTIPLE_CHARTS limit of the plan).
export function withChartLimit(limit: number, base: TvStateFixture): TvStateFixture {
  return { ...base, planLimits: { ...base.planLimits, MULTIPLE_CHARTS: limit } };
}
