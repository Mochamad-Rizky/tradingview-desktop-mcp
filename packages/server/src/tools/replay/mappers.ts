import { isTvMcpError, TvMcpError } from '../../core/errors.js';
import { modifiedToSeconds, parseTimeInput, toIso } from '../../utils/time.js';
import type { ReplayReading, ReplaySpeed } from './page.js';

// The pure parts of the replay tools: the timeframes the plan gates, the times and speeds TradingView
// reports, whether the active chart can be replayed, where a replay starts, and the errors and
// warnings of the tools.

// Where replay_start starts a replay: a second before a time (Unix seconds), at the first bar replay
// can reach, or at a random bar.
export type ReplayStartChoice = { start: 'date'; seconds: number } | { start: 'first' | 'random' };

// What the availability of the active chart is judged by.
type AvailabilityReading = Pick<
  ReplayReading,
  'available' | 'chartAvailable' | 'unavailableReason' | 'resolution'
>;

const STATUS_HINT = 'Check replay_status.';
const END_HINT = 'Call replay_stop to leave replay, and replay_start to replay again.';
const TIMEFRAME_HINT =
  'Switch the chart to a daily, weekly or monthly timeframe with chart_set_timeframe';

// Daily, weekly and monthly timeframes (1D, W, 3M and the like), which replay on every plan, as
// Interval.isDWM() of the app tells them. Every other timeframe is intraday (minutes, seconds,
// ticks, ranges), which needs BAR_REPLAY_INTRADAY; so is a timeframe the chart does not report, as
// far as the plan goes.
export function isDailyOrLonger(resolution: string | null): boolean {
  return resolution !== null && /^\d*[DWM]$/.test(resolution);
}

// A replay date as the tools report it: Unix seconds and ISO, both null for what is no time.
export function replayTimeOf(value: number | null): {
  date: number | null;
  dateIso: string | null;
} {
  const seconds = modifiedToSeconds(value);
  return { date: seconds, dateIso: seconds === null ? null : toIso(seconds) };
}

// The label of the speed whose delay is delayMs, null for a delay TradingView does not list.
export function speedLabelOf(
  delayMs: number | null,
  speeds: readonly ReplaySpeed[],
): string | null {
  return speeds.find(({ value }) => value === delayMs)?.label ?? null;
}

// The labels as a list for a sentence: "a, b or c".
function listed(labels: readonly string[]): string {
  return labels.length < 2
    ? labels.join('')
    : `${labels.slice(0, -1).join(', ')} or ${String(labels.at(-1))}`;
}

// The delay of the speed labeled `speed`, in any case and with spaces around it. A label TradingView
// does not list is INVALID_INPUT, which names the speeds, and no list at all NOT_AVAILABLE.
export function speedDelayOf(speed: string, speeds: readonly ReplaySpeed[]): number {
  if (speeds.length === 0) {
    throw new TvMcpError(
      'NOT_AVAILABLE',
      'TradingView does not list the speeds of replay, so no speed can be set',
      { hint: 'Leave speed out to keep the speed replay plays at.' },
    );
  }
  const wanted = speed.trim().toLowerCase();
  const found = speeds.find(({ label }) => label.toLowerCase() === wanted);
  if (found === undefined) {
    const labels = speeds.map(({ label }) => label);
    throw new TvMcpError(
      'INVALID_INPUT',
      `Unknown replay speed ${JSON.stringify(speed)}: TradingView plays replay at ${listed(labels)}`,
      {
        hint: 'Give one of these speeds, as replay_status names the current one.',
        details: { speed, speeds: labels },
      },
    );
  }
  return found.value;
}

// Why TradingView cannot replay the active chart within the plan, as the error replay_start fails
// with, or null when it can: TradingView says it cannot replay the chart, or does not tell; or the
// chart is intraday on a plan without BAR_REPLAY_INTRADAY, where the app would open its paywall
// (intradayAllowed is what the plan says, null when it cannot be read). The plan is not asked about
// a daily, weekly or monthly chart, whatever intradayAllowed says.
export function availabilityRefusal(
  reading: AvailabilityReading,
  intradayAllowed: boolean | null,
): TvMcpError | null {
  const { available, chartAvailable, unavailableReason: reason, resolution } = reading;
  const chart = resolution === null ? 'the chart' : `the chart on its ${resolution} timeframe`;
  if (available === null) {
    return new TvMcpError(
      'NOT_AVAILABLE',
      `TradingView does not tell whether it can replay ${chart}, so replay was not started`,
      { hint: 'Check app_health, or start replay in TradingView itself.', details: { resolution } },
    );
  }
  if (!available || chartAvailable === false) {
    return new TvMcpError(
      'NOT_AVAILABLE',
      `TradingView cannot replay ${chart}${reason === null ? '' : `: ${reason}`}`,
      {
        hint:
          'TradingView does not replay some chart types (range bars among them), some symbols, ' +
          'or a chart converted to another currency or unit. Check replay_status.',
        details: { resolution, reason },
      },
    );
  }
  if (isDailyOrLonger(resolution) || intradayAllowed === true) {
    return null;
  }
  if (intradayAllowed === null) {
    return intradayUnreadableError(resolution);
  }
  return resolution === null ? noTimeframeError() : intradayPlanError(resolution);
}

// The refusals of an intraday chart, which startReplayViaApi repeats word for word right before the
// select: the plan does not include intraday replay, it cannot be read, or the chart does not
// report its timeframe on a plan that replays daily, weekly and monthly charts only.
export function intradayPlanError(resolution: string): TvMcpError {
  return new TvMcpError(
    'PLAN_LIMIT',
    'The plan does not include bar replay on intraday timeframes (BAR_REPLAY_INTRADAY), and the ' +
      `chart is on ${resolution}`,
    {
      hint: `${TIMEFRAME_HINT} to replay it, or upgrade the plan in TradingView.`,
      details: { feature: 'BAR_REPLAY_INTRADAY', resolution },
    },
  );
}

export function intradayUnreadableError(resolution: string | null): TvMcpError {
  return new TvMcpError(
    'NOT_AVAILABLE',
    'Whether the plan includes bar replay on intraday timeframes cannot be read on this ' +
      `TradingView build, and the chart is on ${resolution ?? 'a timeframe it does not report'}`,
    {
      hint: `${TIMEFRAME_HINT}, or start replay in TradingView itself.`,
      details: { feature: 'BAR_REPLAY_INTRADAY', resolution },
    },
  );
}

export function noTimeframeError(): TvMcpError {
  return new TvMcpError(
    'NOT_AVAILABLE',
    'The chart does not report its timeframe, and the plan replays daily, weekly and monthly ' +
      'charts only',
    {
      hint: 'Check chart_get_state, or start replay in TradingView itself.',
      details: { feature: 'BAR_REPLAY_INTRADAY' },
    },
  );
}

// Whether TradingView can replay the active chart within the plan, and why not, for replay_status.
export function availabilityOf(
  reading: AvailabilityReading,
  intradayAllowed: boolean | null,
): { available: boolean; reason: string | null } {
  const refusal = availabilityRefusal(reading, intradayAllowed);
  return { available: refusal === null, reason: refusal?.message ?? null };
}

// Where a replay starts, from the date of replay_start: a random bar without one, as the Random bar
// of TradingView, first or random in any case, or else a time, which parseTimeInput reads.
export function startOf(date: string | number | undefined): ReplayStartChoice {
  if (date === undefined) {
    return { start: 'random' };
  }
  if (typeof date === 'string') {
    const word = date.trim().toLowerCase();
    if (word === 'first' || word === 'random') {
      return { start: word };
    }
  }
  try {
    return { start: 'date', seconds: parseTimeInput(date) };
  } catch (error) {
    if (isTvMcpError(error) && error.code === 'INVALID_INPUT') {
      throw new TvMcpError('INVALID_INPUT', error.message, {
        hint: `Give 'first', 'random' or a time. ${error.hint ?? ''}`.trim(),
      });
    }
    throw error;
  }
}

// Fails unless `seconds` lies within the loaded bars of the active chart (history, null without
// bars): replay starts within the bars the chart has.
export function requireWithinHistory(
  seconds: number,
  history: { first: number; last: number } | null,
): void {
  if (history === null) {
    throw new TvMcpError('NOT_AVAILABLE', 'The chart has no loaded bars to start replay in', {
      hint: 'Check app_health: the chart may still be loading.',
    });
  }
  if (seconds < history.first || seconds > history.last) {
    throw new TvMcpError(
      'INVALID_INPUT',
      `${toIso(seconds)} is outside the loaded bars of the chart, from ${toIso(history.first)} ` +
        `to ${toIso(history.last)}`,
      {
        hint:
          "Give a time within the loaded bars, or 'first' for the first bar replay can reach, or " +
          "'random'.",
        details: { date: seconds, first: history.first, last: history.last },
      },
    );
  }
}

export function alreadyActiveError(): TvMcpError {
  return new TvMcpError('NOT_AVAILABLE', 'Replay is already running on the chart', {
    hint:
      'Call replay_step to go on from where it is, or replay_stop and then replay_start to start ' +
      'again.',
  });
}

export function unknownStateError(): TvMcpError {
  return new TvMcpError(
    'NOT_AVAILABLE',
    'TradingView does not tell whether replay is running, so it was not started',
    { hint: 'Check replay_status, or start replay in TradingView itself.' },
  );
}

export function notStartedError(): TvMcpError {
  return new TvMcpError('NOT_AVAILABLE', 'Replay is not running on the chart', {
    hint: 'Start it with replay_start first.',
  });
}

export function autoplayRunningError(): TvMcpError {
  return new TvMcpError(
    'NOT_AVAILABLE',
    'Replay is playing on its own (autoplay), so it cannot be stepped',
    { hint: 'Stop autoplay with replay_autoplay and enabled: false, then step.' },
  );
}

export function signedOutError(): TvMcpError {
  return new TvMcpError('AUTH_REQUIRED', 'Bar replay needs a signed-in TradingView account', {
    hint: 'Sign in to TradingView, then try again.',
  });
}

// A layout that holds a replay TradingView saved on leaving it (saved true), or does not tell (null):
// the next start would open the "continue replay" dialog of the app. No tool clears such a replay:
// replay_stop clears only what TradingView saves as it leaves the replay this session started.
export function savedSessionError(saved: boolean | null): TvMcpError {
  return new TvMcpError(
    'NOT_AVAILABLE',
    saved === true
      ? 'The layout holds a replay TradingView saved when it was left, so starting replay would ' +
          'open the "continue replay" dialog of TradingView'
      : 'TradingView does not tell whether the layout holds a saved replay, which would open its ' +
          '"continue replay" dialog',
    {
      hint:
        'Nothing was started. The user continues or discards the saved replay in TradingView ' +
        'itself (its replay button asks); no tool clears it. Then try again.',
    },
  );
}

export function startFailedError(reason: string | null): TvMcpError {
  return new TvMcpError(
    'NOT_AVAILABLE',
    `TradingView did not start replay${reason === null ? '' : `: ${reason}`}`,
    {
      hint: 'Check replay_status; replay_stop closes the replay toolbar if TradingView left it open.',
    },
  );
}

export function startTimeoutError(waitMs: number): TvMcpError {
  return new TvMcpError('TIMEOUT', `TradingView did not start replay within ${String(waitMs)} ms`, {
    hint: 'Replay may still start: check replay_status, and call replay_stop to leave it.',
    details: { waitMs },
  });
}

export function stepFailedError(reason: string | null): TvMcpError {
  return new TvMcpError(
    'NOT_AVAILABLE',
    `TradingView could not step the replay${reason === null ? '' : `: ${reason}`}`,
    { hint: 'Check replay_status; replay_stop leaves replay.' },
  );
}

export function stepTimeoutError(waitMs: number): TvMcpError {
  return new TvMcpError(
    'TIMEOUT',
    `TradingView did not step the replay within ${String(waitMs)} ms`,
    {
      hint: 'The step may still come through: check replay_status before stepping again.',
      details: { waitMs },
    },
  );
}

export function endOfHistoryError(): TvMcpError {
  return new TvMcpError(
    'NOT_AVAILABLE',
    'Replay has reached the end of the loaded bars, so it cannot play on',
    { hint: END_HINT },
  );
}

export function replayEndedError(): TvMcpError {
  return new TvMcpError(
    'NOT_AVAILABLE',
    'TradingView ended the replay instead of playing it: it had reached the end of the loaded bars',
    { hint: END_HINT },
  );
}

export function autoplayUnchangedError(enabled: boolean, waitMs: number): TvMcpError {
  return new TvMcpError(
    'NOT_AVAILABLE',
    `TradingView did not ${enabled ? 'start' : 'stop'} autoplay within ${String(waitMs)} ms`,
    { hint: STATUS_HINT, details: { waitMs } },
  );
}

export function stopTimeoutError(waitMs: number): TvMcpError {
  return new TvMcpError('TIMEOUT', `Replay did not stop within ${String(waitMs)} ms`, {
    hint: 'No dialog was opened. Check replay_status, and call replay_stop again.',
    details: { waitMs },
  });
}

export function dateNotReportedWarning(waitMs: number): string {
  return (
    `Replay started, but TradingView did not report the replay date within ${String(waitMs)} ms: ` +
    'replay_status reads it.'
  );
}

export function barsNotShownWarning(waitMs: number): string {
  return (
    `Replay started, but TradingView did not show the bars of the replay within ${String(waitMs)} ` +
    'ms: until it does, data_get_ohlcv finds no bars and replay_step may not be confirmed. Call ' +
    'replay_status or data_get_ohlcv again shortly.'
  );
}

export const TIMING_MODE_WARNING =
  'Starting replay changed the setting of TradingView for how its replay button starts a replay, ' +
  'and it could not be set back.';

export function outOfTimeWarning(stepped: number, bars: number, budgetMs: number): string {
  return (
    `Stepped ${String(stepped)} of ${String(bars)} bars within the ${String(budgetMs / 1000)} s a ` +
    'call allows: call replay_step again for the rest.'
  );
}

export function unconfirmedStepWarning(waitMs: number): string {
  return (
    'TradingView took the last step but did not report the new replay date within ' +
    `${String(waitMs)} ms: replay_status reads it.`
  );
}

export function stoppedEarlyWarning(stepped: number, bars: number, why: string): string {
  return `Stepped ${String(stepped)} of ${String(bars)} bars, then stopped: ${why}`;
}

export const NOT_CLEARED_WARNING =
  'The replay TradingView saved in the layout when it was left could not be cleared: TradingView ' +
  'may offer to continue it the next time replay starts.';
