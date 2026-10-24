import type { PageErrorSentinel } from '../../core/tv/page-bridge.js';
import type {
  BarsLike,
  ChartModelLike,
  ChartWidgetApiLike,
  ReplayApiLike,
  TradingViewApiLike,
  TvWindow,
} from '../../core/tv/tv-window.js';

// The page functions of the replay tools (reverse-engineering notes of Plan 3, section 4). The page
// bridge sends the source text of each one into the page, so each uses nothing of this file, only its
// parameters and the globals of the page, and whatever it shares with another is written out in
// each. Types are erased, so the type imports above are fine.
//
// Each reaches replay through TradingViewApi.replayApi(), the replay API of the app, and reads its
// watched values with value(). None calls buy, sell, closePosition or goToRealtime of that API, nor
// the trading service of the app: on TradingView Desktop the paper trading of replay goes through
// that service, with an internal replay broker the app itself selects for its trading panel during
// replay and swaps back afterwards. Replay is left with leaveReplay and skipConfirm, which never asks
// in the "Leave replay" dialog. The replay TradingView saves in the layout on leaving, which would
// open its "continue replay" dialog at the next start, is cleared only right after leaving the run
// of replay the caller started, told by the point it started at (getReplaySelectedDate).

// A speed of autoplay: its label, such as 10x, and the time between two bars in milliseconds. A type
// alias, not an interface: it comes back from the page as JSON, which a type must satisfy JsonValue
// for.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type ReplaySpeed = { label: string; value: number };

// Replay on the active chart, as far as the tools need it, each member null when TradingView does
// not tell:
// - signedIn: whether an account is signed in (window.is_authenticated);
// - available: whether TradingView can replay a chart of the layout (isReplayAvailable), and
//   chartAvailable and unavailableReason what the replay controller says of the active chart, by the
//   id of its chart model (the reason null when it gives none);
// - started: whether replay runs; modeOn: whether the replay mode, which shows the replay toolbar,
//   is on (it stays on when replay reaches the end of the data, until replay is left); finished:
//   whether replay reached the end of the data;
// - autoplay, date (the replay point in Unix seconds, as currentDate gives it), selectedPoint (the
//   point the run of replay started or was last reset at, in Unix seconds, null while replay is
//   stopped), delayMs (the time between two bars of autoplay) and speeds (those TradingView lists);
// - resolution: the timeframe of the active chart; savedSession: whether the layout holds a replay
//   TradingView saved on leaving it; history: the earliest and the latest time of the loaded bars of
//   the active chart, null without bars;
// - position, realizedPL and currency of the paper trading of replay, null on TradingView Desktop.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type ReplayReading = {
  signedIn: boolean;
  available: boolean | null;
  chartAvailable: boolean | null;
  unavailableReason: string | null;
  started: boolean | null;
  modeOn: boolean | null;
  finished: boolean | null;
  autoplay: boolean | null;
  date: number | null;
  selectedPoint: number | null;
  delayMs: number | null;
  speeds: ReplaySpeed[];
  resolution: string | null;
  savedSession: boolean | null;
  history: { first: number; last: number } | null;
  position: number | string | null;
  realizedPL: number | string | null;
  currency: string | null;
};

// How a start of replay ended: the select resolved, rejected (with why) or had not ended within the
// wait (late); and whether the timing mode of replay is as it was before (timingModeKept), which the
// select changes and keeps as a setting of the app.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type StartOutcome = {
  ended: 'resolved' | 'rejected' | 'late';
  reason: string | null;
  timingModeKept: boolean;
};

// How one step ended: stepped, once the replay date showed the next bar; unconfirmed, when the step
// resolved but the date did not change within the wait; ended, when the step resolved and
// TradingView then stopped replay by itself, keeping its toolbar, as it does once a step reaches the
// end of the data (seen on the app); finished, when TradingView refused the step as the end of the
// data ("Replay is finished"); failed, with why; or late, when the step had not ended within the
// wait. date is the replay date afterwards.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type StepOutcome = {
  outcome: 'stepped' | 'unconfirmed' | 'ended' | 'finished' | 'failed' | 'late';
  date: number | null;
  reason: string | null;
};

// Replay after a change of autoplay: whether it still runs, whether autoplay plays (null when
// TradingView does not tell) and the time between two bars.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type AutoplayOutcome = {
  started: boolean;
  autoplay: boolean | null;
  delayMs: number | null;
};

// What leaving replay did: whether there was a replay or a replay mode to leave (left), whether
// replay is stopped now, whether what TradingView saved for the replay it left is cleared (null
// when the replay left was not the run the caller started, or there was none, false when it could
// not be cleared), and whether the chart shows its live bars again, bars after the replay point
// (null when no replay point was left, or the chart does not tell its bars).
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type LeaveOutcome = {
  left: boolean;
  stopped: boolean;
  cleared: boolean | null;
  liveBars: boolean | null;
};

// Replay on the active chart, as a ReplayReading. It changes nothing of replay or the chart. When the
// app has not made its replay API yet, replayApi() has it made, as the app does on its first use of
// replay: it builds the replay controller of the app, which may load the replay module of the app
// on demand. A page without the replay API is CAPABILITY_UNAVAILABLE, and an API TradingView does not
// give NOT_AVAILABLE.
export async function readReplayState(win: TvWindow): Promise<ReplayReading | PageErrorSentinel> {
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  if (typeof api?.replayApi !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no replay API of TradingView',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  const reasonOf = (error: unknown): string => {
    const message: unknown =
      typeof error === 'object' && error !== null
        ? (error as { message?: unknown }).message
        : undefined;
    return typeof message === 'string' && message !== '' ? message : String(error);
  };
  let given: unknown;
  try {
    given = await api.replayApi();
  } catch (error) {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: `TradingView did not give its replay API: ${reasonOf(error)}`,
        hint: 'Check app_health: the chart may still be loading.',
      },
    };
  }
  if (typeof given !== 'object' || given === null) {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: 'TradingView did not give its replay API: it answered no object',
        hint: 'Check app_health: the chart may still be loading.',
      },
    };
  }
  const replay = given as Partial<ReplayApiLike>;
  const attempt = (read: () => unknown): unknown => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  // A watched value, whose value() is read as a method of it.
  const watched = (get: () => unknown): unknown =>
    attempt(() => {
      const value = get() as { value?: unknown } | null | undefined;
      return typeof value?.value === 'function'
        ? (value as { value(): unknown }).value()
        : undefined;
    });
  const flag = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
  const finite = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const text = (value: unknown): string | null =>
    typeof value === 'string' && value !== '' ? value : null;

  const chart = attempt(() => api.activeChart?.()) as Partial<ChartWidgetApiLike> | undefined;
  const model = attempt(() => chart?._chartWidget?.model()) as Partial<ChartModelLike> | undefined;
  // What the replay controller says of the active chart, by the id of its chart model.
  const modelId = attempt(() => model?.id?.());
  const map = attempt(() => replay._replayUIController?.replayAvailability?.()) as
    { get?: unknown } | null | undefined;
  const entry =
    modelId !== undefined && modelId !== null && typeof map?.get === 'function'
      ? (attempt(() => (map as { get(key: unknown): unknown }).get(modelId)) as
          { isAvailable?: unknown; unavailabilityReason?: unknown } | null | undefined)
      : undefined;

  const speeds: ReplaySpeed[] = [];
  const list = attempt(() => replay.autoplayDelayList?.());
  if (Array.isArray(list)) {
    for (const item of list as unknown[]) {
      const label = attempt(() => (item as { label?: unknown } | null)?.label);
      const value = attempt(() => (item as { value?: unknown } | null)?.value);
      if (typeof label === 'string' && label !== '' && finite(value) !== null) {
        speeds.push({ label, value: value as number });
      }
    }
  }

  // The loaded bars from the earlier to the later of two times for each end: the time in the row of
  // the bar, which is the start of its session, and the time the chart reports for it, which is the
  // day at 00:00 UTC for a daily bar.
  const bars = attempt(() => model?.mainSeries?.().bars()) as Partial<BarsLike> | undefined;
  const timesOf = (index: unknown): number[] => {
    if (typeof index !== 'number') {
      return [];
    }
    const row = attempt(() => bars?.valueAt?.(index));
    const times = [
      Array.isArray(row) ? finite(row[0]) : null,
      finite(attempt(() => chart?._convertIndexToPublicTime?.(index))),
    ];
    return times.filter((time): time is number => time !== null);
  };
  const firsts = timesOf(attempt(() => bars?.firstIndex?.()));
  const lasts = timesOf(attempt(() => bars?.lastIndex?.()));

  let savedSession: boolean | null = null;
  try {
    const collection = api._chartWidgetCollection;
    if (typeof collection?.replaySessionState === 'function') {
      const saved = collection.replaySessionState();
      savedSession = saved !== null && saved !== undefined;
    }
  } catch {
    savedSession = null;
  }
  const amount = (value: unknown): number | string | null =>
    typeof value === 'string' ? value : finite(value);

  return {
    signedIn: win.is_authenticated === true,
    available: flag(watched(() => replay.isReplayAvailable?.())),
    chartAvailable: flag(attempt(() => entry?.isAvailable)),
    unavailableReason: text(attempt(() => entry?.unavailabilityReason)),
    started: flag(watched(() => replay.isReplayStarted?.())),
    modeOn: flag(watched(() => replay.isReplayToolbarVisible?.())),
    finished: flag(attempt(() => replay._replayUIController?._replayManager?.isReplayFinished?.())),
    autoplay: flag(watched(() => replay.isAutoplayStarted?.())),
    date: finite(watched(() => replay.currentDate?.())),
    selectedPoint: finite(watched(() => replay.getReplaySelectedDate?.())),
    delayMs: finite(attempt(() => replay.autoplayDelay?.())),
    speeds,
    resolution: text(attempt(() => chart?.resolution?.())),
    savedSession,
    history:
      firsts.length > 0 && lasts.length > 0
        ? { first: Math.min(...firsts), last: Math.max(...lasts) }
        : null,
    position: amount(watched(() => replay.position?.())),
    realizedPL: amount(watched(() => replay.realizedPL?.())),
    currency: text(watched(() => replay.currency?.())),
  };
}

// Starts replay with the select of the app for `start`: selectDate(ms) a second before the time ms
// (Unix milliseconds), selectFirstAvailableDate() or selectRandomDate(). Answers how the select ended
// within waitMs (StartOutcome). The select keeps its timing mode of replay as a setting of the app,
// so the mode is set back to what it was afterwards, whether the select ended or not; a mode that
// cannot be read, or set back, refuses before the select (NOT_AVAILABLE), so that the setting never
// stays changed. Right before the select, in the same turn, since the user may change these while
// the caller checks: a running replay, or one TradingView does not tell about, is NOT_AVAILABLE, a
// signed-out account (the app would show its sign-in wall) AUTH_REQUIRED, a chart that is not on a
// daily, weekly or monthly timeframe PLAN_LIMIT or NOT_AVAILABLE unless intradayAllowed, what the plan
// says of intraday replay, is true (the app would open its paywall), and a layout that holds a saved
// replay, or does not tell, NOT_AVAILABLE (the app would open its "continue replay" dialog). Each of
// these refusals is word for word the one the tools give before they call this. A start it does not
// know and a time that is no number are INVALID_INPUT, and a build without the select
// CAPABILITY_UNAVAILABLE.
export async function startReplayViaApi(
  win: TvWindow,
  start: string,
  ms: number | null,
  intradayAllowed: boolean | null,
  waitMs: number,
): Promise<StartOutcome | PageErrorSentinel> {
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  if (typeof api?.replayApi !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no replay API of TradingView',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  const reasonOf = (error: unknown): string => {
    const message: unknown =
      typeof error === 'object' && error !== null
        ? (error as { message?: unknown }).message
        : undefined;
    return typeof message === 'string' && message !== '' ? message : String(error);
  };
  let given: unknown;
  try {
    given = await api.replayApi();
  } catch (error) {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: `TradingView did not give its replay API: ${reasonOf(error)}`,
        hint: 'Check app_health: the chart may still be loading.',
      },
    };
  }
  if (typeof given !== 'object' || given === null) {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: 'TradingView did not give its replay API: it answered no object',
        hint: 'Check app_health: the chart may still be loading.',
      },
    };
  }
  const replay = given as Partial<ReplayApiLike>;
  const attempt = (read: () => unknown): unknown => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const started = attempt(() => {
    const value = replay.isReplayStarted?.() as { value?: unknown } | null | undefined;
    return typeof value?.value === 'function' ? (value as { value(): unknown }).value() : undefined;
  });
  if (started === true) {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: 'Replay is already running on the chart',
        hint:
          'Call replay_step to go on from where it is. A replay this session did not start may ' +
          "be the user's: ask the user before stopping it with replay_stop.",
      },
    };
  }
  if (started !== false) {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: 'TradingView does not tell whether replay is running, so it was not started',
        hint: 'Check replay_status, or start replay in TradingView itself.',
      },
    };
  }
  if (win.is_authenticated !== true) {
    return {
      __tvmcpError: {
        code: 'AUTH_REQUIRED',
        message: 'Bar replay needs a signed-in TradingView account',
        hint: 'Sign in to TradingView, then try again.',
      },
    };
  }
  // The timeframe, which another call may have changed since the plan was checked.
  const shown = attempt(() => api.activeChart?.().resolution());
  const resolution = typeof shown === 'string' && shown !== '' ? shown : null;
  if ((resolution === null || !/^\d*[DWM]$/.test(resolution)) && intradayAllowed !== true) {
    const timeframeHint =
      'Switch the chart to a daily, weekly or monthly timeframe with chart_set_timeframe';
    if (intradayAllowed === null) {
      return {
        __tvmcpError: {
          code: 'NOT_AVAILABLE',
          message:
            'Whether the plan includes bar replay on intraday timeframes cannot be read on this ' +
            `TradingView build, and the chart is on ${resolution ?? 'a timeframe it does not report'}`,
          hint: `${timeframeHint}, or start replay in TradingView itself.`,
          details: { feature: 'BAR_REPLAY_INTRADAY', resolution },
        },
      };
    }
    return {
      __tvmcpError:
        resolution === null
          ? {
              code: 'NOT_AVAILABLE',
              message:
                'The chart does not report its timeframe, and the plan replays daily, weekly and ' +
                'monthly charts only',
              hint: 'Check chart_get_state, or start replay in TradingView itself.',
              details: { feature: 'BAR_REPLAY_INTRADAY' },
            }
          : {
              code: 'PLAN_LIMIT',
              message:
                'The plan does not include bar replay on intraday timeframes ' +
                `(BAR_REPLAY_INTRADAY), and the chart is on ${resolution}`,
              hint: `${timeframeHint} to replay it, or upgrade the plan in TradingView.`,
              details: { feature: 'BAR_REPLAY_INTRADAY', resolution },
            },
    };
  }
  let saved: boolean | null = null;
  try {
    const collection = api._chartWidgetCollection;
    if (typeof collection?.replaySessionState === 'function') {
      const state = collection.replaySessionState();
      saved = state !== null && state !== undefined;
    }
  } catch {
    saved = null;
  }
  if (saved !== false) {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message:
          saved === true
            ? 'The layout holds a replay TradingView saved when it was left, so starting replay ' +
              'would open the "continue replay" dialog of TradingView'
            : 'TradingView does not tell whether the layout holds a saved replay, which would ' +
              'open its "continue replay" dialog',
        hint:
          'Nothing was started. The user continues or discards the saved replay in TradingView ' +
          'itself (its replay button asks); no tool clears it. Then try again.',
      },
    };
  }
  if (start !== 'date' && start !== 'first' && start !== 'random') {
    return {
      __tvmcpError: {
        code: 'INVALID_INPUT',
        message: `Replay cannot start at ${JSON.stringify(start)}`,
        hint: 'Start replay at a date, at the first bar replay can reach, or at a random bar.',
      },
    };
  }
  const canSelect =
    start === 'date'
      ? typeof replay.selectDate === 'function'
      : start === 'first'
        ? typeof replay.selectFirstAvailableDate === 'function'
        : typeof replay.selectRandomDate === 'function';
  if (!canSelect) {
    const where =
      start === 'date'
        ? 'at a date'
        : start === 'first'
          ? 'at the first bar replay can reach'
          : 'at a random bar';
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: `This TradingView build has no way to start replay ${where}`,
      },
    };
  }
  let at = 0;
  if (start === 'date') {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) {
      return {
        __tvmcpError: {
          code: 'INVALID_INPUT',
          message: 'No time was given to start replay at',
          hint: 'Give the time in Unix milliseconds.',
        },
      };
    }
    at = ms;
  }
  // How a call ended, or late when it did not end within waitMs.
  const settle = (
    call: () => unknown,
  ): Promise<{ value: unknown } | { error: unknown } | { late: true }> => {
    let ended: Promise<{ value: unknown } | { error: unknown }>;
    try {
      ended = Promise.resolve(call()).then(
        (value: unknown) => ({ value }),
        (error: unknown) => ({ error }),
      );
    } catch (error) {
      ended = Promise.resolve({ error });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<{ late: true }>((resolve) => {
      timer = setTimeout(() => {
        resolve({ late: true });
      }, waitMs);
    });
    return Promise.race([ended, late]).then((outcome) => {
      clearTimeout(timer);
      return outcome;
    });
  };

  // The property of the timing mode, read as a method of it, which the select changes and keeps as a
  // setting of the app: one that cannot be set back is not left changed.
  const mode = attempt(() => replay.replayTimingMode?.()) as
    { value?: unknown; setValue?: unknown } | null | undefined;
  const modeNow = (): unknown =>
    attempt(() =>
      typeof mode?.value === 'function' ? (mode as { value(): unknown }).value() : undefined,
    );
  const previous = modeNow();
  if (previous === undefined || typeof mode?.setValue !== 'function') {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message:
          'The setting of TradingView for how its replay button starts a replay cannot be read ' +
          'and set back on this build, and starting replay would change it, so replay was not ' +
          'started',
        hint: 'Start replay in TradingView itself.',
      },
    };
  }
  const property = mode as { setValue(value: unknown): void };
  const starter = replay as ReplayApiLike;
  const outcome = await settle(() =>
    start === 'date'
      ? starter.selectDate(at)
      : start === 'first'
        ? starter.selectFirstAvailableDate()
        : starter.selectRandomDate(),
  );
  let kept: boolean;
  try {
    if (modeNow() !== previous) {
      property.setValue(previous);
    }
    kept = modeNow() === previous;
  } catch {
    kept = false;
  }
  return {
    ended: 'late' in outcome ? 'late' : 'error' in outcome ? 'rejected' : 'resolved',
    reason: 'error' in outcome ? reasonOf(outcome.error) : null,
    timingModeKept: kept,
  };
}

// Moves a running replay one bar forward with doStep, and answers how the step ended within waitMs
// (StepOutcome): the step resolves before the replay date shows the next bar, so it then waits, for
// what is left of waitMs, until the date changes. The step that reaches the end of the data resolves,
// and TradingView then stops replay by itself and keeps its toolbar, without showing a new date: the
// outcome ended; replay that stops with its toolbar gone was left, which is the outcome failed. A
// step TradingView rejects with "Replay is finished" is the outcome finished. Before the step,
// replay that does not run, or plays on its own (autoplay), is NOT_AVAILABLE, and a build without
// doStep CAPABILITY_UNAVAILABLE.
export async function stepReplayViaApi(
  win: TvWindow,
  waitMs: number,
): Promise<StepOutcome | PageErrorSentinel> {
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  if (typeof api?.replayApi !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no replay API of TradingView',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  const reasonOf = (error: unknown): string => {
    const message: unknown =
      typeof error === 'object' && error !== null
        ? (error as { message?: unknown }).message
        : undefined;
    return typeof message === 'string' && message !== '' ? message : String(error);
  };
  let given: unknown;
  try {
    given = await api.replayApi();
  } catch (error) {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: `TradingView did not give its replay API: ${reasonOf(error)}`,
        hint: 'Check app_health: the chart may still be loading.',
      },
    };
  }
  if (typeof given !== 'object' || given === null) {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: 'TradingView did not give its replay API: it answered no object',
        hint: 'Check app_health: the chart may still be loading.',
      },
    };
  }
  const replay = given as Partial<ReplayApiLike>;
  // A watched value, whose value() is read as a method of it.
  const watched = (get: () => unknown): unknown => {
    try {
      const value = get() as { value?: unknown } | null | undefined;
      return typeof value?.value === 'function'
        ? (value as { value(): unknown }).value()
        : undefined;
    } catch {
      return undefined;
    }
  };
  if (watched(() => replay.isReplayStarted?.()) !== true) {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: 'Replay is not running on the chart',
        hint: 'Start it with replay_start first.',
      },
    };
  }
  if (watched(() => replay.isAutoplayStarted?.()) === true) {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: 'Replay is playing on its own (autoplay), so it cannot be stepped',
        hint: 'Stop autoplay with replay_autoplay and enabled: false, then step.',
      },
    };
  }
  if (typeof replay.doStep !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This TradingView build has no way to step a replay',
      },
    };
  }
  const dateNow = (): number | null => {
    const date = watched(() => replay.currentDate?.());
    return typeof date === 'number' && Number.isFinite(date) ? date : null;
  };
  const before = dateNow();
  const startedAt = Date.now();
  const stepper = replay as ReplayApiLike;
  // How the step ended, or late when it did not end within waitMs. doStep throws at once for some
  // failures, which counts as a rejection.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ended: Promise<{ value: unknown } | { error: unknown }>;
  try {
    ended = Promise.resolve(stepper.doStep()).then(
      (value: unknown) => ({ value }),
      (error: unknown) => ({ error }),
    );
  } catch (error) {
    ended = Promise.resolve({ error });
  }
  const outcome = await Promise.race([
    ended,
    new Promise<{ late: true }>((resolve) => {
      timer = setTimeout(() => {
        resolve({ late: true });
      }, waitMs);
    }),
  ]);
  clearTimeout(timer);
  if ('late' in outcome) {
    return { outcome: 'late', date: before, reason: null };
  }
  if ('error' in outcome) {
    const reason = reasonOf(outcome.error);
    return /replay is finished/i.test(reason)
      ? { outcome: 'finished', date: dateNow() ?? before, reason: null }
      : { outcome: 'failed', date: dateNow() ?? before, reason };
  }
  const shown = await new Promise<'date' | 'stopped' | 'none'>((resolve) => {
    const look = (): void => {
      const date = dateNow();
      if (date !== null && date !== before) {
        resolve('date');
      } else if (watched(() => replay.isReplayStarted?.()) === false) {
        resolve('stopped');
      } else if (Date.now() - startedAt >= waitMs) {
        resolve('none');
      } else {
        setTimeout(look, 20);
      }
    };
    look();
  });
  if (shown === 'stopped') {
    return watched(() => replay.isReplayToolbarVisible?.()) === true
      ? { outcome: 'ended', date: dateNow(), reason: null }
      : { outcome: 'failed', date: dateNow(), reason: 'Replay was left during the step' };
  }
  return { outcome: shown === 'date' ? 'stepped' : 'unconfirmed', date: dateNow(), reason: null };
}

// Sets the speed of autoplay to the delay delayMs (one of the speeds of the app; null leaves it),
// which the app keeps as a setting of its own, and starts autoplay when enabled or stops it,
// toggling it only when it is not as asked. Then waits, within waitMs, until autoplay is as asked or
// replay stopped, and answers replay afterwards (AutoplayOutcome). Before anything changes, replay
// that does not run is NOT_AVAILABLE, and so is starting autoplay at the end of the data, where the
// app would stop replay instead. A change the app refuses is NOT_AVAILABLE, and a build without the
// calls CAPABILITY_UNAVAILABLE.
export async function setAutoplayViaApi(
  win: TvWindow,
  enabled: boolean,
  delayMs: number | null,
  waitMs: number,
): Promise<AutoplayOutcome | PageErrorSentinel> {
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  if (typeof api?.replayApi !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no replay API of TradingView',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  const reasonOf = (error: unknown): string => {
    const message: unknown =
      typeof error === 'object' && error !== null
        ? (error as { message?: unknown }).message
        : undefined;
    return typeof message === 'string' && message !== '' ? message : String(error);
  };
  let given: unknown;
  try {
    given = await api.replayApi();
  } catch (error) {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: `TradingView did not give its replay API: ${reasonOf(error)}`,
        hint: 'Check app_health: the chart may still be loading.',
      },
    };
  }
  if (typeof given !== 'object' || given === null) {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: 'TradingView did not give its replay API: it answered no object',
        hint: 'Check app_health: the chart may still be loading.',
      },
    };
  }
  const replay = given as Partial<ReplayApiLike>;
  const attempt = (read: () => unknown): unknown => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  // A watched value, whose value() is read as a method of it.
  const watched = (get: () => unknown): unknown =>
    attempt(() => {
      const value = get() as { value?: unknown } | null | undefined;
      return typeof value?.value === 'function'
        ? (value as { value(): unknown }).value()
        : undefined;
    });
  const running = (): boolean => watched(() => replay.isReplayStarted?.()) === true;
  const playing = (): unknown => watched(() => replay.isAutoplayStarted?.());
  if (!running()) {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: 'Replay is not running on the chart',
        hint: 'Start it with replay_start first.',
      },
    };
  }
  if (
    enabled &&
    attempt(() => replay._replayUIController?._replayManager?.isReplayFinished?.()) === true
  ) {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: 'Replay has reached the end of the loaded bars, so it cannot play on',
        hint:
          'replay_stop leaves replay, and replay_start replays again. Ask the user before ' +
          'stopping a replay this session did not start: it may be theirs.',
      },
    };
  }
  const player = replay as ReplayApiLike;
  if (typeof delayMs === 'number') {
    if (typeof replay.changeAutoplayDelay !== 'function') {
      return {
        __tvmcpError: {
          code: 'CAPABILITY_UNAVAILABLE',
          message: 'This TradingView build has no way to change the speed of autoplay',
        },
      };
    }
    if (attempt(() => player.autoplayDelay()) !== delayMs) {
      try {
        player.changeAutoplayDelay(delayMs);
      } catch (error) {
        return {
          __tvmcpError: {
            code: 'NOT_AVAILABLE',
            message: `TradingView refused to change the speed of autoplay: ${reasonOf(error)}`,
            hint: 'Check replay_status.',
          },
        };
      }
    }
  }
  if ((playing() === true) !== enabled) {
    if (typeof replay.toggleAutoplay !== 'function') {
      return {
        __tvmcpError: {
          code: 'CAPABILITY_UNAVAILABLE',
          message: 'This TradingView build has no way to start or stop autoplay',
        },
      };
    }
    try {
      player.toggleAutoplay();
    } catch (error) {
      return {
        __tvmcpError: {
          code: 'NOT_AVAILABLE',
          message: `TradingView refused to change autoplay: ${reasonOf(error)}`,
          hint: 'Check replay_status.',
        },
      };
    }
  }
  const startedAt = Date.now();
  await new Promise<void>((resolve) => {
    const look = (): void => {
      if ((playing() === true) === enabled || !running() || Date.now() - startedAt >= waitMs) {
        resolve();
      } else {
        setTimeout(look, 20);
      }
    };
    look();
  });
  const shown = playing();
  const delay = attempt(() => player.autoplayDelay());
  return {
    started: running(),
    autoplay: typeof shown === 'boolean' ? shown : null,
    delayMs: typeof delay === 'number' && Number.isFinite(delay) ? delay : null,
  };
}

// Leaves replay, or the replay mode TradingView keeps on without a running replay (after replay
// reached the end of the data, say): stops autoplay first while it plays, then calls
// leaveReplay({ skipConfirm: true }), which never asks in the "Leave replay" dialog, and waits, within
// waitMs, until replay is stopped and the mode off. Leaving saves the replay in the layout, unless it
// had reached its end. The main series keeps the bars of the replay, up to its point, for a moment
// after replay stopped (0.4 to 0.7 s seen, and longer at times), so when a replay point was left it
// then waits, within what is left of waitMs and 5 s at most, until the series holds a bar after that
// point: the live bars. ownRun is the start point of the run of replay the caller started (its
// getReplaySelectedDate), or null: when the replay running before the leave is that run, by the start
// point read right before the leave, what TradingView saved for it is cleared once replay is stopped,
// with updateReplaySessionState(null), as the "Start new" button of the "continue replay" dialog does.
// Any other replay, a replay whose start point TradingView does not tell, and a replay saved before
// keep what was saved. Answers what it did (LeaveOutcome). With nothing to leave it changes nothing.
// Replay TradingView does not tell about is NOT_AVAILABLE, a build without leaveReplay
// CAPABILITY_UNAVAILABLE, and a leave the app refuses NOT_AVAILABLE.
export async function leaveReplayViaApi(
  win: TvWindow,
  ownRun: number | null,
  waitMs: number,
): Promise<LeaveOutcome | PageErrorSentinel> {
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  if (typeof api?.replayApi !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no replay API of TradingView',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  const reasonOf = (error: unknown): string => {
    const message: unknown =
      typeof error === 'object' && error !== null
        ? (error as { message?: unknown }).message
        : undefined;
    return typeof message === 'string' && message !== '' ? message : String(error);
  };
  let given: unknown;
  try {
    given = await api.replayApi();
  } catch (error) {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: `TradingView did not give its replay API: ${reasonOf(error)}`,
        hint: 'Check app_health: the chart may still be loading.',
      },
    };
  }
  if (typeof given !== 'object' || given === null) {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: 'TradingView did not give its replay API: it answered no object',
        hint: 'Check app_health: the chart may still be loading.',
      },
    };
  }
  const replay = given as Partial<ReplayApiLike>;
  // A watched value, whose value() is read as a method of it.
  const watched = (get: () => unknown): unknown => {
    try {
      const value = get() as { value?: unknown } | null | undefined;
      return typeof value?.value === 'function'
        ? (value as { value(): unknown }).value()
        : undefined;
    } catch {
      return undefined;
    }
  };
  const started = (): unknown => watched(() => replay.isReplayStarted?.());
  const modeOn = (): boolean => watched(() => replay.isReplayToolbarVisible?.()) === true;
  const playing = (): boolean => watched(() => replay.isAutoplayStarted?.()) === true;
  const startedAt = Date.now();
  const left = (): number => Math.max(waitMs - (Date.now() - startedAt), 0);
  const waitFor = (done: () => boolean, ms: number): Promise<void> =>
    new Promise((resolve) => {
      const since = Date.now();
      const look = (): void => {
        if (done() || Date.now() - since >= ms) {
          resolve();
        } else {
          setTimeout(look, 20);
        }
      };
      look();
    });

  const before = started();
  if (typeof before !== 'boolean') {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: 'TradingView does not tell whether replay is running, so it was not left',
        hint: 'Check replay_status, or leave replay in TradingView itself.',
      },
    };
  }
  // The time of the last bar the main series of the active chart holds: null without bars, and
  // undefined when the chart does not tell.
  const lastBarTime = (): number | null | undefined => {
    try {
      const bars = api.activeChart?.()._chartWidget?.model().mainSeries().bars();
      if (bars === undefined) {
        return undefined;
      }
      const index = bars.lastIndex();
      const row: unknown = typeof index === 'number' ? bars.valueAt(index) : null;
      return Array.isArray(row) && typeof row[0] === 'number' ? row[0] : null;
    } catch {
      return undefined;
    }
  };
  // The replay point while replay runs, read before the leave clears it: the series holds the bars
  // up to it until the live bars come back.
  const shownDate = before ? watched(() => replay.currentDate?.()) : null;
  const replayPoint =
    typeof shownDate === 'number' && Number.isFinite(shownDate) ? shownDate : null;
  // Whether the replay about to be left is the run the caller started, by its start point, read
  // before the leave clears it.
  const point = watched(() => replay.getReplaySelectedDate?.());
  const own = before && typeof ownRun === 'number' && typeof point === 'number' && point === ownRun;
  let leaving = false;
  if (before || modeOn()) {
    if (typeof replay.leaveReplay !== 'function') {
      return {
        __tvmcpError: {
          code: 'CAPABILITY_UNAVAILABLE',
          message: 'This TradingView build has no way to leave replay without its dialog',
        },
      };
    }
    const leaver = replay as ReplayApiLike;
    if (before && playing() && typeof replay.toggleAutoplay === 'function') {
      try {
        leaver.toggleAutoplay();
      } catch {
        // Leaving stops autoplay as well.
      }
      await waitFor(() => !playing(), Math.min(left(), 1000));
    }
    try {
      leaver.leaveReplay({ skipConfirm: true });
    } catch (error) {
      return {
        __tvmcpError: {
          code: 'NOT_AVAILABLE',
          message: `TradingView refused to leave replay: ${reasonOf(error)}`,
          hint: 'Check replay_status.',
        },
      };
    }
    leaving = true;
    await waitFor(() => started() === false && !modeOn(), left());
  }
  const stopped = started() === false;
  let cleared: boolean | null = null;
  if (own) {
    cleared = false;
    try {
      const collection = api._chartWidgetCollection;
      if (
        stopped &&
        typeof collection?.replaySessionState === 'function' &&
        typeof collection.updateReplaySessionState === 'function'
      ) {
        const saved = collection.replaySessionState();
        if (saved !== null && saved !== undefined) {
          collection.updateReplaySessionState(null);
        }
        const after = collection.replaySessionState();
        cleared = after === null || after === undefined;
      }
    } catch {
      cleared = false;
    }
  }
  let liveBars: boolean | null = null;
  if (leaving && stopped && replayPoint !== null && lastBarTime() !== undefined) {
    const live = (): boolean => {
      const last = lastBarTime();
      return typeof last === 'number' && last > replayPoint;
    };
    await waitFor(live, Math.min(left(), 5000));
    liveBars = live();
  }
  return { left: leaving, stopped, cleared, liveBars };
}
