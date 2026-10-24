import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  CLIENT_IDS,
  parseClientId,
  renderClientConfig,
  resolveCliPath,
  type ClientConfigOptions,
  type ClientId,
} from '../../../src/cli/clients.js';
import { TvMcpError } from '../../../src/core/errors.js';

const NPX_DARWIN: ClientConfigOptions = { platform: 'darwin', command: { kind: 'npx' } };

// The clients that start the server themselves, and the format of their snippet.
const STDIO_CLIENTS = [
  ['claude-desktop', 'json'],
  ['claude-code', 'shell'],
  ['cursor', 'json'],
  ['vscode', 'json'],
  ['windsurf', 'json'],
  ['gemini-cli', 'json'],
  ['codex-cli', 'toml'],
] as const satisfies readonly (readonly [ClientId, string])[];

const JSON_CLIENTS = STDIO_CLIENTS.filter(([, format]) => format === 'json').map(([id]) => id);

// Returns the error, so a test can check its code, message and hint together.
function errorOf(action: () => unknown): TvMcpError {
  try {
    action();
  } catch (error) {
    if (error instanceof TvMcpError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a TvMcpError');
}

function snippetOf(client: ClientId, options: Partial<ClientConfigOptions> = {}): string {
  return renderClientConfig(client, { ...NPX_DARWIN, ...options }).snippet;
}

function notesOf(client: ClientId, options: Partial<ClientConfigOptions> = {}): string[] {
  return renderClientConfig(client, { ...NPX_DARWIN, ...options }).notes;
}

interface Launch {
  type?: unknown;
  command: unknown;
  args: unknown;
}

// The server entry of a JSON snippet: under mcpServers, or under servers for VS Code.
function jsonEntry(snippet: string): Launch {
  const parsed = JSON.parse(snippet) as Record<string, Record<string, Launch> | undefined>;
  const servers = parsed.mcpServers ?? parsed.servers;
  expect(Object.keys(servers ?? {})).toEqual(['tradingview']);
  const entry = servers?.tradingview;
  if (entry === undefined) {
    throw new Error(`no tradingview server in ${snippet}`);
  }
  return entry;
}

// A reader for the TOML of the codex-cli snippet, written from the TOML 1.0 grammar rather than
// from the code under test: table headers of bare keys, and keys set to a basic string or to an
// array of basic strings. Anything else is refused, so a snippet that strays from it shows.
const BARE_KEY = '[A-Za-z0-9_-]+';
const BASIC_STRING =
  // Any character but a quote, a backslash and the controls other than tab, or an escape. The
  // controls are what TOML refuses unescaped, so the pattern has to name them.
  // eslint-disable-next-line no-control-regex
  /"((?:[^"\\\u0000-\u0008\u000a-\u001f\u007f]|\\(?:[btnfr"\\]|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}))*)"/y;
const ESCAPES: Record<string, string> = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  '"': '"',
  '\\': '\\',
};

function unescapeBasic(body: string): string {
  return body.replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/g, (_match, escape: string) => {
    if (escape.length === 1) {
      return ESCAPES[escape] ?? '';
    }
    const code = Number.parseInt(escape.slice(1), 16);
    // TOML takes Unicode scalar values only: a lone surrogate half is an error.
    if (code >= 0xd800 && code <= 0xdfff) {
      throw new Error(`not a scalar value: ${escape}`);
    }
    return String.fromCodePoint(code);
  });
}

function readTomlValue(text: string): string | string[] {
  const strings: string[] = [];
  const array = text.startsWith('[');
  let at = array ? 1 : 0;
  for (;;) {
    BASIC_STRING.lastIndex = at;
    const match = BASIC_STRING.exec(text);
    if (match === null) {
      throw new Error(`not a basic string at ${String(at)}: ${text}`);
    }
    strings.push(unescapeBasic(match[1] ?? ''));
    at = BASIC_STRING.lastIndex;
    if (!array || text.charAt(at) !== ',') {
      break;
    }
    at += text.charAt(at + 1) === ' ' ? 2 : 1;
  }
  const end = array ? ']' : '';
  if (text.slice(at) !== end) {
    throw new Error(`unexpected text after the value: ${text.slice(at)}`);
  }
  return array ? strings : (strings[0] ?? '');
}

function readToml(text: string): Record<string, Record<string, string | string[]>> {
  const tables: Record<string, Record<string, string | string[]>> = {};
  let table: Record<string, string | string[]> | undefined;
  for (const line of text.split('\n')) {
    if (line === '') {
      continue;
    }
    const header = new RegExp(`^\\[(${BARE_KEY}(?:\\.${BARE_KEY})*)\\]$`).exec(line);
    if (header?.[1] !== undefined) {
      table = {};
      tables[header[1]] = table;
      continue;
    }
    const pair = new RegExp(`^(${BARE_KEY}) = (.+)$`).exec(line);
    if (pair?.[1] === undefined || pair[2] === undefined || table === undefined) {
      throw new Error(`not TOML: ${line}`);
    }
    table[pair[1]] = readTomlValue(pair[2]);
  }
  return tables;
}

function tomlEntry(snippet: string): Record<string, string | string[]> {
  const tables = readToml(snippet);
  expect(Object.keys(tables)).toEqual(['mcp_servers.tradingview']);
  return tables['mcp_servers.tradingview'] ?? {};
}

// The words a POSIX shell makes of the server command of the claude-code line.
function shellWords(line: string): string[] {
  const command = line.trimEnd().split(' -- ')[1] ?? '';
  const result = spawnSync('/bin/sh', ['-c', `printf '%s\\n' ${command}`], { encoding: 'utf8' });
  return result.stdout.split('\n').slice(0, -1);
}

const JSON_SNIPPET = `{
  "mcpServers": {
    "tradingview": {
      "command": "npx",
      "args": ["-y", "tradingview-desktop-mcp"]
    }
  }
}
`;

test('the clients are the nine supported ones, in order', () => {
  expect(CLIENT_IDS).toEqual([
    'claude-desktop',
    'claude-code',
    'cursor',
    'vscode',
    'windsurf',
    'gemini-cli',
    'codex-cli',
    'chatgpt',
    'openai-api',
  ]);
});

const SNIPPETS: [ClientId, string][] = [
  ['claude-desktop', JSON_SNIPPET],
  ['claude-code', 'claude mcp add tradingview -- npx -y tradingview-desktop-mcp\n'],
  [
    'cursor',
    `{
  "mcpServers": {
    "tradingview": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "tradingview-desktop-mcp"]
    }
  }
}
`,
  ],
  [
    'vscode',
    `{
  "servers": {
    "tradingview": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "tradingview-desktop-mcp"]
    }
  }
}
`,
  ],
  ['windsurf', JSON_SNIPPET],
  ['gemini-cli', JSON_SNIPPET],
  [
    'codex-cli',
    `[mcp_servers.tradingview]
command = "npx"
args = ["-y", "tradingview-desktop-mcp"]
`,
  ],
  ['chatgpt', 'https://YOUR-TUNNEL-HOST/mcp/<TV_MCP_AUTH_TOKEN>\n'],
  [
    'openai-api',
    `{
  "type": "mcp",
  "server_label": "tradingview",
  "server_url": "https://YOUR-TUNNEL-HOST/mcp",
  "headers": {
    "Authorization": "Bearer <TV_MCP_AUTH_TOKEN>"
  },
  "require_approval": "always"
}
`,
  ],
];

test("renderClientConfig prints each client's snippet", () => {
  expect(SNIPPETS.map(([client]) => client)).toEqual(CLIENT_IDS);
  for (const [client, snippet] of SNIPPETS) {
    const { snippet: printed, notes } = renderClientConfig(client, NPX_DARWIN);

    expect(printed).toBe(snippet);
    // Where it goes, then what to do next, one line each.
    expect(notes.length).toBeGreaterThanOrEqual(2);
    for (const note of notes) {
      expect(note).not.toContain('\n');
      expect(note).not.toBe('');
    }
  }
});

test.each<[ClientId, string, string, string]>([
  [
    'claude-desktop',
    '~/Library/Application Support/Claude/claude_desktop_config.json',
    '%APPDATA%\\Claude\\claude_desktop_config.json',
    '~/.config/Claude/claude_desktop_config.json',
  ],
  ['cursor', '~/.cursor/mcp.json', '%USERPROFILE%\\.cursor\\mcp.json', '~/.cursor/mcp.json'],
  ['vscode', '.vscode/mcp.json', '.vscode/mcp.json', '.vscode/mcp.json'],
  [
    'windsurf',
    '~/.config/devin/mcp_config.json',
    '%APPDATA%\\devin\\mcp_config.json',
    '~/.config/devin/mcp_config.json',
  ],
  [
    'gemini-cli',
    '~/.gemini/settings.json',
    '%USERPROFILE%\\.gemini\\settings.json',
    '~/.gemini/settings.json',
  ],
  [
    'codex-cli',
    '~/.codex/config.toml',
    '%USERPROFILE%\\.codex\\config.toml',
    '~/.codex/config.toml',
  ],
])('the first note of %s names the file for each system', (client, darwin, win32, linux) => {
  expect(notesOf(client, { platform: 'darwin' })[0]).toContain(darwin);
  expect(notesOf(client, { platform: 'win32' })[0]).toContain(win32);
  expect(notesOf(client, { platform: 'linux' })[0]).toContain(linux);
  // Another Unix keeps its files where Linux does.
  expect(notesOf(client, { platform: 'freebsd' })[0]).toContain(linux);
});

test('the notes say what to do next for each client', () => {
  expect(notesOf('claude-desktop')[1]).toContain('quit Claude Desktop');
  expect(notesOf('claude-code')[0]).toContain('--scope user');
  expect(notesOf('claude-code')[1]).toContain('claude mcp get tradingview');
  expect(notesOf('cursor')[0]).toContain('.cursor/mcp.json');
  expect(notesOf('vscode')[0]).toContain('MCP: Open User Configuration');
  expect(notesOf('vscode')[1]).toContain('MCP: List Servers');
  // Windsurf is now Devin Desktop, and its older releases read another file.
  expect(notesOf('windsurf')[0]).toContain('Devin Desktop');
  expect(notesOf('windsurf')[0]).toContain('~/.codeium/windsurf/mcp_config.json');
  expect(notesOf('gemini-cli')[1]).toContain('/mcp');
  expect(notesOf('codex-cli')[1]).toContain('/mcp');
  expect(notesOf('chatgpt')[0]).toContain('Add custom MCP server');
  expect(notesOf('openai-api')[0]).toContain('Responses API');
});

test('the stdio snippets are valid JSON or TOML with the server named tradingview', () => {
  // Paths that need escaping: a quote, a backslash, a space, a character outside ASCII and DEL.
  const paths = [
    '/Users/Zoë "Z" O\'Neil/tv mcp/dist/cli.js',
    'C:\\Program Files\\nodejs\\node_modules\\tradingview-desktop-mcp\\dist\\cli.js',
    '/opt/odd\u007fname/cli.js',
  ];
  for (const options of [
    NPX_DARWIN,
    { ...NPX_DARWIN, profile: 'core' as const },
    ...paths.map((cliPath) => ({ ...NPX_DARWIN, command: { kind: 'local' as const, cliPath } })),
  ]) {
    const launch =
      options.command.kind === 'npx'
        ? { command: 'npx', args: ['-y', 'tradingview-desktop-mcp'] }
        : { command: 'node', args: [options.command.cliPath] };
    const args = [...launch.args, ...(options.profile === undefined ? [] : ['--profile', 'core'])];

    for (const client of JSON_CLIENTS) {
      const entry = jsonEntry(snippetOf(client, options));
      expect(entry.command).toBe(launch.command);
      expect(entry.args).toEqual(args);
    }
    expect(tomlEntry(snippetOf('codex-cli', options))).toEqual({ command: launch.command, args });
  }
});

test('the claude-code line quotes a path for the shell it runs in', () => {
  const cliPath = "/Users/Zoë O'Neil/tv mcp/dist/cli.js";

  const line = snippetOf('claude-code', { command: { kind: 'local', cliPath } });

  expect(line).toBe(
    `claude mcp add tradingview -- node '/Users/Zoë O'\\''Neil/tv mcp/dist/cli.js'\n`,
  );
  expect(shellWords(line)).toEqual(['node', cliPath]);
  // PowerShell and cmd both take a double-quoted path, and a Windows path cannot hold a quote.
  expect(
    snippetOf('claude-code', {
      platform: 'win32',
      command: { kind: 'local', cliPath: 'C:\\Program Files\\tv\\cli.js' },
    }),
  ).toBe('claude mcp add tradingview -- node "C:\\Program Files\\tv\\cli.js"\n');
});

test('--local snippets start the given path with node', () => {
  const command = { kind: 'local', cliPath: '/opt/tv/dist/cli.js' } as const;

  for (const client of JSON_CLIENTS) {
    expect(jsonEntry(snippetOf(client, { command }))).toMatchObject({
      command: 'node',
      args: ['/opt/tv/dist/cli.js'],
    });
  }
  expect(snippetOf('claude-code', { command })).toBe(
    'claude mcp add tradingview -- node /opt/tv/dist/cli.js\n',
  );
  expect(tomlEntry(snippetOf('codex-cli', { command }))).toEqual({
    command: 'node',
    args: ['/opt/tv/dist/cli.js'],
  });
});

test('a path inside the npx cache comes with a note that npm can clear it', () => {
  const cached = '/Users/me/.npm/_npx/0a1b2c3d/node_modules/tradingview-desktop-mcp/dist/cli.js';
  const installed = '/usr/local/lib/node_modules/tradingview-desktop-mcp/dist/cli.js';

  const notes = notesOf('claude-desktop', { command: { kind: 'local', cliPath: cached } });

  expect(notes.at(-1)).toContain('npm install -g tradingview-desktop-mcp');
  expect(
    notesOf('claude-desktop', {
      platform: 'win32',
      command: {
        kind: 'local',
        cliPath: 'C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\0a\\cli.js',
      },
    }).at(-1),
  ).toContain('npm install -g');
  expect(notesOf('claude-desktop', { command: { kind: 'local', cliPath: installed } })).toEqual(
    notesOf('claude-desktop'),
  );
});

// None of the clients' current documentation asks for cmd /c: Claude Desktop's shows npx started
// directly on Windows, and Claude Code dropped its cmd /c warning as a false positive. So the
// snippet keeps npx, and on Windows a last note gives the cmd /c form for a client that cannot
// start npx directly. A path from --local is kept as given.
const CMD_ARGS = '["/c", "npx", "-y", "tradingview-desktop-mcp"]';
const JSON_FALLBACK = `"command": "cmd", "args": ${CMD_ARGS}`;

test('--platform win32 uses cmd /c npx where the client needs it', () => {
  for (const [client, format] of STDIO_CLIENTS) {
    const windows = renderClientConfig(client, { ...NPX_DARWIN, platform: 'win32' });
    const fallback = windows.notes.at(-1) ?? '';

    expect(windows.snippet).toBe(snippetOf(client));
    expect(windows.snippet).not.toContain('cmd');
    expect(windows.notes).toHaveLength(notesOf(client).length + 1);
    expect(fallback).toContain('cannot start npx');
    if (format === 'json') {
      // The members as they are written, which read back as the cmd launch.
      expect(fallback).toContain(JSON_FALLBACK);
      expect(JSON.parse(`{${JSON_FALLBACK}}`)).toEqual({
        command: 'cmd',
        args: ['/c', 'npx', '-y', 'tradingview-desktop-mcp'],
      });
    }
  }
  expect(notesOf('codex-cli', { platform: 'win32' }).at(-1)).toContain(
    `command = "cmd" and args = ${CMD_ARGS}`,
  );
  expect(tomlEntry(`[mcp_servers.tradingview]\ncommand = "cmd"\nargs = ${CMD_ARGS}\n`)).toEqual({
    command: 'cmd',
    args: ['/c', 'npx', '-y', 'tradingview-desktop-mcp'],
  });
  expect(notesOf('claude-code', { platform: 'win32' }).at(-1)).toContain(
    'claude mcp add tradingview -- cmd /c npx -y tradingview-desktop-mcp',
  );

  // The fallback keeps the profile, and is for npx on Windows alone.
  expect(notesOf('cursor', { platform: 'win32', profile: 'core' }).at(-1)).toContain(
    '"args": ["/c", "npx", "-y", "tradingview-desktop-mcp", "--profile", "core"]',
  );
  for (const [client] of STDIO_CLIENTS) {
    expect(notesOf(client, { platform: 'linux' }).join('\n')).not.toContain('cmd');
  }
  for (const client of ['chatgpt', 'openai-api'] as const) {
    expect(notesOf(client, { platform: 'win32' }).join('\n')).not.toContain('cmd /c');
  }

  const cliPath =
    'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\tradingview-desktop-mcp\\dist\\cli.js';
  const local = { platform: 'win32', command: { kind: 'local', cliPath } } as const;
  expect(snippetOf('claude-desktop', local)).toContain(JSON.stringify(cliPath));
  expect(jsonEntry(snippetOf('claude-desktop', local))).toEqual({
    command: 'node',
    args: [cliPath],
  });
  // node is a program of its own, so it needs no cmd.
  expect(notesOf('claude-desktop', local).join('\n')).not.toContain('cmd');
});

test('an explicit --profile is added to the args', () => {
  for (const client of JSON_CLIENTS) {
    expect(jsonEntry(snippetOf(client, { profile: 'readonly' })).args).toEqual([
      '-y',
      'tradingview-desktop-mcp',
      '--profile',
      'readonly',
    ]);
  }
  expect(snippetOf('claude-code', { profile: 'readonly' })).toBe(
    'claude mcp add tradingview -- npx -y tradingview-desktop-mcp --profile readonly\n',
  );
  expect(tomlEntry(snippetOf('codex-cli', { profile: 'core' })).args).toEqual([
    '-y',
    'tradingview-desktop-mcp',
    '--profile',
    'core',
  ]);

  // A remote client gets the readonly profile when none is given, and the one given otherwise.
  for (const client of ['chatgpt', 'openai-api'] as const) {
    expect(notesOf(client).join('\n')).toContain(
      'npx -y tradingview-desktop-mcp --transport http --profile readonly',
    );
    expect(notesOf(client, { profile: 'full' }).join('\n')).toContain(
      'npx -y tradingview-desktop-mcp --transport http --profile full',
    );
    // The profile is a setting of the server, not of the snippet.
    expect(snippetOf(client, { profile: 'full' })).toBe(snippetOf(client));
  }
});

test('the remote clients take the host from --url and keep its port', () => {
  expect(snippetOf('chatgpt', { url: 'abc.ngrok.app' })).toBe(
    'https://abc.ngrok.app/mcp/<TV_MCP_AUTH_TOKEN>\n',
  );
  expect(snippetOf('chatgpt', { url: 'tunnel.example:8443' })).toBe(
    'https://tunnel.example:8443/mcp/<TV_MCP_AUTH_TOKEN>\n',
  );
  expect(
    (JSON.parse(snippetOf('openai-api', { url: 'abc.ngrok.app' })) as Record<string, unknown>)
      .server_url,
  ).toBe('https://abc.ngrok.app/mcp');

  for (const client of ['chatgpt', 'openai-api'] as const) {
    const notes = notesOf(client, { url: 'abc.ngrok.app' }).join('\n');
    expect(notes).toContain('TV_MCP_ALLOWED_HOSTS=abc.ngrok.app');
    expect(notes).toContain('tunnel');
    expect(notesOf(client).join('\n')).toContain('TV_MCP_ALLOWED_HOSTS=YOUR-TUNNEL-HOST');
  }
  // The connector URL is the token, and the notes say so.
  expect(notesOf('chatgpt').join('\n')).toMatch(/anyone who has it/i);
});

test('the remote clients start this installation with node when --local is given', () => {
  const notes = notesOf('chatgpt', {
    platform: 'win32',
    command: { kind: 'local', cliPath: 'C:\\Program Files\\tv\\cli.js' },
  });

  expect(notes.join('\n')).toContain(
    'node "C:\\Program Files\\tv\\cli.js" --transport http --profile readonly',
  );
});

test('--url is refused for a client that starts the server itself', () => {
  for (const [client] of STDIO_CLIENTS) {
    const error = errorOf(() =>
      renderClientConfig(client, { ...NPX_DARWIN, url: 'abc.ngrok.app' }),
    );

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('--url');
    expect(error.message).toContain(client);
    expect(error.hint).toContain('chatgpt');
  }
});

test('an unknown client lists the clients and suggests the closest', () => {
  const cases = [
    ['vs-code', 'Did you mean "vscode"?'],
    ['chat-gpt', 'Did you mean "chatgpt"?'],
    ['Cursor', 'Did you mean "cursor"?'],
    ['claude-desktp', 'Did you mean "claude-desktop"?'],
    // The first part of a name counts, so a name shared by two clients suggests both.
    ['claude', 'Did you mean "claude-desktop" or "claude-code"?'],
    ['codex', 'Did you mean "codex-cli"?'],
    ['Gemini', 'Did you mean "gemini-cli"?'],
  ];

  for (const [name = '', suggestion = ''] of cases) {
    const error = errorOf(() => parseClientId([name]));

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe(`Unknown client ${JSON.stringify(name)}. ${suggestion}`);
    expect(error.hint).toBe(`Valid clients: ${CLIENT_IDS.join(', ')}`);
  }
  expect(errorOf(() => parseClientId(['zzzzzzzz'])).message).toBe('Unknown client "zzzzzzzz"');
  expect(errorOf(() => parseClientId(['c'])).message).toBe('Unknown client "c"');
});

test('config needs exactly one client', () => {
  const missing = errorOf(() => parseClientId([]));
  const two = errorOf(() => parseClientId(['cursor', 'vscode']));

  expect(missing.code).toBe('INVALID_INPUT');
  expect(missing.message).toBe('The config command needs the name of a client');
  expect(missing.hint).toContain(CLIENT_IDS.join(', '));
  expect(two.code).toBe('INVALID_INPUT');
  expect(two.message).toBe('The config command takes one client, but got "cursor", "vscode"');
  expect(two.hint).toContain(CLIENT_IDS.join(', '));
});

test.each(CLIENT_IDS)('parseClientId accepts %s', (client) => {
  expect(parseClientId([client])).toBe(client);
});

describe('resolveCliPath', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tv-mcp-cli-path-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('follows the link that npx and a global install start the CLI through', () => {
    const cli = join(dir, 'node_modules', 'tradingview-desktop-mcp', 'dist', 'cli.js');
    mkdirSync(join(cli, '..'), { recursive: true });
    writeFileSync(cli, '');
    const bin = join(dir, 'node_modules', '.bin');
    mkdirSync(bin);
    const link = join(bin, 'tradingview-desktop-mcp');
    symlinkSync(cli, link);

    expect(resolveCliPath(link)).toBe(realpathSync(cli));
  });

  test('makes a path that cannot be resolved absolute', () => {
    const resolved = resolveCliPath(join('no', 'such', 'cli.js'));

    expect(isAbsolute(resolved)).toBe(true);
    expect(resolved).toContain(join('no', 'such', 'cli.js'));
  });

  test('refuses when no script is running', () => {
    for (const script of [undefined, '']) {
      const error = errorOf(() => resolveCliPath(script));

      expect(error.code).toBe('INVALID_INPUT');
      expect(error.hint).toContain('npx');
    }
  });
});
