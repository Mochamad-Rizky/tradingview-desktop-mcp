import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMcpServer } from '../../../src/server.js';
import type { TvWindow } from '../../../src/core/tv/tv-window.js';
import type { SavedScriptRow } from '../../../src/tools/pine/page.js';
import type { ToolContext } from '../../../src/tools/types.js';
import {
  applyView,
  callFailure,
  callOk,
  changeThenRestore,
  closeEditor,
  describeFailure,
  editorDifferences,
  editorReopenProblems,
  findEditorReopenProblems,
  HarnessError,
  missingChartMembers,
  openEditor,
  planLimitSkipReason,
  prepareChartChange,
  readLastEditedScript,
  readSymbolListing,
  readView,
  restorabilityProblems,
  restoreChart,
  restoreChartAndView,
  restoreEditor,
  snapshotEditor,
  templateType,
  type ChartSnapshot,
  type ChartState,
  type E2eServer,
} from '../../e2e/setup.js';
import { startFakeCdpServer } from '../../helpers/fake-cdp/server.js';
import { loadTargetsFixture } from '../../helpers/fake-cdp/targets.js';
import { loadTvFixture } from '../../helpers/fake-tv/fixture.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTvWindow,
} from '../../helpers/fake-tv/window.js';
import { connectInMemoryClient } from '../../helpers/mcp-client.js';
import { quietLogger, refusingLauncher, testConfig } from '../../helpers/tool-context.js';

// The checks the end-to-end chart suite makes, by reading only, before it changes the user's chart:
// that the tools can put the chart back as it is, and that the chart API has what the tools use, so
// that none of them falls back to clicks and typing. Either failing skips the suite.

const fixture = loadTvFixture();

const STATE = {
  symbol: 'NASDAQ:AAPL',
  resolution: '1D',
  chartType: 1,
  visibleRange: {
    from: 1_721_433_600,
    to: 1_729_987_200,
    fromIso: '2024-07-20T00:00:00Z',
    toIso: '2024-10-27T00:00:00Z',
  },
};

const range = (from: number, to: number) => ({ from, to, fromIso: '', toIso: '' });

// The values of a chart state as a message could hold them, plainly or quoted: a problem names the
// part that cannot be put back, never its value, which is the user's (the symbol of their chart,
// its timeframe, its view).
function valuesOf(state: Pick<ChartState, 'symbol' | 'resolution' | 'chartType' | 'visibleRange'>) {
  const values = [state.symbol, state.resolution, String(state.chartType)];
  if (state.visibleRange !== null) {
    values.push(String(state.visibleRange.from), String(state.visibleRange.to));
  }
  return values
    .flatMap((value) => [value, JSON.stringify(value)])
    .filter((value) => value.trim().length > 0);
}

describe('restorabilityProblems', () => {
  test('finds nothing to object to in a chart the tools can put back', () => {
    expect(restorabilityProblems(STATE)).toEqual([]);
    // A resolution TradingView writes without a count is the same timeframe the tools set.
    expect(restorabilityProblems({ ...STATE, resolution: 'D' })).toEqual([]);
    expect(restorabilityProblems({ ...STATE, resolution: '100T', chartType: 8 })).toEqual([]);
  });

  test.each([
    ['a chart type without a name (11)', { chartType: 11 }, /the chart type/],
    ['a chart type the tools do not know', { chartType: 99 }, /the chart type/],
    ['a timeframe the tools cannot read', { resolution: '1D,2' }, /the timeframe/],
    ['a timeframe longer than the tool takes', { resolution: '1'.repeat(17) }, /the timeframe/],
    ['an empty symbol', { symbol: '' }, /the symbol/],
    ['a blank symbol', { symbol: '   ' }, /the symbol/],
    ['a symbol longer than the tool takes', { symbol: 'X'.repeat(201) }, /the symbol/],
    ['no visible range', { visibleRange: null }, /no visible range/],
    [
      'a range whose ends are the wrong way round',
      { visibleRange: range(1_729_987_200, 1_721_433_600) },
      /the visible range/,
    ],
    [
      'a range of one instant',
      { visibleRange: range(1_721_433_600, 1_721_433_600) },
      /the visible range/,
    ],
    [
      'a range in milliseconds',
      { visibleRange: range(1_721_433_600_000, 1_729_987_200_000) },
      /the visible range/,
    ],
    ['a range that starts in 1970', { visibleRange: range(0, 1_729_987_200) }, /the visible range/],
    [
      'a range with an end that is not a number',
      { visibleRange: range(1_721_433_600, Number.NaN) },
      /the visible range/,
    ],
  ])('objects to %s, naming the part and never its value', (_case, change, part) => {
    const state = { ...STATE, ...change };

    const problems = restorabilityProblems(state);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(part);
    for (const value of valuesOf(state)) {
      expect(problems[0]).not.toContain(value);
    }
    expect(problems[0]).not.toMatch(/XXX|\d/);
  });

  test('lists every problem it finds', () => {
    expect(
      restorabilityProblems({ symbol: '', resolution: '?', chartType: 11, visibleRange: null }),
    ).toHaveLength(4);
  });
});

describe('missingChartMembers', () => {
  test('finds nothing missing on a chart with the API and the time scale', () => {
    expect(missingChartMembers(createFakeTvWindow(fixture) as unknown as TvWindow)).toEqual([]);
  });

  test('names a setter the chart API lacks, whose tool would fall back to the interface', () => {
    const win = createFakeTvWindow(fixture);
    Reflect.deleteProperty(win.TradingViewApi?.activeChart() ?? {}, 'setSymbol');

    expect(missingChartMembers(win as unknown as TvWindow)).toEqual(['activeChart().setSymbol']);
  });

  test('names everything on a page whose app has not booted, or whose chart cannot be reached', () => {
    const everything = [
      'activeChart().symbol',
      'activeChart().resolution',
      'activeChart().chartType',
      'activeChart().getVisibleRange',
      'activeChart().setSymbol',
      'activeChart().setResolution',
      'activeChart().setChartType',
      'timeScale().zoomToBarsRange',
      'bars().firstIndex',
      'bars().lastIndex',
      'bars().valueAt',
    ];
    const booting = createFakeTvWindow(fixture, { withoutApi: true }) as unknown as TvWindow;
    const throwing = {
      ...booting,
      TradingViewApi: {
        activeChart: () => {
          throw new Error('No chart is active');
        },
      },
    } as unknown as TvWindow;

    expect(missingChartMembers(booting)).toEqual(everything);
    expect(missingChartMembers(throwing)).toEqual(everything);
  });
});

describe('the exact view restore', () => {
  // A time scale that keeps the relation seen on the app: the view spans width / barSpacing - 1
  // bars, and ends rightOffset bars after the bar at baseIndex.
  function timeScale(width: number, barSpacing: number, rightOffset: number, baseIndex = 299) {
    const scale = {
      width: () => width,
      barSpacing: () => barSpacing,
      rightOffset: () => rightOffset,
      logicalRange: () => ({
        left: () => baseIndex + rightOffset - (width / barSpacing - 1),
        right: () => baseIndex + rightOffset,
      }),
      setBarSpacing: (value: number) => {
        barSpacing = value;
      },
      setRightOffset: (value: number) => {
        rightOffset = value;
      },
      resize: (value: number) => {
        width = value;
      },
    };
    const win = {
      TradingViewApi: {
        activeChart: () => ({
          _chartWidget: { model: () => ({ model: () => ({ timeScale: () => scale }) }) },
        }),
      },
    } as unknown as TvWindow;
    return { scale, win };
  }

  test('reads the bars the view spans and how far it reaches past the last bar', () => {
    const { win } = timeScale(1250, 4.87, 37.25);

    const view = readView(win);

    expect(view?.rightOffset).toBe(37.25);
    expect(view?.left).toBeCloseTo(80.576489, 5);
    expect(view?.right).toBeCloseTo(336.25, 5);
  });

  test('puts the same bars back from edge to edge, also on a pane that has grown meanwhile', () => {
    const { scale, win } = timeScale(1250, 4.87, 37.25);
    const view = readView(win);
    if (view === null) {
      throw new Error('The view could not be read');
    }

    // TradingView narrows the price axis by 20 px, and the test moves the view.
    scale.resize(1270);
    scale.setBarSpacing(9);
    scale.setRightOffset(-10);
    expect(applyView(win, view)).toBe(true);

    const range = scale.logicalRange();
    expect(range.left()).toBeCloseTo(view.left, 6);
    expect(range.right()).toBeCloseTo(view.right, 6);
  });

  test('gives back the very zoom it read when the pane kept its width', () => {
    const { scale, win } = timeScale(1250, 4.87, 37.25);
    const view = readView(win);
    if (view === null) {
      throw new Error('The view could not be read');
    }

    scale.setBarSpacing(9);
    applyView(win, view);

    expect(scale.barSpacing()).toBeCloseTo(4.87, 9);
  });
});

// The chart can show a symbol through the exchange of its data feed, BATS:AAPL for NASDAQ:AAPL
// (seen on the app), and setting that name would switch to another listing.
describe('readSymbolListing', () => {
  test('reads the listing of a symbol the chart shows through its data feed', () => {
    const win = createFakeTvWindow(fixture, { feeds: { 'NASDAQ:AAPL': 'BATS:AAPL' } });

    expect(win.TradingViewApi?.activeChart().symbol()).toBe('BATS:AAPL');
    expect(readSymbolListing(win as unknown as TvWindow)).toBe('NASDAQ:AAPL');
  });

  test('answers null when the series names no listing, or the chart cannot be reached', () => {
    const invalid = createFakeTvWindow(fixture);
    inspectFakeWindow(invalid).state.symbolInvalid = true;
    const booting = createFakeTvWindow(fixture, { withoutApi: true });
    const throwing = {
      TradingViewApi: {
        activeChart: () => {
          throw new Error('No chart is active');
        },
      },
    };

    for (const win of [invalid, booting, throwing]) {
      expect(readSymbolListing(win as unknown as TvWindow)).toBeNull();
    }
  });
});

describe('restoreChart', () => {
  // A client whose chart shows `state` and that answers every change with success. It records the
  // tools called, with their arguments.
  function recordingClient(state: ChartState): { client: Client; calls: unknown[][] } {
    const calls: unknown[][] = [];
    const client = {
      callTool: ({ name, arguments: args }: { name: string; arguments?: unknown }) => {
        calls.push([name, args]);
        const envelope = { ok: true, data: name === 'chart_get_state' ? state : {}, meta: {} };
        return Promise.resolve({
          content: [{ type: 'text', text: JSON.stringify(envelope) }],
          structuredContent: envelope,
        });
      },
    } as unknown as Client;
    return { client, calls };
  }

  const SNAPSHOT: ChartSnapshot = {
    symbol: 'BATS:AAPL',
    listing: 'NASDAQ:AAPL',
    resolution: '1D',
    chartType: 1,
    visibleRange: { from: STATE.visibleRange.from, to: STATE.visibleRange.to },
  };

  test('puts the symbol back by its listing, not by the name of its data feed', async () => {
    const { client, calls } = recordingClient({
      ...STATE,
      symbol: 'NASDAQ:MSFT',
      chartTypeName: 'candles',
    });

    await restoreChart(client, SNAPSHOT);

    expect(calls).toContainEqual(['chart_set_symbol', { symbol: 'NASDAQ:AAPL' }]);
  });

  // A client whose chart shows `state` and that fails `failing` with an error whose message and
  // details name the symbols, as chart_set_symbol does, or throws for it when `throws`.
  function failingClient(state: ChartState, failing: string, throws = false): Client {
    return {
      callTool: ({ name }: { name: string }) => {
        if (name === failing && throws) {
          return Promise.reject(new Error('The transport broke while NASDAQ:ZZZZ loaded'));
        }
        const envelope =
          name === failing
            ? {
                ok: false,
                error: {
                  code: 'INVALID_INPUT',
                  message:
                    'TradingView could not find NASDAQ:ZZZZ, so the chart was switched back to ' +
                    'NASDAQ:MSFT',
                  details: { requested: 'NASDAQ:ZZZZ', kept: 'NASDAQ:MSFT' },
                },
                meta: {},
              }
            : { ok: true, data: name === 'chart_get_state' ? state : {}, meta: {} };
        return Promise.resolve({
          content: [{ type: 'text', text: JSON.stringify(envelope) }],
          structuredContent: envelope,
          ...(name === failing ? { isError: true } : {}),
        });
      },
    } as unknown as Client;
  }

  const SHOWS_MSFT = { ...STATE, symbol: 'NASDAQ:MSFT', chartTypeName: 'candles' };

  test('names a step that failed by its tool and code only, never the text of the tool', async () => {
    const restore = restoreChart(failingClient(SHOWS_MSFT, 'chart_set_symbol'), SNAPSHOT);

    await expect(restore).rejects.toThrow(
      /^The chart could not be restored: chart_set_symbol failed with INVALID_INPUT$/,
    );
    await expect(restore).rejects.toBeInstanceOf(HarnessError);
  });

  test('names a step whose call threw, without the message of the error', async () => {
    const restore = restoreChart(failingClient(SHOWS_MSFT, 'chart_set_symbol', true), SNAPSHOT);

    await expect(restore).rejects.toThrow(
      /^The chart could not be restored: chart_set_symbol could not be called$/,
    );
  });

  test('names a chart state it could not read by its code', async () => {
    const restore = restoreChart(failingClient(SHOWS_MSFT, 'chart_get_state'), SNAPSHOT);

    await expect(restore).rejects.toThrow(/chart_get_state failed with INVALID_INPUT/);
    await expect(restore).rejects.not.toThrow(/ZZZZ|MSFT|AAPL/);
  });

  test('changeThenRestore logs a failed restore after a failed test by codes only', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('the test failed');

    const run = changeThenRestore(failingClient(SHOWS_MSFT, 'chart_set_symbol'), SNAPSHOT, () =>
      Promise.reject(failure),
    );

    await expect(run).rejects.toBe(failure);
    expect(logged).toHaveBeenCalledTimes(1);
    const line = String(logged.mock.calls[0]?.[0]);
    expect(line).toMatch(/chart_set_symbol failed with INVALID_INPUT/);
    expect(line).not.toMatch(/ZZZZ|MSFT|AAPL/);
    logged.mockRestore();
  });

  test('leaves the symbol alone when the chart shows it already', async () => {
    const { client, calls } = recordingClient({
      ...STATE,
      symbol: 'BATS:AAPL',
      chartTypeName: 'candles',
    });

    await restoreChart(client, SNAPSHOT);

    expect(calls.map(([name]) => name)).toEqual([
      'chart_get_state',
      'data_get_ohlcv',
      'chart_set_visible_range',
    ]);
  });
});

describe('planLimitSkipReason', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  });

  // A client of the real server over a fake app whose plan allows 2 indicators on a chart.
  async function clientOf(overrides: Parameters<typeof createFakeTvWindow>[1] = {}) {
    const win = createFakeTvWindow(fixture, overrides);
    const app = await startFakeCdpServer({
      targets: loadTargetsFixture({ chartWindow: () => win }),
    });
    cleanups.push(() => app.close());
    const { server, ctx } = createMcpServer(
      testConfig({ cdpPort: app.port, callTimeoutMs: 5000 }),
      {
        launcher: refusingLauncher(),
        logger: quietLogger,
      },
    );
    cleanups.push(() => ctx.connection.close());
    const client = await connectInMemoryClient(server);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    return client;
  }

  test('names the feature and limit when the chart is full', async () => {
    const client = await clientOf();

    const reason = await planLimitSkipReason(client, 'INDICATORS_ON_CHART', 2, 1);

    expect(reason).toMatch(/INDICATORS_ON_CHART/);
    expect(reason).toMatch(/limit of 2/);
    expect(reason).toMatch(/2 in use/);
  });

  test('names the feature and limit when the test would need more than there is room for', async () => {
    const client = await clientOf();

    expect(await planLimitSkipReason(client, 'INDICATORS_ON_CHART', 1, 2)).toMatch(
      /INDICATORS_ON_CHART/,
    );
  });

  test('returns null when there is room', async () => {
    const client = await clientOf();

    expect(await planLimitSkipReason(client, 'INDICATORS_ON_CHART', 1, 1)).toBeNull();
    expect(await planLimitSkipReason(client, 'INDICATORS_ON_CHART', 0, 2)).toBeNull();
  });

  test('returns null when the limit is unknown', async () => {
    const client = await clientOf();
    // The fixture plan sets no limit for HISTORICAL_BARS.
    expect(await planLimitSkipReason(client, 'HISTORICAL_BARS', 1000, 1)).toBeNull();

    const bare = await clientOf({ webpackModules: {} });
    expect(await planLimitSkipReason(bare, 'INDICATORS_ON_CHART', 100, 1)).toBeNull();
  });
});

// A server of this branch on a fake app, as startE2eServer gives one for the real app, with the
// fake window to stage and inspect the app. close() closes the server and the fake app.
async function fakeE2eServer(
  overrides: Parameters<typeof createFakeTvWindow>[1] = {},
): Promise<E2eServer & { win: FakeTvWindow; client: Client; ctx: ToolContext }> {
  const win = createFakeTvWindow(fixture, overrides);
  const app = await startFakeCdpServer({ targets: loadTargetsFixture({ chartWindow: () => win }) });
  const { server, ctx } = createMcpServer(testConfig({ cdpPort: app.port, callTimeoutMs: 5000 }), {
    launcher: refusingLauncher(),
    logger: quietLogger,
  });
  const client = await connectInMemoryClient(server);
  return {
    client,
    ctx,
    win,
    async close() {
      await client.close();
      await server.close();
      await ctx.connection.close();
      await app.close();
    },
  };
}

describe('the steps of a suite that changes the chart', () => {
  const servers: E2eServer[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await server.close();
    }
  });

  test('prepareChartChange takes the snapshot and the view of a chart the tools can put back', async () => {
    const server = await fakeE2eServer();
    servers.push(server);

    const plan = await prepareChartChange(server);

    expect(plan.skipReason).toBeUndefined();
    expect(plan.snapshot).toMatchObject({ symbol: 'NASDAQ:AAPL', listing: 'NASDAQ:AAPL' });
    expect(await restoreChartAndView(server, plan)).toEqual([]);
  });

  test('prepareChartChange names the part of a chart it could not put back, not its value', async () => {
    const server = await fakeE2eServer();
    servers.push(server);
    await server.win.TradingViewApi?.activeChart().setChartType(11);

    const plan = await prepareChartChange(server);

    expect(plan.snapshot).toBeUndefined();
    expect(plan.skipReason).toMatch(/the chart type.*nothing was changed/);
    expect(plan.skipReason).not.toMatch(/\d|AAPL/);
  });

  test('prepareChartChange names a member the chart API lacks, and takes no snapshot', async () => {
    const server = await fakeE2eServer();
    servers.push(server);
    Reflect.deleteProperty(server.win.TradingViewApi?.activeChart() ?? {}, 'setResolution');

    const plan = await prepareChartChange(server);

    expect(plan.snapshot).toBeUndefined();
    expect(plan.skipReason).toMatch(/activeChart\(\)\.setResolution.*nothing was changed/);
    expect(await restoreChartAndView(server, plan)).toEqual([]);
  });
});

describe('callFailure', () => {
  const servers: E2eServer[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await server.close();
    }
  });

  test('answers the error of a call that failed', async () => {
    const server = await fakeE2eServer();
    servers.push(server);

    const error = await callFailure(server.client, 'indicator_get_values', { id: 'NOPE01' });

    expect(error.code).toBe('INVALID_INPUT');
  });

  test('throws, without the data, for a call that succeeded', async () => {
    const server = await fakeE2eServer();
    servers.push(server);

    await expect(callFailure(server.client, 'indicator_list')).rejects.toThrow(
      /^indicator_list was expected to fail, but it succeeded$/,
    );
  });
});

describe('callOk', () => {
  test('throws with the tool and the code of a failure only, never the text of the tool', async () => {
    const envelope = {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message:
          'TradingView could not find NASDAQ:ZZZZ, so the chart was switched back to NASDAQ:MSFT',
        details: { kept: 'NASDAQ:MSFT' },
      },
      meta: {},
    };
    const client = {
      callTool: () =>
        Promise.resolve({
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(envelope) }],
          structuredContent: envelope,
        }),
    } as unknown as Client;

    const call = callOk(client, 'chart_set_symbol', { symbol: 'NASDAQ:ZZZZ' });

    await expect(call).rejects.toThrow(/^chart_set_symbol failed with INVALID_INPUT$/);
    await expect(call).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('describeFailure', () => {
  test('keeps the text of an error of the harness, which holds no value', () => {
    expect(describeFailure(new HarnessError('The chart could not be restored'))).toBe(
      'The chart could not be restored',
    );
  });

  test('names any other error by its code or its kind, never by its message', () => {
    const coded = Object.assign(new Error('CDP Runtime.evaluate timed out while NASDAQ:MSFT'), {
      code: 'TIMEOUT',
    });

    expect(describeFailure(coded)).toBe('an error with code TIMEOUT');
    expect(describeFailure(new TypeError('NASDAQ:MSFT is not a function'))).toBe(
      'an unexpected TypeError',
    );
    expect(describeFailure('NASDAQ:MSFT')).toBe('an unexpected error');
  });
});

describe('templateType', () => {
  test('tells the template of a strategy or a library from that of an indicator', () => {
    expect(templateType('//@version=6\nstrategy("My strategy", overlay = true)\n')).toBe(
      'strategy',
    );
    expect(templateType('//@version=6\nlibrary("MyLibrary")\n')).toBe('library');
    expect(templateType('//@version=6\nindicator("My script")\nplot(close)\n')).toBe('indicator');
    expect(templateType('')).toBe('indicator');
  });
});

describe('editorReopenProblems', () => {
  const row = (scriptIdPart: string, version: string, modified: number): SavedScriptRow => ({
    scriptIdPart,
    scriptName: 'Script',
    scriptTitle: 'Script',
    version,
    modified,
    kind: 'study',
  });
  const saved = [
    row('USER;new', '2.0', 300),
    row('USER;old', '4.0', 100),
    row('USER;draft', '0.1', 50),
  ];

  test('finds nothing for a new script, or for a saved script pine_open opens as shown', () => {
    expect(editorReopenProblems(null, [], 1)).toEqual([]);
    expect(editorReopenProblems({ id: 'USER;new', version: '2.0' }, saved, 1)).toEqual([]);
    // A server draft is never open-limited, and no limit limits nothing.
    expect(editorReopenProblems({ id: 'USER;draft', version: '0.1' }, saved, 1)).toEqual([]);
    expect(editorReopenProblems({ id: 'USER;old', version: '4.0' }, saved, null)).toEqual([]);
  });

  test('objects to a script the saved scripts lack', () => {
    expect(editorReopenProblems({ id: 'USER;gone', version: '1.0' }, saved, 1)).toEqual([
      'pine_open would not find the script among the saved scripts',
    ]);
  });

  test('objects to a version other than the one shown, or no version', () => {
    expect(editorReopenProblems({ id: 'USER;new', version: '1.0' }, saved, 1)).toEqual([
      'pine_open would open another version of the script than the one shown',
    ]);
    expect(editorReopenProblems({ id: 'USER;new', version: null }, saved, 1)).toHaveLength(1);
  });

  test('objects to a script the plan does not let TradingView open', () => {
    expect(editorReopenProblems({ id: 'USER;old', version: '4.0' }, saved, 1)).toEqual([
      'the plan lets TradingView open only the 1 most recently changed saved scripts',
    ]);
  });
});

// The guard of the suites that use the Pine Editor, on the fake app, whose editor is closed and
// shows the saved script Fixture Script (2.0) when it opens.
describe('the Pine Editor guard', () => {
  const FIXTURE_SCRIPT = { id: 'USER;0f1e2d3c4b5a69788796a5b4c3d2e1f0', version: '2.0' };
  const OWN_TEXT = '//@version=6\nindicator("written by the test")\nplot(close)\n';
  const servers: E2eServer[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await server.close();
    }
  });

  async function openedEditor() {
    const server = await fakeE2eServer();
    servers.push(server);
    const pine = inspectFakeWindow(server.win).state.pineEditor;
    expect(pine.placement).toBeNull();
    await openEditor(server.ctx);
    const shown = await snapshotEditor(server.ctx);
    return { ...server, pine, shown, target: { script: shown.state.script, source: shown.source } };
  }

  test('snapshotEditor reads the script the editor shows and its text', async () => {
    const { pine, shown } = await openedEditor();

    expect(shown.state).toMatchObject({ open: true, modified: false, script: FIXTURE_SCRIPT });
    expect(shown.source).toBe(pine.savedSource);
    // The fake app has no pineDialogOpenState.
    expect(shown.visible).toBeNull();
  });

  test('editorDifferences names the script, unsaved changes and the text, the text only when known', async () => {
    const { shown } = await openedEditor();
    const edited = {
      ...shown,
      state: { ...shown.state, modified: true },
      ownModified: true,
      source: OWN_TEXT,
    };

    expect(editorDifferences(shown, { script: FIXTURE_SCRIPT, source: shown.source })).toEqual([]);
    expect(editorDifferences(edited, { script: FIXTURE_SCRIPT, source: shown.source })).toEqual([
      'modified',
      'text',
    ]);
    expect(editorDifferences(edited, { script: null, source: null })).toEqual([
      'script',
      'modified',
    ]);
    // The template of a new script is written anew, so its text is not compared.
    const template = { ...shown, state: { ...shown.state, script: null }, source: 'other text' };
    expect(editorDifferences(template, { script: null, source: OWN_TEXT })).toEqual([]);
    // The flag the app keeps can lag while the editor is open: its own isModified() decides.
    const lagging = { ...shown, state: { ...shown.state, modified: true }, ownModified: false };
    expect(editorDifferences(lagging, { script: FIXTURE_SCRIPT, source: shown.source })).toEqual(
      [],
    );
  });

  test('restoreEditor opens the saved script again after the test wrote its own text', async () => {
    const { client, ctx, pine, shown, target } = await openedEditor();
    await callOk(client, 'pine_new', {});
    await callOk(client, 'pine_set_source', { source: OWN_TEXT });

    const restored = await restoreEditor(client, ctx, target, new Set([OWN_TEXT]));

    expect(restored).toMatchObject({ problems: [], differedAtFirst: [] });
    expect(pine.script).toEqual({ scriptIdPart: FIXTURE_SCRIPT.id, version: '2.0' });
    expect(pine.source).toBe(shown.source);
    expect(pine.source).toBe(pine.savedSource);
  });

  test('restoreEditor puts back a saved script it knows by its id only', async () => {
    const { client, ctx, pine, shown } = await openedEditor();
    await callOk(client, 'pine_new', {});
    await callOk(client, 'pine_set_source', { source: OWN_TEXT });

    const restored = await restoreEditor(
      client,
      ctx,
      { script: FIXTURE_SCRIPT, source: null },
      new Set([OWN_TEXT]),
    );

    expect(restored.problems).toEqual([]);
    expect(pine.script).toEqual({ scriptIdPart: FIXTURE_SCRIPT.id, version: '2.0' });
    expect(pine.source).toBe(shown.source);
  });

  test('restoreEditor does nothing when the editor shows its target', async () => {
    const { client, ctx, win, target } = await openedEditor();

    expect(await restoreEditor(client, ctx, target, new Set())).toEqual({
      problems: [],
      differedAtFirst: null,
      waitedMs: null,
    });

    expect(inspectFakeWindow(win).callsTo('pineFacade.openScript')).toEqual([]);
  });

  test('restoreEditor leaves unsaved text it did not write as it is', async () => {
    const { client, ctx, win, pine, target } = await openedEditor();
    await callOk(client, 'pine_new', {});
    await callOk(client, 'pine_set_source', { source: OWN_TEXT });
    pine.source = 'typed by someone else';

    expect((await restoreEditor(client, ctx, target, new Set([OWN_TEXT]))).problems).toEqual([
      'The Pine Editor holds unsaved text this test did not write, so it was left as it is',
    ]);

    expect(pine.source).toBe('typed by someone else');
    expect(inspectFakeWindow(win).callsTo('pineFacade.openScript')).toEqual([]);
  });

  test('restoreEditor starts the template of a new script again', async () => {
    const { client, ctx, pine } = await openedEditor();
    await callOk(client, 'pine_new', { type: 'strategy' });
    const shown = await snapshotEditor(ctx);
    await callOk(client, 'pine_set_source', { source: OWN_TEXT });

    const restored = await restoreEditor(
      client,
      ctx,
      { script: null, source: shown.source },
      new Set([OWN_TEXT]),
    );

    expect(restored.problems).toEqual([]);
    expect(pine.script).toBeNull();
    expect(pine.source).toBe(shown.source);
    expect(pine.source).toBe(pine.savedSource);
  });

  test('restoreEditor says what pine_open failed with, and nothing of the script', async () => {
    const { client, ctx, pine, target } = await openedEditor();
    await callOk(client, 'pine_new', {});
    await callOk(client, 'pine_set_source', { source: OWN_TEXT });
    pine.savedScripts = pine.savedScripts.filter(
      ({ scriptIdPart }) => scriptIdPart !== FIXTURE_SCRIPT.id,
    );

    const { problems } = await restoreEditor(client, ctx, target, new Set([OWN_TEXT]));

    expect(problems).toEqual([
      'The Pine Editor could not be put back: pine_open failed with INVALID_INPUT',
    ]);
    expect(pine.source).toBe(OWN_TEXT);
  });

  // Makes the facade open a saved script at once but show its text only after `delayMs`, as the
  // code editor of the app can: until then it shows the text it had, so it reads as modified.
  function showOpenedTextLate(server: Awaited<ReturnType<typeof openedEditor>>, delayMs: number) {
    const facade = server.win.TradingViewApi?.pineEditorApi().getDialogFacade();
    if (facade === null || facade === undefined) {
      throw new Error('The fake editor is not open');
    }
    const openScript = facade.openScript.bind(facade);
    facade.openScript = async (info) => {
      const shownBefore = server.pine.source;
      await openScript(info);
      const opened = server.pine.source;
      server.pine.source = shownBefore;
      if (Number.isFinite(delayMs)) {
        setTimeout(() => {
          server.pine.source = opened;
        }, delayMs);
      }
    };
  }

  test('restoreEditor waits for an editor that shows the text of the opened script a moment late', async () => {
    const server = await openedEditor();
    const { client, ctx, pine, shown, target } = server;
    await callOk(client, 'pine_new', {});
    await callOk(client, 'pine_set_source', { source: OWN_TEXT });
    showOpenedTextLate(server, 300);

    const restored = await restoreEditor(client, ctx, target, new Set([OWN_TEXT]));

    expect(restored.problems).toEqual([]);
    expect(restored.differedAtFirst).toEqual(['modified', 'text']);
    expect(restored.waitedMs).toBeGreaterThanOrEqual(200);
    expect(pine.source).toBe(shown.source);
  });

  test('restoreEditor says what still differs when the editor never shows the script', async () => {
    const server = await openedEditor();
    const { client, ctx, target } = server;
    await callOk(client, 'pine_new', {});
    await callOk(client, 'pine_set_source', { source: OWN_TEXT });
    showOpenedTextLate(server, Number.POSITIVE_INFINITY);

    const { problems } = await restoreEditor(client, ctx, target, new Set([OWN_TEXT]));

    expect(problems).toEqual([
      'The Pine Editor does not show the script it is to show again (it differs in modified, text)',
    ]);
  });

  test('findEditorReopenProblems reads the saved scripts and the limit of the plan', async () => {
    const { ctx } = await openedEditor();

    expect(await findEditorReopenProblems(ctx, FIXTURE_SCRIPT)).toEqual([]);
    expect(await findEditorReopenProblems(ctx, null)).toEqual([]);
    // Fixture Strategy is older than Fixture Script, and the plan of the fixture allows one.
    expect(
      await findEditorReopenProblems(ctx, {
        id: 'USER;1a2b3c4d5e6f708192a3b4c5d6e7f809',
        version: '3.0',
      }),
    ).toEqual(['the plan lets TradingView open only the 1 most recently changed saved scripts']);
  });

  test('closeEditor hides the editor and keeps its text', async () => {
    const { ctx, pine, shown } = await openedEditor();

    expect(await closeEditor(ctx)).toEqual({ closed: true, placement: 'dialog' });

    expect(pine.visible).toBe(false);
    expect(pine.source).toBe(shown.source);
  });
});

// The script the app keeps for the closed side panel of the Pine Editor, under the name of the
// account, read for its id and version only.
describe('readLastEditedScript', () => {
  const page = (items: Record<string, unknown>) =>
    ({
      localStorage: {
        getItem: (key: string) => (key in items ? JSON.stringify(items[key]) : null),
      },
    }) as unknown as TvWindow;

  test('reads the id and version of a saved script and whether it has unsaved changes', () => {
    const win = page({
      last_edited_script: {
        someone: {
          scriptIdPart: 'USER;abc',
          version: '3.0',
          scriptName: 'Mine',
          scriptSource: 'x',
        },
      },
      has_unsaved_modifications: { someone: false },
    });

    expect(readLastEditedScript(win)).toEqual({
      script: { id: 'USER;abc', version: '3.0' },
      unsaved: false,
    });
    expect(JSON.stringify(readLastEditedScript(win))).not.toMatch(/Mine|someone/);
  });

  test('reads a new script as no script, and an unknown flag as null', () => {
    const win = page({ last_edited_script: { someone: { scriptIdPart: '', version: '0.0' } } });

    expect(readLastEditedScript(win)).toEqual({ script: null, unsaved: null });
  });

  test('answers null when the app keeps nothing, keeps it for several accounts, or it cannot be read', () => {
    expect(readLastEditedScript(page({}))).toBeNull();
    expect(
      readLastEditedScript(
        page({
          last_edited_script: { one: { scriptIdPart: 'USER;a' }, two: { scriptIdPart: 'USER;b' } },
        }),
      ),
    ).toBeNull();
    expect(readLastEditedScript({} as unknown as TvWindow)).toBeNull();
    const broken = {
      localStorage: {
        getItem: () => {
          throw new Error('denied');
        },
      },
    } as unknown as TvWindow;
    expect(readLastEditedScript(broken)).toBeNull();
  });
});
