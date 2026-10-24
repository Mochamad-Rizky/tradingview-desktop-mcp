import { z } from 'zod';
import type { LogLevel } from '../core/logger.js';

// The logger owns this type. It is re-exported so code that reads the configuration imports every
// config type from one module.
export type { LogLevel } from '../core/logger.js';

export const CLI_COMMANDS = ['serve', 'launch', 'doctor', 'config'] as const;
export type CliCommand = (typeof CLI_COMMANDS)[number];

const PROFILES = ['core', 'full', 'readonly'] as const;
export type Profile = (typeof PROFILES)[number];

const TRANSPORTS = ['stdio', 'http'] as const;
export type TransportKind = (typeof TRANSPORTS)[number];

// `satisfies` turns a misspelled level into a compile error.
const LOG_LEVELS = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
  'silent',
] as const satisfies readonly LogLevel[];

// The debug port gives full control of the app, so the server only ever connects to it locally.
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'] as const;

// The systems `config` can write a client's snippet for.
const CLIENT_PLATFORMS = ['darwin', 'win32', 'linux'] as const;
export type ClientPlatform = (typeof CLIENT_PLATFORMS)[number];

// The options of the config command, which no other command takes.
export interface ClientOptions {
  // Start the server with node and the path of this installation instead of npx.
  local: boolean;
  // The public host of a tunnel, normalised like an allowed host.
  url?: string;
  // Absent means the system the CLI runs on.
  platform?: ClientPlatform;
  // Only a --profile flag: the client starts the server with an environment of its own, so a
  // TV_MCP_PROFILE of this shell would not reach it.
  profile?: Profile;
}

export interface Config {
  cdpHost: string;
  cdpPort: number;
  // Absent means the app is found automatically.
  appPath?: string;
  launchTimeoutMs: number;
  callTimeoutMs: number;
  logLevel: LogLevel;
  transport: TransportKind;
  httpHost: string;
  httpPort: number;
  // A bearer secret: never log this object as it is.
  authToken?: string;
  profile: Profile;
  // Globs with `*`. Empty means every tool the profile allows; a lone `all` is read as empty.
  toolPatterns: string[];
  allowEval: boolean;
  dashboard: boolean;
  // Host header values the HTTP listener accepts besides its own address, such as a tunnel's public
  // host: lower case, with a port only when it is not 80 or 443. Empty means only its own address.
  allowedHosts: string[];
}

// Settings without an entry here have no fixed default: appPath, authToken, toolPatterns and
// allowedHosts are absent or empty, and the dashboard default depends on the transport.
export const DEFAULTS = {
  cdpHost: '127.0.0.1',
  cdpPort: 9222,
  launchTimeoutMs: 60_000,
  callTimeoutMs: 15_000,
  logLevel: 'info',
  transport: 'stdio',
  httpHost: '127.0.0.1',
  httpPort: 8787,
  profile: 'full',
  allowEval: false,
} as const satisfies Partial<Config>;

const MAX_PORT = 65535;
const MIN_TIMEOUT_MS = 1000;
// The largest delay setTimeout honors. Node clamps anything above it to 1 ms, so a larger timeout
// would make every call fail at once instead of never.
const MAX_TIMEOUT_MS = 2_147_483_647;

// Each schema below reads the text of a variable or flag, so both sources share one set of rules.
// The message is the problem only; the loader puts the name of the variable or flag in front of it.

function wholeNumber(min: number, max: number) {
  const problem = `must be a whole number from ${String(min)} to ${String(max)}`;
  // The regex comes first because Number() alone accepts '1e3', '0x50' and fractions, and
  // parseInt() accepts '12abc'.
  return z
    .string()
    .regex(/^\d+$/, problem)
    .transform((text) => Number(text))
    .pipe(z.number().min(min, problem).max(max, problem));
}

function oneOf(values: readonly string[]): string {
  return `must be one of ${values.join(', ')}`;
}

// Blank items are dropped: a trailing comma is a slip, not an item.
const list = z.string().transform((text) =>
  text
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== ''),
);

export const settingSchemas = {
  // Matching ignores case and the value is kept in lower case, so later comparisons are exact.
  loopbackHost: z
    .string()
    .toLowerCase()
    .pipe(z.enum(LOOPBACK_HOSTS, `must be a loopback address (${LOOPBACK_HOSTS.join(', ')})`)),
  port: wholeNumber(1, MAX_PORT),
  timeoutMs: wholeNumber(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
  logLevel: z
    .string()
    .toLowerCase()
    .pipe(z.enum(LOG_LEVELS, oneOf(LOG_LEVELS))),
  transport: z
    .string()
    .toLowerCase()
    .pipe(z.enum(TRANSPORTS, oneOf(TRANSPORTS))),
  profile: z
    .string()
    .toLowerCase()
    .pipe(z.enum(PROFILES, oneOf(PROFILES))),
  platform: z
    .string()
    .toLowerCase()
    .pipe(z.enum(CLIENT_PLATFORMS, oneOf(CLIENT_PLATFORMS))),
  boolean: z
    .string()
    .toLowerCase()
    .pipe(z.enum(['true', '1', 'false', '0'], 'must be true, false, 1 or 0'))
    .transform((text) => text === 'true' || text === '1'),
  text: z.string(),
  // Design spec 9 documents `all` as the default filter, so on its own it must mean "no filter"
  // rather than a glob that matches no tool. Next to other globs it is an ordinary pattern.
  toolPatterns: list.transform((patterns) =>
    patterns.length === 1 && patterns[0]?.toLowerCase() === 'all' ? [] : patterns,
  ),
  // Each item is normalised by the loader, so that an error names the item at fault.
  list,
};
