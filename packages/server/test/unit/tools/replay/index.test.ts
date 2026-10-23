import { z } from 'zod';
import { TvMcpError } from '../../../../src/core/errors.js';
import { readPlanFeaturesEnabled } from '../../../../src/core/tv/plan-limits.js';
import { READ_ONLY } from '../../../../src/tools/annotations.js';
import { CLIENT_SAFE_BUDGET_MS } from '../../../../src/tools/chart/strategies.js';
import { allTools } from '../../../../src/tools/index.js';
import {
  replayAutoplay,
  replayStart,
  replayStatus,
  replayStop,
  replayTools,
  stepBars,
} from '../../../../src/tools/replay/index.js';
import {
  leaveReplayViaApi,
  readReplayState,
  setAutoplayViaApi,
  startReplayViaApi,
  stepReplayViaApi,
  type ReplayReading,
} from '../../../../src/tools/replay/page.js';
import { selectTools } from '../../../../src/tools/registry.js';
import { tabTools } from '../../../../src/tools/tab/index.js';
import type { AnyToolDefinition, ToolContext } from '../../../../src/tools/types.js';
import { failureOf } from '../../../helpers/failure-of.js';
import { createTestContext, testConfig } from '../../../helpers/tool-context.js';

// What the model and the client see of the replay tools: their names, annotations, descriptions and
// input schemas, and the time replay_step allows itself. The behavior behind them is tested through
// a server in test/integration/tools/replay.test.ts, apart from answers the fake app never gives,
// which a scripted page gives here. Values are synthetic.

function toolNamed(name: string): AnyToolDefinition {
  const tool = replayTools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`There is no replay tool ${name}`);
  }
  return tool;
}

const schemaOf = (name: string) => z.object(toolNamed(name).inputSchema);

const SPEEDS = [
  { label: '10x', value: 100 },
  { label: '1x', value: 1000 },
];
// A replay running on a daily chart, as readReplayState reads it.
const RUNNING: ReplayReading = {
  signedIn: true,
  available: true,
  chartAvailable: true,
  unavailableReason: null,
  started: true,
  modeOn: true,
  finished: false,
  autoplay: false,
  date: 1712707200,
  selectedPoint: 1712620800,
  delayMs: 1000,
  speeds: SPEEDS,
  resolution: '1D',
  savedSession: false,
  history: { first: 1704153600, last: 1729987200 },
  position: null,
  realizedPL: null,
  currency: null,
};
const OFF: ReplayReading = {
  ...RUNNING,
  started: false,
  modeOn: false,
  date: null,
  selectedPoint: null,
};
// What the plan says of intraday replay.
const NO_INTRADAY = { value: { BAR_REPLAY_INTRADAY: false } };
// What one step answers.
const stepped = (date: number) => ({ outcome: 'stepped', date, reason: null });

test('replayTools lists the replay tools in the order of the catalog', () => {
  expect(replayTools.map(({ name }) => name)).toEqual([
    'replay_start',
    'replay_step',
    'replay_autoplay',
    'replay_status',
    'replay_stop',
  ]);
  expect(new Set(replayTools.map(({ domain }) => domain))).toEqual(new Set(['replay']));
});

test('the catalog lists the replay tools after the tab tools and before the screenshot', () => {
  const names = allTools.map(({ name }) => name);
  const lastTab = tabTools.at(-1);
  if (lastTab === undefined) {
    throw new Error('There are no tab tools');
  }

  expect(names.indexOf('replay_start')).toBe(names.indexOf(lastTab.name) + 1);
  expect(names.indexOf('replay_stop')).toBe(names.indexOf('screenshot_capture') - 1);
});

test('replay_status only reads, so the readonly profile offers it and no other replay tool', () => {
  expect(toolNamed('replay_status').annotations).toBe(READ_ONLY);
  expect(
    selectTools(replayTools, { profile: 'readonly', patterns: [] }).map(({ name }) => name),
  ).toEqual(['replay_status']);
});

test('the replay tools that act destroy nothing; replay_stop and replay_autoplay can be called again to no further effect', () => {
  for (const name of ['replay_start', 'replay_step']) {
    expect(toolNamed(name).annotations, name).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  }
  for (const name of ['replay_autoplay', 'replay_stop']) {
    expect(toolNamed(name).annotations, name).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  }
});

// The core profile itself is pinned in test/unit/tools/registry.test.ts.
test('the core profile keeps replay_start, replay_step and replay_stop of the replay tools', () => {
  expect(
    selectTools(replayTools, { profile: 'core', patterns: [] }).map(({ name }) => name),
  ).toEqual(['replay_start', 'replay_step', 'replay_stop']);
  expect(replayAutoplay.core).toBeUndefined();
  expect(replayStatus.core).toBeUndefined();
});

test('the descriptions name the start points, the refusals, the speeds, the setting kept and that the server never trades', () => {
  const start = toolNamed('replay_start').description;
  const step = toolNamed('replay_step').description;
  const autoplay = toolNamed('replay_autoplay').description;
  const status = toolNamed('replay_status').description;
  const stop = toolNamed('replay_stop').description;

  expect(start).toMatch(/'first'/);
  expect(start).toMatch(/'random'/);
  expect(start).toMatch(/PLAN_LIMIT/);
  expect(start).toMatch(/BAR_REPLAY_INTRADAY/);
  expect(start).toMatch(/continue replay/);
  expect(start).toMatch(/INVALID_INPUT/);
  expect(start).toMatch(/internal replay broker/);
  expect(start).toMatch(/never trades/);
  expect(start).toMatch(/replay_stop/);
  expect(step).toMatch(/1 to 500/);
  expect(step).toMatch(/45 s/);
  expect(step).toMatch(/finished/);
  expect(autoplay).toMatch(/10x/);
  expect(autoplay).toMatch(/own setting/);
  expect(autoplay).toMatch(/INVALID_INPUT/);
  expect(status).toMatch(/changes nothing/);
  expect(status).toMatch(/null on TradingView Desktop/);
  expect(stop).toMatch(/"Leave replay" dialog/);
  expect(stop).toMatch(/autoplay first/);
  expect(stop).toMatch(/user started keeps/);
  expect(stop).toMatch(/With nothing to leave it changes nothing/);
  for (const tool of replayTools) {
    expect(tool.description, tool.name).not.toMatch(/replay_trade/);
  }
});

test('replay_start takes a date, replay_step a bar count, replay_autoplay enabled and a speed, and the others nothing', () => {
  expect(Object.keys(toolNamed('replay_start').inputSchema)).toEqual(['date']);
  expect(schemaOf('replay_start').parse({})).toEqual({});
  expect(schemaOf('replay_start').parse({ date: 'first' })).toEqual({ date: 'first' });
  expect(schemaOf('replay_start').parse({ date: 1712793600 })).toEqual({ date: 1712793600 });
  expect(schemaOf('replay_step').parse({})).toEqual({ bars: 1 });
  expect(schemaOf('replay_step').parse({ bars: 500 })).toEqual({ bars: 500 });
  expect(schemaOf('replay_autoplay').parse({ enabled: true, speed: '5x' })).toEqual({
    enabled: true,
    speed: '5x',
  });
  expect(Object.keys(toolNamed('replay_status').inputSchema)).toEqual([]);
  expect(Object.keys(toolNamed('replay_stop').inputSchema)).toEqual([]);
});

test.each([
  ['replay_start', 'an empty date', { date: '' }],
  ['replay_start', 'a date of 65 characters', { date: 'x'.repeat(65) }],
  ['replay_start', 'a date that is a boolean', { date: true }],
  ['replay_step', 'no bar', { bars: 0 }],
  ['replay_step', '501 bars', { bars: 501 }],
  ['replay_step', 'a fraction of a bar', { bars: 1.5 }],
  ['replay_autoplay', 'no enabled', {}],
  ['replay_autoplay', 'an enabled that is no boolean', { enabled: 'yes' }],
  ['replay_autoplay', 'an empty speed', { enabled: true, speed: '' }],
  ['replay_autoplay', 'a speed of 21 characters', { enabled: true, speed: 'x'.repeat(21) }],
])('%s refuses %s', (name, _label, input) => {
  expect(schemaOf(name).safeParse(input).success).toBe(false);
});

// A page that answers each page function with what a script says, at once, and moves a clock of its
// own on by the time the script says each call took. A function is answered with the answers of its
// script in turn, the last one again and again; an answer may also be an error to throw.
interface Scripted {
  value?: unknown;
  error?: unknown;
  takesMs?: number;
}

function scriptedRun(script: [unknown, Scripted[]][], callTimeoutMs = 15_000) {
  const clock = { now: 0 };
  const answers = new Map(script);
  const asked: { fn: unknown; args: unknown[] }[] = [];
  const answer = async (fn: unknown, args: unknown[]): Promise<unknown> => {
    asked.push({ fn, args });
    const list = answers.get(fn);
    const next = list?.length === 1 ? list[0] : list?.shift();
    if (next === undefined) {
      throw new Error('Unexpected page function');
    }
    clock.now += next.takesMs ?? 0;
    // Settled on a later tick, as a page call is.
    await Promise.resolve();
    if ('error' in next) {
      throw next.error;
    }
    return next.value;
  };
  const ctx = {
    ...createTestContext({ config: testConfig({ callTimeoutMs }) }),
    connection: {
      chartPage: () => Promise.resolve({ bridge: { evaluate: answer, evaluateWithLib: answer } }),
    },
  } as unknown as ToolContext;
  const argsOf = (fn: unknown): unknown[][] =>
    asked.filter((call) => call.fn === fn).map(({ args }) => args);
  return { clock, ctx, argsOf };
}

// The time replay_step allows itself, tested with the clock of a scripted page.
describe('the time replay_step allows itself', () => {
  test('keeps within 45 s by default: it starts a step only while a step wait is left, and says what is left', async () => {
    const run = scriptedRun([
      [readReplayState, [{ value: RUNNING }]],
      [stepReplayViaApi, [{ value: stepped(1712793600), takesMs: 1000 }]],
    ]);

    const output = await stepBars({ bars: 500 }, run.ctx, undefined, () => run.clock.now);

    expect(CLIENT_SAFE_BUDGET_MS).toBe(45_000);
    // Each step waits at most 5 s, so the last one starts with 5 s of the 45 s left.
    expect(output.data).toEqual({
      date: 1712793600,
      dateIso: '2024-04-11T00:00:00Z',
      stepped: 41,
      finished: false,
    });
    expect(output.warnings).toEqual([
      'Stepped 41 of 500 bars within the 45 s a call allows: call replay_step again for the rest.',
    ]);
    expect(run.argsOf(stepReplayViaApi)).toHaveLength(41);
    expect(new Set(run.argsOf(stepReplayViaApi).map(([waitMs]) => waitMs))).toEqual(
      new Set([5000]),
    );
  });

  test('keeps each step within the call timeout', async () => {
    const run = scriptedRun(
      [
        [readReplayState, [{ value: RUNNING }]],
        [stepReplayViaApi, [{ value: stepped(1712793600) }]],
      ],
      2000,
    );

    await stepBars({ bars: 2 }, run.ctx, CLIENT_SAFE_BUDGET_MS, () => run.clock.now);

    expect(run.argsOf(stepReplayViaApi)).toEqual([[1000], [1000]]);
  });

  test('steps nothing, and says so, when less than a step wait is left after the first look', async () => {
    const run = scriptedRun([
      [readReplayState, [{ value: RUNNING, takesMs: 41_000 }]],
      [stepReplayViaApi, [{ value: stepped(1712793600) }]],
    ]);

    const output = await stepBars({ bars: 3 }, run.ctx, CLIENT_SAFE_BUDGET_MS, () => run.clock.now);

    expect(output.data).toEqual({
      date: 1712707200,
      dateIso: '2024-04-10T00:00:00Z',
      stepped: 0,
      finished: false,
    });
    expect(output.warnings).toEqual([
      expect.stringMatching(/^Stepped 0 of 3 bars within the 45 s/),
    ]);
    expect(run.argsOf(stepReplayViaApi)).toEqual([]);
  });
});

describe('what replay_step makes of each step', () => {
  async function stepWith(steps: Scripted[], bars = 3) {
    const run = scriptedRun([
      [readReplayState, [{ value: RUNNING }]],
      [stepReplayViaApi, steps],
    ]);
    return stepBars({ bars }, run.ctx, CLIENT_SAFE_BUDGET_MS, () => run.clock.now);
  }

  test('returns the bars it stepped, with the reason, when a later step fails', async () => {
    const output = await stepWith([
      { value: stepped(1712793600) },
      { value: stepped(1712880000) },
      { value: { outcome: 'failed', date: 1712880000, reason: 'Session error' } },
    ]);

    expect(output.data).toEqual({
      date: 1712880000,
      dateIso: '2024-04-12T00:00:00Z',
      stepped: 2,
      finished: false,
    });
    expect(output.warnings).toEqual([
      'Stepped 2 of 3 bars, then stopped: TradingView could not step the replay: Session error',
    ]);
  });

  test('returns the bars it stepped when a later step does not end in time, or the page fails', async () => {
    const late = await stepWith([
      { value: stepped(1712793600) },
      { value: { outcome: 'late', date: 1712793600, reason: null } },
    ]);
    const broken = await stepWith([
      { value: stepped(1712793600) },
      { error: new TvMcpError('TIMEOUT', 'Runtime.evaluate timed out after 15000 ms') },
    ]);

    expect(late.data).toMatchObject({ stepped: 1, date: 1712793600 });
    expect(late.warnings).toEqual([
      expect.stringMatching(/^Stepped 1 of 3 bars, then stopped: TradingView did not step/),
    ]);
    expect(broken.data).toMatchObject({ stepped: 1, date: 1712793600 });
    expect(broken.warnings).toEqual([
      'Stepped 1 of 3 bars, then stopped: Runtime.evaluate timed out after 15000 ms',
    ]);
  });

  test('passes an error that is none of the server on, whatever was stepped', async () => {
    const failure = new Error('A bug');

    await expect(stepWith([{ value: stepped(1712793600) }, { error: failure }])).rejects.toBe(
      failure,
    );
  });

  test('counts a step TradingView took whose date it did not report, and reports no date', async () => {
    const output = await stepWith([
      { value: stepped(1712793600) },
      { value: { outcome: 'unconfirmed', date: 1712793600, reason: null } },
    ]);

    expect(output.data).toEqual({ date: null, dateIso: null, stepped: 2, finished: false });
    expect(output.warnings).toEqual([
      expect.stringMatching(/did not report the new replay date within 5000 ms/),
    ]);
  });

  test('reports a replay at its end as finished, with no bar stepped', async () => {
    const output = await stepWith([
      { value: { outcome: 'finished', date: 1729987200, reason: null } },
    ]);
    // The date the replay was at, when TradingView does not report one at the end.
    const unreported = await stepWith([
      { value: stepped(1729900800) },
      { value: { outcome: 'finished', date: null, reason: null } },
    ]);

    expect(output.data).toEqual({
      date: 1729987200,
      dateIso: '2024-10-27T00:00:00Z',
      stepped: 0,
      finished: true,
    });
    expect(output.warnings).toEqual([]);
    expect(unreported.data).toEqual({
      date: 1729900800,
      dateIso: '2024-10-26T00:00:00Z',
      stepped: 1,
      finished: true,
    });
  });

  test('fails when the first step fails or does not end in time', async () => {
    const failed = await failureOf(
      stepWith([{ value: { outcome: 'failed', date: null, reason: 'Session error' } }]),
    );
    const late = await failureOf(
      stepWith([{ value: { outcome: 'late', date: null, reason: null } }]),
    );

    const silent = await failureOf(
      stepWith([{ value: { outcome: 'failed', date: null, reason: null } }]),
    );

    expect(failed.toPayload()).toEqual({
      code: 'NOT_AVAILABLE',
      message: 'TradingView could not step the replay: Session error',
      hint: 'Check replay_status; replay_stop leaves replay.',
    });
    expect(silent.message).toBe('TradingView could not step the replay');
    expect(late.toPayload()).toEqual({
      code: 'TIMEOUT',
      message: 'TradingView did not step the replay within 5000 ms',
      hint: 'The step may still come through: check replay_status before stepping again.',
      details: { waitMs: 5000 },
    });
  });

  test('fails with the page error of the first step', async () => {
    const refused = new TvMcpError('NOT_AVAILABLE', 'Replay is not running on the chart');

    expect(await failureOf(stepWith([{ error: refused }]))).toBe(refused);
  });
});

describe('what replay_start makes of the start', () => {
  function startWith(start: Scripted, after: ReplayReading[]) {
    const run = scriptedRun([
      [readReplayState, [{ value: OFF }, ...after.map((value) => ({ value }))]],
      [readPlanFeaturesEnabled, [NO_INTRADAY]],
      [startReplayViaApi, [start]],
    ]);
    return { run, call: replayStart.handler({ date: 'first' }, run.ctx) };
  }

  test('fails NOT_AVAILABLE, without waiting, when the select ended and replay did not start', async () => {
    const { run, call } = startWith(
      { value: { ended: 'resolved', reason: null, timingModeKept: true } },
      [OFF],
    );

    const error = await failureOf(call);

    expect(error.toPayload()).toEqual({
      code: 'NOT_AVAILABLE',
      message: 'TradingView did not start replay',
      hint: 'Check replay_status; replay_stop closes the replay toolbar if TradingView left it open.',
    });
    expect(run.argsOf(readReplayState)).toHaveLength(2);
    expect(run.ctx.session.replayRunStartedBySession).toBeNull();
  });

  test('fails NOT_AVAILABLE with the reason of TradingView when the select rejected', async () => {
    const { call } = startWith(
      {
        value: {
          ended: 'rejected',
          reason: 'Error getting the available data depth',
          timingModeKept: true,
        },
      },
      [OFF],
    );

    expect((await failureOf(call)).message).toBe(
      'TradingView did not start replay: Error getting the available data depth',
    );
  });

  test('reports a replay that started although the select rejected', async () => {
    const { run, call } = startWith(
      { value: { ended: 'rejected', reason: 'A late error', timingModeKept: true } },
      [RUNNING],
    );

    expect((await call).data).toMatchObject({ active: true, date: 1712707200, start: 'first' });
    expect(run.ctx.session.replayRunStartedBySession).toBe(1712620800);
  });

  test('counts no replay as its own whose start point TradingView does not tell', async () => {
    const { run, call } = startWith(
      { value: { ended: 'resolved', reason: null, timingModeKept: true } },
      [{ ...RUNNING, selectedPoint: null }],
    );

    expect((await call).data).toMatchObject({ active: true });
    expect(run.ctx.session.replayRunStartedBySession).toBeNull();
  });

  test('passes the start, the time in milliseconds, what the plan says of intraday replay and the page wait to the page', async () => {
    const run = scriptedRun([
      [readReplayState, [{ value: OFF }, { value: RUNNING }]],
      [readPlanFeaturesEnabled, [NO_INTRADAY]],
      [startReplayViaApi, [{ value: { ended: 'resolved', reason: null, timingModeKept: true } }]],
    ]);

    await replayStart.handler({ date: '2024-04-11' }, run.ctx);

    // The page checks the timeframe again right before the select, with the answer of the plan.
    expect(run.argsOf(readPlanFeaturesEnabled)).toEqual([[['BAR_REPLAY_INTRADAY']]]);
    expect(run.argsOf(startReplayViaApi)).toEqual([['date', 1712793600000, false, 14_000]]);
  });

  test('refuses a replay that TradingView does not tell is off', async () => {
    const run = scriptedRun([[readReplayState, [{ value: { ...OFF, started: null } }]]]);

    const error = await failureOf(replayStart.handler({}, run.ctx));

    expect(error.message).toBe(
      'TradingView does not tell whether replay is running, so it was not started',
    );
  });
});

describe('what replay_autoplay makes of the change', () => {
  function autoplayWith(answer: unknown, reading: ReplayReading = RUNNING) {
    const run = scriptedRun([
      [readReplayState, [{ value: reading }]],
      [setAutoplayViaApi, [{ value: answer }]],
    ]);
    return replayAutoplay.handler({ enabled: true }, run.ctx);
  }

  test('fails NOT_AVAILABLE when TradingView ended replay instead of playing it', async () => {
    const error = await failureOf(autoplayWith({ started: false, autoplay: false, delayMs: 1000 }));

    expect(error.toPayload()).toEqual({
      code: 'NOT_AVAILABLE',
      message:
        'TradingView ended the replay instead of playing it: it had reached the end of the ' +
        'loaded bars',
      hint: 'Call replay_stop to leave replay, and replay_start to replay again.',
    });
  });

  test('fails NOT_AVAILABLE when TradingView did not change autoplay in time', async () => {
    const error = await failureOf(autoplayWith({ started: true, autoplay: false, delayMs: 1000 }));
    const run = scriptedRun([
      [readReplayState, [{ value: { ...RUNNING, autoplay: true } }]],
      [setAutoplayViaApi, [{ value: { started: true, autoplay: true, delayMs: 1000 } }]],
    ]);
    const stop = await failureOf(replayAutoplay.handler({ enabled: false }, run.ctx));

    expect(error.toPayload()).toEqual({
      code: 'NOT_AVAILABLE',
      message: 'TradingView did not start autoplay within 3000 ms',
      hint: 'Check replay_status.',
      details: { waitMs: 3000 },
    });
    expect(stop.message).toBe('TradingView did not stop autoplay within 3000 ms');
  });

  test('refuses a speed when TradingView lists none', async () => {
    const run = scriptedRun([[readReplayState, [{ value: { ...RUNNING, speeds: [] } }]]]);

    const error = await failureOf(replayAutoplay.handler({ enabled: true, speed: '1x' }, run.ctx));

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(run.argsOf(setAutoplayViaApi)).toEqual([]);
  });
});

describe('what replay_stop does with the replay this session started', () => {
  function stopWith(own: number | null, answer: Scripted) {
    const run = scriptedRun([[leaveReplayViaApi, [answer]]]);
    run.ctx.session.replayRunStartedBySession = own;
    return { run, call: replayStop.handler({}, run.ctx) };
  }

  test('passes the start point of that replay to the page, and forgets it once replay stopped', async () => {
    const { run, call } = stopWith(1712620800, {
      value: { left: true, stopped: true, cleared: true },
    });

    expect(await call).toEqual({ data: { active: false }, via: 'api', warnings: [] });
    expect(run.argsOf(leaveReplayViaApi)).toEqual([[1712620800, 14_000]]);
    expect(run.ctx.session.replayRunStartedBySession).toBeNull();
  });

  test('says so when that replay was left but what TradingView saved for it could not be cleared', async () => {
    const { run, call } = stopWith(1712620800, {
      value: { left: true, stopped: true, cleared: false },
    });

    expect((await call).warnings).toEqual([expect.stringMatching(/could not be cleared/)]);
    expect(run.ctx.session.replayRunStartedBySession).toBeNull();
  });

  test('warns of nothing when the replay left was another one, or there was none', async () => {
    const other = stopWith(1712620800, { value: { left: true, stopped: true, cleared: null } });
    const none = stopWith(null, { value: { left: false, stopped: true, cleared: null } });

    expect((await other.call).warnings).toEqual([]);
    expect((await none.call).warnings).toEqual([]);
    expect(other.run.ctx.session.replayRunStartedBySession).toBeNull();
  });

  test('keeps that replay while it did not stop', async () => {
    const { run, call } = stopWith(1712620800, {
      value: { left: true, stopped: false, cleared: false },
    });

    expect((await failureOf(call)).code).toBe('TIMEOUT');
    expect(run.ctx.session.replayRunStartedBySession).toBe(1712620800);
  });
});

describe('what a reading of replay does with the replay this session started', () => {
  // The replay the session started is known by its start point, 1712620800.
  async function afterStatus(reading: ReplayReading) {
    const run = scriptedRun([
      [readReplayState, [{ value: reading }]],
      [readPlanFeaturesEnabled, [NO_INTRADAY]],
    ]);
    run.ctx.session.replayRunStartedBySession = 1712620800;
    await replayStatus.handler({}, run.ctx);
    return run.ctx.session.replayRunStartedBySession;
  }

  test('forgets it when another replay runs, or none', async () => {
    expect(await afterStatus({ ...RUNNING, selectedPoint: 1712000000 })).toBeNull();
    expect(await afterStatus({ ...RUNNING, selectedPoint: null })).toBeNull();
    expect(await afterStatus(OFF)).toBeNull();
  });

  test('keeps it while it runs, or while TradingView does not tell whether replay runs', async () => {
    expect(await afterStatus(RUNNING)).toBe(1712620800);
    expect(await afterStatus({ ...RUNNING, started: null, selectedPoint: null })).toBe(1712620800);
  });

  test('is done by every replay tool that reads replay', async () => {
    const reading = { ...RUNNING, selectedPoint: 1712000000 };
    for (const call of [
      (ctx: ToolContext) => stepBars({ bars: 1 }, ctx),
      (ctx: ToolContext) => replayAutoplay.handler({ enabled: false }, ctx),
      (ctx: ToolContext) => replayStart.handler({}, ctx),
    ]) {
      const run = scriptedRun([
        [readReplayState, [{ value: reading }]],
        [stepReplayViaApi, [{ value: stepped(1712793600) }]],
        [setAutoplayViaApi, [{ value: { started: true, autoplay: false, delayMs: 1000 } }]],
      ]);
      run.ctx.session.replayRunStartedBySession = 1712620800;
      // replay_start refuses a running replay, after it read it.
      await call(run.ctx).catch(() => undefined);
      expect(run.ctx.session.replayRunStartedBySession).toBeNull();
    }
  });
});

describe('what replay_status reports', () => {
  test('reports null for what TradingView does not tell, and asks the plan only for an intraday chart', async () => {
    const run = scriptedRun([
      [
        readReplayState,
        [
          {
            value: {
              ...RUNNING,
              started: null,
              autoplay: null,
              date: null,
              delayMs: null,
              resolution: '60',
            },
          },
        ],
      ],
      [readPlanFeaturesEnabled, [{ value: { BAR_REPLAY_INTRADAY: true } }]],
    ]);

    expect((await replayStatus.handler({}, run.ctx)).data).toEqual({
      available: true,
      reason: null,
      active: null,
      date: null,
      dateIso: null,
      autoplay: null,
      delayMs: null,
      speed: null,
      resolution: '60',
      position: null,
      realizedPL: null,
      currency: null,
    });
    expect(run.argsOf(readPlanFeaturesEnabled)).toEqual([[['BAR_REPLAY_INTRADAY']]]);
  });

  test('does not ask the plan for a daily chart', async () => {
    const run = scriptedRun([[readReplayState, [{ value: RUNNING }]]]);

    await replayStatus.handler({}, run.ctx);

    expect(run.argsOf(readPlanFeaturesEnabled)).toEqual([]);
    expect(run.argsOf(readReplayState)).toEqual([[]]);
  });
});
