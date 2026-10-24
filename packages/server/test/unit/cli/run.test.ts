import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import pkg from '../../../package.json' with { type: 'json' };
import { CLIENT_IDS, renderClientConfig, resolveCliPath } from '../../../src/cli/clients.js';
import { runCli, type CliDeps } from '../../../src/cli/run.js';
import { ConnectionManager, type HealthReport } from '../../../src/core/connection.js';
import { TvMcpError } from '../../../src/core/errors.js';
import type { Launcher, LaunchResult } from '../../../src/core/launcher/launch.js';
import { freePort } from '../../helpers/dashboard-client.js';
import { createDashboardFiles } from '../../helpers/dashboard-files.js';
import { CaptureStream } from '../../helpers/streams.js';
import {
  capturingLogger,
  quietLogger,
  refusingLauncher,
  unreachableConnection,
  unreachableConnectionDeps,
} from '../../helpers/tool-context.js';

// Port 9 (discard): should a test reach the network by mistake, no TradingView answers there.
const ENV = { TV_CDP_PORT: '9' };
const ENDPOINT = 'http://127.0.0.1:9222';

const READY: HealthReport = {
  cdp: { reachable: true, endpoint: ENDPOINT, browser: 'Chrome/146.0.7680.216' },
  chart: { found: true, tabs: 1, url: 'https://www.tradingview.com/chart/FIXTURE1/' },
  app: { ready: true, connected: true, buildTime: '2026-10-16T17:55:37' },
};

const LAUNCHED: LaunchResult = {
  status: 'launched',
  executable: '/Applications/TradingView.app/Contents/MacOS/TradingView',
  endpoint: ENDPOINT,
  waitedMs: 4200,
};

// A connection manager whose health report is fixed, for the doctor command.
class ReportingConnection extends ConnectionManager {
  constructor(private readonly report: HealthReport) {
    super(unreachableConnectionDeps());
  }

  override health(): Promise<HealthReport> {
    return Promise.resolve(this.report);
  }
}

// One whose close never finishes, like a CDP connection to an app that stopped answering.
class StuckConnection extends ReportingConnection {
  override close(): Promise<void> {
    return new Promise(() => undefined);
  }
}

// One whose close fails.
class FailingConnection extends ReportingConnection {
  override close(): Promise<void> {
    return Promise.reject(new Error('socket hang up'));
  }
}

function slowCloseLines(lines: Record<string, unknown>[]): Record<string, unknown>[] {
  return lines.filter((line) => typeof line.msg === 'string' && line.msg.includes('in time'));
}

function offlineDeps(overrides: CliDeps = {}): CliDeps {
  return {
    connection: unreachableConnection(),
    launcher: refusingLauncher(),
    logger: quietLogger,
    ...overrides,
  };
}

function launcherAnswering(outcome: () => Promise<LaunchResult>): Launcher & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    launch(options) {
      calls.push(options);
      return outcome();
    },
    discover: () => Promise.reject(new Error('No command asks discover')),
  };
}

async function run(
  argv: string[],
  options: { env?: NodeJS.ProcessEnv; deps?: CliDeps; tty?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = new CaptureStream({ tty: options.tty ?? false });
  const stderr = new CaptureStream({ tty: options.tty ?? false });
  const code = await runCli(
    argv,
    options.env ?? ENV,
    { stdout, stderr },
    options.deps ?? offlineDeps(),
  );
  return { code, stdout: stdout.text, stderr: stderr.text };
}

afterEach(() => {
  vi.useRealTimers();
});

test.each(['--help', '-h'])('%s prints the usage on stdout and exits 0', async (flag) => {
  const { code, stdout, stderr } = await run([flag]);

  expect(code).toBe(0);
  expect(stdout).toContain('Usage:');
  expect(stderr).toBe('');
});

test('--help wins over settings that would not load', async () => {
  // The loader refuses the HTTP transport without a token.
  const { code, stdout } = await run(['--transport', 'http', '--help'], { env: {} });

  expect(code).toBe(0);
  expect(stdout).toContain('Usage:');
});

test('--help documents every option the CLI accepts', async () => {
  // The hint for an unknown option lists the options the loader accepts.
  const { stderr } = await run(['--no-such-option']);
  const accepted = stderr.match(/--[a-z-]+/g)?.filter((option) => option !== '--no-such-option');

  const { stdout: help } = await run(['--help']);

  expect(accepted?.length).toBeGreaterThan(10);
  for (const option of accepted ?? []) {
    expect(help).toContain(option);
  }
});

test.each(['--version', '-v'])('%s prints the version on stdout and exits 0', async (flag) => {
  const { code, stdout, stderr } = await run([flag]);

  expect(code).toBe(0);
  expect(stdout).toBe(`${pkg.version}\n`);
  expect(stderr).toBe('');
});

test('config prints the snippet on stdout, the notes on stderr, and exits 0', async () => {
  const expected = renderClientConfig('cursor', { platform: 'linux', command: { kind: 'npx' } });

  const { code, stdout, stderr } = await run(['config', 'cursor', '--platform', 'linux']);

  expect(code).toBe(0);
  expect(stdout).toBe(expected.snippet);
  expect(stderr).toBe(expected.notes.map((note) => `${note}\n`).join(''));
});

test('config writes for the running system unless --platform names another', async () => {
  const running = renderClientConfig('claude-desktop', {
    platform: process.platform,
    command: { kind: 'npx' },
  });
  const windows = renderClientConfig('claude-desktop', {
    platform: 'win32',
    command: { kind: 'npx' },
  });

  expect((await run(['config', 'claude-desktop'])).stderr).toContain(running.notes[0]);
  expect((await run(['config', 'claude-desktop', '--platform', 'WIN32'])).stderr).toContain(
    windows.notes[0],
  );
});

test('--local uses node and the absolute path of the running CLI', async () => {
  const cliPath = '/opt/tradingview-desktop-mcp/dist/cli.js';

  const { code, stdout } = await run(['config', 'claude-desktop', '--local'], {
    deps: offlineDeps({ cliPath }),
  });
  const line = await run(['config', 'claude-code', '--local', '--profile', 'core'], {
    deps: offlineDeps({ cliPath }),
  });

  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toEqual({
    mcpServers: { tradingview: { command: 'node', args: [cliPath] } },
  });
  expect(line.stdout).toBe(`claude mcp add tradingview -- node ${cliPath} --profile core\n`);
});

test('--local without an injected path names the script that runs, resolved', async () => {
  const { code, stdout } = await run(['config', 'cursor', '--local']);
  const script = process.argv[1] ?? '';

  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({
    mcpServers: { tradingview: { command: 'node', args: [resolveCliPath(script)] } },
  });
});

test('remote clients use the --url host, or YOUR-TUNNEL-HOST, and never the real token even when TV_MCP_AUTH_TOKEN is set', async () => {
  const token = 'synthetic-token-0123456789abcdef0123456789abcdef';
  const env = { ...ENV, TV_MCP_AUTH_TOKEN: token };

  for (const client of ['chatgpt', 'openai-api']) {
    const given = await run(['config', client, '--url', 'https://Abc.Ngrok.app/'], { env });
    const placeholder = await run(['config', client], { env });

    expect(given.code).toBe(0);
    expect(given.stdout).toContain('https://abc.ngrok.app/mcp');
    expect(given.stderr).toContain('TV_MCP_ALLOWED_HOSTS=abc.ngrok.app');
    expect(placeholder.code).toBe(0);
    expect(placeholder.stdout).toContain('https://YOUR-TUNNEL-HOST/mcp');
    for (const { stdout, stderr } of [given, placeholder]) {
      expect(stdout).toContain('<TV_MCP_AUTH_TOKEN>');
      expect(stdout).not.toContain(token);
      expect(stderr).not.toContain(token);
    }
  }

  // A port other than 443 is part of the host and stays; 443 is what https means anyway.
  expect((await run(['config', 'chatgpt', '--url', 'abc.ngrok.app:8443'], { env })).stdout).toBe(
    'https://abc.ngrok.app:8443/mcp/<TV_MCP_AUTH_TOKEN>\n',
  );
  expect((await run(['config', 'chatgpt', '--url', 'abc.ngrok.app:443'], { env })).stdout).toBe(
    'https://abc.ngrok.app/mcp/<TV_MCP_AUTH_TOKEN>\n',
  );
});

test('a --url that is not a host is refused with the rules and message of an allowed host', async () => {
  const { code, stdout, stderr } = await run([
    'config',
    'chatgpt',
    '--url',
    'https://abc.ngrok.app/mcp/s3cret',
  ]);

  expect(code).toBe(1);
  expect(stdout).toBe('');
  expect(stderr).toContain(
    '✖ INVALID_INPUT: --url: "https://abc.ngrok.app/…" is not a host name: it has a path',
  );
  // The part after the host may be a pasted token, so it is not repeated.
  expect(stderr).not.toContain('s3cret');
});

test('an unknown client exits 1 and lists the clients with the closest one', async () => {
  const { code, stdout, stderr } = await run(['config', 'vs-code']);

  expect(code).toBe(1);
  expect(stdout).toBe('');
  expect(stderr).toContain('✖ INVALID_INPUT: Unknown client "vs-code". Did you mean "vscode"?');
  expect(stderr).toContain(`Valid clients: ${CLIENT_IDS.join(', ')}`);
});

test('config options with another command are INVALID_INPUT', async () => {
  for (const [argv, named] of [
    [['--local'], '--local'],
    [['doctor', '--url', 'abc.ngrok.app'], '--url'],
    [['launch', '--platform', 'win32'], '--platform'],
    [['serve', '--local', '--platform', 'linux'], '--local and --platform'],
  ] as const) {
    const { code, stdout, stderr } = await run([...argv]);

    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain(`✖ INVALID_INPUT: ${named}`);
    expect(stderr).toContain('config');
  }
});

test('--help lists the options of config and the clients under config', async () => {
  const { stdout } = await run(['--help']);
  const config = stdout.slice(stdout.indexOf('Options of config'));

  expect(stdout).not.toContain('not implemented');
  expect(config).toContain('--local');
  expect(config).toContain('--url <host>');
  expect(config).toContain('--platform <darwin|win32|linux>');
  expect(config).toContain('--profile');
  for (const client of CLIENT_IDS) {
    expect(config).toContain(client);
  }
});

test('an unknown flag prints the code, the message and the hint, and exits 1', async () => {
  const { code, stdout, stderr } = await run(['--bogus']);

  expect(code).toBe(1);
  expect(stderr).toContain("✖ INVALID_INPUT: Unknown option '--bogus'");
  expect(stderr).toContain('Valid options');
  expect(stdout).toBe('');
});

test('errors are colored on a terminal unless NO_COLOR is set', async () => {
  const colored = await run(['--bogus'], { tty: true });
  const plain = await run(['--bogus'], { tty: true, env: { ...ENV, NO_COLOR: '1' } });

  expect(colored.stderr).toContain('\u001b[');
  expect(plain.stderr).not.toContain('\u001b[');
});

test('launch starts TradingView without restarting it and prints the result', async () => {
  const launcher = launcherAnswering(() => Promise.resolve(LAUNCHED));

  const { code, stdout } = await run(['launch'], { deps: offlineDeps({ launcher }) });

  expect(code).toBe(0);
  // A restart could close the app with unsaved work, so the CLI never asks for one.
  expect(launcher.calls).toEqual([{ restart: false }]);
  expect(stdout).toContain(`Started TradingView with the debug port at ${ENDPOINT}`);
  expect(stdout).toContain(LAUNCHED.executable);
});

test('launch prints the code, the message and the hint of a failure, and exits 1', async () => {
  const launcher = launcherAnswering(() =>
    Promise.reject(
      new TvMcpError('RESTART_REQUIRED', 'TradingView is running without the debug port', {
        hint: 'Quit TradingView and launch again.',
      }),
    ),
  );

  const { code, stdout, stderr } = await run(['launch'], { deps: offlineDeps({ launcher }) });

  expect(code).toBe(1);
  expect(stderr).toContain('✖ RESTART_REQUIRED: TradingView is running without the debug port');
  expect(stderr).toContain('Quit TradingView and launch again.');
  expect(stdout).toBe('');
});

test('a failure nobody planned for is printed as INTERNAL and logged with its stack', async () => {
  const { logger, lines } = capturingLogger();
  const launcher = launcherAnswering(() => Promise.reject(new Error('spawn exploded')));

  const { code, stderr } = await run(['launch'], { deps: offlineDeps({ launcher, logger }) });

  expect(code).toBe(1);
  expect(stderr).toContain('✖ INTERNAL: spawn exploded');
  expect(lines).toContainEqual(
    expect.objectContaining({
      level: 50,
      err: expect.objectContaining({
        stack: expect.stringContaining('spawn exploded') as string,
      }) as unknown,
    }),
  );
});

test('doctor prints the checklist and exits 1 when the debug port does not answer', async () => {
  const { code, stdout } = await run(['doctor']);

  expect(code).toBe(1);
  expect(stdout).toContain('✖ Debug port does not answer');
  expect(stdout).toContain('tradingview-desktop-mcp launch');
});

test('doctor exits 0 for a ready app', async () => {
  const connection = new ReportingConnection(READY);

  const { code, stdout } = await run(['doctor'], { deps: offlineDeps({ connection }) });

  expect(code).toBe(0);
  expect(stdout).toContain('TradingView is ready.');
});

test('doctor exits 1 when several chart tabs are open and none is in front', async () => {
  const connection = new ReportingConnection({
    ...READY,
    chart: { found: true, tabs: 2 },
    app: { ready: false },
  });

  const { code } = await run(['doctor'], { deps: offlineDeps({ connection }) });

  expect(code).toBe(1);
});

test('the CDP connection gets at most 3 s to close before the CLI moves on', async () => {
  vi.useFakeTimers();
  const { logger, lines } = capturingLogger();
  const deps = offlineDeps({ connection: new StuckConnection(READY), logger });
  let code: number | undefined;

  const running = runCli(
    ['doctor'],
    ENV,
    { stdout: new CaptureStream(), stderr: new CaptureStream() },
    deps,
  ).then((value) => {
    code = value;
  });
  await vi.advanceTimersByTimeAsync(2999);
  expect(code).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  await running;

  expect(code).toBe(0);
  expect(slowCloseLines(lines)).toEqual([expect.objectContaining({ level: 40, timeoutMs: 3000 })]);
});

test('a CDP connection that fails to close is logged with its error, not as a slow one', async () => {
  const { logger, lines } = capturingLogger();
  const deps = offlineDeps({ connection: new FailingConnection(READY), logger });

  const { code } = await run(['doctor'], { deps });

  expect(code).toBe(0);
  expect(lines).toContainEqual(
    expect.objectContaining({
      level: 40,
      err: expect.objectContaining({
        stack: expect.stringContaining('socket hang up') as string,
      }) as unknown,
    }),
  );
  expect(slowCloseLines(lines)).toEqual([]);
});

// The log can be silenced, and it is not where a person looks first when the process ends.
test('an error nothing caught is printed on stderr even when logging is silent', async () => {
  const signals = new EventEmitter();
  const stdin = new PassThrough();
  const stderr = new CaptureStream();
  // offlineDeps logs nothing: its logger is silent.
  const running = runCli(
    [],
    ENV,
    { stdin, stdout: new PassThrough(), stderr, process: signals },
    offlineDeps(),
  );
  await expect.poll(() => stderr.text).toMatch(/transport +stdio/);

  signals.emit('uncaughtException', new Error('thrown from a socket handler'));
  signals.emit('unhandledRejection', new Error('rejected after it'));

  expect(await running).toBe(1);
  expect(stderr.text).toContain('✖ INTERNAL: thrown from a socket handler');
  // Only the error that ended the CLI is printed.
  expect(stderr.text).not.toContain('rejected after it');
  // The server that was left running stops once its input ends.
  stdin.end();
});

test('once it shuts down it stops listening for signals, so a second one ends the process', async () => {
  vi.useFakeTimers();
  const signals = new EventEmitter();
  const stdin = new PassThrough();
  const deps = offlineDeps({ connection: new StuckConnection(READY) });
  let code: number | undefined;
  const running = runCli(
    [],
    ENV,
    { stdin, stdout: new PassThrough(), stderr: new CaptureStream(), process: signals },
    deps,
  ).then((value) => {
    code = value;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(signals.listenerCount('SIGINT')).toBe(1);
  expect(signals.listenerCount('SIGTERM')).toBe(1);

  signals.emit('SIGINT');
  await vi.advanceTimersByTimeAsync(0);

  // Still waiting for the connection to close, but without a handler of its own: Node's default
  // handling ends the process at the next Ctrl+C.
  expect(code).toBeUndefined();
  expect(signals.listenerCount('SIGINT')).toBe(0);
  expect(signals.listenerCount('SIGTERM')).toBe(0);
  await vi.advanceTimersByTimeAsync(3000);
  await running;
  expect(code).toBe(0);
  expect(signals.eventNames()).toEqual([]);
});

// The banner and the log end up where others read them, such as a terminal shared on a call.
test('the banner shows the dashboard URL and never the token', async () => {
  const built = createDashboardFiles();
  const token = 'synthetic-token-0123456789abcdef0123456789abcdef';

  try {
    for (const flags of [['--transport', 'http'], ['--dashboard']]) {
      const { logger, lines } = capturingLogger();
      const port = await freePort();
      const signals = new EventEmitter();
      const stderr = new CaptureStream();
      const running = runCli(
        [...flags, '--port', String(port)],
        { ...ENV, TV_MCP_AUTH_TOKEN: token },
        { stdin: new PassThrough(), stdout: new PassThrough(), stderr, process: signals },
        offlineDeps({ logger, dashboardDir: built.dir }),
      );
      const url = `http://127.0.0.1:${String(port)}/`;
      const row = new RegExp(`dashboard +${url.replaceAll('.', '\\.')}\n`);
      await expect.poll(() => stderr.text).toMatch(row);

      expect(lines).toContainEqual(
        expect.objectContaining({ level: 30, url, msg: 'The dashboard is served' }),
      );
      signals.emit('SIGTERM');
      expect(await running).toBe(0);
      expect(stderr.text).not.toContain(token);
      expect(JSON.stringify(lines)).not.toContain(token);
    }
  } finally {
    built.remove();
  }
});
