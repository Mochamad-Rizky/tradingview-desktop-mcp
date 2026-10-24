import { loadConfig } from '../../../../src/config/load.js';
import type { Config } from '../../../../src/config/schema.js';
import { TvMcpError } from '../../../../src/core/errors.js';
import { buildLaunchArgs, createLauncher } from '../../../../src/core/launcher/launch.js';
import { failureOf } from '../../../helpers/failure-of.js';
import {
  ENDPOINT,
  MAC_BINARY,
  behindReport,
  connectingReport,
  createMachine,
  downReport,
  exitCode,
  noChartReport,
  otherBrowserReport,
  readyReport,
  unfocusedReport,
  type FakeMachine,
} from '../../../helpers/fake-machine.js';

// Nothing in this file may run a real program or start TradingView: the machine this suite runs on
// may have one open. Every dependency of the launcher is a fake, and this is the second lock, so
// that even a mistake in the wiring fails the test instead of starting something.
vi.mock('node:child_process', () => ({
  spawn: () => {
    throw new Error('A test tried to start a real program with spawn');
  },
  execFile: () => {
    throw new Error('A test tried to start a real program with execFile');
  },
}));

// The clock of the waiting is frozen, so that the time a launch reports is the time that its
// fake sleeps added up to, and not the milliseconds the test itself took.
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const USER_BINARY = '/Users/trader/Applications/TradingView.app/Contents/MacOS/TradingView';
const DEBUG_FLAG = '--remote-debugging-port=9222';

function configWith(env: Record<string, string> = {}): Config {
  return loadConfig({ argv: [], env }).config;
}

function launcherFor(machine: FakeMachine, config: Config = configWith()) {
  return createLauncher({
    install: machine.deps,
    spawn: machine.spawn,
    health: machine.health,
    config,
    sleep: machine.sleep,
  });
}

// The log with the length of the pauses left out, for tests about the order of the steps.
function steps(machine: FakeMachine): string[] {
  return machine.log.map((entry) => entry.replace(/^sleep \d+$/, 'sleep'));
}

function totalSleep(machine: FakeMachine): number {
  return machine.log.reduce((total, entry) => {
    const ms = /^sleep (\d+)$/.exec(entry)?.[1];
    return total + (ms === undefined ? 0 : Number(ms));
  }, 0);
}

describe('buildLaunchArgs', () => {
  test('buildLaunchArgs passes only the debug port', () => {
    const args = buildLaunchArgs(9222);

    expect(args).toEqual([DEBUG_FLAG]);
    expect(args).not.toContain('--options=clean');
    expect(args).not.toContain('--remote-debugging-address');
    // Nor in the form with a value.
    expect(args.some((arg) => /^--(options|remote-debugging-address)/.test(arg))).toBe(false);
  });

  test('buildLaunchArgs puts the port it is given in the flag', () => {
    expect(buildLaunchArgs(9333)).toEqual(['--remote-debugging-port=9333']);
    expect(buildLaunchArgs(1)).toEqual(['--remote-debugging-port=1']);
    expect(buildLaunchArgs(65535)).toEqual(['--remote-debugging-port=65535']);
  });

  test.each([
    ['zero, which would let the app pick a port that nobody can look up', 0],
    ['above 65535', 65536],
    ['negative', -9222],
    ['a fraction', 9222.5],
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ])('buildLaunchArgs refuses a port that is %s', async (_label, port) => {
    const error = await failureOf(Promise.resolve().then(() => buildLaunchArgs(port)));

    expect(error.code).toBe('INVALID_INPUT');
  });
});

describe('launch when the debug port already answers', () => {
  test('returns already-running without spawning when CDP is up', async () => {
    const machine = createMachine({ running: true, reports: [readyReport()] });

    const result = await launcherFor(machine).launch({ restart: false });

    expect(result).toEqual({
      status: 'already-running',
      executable: null,
      endpoint: ENDPOINT,
      waitedMs: 0,
    });
    // One look at the debug port and nothing else: no process lookup, no install lookup, no start.
    expect(machine.log).toEqual(['health']);
  });

  test('returns already-running even when restart is true, since the port is what a restart is for', async () => {
    const machine = createMachine({ running: true, reports: [readyReport()] });

    const result = await launcherFor(machine).launch({ restart: true });

    expect(result.status).toBe('already-running');
    expect(machine.log).toEqual(['health']);
  });

  test('returns already-running when the port answers but the app has no chart yet', async () => {
    const machine = createMachine({ running: true, reports: [noChartReport()] });

    const result = await launcherFor(machine).launch({ restart: false });

    expect(result.status).toBe('already-running');
    expect(machine.spawned).toEqual([]);
  });
});

// TradingView could not open its debug port while another browser holds it, so starting it would
// only leave it running without the port, and a restart would close it for nothing.
describe('launch when another browser holds the debug port', () => {
  test.each([false, true])(
    'refuses with CDP_UNREACHABLE and looks no further (restart %s)',
    async (restart) => {
      const machine = createMachine({ running: true, reports: [otherBrowserReport()] });

      const error = await failureOf(launcherFor(machine).launch({ restart }));

      expect(error.toPayload()).toStrictEqual({
        code: 'CDP_UNREACHABLE',
        message: `Another browser answers on the debug port at ${ENDPOINT}, not TradingView Desktop`,
        hint: expect.stringMatching(
          /another browser holds the debug port.*quit it.*TV_CDP_PORT/is,
        ) as string,
        details: { endpoint: ENDPOINT, browser: 'Chrome/134.0.0.0', otherBrowser: true },
      });
      // One look at the debug port: no process lookup, no quit, no start.
      expect(machine.log).toEqual(['health']);
    },
  );

  test('leaves the browser out of the details when the report does not name it', async () => {
    const report = otherBrowserReport();
    const machine = createMachine({
      reports: [{ ...report, cdp: { reachable: false, endpoint: ENDPOINT, otherBrowser: true } }],
    });

    const error = await failureOf(launcherFor(machine).launch({ restart: false }));

    expect(error.details).toStrictEqual({ endpoint: ENDPOINT, otherBrowser: true });
  });
});

describe('launch when TradingView is not running', () => {
  test('starts the app with the debug port and waits until it is ready', async () => {
    const machine = createMachine({
      reports: [downReport(), downReport(), connectingReport(), readyReport()],
    });

    const result = await launcherFor(machine).launch({ restart: false });

    expect(result).toEqual({
      status: 'launched',
      executable: MAC_BINARY,
      endpoint: ENDPOINT,
      waitedMs: 1000,
    });
    expect(machine.log).toEqual([
      'health',
      'lookup',
      `spawn ${MAC_BINARY} ${DEBUG_FLAG}`,
      'health',
      'sleep 500',
      'health',
      'sleep 500',
      'health',
    ]);
  });

  test('starts the binary inside the app bundle on macOS, never through open', async () => {
    const machine = createMachine({ reports: [downReport(), readyReport()] });

    await launcherFor(machine).launch({ restart: false });

    // `open -a TradingView --args ...` drops the arguments when the app is already running.
    expect(machine.spawned).toEqual([{ command: MAC_BINARY, args: [DEBUG_FLAG] }]);
    expect(machine.spawned[0]?.command).toMatch(/\.app\/Contents\/MacOS\/TradingView$/);
    expect(machine.programs.map(([command]) => command)).not.toContain('open');
  });

  test('puts the configured debug port in the arguments', async () => {
    const machine = createMachine({ reports: [downReport(), readyReport()] });

    await launcherFor(machine, configWith({ TV_CDP_PORT: '9333' })).launch({ restart: false });

    expect(machine.spawned).toEqual([
      { command: MAC_BINARY, args: ['--remote-debugging-port=9333'] },
    ]);
  });

  test('never hands the app anything but the debug port', async () => {
    const machine = createMachine({
      running: true,
      stays: 1,
      reports: [downReport(), readyReport()],
    });

    await launcherFor(machine).launch({ restart: true });

    for (const { args } of machine.spawned) {
      expect(args).toEqual([DEBUG_FLAG]);
    }
  });

  test('a restart that finds nothing running is a plain launch', async () => {
    const machine = createMachine({ running: false, reports: [downReport(), readyReport()] });

    const result = await launcherFor(machine).launch({ restart: true });

    expect(result.status).toBe('launched');
    expect(machine.log.some((entry) => entry.startsWith('quit'))).toBe(false);
  });

  test('starts the file that TV_APP_PATH names', async () => {
    const override = '/Volumes/Tools/TradingView';
    const machine = createMachine({ files: [override], reports: [downReport(), readyReport()] });

    const result = await launcherFor(machine, configWith({ TV_APP_PATH: override })).launch({
      restart: false,
    });

    expect(result.executable).toBe(override);
    expect(machine.spawned).toEqual([{ command: override, args: [DEBUG_FLAG] }]);
  });
});

describe('launch when TradingView runs without the debug port', () => {
  test('running without CDP and restart=false throws RESTART_REQUIRED, with a hint naming restart: true and launch --restart', async () => {
    const machine = createMachine({ running: true, reports: [downReport()] });

    const error = await failureOf(launcherFor(machine).launch({ restart: false }));

    expect(error.code).toBe('RESTART_REQUIRED');
    // The option of app_launch and the flag of the CLI, whichever the caller came through.
    expect(error.hint).toContain('app_launch with restart: true');
    expect(error.hint).toContain('tradingview-desktop-mcp launch --restart');
    expect(error.hint).toContain('one instance');
    // The app is left alone: nothing is closed and nothing is started.
    expect(machine.log).toEqual(['health', 'lookup']);
  });

  test('says that the app runs without the debug port before it looks for the install', async () => {
    const machine = createMachine({ running: true, files: [], reports: [downReport()] });

    const error = await failureOf(launcherFor(machine).launch({ restart: false }));

    expect(error.code).toBe('RESTART_REQUIRED');
  });

  test('restart quits, then spawns, then waits for readiness', async () => {
    const machine = createMachine({
      running: true,
      stays: 1,
      reports: [downReport(), downReport(), readyReport()],
    });

    const result = await launcherFor(machine).launch({ restart: true });

    expect(result.status).toBe('restarted');
    expect(result.executable).toBe(MAC_BINARY);
    expect(steps(machine)).toEqual([
      'health',
      'lookup',
      'quit osascript',
      'lookup',
      'sleep',
      'lookup',
      `spawn ${MAC_BINARY} ${DEBUG_FLAG}`,
      'health',
      'sleep',
      'health',
    ]);
  });

  test('starts the new instance only after the old process is gone', async () => {
    const machine = createMachine({
      running: true,
      stays: 3,
      reports: [downReport(), readyReport()],
    });

    await launcherFor(machine).launch({ restart: true });

    const spawnAt = machine.log.findIndex((entry) => entry.startsWith('spawn'));
    const lookupsBefore = machine.log.slice(0, spawnAt).filter((entry) => entry === 'lookup');
    // One lookup before the request, then one per check of the exit: 3 that still find it, 1 that
    // does not.
    expect(lookupsBefore).toHaveLength(5);
  });

  test('fails with LAUNCH_FAILED when the app does not exit, and starts nothing', async () => {
    const machine = createMachine({ running: true, stays: Infinity, reports: [downReport()] });

    const error = await failureOf(launcherFor(machine).launch({ restart: true }));

    expect(error.code).toBe('LAUNCH_FAILED');
    expect(error.message).toContain('did not exit');
    expect(machine.spawned).toEqual([]);
    // It asked once, politely, and did not try anything stronger.
    expect(new Set(machine.programs.map(([command]) => command))).toEqual(
      new Set(['pgrep', 'osascript']),
    );
  });

  test('starts nothing when the quit request is refused', async () => {
    const machine = createMachine({
      running: true,
      stays: Infinity,
      quitError: exitCode(1),
      reports: [downReport()],
    });

    const error = await failureOf(launcherFor(machine).launch({ restart: true }));

    expect(error.code).toBe('LAUNCH_FAILED');
    expect(machine.spawned).toEqual([]);
  });

  test('does not quit an app that it could not start again', async () => {
    const machine = createMachine({ running: true, files: [], reports: [downReport()] });

    const error = await failureOf(launcherFor(machine).launch({ restart: true }));

    expect(error.code).toBe('TV_NOT_INSTALLED');
    expect(machine.log.some((entry) => entry.startsWith('quit'))).toBe(false);
  });

  test('does not quit the app when TV_APP_PATH names a file that is not there', async () => {
    const machine = createMachine({ running: true, reports: [downReport()] });

    const error = await failureOf(
      launcherFor(machine, configWith({ TV_APP_PATH: '/Volumes/Tools/TradingView' })).launch({
        restart: true,
      }),
    );

    expect(error.code).toBe('TV_NOT_INSTALLED');
    expect(machine.log.some((entry) => entry.startsWith('quit'))).toBe(false);
  });

  test('checks the port before it closes anything', async () => {
    const machine = createMachine({ running: true, reports: [downReport()] });

    const error = await failureOf(launcherFor(machine).launch({ restart: true, port: 70000 }));

    expect(error.code).toBe('INVALID_INPUT');
    expect(machine.log).toEqual([]);
  });
});

describe('launch readiness', () => {
  test('fails with LAUNCH_FAILED when CDP never comes up', async () => {
    const machine = createMachine({ reports: [downReport()] });
    const config = configWith({ TV_LAUNCH_TIMEOUT_MS: '2000' });

    const error = await failureOf(launcherFor(machine, config).launch({ restart: false }));

    expect(error.code).toBe('LAUNCH_FAILED');
    expect(error.message).toContain('within 2 s');
    expect(error.message).toContain(`the debug port at ${ENDPOINT} did not answer`);
    expect(error.hint).toContain(DEBUG_FLAG);
    expect(error.hint).toContain('TV_LAUNCH_TIMEOUT_MS');
    expect(error.details).toEqual({
      endpoint: ENDPOINT,
      waitedMs: 2000,
      cdpReachable: false,
      chartFound: false,
      appReady: false,
    });
    // It waited for as long as the limit allows, in pauses of half a second.
    expect(totalSleep(machine)).toBe(2000);
    expect(
      machine.log.filter((entry) => entry.startsWith('sleep')).every((e) => e === 'sleep 500'),
    ).toBe(true);
  });

  test('waits for as long as the configured launch timeout', async () => {
    const machine = createMachine({ reports: [downReport()] });

    await failureOf(launcherFor(machine).launch({ restart: false }));

    expect(totalSleep(machine)).toBe(configWith().launchTimeoutMs);
  });

  test('keeps the notes out of the failure hint, because the notes are not shipped', async () => {
    const machine = createMachine({ reports: [downReport()] });

    const error = await failureOf(launcherFor(machine).launch({ restart: false }));

    // The package holds only its build, so a path into the repository would lead nowhere.
    expect(error.hint).not.toMatch(/docs\/|reverse-engineering|\.md/);
    // What the reader needs is still there: the flag to start the app with, and the timeout.
    expect(error.hint).toContain(`Start TradingView yourself with ${DEBUG_FLAG}, then try again.`);
    expect(error.hint).toContain('raise TV_LAUNCH_TIMEOUT_MS');
  });

  test.each([
    [
      'the debug port answers but the app has no chart tab',
      noChartReport(),
      'the debug port answered, but the app has no chart tab',
      { cdpReachable: true, chartFound: false, appReady: false },
    ],
    [
      'a chart tab is open but the app is not connected',
      connectingReport(),
      'a chart tab is open, but the app did not report that it is connected',
      { cdpReachable: true, chartFound: true, appReady: false },
    ],
  ])('says how far the app got when it gives up: %s', async (_label, report, sentence, state) => {
    const machine = createMachine({ reports: [downReport(), report] });
    const config = configWith({ TV_LAUNCH_TIMEOUT_MS: '1000' });

    const error = await failureOf(launcherFor(machine, config).launch({ restart: false }));

    expect(error.code).toBe('LAUNCH_FAILED');
    expect(error.message).toContain(sentence);
    expect(error.details).toEqual({ endpoint: ENDPOINT, waitedMs: 1000, ...state });
  });

  test('keeps waiting while the port answers but no chart tab is open', async () => {
    const machine = createMachine({
      reports: [downReport(), noChartReport(), noChartReport(), readyReport()],
    });

    const result = await launcherFor(machine).launch({ restart: false });

    expect(result).toMatchObject({ status: 'launched', waitedMs: 1000 });
  });

  test('keeps waiting while the chart tab is not connected', async () => {
    const machine = createMachine({ reports: [downReport(), connectingReport(), readyReport()] });

    const result = await launcherFor(machine).launch({ restart: false });

    expect(result).toMatchObject({ status: 'launched', waitedMs: 500 });
  });

  test('counts several chart tabs with none in front as ready enough', async () => {
    // The health check cannot tell which tab to read then, and says the app is not ready. The app
    // itself is up, and the user only has to bring one tab to the front.
    const machine = createMachine({ reports: [downReport(), unfocusedReport(2)] });

    const result = await launcherFor(machine).launch({ restart: false });

    expect(result).toMatchObject({ status: 'launched', waitedMs: 0, endpoint: ENDPOINT });
  });

  test('counts a chart tab behind a tab that shows no chart as ready enough', async () => {
    // A restored session can put TradingView's New tab page in front: the health check says that no
    // chart tab is in front. The app itself is up, and the chart tools say what to do about the tab.
    const machine = createMachine({ reports: [downReport(), behindReport()] });

    const result = await launcherFor(machine).launch({ restart: false });

    expect(result).toMatchObject({ status: 'launched', waitedMs: 0, endpoint: ENDPOINT });
  });

  test('restarts into a window whose tab in front shows no chart', async () => {
    const machine = createMachine({
      files: [MAC_BINARY],
      running: true,
      stays: 1,
      reports: [downReport(), downReport(), behindReport()],
    });

    const result = await launcherFor(machine).launch({ restart: true });

    expect(result).toMatchObject({ status: 'restarted', executable: MAC_BINARY });
  });

  test('does not count a single chart tab that is not ready as ready enough', async () => {
    const machine = createMachine({ reports: [downReport(), unfocusedReport(1), readyReport()] });

    const result = await launcherFor(machine).launch({ restart: false });

    expect(result.waitedMs).toBe(500);
  });
});

describe('launch when TradingView cannot be found or started', () => {
  test('fails with TV_NOT_INSTALLED when no install is found, listing the places it looked', async () => {
    const machine = createMachine({ files: [], reports: [downReport()] });

    const error = await failureOf(launcherFor(machine).launch({ restart: false }));

    expect(error.code).toBe('TV_NOT_INSTALLED');
    expect(error.hint).toContain('TV_APP_PATH');
    expect(error.details).toEqual({ checked: [MAC_BINARY, USER_BINARY] });
    expect(machine.spawned).toEqual([]);
  });

  test('also lists the Store package among the places it looked on Windows', async () => {
    const machine = createMachine({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\trader\\AppData\\Local', ProgramFiles: 'C:\\Program Files' },
      files: [],
      reports: [downReport()],
    });
    // PowerShell is not part of the fake machine, so asking it fails, like a machine without it.
    const error = await failureOf(launcherFor(machine).launch({ restart: false }));

    expect(error.code).toBe('TV_NOT_INSTALLED');
    expect(error.details).toEqual({
      checked: [
        'C:\\Users\\trader\\AppData\\Local\\TradingView\\TradingView.exe',
        'C:\\Program Files\\TradingView\\TradingView.exe',
        'Get-AppxPackage -Name TradingView.Desktop',
      ],
    });
  });

  test('names the override when TV_APP_PATH points to a file that is not there', async () => {
    const override = '/Volumes/Tools/TradingView';
    // The standard install exists, and is not used instead of the file that was asked for.
    const machine = createMachine({ files: [MAC_BINARY], reports: [downReport()] });

    const error = await failureOf(
      launcherFor(machine, configWith({ TV_APP_PATH: override })).launch({ restart: false }),
    );

    expect(error.code).toBe('TV_NOT_INSTALLED');
    expect(error.message).toContain(override);
    expect(machine.spawned).toEqual([]);
  });

  test('turns an error thrown by the start into LAUNCH_FAILED', async () => {
    const cause = new Error('spawn EACCES');
    const machine = createMachine({ spawnError: cause, reports: [downReport()] });

    const error = await failureOf(launcherFor(machine).launch({ restart: false }));

    expect(error.code).toBe('LAUNCH_FAILED');
    expect(error.message).toContain(MAC_BINARY);
    expect(error.hint).toContain('TV_APP_PATH');
    expect(error.cause).toBe(cause);
  });

  test('lets a LAUNCH_FAILED of the start through as it is', async () => {
    const own = new TvMcpError('LAUNCH_FAILED', 'Could not start the app', { hint: 'Try again' });
    const machine = createMachine({ spawnError: own, reports: [downReport()] });

    await expect(launcherFor(machine).launch({ restart: false })).rejects.toBe(own);
  });

  test('lets a failed process lookup through, because it cannot tell whether to start a second copy', async () => {
    const machine = createMachine({ reports: [downReport()] });
    const lookupFailure = exitCode('ENOENT');
    const deps = { ...machine.deps, execFile: () => Promise.reject(lookupFailure) };
    const launcher = createLauncher({
      install: deps,
      spawn: machine.spawn,
      health: machine.health,
      config: configWith(),
      sleep: machine.sleep,
    });

    const error = await failureOf(launcher.launch({ restart: false }));

    expect(error.code).toBe('LAUNCH_FAILED');
    expect(machine.spawned).toEqual([]);
  });
});

describe('launch with a port', () => {
  test('accepts the port that the server is configured for', async () => {
    const machine = createMachine({ reports: [downReport(), readyReport()] });

    const result = await launcherFor(machine).launch({ restart: false, port: 9222 });

    expect(result.status).toBe('launched');
    expect(machine.spawned[0]?.args).toEqual([DEBUG_FLAG]);
  });

  test('refuses another port, because the health check watches the configured one', async () => {
    const machine = createMachine({ reports: [downReport(), readyReport()] });

    const error = await failureOf(launcherFor(machine).launch({ restart: false, port: 9333 }));

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('9333');
    expect(error.message).toContain('9222');
    expect(error.hint).toContain('TV_CDP_PORT');
    expect(error.details).toEqual({ port: 9333, configuredPort: 9222 });
    // Refused before anything was looked at.
    expect(machine.log).toEqual([]);
  });

  test('refuses a port that cannot be a port, before anything is looked at', async () => {
    const machine = createMachine({ reports: [downReport()] });

    const error = await failureOf(launcherFor(machine).launch({ restart: false, port: 0 }));

    expect(error.code).toBe('INVALID_INPUT');
    expect(machine.log).toEqual([]);
  });
});

describe('launch on each platform', () => {
  const WINDOWS_ENV = {
    LOCALAPPDATA: 'C:\\Users\\trader\\AppData\\Local',
    ProgramFiles: 'C:\\Program Files',
  };

  test.each([
    ['darwin', MAC_BINARY, { HOME: '/Users/trader' }, 'osascript'],
    [
      'win32',
      'C:\\Users\\trader\\AppData\\Local\\TradingView\\TradingView.exe',
      WINDOWS_ENV,
      'taskkill',
    ],
    ['linux', '/opt/TradingView/tradingview', {}, 'pkill'],
  ] as const)(
    'restarts on %s through its own programs',
    async (platform, executable, env, quit) => {
      const machine = createMachine({
        platform,
        env,
        files: [executable],
        running: true,
        stays: 1,
        reports: [downReport(), downReport(), readyReport()],
      });

      const result = await launcherFor(machine).launch({ restart: true });

      expect(result).toMatchObject({ status: 'restarted', executable });
      expect(machine.spawned).toEqual([{ command: executable, args: [DEBUG_FLAG] }]);
      expect(machine.log.filter((entry) => entry.startsWith('quit'))).toEqual([`quit ${quit}`]);
    },
  );
});

describe('launch from several callers at once', () => {
  test('runs launches one after the other, so that the second finds the app the first started', async () => {
    // Without a turn for each, both would see the port down and both would start the app.
    const machine = createMachine({ reports: [downReport(), downReport(), readyReport()] });
    const launcher = launcherFor(machine);

    const [first, second] = await Promise.all([
      launcher.launch({ restart: false }),
      launcher.launch({ restart: false }),
    ]);

    expect(first.status).toBe('launched');
    expect(second.status).toBe('already-running');
    expect(machine.spawned).toHaveLength(1);
  });

  test('does not let a launch that failed hold up the one behind it', async () => {
    const machine = createMachine({
      running: true,
      stays: 0,
      reports: [downReport(), downReport(), downReport(), readyReport()],
    });
    const launcher = launcherFor(machine);

    const [first, second] = await Promise.allSettled([
      launcher.launch({ restart: false }),
      launcher.launch({ restart: true }),
    ]);

    expect(first.status).toBe('rejected');
    expect(second).toMatchObject({ status: 'fulfilled', value: { status: 'restarted' } });
  });
});

describe('discover', () => {
  test('reports the executable, that the app runs, and that the debug port answers', async () => {
    const machine = createMachine({ running: true, reports: [readyReport()] });

    await expect(launcherFor(machine).discover()).resolves.toEqual({
      executable: MAC_BINARY,
      running: true,
      cdpReachable: true,
    });
    // The port answering already says that the app runs, so the process table is not read.
    expect(machine.log).not.toContain('lookup');
  });

  test('reports an app that runs without the debug port', async () => {
    const machine = createMachine({ running: true, reports: [downReport()] });

    await expect(launcherFor(machine).discover()).resolves.toEqual({
      executable: MAC_BINARY,
      running: true,
      cdpReachable: false,
    });
  });

  // The debug port answers, but not for TradingView, so whether the app runs is read from the
  // process table.
  test.each([true, false])(
    'reports a debug port that another browser holds as not reachable (app running %s)',
    async (running) => {
      const machine = createMachine({ running, reports: [otherBrowserReport()] });

      await expect(launcherFor(machine).discover()).resolves.toEqual({
        executable: MAC_BINARY,
        running,
        cdpReachable: false,
      });
      expect(machine.log).toContain('lookup');
    },
  );

  test('reports an app that is not running', async () => {
    const machine = createMachine({ running: false, reports: [downReport()] });

    await expect(launcherFor(machine).discover()).resolves.toEqual({
      executable: MAC_BINARY,
      running: false,
      cdpReachable: false,
    });
  });

  test('reports no executable, and does not fail, when nothing is installed', async () => {
    const machine = createMachine({ files: [], reports: [downReport()] });

    await expect(launcherFor(machine).discover()).resolves.toEqual({
      executable: null,
      running: false,
      cdpReachable: false,
    });
  });

  test('reports no executable, and does not fail, when TV_APP_PATH names a file that is not there', async () => {
    const machine = createMachine({ reports: [downReport()] });
    const launcher = launcherFor(
      machine,
      configWith({ TV_APP_PATH: '/Volumes/Tools/TradingView' }),
    );

    await expect(launcher.discover()).resolves.toMatchObject({ executable: null });
  });

  test('lets an unexpected failure of the install lookup through, since only a missing install is a finding', async () => {
    const machine = createMachine({ reports: [downReport()] });
    const broken = new Error('EIO: input/output error');
    const deps = {
      ...machine.deps,
      exists: (): boolean => {
        throw broken;
      },
    };
    const launcher = createLauncher({
      install: deps,
      spawn: machine.spawn,
      health: machine.health,
      config: configWith(),
    });

    await expect(launcher.discover()).rejects.toBe(broken);
  });

  test('does not start or close anything', async () => {
    const machine = createMachine({ running: true, reports: [downReport()] });

    await launcherFor(machine).discover();

    expect(machine.spawned).toEqual([]);
    expect(machine.log.some((entry) => entry.startsWith('quit'))).toBe(false);
  });

  test('lets a failed process lookup through', async () => {
    const machine = createMachine({ reports: [downReport()] });
    const deps = { ...machine.deps, execFile: () => Promise.reject(exitCode('ENOENT')) };
    const launcher = createLauncher({
      install: deps,
      spawn: machine.spawn,
      health: machine.health,
      config: configWith(),
    });

    const error = await failureOf(launcher.discover());

    expect(error.code).toBe('LAUNCH_FAILED');
  });
});
