import {
  createNodeInstallDeps,
  findInstall,
  installCandidates,
  searchedLocations,
  type ExecFileFn,
  type InstallDeps,
} from '../../../../src/core/launcher/install.js';
import { failureOf } from '../../../helpers/failure-of.js';

// Nothing in this file may run a real program: the machine this suite runs on may have a
// TradingView of its own open. Every dependency is a fake, and this is the second lock, so that
// even a mistake in the wiring of the default dependencies fails the test instead of starting
// something.
vi.mock('node:child_process', () => ({
  spawn: () => {
    throw new Error('A test tried to start a real program with spawn');
  },
  execFile: () => {
    throw new Error('A test tried to start a real program with execFile');
  },
}));

const MAC_APP = '/Applications/TradingView.app/Contents/MacOS/TradingView';
const MAC_USER_APP = '/Users/trader/Applications/TradingView.app/Contents/MacOS/TradingView';

const WINDOWS_ENV = {
  LOCALAPPDATA: 'C:\\Users\\trader\\AppData\\Local',
  ProgramFiles: 'C:\\Program Files',
};
const WINDOWS_USER_APP = 'C:\\Users\\trader\\AppData\\Local\\TradingView\\TradingView.exe';
const WINDOWS_MACHINE_APP = 'C:\\Program Files\\TradingView\\TradingView.exe';

const MSIX_FOLDER = 'C:\\Program Files\\WindowsApps\\TradingView.Desktop_1.0_x64__abc';

const unexpectedProgram: InstallDeps['execFile'] = (command, args) =>
  Promise.reject(new Error(`Unexpected program: ${[command, ...args].join(' ')}`));

interface Machine {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  files?: readonly string[];
  execFile?: InstallDeps['execFile'];
}

// A machine with only the given files on it. A program it is not told about is a failure.
function machine({
  platform = 'darwin',
  env = {},
  files = [],
  execFile = unexpectedProgram,
}: Machine = {}): InstallDeps {
  return { platform, env, exists: (path) => files.includes(path), execFile };
}

function asking(output: string) {
  return vi.fn<InstallDeps['execFile']>(() => Promise.resolve(output));
}

describe('installCandidates', () => {
  test('lists macOS candidates', () => {
    expect(installCandidates('darwin', { HOME: '/Users/trader' })).toEqual([MAC_APP, MAC_USER_APP]);
  });

  test.each([
    ['not set', {}],
    ['empty', { HOME: '' }],
  ])('leaves out the user Applications folder when HOME is %s', (_label, env) => {
    expect(installCandidates('darwin', env)).toEqual([MAC_APP]);
  });

  test('lists Windows candidates', () => {
    expect(installCandidates('win32', WINDOWS_ENV)).toEqual([
      WINDOWS_USER_APP,
      WINDOWS_MACHINE_APP,
    ]);
  });

  test('builds Windows candidates with Windows separators on any host', () => {
    // Joined with the Windows rules, so that a suite running on macOS or Linux gets the same paths.
    expect(installCandidates('win32', { LOCALAPPDATA: 'D:\\Data\\Local\\' })).toEqual([
      'D:\\Data\\Local\\TradingView\\TradingView.exe',
    ]);
  });

  test.each([
    ['LOCALAPPDATA', { ProgramFiles: 'C:\\Program Files' }, [WINDOWS_MACHINE_APP]],
    ['ProgramFiles', { LOCALAPPDATA: WINDOWS_ENV.LOCALAPPDATA }, [WINDOWS_USER_APP]],
    ['both folders', {}, []],
  ])('leaves out the Windows candidates whose folder is missing: %s', (_label, env, expected) => {
    expect(installCandidates('win32', env)).toEqual(expected);
  });

  test('lists Linux candidates', () => {
    expect(installCandidates('linux', {})).toEqual([
      '/opt/TradingView/tradingview',
      '/usr/bin/tradingview',
      '/snap/bin/tradingview',
    ]);
  });

  test('lists nothing for a platform that TradingView has no desktop app for', () => {
    expect(installCandidates('freebsd', { HOME: '/home/trader' })).toEqual([]);
  });
});

describe('searchedLocations', () => {
  test('is the candidate list on macOS and Linux', () => {
    expect(searchedLocations('darwin', { HOME: '/Users/trader' })).toEqual([MAC_APP, MAC_USER_APP]);
    expect(searchedLocations('linux', {})).toEqual(installCandidates('linux', {}));
  });

  test('adds the query for the Microsoft Store package on Windows', () => {
    expect(searchedLocations('win32', WINDOWS_ENV)).toEqual([
      WINDOWS_USER_APP,
      WINDOWS_MACHINE_APP,
      'Get-AppxPackage -Name TradingView.Desktop',
    ]);
  });
});

describe('findInstall', () => {
  test('returns the first candidate that exists, in list order', async () => {
    const deps = machine({ env: { HOME: '/Users/trader' }, files: [MAC_USER_APP, MAC_APP] });

    await expect(findInstall(deps)).resolves.toBe(MAC_APP);
  });

  test('skips candidates that are not there', async () => {
    const deps = machine({ env: { HOME: '/Users/trader' }, files: [MAC_USER_APP] });

    await expect(findInstall(deps)).resolves.toBe(MAC_USER_APP);
  });

  test('returns null when nothing is installed, without running any program on macOS or Linux', async () => {
    // The default `execFile` of the fake machine fails any program it is asked to run.
    await expect(findInstall(machine({ platform: 'darwin' }))).resolves.toBeNull();
    await expect(findInstall(machine({ platform: 'linux' }))).resolves.toBeNull();
  });

  test('TV_APP_PATH overrides detection', async () => {
    const override = '/Volumes/Tools/TradingView.app/Contents/MacOS/TradingView';
    const deps = machine({ files: [override, MAC_APP] });

    // The standard install exists too, and is still not the answer.
    await expect(findInstall(deps, override)).resolves.toBe(override);
  });

  test('gives TV_NOT_INSTALLED when TV_APP_PATH points to a file that does not exist', async () => {
    const override = '/Volumes/Tools/TradingView';
    // A standard install is there, and must not be used behind the back of someone who named a path.
    const deps = machine({ files: [MAC_APP] });

    const error = await failureOf(findInstall(deps, override));

    expect(error.code).toBe('TV_NOT_INSTALLED');
    expect(error.message).toContain(override);
    expect(error.message).toContain('TV_APP_PATH');
    expect(error.hint).toContain('executable');
    expect(error.details).toEqual({ path: override });
  });

  test.each([
    ['the bundle', '/Volumes/Tools/TradingView.app'],
    ['the bundle with a trailing slash', '/Volumes/Tools/TradingView.app/'],
    ['a bundle whose extension is in capitals', '/Volumes/Tools/TradingView.APP'],
  ])(
    'on macOS, TV_APP_PATH may name %s, and the executable inside it is started',
    async (_label, bundle) => {
      const inside = `${bundle.replace(/\/$/, '')}/Contents/MacOS/TradingView`;
      const deps = machine({ files: [inside] });

      await expect(findInstall(deps, bundle)).resolves.toBe(inside);
    },
  );

  test('on macOS, names the executable that it looked for in a bundle that has none', async () => {
    const bundle = '/Volumes/Tools/TradingView.app';

    const error = await failureOf(findInstall(machine(), bundle));

    expect(error.code).toBe('TV_NOT_INSTALLED');
    expect(error.message).toContain(`${bundle}/Contents/MacOS/TradingView`);
    expect(error.details).toEqual({ path: `${bundle}/Contents/MacOS/TradingView` });
  });

  test('does not read an override as a bundle on other platforms', async () => {
    const odd = '/opt/tools/Viewer.app';
    const deps = machine({ platform: 'linux', files: [odd] });

    await expect(findInstall(deps, odd)).resolves.toBe(odd);
  });

  test('treats an empty override as no override', async () => {
    await expect(findInstall(machine({ files: [MAC_APP] }), '')).resolves.toBe(MAC_APP);
  });

  test('does not ask PowerShell when a classic Windows install exists', async () => {
    const execFile = vi.fn<InstallDeps['execFile']>(unexpectedProgram);
    const deps = machine({
      platform: 'win32',
      env: WINDOWS_ENV,
      files: [WINDOWS_MACHINE_APP],
      execFile,
    });

    await expect(findInstall(deps)).resolves.toBe(WINDOWS_MACHINE_APP);
    expect(execFile).not.toHaveBeenCalled();
  });

  test('resolves an MSIX install through Get-AppxPackage', async () => {
    const execFile = asking(`${MSIX_FOLDER}\r\n`);
    const deps = machine({ platform: 'win32', env: WINDOWS_ENV, execFile });

    const found = await findInstall(deps);

    expect(found).toBe(`${MSIX_FOLDER}\\TradingView.exe`);
    expect(found?.endsWith('\\TradingView.exe')).toBe(true);
  });

  test('asks PowerShell with an argument list, a fixed script and a deadline', async () => {
    const execFile = asking(`${MSIX_FOLDER}\r\n`);

    await findInstall(machine({ platform: 'win32', env: WINDOWS_ENV, execFile }));

    expect(execFile).toHaveBeenCalledOnce();
    const [command, args, options] = execFile.mock.calls[0] ?? [];
    expect(command).toBe('powershell.exe');
    expect(args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "(Get-AppxPackage -Name 'TradingView.Desktop').InstallLocation",
    ]);
    expect(options?.timeoutMs).toBeGreaterThan(0);
  });

  test('does not check that the Store executable exists, because WindowsApps hides it from a stat', async () => {
    // exists() says no for everything, as it can for a folder that the user may not list.
    const deps = machine({
      platform: 'win32',
      env: WINDOWS_ENV,
      files: [],
      execFile: asking(`${MSIX_FOLDER}\r\n`),
    });

    await expect(findInstall(deps)).resolves.toBe(`${MSIX_FOLDER}\\TradingView.exe`);
  });

  test('takes the first location when several packages are installed', async () => {
    const other = 'C:\\Program Files\\WindowsApps\\TradingView.Desktop_0.9_x64__abc';
    const deps = machine({
      platform: 'win32',
      env: WINDOWS_ENV,
      execFile: asking(`\r\n${MSIX_FOLDER}\r\n${other}\r\n`),
    });

    await expect(findInstall(deps)).resolves.toBe(`${MSIX_FOLDER}\\TradingView.exe`);
  });

  test.each([
    ['prints nothing, as it does when the package is not installed', ''],
    ['prints only blank lines', '\r\n  \r\n'],
    ['prints text that is not a folder', 'Get-AppxPackage : something went wrong'],
    ['prints a relative path', 'WindowsApps\\TradingView.Desktop'],
  ])('finds nothing when PowerShell %s', async (_label, output) => {
    const deps = machine({ platform: 'win32', env: WINDOWS_ENV, execFile: asking(output) });

    await expect(findInstall(deps)).resolves.toBeNull();
  });

  test('finds nothing when PowerShell cannot be run or fails', async () => {
    const deps = machine({
      platform: 'win32',
      env: WINDOWS_ENV,
      execFile: () => Promise.reject(new Error('spawn powershell.exe ENOENT')),
    });

    await expect(findInstall(deps)).resolves.toBeNull();
  });

  test('uses an override on Windows without asking PowerShell', async () => {
    const override = 'D:\\Apps\\TradingView\\TradingView.exe';
    const execFile = vi.fn<InstallDeps['execFile']>(unexpectedProgram);
    const deps = machine({ platform: 'win32', env: WINDOWS_ENV, files: [override], execFile });

    await expect(findInstall(deps, override)).resolves.toBe(override);
    expect(execFile).not.toHaveBeenCalled();
  });
});

// The default dependencies are the only code in this file that would touch the machine. The real
// child_process is replaced at the top of the file, so what these tests see is the stand-in, and
// the fakes passed in below take its place wherever a call is meant to be observed.
describe('createNodeInstallDeps', () => {
  type Callback = Parameters<ExecFileFn>[3];
  type Options = Parameters<ExecFileFn>[2];

  // A stand-in for node's execFile that answers every program the same way.
  function recordingRunner(answer: (callback: Callback) => void) {
    const calls: { file: string; args: string[]; options: Options }[] = [];
    const run: ExecFileFn = (file, args, options, callback) => {
      calls.push({ file, args, options });
      answer(callback);
      return undefined;
    };
    return { calls, run };
  }

  test('describes the machine it runs on', () => {
    const deps = createNodeInstallDeps();

    expect(deps.platform).toBe(process.platform);
    expect(deps.env).toBe(process.env);
  });

  test('checks files with the function it is given', () => {
    const checked: string[] = [];
    const deps = createNodeInstallDeps({
      existsSync: (path) => {
        checked.push(path);
        return path === '/there';
      },
    });

    expect(deps.exists('/there')).toBe(true);
    expect(deps.exists('/missing')).toBe(false);
    expect(checked).toEqual(['/there', '/missing']);
  });

  test('runs a program with an argument list and no shell, and resolves with its output', async () => {
    const { calls, run } = recordingRunner((callback) => {
      callback(null, '4242\n');
    });
    const deps = createNodeInstallDeps({ execFile: run });

    await expect(deps.execFile('pgrep', ['-x', 'TradingView'], { timeoutMs: 3000 })).resolves.toBe(
      '4242\n',
    );

    expect(calls).toEqual([
      {
        file: 'pgrep',
        args: ['-x', 'TradingView'],
        options: { timeout: 3000, windowsHide: true, encoding: 'utf8' },
      },
    ]);
    // A shell would read the arguments as text. The option must not even be mentioned.
    expect(calls[0]?.options).not.toHaveProperty('shell');
  });

  test('sets no deadline when it is not given one', async () => {
    const { calls, run } = recordingRunner((callback) => {
      callback(null, '');
    });

    await createNodeInstallDeps({ execFile: run }).execFile('tasklist', []);

    expect(calls[0]?.options).toEqual({ windowsHide: true, encoding: 'utf8' });
  });

  test('rejects with the error of the program, which carries its exit code', async () => {
    const exitedWithOne = Object.assign(new Error('Command failed: pgrep'), { code: 1 });
    const { run } = recordingRunner((callback) => {
      callback(exitedWithOne, '');
    });

    await expect(createNodeInstallDeps({ execFile: run }).execFile('pgrep', [])).rejects.toBe(
      exitedWithOne,
    );
  });

  test('runs the real child_process by default, which these tests have replaced', async () => {
    // If this ever reached a real program, the test would not be able to tell. The stand-in at the
    // top of the file throws, and the adapter turns that into a rejection.
    await expect(createNodeInstallDeps().execFile('anything', [])).rejects.toThrow(
      'A test tried to start a real program with execFile',
    );
  });
});
