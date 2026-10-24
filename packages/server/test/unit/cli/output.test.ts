import { stripVTControlCharacters } from 'node:util';
import {
  colorEnabled,
  isHealthy,
  renderError,
  renderHealth,
  renderHelp,
  renderLaunchResult,
} from '../../../src/cli/output.js';
import type { HealthReport } from '../../../src/core/connection.js';
import { TvMcpError } from '../../../src/core/errors.js';
import type { LaunchResult } from '../../../src/core/launcher/launch.js';

const ENDPOINT = 'http://127.0.0.1:9222';
const CHART_URL = 'https://www.tradingview.com/chart/FIXTURE1/';

const READY: HealthReport = {
  cdp: {
    reachable: true,
    endpoint: ENDPOINT,
    browser: 'Chrome/146.0.7680.216',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) TradingView/3.4.1 Chrome/146.0.7680.216 Electron/41.7.1 Safari/537.36 TVDesktop/3.4.1',
  },
  chart: { found: true, tabs: 1, url: CHART_URL },
  app: { ready: true, connected: true, buildTime: '2026-10-16T17:55:37' },
};

const UNREACHABLE: HealthReport = {
  cdp: { reachable: false, endpoint: ENDPOINT },
  chart: { found: false, tabs: 0 },
  app: { ready: false },
};

const REACHABLE = { reachable: true, endpoint: ENDPOINT, browser: 'Chrome/146.0.7680.216' };

// Chrome started with a debug port of its own holds the port TradingView should have.
const OTHER_BROWSER: HealthReport = {
  cdp: {
    reachable: false,
    endpoint: ENDPOINT,
    browser: 'Chrome/146.0.7680.216',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.216 Safari/537.36',
    otherBrowser: true,
  },
  chart: { found: false, tabs: 0 },
  app: { ready: false },
};

test('renderHealth checks off every step of a ready app', () => {
  const text = renderHealth(READY, { color: false });

  expect(text).toContain(`✔ Debug port answers at ${ENDPOINT}`);
  expect(text).toContain('TradingView 3.4.1');
  expect(text).toContain(`✔ Chart tab open: ${CHART_URL}\n`);
  expect(text).toContain('✔ App connected and ready (build 2026-10-16T17:55:37)');
  expect(text).not.toContain('✖');
  expect(text).toContain('TradingView is ready.');
});

test('renderHealth says how to start TradingView when the debug port does not answer', () => {
  const text = renderHealth(UNREACHABLE, { color: false });

  expect(text).toContain(`✖ Debug port does not answer at ${ENDPOINT}`);
  expect(text).toContain('tradingview-desktop-mcp launch');
  // What depends on the debug port was not looked at, and the report says so.
  expect(text).toContain('- Chart tab: not checked');
  expect(text).toContain('- App: not checked');
  expect(text).toContain('TradingView is not ready.');
});

test('renderHealth says that another browser holds the debug port, and how to free it', () => {
  const text = renderHealth(OTHER_BROWSER, { color: false });

  expect(text).toContain(
    `✖ Another browser answers on the debug port at ${ENDPOINT} (Chrome/146.0.7680.216), not TradingView`,
  );
  expect(text).toMatch(/quit it.*TV_CDP_PORT/is);
  expect(text).not.toContain('does not answer');
  expect(text).toContain('- Chart tab: not checked');
  expect(text).toContain('TradingView is not ready.');
  expect(isHealthy(OTHER_BROWSER)).toBe(false);
});

test('renderHealth names no browser when the debug port did not say which it is', () => {
  const text = renderHealth(
    { ...OTHER_BROWSER, cdp: { reachable: false, endpoint: ENDPOINT, otherBrowser: true } },
    { color: false },
  );

  expect(text).toContain(
    `✖ Another browser answers on the debug port at ${ENDPOINT}, not TradingView`,
  );
});

test.each<[string, HealthReport, string[]]>([
  [
    'no chart tab is open',
    { cdp: REACHABLE, chart: { found: false, tabs: 0 }, app: { ready: false } },
    ['✖ No chart tab is open', 'Open a chart', '- App: not checked'],
  ],
  [
    'several chart tabs are open and none is in front',
    { cdp: REACHABLE, chart: { found: true, tabs: 2 }, app: { ready: false } },
    ['✖ 2 chart tabs are open, and none of them is in front', 'front', '- App: not checked'],
  ],
  [
    'the app is not connected',
    {
      cdp: REACHABLE,
      chart: { found: true, tabs: 1, url: CHART_URL },
      app: { ready: false, connected: false, buildTime: null },
    },
    ['✔ Chart tab open', '✖ The app reports that it is not connected', 'logged in'],
  ],
  [
    'the app API is not there yet',
    {
      cdp: REACHABLE,
      chart: { found: true, tabs: 1, url: CHART_URL },
      app: { ready: false, buildTime: null },
    },
    ['✔ Chart tab open', "✖ The app's API is not available yet", 'loaded'],
  ],
])('renderHealth explains what to do when %s', (_case, report, fragments) => {
  const text = renderHealth(report, { color: false });

  for (const fragment of fragments) {
    expect(text).toContain(fragment);
  }
  expect(text).toContain('TradingView is not ready.');
});

test('renderHealth says how many chart tabs are open when one of several was chosen', () => {
  const text = renderHealth(
    { ...READY, chart: { found: true, tabs: 3, url: CHART_URL } },
    { color: false },
  );

  expect(text).toContain(`✔ Chart tab open: ${CHART_URL} (3 tabs open)`);
});

test('renderHealth leaves out a build time the page does not state', () => {
  const report: HealthReport = { ...READY, app: { ready: true, connected: true, buildTime: null } };

  const text = renderHealth(report, { color: false });

  expect(text).toContain('✔ App connected and ready\n');
});

test('isHealthy wants a reachable debug port and a ready app', () => {
  expect(isHealthy(READY)).toBe(true);
  expect(isHealthy(UNREACHABLE)).toBe(false);
  expect(isHealthy({ ...READY, app: { ready: false, connected: false } })).toBe(false);
});

test('renderHealth colors only when asked, and says the same either way', () => {
  const colored = renderHealth(UNREACHABLE, { color: true });

  expect(colored).toContain('\u001b[');
  expect(stripVTControlCharacters(colored)).toBe(renderHealth(UNREACHABLE, { color: false }));
});

const LAUNCHED: LaunchResult = {
  status: 'launched',
  executable: '/Applications/TradingView.app/Contents/MacOS/TradingView',
  endpoint: ENDPOINT,
  waitedMs: 4200,
};

test.each<[LaunchResult, string[]]>([
  [
    { status: 'already-running', executable: null, endpoint: ENDPOINT, waitedMs: 0 },
    [`✔ TradingView is already running with the debug port at ${ENDPOINT}`],
  ],
  [
    LAUNCHED,
    [
      `✔ Started TradingView with the debug port at ${ENDPOINT}, ready after 4.2 s`,
      '/Applications/TradingView.app/Contents/MacOS/TradingView',
    ],
  ],
  [
    { ...LAUNCHED, status: 'restarted', waitedMs: 12_345 },
    [`✔ Restarted TradingView with the debug port at ${ENDPOINT}, ready after 12.3 s`],
  ],
])('renderLaunchResult describes a $status app', (result, fragments) => {
  const text = renderLaunchResult(result, { color: false });

  for (const fragment of fragments) {
    expect(text).toContain(fragment);
  }
});

test('renderError shows the code, the message and the hint of our errors', () => {
  const message = 'TradingView is running without the debug port';
  const error = new TvMcpError('RESTART_REQUIRED', message, {
    hint: 'Quit TradingView and launch again.',
  });

  expect(renderError(error, { color: false })).toBe(
    '✖ RESTART_REQUIRED: TradingView is running without the debug port\n' +
      '  Quit TradingView and launch again.\n',
  );
});

test('renderError leaves out a hint that is not there', () => {
  const error = new TvMcpError('INVALID_INPUT', 'Pass either --dashboard or --no-dashboard');

  expect(renderError(error, { color: false })).toBe(
    '✖ INVALID_INPUT: Pass either --dashboard or --no-dashboard\n',
  );
});

test('renderError reports any other failure as INTERNAL with its message', () => {
  expect(renderError(new Error('spawn exploded'), { color: false })).toBe(
    '✖ INTERNAL: spawn exploded\n',
  );
  expect(renderError(new Error(''), { color: false })).toBe('✖ INTERNAL: Unexpected error\n');
  expect(renderError('a thrown string', { color: false })).toBe('✖ INTERNAL: a thrown string\n');
});

test('renderError colors only when asked', () => {
  const colored = renderError(new TvMcpError('TIMEOUT', 'Too slow', { hint: 'Wait.' }), {
    color: true,
  });

  expect(colored).toContain('\u001b[');
  expect(stripVTControlCharacters(colored)).toBe('✖ TIMEOUT: Too slow\n  Wait.\n');
});

test.each<[string, NodeJS.ProcessEnv, boolean, boolean]>([
  ['a terminal', {}, true, true],
  ['a pipe', {}, false, false],
  ['a terminal with NO_COLOR', { NO_COLOR: '1' }, true, false],
  ['a terminal with an empty NO_COLOR, which counts as unset', { NO_COLOR: '' }, true, true],
  ['a dumb terminal', { TERM: 'dumb' }, true, false],
  ['a pipe with FORCE_COLOR', { FORCE_COLOR: '1' }, false, true],
  ['a terminal with FORCE_COLOR=0', { FORCE_COLOR: '0' }, true, false],
  ['a pipe with both, where NO_COLOR wins', { NO_COLOR: '1', FORCE_COLOR: '1' }, false, false],
])('colorEnabled for %s', (_case, env, tty, expected) => {
  expect(colorEnabled(env, { isTTY: tty })).toBe(expected);
});

test('colorEnabled treats a stream that says nothing about a terminal as a pipe', () => {
  expect(colorEnabled({}, {})).toBe(false);
});

test('renderHelp lists the commands and every variable of the configuration', () => {
  const help = renderHelp();

  for (const command of ['serve', 'launch', 'doctor', 'config <client>']) {
    expect(help).toContain(command);
  }
  // Design spec 9, copied by hand.
  for (const variable of [
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
    // Added for tunnels.
    'TV_MCP_ALLOWED_HOSTS',
  ]) {
    expect(help).toContain(variable);
  }
  expect(help).toContain('--allowed-hosts <hosts>');
  expect(help).toContain('9222');
  expect(help).toContain('8787');
});
