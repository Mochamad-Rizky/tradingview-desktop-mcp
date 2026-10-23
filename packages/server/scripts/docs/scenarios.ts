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

// One request for an alert, which the two alert scenarios make on a plan with room and on a full
// one.
const ALERT_PROMPT = 'Alert me when Apple crosses 110.';
const ALERT_ARGUMENTS = { condition: 'crossing', price: 110 };

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
  {
    title: 'Draw a support line',
    prompt: 'Draw a support line at 102.80 on my chart.',
    steps: [
      {
        tool: 'drawing_create',
        arguments: {
          shape: 'horizontal_line',
          points: [{ time: '2024-10-27', price: 102.8 }],
          text: 'Support',
        },
      },
      { tool: 'drawing_list', arguments: {} },
    ],
    // The chart holds one drawing of the user, so that the list shows it next to the new line.
    fixture: (base) => ({ ...base, shapes: base.shapes.slice(0, 1) }),
    summary:
      'A horizontal line at 102.8, labeled Support, is on the chart now, with the id DRW001. The ' +
      'chart holds 2 drawings: a trend line that was there before and the new line, which ' +
      'drawing_list marks as created by this session (createdByServer is true). drawing_remove ' +
      'can remove the line without confirm: true, while removing the trend line, which is yours, ' +
      'would need it.',
  },
  {
    title: 'Create a price alert',
    prompt: ALERT_PROMPT,
    steps: [{ tool: 'alert_create', arguments: ALERT_ARGUMENTS }],
    summary:
      'The alert is set, with the id 9001. It watches NASDAQ:AAPL, the symbol of the chart, and ' +
      'fires once when the price crosses 110 in either direction, then stops. Unless it fires ' +
      'first, it expires on 2024-11-26, the default expiration of TradingView. The plan had room ' +
      'for it: the alert limit of the plan is checked before anything is sent. Because this ' +
      'session created the alert, alert_delete can delete it without confirm: true.',
  },
  {
    title: 'Create an alert when the plan is full',
    prompt: ALERT_PROMPT,
    steps: [
      { tool: 'alert_create', arguments: ALERT_ARGUMENTS, expectError: 'PLAN_LIMIT' },
      { tool: 'alert_list', arguments: {} },
    ],
    // As many active price alerts as the plan of the fixture allows, which is 3. They were set
    // before the time the page is set at, the last bar, so they expire within the 30 days a free
    // plan allows from then, before the alert of the plan with room would.
    fixture: (base) => ({
      ...base,
      alerts: [
        { id: 1, price: 100, expiration: '2024-11-03T00:00:00Z' },
        { id: 2, condition: 'cross_up', price: 105, expiration: '2024-11-10T00:00:00Z' },
        {
          id: 3,
          symbol: 'NASDAQ:MSFT',
          condition: 'cross_down',
          price: 205,
          expiration: '2024-11-17T00:00:00Z',
        },
      ],
    }),
    summary:
      'No alert was created: the plan allows 3 active price alerts and 3 are in use (the error ' +
      'is PLAN_LIMIT, for SERVER_SIDE_ALERTS), which was checked before anything was sent. The ' +
      'alerts that fill the plan are NASDAQ:AAPL crossing 100, NASDAQ:AAPL crossing up 105 and ' +
      'NASDAQ:MSFT crossing down 205, all active and set to expire between 2024-11-03 and ' +
      '2024-11-17. To make room, one of them has to go: alert_delete can delete it, but it needs ' +
      'confirm: true for an alert that this session did not create, so the assistant asks you ' +
      'which one first. Stopping one in TradingView makes room too.',
  },
  {
    title: 'Add symbols to a watchlist',
    prompt: 'Add these symbols to my watchlist: NYSE:IBM, FX:EURUSD, NASDAQ:MSFT and NASDAQ:MSTF.',
    steps: [
      {
        tool: 'watchlist_add_bulk',
        arguments: { symbols: ['NYSE:IBM', 'FX:EURUSD', 'NASDAQ:MSFT', 'NASDAQ:MSTF'] },
      },
    ],
    summary:
      'Two of the four symbols were added to your active watchlist (id 101): NYSE:IBM and ' +
      'FX:EURUSD. NASDAQ:MSFT was skipped because the list holds it already, and NASDAQ:MSTF ' +
      'because the symbol search of TradingView does not know it; it may be a typo for MSFT. ' +
      'Every symbol was checked with the symbol search before anything was added, and ' +
      'watchlist_remove can take the two new ones out again without confirm: true, since this ' +
      'session added them.',
  },
  {
    title: 'Practice with bar replay',
    prompt:
      'Let me practice on a bar replay of my chart from 2024-06-03: step five bars forward, tell ' +
      'me where we are, then end the replay.',
    steps: [
      { tool: 'replay_start', arguments: { date: '2024-06-03' } },
      { tool: 'replay_step', arguments: { bars: 5 } },
      { tool: 'replay_status', arguments: {} },
      { tool: 'replay_stop', arguments: {} },
    ],
    summary:
      'Replay started on the daily chart (resolution 1D) just before 2024-06-03, at the bar of ' +
      '2024-06-02, so the bar of 2024-06-03 came with the first step. Five steps later the ' +
      'replay point is at 2024-06-07 (stepped is 5), and finished is false: there are bars left ' +
      'to replay. replay_status shows replay active, with autoplay off at 1x. Its position and ' +
      'realizedPL are null because no tool trades: practice trades are kept in the ' +
      'conversation, as the replay_practice_session prompt has the assistant do. replay_stop ' +
      'left replay (active is false), and the chart shows its live bars again.',
  },
  {
    title: 'Take a screenshot',
    prompt: 'Take a screenshot of my chart.',
    // A jpeg, which is smaller and enough to read a chart. The fake app writes it byte by byte, so
    // its size on the page is the same on every machine (a png of the fake goes through zlib).
    steps: [{ tool: 'screenshot_capture', arguments: { format: 'jpeg' } }],
    summary:
      'Here is the chart as a picture: the chart container of the active chart, with its legend, ' +
      'panes and scales but without the toolbars, a jpeg of 1180 by 640 pixels (3100 bytes), ' +
      'enough to read a chart. The assistant can look at it ' +
      'and describe what it shows; the server handed it over and kept no copy. With target ' +
      'page, the picture would show the whole chart tab, toolbars and panels included.',
  },
];
