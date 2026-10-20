import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Config } from '../../src/config/schema.js';
import { createMcpServer } from '../../src/server.js';
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

test('lists the four prompts with their arguments', async () => {
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
  ]);
  for (const prompt of prompts) {
    expect(prompt.title?.trim(), prompt.name).toBeTruthy();
    expect(prompt.description?.length, prompt.name).toBeGreaterThan(40);
    for (const argument of prompt.arguments ?? []) {
      expect(argument.description?.length, `${prompt.name} ${argument.name}`).toBeGreaterThan(10);
    }
  }
});

// Like the resources, the prompts do not depend on which tools the profile registers.
test.each(['core', 'full', 'readonly'] as const)(
  'offers the four prompts with the %s profile',
  async (profile) => {
    const { client } = await startServer({ profile });

    const { prompts } = await client.listPrompts();

    expect(prompts.map(({ name }) => name)).toEqual([
      'analyze_current_chart',
      'multi_timeframe_review',
      'write_and_backtest_strategy',
      'debug_pine_script',
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
    'chart_set_timeframe',
    'data_get_ohlcv',
    'indicator_get_values',
  ];

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

  test('passes confirm: true to the later changes, which TradingView flags until the editor is closed', async () => {
    const { client } = await startServer();

    const text = await messageOf(client, 'write_and_backtest_strategy', { idea: IDEA });

    expect(text).toMatch(/flags? [^.]*unsaved changes until (?:the editor|it) is closed/i);
    expect(text).toMatch(/later change[^.]*confirm: true/i);
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
  };
  // Only what is needed.
  const LEAST: Record<string, Record<string, string>> = {
    ...FULL,
    analyze_current_chart: {},
    multi_timeframe_review: {},
    write_and_backtest_strategy: { idea: 'Buy dips' },
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
