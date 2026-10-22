import { z } from 'zod';
import {
  findNewTabPages,
  isEveryChartTabHidden,
  isNoChartInFrontError,
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
// by its visibility (connection.ts). So once a tool may have changed the tab in front, it drops
// every session (reset), and the next tool looks again. A new tab opens on TradingView's New tab
// page, whose renderer has Node integration too: it is only ever found by its URL among the
// targets, never connected to.

// The shell answers a click on the strip over IPC, within a moment; a change that has not shown by
// this time is not going to. Each wait is kept within the page wait of the call timeout as well.
const TAB_WAIT_MS = 5000;

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

// A value in double quotes for an attribute selector, with what would end it or break it escaped.
// The ids of the strip are UUIDs, which need nothing escaped.
function quoted(value: string): string {
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
  return `div.tab[id=${quoted(tabId)}] ${part}`;
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

// Brings `tab` to the front with a click on its title and waits until the strip shows it there.
// However that ends, the sessions are dropped, since the click may have changed the tab in front.
async function bringToFront(ctx: ToolContext, chrome: PageHandle, tab: ListedTab): Promise<void> {
  const waitMs = tabWaitMs(ctx);
  try {
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
  } finally {
    await ctx.connection.reset();
  }
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
// the two apart. Anything else cannot be told, and is refused.
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

// Whether the window is in view, as its window chrome reports it: a property of its document, read
// like the rest of its DOM.
async function assertWindowInView(ctx: ToolContext, tabId: string): Promise<void> {
  const chrome = await ctx.connection.windowChromePage();
  if ((await chrome.bridge.evaluate(readVisibilityState, [])) !== 'visible') {
    throw new TvMcpError(
      'NOT_AVAILABLE',
      'The TradingView window is out of view, so whether the tab in front shows a chart cannot ' +
        'be told',
      {
        hint:
          'Bring the TradingView window into view (it is covered by other windows or minimized), ' +
          'then try again.',
        details: { tabId, reason: 'window-out-of-view' },
      },
    );
  }
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
    'with tab_close, which needs no confirm for a tab this session opened. Returns id and index ' +
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
    const waitMs = tabWaitMs(ctx);
    try {
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
      return {
        data: { id: tab.id, index: tab.index },
        via: 'dom',
        warnings: page.satisfied
          ? []
          : [
              `The new tab is open, but its page did not show among the pages of TradingView ` +
                `within ${String(waitMs)} ms: until it does, the chart tools may act on the ` +
                'chart of a tab behind it.',
            ],
      };
    } finally {
      await ctx.connection.reset();
    }
  },
});

export const tabSwitch = defineTool({
  name: 'tab_switch',
  domain: 'tab',
  title: 'Bring a tab to the front',
  description:
    'Brings a tab of the TradingView window to the front, as a click on it does, and waits until ' +
    'it is the active tab; the chart tools then act on the chart it shows. Give exactly one of ' +
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
  async handler({ tabId, index }, ctx) {
    const choice = tabChoiceOf(tabId, index);
    const chrome = await ctx.connection.windowChromePage();
    const tab = findTab(await listTabs(chrome), choice);
    if (!tab.active) {
      await bringToFront(ctx, chrome, tab);
    }
    return { data: { id: tab.id, index: tab.index, changed: !tab.active }, via: 'dom' };
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
    'layout, or wait for autosave, first. NOT_AVAILABLE as well when the server cannot tell which ' +
    'page the tab shows, as while the TradingView window is covered or minimized, or the tab ' +
    'shows no close button (a pinned tab). INVALID_INPUT for ' +
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
      throw new TvMcpError(
        'NOT_AVAILABLE',
        'The only tab of the window is not closed: closing it would close the window',
        {
          hint: 'TradingView closes the window with its last tab. Close the window there yourself.',
          details: { tabId: tab.id },
        },
      );
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
    if (!tab.active) {
      await bringToFront(ctx, strip, tab);
    }
    await ctx.connection.reset();
    await assertClosesWithoutDialog(ctx, tab.id);

    // Looked at again right before the click: the tab must still be in front, and show its close
    // button.
    const chrome = await ctx.connection.windowChromePage();
    const current = (await listTabs(chrome)).find(({ id }) => id === tab.id);
    if (current?.active !== true) {
      throw new TvMcpError('NOT_AVAILABLE', 'The tab is no longer in front of the window', {
        hint: 'Check tab_list, then try again.',
        details: { tabId: tab.id },
      });
    }
    if (!current.closable) {
      throw noCloseButton(tab.id);
    }
    const waitMs = tabWaitMs(ctx);
    try {
      await clickElement(chrome, partOf(tab.id, SELECTORS.windowChrome.tabCloseButton), TAB_CLICK);
      const gone = await pollUntil(
        () => listTabs(chrome),
        (left) => !left.some(({ id }) => id === tab.id),
        { intervalMs: POLL_INTERVAL_MS, timeoutMs: waitMs },
      );
      if (!gone.satisfied) {
        throw new TvMcpError('TIMEOUT', `The tab did not close within ${String(waitMs)} ms`, {
          hint:
            'Check tab_list: TradingView may still close it. If TradingView asks about the tab ' +
            'in a dialog, answer it there.',
          details: { tabId: tab.id, ms: waitMs },
        });
      }
      ctx.session.openedTabIds.delete(tab.id);
      return { data: { closed: tab.id, remaining: gone.last.length }, via: 'dom' };
    } finally {
      await ctx.connection.reset();
    }
  },
});

// In the order of the catalog (design spec 7).
export const tabTools: AnyToolDefinition[] = [tabList, tabNew, tabSwitch, tabClose];
