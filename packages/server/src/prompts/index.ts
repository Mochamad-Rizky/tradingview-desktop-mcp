import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GetPromptResult, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { TvMcpError } from '../core/errors.js';
import { toMcpError } from '../core/mcp-error.js';
import { normalizeTimeframe } from '../tools/chart/mappers.js';
import { startOf, type ReplayStartChoice } from '../tools/replay/mappers.js';

// The prompts of design spec 7. A prompt is one user message that tells the model which tools to
// call, in which order, and what to report back; reading one asks TradingView nothing. The tools
// are named as the registry names them, which a test checks. A message never asks for more than the
// tools are meant to do: it has the model pass confirm: true only once the user agreed, and ask the
// user before it discards or removes anything that was theirs. Only an edit the model made in the
// Pine Editor and did not save passes without confirm: true; a refusal can come over the model's
// own text too, once TradingView kept it across a close.

// What multi_timeframe_review reviews when it is given no timeframes, and how many it takes at
// most: each one costs three tool calls.
const DEFAULT_TIMEFRAMES = '1D,4h,1h';
const MAX_TIMEFRAMES = 8;

// The timeframe replay_practice_session practices on when it is given none: TradingView replays a
// daily, weekly or monthly chart on every plan, and an intraday one only on a plan with
// BAR_REPLAY_INTRADAY, where replay_start answers PLAN_LIMIT otherwise.
const DEFAULT_REPLAY_TIMEFRAME = '1D';

// The longest text each argument takes. They bound what a message holds, nothing more.
const MAX_LENGTH = {
  date: 64,
  focus: 500,
  idea: 2000,
  symbol: 200,
  timeframe: 16,
  timeframes: 200,
};

// The last line of every message. The profile and the tool filter decide which tools a server
// offers (the core profile leaves some of the tools named here out), and a model that is told so
// skips a step instead of failing on a tool that is not there.
const MISSING_TOOLS =
  'If this server does not offer a tool named above (the profile and the tool filter decide ' +
  'which it offers), skip its step and say so in your report.';

// The error for an argument that cannot be used: invalid params, with the error payload of design
// spec 5.2 as its data.
function invalidArgument(message: string, hint: string): McpError {
  return toMcpError(new TvMcpError('INVALID_INPUT', message, { hint }));
}

// A message of one user turn.
function userMessage(lines: readonly string[]): GetPromptResult {
  return { messages: [{ role: 'user', content: { type: 'text', text: lines.join('\n') } }] };
}

// "1. First step", "2. Second step", and so on.
function numbered(steps: readonly string[]): string[] {
  return steps.map((step, index) => `${String(index + 1)}. ${step}`);
}

// The text of an optional argument, trimmed. A blank one counts as not given: a client that shows
// every argument as a form field sends an empty text for one that was left alone.
function given(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text === undefined || text === '' ? undefined : text;
}

// The resolution TradingView uses for a timeframe as written. A timeframe that chart_set_timeframe
// cannot read is refused with the forms that are accepted.
function resolutionOf(timeframe: string): string {
  try {
    return normalizeTimeframe(timeframe);
  } catch (error) {
    throw toMcpError(error);
  }
}

// Where replay starts for a date as written, as replay_start reads it: at the time it names, at the
// first bar replay can reach (first) or at a random bar (random). A date that replay_start cannot
// read is refused with the forms it takes. The message keeps a time as written.
function replayStartOf(date: string): ReplayStartChoice['start'] {
  try {
    return startOf(date).start;
  } catch (error) {
    throw toMcpError(error);
  }
}

// The timeframes of a comma-separated list, trimmed and otherwise as written. Each must be one that
// chart_set_timeframe takes, the list may not hold an empty entry or one timeframe twice (1h and
// 60 are one), and it holds eight at most. The list is checked here and not converted by the
// schema, which only bounds its length, so that the text stays as the client wrote it.
function parseTimeframes(list: string): string[] {
  const entries = list.split(',').map((entry) => entry.trim());
  if (entries.length > MAX_TIMEFRAMES) {
    throw invalidArgument(
      `The timeframes list has ${String(entries.length)} entries, and at most ` +
        `${String(MAX_TIMEFRAMES)} are allowed`,
      'Review fewer timeframes at a time.',
    );
  }
  if (entries.includes('')) {
    throw invalidArgument(
      'The timeframes list has an empty entry',
      'Give timeframes separated by commas, such as 1D,4h,1h.',
    );
  }
  const written = new Map<string, string>();
  for (const entry of entries) {
    const resolution = resolutionOf(entry);
    const earlier = written.get(resolution);
    if (earlier !== undefined) {
      throw invalidArgument(
        earlier === entry
          ? `The timeframe ${entry} is in the list twice`
          : `The timeframes ${earlier} and ${entry} are the same timeframe`,
        'Name each timeframe once.',
      );
    }
    written.set(resolution, entry);
  }
  return entries;
}

function analyzeCurrentChart(focus: string | undefined): GetPromptResult {
  return userMessage([
    'Analyze the chart that TradingView shows now, with the tools of this server. Only read: ' +
      'change nothing on the chart.',
    '',
    ...numbered([
      'chart_get_state: note the symbol, the timeframe (resolution), the visible range and the ' +
        'indicators on the chart.',
      'data_get_ohlcv: read the bars of that chart. The default count is enough for the trend ' +
        'and the levels near the price; ask for more only when you need a longer view.',
      'indicator_list: list the indicators on the chart with their inputs.',
      'indicator_get_values: for each indicator worth reading, take its id from indicator_list ' +
        'and read its latest values; ask for a few bars when you need to see its direction.',
    ]),
    '',
    'Then report:',
    '- Trend: its direction on this timeframe, and the bars that show it.',
    '- Levels: the support and resistance levels nearest to the last price, and the bars that ' +
      'mark them.',
    '- Indicators: what each indicator reads now, and what that says about the trend.',
    ...(focus === undefined ? [] : [`- Focus: ${focus}. Cover it in a section of its own.`]),
    'Base every statement on the data you read, and say so when the chart has no indicators or ' +
      'too few bars.',
    MISSING_TOOLS,
  ]);
}

function multiTimeframeReview(timeframes: readonly string[]): GetPromptResult {
  const list = timeframes.join(', ');
  return userMessage([
    `Review the chart that TradingView shows across these timeframes, in this order: ${list}.`,
    '',
    ...numbered([
      'chart_get_state: note the symbol, the timeframe (resolution) the chart shows now, and the ' +
        'indicators on the chart with their ids. You restore this timeframe at the end.',
      'chart_get_visible_range: note from and to, the period the chart shows now. A change of ' +
        'timeframe moves the view, so you put this period back at the end as well.',
      `For each of ${list}, in this order: chart_set_timeframe with that timeframe; ` +
        'data_get_ohlcv for its bars (the default count is enough); indicator_get_values for ' +
        'each indicator on the chart, if it has any (the latest values are enough).',
      'Restore the original timeframe: chart_set_timeframe with the one you noted in step 1. ' +
        'Then restore the original view: chart_set_visible_range with the from and to you noted ' +
        'in step 2, so that the chart shows what it showed before. Do both even when a step ' +
        'above failed, and check that the answers report that timeframe and that period (the ' +
        'chart shows whole bars, so its ends can move to the nearest bar).',
    ]),
    '',
    'Then report the alignment across the timeframes:',
    '- For each timeframe: the trend, the nearest support and resistance, and what the ' +
      'indicators read.',
    '- Where the timeframes agree and where they disagree.',
    '- A verdict: aligned up, aligned down or mixed, and what would change it.',
    'Base every statement on the data you read.',
    MISSING_TOOLS,
  ]);
}

function writeAndBacktestStrategy(
  idea: string,
  symbol: string | undefined,
  timeframe: string | undefined,
): GetPromptResult {
  const setup = [
    ...(symbol === undefined ? [] : [`chart_set_symbol with ${symbol}`]),
    ...(timeframe === undefined ? [] : [`chart_set_timeframe with ${timeframe}`]),
  ];
  return userMessage([
    'Turn this trading idea into a Pine Script strategy, and backtest it in TradingView:',
    '',
    idea,
    '',
    'Work through these steps in order. When one fails in a way you cannot fix, stop and report ' +
      'its error with its hint instead of going on.',
    '',
    ...numbered([
      ...(setup.length === 0 ? [] : [`Set up the chart: ${setup.join(', then ')}.`]),
      'pine_new with type strategy and, as source, the strategy you write from the idea: ' +
        '//@version=6, a strategy() declaration, the entry and exit rules of the idea, and an ' +
        'input for each parameter. If it fails with CONFIRMATION_REQUIRED, the Pine Editor holds ' +
        'unsaved text: ask the user before you call it again with confirm: true, and never ' +
        'discard that text on your own. While the editor holds your script as an edit you made ' +
        'and did not save, changing it needs no confirm: true: the server tells that edit from ' +
        'text of the user.',
      'pine_smart_compile with writeBack: true. It compiles the text, applies the rule-based ' +
        'fixes it knows and writes the fixed text back. If it fails with CONFIRMATION_REQUIRED, ' +
        'the editor no longer holds your edit as you left it: the user may have typed in it, or ' +
        'TradingView kept the text across a close of the editor, after which even your own text ' +
        'needs confirm: true. Ask the user before you pass confirm: true. If errors remain, fix ' +
        'the source yourself, put it in the editor with pine_set_source and call ' +
        'pine_smart_compile again, until the script compiles without errors.',
      'pine_compile with addToChart: true, which adds the strategy to the chart. It can fail ' +
        'with PLAN_LIMIT when the chart already holds as many indicators as the plan allows. Do ' +
        'not remove anything on your own then: tell the user, and offer to take one indicator ' +
        'off (indicator_list shows them, indicator_remove removes one, and needs confirm: true ' +
        'for an indicator you did not add). When there is room, call pine_compile with ' +
        'addToChart: true again.',
      'strategy_get_results with the studyId that pine_compile returned, for the performance of ' +
        'the strategy. TradingView calculates the report after the strategy is added: if it ' +
        'fails with NOT_AVAILABLE because the report is not ready, wait a moment and call it ' +
        'again.',
      'strategy_get_trades with the same studyId, for the trades.',
    ]),
    '',
    'Then summarize the backtest:',
    '- The idea and the rules you coded, with the inputs you chose.',
    '- The symbol and timeframe it ran on (chart_get_state tells them).',
    '- From strategy_get_results: the net profit, the number of trades, the percent profitable, ' +
      'the profit factor and the max drawdown, in the currency it reports.',
    '- From strategy_get_trades: the best and the worst trades, and whether the result comes ' +
      'steadily or from a few trades.',
    '- How far to trust it: a backtest only describes the past, and it counts fees and slippage ' +
      'only when the strategy sets them.',
    MISSING_TOOLS,
  ]);
}

function debugPineScript(): GetPromptResult {
  return userMessage([
    'Find out why the script in the Pine Editor of TradingView fails to compile or misbehaves, ' +
      'and explain how to fix it. Only read and compile: do not change the text of the editor, ' +
      'and save nothing.',
    '',
    ...numbered([
      'pine_get_source: read the script. If it fails with NOT_AVAILABLE the editor is closed: ' +
        'say so, and ask the user which script to open.',
      'pine_analyze: check the text offline (call it without a source) for a missing or old ' +
        'version, renamed v4 functions, declaration mistakes and similar problems.',
      'pine_compile: compile the text of the editor with the compiler of TradingView. It saves ' +
        'nothing and touches neither the editor nor the chart.',
      'pine_get_errors: read the errors and warnings of that compilation again, with their lines ' +
        'and columns.',
      'pine_smart_compile: call it without writeBack, to see which errors the rule-based fixes ' +
        'resolve and what the fixed text looks like. The text of the editor stays as it is.',
    ]),
    '',
    'Then explain each error and warning: where it is (line and column, with that line of the ' +
      'script), what the message means, why the script triggers it, and the fix as corrected ' +
      'code. Say which fixes pine_smart_compile found and which need a change of your own. When ' +
      'the script compiles without errors, say so, and explain only the warnings and the ' +
      'findings of pine_analyze. Offer to apply the fixes, but change the editor only when the ' +
      'user agrees: a change of the text needs confirm: true while the editor holds unsaved ' +
      'changes, which TradingView keeps flagging until the editor is closed.',
    MISSING_TOOLS,
  ]);
}

// A practice session on bar replay. Nothing is traded: no tool places an order (design spec 5.3,
// rule 1), and on TradingView Desktop the paper trading of replay goes through the trading service
// of the app, which the server never touches, so the trades are hypothetical ones the model keeps
// in a journal, at prices it read from the chart. A replay that was running before the session is
// the user's: the model finds out about one before it changes anything, asks what to do with it,
// and never stops it. Only the replay its own replay_start started is stopped at the end, whatever
// happened, so that no session leaves the chart in replay. replay_status, which the core profile
// leaves out, is used only where the message also says what to do without it.
function replayPracticeSession(
  start: { date: string; kind: ReplayStartChoice['start'] } | undefined,
  symbol: string | undefined,
  timeframe: string | undefined,
): GetPromptResult {
  const setup = [
    ...(symbol === undefined ? [] : [`chart_set_symbol with ${symbol}`]),
    `chart_set_timeframe with ${timeframe ?? DEFAULT_REPLAY_TIMEFRAME}`,
  ];
  return userMessage([
    'Run a bar replay practice session with me in TradingView: replay the chart from a point in ' +
      'the past, bar by bar, let me decide at each step what I would trade, and keep score. It is ' +
      'practice only: nothing is traded.',
    '',
    ...numbered([
      'chart_get_state: note the symbol and the timeframe the chart shows.',
      'Before you change anything, find out whether a replay is already running on the chart. If ' +
        'this server offers replay_status, call it: a replay runs while active is true, and may ' +
        'run while active is null. If it does not offer replay_status, call replay_start as in ' +
        'step 4 now, on the chart as it is: it fails with NOT_AVAILABLE, saying so, when a replay ' +
        'is already running or TradingView cannot tell whether one is, and if it starts replay ' +
        'instead, that replay is yours. If it fails in another way, no replay was running. A ' +
        'replay that was running before the session may be mine: tell me about it, ask me whether ' +
        'to practice on it from where it is or to leave it alone, and change nothing until I ' +
        'answer. If I choose to practice on it, go on with step 5 on that replay; if I want it ' +
        'left alone, end the session there.',
      `Set up the chart: ${setup.join(', then ')}.` +
        (timeframe === undefined
          ? ' The daily timeframe is the default because TradingView replays intraday timeframes ' +
            'only on plans with BAR_REPLAY_INTRADAY.'
          : '') +
        ' If replay_start started your replay in step 2 and the chart has to change, call ' +
        'replay_stop first, and start again in step 4.',
      `${startSentence(start)} Skip this step when your replay from step 2 already runs on the ` +
        'chart as set up. If it fails with PLAN_LIMIT for BAR_REPLAY_INTRADAY, the plan does not ' +
        'replay intraday timeframes: tell me, and offer to practice on the daily chart instead ' +
        '(chart_set_timeframe with 1D, then replay_start again). If it fails in another way, tell ' +
        'me its error with its hint, and ask me before you follow the hint.',
      'Note the replay date and the timeframe. If this server offers replay_status, call it ' +
        'again: active must be true. Otherwise take them from what replay_start returned (active, ' +
        'date and resolution); on a replay that was running before the session, the timeframe ' +
        'from step 1 and the date from the first replay_step.',
      'Then go bar by bar. Read the bar at the replay point with data_get_ohlcv with to set to the ' +
        'replay date and a count of 5: the last bar it returns is the bar at the replay point, and ' +
        'the ones before it give the context. Show me that bar (its date, open, high, low and ' +
        'close) and ask me for a decision: long, short or flat (flat closes an open trade). If I ' +
        'prefer, ask me only every few bars. Then replay_step, with bars: 1 or as many bars as I ' +
        'want to skip, and take the replay date it returns for the next read.',
      'Keep a written journal in the conversation: every hypothetical entry and exit with its ' +
        'date, its side (long or short) and its price, which is the close of the bar at the ' +
        'replay point as data_get_ohlcv reports it; never a price you did not read. Work out the ' +
        'hypothetical profit or loss of each closed trade, as a price difference and in percent, ' +
        'and the running total yourself, in the conversation.',
      'End the session when I say so, when replay_step returns finished: true, or when a step ' +
        'fails. If your replay_start succeeded, ALWAYS call replay_stop at the end, also after an ' +
        'error, so that the chart shows its live bars again. Never stop a replay that was running ' +
        'before the session: if we practiced on one, tell me at the end that it is still running.',
    ]),
    '',
    'Then summarize the journal: each trade with its side, its entry and exit dates and prices ' +
      'and its hypothetical profit or loss, the total, how many trades won, and what the ' +
      'decisions that worked had in common.',
    'Never place an order: there is no trading tool, and practice needs none. Do not try another ' +
      'way to trade either, such as the trading panel or the Buy and Sell buttons of TradingView.',
    MISSING_TOOLS,
  ]);
}

// The call of replay_start a practice session makes, by where replay starts: at the time the date
// names, which replay_start starts a second before, at the first bar replay can reach, or at a
// random bar, which is also where it starts without a date.
function startSentence(
  start: { date: string; kind: ReplayStartChoice['start'] } | undefined,
): string {
  const random = 'which starts replay at a random bar, so that I cannot know what comes next.';
  switch (start?.kind) {
    case undefined:
      return `replay_start without a date, ${random}`;
    case 'random':
      return `replay_start with date random, ${random}`;
    case 'first':
      return 'replay_start with date first, which starts replay at the first bar replay can reach.';
    case 'date':
      return (
        `replay_start with date ${start.date}. Replay starts just before it, so its bar comes ` +
        'with the first step.'
      );
  }
}

// Registers the prompts. They need nothing of the connection or of the tools of the server: a
// message names tools, and the model calls them.
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'analyze_current_chart',
    {
      title: 'Analyze the current chart',
      description:
        'Reads the chart that TradingView shows (its state, its bars and its indicators) and ' +
        'reports the trend, the key levels and what the indicators read.',
      argsSchema: {
        focus: z
          .string()
          .max(MAX_LENGTH.focus)
          .optional()
          .describe(
            'What to look at closely, such as support and resistance, momentum or volume. ' +
              'Default: a general review.',
          ),
      },
    },
    ({ focus }) => analyzeCurrentChart(given(focus)),
  );
  server.registerPrompt(
    'multi_timeframe_review',
    {
      title: 'Review a chart across timeframes',
      description:
        'Steps through several timeframes of the chart, reads the bars and the indicators of ' +
        'each, puts the chart back on the timeframe and the period it showed, and reports how ' +
        'they line up.',
      argsSchema: {
        timeframes: z
          .string()
          .max(MAX_LENGTH.timeframes)
          .optional()
          .describe(
            'The timeframes to review, in this order, separated by commas: ' +
              `${DEFAULT_TIMEFRAMES} by default. Each is one that chart_set_timeframe takes, and ` +
              `at most ${String(MAX_TIMEFRAMES)} are allowed.`,
          ),
      },
    },
    ({ timeframes }) =>
      multiTimeframeReview(parseTimeframes(given(timeframes) ?? DEFAULT_TIMEFRAMES)),
  );
  server.registerPrompt(
    'write_and_backtest_strategy',
    {
      title: 'Write and backtest a strategy',
      description:
        'Turns a trading idea into a Pine Script strategy, compiles it, adds it to the chart and ' +
        'summarizes the results of the Strategy Tester.',
      argsSchema: {
        idea: z
          .string()
          .min(1)
          .max(MAX_LENGTH.idea)
          .describe('The trading idea to turn into a strategy, in plain words.'),
        symbol: z
          .string()
          .max(MAX_LENGTH.symbol)
          .optional()
          .describe(
            'The symbol to test on, such as NASDAQ:AAPL. Default: the one the chart shows.',
          ),
        timeframe: z
          .string()
          .max(MAX_LENGTH.timeframe)
          .optional()
          .describe(
            'The timeframe to test on, such as 1D or 4h. Default: the one the chart shows.',
          ),
      },
    },
    ({ idea, symbol, timeframe }) => {
      const wanted = given(idea);
      if (wanted === undefined) {
        throw invalidArgument('The idea is blank', 'Describe the trading idea in a few words.');
      }
      const frame = given(timeframe);
      if (frame !== undefined) {
        // Only to refuse one that cannot be read; the message keeps it as written.
        resolutionOf(frame);
      }
      return writeAndBacktestStrategy(wanted, given(symbol), frame);
    },
  );
  server.registerPrompt(
    'debug_pine_script',
    {
      title: 'Debug the Pine script',
      description:
        'Reads the script in the Pine Editor, analyzes and compiles it, and explains each error ' +
        'with the fix for it.',
    },
    () => debugPineScript(),
  );
  server.registerPrompt(
    'replay_practice_session',
    {
      title: 'Practice reading charts with bar replay',
      description:
        'Replays the chart bar by bar from a point in the past, asks for a decision at each ' +
        'step, keeps a journal of hypothetical trades at prices read from the chart and works ' +
        'out their profit or loss. It never places an order, and it stops the replay it started ' +
        'at the end, never one that was running before.',
      argsSchema: {
        date: z
          .string()
          .max(MAX_LENGTH.date)
          .optional()
          .describe(
            'Where replay starts, as replay_start takes it: a date such as 2024-06-03, first or ' +
              'random. Default: a random bar.',
          ),
        symbol: z
          .string()
          .max(MAX_LENGTH.symbol)
          .optional()
          .describe(
            'The symbol to practice on, such as NASDAQ:AAPL. Default: the one the chart shows.',
          ),
        timeframe: z
          .string()
          .max(MAX_LENGTH.timeframe)
          .optional()
          .describe(
            `The timeframe to practice on, such as 1D or 1W. Default: ${DEFAULT_REPLAY_TIMEFRAME}. ` +
              'TradingView replays intraday timeframes only on plans with BAR_REPLAY_INTRADAY.',
          ),
      },
    },
    ({ date, symbol, timeframe }) => {
      const written = given(date);
      const start =
        written === undefined ? undefined : { date: written, kind: replayStartOf(written) };
      const frame = given(timeframe);
      if (frame !== undefined) {
        // Only to refuse one that cannot be read; the message keeps it as written.
        resolutionOf(frame);
      }
      return replayPracticeSession(start, given(symbol), frame);
    },
  );
}
