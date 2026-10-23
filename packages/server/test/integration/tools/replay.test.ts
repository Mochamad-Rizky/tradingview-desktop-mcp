import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../../../src/config/schema.js';
import { createMcpServer } from '../../../src/server.js';
import type { ToolContext } from '../../../src/tools/types.js';
import { startFakeCdpServer } from '../../helpers/fake-cdp/server.js';
import { loadTargetsFixture } from '../../helpers/fake-cdp/targets.js';
import { loadTvFixture, type TvStateFixture } from '../../helpers/fake-tv/fixture.js';
import { syntheticBars } from '../../helpers/fake-tv/synthetic-bars.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTvOverrides,
  type FakeTvWindow,
} from '../../helpers/fake-tv/window.js';
import { callTool, connectInMemoryClient, textOf } from '../../helpers/mcp-client.js';
import { quietLogger, refusingLauncher, testConfig } from '../../helpers/tool-context.js';

// The replay tools through the whole server: an SDK client over the in-memory transport, the real
// registry, connection manager and CDP adapter, and the fake debug port of the app with a fake chart
// tab behind it, whose replay API starts, steps, plays and leaves replay (replay.ts). Values are
// synthetic: 300 daily bars, one a day from 2024-01-02.

// Nothing in this file may run a real program or start TradingView.
vi.mock('node:child_process', () => ({
  spawn: () => {
    throw new Error('A test tried to start a real program with spawn');
  },
  execFile: () => {
    throw new Error('A test tried to start a real program with execFile');
  },
}));

const fixture = loadTvFixture();
const times = syntheticBars(fixture.bars).map(([time]) => time);
const LAST = times.length - 1;
const time = (index: number): number => times[index] ?? Number.NaN;
const isoOf = (seconds: number): string =>
  new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');
// An intraday chart on the plan of the fixture, which lacks BAR_REPLAY_INTRADAY, as the plan of the
// real account does, and on a plan that has it.
const intraday: TvStateFixture = { ...fixture, resolution: '15' };
const intradayPlan: TvStateFixture = {
  ...intraday,
  planConfigs: { ...fixture.planConfigs, BAR_REPLAY_INTRADAY: {} },
};

// The calls the tools must never make: the paper trading of replay, which TradingView Desktop routes
// through its trading service, going to realtime, which keeps replay on and can show a dialog, and
// the trading service itself.
const FORBIDDEN = [
  'replayApi.buy',
  'replayApi.sell',
  'replayApi.closePosition',
  'replayApi.goToRealtime',
  'tradingService',
];

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function connect(server: McpServer): Promise<Client> {
  const client = await connectInMemoryClient(server);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

interface Harness {
  client: Client;
  win: FakeTvWindow;
  ctx: ToolContext;
}

// A server behind a fake app showing `win`.
async function startHarnessWith(win: FakeTvWindow, config: Partial<Config> = {}): Promise<Harness> {
  const app = await startFakeCdpServer({ targets: loadTargetsFixture({ chartWindow: () => win }) });
  cleanups.push(() => app.close());
  const { server, ctx } = createMcpServer(
    testConfig({ cdpPort: app.port, callTimeoutMs: 5000, ...config }),
    { launcher: refusingLauncher(), logger: quietLogger },
  );
  cleanups.push(() => ctx.connection.close());
  return { client: await connect(server), win, ctx };
}

function startHarness(
  from: TvStateFixture = fixture,
  overrides: FakeTvOverrides = {},
  config: Partial<Config> = {},
): Promise<Harness> {
  return startHarnessWith(createFakeTvWindow(from, overrides), config);
}

interface Envelope {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; hint?: string; details?: Record<string, unknown> };
  meta: { via?: string; durationMs: number; warnings?: string[] };
}

const envelopeOf = (result: { structuredContent?: unknown }): Envelope =>
  result.structuredContent as Envelope;
const dataOf = (result: { structuredContent?: unknown }) => envelopeOf(result).data ?? {};
const errorOf = (result: { structuredContent?: unknown }) => envelopeOf(result).error;
const warningsOf = (result: { structuredContent?: unknown }) =>
  envelopeOf(result).meta.warnings ?? [];

const replayOf = (win: FakeTvWindow) => inspectFakeWindow(win).state.replay;
const calls = (win: FakeTvWindow, name: string) => inspectFakeWindow(win).callsTo(name);
const callNames = (win: FakeTvWindow) => inspectFakeWindow(win).calls.map(({ name }) => name);
const dialogs = (win: FakeTvWindow) => callNames(win).filter((name) => name.startsWith('dialog.'));
const forbidden = (win: FakeTvWindow) => callNames(win).filter((name) => FORBIDDEN.includes(name));
// What the selects of replay recorded, in order.
const selects = (win: FakeTvWindow) =>
  callNames(win).filter((name) => name.startsWith('replayApi.select'));

// A replay the user started at bar `index`, without the tools.
function startedByUser(win: FakeTvWindow, index: number): void {
  Object.assign(replayOf(win), {
    modeOn: true,
    started: true,
    index,
    shownIndex: index,
    selectedPoint: time(index),
  });
}

// The user closes the replay of the session from the replay toolbar, answering its "Leave replay"
// dialog, so that TradingView saves it; then starts replay with the replay button, answering "Start
// new" in the "continue replay" dialog, which clears what was saved, and replays from bar 40.
async function userTakesOver(win: FakeTvWindow): Promise<void> {
  const api = win.TradingViewApi;
  const replay = await api?.replayApi?.();
  replay?.leaveReplay({ skipConfirm: true });
  api?._chartWidgetCollection?.updateReplaySessionState?.(null);
  startedByUser(win, 40);
}

describe('replay_start', () => {
  test('replay_start with a date selects that day in milliseconds and waits until replay is ready', async () => {
    const { client, win, ctx } = await startHarness(fixture, {
      replay: { selectMs: 30, dateMs: 150 },
    });

    const result = await callTool(client, 'replay_start', { date: '2024-04-11' });

    // TradingView starts replay a second before the time, so the bar of that day comes with the
    // first step.
    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: {
        active: true,
        date: time(99),
        dateIso: isoOf(time(99)),
        start: 'date',
        resolution: '1D',
      },
      meta: { via: 'api', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(JSON.parse(textOf(result))).toStrictEqual(result.structuredContent);
    expect(calls(win, 'replayApi.selectDate')).toEqual([[time(100) * 1000]]);
    expect(replayOf(win)).toMatchObject({ started: true, index: 99, shownIndex: 99 });
    // The session knows its replay by the point it started at.
    expect(ctx.session.replayRunStartedBySession).toBe(time(99));
    expect(dialogs(win)).toEqual([]);
  });

  test("replay_start 'first' and 'random' use the app's own selectors", async () => {
    const first = await startHarness();
    replayOf(first.win).depthIndex = 12;
    const random = await startHarness();

    const fromFirst = await callTool(first.client, 'replay_start', { date: 'first' });
    const fromRandom = await callTool(random.client, 'replay_start', { date: 'random' });

    expect(dataOf(fromFirst)).toEqual({
      active: true,
      date: time(12),
      dateIso: isoOf(time(12)),
      start: 'first',
      resolution: '1D',
    });
    expect(selects(first.win)).toEqual(['replayApi.selectFirstAvailableDate']);
    const halfway = Math.floor((LAST - 1) / 2);
    expect(dataOf(fromRandom)).toMatchObject({ date: time(halfway), start: 'random' });
    expect(selects(random.win)).toEqual(['replayApi.selectRandomDate']);
  });

  test('replay_start without a date starts at a random bar, as the Random bar of TradingView', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'replay_start');

    expect(dataOf(result)).toMatchObject({ active: true, start: 'random' });
    expect(selects(win)).toEqual(['replayApi.selectRandomDate']);
  });

  test('replay_start sets the replay timing mode of TradingView back after the select, which keeps it as a setting', async () => {
    const { client, win } = await startHarness();

    await callTool(client, 'replay_start', { date: '2024-04-11' });

    expect(calls(win, 'settings.setValue')).toEqual([
      ['replay_timing_mode', 'date'],
      ['replay_timing_mode', 'manual'],
    ]);
    expect(replayOf(win).timingMode).toBe('manual');
  });

  test('replay_start sets a replay timing mode other than manual back', async () => {
    const { client, win } = await startHarness();
    replayOf(win).timingMode = 'random';

    await callTool(client, 'replay_start', { date: 'first' });

    expect(calls(win, 'settings.setValue')).toEqual([
      ['replay_timing_mode', 'first_available_date'],
      ['replay_timing_mode', 'random'],
    ]);
    expect(replayOf(win).timingMode).toBe('random');
  });

  test('replay_start refuses, and changes nothing, when the replay timing mode of TradingView cannot be set back', async () => {
    const { client, win } = await startHarness(fixture, {
      replay: { withoutTimingModeSetter: true },
    });

    const result = await callTool(client, 'replay_start', { date: 'first' });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: expect.stringContaining('how its replay button starts a replay') as string,
    });
    expect(selects(win)).toEqual([]);
    expect(calls(win, 'settings.setValue')).toEqual([]);
    expect(replayOf(win)).toMatchObject({ timingMode: 'manual', started: false, modeOn: false });
  });

  test('replay_start warns when TradingView refuses to set its replay timing mode back', async () => {
    const { client, win } = await startHarness();
    const replay = await win.TradingViewApi?.replayApi?.();
    if (replay !== undefined) {
      const original = replay.replayTimingMode.bind(replay);
      replay.replayTimingMode = () => ({
        ...original(),
        setValue: () => {
          throw new Error('The setting is read-only');
        },
      });
    }

    const result = await callTool(client, 'replay_start', { date: 'first' });

    expect(dataOf(result)).toMatchObject({ active: true });
    expect(warningsOf(result)).toEqual([
      expect.stringMatching(/how its replay button starts a replay.*could not be set back/),
    ]);
  });

  test('replay_start a date outside the loaded history is INVALID_INPUT', async () => {
    const { client, win } = await startHarness();

    // Before the first loaded bar, and after the last one.
    for (const date of ['2023-12-01', '2025-01-01']) {
      const result = await callTool(client, 'replay_start', { date });

      expect(errorOf(result), date).toMatchObject({
        code: 'INVALID_INPUT',
        message: expect.stringContaining(
          `outside the loaded bars of the chart, from ${isoOf(time(0))} to ${isoOf(time(LAST))}`,
        ) as string,
        details: { first: time(0), last: time(LAST) },
      });
      expect(errorOf(result)?.hint, date).toMatch(/'first'.*'random'/);
    }
    expect(selects(win)).toEqual([]);
  });

  test('replay_start refuses a date it cannot read, naming first and random', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'replay_start', { date: 'yesterday' });

    expect(errorOf(result)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(errorOf(result)?.hint).toMatch(/'first'/);
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('replay_start where replay is not available fails NOT_AVAILABLE naming the resolution', async () => {
    const off = await startHarness();
    replayOf(off.win).available = false;
    const chartOff = await startHarness();
    replayOf(chartOff.win).availability = {
      isAvailable: false,
      unavailabilityReason: 'Replay is not available for this symbol',
    };

    const fromOff = await callTool(off.client, 'replay_start');
    const fromChartOff = await callTool(chartOff.client, 'replay_start');

    expect(errorOf(fromOff)).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: expect.stringContaining('1D') as string,
      details: { resolution: '1D', reason: null },
    });
    expect(errorOf(fromChartOff)).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: expect.stringMatching(/1D.*Replay is not available for this symbol/) as string,
      details: { resolution: '1D', reason: 'Replay is not available for this symbol' },
    });
    expect(selects(off.win)).toEqual([]);
    expect(selects(chartOff.win)).toEqual([]);
  });

  test('replay_start on an intraday chart fails PLAN_LIMIT BAR_REPLAY_INTRADAY on a plan without it, and opens no paywall', async () => {
    const { client, win } = await startHarness(intraday);

    const result = await callTool(client, 'replay_start', { date: 'first' });

    expect(errorOf(result)).toMatchObject({
      code: 'PLAN_LIMIT',
      message: expect.stringMatching(/BAR_REPLAY_INTRADAY.*15/) as string,
      details: { feature: 'BAR_REPLAY_INTRADAY', resolution: '15' },
    });
    expect(errorOf(result)?.hint).toMatch(/chart_set_timeframe/);
    expect(selects(win)).toEqual([]);
    expect(dialogs(win)).toEqual([]);
  });

  test('replay_start on an intraday chart starts on a plan with BAR_REPLAY_INTRADAY', async () => {
    const { client, win } = await startHarness(intradayPlan);

    const result = await callTool(client, 'replay_start', { date: 'first' });

    expect(dataOf(result)).toMatchObject({ active: true, start: 'first', resolution: '15' });
    expect(dialogs(win)).toEqual([]);
  });

  test('replay_start refuses a chart that turns intraday while replay starts, and opens no paywall', async () => {
    const { client, win } = await startHarness();
    // The chart turns to 15 minutes, as a chart_set_timeframe of another call would turn it, after
    // the checks of replay_start and right before it starts replay.
    const api = win.TradingViewApi;
    const original = api?.replayApi?.bind(api);
    let asked = 0;
    if (api !== undefined && original !== undefined) {
      api.replayApi = () => {
        asked += 1;
        if (asked === 2) {
          inspectFakeWindow(win).state.resolution = '15';
        }
        return original();
      };
    }

    const result = await callTool(client, 'replay_start', { date: 'first' });

    expect(errorOf(result)).toMatchObject({
      code: 'PLAN_LIMIT',
      details: { feature: 'BAR_REPLAY_INTRADAY', resolution: '15' },
    });
    expect(selects(win)).toEqual([]);
    expect(dialogs(win)).toEqual([]);
  });

  test('replay_start on an intraday chart refuses NOT_AVAILABLE when the plan cannot be read', async () => {
    const { client, win } = await startHarness(intraday, { webpackModules: {} });

    const result = await callTool(client, 'replay_start', { date: 'first' });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      details: { feature: 'BAR_REPLAY_INTRADAY', resolution: '15' },
    });
    expect(selects(win)).toEqual([]);
  });

  test('replay_start refuses while replay runs, naming replay_step and replay_stop', async () => {
    const { client, win } = await startHarness();
    startedByUser(win, 40);

    const result = await callTool(client, 'replay_start', { date: 'first' });

    expect(errorOf(result)).toMatchObject({ code: 'NOT_AVAILABLE' });
    // The replay may be the user's: the hint never tells to stop it without asking.
    expect(errorOf(result)?.hint).toMatch(
      /replay_step.*ask the user before stopping it with replay_stop/,
    );
    expect(selects(win)).toEqual([]);
    expect(replayOf(win)).toMatchObject({ started: true, index: 40 });
  });

  test('replay_start refuses a layout with a saved replay session, which would open the "continue replay" dialog, and keeps it', async () => {
    const { client, win } = await startHarness();
    const saved = { replayTime: time(20), replayMode: 'ActiveChart', charts: [] };
    replayOf(win).sessionState = saved;

    const result = await callTool(client, 'replay_start', { date: 'first' });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: expect.stringContaining('saved') as string,
    });
    expect(selects(win)).toEqual([]);
    expect(dialogs(win)).toEqual([]);
    expect(replayOf(win).sessionState).toEqual(saved);
    expect(calls(win, 'chartWidgetCollection.updateReplaySessionState')).toEqual([]);
  });

  test('replay_start refuses when TradingView does not tell whether a replay session is saved', async () => {
    const { client, win } = await startHarness(fixture, { replay: { withoutSessionState: true } });

    const result = await callTool(client, 'replay_start', { date: 'first' });

    expect(errorOf(result)).toMatchObject({ code: 'NOT_AVAILABLE' });
    expect(selects(win)).toEqual([]);
  });

  test('replay_start needs a signed-in account, and opens no sign-in wall', async () => {
    const { client, win } = await startHarness();
    inspectFakeWindow(win).state.pineEditor.signedIn = false;

    const result = await callTool(client, 'replay_start');

    expect(errorOf(result)).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(selects(win)).toEqual([]);
    expect(dialogs(win)).toEqual([]);
  });

  test('replay_start fails CAPABILITY_UNAVAILABLE on a page without the replay API, and NOT_AVAILABLE while TradingView does not give it', async () => {
    const without = await startHarness(fixture, { replay: { withoutReplayApi: true } });
    const refused = await startHarness(fixture, {
      replay: { replayApiError: "replay api isn't available" },
    });

    expect(errorOf(await callTool(without.client, 'replay_start'))).toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    });
    expect(errorOf(await callTool(refused.client, 'replay_start'))).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: expect.stringContaining("replay api isn't available") as string,
    });
  });

  test('replay_start answers TIMEOUT, saying replay may still start, when TradingView does not start it in time', async () => {
    const { client, win, ctx } = await startHarness(
      fixture,
      { replay: { selectMs: 3000 } },
      { callTimeoutMs: 1500 },
    );

    const result = await callTool(client, 'replay_start', { date: 'first' });

    expect(errorOf(result)).toMatchObject({ code: 'TIMEOUT', details: { waitMs: 500 } });
    expect(errorOf(result)?.hint).toMatch(
      /replay_status.*ask the user before stopping it with replay_stop/,
    );
    // A start the session did not see come cannot be told from one of the user: replay_stop will
    // not clear what TradingView saves for it.
    expect(ctx.session.replayRunStartedBySession).toBeNull();
    expect(replayOf(win).timingMode).toBe('manual');
  });

  test('replay_start reports a replay date TradingView has not reported in time as null, with a warning', async () => {
    const { client, ctx } = await startHarness(
      fixture,
      { replay: { dateMs: 3000 } },
      { callTimeoutMs: 1500 },
    );

    const result = await callTool(client, 'replay_start', { date: 'first' });

    expect(dataOf(result)).toMatchObject({ active: true, date: null, dateIso: null });
    expect(warningsOf(result)).toEqual([expect.stringMatching(/did not report the replay date/)]);
    // Replay was not seen ready, so the session does not count it as its own.
    expect(ctx.session.replayRunStartedBySession).toBeNull();
  });

  test('replay_start answers once the chart shows the bars of the replay, so that the first step and data_get_ohlcv find them', async () => {
    const { client } = await startHarness(fixture, { replay: { barsMs: 300 } });

    await callTool(client, 'replay_start', { date: '2024-04-11' });
    const bars = await callTool(client, 'data_get_ohlcv', { count: 1 });
    const step = await callTool(client, 'replay_step');

    expect(errorOf(bars)).toBeUndefined();
    expect(dataOf(step)).toMatchObject({ stepped: 1, finished: false });
    expect(warningsOf(step)).toEqual([]);
  });

  test('replay_start warns when the bars of the replay do not show in time, and still counts the replay as its own', async () => {
    const { client, ctx } = await startHarness(
      fixture,
      { replay: { barsMs: 3000 } },
      { callTimeoutMs: 1500 },
    );

    const result = await callTool(client, 'replay_start', { date: 'first' });

    expect(dataOf(result)).toMatchObject({ active: true, date: time(0) });
    expect(warningsOf(result)).toEqual([
      expect.stringMatching(/did not show the bars of the replay within 500 ms/),
    ]);
    expect(ctx.session.replayRunStartedBySession).toBe(time(0));
  });
});

describe('replay_step', () => {
  test('replay_step steps one bar per call of doStep and reports the date', async () => {
    const { client, win } = await startHarness();
    await callTool(client, 'replay_start', { date: '2024-04-11' });

    const result = await callTool(client, 'replay_step', { bars: 3 });

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: { date: time(102), dateIso: isoOf(time(102)), stepped: 3, finished: false },
      meta: { via: 'api', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(calls(win, 'replayApi.doStep')).toEqual([[], [], []]);
    expect(dataOf(await callTool(client, 'replay_step'))).toEqual({
      date: time(103),
      dateIso: isoOf(time(103)),
      stepped: 1,
      finished: false,
    });
  });

  test('replay_step stops at the end of the loaded bars with finished: true', async () => {
    const { client, win } = await startHarness();
    startedByUser(win, LAST - 2);

    const result = await callTool(client, 'replay_step', { bars: 5 });

    // The step that reached the end counts; TradingView stopped replay before it showed the last bar,
    // keeping its toolbar, so no replay point is left.
    expect(dataOf(result)).toEqual({ date: null, dateIso: null, stepped: 2, finished: true });
    expect(warningsOf(result)).toEqual([]);
    expect(calls(win, 'replayApi.doStep')).toHaveLength(2);
    expect(replayOf(win)).toMatchObject({ started: false, modeOn: true });
  });

  test('replay_step refuses NOT_AVAILABLE when replay is not running, naming replay_start', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'replay_step');

    expect(errorOf(result)).toMatchObject({ code: 'NOT_AVAILABLE' });
    expect(errorOf(result)?.hint).toMatch(/replay_start/);
    expect(calls(win, 'replayApi.doStep')).toEqual([]);
  });

  test('replay_step refuses while autoplay runs, naming replay_autoplay with enabled: false', async () => {
    const { client, win } = await startHarness();
    startedByUser(win, 40);
    replayOf(win).autoplay = true;

    const result = await callTool(client, 'replay_step');

    expect(errorOf(result)).toMatchObject({ code: 'NOT_AVAILABLE' });
    expect(errorOf(result)?.hint).toMatch(/replay_autoplay.*enabled: false/);
    expect(calls(win, 'replayApi.doStep')).toEqual([]);
  });

  test('replay_step fails NOT_AVAILABLE with the reason of TradingView when its first step fails', async () => {
    const { client, win } = await startHarness();
    startedByUser(win, 40);
    replayOf(win).stepError = 'The replay session answered an error';

    const result = await callTool(client, 'replay_step', { bars: 4 });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: expect.stringContaining('The replay session answered an error') as string,
    });
    expect(calls(win, 'replayApi.doStep')).toHaveLength(1);
    expect(replayOf(win)).toMatchObject({ started: true, index: 40 });
  });

  test('replay_step answers TIMEOUT when its first step does not end in time', async () => {
    const { client, win } = await startHarness(fixture, {}, { callTimeoutMs: 1500 });
    startedByUser(win, 40);
    replayOf(win).stepHangs = true;

    const result = await callTool(client, 'replay_step');

    expect(errorOf(result)).toMatchObject({ code: 'TIMEOUT', details: { waitMs: 500 } });
    expect(errorOf(result)?.hint).toMatch(/replay_status/);
  });

  test('replay_step refuses a bar count outside 1 to 500', async () => {
    const { client, win } = await startHarness();
    startedByUser(win, 40);

    for (const bars of [0, 501, 1.5]) {
      const result = await callTool(client, 'replay_step', { bars });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/bars/);
    }
    expect(calls(win, 'replayApi.doStep')).toEqual([]);
  });
});

describe('replay_autoplay', () => {
  test('replay_autoplay maps speed labels to delays and rejects unknown labels', async () => {
    const { client, win } = await startHarness();
    await callTool(client, 'replay_start', { date: 'first' });

    const result = await callTool(client, 'replay_autoplay', { enabled: true, speed: '5x' });

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: { autoplay: true, delayMs: 200, speed: '5x' },
      meta: { via: 'api', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(calls(win, 'replayApi.changeAutoplayDelay')).toEqual([[200]]);
    expect(calls(win, 'replayApi.toggleAutoplay')).toEqual([[]]);
    // TradingView keeps the speed as its own setting.
    expect(calls(win, 'settings.setValue')).toContainEqual(['ReplayAutoplayDelay', 200]);

    const unknown = await callTool(client, 'replay_autoplay', { enabled: true, speed: '2x' });

    expect(errorOf(unknown)).toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('"2x"') as string,
      details: {
        speed: '2x',
        speeds: ['10x', '7x', '5x', '3x', '1x', '0.5x', '0.3x', '0.2x', '0.1x'],
      },
    });
    expect(calls(win, 'replayApi.changeAutoplayDelay')).toHaveLength(1);
    expect(calls(win, 'replayApi.toggleAutoplay')).toHaveLength(1);
  });

  test('replay_autoplay toggles autoplay only when it differs, and stops it with enabled: false', async () => {
    const { client, win } = await startHarness();
    startedByUser(win, 40);
    replayOf(win).autoplay = true;

    const again = await callTool(client, 'replay_autoplay', { enabled: true });

    expect(dataOf(again)).toEqual({ autoplay: true, delayMs: 1000, speed: '1x' });
    expect(calls(win, 'replayApi.toggleAutoplay')).toEqual([]);
    expect(calls(win, 'replayApi.changeAutoplayDelay')).toEqual([]);

    const stopped = await callTool(client, 'replay_autoplay', { enabled: false, speed: '0.1X' });

    expect(dataOf(stopped)).toEqual({ autoplay: false, delayMs: 10000, speed: '0.1x' });
    expect(calls(win, 'replayApi.toggleAutoplay')).toEqual([[]]);
  });

  test('replay_autoplay refuses NOT_AVAILABLE when replay is not running', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'replay_autoplay', { enabled: true });

    expect(errorOf(result)).toMatchObject({ code: 'NOT_AVAILABLE' });
    expect(errorOf(result)?.hint).toMatch(/replay_start/);
    expect(calls(win, 'replayApi.toggleAutoplay')).toEqual([]);
  });

  test('replay_autoplay refuses to play a replay at the end of the loaded bars, which TradingView would end instead', async () => {
    const { client, win } = await startHarness();
    startedByUser(win, LAST);

    const result = await callTool(client, 'replay_autoplay', { enabled: true });

    expect(errorOf(result)).toMatchObject({ code: 'NOT_AVAILABLE' });
    expect(errorOf(result)?.hint).toMatch(/replay_stop/);
    expect(calls(win, 'replayApi.toggleAutoplay')).toEqual([]);
    expect(replayOf(win).started).toBe(true);
  });
});

describe('replay_status', () => {
  test('replay_status reports replay off on an available chart, and calls nothing', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'replay_status');

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: {
        available: true,
        reason: null,
        active: false,
        date: null,
        dateIso: null,
        autoplay: false,
        delayMs: 1000,
        speed: '1x',
        resolution: '1D',
        position: null,
        realizedPL: null,
        currency: null,
      },
      meta: { via: 'api', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('replay_status reports a running replay, its date and its speed', async () => {
    const { client, win } = await startHarness();
    startedByUser(win, 40);
    Object.assign(replayOf(win), { autoplay: true, delayMs: 300 });

    expect(dataOf(await callTool(client, 'replay_status'))).toMatchObject({
      available: true,
      active: true,
      date: time(40),
      dateIso: isoOf(time(40)),
      autoplay: true,
      delayMs: 300,
      speed: '3x',
    });
  });

  test('replay_status reports an intraday chart unavailable on a plan without BAR_REPLAY_INTRADAY, and why', async () => {
    const gated = await startHarness(intraday);
    const allowed = await startHarness(intradayPlan);

    expect(dataOf(await callTool(gated.client, 'replay_status'))).toMatchObject({
      available: false,
      reason: expect.stringContaining('BAR_REPLAY_INTRADAY') as string,
      resolution: '15',
    });
    expect(dataOf(await callTool(allowed.client, 'replay_status'))).toMatchObject({
      available: true,
      reason: null,
    });
  });

  test('replay_status reports why TradingView cannot replay the chart', async () => {
    const { client, win } = await startHarness();
    replayOf(win).availability = { isAvailable: false, unavailabilityReason: 'Range bars' };

    expect(dataOf(await callTool(client, 'replay_status'))).toMatchObject({
      available: false,
      reason: expect.stringContaining('Range bars') as string,
    });
  });
});

describe('replay_stop', () => {
  test('replay_stop leaves replay while autoplay runs and after a failed step', async () => {
    const playing = await startHarness();
    await callTool(playing.client, 'replay_start', { date: 'first' });
    await callTool(playing.client, 'replay_autoplay', { enabled: true });

    const fromPlaying = await callTool(playing.client, 'replay_stop');

    expect(envelopeOf(fromPlaying)).toStrictEqual({
      ok: true,
      data: { active: false },
      meta: { via: 'api', durationMs: expect.any(Number) as number, warnings: [] },
    });
    // Autoplay is stopped first, then replay is left without the "Leave replay" dialog.
    const order = callNames(playing.win).filter((name) =>
      ['replayApi.toggleAutoplay', 'replayApi.leaveReplay'].includes(name),
    );
    expect(order).toEqual([
      'replayApi.toggleAutoplay',
      'replayApi.toggleAutoplay',
      'replayApi.leaveReplay',
    ]);
    expect(calls(playing.win, 'replayApi.leaveReplay')).toEqual([[{ skipConfirm: true }]]);
    expect(dataOf(await callTool(playing.client, 'replay_status'))).toMatchObject({
      active: false,
      autoplay: false,
    });

    const failed = await startHarness();
    await callTool(failed.client, 'replay_start', { date: 'first' });
    replayOf(failed.win).stepError = 'The replay session answered an error';
    expect(errorOf(await callTool(failed.client, 'replay_step'))).toMatchObject({
      code: 'NOT_AVAILABLE',
    });

    expect(dataOf(await callTool(failed.client, 'replay_stop'))).toEqual({ active: false });
    expect(calls(failed.win, 'replayApi.leaveReplay')).toEqual([[{ skipConfirm: true }]]);
    expect(dataOf(await callTool(failed.client, 'replay_status'))).toMatchObject({
      active: false,
    });
    expect(dialogs(playing.win)).toEqual([]);
    expect(dialogs(failed.win)).toEqual([]);
  });

  test('replay_stop clears the replay session TradingView saved for a replay of this session', async () => {
    const { client, win, ctx } = await startHarness();
    await callTool(client, 'replay_start', { date: '2024-04-11' });
    await callTool(client, 'replay_step', { bars: 2 });

    await callTool(client, 'replay_stop');

    // TradingView saved the replay on leaving, and the tool cleared it as its "Start new" does.
    expect(calls(win, 'chartWidgetCollection.updateReplaySessionState')).toEqual([
      [
        {
          replayTime: time(101),
          replayMode: 'ActiveChart',
          charts: [{ symbol: fixture.symbol, interval: '1D', chartId: 'chart0' }],
        },
      ],
      [null],
    ]);
    expect(replayOf(win).sessionState).toBeNull();
    expect(ctx.session.replayRunStartedBySession).toBeNull();
    // A new replay starts without the "continue replay" dialog.
    expect(dataOf(await callTool(client, 'replay_start', { date: 'first' }))).toMatchObject({
      active: true,
    });
    expect(dialogs(win)).toEqual([]);
  });

  test('replay_stop keeps the replay session TradingView saved for a replay the user started', async () => {
    const { client, win } = await startHarness();
    startedByUser(win, 40);

    expect(dataOf(await callTool(client, 'replay_stop'))).toEqual({ active: false });

    expect(calls(win, 'replayApi.leaveReplay')).toEqual([[{ skipConfirm: true }]]);
    expect(calls(win, 'chartWidgetCollection.updateReplaySessionState')).toEqual([
      [expect.objectContaining({ replayTime: time(40) })],
    ]);
    expect(replayOf(win).sessionState).toMatchObject({ replayTime: time(40) });
  });

  test('replay_stop keeps what TradingView saves for a replay the user started after closing the one of this session', async () => {
    const { client, win, ctx } = await startHarness();
    await callTool(client, 'replay_start', { date: 'first' });
    await userTakesOver(win);

    expect(dataOf(await callTool(client, 'replay_stop'))).toEqual({ active: false });

    // The replay of the user was left, and what TradingView saved for it stays.
    expect(calls(win, 'replayApi.leaveReplay').at(-1)).toEqual([{ skipConfirm: true }]);
    expect(calls(win, 'chartWidgetCollection.updateReplaySessionState').at(-1)).toEqual([
      expect.objectContaining({ replayTime: time(40) }),
    ]);
    expect(replayOf(win).sessionState).toMatchObject({ replayTime: time(40) });
    expect(ctx.session.replayRunStartedBySession).toBeNull();
  });

  test('replay_stop with nothing running keeps the replay the user saved after closing the one of this session', async () => {
    const { client, win, ctx } = await startHarness();
    await callTool(client, 'replay_start', { date: 'first' });
    await userTakesOver(win);
    // The user leaves their replay as well, and TradingView saves it.
    (await win.TradingViewApi?.replayApi?.())?.leaveReplay({ skipConfirm: true });
    const saved = replayOf(win).sessionState;
    const before = inspectFakeWindow(win).calls.length;

    expect(dataOf(await callTool(client, 'replay_stop'))).toEqual({ active: false });

    expect(saved).toMatchObject({ replayTime: time(40) });
    expect(replayOf(win).sessionState).toEqual(saved);
    expect(inspectFakeWindow(win).calls.slice(before)).toEqual([]);
    expect(ctx.session.replayRunStartedBySession).toBeNull();
  });

  test('a replay tool that reads another replay than the one this session started forgets it', async () => {
    const { client, win, ctx } = await startHarness();
    await callTool(client, 'replay_start', { date: 'first' });
    await userTakesOver(win);

    await callTool(client, 'replay_status');

    expect(ctx.session.replayRunStartedBySession).toBeNull();
    // The replay of the user is left without clearing what TradingView saves for it.
    await callTool(client, 'replay_stop');
    expect(replayOf(win).sessionState).toMatchObject({ replayTime: time(40) });
  });

  test('a replay tool that reads the replay of this session at another bar keeps it', async () => {
    const { client, ctx } = await startHarness();
    await callTool(client, 'replay_start', { date: 'first' });
    await callTool(client, 'replay_step', { bars: 2 });

    await callTool(client, 'replay_status');

    expect(ctx.session.replayRunStartedBySession).toBe(time(0));
  });

  test('replay_stop with replay off answers { active: false } and calls nothing', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'replay_stop');

    expect(dataOf(result)).toEqual({ active: false });
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('replay_stop closes the replay toolbar TradingView keeps after replay reached its end', async () => {
    const { client, win, ctx } = await startHarness();
    await callTool(client, 'replay_start', { date: 'first' });
    replayOf(win).index = LAST - 1;
    replayOf(win).shownIndex = LAST - 1;
    expect(dataOf(await callTool(client, 'replay_step', { bars: 3 }))).toMatchObject({
      finished: true,
    });
    expect(replayOf(win)).toMatchObject({ started: false, modeOn: true });

    expect(dataOf(await callTool(client, 'replay_stop'))).toEqual({ active: false });

    expect(calls(win, 'replayApi.leaveReplay')).toEqual([[{ skipConfirm: true }]]);
    expect(replayOf(win)).toMatchObject({ modeOn: false, sessionState: null });
    expect(ctx.session.replayRunStartedBySession).toBeNull();
    expect(dialogs(win)).toEqual([]);
  });

  test('replay_stop warns when the saved replay of this session cannot be cleared', async () => {
    const { client, win, ctx } = await startHarness();
    await callTool(client, 'replay_start', { date: 'first' });
    const collection = win.TradingViewApi?._chartWidgetCollection;
    if (collection !== undefined) {
      Reflect.deleteProperty(collection, 'updateReplaySessionState');
    }

    const result = await callTool(client, 'replay_stop');

    expect(dataOf(result)).toEqual({ active: false });
    expect(warningsOf(result)).toEqual([expect.stringMatching(/could not be cleared/)]);
    expect(ctx.session.replayRunStartedBySession).toBeNull();
  });

  test('replay_stop answers TIMEOUT when replay does not stop, and opens no dialog', async () => {
    const { client, win, ctx } = await startHarness(fixture, {}, { callTimeoutMs: 1500 });
    await callTool(client, 'replay_start', { date: 'first' });
    const api = win.TradingViewApi;
    const replay = await api?.replayApi?.();
    if (replay !== undefined) {
      replay.leaveReplay = () => undefined;
    }

    const result = await callTool(client, 'replay_stop');

    expect(errorOf(result)).toMatchObject({ code: 'TIMEOUT', details: { waitMs: 500 } });
    expect(dialogs(win)).toEqual([]);
    // The replay of this session still runs, so a later replay_stop still clears what it leaves.
    expect(ctx.session.replayRunStartedBySession).toBe(time(0));
  });
});

describe('the layout tools while a replay this session started runs', () => {
  // A plan that lets the account save ten layouts; the fixture has three saved.
  const roomy: TvStateFixture = {
    ...fixture,
    planLimits: { ...fixture.planLimits, CHART_STORAGE: 10 },
  };

  test('layout_switch and layout_new refuse NOT_AVAILABLE, naming replay_stop, before they load or create anything', async () => {
    const { client, win } = await startHarness(roomy);
    await callTool(client, 'replay_start', { date: '2024-04-11' });

    const switched = await callTool(client, 'layout_switch', {
      layoutId: 'FIXTURE2',
      confirm: true,
    });
    const created = await callTool(client, 'layout_new', { name: 'Example Layout', confirm: true });

    for (const result of [switched, created]) {
      expect(errorOf(result)).toMatchObject({
        code: 'NOT_AVAILABLE',
        hint: expect.stringContaining('replay_stop') as string,
      });
    }
    expect(calls(win, 'TradingViewApi.loadLayoutFromServerByLayoutId')).toEqual([]);
    expect(calls(win, 'createNewChart')).toEqual([]);
    expect(replayOf(win)).toMatchObject({ started: true });
    // Once the replay is stopped, they act.
    await callTool(client, 'replay_stop');
    const after = await callTool(client, 'layout_switch', { layoutId: 'FIXTURE2', confirm: true });
    expect(dataOf(after)).toMatchObject({ id: 'FIXTURE2', changed: true });
  });

  test('a replay the user started, or a run of this session that is over, holds no layout tool back', async () => {
    const { client, win, ctx } = await startHarness(roomy);
    await callTool(client, 'replay_start', { date: '2024-04-11' });
    // The user closes the replay of the session and starts one of their own.
    await userTakesOver(win);

    const switched = await callTool(client, 'layout_switch', {
      layoutId: 'FIXTURE2',
      confirm: true,
    });

    expect(dataOf(switched)).toMatchObject({ id: 'FIXTURE2', changed: true });
    expect(ctx.session.replayRunStartedBySession).toBeNull();
  });
});

test('the replay tools never trade, never go to realtime and never touch the trading service', async () => {
  const { client, win } = await startHarness();

  await callTool(client, 'replay_start', { date: '2024-04-11' });
  await callTool(client, 'replay_step', { bars: 2 });
  await callTool(client, 'replay_autoplay', { enabled: true, speed: '10x' });
  await callTool(client, 'replay_status');
  await callTool(client, 'replay_autoplay', { enabled: false });
  await callTool(client, 'replay_stop');

  expect(forbidden(win)).toEqual([]);
  expect(dialogs(win)).toEqual([]);
  expect(calls(win, 'replayApi.stopReplay')).toEqual([]);
});
