import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMcpServer } from '../../../src/server.js';
import type { TvWindow } from '../../../src/core/tv/tv-window.js';
import {
  applyView,
  missingChartMembers,
  planLimitSkipReason,
  readSymbolListing,
  readView,
  restorabilityProblems,
  restoreChart,
  type ChartSnapshot,
  type ChartState,
} from '../../e2e/setup.js';
import { startFakeCdpServer } from '../../helpers/fake-cdp/server.js';
import { loadTargetsFixture } from '../../helpers/fake-cdp/targets.js';
import { loadTvFixture } from '../../helpers/fake-tv/fixture.js';
import { createFakeTvWindow, inspectFakeWindow } from '../../helpers/fake-tv/window.js';
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

describe('restorabilityProblems', () => {
  test('finds nothing to object to in a chart the tools can put back', () => {
    expect(restorabilityProblems(STATE)).toEqual([]);
    // A resolution TradingView writes without a count is the same timeframe the tools set.
    expect(restorabilityProblems({ ...STATE, resolution: 'D' })).toEqual([]);
    expect(restorabilityProblems({ ...STATE, resolution: '100T', chartType: 8 })).toEqual([]);
  });

  test.each([
    ['a chart type without a name (11)', { chartType: 11 }, /chart type 11/],
    ['a chart type the tools do not know', { chartType: 99 }, /chart type 99/],
    ['a timeframe the tools cannot read', { resolution: '1D,2' }, /timeframe "1D,2"/],
    ['a timeframe longer than the tool takes', { resolution: '1'.repeat(17) }, /timeframe/],
    ['an empty symbol', { symbol: '' }, /symbol ""/],
    ['a blank symbol', { symbol: '   ' }, /symbol " {3}"/],
    ['a symbol longer than the tool takes', { symbol: 'X'.repeat(201) }, /symbol/],
    ['no visible range', { visibleRange: null }, /no visible range/],
    [
      'a range whose ends are the wrong way round',
      { visibleRange: range(1_729_987_200, 1_721_433_600) },
      /range/,
    ],
    ['a range of one instant', { visibleRange: range(1_721_433_600, 1_721_433_600) }, /range/],
    [
      'a range in milliseconds',
      { visibleRange: range(1_721_433_600_000, 1_729_987_200_000) },
      /range/,
    ],
    ['a range that starts in 1970', { visibleRange: range(0, 1_729_987_200) }, /range/],
    [
      'a range with an end that is not a number',
      { visibleRange: range(1_721_433_600, Number.NaN) },
      /range/,
    ],
  ])('objects to %s', (_case, change, problem) => {
    const problems = restorabilityProblems({ ...STATE, ...change });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(problem);
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

  test('leaves the symbol alone when the chart shows it already', async () => {
    const { client, calls } = recordingClient({
      ...STATE,
      symbol: 'BATS:AAPL',
      chartTypeName: 'candles',
    });

    await restoreChart(client, SNAPSHOT);

    expect(calls.map(([name]) => name)).toEqual(['chart_get_state', 'chart_set_visible_range']);
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
