import { z } from 'zod';
import { classifyTarget } from '../../core/cdp/targets.js';
import type { CdpTargetInfo } from '../../core/cdp/types.js';
import { isOtherBrowserError } from '../../core/connection.js';
import { isTvMcpError, TvMcpError } from '../../core/errors.js';
import { readCapabilities, type Capabilities } from '../../core/tv/capabilities.js';
import { getPlanLimits, PLAN_FEATURES, type PlanFeature } from '../../core/tv/plan-limits.js';
import { defineTool, type AnyToolDefinition } from '../types.js';
import { readUiState, reloadTab, UI_STATE_SELECTORS } from './page.js';

// The tools that bring TradingView up and say how it is doing (design spec 7, domain App).

const MAX_PORT = 65535;

// Several chart tabs and none in front: the connection manager cannot tell which one to read, and
// the health report says so by listing more than one tab and no url. The app is up; someone only
// has to bring one tab forward.
const UNFOCUSED_TABS =
  'Several TradingView chart tabs are open and none of them is in front, so the app cannot tell ' +
  'which one to use. Focus one TradingView tab (click it), then call app_health again.';

// What frees the debug port when another browser holds it, such as a Chrome started with a debug
// port of its own.
const FREE_THE_PORT =
  'quit that browser, or set TV_CDP_PORT (--cdp-port) to a free port and start this server ' +
  'again, then call app_launch.';

// What a failure of the debug port means to a tool that only reports. The two codes say that the
// port cannot be used right now; any other failure is not an answer about the port.
function isPortFailure(error: unknown): error is TvMcpError {
  return isTvMcpError(error) && (error.code === 'CDP_UNREACHABLE' || error.code === 'TIMEOUT');
}

// Targets as the tools show them: what a person needs to tell a chart from a helper page. The
// address the debugger connects to is left out on purpose.
function describeTargets(targets: readonly CdpTargetInfo[]) {
  return targets.map((target) => ({
    id: target.id,
    kind: classifyTarget(target),
    title: target.title,
    url: target.url,
  }));
}

// Why no targets could be listed, with the step that fixes it.
function whyNoTargets(
  found: { executable: string | null; running: boolean },
  failure: TvMcpError,
): string {
  if (isOtherBrowserError(failure)) {
    return (
      'Another browser holds the debug port, not TradingView, so targets is empty and none of ' +
      `its pages is listed: ${FREE_THE_PORT}`
    );
  }
  if (failure.code === 'TIMEOUT') {
    return (
      'The debug port did not list its targets in time, so targets is empty. Try again, and ' +
      'check that TradingView is not frozen.'
    );
  }
  if (found.running) {
    return (
      'TradingView is running, but its debug port does not answer, so targets is empty. Quit ' +
      'TradingView and call app_launch, or call app_launch with restart: true and confirm: true ' +
      'to have it quit and reopen.'
    );
  }
  if (found.executable === null) {
    return (
      'TradingView Desktop was not found on this machine and its debug port does not answer, so ' +
      'targets is empty. Install it, or set TV_APP_PATH to its executable, then call app_launch.'
    );
  }
  return (
    'TradingView is not running, so its debug port does not answer and targets is empty. Call ' +
    'app_launch to start it.'
  );
}

export const appLaunch = defineTool({
  name: 'app_launch',
  domain: 'app',
  title: 'Launch TradingView',
  description:
    'Starts TradingView Desktop with its debug port open, which is how every other tool reaches ' +
    'it, and waits until a chart tab is up. Use it when app_health shows that the debug port does ' +
    'not answer. It does nothing when TradingView already answers on the port (status ' +
    'already-running), and fails with CDP_UNREACHABLE while another browser holds the port. ' +
    'TradingView allows only one instance, so when it runs without the debug port the call fails ' +
    'with RESTART_REQUIRED; to quit and reopen it, call again with restart: true and confirm: ' +
    'true. A restart closes TradingView, so unsaved edits, such as Pine Editor text, can be ' +
    'lost. A restart can take more than a minute (up to 20 s for the app to quit, then up to the ' +
    'launch timeout, 60 s by default, for it to come back), which may exceed the request ' +
    'timeout of some clients; a plain launch is quicker. Returns status (already-running, ' +
    'launched or restarted), executable (the file that was started, or null), endpoint (the ' +
    'debug port) and waitedMs.',
  inputSchema: {
    restart: z
      .boolean()
      .default(false)
      .describe(
        'Set to true when TradingView runs without the debug port and has to be quit and ' +
          'reopened. It also needs confirm: true. Default false.',
      ),
    port: z
      .number()
      .int()
      .min(1)
      .max(MAX_PORT)
      .optional()
      .describe(
        'Debug port to start TradingView on. Must equal the configured CDP port (TV_CDP_PORT); ' +
          'omit it normally.',
      ),
    confirm: z
      .boolean()
      .optional()
      .describe(
        'Must be true together with restart: true, to confirm that TradingView may be closed and ' +
          'reopened, which loses unsaved edits such as Pine Editor text. Ignored without restart.',
      ),
  },
  // A restart can lose unsaved work. A client decides from the hints whether to ask the user
  // first, while confirm is filled in by the model, so the hints describe the worst mode.
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  core: true,
  async handler({ restart, port, confirm }, ctx) {
    // Before anything else, so that the answer needs no look at the machine and cannot close the
    // app: a restart is the one launch that can cost the user work (design spec 5.3).
    if (restart && confirm !== true) {
      throw new TvMcpError('CONFIRMATION_REQUIRED', 'Restarting TradingView needs confirmation', {
        hint:
          'A restart closes TradingView and opens it again, so unsaved edits, such as Pine Editor ' +
          'text, can be lost. Save your work, then call app_launch again with restart: true and ' +
          'confirm: true.',
      });
    }
    // With exactOptionalPropertyTypes an absent option must stay absent.
    const launched = await ctx.launcher.launch({
      restart,
      ...(port === undefined ? {} : { port }),
    });
    ctx.logger.info(
      { status: launched.status, waitedMs: launched.waitedMs },
      'App launch finished',
    );
    return {
      data: {
        status: launched.status,
        executable: launched.executable,
        endpoint: launched.endpoint,
        waitedMs: launched.waitedMs,
      },
      via: 'local',
    };
  },
});

export const appHealth = defineTool({
  name: 'app_health',
  domain: 'app',
  title: 'TradingView health',
  description:
    'Reports how far TradingView is up, and changes nothing. cdp says whether the debug port ' +
    'answers (reachable), at which endpoint and in which browser; if cdp.reachable is false, ' +
    'TradingView is not running with the debug port: call app_launch. chart says how many chart ' +
    'tabs are open and the url of the one in use. app says whether the app in that tab is ready ' +
    '(it has its API and is connected to the data servers), whether it is connected, and when it ' +
    'was built. capabilities lists which parts of the page the other tools can use (the public ' +
    'API, the active chart, the chart model, the replay and Pine editor APIs, the module ' +
    'registry, the desktop bridge); every flag is false on a page whose app has not started, and ' +
    'capabilities is null when no chart tab could be read. It is a report, so it succeeds when ' +
    'TradingView is down. With several chart tabs open and none in front, chart.tabs is above 1 ' +
    'and a warning asks you to focus one TradingView tab. When another browser holds the debug ' +
    'port, cdp.reachable is false, cdp.otherBrowser is true and a warning says how to free it.',
  inputSchema: {},
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  core: true,
  async handler(_input, ctx) {
    const report = await ctx.connection.health();
    const warnings: string[] = [];
    if (report.cdp.otherBrowser === true) {
      warnings.push(
        'Another browser holds the debug port, not TradingView, so none of its pages is read: ' +
          FREE_THE_PORT,
      );
    }
    // Not a sign that the app is starting, so it is told apart from a tab that is not ready.
    const unfocused = report.chart.tabs > 1 && report.chart.url === undefined;
    if (unfocused) {
      warnings.push(UNFOCUSED_TABS);
    }

    let capabilities: Capabilities | null = null;
    // A report that already failed to choose a tab would only fail the same way, and each try
    // opens a session to every tab to ask which one is in front.
    if (report.chart.found && !unfocused) {
      try {
        capabilities = await readCapabilities(await ctx.connection.chartPage());
      } catch (error) {
        if (!isTvMcpError(error)) {
          throw error;
        }
        // The code only: the message of a failure can carry what the page said.
        warnings.push(`The capabilities of the page could not be read (${error.code}).`);
      }
    }
    return {
      data: { cdp: report.cdp, chart: report.chart, app: report.app, capabilities },
      via: 'cdp',
      warnings,
    };
  },
});

export const appDiscover = defineTool({
  name: 'app_discover',
  domain: 'app',
  title: 'Discover TradingView',
  description:
    'Finds TradingView on this machine without changing anything. Returns executable (the file ' +
    'app_launch would start, or null when TradingView is not installed or TV_APP_PATH is wrong), ' +
    'running (whether a TradingView process exists), cdpReachable (whether its debug port ' +
    'answers) and targets: every page the debug port lists, each with id, kind, title and url. ' +
    'kind is chart (a tab that shows a chart, the kind the other tools drive), window-chrome ' +
    '(the window with the tab strip), helper (a page the app keeps for itself), blank (a page ' +
    'without content) or other (a frame, a worker, or a page that is not a chart, such as the ' +
    'TradingView home page). Use it to find out why no chart tab is found, for example when the ' +
    'only tab is not on a chart. targets is empty, with a warning that says what to do, when the ' +
    'debug port does not answer.',
  inputSchema: {},
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  core: true,
  async handler(_input, ctx) {
    const found = await ctx.launcher.discover();
    const warnings: string[] = [];
    let targets: ReturnType<typeof describeTargets> = [];
    try {
      targets = describeTargets(await ctx.connection.targets());
    } catch (error) {
      // A report about the machine: a debug port that cannot be used is a finding, not a failure.
      if (!isPortFailure(error)) {
        throw error;
      }
      warnings.push(whyNoTargets(found, error));
    }
    return {
      data: {
        executable: found.executable,
        running: found.running,
        cdpReachable: found.cdpReachable,
        targets,
      },
      via: 'cdp',
      warnings,
    };
  },
});

export const appGetUiState = defineTool({
  name: 'app_get_ui_state',
  domain: 'app',
  title: 'Read the interface state',
  description:
    'Reads which parts of the TradingView interface are open in the chart tab, and changes ' +
    'nothing. Returns rightPanel (open, and activeWidget: watchlist, alerts, object_tree, ' +
    'pine_logs, detail or null), panels (watchlist, alerts, object_tree, data_window and ' +
    'pine_editor, each true while its button in the right toolbar shows its panel; the data ' +
    'window is a tab of the panel of the object tree, so object_tree and data_window are never ' +
    'both true), bottomPanelOpen, dialogs (the dialogs, menus and popups that are open, each by ' +
    'its data-name, aria-label or role and never by its text, or unnamed when it has none), ' +
    'fullscreen, replayToolbarVisible and pineEditorOpen. Use it before clicking in the ' +
    'interface, to see whether a dialog covers the chart. It reads the page, so a part is ' +
    "reported as closed when the page does not show it. fullscreen is TradingView's own " +
    'fullscreen mode, as the app reports it, which fills the tab with the chart and leaves the ' +
    'window as it is; it is also true while an element of the page is in the full screen of the ' +
    'browser. Fails with NOT_AVAILABLE on a page without a DOM.',
  inputSchema: {},
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  core: true,
  async handler(_input, ctx) {
    const page = await ctx.connection.chartPage();
    const state = await page.bridge.evaluate(readUiState, [UI_STATE_SELECTORS]);
    return { data: state, via: 'dom' };
  },
});

export const appGetPlanLimits = defineTool({
  name: 'app_get_plan_limits',
  domain: 'app',
  title: 'Read the plan limits',
  description:
    'Reads what the TradingView plan of the signed-in account allows, and changes nothing. ' +
    'Returns limits: for each of INDICATORS_ON_CHART (indicators on one chart), ' +
    'SAVED_PINE_SCRIPTS, CHART_STORAGE, MULTIPLE_CHARTS (charts in one layout), ' +
    'SERVER_SIDE_ALERTS, WATCHLIST_SYMBOLS, STUDY_TEMPLATES and HISTORICAL_BARS, the number ' +
    'the app reports, or null when the app does not report one. The limits are those of the ' +
    "user's own plan, as the app reports them; 99999 means unlimited. Use it before adding " +
    'indicators or saving scripts, to see how much room is left: the tools that act check the ' +
    'same limits and fail with PLAN_LIMIT instead of opening an upgrade dialog. It reads the ' +
    'modules the app has loaded, so every limit is null on a page whose app has not started.',
  inputSchema: {},
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(_input, ctx) {
    const page = await ctx.connection.chartPage();
    const read = await getPlanLimits(page, PLAN_FEATURES);
    // Every feature is listed, in a fixed order, null where the app said nothing.
    const limits = Object.fromEntries(
      PLAN_FEATURES.map((feature: PlanFeature) => [feature, read[feature] ?? null]),
    );
    return { data: { limits }, via: 'internal' };
  },
});

export const appReconnect = defineTool({
  name: 'app_reconnect',
  domain: 'app',
  title: 'Reconnect to TradingView',
  description:
    'Drops every connection this server holds to TradingView, so that the next tool call ' +
    'connects again and picks the chart tab anew. Use it when calls keep failing after ' +
    'TradingView was restarted, a tab was replaced or the page was reloaded. With reloadTab: ' +
    'true it first asks TradingView Desktop to reload the chart tab, which also recovers a page ' +
    'that is stuck. That needs confirm: true as well, because reloading loses unsaved edits in ' +
    'the tab, such as Pine Editor text; without it nothing is reloaded and nothing is dropped. ' +
    'The page needs a few seconds to come back, so check app_health afterwards. It does not ' +
    'start TradingView: use app_launch for that. Returns reset (true) and reloadRequested.',
  inputSchema: {
    reloadTab: z
      .boolean()
      .default(false)
      .describe(
        'Also reload the chart tab before the connections are dropped (default false). Use it ' +
          'only when the page is stuck: the tab loses unsaved edits, such as Pine Editor text. ' +
          'It also needs confirm: true.',
      ),
    confirm: z
      .boolean()
      .optional()
      .describe(
        'Must be true together with reloadTab: true, to confirm that the chart tab may be ' +
          'reloaded, which loses unsaved edits such as Pine Editor text. Ignored without reloadTab.',
      ),
  },
  // As for app_launch, the hints describe the worst mode: a reload can lose unsaved work, and
  // every call with reloadTab reloads the tab again.
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  core: true,
  async handler({ reloadTab: reload, confirm }, ctx) {
    // Before anything else, so that a refusal touches neither the page nor the sessions: a reload
    // is the one reconnect that can cost the user work (design spec 5.3).
    if (reload && confirm !== true) {
      throw new TvMcpError('CONFIRMATION_REQUIRED', 'Reloading the chart tab needs confirmation', {
        hint:
          'Reloading the chart page can discard unsaved Pine Editor changes. Save your work, then ' +
          'call app_reconnect again with reloadTab: true and confirm: true.',
      });
    }
    if (reload) {
      try {
        const page = await ctx.connection.chartPage();
        await page.bridge.evaluate(reloadTab, []);
      } finally {
        // Whether or not the reload went through: the sessions are what the caller wants dropped,
        // and a reloading page leaves them pointing at a page that is gone.
        await ctx.connection.reset();
      }
    } else {
      await ctx.connection.reset();
    }
    return {
      data: { reset: true, reloadRequested: reload },
      via: reload ? 'internal' : 'local',
      warnings: reload
        ? [
            'The chart tab is reloading and needs a few seconds to come back. Call app_health to ' +
              'see when the app is ready again.',
          ]
        : [],
    };
  },
});

export const appTools: AnyToolDefinition[] = [
  appLaunch,
  appHealth,
  appDiscover,
  appGetUiState,
  appGetPlanLimits,
  appReconnect,
];
