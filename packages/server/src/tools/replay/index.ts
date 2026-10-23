import { z } from 'zod';
import type { PageHandle } from '../../core/connection.js';
import { isTvMcpError } from '../../core/errors.js';
import { getPlanFeaturesEnabled } from '../../core/tv/plan-limits.js';
import { pollUntil } from '../../utils/poll.js';
import { READ_ONLY } from '../annotations.js';
import { TIME_INPUT, timeInput } from '../chart/index.js';
import { CLIENT_SAFE_BUDGET_MS, pageWaitMs, POLL_INTERVAL_MS } from '../chart/strategies.js';
import { defineTool, type AnyToolDefinition, type ToolContext, type ToolOutput } from '../types.js';
import {
  alreadyActiveError,
  autoplayRunningError,
  autoplayUnchangedError,
  availabilityOf,
  availabilityRefusal,
  dateNotReportedWarning,
  endOfHistoryError,
  isDailyOrLonger,
  NOT_CLEARED_WARNING,
  notStartedError,
  outOfTimeWarning,
  replayEndedError,
  replayTimeOf,
  requireWithinHistory,
  savedSessionError,
  signedOutError,
  speedDelayOf,
  speedLabelOf,
  startFailedError,
  startOf,
  startTimeoutError,
  stepFailedError,
  stepTimeoutError,
  stopTimeoutError,
  stoppedEarlyWarning,
  TIMING_MODE_WARNING,
  unconfirmedStepWarning,
  unknownStateError,
} from './mappers.js';
import {
  leaveReplayViaApi,
  readReplayState,
  setAutoplayViaApi,
  startReplayViaApi,
  stepReplayViaApi,
  type ReplayReading,
  type StepOutcome,
} from './page.js';

// The replay tools (design spec 7, domain Replay): bar replay on the active chart, which hides the
// bars after a point in the past and shows them again one by one, through the replay API of the app
// (reverse-engineering notes of Plan 3, section 4). replay_start checks first what would make the app
// open a dialog, and refuses instead: its sign-in wall, its paywall for intraday replay on a plan
// without BAR_REPLAY_INTRADAY (design spec 5.3, rule 3), and its "continue replay" dialog for a layout
// that holds a replay saved on leaving it; it checks the timeframe again in the same turn as the
// start. replay_stop leaves replay with skipConfirm, which never asks in the "Leave replay" dialog,
// and clears what TradingView then saves in the layout only for the run of replay this session
// started, which the session knows by the point it started at (design spec 5.3, rule 2). A replay
// tool that reads another run of replay, or none, forgets that run: a run never comes back once it
// stopped.
//
// There is no trading tool (design spec 5.3, rule 1): on TradingView Desktop the paper trading of
// replay goes through the trading service of the app, the machinery of real orders, with an internal
// replay broker the app selects for its trading panel during replay and swaps back afterwards. The
// tools never call the paper trading of the replay API, nor goToRealtime, which keeps replay on and
// can show a statistics dialog.

// The longest one step is waited for, with the date it shows, within the page wait of the call
// timeout as well: the replay session answers a step within a moment.
const STEP_WAIT_MS = 5000;
// The longest a change of autoplay is waited for: the app changes it at once.
const AUTOPLAY_WAIT_MS = 3000;
const MAX_BARS = 500;
// The longest speed label the schema takes; the labels of the app are a few characters (0.5x).
const MAX_SPEED_INPUT = 20;

// replay_start and replay_step change what the chart shows, which replay_stop puts back, and each
// call does more.
const ACTS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;
// replay_autoplay and replay_stop bring replay to a state, which a second call leaves as it is.
const SETS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

// What the replay tools return. Type aliases, not interfaces: they go to the client as JSON.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
type StartedReplay = {
  active: boolean;
  date: number | null;
  dateIso: string | null;
  start: 'date' | 'first' | 'random';
  resolution: string | null;
};
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
type SteppedReplay = {
  date: number | null;
  dateIso: string | null;
  stepped: number;
  finished: boolean;
};

// What the plan says of intraday replay, null when it cannot be read.
async function planAllowsIntraday(page: PageHandle): Promise<boolean | null> {
  const { BAR_REPLAY_INTRADAY: enabled = null } = await getPlanFeaturesEnabled(page, [
    'BAR_REPLAY_INTRADAY',
  ]);
  return enabled;
}

// The same, asked only where it matters for the availability of the chart: for a chart TradingView
// can replay whose timeframe is not daily, weekly or monthly. Null when it is not asked.
async function intradayAllowed(page: PageHandle, reading: ReplayReading): Promise<boolean | null> {
  if (
    reading.available !== true ||
    reading.chartAvailable === false ||
    isDailyOrLonger(reading.resolution)
  ) {
    return null;
  }
  return planAllowsIntraday(page);
}

// Forgets the run of replay this session started once a reading shows that it is over: another run
// runs, with another start point or one TradingView does not tell, or none does. A run never comes
// back once it stopped, and replay_stop then clears nothing for it.
function forgetEndedRun(
  ctx: ToolContext,
  reading: Pick<ReplayReading, 'started' | 'selectedPoint'>,
): void {
  const own = ctx.session.replayRunStartedBySession;
  if (
    own !== null &&
    (reading.started === false || (reading.started === true && reading.selectedPoint !== own))
  ) {
    ctx.session.replayRunStartedBySession = null;
  }
}

export const replayStart = defineTool({
  name: 'replay_start',
  domain: 'replay',
  title: 'Start bar replay',
  description:
    'Starts bar replay on the active chart: TradingView hides the bars after a point in the past ' +
    'and shows them again one by one (replay_step, replay_autoplay). date picks the point: a time ' +
    '(ISO 8601 or a Unix timestamp; replay starts a second before it, so its bar comes with the ' +
    "first step), 'first' (the first bar replay can reach) or 'random' (a random bar, the default, " +
    'as the Random bar of TradingView). Returns active, date and dateIso (the replay point, Unix ' +
    'seconds and ISO; null, with a warning, until TradingView reports it), start and resolution ' +
    '(the timeframe of the chart). Fails with NOT_AVAILABLE while replay runs already, when ' +
    'TradingView cannot replay the chart, and when the layout holds a replay TradingView saved on ' +
    'leaving it, which it would ask about in its "continue replay" dialog; with PLAN_LIMIT on an ' +
    'intraday timeframe when the plan lacks BAR_REPLAY_INTRADAY (daily, weekly and monthly charts ' +
    'replay on every plan); with INVALID_INPUT for a time outside the loaded bars; and with ' +
    'AUTH_REQUIRED while no account is signed in. TradingView keeps how its replay button starts ' +
    'a replay as a setting, which the call sets back. During replay TradingView itself switches ' +
    'its trading panel to its internal replay broker, and back to the default broker afterwards; ' +
    'the server never trades, and no tool places orders. End with replay_stop.',
  inputSchema: {
    date: timeInput()
      .optional()
      .describe(
        "Where replay starts: 'first' (the first bar replay can reach), 'random' (a random bar, " +
          `the default) or a time: ${TIME_INPUT}. Without an offset a time is UTC. A time must lie ` +
          'within the loaded bars of the chart.',
      ),
  },
  annotations: ACTS,
  async handler({ date }, ctx): Promise<ToolOutput<StartedReplay>> {
    const choice = startOf(date);
    const page = await ctx.connection.chartPage();
    const waitMs = pageWaitMs(ctx.config.callTimeoutMs);
    // Checked in this order, before anything changes.
    const reading = await page.bridge.evaluate(readReplayState, []);
    forgetEndedRun(ctx, reading);
    if (reading.started === true) {
      throw alreadyActiveError();
    }
    if (reading.started !== false) {
      throw unknownStateError();
    }
    if (!reading.signedIn) {
      throw signedOutError();
    }
    // Read whatever the timeframe, since the page checks it again right before the select.
    const allowed = await planAllowsIntraday(page);
    const refusal = availabilityRefusal(reading, allowed);
    if (refusal !== null) {
      throw refusal;
    }
    if (reading.savedSession !== false) {
      throw savedSessionError(reading.savedSession);
    }
    if (choice.start === 'date') {
      requireWithinHistory(choice.seconds, reading.history);
    }
    const startedAt = performance.now();
    const left = (): number => Math.max(waitMs - (performance.now() - startedAt), 0);
    const outcome = await page.bridge.evaluate(startReplayViaApi, [
      choice.start,
      choice.start === 'date' ? choice.seconds * 1000 : null,
      allowed,
      waitMs,
    ]);
    // A select that ended has started replay by then, or will not; the replay date shows later.
    const ready = await pollUntil(
      () => page.bridge.evaluate(readReplayState, []),
      (state) =>
        (state.started === true && state.date !== null) ||
        (outcome.ended !== 'late' && state.started !== true),
      { intervalMs: POLL_INTERVAL_MS, timeoutMs: left() },
    );
    const state = ready.last;
    // The run of replay this session started, by its start point, once it is seen ready. A start not
    // seen ready may still come, but nothing tells it from a replay the user starts meanwhile, so
    // replay_stop will not clear what TradingView saves for it.
    ctx.session.replayRunStartedBySession =
      state.started === true && state.date !== null ? state.selectedPoint : null;
    if (state.started !== true) {
      throw outcome.ended === 'late' ? startTimeoutError(waitMs) : startFailedError(outcome.reason);
    }
    const warnings: string[] = [];
    if (state.date === null) {
      warnings.push(dateNotReportedWarning(waitMs));
    }
    if (!outcome.timingModeKept) {
      warnings.push(TIMING_MODE_WARNING);
    }
    return {
      data: {
        active: true,
        ...replayTimeOf(state.date),
        start: choice.start,
        resolution: state.resolution,
      },
      via: 'api',
      warnings,
    };
  },
});

export const replayStep = defineTool({
  name: 'replay_step',
  domain: 'replay',
  title: 'Step bar replay',
  description:
    'Moves a running replay forward by bars bars (1 to 500, default 1), one step of TradingView ' +
    'each, and returns date and dateIso (the replay point afterwards), stepped (how many bars it ' +
    'moved) and finished (true when replay reached the end of the loaded bars, where TradingView ' +
    'stops replay; replay_stop then closes its toolbar). A call keeps within 45 s, so that no ' +
    'client gives up on it: what is left comes back with a warning, to step on with another call. ' +
    'Fails with NOT_AVAILABLE when replay is not running (replay_start) or plays on its own ' +
    '(replay_autoplay with enabled: false first).',
  inputSchema: {
    bars: z
      .number()
      .int()
      .min(1)
      .max(MAX_BARS)
      .default(1)
      .describe(`How many bars to step, 1 to ${String(MAX_BARS)} (default 1).`),
  },
  annotations: ACTS,
  handler: (input, ctx) => stepBars(input, ctx),
});

// What replay_step does, within budgetMs from its start, timed by now (a test gives its own): one
// page call for each bar, each waiting at most a step wait, and a step only while a step wait of the
// budget is left. A step that fails, or a page that fails, after the first bar ends the call with
// what was stepped and a warning, since a failed call invites a retry from where the replay went on.
export async function stepBars(
  { bars }: { bars: number },
  ctx: ToolContext,
  budgetMs: number = CLIENT_SAFE_BUDGET_MS,
  now: () => number = () => performance.now(),
): Promise<ToolOutput<SteppedReplay>> {
  const startedAt = now();
  const left = (): number => budgetMs - (now() - startedAt);
  const page = await ctx.connection.chartPage();
  const stepWait = Math.min(STEP_WAIT_MS, pageWaitMs(ctx.config.callTimeoutMs));
  const reading = await page.bridge.evaluate(readReplayState, []);
  forgetEndedRun(ctx, reading);
  if (reading.started !== true) {
    throw notStartedError();
  }
  if (reading.autoplay === true) {
    throw autoplayRunningError();
  }
  let date = reading.date;
  let stepped = 0;
  let finished = false;
  const warnings: string[] = [];
  while (stepped < bars) {
    if (left() < stepWait) {
      warnings.push(outOfTimeWarning(stepped, bars, budgetMs));
      break;
    }
    let step: StepOutcome;
    try {
      step = await page.bridge.evaluate(stepReplayViaApi, [stepWait]);
    } catch (error) {
      if (stepped === 0 || !isTvMcpError(error)) {
        throw error;
      }
      warnings.push(stoppedEarlyWarning(stepped, bars, error.message));
      break;
    }
    if (step.outcome === 'finished') {
      finished = true;
      date = step.date ?? date;
      break;
    }
    if (step.outcome === 'stepped') {
      stepped += 1;
      date = step.date;
      continue;
    }
    if (step.outcome === 'unconfirmed') {
      // TradingView took the step: it counts, and the date it moved to is not known.
      stepped += 1;
      date = null;
      warnings.push(unconfirmedStepWarning(stepWait));
      break;
    }
    const failure =
      step.outcome === 'late' ? stepTimeoutError(stepWait) : stepFailedError(step.reason);
    if (stepped === 0) {
      throw failure;
    }
    warnings.push(stoppedEarlyWarning(stepped, bars, failure.message));
    break;
  }
  return { data: { ...replayTimeOf(date), stepped, finished }, via: 'api', warnings };
}

export const replayAutoplay = defineTool({
  name: 'replay_autoplay',
  domain: 'replay',
  title: 'Play bar replay',
  description:
    'Starts or stops the automatic playback of a running replay (enabled), and with speed sets ' +
    'how fast it plays, as one of the speeds of TradingView, from 10x (ten bars a second) to 0.1x ' +
    '(a bar every 10 s), such as 1x or 0.5x; replay_status names the current one. Returns ' +
    'autoplay, delayMs (the time between two bars) and speed. TradingView keeps the speed as its ' +
    'own setting, for later replays too. Fails with NOT_AVAILABLE when replay is not running or ' +
    'has reached the end of the loaded bars, and an unknown speed with INVALID_INPUT, which lists ' +
    'the speeds.',
  inputSchema: {
    enabled: z.boolean().describe('true starts autoplay, false stops it.'),
    speed: z
      .string()
      .min(1)
      .max(MAX_SPEED_INPUT)
      .optional()
      .describe(
        'How fast autoplay plays, as a speed of TradingView such as 10x, 1x or 0.5x (replay_status ' +
          'names the current one). TradingView keeps it as its own setting. Left out, the speed ' +
          'stays.',
      ),
  },
  annotations: SETS,
  async handler({ enabled, speed }, ctx) {
    const page = await ctx.connection.chartPage();
    const reading = await page.bridge.evaluate(readReplayState, []);
    forgetEndedRun(ctx, reading);
    const delayMs = speed === undefined ? null : speedDelayOf(speed, reading.speeds);
    if (reading.started !== true) {
      throw notStartedError();
    }
    // At the end of the data TradingView would stop replay instead of playing it.
    if (enabled && reading.finished === true) {
      throw endOfHistoryError();
    }
    const waitMs = Math.min(AUTOPLAY_WAIT_MS, pageWaitMs(ctx.config.callTimeoutMs));
    const result = await page.bridge.evaluate(setAutoplayViaApi, [enabled, delayMs, waitMs]);
    if (!result.started) {
      throw replayEndedError();
    }
    if (result.autoplay !== enabled) {
      throw autoplayUnchangedError(enabled, waitMs);
    }
    return {
      data: {
        autoplay: result.autoplay,
        delayMs: result.delayMs,
        speed: speedLabelOf(result.delayMs, reading.speeds),
      },
      via: 'api',
    };
  },
});

export const replayStatus = defineTool({
  name: 'replay_status',
  domain: 'replay',
  title: 'Read bar replay',
  description:
    'Reports bar replay on the active chart, and changes nothing: available (whether TradingView ' +
    'can replay the chart within the plan; reason says why not, such as an intraday timeframe ' +
    'without BAR_REPLAY_INTRADAY), active (whether replay runs), date and dateIso (the replay ' +
    'point, Unix seconds and ISO; null while replay is off), autoplay, delayMs and speed (how fast ' +
    'autoplay plays), resolution (the timeframe of the chart), and position, realizedPL and ' +
    'currency of the paper trading of replay, which stay null on TradingView Desktop (no tool ' +
    'trades). A value TradingView does not tell is null.',
  inputSchema: {},
  annotations: READ_ONLY,
  async handler(_input, ctx) {
    const page = await ctx.connection.chartPage();
    const reading = await page.bridge.evaluate(readReplayState, []);
    forgetEndedRun(ctx, reading);
    const { available, reason } = availabilityOf(reading, await intradayAllowed(page, reading));
    return {
      data: {
        available,
        reason,
        active: reading.started,
        ...replayTimeOf(reading.date),
        autoplay: reading.autoplay,
        delayMs: reading.delayMs,
        speed: speedLabelOf(reading.delayMs, reading.speeds),
        resolution: reading.resolution,
        position: reading.position,
        realizedPL: reading.realizedPL,
        currency: reading.currency,
      },
      via: 'api',
    };
  },
});

export const replayStop = defineTool({
  name: 'replay_stop',
  domain: 'replay',
  title: 'Stop bar replay',
  description:
    'Leaves bar replay, and returns { active: false }: it stops autoplay first, then leaves replay ' +
    'without the "Leave replay" dialog of TradingView, and the chart shows its live bars again; ' +
    'the replay toolbar TradingView keeps open after replay reached its end is closed too. ' +
    'TradingView saves a replay left before its end in the layout, to offer to continue it in a ' +
    'dialog the next time replay starts: when the replay left is the one replay_start of this ' +
    'session started, known by the point it started at, the call clears that (TradingView counts ' +
    'it as a change of the layout), while a replay the user started keeps it, as does any replay ' +
    'saved before. With nothing to leave it changes nothing.',
  inputSchema: {},
  annotations: SETS,
  async handler(_input, ctx) {
    const page = await ctx.connection.chartPage();
    const waitMs = pageWaitMs(ctx.config.callTimeoutMs);
    const result = await page.bridge.evaluate(leaveReplayViaApi, [
      ctx.session.replayRunStartedBySession,
      waitMs,
    ]);
    if (!result.stopped) {
      // The run may still be the one of this session, whose saved state a later call then clears.
      throw stopTimeoutError(waitMs);
    }
    ctx.session.replayRunStartedBySession = null;
    return {
      data: { active: false },
      via: 'api',
      warnings: result.cleared === false ? [NOT_CLEARED_WARNING] : [],
    };
  },
});

// In the order of the catalog (design spec 7).
export const replayTools: AnyToolDefinition[] = [
  replayStart,
  replayStep,
  replayAutoplay,
  replayStatus,
  replayStop,
];
