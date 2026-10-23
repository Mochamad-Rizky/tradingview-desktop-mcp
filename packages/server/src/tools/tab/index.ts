import { z } from 'zod';
import {
  findNewTabPages,
  isEveryChartTabHidden,
  isNoChartInFrontError,
  type Visibility,
} from '../../core/cdp/targets.js';
import type { PageHandle } from '../../core/connection.js';
import { isTvMcpError, TvMcpError } from '../../core/errors.js';
import { clickElement, type ClickOptions } from '../../core/tv/input.js';
import { readVisibilityState } from '../../core/tv/probes.js';
import { SELECTORS } from '../../core/tv/selectors.js';
import { pollUntil } from '../../utils/poll.js';
import { READ_ONLY } from '../annotations.js';
import { pageWaitMs, POLL_INTERVAL_MS } from '../chart/strategies.js';
import { defineTool, type AnyToolDefinition, type ToolContext, type ToolOutput } from '../types.js';
import { readTabs, readUnsavedLayout, TAB_STRIP, type StripTab } from './page.js';

// The tab tools (design spec 7, domain Tabs): the tabs of the TradingView window, read from the tab
// strip of the window chrome and changed with clicks on it (reverse-engineering notes of Plan 3,
// section 3). The renderer of the window chrome has Node integration, so the tools only read its
// DOM there, with page functions that read nothing else, and send it the input of the guarded
// click helpers. Every click is one press of the left button on the very part of the strip it aims
// at: the shell duplicates a tab on a second click of it, closes it on a middle click and opens its
// menu on a right click.
//
// Only the page of the tab in front is shown, and the connection manager maps the chart tools to it
// by its visibility (connection.ts), anew on every call. The strip and the pages are separate
// renderers, so a page can hear of a change of the tab in front later than the strip shows it: a tool
// that changes the tab in front waits until the mapping shows the change too (awaitPageInFront), so
// that the next tool acts on the tab in front. No session is dropped for it: a call that runs on a
// page meanwhile goes on, and the session of a tab that closed goes once the targets are listed
// without it. A new tab opens on
// TradingView's New tab page, whose renderer has Node integration too: it is only ever found by its
// URL among the targets, never connected to.

// The shell answers a click on the strip over IPC, within a moment; a change that has not shown by
// this time is not going to. Each wait is kept within the page wait of the call timeout as well.
const TAB_WAIT_MS = 5000;

// How long no chart in front has to last before it counts: on the way from one chart tab to another,
// the page that leaves the front can report itself hidden before the other one reports itself
// visible.
const NO_CHART_SETTLE_MS = 600;

// The clicks on a tab (ClickOptions). Its title shows the names of the user's layouts and symbols,
// which the test of trading names would take for trading actions ("Sell the rally"), on a page that
// holds no order controls; and the click has to land on the part it aims at, never on the close
// button beside the title. The click on the new-tab button keeps the whole guard.
const TAB_CLICK: ClickOptions = { skipTradingNames: true, onTargetOnly: true };

const LIST_HINT = 'List the tabs with tab_list, and give one of their ids or indexes.';

// A tab of the strip, with its place in it.
type ListedTab = StripTab & { index: number };

// How the caller named a tab.
type TabChoice = { tabId: string } | { index: number };

// A value as a CSS string in double quotes, for an attribute selector: a double quote and a
// backslash are escaped with a backslash, and a control character (a newline among them, which
// would end the string) with its code in hex and a space, which ends the escape before a hex digit
// that follows. Anything else stands for itself in a CSS string, digits at the start included. The
// ids of the strip are UUIDs, which need nothing escaped.
export function cssString(value: string): string {
  let escaped = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (character === '"' || character === '\\') {
      escaped += `\\${character}`;
    } else if (code < 0x20 || code === 0x7f) {
      escaped += `\\${code.toString(16)} `;
    } else {
      escaped += character;
    }
  }
  return `"${escaped}"`;
}

// A part of the tab with id `tabId`: its title or its close button.
function partOf(tabId: string, part: string): string {
  return `div.tab[id=${cssString(tabId)}] ${part}`;
}

async function listTabs(chrome: PageHandle): Promise<ListedTab[]> {
  const { tabs } = await chrome.bridge.evaluate(readTabs, [TAB_STRIP]);
  return tabs.map((tab, index) => ({ ...tab, index }));
}

function tabWaitMs(ctx: Pick<ToolContext, 'config'>): number {
  return Math.min(TAB_WAIT_MS, pageWaitMs(ctx.config.callTimeoutMs));
}

// Exactly one of tabId and index, checked before anything is looked at.
function tabChoiceOf(tabId: string | undefined, index: number | undefined): TabChoice {
  if (tabId !== undefined && index === undefined) {
    return { tabId };
  }
  if (index !== undefined && tabId === undefined) {
    return { index };
  }
  throw new TvMcpError('INVALID_INPUT', 'Give exactly one of tabId or index', {
    hint: 'Name the tab by its id or by its index in the tab strip, as tab_list lists them, not both.',
  });
}

function findTab(tabs: ListedTab[], choice: TabChoice): ListedTab {
  if ('tabId' in choice) {
    const tab = tabs.find(({ id }) => id === choice.tabId);
    if (tab === undefined) {
      throw new TvMcpError(
        'INVALID_INPUT',
        `No tab of the window has the id ${JSON.stringify(choice.tabId)}`,
        { hint: LIST_HINT, details: { tabId: choice.tabId } },
      );
    }
    return tab;
  }
  const tab = tabs[choice.index];
  if (tab === undefined) {
    const count = `${String(tabs.length)} tab${tabs.length === 1 ? '' : 's'}`;
    throw new TvMcpError(
      'INVALID_INPUT',
      `There is no tab at index ${String(choice.index)}: the window has ${count}`,
      { hint: LIST_HINT, details: { index: choice.index, tabs: tabs.length } },
    );
  }
  return tab;
}

// The page the connection manager maps the chart tools to: a chart tab, by the id of its target;
// none, when the tab in front shows no chart while a New tab page is open, every chart tab hidden;
// or unknown, when it cannot tell (several tabs report themselves visible, the window is out of
// view, a page does not answer).
type FrontPage = { kind: 'chart'; targetId: string } | { kind: 'none' } | { kind: 'unknown' };

async function frontPage(ctx: ToolContext): Promise<FrontPage> {
  try {
    return { kind: 'chart', targetId: (await ctx.connection.chartPage()).target.id };
  } catch (error) {
    if (isNoChartInFrontError(error) && isEveryChartTabHidden(error)) {
      return { kind: 'none' };
    }
    if (isTvMcpError(error)) {
      return { kind: 'unknown' };
    }
    throw error;
  }
}

// The visibility of the window chrome, which is hidden while the window is covered by other windows
// or minimized: a property of its document, read like the rest of its DOM.
async function windowVisibility(ctx: ToolContext): Promise<Visibility> {
  const chrome = await ctx.connection.windowChromePage();
  return chrome.bridge.evaluate(readVisibilityState, []);
}

// What the mapping showed once the strip showed a tab in front: a chart tab in front, or no chart in
// front (a New tab page); the window out of view, where pages say nothing about the tab in front
// (covered); no change within the wait (late); or, when the mapping could not tell either before the
// click, nothing it kept to for long enough (unconfirmed).
type Arrival = 'chart' | 'none' | 'covered' | 'late' | 'unconfirmed';

// Waits until the mapping of the chart tools shows the change of the tab in front that the strip
// shows already: a chart tab other than the one in front before the click (`before`), or no chart in
// front that lasts NO_CHART_SETTLE_MS. When nothing was known before the click, a chart tab counts
// only once it lasts as long. The wait is the tab wait, and never shorter than a settle and a few
// polls, which the call timeout always leaves room for.
async function awaitPageInFront(ctx: ToolContext, before: FrontPage): Promise<Arrival> {
  const waitMs = Math.max(tabWaitMs(ctx), NO_CHART_SETTLE_MS + 3 * POLL_INTERVAL_MS);
  let held: { reading: string; since: number } | undefined;
  const { satisfied, last } = await pollUntil(
    async (): Promise<Arrival | null> => {
      if ((await windowVisibility(ctx)) === 'hidden') {
        return 'covered';
      }
      const front = await frontPage(ctx);
      const now = performance.now();
      if (
        front.kind === 'chart' &&
        before.kind !== 'unknown' &&
        (before.kind === 'none' || front.targetId !== before.targetId)
      ) {
        return 'chart';
      }
      // A reading that counts once it lasts: no chart in front, or a chart tab when nothing was
      // known before the click.
      const lasting =
        front.kind === 'none'
          ? 'none'
          : front.kind === 'chart' && before.kind === 'unknown'
            ? front.targetId
            : undefined;
      if (lasting === undefined) {
        held = undefined;
      } else if (held?.reading !== lasting) {
        held = { reading: lasting, since: now };
      } else if (now - held.since >= NO_CHART_SETTLE_MS) {
        return lasting === 'none' ? 'none' : 'chart';
      }
      return null;
    },
    (arrival) => arrival !== null,
    { intervalMs: POLL_INTERVAL_MS, timeoutMs: waitMs },
  );
  if (satisfied && last !== null) {
    return last;
  }
  return before.kind === 'unknown' ? 'unconfirmed' : 'late';
}

// Brings `tab` to the front with a click on its title, waits until the strip shows it there, and
// then until the mapping of the chart tools shows it too (awaitPageInFront), with `before` read
// before the click.
async function bringToFront(
  ctx: ToolContext,
  chrome: PageHandle,
  tab: ListedTab,
  before: FrontPage,
): Promise<Arrival> {
  const waitMs = tabWaitMs(ctx);
  await clickElement(chrome, partOf(tab.id, SELECTORS.windowChrome.tabTitle), TAB_CLICK);
  const { satisfied } = await pollUntil(
    () => listTabs(chrome),
    (tabs) => tabs.some(({ id, active }) => id === tab.id && active),
    { intervalMs: POLL_INTERVAL_MS, timeoutMs: waitMs },
  );
  if (!satisfied) {
    throw new TvMcpError(
      'TIMEOUT',
      `The tab did not come to the front within ${String(waitMs)} ms`,
      {
        hint: 'Check tab_list: TradingView may still bring the tab to the front.',
        details: { tabId: tab.id, ms: waitMs },
      },
    );
  }
  return awaitPageInFront(ctx, before);
}

// The ids of the New tab pages the debug port lists, or null while it cannot list them.
async function newTabPageIds(ctx: ToolContext): Promise<string[] | null> {
  try {
    return findNewTabPages(await ctx.connection.targets()).map(({ id }) => id);
  } catch (error) {
    if (isTvMcpError(error)) {
      return null;
    }
    throw error;
  }
}

// Closing a tab whose page says shouldBeSaved() makes the shell ask in its "Close tab?" dialog
// (notes of Plan 3, section 3.4), which no tool may open, so the page of the tab is asked first. The
// tab is in front by now, so a chart it shows is the chart page the connection manager maps to the
// tab in front. No chart tab in front while a New tab page is open, every chart tab hidden, means
// that the tab is a New tab page, which has no layout to save, but only while the window is in
// view: while it is covered by other windows or minimized, every page of it reports hidden, the
// chart in front too, and so does the window chrome (seen on the app), whose own visibility tells
// the two apart. It is asked again here, as the window may have gone out of view since the tool
// first asked. Anything else cannot be told, and is refused.
async function assertClosesWithoutDialog(ctx: ToolContext, tabId: string): Promise<void> {
  let page: PageHandle;
  try {
    page = await ctx.connection.chartPage();
  } catch (error) {
    if (isNoChartInFrontError(error) && isEveryChartTabHidden(error)) {
      await assertWindowInView(ctx, tabId);
      return;
    }
    if (isTvMcpError(error) && error.code === 'TARGET_NOT_FOUND') {
      throw new TvMcpError(
        'NOT_AVAILABLE',
        `Cannot tell whether closing the tab would open the "Close tab?" dialog of TradingView: ${error.message}`,
        { hint: 'Close the tab in TradingView yourself.', details: { tabId, reason: error.code } },
      );
    }
    throw error;
  }
  const { shouldBeSaved } = await page.bridge.evaluate(readUnsavedLayout, []);
  if (shouldBeSaved === true) {
    throw new TvMcpError(
      'NOT_AVAILABLE',
      'The layout of the tab has unsaved changes: closing it would open the "Close tab?" dialog ' +
        'of TradingView',
      {
        hint: 'Save the layout in TradingView, or wait for autosave to save it, then try again.',
        details: { tabId },
      },
    );
  }
  if (shouldBeSaved === null) {
    throw new TvMcpError(
      'NOT_AVAILABLE',
      'TradingView does not say whether the layout of the tab has unsaved changes, and closing a ' +
        'tab with some opens its "Close tab?" dialog',
      {
        hint: 'Save the layout in TradingView first, or check app_health.',
        details: { tabId },
      },
    );
  }
}

function windowOutOfView(tabId: string): TvMcpError {
  return new TvMcpError(
    'NOT_AVAILABLE',
    'The TradingView window is out of view, so whether the tab in front shows a chart cannot be ' +
      'told',
    {
      hint:
        'Bring the TradingView window into view (it is covered by other windows or minimized), ' +
        'then try again.',
      details: { tabId, reason: 'window-out-of-view' },
    },
  );
}

// The close itself: the strip is looked at again right before the click, as the user may have
// changed it since the tool read it; the tab must still be in front, not be the only tab of the
// window, and show its close button. Then one guarded click on that button, and a wait until the
// tab is gone.
async function clickClose(
  ctx: ToolContext,
  tabId: string,
): Promise<ToolOutput<{ closed: string; remaining: number }>> {
  const chrome = await ctx.connection.windowChromePage();
  const tabs = await listTabs(chrome);
  const current = tabs.find(({ id }) => id === tabId);
  if (current?.active !== true) {
    throw new TvMcpError('NOT_AVAILABLE', 'The tab is no longer in front of the window', {
      hint: 'Check tab_list, then try again.',
      details: { tabId, inFront: false },
    });
  }
  if (tabs.length === 1) {
    throw onlyTab(tabId);
  }
  if (!current.closable) {
    throw noCloseButton(tabId);
  }
  const waitMs = tabWaitMs(ctx);
  await clickElement(chrome, partOf(tabId, SELECTORS.windowChrome.tabCloseButton), TAB_CLICK);
  const gone = await pollUntil(
    () => listTabs(chrome),
    (left) => !left.some(({ id }) => id === tabId),
    { intervalMs: POLL_INTERVAL_MS, timeoutMs: waitMs },
  );
  if (!gone.satisfied) {
    throw new TvMcpError('TIMEOUT', `The tab did not close within ${String(waitMs)} ms`, {
      hint:
        'Check tab_list: TradingView may still close it. If TradingView asks about the tab in ' +
        'a dialog, answer it there.',
      details: { tabId, ms: waitMs },
    });
  }
  ctx.session.openedTabIds.delete(tabId);
  return { data: { closed: tabId, remaining: gone.last.length }, via: 'dom' };
}

// Whether the window is in view, as its window chrome reports it (windowVisibility).
async function assertWindowInView(ctx: ToolContext, tabId: string): Promise<void> {
  if ((await windowVisibility(ctx)) !== 'visible') {
    throw windowOutOfView(tabId);
  }
}

function onlyTab(tabId: string): TvMcpError {
  return new TvMcpError(
    'NOT_AVAILABLE',
    'The only tab of the window is not closed: closing it would close the window',
    {
      hint: 'TradingView closes the window with its last tab. Close the window there yourself.',
      details: { tabId },
    },
  );
}

// A refusal of tab_close after it brought the tab to the front, which leaves the tab there, where
// the chart tools act on it: the refusal says so, in its hint and with inFront in its details. A
// refusal that already says where the tab is, and anything that is not one of ours, is left as it is.
function leftInFront(error: unknown): unknown {
  if (!isTvMcpError(error) || error.details?.inFront !== undefined) {
    return error;
  }
  const where =
    'The tab is in front now, where tab_close brought it, and the chart tools act on the tab in ' +
    'front.';
  return new TvMcpError(error.code, error.message, {
    hint: error.hint === undefined ? where : `${where} ${error.hint}`,
    details: { ...error.details, inFront: true },
    cause: error,
  });
}

function noCloseButton(tabId: string): TvMcpError {
  return new TvMcpError('NOT_AVAILABLE', 'The tab shows no close button', {
    hint: 'A pinned tab has none: unpin it in TradingView first, or close it there yourself.',
    details: { tabId },
  });
}

function tabIdInput() {
  return z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('The id of the tab, as tab_list reports it. Give this or index, not both.');
}

function indexInput() {
  return z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'The place of the tab in the tab strip, from 0 at the left, as tab_list reports it. Give ' +
        'this or tabId, not both.',
    );
}

export const tabList = defineTool({
  name: 'tab_list',
  domain: 'tab',
  title: 'List the tabs',
  description:
    'Lists the tabs of the TradingView window in the order of its tab strip, and changes nothing. ' +
    'Each tab has id (the id TradingView gives the tab, which tab_switch and tab_close take), ' +
    'index (its place in the strip, from 0 at the left), title (what the tab shows: the symbol, ' +
    'its last price and change, and the name of its layout, or the title of a New tab page), ' +
    'active (whether it is the tab in front, whose chart the chart tools act on) and ' +
    'openedBySession (whether tab_new of this session opened it, so that tab_close needs no ' +
    'confirm for it).',
  inputSchema: {},
  annotations: READ_ONLY,
  async handler(_input, ctx) {
    const chrome = await ctx.connection.windowChromePage();
    const tabs = await listTabs(chrome);
    return {
      data: {
        tabs: tabs.map(({ id, index, title, active }) => ({
          id,
          index,
          title,
          active,
          openedBySession: ctx.session.openedTabIds.has(id),
        })),
      },
      via: 'dom',
    };
  },
});

export const tabNew = defineTool({
  name: 'tab_new',
  domain: 'tab',
  title: 'Open a new tab',
  description:
    'Opens a new tab in the TradingView window, as its new-tab button does, and waits until the ' +
    "tab is in front and its page has opened. The tab shows TradingView's own New tab start " +
    'page: no chart and no saved layout, so nothing counts against the limit of saved layouts of ' +
    'the plan (CHART_STORAGE). While it is in front, the chart tools fail with TARGET_NOT_FOUND, ' +
    'since the tab shows no chart: bring a chart tab back with tab_switch, or close the new tab ' +
    'with tab_close, which needs no confirm for a tab this session opened. (While the TradingView ' +
    'window is covered or minimized, which tab is in front cannot be told, and the chart tools use ' +
    'the only chart tab, if there is just one.) Returns id and index ' +
    'of the new tab, and a warning when its page did not open in time. TIMEOUT when no new tab ' +
    'shows in time: check tab_list before trying again, as the tab may still open.',
  inputSchema: {},
  // A new tab every time; nothing of the user is changed.
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  async handler(_input, ctx) {
    const chrome = await ctx.connection.windowChromePage();
    const before = new Set((await listTabs(chrome)).map(({ id }) => id));
    const pagesBefore = new Set(
      findNewTabPages(await ctx.connection.targets()).map(({ id }) => id),
    );
    const frontBefore = await frontPage(ctx);
    const waitMs = tabWaitMs(ctx);
    await clickElement(chrome, SELECTORS.windowChrome.newTab);
    const opened = await pollUntil(
      () => listTabs(chrome),
      (tabs) => tabs.some(({ id, active }) => active && !before.has(id)),
      { intervalMs: POLL_INTERVAL_MS, timeoutMs: waitMs },
    );
    const tab = opened.last.find(({ id, active }) => active && !before.has(id));
    if (tab === undefined) {
      throw new TvMcpError(
        'TIMEOUT',
        `No new tab showed in the tab strip within ${String(waitMs)} ms`,
        {
          hint:
            'Check tab_list before you try again: the tab may still open, and tab_new would ' +
            'open another one.',
          details: { ms: waitMs },
        },
      );
    }
    ctx.session.openedTabIds.add(tab.id);
    // Its page is found by its URL among the targets, and never connected to.
    const page = await pollUntil(
      () => newTabPageIds(ctx),
      (ids) => ids?.some((id) => !pagesBefore.has(id)) === true,
      { intervalMs: POLL_INTERVAL_MS, timeoutMs: waitMs },
    );
    if (!page.satisfied) {
      return {
        data: { id: tab.id, index: tab.index },
        via: 'dom',
        warnings: [
          `The new tab is open, but its page did not show among the pages of TradingView ` +
            `within ${String(waitMs)} ms: until it does, the chart tools may act on the chart ` +
            'of a tab behind it.',
        ],
      };
    }
    // The chart tab it covers may hear of it later than the strip: the chart tools are left to
    // the mapping once that shows the new tab in front too.
    const arrival = await awaitPageInFront(ctx, frontBefore);
    return {
      data: { id: tab.id, index: tab.index },
      via: 'dom',
      warnings:
        arrival === 'late' || arrival === 'unconfirmed'
          ? [
              'The new tab is open, but the chart tab it covers did not show yet that it is ' +
                'behind it: for a moment, the chart tools may still act on that chart.',
            ]
          : [],
    };
  },
});

export const tabSwitch = defineTool({
  name: 'tab_switch',
  domain: 'tab',
  title: 'Bring a tab to the front',
  description:
    'Brings a tab of the TradingView window to the front, as a click on it does, and waits until ' +
    'it is the active tab and its page is in front; the chart tools then act on the chart it ' +
    'shows. NOT_AVAILABLE when the strip shows the tab but its page does not come to the front ' +
    'in time (try tab_list or a chart tool again shortly); a warning when that cannot be ' +
    'confirmed, as while the window is covered or minimized. Give exactly one of ' +
    'tabId or index (tab_list lists both). Returns id, index and changed, which is false for a ' +
    'tab that was in front already: it is left as it is, with no click, as a second click on a ' +
    'tab can duplicate it. The click lands on the title of the tab and nowhere else: when ' +
    'something else lies there, such as its close button, nothing is clicked (NOT_AVAILABLE). ' +
    'INVALID_INPUT for neither or both of tabId and index, and for a tab the window does not have. ' +
    'TIMEOUT when the tab does not come to the front in time.',
  inputSchema: { tabId: tabIdInput(), index: indexInput() },
  // Bringing the tab in front to the front again changes nothing.
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(
    { tabId, index },
    ctx,
  ): Promise<ToolOutput<{ id: string; index: number; changed: boolean }>> {
    const choice = tabChoiceOf(tabId, index);
    const chrome = await ctx.connection.windowChromePage();
    const tab = findTab(await listTabs(chrome), choice);
    if (tab.active) {
      return { data: { id: tab.id, index: tab.index, changed: false }, via: 'dom' };
    }
    const arrival = await bringToFront(ctx, chrome, tab, await frontPage(ctx));
    if (arrival === 'late') {
      throw new TvMcpError(
        'NOT_AVAILABLE',
        'The tab is selected in the tab strip, but its page has not come to the front yet',
        {
          hint: 'Try tab_list or a chart tool again shortly.',
          details: { tabId: tab.id },
        },
      );
    }
    const warnings: string[] = [];
    if (arrival === 'covered') {
      warnings.push(
        'The tab is selected in the tab strip, but whether its page is in front could not be ' +
          'confirmed while the TradingView window is covered or minimized.',
      );
    } else if (arrival === 'unconfirmed') {
      warnings.push(
        'The tab is selected in the tab strip, but whether its page is in front could not be ' +
          'confirmed: the pages of TradingView do not tell which tab is in front.',
      );
    }
    return { data: { id: tab.id, index: tab.index, changed: true }, via: 'dom', warnings };
  },
});

export const tabClose = defineTool({
  name: 'tab_close',
  domain: 'tab',
  title: 'Close a tab',
  description:
    'Closes a tab of the TradingView window with its close button, and returns closed (its id) ' +
    'and remaining (how many tabs are left). Give exactly one of tabId or index (tab_list lists ' +
    "both). The window's only tab is never closed (NOT_AVAILABLE), since TradingView would close " +
    'the window with it. A tab that tab_new of this session did not open holds the layout of the ' +
    'user and needs confirm: true, or the call fails with CONFIRMATION_REQUIRED and nothing ' +
    'changes. A tab in the background is brought to the front first, as its close button may ' +
    'show only there. A tab whose layout has unsaved changes is refused with NOT_AVAILABLE, ' +
    'confirm or not, since TradingView would ask in a dialog whether to save them: save the ' +
    'layout, or wait for autosave, first. NOT_AVAILABLE as well, before anything is clicked, while ' +
    'the TradingView window is covered or minimized, since which page the tab in front shows ' +
    'cannot be told then, and when the server cannot tell it otherwise, or the tab shows no close ' +
    'button (a pinned tab). INVALID_INPUT for ' +
    'neither or both of tabId and index, and for a tab the window does not have. TIMEOUT when the ' +
    'tab does not close in time.',
  inputSchema: {
    tabId: tabIdInput(),
    index: indexInput(),
    confirm: z
      .boolean()
      .optional()
      .describe(
        'Must be true to close a tab that tab_new of this session did not open. Not needed for ' +
          'one it opened.',
      ),
  },
  // The tab of the user, and the layout it shows, leave the window. Closing by index again closes
  // another tab.
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  async handler(
    { tabId, index, confirm },
    ctx,
  ): Promise<ToolOutput<{ closed: string; remaining: number }>> {
    const choice = tabChoiceOf(tabId, index);
    const strip = await ctx.connection.windowChromePage();
    const tabs = await listTabs(strip);
    const tab = findTab(tabs, choice);
    if (tabs.length === 1) {
      throw onlyTab(tab.id);
    }
    if (!ctx.session.openedTabIds.has(tab.id) && confirm !== true) {
      throw new TvMcpError(
        'CONFIRMATION_REQUIRED',
        'Closing this tab needs confirm: true: this session did not open it',
        {
          hint:
            'The tab belongs to the user. Pass confirm: true to close it all the same; its saved ' +
            'layout stays saved.',
          details: { tabId: tab.id },
        },
      );
    }
    if (tab.active && !tab.closable) {
      throw noCloseButton(tab.id);
    }
    // The page in front can be told only while the window is in view (assertClosesWithoutDialog),
    // so a covered or minimized window is refused before anything is clicked.
    await assertWindowInView(ctx, tab.id);
    let broughtToFront = false;
    try {
      if (!tab.active) {
        // Whether the page of the tab came to the front is told by a change of the page in front,
        // so that must be known before the click.
        const before = await frontPage(ctx);
        if (before.kind === 'unknown') {
          throw new TvMcpError(
            'NOT_AVAILABLE',
            'Which page is in front of the window cannot be told, so whether closing a tab in the ' +
              'background would open the "Close tab?" dialog of TradingView cannot be checked',
            {
              hint: 'Try again shortly, or close the tab in TradingView yourself.',
              details: { tabId: tab.id, reason: 'front-unknown' },
            },
          );
        }
        const arrival = await bringToFront(ctx, strip, tab, before);
        broughtToFront = true;
        if (arrival === 'covered') {
          throw windowOutOfView(tab.id);
        }
        if (arrival === 'late' || arrival === 'unconfirmed') {
          throw new TvMcpError(
            'NOT_AVAILABLE',
            'The tab is selected in the tab strip, but its page has not come to the front yet, ' +
              'so whether closing it would open the "Close tab?" dialog of TradingView cannot be ' +
              'told',
            {
              hint: 'Try again shortly.',
              details: { tabId: tab.id, reason: 'page-not-in-front' },
            },
          );
        }
      }
      await assertClosesWithoutDialog(ctx, tab.id);
      return await clickClose(ctx, tab.id);
    } catch (error) {
      throw broughtToFront ? leftInFront(error) : error;
    }
  },
});

// In the order of the catalog (design spec 7).
export const tabTools: AnyToolDefinition[] = [tabList, tabNew, tabSwitch, tabClose];
