import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../../src/config/schema.js';
import { createMcpServer } from '../../src/server.js';
import { startFakeCdpServer } from '../helpers/fake-cdp/server.js';
import { loadTargetsFixture } from '../helpers/fake-cdp/targets.js';
import { loadTvFixture, type TvStateFixture } from '../helpers/fake-tv/fixture.js';
import { syntheticBars } from '../helpers/fake-tv/synthetic-bars.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTvWindow,
} from '../helpers/fake-tv/window.js';
import { callTool, connectInMemoryClient } from '../helpers/mcp-client.js';
import { SAMPLE_STRATEGY, SECOND_STRATEGY, withStudies } from '../helpers/strategy-fixtures.js';
import {
  quietLogger,
  refusingLauncher,
  testConfig,
  unreachableConnection,
} from '../helpers/tool-context.js';

// The resources of the data, Pine, strategy and watchlist domains (design spec 7) through the whole
// server: an SDK client over the in-memory transport, the real registry, connection manager and CDP
// adapter, and the fake debug port of the app with a fake chart, Pine Editor, Strategy Tester and
// watchlists behind it. The resources of the app health and the chart state are tested with the
// domains they belong to. Prices, sources and watchlists are synthetic.

// Nothing in this file may run a real program or start TradingView.
vi.mock('node:child_process', () => ({
  spawn: () => {
    throw new Error('A test tried to start a real program with spawn');
  },
  execFile: () => {
    throw new Error('A test tried to start a real program with execFile');
  },
}));

const URIS = {
  health: 'tradingview://app/health',
  state: 'tradingview://chart/state',
  ohlcv: 'tradingview://chart/ohlcv',
  source: 'tradingview://pine/source',
  errors: 'tradingview://pine/errors',
  report: 'tradingview://strategy/report',
  watchlist: 'tradingview://watchlist/active',
} as const;

const fixture = loadTvFixture();
const bars = syntheticBars(fixture.bars);
const EDITED = '//@version=6\nindicator("Fixture Script")\nplot(open)\n';
const BROKEN = '//@version=6\nindicator("Broken")\nplot(undeclared_x)\n';
const SOUND = '//@version=6\nindicator("Sound")\nplot(close)\n';

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

async function startHarness(
  from: TvStateFixture = fixture,
): Promise<{ client: Client; win: FakeTvWindow }> {
  const win = createFakeTvWindow(from);
  const app = await startFakeCdpServer({ targets: loadTargetsFixture({ chartWindow: () => win }) });
  cleanups.push(() => app.close());
  const config = testConfig({ cdpPort: app.port, callTimeoutMs: 5000 });
  const { server, ctx } = createMcpServer(config, {
    launcher: refusingLauncher(),
    logger: quietLogger,
  });
  cleanups.push(() => ctx.connection.close());
  return { client: await connect(server), win };
}

// A server whose TradingView is down, with the tools that `selection` selects (all by default).
async function startOffline(
  selection: Partial<Pick<Config, 'profile' | 'toolPatterns'>> = {},
): Promise<Client> {
  const { server } = createMcpServer(testConfig(selection), {
    connection: unreachableConnection(),
    launcher: refusingLauncher(),
    logger: quietLogger,
  });
  return connect(server);
}

// The fixture with the editor open in a dialog, changed by `editor`.
function withEditor(editor: Partial<TvStateFixture['pineEditor']> = {}): TvStateFixture {
  return { ...fixture, pineEditor: { ...fixture.pineEditor, open: 'dialog', ...editor } };
}

// The JSON a resource holds.
async function readJson(client: Client, uri: string): Promise<unknown> {
  const read = await client.readResource({ uri });
  expect(read.contents).toHaveLength(1);
  const [content] = read.contents;
  expect(content).toMatchObject({ uri, mimeType: 'application/json' });
  return JSON.parse(content !== undefined && 'text' in content ? content.text : '');
}

const dataOf = (result: { structuredContent?: unknown }): unknown =>
  (result.structuredContent as { data?: unknown }).data;

test('lists every resource', async () => {
  const client = await startOffline();

  const { resources } = await client.listResources();

  expect(resources.map(({ uri }) => uri)).toEqual(Object.values(URIS));
  expect(resources.map(({ name }) => name)).toEqual([
    'app_health',
    'chart_state',
    'chart_ohlcv',
    'pine_source',
    'pine_errors',
    'strategy_report',
    'watchlist_active',
  ]);
  for (const resource of resources) {
    expect(resource.mimeType, resource.uri).toBe('application/json');
    expect(resource.title?.trim(), resource.uri).toBeTruthy();
    expect(resource.description?.length, resource.uri).toBeGreaterThan(60);
    // A resource is read, never run.
    expect(resource.description, resource.uri).toMatch(/changes nothing/);
  }
});

describe('the resources follow the tools', () => {
  test('offers only the chart state resource under the tool filter chart_*', async () => {
    const client = await startOffline({ toolPatterns: ['chart_*'] });

    const { resources } = await client.listResources();

    expect(resources.map(({ uri }) => uri)).toEqual([URIS.state]);
    // A resource that is not offered cannot be read either: the text of the Pine Editor stays
    // out of reach of a server that offers no Pine tool.
    await expect(client.readResource({ uri: URIS.source })).rejects.toThrow(/not found/i);
    await expect(client.readResource({ uri: URIS.report })).rejects.toThrow(/not found/i);
  });

  test('offers each resource only with its tool', async () => {
    const pine = await startOffline({ toolPatterns: ['pine_*'] });
    const picked = await startOffline({ toolPatterns: ['app_health', 'data_*', 'strategy_*'] });
    const errorsOnly = await startOffline({ toolPatterns: ['pine_get_errors'] });

    expect((await pine.listResources()).resources.map(({ uri }) => uri)).toEqual([
      URIS.source,
      URIS.errors,
    ]);
    expect((await picked.listResources()).resources.map(({ uri }) => uri)).toEqual([
      URIS.health,
      URIS.ohlcv,
      URIS.report,
    ]);
    expect((await errorsOnly.listResources()).resources.map(({ uri }) => uri)).toEqual([
      URIS.errors,
    ]);
  });

  test('offers every resource under the readonly profile, which keeps their tools', async () => {
    const client = await startOffline({ profile: 'readonly' });

    const { resources } = await client.listResources();

    expect(resources.map(({ uri }) => uri)).toEqual(Object.values(URIS));
  });

  test('offers the resources of the core tools under the core profile', async () => {
    const client = await startOffline({ profile: 'core' });

    const { resources } = await client.listResources();

    // watchlist_get is not a core tool, so the core profile offers no watchlist resource.
    expect(resources.map(({ uri }) => uri)).toEqual(
      Object.values(URIS).filter((uri) => uri !== URIS.watchlist),
    );
  });

  test('offers no resource when no tool of one is selected', async () => {
    const client = await startOffline({ toolPatterns: ['indicator_*'] });

    expect(client.getServerCapabilities()?.resources).toBeUndefined();
    await expect(client.readResource({ uri: URIS.state })).rejects.toThrow();
  });
});

describe('the OHLCV resource', () => {
  test('reads the OHLCV resource', async () => {
    const { client, win } = await startHarness();

    const resource = await readJson(client, URIS.ohlcv);
    const tool = await callTool(client, 'data_get_ohlcv', { count: 100 });

    expect(resource).toStrictEqual(dataOf(tool));
    expect(resource).toMatchObject({ symbol: 'NASDAQ:AAPL', resolution: '1D', complete: true });
    // The last 100 of the bars the chart holds, oldest first.
    const { bars: read } = resource as { bars: { time: number }[] };
    expect(read).toHaveLength(100);
    expect(read[0]?.time).toBe(bars[200]?.[0]);
    expect(read.at(-1)?.time).toBe(bars[299]?.[0]);
    // Enough bars were loaded, so nothing was asked of the app.
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('the OHLCV resource follows the chart', async () => {
    const { client } = await startHarness();

    await callTool(client, 'chart_set_symbol', { symbol: 'NASDAQ:MSFT' });
    const resource = await readJson(client, URIS.ohlcv);

    expect(resource).toMatchObject({ symbol: 'NASDAQ:MSFT' });
  });
});

describe('the Pine source resource', () => {
  test('the Pine source resource does not open the editor', async () => {
    const { client, win } = await startHarness();

    await expect(client.readResource({ uri: URIS.source })).rejects.toMatchObject({
      code: -32603,
      data: {
        code: 'NOT_AVAILABLE',
        message: 'The Pine Editor is not open',
        hint: expect.stringMatching(/pine_open.*pine_new/s) as string,
      },
    });
    // The editor is still closed, and nothing was called on the page to open it.
    expect(inspectFakeWindow(win).state.pineEditor.placement).toBeNull();
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('reads the text of the open editor with its script and whether it has unsaved changes', async () => {
    const { client, win } = await startHarness(withEditor({ source: EDITED }));

    const resource = await readJson(client, URIS.source);
    const tool = await callTool(client, 'pine_get_source');

    expect(resource).toStrictEqual(dataOf(tool));
    expect(resource).toEqual({
      source: EDITED,
      script: {
        id: fixture.pineEditor.script?.scriptIdPart,
        version: fixture.pineEditor.script?.version,
      },
      modified: true,
    });
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });
});

describe('the Pine errors resource', () => {
  const EMPTY = {
    success: true,
    errors: [],
    warnings: [],
    addedToChart: false,
    studyId: null,
    compiledAt: null,
    compiledAtIso: null,
  };

  test('returns an empty result before any compile of the session', async () => {
    const { client, win } = await startHarness();

    const resource = await readJson(client, URIS.errors);
    const tool = await callTool(client, 'pine_get_errors');

    expect(resource).toStrictEqual(EMPTY);
    expect(resource).toStrictEqual(dataOf(tool));
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('needs no TradingView', async () => {
    const client = await startOffline();

    await expect(readJson(client, URIS.errors)).resolves.toStrictEqual(EMPTY);
  });

  test('returns the last compile of the session', async () => {
    const { client } = await startHarness();

    await callTool(client, 'pine_compile', { source: BROKEN });
    const broken = await readJson(client, URIS.errors);
    const brokenTool = await callTool(client, 'pine_get_errors');
    await callTool(client, 'pine_compile', { source: SOUND });
    const sound = await readJson(client, URIS.errors);
    const soundTool = await callTool(client, 'pine_get_errors');

    expect(broken).toStrictEqual(dataOf(brokenTool));
    expect(broken).toMatchObject({
      success: false,
      errors: [{ line: 3, message: expect.stringContaining('undeclared_x') as string }],
      addedToChart: false,
      compiledAt: expect.any(Number) as number,
      compiledAtIso: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/) as string,
    });
    // Each compile replaces the one before it.
    expect(sound).toStrictEqual(dataOf(soundTool));
    expect(sound).toMatchObject({ success: true, errors: [] });
  });
});

describe('the strategy report resource', () => {
  test('the strategy report resource fails NOT_AVAILABLE without a strategy', async () => {
    const { client, win } = await startHarness();

    await expect(client.readResource({ uri: URIS.report })).rejects.toMatchObject({
      code: -32603,
      data: {
        code: 'NOT_AVAILABLE',
        message: 'The chart has no strategy',
        // How to get one.
        hint: expect.stringMatching(/pine_new.*strategy.*pine_compile.*addToChart/s) as string,
      },
    });
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('reads the results of the active strategy', async () => {
    const { client, win } = await startHarness(withStudies(fixture, SAMPLE_STRATEGY));

    const resource = await readJson(client, URIS.report);
    const tool = await callTool(client, 'strategy_get_results');

    expect(resource).toStrictEqual(dataOf(tool));
    expect(resource).toMatchObject({
      strategy: { id: 'STRAT01', name: 'RSI Strategy' },
      currency: 'USD',
      initialCapital: 10_000,
      performance: { all: { netProfit: 155, totalTrades: 3 } },
    });
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('names the strategies when there are several and none is active', async () => {
    const { client } = await startHarness(withStudies(fixture, SAMPLE_STRATEGY, SECOND_STRATEGY));

    // The client's mistake, in JSON-RPC terms: it should have said which strategy.
    await expect(client.readResource({ uri: URIS.report })).rejects.toMatchObject({
      code: -32602,
      data: {
        code: 'INVALID_INPUT',
        details: { ids: ['STRAT01', 'STRAT02'] },
        hint: expect.stringMatching(/studyId/) as string,
      },
    });
  });
});

describe('the watchlist resource', () => {
  test('the watchlist/active resource equals watchlist_get without listId and is absent without that tool', async () => {
    const { client, win } = await startHarness();
    const withoutGet = await startOffline({ toolPatterns: ['watchlist_list', 'watchlist_add*'] });
    const getOnly = await startOffline({ toolPatterns: ['watchlist_get'] });

    const resource = await readJson(client, URIS.watchlist);
    const tool = await callTool(client, 'watchlist_get');

    expect(resource).toStrictEqual(dataOf(tool));
    expect(resource).toEqual({
      id: '101',
      name: 'Fixture List',
      editable: true,
      symbols: ['NASDAQ:AAPL', 'NASDAQ:MSFT', 'BINANCE:BTCUSDT'],
      sections: [
        { name: 'Tech', symbols: ['NASDAQ:AAPL', 'NASDAQ:MSFT'] },
        { name: 'Crypto', symbols: ['BINANCE:BTCUSDT'] },
      ],
    });
    // Reading it changed nothing: the store was only loaded, once, as the watchlist panel loads it.
    expect(inspectFakeWindow(win).callsTo('symbolListBackend.getCustomWatchLists')).toEqual([[]]);
    expect(
      inspectFakeWindow(win)
        .calls.map(({ name }) => name)
        .filter((name) => /^symbolListBackend\.(add|remove)/.test(name)),
    ).toEqual([]);
    // A server with no resource to offer has no resources at all.
    expect(withoutGet.getServerCapabilities()?.resources).toBeUndefined();
    await expect(withoutGet.readResource({ uri: URIS.watchlist })).rejects.toThrow();
    expect((await getOnly.listResources()).resources.map(({ uri }) => uri)).toEqual([
      URIS.watchlist,
    ]);
  });

  test('the watchlist resource fails NOT_AVAILABLE while the symbol list service is not set up', async () => {
    const win = createFakeTvWindow(fixture, { watchlists: { withoutService: true } });
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
    const client = await connect(server);

    await expect(client.readResource({ uri: URIS.watchlist })).rejects.toMatchObject({
      code: -32603,
      data: {
        code: 'NOT_AVAILABLE',
        hint: expect.stringContaining('ui_open_panel') as string,
      },
    });
  });
});

test.each([URIS.ohlcv, URIS.source, URIS.report, URIS.watchlist])(
  'the resource %s fails with the code of the failure when TradingView is down',
  async (uri) => {
    const client = await startOffline();

    await expect(client.readResource({ uri })).rejects.toMatchObject({
      data: { code: 'CDP_UNREACHABLE' },
    });
  },
);
