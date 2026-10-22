import { z } from 'zod';
import type { PageHandle } from '../../core/connection.js';
import { isTvMcpError } from '../../core/errors.js';
import { getPlanLimits, inPlanLimitedTurn, requireBelowLimit } from '../../core/tv/plan-limits.js';
import { pollUntil } from '../../utils/poll.js';
import { READ_ONLY } from '../annotations.js';
import { pageWaitMs } from '../chart/strategies.js';
import { defineTool, type AnyToolDefinition, type ToolContext, type ToolOutput } from '../types.js';
import {
  CHART_STORAGE_HINT,
  dataNotReadyWarning,
  layoutIdFromUrl,
  layoutNameOf,
  MAX_LAYOUT_NAME,
  NO_ID_WARNING,
  notCreatedError,
  notOpenedError,
  notOpenedWarning,
  outOfTimeError,
  overLimitError,
  permissionRefusedError,
  permissionUnknownError,
  signedOutError,
  toLayoutListing,
  unfinishedLoadWarning,
  unknownLayoutError,
  unreadableLayoutsWarning,
  unsavedChangesError,
  unsavedNotOpenedWarning,
} from './mappers.js';
import {
  awaitChartData,
  checkLayoutPermission,
  createLayoutViaApi,
  loadLayoutInPlace,
  readLayoutState,
  readSavedLayouts,
  type LoadOutcome,
} from './page.js';

// The layout tools (design spec 7, domain Layouts and panes). Saved layouts are the user's data on
// the layouts server of TradingView, which the tools reach through the layout API of the app
// (reverse-engineering notes of Plan 3, section 1). layout_list sends the one request the layouts
// menu of the app sends. layout_switch and layout_new load a saved layout in place, as that menu
// does, with loadLayoutFromServerByLayoutId(id, false, true), which discards the unsaved changes of
// the layout on the chart without the dialog of the app: both need confirm: true while there are
// unsaved changes, or TradingView does not tell (design spec 5.3, rule 2). Neither uses
// loadChartFromServer, which asks in a dialog, a new tab, or createNewLayout, which rewrites the URL
// of the page without loading the layout.
//
// layout_new checks, in a turn of the plan-limited actions, the CHART_STORAGE limit of the plan
// against the saved layouts (a limit that cannot be read refuses) and then the check the Create new
// layout dialog of the app runs, before it saves the layout with the export createNewChart, as that
// dialog does (design spec 5.3, rule 3). A failure TradingView meets after that, a server error say,
// it shows in a dialog of its own: no check before can foresee it. A layout layout_new created is
// reported as created even when it could not be opened, so that the client does not create it
// twice, and the call keeps to a time below what common clients wait for one, so that none gives up
// on it after the creation and tries again. layout_switch takes its turn as well, and refuses a
// layout beyond the limit of the plan, which TradingView would answer with its paywall. Layout names
// go to the client and into no log.

// The longest name and layout id the schemas take. A name is checked against the limit of the
// dialog of TradingView once it is trimmed (layoutNameOf).
const MAX_NAME_INPUT = 200;
const MAX_LAYOUT_ID = 100;
// How often the page is asked whether the layout on the chart became the one being loaded.
const POLL_INTERVAL_MS = 100;
// The least time the chart of a layout that was loaded is given to report its data, when the call
// timeout leaves that much to a page call.
const MIN_DATA_WAIT_MS = 1500;
// The longest layout_new takes from its start: below the 60 s a common MCP client waits for a call,
// since a client that gives up after the layout was created would call again and create another.
const NEW_LAYOUT_BUDGET_MS = 45_000;
// Less time than this left to open a created layout counts as none: a load the call could not wait
// for might switch the layout after the call reported it unopened.
const MIN_OPEN_MS = 1000;

// Switching to a layout, or to a new one, loads it in place of the current layout, which discards its
// unsaved changes (with confirm: true); doing it again undoes nothing of that.
const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

// What layout_new returns: the id of the new layout (null when TradingView did not say it), its name
// and whether it was opened; and what layout_switch returns: the layout the chart shows and whether
// the call changed it. Type aliases, not interfaces: they go to the client as JSON.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
type NewLayout = { id: string | null; name: string; opened: boolean };
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
type ShownLayout = { id: string; name: string | null; changed: boolean };

// What a load of a saved layout came to: opened, with the name the chart gives the layout then and
// the warnings; unopened, with why when TradingView said; or refused before anything was loaded,
// because the layout on the chart had unsaved changes by then, or TradingView did not tell (unsaved
// null), and confirm was not given.
type OpenOutcome =
  | { status: 'opened'; name: string | null; warnings: string[] }
  | { status: 'unopened'; reason: string | null }
  | { status: 'unsaved'; unsaved: true | null };

// How a load of a layout is waited for: waitMs bounds each page call and the wait for the switch,
// limitMs the whole of it, data included (Infinity when only waitMs counts), and confirm says whether
// unsaved changes of the layout on the chart may be discarded.
interface OpenOptions {
  waitMs: number;
  limitMs: number;
  confirm: boolean;
}

// Loads the saved layout `id` in place and waits, within waitMs, until the layout on the chart is it
// (polled with plain page functions), and then until its chart has its data, which gets the rest of
// the wait and at least MIN_DATA_WAIT_MS, but never more than waitMs, since a page call that waits
// longer would outlast the call timeout of the bridge, nor more than limitMs allows. The data is
// waited for only once the loader
// reported that the content of the layout is in place: before that, the chart may still be the one
// of the layout before, so a layout switched to without that report comes with a warning instead. A
// load that ended, loaded or failed, is looked at once: the app switches the layout before its loader
// resolves, and resolves without loading anything for a layout it does not find, so waiting longer
// would not change the answer. The unsaved changes are looked at again right before the load, which
// discards them only with confirm.
async function openLayout(
  page: PageHandle,
  id: string,
  { waitMs, limitMs, confirm }: OpenOptions,
): Promise<OpenOutcome> {
  const startedAt = performance.now();
  const elapsed = (): number => performance.now() - startedAt;
  const left = (): number => Math.max(waitMs - elapsed(), 0);
  const limitLeft = (): number => Math.max(limitMs - elapsed(), 0);
  let load: LoadOutcome;
  try {
    load = await page.bridge.evaluate(loadLayoutInPlace, [id, waitMs, confirm]);
  } catch (error) {
    if (isTvMcpError(error) && error.code === 'CONFIRMATION_REQUIRED') {
      return { status: 'unsaved', unsaved: error.details?.unsavedChanges === true ? true : null };
    }
    throw error;
  }
  const switched = await pollUntil(
    () => page.bridge.evaluate(readLayoutState, []),
    (state) => state.id === id,
    { intervalMs: POLL_INTERVAL_MS, timeoutMs: load.ended === 'late' ? left() : 0 },
  );
  if (!switched.satisfied) {
    return { status: 'unopened', reason: load.reason };
  }
  const { name } = switched.last;
  if (load.ended !== 'loaded') {
    return { status: 'opened', name, warnings: [unfinishedLoadWarning(id)] };
  }
  const dataWaitMs = Math.round(Math.min(Math.max(left(), MIN_DATA_WAIT_MS), waitMs, limitLeft()));
  const { ready } = await page.bridge.evaluate(awaitChartData, [dataWaitMs]);
  return {
    status: 'opened',
    name,
    warnings: ready ? [] : [dataNotReadyWarning(id, dataWaitMs)],
  };
}

export const layoutList = defineTool({
  name: 'layout_list',
  domain: 'layout',
  title: 'List saved layouts',
  description:
    "Lists the saved layouts of the user's TradingView account, and changes nothing. Returns " +
    'current, the layout the chart tab shows ({ id, name }, both null for a layout that was ' +
    'never saved), and layouts, in the order TradingView gives them, each with id (the layoutId ' +
    'of layout_switch), name, modified (Unix seconds, with modifiedIso) and overLimit: true on a ' +
    'layout beyond the CHART_STORAGE limit of the plan, which TradingView keeps locked. It sends ' +
    'the one request the layouts menu of TradingView sends. Needs a signed-in account ' +
    '(AUTH_REQUIRED).',
  inputSchema: {},
  annotations: READ_ONLY,
  async handler(_input, ctx) {
    const page = await ctx.connection.chartPage();
    const state = await page.bridge.evaluate(readLayoutState, []);
    if (!state.signedIn) {
      throw signedOutError();
    }
    const saved = await page.bridge.evaluate(readSavedLayouts, [
      pageWaitMs(ctx.config.callTimeoutMs),
    ]);
    const { layouts, unreadable } = toLayoutListing(saved.layouts);
    return {
      data: { current: { id: state.id, name: state.name }, layouts },
      via: 'api',
      warnings: unreadable === 0 ? [] : [unreadableLayoutsWarning(unreadable)],
    };
  },
});

export const layoutNew = defineTool({
  name: 'layout_new',
  domain: 'layout',
  title: 'Create a layout',
  description:
    `Creates a saved layout named name (1 to ${String(MAX_LAYOUT_NAME)} characters, trimmed) in ` +
    "the user's TradingView account, as the Create new layout dialog of TradingView does, and " +
    'opens it in place of the current layout. The new layout starts from the default chart of ' +
    'TradingView: nothing of the current layout is copied. Returns id (for layout_switch), name ' +
    'and opened. The plan limit CHART_STORAGE is checked first: when the saved layouts fill the ' +
    'plan, or the check of TradingView itself says no, the call fails with PLAN_LIMIT and nothing ' +
    'is created; a limit that cannot be read fails with NOT_AVAILABLE. Opening the new layout ' +
    'discards the unsaved changes of the current one, so while it has any, or TradingView does ' +
    'not tell, the call fails with CONFIRMATION_REQUIRED unless confirm: true, and nothing is ' +
    'created. A layout that was created but not opened in time comes back with opened: false and ' +
    'a warning: open it with layout_switch rather than creating it again. When TradingView ' +
    'refuses the layout after these checks, the call fails with NOT_AVAILABLE, and TradingView ' +
    'may show a message saying why. No tool deletes a layout.',
  inputSchema: {
    name: z
      .string()
      .min(1)
      .max(MAX_NAME_INPUT)
      .describe(
        `The name of the new layout: 1 to ${String(MAX_LAYOUT_NAME)} characters once leading and ` +
          'trailing spaces are trimmed, as the Create new layout dialog of TradingView takes it.',
      ),
    confirm: z
      .boolean()
      .optional()
      .describe(
        'Must be true while the current layout has unsaved changes, or TradingView does not tell: ' +
          'opening the new layout in its place discards them. Not needed otherwise.',
      ),
  },
  annotations: DESTRUCTIVE,
  handler: (input, ctx) => newLayout(input, ctx),
});

// What layout_new does, within budgetMs from its start, timed by now (a test gives its own). Each
// page call waits at most a third of the budget, so that the checks and the creation fit in it
// whatever the call timeout. The creation is sent only while a page wait of the budget is left, and
// the opening of the new layout gets what is left after it.
export async function newLayout(
  { name, confirm }: { name: string; confirm?: boolean | undefined },
  ctx: ToolContext,
  budgetMs: number = NEW_LAYOUT_BUDGET_MS,
  now: () => number = () => performance.now(),
): Promise<ToolOutput<NewLayout>> {
  const startedAt = now();
  const remainingMs = (): number => budgetMs - (now() - startedAt);
  const wanted = layoutNameOf(name);
  const page = await ctx.connection.chartPage();
  const waitMs = Math.min(pageWaitMs(ctx.config.callTimeoutMs), Math.floor(budgetMs / 3));
  // From the checks to the end of the creation and of the load, the other actions on plan limits
  // wait.
  return inPlanLimitedTurn(async (): Promise<ToolOutput<NewLayout>> => {
    const state = await page.bridge.evaluate(readLayoutState, []);
    if (!state.signedIn) {
      throw signedOutError();
    }
    if (state.unsaved !== false && confirm !== true) {
      throw unsavedChangesError('new', state.unsaved);
    }
    const saved = await page.bridge.evaluate(readSavedLayouts, [waitMs]);
    const { CHART_STORAGE: limit = null } = await getPlanLimits(page, ['CHART_STORAGE']);
    requireBelowLimit('CHART_STORAGE', saved.layouts.length, limit, CHART_STORAGE_HINT);
    const permission = await page.bridge.evaluateWithLib(checkLayoutPermission, [waitMs]);
    if ('failed' in permission) {
      throw permissionUnknownError(permission.failed);
    }
    if (permission.allowed === false) {
      // requireBelowLimit has refused a limit that is not a number.
      throw permissionRefusedError(Number(limit));
    }
    // A creation whose answer the call could not wait for might land after the call failed, and a
    // client would create the layout again.
    if (remainingMs() < waitMs) {
      throw outOfTimeError(budgetMs);
    }
    const created = await page.bridge.evaluateWithLib(createLayoutViaApi, [wanted, waitMs]);
    if (created.url === null) {
      throw notCreatedError();
    }
    const id = layoutIdFromUrl(created.url);
    if (id === null) {
      return {
        data: { id, name: wanted, opened: false },
        via: 'internal',
        warnings: [NO_ID_WARNING],
      };
    }
    const openMs = Math.floor(remainingMs());
    if (openMs < MIN_OPEN_MS) {
      return {
        data: { id, name: wanted, opened: false },
        via: 'internal',
        warnings: [notOpenedWarning(id, 'no time was left to open it')],
      };
    }
    let outcome: OpenOutcome;
    try {
      outcome = await openLayout(page, id, {
        waitMs: Math.min(waitMs, openMs),
        limitMs: openMs,
        confirm: confirm === true,
      });
    } catch (error) {
      // The layout exists: whatever fails while it is opened, the call reports it created, since a
      // failed call invites a retry, which would create another layout. An unexpected error is
      // logged, as the registry would log it, and its message kept from the client.
      if (!isTvMcpError(error)) {
        ctx.logger.error(
          { err: error, tool: 'layout_new' },
          'Opening a created layout failed with an unexpected error',
        );
      }
      outcome = { status: 'unopened', reason: isTvMcpError(error) ? error.message : null };
    }
    return {
      data: { id, name: wanted, opened: outcome.status === 'opened' },
      via: 'internal',
      warnings:
        outcome.status === 'opened'
          ? outcome.warnings
          : outcome.status === 'unsaved'
            ? [unsavedNotOpenedWarning(id, outcome.unsaved)]
            : [notOpenedWarning(id, outcome.reason)],
    };
  });
}

export const layoutSwitch = defineTool({
  name: 'layout_switch',
  domain: 'layout',
  title: 'Switch to a saved layout',
  description:
    "Switches the chart tab to another saved layout of the user's TradingView account, given by " +
    'its id from layout_list, and returns id, name and changed (false when the layout is the one ' +
    'shown already, which is left as it is). The layout is loaded in place, as the layouts menu ' +
    'of TradingView loads it, and the call returns once its chart has its data; a warning says ' +
    'when the chart does not report it in time. Loading a layout discards the unsaved changes of ' +
    'the current one: while it has any, or TradingView does not tell, the call fails with ' +
    'CONFIRMATION_REQUIRED unless confirm: true, and nothing changes. An id the account does not ' +
    'have fails with INVALID_INPUT, and a layout layout_list marks overLimit, beyond the ' +
    'CHART_STORAGE limit of the plan, with PLAN_LIMIT. TradingView may still show an upgrade ' +
    'prompt where these checks cannot see: for a saved multi-chart layout on a plan with fewer ' +
    'charts (the list of saved layouts does not say how many charts a layout has), for a layout ' +
    'its server refuses as beyond the limit, and for a layout the list TradingView keeps for ' +
    'itself marks over the limit while layout_list does not (that list can be out of date).',
  inputSchema: {
    layoutId: z
      .string()
      .min(1)
      .max(MAX_LAYOUT_ID)
      .describe('The id of a saved layout, as layout_list reports it.'),
    confirm: z
      .boolean()
      .optional()
      .describe(
        'Must be true while the current layout has unsaved changes, or TradingView does not tell: ' +
          'loading another layout discards them. Not needed otherwise.',
      ),
  },
  annotations: DESTRUCTIVE,
  async handler({ layoutId, confirm }, ctx) {
    const page = await ctx.connection.chartPage();
    const waitMs = pageWaitMs(ctx.config.callTimeoutMs);
    return inPlanLimitedTurn(async (): Promise<ToolOutput<ShownLayout>> => {
      const state = await page.bridge.evaluate(readLayoutState, []);
      if (!state.signedIn) {
        throw signedOutError();
      }
      if (layoutId === state.id) {
        return { data: { id: state.id, name: state.name, changed: false }, via: 'api' };
      }
      // The in-place loader loads nothing, without a word, for an id TradingView does not list.
      const saved = await page.bridge.evaluate(readSavedLayouts, [waitMs]);
      const target = saved.layouts.find(({ url }) => url === layoutId);
      if (target === undefined) {
        throw unknownLayoutError(layoutId);
      }
      if (target.overLimit) {
        throw overLimitError(layoutId);
      }
      if (state.unsaved !== false && confirm !== true) {
        throw unsavedChangesError('switch', state.unsaved);
      }
      const outcome = await openLayout(page, layoutId, {
        waitMs,
        limitMs: Infinity,
        confirm: confirm === true,
      });
      if (outcome.status === 'unsaved') {
        throw unsavedChangesError('switch', outcome.unsaved);
      }
      if (outcome.status === 'unopened') {
        throw notOpenedError(layoutId, outcome.reason);
      }
      return {
        data: { id: layoutId, name: outcome.name ?? target.name, changed: true },
        via: 'api',
        warnings: outcome.warnings,
      };
    });
  },
});

// In the order of the catalog (design spec 7).
export const layoutTools: AnyToolDefinition[] = [layoutList, layoutNew, layoutSwitch];
