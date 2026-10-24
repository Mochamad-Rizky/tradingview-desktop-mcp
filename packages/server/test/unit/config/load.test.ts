import { readFileSync } from 'node:fs';
import { loadConfig } from '../../../src/config/load.js';
import type { Config } from '../../../src/config/schema.js';
import { TvMcpError } from '../../../src/core/errors.js';

const realArgv = process.argv;

afterEach(() => {
  process.argv = realArgv;
  vi.unstubAllEnvs();
});

function load(argv: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return loadConfig({ argv, env });
}

// Returns the error, so a test can check its code, message and hint together.
function loadError(argv: string[] = [], env: NodeJS.ProcessEnv = {}): TvMcpError {
  try {
    loadConfig({ argv, env });
  } catch (error) {
    if (error instanceof TvMcpError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected loadConfig to throw');
}

// Everything a user reads when the CLI prints the error.
function textOf(error: TvMcpError): string {
  return `${error.message}\n${error.hint ?? ''}`;
}

// The variables of design spec 9 and TV_MCP_ALLOWED_HOSTS, copied by hand so the assertions below
// do not depend on the code under test.
const SPEC_VARIABLES = [
  'TV_CDP_HOST',
  'TV_CDP_PORT',
  'TV_APP_PATH',
  'TV_LAUNCH_TIMEOUT_MS',
  'TV_CALL_TIMEOUT_MS',
  'TV_MCP_LOG_LEVEL',
  'TV_MCP_TRANSPORT',
  'TV_MCP_HTTP_HOST',
  'TV_MCP_HTTP_PORT',
  'TV_MCP_AUTH_TOKEN',
  'TV_MCP_PROFILE',
  'TV_MCP_TOOLS',
  'TV_MCP_ALLOW_EVAL',
  'TV_MCP_DASHBOARD',
  'TV_MCP_ALLOWED_HOSTS',
];

// Satisfies the HTTP transport's token rule when a test is about something else.
const HTTP_ENV = { TV_MCP_AUTH_TOKEN: 'secret' };

test('uses documented defaults', () => {
  const { command, commandArgs, config } = load();

  expect(command).toBe('serve');
  expect(commandArgs).toEqual([]);
  // toStrictEqual tells a missing key apart from a key that holds undefined: appPath and
  // authToken must be absent.
  expect(config).toStrictEqual({
    cdpHost: '127.0.0.1',
    cdpPort: 9222,
    launchTimeoutMs: 60000,
    callTimeoutMs: 15000,
    logLevel: 'info',
    transport: 'stdio',
    httpHost: '127.0.0.1',
    httpPort: 8787,
    profile: 'full',
    toolPatterns: [],
    allowEval: false,
    dashboard: false,
    allowedHosts: [],
  });
});

test('CLI flags override environment variables', () => {
  const { config } = load(['--cdp-port', '9444'], { TV_CDP_PORT: '9333' });

  expect(config.cdpPort).toBe(9444);
});

interface PrecedenceCase {
  key: keyof Config;
  variable: string;
  flag: string;
  // The two texts differ from each other and from the default, so each source is distinguishable.
  envText: string;
  envValue: unknown;
  flagText: string;
  flagValue: unknown;
}

// The text, number and list settings that have both a variable and a flag. The transport (choosing
// http also needs a token) and the two on/off switches have their own tests.
const PRECEDENCE_CASES: PrecedenceCase[] = [
  {
    key: 'cdpHost',
    variable: 'TV_CDP_HOST',
    flag: '--cdp-host',
    envText: 'localhost',
    envValue: 'localhost',
    flagText: '::1',
    flagValue: '::1',
  },
  {
    key: 'cdpPort',
    variable: 'TV_CDP_PORT',
    flag: '--cdp-port',
    envText: '9333',
    envValue: 9333,
    flagText: '9444',
    flagValue: 9444,
  },
  {
    key: 'appPath',
    variable: 'TV_APP_PATH',
    flag: '--app-path',
    envText: '/opt/env/TradingView',
    envValue: '/opt/env/TradingView',
    flagText: '/opt/flag/TradingView',
    flagValue: '/opt/flag/TradingView',
  },
  {
    key: 'logLevel',
    variable: 'TV_MCP_LOG_LEVEL',
    flag: '--log-level',
    envText: 'warn',
    envValue: 'warn',
    flagText: 'debug',
    flagValue: 'debug',
  },
  {
    key: 'httpHost',
    variable: 'TV_MCP_HTTP_HOST',
    flag: '--host',
    envText: 'localhost',
    envValue: 'localhost',
    flagText: '0.0.0.0',
    flagValue: '0.0.0.0',
  },
  {
    key: 'httpPort',
    variable: 'TV_MCP_HTTP_PORT',
    flag: '--port',
    envText: '9001',
    envValue: 9001,
    flagText: '9002',
    flagValue: 9002,
  },
  {
    key: 'profile',
    variable: 'TV_MCP_PROFILE',
    flag: '--profile',
    envText: 'readonly',
    envValue: 'readonly',
    flagText: 'core',
    flagValue: 'core',
  },
  {
    key: 'toolPatterns',
    variable: 'TV_MCP_TOOLS',
    flag: '--tools',
    envText: 'chart_*',
    envValue: ['chart_*'],
    flagText: 'data_*,app_health',
    flagValue: ['data_*', 'app_health'],
  },
];

test.each(PRECEDENCE_CASES)('$variable sets $key', ({ key, variable, envText, envValue }) => {
  expect(load([], { [variable]: envText }).config[key]).toEqual(envValue);
});

test.each(PRECEDENCE_CASES)(
  '$flag sets $key and beats $variable',
  ({ key, variable, flag, envText, flagText, flagValue }) => {
    expect(load([flag, flagText]).config[key]).toEqual(flagValue);
    expect(load([flag, flagText], { [variable]: envText }).config[key]).toEqual(flagValue);
  },
);

test('--transport beats TV_MCP_TRANSPORT in both directions', () => {
  expect(load([], { ...HTTP_ENV, TV_MCP_TRANSPORT: 'http' }).config.transport).toBe('http');
  expect(
    load(['--transport', 'stdio'], { ...HTTP_ENV, TV_MCP_TRANSPORT: 'http' }).config.transport,
  ).toBe('stdio');
  expect(
    load(['--transport', 'http'], { ...HTTP_ENV, TV_MCP_TRANSPORT: 'stdio' }).config.transport,
  ).toBe('http');
});

test('ignores an invalid variable that a flag overrides', () => {
  const { config } = load(['--cdp-port', '9444'], { TV_CDP_PORT: 'not-a-port' });

  expect(config.cdpPort).toBe(9444);
});

test('rejects a non-loopback CDP host', () => {
  const error = loadError([], { TV_CDP_HOST: '192.168.1.5' });

  expect(error.code).toBe('INVALID_INPUT');
  expect(error.message).toContain('TV_CDP_HOST');
  // The user needs to know what to use instead, and why the server is strict about it.
  expect(error.hint).toContain('127.0.0.1');
});

// Each value defeats a plausible but too loose check: a prefix test (127.0.0.2), a suffix or
// substring test (localhost.evil.com, 127.0.0.1.evil.com), "any address means this machine"
// (0.0.0.0, ::), or a host that carries a port.
test.each([
  '0.0.0.0',
  '::',
  '192.168.1.5',
  'example.com',
  'localhost.evil.com',
  '127.0.0.1.evil.com',
  '127.0.0.2',
  '[::1]',
  '127.0.0.1:9222',
])('rejects %s as a CDP host', (host) => {
  expect(loadError([], { TV_CDP_HOST: host }).code).toBe('INVALID_INPUT');
});

test('names the flag when the non-loopback CDP host came from --cdp-host', () => {
  const error = loadError(['--cdp-host', '10.0.0.5'], { TV_CDP_HOST: '127.0.0.1' });

  expect(error.code).toBe('INVALID_INPUT');
  expect(error.message).toContain('--cdp-host');
});

test.each([
  ['127.0.0.1', '127.0.0.1'],
  ['localhost', 'localhost'],
  ['::1', '::1'],
  ['LocalHost', 'localhost'],
])('accepts %s as a CDP host and keeps it as %s', (text, expected) => {
  expect(load([], { TV_CDP_HOST: text }).config.cdpHost).toBe(expected);
});

test('requires an auth token for the HTTP transport', () => {
  const error = loadError(['--transport', 'http']);

  expect(error.code).toBe('INVALID_INPUT');
  expect(error.hint).toContain('TV_MCP_AUTH_TOKEN');
});

test('requires an auth token when the HTTP transport comes from the environment', () => {
  const error = loadError([], { TV_MCP_TRANSPORT: 'http' });

  expect(error.code).toBe('INVALID_INPUT');
  expect(error.hint).toContain('TV_MCP_AUTH_TOKEN');
});

// An empty secret would let a request with an empty Bearer value through.
test.each(['', '   '])(
  'treats the blank auth token %j as missing for the HTTP transport',
  (token) => {
    const error = loadError(['--transport', 'http'], { TV_MCP_AUTH_TOKEN: token });

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.hint).toContain('TV_MCP_AUTH_TOKEN');
  },
);

test('accepts the HTTP transport with an auth token and trims it', () => {
  const { config } = load(['--transport', 'http'], { TV_MCP_AUTH_TOKEN: ' s3cret\n' });

  expect(config.transport).toBe('http');
  expect(config.authToken).toBe('s3cret');
});

test('does not ask for an auth token when stdio is selected, and keeps one that is given', () => {
  expect(load([], { TV_MCP_TRANSPORT: 'stdio' }).config).not.toHaveProperty('authToken');
  expect(load(['--transport', 'stdio'], { TV_MCP_TRANSPORT: 'http' }).config.transport).toBe(
    'stdio',
  );
  expect(load([], { TV_MCP_AUTH_TOKEN: 's3cret' }).config.authToken).toBe('s3cret');
});

// Selecting http in a shell profile must not break the commands that never serve.
test.each(['launch', 'doctor', 'config'])(
  'does not require an auth token for the %s command',
  (command) => {
    expect(load([command, '--transport', 'http'], {}).config.transport).toBe('http');
  },
);

test('enables the dashboard by default in HTTP mode', () => {
  expect(load(['--transport', 'http'], HTTP_ENV).config.dashboard).toBe(true);
  expect(load(['--transport', 'http', '--no-dashboard'], HTTP_ENV).config.dashboard).toBe(false);
});

test('keeps the dashboard off in stdio mode unless it is asked for', () => {
  expect(load().config.dashboard).toBe(false);
  expect(load(['--dashboard']).config.dashboard).toBe(true);
  expect(load([], { TV_MCP_DASHBOARD: 'true' }).config.dashboard).toBe(true);
});

test('TV_MCP_DASHBOARD overrides the transport default and a flag overrides the variable', () => {
  const http = ['--transport', 'http'];

  expect(load(http, { ...HTTP_ENV, TV_MCP_DASHBOARD: 'false' }).config.dashboard).toBe(false);
  expect(
    load([...http, '--dashboard'], { ...HTTP_ENV, TV_MCP_DASHBOARD: 'false' }).config.dashboard,
  ).toBe(true);
  expect(load(['--no-dashboard'], { TV_MCP_DASHBOARD: 'true' }).config.dashboard).toBe(false);
});

test('rejects --dashboard together with --no-dashboard', () => {
  const error = loadError(['--dashboard', '--no-dashboard']);

  expect(error.code).toBe('INVALID_INPUT');
  expect(textOf(error)).toContain('--no-dashboard');
});

test('parses tool patterns', () => {
  const { config } = load([], { TV_MCP_TOOLS: 'chart_*, data_get_ohlcv' });

  expect(config.toolPatterns).toEqual(['chart_*', 'data_get_ohlcv']);
});

test('drops empty tool patterns', () => {
  expect(load(['--tools', ',chart_* ,, ']).config.toolPatterns).toEqual(['chart_*']);
});

// Design spec 9 documents "all" as the default of the tool filter, so it has to select every tool
// like an empty filter does, not a tool named "all" (there is none, so nothing would be served).
test.each(['all', 'ALL', ' All ', 'all,'])(
  'a lone %j in TV_MCP_TOOLS selects every tool',
  (text) => {
    expect(load([], { TV_MCP_TOOLS: text }).config.toolPatterns).toEqual([]);
  },
);

test('--tools all selects every tool and beats TV_MCP_TOOLS', () => {
  expect(load(['--tools', 'all']).config.toolPatterns).toEqual([]);
  expect(load(['--tools', 'All'], { TV_MCP_TOOLS: 'chart_*' }).config.toolPatterns).toEqual([]);
});

test('reads all as an ordinary pattern when other patterns come with it', () => {
  expect(load(['--tools', 'all,chart_*']).config.toolPatterns).toEqual(['all', 'chart_*']);
});

const ALLOWED_HOSTS_HINT =
  'TV_MCP_ALLOWED_HOSTS takes host names such as abc.ngrok.app, comma-separated';

test('TV_MCP_ALLOWED_HOSTS accepts hosts, host:port and https URLs and normalises them', () => {
  const { config } = load([], {
    TV_MCP_ALLOWED_HOSTS:
      ' abc.ngrok.app , https://Abc.Ngrok.APP/, mymac.local:8443,https://abc.ngrok.app:443,' +
      'tunnel.example:443,[2001:db8::1],,',
  });

  // In order, each one once; blank entries are dropped as for TV_MCP_TOOLS.
  expect(config.allowedHosts).toEqual([
    'abc.ngrok.app',
    'mymac.local:8443',
    'tunnel.example',
    '[2001:db8::1]',
  ]);
});

test('TV_MCP_ALLOWED_HOSTS refuses a path, a wildcard and credentials with the expected form in the hint', () => {
  // What the message quotes of the entry stops at the host, where a pasted URL carries no secret.
  const cases = [
    ['https://abc.ngrok.app/mcp', 'path', 'https://abc.ngrok.app/…'],
    ['*.ngrok.app', 'wildcard', '*.ngrok.app'],
    ['https://user:secret@abc.ngrok.app', 'user name or password', 'https://…@abc.ngrok.app'],
    ['abc.ngrok.app/?x=1', 'query', 'abc.ngrok.app/…'],
  ];

  for (const [entry = '', problem = '', shown = ''] of cases) {
    const error = loadError([], { TV_MCP_ALLOWED_HOSTS: `good.example,${entry}` });

    expect(error.code).toBe('INVALID_INPUT');
    // The variable and the entry at fault are named, never silently dropped, and the hint shows
    // what is expected.
    expect(error.message).toContain('TV_MCP_ALLOWED_HOSTS');
    expect(error.message).toContain(JSON.stringify(shown));
    expect(error.message).toContain(problem);
    expect(error.message).not.toContain('good.example');
    expect(error.message).not.toContain('secret');
    expect(error.hint).toBe(ALLOWED_HOSTS_HINT);
  }
});

test('TV_MCP_ALLOWED_HOSTS refuses an entry that could never match a Host header', () => {
  // A semicolon is not a separator, so this would be one name that no client sends.
  const error = loadError([], { TV_MCP_ALLOWED_HOSTS: 'a.example;b.example' });

  expect(error.code).toBe('INVALID_INPUT');
  expect(error.message).toBe('TV_MCP_ALLOWED_HOSTS: "a.example;b.example" is not a host name');
  expect(error.hint).toBe(ALLOWED_HOSTS_HINT);
});

test('--allowed-hosts beats TV_MCP_ALLOWED_HOSTS', () => {
  expect(load(['--allowed-hosts', 'flag.example']).config.allowedHosts).toEqual(['flag.example']);
  expect(
    load(['--allowed-hosts', 'https://Flag.Example/'], { TV_MCP_ALLOWED_HOSTS: 'env.example' })
      .config.allowedHosts,
  ).toEqual(['flag.example']);
  // Only the source that wins is read, so a broken variable under a flag does no harm.
  expect(
    load(['--allowed-hosts', 'flag.example'], { TV_MCP_ALLOWED_HOSTS: '*.example' }).config
      .allowedHosts,
  ).toEqual(['flag.example']);
});

test('names the flag when the refused allowed host came from --allowed-hosts', () => {
  const error = loadError(['--allowed-hosts', 'http://abc.ngrok.app']);

  expect(error.message).toContain('--allowed-hosts');
  expect(error.message).toContain('"http://abc.ngrok.app"');
  expect(error.hint).toBe(ALLOWED_HOSTS_HINT);
});

test('parses subcommands', () => {
  expect(load(['launch']).command).toBe('launch');

  const { command, commandArgs } = load(['config', 'cursor']);
  expect(command).toBe('config');
  expect(commandArgs).toEqual(['cursor']);
});

test.each(['serve', 'launch', 'doctor'])('parses the %s command without arguments', (name) => {
  const { command, commandArgs } = load([name]);

  expect(command).toBe(name);
  expect(commandArgs).toEqual([]);
});

test('reads flags that come after the subcommand', () => {
  const { command, config } = load(['doctor', '--cdp-port', '9444']);

  expect(command).toBe('doctor');
  expect(config.cdpPort).toBe(9444);
});

test('rejects an unknown subcommand and lists the valid ones', () => {
  const error = loadError(['dcotor']);

  expect(error.code).toBe('INVALID_INPUT');
  expect(textOf(error)).toContain('dcotor');
  for (const valid of ['serve', 'launch', 'doctor', 'config']) {
    expect(textOf(error)).toContain(valid);
  }
});

test.each(['serve', 'launch', 'doctor'])('rejects extra arguments for the %s command', (name) => {
  const error = loadError([name, 'extra']);

  expect(error.code).toBe('INVALID_INPUT');
  expect(textOf(error)).toContain('extra');
});

// Each row is an argument list that util.parseArgs refuses in strict mode.
test.each([
  ['an unknown flag', ['--bogus'], '--bogus'],
  ['an unknown short flag', ['-x'], '-x'],
  ['a flag without its value', ['--cdp-port'], '--cdp-port'],
  ['a switch that was given a value', ['--allow-eval=true'], '--allow-eval'],
  ['a value that looks like a flag', ['--cdp-port', '-1'], '--cdp-port'],
])('rejects %s', (_label, argv, flag) => {
  const error = loadError(argv);

  expect(error.code).toBe('INVALID_INPUT');
  expect(error.message).toContain(flag);
});

test('reports an unknown flag in one short sentence', () => {
  const error = loadError(['--bogus']);

  expect(error.message).toContain('--bogus');
  // Node appends advice about positional arguments, which only confuses someone who mistyped a
  // flag. The hint carries the useful advice instead.
  expect(error.message).not.toContain('positional');
});

// The user cannot cause this one. Reporting it as INVALID_INPUT would send them looking for a
// mistake in their command line, so it has to surface as the bug it is.
test('lets a bug in the caller surface as itself instead of as invalid input', () => {
  const notAnArray = 'config' as unknown as string[];

  expect(() => loadConfig({ argv: notAnArray, env: {} })).toThrow(TypeError);
});

test('keeps the parser error as the cause, for logging', () => {
  expect(loadError(['--bogus']).cause).toBeInstanceOf(Error);
});

// The token comes from the environment only. A copy-paste slip that bound it to a neighboring
// flag would turn, say, --host into the secret, and the secret would be guessable.
test('never takes the auth token from a flag', () => {
  const argv = [
    ['--cdp-host', 'localhost'],
    ['--cdp-port', '9333'],
    ['--app-path', '/opt/tv'],
    ['--log-level', 'warn'],
    ['--transport', 'stdio'],
    ['--host', '0.0.0.0'],
    ['--port', '9000'],
    ['--profile', 'core'],
    ['--tools', 'chart_*'],
    ['--allowed-hosts', 'abc.ngrok.app'],
  ].flat();

  expect(load(argv).config).not.toHaveProperty('authToken');
});

test('shows the rejected value so that a typo is easy to spot', () => {
  expect(loadError([], { TV_MCP_TRANSPORT: 'htp' }).message).toContain('"htp"');
  expect(loadError(['--profile', 'ful']).message).toContain('"ful"');
});

test('lists the valid options when a flag is unknown', () => {
  const hint = loadError(['--auth-token', 'secret']).hint;

  expect(hint).toContain('--cdp-port');
  expect(hint).toContain('--no-dashboard');
  // The secret has no flag on purpose, and the hint says where it goes instead.
  expect(hint).toContain('TV_MCP_AUTH_TOKEN');
});

// The CLI answers these before it loads anything, but a caller may hand loadConfig the whole argv.
test.each(['--help', '-h', '--version', '-v'])('accepts %s and loads the defaults', (flag) => {
  expect(load([flag])).toEqual(load());
});

const BOOLEAN_VARIABLES = ['TV_MCP_ALLOW_EVAL', 'TV_MCP_DASHBOARD'];

test.each(['true', 'TRUE', 'True', '1'])('TV_MCP_ALLOW_EVAL=%s enables eval', (text) => {
  expect(load([], { TV_MCP_ALLOW_EVAL: text }).config.allowEval).toBe(true);
});

test.each(['false', 'FALSE', '0'])('TV_MCP_ALLOW_EVAL=%s keeps eval off', (text) => {
  expect(load([], { TV_MCP_ALLOW_EVAL: text }).config.allowEval).toBe(false);
});

test.each(['true', 'TRUE', 'True', '1'])('TV_MCP_DASHBOARD=%s enables the dashboard', (text) => {
  expect(load([], { TV_MCP_DASHBOARD: text }).config.dashboard).toBe(true);
});

// The dashboard is on by default in HTTP mode, so only there does "off" prove the text was read.
test.each(['false', 'FALSE', '0'])('TV_MCP_DASHBOARD=%s disables the dashboard', (text) => {
  const { config } = load(['--transport', 'http'], { ...HTTP_ENV, TV_MCP_DASHBOARD: text });

  expect(config.dashboard).toBe(false);
});

test('--allow-eval turns eval on even when the variable says false', () => {
  expect(load(['--allow-eval']).config.allowEval).toBe(true);
  expect(load(['--allow-eval'], { TV_MCP_ALLOW_EVAL: 'false' }).config.allowEval).toBe(true);
});

test.each(
  BOOLEAN_VARIABLES.flatMap((variable): [string, string][] =>
    ['yes', 'no', 'on', 'off', '2', 'truee', 'enabled'].map((text) => [variable, text]),
  ),
)('%s rejects the non-boolean %j', (variable, text) => {
  const error = loadError([], { [variable]: text });

  expect(error.code).toBe('INVALID_INPUT');
  expect(error.message).toContain(variable);
});

const PORT_VARIABLES = ['TV_CDP_PORT', 'TV_MCP_HTTP_PORT'];

// Each value defeats a plausible but too lenient parser: Number() accepts 1e3, 0x50 and fractions
// that parseInt would cut, and parseInt accepts 12abc. 0 and 65536 sit just outside the range.
const INVALID_PORTS = ['abc', '0', '65536', '-1', '9222.5', '1e3', '0x50', '12abc'];

test.each(
  PORT_VARIABLES.flatMap((variable): [string, string][] =>
    INVALID_PORTS.map((text) => [variable, text]),
  ),
)('%s rejects the port %j', (variable, text) => {
  const error = loadError([], { [variable]: text });

  expect(error.code).toBe('INVALID_INPUT');
  expect(error.message).toContain(variable);
});

test.each([
  ['--cdp-port', 'abc'],
  ['--cdp-port', '70000'],
  ['--port', 'abc'],
  ['--port', '70000'],
])('%s rejects the port %j and names the flag', (flag, text) => {
  const error = loadError([flag, text], { TV_CDP_PORT: '9222', TV_MCP_HTTP_PORT: '8787' });

  expect(error.code).toBe('INVALID_INPUT');
  expect(error.message).toContain(flag);
});

test.each([
  ['TV_CDP_PORT', 'cdpPort', '1', 1],
  ['TV_CDP_PORT', 'cdpPort', '65535', 65535],
  ['TV_MCP_HTTP_PORT', 'httpPort', '1', 1],
  ['TV_MCP_HTTP_PORT', 'httpPort', '65535', 65535],
] as const)('%s accepts the boundary port %s', (variable, key, text, expected) => {
  expect(load([], { [variable]: text }).config[key]).toBe(expected);
});

const TIMEOUT_CASES = [
  { variable: 'TV_LAUNCH_TIMEOUT_MS', key: 'launchTimeoutMs' },
  { variable: 'TV_CALL_TIMEOUT_MS', key: 'callTimeoutMs' },
] as const;

// 2147483648 is one past the largest delay setTimeout honors. Node clamps anything above it to
// 1 ms, so such a timeout would make every call fail at once instead of never.
const INVALID_TIMEOUTS = ['999', '0', '-5', 'abc', '15.5', '1e4', '2147483648'];

test.each(
  TIMEOUT_CASES.flatMap(({ variable }): [string, string][] =>
    INVALID_TIMEOUTS.map((text) => [variable, text]),
  ),
)('%s rejects the timeout %j', (variable, text) => {
  const error = loadError([], { [variable]: text });

  expect(error.code).toBe('INVALID_INPUT');
  expect(error.message).toContain(variable);
});

test.each(TIMEOUT_CASES)(
  '$variable accepts the smallest and the largest timeout',
  ({ variable, key }) => {
    expect(load([], { [variable]: '1000' }).config[key]).toBe(1000);
    expect(load([], { [variable]: '2147483647' }).config[key]).toBe(2147483647);
  },
);

test.each([
  ['TV_MCP_TRANSPORT', 'tcp'],
  ['TV_MCP_PROFILE', 'admin'],
  ['TV_MCP_LOG_LEVEL', 'verbose'],
])('%s rejects %j', (variable, text) => {
  const error = loadError([], { [variable]: text });

  expect(error.code).toBe('INVALID_INPUT');
  expect(error.message).toContain(variable);
});

test.each([
  ['--transport', 'tcp'],
  ['--profile', 'admin'],
  ['--log-level', 'verbose'],
])('%s rejects %j and names the flag', (flag, text) => {
  const error = loadError([flag, text]);

  expect(error.code).toBe('INVALID_INPUT');
  expect(error.message).toContain(flag);
});

test('lists the accepted values when an enumerated setting is wrong', () => {
  expect(loadError([], { TV_MCP_TRANSPORT: 'tcp' }).message).toContain('stdio, http');
  expect(loadError([], { TV_MCP_PROFILE: 'admin' }).message).toContain('core, full, readonly');
});

test.each(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])(
  'accepts the log level %s',
  (level) => {
    expect(load(['--log-level', level]).config.logLevel).toBe(level);
  },
);

test.each(['core', 'full', 'readonly'])('accepts the profile %s', (profile) => {
  expect(load(['--profile', profile]).config.profile).toBe(profile);
});

test('accepts enumerated and numeric values with other case and surrounding spaces', () => {
  const { config } = load([], {
    ...HTTP_ENV,
    TV_MCP_LOG_LEVEL: ' WARN ',
    TV_MCP_TRANSPORT: 'Http',
    TV_MCP_PROFILE: 'ReadOnly',
    TV_CDP_PORT: ' 9333 ',
  });

  expect(config).toMatchObject({
    logLevel: 'warn',
    transport: 'http',
    profile: 'readonly',
    cdpPort: 9333,
  });
});

// A copied .env.example sets every variable, most of them to nothing, and compose files pass an
// unset variable as an empty string. None of that may change the configuration.
test.each(SPEC_VARIABLES)('treats a blank or undefined %s as unset', (variable) => {
  const expected = load();

  expect(load([], { [variable]: '' })).toStrictEqual(expected);
  expect(load([], { [variable]: '   ' })).toStrictEqual(expected);
  expect(load([], { [variable]: undefined })).toStrictEqual(expected);
});

test('treats a blank flag value as not given, so the variable still applies', () => {
  const { config } = load(['--cdp-port', ''], { TV_CDP_PORT: '9333' });

  expect(config.cdpPort).toBe(9333);
});

test('reads only its input, never process.env or process.argv', () => {
  vi.stubEnv('TV_CDP_PORT', '4242');
  vi.stubEnv('TV_MCP_TRANSPORT', 'http');
  process.argv = ['node', 'cli.js', 'doctor', '--cdp-port', '4343'];

  const { command, config } = load();

  expect(command).toBe('serve');
  expect(config.cdpPort).toBe(9222);
  expect(config.transport).toBe('stdio');
});

test('does not modify the argv and env it is given', () => {
  const argv = Object.freeze(['config', 'cursor', '--cdp-port', '9444']);
  const env = Object.freeze({ TV_CDP_HOST: 'localhost', TV_MCP_TOOLS: 'chart_*' });

  // A frozen input makes any write throw.
  expect(() => loadConfig({ argv, env })).not.toThrow();
});

test('returns a frozen config, so a stray write fails instead of going unnoticed', () => {
  const { config } = load([], { TV_MCP_TOOLS: 'chart_*' });
  // The result is typed Readonly<Config> but must stay usable where a Config is expected.
  const writable: Config = config;

  expect(() => {
    writable.cdpPort = 1;
  }).toThrow(TypeError);
  expect(() => {
    writable.toolPatterns.push('data_*');
  }).toThrow(TypeError);
  expect(() => {
    writable.allowedHosts.push('evil.example');
  }).toThrow(TypeError);
});

// The repository root is five directories above this file.
const ENV_EXAMPLE = new URL('../../../../../.env.example', import.meta.url);

function readEnvExample(): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of readFileSync(ENV_EXAMPLE, 'utf8').split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match !== null) {
      const [, name = '', value = ''] = match;
      entries[name] = value;
    }
  }
  return entries;
}

test('.env.example sets every variable of the design spec and nothing else', () => {
  expect(Object.keys(readEnvExample()).sort()).toEqual([...SPEC_VARIABLES].sort());
});

test('.env.example loads unchanged as the documented defaults', () => {
  expect(load([], readEnvExample())).toStrictEqual(load());
});
