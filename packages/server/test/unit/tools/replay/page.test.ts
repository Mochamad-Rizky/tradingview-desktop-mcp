import type { CdpSession } from '../../../../src/core/cdp/types.js';
import type { TvMcpError } from '../../../../src/core/errors.js';
import {
  createPageBridge,
  type PageBridge,
  type PageFunction,
} from '../../../../src/core/tv/page-bridge.js';
import {
  leaveReplayViaApi,
  readReplayState,
  setAutoplayViaApi,
  startReplayViaApi,
  stepReplayViaApi,
} from '../../../../src/tools/replay/page.js';
import {
  alreadyActiveError,
  autoplayRunningError,
  endOfHistoryError,
  intradayPlanError,
  intradayUnreadableError,
  noTimeframeError,
  notStartedError,
  savedSessionError,
  signedOutError,
  unknownStateError,
} from '../../../../src/tools/replay/mappers.js';
import type { JsonValue } from '../../../../src/utils/json.js';
import { failureOf } from '../../../helpers/failure-of.js';
import { createPageRuntime } from '../../../helpers/fake-cdp/runtime.js';
import { loadTvFixture, type TvStateFixture } from '../../../helpers/fake-tv/fixture.js';
import type { FakeReplayApi } from '../../../helpers/fake-tv/replay.js';
import { syntheticBars } from '../../../helpers/fake-tv/synthetic-bars.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTvOverrides,
  type FakeTvWindow,
} from '../../../helpers/fake-tv/window.js';

// The page functions of the replay tools, run the way the server runs them, as source text in a page
// through the real page bridge, and called directly on a second window built the same way, which is
// what the coverage of the module measures. The two answers must agree. Values are synthetic: 300
// daily bars, one a day from 2024-01-02.

const fixture = loadTvFixture();
const times = syntheticBars(fixture.bars).map(([time]) => time);
const LAST = times.length - 1;
const time = (index: number): number => times[index] ?? Number.NaN;
const SPEEDS = [
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
const WAIT_MS = 1000;
// For the waits that are meant to give up.
const SHORT_WAIT_MS = 60;

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
});

function bridgeTo(win: object): PageBridge {
  const runtime = createPageRuntime(win);
  disposers.push(() => {
    runtime.dispose();
  });
  const send = (method: string, params?: unknown): Promise<unknown> =>
    method === 'Runtime.evaluate'
      ? runtime.evaluate(params as Record<string, unknown>)
      : Promise.reject(new Error(`Unexpected command ${method}`));
  const session: CdpSession = {
    targetId: 'PAGE1',
    isClosed: false,
    send: send as CdpSession['send'],
    onClose: () => undefined,
    close: () => Promise.resolve(),
  };
  return createPageBridge(session, { timeoutMs: 5000 });
}

type Make = () => FakeTvWindow;

// A fake chart tab built from `from`, changed by `change` once it is built.
const chart =
  (
    change: (win: FakeTvWindow) => void = () => undefined,
    from: TvStateFixture = fixture,
    overrides: FakeTvOverrides = {},
  ): Make =>
  () => {
    const win = createFakeTvWindow(from, overrides);
    change(win);
    return win;
  };

// A fake chart tab whose replay API is changed by `change` before the page first gets it.
const withReplay = (
  change: (replay: FakeReplayApi, win: FakeTvWindow) => void,
  before: (win: FakeTvWindow) => void = () => undefined,
  overrides: FakeTvOverrides = {},
): Make =>
  chart(
    (win) => {
      before(win);
      const api = win.TradingViewApi;
      if (api?.replayApi === undefined) {
        return;
      }
      const original = api.replayApi.bind(api);
      let changed: Promise<FakeReplayApi> | undefined;
      api.replayApi = () =>
        (changed ??= original().then((replay) => {
          change(replay, win);
          return replay;
        }));
    },
    fixture,
    overrides,
  );

const replayOf = (win: object) => inspectFakeWindow(win).state.replay;

// A replay the user started at bar `index`.
const running =
  (index: number, also: Partial<ReturnType<typeof replayOf>> = {}) =>
  (win: FakeTvWindow): void => {
    Object.assign(replayOf(win), {
      modeOn: true,
      started: true,
      index,
      shownIndex: index,
      selectedPoint: time(index),
      ...also,
    });
  };

async function resultOf<A extends JsonValue[], R extends JsonValue | null>(
  fn: PageFunction<A, R>,
  args: A,
  make: Make,
): Promise<{ result: R; win: FakeTvWindow }> {
  const win = make();
  const result = await bridgeTo(win).evaluate(fn, args);
  const direct = await fn(make(), ...args);
  expect(direct).toEqual(result);
  return { result, win };
}

async function failureOfBoth<A extends JsonValue[], R extends JsonValue | null>(
  fn: PageFunction<A, R>,
  args: A,
  make: Make,
): Promise<{ error: TvMcpError; win: FakeTvWindow }> {
  const win = make();
  const error = await failureOf(bridgeTo(win).evaluate(fn, args));
  const direct = await fn(make(), ...args);
  expect(direct).toEqual({ __tvmcpError: error.toPayload() });
  return { error, win };
}

const calls = (win: object, name: string) => inspectFakeWindow(win).callsTo(name);
const callNames = (win: object) => inspectFakeWindow(win).calls.map(({ name }) => name);

// Every page function, with arguments it takes, for the checks every one of them shares.
const EVERY = [
  ['readReplayState', readReplayState, []],
  ['startReplayViaApi', startReplayViaApi, ['first', null, false, WAIT_MS]],
  ['stepReplayViaApi', stepReplayViaApi, [WAIT_MS]],
  ['setAutoplayViaApi', setAutoplayViaApi, [true, null, WAIT_MS]],
  ['leaveReplayViaApi', leaveReplayViaApi, [null, WAIT_MS]],
] as const;

describe('every page function', () => {
  test.each(EVERY)(
    '%s fails CAPABILITY_UNAVAILABLE on a page without the replay API',
    async (_name, fn, args) => {
      const { error } = await failureOfBoth(
        fn as PageFunction<JsonValue[], JsonValue>,
        [...args],
        chart(() => undefined, fixture, { replay: { withoutReplayApi: true } }),
      );

      expect(error.toPayload()).toEqual({
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no replay API of TradingView',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      });
    },
  );

  test.each(EVERY)(
    '%s fails NOT_AVAILABLE with the reason of TradingView when it does not give its replay API',
    async (_name, fn, args) => {
      const { error } = await failureOfBoth(
        fn as PageFunction<JsonValue[], JsonValue>,
        [...args],
        chart(() => undefined, fixture, {
          replay: { replayApiError: "replay api isn't available" },
        }),
      );

      expect(error.toPayload()).toEqual({
        code: 'NOT_AVAILABLE',
        message: "TradingView did not give its replay API: replay api isn't available",
        hint: 'Check app_health: the chart may still be loading.',
      });
    },
  );

  test.each(EVERY)(
    '%s fails NOT_AVAILABLE when the replay API is no object',
    async (_name, fn, args) => {
      const { error } = await failureOfBoth(
        fn as PageFunction<JsonValue[], JsonValue>,
        [...args],
        chart((win) => {
          const api = win.TradingViewApi;
          if (api !== undefined) {
            api.replayApi = () => Promise.resolve(null as unknown as FakeReplayApi);
          }
        }),
      );

      expect(error.toPayload()).toEqual({
        code: 'NOT_AVAILABLE',
        message: 'TradingView did not give its replay API: it answered no object',
        hint: 'Check app_health: the chart may still be loading.',
      });
    },
  );

  test.each(EVERY)(
    '%s gives the reason of a rejection that is no Error, or an Error without a message',
    async (_name, fn, args) => {
      const rejectingWith = (reason: unknown) =>
        chart((win) => {
          const api = win.TradingViewApi;
          if (api !== undefined) {
            api.replayApi = () =>
              Promise.resolve().then((): never => {
                throw reason;
              });
          }
        });

      const { error: text } = await failureOfBoth(
        fn as PageFunction<JsonValue[], JsonValue>,
        [...args],
        rejectingWith('The chart is not ready'),
      );
      const { error: blank } = await failureOfBoth(
        fn as PageFunction<JsonValue[], JsonValue>,
        [...args],
        rejectingWith(new Error('')),
      );

      expect(text.message).toBe('TradingView did not give its replay API: The chart is not ready');
      expect(blank.message).toBe('TradingView did not give its replay API: Error');
    },
  );
});

describe('readReplayState', () => {
  test('reads replay off on an available daily chart, the speeds, the timeframe and the loaded bars', async () => {
    const { result, win } = await resultOf(readReplayState, [], chart());

    expect(result).toEqual({
      signedIn: true,
      available: true,
      chartAvailable: true,
      unavailableReason: null,
      started: false,
      modeOn: false,
      finished: false,
      autoplay: false,
      date: null,
      selectedPoint: null,
      delayMs: 1000,
      speeds: SPEEDS,
      resolution: '1D',
      savedSession: false,
      history: { first: time(0), last: time(LAST) },
      position: null,
      realizedPL: null,
      currency: null,
    });
    // It reads, and calls nothing.
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('reads a running replay, its point and autoplay, and the end of the loaded bars', async () => {
    const { result } = await resultOf(
      readReplayState,
      [],
      chart(running(40, { autoplay: true, delayMs: 200 })),
    );
    const { result: atEnd } = await resultOf(readReplayState, [], chart(running(LAST)));

    expect(result).toMatchObject({
      started: true,
      modeOn: true,
      finished: false,
      autoplay: true,
      date: time(40),
      selectedPoint: time(40),
      delayMs: 200,
    });
    expect(atEnd).toMatchObject({ started: true, finished: true, date: time(LAST) });
  });

  test('reads why TradingView cannot replay the chart, a saved replay session and a signed-out account', async () => {
    const { result } = await resultOf(
      readReplayState,
      [],
      chart((win) => {
        Object.assign(replayOf(win), {
          available: false,
          availability: { isAvailable: false, unavailabilityReason: 'Range bars' },
          sessionState: { replayTime: time(5), replayMode: 'ActiveChart', charts: [] },
        });
        inspectFakeWindow(win).state.pineEditor.signedIn = false;
      }),
    );

    expect(result).toMatchObject({
      signedIn: false,
      available: false,
      chartAvailable: false,
      unavailableReason: 'Range bars',
      savedSession: true,
    });
  });

  test('takes the loaded bars from the earlier and the later of the time of a bar row and the time the chart reports for it', async () => {
    // The chart reports a daily bar as its day at 00:00 UTC, before the session start in its row.
    const { result } = await resultOf(
      readReplayState,
      [],
      chart(() => undefined, fixture, { sessionOffsetSeconds: 48_600 }),
    );

    expect(result).toMatchObject({ history: { first: time(0) - 48_600, last: time(LAST) } });
  });

  test('reads null for what a build does not have or does not tell', async () => {
    const { result } = await resultOf(
      readReplayState,
      [],
      withReplay(
        (replay) => {
          replay.isReplayStarted = () => {
            throw new Error('Not ready');
          };
          replay.autoplayDelayList = () => {
            throw new Error('Not ready');
          };
          replay.autoplayDelay = () => Number.NaN;
          Reflect.deleteProperty(replay, 'currentDate');
          Reflect.deleteProperty(replay, 'getReplaySelectedDate');
        },
        () => undefined,
        { replay: { withoutController: true, withoutSessionState: true } },
      ),
    );

    expect(result).toMatchObject({
      available: true,
      chartAvailable: null,
      unavailableReason: null,
      started: null,
      finished: null,
      date: null,
      selectedPoint: null,
      delayMs: null,
      speeds: [],
      savedSession: null,
    });
  });

  test('reads no timeframe, no loaded bars and no availability of a chart it cannot reach', async () => {
    const { result } = await resultOf(
      readReplayState,
      [],
      chart((win) => {
        const api = win.TradingViewApi;
        if (api !== undefined) {
          api.activeChart = () => {
            throw new Error('No active chart');
          };
        }
      }),
    );

    expect(result).toMatchObject({ resolution: null, history: null, chartAvailable: null });
  });

  test('takes the loaded bars from the times the chart reports when the bar rows cannot be read, and reads no saved replay that cannot be read', async () => {
    const { result } = await resultOf(
      readReplayState,
      [],
      chart(
        (win) => {
          const api = win.TradingViewApi;
          const bars = api?.activeChart()._chartWidget.model().mainSeries().bars();
          if (api?._chartWidgetCollection === undefined || bars === undefined) {
            return;
          }
          bars.valueAt = () => null;
          api._chartWidgetCollection.replaySessionState = () => {
            throw new Error('Not ready');
          };
        },
        fixture,
        { sessionOffsetSeconds: 48_600 },
      ),
    );

    expect(result).toMatchObject({
      history: { first: time(0) - 48_600, last: time(LAST) - 48_600 },
      savedSession: null,
    });
  });

  test('reads no loaded bars on a chart that has none', async () => {
    const { result } = await resultOf(
      readReplayState,
      [],
      chart((win) => {
        inspectFakeWindow(win).state.symbolInvalid = true;
      }),
    );

    expect(result).toMatchObject({ history: null });
  });

  test('keeps the speeds TradingView lists in full, and the trading values it gives as numbers or text', async () => {
    const { result } = await resultOf(
      readReplayState,
      [],
      withReplay((replay) => {
        replay.autoplayDelayList = () =>
          [
            { label: '1x', description: 'One a second', value: 1000 },
            { label: 2, description: '', value: 3 },
            null,
            { label: 'NaN', description: '', value: Number.NaN },
          ] as unknown as ReturnType<FakeReplayApi['autoplayDelayList']>;
        const watched = (value: unknown) => ({
          value: () => value,
          subscribe: () => undefined,
          unsubscribe: () => undefined,
        });
        replay.position = () => watched(5) as ReturnType<FakeReplayApi['position']>;
        replay.realizedPL = () => watched('12.5') as ReturnType<FakeReplayApi['realizedPL']>;
        replay.currency = () => watched('USD') as ReturnType<FakeReplayApi['currency']>;
      }),
    );
    const { result: unreadable } = await resultOf(
      readReplayState,
      [],
      withReplay((replay) => {
        replay.position = () =>
          ({ value: () => ({ qty: 1 }) }) as unknown as ReturnType<FakeReplayApi['position']>;
      }),
    );

    expect(result).toMatchObject({
      speeds: [{ label: '1x', value: 1000 }],
      position: 5,
      realizedPL: '12.5',
      currency: 'USD',
    });
    expect(unreadable).toMatchObject({ position: null });
  });
});

describe('startReplayViaApi', () => {
  test('selects the time in milliseconds, starts replay and sets the timing mode back', async () => {
    const { result, win } = await resultOf(
      startReplayViaApi,
      ['date', time(100) * 1000, false, WAIT_MS],
      chart(),
    );

    expect(result).toEqual({ ended: 'resolved', reason: null, timingModeKept: true });
    expect(calls(win, 'replayApi.selectDate')).toEqual([[time(100) * 1000]]);
    expect(replayOf(win)).toMatchObject({ started: true, index: 99, timingMode: 'manual' });
    expect(calls(win, 'settings.setValue')).toEqual([
      ['replay_timing_mode', 'date'],
      ['replay_timing_mode', 'manual'],
    ]);
  });

  test('starts at the first bar replay can reach, or at a random bar, with the selectors of TradingView', async () => {
    const { result: first, win: fromFirst } = await resultOf(
      startReplayViaApi,
      ['first', null, false, WAIT_MS],
      chart(),
    );
    const { result: random, win: fromRandom } = await resultOf(
      startReplayViaApi,
      ['random', null, false, WAIT_MS],
      chart(),
    );

    expect([first, random]).toEqual([
      { ended: 'resolved', reason: null, timingModeKept: true },
      { ended: 'resolved', reason: null, timingModeKept: true },
    ]);
    expect(callNames(fromFirst)).toContain('replayApi.selectFirstAvailableDate');
    expect(callNames(fromRandom)).toContain('replayApi.selectRandomDate');
  });

  test('answers how a select that rejects or throws ended, with the reason of TradingView', async () => {
    const { result: rejected } = await resultOf(
      startReplayViaApi,
      ['random', null, false, WAIT_MS],
      withReplay((replay) => {
        replay.selectRandomDate = () =>
          Promise.reject(new Error('Error getting the available data depth'));
      }),
    );
    const { result: thrown } = await resultOf(
      startReplayViaApi,
      ['first', null, false, WAIT_MS],
      withReplay((replay) => {
        replay.selectFirstAvailableDate = () => {
          throw new Error('Replay is not available');
        };
      }),
    );

    expect(rejected).toEqual({
      ended: 'rejected',
      reason: 'Error getting the available data depth',
      timingModeKept: true,
    });
    expect(thrown).toEqual({
      ended: 'rejected',
      reason: 'Replay is not available',
      timingModeKept: true,
    });
  });

  test('answers late for a select that does not end in time, and sets the timing mode back all the same', async () => {
    const { result, win } = await resultOf(
      startReplayViaApi,
      ['first', null, false, SHORT_WAIT_MS],
      chart(() => undefined, fixture, { replay: { selectMs: 400 } }),
    );

    expect(result).toEqual({ ended: 'late', reason: null, timingModeKept: true });
    expect(replayOf(win)).toMatchObject({ started: false, timingMode: 'manual' });
  });

  test('refuses before the select when the timing mode cannot be read or set back, so that the setting never stays changed', async () => {
    const refusal = {
      code: 'NOT_AVAILABLE',
      message:
        'The setting of TradingView for how its replay button starts a replay cannot be read and ' +
        'set back on this build, and starting replay would change it, so replay was not started',
      hint: 'Start replay in TradingView itself.',
    };
    const { error: fixed, win } = await failureOfBoth(
      startReplayViaApi,
      ['first', null, false, WAIT_MS],
      chart(() => undefined, fixture, { replay: { withoutTimingModeSetter: true } }),
    );
    const { error: unreadable } = await failureOfBoth(
      startReplayViaApi,
      ['first', null, false, WAIT_MS],
      withReplay((replay) => {
        replay.replayTimingMode = () => {
          throw new Error('No setting');
        };
      }),
    );
    const { error: blank } = await failureOfBoth(
      startReplayViaApi,
      ['first', null, false, WAIT_MS],
      withReplay((replay) => {
        replay.replayTimingMode = () =>
          ({
            value: () => undefined,
            setValue: () => undefined,
            subscribe: () => undefined,
            unsubscribe: () => undefined,
          }) as unknown as ReturnType<FakeReplayApi['replayTimingMode']>;
      }),
    );

    expect(fixed.toPayload()).toEqual(refusal);
    expect(unreadable.toPayload()).toEqual(refusal);
    expect(blank.toPayload()).toEqual(refusal);
    expect(callNames(win)).toEqual([]);
    expect(replayOf(win)).toMatchObject({ timingMode: 'manual', modeOn: false });
  });

  test('says when TradingView refuses to set the timing mode back', async () => {
    const { result } = await resultOf(
      startReplayViaApi,
      ['first', null, false, WAIT_MS],
      withReplay((replay, win) => {
        // A setter that refuses, on a property that follows the setting the select keeps.
        replay.replayTimingMode = () => ({
          value: () => replayOf(win).timingMode,
          setValue: () => {
            throw new Error('The setting is read-only');
          },
          subscribe: () => undefined,
          unsubscribe: () => undefined,
        });
      }),
    );

    expect(result).toEqual({ ended: 'resolved', reason: null, timingModeKept: false });
  });

  test('sets a timing mode other than manual back', async () => {
    const { result, win } = await resultOf(
      startReplayViaApi,
      ['random', null, false, WAIT_MS],
      chart((win) => {
        replayOf(win).timingMode = 'date';
      }),
    );

    expect(result).toEqual({ ended: 'resolved', reason: null, timingModeKept: true });
    expect(calls(win, 'settings.setValue')).toEqual([
      ['replay_timing_mode', 'random'],
      ['replay_timing_mode', 'date'],
    ]);
    expect(replayOf(win).timingMode).toBe('date');
  });

  test('refuses a running replay, or one TradingView does not tell about, and calls no select', async () => {
    const { error, win } = await failureOfBoth(
      startReplayViaApi,
      ['first', null, false, WAIT_MS],
      chart(running(40)),
    );
    const { error: unknown } = await failureOfBoth(
      startReplayViaApi,
      ['first', null, false, WAIT_MS],
      withReplay((replay) => {
        Reflect.deleteProperty(replay, 'isReplayStarted');
      }),
    );

    expect(error.toPayload()).toEqual({
      code: 'NOT_AVAILABLE',
      message: 'Replay is already running on the chart',
      hint:
        'Call replay_step to go on from where it is, or replay_stop and then replay_start to ' +
        'start again.',
    });
    expect(unknown.toPayload()).toEqual({
      code: 'NOT_AVAILABLE',
      message: 'TradingView does not tell whether replay is running, so it was not started',
      hint: 'Check replay_status, or start replay in TradingView itself.',
    });
    expect(callNames(win)).toEqual([]);
  });

  test('refuses a signed-out account with AUTH_REQUIRED before TradingView would show its sign-in wall', async () => {
    const { error, win } = await failureOfBoth(
      startReplayViaApi,
      ['first', null, false, WAIT_MS],
      chart((win) => {
        inspectFakeWindow(win).state.pineEditor.signedIn = false;
      }),
    );

    expect(error.toPayload()).toEqual({
      code: 'AUTH_REQUIRED',
      message: 'Bar replay needs a signed-in TradingView account',
      hint: 'Sign in to TradingView, then try again.',
    });
    expect(callNames(win)).toEqual([]);
  });

  test('refuses an intraday chart in the same turn as the select unless the plan includes intraday replay, before TradingView would open its paywall', async () => {
    const onFifteen = (win: FakeTvWindow): void => {
      inspectFakeWindow(win).state.resolution = '15';
    };
    const { error: gated, win } = await failureOfBoth(
      startReplayViaApi,
      ['first', null, false, WAIT_MS],
      chart(onFifteen),
    );
    const { error: unknown } = await failureOfBoth(
      startReplayViaApi,
      ['first', null, null, WAIT_MS],
      chart(onFifteen),
    );
    const { result, win: allowed } = await resultOf(
      startReplayViaApi,
      ['first', null, true, WAIT_MS],
      chart(onFifteen, {
        ...fixture,
        planConfigs: { ...fixture.planConfigs, BAR_REPLAY_INTRADAY: {} },
      }),
    );

    expect(gated.toPayload()).toEqual(intradayPlanError('15').toPayload());
    expect(unknown.toPayload()).toEqual(intradayUnreadableError('15').toPayload());
    expect(callNames(win)).toEqual([]);
    expect(result).toEqual({ ended: 'resolved', reason: null, timingModeKept: true });
    expect(replayOf(allowed).started).toBe(true);
    expect(callNames(allowed).filter((name) => name.startsWith('dialog.'))).toEqual([]);
  });

  test('refuses a chart whose timeframe it cannot read unless the plan includes intraday replay', async () => {
    const unreachable = chart((win) => {
      const api = win.TradingViewApi;
      if (api !== undefined) {
        api.activeChart = () => {
          throw new Error('No active chart');
        };
      }
    });
    const { error } = await failureOfBoth(
      startReplayViaApi,
      ['first', null, false, WAIT_MS],
      unreachable,
    );
    const { error: unknown } = await failureOfBoth(
      startReplayViaApi,
      ['first', null, null, WAIT_MS],
      unreachable,
    );

    expect(error.toPayload()).toEqual(noTimeframeError().toPayload());
    expect(unknown.toPayload()).toEqual(intradayUnreadableError(null).toPayload());
  });

  test('refuses a saved replay session, or a layout that does not tell about one, before the "continue replay" dialog', async () => {
    const { error, win } = await failureOfBoth(
      startReplayViaApi,
      ['first', null, false, WAIT_MS],
      chart((win) => {
        replayOf(win).sessionState = { replayTime: time(5), replayMode: 'ActiveChart', charts: [] };
      }),
    );
    const { error: unknown } = await failureOfBoth(
      startReplayViaApi,
      ['first', null, false, WAIT_MS],
      chart(() => undefined, fixture, { replay: { withoutSessionState: true } }),
    );
    const { error: unreadable } = await failureOfBoth(
      startReplayViaApi,
      ['first', null, false, WAIT_MS],
      chart((win) => {
        const collection = win.TradingViewApi?._chartWidgetCollection;
        if (collection !== undefined) {
          collection.replaySessionState = () => {
            throw new Error('Not ready');
          };
        }
      }),
    );
    expect(unreadable.message).toBe(unknown.message);

    expect(error.toPayload()).toEqual({
      code: 'NOT_AVAILABLE',
      message:
        'The layout holds a replay TradingView saved when it was left, so starting replay would ' +
        'open the "continue replay" dialog of TradingView',
      hint:
        'Nothing was started. The user continues or discards the saved replay in TradingView ' +
        'itself (its replay button asks); no tool clears it. Then try again.',
    });
    expect(unknown.message).toBe(
      'TradingView does not tell whether the layout holds a saved replay, which would open its ' +
        '"continue replay" dialog',
    );
    expect(callNames(win)).toEqual([]);
  });

  test('refuses a start it does not know, a time that is no number and a build without the select', async () => {
    const { error: start } = await failureOfBoth(
      startReplayViaApi,
      ['sideways', null, false, WAIT_MS],
      chart(),
    );
    const { error: noTime } = await failureOfBoth(
      startReplayViaApi,
      ['date', null, false, WAIT_MS],
      chart(),
    );
    const withoutSelect = (name: string) =>
      withReplay((replay) => {
        Reflect.deleteProperty(replay, name);
      });
    const { error: noRandom } = await failureOfBoth(
      startReplayViaApi,
      ['random', null, false, WAIT_MS],
      withoutSelect('selectRandomDate'),
    );
    const { error: noFirst } = await failureOfBoth(
      startReplayViaApi,
      ['first', null, false, WAIT_MS],
      withoutSelect('selectFirstAvailableDate'),
    );
    const { error: noDate } = await failureOfBoth(
      startReplayViaApi,
      ['date', time(100) * 1000, false, WAIT_MS],
      withoutSelect('selectDate'),
    );

    expect(start.code).toBe('INVALID_INPUT');
    expect(noTime.code).toBe('INVALID_INPUT');
    expect(noRandom.toPayload()).toEqual({
      code: 'CAPABILITY_UNAVAILABLE',
      message: 'This TradingView build has no way to start replay at a random bar',
    });
    expect(noFirst.message).toBe(
      'This TradingView build has no way to start replay at the first bar replay can reach',
    );
    expect(noDate.message).toBe('This TradingView build has no way to start replay at a date');
  });
});

describe('stepReplayViaApi', () => {
  test('steps once and answers once the replay date shows the next bar', async () => {
    const { result, win } = await resultOf(stepReplayViaApi, [WAIT_MS], chart(running(40)));

    expect(result).toEqual({ outcome: 'stepped', date: time(41), reason: null });
    expect(calls(win, 'replayApi.doStep')).toEqual([[]]);
  });

  test('answers ended for the step that reaches the end of the loaded bars, after which TradingView stops replay and keeps its toolbar', async () => {
    const { result, win } = await resultOf(stepReplayViaApi, [WAIT_MS], chart(running(LAST - 1)));

    // TradingView stops replay before it shows the last bar: no replay point is left.
    expect(result).toEqual({ outcome: 'ended', date: null, reason: null });
    expect(replayOf(win)).toMatchObject({ started: false, modeOn: true });
  });

  test('answers failed for a step during which replay was left, its toolbar closed', async () => {
    const { result } = await resultOf(
      stepReplayViaApi,
      [WAIT_MS],
      withReplay((replay, win) => {
        replay.doStep = () => {
          Object.assign(replayOf(win), { started: false, modeOn: false, shownIndex: null });
          return Promise.resolve();
        };
      }, running(40)),
    );

    expect(result).toEqual({
      outcome: 'failed',
      date: null,
      reason: 'Replay was left during the step',
    });
  });

  test('answers finished at the end of the loaded bars, where TradingView stops replay', async () => {
    const { result, win } = await resultOf(stepReplayViaApi, [WAIT_MS], chart(running(LAST)));

    expect(result).toEqual({ outcome: 'finished', date: time(LAST), reason: null });
    expect(replayOf(win).started).toBe(false);
  });

  test('answers failed with the reason of TradingView for a step that rejects or throws', async () => {
    const { result: rejected } = await resultOf(
      stepReplayViaApi,
      [WAIT_MS],
      chart(running(40, { stepError: 'Session error' })),
    );
    const { result: thrown } = await resultOf(
      stepReplayViaApi,
      [WAIT_MS],
      withReplay((replay) => {
        replay.doStep = () => {
          throw new Error('Not enough series to do replay step');
        };
      }, running(40)),
    );
    const { result: text } = await resultOf(
      stepReplayViaApi,
      [WAIT_MS],
      withReplay((replay) => {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        replay.doStep = () => Promise.reject('The session is closed');
      }, running(40)),
    );

    expect(rejected).toEqual({ outcome: 'failed', date: time(40), reason: 'Session error' });
    expect(thrown).toEqual({
      outcome: 'failed',
      date: time(40),
      reason: 'Not enough series to do replay step',
    });
    expect(text).toEqual({ outcome: 'failed', date: time(40), reason: 'The session is closed' });
  });

  test('answers late for a step that does not end in time, and unconfirmed for one whose date does not show in time', async () => {
    const { result: late } = await resultOf(
      stepReplayViaApi,
      [SHORT_WAIT_MS],
      chart(running(40, { stepHangs: true })),
    );
    const { result: unconfirmed } = await resultOf(
      stepReplayViaApi,
      [SHORT_WAIT_MS],
      chart(running(40), fixture, { replay: { dateMs: 400 } }),
    );

    expect(late).toEqual({ outcome: 'late', date: time(40), reason: null });
    expect(unconfirmed).toEqual({ outcome: 'unconfirmed', date: time(40), reason: null });
  });

  test('refuses NOT_AVAILABLE when replay is not running or plays on its own, and steps nothing', async () => {
    const { error: off, win } = await failureOfBoth(stepReplayViaApi, [WAIT_MS], chart());
    const { error: playing } = await failureOfBoth(
      stepReplayViaApi,
      [WAIT_MS],
      chart(running(40, { autoplay: true })),
    );

    expect(off.toPayload()).toEqual({
      code: 'NOT_AVAILABLE',
      message: 'Replay is not running on the chart',
      hint: 'Start it with replay_start first.',
    });
    expect(playing.toPayload()).toEqual({
      code: 'NOT_AVAILABLE',
      message: 'Replay is playing on its own (autoplay), so it cannot be stepped',
      hint: 'Stop autoplay with replay_autoplay and enabled: false, then step.',
    });
    expect(calls(win, 'replayApi.doStep')).toEqual([]);
  });

  test('steps from a point whose date has not shown yet, and reads no date from a watched value without one', async () => {
    const { result } = await resultOf(
      stepReplayViaApi,
      [WAIT_MS],
      chart(running(40, { shownIndex: null })),
    );
    const { result: finished } = await resultOf(
      stepReplayViaApi,
      [WAIT_MS],
      withReplay((replay) => {
        replay.currentDate = () =>
          ({ subscribe: () => undefined }) as unknown as ReturnType<FakeReplayApi['currentDate']>;
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        replay.doStep = () => Promise.reject('Replay is finished');
      }, running(40)),
    );
    const { result: failed } = await resultOf(
      stepReplayViaApi,
      [WAIT_MS],
      withReplay((replay) => {
        replay.currentDate = () => {
          throw new Error('Not ready');
        };
        replay.doStep = () => Promise.reject(new Error('Session error'));
      }, running(40)),
    );

    expect(result).toEqual({ outcome: 'stepped', date: time(41), reason: null });
    expect(finished).toEqual({ outcome: 'finished', date: null, reason: null });
    expect(failed).toEqual({ outcome: 'failed', date: null, reason: 'Session error' });
  });

  test('refuses a replay TradingView does not tell about as not running', async () => {
    const { error } = await failureOfBoth(
      stepReplayViaApi,
      [WAIT_MS],
      withReplay((replay) => {
        replay.isReplayStarted = () => {
          throw new Error('Not ready');
        };
      }, running(40)),
    );

    expect(error.message).toBe('Replay is not running on the chart');
  });

  test('fails CAPABILITY_UNAVAILABLE on a build without doStep', async () => {
    const { error } = await failureOfBoth(
      stepReplayViaApi,
      [WAIT_MS],
      withReplay((replay) => {
        Reflect.deleteProperty(replay, 'doStep');
      }, running(40)),
    );

    expect(error.toPayload()).toEqual({
      code: 'CAPABILITY_UNAVAILABLE',
      message: 'This TradingView build has no way to step a replay',
    });
  });
});

describe('setAutoplayViaApi', () => {
  test('sets the speed and starts autoplay', async () => {
    const { result, win } = await resultOf(
      setAutoplayViaApi,
      [true, 200, WAIT_MS],
      chart(running(40)),
    );

    expect(result).toEqual({ started: true, autoplay: true, delayMs: 200 });
    expect(callNames(win)).toEqual([
      'replayApi.changeAutoplayDelay',
      'settings.setValue',
      'replayApi.toggleAutoplay',
    ]);
  });

  test('changes neither the speed nor autoplay when both are as asked', async () => {
    const { result, win } = await resultOf(
      setAutoplayViaApi,
      [true, 1000, WAIT_MS],
      chart(running(40, { autoplay: true })),
    );

    expect(result).toEqual({ started: true, autoplay: true, delayMs: 1000 });
    expect(callNames(win)).toEqual([]);
  });

  test('stops autoplay', async () => {
    const { result, win } = await resultOf(
      setAutoplayViaApi,
      [false, null, WAIT_MS],
      chart(running(40, { autoplay: true })),
    );

    expect(result).toEqual({ started: true, autoplay: false, delayMs: 1000 });
    expect(calls(win, 'replayApi.toggleAutoplay')).toEqual([[]]);
  });

  test('refuses NOT_AVAILABLE when replay is not running, and to play a replay at the end of the loaded bars', async () => {
    const { error: off, win } = await failureOfBoth(
      setAutoplayViaApi,
      [true, null, WAIT_MS],
      chart(),
    );
    const { error: atEnd, win: ended } = await failureOfBoth(
      setAutoplayViaApi,
      [true, 200, WAIT_MS],
      chart(running(LAST)),
    );

    expect(off.message).toBe('Replay is not running on the chart');
    expect(atEnd.toPayload()).toEqual({
      code: 'NOT_AVAILABLE',
      message: 'Replay has reached the end of the loaded bars, so it cannot play on',
      hint: 'Call replay_stop to leave replay, and replay_start to replay again.',
    });
    expect(callNames(win)).toEqual([]);
    expect(callNames(ended)).toEqual([]);
  });

  test('answers what autoplay is when TradingView does not change it in time, and that replay ended', async () => {
    const { result: unchanged } = await resultOf(
      setAutoplayViaApi,
      [true, null, SHORT_WAIT_MS],
      withReplay((replay) => {
        replay.toggleAutoplay = () => undefined;
      }, running(40)),
    );
    // A build that does not tell that replay is at its end: TradingView ends replay instead.
    const { result: ended } = await resultOf(
      setAutoplayViaApi,
      [true, null, WAIT_MS],
      chart(running(LAST), fixture, { replay: { withoutController: true } }),
    );

    expect(unchanged).toEqual({ started: true, autoplay: false, delayMs: 1000 });
    expect(ended).toEqual({ started: false, autoplay: false, delayMs: 1000 });
  });

  test('reads null for an autoplay and a delay TradingView does not tell, and sets the speed it cannot compare', async () => {
    const { result, win } = await resultOf(
      setAutoplayViaApi,
      [false, 200, WAIT_MS],
      withReplay((replay) => {
        replay.isAutoplayStarted = () =>
          ({ subscribe: () => undefined }) as unknown as ReturnType<
            FakeReplayApi['isAutoplayStarted']
          >;
        replay.autoplayDelay = () => {
          throw new Error('Not ready');
        };
      }, running(40)),
    );

    expect(result).toEqual({ started: true, autoplay: null, delayMs: null });
    expect(calls(win, 'replayApi.changeAutoplayDelay')).toEqual([[200]]);
    expect(calls(win, 'replayApi.toggleAutoplay')).toEqual([]);
  });

  test('fails NOT_AVAILABLE with the reason of TradingView when it refuses a speed', async () => {
    const { error } = await failureOfBoth(
      setAutoplayViaApi,
      [true, 200, WAIT_MS],
      withReplay((replay) => {
        replay.changeAutoplayDelay = () => {
          throw new Error('Invalid autoplay delay');
        };
      }, running(40)),
    );

    expect(error.toPayload()).toEqual({
      code: 'NOT_AVAILABLE',
      message: 'TradingView refused to change the speed of autoplay: Invalid autoplay delay',
      hint: 'Check replay_status.',
    });
  });

  test('fails NOT_AVAILABLE with the reason of TradingView when it refuses the change, and CAPABILITY_UNAVAILABLE without the calls', async () => {
    const { error: refused } = await failureOfBoth(
      setAutoplayViaApi,
      [true, null, WAIT_MS],
      withReplay((replay) => {
        replay.toggleAutoplay = () => {
          throw new Error('Cannot start autoplay multiple times');
        };
      }, running(40)),
    );
    const { error: noToggle } = await failureOfBoth(
      setAutoplayViaApi,
      [true, null, WAIT_MS],
      withReplay((replay) => {
        Reflect.deleteProperty(replay, 'toggleAutoplay');
      }, running(40)),
    );
    const { error: noDelay } = await failureOfBoth(
      setAutoplayViaApi,
      [true, 200, WAIT_MS],
      withReplay((replay) => {
        Reflect.deleteProperty(replay, 'changeAutoplayDelay');
      }, running(40)),
    );

    expect(refused.toPayload()).toEqual({
      code: 'NOT_AVAILABLE',
      message: 'TradingView refused to change autoplay: Cannot start autoplay multiple times',
      hint: 'Check replay_status.',
    });
    expect(noToggle.toPayload()).toEqual({
      code: 'CAPABILITY_UNAVAILABLE',
      message: 'This TradingView build has no way to start or stop autoplay',
    });
    expect(noDelay.toPayload()).toEqual({
      code: 'CAPABILITY_UNAVAILABLE',
      message: 'This TradingView build has no way to change the speed of autoplay',
    });
  });
});

describe('leaveReplayViaApi', () => {
  test('stops autoplay first, leaves replay without the dialog and clears what TradingView saved for the replay the caller started', async () => {
    const { result, win } = await resultOf(
      leaveReplayViaApi,
      [time(40), WAIT_MS],
      chart(running(40, { autoplay: true })),
    );

    expect(result).toEqual({ left: true, stopped: true, cleared: true });
    // TradingView saves the replay as it leaves it, and the page function clears it then.
    expect(callNames(win)).toEqual([
      'replayApi.toggleAutoplay',
      'replayApi.leaveReplay',
      'chartWidgetCollection.updateReplaySessionState',
      'chartWidgetCollection.updateReplaySessionState',
    ]);
    expect(calls(win, 'replayApi.leaveReplay')).toEqual([[{ skipConfirm: true }]]);
    expect(calls(win, 'chartWidgetCollection.updateReplaySessionState')).toEqual([
      [expect.objectContaining({ replayTime: time(40) })],
      [null],
    ]);
    expect(replayOf(win)).toMatchObject({ started: false, modeOn: false, sessionState: null });
  });

  test('keeps what TradingView saved when the caller started no replay, or another one than this', async () => {
    const { result: none, win: noneWin } = await resultOf(
      leaveReplayViaApi,
      [null, WAIT_MS],
      chart(running(40)),
    );
    // The replay the caller started began at bar 5; this one began at bar 40.
    const { result: other, win: otherWin } = await resultOf(
      leaveReplayViaApi,
      [time(5), WAIT_MS],
      chart(running(40)),
    );
    // A replay whose start point TradingView does not tell is never taken for the caller's.
    const { result: unknown, win: unknownWin } = await resultOf(
      leaveReplayViaApi,
      [time(40), WAIT_MS],
      withReplay((replay) => {
        Reflect.deleteProperty(replay, 'getReplaySelectedDate');
      }, running(40)),
    );

    for (const [result, win] of [
      [none, noneWin],
      [other, otherWin],
      [unknown, unknownWin],
    ] as const) {
      expect(result).toEqual({ left: true, stopped: true, cleared: null });
      expect(calls(win, 'chartWidgetCollection.updateReplaySessionState')).toEqual([
        [expect.objectContaining({ replayTime: time(40) })],
      ]);
      expect(replayOf(win).sessionState).toMatchObject({ replayTime: time(40) });
    }
  });

  test('leaves nothing while replay is off, and clears nothing then, not even for the replay the caller started', async () => {
    const { result: off, win } = await resultOf(leaveReplayViaApi, [null, WAIT_MS], chart());
    const { result: saved, win: savedWin } = await resultOf(
      leaveReplayViaApi,
      [time(5), WAIT_MS],
      chart((win) => {
        replayOf(win).sessionState = { replayTime: time(5), replayMode: 'ActiveChart', charts: [] };
      }),
    );

    expect(off).toEqual({ left: false, stopped: true, cleared: null });
    expect(callNames(win)).toEqual([]);
    expect(saved).toEqual({ left: false, stopped: true, cleared: null });
    expect(callNames(savedWin)).toEqual([]);
    expect(replayOf(savedWin).sessionState).toMatchObject({ replayTime: time(5) });
  });

  test('closes the replay mode TradingView keeps on without a running replay, and clears nothing', async () => {
    const { result, win } = await resultOf(
      leaveReplayViaApi,
      [time(5), WAIT_MS],
      chart((win) => {
        replayOf(win).modeOn = true;
      }),
    );

    expect(result).toEqual({ left: true, stopped: true, cleared: null });
    expect(replayOf(win).modeOn).toBe(false);
    expect(calls(win, 'chartWidgetCollection.updateReplaySessionState')).toEqual([]);
  });

  test('answers stopped: false, and clears nothing, when replay does not stop in time', async () => {
    const { result, win } = await resultOf(
      leaveReplayViaApi,
      [time(40), SHORT_WAIT_MS],
      withReplay((replay) => {
        replay.leaveReplay = () => undefined;
      }, running(40)),
    );

    expect(result).toEqual({ left: true, stopped: false, cleared: false });
    expect(calls(win, 'chartWidgetCollection.updateReplaySessionState')).toEqual([]);
  });

  test('answers cleared: false when the layout does not let the saved replay be cleared', async () => {
    const { result } = await resultOf(
      leaveReplayViaApi,
      [time(40), WAIT_MS],
      chart(running(40), fixture, { replay: { withoutSessionState: true } }),
    );
    const { result: throwing } = await resultOf(
      leaveReplayViaApi,
      [time(40), WAIT_MS],
      chart((win) => {
        running(40)(win);
        const collection = win.TradingViewApi?._chartWidgetCollection;
        if (collection !== undefined) {
          collection.updateReplaySessionState = () => {
            throw new Error('The layout is read-only');
          };
        }
      }),
    );

    expect(result).toEqual({ left: true, stopped: true, cleared: false });
    expect(throwing).toEqual({ left: true, stopped: true, cleared: false });
  });

  test('clears nothing when TradingView saved nothing for the replay the caller started', async () => {
    const { result, win } = await resultOf(
      leaveReplayViaApi,
      [time(40), WAIT_MS],
      chart((win) => {
        running(40)(win);
        const collection = win.TradingViewApi?._chartWidgetCollection;
        if (collection !== undefined) {
          collection.replaySessionState = () => undefined as unknown as null;
        }
      }),
    );

    expect(result).toEqual({ left: true, stopped: true, cleared: true });
    // Only TradingView saved, as it left replay.
    expect(calls(win, 'chartWidgetCollection.updateReplaySessionState')).toEqual([
      [expect.objectContaining({ replayTime: time(40) })],
    ]);
  });

  test('reads a replay mode TradingView does not tell as off', async () => {
    const { result, win } = await resultOf(
      leaveReplayViaApi,
      [null, WAIT_MS],
      withReplay((replay) => {
        replay.isReplayToolbarVisible = () =>
          ({ subscribe: () => undefined }) as unknown as ReturnType<
            FakeReplayApi['isReplayToolbarVisible']
          >;
      }),
    );

    expect(result).toEqual({ left: false, stopped: true, cleared: null });
    expect(callNames(win)).toEqual([]);
  });

  test('refuses when TradingView does not tell whether replay runs, and fails on a build that cannot leave it', async () => {
    const { error: unknown } = await failureOfBoth(
      leaveReplayViaApi,
      [time(40), WAIT_MS],
      withReplay((replay) => {
        replay.isReplayStarted = () => {
          throw new Error('Not ready');
        };
      }),
    );
    const { error: noLeave } = await failureOfBoth(
      leaveReplayViaApi,
      [time(40), WAIT_MS],
      withReplay((replay) => {
        Reflect.deleteProperty(replay, 'leaveReplay');
      }, running(40)),
    );
    const { error: refused } = await failureOfBoth(
      leaveReplayViaApi,
      [time(40), WAIT_MS],
      withReplay((replay) => {
        replay.leaveReplay = () => {
          throw new Error('The replay toolbar is busy');
        };
      }, running(40)),
    );

    expect(unknown.toPayload()).toEqual({
      code: 'NOT_AVAILABLE',
      message: 'TradingView does not tell whether replay is running, so it was not left',
      hint: 'Check replay_status, or leave replay in TradingView itself.',
    });
    expect(noLeave.toPayload()).toEqual({
      code: 'CAPABILITY_UNAVAILABLE',
      message: 'This TradingView build has no way to leave replay without its dialog',
    });
    expect(refused.toPayload()).toEqual({
      code: 'NOT_AVAILABLE',
      message: 'TradingView refused to leave replay: The replay toolbar is busy',
      hint: 'Check replay_status.',
    });
  });
});

test('the refusals the page functions repeat are word for word those of the tools', async () => {
  const pageError = async (
    fn: PageFunction<JsonValue[], JsonValue>,
    args: JsonValue[],
    make: Make,
  ): Promise<unknown> => (await failureOfBoth(fn, args, make)).error.toPayload();
  const start = startReplayViaApi as PageFunction<JsonValue[], JsonValue>;
  const step = stepReplayViaApi as PageFunction<JsonValue[], JsonValue>;
  const autoplay = setAutoplayViaApi as PageFunction<JsonValue[], JsonValue>;
  const startArgs: JsonValue[] = ['first', null, false, WAIT_MS];

  expect(await pageError(start, startArgs, chart(running(40)))).toEqual(
    alreadyActiveError().toPayload(),
  );
  expect(
    await pageError(
      start,
      startArgs,
      withReplay((replay) => {
        Reflect.deleteProperty(replay, 'isReplayStarted');
      }),
    ),
  ).toEqual(unknownStateError().toPayload());
  expect(
    await pageError(
      start,
      startArgs,
      chart((win) => {
        inspectFakeWindow(win).state.pineEditor.signedIn = false;
      }),
    ),
  ).toEqual(signedOutError().toPayload());
  expect(
    await pageError(
      start,
      startArgs,
      chart((win) => {
        replayOf(win).sessionState = { replayTime: time(5), replayMode: 'ActiveChart', charts: [] };
      }),
    ),
  ).toEqual(savedSessionError(true).toPayload());
  expect(
    await pageError(
      start,
      startArgs,
      chart(() => undefined, fixture, { replay: { withoutSessionState: true } }),
    ),
  ).toEqual(savedSessionError(null).toPayload());
  expect(await pageError(step, [WAIT_MS], chart())).toEqual(notStartedError().toPayload());
  expect(await pageError(step, [WAIT_MS], chart(running(40, { autoplay: true })))).toEqual(
    autoplayRunningError().toPayload(),
  );
  expect(await pageError(autoplay, [true, null, WAIT_MS], chart())).toEqual(
    notStartedError().toPayload(),
  );
  expect(await pageError(autoplay, [true, null, WAIT_MS], chart(running(LAST)))).toEqual(
    endOfHistoryError().toPayload(),
  );
});
