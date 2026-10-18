import { spawn as nodeSpawn } from 'node:child_process';
import { pollUntil } from '../../utils/poll.js';
import { TvMcpError } from '../errors.js';
import type { InstallDeps } from './install.js';

// What the app is called in the process table. Every lookup and every request below matches this
// name exactly, never a part of a command line: this server is itself a process whose arguments
// mention tradingview (tradingview-desktop-mcp), and a pattern that matched them would make the
// app look as if it were always running, and could signal this server instead of the app.
const MAC_PROCESS = 'TradingView';
const WINDOWS_IMAGE = 'TradingView.exe';
const POSIX_PROCESS = 'tradingview';

// A lookup answers in milliseconds. This is for one that hangs, which must not hold up a launch.
const LOOKUP_TIMEOUT_MS = 10_000;
// A quit request is only the delivery of a message, but osascript waits for the app to take it.
const QUIT_REQUEST_TIMEOUT_MS = 10_000;
const EXIT_POLL_INTERVAL_MS = 250;

// node reports the exit code of a program that ran as `code`, and the errno name (ENOENT, ...) of
// one that could not be run.
function exitCodeOf(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return typeof error.code === 'number' ? error.code : undefined;
  }
  return undefined;
}

// A lookup that fails says nothing about the app, and a guess could start a second copy that the
// single-instance lock then hands over to the first, so the launch stops instead.
function lookupFailed(program: string, cause: unknown): TvMcpError {
  return new TvMcpError(
    'LAUNCH_FAILED',
    `Could not tell whether TradingView is running, because ${program} failed`,
    {
      hint: `Check that ${program} works on this machine, or start TradingView yourself with the debug port.`,
      cause,
    },
  );
}

async function pgrepFinds(deps: InstallDeps, args: string[]): Promise<boolean> {
  let output: string;
  try {
    output = await deps.execFile('pgrep', args, { timeoutMs: LOOKUP_TIMEOUT_MS });
  } catch (error) {
    // This is how pgrep says that nothing matched, which is an answer and not a failure.
    if (exitCodeOf(error) === 1) {
      return false;
    }
    throw lookupFailed('pgrep', error);
  }
  // pgrep leaves itself out of the list, but not the process that ran it. With an exact name match
  // this server cannot be listed, and it is left out anyway, so that no build or wrapper of it can
  // ever be mistaken for the app.
  return output.split('\n').some((line) => {
    const pid = line.trim();
    return /^\d+$/.test(pid) && Number(pid) !== process.pid;
  });
}

async function tasklistFinds(deps: InstallDeps): Promise<boolean> {
  let output: string;
  try {
    output = await deps.execFile('tasklist', ['/FI', `IMAGENAME eq ${WINDOWS_IMAGE}`], {
      timeoutMs: LOOKUP_TIMEOUT_MS,
    });
  } catch (error) {
    throw lookupFailed('tasklist', error);
  }
  // tasklist exits with 0 whether it found the image or not, and the text of "no task" depends on
  // the language of Windows. A found image is a row that starts with its name, and names are
  // never translated.
  return /^TradingView\.exe\s+\d+/im.test(output);
}

// Whether a TradingView process exists, whatever it was started with. Throws LAUNCH_FAILED when the
// lookup itself does not work.
export function isTradingViewRunning(deps: InstallDeps): Promise<boolean> {
  switch (deps.platform) {
    case 'win32':
      return tasklistFinds(deps);
    case 'darwin':
      return pgrepFinds(deps, ['-x', MAC_PROCESS]);
    default:
      // -i because the executable is spelled tradingview or TradingView, depending on the package.
      return pgrepFinds(deps, ['-x', '-i', POSIX_PROCESS]);
  }
}

// The gentle way to close the app on each platform, the same as the user closing it: a request
// that the app is free to answer with a dialog, and never a kill.
function quitRequest(platform: NodeJS.Platform): { program: string; args: string[] } {
  switch (platform) {
    case 'darwin':
      return { program: 'osascript', args: ['-e', `quit app "${MAC_PROCESS}"`] };
    case 'win32':
      return { program: 'taskkill', args: ['/IM', WINDOWS_IMAGE] };
    default:
      return { program: 'pkill', args: ['-TERM', '-x', '-i', POSIX_PROCESS] };
  }
}

function quitRefused(platform: NodeJS.Platform, cause: unknown): TvMcpError {
  const permission =
    platform === 'darwin'
      ? ' macOS may also be waiting for your permission: allow the app that runs this server to ' +
        'control TradingView under System Settings > Privacy & Security > Automation.'
      : '';
  return new TvMcpError('LAUNCH_FAILED', 'Could not ask TradingView to quit', {
    hint: `Quit TradingView yourself, then launch again.${permission}`,
    cause,
  });
}

function didNotExit(timeoutMs: number): TvMcpError {
  return new TvMcpError(
    'LAUNCH_FAILED',
    `TradingView did not exit within ${String(Math.round(timeoutMs / 1000))} s after it was asked to quit`,
    {
      hint:
        'It may be waiting for an answer to a dialog, such as a question about unsaved changes. ' +
        'Close TradingView yourself, then launch again. The server never closes it by force.',
      details: { timeoutMs },
    },
  );
}

// Asks the app to quit and waits until its process is gone. It does not force anything: an app
// that is stuck on a dialog is left for the user to answer, because a kill would lose what the
// dialog is about (a Pine script that was not saved, say). Throws LAUNCH_FAILED when the request
// is refused or the process is still there after `timeoutMs`.
export async function quitTradingView(
  deps: InstallDeps,
  timeoutMs: number,
  sleep?: (ms: number) => Promise<void>,
): Promise<void> {
  const { program, args } = quitRequest(deps.platform);
  const refusal = await deps.execFile(program, args, { timeoutMs: QUIT_REQUEST_TIMEOUT_MS }).then(
    () => undefined,
    (cause: unknown) => ({ cause }),
  );
  if (refusal !== undefined) {
    // osascript and taskkill also report an error for an app that quit a moment ago, which is what
    // the caller wants. Anything else is a refusal, and waiting for an app that was never asked
    // would only keep the caller waiting.
    if (await isTradingViewRunning(deps)) {
      throw quitRefused(deps.platform, refusal.cause);
    }
    return;
  }
  const { satisfied } = await pollUntil(
    () => isTradingViewRunning(deps),
    (running) => !running,
    {
      intervalMs: EXIT_POLL_INTERVAL_MS,
      timeoutMs,
      // With exactOptionalPropertyTypes an absent option must stay absent.
      ...(sleep === undefined ? {} : { sleep }),
    },
  );
  if (!satisfied) {
    throw didNotExit(timeoutMs);
  }
}

// Starts a program and returns at once. The launcher takes this as a dependency so that its tests
// never start anything.
export type SpawnFn = (command: string, args: string[]) => { pid?: number };

// The options a detached start uses, and the part of a child process that the adapter touches.
// Naming them lets a test hand in a stand-in for node's spawn without a cast.
export interface DetachedSpawnOptions {
  detached: true;
  stdio: 'ignore';
  windowsHide: true;
  env: NodeJS.ProcessEnv;
}

export interface SpawnedChild {
  readonly pid?: number | undefined;
  on(event: 'error', listener: (error: Error) => void): unknown;
  unref(): unknown;
}

export type SpawnImpl = (
  command: string,
  args: string[],
  options: DetachedSpawnOptions,
) => SpawnedChild;

// The start of a real run: the app is detached, so that it outlives this server and does not hold
// on to its pipes, and nothing is attached to its input and output. Never run by a test.
export function createDetachedSpawn(
  system: { spawn?: SpawnImpl; env?: NodeJS.ProcessEnv } = {},
): SpawnFn {
  const start: SpawnImpl = system.spawn ?? nodeSpawn;
  return (command, args) => {
    // A client built on Electron may run this server as plain Node with ELECTRON_RUN_AS_NODE set,
    // and TradingView would inherit it. The app has that mode enabled (see the security notes in
    // docs/reverse-engineering.md), so it would start as a plain Node.js runtime and never open
    // its windows or the debug port.
    const env = { ...(system.env ?? process.env) };
    delete env.ELECTRON_RUN_AS_NODE;

    const child = start(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env,
    });
    // A start that fails (the file is gone, or not allowed to run) is reported as an event on the
    // next tick, and an event of that kind that nobody listens for would crash the server.
    child.on('error', () => undefined);
    child.unref();
    if (child.pid === undefined) {
      throw new TvMcpError('LAUNCH_FAILED', `Could not start ${command}`, {
        hint:
          'Check that the file exists and that this user may run it, or point TV_APP_PATH at ' +
          'another TradingView executable.',
      });
    }
    return { pid: child.pid };
  };
}
