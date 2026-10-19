import type { Config } from '../../config/schema.js';
import { pollUntil } from '../../utils/poll.js';
import { otherBrowserOnPort, type HealthReport } from '../connection.js';
import { isTvMcpError, TvMcpError } from '../errors.js';
import { findInstall, searchedLocations, type InstallDeps } from './install.js';
import { isTradingViewRunning, quitTradingView, type SpawnFn } from './process.js';

// The health check is cheap when the port is closed, and the app takes tens of seconds to come up,
// so half a second is often enough to notice it without keeping the caller waiting for nothing.
const READY_POLL_INTERVAL_MS = 500;
// How long the app gets to close after it was asked to. A dialog on screen (unsaved changes) holds
// it up for as long as the user takes to answer, and the launcher does not wait for that.
const QUIT_TIMEOUT_MS = 20_000;
const MAX_PORT = 65535;

// The arguments the app is started with. Only the debug port, on purpose:
// - --options=clean makes the app wipe the data of its default session when it starts.
// - --remote-debugging-address would open the port to other machines, and the port is equivalent
//   to full control of the logged-in session. Without it, the port binds to loopback.
export function buildLaunchArgs(port: number): string[] {
  // Checked here, in the one place that builds the flag, and before a restart has closed anything:
  // a port that makes the app fail to start must not be found out after it was quit.
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new TvMcpError(
      'INVALID_INPUT',
      `The debug port must be a whole number from 1 to ${String(MAX_PORT)}, but got ${String(port)}`,
    );
  }
  return [`--remote-debugging-port=${String(port)}`];
}

export interface LaunchResult {
  status: 'already-running' | 'launched' | 'restarted';
  // The file that was started, or null when nothing was started (the app was already up).
  executable: string | null;
  // Where the debug port is, as the health check reports it.
  endpoint: string;
  // How long the launcher waited for the app to be ready after it started it.
  waitedMs: number;
}

export interface Launcher {
  // Brings the app up with the debug port and waits until a chart tab is there. An app that runs
  // without the port is only restarted when `restart` is true, because closing it can lose what
  // is not saved.
  launch(options: { restart: boolean; port?: number }): Promise<LaunchResult>;
  // What can be told about the app without changing anything.
  discover(): Promise<{ executable: string | null; running: boolean; cdpReachable: boolean }>;
}

export interface LauncherDeps {
  install: InstallDeps;
  spawn: SpawnFn;
  health: () => Promise<HealthReport>;
  config: Config;
  // Replaceable so that tests can run a long wait without waiting.
  sleep?: (ms: number) => Promise<void>;
}

// Several chart tabs and none in front is how a healthy app looks while its window is behind
// another one, and the health check then says that the app is not ready, because it cannot tell
// which tab to read. For the launcher the app is up: the user only has to bring a tab forward.
function isReady({ cdp, chart, app }: HealthReport): boolean {
  return cdp.reachable && chart.found && (app.ready || chart.tabs > 1);
}

function restartRequired(port: number): TvMcpError {
  return new TvMcpError('RESTART_REQUIRED', 'TradingView is running without the debug port', {
    hint:
      'TradingView allows only one instance, so starting it again would not turn the debug port ' +
      'on. Quit TradingView and launch again, or use restart: true to have it quit and reopen ' +
      `with --remote-debugging-port=${String(port)}. A restart closes the app, so save unsaved ` +
      'work first.',
    details: { port },
  });
}

function notInstalled(install: InstallDeps): TvMcpError {
  return new TvMcpError('TV_NOT_INSTALLED', 'TradingView Desktop was not found', {
    hint:
      'Install TradingView Desktop, or set TV_APP_PATH (or --app-path) to the path of its ' +
      'executable.',
    details: { checked: searchedLocations(install.platform, install.env) },
  });
}

function otherPort(port: number, configured: number): TvMcpError {
  return new TvMcpError(
    'INVALID_INPUT',
    `Cannot start TradingView on port ${String(port)}, because the server watches port ${String(configured)}`,
    {
      hint:
        'Leave the port out, or set TV_CDP_PORT (--cdp-port) to the port you want, so that the ' +
        'server watches the port the app is started on.',
      details: { port, configuredPort: configured },
    },
  );
}

function startFailed(executable: string, cause: unknown): TvMcpError {
  return new TvMcpError('LAUNCH_FAILED', `Could not start ${executable}`, {
    hint:
      'Check that the file exists and that this user may run it, or point TV_APP_PATH at ' +
      'another TradingView executable.',
    cause,
  });
}

// What the last health report says about how far the app got.
function progressOf({ cdp, chart }: HealthReport): string {
  if (!cdp.reachable) {
    return `the debug port at ${cdp.endpoint} did not answer`;
  }
  if (!chart.found) {
    return 'the debug port answered, but the app has no chart tab';
  }
  return 'a chart tab is open, but the app did not report that it is connected';
}

function notReady(last: HealthReport, port: number, limitMs: number, waitedMs: number): TvMcpError {
  return new TvMcpError(
    'LAUNCH_FAILED',
    `TradingView did not become ready within ${String(Math.round(limitMs / 1000))} s: ${progressOf(last)}`,
    {
      hint:
        `Start TradingView yourself with --remote-debugging-port=${String(port)}, then try ` +
        'again. If the app is only slow to start, raise TV_LAUNCH_TIMEOUT_MS.',
      details: {
        endpoint: last.cdp.endpoint,
        waitedMs,
        cdpReachable: last.cdp.reachable,
        chartFound: last.chart.found,
        appReady: last.app.ready,
      },
    },
  );
}

export function createLauncher(deps: LauncherDeps): Launcher {
  const { install, spawn, health, config } = deps;
  // With exactOptionalPropertyTypes an absent option must stay absent.
  const timing = deps.sleep === undefined ? {} : { sleep: deps.sleep };

  // Launches take turns. Two at once would both see the port closed and both start the app, or one
  // would restart the app that the other had just started. The turn after a failed one still comes.
  let queue: Promise<unknown> = Promise.resolve();
  function inTurn<T>(work: () => Promise<T>): Promise<T> {
    const turn = queue.then(work);
    queue = turn.catch(() => undefined);
    return turn;
  }

  function start(executable: string, args: string[]): void {
    try {
      spawn(executable, args);
    } catch (error) {
      // The adapter of a real run already speaks in our errors. Anything else, such as a start
      // that node refuses to attempt, is a failed launch too.
      throw isTvMcpError(error) ? error : startFailed(executable, error);
    }
  }

  async function run(restart: boolean, port: number, args: string[]): Promise<LaunchResult> {
    const first = await health();
    // Another browser holds the port, so TradingView could not open it: a start would leave the app
    // running without the port, and a restart would close it for nothing.
    if (first.cdp.otherBrowser === true) {
      throw otherBrowserOnPort(first.cdp.endpoint, first.cdp.browser);
    }
    if (first.cdp.reachable) {
      // The app answers on the port (the health check tells it from another browser), so there is
      // nothing to start, and a restart has nothing to fix.
      return {
        status: 'already-running',
        executable: null,
        endpoint: first.cdp.endpoint,
        waitedMs: 0,
      };
    }

    const running = await isTradingViewRunning(install);
    if (running && !restart) {
      throw restartRequired(port);
    }

    // Found before anything is closed: an app that cannot be started again must not be quit.
    const executable = await findInstall(install, config.appPath);
    if (executable === null) {
      throw notInstalled(install);
    }

    if (running) {
      await quitTradingView(install, QUIT_TIMEOUT_MS, deps.sleep);
    }
    start(executable, args);

    const { satisfied, last, waitedMs } = await pollUntil(health, isReady, {
      intervalMs: READY_POLL_INTERVAL_MS,
      timeoutMs: config.launchTimeoutMs,
      ...timing,
    });
    if (!satisfied) {
      throw notReady(last, port, config.launchTimeoutMs, waitedMs);
    }
    return {
      status: running ? 'restarted' : 'launched',
      executable,
      endpoint: last.cdp.endpoint,
      waitedMs,
    };
  }

  // A report about the machine does not fail because TV_APP_PATH is wrong: that is a finding.
  async function installedOrNull(): Promise<string | null> {
    try {
      return await findInstall(install, config.appPath);
    } catch (error) {
      if (isTvMcpError(error) && error.code === 'TV_NOT_INSTALLED') {
        return null;
      }
      throw error;
    }
  }

  return {
    async launch({ restart, port }) {
      const wanted = port ?? config.cdpPort;
      // Before the turn and before anything else, so that a mistake is reported at once and never
      // after the app was closed.
      const args = buildLaunchArgs(wanted);
      // The health check looks at the configured port. On another one it could neither see that
      // the app is up nor that it came up.
      if (wanted !== config.cdpPort) {
        throw otherPort(wanted, config.cdpPort);
      }
      return inTurn(() => run(restart, wanted, args));
    },

    async discover() {
      const [executable, report] = await Promise.all([installedOrNull(), health()]);
      // A debug port that answers says that the app runs, so the process table is only read when it
      // does not.
      const running = report.cdp.reachable || (await isTradingViewRunning(install));
      return { executable, running, cdpReachable: report.cdp.reachable };
    },
  };
}
