import { setTimeout as delay } from 'node:timers/promises';
import { loadTvFixture, type TvStateFixture } from '../../helpers/fake-tv/fixture.js';
import type { FakeReplayApi } from '../../helpers/fake-tv/replay.js';
import { syntheticBars } from '../../helpers/fake-tv/synthetic-bars.js';
import type { FakeWebpackRequire } from '../../helpers/fake-tv/webpack.js';
import {
  CHART_MODEL_ID,
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTvOverrides,
  type FakeTvWindow,
} from '../../helpers/fake-tv/window.js';

// Bar replay in the fake chart tab (replay.ts), checked against what the reverse-engineering notes of
// Plan 3 (section 4) and the web build record for the app. Values are synthetic.

const fixture = loadTvFixture();
const times = syntheticBars(fixture.bars).map(([time]) => time);
const LAST = times.length - 1;
// An intraday chart, and a plan that replays it.
const intraday: TvStateFixture = { ...fixture, resolution: '15' };
const intradayPlan: TvStateFixture = {
  ...intraday,
  planConfigs: { ...fixture.planConfigs, BAR_REPLAY_INTRADAY: {} },
};

function windowWith(from: TvStateFixture = fixture, overrides: FakeTvOverrides = {}): FakeTvWindow {
  return createFakeTvWindow(from, overrides);
}

async function replayOf(win: FakeTvWindow): Promise<FakeReplayApi> {
  const api = win.TradingViewApi;
  if (api?.replayApi === undefined) {
    throw new Error('The fake window has no replay API');
  }
  return api.replayApi();
}

const stateOf = (win: FakeTvWindow) => inspectFakeWindow(win).state.replay;
const calls = (win: FakeTvWindow, name: string) => inspectFakeWindow(win).callsTo(name);
const dialogs = (win: FakeTvWindow) =>
  inspectFakeWindow(win)
    .calls.map(({ name }) => name)
    .filter((name) => name.startsWith('dialog.'));

// The exports of the default webpack cache, by name.
let probes = 0;
function exportsOf(win: FakeTvWindow): Record<string, unknown> {
  let handed: FakeWebpackRequire | undefined;
  probes += 1;
  (win.webpackChunktradingview as { push(chunk: unknown): unknown }).push([
    [`replay${String(probes)}`],
    {},
    (given: FakeWebpackRequire) => (handed = given),
  ]);
  const found: Record<string, unknown> = {};
  for (const record of Object.values(handed?.c ?? {})) {
    Object.assign(found, record.exports);
  }
  return found;
}

// A replay running at bar `index`, as the user would have started it.
function running(win: FakeTvWindow, index: number): void {
  Object.assign(stateOf(win), { modeOn: true, started: true, index, shownIndex: index });
}

describe('the replay API', () => {
  test('replayApi resolves the same object every time, with replay off, available and at 1x', async () => {
    const win = windowWith();
    const replay = await replayOf(win);

    expect(await replayOf(win)).toBe(replay);
    expect(replay.isReplayAvailable().value()).toBe(true);
    expect(replay.isReplayStarted().value()).toBe(false);
    expect(replay.isAutoplayStarted().value()).toBe(false);
    expect(replay.isReplayToolbarVisible().value()).toBe(false);
    expect(replay.currentDate().value()).toBeNull();
    expect([
      replay.position().value(),
      replay.realizedPL().value(),
      replay.currency().value(),
    ]).toEqual([null, null, null]);
    expect(replay.autoplayDelay()).toBe(1000);
    expect(replay.replayTimingMode().value()).toBe('manual');
    expect(replay.autoplayDelayList().map(({ label, value }) => [label, value])).toEqual([
      ['10x', 100],
      ['7x', 143],
      ['5x', 200],
      ['3x', 300],
      ['1x', 1000],
      ['0.5x', 2000],
      ['0.3x', 3000],
      ['0.2x', 5000],
      ['0.1x', 10000],
    ]);
    // Reads are not recorded.
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('a build may lack the replay API, and replayApi rejects while the chart API is not up', async () => {
    expect(
      windowWith(fixture, { replay: { withoutReplayApi: true } }).TradingViewApi,
    ).not.toHaveProperty('replayApi');
    await expect(
      replayOf(windowWith(fixture, { replay: { replayApiError: "replay api isn't available" } })),
    ).rejects.toThrow("replay api isn't available");
  });

  test('the internal controller answers the availability of chart 0 by the id of its chart model', async () => {
    const win = windowWith();
    const replay = await replayOf(win);
    const modelId = win.TradingViewApi?.activeChart()._chartWidget.model().id?.();

    expect(modelId).toBe(CHART_MODEL_ID);
    expect([...(replay._replayUIController?.replayAvailability() ?? [])]).toEqual([
      [CHART_MODEL_ID, { isAvailable: true, unavailabilityReason: '' }],
    ]);
    stateOf(win).availability = { isAvailable: false, unavailabilityReason: 'Range bars' };
    expect(replay._replayUIController?.replayAvailability().get(CHART_MODEL_ID)).toEqual({
      isAvailable: false,
      unavailabilityReason: 'Range bars',
    });
    expect(replay._replayUIController?._replayManager.isReplayFinished()).toBe(false);
    expect(
      (await replayOf(windowWith(fixture, { replay: { withoutController: true } })))
        ._replayUIController,
    ).toBe(undefined);
  });
});

describe('starting replay', () => {
  test('selectDate keeps the timing mode date, turns the replay mode on and starts at the bar before the time, whose date shows later', async () => {
    const win = windowWith(fixture, { replay: { selectMs: 20, dateMs: 40 } });
    const replay = await replayOf(win);

    const starting = replay.selectDate((times[100] ?? 0) * 1000);
    expect(replay.replayTimingMode().value()).toBe('date');
    expect(replay.isReplayToolbarVisible().value()).toBe(true);
    expect(replay.isReplayStarted().value()).toBe(false);
    await starting;

    expect(replay.isReplayStarted().value()).toBe(true);
    expect(stateOf(win).index).toBe(99);
    expect(replay.currentDate().value()).toBeNull();
    await delay(60);
    expect(replay.currentDate().value()).toBe(times[99]);
    expect(calls(win, 'replayApi.selectDate')).toEqual([[(times[100] ?? 0) * 1000]]);
    expect(calls(win, 'settings.setValue')).toEqual([['replay_timing_mode', 'date']]);
    expect(dialogs(win)).toEqual([]);
  });

  test('selectFirstAvailableDate starts at the first bar replay can reach, selectRandomDate halfway to the last bar', async () => {
    const first = windowWith();
    const random = windowWith();
    stateOf(first).depthIndex = 20;

    await (await replayOf(first)).selectFirstAvailableDate();
    await (await replayOf(random)).selectRandomDate();

    expect(stateOf(first).index).toBe(20);
    expect(stateOf(random).index).toBe(Math.floor((LAST - 1) / 2));
    expect(calls(first, 'settings.setValue')).toEqual([
      ['replay_timing_mode', 'first_available_date'],
    ]);
    expect(calls(random, 'settings.setValue')).toEqual([['replay_timing_mode', 'random']]);
  });

  test('a time before the first bar replay can reach starts there, with a notification and no dialog', async () => {
    const win = windowWith();
    stateOf(win).depthIndex = 10;

    await (await replayOf(win)).selectDate((times[3] ?? 0) * 1000);

    expect(stateOf(win).index).toBe(10);
    expect(calls(win, 'notification.replayTimePointCorrected')).toEqual([[]]);
    expect(dialogs(win)).toEqual([]);
  });

  test.each([
    ['a signed-out account gets the sign-in wall', 'dialog.signIn', ['REGWALL_BAR_REPLY']],
    ['a saved replay session gets the "continue replay" dialog', 'dialog.continueReplay', []],
  ])('%s, and nothing starts', async (_case, dialog, args) => {
    const win = windowWith();
    if (dialog === 'dialog.signIn') {
      inspectFakeWindow(win).state.pineEditor.signedIn = false;
    } else {
      stateOf(win).sessionState = {
        replayTime: times[5] ?? 0,
        replayMode: 'ActiveChart',
        charts: [],
      };
    }

    await (await replayOf(win)).selectRandomDate();

    expect(calls(win, dialog)).toEqual([args]);
    expect(stateOf(win).started).toBe(false);
    expect(stateOf(win).modeOn).toBe(false);
  });

  test('nothing starts while replay is not available', async () => {
    const off = windowWith();
    const chartOff = windowWith();
    stateOf(off).available = false;
    stateOf(chartOff).availability = { isAvailable: false, unavailabilityReason: 'Range bars' };

    await (await replayOf(off)).selectRandomDate();
    await (await replayOf(chartOff)).selectRandomDate();

    expect(stateOf(off).started).toBe(false);
    expect(stateOf(chartOff).started).toBe(false);
  });

  test('an intraday chart gets the paywall on a plan without BAR_REPLAY_INTRADAY, and replays on a plan with it', async () => {
    const gated = windowWith(intraday);
    const allowed = windowWith(intradayPlan);

    await (await replayOf(gated)).selectRandomDate();
    await (await replayOf(allowed)).selectRandomDate();

    expect(calls(gated, 'dialog.paywall')).toEqual([['PAYWALL_BAR_REPLAY_INTRADAY']]);
    expect(stateOf(gated).started).toBe(false);
    expect(stateOf(allowed).started).toBe(true);
    expect(dialogs(allowed)).toEqual([]);
  });

  test('the property of the timing mode keeps what it is set to, unless the build has no setter', async () => {
    const win = windowWith();
    const replay = await replayOf(win);

    replay.replayTimingMode().setValue?.('manual');

    expect(calls(win, 'settings.setValue')).toEqual([['replay_timing_mode', 'manual']]);
    const fixed = await replayOf(
      windowWith(fixture, { replay: { withoutTimingModeSetter: true } }),
    );
    expect(fixed.replayTimingMode()).not.toHaveProperty('setValue');
  });
});

describe('stepping and autoplay', () => {
  test('doStep throws at once before replay starts', async () => {
    const win = windowWith();
    const replay = await replayOf(win);

    expect(() => replay.doStep()).toThrow('Replay is not started');
    expect(calls(win, 'replayApi.doStep')).toEqual([[]]);
  });

  test('doStep resolves before currentDate shows the next bar', async () => {
    const win = windowWith(fixture, { replay: { stepMs: 10, dateMs: 40 } });
    const replay = await replayOf(win);
    running(win, 50);

    await replay.doStep();

    expect(stateOf(win).index).toBe(51);
    expect(replay.currentDate().value()).toBe(times[50]);
    await delay(60);
    expect(replay.currentDate().value()).toBe(times[51]);
  });

  test('doStep on the last bar stops replay and rejects with "Replay is finished"', async () => {
    const win = windowWith();
    const replay = await replayOf(win);
    running(win, LAST);

    expect(replay._replayUIController?._replayManager.isReplayFinished()).toBe(true);
    await expect(replay.doStep()).rejects.toBe('Replay is finished');
    expect(stateOf(win).started).toBe(false);
    expect(stateOf(win).modeOn).toBe(true);
  });

  test('a staged step error rejects and leaves replay running, and a hanging step never settles', async () => {
    const win = windowWith();
    const replay = await replayOf(win);
    running(win, 50);
    stateOf(win).stepError = 'Session error';

    await expect(replay.doStep()).rejects.toThrow('Session error');
    expect(stateOf(win)).toMatchObject({ started: true, index: 50 });
    stateOf(win).stepError = null;
    stateOf(win).stepHangs = true;
    let settled = false;
    void replay.doStep().finally(() => (settled = true));
    await delay(30);
    expect(settled).toBe(false);
  });

  test('toggleAutoplay starts and stops autoplay, throws before replay starts, and stops a finished replay', async () => {
    const win = windowWith();
    const replay = await replayOf(win);

    expect(() => {
      replay.toggleAutoplay();
    }).toThrow('Replay is not started');
    running(win, 50);
    replay.toggleAutoplay();
    expect(replay.isAutoplayStarted().value()).toBe(true);
    replay.toggleAutoplay();
    expect(replay.isAutoplayStarted().value()).toBe(false);
    running(win, LAST);
    replay.toggleAutoplay();
    expect(stateOf(win).started).toBe(false);
    expect(calls(win, 'replayApi.toggleAutoplay')).toHaveLength(4);
  });

  test('changeAutoplayDelay takes the nearest speed and keeps it as a setting when it changes', async () => {
    const win = windowWith();
    const replay = await replayOf(win);

    replay.changeAutoplayDelay(190);
    replay.changeAutoplayDelay(200);

    expect(replay.autoplayDelay()).toBe(200);
    expect(calls(win, 'replayApi.changeAutoplayDelay')).toEqual([[190], [200]]);
    expect(calls(win, 'settings.setValue')).toEqual([['ReplayAutoplayDelay', 200]]);
  });
});

describe('leaving replay', () => {
  test('leaveReplay without skipConfirm opens the "Leave replay" dialog while replay runs, and changes nothing', async () => {
    const win = windowWith();
    const replay = await replayOf(win);
    running(win, 50);

    replay.leaveReplay();

    expect(calls(win, 'dialog.leaveReplay')).toEqual([[]]);
    expect(stateOf(win)).toMatchObject({ started: true, modeOn: true, sessionState: null });
  });

  test('leaveReplay with skipConfirm leaves, saves the replay session in the layout and calls onLeave', async () => {
    const win = windowWith();
    const replay = await replayOf(win);
    running(win, 50);
    stateOf(win).autoplay = true;
    let left = 0;

    replay.leaveReplay({ skipConfirm: true, onLeave: () => (left += 1) });

    expect(stateOf(win)).toMatchObject({
      started: false,
      autoplay: false,
      modeOn: false,
      index: null,
      shownIndex: null,
      sessionState: {
        replayTime: times[50],
        replayMode: 'ActiveChart',
        charts: [{ symbol: fixture.symbol, interval: fixture.resolution, chartId: 'chart0' }],
      },
    });
    expect(left).toBe(1);
    expect(inspectFakeWindow(win).state.layouts.unsaved).toBe(true);
    expect(win.TradingViewApi?._chartWidgetCollection?.replaySessionState?.()).toEqual(
      stateOf(win).sessionState,
    );
    expect(dialogs(win)).toEqual([]);
  });

  test('leaving a finished replay, or with the setting off, saves no session; leaving without a point saves nothing', async () => {
    const finished = windowWith();
    const settingOff = windowWith();
    const neverStarted = windowWith();
    running(finished, LAST);
    running(settingOff, 50);
    stateOf(settingOff).saveSessionState = false;
    stateOf(neverStarted).modeOn = true;

    (await replayOf(finished)).leaveReplay();
    (await replayOf(settingOff)).stopReplay();
    (await replayOf(neverStarted)).leaveReplay({ skipConfirm: false });

    expect(stateOf(finished)).toMatchObject({ started: false, sessionState: null });
    expect(inspectFakeWindow(finished).state.layouts.unsaved).toBe(true);
    expect(stateOf(settingOff)).toMatchObject({ started: false, sessionState: null });
    expect(calls(settingOff, 'replayApi.stopReplay')).toEqual([[]]);
    expect(stateOf(neverStarted).modeOn).toBe(false);
    expect(inspectFakeWindow(neverStarted).state.layouts.unsaved).toBe(false);
    expect(dialogs(finished)).toEqual([]);
  });

  test('updateReplaySessionState records itself, sets the state and marks the layout changed', () => {
    const win = windowWith();
    const collection = win.TradingViewApi?._chartWidgetCollection;
    const saved = { replayTime: times[5] ?? 0, replayMode: 'ActiveChart', charts: [] };

    collection?.updateReplaySessionState?.(saved);
    expect(collection?.replaySessionState?.()).toEqual(saved);
    collection?.updateReplaySessionState?.(null);

    expect(collection?.replaySessionState?.()).toBeNull();
    expect(calls(win, 'chartWidgetCollection.updateReplaySessionState')).toEqual([[saved], [null]]);
    expect(inspectFakeWindow(win).state.layouts.unsaved).toBe(true);
    const without = windowWith(fixture, { replay: { withoutSessionState: true } });
    expect(without.TradingViewApi?._chartWidgetCollection).not.toHaveProperty('replaySessionState');
  });
});

test('what the tools must never call only records itself', async () => {
  const win = windowWith();
  const replay = await replayOf(win);
  running(win, 50);

  replay.buy(1);
  replay.sell(2);
  replay.closePosition();
  replay.goToRealtime();
  (exportsOf(win).tradingService as () => unknown)();

  expect(inspectFakeWindow(win).calls.map(({ name, args }) => [name, args])).toEqual([
    ['replayApi.buy', [1]],
    ['replayApi.sell', [2]],
    ['replayApi.closePosition', []],
    ['replayApi.goToRealtime', []],
    ['tradingService', []],
  ]);
  expect(stateOf(win)).toMatchObject({ started: true, index: 50 });
});
