import type { ImageContent } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { TvMcpError } from '../../../src/core/errors.js';
import type { ToolCallEvent } from '../../../src/core/events.js';
import { allTools } from '../../../src/tools/index.js';
import { createToolRegistry, selectTools } from '../../../src/tools/registry.js';
import {
  defineTool,
  type AnyToolDefinition,
  type Domain,
  type ToolContext,
} from '../../../src/tools/types.js';
import { sleep } from '../../../src/utils/timeout.js';
import { textOf } from '../../helpers/mcp-client.js';
import { capturingLogger, createTestContext } from '../../helpers/tool-context.js';

afterEach(() => {
  vi.useRealTimers();
});

// Profiles and patterns

interface FakeOptions {
  // Left out of the annotations when undefined, like a tool that does not say.
  readOnly?: boolean;
  core?: boolean;
}

function fake(domain: Domain, name: string, options: FakeOptions = {}): AnyToolDefinition {
  return defineTool({
    name,
    domain,
    title: name,
    description: `Stands in for ${name}.`,
    inputSchema: {},
    annotations: options.readOnly === undefined ? {} : { readOnlyHint: options.readOnly },
    ...(options.core === undefined ? {} : { core: options.core }),
    handler: () => Promise.resolve({ data: null }),
  });
}

const catalog = [
  fake('app', 'app_health', { readOnly: true, core: true }),
  fake('app', 'app_launch', { readOnly: false, core: true }),
  fake('chart', 'chart_get_state', { readOnly: true, core: true }),
  fake('chart', 'chart_set_symbol', { readOnly: false, core: true }),
  fake('data', 'data_get_ohlcv', { readOnly: true }),
  fake('ui', 'ui_hover'),
  fake('batch', 'batch_run', { readOnly: false, core: true }),
];

function names(tools: AnyToolDefinition[]): string[] {
  return tools.map((tool) => tool.name);
}

test('selectTools applies the readonly profile', () => {
  // Only an explicit readOnlyHint: true counts; a tool that does not say may change something.
  expect(names(selectTools(catalog, { profile: 'readonly', patterns: [] }))).toEqual([
    'app_health',
    'chart_get_state',
    'data_get_ohlcv',
  ]);
});

test('selectTools applies glob patterns', () => {
  const select = (patterns: string[]) => names(selectTools(catalog, { profile: 'full', patterns }));

  expect(select(['chart_*', 'data_get_ohlcv'])).toEqual([
    'chart_get_state',
    'chart_set_symbol',
    'data_get_ohlcv',
  ]);
  expect(select(['*_get_*'])).toEqual(['chart_get_state', 'data_get_ohlcv']);
  expect(select(['*'])).toEqual(names(catalog));
  // Without a star a pattern names one tool, not every tool that starts with it.
  expect(select(['app'])).toEqual([]);
  expect(select(['app_health'])).toEqual(['app_health']);
});

test('selectTools core profile keeps core tools only', () => {
  expect(names(selectTools(catalog, { profile: 'core', patterns: [] }))).toEqual([
    'app_health',
    'app_launch',
    'chart_get_state',
    'chart_set_symbol',
    'batch_run',
  ]);
});

test('selectTools keeps every tool, in order, for the full profile without patterns', () => {
  expect(selectTools(catalog, { profile: 'full', patterns: [] })).toEqual(catalog);
});

test('selectTools keeps only the tools that both the profile and the patterns allow', () => {
  expect(names(selectTools(catalog, { profile: 'readonly', patterns: ['chart_*'] }))).toEqual([
    'chart_get_state',
  ]);
  expect(names(selectTools(catalog, { profile: 'core', patterns: ['data_*'] }))).toEqual([]);
});

test('selectTools ignores case and treats every character but the star literally', () => {
  const select = (patterns: string[]) => names(selectTools(catalog, { profile: 'full', patterns }));

  expect(select(['CHART_GET_*'])).toEqual(['chart_get_state']);
  expect(select(['chart.get.state', 'chart_get_stat?', 'app_(health)', '[a]pp_health'])).toEqual(
    [],
  );
});

// Calling tools

const sampleImage: ImageContent = { type: 'image', data: 'AAAA', mimeType: 'image/png' };

interface Harness {
  ctx: Omit<ToolContext, 'registry'>;
  events: ToolCallEvent[];
  // The input each handler received, in call order.
  inputs: unknown[];
}

function harness(overrides: Partial<Omit<ToolContext, 'registry'>> = {}): Harness {
  const ctx = createTestContext(overrides);
  const events: ToolCallEvent[] = [];
  ctx.events.subscribe((event) => {
    events.push(event);
  });
  return { ctx, events, inputs: [] };
}

function echoTool(inputs: unknown[]) {
  return defineTool({
    name: 'chart_echo',
    domain: 'chart',
    title: 'Echo',
    description: 'Returns its text.',
    inputSchema: {
      text: z.string().describe('The text to return'),
      times: z.number().int().min(1).default(1).describe('How many times to repeat it'),
    },
    annotations: { readOnlyHint: true },
    handler: (input) => {
      inputs.push(input);
      return Promise.resolve({
        data: { text: input.text.repeat(input.times) },
        via: 'api',
        warnings: ['echoed'],
      });
    },
  });
}

// Fails with `error`, whatever it is: one of ours, a stray Error, or something that is no error.
function failingTool(error: unknown) {
  return defineTool({
    name: 'chart_fail',
    domain: 'chart',
    title: 'Fail',
    description: 'Always fails.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
    handler: () =>
      Promise.resolve().then(() => {
        throw error;
      }),
  });
}

const notAvailable = new TvMcpError('NOT_AVAILABLE', 'Replay is not open', {
  hint: 'Start replay first.',
  details: { panel: 'replay' },
});

test('registry wraps results in the envelope with durationMs', async () => {
  vi.useFakeTimers();
  const slow = defineTool({
    name: 'chart_slow',
    domain: 'chart',
    title: 'Slow',
    description: 'Takes 42 ms.',
    inputSchema: { text: z.string().describe('The text to return') },
    annotations: { readOnlyHint: true },
    handler: async ({ text }) => {
      await sleep(42);
      return { data: { text }, via: 'internal' };
    },
  });
  const registry = createToolRegistry([slow], harness().ctx);

  const pending = registry.call('chart_slow', { text: 'hi' }, 'mcp');
  await vi.advanceTimersByTimeAsync(42);
  const result = await pending;

  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toStrictEqual({
    ok: true,
    data: { text: 'hi' },
    meta: { via: 'internal', durationMs: 42, warnings: [] },
  });
  expect(JSON.parse(textOf(result))).toStrictEqual(result.structuredContent);
});

test('registry passes on the warnings and images of a handler, images first', async () => {
  const pictured = defineTool({
    name: 'screenshot_fake',
    domain: 'screenshot',
    title: 'Picture',
    description: 'Returns an image.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
    handler: () =>
      Promise.resolve({
        data: { width: 1 },
        via: 'cdp',
        warnings: ['scaled'],
        images: [sampleImage],
      }),
  });
  const registry = createToolRegistry([pictured], harness().ctx);

  const result = await registry.call('screenshot_fake', {}, 'mcp');

  expect(result.content[0]).toEqual(sampleImage);
  expect(result.structuredContent).toMatchObject({
    data: { width: 1 },
    meta: { via: 'cdp', warnings: ['scaled'] },
  });
});

test('registry validates arguments, fills in defaults and drops unknown keys', async () => {
  const { ctx, inputs } = harness();
  const registry = createToolRegistry([echoTool(inputs)], ctx);

  const result = await registry.call('chart_echo', { text: 'ab', extra: true }, 'dashboard');

  expect(inputs).toEqual([{ text: 'ab', times: 1 }]);
  expect(result.structuredContent).toStrictEqual({
    ok: true,
    data: { text: 'ab' },
    meta: { via: 'api', durationMs: expect.any(Number) as number, warnings: ['echoed'] },
  });
});

test('registry rejects invalid arguments with INVALID_INPUT and names the fields', async () => {
  const { ctx, inputs } = harness();
  const registry = createToolRegistry([echoTool(inputs)], ctx);

  const result = await registry.call('chart_echo', { text: 7, times: 0 }, 'batch');

  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    ok: false,
    error: {
      code: 'INVALID_INPUT',
      message: expect.stringMatching(
        /^Invalid arguments for chart_echo: text: .+; times: .+/,
      ) as string,
      details: {
        issues: [
          { path: 'text', message: expect.any(String) as string },
          { path: 'times', message: expect.any(String) as string },
        ],
      },
    },
  });
  expect(inputs).toEqual([]);
});

test('registry names a nested problem the way JavaScript would reach it', async () => {
  const drawing = defineTool({
    name: 'drawing_fake',
    domain: 'drawing',
    title: 'Drawing',
    description: 'Takes points.',
    inputSchema: {
      points: z.array(z.object({ time: z.number() })).describe('Points of the drawing'),
    },
    annotations: { readOnlyHint: false },
    handler: () => Promise.resolve({ data: null }),
  });
  const registry = createToolRegistry([drawing], harness().ctx);

  const result = await registry.call(
    'drawing_fake',
    { points: [{ time: 1 }, { time: 'noon' }] },
    'mcp',
  );

  expect(result.structuredContent).toMatchObject({
    error: { code: 'INVALID_INPUT', details: { issues: [{ path: 'points[1].time' }] } },
  });
});

// One value per row: a bare [] would be read as a row without arguments.
test.each([[null], ['text'], [[]], [3]])('registry rejects %j as the arguments', async (args) => {
  const { ctx, inputs } = harness();
  const registry = createToolRegistry([echoTool(inputs)], ctx);

  const result = await registry.call('chart_echo', args, 'dashboard');

  expect(result.structuredContent).toMatchObject({ error: { code: 'INVALID_INPUT' } });
  expect(inputs).toEqual([]);
});

test('registry reports at most ten problems with the arguments', async () => {
  const many = defineTool({
    name: 'chart_many',
    domain: 'chart',
    title: 'Many',
    description: 'Takes a list of numbers.',
    inputSchema: { values: z.array(z.number()).describe('Numbers') },
    annotations: { readOnlyHint: true },
    handler: () => Promise.resolve({ data: null }),
  });
  const registry = createToolRegistry([many], harness().ctx);

  const values = Array.from({ length: 25 }, () => 'not a number');

  const result = await registry.call('chart_many', { values }, 'mcp');

  expect(result.structuredContent).toMatchObject({
    error: {
      code: 'INVALID_INPUT',
      message: expect.stringContaining('values[9]: ') as string,
    },
  });
  const text = textOf(result);
  expect(text).toContain('(and 15 more)');
  expect(text).not.toContain('values[10]');
});

test('registry maps thrown TvMcpError to an error result', async () => {
  const registry = createToolRegistry([failingTool(notAvailable)], harness().ctx);

  const result = await registry.call('chart_fail', {}, 'mcp');

  expect(result.isError).toBe(true);
  expect(result.structuredContent).toStrictEqual({
    ok: false,
    error: {
      code: 'NOT_AVAILABLE',
      message: 'Replay is not open',
      hint: 'Start replay first.',
      details: { panel: 'replay' },
    },
    meta: { durationMs: expect.any(Number) as number },
  });
  expect(JSON.parse(textOf(result))).toStrictEqual(result.structuredContent);
});

test('registry logs an unexpected error with its stack and returns only INTERNAL', async () => {
  const { logger, lines } = capturingLogger();
  const crash = new Error('Cannot read properties of undefined at /Users/someone/secret.ts');
  const registry = createToolRegistry([failingTool(crash)], harness({ logger }).ctx);

  const result = await registry.call('chart_fail', {}, 'mcp');

  expect(result.structuredContent).toStrictEqual({
    ok: false,
    error: { code: 'INTERNAL', message: 'Unexpected error' },
    meta: { durationMs: expect.any(Number) as number },
  });
  // Neither the message nor the stack of an unexpected error leaves the server.
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(lines).toContainEqual(
    expect.objectContaining({
      level: 50,
      tool: 'chart_fail',
      origin: 'mcp',
      err: expect.objectContaining({
        message: crash.message,
        stack: expect.stringContaining('secret.ts') as string,
      }) as unknown,
    }),
  );
});

test('registry turns a thrown value that is not an Error into INTERNAL too', async () => {
  const { logger, lines } = capturingLogger();
  const registry = createToolRegistry([failingTool('a bare string')], harness({ logger }).ctx);

  const result = await registry.call('chart_fail', {}, 'mcp');

  expect(result.structuredContent).toMatchObject({ error: { code: 'INTERNAL' } });
  expect(lines).toContainEqual(expect.objectContaining({ level: 50, err: 'a bare string' }));
});

test('registry rejects unknown tools with INVALID_INPUT', async () => {
  const { ctx, events } = harness();
  const registry = createToolRegistry([failingTool(notAvailable)], ctx);

  const result = await registry.call('chart_nope', {}, 'dashboard');

  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    ok: false,
    error: {
      code: 'INVALID_INPUT',
      message: 'Unknown tool "chart_nope"',
      details: { tool: 'chart_nope' },
    },
  });
  // The attempt is still part of the event log.
  expect(events.map(({ phase, errorCode }) => [phase, errorCode])).toEqual([
    ['start', undefined],
    ['end', 'INVALID_INPUT'],
  ]);
});

test('registry emits start and end events with the error code', async () => {
  const { ctx, events } = harness();
  const registry = createToolRegistry([failingTool(notAvailable)], ctx);

  await registry.call('chart_fail', { reason: 'test' }, 'batch');

  expect(events).toHaveLength(2);
  const [start, end] = events;
  expect(start).toStrictEqual({
    id: expect.any(String) as string,
    tool: 'chart_fail',
    origin: 'batch',
    phase: 'start',
    at: expect.any(String) as string,
    args: { reason: 'test' },
  });
  expect(end).toStrictEqual({
    id: start?.id,
    tool: 'chart_fail',
    origin: 'batch',
    phase: 'end',
    at: expect.any(String) as string,
    durationMs: expect.any(Number) as number,
    ok: false,
    errorCode: 'NOT_AVAILABLE',
  });
  expect(Date.parse(start?.at ?? '')).not.toBeNaN();
});

test('registry reports a successful call as ok, with its own id per call', async () => {
  const { ctx, events, inputs } = harness();
  const registry = createToolRegistry([echoTool(inputs)], ctx);

  await registry.call('chart_echo', { text: 'a' }, 'mcp');
  await registry.call('chart_echo', { text: 'b' }, 'mcp');

  expect(events.map(({ phase }) => phase)).toEqual(['start', 'end', 'start', 'end']);
  expect(events[1]).toStrictEqual({
    id: events[0]?.id,
    tool: 'chart_echo',
    origin: 'mcp',
    phase: 'end',
    at: expect.any(String) as string,
    durationMs: expect.any(Number) as number,
    ok: true,
  });
  expect(events[2]?.id).not.toBe(events[0]?.id);
});

test('registry truncates long string arguments in events to 200 characters', async () => {
  const { ctx, events, inputs } = harness();
  const registry = createToolRegistry([echoTool(inputs)], ctx);
  const long = 'x'.repeat(5000);
  const clipped = `${'x'.repeat(199)}…`;

  const result = await registry.call(
    'chart_echo',
    { text: long, extra: { notes: [long, 'short', 42, true, null], [`k${long}`]: 1 } },
    'mcp',
  );

  expect(events[0]?.args).toStrictEqual({
    text: clipped,
    extra: { notes: [clipped, 'short', 42, true, null], [`k${'x'.repeat(198)}…`]: 1 },
  });
  // Only the event is shortened: the handler gets the whole text.
  expect(inputs).toEqual([{ text: long, times: 1 }]);
  expect(result.structuredContent).toMatchObject({ data: { text: long } });
});

test('registry does not split a character in two when it truncates', async () => {
  const { ctx, events } = harness();
  const registry = createToolRegistry([failingTool(notAvailable)], ctx);
  // The emoji takes two UTF-16 units, at positions 198 and 199.
  const text = `${'a'.repeat(198)}😀${'b'.repeat(20)}`;

  await registry.call('chart_fail', { text }, 'mcp');

  expect(events[0]?.args).toEqual({ text: `${'a'.repeat(198)}…` });
});

test('registry bounds how deep and how wide the arguments in an event go', async () => {
  const { ctx, events } = harness();
  const registry = createToolRegistry([failingTool(notAvailable)], ctx);
  let deep: unknown = 'bottom';
  for (let level = 0; level < 12; level += 1) {
    deep = { level, inner: deep };
  }
  const wide = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`key${String(i)}`, i]));

  await registry.call(
    'chart_fail',
    { deep, list: Array.from({ length: 75 }, (_, i) => i), wide, odd: [undefined, Infinity] },
    'mcp',
  );

  const args = events[0]?.args;
  expect(JSON.stringify(args)).not.toContain('bottom');
  expect(JSON.stringify(args)).toContain('"…"');
  expect(args).toMatchObject({
    list: [...Array.from({ length: 50 }, (_, i) => i), '… 25 more'],
    wide: { key0: 0, key49: 49, '…': '10 more' },
    // Values JSON cannot carry come out the way JSON.stringify writes them in a list.
    odd: [null, null],
  });
  expect(args).not.toHaveProperty('wide.key50');
});

test('registry still answers when the arguments cannot be read for the event', async () => {
  const { ctx, events, inputs } = harness();
  const registry = createToolRegistry([echoTool(inputs)], ctx);
  const args = {
    text: 'kept',
    get broken(): string {
      throw new Error('This getter cannot be read');
    },
  };

  const result = await registry.call('chart_echo', args, 'dashboard');

  expect(events[0]?.args).toBe('…');
  expect(result.structuredContent).toMatchObject({ ok: true, data: { text: 'kept' } });
});

test('registry runs asynchronous checks of an input schema', async () => {
  const { ctx } = harness();
  const checked = defineTool({
    name: 'chart_checked',
    domain: 'chart',
    title: 'Checked',
    description: 'Accepts only even numbers, checked asynchronously.',
    inputSchema: {
      value: z
        .number()
        .refine((value) => Promise.resolve(value % 2 === 0), 'must be even')
        .describe('An even number'),
    },
    annotations: { readOnlyHint: true },
    handler: ({ value }) => Promise.resolve({ data: { value } }),
  });
  const registry = createToolRegistry([checked], ctx);

  const even = await registry.call('chart_checked', { value: 4 }, 'mcp');
  const odd = await registry.call('chart_checked', { value: 3 }, 'mcp');

  expect(even.structuredContent).toMatchObject({ ok: true, data: { value: 4 } });
  expect(odd.structuredContent).toMatchObject({
    error: {
      code: 'INVALID_INPUT',
      message: 'Invalid arguments for chart_checked: value: must be even',
    },
  });
});

test('registry hands every handler the context with the registry itself', async () => {
  const { ctx, inputs } = harness();
  const caller = defineTool({
    name: 'chart_caller',
    domain: 'chart',
    title: 'Caller',
    description: 'Calls chart_echo through the registry.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
    handler: async (_input, handlerCtx) => {
      const inner = await handlerCtx.registry.call('chart_echo', { text: 'inner' }, 'batch');
      return {
        data: {
          sameConfig: handlerCtx.config === ctx.config,
          sameSession: handlerCtx.session === ctx.session,
          inner: inner.isError === true ? 'failed' : 'ok',
        },
      };
    },
  });
  const registry = createToolRegistry([caller, echoTool(inputs)], ctx);

  const result = await registry.call('chart_caller', {}, 'mcp');

  expect(result.structuredContent).toMatchObject({
    data: { sameConfig: true, sameSession: true, inner: 'ok' },
  });
  expect(inputs).toEqual([{ text: 'inner', times: 1 }]);
});

test('registry lists its tools in order and hands out a copy', () => {
  const { ctx, inputs } = harness();
  const echo = echoTool(inputs);
  const fail = failingTool(notAvailable);
  const registry = createToolRegistry([echo, fail], ctx);

  const listed = registry.list();
  listed.pop();

  expect(listed).toEqual([echo]);
  expect(registry.list()).toEqual([echo, fail]);
});

test('createToolRegistry refuses two tools with one name', () => {
  const { ctx, inputs } = harness();

  expect(() => createToolRegistry([echoTool(inputs), echoTool(inputs)], ctx)).toThrow(
    'Tool chart_echo is defined twice',
  );
});

test.each([
  ['data_echo', 'outside its domain'],
  ['chart_Echo', 'snake_case'],
  ['chart', 'snake_case'],
  ['chart_echo-2', 'snake_case'],
])('createToolRegistry refuses the name %s', (name, problem) => {
  const { ctx, inputs } = harness();
  const misnamed = defineTool({ ...echoTool(inputs), name });

  expect(() => createToolRegistry([misnamed], ctx)).toThrow(problem);
});

// The catalog every server starts from

test.each(allTools.map((tool) => [tool.name, tool] as const))(
  '%s follows the tool contract',
  (_name, tool) => {
    expect(tool.name).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/);
    expect(tool.name.startsWith(`${tool.domain}_`)).toBe(true);
    expect(tool.title.trim()).not.toBe('');
    expect(tool.description.trim().length).toBeGreaterThan(40);
    expect(typeof tool.annotations.readOnlyHint).toBe('boolean');
    expect(typeof tool.annotations.destructiveHint).toBe('boolean');
    expect(typeof tool.annotations.idempotentHint).toBe('boolean');
    for (const [field, schema] of Object.entries(tool.inputSchema)) {
      expect(z.globalRegistry.get(schema)?.description, `${field} needs .describe()`).toBeTruthy();
    }
  },
);

test('batch_run belongs to the core profile and stays out of the readonly one', () => {
  expect(names(selectTools(allTools, { profile: 'core', patterns: [] }))).toContain('batch_run');
  expect(names(selectTools(allTools, { profile: 'readonly', patterns: [] }))).not.toContain(
    'batch_run',
  );
});

// The core profile is the reduced set for clients that cap the number of tools (design spec 5.4),
// so it holds the essentials of each domain and not nearly every tool. A tool joins it, or leaves
// it, by changing this list: nothing else keeps the profile from growing back one tool at a time.
test('the core profile keeps exactly the essential tools', () => {
  const core = [
    // App
    'app_launch',
    'app_health',
    'app_discover',
    'app_get_ui_state',
    'app_reconnect',
    // Chart
    'chart_get_state',
    'chart_set_symbol',
    'chart_set_timeframe',
    'chart_set_type',
    'chart_get_visible_range',
    'chart_set_visible_range',
    'chart_scroll_to_date',
    // Market data
    'data_get_ohlcv',
    'data_get_quote',
    'data_get_symbol_info',
    'data_search_symbols',
    // Indicators
    'indicator_list',
    'indicator_search',
    'indicator_get_values',
    'indicator_add',
    'indicator_remove',
    // Pine
    'pine_new',
    'pine_get_source',
    'pine_set_source',
    'pine_compile',
    'pine_get_errors',
    'pine_smart_compile',
    // Strategy Tester
    'strategy_get_results',
    // Batch
    'batch_run',
  ];

  expect(names(selectTools(allTools, { profile: 'core', patterns: [] })).sort()).toEqual(
    [...core].sort(),
  );
});
