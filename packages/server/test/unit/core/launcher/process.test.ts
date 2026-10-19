import { EventEmitter } from 'node:events';
import type { InstallDeps } from '../../../../src/core/launcher/install.js';
import {
  createDetachedSpawn,
  isTradingViewRunning,
  quitTradingView,
  type SpawnImpl,
} from '../../../../src/core/launcher/process.js';
import { failureOf } from '../../../helpers/failure-of.js';
import {
  WINDOWS_LISTING,
  WINDOWS_NO_TASK,
  createMachine,
  exitCode,
} from '../../../helpers/fake-machine.js';

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

// A machine that answers every program with the same outcome, and keeps what it was asked.
function answering(platform: NodeJS.Platform, outcome: string | Error) {
  const calls: { command: string; args: string[]; timeoutMs: number | undefined }[] = [];
  const deps: InstallDeps = {
    platform,
    env: {},
    exists: () => false,
    execFile: (command, args, options) => {
      calls.push({ command, args, timeoutMs: options?.timeoutMs });
      return typeof outcome === 'string' ? Promise.resolve(outcome) : Promise.reject(outcome);
    },
  };
  return { deps, calls };
}

function commandsOf(calls: { command: string; args: string[] }[]): string[][] {
  return calls.map(({ command, args }) => [command, ...args]);
}

describe('isTradingViewRunning', () => {
  test('on macOS asks pgrep for a process named exactly TradingView', async () => {
    const { deps, calls } = answering('darwin', '4242\n');

    await expect(isTradingViewRunning(deps)).resolves.toBe(true);

    // -x matches the name, so the helper processes ("TradingView Helper (GPU)") do not count.
    expect(commandsOf(calls)).toEqual([['pgrep', '-x', 'TradingView']]);
  });

  test.each(['darwin', 'linux'] as const)(
    'on %s, exit code 1 of pgrep means not running',
    async (platform) => {
      const { deps } = answering(platform, exitCode(1));

      await expect(isTradingViewRunning(deps)).resolves.toBe(false);
    },
  );

  test('on Linux matches the process name exactly and ignoring case, never the command line', async () => {
    const { deps, calls } = answering('linux', '4242\n');

    await expect(isTradingViewRunning(deps)).resolves.toBe(true);

    expect(commandsOf(calls)).toEqual([['pgrep', '-x', '-i', 'tradingview']]);
    // -f would match any process whose arguments mention tradingview, and this server is one of
    // them (tradingview-desktop-mcp), so the app would always look like it is running.
    expect(calls[0]?.args).not.toContain('-f');
  });

  test('does not count its own process', async () => {
    const { deps } = answering('linux', `${String(process.pid)}\n`);

    await expect(isTradingViewRunning(deps)).resolves.toBe(false);
  });

  test('counts another process next to its own', async () => {
    const { deps } = answering('linux', `${String(process.pid)}\n${String(process.pid + 1)}\n`);

    await expect(isTradingViewRunning(deps)).resolves.toBe(true);
  });

  test('ignores lines that are not process ids', async () => {
    await expect(isTradingViewRunning(answering('darwin', 'warning: odd\n').deps)).resolves.toBe(
      false,
    );
    await expect(
      isTradingViewRunning(answering('darwin', `warning: odd\n${String(process.pid + 1)}\n`).deps),
    ).resolves.toBe(true);
  });

  test('on Windows asks tasklist for the image name and finds the app in the table', async () => {
    const { deps, calls } = answering('win32', WINDOWS_LISTING);

    await expect(isTradingViewRunning(deps)).resolves.toBe(true);

    expect(commandsOf(calls)).toEqual([['tasklist', '/FI', 'IMAGENAME eq TradingView.exe']]);
  });

  test('on Windows, tasklist saying that no task matches means not running', async () => {
    // tasklist exits with 0 in that case, so the answer is in the text.
    const { deps } = answering('win32', WINDOWS_NO_TASK);

    await expect(isTradingViewRunning(deps)).resolves.toBe(false);
  });

  test('on Windows reads the image name without regard to case, and only at the start of a row', async () => {
    await expect(
      isTradingViewRunning(answering('win32', 'tradingview.exe   4242 Console 1 100 K\r\n').deps),
    ).resolves.toBe(true);
    await expect(
      isTradingViewRunning(answering('win32', 'NotTradingView.exe   99 Console 1 100 K\r\n').deps),
    ).resolves.toBe(false);
  });

  test('on a platform without its own lookup, uses the exact name lookup of Linux', async () => {
    const { deps, calls } = answering('freebsd', '4242\n');

    await expect(isTradingViewRunning(deps)).resolves.toBe(true);

    expect(commandsOf(calls)).toEqual([['pgrep', '-x', '-i', 'tradingview']]);
  });

  test.each([
    ['pgrep is missing', exitCode('ENOENT')],
    ['pgrep fails with another exit code', exitCode(2)],
    ['pgrep is killed by its deadline', Object.assign(new Error('timed out'), { killed: true })],
  ])(
    'fails with LAUNCH_FAILED when %s, since the answer would be a guess',
    async (_label, cause) => {
      const { deps } = answering('darwin', cause);

      const error = await failureOf(isTradingViewRunning(deps));

      expect(error.code).toBe('LAUNCH_FAILED');
      expect(error.message).toContain('pgrep');
      expect(error.hint).toBeDefined();
      expect(error.cause).toBe(cause);
    },
  );

  test('fails with LAUNCH_FAILED when tasklist fails', async () => {
    const cause = exitCode('ENOENT');
    const { deps } = answering('win32', cause);

    const error = await failureOf(isTradingViewRunning(deps));

    expect(error.code).toBe('LAUNCH_FAILED');
    expect(error.message).toContain('tasklist');
    expect(error.cause).toBe(cause);
  });

  test('gives the lookup a deadline, so that a stuck pgrep cannot hold up a launch', async () => {
    const { deps, calls } = answering('darwin', '4242\n');

    await isTradingViewRunning(deps);

    expect(calls[0]?.timeoutMs).toBeGreaterThan(0);
  });
});

describe('quitTradingView', () => {
  const QUITS = [
    ['darwin', 'osascript', ['-e', 'quit app "TradingView"'], 'pgrep'],
    ['win32', 'taskkill', ['/IM', 'TradingView.exe'], 'tasklist'],
    ['linux', 'pkill', ['-TERM', '-x', '-i', 'tradingview'], 'pgrep'],
  ] as const;

  test.each(QUITS)(
    'on %s asks the app to quit with %s and nothing stronger',
    async (platform, program, args, lookup) => {
      const machine = createMachine({ platform, running: true, stays: 1 });

      await quitTradingView(machine.deps, 20_000, machine.sleep);

      expect(machine.programs[0]).toEqual([program, ...args]);
      // The request is made once, and everything after it only looks at the process table.
      expect(machine.programs.filter(([command]) => command === program)).toHaveLength(1);
      expect(new Set(machine.programs.map(([command]) => command))).toEqual(
        new Set([program, lookup]),
      );
    },
  );

  test.each(QUITS)(
    'on %s never escalates to a forced kill, even when the app stays',
    async (platform, program, _args, lookup) => {
      const machine = createMachine({ platform, running: true, stays: Infinity });

      await expect(quitTradingView(machine.deps, 2000, machine.sleep)).rejects.toMatchObject({
        code: 'LAUNCH_FAILED',
      });

      expect(new Set(machine.programs.map(([command]) => command))).toEqual(
        new Set([program, lookup]),
      );
      const force = /^(-9|-KILL|-SIGKILL|\/F|\/T|--force)$/i;
      expect(machine.programs.flat().filter((argument) => force.test(argument))).toEqual([]);
    },
  );

  test('waits until the process is gone, looking again after each pause', async () => {
    const machine = createMachine({ running: true, stays: 2 });

    await quitTradingView(machine.deps, 20_000, machine.sleep);

    const steps = machine.log.map((entry) => entry.replace(/^sleep \d+$/, 'sleep'));
    expect(steps).toEqual(['quit osascript', 'lookup', 'sleep', 'lookup', 'sleep', 'lookup']);
  });

  test('pauses with the real timer when it is not given a sleep', async () => {
    vi.useFakeTimers();
    try {
      const machine = createMachine({ running: true, stays: 1 });
      let finished = false;
      const quitting = quitTradingView(machine.deps, 20_000).then(() => {
        finished = true;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(finished).toBe(false);

      await vi.advanceTimersByTimeAsync(250);
      await quitting;

      expect(finished).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('returns without waiting when the process is gone at the first look', async () => {
    const machine = createMachine({ running: true, stays: 0 });

    await quitTradingView(machine.deps, 20_000, machine.sleep);

    expect(machine.log).toEqual(['quit osascript', 'lookup']);
  });

  test('fails with LAUNCH_FAILED when the app has not exited by the deadline', async () => {
    const machine = createMachine({ running: true, stays: Infinity });

    const error = await failureOf(quitTradingView(machine.deps, 2000, machine.sleep));

    expect(error.code).toBe('LAUNCH_FAILED');
    expect(error.message).toContain('did not exit');
    expect(error.message).toContain('2 s');
    expect(error.hint).toContain('dialog');
    expect(error.hint).toContain('by force');
    expect(error.details).toEqual({ timeoutMs: 2000 });
    // The wait took the whole time that it was given, in pauses.
    const paused = machine.log
      .map((entry) => /^sleep (\d+)$/.exec(entry)?.[1])
      .reduce((total, ms) => total + Number(ms ?? 0), 0);
    expect(paused).toBe(2000);
  });

  test('is satisfied when the request fails but the app is gone anyway', async () => {
    // osascript and taskkill both report an error for an app that quit a moment earlier.
    const machine = createMachine({ running: true, stays: 0, quitError: exitCode(1) });

    await expect(quitTradingView(machine.deps, 20_000, machine.sleep)).resolves.toBeUndefined();

    expect(machine.log).toEqual(['quit osascript', 'lookup']);
  });

  test('fails at once when the request fails and the app is still there', async () => {
    const refusal = exitCode(1);
    const machine = createMachine({ running: true, stays: Infinity, quitError: refusal });

    const error = await failureOf(quitTradingView(machine.deps, 20_000, machine.sleep));

    expect(error.code).toBe('LAUNCH_FAILED');
    expect(error.message).toContain('ask TradingView to quit');
    expect(error.hint).toContain('Quit TradingView yourself');
    expect(error.cause).toBe(refusal);
    // No point in waiting 20 s for an app that was never asked.
    expect(machine.log).toEqual(['quit osascript', 'lookup']);
  });

  test('points a macOS user to the Automation permission when the request fails', async () => {
    const machine = createMachine({
      platform: 'darwin',
      running: true,
      stays: Infinity,
      quitError: exitCode(1),
    });

    const error = await failureOf(quitTradingView(machine.deps, 20_000, machine.sleep));

    expect(error.hint).toContain('Automation');
  });

  test('does not mention the Automation permission on other platforms', async () => {
    const machine = createMachine({
      platform: 'win32',
      running: true,
      stays: Infinity,
      quitError: exitCode(128),
    });

    const error = await failureOf(quitTradingView(machine.deps, 20_000, machine.sleep));

    expect(error.hint).not.toContain('Automation');
  });

  test('lets a failed lookup through while it waits', async () => {
    const lookupFailure = exitCode('ENOENT');
    const deps: InstallDeps = {
      platform: 'darwin',
      env: {},
      exists: () => false,
      execFile: (command) =>
        command === 'osascript' ? Promise.resolve('') : Promise.reject(lookupFailure),
    };

    const error = await failureOf(quitTradingView(deps, 20_000, () => Promise.resolve()));

    expect(error.code).toBe('LAUNCH_FAILED');
    expect(error.cause).toBe(lookupFailure);
  });
});

describe('createDetachedSpawn', () => {
  class FakeChild extends EventEmitter {
    readonly unref = vi.fn<() => void>();
    constructor(readonly pid: number | undefined) {
      super();
    }
  }

  function recorder(child: FakeChild) {
    const calls: { command: string; args: string[]; options: Parameters<SpawnImpl>[2] }[] = [];
    const impl: SpawnImpl = (command, args, options) => {
      calls.push({ command, args, options });
      return child;
    };
    return { impl, calls };
  }

  test('starts the command with its arguments, detached, without input or output, and hidden on Windows', () => {
    const child = new FakeChild(4242);
    const { impl, calls } = recorder(child);

    createDetachedSpawn({ spawn: impl, env: {} })('/path/to/TradingView', [
      '--remote-debugging-port=9222',
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('/path/to/TradingView');
    expect(calls[0]?.args).toEqual(['--remote-debugging-port=9222']);
    expect(calls[0]?.options).toMatchObject({
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    // No shell, so that the path and the arguments are never read as shell syntax.
    expect(calls[0]?.options).not.toHaveProperty('shell');
  });

  test('lets the app outlive this process', () => {
    const child = new FakeChild(4242);

    createDetachedSpawn({ spawn: recorder(child).impl, env: {} })('/path/to/TradingView', []);

    expect(child.unref).toHaveBeenCalledOnce();
  });

  test('returns the process id', () => {
    const spawn = createDetachedSpawn({ spawn: recorder(new FakeChild(4242)).impl, env: {} });

    expect(spawn('/path/to/TradingView', [])).toEqual({ pid: 4242 });
  });

  test('keeps ELECTRON_RUN_AS_NODE away from the app, which would turn it into plain Node', () => {
    const env = { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1', HOME: '/Users/trader' };
    const { impl, calls } = recorder(new FakeChild(4242));

    createDetachedSpawn({ spawn: impl, env })('/path/to/TradingView', []);

    expect(calls[0]?.options.env).toEqual({ PATH: '/usr/bin', HOME: '/Users/trader' });
    // The environment of this process is only read.
    expect(env).toHaveProperty('ELECTRON_RUN_AS_NODE', '1');
  });

  test('keeps the settings and secrets of this server away from the app', () => {
    const env = {
      PATH: '/usr/bin',
      HOME: '/Users/trader',
      TV_CDP_PORT: '9222',
      TV_MCP_AUTH_TOKEN: 'a-secret-token',
      TV_MCP_PROFILE: 'readonly',
      TV_MCP_HTTP_PORT: '8787',
      // Windows treats the names of variables as case-insensitive, and a spread of its environment
      // keeps them as they were written.
      tv_mcp_log_level: 'debug',
    };
    const before = { ...env };
    const { impl, calls } = recorder(new FakeChild(4242));

    createDetachedSpawn({ spawn: impl, env })('/path/to/TradingView', []);

    // The app and everything it starts could read what it inherits. The settings that are not ours
    // are not touched.
    expect(calls[0]?.options.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/trader',
      TV_CDP_PORT: '9222',
    });
    // The environment of this process is only read.
    expect(env).toEqual(before);
  });

  test('keeps a variable that only looks like one of ours', () => {
    const env = { TV_MCP: '1', TV_MCPX: '2', MY_TV_MCP_X: '3', TV_APP_PATH: '/path' };
    const { impl, calls } = recorder(new FakeChild(4242));

    createDetachedSpawn({ spawn: impl, env })('/path/to/TradingView', []);

    expect(calls[0]?.options.env).toEqual(env);
  });

  test('listens for the error event of the child, so that a failed start cannot crash the server', () => {
    const child = new FakeChild(4242);

    createDetachedSpawn({ spawn: recorder(child).impl, env: {} })('/path/to/TradingView', []);

    // An EventEmitter throws when it emits "error" and nobody listens.
    expect(() => child.emit('error', new Error('spawn EACCES'))).not.toThrow();
  });

  test('fails with LAUNCH_FAILED when the process could not be started', () => {
    const child = new FakeChild(undefined);
    const spawn = createDetachedSpawn({ spawn: recorder(child).impl, env: {} });

    let thrown: unknown;
    try {
      spawn('/path/to/TradingView', []);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: 'LAUNCH_FAILED',
      message: expect.stringContaining('/path/to/TradingView') as unknown,
      hint: expect.stringContaining('TV_APP_PATH') as unknown,
    });
    // The failure arrives as an error event on the next tick, and must find a listener.
    expect(() => child.emit('error', new Error('spawn ENOENT'))).not.toThrow();
  });

  test('starts programs with node:child_process by default, which these tests have replaced', () => {
    expect(() => createDetachedSpawn()('/path/to/TradingView', [])).toThrow(
      'A test tried to start a real program with spawn',
    );
  });
});
