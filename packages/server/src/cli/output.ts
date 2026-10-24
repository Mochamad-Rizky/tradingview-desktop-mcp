import pc from 'picocolors';
import { DEFAULTS } from '../config/schema.js';
import type { HealthReport } from '../core/connection.js';
import { isTvMcpError } from '../core/errors.js';
import type { LaunchResult } from '../core/launcher/launch.js';
import { PACKAGE_NAME, VERSION } from '../version.js';

// What the CLI prints for people. Every function returns text and leaves the stream to the caller,
// who decides about color from the stream it writes to.

interface ColorOption {
  color: boolean;
}

function present(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

// NO_COLOR (no-color.org) turns color off whatever else is set. FORCE_COLOR turns it on for a pipe,
// unless it is 0 or false. Otherwise only a terminal gets color. An empty variable counts as unset.
export function colorEnabled(env: NodeJS.ProcessEnv, stream: object): boolean {
  if (present(env.NO_COLOR)) {
    return false;
  }
  if (present(env.FORCE_COLOR)) {
    return env.FORCE_COLOR !== '0' && env.FORCE_COLOR.toLowerCase() !== 'false';
  }
  return 'isTTY' in stream && stream.isTTY === true && env.TERM !== 'dumb';
}

function table(rows: readonly (readonly [string, string])[], prefix = ''): string {
  const width = Math.max(...rows.map(([left]) => left.length)) + 2;
  return rows.map(([left, right]) => `  ${prefix}${left.padEnd(width)}${right}`).join('\n');
}

const COMMANDS = [
  ['[serve] [options]', 'Start the MCP server (the default command)'],
  ['launch [options]', 'Start TradingView Desktop with the debug port'],
  ['doctor [options]', 'Check that TradingView can be reached and is ready'],
  ['config <client>', 'Print a client config snippet (not implemented yet)'],
] as const;

const OPTIONS = [
  ['--transport <stdio|http>', `MCP transport (TV_MCP_TRANSPORT, default ${DEFAULTS.transport})`],
  ['--host <address>', `HTTP listen address (TV_MCP_HTTP_HOST, default ${DEFAULTS.httpHost})`],
  ['--port <number>', `HTTP listen port (TV_MCP_HTTP_PORT, default ${String(DEFAULTS.httpPort)})`],
  [
    '--allowed-hosts <hosts>',
    "Extra host names, such as a tunnel's (TV_MCP_ALLOWED_HOSTS, default none)",
  ],
  [
    '--cdp-host <address>',
    `Debug port host, loopback only (TV_CDP_HOST, default ${DEFAULTS.cdpHost})`,
  ],
  [
    '--cdp-port <number>',
    `TradingView's debug port (TV_CDP_PORT, default ${String(DEFAULTS.cdpPort)})`,
  ],
  ['--app-path <path>', 'TradingView executable (TV_APP_PATH, default: found automatically)'],
  [
    '--profile <name>',
    `Tools: core, full or readonly (TV_MCP_PROFILE, default ${DEFAULTS.profile})`,
  ],
  ['--tools <globs>', 'Comma-separated tool name globs, or all (TV_MCP_TOOLS, default all)'],
  ['--allow-eval', 'Allow JavaScript in TradingView (TV_MCP_ALLOW_EVAL, default off)'],
  ['--dashboard, --no-dashboard', 'Web dashboard (TV_MCP_DASHBOARD, default on for http only)'],
  [
    '--log-level <level>',
    `trace to fatal, or silent (TV_MCP_LOG_LEVEL, default ${DEFAULTS.logLevel})`,
  ],
  ['-h, --help', 'Show this help'],
  ['-v, --version', 'Show the version'],
] as const;

const ENVIRONMENT_ONLY = [
  ['TV_MCP_AUTH_TOKEN', 'Secret for http: "Authorization: Bearer <token>", or /mcp/<token>'],
  [
    'TV_LAUNCH_TIMEOUT_MS',
    `How long launch waits for the app, in ms (default ${String(DEFAULTS.launchTimeoutMs)})`,
  ],
  [
    'TV_CALL_TIMEOUT_MS',
    `How long one call into the app may take, in ms (default ${String(DEFAULTS.callTimeoutMs)})`,
  ],
] as const;

export function renderHelp(): string {
  return [
    `${PACKAGE_NAME} ${VERSION}`,
    'Lets AI assistants read and control TradingView Desktop over the Chrome DevTools Protocol.',
    '',
    'Usage:',
    table(COMMANDS, `${PACKAGE_NAME} `),
    '',
    'Options (each one beats its environment variable):',
    table(OPTIONS),
    '',
    'Environment only:',
    table(ENVIRONMENT_ONLY),
    '',
    'Logs go to stderr. In stdio mode, stdout carries only MCP messages.',
    '',
  ].join('\n');
}

interface Check {
  state: 'ok' | 'fail' | 'skipped';
  text: string;
  hint?: string;
}

function tradingViewVersion(userAgent: string | undefined): string | undefined {
  const version = /\bTradingView\/(\S+)/.exec(userAgent ?? '')?.[1];
  return version === undefined ? undefined : `TradingView ${version}`;
}

function cdpCheck({ cdp }: HealthReport): Check {
  if (cdp.otherBrowser === true) {
    const browser = present(cdp.browser) ? ` (${cdp.browser})` : '';
    return {
      state: 'fail',
      text: `Another browser answers on the debug port at ${cdp.endpoint}${browser}, not TradingView`,
      hint:
        'Another browser holds the debug port: quit it, or set TV_CDP_PORT (--cdp-port) to a ' +
        'free port for TradingView.',
    };
  }
  if (!cdp.reachable) {
    return {
      state: 'fail',
      text: `Debug port does not answer at ${cdp.endpoint}`,
      hint: `Start TradingView with the debug port: ${PACKAGE_NAME} launch`,
    };
  }
  const about = [tradingViewVersion(cdp.userAgent), cdp.browser].filter(present);
  const details = about.length === 0 ? '' : ` (${about.join(', ')})`;
  return { state: 'ok', text: `Debug port answers at ${cdp.endpoint}${details}` };
}

function chartCheck({ cdp, chart }: HealthReport): Check {
  if (!cdp.reachable) {
    return { state: 'skipped', text: 'Chart tab: not checked' };
  }
  if (!chart.found) {
    return {
      state: 'fail',
      text: 'No chart tab is open',
      hint: 'Open a chart in TradingView Desktop, then run doctor again.',
    };
  }
  // The tab in use is the one in front, and with several tabs and none in front there is no url.
  if (chart.url === undefined) {
    return {
      state: 'fail',
      text: `${String(chart.tabs)} chart tabs are open, and none of them is in front`,
      hint: 'Bring the chart tab you want to use to the front, then run doctor again.',
    };
  }
  const count = chart.tabs > 1 ? ` (${String(chart.tabs)} tabs open)` : '';
  return { state: 'ok', text: `Chart tab open: ${chart.url}${count}` };
}

function appCheck({ chart, app }: HealthReport): Check {
  if (chart.url === undefined) {
    return { state: 'skipped', text: 'App: not checked' };
  }
  if (app.ready) {
    const { buildTime } = app;
    const build = typeof buildTime === 'string' && buildTime !== '' ? ` (build ${buildTime})` : '';
    return { state: 'ok', text: `App connected and ready${build}` };
  }
  if (app.connected === false) {
    return {
      state: 'fail',
      text: 'The app reports that it is not connected',
      hint: 'Check the network connection and that you are logged in to TradingView.',
    };
  }
  return {
    state: 'fail',
    text: "The app's API is not available yet",
    hint: 'Wait until the chart has loaded, then run doctor again.',
  };
}

// Ready means a tool call can work now: the debug port answers and the app in the tab is up.
export function isHealthy(report: HealthReport): boolean {
  return report.cdp.reachable && report.app.ready;
}

export function renderHealth(report: HealthReport, { color }: ColorOption): string {
  const c = pc.createColors(color);
  const marks = { ok: c.green('✔'), fail: c.red('✖'), skipped: c.dim('-') };
  const lines = [c.bold('TradingView Desktop')];
  for (const check of [cdpCheck(report), chartCheck(report), appCheck(report)]) {
    const text = check.state === 'skipped' ? c.dim(check.text) : check.text;
    lines.push(`  ${marks[check.state]} ${text}`);
    if (check.hint !== undefined) {
      lines.push(`    ${c.yellow(check.hint)}`);
    }
  }
  lines.push(
    isHealthy(report) ? c.green('TradingView is ready.') : c.red('TradingView is not ready.'),
  );
  return `${lines.join('\n')}\n`;
}

const STARTED = { launched: 'Started', restarted: 'Restarted' } as const;

export function renderLaunchResult(result: LaunchResult, { color }: ColorOption): string {
  const c = pc.createColors(color);
  const ok = c.green('✔');
  if (result.status === 'already-running') {
    return `${ok} TradingView is already running with the debug port at ${result.endpoint}\n`;
  }
  const seconds = (result.waitedMs / 1000).toFixed(1);
  const lines = [
    `${ok} ${STARTED[result.status]} TradingView with the debug port at ${result.endpoint}, ready after ${seconds} s`,
  ];
  if (result.executable !== null) {
    lines.push(`  ${c.dim(result.executable)}`);
  }
  return `${lines.join('\n')}\n`;
}

// Our errors carry a code a user can look up and a hint that says what to do. Anything else is a
// failure nobody planned for, shown with its own message, since the user is the one to fix it.
export function renderError(error: unknown, { color }: ColorOption): string {
  const c = pc.createColors(color);
  let code = 'INTERNAL';
  let message = error instanceof Error ? error.message : String(error);
  let hint: string | undefined;
  if (isTvMcpError(error)) {
    ({ code, message, hint } = error);
  } else if (message === '') {
    message = 'Unexpected error';
  }
  const lines = [`${c.red('✖')} ${c.bold(c.red(`${code}:`))} ${message}`];
  if (hint !== undefined) {
    lines.push(`  ${c.yellow(hint)}`);
  }
  return `${lines.join('\n')}\n`;
}
