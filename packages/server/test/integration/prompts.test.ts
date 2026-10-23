import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Config } from '../../src/config/schema.js';
import { createMcpServer } from '../../src/server.js';
import { allTools } from '../../src/tools/index.js';
import { selectTools } from '../../src/tools/registry.js';
import type { ToolRegistry } from '../../src/tools/types.js';
import { connectInMemoryClient } from '../helpers/mcp-client.js';
import {
  quietLogger,
  refusingLauncher,
  testConfig,
  unreachableConnection,
} from '../helpers/tool-context.js';

// The prompts of the server (design spec 7) through an SDK client over the in-memory transport. A
// prompt is a message for the model and asks nothing of TradingView, so every server here is
// offline: reading a prompt must work without the app.

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function startServer(
  overrides: Partial<Config> = {},
): Promise<{ client: Client; registry: ToolRegistry }> {
  const { server, registry } = createMcpServer(testConfig(overrides), {
    connection: unreachableConnection(),
    launcher: refusingLauncher(),
    logger: quietLogger,
  });
  const client = await connectInMemoryClient(server);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, registry };
}

// The one message of a prompt, which is a user message of text, as its text.
async function messageOf(
  client: Client,
  name: string,
  args: Record<string, string> = {},
): Promise<string> {
  const { messages } = await client.getPrompt({ name, arguments: args });
  expect(messages).toHaveLength(1);
  const [message] = messages;
  expect(message?.role).toBe('user');
  if (message?.content.type !== 'text') {
    throw new Error(`The prompt ${name} did not answer with text`);
  }
  return message.content.text;
}

// The prefixes of the tool names of design spec 5.1.
const DOMAINS = [
  'app',
  'chart',
  'data',
  'indicator',
  'pine',
  'strategy',
  'drawing',
  'alert',
  'watchlist',
  'layout',
  'pane',
  'tab',
  'replay',
  'screenshot',
  'ui',
  'batch',
];
const TOOL_NAME = new RegExp(`\\b(?:${DOMAINS.join('|')})_[a-z0-9]+(?:_[a-z0-9]+)*\\b`, 'g');

// The tools a message names, each once, in the order of their first mention.
function toolsNamed(text: string): string[] {
  return [...new Set(text.match(TOOL_NAME) ?? [])];
}

// Of the tools a message names, those among `steps`: the message names them all, and in the order
// of the steps, when this is `steps`.
function stepsNamed(text: string, steps: string[]): string[] {
  return toolsNamed(text).filter((name) => steps.includes(name));
}

test('lists the five prompts with their arguments', async () => {
  const { client } = await startServer();

  const { prompts } = await client.listPrompts();

  expect(
    prompts.map(({ name, arguments: args = [] }) => [
      name,
      args.map(({ name: argument, required = false }) => `${argument}${required ? '' : '?'}`),
    ]),
  ).toEqual([
    ['analyze_current_chart', ['focus?']],
    ['multi_timeframe_review', ['timeframes?']],
    ['write_and_backtest_strategy', ['idea', 'symbol?', 'timeframe?']],
    ['debug_pine_script', []],
    ['replay_practice_session', ['date?', 'symbol?', 'timeframe?']],
  ]);
  for (const prompt of prompts) {
    expect(prompt.title?.trim(), prompt.name).toBeTruthy();
    expect(prompt.description?.length, prompt.name).toBeGreaterThan(40);
    for (const argument of prompt.arguments ?? []) {
      expect(argument.description?.length, `${prompt.name} ${argument.name}`).toBeGreaterThan(10);
    }
  }
});

// Unlike the resources, which follow their tools, the prompts do not depend on which tools the
// profile registers.
test.each(['core', 'full', 'readonly'] as const)(
  'offers the five prompts with the %s profile',
  async (profile) => {
    const { client } = await startServer({ profile });

    const { prompts } = await client.listPrompts();

    expect(prompts.map(({ name }) => name)).toEqual([
      'analyze_current_chart',
      'multi_timeframe_review',
      'write_and_backtest_strategy',
      'debug_pine_script',
      'replay_practice_session',
    ]);
  },
);

describe('analyze_current_chart', () => {
  test('names the chart tools in order and asks for the trend, levels and indicator readings', async () => {
    const { client } = await startServer();

    const text = await messageOf(client, 'analyze_current_chart');

    expect(toolsNamed(text)).toEqual([
      'chart_get_state',
      'data_get_ohlcv',
      'indicator_list',
      'indicator_get_values',
    ]);
    expect(text).toMatch(/Trend/);
    expect(text).toMatch(/Levels/);
    expect(text).toMatch(/Indicators/);
    // Reading changes nothing on the chart.
    expect(text).toMatch(/change nothing/);
  });

  test('adds the focus to the report when one is given', async () => {
    const { client } = await startServer();

    const without = await messageOf(client, 'analyze_current_chart');
    const focused = await messageOf(client, 'analyze_current_chart', {
      focus: 'volume and momentum',
    });

    expect(without).not.toMatch(/focus/i);
    expect(focused).toMatch(/Focus: volume and momentum/);
    // The steps are the same with or without it.
    expect(toolsNamed(focused)).toEqual(toolsNamed(without));
  });

  test('takes a blank focus for none', async () => {
    const { client } = await startServer();

    const blank = await messageOf(client, 'analyze_current_chart', { focus: '  ' });

    expect(blank).toBe(await messageOf(client, 'analyze_current_chart'));
  });
});

describe('multi_timeframe_review', () => {
  const STEPS = [
    'chart_get_state',
    'chart_get_visible_range',
    'chart_set_timeframe',
    'data_get_ohlcv',
    'indicator_get_values',
    'chart_set_visible_range',
  ];

  test('multi_timeframe_review tells the assistant to restore the visible range too', async () => {
    const { client } = await startServer();

    const text = await messageOf(client, 'multi_timeframe_review');

    // The range is read before the first change of timeframe, and set again after the timeframe is
    // back, with the times that were read.
    expect(text.indexOf('chart_get_visible_range')).toBeGreaterThan(-1);
    expect(text.indexOf('chart_get_visible_range')).toBeLessThan(
      text.indexOf('chart_set_timeframe'),
    );
    expect(text.indexOf('chart_set_visible_range')).toBeGreaterThan(
      text.lastIndexOf('chart_set_timeframe'),
    );
    expect(text).toMatch(/chart_set_visible_range with the from and to/);
  });

  test('names its tools in order, and restores the first timeframe after the last one', async () => {
    const { client } = await startServer();

    const text = await messageOf(client, 'multi_timeframe_review');

    expect(stepsNamed(text, STEPS)).toEqual(STEPS);
    expect(toolsNamed(text)).toEqual(STEPS);
    // The timeframe to restore is the one chart_get_state reported before anything was changed.
    expect(text.indexOf('chart_get_state')).toBeLessThan(text.indexOf('chart_set_timeframe'));
    expect(text.lastIndexOf('chart_set_timeframe')).toBeGreaterThan(
      text.lastIndexOf('indicator_get_values'),
    );
    expect(text).toMatch(/restore/i);
    expect(text).toMatch(/alignment/i);
  });

  test('reviews 1D, 4h and 1h in that order when no timeframes are given', async () => {
    const { client } = await startServer();

    const text = await messageOf(client, 'multi_timeframe_review');

    expect(text).toContain('1D, 4h, 1h');
  });

  test('takes the timeframes it is given, trimmed, in their order', async () => {
    const { client } = await startServer();

    const text = await messageOf(client, 'multi_timeframe_review', {
      timeframes: ' 15m , 1W,1M ',
    });

    expect(text).toContain('15m, 1W, 1M');
    // Nothing of the default is left.
    expect(text).not.toContain('1D');
    expect(text).not.toContain('4h');
  });

  test('takes a blank list for none, which is the default', async () => {
    const { client } = await startServer();

    const blank = await messageOf(client, 'multi_timeframe_review', { timeframes: ' ' });

    expect(blank).toBe(await messageOf(client, 'multi_timeframe_review'));
  });

  test('takes eight timeframes', async () => {
    const { client } = await startServer();

    const text = await messageOf(client, 'multi_timeframe_review', {
      timeframes: '1W,1D,4h,2h,1h,30m,15m,5m',
    });

    expect(text).toContain('1W, 1D, 4h, 2h, 1h, 30m, 15m, 5m');
  });

  test.each([
    ['an unknown timeframe', '1D,foo', /foo/],
    ['an empty entry', '1D,,1h', /empty/],
    ['a list of separators', ',', /empty/],
    ['a timeframe twice', '1D,4h,1D', /1D/],
    ['one timeframe written two ways', '1h,60', /60/],
    ['more than eight timeframes', '1,2,3,4,5,15,30,45,60', /at most 8/],
  ])('refuses %s', async (_what, timeframes, message) => {
    const { client } = await startServer();

    await expect(
      client.getPrompt({ name: 'multi_timeframe_review', arguments: { timeframes } }),
    ).rejects.toMatchObject({
      // The mistake of the client, with the error payload of design spec 5.2 as its data.
      code: -32602,
      message: expect.stringMatching(message) as string,
      data: { code: 'INVALID_INPUT', hint: expect.any(String) as string },
    });
  });

  test('tells the forms a timeframe can take when one cannot be read', async () => {
    const { client } = await startServer();

    await expect(
      client.getPrompt({ name: 'multi_timeframe_review', arguments: { timeframes: '1D,foo' } }),
    ).rejects.toMatchObject({
      data: { hint: expect.stringMatching(/4h is 240/) as string, details: { timeframe: 'foo' } },
    });
  });

  test('refuses a text that is too long before it reads it', async () => {
    const { client } = await startServer();

    await expect(
      client.getPrompt({
        name: 'multi_timeframe_review',
        arguments: { timeframes: '1D,'.repeat(100) },
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });
});

describe('write_and_backtest_strategy', () => {
  const IDEA = 'Buy when the 20 bar high breaks, sell when the price closes below the 10 bar low';
  const STEPS = [
    'pine_new',
    'pine_smart_compile',
    'pine_compile',
    'strategy_get_results',
    'strategy_get_trades',
  ];

  test('write_and_backtest_strategy names pine_new, pine_smart_compile, pine_compile and strategy_get_results', async () => {
    const { client } = await startServer();

    const text = await messageOf(client, 'write_and_backtest_strategy', { idea: IDEA });

    expect(stepsNamed(text, STEPS)).toEqual(STEPS);
    expect(text).toContain(IDEA);
  });

  test('writes a strategy script, compiles it with the fixes written back, and adds it to the chart', async () => {
    const { client } = await startServer();

    const text = await messageOf(client, 'write_and_backtest_strategy', { idea: IDEA });

    expect(text).toMatch(/pine_new[^.]*type strategy/);
    expect(text).toMatch(/pine_smart_compile[^.]*writeBack: true/);
    expect(text).toMatch(/pine_compile[^.]*addToChart: true/);
    // The results and the trades are those of the strategy that was added.
    expect(text).toMatch(/strategy_get_results[^.]*studyId/);
    expect(text).toMatch(/strategy_get_trades[^.]*studyId/);
  });

  test('says what to do when adding the strategy fails with PLAN_LIMIT', async () => {
    const { client } = await startServer();

    const text = await messageOf(client, 'write_and_backtest_strategy', { idea: IDEA });

    expect(text.indexOf('PLAN_LIMIT')).toBeGreaterThan(text.indexOf('addToChart'));
    // It does not take the indicators of the user off the chart on its own.
    expect(text).toMatch(/ask the user/i);
    expect(text).toMatch(/indicator_remove/);
  });

  test('does not discard unsaved text of the Pine Editor on its own', async () => {
    const { client } = await startServer();

    const text = await messageOf(client, 'write_and_backtest_strategy', { idea: IDEA });

    expect(text).toMatch(/CONFIRMATION_REQUIRED/);
    expect(text).toMatch(/never discard/i);
  });

  test('changes the script it wrote without confirm: true, and asks the user once the text is no longer its own', async () => {
    const { client } = await startServer();

    const text = await messageOf(client, 'write_and_backtest_strategy', { idea: IDEA });

    // Only an edit of its own that is not saved yet passes without confirm.
    expect(text).toMatch(
      /as an edit you made and did not save, changing it needs no confirm: true/,
    );
    expect(text).not.toMatch(/writeBack: true and confirm: true/);
    expect(text).not.toMatch(/with confirm: true again/);
    // A refusal after that can come over its own text too, and only the user may let it go.
    const compile = text.slice(text.indexOf('pine_smart_compile with writeBack'));
    expect(compile).toMatch(/CONFIRMATION_REQUIRED[^.]*no longer holds your edit as you left it/);
    expect(compile).toMatch(/kept the text across a close/);
    expect(compile).toMatch(/ask the user before you pass confirm: true/i);
  });

  test('asks for a summary of the results', async () => {
    const { client } = await startServer();

    const text = await messageOf(client, 'write_and_backtest_strategy', { idea: IDEA });

    const summary = text.slice(text.indexOf('Then summarize'));
    expect(summary).toMatch(/net profit/i);
    expect(summary).toMatch(/percent profitable/i);
    expect(summary).toMatch(/drawdown/i);
    expect(summary).toMatch(/trades/i);
  });

  test('changes the symbol and the timeframe first when it is given them', async () => {
    const { client } = await startServer();

    const text = await messageOf(client, 'write_and_backtest_strategy', {
      idea: IDEA,
      symbol: 'NASDAQ:MSFT',
      timeframe: '4h',
    });

    expect(toolsNamed(text).slice(0, 3)).toEqual([
      'chart_set_symbol',
      'chart_set_timeframe',
      'pine_new',
    ]);
    expect(text).toMatch(/chart_set_symbol with NASDAQ:MSFT/);
    expect(text).toMatch(/chart_set_timeframe with 4h/);
  });

  test('leaves the chart as it is when it is given neither', async () => {
    const { client } = await startServer();

    const plain = await messageOf(client, 'write_and_backtest_strategy', { idea: IDEA });
    const symbolOnly = await messageOf(client, 'write_and_backtest_strategy', {
      idea: IDEA,
      symbol: 'NASDAQ:MSFT',
    });
    const timeframeOnly = await messageOf(client, 'write_and_backtest_strategy', {
      idea: IDEA,
      timeframe: '1D',
    });
    const blank = await messageOf(client, 'write_and_backtest_strategy', {
      idea: IDEA,
      symbol: ' ',
      timeframe: '',
    });

    expect(toolsNamed(plain)).not.toContain('chart_set_symbol');
    expect(toolsNamed(plain)).not.toContain('chart_set_timeframe');
    expect(toolsNamed(symbolOnly)).toContain('chart_set_symbol');
    expect(toolsNamed(symbolOnly)).not.toContain('chart_set_timeframe');
    expect(toolsNamed(timeframeOnly)).toContain('chart_set_timeframe');
    expect(toolsNamed(timeframeOnly)).not.toContain('chart_set_symbol');
    // A blank symbol and timeframe count as none.
    expect(blank).toBe(plain);
  });

  test('needs an idea', async () => {
    const { client } = await startServer();

    // Missing: the schema refuses it.
    await expect(
      client.getPrompt({ name: 'write_and_backtest_strategy', arguments: {} }),
    ).rejects.toMatchObject({ code: -32602 });
    // Blank: refused when the message is made, like a blank symbol in the tools.
    await expect(
      client.getPrompt({ name: 'write_and_backtest_strategy', arguments: { idea: '   ' } }),
    ).rejects.toMatchObject({
      code: -32602,
      message: expect.stringMatching(/idea/) as string,
      data: { code: 'INVALID_INPUT' },
    });
  });

  test('refuses a timeframe it cannot read, and a list where one timeframe is wanted', async () => {
    const { client } = await startServer();

    for (const timeframe of ['foo', '1D,4h']) {
      await expect(
        client.getPrompt({
          name: 'write_and_backtest_strategy',
          arguments: { idea: IDEA, timeframe },
        }),
        timeframe,
      ).rejects.toMatchObject({
        code: -32602,
        data: { code: 'INVALID_INPUT', details: { timeframe } },
      });
    }
  });
});

describe('debug_pine_script', () => {
  test('names the Pine tools in order and asks for each error with its fix', async () => {
    const { client } = await startServer();

    const text = await messageOf(client, 'debug_pine_script');

    expect(toolsNamed(text)).toEqual([
      'pine_get_source',
      'pine_analyze',
      'pine_compile',
      'pine_get_errors',
      'pine_smart_compile',
    ]);
    expect(text).toMatch(/explain each error/i);
    expect(text).toMatch(/fix/i);
  });

  test('reads and compiles only, and leaves the text of the editor as it is', async () => {
    const { client } = await startServer();

    const text = await messageOf(client, 'debug_pine_script');

    expect(text).toMatch(/do not change the text of the editor/i);
    expect(text).not.toMatch(/writeBack: true/);
  });

  test('says that applying a fix needs confirm: true while the editor counts as unsaved', async () => {
    const { client } = await startServer();

    const text = await messageOf(client, 'debug_pine_script');

    expect(text).toMatch(/confirm: true/);
    expect(text).toMatch(/until the editor is closed/i);
  });

  test('takes no arguments, and ignores what a client sends', async () => {
    const { client } = await startServer();

    const plain = await messageOf(client, 'debug_pine_script');
    const sent = await messageOf(client, 'debug_pine_script', { anything: 'at all' });

    expect(sent).toBe(plain);
  });
});

describe('replay_practice_session', () => {
  // The text of step `number` of a message: its numbered line, without the number.
  function stepOf(text: string, number: number): string {
    const match = new RegExp(`^${String(number)}\\. (.*)$`, 'm').exec(text);
    if (match === null) {
      throw new Error(`The message has no step ${String(number)}`);
    }
    return match[1] ?? '';
  }

  // The steps: read the chart, check for a running replay, set up the chart, start, note where
  // replay is, go bar by bar, keep the journal, end.
  const CHECK = 2;
  const SETUP = 3;
  const START = 4;
  const NOTE = 5;
  const END = 8;

  test('replay_practice_session names replay_start, replay_step, replay_status and replay_stop and tells the assistant to stop replay at the end', async () => {
    const { client } = await startServer();

    const text = await messageOf(client, 'replay_practice_session');

    expect(toolsNamed(text)).toEqual(
      expect.arrayContaining(['replay_start', 'replay_step', 'replay_status', 'replay_stop']),
    );
    // The stop is the last call, after every other tool the message names. It is made whenever
    // the session started a replay of its own, also when a step went wrong, and only then.
    const stop = text.lastIndexOf('replay_stop');
    for (const tool of toolsNamed(text).filter((name) => name !== 'replay_stop')) {
      expect(text.lastIndexOf(tool), tool).toBeLessThan(stop);
    }
    expect(stepOf(text, END)).toMatch(
      /If your replay_start succeeded, ALWAYS call replay_stop at the end, also after an error/,
    );
    // The journal is summed up once replay is left.
    expect(text.indexOf('Then summarize the journal')).toBeGreaterThan(stop);
  });

  test('checks whether a replay is already running before it changes anything, and asks the user about one', async () => {
    const { client } = await startServer();

    const text = await messageOf(client, 'replay_practice_session', { symbol: 'NASDAQ:MSFT' });

    expect(stepOf(text, 1)).toMatch(/^chart_get_state: note the symbol and the timeframe/);
    const check = stepOf(text, CHECK);
    expect(check).toMatch(
      /^Before you change anything, find out whether a replay is already running/,
    );
    expect(check).toMatch(/If this server offers replay_status, call it/);
    // Nothing changes before the check: the chart tools that change come after it.
    expect(text.indexOf('chart_set_symbol')).toBeGreaterThan(text.indexOf(check));
    expect(text.indexOf('chart_set_timeframe')).toBeGreaterThan(text.indexOf(check));
    // A running replay may be the user's, who decides what happens to it.
    expect(check).toMatch(/may be mine/);
    expect(check).toMatch(/practice on it from where it is or to leave it alone/);
    expect(check).toMatch(/change nothing until I answer/);
  });

  test('without replay_status, learns from a refused replay_start that a replay runs, before it sets up the chart', async () => {
    const { client } = await startServer();

    const text = await messageOf(client, 'replay_practice_session');

    const check = stepOf(text, CHECK);
    expect(check).toMatch(
      /If it does not offer replay_status, call replay_start as in step 4 now, on the chart as it is/,
    );
    expect(check).toMatch(/fails with NOT_AVAILABLE[^.]*when a replay is already running/);
    // A replay that start gave is the session's own; any other refusal means none was running.
    expect(check).toMatch(/if it starts replay instead, that replay is yours/);
    expect(check).toMatch(/If it fails in another way, no replay was running/);
    // The session's own replay is left before the chart changes, and started again after.
    expect(stepOf(text, SETUP)).toMatch(
      /If replay_start started your replay in step 2 and the chart has to change, call replay_stop first/,
    );
    expect(stepOf(text, START)).toMatch(/when your replay from step 2 already runs on the chart/);
  });

  test('never stops a replay that was running before the session, and says that it still runs', async () => {
    const { client } = await startServer();

    const text = await messageOf(client, 'replay_practice_session');

    // Practicing on the user's replay skips the setup and the start, which would change it.
    expect(stepOf(text, CHECK)).toMatch(/If I choose to practice on it, go on with step 5/);
    expect(stepOf(text, CHECK)).toMatch(/if I want it left alone, end the session there/);
    const end = stepOf(text, END);
    expect(end).toMatch(/Never stop a replay that was running before the session/);
    expect(end).toMatch(/tell me at the end that it is still running/);
  });

  test('names replay_status, which the core profile leaves out, only where it says what to do without it', async () => {
    const { client } = await startServer();
    const core = new Set(
      selectTools(allTools, { profile: 'core', patterns: [] }).map(({ name }) => name),
    );

    const text = await messageOf(client, 'replay_practice_session', {
      symbol: 'NASDAQ:AAPL',
      timeframe: '1D',
    });

    expect(toolsNamed(text).filter((name) => !core.has(name))).toEqual(['replay_status']);
    const sentences = text
      .split(/(?<=\.)\s+/)
      .filter((sentence) => sentence.includes('replay_status'));
    expect(sentences.length).toBeGreaterThan(0);
    for (const sentence of sentences) {
      expect(sentence).toMatch(/If (?:this server|it does not) (?:offers|offer) replay_status/);
    }
    // Without it, the date and the timeframe come from what replay_start returned.
    expect(stepOf(text, NOTE)).toMatch(
      /Otherwise take them from what replay_start returned \(active, date and resolution\)/,
    );
  });

  test('takes a replay as running in the note of the replay date as it does in the check, active null included', async () => {
    const { client } = await startServer();

    const text = await messageOf(client, 'replay_practice_session');

    // The check lets the session practice on a replay whose active is null, so the note must too.
    expect(stepOf(text, CHECK)).toMatch(
      /a replay runs while active is true, and may run while active is null/,
    );
    expect(stepOf(text, NOTE)).not.toMatch(/active must be true/);
    expect(stepOf(text, NOTE)).toMatch(
      /replay runs while active is true, and may run while it is null/,
    );
  });

  test('sets the chart to the symbol and the timeframe it is given before replay starts', async () => {
    const { client } = await startServer();

    const text = await messageOf(client, 'replay_practice_session', {
      symbol: 'NASDAQ:MSFT',
      timeframe: '1W',
    });

    expect(stepOf(text, SETUP)).toMatch(
      /^Set up the chart: chart_set_symbol with NASDAQ:MSFT, then chart_set_timeframe with 1W\./,
    );
    expect(stepOf(text, START)).toMatch(/^replay_start /);
  });

  test('practices on the daily chart when it is given no timeframe, since intraday replay is plan-gated', async () => {
    const { client } = await startServer();

    const text = await messageOf(client, 'replay_practice_session');

    expect(toolsNamed(text)).not.toContain('chart_set_symbol');
    expect(stepOf(text, SETUP)).toMatch(/^Set up the chart: chart_set_timeframe with 1D\./);
    expect(stepOf(text, SETUP)).toMatch(/BAR_REPLAY_INTRADAY/);
    // On an intraday timeframe without intraday replay in the plan, replay_start refuses, and the
    // message says what to do then.
    const start = stepOf(text, START);
    expect(start).toMatch(/fails with PLAN_LIMIT for BAR_REPLAY_INTRADAY/);
    expect(start).toMatch(/practice on the daily chart/);
  });

  test('says where replay starts for a date, for first and for random', async () => {
    const { client } = await startServer();

    const dated = await messageOf(client, 'replay_practice_session', { date: '2024-03-01' });
    const first = await messageOf(client, 'replay_practice_session', { date: ' First ' });
    const random = await messageOf(client, 'replay_practice_session', { date: 'random' });
    const none = await messageOf(client, 'replay_practice_session');

    expect(stepOf(dated, START)).toMatch(
      /^replay_start with date 2024-03-01\. Replay starts just before it, so its bar comes with the first step\./,
    );
    expect(stepOf(first, START)).toMatch(
      /^replay_start with date first, which starts replay at the first bar replay can reach\./,
    );
    expect(stepOf(random, START)).toMatch(
      /^replay_start with date random, which starts replay at a random bar, so that I cannot know what comes next\./,
    );
    expect(stepOf(none, START)).toMatch(
      /^replay_start without a date, which starts replay at a random bar, so that I cannot know what comes next\./,
    );
    for (const text of [first, random, none]) {
      expect(text).not.toMatch(/starts just before it/);
    }
    // The steps are the same however replay starts.
    for (const text of [first, random, none]) {
      expect(toolsNamed(text)).toEqual(toolsNamed(dated));
    }
  });

  test('has the user decide at the steps, and keeps a journal of hypothetical trades with prices read from the chart', async () => {
    const { client } = await startServer();

    const text = await messageOf(client, 'replay_practice_session');

    expect(text).toMatch(/long, short or flat/);
    expect(text).toMatch(/every few bars/);
    expect(text).toMatch(/written journal/);
    expect(text).toMatch(/hypothetical/);
    // A price is the close of the bar at the replay point, read from the bars of the chart up to
    // that point, never one the model did not read.
    expect(text).toMatch(/data_get_ohlcv with to set to the replay date/);
    expect(text).toMatch(/never a price you did not read/i);
    // The profit and loss is worked out in the conversation.
    expect(text).toMatch(/profit or loss[^.]*in the conversation/);
  });

  test('never places an order, and does not look for another way to trade', async () => {
    const { client } = await startServer();

    const text = await messageOf(client, 'replay_practice_session');

    expect(text).toMatch(/Never place an order: there is no trading tool/);
    expect(text).toMatch(/Do not try another way to trade/);
    // No tool the message names trades or orders.
    expect(toolsNamed(text).filter((name) => /trade|order|buy|sell|position/.test(name))).toEqual(
      [],
    );
  });

  test('says in its title and description that it trades nothing and stops only its own replay', async () => {
    const { client } = await startServer();

    const { prompts } = await client.listPrompts();
    const prompt = prompts.find(({ name }) => name === 'replay_practice_session');

    expect(prompt?.title).toBe('Practice reading charts with bar replay');
    expect(prompt?.description).toMatch(/never places an order/);
    expect(prompt?.description).toMatch(/stops the replay it started at the end/);
    expect(prompt?.description).toMatch(/never one that was running before/);
  });

  test('takes blank arguments for none', async () => {
    const { client } = await startServer();

    const blank = await messageOf(client, 'replay_practice_session', {
      date: ' ',
      symbol: '',
      timeframe: '  ',
    });

    expect(blank).toBe(await messageOf(client, 'replay_practice_session'));
  });

  test('refuses a date or a timeframe it cannot read', async () => {
    const { client } = await startServer();

    for (const args of [
      { date: 'yesterday' },
      { date: '20240301' },
      { timeframe: 'foo' },
      { timeframe: '1D,4h' },
    ]) {
      await expect(
        client.getPrompt({ name: 'replay_practice_session', arguments: args }),
        JSON.stringify(args),
      ).rejects.toMatchObject({
        code: -32602,
        data: { code: 'INVALID_INPUT', hint: expect.any(String) as string },
      });
    }
  });
});

// The check that every prompt names only tools that exist is only as good as the pattern that finds
// the names in a message.
test('the pattern for tool names finds a name whether or not a tool has it', () => {
  expect(toolsNamed('Call pine_new, then pine_run and indicator_get_values.')).toEqual([
    'pine_new',
    'pine_run',
    'indicator_get_values',
  ]);
  expect(toolsNamed('The studyId and addToChart are arguments, not tools.')).toEqual([]);
});

describe('every prompt', () => {
  // Every optional argument given, so that every sentence a prompt can have is in the message.
  const FULL: Record<string, Record<string, string>> = {
    analyze_current_chart: { focus: 'volume' },
    multi_timeframe_review: { timeframes: '1W,1D,4h,15m' },
    write_and_backtest_strategy: { idea: 'Buy dips', symbol: 'NASDAQ:AAPL', timeframe: '1D' },
    debug_pine_script: {},
    replay_practice_session: { date: '2024-06-03', symbol: 'NASDAQ:AAPL', timeframe: '1D' },
  };
  // Only what is needed.
  const LEAST: Record<string, Record<string, string>> = {
    ...FULL,
    analyze_current_chart: {},
    multi_timeframe_review: {},
    write_and_backtest_strategy: { idea: 'Buy dips' },
    replay_practice_session: {},
  };

  test('names only tools that the registry has', async () => {
    const { client, registry } = await startServer();
    const registered = new Set(registry.list().map(({ name }) => name));

    for (const [name, args] of [...Object.entries(FULL), ...Object.entries(LEAST)]) {
      const named = toolsNamed(await messageOf(client, name, args));

      expect(named.length, name).toBeGreaterThanOrEqual(4);
      for (const tool of named) {
        expect(registered.has(tool), `${name} names ${tool}, which no tool has`).toBe(true);
      }
    }
  });

  test('is one user message of text', async () => {
    const { client } = await startServer();

    for (const [name, args] of Object.entries(FULL)) {
      const { messages } = await client.getPrompt({ name, arguments: args });

      expect(messages, name).toEqual([
        { role: 'user', content: { type: 'text', text: expect.any(String) as string } },
      ]);
    }
  });

  test('tells the model what to do when the server does not offer a tool it names', async () => {
    const { client } = await startServer();

    for (const [name, args] of Object.entries(FULL)) {
      expect(await messageOf(client, name, args), name).toMatch(
        /does not offer a tool named above.*skip its step and say so/s,
      );
    }
  });
});
