import { execFile as nodeExecFile } from 'node:child_process';
import { existsSync as nodeExistsSync } from 'node:fs';
import path from 'node:path';
import { TvMcpError } from '../errors.js';

// Everything the install lookup and the process control need from the machine. Tests pass fakes, so
// that no test depends on the platform it runs on or touches the TradingView that may be open on it.
export interface InstallDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists(path: string): boolean;
  // Runs a program with an argument list and no shell, so that nothing is read as shell syntax.
  // It resolves with what the program printed when it exits with code 0, and rejects otherwise with
  // the error that node:child_process produces: the exit code is in `code`, or the errno name
  // (ENOENT, ...) when the program could not be run at all.
  execFile(cmd: string, args: string[], options?: { timeoutMs?: number }): Promise<string>;
}

// Where the installers put the app, per docs/reverse-engineering.md section 10. macOS is verified;
// the Windows and Linux locations are expected ones that nobody has confirmed on a real machine.
const MAC_BINARY = ['TradingView.app', 'Contents', 'MacOS', 'TradingView'] as const;
const LINUX_CANDIDATES = [
  '/opt/TradingView/tradingview',
  '/usr/bin/tradingview',
  '/snap/bin/tradingview',
];

const WINDOWS_FOLDER = 'TradingView';
const WINDOWS_BINARY = 'TradingView.exe';

// The Microsoft Store build lives in a versioned folder of WindowsApps, so only the package
// registry knows where it is. The script is a constant on purpose: nothing is interpolated into it.
const MSIX_PACKAGE = 'TradingView.Desktop';
const MSIX_SCRIPT = `(Get-AppxPackage -Name '${MSIX_PACKAGE}').InstallLocation`;
// Starting PowerShell takes a few seconds on a slow machine, and a stuck one must not hold up the
// launcher for good.
const MSIX_QUERY_TIMEOUT_MS = 15_000;

function present(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

// In the order they are tried. A folder variable that is missing leaves its candidate out, because
// a path built from nothing would point at the current directory.
export function installCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  switch (platform) {
    case 'darwin': {
      const { HOME: home } = env;
      return [
        path.posix.join('/Applications', ...MAC_BINARY),
        ...(present(home) ? [path.posix.join(home, 'Applications', ...MAC_BINARY)] : []),
      ];
    }
    case 'win32': {
      // Joined with the Windows rules whatever the host is, so that the result does not depend on
      // the platform the tests run on.
      const { LOCALAPPDATA: perUser, ProgramFiles: perMachine } = env;
      return [perUser, perMachine]
        .filter(present)
        .map((folder) => path.win32.join(folder, WINDOWS_FOLDER, WINDOWS_BINARY));
    }
    case 'linux':
      return [...LINUX_CANDIDATES];
    default:
      // TradingView publishes no desktop app for other platforms, so only TV_APP_PATH can help.
      return [];
  }
}

// What the lookup looked at, for an error that tells the user where the app was expected.
export function searchedLocations(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const candidates = installCandidates(platform, env);
  return platform === 'win32'
    ? [...candidates, `Get-AppxPackage -Name ${MSIX_PACKAGE}`]
    : candidates;
}

// A package that is not installed makes PowerShell print nothing, and several installed versions
// make it print one folder per line, so the first line with a folder is the answer. A failure of
// PowerShell itself (missing, blocked by policy, too slow) only means that this way of finding the
// app did not work, which is not an error of the lookup.
async function findStorePackage(deps: InstallDeps): Promise<string | null> {
  let output: string;
  try {
    output = await deps.execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', MSIX_SCRIPT],
      { timeoutMs: MSIX_QUERY_TIMEOUT_MS },
    );
  } catch {
    return null;
  }
  const folder = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '');
  // The answer is started as a program, so text that merely looks like output is not accepted.
  if (folder === undefined || !path.win32.isAbsolute(folder)) {
    return null;
  }
  // Not checked with exists(): WindowsApps is access controlled, and a stat there can fail for a
  // package that is installed (see section 10 of the reverse-engineering notes).
  return path.win32.join(folder, WINDOWS_BINARY);
}

function overrideMissing(executable: string): TvMcpError {
  return new TvMcpError(
    'TV_NOT_INSTALLED',
    `The TradingView executable set by TV_APP_PATH (or --app-path) does not exist: ${executable}`,
    {
      hint:
        'Point TV_APP_PATH at the TradingView executable, or on macOS at TradingView.app. ' +
        'Remove the setting to look in the usual places.',
      details: { path: executable },
    },
  );
}

// On macOS the app is a folder, and the path that a user copies for "the app" is that folder, so
// the executable is looked for inside it. Nothing is guessed on other platforms.
const MAC_BUNDLE = /\.app\/?$/i;

function executableAt(platform: NodeJS.Platform, overridePath: string): string {
  return platform === 'darwin' && MAC_BUNDLE.test(overridePath)
    ? path.posix.join(overridePath, 'Contents', 'MacOS', 'TradingView')
    : overridePath;
}

// The executable to start, or null when the app is not in any of the usual places. A path that
// the user named is binding: if it is wrong, that is the error, because quietly starting another
// copy of the app would be a surprise.
export async function findInstall(
  deps: InstallDeps,
  overridePath?: string,
): Promise<string | null> {
  if (present(overridePath)) {
    const executable = executableAt(deps.platform, overridePath);
    if (deps.exists(executable)) {
      return executable;
    }
    throw overrideMissing(executable);
  }
  const found = installCandidates(deps.platform, deps.env).find((candidate) =>
    deps.exists(candidate),
  );
  if (found !== undefined) {
    return found;
  }
  // Asked last, because starting PowerShell is slow.
  return deps.platform === 'win32' ? findStorePackage(deps) : null;
}

// The parts of node's own functions that the adapter below uses. Naming them lets a test hand in a
// stand-in without a cast.
export type ExecFileFn = (
  file: string,
  args: string[],
  options: { timeout?: number; windowsHide: true; encoding: 'utf8' },
  callback: (error: Error | null, stdout: string) => void,
) => unknown;

export interface SystemCalls {
  existsSync(path: string): boolean;
  execFile: ExecFileFn;
}

// The dependencies of a real run. Nothing here runs until a lookup asks for it.
export function createNodeInstallDeps(system: Partial<SystemCalls> = {}): InstallDeps {
  const existsSync = system.existsSync ?? nodeExistsSync;
  const run: ExecFileFn = system.execFile ?? nodeExecFile;
  return {
    platform: process.platform,
    env: process.env,
    exists: (target) => existsSync(target),
    execFile: (command, args, options) =>
      new Promise<string>((resolve, reject) => {
        run(
          command,
          args,
          {
            // With exactOptionalPropertyTypes an absent deadline must stay absent.
            ...(options?.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
            // A console window would flash on Windows for every query.
            windowsHide: true,
            encoding: 'utf8',
          },
          (error, stdout) => {
            if (error === null) {
              resolve(stdout);
            } else {
              reject(error);
            }
          },
        );
      }),
  };
}
