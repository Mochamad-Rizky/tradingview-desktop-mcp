import { parseArgs } from 'node:util';
import type { z } from 'zod';
import { TvMcpError } from '../core/errors.js';
import { CLI_COMMANDS, DEFAULTS, settingSchemas } from './schema.js';
import type { CliCommand, Config } from './schema.js';

// The flags of design spec 9. The value flags are plain strings here and are validated like their
// variables, so both sources share one set of rules and messages.
const OPTIONS = {
  'cdp-host': { type: 'string' },
  'cdp-port': { type: 'string' },
  'app-path': { type: 'string' },
  'log-level': { type: 'string' },
  transport: { type: 'string' },
  host: { type: 'string' },
  port: { type: 'string' },
  profile: { type: 'string' },
  tools: { type: 'string' },
  'allow-eval': { type: 'boolean' },
  dashboard: { type: 'boolean' },
  'no-dashboard': { type: 'boolean' },
  // The CLI answers these itself before it loads a configuration, so they change nothing here.
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

type StringOption = {
  [K in keyof typeof OPTIONS]: (typeof OPTIONS)[K]['type'] extends 'string' ? K : never;
}[keyof typeof OPTIONS];

type Flags = ReturnType<typeof parseFlags>['values'];

const VALID_OPTIONS = Object.keys(OPTIONS)
  .map((name) => `--${name}`)
  .join(', ');

// The auth token has no flag on purpose, and the hint says where it goes instead, because
// --auth-token is the first thing a user will try.
const UNKNOWN_OPTION_HINT =
  `Valid options: ${VALID_OPTIONS}. TV_LAUNCH_TIMEOUT_MS, TV_CALL_TIMEOUT_MS and ` +
  'TV_MCP_AUTH_TOKEN have no flag: set them as environment variables.';

const LOOPBACK_HINT =
  "TradingView's debug port gives full control of the app, so the server only connects to it on " +
  'this machine. Use 127.0.0.1.';

const TOKEN_HINT =
  'Set TV_MCP_AUTH_TOKEN to a random secret, for example the output of "openssl rand -hex 32", ' +
  'or use the stdio transport.';

function isParseArgsError(error: unknown): error is Error & { code: string } {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('ERR_PARSE_ARGS_')
  );
}

function parseFlags(argv: readonly string[]) {
  try {
    return parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: true });
  } catch (error) {
    // Anything else is a bug in the caller or in our option table, not a mistake by the user.
    if (!isParseArgsError(error)) {
      throw error;
    }
    // For an unknown option Node adds advice about positional arguments after the first sentence,
    // which only confuses someone who mistyped a flag, and the hint below is more useful.
    const message = error.message.replace(/\. To specify a positional argument.*$/s, '');
    throw new TvMcpError('INVALID_INPUT', message, {
      // The other parse errors already say what is wrong with the flag they name.
      ...(error.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? { hint: UNKNOWN_OPTION_HINT } : {}),
      cause: error,
    });
  }
}

function isCliCommand(name: string): name is CliCommand {
  return CLI_COMMANDS.some((command) => command === name);
}

function parseCommand(positionals: string[]): { command: CliCommand; commandArgs: string[] } {
  const [name = 'serve', ...commandArgs] = positionals;
  if (!isCliCommand(name)) {
    throw new TvMcpError('INVALID_INPUT', `Unknown command ${JSON.stringify(name)}`, {
      hint: `Valid commands: ${CLI_COMMANDS.join(', ')}`,
    });
  }
  // Without this check a typo such as `serve http` would start the server and ignore the word.
  // The arguments of `config` (the client name) are for the handler of that command to judge.
  if (name !== 'config' && commandArgs.length > 0) {
    const got = commandArgs.map((arg) => JSON.stringify(arg)).join(', ');
    throw new TvMcpError(
      'INVALID_INPUT',
      `The ${name} command takes no arguments, but got ${got}`,
      {
        hint: 'Pass settings as options, for example: serve --transport http',
      },
    );
  }
  return { command: name, commandArgs };
}

function parseDashboardFlag(flags: Flags): boolean | undefined {
  const on = flags.dashboard === true;
  const off = flags['no-dashboard'] === true;
  if (on && off) {
    throw new TvMcpError('INVALID_INPUT', 'Pass either --dashboard or --no-dashboard, not both');
  }
  if (on) {
    return true;
  }
  return off ? false : undefined;
}

// Whitespace around a value is a copy-and-paste artifact, and a blank one means "not set": compose
// files and a copied .env.example pass unset variables as empty strings. For the auth token this
// also means a blank secret can never be accepted.
function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === '' ? undefined : trimmed;
}

interface Source {
  // How the user wrote it, so an error points at the thing to fix: "--cdp-port" or "TV_CDP_PORT".
  name: string;
  raw: string;
}

// The flag wins over the variable. A blank flag does not count as given, so the variable applies.
function pickSource(
  env: NodeJS.ProcessEnv,
  flags: Flags,
  variable: string,
  flag: StringOption | undefined,
): Source | undefined {
  if (flag !== undefined) {
    const raw = present(flags[flag]);
    if (raw !== undefined) {
      return { name: `--${flag}`, raw };
    }
  }
  const raw = present(env[variable]);
  return raw === undefined ? undefined : { name: variable, raw };
}

// A config is shared by every component for the life of the process, so a stray write would change
// behavior far from where it happened. Frozen, it throws instead. The array stays typed string[]
// because the consumers that take patterns declare it that way.
function freeze(config: Config): Readonly<Config> {
  Object.freeze(config.toolPatterns);
  return Object.freeze(config);
}

// Pure on purpose: the caller passes argv (without the node and script entries) and env, so tests
// need no process state and printing stays the job of the CLI. Precedence is flag, then variable,
// then default, and only the source that wins is validated.
export function loadConfig(input: { argv: readonly string[]; env: NodeJS.ProcessEnv }): {
  command: CliCommand;
  commandArgs: string[];
  config: Readonly<Config>;
} {
  const { env } = input;
  const { values: flags, positionals } = parseFlags(input.argv);
  const { command, commandArgs } = parseCommand(positionals);
  const dashboardFlag = parseDashboardFlag(flags);

  const read = <S extends z.ZodType>(
    schema: S,
    variable: string,
    flag?: StringOption,
    hint?: string,
  ): z.output<S> | undefined => {
    const source = pickSource(env, flags, variable, flag);
    if (source === undefined) {
      return undefined;
    }
    const result = schema.safeParse(source.raw);
    if (result.success) {
      return result.data;
    }
    const problem = result.error.issues.map((issue) => issue.message).join('; ');
    throw new TvMcpError(
      'INVALID_INPUT',
      // The value is quoted so that a typo stands out.
      `${source.name} ${problem}, but got ${JSON.stringify(source.raw)}`,
      hint === undefined ? {} : { hint },
    );
  };

  const cdpHost =
    read(settingSchemas.loopbackHost, 'TV_CDP_HOST', 'cdp-host', LOOPBACK_HINT) ?? DEFAULTS.cdpHost;
  const cdpPort = read(settingSchemas.port, 'TV_CDP_PORT', 'cdp-port') ?? DEFAULTS.cdpPort;
  const appPath = read(settingSchemas.text, 'TV_APP_PATH', 'app-path');
  const launchTimeoutMs =
    read(settingSchemas.timeoutMs, 'TV_LAUNCH_TIMEOUT_MS') ?? DEFAULTS.launchTimeoutMs;
  const callTimeoutMs =
    read(settingSchemas.timeoutMs, 'TV_CALL_TIMEOUT_MS') ?? DEFAULTS.callTimeoutMs;
  const logLevel =
    read(settingSchemas.logLevel, 'TV_MCP_LOG_LEVEL', 'log-level') ?? DEFAULTS.logLevel;
  const transport =
    read(settingSchemas.transport, 'TV_MCP_TRANSPORT', 'transport') ?? DEFAULTS.transport;
  const httpHost = read(settingSchemas.text, 'TV_MCP_HTTP_HOST', 'host') ?? DEFAULTS.httpHost;
  const httpPort = read(settingSchemas.port, 'TV_MCP_HTTP_PORT', 'port') ?? DEFAULTS.httpPort;
  // Environment only: a flag would show the secret in the process list.
  const authToken = read(settingSchemas.text, 'TV_MCP_AUTH_TOKEN');
  const profile = read(settingSchemas.profile, 'TV_MCP_PROFILE', 'profile') ?? DEFAULTS.profile;
  const toolPatterns = read(settingSchemas.toolPatterns, 'TV_MCP_TOOLS', 'tools') ?? [];
  const allowEval =
    flags['allow-eval'] ?? read(settingSchemas.boolean, 'TV_MCP_ALLOW_EVAL') ?? DEFAULTS.allowEval;
  // Without a flag or a variable the dashboard follows the transport: on for http, off for stdio.
  const dashboard =
    dashboardFlag ?? read(settingSchemas.boolean, 'TV_MCP_DASHBOARD') ?? transport === 'http';

  // Only serving opens a listener. Requiring the secret for doctor, launch and config would break
  // them for anyone who selects http in their shell profile.
  if (command === 'serve' && transport === 'http' && authToken === undefined) {
    throw new TvMcpError('INVALID_INPUT', 'TV_MCP_AUTH_TOKEN is required for the HTTP transport', {
      hint: TOKEN_HINT,
    });
  }

  const config: Config = {
    cdpHost,
    cdpPort,
    // With exactOptionalPropertyTypes an absent value must stay a missing key.
    ...(appPath === undefined ? {} : { appPath }),
    launchTimeoutMs,
    callTimeoutMs,
    logLevel,
    transport,
    httpHost,
    httpPort,
    ...(authToken === undefined ? {} : { authToken }),
    profile,
    toolPatterns,
    allowEval,
    dashboard,
  };
  return { command, commandArgs, config: freeze(config) };
}
