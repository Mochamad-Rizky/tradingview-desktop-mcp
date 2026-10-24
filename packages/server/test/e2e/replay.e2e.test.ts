import type { TvWindow } from '../../src/core/tv/tv-window.js';
import type { JsonValue } from '../../src/utils/json.js';
import { isDailyOrLonger } from '../../src/tools/replay/mappers.js';
import { readReplayState, type ReplayReading } from '../../src/tools/replay/page.js';
import { pollUntil } from '../../src/utils/poll.js';
import { sleep } from '../../src/utils/timeout.js';
import { callTool } from '../helpers/mcp-client.js';
import {
  barDistance,
  callOk,
  describeFailure,
  e2eEnabled,
  HarnessError,
  observe,
  prepareChartChange,
  readChartState,
  readChartVisibility,
  restoreChartAndView,
  startE2eServer,
  type ChartChangePlan,
  type E2eServer,
  type ToolSuccess,
} from './setup.js';

// The replay tools against the real TradingView Desktop, on a daily chart: a chart on another
// timeframe is switched to 1D first. Replay moves the view of the chart (it shows the replay point,
// and leaving it shows the last bars), so the suite takes the chart snapshot of the chart suites
// before its first test and puts the chart and its exact view back after its last one. A replay of
// the user's, running or saved in the layout by TradingView, is never touched: the suite then skips
// every test. Each test starts replay, works on it and leaves it with replay_stop however it ended,
// and checks that nothing is left behind: no replay saved in the layout, the setting of how the
// replay button starts a replay and the speed of autoplay as they were (the tests never pass a
// speed). Dates and prices of the chart are compared without being printed.

interface ReplayStatus {
  available: boolean | null;
  reason: string | null;
  active: boolean | null;
  date: number | null;
  dateIso: string | null;
  autoplay: boolean | null;
  delayMs: number | null;
  speed: string | null;
  resolution: string | null;
  position: number | string | null;
  realizedPL: number | string | null;
  currency: string | null;
}

interface StartedReplay {
  active: boolean;
  date: number | null;
  dateIso: string | null;
  start: 'date' | 'first' | 'random';
  resolution: string | null;
}

interface SteppedReplay {
  date: number | null;
  dateIso: string | null;
  stepped: number;
  finished: boolean;
}

// The settings of replay a start could change: how the replay button of the app starts a replay
// (replayTimingMode, which the selects of the app change and the tool sets back) and the delay of
// autoplay (changeAutoplayDelay keeps it), compared in memory and never printed. Null for what the
// app does not tell. It only reads; replayApi() has the app make its replay API as its first use of
// replay does.
async function readReplaySettings(
  win: TvWindow,
): Promise<{ timingMode: string | null; autoplayDelay: number | null }> {
  try {
    const replay = (await win.TradingViewApi?.replayApi?.()) as
      | { replayTimingMode?: () => { value?: () => unknown }; autoplayDelay?: () => unknown }
      | undefined;
    const mode = replay?.replayTimingMode?.().value?.();
    const delay = replay?.autoplayDelay?.();
    return {
      timingMode: typeof mode === 'string' ? mode : null,
      autoplayDelay: typeof delay === 'number' ? delay : null,
    };
  } catch {
    return { timingMode: null, autoplayDelay: null };
  }
}

// Clears the replay TradingView saved in the layout on leaving a replay, with
// updateReplaySessionState(null), as the "Start new" button of its "continue replay" dialog does.
// Only for a replay of the suite's own that replay_stop did not clear: the suite runs only on a
// layout without a saved replay, so one found after its own replay is its own. Answers whether the
// layout holds none afterwards.
function clearOwnSavedReplay(win: TvWindow): boolean {
  const collection = win.TradingViewApi?._chartWidgetCollection as
    | { replaySessionState?: () => unknown; updateReplaySessionState?: (state: null) => void }
    | undefined;
  try {
    if (collection?.replaySessionState?.() != null) {
      collection.updateReplaySessionState?.(null);
    }
    return collection?.replaySessionState?.() == null;
  } catch {
    return false;
  }
}

// How many bars the main series of the active chart holds, as data_get_ohlcv reads them, and the
// time of the last one, compared in memory and never printed. It only reads.
function readSeriesBars(win: TvWindow): { size: number | null; lastTime: number | null } {
  try {
    const bars = win.TradingViewApi?.activeChart()._chartWidget?.model().mainSeries().bars();
    const size = bars?.size();
    const lastIndex = bars?.lastIndex();
    const last =
      bars === undefined || typeof lastIndex !== 'number' ? null : bars.valueAt(lastIndex);
    return {
      size: typeof size === 'number' ? size : null,
      lastTime: Array.isArray(last) && typeof last[0] === 'number' ? last[0] : null,
    };
  } catch {
    return { size: null, lastTime: null };
  }
}

// The code of a failed tool call, null for one that succeeded.
function codeOf(result: Awaited<ReturnType<typeof callTool>>): string | null {
  if (result.isError !== true) {
    return null;
  }
  const envelope = result.structuredContent as { error?: { code?: unknown } } | undefined;
  return typeof envelope?.error?.code === 'string' ? envelope.error.code : 'UNKNOWN';
}

describe.skipIf(!e2eEnabled())('the replay tools against TradingView Desktop', () => {
  let e2e: E2eServer | undefined;
  // The chart snapshot and its exact view, to put back after the last test.
  let plan: ChartChangePlan | undefined;
  let skipReason: string | undefined;
  let settings: { timingMode: string | null; autoplayDelay: number | null } | undefined;
  // How long after each replay_stop the chart showed its live bars again, the last bar of before the
  // replay or a later one, null when it did not: TradingView keeps the bars of the replay for a
  // moment after leaving it. replay_stop waits for the live bars after a running replay, so this is
  // about 0 then; after a replay that reached its end, whose last bar can take a second more to
  // show, it is about 1 s.
  const barsBackAfterStopMs: (number | null)[] = [];
  // How long after the bars were back the visible range last changed, after each replay_stop.
  const viewSettledAfterStopMs: number[] = [];
  // Whether a test may have left the replay it started running: from before its start until a
  // reading after its stop shows replay off.
  let ownReplayMayRun = false;

  async function reading(): Promise<ReplayReading> {
    const page = await server().ctx.connection.chartPage();
    return page.bridge.evaluate(readReplayState, []);
  }

  async function readSettings() {
    const page = await server().ctx.connection.chartPage();
    return page.bridge.evaluate(readReplaySettings, []);
  }

  function server(): E2eServer {
    if (e2e === undefined) {
      throw new Error('The server did not start');
    }
    return e2e;
  }

  beforeAll(async () => {
    e2e = await startE2eServer();
    const first = await reading();
    if (first.started !== false || first.modeOn === true) {
      skipReason =
        'A replay runs on the chart, or TradingView does not say: the replay of the user is never ' +
        'touched';
      return;
    }
    if (first.savedSession !== false) {
      skipReason =
        'The layout holds a replay TradingView saved when the user left it (or does not say), ' +
        'which replay_start refuses and the suite never clears';
      return;
    }
    plan = await prepareChartChange(e2e);
    if (plan.skipReason !== undefined) {
      skipReason = plan.skipReason;
      return;
    }
    if (!isDailyOrLonger(first.resolution)) {
      await callOk(e2e.client, 'chart_set_timeframe', { timeframe: '1D' });
    }
    const { data: status } = await callOk<ReplayStatus>(e2e.client, 'replay_status');
    if (status.available !== true) {
      skipReason = `TradingView cannot replay the chart (${status.reason ?? 'no reason given'})`;
      return;
    }
    settings = await readSettings();
  });

  beforeEach((context) => {
    if (skipReason !== undefined) {
      context.skip(skipReason);
    }
  });

  // The chart and its exact view go back after the last test, once replay is off: a test that ended
  // early may have left the replay of the suite running, which is left first. TradingView can still
  // move the view a moment after replay is left, so the range is read again a while later, and the
  // chart put back again while it is more than a bar away from where it was.
  afterAll(async () => {
    if (e2e === undefined) {
      return;
    }
    const failures: string[] = [];
    const attempts: number[] = [];
    const replayLeft = await leaveOwnReplay();
    if (plan?.snapshot !== undefined) {
      const snapshot = plan.snapshot;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        failures.splice(0, failures.length, ...(await restoreChartAndView(e2e, plan)));
        await sleep(1500);
        const range = (await readChartState(e2e.client)).visibleRange;
        const distance =
          range === null ? null : await barDistance(e2e.ctx, range, snapshot.visibleRange);
        attempts.push(distance === null ? -1 : Math.max(distance.from, distance.to));
        if (distance !== null && distance.from <= 1 && distance.to <= 1) {
          break;
        }
        if (attempt === 3) {
          failures.push('The visible range of the chart is not back within a bar of where it was');
        }
      }
    }
    observe('the chart put back after the replay tests', {
      attempts: attempts.length,
      barsAwayAfterEachAttempt: attempts,
      viewChangesAfterEachStop: viewSettledAfterStopMs,
    });
    await e2e.close();
    if (replayLeft.length + failures.length > 0) {
      throw new Error([...replayLeft, ...failures].join('; '));
    }
  });

  // replay_stop, tried a second time when the first try fails.
  async function stopReplay(): Promise<ToolSuccess<{ active: boolean }>> {
    const { client } = server();
    try {
      return await callOk<{ active: boolean }>(client, 'replay_stop');
    } catch {
      return callOk<{ active: boolean }>(client, 'replay_stop');
    }
  }

  // Leaves the replay of the suite when replay still runs, or its toolbar is open, after a test of
  // the suite that may have started one has not seen it off. Answers what it found, never a value of
  // the user.
  async function leaveOwnReplay(): Promise<string[]> {
    if (!ownReplayMayRun) {
      return [];
    }
    try {
      const now = await reading();
      if (now.started === false && now.modeOn !== true) {
        return [];
      }
      await stopReplay();
      ownReplayMayRun = false;
      return ['A test left the replay of the suite running, and the suite left it'];
    } catch (error) {
      return [`The suite could not check that replay is off (${describeFailure(error)})`];
    }
  }

  // Runs `work` on a replay, then leaves replay with replay_stop whatever it did, and checks what is
  // left: no replay running or saved, and the settings of replay as they were. A replay TradingView
  // saved that replay_stop did not clear is the suite's own, and is cleared, and the test fails. The
  // failure of `work` is the one thrown, with a failed check logged next to it. Should the test end
  // before that, by its timeout say, replay is left once it is over all the same.
  async function replayThenStop(work: () => Promise<void>): Promise<void> {
    const { client } = server();
    onTestFinished(async () => {
      const left = await leaveOwnReplay();
      if (left.length > 0) {
        throw new HarnessError(left.join('; '));
      }
    });
    // The time of the last bar the chart shows, compared in memory and never printed; undefined
    // when it shows none.
    const lastBarTime = async (): Promise<number | undefined> => {
      const result = await callTool(client, 'data_get_ohlcv', { count: 1 });
      const bars = (
        result.structuredContent as { data?: { bars?: { time: number }[] } } | undefined
      )?.data?.bars;
      return result.isError === true ? undefined : bars?.at(-1)?.time;
    };
    const liveLast = await lastBarTime();
    let failure: unknown;
    let failed = false;
    ownReplayMayRun = true;
    try {
      await work();
    } catch (error) {
      failure = error;
      failed = true;
    }
    const problems: string[] = [];
    try {
      const stop = await stopReplay();
      if (stop.data.active) {
        problems.push('replay_stop did not report replay off');
      }
      if (stop.warnings.length > 0) {
        problems.push(`replay_stop warned: ${stop.warnings.join(' ')}`);
      }
      // The chart shows its live bars again once replay is left: the last bar of before the replay,
      // or a later one, and not a bar of the replay, which the series keeps for a moment.
      const back = await pollUntil(
        lastBarTime,
        (time) => time !== undefined && (liveLast === undefined || time >= liveLast),
        { intervalMs: 250, timeoutMs: 20_000 },
      );
      barsBackAfterStopMs.push(back.satisfied ? back.waitedMs : null);
      if (!back.satisfied) {
        problems.push('the chart did not show its live bars again 20 s after replay_stop');
      }
      // How long TradingView keeps moving the view after replay is left: until the visible range
      // has stayed the same for 1.5 s.
      const settledAt = performance.now();
      let last = JSON.stringify((await readChartState(client)).visibleRange);
      let lastChange = performance.now();
      while (performance.now() - lastChange < 1500 && performance.now() - settledAt < 10_000) {
        await sleep(250);
        const now = JSON.stringify((await readChartState(client)).visibleRange);
        if (now !== last) {
          last = now;
          lastChange = performance.now();
        }
      }
      viewSettledAfterStopMs.push(Math.round(lastChange - settledAt));
    } catch (error) {
      problems.push(describeFailure(error));
    }
    try {
      const after = await reading();
      if (after.started !== false || after.modeOn === true) {
        problems.push('replay is still running or its toolbar is open after replay_stop');
      } else {
        ownReplayMayRun = false;
      }
      if (after.savedSession !== false) {
        const page = await server().ctx.connection.chartPage();
        const cleared = await page.bridge.evaluate(clearOwnSavedReplay, []);
        problems.push(
          'TradingView kept the replay of the test saved in the layout after replay_stop ' +
            `(${cleared ? 'cleared by the suite' : 'the suite could not clear it: check the replay button'})`,
        );
      }
      const now = await readSettings();
      if (now.timingMode !== settings?.timingMode) {
        problems.push('the setting of how the replay button starts a replay changed');
      }
      if (now.autoplayDelay !== settings?.autoplayDelay) {
        problems.push('the speed of autoplay changed');
      }
    } catch (error) {
      problems.push(describeFailure(error));
    }
    if (failed) {
      if (problems.length > 0) {
        console.error(
          `The replay test left something behind after it failed: ${problems.join('; ')}`,
        );
      }
      throw failure;
    }
    if (problems.length > 0) {
      throw new HarnessError(`The replay test left something behind: ${problems.join('; ')}`);
    }
  }

  async function bars(count: number): Promise<{ time: number; close: number }[]> {
    return (
      await callOk<{ bars: { time: number; close: number }[] }>(server().client, 'data_get_ohlcv', {
        count,
      })
    ).data.bars;
  }

  test('reports replay as off and available on a daily chart', async () => {
    const { client, ctx } = server();
    const { data, warnings } = await callOk<ReplayStatus>(client, 'replay_status');
    expect(data.active).toBe(false);
    expect(data.available).toBe(true);
    expect(data.date).toBeNull();
    expect(warnings.length === 0, 'replay_status gives no warning').toBe(true);
    const state = await readChartState(client);
    expect(isDailyOrLonger(state.resolution)).toBe(true);
    observe('replay status while off', {
      available: data.available,
      reason: data.reason,
      autoplay: data.autoplay,
      speedLabelled: data.speed !== null,
      delayIsNumber: typeof data.delayMs === 'number',
      paperTrading: {
        position: data.position === null ? 'null' : typeof data.position,
        realizedPL: data.realizedPL === null ? 'null' : typeof data.realizedPL,
        currency: data.currency === null ? 'null' : typeof data.currency,
      },
      chartVisibility: await readChartVisibility(ctx),
    });
  });

  test('starts at a date, steps, plays and stops, and leaves nothing behind', async () => {
    const { client } = server();
    const loaded = await bars(120);
    expect(loaded.length).toBeGreaterThanOrEqual(80);
    const startBar = loaded[loaded.length - 60];
    if (startBar === undefined) {
      throw new Error('The chart has too few bars');
    }
    const facts: Record<string, JsonValue> = {};
    await replayThenStop(async () => {
      const startedAt = performance.now();
      const start = await callOk<StartedReplay>(client, 'replay_start', { date: startBar.time });
      facts.startMs = Math.round(performance.now() - startedAt);
      expect(start.data.active).toBe(true);
      expect(start.data.start).toBe('date');
      expect(start.warnings.length === 0, 'replay_start gives no warning').toBe(true);
      expect(typeof start.data.date).toBe('number');
      const ready = await reading();
      facts.selectedPointAtReadiness =
        ready.selectedPoint === null ? 'null' : Number.isFinite(ready.selectedPoint);
      facts.dateRelativeToStartBar = {
        // Relations only: how far apart they are would tell the session of the user's symbol.
        dateBeforeStartBar: start.data.date !== null && start.data.date < startBar.time,
        dateIsDayStart: start.data.date !== null && start.data.date % 86_400 === 0,
        selectedPointEqualsDate: ready.selectedPoint === start.data.date,
      };

      const status = await callOk<ReplayStatus>(client, 'replay_status');
      expect(status.data.active).toBe(true);
      expect(status.data.autoplay).toBe(false);
      expect(status.data.date === start.data.date, 'replay_status reports the replay date').toBe(
        true,
      );
      // What data_get_ohlcv answers during replay, read for a while, since the replay session
      // sends its bars after the start; and what the main series holds meanwhile.
      const page = await server().ctx.connection.chartPage();
      const seriesAtStart = await page.bridge.evaluate(readSeriesBars, []);
      const during = await pollUntil(
        () => callTool(client, 'data_get_ohlcv', { count: 5 }),
        (result) => result.isError !== true,
        { intervalMs: 250, timeoutMs: 10_000 },
      );
      const seriesLater = await page.bridge.evaluate(readSeriesBars, []);
      const duringBars =
        (during.last.structuredContent as { data?: { bars?: { time: number }[] } } | undefined)
          ?.data?.bars ?? [];
      const lastDuring = duringBars.at(-1);
      facts.ohlcvDuringReplay = {
        ok: during.satisfied,
        waitedMs: during.waitedMs,
        code: codeOf(during.last),
        seriesBarsAtStart: seriesAtStart.size,
        seriesBarsLater: seriesLater.size,
        lastBarAtOrBeforeDate:
          lastDuring === undefined || start.data.date === null
            ? null
            : lastDuring.time <= start.data.date,
        lastBarIsTheBarBeforeTheStart:
          lastDuring === undefined ? null : lastDuring.time === loaded[loaded.length - 61]?.time,
        lastBarIsTheStartBar: lastDuring === undefined ? null : lastDuring.time === startBar.time,
      };

      const stepStarted = performance.now();
      const step = await callOk<SteppedReplay>(client, 'replay_step', { bars: 3 });
      facts.threeStepsMs = Math.round(performance.now() - stepStarted);
      expect(step.data.stepped).toBe(3);
      expect(step.data.finished).toBe(false);
      expect(step.warnings.length === 0, 'replay_step gives no warning').toBe(true);
      expect(
        step.data.date !== null && start.data.date !== null && step.data.date > start.data.date,
        'the replay date moved on',
      ).toBe(true);
      const stepped = await reading();
      facts.selectedPointUnchangedBySteps = stepped.selectedPoint === ready.selectedPoint;
      const afterSteps = await callTool(client, 'data_get_ohlcv', { count: 1 });
      const afterStep = (
        afterSteps.structuredContent as { data?: { bars?: { time: number }[] } } | undefined
      )?.data?.bars?.at(-1);
      facts.ohlcvAfterSteps = {
        code: codeOf(afterSteps),
        lastBarIndexFromTheStart:
          afterStep === undefined
            ? null
            : loaded.findIndex(({ time }) => time === afterStep.time) - (loaded.length - 60),
        replayDateIsDayStart: step.data.date !== null && step.data.date % 86_400 === 0,
      };

      const on = await callOk<{ autoplay: boolean; delayMs: number | null; speed: string | null }>(
        client,
        'replay_autoplay',
        { enabled: true },
      );
      expect(on.data.autoplay).toBe(true);
      expect(on.data.delayMs).toBe(settings?.autoplayDelay ?? null);
      const delay = on.data.delayMs ?? 1000;
      const moved = await pollUntil(
        () => callOk<ReplayStatus>(client, 'replay_status'),
        ({ data }) => data.date !== null && step.data.date !== null && data.date > step.data.date,
        { intervalMs: 250, timeoutMs: Math.min(delay * 3 + 1000, 12_000) },
      );
      facts.autoplayMovedWithin = moved.satisfied ? Math.round(moved.waitedMs) : null;
      const off = await callOk<{ autoplay: boolean }>(client, 'replay_autoplay', {
        enabled: false,
      });
      expect(off.data.autoplay).toBe(false);
      const stopped = await callOk<ReplayStatus>(client, 'replay_status');
      expect(stopped.data.active === true || moved.last.data.active === false).toBe(true);
      expect(stopped.data.autoplay).toBe(false);
    });
    const after = await reading();
    facts.selectedPointAfterStop =
      after.selectedPoint === null ? 'null' : typeof after.selectedPoint;
    facts.savedSessionAfterStop = after.savedSession;
    observe('a replay started at a date', facts);
  });

  test('a second replay_start is accepted after the stop', async () => {
    const { client } = server();
    await replayThenStop(async () => {
      const start = await callOk<StartedReplay>(client, 'replay_start', {});
      expect(start.data.active).toBe(true);
      expect(start.data.start).toBe('random');
      const ready = await reading();
      observe('a replay started at a random bar', {
        dateReported: start.data.date !== null,
        selectedPointAtReadiness:
          ready.selectedPoint === null ? 'null' : Number.isFinite(ready.selectedPoint),
        warnings: start.warnings.length,
      });
    });
  });

  test('a replay stepped to its end stops itself, and replay_stop leaves nothing saved', async () => {
    const loaded = await bars(5);
    const near = loaded[loaded.length - 3];
    if (near === undefined) {
      throw new Error('The chart has too few bars');
    }
    const facts: Record<string, JsonValue> = {};
    try {
      await stepToTheEnd(near.time, loaded.at(-1)?.time, facts);
    } finally {
      const after = await reading();
      facts.savedSessionAfterStop = after.savedSession;
      facts.barsBackAfterEachStopMs = barsBackAfterStopMs;
      observe('a replay stepped to its end', facts);
    }
  });

  // Starts replay at `start`, steps on past the last bar (lastBar) and stops, recording into facts
  // what TradingView did at the end.
  async function stepToTheEnd(
    start: number,
    lastBar: number | undefined,
    facts: Record<string, JsonValue>,
  ): Promise<void> {
    const { client } = server();
    await replayThenStop(async () => {
      await callOk<StartedReplay>(client, 'replay_start', { date: start });
      const stepStarted = performance.now();
      const step = await callOk<SteppedReplay>(client, 'replay_step', { bars: 10 });
      facts.stepAtTheEnd = {
        ms: Math.round(performance.now() - stepStarted),
        stepped: step.data.stepped,
        finished: step.data.finished,
        dateReported: step.data.date !== null,
        dateIsTheLastBar: step.data.date === lastBar,
        warnings: step.warnings,
      };
      const end = await reading();
      facts.stepsToTheEnd = step.data.stepped;
      facts.atTheEnd = {
        started: end.started,
        modeOn: end.modeOn,
        finished: end.finished,
        selectedPoint: end.selectedPoint === null ? 'null' : typeof end.selectedPoint,
        savedSession: end.savedSession,
      };
      const status = await callOk<ReplayStatus>(client, 'replay_status');
      facts.statusAtTheEnd = { active: status.data.active, autoplay: status.data.autoplay };
      expect(step.data.finished).toBe(true);
      expect(step.data.stepped).toBeLessThan(10);
    });
  }
});
