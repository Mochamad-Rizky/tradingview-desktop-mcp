import { z } from 'zod';
import type { PageHandle } from '../../core/connection.js';
import { TvMcpError } from '../../core/errors.js';
import type { Tier } from '../../core/result.js';
import { clickElement } from '../../core/tv/input.js';
import { pollUntil } from '../../utils/poll.js';
import { pageWaitMs } from '../chart/strategies.js';
import { ensureEditorOpen, readEditorState } from '../pine/editor.js';
import { closePineEditor } from '../pine/page.js';
import { defineTool, type ToolContext } from '../types.js';
import { PANEL_CONTROLS, readFullscreen, readPanelControls, setFullscreen } from './page.js';

// The panel and fullscreen tools of the low-level interface (design spec 7, domain Low-level UI).
//
// The panels of the right toolbar open and close through its buttons, which say with aria-pressed
// which panel is shown; a click on the button of a hidden panel shows it, and one on the button of
// the shown panel collapses it (notes of Plan 3, section 6.1). The data window has no button: it is
// a tab of the panel of the object tree. The buttons and tabs are clicked through the guarded click
// of the input helpers, like any click of ui_click, and the panel is read again until it shows as
// asked. The Pine Editor opens and closes through the access layer of the Pine tools, which opens
// it the way its button does and closes it without discarding its text.
//
// The fullscreen mode is TradingView's own, inside the page: the API of the app turns it on and off
// and the collection of the charts reports it (notes of Plan 3, section 6.2).

const PANELS = ['watchlist', 'alerts', 'object_tree', 'data_window', 'pine_editor'] as const;

type Panel = (typeof PANELS)[number];
type ToolbarPanel = Exclude<Panel, 'pine_editor'>;
type Controls = Awaited<ReturnType<typeof readControls>>;

const LABELS: Record<Panel, string> = {
  watchlist: 'watchlist',
  alerts: 'alerts',
  object_tree: 'object tree',
  data_window: 'data window',
  pine_editor: 'Pine Editor',
};

// How often the page is read while a panel opens or closes, and for how long at most: a panel
// changes within a moment of the click.
const POLL_INTERVAL_MS = 100;
const PANEL_WAIT_MS = 3000;
// TradingView changes its fullscreen mode at once (seen in the bundle), so a short wait will do.
const FULLSCREEN_POLL_MS = 50;
const FULLSCREEN_WAIT_MS = 1000;

function readControls(page: PageHandle) {
  return page.bridge.evaluate(readPanelControls, [PANEL_CONTROLS]);
}

// Whether a panel of the right toolbar shows as `controls` read it. The panel of the object tree
// shows the data window while its tab is selected, and the object tree otherwise.
function isOpen(panel: ToolbarPanel, controls: Controls): boolean {
  const { buttons, tabs } = controls;
  switch (panel) {
    case 'watchlist':
      return buttons.watchlist.pressed === true;
    case 'alerts':
      return buttons.alerts.pressed === true;
    case 'object_tree':
      return buttons.object_tree.pressed === true && !tabs.data_window.selected;
    case 'data_window':
      return buttons.object_tree.pressed === true && tabs.data_window.selected;
  }
}

interface Failure {
  panel: Panel;
  open: boolean;
  waitMs: number;
}

// A panel that did not change after the click.
function panelTimeout({ panel, open, waitMs }: Failure): TvMcpError {
  return new TvMcpError(
    'TIMEOUT',
    `The ${LABELS[panel]} did not ${open ? 'open' : 'close'} within ${String(waitMs)} ms of the click`,
    {
      hint:
        'TradingView may not have taken the click, or a dialog or a menu took it. Check ' +
        'app_get_ui_state, close what covers the right toolbar, and try again.',
      details: { panel, open, timeoutMs: waitMs },
    },
  );
}

// Reads the page until `done` accepts what it shows, or TIMEOUT once waitMs has passed.
async function waitFor(
  page: PageHandle,
  done: (controls: Controls) => boolean,
  failure: Failure,
): Promise<Controls> {
  const { satisfied, last } = await pollUntil(() => readControls(page), done, {
    intervalMs: POLL_INTERVAL_MS,
    timeoutMs: failure.waitMs,
  });
  if (!satisfied) {
    throw panelTimeout(failure);
  }
  return last;
}

// Opens or closes a panel of the right toolbar, and answers whether it clicked anything. Every
// refusal that needs no click comes before the first one.
async function setToolbarPanel(
  page: PageHandle,
  panel: ToolbarPanel,
  open: boolean,
  waitMs: number,
): Promise<boolean> {
  const owner = panel === 'data_window' ? 'object_tree' : panel;
  const selector = PANEL_CONTROLS.buttons[owner];
  const before = await readControls(page);
  const button = before.buttons[owner];
  if (!button.found) {
    throw new TvMcpError(
      'CAPABILITY_UNAVAILABLE',
      `The right toolbar of this page has no button for the ${LABELS[owner]}`,
      {
        hint: 'This build of TradingView may lay out its toolbar otherwise. Open the panel in TradingView yourself.',
        details: { panel, selector },
      },
    );
  }
  if (button.pressed === null) {
    throw new TvMcpError(
      'CAPABILITY_UNAVAILABLE',
      `The button for the ${LABELS[owner]} does not say whether its panel is shown`,
      {
        hint: 'Without that, this server cannot tell what a click would do. Open the panel in TradingView yourself.',
        details: { panel, selector },
      },
    );
  }
  if (isOpen(panel, before) === open) {
    return false;
  }
  if (!button.shown) {
    throw new TvMcpError('NOT_AVAILABLE', 'The right toolbar of TradingView is not shown', {
      hint: 'TradingView hides its toolbars in its fullscreen mode: leave it with ui_fullscreen (enabled: false) first.',
      details: { panel },
    });
  }

  const failure: Failure = { panel, open, waitMs };
  if (!open || (panel !== 'object_tree' && panel !== 'data_window')) {
    // A panel of its own button, or the panel of the object tree to collapse.
    await clickElement(page, selector);
    await waitFor(page, (controls) => controls.buttons[owner].pressed === open, failure);
    return true;
  }

  // The object tree or the data window to show: the panel first, then the tab, which the panel may
  // remember from before.
  let controls = before;
  let opened = false;
  if (controls.buttons.object_tree.pressed !== true) {
    await clickElement(page, selector);
    opened = true;
    const { satisfied, last } = await pollUntil(
      () => readControls(page),
      ({ buttons, tabs }) =>
        buttons.object_tree.pressed === true && (tabs.object_tree.shown || tabs.data_window.shown),
      { intervalMs: POLL_INTERVAL_MS, timeoutMs: waitMs },
    );
    // A panel that opened without showing its tabs is a build without them.
    if (!satisfied && last.buttons.object_tree.pressed !== true) {
      throw panelTimeout(failure);
    }
    controls = last;
  }
  if (isOpen(panel, controls)) {
    return true;
  }
  if (!controls.tabs[panel].shown) {
    let collapsed = !opened;
    if (opened) {
      // The panel was opened only to look for the tab: it goes as it came.
      try {
        await clickElement(page, selector);
        await waitFor(page, ({ buttons }) => buttons.object_tree.pressed === false, {
          ...failure,
          open: false,
        });
        collapsed = true;
      } catch {
        collapsed = false;
      }
    }
    throw new TvMcpError(
      'CAPABILITY_UNAVAILABLE',
      `The panel of the object tree has no tab for the ${LABELS[panel]}${
        opened
          ? collapsed
            ? ', so it was collapsed again'
            : ', and it could not be collapsed again'
          : ''
      }`,
      {
        hint: 'This build of TradingView may show it otherwise. Open it in TradingView yourself.',
        details: { panel, selector: PANEL_CONTROLS.tabs[panel] },
      },
    );
  }
  await clickElement(page, PANEL_CONTROLS.tabs[panel]);
  await waitFor(page, (now) => isOpen(panel, now), failure);
  return true;
}

// Opens or closes the Pine Editor, and answers whether it did anything. Opening is what the Pine
// tools do (ensureEditorOpen), the way the button of TradingView opens it. Closing goes through the
// close path of the Pine tools (closePineEditor), which never discards the text: TradingView keeps
// unsaved text and shows it again on the next open. The side panel leaves the registry of open
// editors when it closes, which is waited for; the editor at the bottom only hides, and stays in it.
async function setPineEditor(page: PageHandle, open: boolean, waitMs: number): Promise<boolean> {
  if (open) {
    if ((await readEditorState(page)).open) {
      return false;
    }
    await ensureEditorOpen(page, waitMs);
    return true;
  }
  const { closed, placement } = await page.bridge.evaluateWithLib(closePineEditor, []);
  if (!closed) {
    return false;
  }
  if (placement === 'dialog') {
    const { satisfied } = await pollUntil(
      () => readEditorState(page),
      (state) => !state.open,
      { intervalMs: POLL_INTERVAL_MS, timeoutMs: Math.min(PANEL_WAIT_MS, waitMs) },
    );
    if (!satisfied) {
      throw new TvMcpError('TIMEOUT', 'The Pine Editor did not close', {
        hint: 'Check app_get_ui_state, and close the Pine Editor in TradingView itself.',
        details: { panel: 'pine_editor', open: false },
      });
    }
  }
  return true;
}

export const uiOpenPanel = defineTool({
  name: 'ui_open_panel',
  domain: 'ui',
  title: 'Open or close a panel',
  description:
    'Opens or closes a panel of TradingView (open, true by default): watchlist (the watchlist, ' +
    'the details of a symbol and the news), alerts, object_tree, data_window (a tab of the panel ' +
    'of the object tree) and pine_editor. The first four go through the buttons of the right ' +
    'toolbar, clicked as ui_click clicks (a menu or a dialog over the toolbar refuses the click), ' +
    'and the panel is read afterwards until it shows as asked: opening the data window opens the ' +
    'panel of the object tree and selects its tab, and closing either collapses that panel. ' +
    'pine_editor opens the Pine Editor the way its button in TradingView does, showing the script ' +
    'it last held or a new one, and any unsaved text TradingView kept, and closes it without ' +
    'discarding its text: TradingView keeps unsaved text and shows it again on the next open. A ' +
    'panel that already is as asked is left alone, which changed false says. app_get_ui_state ' +
    'reports the panels the same way. CAPABILITY_UNAVAILABLE when the toolbar has no button for ' +
    'the panel or its button does not say whether it is pressed, when the panel of the object ' +
    'tree has no tab for the data window (the panel is collapsed again if it was opened to look), ' +
    'or when the Pine Editor has no way to close here; NOT_AVAILABLE while the toolbar is hidden, ' +
    'as in fullscreen mode; TIMEOUT when the panel does not change after the click. Returns ' +
    'panel, open and changed.',
  inputSchema: {
    panel: z
      .enum(PANELS)
      .describe(
        'The panel: watchlist, alerts, object_tree, data_window or pine_editor (the Pine Editor).',
      ),
    open: z
      .boolean()
      .default(true)
      .describe('true (default) to open the panel, false to close it.'),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler({ panel, open }, ctx: ToolContext) {
    const page = await ctx.connection.chartPage();
    const waitMs = pageWaitMs(ctx.config.callTimeoutMs);
    let changed: boolean;
    let via: Tier;
    if (panel === 'pine_editor') {
      changed = await setPineEditor(page, open, waitMs);
      via = 'internal';
    } else {
      changed = await setToolbarPanel(page, panel, open, Math.min(PANEL_WAIT_MS, waitMs));
      // A panel that already was as asked was only read.
      via = changed ? 'cdp' : 'dom';
    }
    return { data: { panel, open, changed }, via };
  },
});

export const uiFullscreen = defineTool({
  name: 'ui_fullscreen',
  domain: 'ui',
  title: 'Turn fullscreen on or off',
  description:
    "Turns TradingView's own fullscreen mode on (enabled: true) or off, the mode of its " +
    'fullscreen button: the chart fills the tab and the toolbars and panels hide, while the ' +
    'window itself stays as it is; Escape on the chart leaves the mode too. A mode that already ' +
    'is the one asked for is left alone (changed false). Returns requested, observed (the mode ' +
    'TradingView reports afterwards; null, with a warning, when the page cannot say) and ' +
    'changed. CAPABILITY_UNAVAILABLE on a page without the calls of TradingView for it, ' +
    'NOT_AVAILABLE when TradingView refuses.',
  inputSchema: {
    enabled: z.boolean().describe('true to turn the fullscreen mode on, false to turn it off.'),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler({ enabled }, ctx) {
    const page = await ctx.connection.chartPage();
    const { changed } = await page.bridge.evaluate(setFullscreen, [enabled]);
    // A mode that already was the one asked for was read as that one.
    let observed: boolean | null = enabled;
    const warnings: string[] = [];
    if (changed) {
      ({ last: observed } = await pollUntil(
        async () => (await page.bridge.evaluate(readFullscreen, [])).on,
        (on) => on === null || on === enabled,
        { intervalMs: FULLSCREEN_POLL_MS, timeoutMs: FULLSCREEN_WAIT_MS },
      ));
      if (observed === null) {
        warnings.push(
          'TradingView did not say whether its fullscreen mode is on, so observed is null. Look ' +
            'at the chart, with screenshot_capture for one, to see what it shows.',
        );
      } else if (observed !== enabled) {
        warnings.push(
          `TradingView still reports its fullscreen mode ${observed ? 'on' : 'off'} ` +
            `${String(FULLSCREEN_WAIT_MS)} ms after it was asked to turn it ${enabled ? 'on' : 'off'}.`,
        );
      }
    }
    return { data: { requested: enabled, observed, changed }, via: 'api', warnings };
  },
});
