import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CdpTargetInfo } from '../../../src/core/cdp/types.js';
import {
  ConnectionManager,
  type HealthReport,
  type PageHandle,
} from '../../../src/core/connection.js';
import { TvMcpError } from '../../../src/core/errors.js';
import { createLauncher, type Launcher } from '../../../src/core/launcher/launch.js';
import { SELECTORS } from '../../../src/core/tv/selectors.js';
import { createMcpServer } from '../../../src/server.js';
import {
  startFakeCdpServer,
  type FakeCdpServer,
  type FakeTarget,
} from '../../helpers/fake-cdp/server.js';
import { loadTargetsFixture } from '../../helpers/fake-cdp/targets.js';
import {
  createMachine,
  downReport,
  ENDPOINT,
  MAC_BINARY,
  readyReport,
  unfocusedReport,
  type FakeMachine,
} from '../../helpers/fake-machine.js';
import { createFakeDomWindow, fakeElement, type FakeElement } from '../../helpers/fake-tv/dom.js';
import { loadTvFixture } from '../../helpers/fake-tv/fixture.js';
import { createFakeTvWindow, inspectFakeWindow } from '../../helpers/fake-tv/window.js';
import { callTool, connectInMemoryClient, textOf } from '../../helpers/mcp-client.js';
import {
  quietLogger,
  refusingLauncher,
  testConfig,
  unreachableConnection,
  unreachableConnectionDeps,
} from '../../helpers/tool-context.js';

// Nothing in this file may run a real program or start TradingView: the machine this suite runs on
// may have one open. The launcher is always one over a fake machine, and this is the second lock,
// so that even a mistake in the wiring fails the test instead of starting something.
vi.mock('node:child_process', () => ({
  spawn: () => {
    throw new Error('A test tried to start a real program with spawn');
  },
  execFile: () => {
    throw new Error('A test tried to start a real program with execFile');
  },
}));

const fixture = loadTvFixture();
const CHART_ID = 'BBB144A7827AE55CBA0E74986FC9574C';
const TAB_A = 'A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1';
const TAB_B = 'B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2';

// Everything a test starts is closed here, newest first, so that a client goes before its server and
// a connection manager before the fake app it talks to.
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
  app: FakeCdpServer;
}

interface HarnessOptions {
  // The window of the chart tab. By default a booted chart.
  win?: object;
  // What the debug port lists. By default the target list of the app, with `win` on its chart tab.
  targets?: FakeTarget[];
  launcher?: Launcher;
}

// The real server over the real adapters, against a fake debug port.
async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const win = options.win ?? createFakeTvWindow(fixture);
  const app = await startFakeCdpServer({
    targets: options.targets ?? loadTargetsFixture({ chartWindow: () => win }),
  });
  cleanups.push(() => app.close());
  const { server, ctx } = createMcpServer(testConfig({ cdpPort: app.port, callTimeoutMs: 5000 }), {
    launcher: options.launcher ?? refusingLauncher(),
    logger: quietLogger,
  });
  cleanups.push(() => ctx.connection.close());
  return { client: await connect(server), app };
}

// The server of a machine where nothing answers on the debug port.
async function startOffline(launcher: Launcher = refusingLauncher()): Promise<Client> {
  const { server } = createMcpServer(testConfig(), {
    connection: unreachableConnection(),
    launcher,
    logger: quietLogger,
  });
  return connect(server);
}

function launcherOn(machine: FakeMachine): Launcher {
  return createLauncher({
    install: machine.deps,
    spawn: machine.spawn,
    health: machine.health,
    config: testConfig(),
    sleep: machine.sleep,
  });
}

function chartTab(id: string, win: object): FakeTarget {
  return {
    id,
    type: 'page',
    title: 'Live stock, index, futures, Forex and Bitcoin charts on TradingView',
    url: `https://www.tradingview.com/chart/${id.slice(0, 8)}/`,
    behavior: 'page',
    window: () => win,
  };
}

// The target list of the app with its one chart tab replaced by `tabs`.
function appWith(tabs: FakeTarget[]): FakeTarget[] {
  return [...loadTargetsFixture().filter(({ id }) => id !== CHART_ID), ...tabs];
}

const dataOf = (result: { structuredContent?: unknown }): unknown =>
  (result.structuredContent as { data?: unknown } | undefined)?.data;

const warningsOf = (result: { structuredContent?: unknown }): unknown =>
  (result.structuredContent as { meta?: { warnings?: unknown } } | undefined)?.meta?.warnings;

describe('app_health', () => {
  test('app_health returns cdp, chart and app sections', async () => {
    const { client, app } = await startHarness();

    const result = await callTool(client, 'app_health');

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toStrictEqual({
      ok: true,
      data: {
        cdp: {
          reachable: true,
          endpoint: `http://127.0.0.1:${String(app.port)}`,
          browser: 'Chrome/146.0.7680.216',
          userAgent: expect.stringContaining('TradingView/3.4.1') as string,
        },
        chart: { found: true, tabs: 1, url: 'https://www.tradingview.com/chart/FIXTURE1/' },
        app: { ready: true, connected: true, buildTime: fixture.buildTime },
        // What the shared fake window offers: the replay and Pine editor APIs are not modeled.
        capabilities: {
          tradingViewApi: true,
          activeChart: true,
          chartModel: true,
          replayApi: false,
          pineEditorApi: false,
          webpackRegistry: true,
          tvd: true,
          buildTime: fixture.buildTime,
        },
      },
      meta: { via: 'cdp', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(JSON.parse(textOf(result))).toStrictEqual(result.structuredContent);
  });

  test('app_health returns CDP_UNREACHABLE as data when TradingView is down', async () => {
    const client = await startOffline();

    const result = await callTool(client, 'app_health');

    // A report, so it succeeds: the problem is what it reports.
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toStrictEqual({
      ok: true,
      data: {
        cdp: { reachable: false, endpoint: 'http://127.0.0.1:9' },
        chart: { found: false, tabs: 0 },
        app: { ready: false },
        capabilities: null,
      },
      meta: { via: 'cdp', durationMs: expect.any(Number) as number, warnings: [] },
    });
  });

  test('app_health reports a page whose app has not booted', async () => {
    const win = createFakeTvWindow(fixture, { withoutApi: true });
    const { client } = await startHarness({ win });

    const result = await callTool(client, 'app_health');

    expect(dataOf(result)).toMatchObject({
      chart: { found: true, tabs: 1 },
      app: { ready: false, buildTime: fixture.buildTime },
      capabilities: {
        tradingViewApi: false,
        activeChart: false,
        chartModel: false,
        webpackRegistry: true,
        tvd: true,
      },
    });
    expect(warningsOf(result)).toEqual([]);
  });

  test('app_health says that the app lost its connection', async () => {
    const win = createFakeTvWindow(fixture);
    inspectFakeWindow(win).state.connected = false;
    const { client } = await startHarness({ win });

    const result = await callTool(client, 'app_health');

    expect(dataOf(result)).toMatchObject({
      app: { ready: false, connected: false },
      capabilities: { tradingViewApi: true },
    });
  });

  test('app_health asks for one tab to be focused when several are open and none is in front', async () => {
    const hidden = (id: string) =>
      chartTab(id, createFakeTvWindow(fixture, { visibilityState: 'hidden' }));
    const { client } = await startHarness({ targets: appWith([hidden(TAB_A), hidden(TAB_B)]) });

    const result = await callTool(client, 'app_health');

    expect(result.isError).not.toBe(true);
    expect(dataOf(result)).toStrictEqual({
      cdp: expect.objectContaining({ reachable: true }) as unknown,
      chart: { found: true, tabs: 2 },
      app: { ready: false },
      capabilities: null,
    });
    expect(warningsOf(result)).toEqual([expect.stringMatching(/focus .*TradingView tab/i)]);
    // It is not the app that is starting, so the warning must not say so.
    expect(JSON.stringify(warningsOf(result))).not.toMatch(/start|launch|wait/i);
  });

  test('app_health reads the tab in front when several are open', async () => {
    const visible = createFakeTvWindow(fixture);
    const hidden = createFakeTvWindow(fixture, { visibilityState: 'hidden' });
    const { client } = await startHarness({
      targets: appWith([chartTab(TAB_A, hidden), chartTab(TAB_B, visible)]),
    });

    const result = await callTool(client, 'app_health');

    expect(dataOf(result)).toMatchObject({
      chart: { found: true, tabs: 2, url: expect.stringContaining(TAB_B.slice(0, 8)) as string },
      app: { ready: true },
      capabilities: { tradingViewApi: true },
    });
    expect(warningsOf(result)).toEqual([]);
  });

  test('app_health reports a debug port that lists no chart tab', async () => {
    const { client } = await startHarness({ targets: appWith([]) });

    const result = await callTool(client, 'app_health');

    expect(dataOf(result)).toMatchObject({
      cdp: { reachable: true },
      chart: { found: false, tabs: 0 },
      app: { ready: false },
      capabilities: null,
    });
    expect(warningsOf(result)).toEqual([]);
  });

  test('app_health only reads, so the page is left as it was', async () => {
    const win = createFakeTvWindow(fixture);
    const { client } = await startHarness({ win });

    await callTool(client, 'app_health');

    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  // Stands in for a connection manager that learned the state of the app but cannot read the
  // page: the health report is whatever the test scripts, and the chart page fails.
  class ScriptedConnection extends ConnectionManager {
    constructor(
      private readonly report: HealthReport,
      private readonly readChartPage: () => Promise<PageHandle>,
    ) {
      super(unreachableConnectionDeps());
    }

    override health(): Promise<HealthReport> {
      return Promise.resolve(this.report);
    }

    override chartPage(): Promise<PageHandle> {
      return this.readChartPage();
    }
  }

  async function startScripted(
    report: HealthReport,
    page: () => Promise<PageHandle>,
  ): Promise<Client> {
    const { server } = createMcpServer(testConfig(), {
      connection: new ScriptedConnection(report, page),
      launcher: refusingLauncher(),
      logger: quietLogger,
    });
    return connect(server);
  }

  test.each([
    ['TIMEOUT', new TvMcpError('TIMEOUT', 'The page did not answer')],
    ['CDP_UNREACHABLE', new TvMcpError('CDP_UNREACHABLE', 'The tab went away')],
    ['PAGE_EVALUATION_FAILED', new TvMcpError('PAGE_EVALUATION_FAILED', 'Page said: private text')],
  ])(
    'app_health reports null capabilities and the code when the page fails with %s',
    async (code, failure) => {
      const client = await startScripted(readyReport(), () => Promise.reject(failure));

      const result = await callTool(client, 'app_health');

      expect(result.isError).not.toBe(true);
      expect(dataOf(result)).toMatchObject({ cdp: { reachable: true }, capabilities: null });
      expect(warningsOf(result)).toEqual([expect.stringContaining(code)]);
      // What a page said never goes into a warning.
      expect(JSON.stringify(result.structuredContent)).not.toContain('private text');
    },
  );

  test('app_health does not ask the page again when the report already says that no tab is chosen', async () => {
    const page = vi.fn<() => Promise<PageHandle>>();
    const client = await startScripted(unfocusedReport(3), page);

    const result = await callTool(client, 'app_health');

    expect(page).not.toHaveBeenCalled();
    expect(dataOf(result)).toMatchObject({ chart: { tabs: 3 }, capabilities: null });
    expect(warningsOf(result)).toHaveLength(1);
  });

  test('app_health lets an unexpected failure of the page through as INTERNAL', async () => {
    const client = await startScripted(readyReport(), () =>
      Promise.reject(new Error('ENOENT: /Users/someone/private/state.json')),
    );

    const result = await callTool(client, 'app_health');

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL', message: 'Unexpected error' },
    });
    expect(textOf(result)).not.toContain('private');
  });
});

describe('app_launch', () => {
  test('app_launch maps RESTART_REQUIRED to an error result', async () => {
    const machine = createMachine({ running: true, reports: [downReport()] });
    const client = await startOffline(launcherOn(machine));

    const result = await callTool(client, 'app_launch');

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: 'RESTART_REQUIRED',
        message: expect.stringContaining('without the debug port') as string,
        hint: expect.stringContaining('restart: true') as string,
      },
      meta: { durationMs: expect.any(Number) as number },
    });
    // It looked and did nothing: the app was not asked to quit and nothing was started.
    expect(machine.log).toEqual(['health', 'lookup']);
  });

  test.each([
    ['leaves confirm out', { restart: true }],
    ['sets confirm to false', { restart: true, confirm: false }],
  ])(
    'app_launch asks for confirmation and touches nothing when it restarts and %s',
    async (_case, args) => {
      const machine = createMachine({ running: true, reports: [downReport()] });
      const client = await startOffline(launcherOn(machine));

      const result = await callTool(client, 'app_launch', args);

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: {
          code: 'CONFIRMATION_REQUIRED',
          hint: expect.stringContaining('confirm: true') as string,
        },
      });
      const { hint } = (result.structuredContent as { error: { hint: string } }).error;
      expect(hint).toMatch(/closes? .*TradingView|reopens/i);
      expect(hint).toMatch(/unsaved/i);
      // Not even a look at the machine: the answer needs none.
      expect(machine.log).toEqual([]);
    },
  );

  test('app_launch quits and reopens TradingView when the restart is confirmed', async () => {
    const machine = createMachine({
      running: true,
      reports: [downReport(), downReport(), readyReport()],
    });
    const client = await startOffline(launcherOn(machine));

    const result = await callTool(client, 'app_launch', { restart: true, confirm: true });

    expect(result.structuredContent).toStrictEqual({
      ok: true,
      data: { status: 'restarted', executable: MAC_BINARY, endpoint: ENDPOINT, waitedMs: 500 },
      meta: { via: 'local', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(machine.log.filter((entry) => /^(quit|spawn)/.test(entry))).toEqual([
      'quit osascript',
      `spawn ${MAC_BINARY} --remote-debugging-port=9`,
    ]);
  });

  test('app_launch starts TradingView when it is not running', async () => {
    const machine = createMachine({ running: false, reports: [downReport(), readyReport()] });
    const client = await startOffline(launcherOn(machine));

    const result = await callTool(client, 'app_launch');

    expect(dataOf(result)).toEqual({
      status: 'launched',
      executable: MAC_BINARY,
      endpoint: ENDPOINT,
      waitedMs: expect.any(Number) as number,
    });
    expect(machine.spawned).toEqual([{ command: MAC_BINARY, args: ['--remote-debugging-port=9'] }]);
  });

  test.each([
    ['plainly', {}],
    ['with a confirmed restart', { restart: true, confirm: true }],
  ])('app_launch leaves TradingView alone when its debug port answers, %s', async (_case, args) => {
    const machine = createMachine({ running: true, reports: [readyReport()] });
    const client = await startOffline(launcherOn(machine));

    const result = await callTool(client, 'app_launch', args);

    expect(dataOf(result)).toEqual({
      status: 'already-running',
      executable: null,
      endpoint: ENDPOINT,
      waitedMs: expect.any(Number) as number,
    });
    expect(machine.spawned).toEqual([]);
    expect(machine.log).toEqual(['health']);
  });

  test('app_launch relays the port to the launcher, which only accepts the configured one', async () => {
    const machine = createMachine({ reports: [downReport()] });
    const client = await startOffline(launcherOn(machine));

    const result = await callTool(client, 'app_launch', { port: 9333 });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: 'INVALID_INPUT',
        hint: expect.stringContaining('TV_CDP_PORT') as string,
        details: { port: 9333, configuredPort: 9 },
      },
    });
    expect(machine.log).toEqual([]);
  });

  test('app_launch starts the app on the configured port when the port is given and equal', async () => {
    const machine = createMachine({ reports: [downReport(), readyReport()] });
    const client = await startOffline(launcherOn(machine));

    const result = await callTool(client, 'app_launch', { port: 9 });

    expect(result.isError).not.toBe(true);
    expect(machine.spawned).toEqual([{ command: MAC_BINARY, args: ['--remote-debugging-port=9'] }]);
  });

  test('app_launch reports TV_NOT_INSTALLED with the places it looked in', async () => {
    const machine = createMachine({ files: [], reports: [downReport()] });
    const client = await startOffline(launcherOn(machine));

    const result = await callTool(client, 'app_launch');

    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: 'TV_NOT_INSTALLED',
        hint: expect.stringContaining('TV_APP_PATH') as string,
        details: { checked: expect.arrayContaining([MAC_BINARY]) as string[] },
      },
    });
    expect(machine.spawned).toEqual([]);
  });

  test('app_launch gives up with LAUNCH_FAILED and a hint that needs no repository', async () => {
    const machine = createMachine({ reports: [downReport()] });
    const client = await startOffline(launcherOn(machine));

    const result = await callTool(client, 'app_launch');

    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: 'LAUNCH_FAILED',
        hint: expect.stringContaining('--remote-debugging-port=9') as string,
      },
    });
    const { hint } = (result.structuredContent as { error: { hint: string } }).error;
    expect(hint).not.toMatch(/docs\/|\.md/);
  });

  test.each([
    ['0', { port: 0 }],
    ['65536', { port: 65536 }],
    ['9222.5', { port: 9222.5 }],
  ])('app_launch refuses the port %s before it looks at the machine', async (_label, args) => {
    const machine = createMachine({ reports: [downReport()] });
    const client = await startOffline(launcherOn(machine));

    const result = await callTool(client, 'app_launch', args);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('port');
    expect(machine.log).toEqual([]);
  });
});

describe('app_discover', () => {
  function discovering(found: {
    executable: string | null;
    running: boolean;
    cdpReachable: boolean;
  }): Launcher {
    return { ...refusingLauncher(), discover: () => Promise.resolve(found) };
  }

  test('app_discover lists classified targets', async () => {
    const launcher = discovering({ executable: MAC_BINARY, running: true, cdpReachable: true });
    const { client } = await startHarness({ launcher });

    const result = await callTool(client, 'app_discover');

    expect(result.isError).not.toBe(true);
    const data = dataOf(result) as { targets: { id: string; kind: string }[] };
    expect(data).toMatchObject({ executable: MAC_BINARY, running: true, cdpReachable: true });
    // In the order the debug port lists them, the blank and helper pages of the app included.
    expect(data.targets.map(({ id, kind }) => [id, kind])).toEqual([
      ['EE67363DAA56C9940A709061CFAA2FFF', 'window-chrome'],
      [CHART_ID, 'chart'],
      ['45FA12C67FCC102BC635696179137865', 'other'],
      ['359029838B634FA51337C41A946372CD', 'other'],
      ['A0290DCF69763ECAA55FA54875AD50A1', 'other'],
      ['0621E0BEA8DA2CEEE3C6E3AFFD3C3229', 'helper'],
      ['D4FA899CB58B76FCEDDAC2E1E63735B2', 'blank'],
      ['B8F925F86CC032DD97DED7C12AB73A28', 'helper'],
      ['ABC65E8C0B5768A7D97D910867C78382', 'helper'],
      ['80A80E86AF3E47B46C0E0C0A748CFC57', 'blank'],
      ['98698293B7D146D1E80957D68A04BDD7', 'other'],
    ]);
    expect(data.targets).toContainEqual({
      id: CHART_ID,
      kind: 'chart',
      title: 'Live stock, index, futures, Forex and Bitcoin charts on TradingView',
      url: 'https://www.tradingview.com/chart/FIXTURE1/',
    });
    expect(warningsOf(result)).toEqual([]);
  });

  test('app_discover gives each target an id, a kind, a title and a url, and nothing else', async () => {
    const launcher = discovering({ executable: MAC_BINARY, running: true, cdpReachable: true });
    const { client } = await startHarness({ launcher });

    const result = await callTool(client, 'app_discover');

    const { targets } = dataOf(result) as { targets: object[] };
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(Object.keys(target)).toEqual(['id', 'kind', 'title', 'url']);
    }
  });

  test('app_discover never hands out the debugging addresses of the targets', async () => {
    const launcher = discovering({ executable: MAC_BINARY, running: true, cdpReachable: true });
    const { client, app } = await startHarness({ launcher });

    const result = await callTool(client, 'app_discover');

    // The debug port does list them, so a copy of a listed target would carry one.
    const listing = (await (
      await fetch(`http://127.0.0.1:${String(app.port)}/json/list`)
    ).json()) as {
      webSocketDebuggerUrl?: string;
    }[];
    expect(listing.every((entry) => typeof entry.webSocketDebuggerUrl === 'string')).toBe(true);
    const text = JSON.stringify(result);
    expect(text).not.toContain('webSocketDebuggerUrl');
    expect(text).not.toContain('ws://');
    expect(text).not.toContain('devtoolsFrontendUrl');
  });

  test('app_discover lists the targets without connecting to any of them', async () => {
    const launcher = discovering({ executable: MAC_BINARY, running: true, cdpReachable: true });
    const { client, app } = await startHarness({ launcher });

    await callTool(client, 'app_discover');

    expect(app.connectionCount()).toBe(0);
  });

  test('app_discover reports the install and the process when the debug port does not answer', async () => {
    const launcher = discovering({ executable: MAC_BINARY, running: true, cdpReachable: false });
    const client = await startOffline(launcher);

    const result = await callTool(client, 'app_discover');

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toStrictEqual({
      ok: true,
      data: { executable: MAC_BINARY, running: true, cdpReachable: false, targets: [] },
      meta: {
        via: 'cdp',
        durationMs: expect.any(Number) as number,
        warnings: [expect.stringMatching(/debug port.*app_launch/is)],
      },
    });
    // TradingView runs, so a plain launch would be refused: the way out is a confirmed restart.
    expect(warningsOf(result)).toEqual([expect.stringMatching(/restart: true.*confirm: true/s)]);
  });

  test('app_discover tells to start TradingView when it is installed and not running', async () => {
    const launcher = discovering({ executable: MAC_BINARY, running: false, cdpReachable: false });
    const client = await startOffline(launcher);

    const result = await callTool(client, 'app_discover');

    expect(warningsOf(result)).toEqual([expect.stringMatching(/not running.*Call app_launch/s)]);
  });

  test('app_discover reports TradingView as not installed and not running', async () => {
    const launcher = discovering({ executable: null, running: false, cdpReachable: false });
    const client = await startOffline(launcher);

    const result = await callTool(client, 'app_discover');

    expect(dataOf(result)).toEqual({
      executable: null,
      running: false,
      cdpReachable: false,
      targets: [],
    });
    expect(warningsOf(result)).toEqual([expect.stringMatching(/not found.*TV_APP_PATH/s)]);
  });

  // A debug port whose listing fails with whatever the test says.
  class FailingListing extends ConnectionManager {
    constructor(private readonly failure: Error) {
      super(unreachableConnectionDeps());
    }

    override targets(): Promise<CdpTargetInfo[]> {
      return Promise.reject(this.failure);
    }
  }

  async function startFailingListing(failure: Error): Promise<Client> {
    const { server } = createMcpServer(testConfig(), {
      connection: new FailingListing(failure),
      launcher: discovering({ executable: MAC_BINARY, running: true, cdpReachable: true }),
      logger: quietLogger,
    });
    return connect(server);
  }

  test('app_discover reports a debug port that stalls like one that does not answer', async () => {
    // It answers the version and then stalls on the listing, which is not the same as a closed port.
    const client = await startFailingListing(
      new TvMcpError('TIMEOUT', 'Listing the targets timed out'),
    );

    const result = await callTool(client, 'app_discover');

    expect(result.isError).not.toBe(true);
    expect(dataOf(result)).toMatchObject({ targets: [] });
    expect(warningsOf(result)).toEqual([
      expect.stringMatching(/debug port did not list.*in time/s),
    ]);
  });

  test('app_discover lets a failure that is not about the debug port through', async () => {
    const client = await startFailingListing(new Error('ENOENT: /Users/someone/private/state'));

    const result = await callTool(client, 'app_discover');

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL', message: 'Unexpected error' },
    });
    expect(textOf(result)).not.toContain('private');
  });

  test('app_discover lets the failure of the launcher through', async () => {
    const launcher: Launcher = {
      ...refusingLauncher(),
      discover: () =>
        Promise.reject(
          new TvMcpError('LAUNCH_FAILED', 'Could not tell whether TradingView is running', {
            hint: 'Check that pgrep works on this machine.',
          }),
        ),
    };
    const { client } = await startHarness({ launcher });

    const result = await callTool(client, 'app_discover');

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'LAUNCH_FAILED', hint: 'Check that pgrep works on this machine.' },
    });
  });
});

describe('app_get_ui_state', () => {
  const button = (selector: string, pressed: boolean): FakeElement =>
    fakeElement({
      tag: 'button',
      matches: [selector],
      attributes: { 'aria-pressed': String(pressed) },
    });

  // A chart page with a DOM: the right panel is open on the watchlist, the bottom panel is closed,
  // and the dialog to search indicators is open over the chart.
  function chartWithDom(): object {
    return createFakeDomWindow([
      fakeElement({
        matches: [SELECTORS.widgets.widgetBar],
        children: [fakeElement({ matches: [SELECTORS.widgets.watchlist] })],
      }),
      fakeElement({
        matches: [SELECTORS.regions.bottomArea],
        rect: { x: 0, y: 0, width: 0, height: 0 },
      }),
      fakeElement({
        matches: [SELECTORS.regions.overlapManagerRoot],
        children: [
          fakeElement({ attributes: { 'data-name': 'indicators-dialog', role: 'dialog' } }),
        ],
      }),
      button(SELECTORS.header.replay, true),
      button(SELECTORS.header.fullscreen, false),
    ]);
  }

  test('app_get_ui_state reads which parts of the interface are open', async () => {
    const { client } = await startHarness({ win: chartWithDom() });

    const result = await callTool(client, 'app_get_ui_state');

    expect(result.structuredContent).toStrictEqual({
      ok: true,
      data: {
        rightPanel: { open: true, activeWidget: 'watchlist' },
        bottomPanelOpen: false,
        dialogs: ['indicators-dialog'],
        fullscreen: false,
        replayToolbarVisible: true,
        pineEditorOpen: false,
      },
      meta: { via: 'dom', durationMs: expect.any(Number) as number, warnings: [] },
    });
  });

  test('app_get_ui_state reports NOT_AVAILABLE when the page has no DOM', async () => {
    const { client } = await startHarness();

    const result = await callTool(client, 'app_get_ui_state');

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'NOT_AVAILABLE', hint: expect.stringContaining('TradingView') as string },
    });
  });

  test('app_get_ui_state asks for one tab to be focused when several are open and none is in front', async () => {
    const hidden = (id: string) =>
      chartTab(id, createFakeTvWindow(fixture, { visibilityState: 'hidden' }));
    const { client } = await startHarness({ targets: appWith([hidden(TAB_A), hidden(TAB_B)]) });

    const result = await callTool(client, 'app_get_ui_state');

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: 'TARGET_NOT_FOUND', hint: expect.stringMatching(/focus/i) as string },
    });
  });

  test('app_get_ui_state fails with CDP_UNREACHABLE when TradingView is down', async () => {
    const client = await startOffline();

    const result = await callTool(client, 'app_get_ui_state');

    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'CDP_UNREACHABLE' },
    });
  });
});

describe('app_reconnect', () => {
  test('app_reconnect drops cached sessions', async () => {
    const win = createFakeTvWindow(fixture);
    const { client, app } = await startHarness({ win });
    await callTool(client, 'app_health');
    expect(app.openConnectionCount(CHART_ID)).toBe(1);

    const result = await callTool(client, 'app_reconnect');

    expect(result.structuredContent).toStrictEqual({
      ok: true,
      data: { reset: true, reloadRequested: false },
      meta: { via: 'local', durationMs: expect.any(Number) as number, warnings: [] },
    });
    await expect.poll(() => app.openConnectionCount()).toBe(0);
    // Nothing was done to the page, and nothing is opened until a call needs it.
    expect(inspectFakeWindow(win).callsTo('TVD.reloadTab')).toEqual([]);
    expect(app.connectionCount()).toBe(1);
    const health = await callTool(client, 'app_health');
    expect(dataOf(health)).toMatchObject({ app: { ready: true } });
    expect(app.connectionCount(CHART_ID)).toBe(2);
  });

  test('app_reconnect with reloadTab requires confirm', async () => {
    const win = createFakeTvWindow(fixture);
    const { client, app } = await startHarness({ win });
    await callTool(client, 'app_health');
    const sentBefore = app.calls.length;

    for (const args of [{ reloadTab: true }, { reloadTab: true, confirm: false }]) {
      const result = await callTool(client, 'app_reconnect', args);

      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(result.structuredContent, JSON.stringify(args)).toMatchObject({
        ok: false,
        error: {
          code: 'CONFIRMATION_REQUIRED',
          hint: expect.stringContaining('confirm: true') as string,
        },
      });
      const { hint } = (result.structuredContent as { error: { hint: string } }).error;
      expect(hint).toMatch(/unsaved Pine Editor changes/);
    }

    // Nothing happened: the page was not asked to reload and was sent nothing at all.
    expect(inspectFakeWindow(win).calls).toEqual([]);
    expect(app.calls).toHaveLength(sentBefore);
    // And the sessions were not dropped, or the next call would have connected anew.
    const health = await callTool(client, 'app_health');
    expect(dataOf(health)).toMatchObject({ app: { ready: true } });
    expect(app.connectionCount(CHART_ID)).toBe(1);
    expect(app.openConnectionCount(CHART_ID)).toBe(1);
  });

  test('app_reconnect with reloadTab asks for confirmation before it looks for TradingView', async () => {
    const client = await startOffline();

    const result = await callTool(client, 'app_reconnect', { reloadTab: true });

    // Not CDP_UNREACHABLE: the answer needs no look at the app.
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'CONFIRMATION_REQUIRED' },
    });
  });

  test('app_reconnect needs no confirmation to drop the sessions, and ignores one', async () => {
    const win = createFakeTvWindow(fixture);
    const { client, app } = await startHarness({ win });
    await callTool(client, 'app_health');

    const result = await callTool(client, 'app_reconnect', { confirm: true });

    expect(dataOf(result)).toEqual({ reset: true, reloadRequested: false });
    expect(inspectFakeWindow(win).calls).toEqual([]);
    await expect.poll(() => app.openConnectionCount()).toBe(0);
  });

  test('app_reconnect with reloadTab and confirm calls TVD.reloadTab', async () => {
    const win = createFakeTvWindow(fixture);
    const { client, app } = await startHarness({ win });
    await callTool(client, 'app_health');

    const result = await callTool(client, 'app_reconnect', { reloadTab: true, confirm: true });

    expect(inspectFakeWindow(win).callsTo('TVD.reloadTab')).toEqual([[]]);
    expect(inspectFakeWindow(win).calls).toHaveLength(1);
    expect(result.structuredContent).toStrictEqual({
      ok: true,
      data: { reset: true, reloadRequested: true },
      meta: {
        via: 'internal',
        durationMs: expect.any(Number) as number,
        warnings: [expect.stringContaining('app_health')],
      },
    });
    // The sessions went with it: the page is reloading under them.
    await expect.poll(() => app.openConnectionCount()).toBe(0);
  });

  test('app_reconnect with reloadTab still drops the sessions when the page cannot reload', async () => {
    const win = createFakeTvWindow(fixture);
    Reflect.deleteProperty(win, 'TVD');
    const { client, app } = await startHarness({ win });
    await callTool(client, 'app_health');
    expect(app.openConnectionCount()).toBe(1);

    const result = await callTool(client, 'app_reconnect', { reloadTab: true, confirm: true });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_UNAVAILABLE' },
    });
    await expect.poll(() => app.openConnectionCount()).toBe(0);
  });

  test('app_reconnect resets even when TradingView is down', async () => {
    const client = await startOffline();

    const result = await callTool(client, 'app_reconnect');

    expect(dataOf(result)).toEqual({ reset: true, reloadRequested: false });
  });

  test('app_reconnect with reloadTab fails with CDP_UNREACHABLE when TradingView is down', async () => {
    const client = await startOffline();

    const result = await callTool(client, 'app_reconnect', { reloadTab: true, confirm: true });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'CDP_UNREACHABLE' },
    });
  });

  test('app_reconnect with reloadTab asks for one tab to be focused when several are open', async () => {
    const hidden = (id: string) =>
      chartTab(id, createFakeTvWindow(fixture, { visibilityState: 'hidden' }));
    const { client } = await startHarness({ targets: appWith([hidden(TAB_A), hidden(TAB_B)]) });

    const result = await callTool(client, 'app_reconnect', { reloadTab: true, confirm: true });

    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'TARGET_NOT_FOUND', hint: expect.stringMatching(/focus/i) as string },
    });
  });
});

describe('the app tools as a client sees them', () => {
  test('are listed with their annotations, descriptions and described inputs', async () => {
    const { client } = await startHarness();

    const { tools } = await client.listTools();

    const app = tools.filter(({ name }) => name.startsWith('app_'));
    expect(app.map(({ name }) => name)).toEqual([
      'app_launch',
      'app_health',
      'app_discover',
      'app_get_ui_state',
      'app_reconnect',
    ]);
    for (const tool of app) {
      expect(tool.annotations?.openWorldHint, tool.name).toBe(false);
      expect(tool.description?.length, tool.name).toBeGreaterThan(100);
      const properties = (tool.inputSchema.properties ?? {}) as Record<
        string,
        { description?: string }
      >;
      for (const [field, schema] of Object.entries(properties)) {
        expect(schema.description, `${tool.name}.${field}`).toBeTruthy();
      }
    }
    const launch = app.find(({ name }) => name === 'app_launch');
    expect(launch?.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        restart: { type: 'boolean', default: false },
        port: { type: 'integer', minimum: 1, maximum: 65535 },
        confirm: { type: 'boolean' },
      },
    });
    expect(launch?.inputSchema.required ?? []).toEqual([]);
    const reconnect = app.find(({ name }) => name === 'app_reconnect');
    expect(reconnect?.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        reloadTab: { type: 'boolean', default: false },
        confirm: { type: 'boolean' },
      },
    });
    expect(reconnect?.inputSchema.required ?? []).toEqual([]);
  });

  test('the readonly profile offers the tools of the app that only read', async () => {
    const { server } = createMcpServer(testConfig({ profile: 'readonly' }), {
      connection: unreachableConnection(),
      launcher: refusingLauncher(),
      logger: quietLogger,
    });
    const client = await connect(server);

    const { tools } = await client.listTools();

    expect(tools.map(({ name }) => name).filter((name) => name.startsWith('app_'))).toEqual([
      'app_health',
      'app_discover',
      'app_get_ui_state',
    ]);
  });
});
