import type { ErrorCode } from '../../src/core/errors.js';
import type { JsonValue } from '../../src/utils/json.js';
import type { TvStateFixture } from '../../test/helpers/fake-tv/fixture.js';
import { SAMPLE_STRATEGY, withStudies } from '../../test/helpers/strategy-fixtures.js';

// The scenarios of docs/examples.md. Each one is a request that a person types to an AI assistant,
// the tool calls that the assistant makes for it, and what it would answer. examples.ts runs the
// calls against the fake TradingView app of the test suite, so the results on the page are the
// ones the real server produces, with synthetic values.
//
// A summary says only what the results show. Its numbers and dates have to appear in the tool calls
// and results above it, which docs-examples.test.ts checks, so a change that makes a result differ
// shows up there.

export interface ScenarioStep {
  tool: string;
  arguments: Record<string, JsonValue>;
  // The code of the error this step ends with. A step without one must succeed, so that a tool that
  // starts to fail cannot slip an error into a page that describes a success.
  expectError?: ErrorCode;
}

export interface Scenario {
  title: string;
  prompt: string;
  steps: ScenarioStep[];
  summary: string;
  // How the fake app starts for this scenario: the chart-basic fixture, changed by this function.
  // Every scenario gets an app of its own, so what one does never shows in another.
  fixture?: (base: TvStateFixture) => TvStateFixture;
}

// A script that compiles, which the assistant writes in the scenario that compiles one.
const TWO_AVERAGES = [
  '//@version=6',
  'indicator("Two moving averages", overlay=true)',
  'fast = ta.sma(close, 9)',
  'slow = ta.sma(close, 21)',
  'plot(fast, "Fast")',
  'plot(slow, "Slow")',
  '',
].join('\n');

// A script that declares Pine v6 and uses names of v4. The compiler rejects them in v6, and the
// rules of the smart compile know them. The header is what makes them errors: a script without
// //@version is read as an old version, in which these names are valid, so it would need no fix.
const OLD_NAMES = ['//@version=6', 'study("RSI line")', 'plot(rsi(close, 14))', ''].join('\n');

export const SCENARIOS: Scenario[] = [
  {
    title: 'Read the chart',
    prompt:
      'What am I looking at on my chart? ' +
      'Tell me the symbol, the timeframe and which indicators are on it.',
    steps: [{ tool: 'chart_get_state', arguments: {} }],
    summary:
      'You are looking at NASDAQ:AAPL on the daily timeframe (resolution 1D), drawn as candles. ' +
      'The chart shows 2024-07-20 to 2024-10-27 and has two indicators, a Moving Average and a ' +
      'Relative Strength Index, plus 3 drawings. The layout is a single chart.',
  },
  {
    title: 'Switch symbol and timeframe',
    prompt: 'Show me Microsoft on the 1 hour chart.',
    steps: [
      { tool: 'chart_set_symbol', arguments: { symbol: 'NASDAQ:MSFT' } },
      { tool: 'chart_set_timeframe', arguments: { timeframe: '1h' } },
    ],
    summary:
      'The chart now shows NASDAQ:MSFT, where it showed NASDAQ:AAPL before, on the 1 hour ' +
      'timeframe. TradingView writes that timeframe as resolution 60, and the chart was on 1D. ' +
      'Both changes took effect.',
  },
  {
    title: 'Read the last candles',
    prompt: 'Show me the last 3 daily candles.',
    steps: [{ tool: 'data_get_ohlcv', arguments: { count: 3 } }],
    summary:
      'These are the last three daily bars of NASDAQ:AAPL, oldest first. The latest one, from ' +
      '2024-10-27, opened at 103.58, ranged from 102.91 to 103.72 and closed at 103.42 on a ' +
      'volume of 4,035,204. The bar before it, from 2024-10-26, closed at 103.58, so the chart ' +
      'ended a little lower. All three bars were returned (complete is true).',
  },
  {
    title: 'Read indicator values',
    prompt: 'What does the moving average on my chart read right now?',
    steps: [
      { tool: 'indicator_list', arguments: {} },
      { tool: 'indicator_get_values', arguments: { id: 'STUDY01' } },
    ],
    summary:
      'The chart has two indicators: the Moving Average (MA 9 close, id STUDY01), which is ' +
      'visible, and the Relative Strength Index (RSI 14 close), which is hidden. The moving ' +
      'average reads 103.42 on the latest bar, from 2024-10-27.',
  },
  {
    title: 'Add an indicator to a full chart',
    prompt: 'Add the MACD to my chart.',
    steps: [
      { tool: 'indicator_search', arguments: { query: 'macd' } },
      { tool: 'indicator_add', arguments: { name: 'STD;MACD' }, expectError: 'PLAN_LIMIT' },
    ],
    // The chart of the fixture holds two indicators, and the limit of the plan is made equal to
    // that number, so that it stays full whatever the fixture holds.
    fixture: (base) => ({
      ...base,
      planLimits: { ...base.planLimits, INDICATORS_ON_CHART: base.studies.length },
    }),
    summary:
      'TradingView has the Moving Average Convergence Divergence (MACD, id STD;MACD), but it was ' +
      'not added: the chart already holds as many indicators as the plan allows, 2 (the error is ' +
      'PLAN_LIMIT, for INDICATORS_ON_CHART). To make room, one of the two indicators would have ' +
      'to go. indicator_remove can remove it, but it needs confirm: true for an indicator that ' +
      'this session did not add, so the assistant asks you before it does.',
  },
  {
    title: 'Write and compile a Pine script',
    prompt:
      'Write a Pine Script indicator that plots a 9-bar and a 21-bar moving average of the close, ' +
      'and check that it compiles.',
    steps: [
      { tool: 'pine_new', arguments: { type: 'indicator', source: TWO_AVERAGES } },
      { tool: 'pine_compile', arguments: {} },
    ],
    summary:
      'The script is in the Pine Editor as a new script that is not saved yet (script is null and ' +
      'draft is true), and it compiles: success is true, with no errors and no warnings. It was ' +
      'not added to the chart (addedToChart is false).',
  },
  {
    title: 'Fix a Pine script with smart compile',
    prompt: 'The script in my Pine Editor will not compile. Can you fix it?',
    steps: [{ tool: 'pine_smart_compile', arguments: {} }],
    fixture: (base) => ({
      ...base,
      pineEditor: { ...base.pineEditor, open: 'dialog', source: OLD_NAMES, savedSource: OLD_NAMES },
    }),
    summary:
      'The first attempt failed at line 2, column 1: the compiler could not find the function ' +
      'study, a name of Pine v4 in a script that says //@version=6, and stopped there. The rules ' +
      'know every such name, so two fixes were applied, study( became indicator( and rsi( became ' +
      'ta.rsi(, and the second attempt compiled (success is true). The diff shows what changed. ' +
      'The Pine Editor still holds your original text (writtenBack is false), and the assistant ' +
      'can write the fixed text into it if you want it there.',
  },
  {
    title: 'Read backtest results',
    prompt: 'How did the strategy on my chart do in the backtest?',
    steps: [
      { tool: 'strategy_get_results', arguments: {} },
      { tool: 'strategy_get_trades', arguments: {} },
    ],
    fixture: (base) => withStudies(base, SAMPLE_STRATEGY),
    summary:
      'The RSI Strategy (id STRAT01) made a net profit of 155 USD, 1.55% of its initial capital ' +
      'of 10,000, over 3 closed trades. 2 of them won (66.67%), the profit factor is 4.1 and the ' +
      'largest drawdown is 60. Long trades made 205 and the short trade lost 50. A fourth trade ' +
      'is still open, with an open profit and loss of -20. The trades are listed oldest first.',
  },
];
