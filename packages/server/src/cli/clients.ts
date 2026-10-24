import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULTS, type Profile } from '../config/schema.js';
import { TvMcpError } from '../core/errors.js';
import { PACKAGE_NAME } from '../version.js';

// The configuration snippet of each supported AI client: what `config <client>` prints and what the
// client tutorials embed. Each renderer cites the documentation its format and file locations come
// from, as they read in October 2026.

export const CLIENT_IDS = [
  'claude-desktop',
  'claude-code',
  'cursor',
  'vscode',
  'windsurf',
  'gemini-cli',
  'codex-cli',
  'chatgpt',
  'openai-api',
] as const;
export type ClientId = (typeof CLIENT_IDS)[number];

// How the client starts the server: through npx, which fetches the published package, or with node
// and the path of an installed copy.
export type ClientCommand = { kind: 'npx' } | { kind: 'local'; cliPath: string };

export interface ClientConfigOptions {
  // The system the client runs on: it decides the file locations in the notes and how a path is
  // quoted on a command line.
  platform: NodeJS.Platform;
  command: ClientCommand;
  // Passed on to the server when given.
  profile?: Profile;
  // The public host of a tunnel, already normalised like an allowed host, for the remote clients.
  url?: string;
}

export interface ClientConfig {
  // Exactly what goes to stdout.
  snippet: string;
  // For stderr, one line each: where the snippet goes, then what to do next.
  notes: string[];
}

const SERVER_NAME = 'tradingview';
// The real token is never printed: the user puts it in where the placeholder is.
const TOKEN_PLACEHOLDER = '<TV_MCP_AUTH_TOKEN>';
const HOST_PLACEHOLDER = 'YOUR-TUNNEL-HOST';
// A remote client reaches the server through a tunnel, so unless the user picks another profile it
// gets the tools that change nothing.
const REMOTE_PROFILE: Profile = 'readonly';
const REMOTE_CLIENTS: readonly ClientId[] = ['chatgpt', 'openai-api'];

// A suggestion further away than this would be a guess rather than the likely typo.
const MAX_SUGGESTION_DISTANCE = 3;

interface Launch {
  command: string;
  args: string[];
}

function launch({ command, profile }: ClientConfigOptions, extra: readonly string[] = []): Launch {
  const tail = [...extra, ...(profile === undefined ? [] : ['--profile', profile])];
  return command.kind === 'npx'
    ? { command: 'npx', args: ['-y', PACKAGE_NAME, ...tail] }
    : { command: 'node', args: [command.cliPath, ...tail] };
}

type JsonText = string | string[] | { [key: string]: JsonText };

// JSON as the clients' documentation writes it: indented by two spaces, with a list of strings on
// one line.
function formatJson(value: JsonText, indent = ''): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => JSON.stringify(item)).join(', ')}]`;
  }
  const inner = `${indent}  `;
  const members = Object.entries(value).map(
    ([key, item]) => `${inner}${JSON.stringify(key)}: ${formatJson(item, inner)}`,
  );
  return `{\n${members.join(',\n')}\n${indent}}`;
}

function jsonSnippet(value: JsonText): string {
  return `${formatJson(value)}\n`;
}

// A TOML basic string takes every escape JSON.stringify writes, but must also escape DEL.
function tomlString(text: string): string {
  return JSON.stringify(text).replaceAll('\u007f', '\\u007F');
}

// A word with only these characters means the same unquoted in a POSIX shell, PowerShell and cmd.
const PLAIN_WORD = /^[\w+:./-]+$/;

function shellWord(word: string, platform: NodeJS.Platform): string {
  if (PLAIN_WORD.test(word)) {
    return word;
  }
  // PowerShell and cmd both read a double-quoted path, and a Windows path cannot hold a double
  // quote. In a POSIX shell a single-quoted word keeps everything but a single quote, which is
  // closed, escaped and opened again.
  return platform === 'win32' ? `"${word}"` : `'${word.replaceAll("'", "'\\''")}'`;
}

function commandLine({ command, args }: Launch, platform: NodeJS.Platform): string {
  return [command, ...args].map((word) => shellWord(word, platform)).join(' ');
}

// A file under the home directory, written the way the user's system writes it.
function homeFile(platform: NodeJS.Platform, ...segments: string[]): string {
  return platform === 'win32' ? `%USERPROFILE%\\${segments.join('\\')}` : `~/${segments.join('/')}`;
}

function stdioEntry(options: ClientConfigOptions): { command: string; args: string[] } {
  const { command, args } = launch(options);
  return { command, args };
}

const KEEP_OTHERS = 'keeping any other servers in mcpServers';

// https://modelcontextprotocol.io/docs/develop/connect-local-servers gives the file for macOS and
// Windows, with npx started directly on both. The Linux file is from the discovery table of
// https://code.visualstudio.com/docs/agents/reference/mcp-configuration
function claudeDesktop(options: ClientConfigOptions): ClientConfig {
  const files: Record<'darwin' | 'win32' | 'linux', string> = {
    darwin: '~/Library/Application Support/Claude/claude_desktop_config.json',
    win32: '%APPDATA%\\Claude\\claude_desktop_config.json',
    linux: '~/.config/Claude/claude_desktop_config.json',
  };
  const { platform } = options;
  const file = platform === 'darwin' || platform === 'win32' ? files[platform] : files.linux;
  return {
    snippet: jsonSnippet({ mcpServers: { [SERVER_NAME]: stdioEntry(options) } }),
    notes: [
      `Put this in ${file}, ${KEEP_OTHERS}. In Claude Desktop, Settings > Developer > Edit Config opens the file.`,
      'Then quit Claude Desktop completely and open it again.',
    ],
  };
}

// https://code.claude.com/docs/en/mcp: `claude mcp add [options] <name> -- <command> [args...]`,
// in the local scope unless --scope says otherwise. The Claude Code changelog (2.1.119) dropped
// the warning that npx needs cmd /c on Windows as a false positive.
function claudeCode(options: ClientConfigOptions): ClientConfig {
  return {
    snippet: `claude mcp add ${SERVER_NAME} -- ${commandLine(launch(options), options.platform)}\n`,
    notes: [
      'Run this in a terminal. It adds the server to the current project; put --scope user before tradingview to add it to every project.',
      'Then check that it connects with: claude mcp get tradingview',
    ],
  };
}

// https://cursor.com/docs/mcp: mcpServers in ~/.cursor/mcp.json or a project's .cursor/mcp.json.
// Its table of stdio fields marks type ("stdio") as required.
function cursor(options: ClientConfigOptions): ClientConfig {
  return {
    snippet: jsonSnippet({
      mcpServers: { [SERVER_NAME]: { type: 'stdio', ...stdioEntry(options) } },
    }),
    notes: [
      `Put this in ${homeFile(options.platform, '.cursor', 'mcp.json')} for every project, or in .cursor/mcp.json in a project, ${KEEP_OTHERS}.`,
      "Then open Customize in Cursor's sidebar and check that tradingview is on.",
    ],
  };
}

// https://code.visualstudio.com/docs/agents/reference/mcp-configuration: the VS Code format, with a
// top-level servers object, in .vscode/mcp.json or the user profile's mcp.json. VS Code also hands
// the servers of this format to Copilot sessions.
function vscode(options: ClientConfigOptions): ClientConfig {
  return {
    snippet: jsonSnippet({
      servers: { [SERVER_NAME]: { type: 'stdio', ...stdioEntry(options) } },
    }),
    notes: [
      'Put this in .vscode/mcp.json in your workspace, or in your user mcp.json (run MCP: Open User Configuration), keeping any other servers.',
      'Then run MCP: List Servers from the Command Palette and start tradingview.',
    ],
  };
}

// https://docs.windsurf.com/windsurf/cascade/mcp now leads to https://docs.devin.ai/desktop/cascade/mcp:
// Windsurf became Devin Desktop in June 2026, and its Cascade and Devin Local agents read
// mcpServers from the Devin configuration directory. Older releases read ~/.codeium/windsurf.
function windsurf(options: ClientConfigOptions): ClientConfig {
  const { platform } = options;
  const file =
    platform === 'win32' ? '%APPDATA%\\devin\\mcp_config.json' : '~/.config/devin/mcp_config.json';
  const legacy = homeFile(platform, '.codeium', 'windsurf', 'mcp_config.json');
  return {
    snippet: jsonSnippet({ mcpServers: { [SERVER_NAME]: stdioEntry(options) } }),
    notes: [
      `Windsurf is now Devin Desktop: put this in ${file}, ${KEEP_OTHERS} (releases from before the new name read ${legacy}). Cascade opens it from its ... (Actions) menu > Open MCP config file.`,
      'Then check that tradingview is on in the MCPs section of that menu.',
    ],
  };
}

// https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md: mcpServers in
// ~/.gemini/settings.json, or .gemini/settings.json in a project.
function geminiCli(options: ClientConfigOptions): ClientConfig {
  return {
    snippet: jsonSnippet({ mcpServers: { [SERVER_NAME]: stdioEntry(options) } }),
    notes: [
      `Put this in ${homeFile(options.platform, '.gemini', 'settings.json')} for every project, or in .gemini/settings.json in a project, keeping your other settings.`,
      'Then start gemini and run /mcp to check that tradingview is connected.',
    ],
  };
}

// https://developers.openai.com/codex/mcp (now https://learn.chatgpt.com/docs/extend/mcp): a
// [mcp_servers.<name>] table with command and args in ~/.codex/config.toml.
function codexCli(options: ClientConfigOptions): ClientConfig {
  const { command, args } = launch(options);
  return {
    snippet: [
      `[mcp_servers.${SERVER_NAME}]`,
      `command = ${tomlString(command)}`,
      `args = [${args.map(tomlString).join(', ')}]`,
      '',
    ].join('\n'),
    notes: [
      `Put this in ${homeFile(options.platform, '.codex', 'config.toml')}, or in .codex/config.toml in a trusted project.`,
      'Then start codex and run /mcp to check that tradingview is listed.',
    ],
  };
}

// What a remote client needs on this machine: the server over HTTP, and a tunnel to it.
function serverNotes(options: ClientConfigOptions, host: string): string[] {
  const start = launch({ ...options, profile: options.profile ?? REMOTE_PROFILE }, [
    '--transport',
    'http',
  ]);
  const address = `http://${DEFAULTS.httpHost}:${String(DEFAULTS.httpPort)}`;
  return [
    `Start the server with TV_MCP_AUTH_TOKEN set to a random secret, such as the output of "openssl rand -hex 32", and TV_MCP_ALLOWED_HOSTS=${host}: ${commandLine(start, options.platform)}`,
    `Then point an HTTPS tunnel whose public host is ${host} at the server, ${address} unless you set --host or --port.`,
  ];
}

// https://developers.openai.com/plugins/deploy/connect-chatgpt: ChatGPT Plugins, +, Add custom MCP
// server, with the URL of the endpoint. ChatGPT cannot send a custom key
// (https://developers.openai.com/plugins/build/auth), so the token goes in the path.
function chatgpt(options: ClientConfigOptions): ClientConfig {
  const host = options.url ?? HOST_PLACEHOLDER;
  return {
    snippet: `https://${host}/mcp/${TOKEN_PLACEHOLDER}\n`,
    notes: [
      `Paste this URL, with your token in place of ${TOKEN_PLACEHOLDER}, as the connection of a custom MCP server in ChatGPT (chatgpt.com/plugins, +, Add custom MCP server), with no authentication.`,
      'The URL holds the token, so anyone who has it can use TradingView through the server: keep it private.',
      ...serverNotes(options, host),
    ],
  };
}

// https://developers.openai.com/api/reference/resources/responses/methods/create: the mcp tool
// takes server_label, server_url, headers ("Optional HTTP headers to send to the MCP server. Use
// for authentication") and require_approval.
function openaiApi(options: ClientConfigOptions): ClientConfig {
  const host = options.url ?? HOST_PLACEHOLDER;
  return {
    snippet: jsonSnippet({
      type: 'mcp',
      server_label: SERVER_NAME,
      server_url: `https://${host}/mcp`,
      headers: { Authorization: `Bearer ${TOKEN_PLACEHOLDER}` },
      require_approval: 'always',
    }),
    notes: [
      `Add this object to the tools of a Responses API request, with your token in place of ${TOKEN_PLACEHOLDER}. Read the token from the environment rather than writing it into your code.`,
      ...serverNotes(options, host),
    ],
  };
}

const RENDERERS: Record<ClientId, (options: ClientConfigOptions) => ClientConfig> = {
  'claude-desktop': claudeDesktop,
  'claude-code': claudeCode,
  cursor,
  vscode,
  windsurf,
  'gemini-cli': geminiCli,
  'codex-cli': codexCli,
  chatgpt,
  'openai-api': openaiApi,
};

// npx runs a package from its cache, which npm may clear: a path in there stops working one day.
const NPX_CACHE = /[\\/]_npx[\\/]/;

const NPX_CACHE_NOTE =
  `That path is in the npx cache, which npm can clear at any time: install the package with ` +
  `"npm install -g ${PACKAGE_NAME}" and run config --local from that installation.`;

// Pure: the same options always give the same snippet and notes.
export function renderClientConfig(client: ClientId, options: ClientConfigOptions): ClientConfig {
  if (options.url !== undefined && !REMOTE_CLIENTS.includes(client)) {
    throw new TvMcpError(
      'INVALID_INPUT',
      `--url names the host a remote client reaches the server at, but ${client} starts the server itself`,
      { hint: `Leave --url out, or use it with ${REMOTE_CLIENTS.join(' or ')}` },
    );
  }
  const { snippet, notes } = RENDERERS[client](options);
  const cached = options.command.kind === 'local' && NPX_CACHE.test(options.command.cliPath);
  return { snippet, notes: cached ? [...notes, NPX_CACHE_NOTE] : notes };
}

// The Levenshtein distance: how many letters must be added, removed or changed to turn one word
// into the other. The table is kept one row at a time.
function editDistance(from: string, to: string): number {
  let row = Array.from({ length: to.length + 1 }, (_, j) => j);
  let distance = to.length;
  for (let i = 1; i <= from.length; i += 1) {
    const letter = from.charAt(i - 1);
    let diagonal = i - 1;
    let left = i;
    const next = [left];
    for (const [j, above] of row.slice(1).entries()) {
      left = Math.min(above + 1, left + 1, diagonal + (letter === to.charAt(j) ? 0 : 1));
      diagonal = above;
      next.push(left);
    }
    row = next;
    distance = left;
  }
  return distance;
}

// How far a name is from a client, which it may also name by its first part alone: claude, codex.
function distanceTo(name: string, client: ClientId): number {
  return Math.min(editDistance(name, client), editDistance(name, client.replace(/-.*$/s, '')));
}

// The clients a mistyped name most likely meant: the nearest ones, unless all are too far.
function suggestions(name: string): ClientId[] {
  const wanted = name.toLowerCase();
  const scored = CLIENT_IDS.map((id) => ({ id, distance: distanceTo(wanted, id) }));
  const best = Math.min(...scored.map(({ distance }) => distance));
  return best > MAX_SUGGESTION_DISTANCE
    ? []
    : scored.filter(({ distance }) => distance === best).map(({ id }) => id);
}

// "a", "a" or "b", "a", "b" or "c".
function quoteList(names: readonly string[]): string {
  const quoted = names.map((name) => JSON.stringify(name));
  return quoted.length === 1
    ? quoted.join('')
    : `${quoted.slice(0, -1).join(', ')} or ${quoted.slice(-1).join('')}`;
}

function isClientId(name: string): name is ClientId {
  return CLIENT_IDS.some((id) => id === name);
}

// The client named by the arguments of config.
export function parseClientId(args: readonly string[]): ClientId {
  const hint = `Valid clients: ${CLIENT_IDS.join(', ')}`;
  const [name, ...rest] = args;
  if (name === undefined) {
    throw new TvMcpError('INVALID_INPUT', 'The config command needs the name of a client', {
      hint,
    });
  }
  if (rest.length > 0) {
    const got = args.map((arg) => JSON.stringify(arg)).join(', ');
    throw new TvMcpError('INVALID_INPUT', `The config command takes one client, but got ${got}`, {
      hint,
    });
  }
  if (isClientId(name)) {
    return name;
  }
  const guesses = suggestions(name);
  const guess = guesses.length === 0 ? '' : `. Did you mean ${quoteList(guesses)}?`;
  throw new TvMcpError('INVALID_INPUT', `Unknown client ${JSON.stringify(name)}${guess}`, { hint });
}

// The real path of the running CLI. npx and a global install start it through a link in a .bin
// folder, which a client configuration must not depend on.
export function resolveCliPath(script: string | undefined): string {
  if (script === undefined || script === '') {
    throw new TvMcpError('INVALID_INPUT', 'No script is running, so --local has no path to print', {
      hint: `Run config --local from the installed ${PACKAGE_NAME} command, or leave --local out to start the server with npx`,
    });
  }
  try {
    return realpathSync(script);
  } catch {
    return resolve(script);
  }
}
