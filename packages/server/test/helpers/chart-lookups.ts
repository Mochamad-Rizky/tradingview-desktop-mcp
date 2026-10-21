import type { FakeTvWindow } from './fake-tv/window.js';

// From now on, notes each time the page asks the layout of a fake window which chart is active
// (activeChart, activeChartIndex) and each chart it reaches by its index (chart:<index>), in order,
// so that a test can tell how often a call resolved the active chart.
export function recordChartLookups(win: FakeTvWindow): string[] {
  const api = win.TradingViewApi;
  if (api === undefined) {
    throw new Error('The fake window has no API');
  }
  const asked: string[] = [];
  const activeChart = api.activeChart.bind(api);
  const activeChartIndex = api.activeChartIndex.bind(api);
  const chart = api.chart.bind(api);
  api.activeChart = () => {
    asked.push('activeChart');
    return activeChart();
  };
  api.activeChartIndex = () => {
    asked.push('activeChartIndex');
    return activeChartIndex();
  };
  api.chart = (index?: number) => {
    asked.push(`chart:${String(index)}`);
    return chart(index);
  };
  return asked;
}
