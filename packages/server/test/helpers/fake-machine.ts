import type { HealthReport } from '../../src/core/connection.js';
import type { InstallDeps } from '../../src/core/launcher/install.js';

// A machine for the tests of the process control and the launcher. It has a process table with at
// most one TradingView, a way to ask that process to quit, and a debug port whose health reports
// the test scripts. Nothing here touches the real machine: a program that the script does not
// know fails the test, and every step is written to `log` so that a test can check their order.

export const ENDPOINT = 'http://127.0.0.1:9222';
export const MAC_BINARY = '/Applications/TradingView.app/Contents/MacOS/TradingView';
const APP_PID = 4242;

const LOOKUP_PROGRAMS = new Set(['pgrep', 'tasklist']);
const QUIT_PROGRAMS = new Set(['osascript', 'taskkill', 'pkill']);

export const WINDOWS_LISTING = [
  'Image Name                     PID Session Name        Session#    Mem Usage',
  '========================= ======== ================ =========== ============',
  `TradingView.exe              ${String(APP_PID)} Console                    1    251,000 K`,
  '',
].join('\r\n');
export const WINDOWS_NO_TASK = 'INFO: No tasks are running which match the specified criteria.\r\n';

export interface MachineOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  // The files that exist. The default is the standard macOS install.
  files?: readonly string[];
  // Whether a TradingView process is alive when the test starts.
  running?: boolean;
  // How many process lookups after a quit request still find the process. Zero means it is gone
  // at the first lookup, and Infinity means that it never exits, like an app that is waiting for an
  // answer to a dialog.
  stays?: number;
  // The quit request fails with this error.
  quitError?: Error;
  // What the debug port reports, one report per health check. The last one repeats.
  reports?: readonly HealthReport[];
  // Starting the app fails with this error.
  spawnError?: Error;
}

export interface FakeMachine {
  deps: InstallDeps;
  spawn: (command: string, args: string[]) => { pid?: number };
  health: () => Promise<HealthReport>;
  sleep: (ms: number) => Promise<void>;
  // Every step in the order it happened: health, lookup, quit <program>, spawn <command> <args>,
  // sleep <ms>.
  log: string[];
  // Every program that was run through execFile, as [command, ...args].
  programs: string[][];
  // Every call of spawn.
  spawned: { command: string; args: string[] }[];
}

// Exits with a code, like pgrep does when nothing matched.
export function exitCode(code: number | string): Error {
  return Object.assign(new Error(`Command failed with ${String(code)}`), { code });
}

export function createMachine(options: MachineOptions = {}): FakeMachine {
  const platform = options.platform ?? 'darwin';
  const files = options.files ?? [MAC_BINARY];
  const reports = options.reports ?? [downReport()];
  const stays = options.stays ?? 0;
  const log: string[] = [];
  const programs: string[][] = [];
  const spawned: FakeMachine['spawned'] = [];
  let alive = options.running ?? false;
  let quitRequested = false;
  let lookupsSinceQuit = 0;
  let healthChecks = 0;

  function lookup(): Promise<string> {
    log.push('lookup');
    if (quitRequested) {
      if (lookupsSinceQuit >= stays) {
        alive = false;
      }
      lookupsSinceQuit += 1;
    }
    if (platform === 'win32') {
      return Promise.resolve(alive ? WINDOWS_LISTING : WINDOWS_NO_TASK);
    }
    return alive ? Promise.resolve(`${String(APP_PID)}\n`) : Promise.reject(exitCode(1));
  }

  function quit(program: string): Promise<string> {
    log.push(`quit ${program}`);
    quitRequested = true;
    return options.quitError === undefined
      ? Promise.resolve('')
      : Promise.reject(options.quitError);
  }

  const deps: InstallDeps = {
    platform,
    env: options.env ?? { HOME: '/Users/trader' },
    exists: (path) => files.includes(path),
    execFile: (command, args) => {
      programs.push([command, ...args]);
      if (LOOKUP_PROGRAMS.has(command)) {
        return lookup();
      }
      if (QUIT_PROGRAMS.has(command)) {
        return quit(command);
      }
      return Promise.reject(new Error(`Unexpected program: ${[command, ...args].join(' ')}`));
    },
  };

  return {
    deps,
    spawn: (command, args) => {
      log.push(`spawn ${[command, ...args].join(' ')}`);
      spawned.push({ command, args });
      if (options.spawnError !== undefined) {
        throw options.spawnError;
      }
      alive = true;
      return { pid: APP_PID };
    },
    health: () => {
      log.push('health');
      const report = reports[Math.min(healthChecks, reports.length - 1)] ?? downReport();
      healthChecks += 1;
      return Promise.resolve(report);
    },
    sleep: (ms) => {
      log.push(`sleep ${String(ms)}`);
      return Promise.resolve();
    },
    log,
    programs,
    spawned,
  };
}

// The reports of the health check, from nothing there to ready. Each is what the check says in
// that state, not a partial answer.

export function downReport(): HealthReport {
  return {
    cdp: { reachable: false, endpoint: ENDPOINT },
    chart: { found: false, tabs: 0 },
    app: { ready: false },
  };
}

// Another browser answers on the debug port, such as a Chrome started with a debug port of its own:
// the health check does not take it for TradingView.
export function otherBrowserReport(): HealthReport {
  return {
    cdp: {
      reachable: false,
      endpoint: ENDPOINT,
      browser: 'Chrome/134.0.0.0',
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36',
      otherBrowser: true,
    },
    chart: { found: false, tabs: 0 },
    app: { ready: false },
  };
}

// The debug port answers, and the app has no chart tab (yet).
export function noChartReport(): HealthReport {
  return {
    cdp: { reachable: true, endpoint: ENDPOINT, browser: 'Chrome/134.0.0.0' },
    chart: { found: false, tabs: 0 },
    app: { ready: false },
  };
}

// A chart tab is open, and the page has not connected to the data yet.
export function connectingReport(): HealthReport {
  return {
    cdp: { reachable: true, endpoint: ENDPOINT, browser: 'Chrome/134.0.0.0' },
    chart: { found: true, tabs: 1, url: 'https://www.tradingview.com/chart/' },
    app: { ready: false, connected: false, buildTime: null },
  };
}

// Several chart tabs and none of them in front: the report cannot say which one to read.
export function unfocusedReport(tabs = 2): HealthReport {
  return {
    cdp: { reachable: true, endpoint: ENDPOINT, browser: 'Chrome/134.0.0.0' },
    chart: { found: true, tabs },
    app: { ready: false },
  };
}

// A chart tab is open behind a tab that shows no chart, TradingView's New tab page, in a window in
// view: no chart tab is in front, so the health check says that the app is not ready, and that the
// chart tabs are in the background.
export function behindReport(): HealthReport {
  return {
    cdp: { reachable: true, endpoint: ENDPOINT, browser: 'Chrome/134.0.0.0' },
    chart: {
      found: true,
      tabs: 1,
      url: 'https://www.tradingview.com/chart/',
      inBackground: true,
    },
    app: { ready: false },
  };
}

export function readyReport(): HealthReport {
  return {
    cdp: { reachable: true, endpoint: ENDPOINT, browser: 'Chrome/134.0.0.0' },
    chart: { found: true, tabs: 1, url: 'https://www.tradingview.com/chart/' },
    app: { ready: true, connected: true, buildTime: '2026-01-01T00:00:00.000Z' },
  };
}
