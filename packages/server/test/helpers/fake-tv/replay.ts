import type { SyntheticBar } from './synthetic-bars.js';

// Bar replay in a fake chart tab: the replay API of the app, the replay session state the chart
// widget collection saves in the layout, and the calls the tools must never make (reverse-engineering
// notes of Plan 3, section 4, and the web build). Values are synthetic.
//
// - TradingViewApi.replayApi() resolves the replay API, the same object on every call; a build may
//   not have it (withoutReplayApi), and it rejects while the chart API is not up (replayApiError).
// - Its watched values: isReplayAvailable() (state.replay.available), isReplayStarted(),
//   isAutoplayStarted(), isReplayToolbarVisible() (the replay mode, which shows the replay toolbar),
//   currentDate() (the time of the bar the replay point shows, in Unix seconds, null while it shows
//   none), getReplaySelectedDate() (the point replay was started or last reset at, which the manager
//   of the app keeps: unchanged by steps, null once replay stops) and position(), realizedPL() and
//   currency(), which stay null, as on TradingView Desktop.
// - autoplayDelay() is the time between two bars of autoplay, and autoplayDelayList() the nine
//   speeds of the app, from 10x (100 ms) to 0.1x (10 s). changeAutoplayDelay(ms) takes the nearest
//   speed, keeps it as a setting of the app (settings.setValue, ReplayAutoplayDelay) and restarts
//   autoplay while it runs.
// - replayTimingMode() is the property of the setting replay_timing_mode (state.replay.timingMode,
//   manual at first), which tells how the replay button of the toolbar starts a replay. Its
//   setValue keeps the setting (settings.setValue, replay_timing_mode).
// - The selects (selectDate(ms), selectFirstAvailableDate(), selectRandomDate()) record themselves,
//   set the timing mode to date, first_available_date or random, and turn the replay mode on when
//   it is off: a signed-out account gets the sign-in wall (dialog.signIn) and a layout with a saved
//   replay session the "continue replay" dialog (dialog.continueReplay), and then nothing starts.
//   selectMs later the point is chosen: nothing starts while replay is not available, and an
//   intraday chart on a plan without BAR_REPLAY_INTRADAY gets the paywall (dialog.paywall,
//   PAYWALL_BAR_REPLAY_INTRADAY). Otherwise replay starts at the last loaded bar before the time
//   (the app starts at the time less a second), the first bar replay can reach for
//   selectFirstAvailableDate (state.replay.depthIndex) and a bar halfway between that one and the
//   last bar for selectRandomDate, so that two fake windows agree. A time before the first bar
//   replay can reach starts there, with the notification of the app (not a dialog). The selected
//   point is the time of that bar. The promise resolves as replay starts, and currentDate shows the
//   point dateMs later. A select while replay runs moves the point, as a reset of the app does.
// - doStep() throws at once while replay is not started (the assert of the app). On the last bar
//   replay is finished: doStep stops replay and rejects with the text "Replay is finished". A
//   step error a test stages (state.replay.stepError) rejects with an Error stepMs later and leaves
//   replay running, and state.replay.stepHangs makes a step never settle. Otherwise the step
//   resolves stepMs later and currentDate shows the next bar dateMs after that.
// - toggleAutoplay() stops replay when it is finished, stops autoplay while it runs and starts it
//   otherwise, which throws while replay is not started. Autoplay does not move the point.
// - leaveReplay(options) records itself with its argument as given. While replay runs and is not
//   finished, without skipConfirm it opens the "Leave replay" dialog (dialog.leaveReplay) and changes
//   nothing. Otherwise it leaves: it saves the replay session state, turns the replay mode off,
//   stops replay and calls onLeave. stopReplay() leaves the same way as
//   leaveReplay({ skipConfirm: true }).
// - Every stop of replay, by leaving it or at the end of the data, stops autoplay and clears the
//   replay point, so that currentDate answers null, and the selected point, as _stopReplay of the
//   manager of the app does; the replay mode stays on until replay is left.
// - Leaving with a replay point saves the session state in the layout with
//   updateReplaySessionState of the chart widget collection, as the app does: { replayTime,
//   replayMode, charts } while the setting save_replay_session_state is on
//   (state.replay.saveSessionState) and replay had not finished, null otherwise.
//   _chartWidgetCollection.replaySessionState() answers it (state.replay.sessionState), and
//   updateReplaySessionState(state), whoever calls it, records itself and sets it. Either way the
//   layout counts as changed (state.layouts.unsaved).
// - The internal replay controller (_replayUIController of the replay API) answers
//   replayAvailability(), a Map from the id of the chart model of chart 0 (model().id()) to
//   state.replay.availability, and _replayManager.isReplayFinished().
// - What the tools must never call only records itself: buy, sell, closePosition and goToRealtime of
//   the replay API, and the export tradingService of the default webpack cache.

export interface FakeReplayOptions {
  // Leaves replayApi out of TradingViewApi, as a build without it.
  withoutReplayApi?: boolean;
  // The message replayApi() rejects with. Default: it resolves.
  replayApiError?: string;
  // How long a select takes to choose the point and start replay. Default 10 ms.
  selectMs?: number;
  // How long after a start or a step currentDate shows the new point. Default 10 ms.
  dateMs?: number;
  // How long a step takes to resolve. Default 5 ms.
  stepMs?: number;
  // Leaves the internal replay controller out of the replay API.
  withoutController?: boolean;
  // Leaves replaySessionState and updateReplaySessionState out of the chart widget collection.
  withoutSessionState?: boolean;
  // Leaves setValue out of the property of the timing mode, which then cannot be set back.
  withoutTimingModeSetter?: boolean;
}

// The replay session TradingView saves in the layout on leaving replay before its end.
export interface FakeReplaySessionState {
  replayTime: number;
  replayMode: string;
  charts: { symbol: string; interval: string; chartId: string }[];
}

// The live state of replay. Tests may assign to it, to stage a replay the user started, a saved
// replay session or an unavailable chart, for instance.
export interface FakeReplayState {
  available: boolean;
  // What replayAvailability() answers for chart 0.
  availability: { isAvailable: boolean; unavailabilityReason: string };
  // The replay mode, which shows the replay toolbar.
  modeOn: boolean;
  started: boolean;
  autoplay: boolean;
  // The replay point, an index into the loaded bars, and the one currentDate shows, which follows it
  // dateMs later; null for none.
  index: number | null;
  shownIndex: number | null;
  // The point replay was started or last reset at, in Unix seconds, which getReplaySelectedDate()
  // answers; null while replay is stopped.
  selectedPoint: number | null;
  delayMs: number;
  timingMode: string;
  sessionState: FakeReplaySessionState | null;
  saveSessionState: boolean;
  // The index of the first bar replay can reach.
  depthIndex: number;
  stepError: string | null;
  stepHangs: boolean;
}

export interface FakeReplayDeps {
  state: FakeReplayState;
  record: (name: string, args: readonly unknown[]) => void;
  signedIn: () => boolean;
  // The loaded bars of chart 0.
  bars: () => readonly SyntheticBar[];
  // What chart 0 shows, for the saved session state and the plan gate.
  chart: () => { symbol: string; interval: string };
  // Whether the plan has BAR_REPLAY_INTRADAY.
  planIntraday: boolean;
  // The id of the chart model of chart 0.
  modelId: string;
  markLayoutChanged: () => void;
  options?: FakeReplayOptions | undefined;
}

// A watched value as page code reads it.
export interface FakeWatched<T> {
  value(): T;
  subscribe(): void;
  unsubscribe(): void;
}

export interface FakeReplayApi {
  isReplayAvailable(): FakeWatched<boolean>;
  isReplayStarted(): FakeWatched<boolean>;
  isAutoplayStarted(): FakeWatched<boolean>;
  isReplayToolbarVisible(): FakeWatched<boolean>;
  currentDate(): FakeWatched<number | null>;
  getReplaySelectedDate(): FakeWatched<number | null>;
  position(): FakeWatched<null>;
  realizedPL(): FakeWatched<null>;
  currency(): FakeWatched<null>;
  autoplayDelay(): number;
  autoplayDelayList(): { label: string; description: string; value: number }[];
  changeAutoplayDelay(delay: unknown): void;
  replayTimingMode(): {
    value(): string;
    setValue?(value: unknown): void;
    subscribe(): void;
    unsubscribe(): void;
  };
  selectDate(ms: unknown): Promise<void>;
  selectFirstAvailableDate(): Promise<void>;
  selectRandomDate(): Promise<void>;
  doStep(): Promise<void>;
  toggleAutoplay(): void;
  leaveReplay(options?: unknown): void;
  stopReplay(): void;
  goToRealtime(): void;
  buy(quantity?: unknown): void;
  sell(quantity?: unknown): void;
  closePosition(): void;
  _replayUIController?: {
    replayAvailability(): Map<string, { isAvailable: boolean; unavailabilityReason: string }>;
    _replayManager: { isReplayFinished(): boolean };
  };
}

// The members of the chart widget collection that concern replay.
export interface FakeReplayCollection {
  replaySessionState?(): FakeReplaySessionState | null;
  updateReplaySessionState?(state: unknown): void;
}

export interface FakeReplay {
  // TradingViewApi.replayApi, none without it.
  readonly replayApi: (() => Promise<FakeReplayApi>) | undefined;
  readonly collection: FakeReplayCollection;
  readonly modules: Record<string, Record<string, unknown>>;
}

// The speeds of autoplay, as the app lists them.
export const AUTOPLAY_SPEEDS: readonly { label: string; value: number }[] = [
  { label: '10x', value: 100 },
  { label: '7x', value: 143 },
  { label: '5x', value: 200 },
  { label: '3x', value: 300 },
  { label: '1x', value: 1000 },
  { label: '0.5x', value: 2000 },
  { label: '0.3x', value: 3000 },
  { label: '0.2x', value: 5000 },
  { label: '0.1x', value: 10000 },
];

// The state replay starts from in a new fake window: available, off, at the speed of 1x.
export function initialReplayState(): FakeReplayState {
  return {
    available: true,
    availability: { isAvailable: true, unavailabilityReason: '' },
    modeOn: false,
    started: false,
    autoplay: false,
    index: null,
    shownIndex: null,
    selectedPoint: null,
    delayMs: 1000,
    timingMode: 'manual',
    sessionState: null,
    saveSessionState: true,
    depthIndex: 0,
    stepError: null,
    stepHangs: false,
  };
}

function watched<T>(read: () => T): FakeWatched<T> {
  return { value: read, subscribe: () => undefined, unsubscribe: () => undefined };
}

// Daily, weekly and monthly timeframes, which replay on every plan.
function isDailyOrLonger(interval: string): boolean {
  return /^\d*[DWM]$/.test(interval);
}

export function createFakeReplay(deps: FakeReplayDeps): FakeReplay {
  const { state, record } = deps;
  const options = deps.options ?? {};
  const selectMs = options.selectMs ?? 10;
  const dateMs = options.dateMs ?? 10;
  const stepMs = options.stepMs ?? 5;
  const lastIndex = (): number => deps.bars().length - 1;
  const timeAt = (index: number | null): number | null =>
    index === null ? null : (deps.bars()[index]?.[0] ?? null);
  const finished = (): boolean => state.index !== null && state.index >= lastIndex();

  const setSetting = (name: string, value: unknown): void => {
    record('settings.setValue', [name, value]);
  };
  const setTimingMode = (mode: string): void => {
    setSetting('replay_timing_mode', mode);
    state.timingMode = mode;
  };
  const showPointLater = (): void => {
    setTimeout(() => {
      state.shownIndex = state.index;
    }, dateMs);
  };
  // _stopReplay of the manager of the app: replay and autoplay stop, and the replay point and the
  // selected point go away.
  const stop = (): void => {
    state.started = false;
    state.autoplay = false;
    state.index = null;
    state.shownIndex = null;
    state.selectedPoint = null;
  };
  // updateReplaySessionState of the chart widget collection, which the app calls itself on leaving
  // replay, as page code may.
  const updateSessionState = (saved: unknown): void => {
    record('chartWidgetCollection.updateReplaySessionState', [saved]);
    state.sessionState = saved === null ? null : (saved as FakeReplaySessionState);
    deps.markLayoutChanged();
  };
  // _updateReplaySessionState of the app, on leaving replay.
  const saveSessionState = (): void => {
    const replayTime = timeAt(state.index);
    if (replayTime === null) {
      return;
    }
    const { symbol, interval } = deps.chart();
    updateSessionState(
      state.saveSessionState && !finished()
        ? {
            replayTime,
            replayMode: 'ActiveChart',
            charts: [{ symbol, interval, chartId: 'chart0' }],
          }
        : null,
    );
  };
  const leave = (onLeave: unknown): void => {
    saveSessionState();
    state.modeOn = false;
    stop();
    if (typeof onLeave === 'function') {
      (onLeave as () => void)();
    }
  };
  // requestCloseReplay of the app.
  const requestClose = (skipConfirm: boolean, onLeave: unknown): void => {
    if (state.started && !finished() && !skipConfirm) {
      record('dialog.leaveReplay', []);
      return;
    }
    leave(onLeave);
  };

  // What a select does, from turning the replay mode on to starting replay at the point `pick`
  // chooses among the loaded bars.
  const select = (pick: () => number): Promise<void> => {
    if (!state.modeOn) {
      if (!deps.signedIn()) {
        record('dialog.signIn', ['REGWALL_BAR_REPLY']);
        return Promise.resolve();
      }
      if (state.sessionState !== null) {
        record('dialog.continueReplay', []);
        return Promise.resolve();
      }
      state.modeOn = true;
    }
    return new Promise((resolve) => {
      setTimeout(() => {
        if (!state.available || !state.availability.isAvailable || lastIndex() < 0) {
          resolve();
          return;
        }
        if (!isDailyOrLonger(deps.chart().interval) && !deps.planIntraday) {
          record('dialog.paywall', ['PAYWALL_BAR_REPLAY_INTRADAY']);
          resolve();
          return;
        }
        state.index = pick();
        state.selectedPoint = timeAt(state.index);
        state.started = true;
        resolve();
        showPointLater();
      }, selectMs);
    });
  };

  const api: FakeReplayApi = {
    isReplayAvailable: () => watched(() => state.available),
    isReplayStarted: () => watched(() => state.started),
    isAutoplayStarted: () => watched(() => state.autoplay),
    isReplayToolbarVisible: () => watched(() => state.modeOn),
    currentDate: () => watched(() => timeAt(state.shownIndex)),
    getReplaySelectedDate: () => watched(() => state.selectedPoint),
    position: () => watched(() => null),
    realizedPL: () => watched(() => null),
    currency: () => watched(() => null),
    autoplayDelay: () => state.delayMs,
    autoplayDelayList: () =>
      AUTOPLAY_SPEEDS.map(({ label, value }) => ({
        label,
        description: `One bar every ${String(value)} ms`,
        value,
      })),
    changeAutoplayDelay(delay) {
      record('replayApi.changeAutoplayDelay', [delay]);
      const wanted = Number(delay);
      let nearest = AUTOPLAY_SPEEDS[0]?.value ?? 1000;
      for (const { value } of AUTOPLAY_SPEEDS) {
        if (Math.abs(value - wanted) < Math.abs(nearest - wanted)) {
          nearest = value;
        }
      }
      if (nearest !== state.delayMs) {
        state.delayMs = nearest;
        setSetting('ReplayAutoplayDelay', nearest);
      }
    },
    replayTimingMode: () => ({
      value: () => state.timingMode,
      ...(options.withoutTimingModeSetter === true
        ? {}
        : {
            setValue: (value: unknown) => {
              setTimingMode(String(value));
            },
          }),
      subscribe: () => undefined,
      unsubscribe: () => undefined,
    }),
    selectDate(ms) {
      record('replayApi.selectDate', [ms]);
      setTimingMode('date');
      const time = Math.floor(Number(ms) / 1000) - 1;
      return select(() => {
        const before = deps.bars().findLastIndex((bar) => bar[0] <= time);
        if (before < state.depthIndex) {
          record('notification.replayTimePointCorrected', []);
          return state.depthIndex;
        }
        return before;
      });
    },
    selectFirstAvailableDate() {
      record('replayApi.selectFirstAvailableDate', []);
      setTimingMode('first_available_date');
      return select(() => state.depthIndex);
    },
    selectRandomDate() {
      record('replayApi.selectRandomDate', []);
      setTimingMode('random');
      return select(() => state.depthIndex + Math.floor((lastIndex() - 1 - state.depthIndex) / 2));
    },
    doStep() {
      record('replayApi.doStep', []);
      if (!state.started) {
        throw new Error('Replay is not started');
      }
      if (finished()) {
        stop();
        // The app rejects with the text itself, not an Error.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        return Promise.reject('Replay is finished');
      }
      if (state.stepHangs) {
        return new Promise<void>(() => undefined);
      }
      const failure = state.stepError;
      return new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          if (failure !== null) {
            reject(new Error(failure));
            return;
          }
          state.index = (state.index ?? state.depthIndex) + 1;
          resolve();
          showPointLater();
        }, stepMs);
      });
    },
    toggleAutoplay() {
      record('replayApi.toggleAutoplay', []);
      if (finished()) {
        stop();
        return;
      }
      if (state.autoplay) {
        state.autoplay = false;
        return;
      }
      if (!state.started) {
        throw new Error('Replay is not started');
      }
      state.autoplay = true;
    },
    leaveReplay(given) {
      record('replayApi.leaveReplay', given === undefined ? [] : [given]);
      const { skipConfirm, onLeave } = (given ?? {}) as {
        skipConfirm?: unknown;
        onLeave?: unknown;
      };
      requestClose(skipConfirm === true, onLeave);
    },
    stopReplay() {
      record('replayApi.stopReplay', []);
      requestClose(true, undefined);
    },
    goToRealtime() {
      record('replayApi.goToRealtime', []);
    },
    buy(quantity) {
      record('replayApi.buy', [quantity]);
    },
    sell(quantity) {
      record('replayApi.sell', [quantity]);
    },
    closePosition() {
      record('replayApi.closePosition', []);
    },
    ...(options.withoutController === true
      ? {}
      : {
          _replayUIController: {
            replayAvailability: () => new Map([[deps.modelId, { ...state.availability }]]),
            _replayManager: { isReplayFinished: finished },
          },
        }),
  };

  return {
    replayApi:
      options.withoutReplayApi === true
        ? undefined
        : () =>
            options.replayApiError === undefined
              ? Promise.resolve(api)
              : Promise.reject(new Error(options.replayApiError)),
    collection:
      options.withoutSessionState === true
        ? {}
        : {
            replaySessionState: () =>
              state.sessionState === null ? null : structuredClone(state.sessionState),
            updateReplaySessionState: updateSessionState,
          },
    modules: {
      // Module IDs are arbitrary numbers, as in a production build.
      '73905': {
        tradingService: () => {
          record('tradingService', []);
          return {};
        },
      },
    },
  };
}
