import type { TvWindow } from '../../src/core/tv/tv-window.js';
import type { JsonValue } from '../../src/utils/json.js';
import { pollUntil } from '../../src/utils/poll.js';
import { callTool } from '../helpers/mcp-client.js';
import {
  callFailure,
  callOk,
  describeFailure,
  e2eEnabled,
  evalAllowed,
  HarnessError,
  observe,
  readChartState,
  readChartVisibility,
  sameJson,
  startE2eServer,
  type E2eServer,
} from './setup.js';

// The low-level interface tools against the real TradingView Desktop. The suite looks elements up,
// hovers a button of the header, opens the symbol search with a click, types into its field and
// closes it with Escape (never Enter, so the chart keeps its symbol), and opens and closes the
// watchlist panel, leaving every panel as it found it. It never clicks the chart or a trading
// control. ui_evaluate runs one expression that reads, only when the run sets TV_MCP_ALLOW_EVAL=true,
// and its value is never printed. Names and texts of elements can show the user's symbols and
// prices: the suite prints counts and kinds only.

interface Found {
  selector: string | null;
  tag: string;
  role: string | null;
  name: string;
  text: string;
  rect: { x: number; y: number; width: number; height: number };
  visible: boolean;
  unsafe: boolean;
  holdsUnsafe: boolean;
}

interface UiState {
  rightPanel: { open: boolean; activeWidget: string | null };
  panels: Record<'watchlist' | 'alerts' | 'object_tree' | 'data_window' | 'pine_editor', boolean>;
  bottomPanelOpen: boolean;
  dialogs: string[];
  fullscreen: boolean;
  replayToolbarVisible: boolean;
  pineEditorOpen: boolean;
}

const SYMBOL_SEARCH = '#header-toolbar-symbol-search';
const TRADING_CONTROLS =
  '[data-name="buy-order-button"], [data-name="sell-order-button"], ' +
  '[data-name="buy-sell-buttons"], [data-qa-id="trade-button"], #header-toolbar-trade-desktop';

// What has the focus, by its kind only: its tag, the type of an input, whether it takes text,
// whether it lies in the overlap root (dialogs, menus) or in the chart, and how long the text in a
// field is, never the text itself. It only reads.
function readFocus(win: TvWindow): {
  tag: string;
  type: string | null;
  editable: boolean;
  inOverlap: boolean;
  inChart: boolean;
  valueLength: number | null;
} {
  const active = win.document.activeElement as HTMLElement | null;
  if (active === null) {
    return {
      tag: 'none',
      type: null,
      editable: false,
      inOverlap: false,
      inChart: false,
      valueLength: null,
    };
  }
  const field = active as HTMLInputElement;
  const takesText =
    active.tagName === 'TEXTAREA' ||
    (active.tagName === 'INPUT' && typeof field.value === 'string');
  return {
    tag: active.tagName.toLowerCase(),
    type: active.tagName === 'INPUT' ? field.type : null,
    editable: active.isContentEditable || takesText,
    inOverlap: active.closest('#overlap-manager-root') !== null,
    inChart: active.closest('[data-qa-id="chart-container"]') !== null,
    valueLength: takesText ? field.value.length : null,
  };
}

// What the right panel remembers while it is collapsed: whether it is minimized and which page it
// would show, from the widget bar of the app. It only reads.
function readWidgetbarMemory(win: TvWindow): {
  minimized: JsonValue;
  activeIndex: JsonValue;
  activeName: string | null;
} | null {
  try {
    const layout = (win as unknown as { widgetbar?: { layout?: Record<string, unknown> } })
      .widgetbar?.layout;
    const valueOf = (item: unknown): JsonValue => {
      const value: unknown =
        typeof (item as { value?: unknown } | null)?.value === 'function'
          ? (item as { value(): unknown }).value()
          : item;
      return typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string'
        ? value
        : null;
    };
    return layout === undefined
      ? null
      : {
          minimized: valueOf(layout.minimized),
          activeIndex: valueOf(layout.activeIndex),
          activeName: typeof layout.activeName === 'string' ? layout.activeName : null,
        };
  } catch {
    return null;
  }
}

// How the buttons of the page are named, by count only: by an aria-label, only by a title, by
// aria-labelledby, or by nothing at all (no label and no text), which the name rule of the input
// helpers reads as no name. It only reads.
function readNamingStats(win: TvWindow): Record<string, number> {
  const doc = win.document as unknown as Document;
  const buttons = Array.from(doc.querySelectorAll<HTMLElement>('button, [role="button"]'));
  const shown = buttons.filter((button) => {
    const rect = button.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  const textOf = (button: HTMLElement): string => button.textContent.trim();
  return {
    buttons: shown.length,
    ariaLabel: shown.filter((button) => button.hasAttribute('aria-label')).length,
    titleOnly: shown.filter(
      (button) =>
        button.hasAttribute('title') && !button.hasAttribute('aria-label') && textOf(button) === '',
    ).length,
    labelledBy: shown.filter((button) => button.hasAttribute('aria-labelledby')).length,
    unnamed: shown.filter(
      (button) =>
        !button.hasAttribute('aria-label') &&
        !button.hasAttribute('title') &&
        !button.hasAttribute('aria-labelledby') &&
        textOf(button) === '',
    ).length,
  };
}

describe.skipIf(!e2eEnabled())('the low-level interface tools against TradingView Desktop', () => {
  let e2e: E2eServer | undefined;

  beforeAll(async () => {
    e2e = await startE2eServer({ allowEval: true });
  });

  afterAll(async () => {
    await e2e?.close();
  });

  function server(): E2eServer {
    if (e2e === undefined) {
      throw new Error('The server did not start');
    }
    return e2e;
  }

  async function uiState(): Promise<UiState> {
    return (await callOk<UiState>(server().client, 'app_get_ui_state')).data;
  }

  async function focus() {
    const page = await server().ctx.connection.chartPage();
    return page.bridge.evaluate(readFocus, []);
  }

  async function find(args: Record<string, unknown>): Promise<Found[]> {
    return (await callOk<{ elements: Found[] }>(server().client, 'ui_find_element', args)).data
      .elements;
  }

  test('finds elements by selector and by name, and marks trading controls unsafe', async () => {
    const { ctx } = server();
    const [search, ...others] = await find({ selector: SYMBOL_SEARCH });
    expect(others).toEqual([]);
    expect(search?.selector).toBe(SYMBOL_SEARCH);
    expect(search?.visible).toBe(true);
    expect(search?.unsafe).toBe(false);
    expect(search?.tag).toBe('button');

    const trading = await find({ selector: TRADING_CONTROLS, limit: 50 });
    expect(trading.every(({ unsafe }) => unsafe)).toBe(true);
    const [body] = await find({ selector: 'body' });
    const toolbar = await find({
      selector: '[data-name="right-toolbar"] [aria-pressed]',
      limit: 50,
    });

    const counts: Record<string, number> = {};
    for (const name of ['base', 'alerts', 'object_tree', 'pine-dialog-button']) {
      counts[name] = (await find({ selector: `[data-name="${name}"]`, limit: 50 })).length;
    }
    const startedAt = performance.now();
    const named = await find({ text: 'Alerts', limit: 50 });
    const textLookupMs = Math.round(performance.now() - startedAt);
    const page = await ctx.connection.chartPage();
    observe('elements of the chart page', {
      tradingControlsShown: trading.length,
      bodyHoldsUnsafe: body?.holdsUnsafe ?? null,
      bodyUnsafe: body?.unsafe ?? null,
      rightToolbarPressable: toolbar.length,
      buttonsByDataName: counts,
      namedAlerts: named.length,
      namedAlertsWithSelector: named.filter(({ selector }) => selector !== null).length,
      textLookupMs,
      naming: await page.bridge.evaluate(readNamingStats, []),
      chartVisibility: await readChartVisibility(ctx),
    });
    expect(Object.values(counts).every((count) => count === 1)).toBe(true);
  });

  test('hovers a button of the header', async () => {
    const { client } = server();
    const before = await uiState();
    const hovered = await callOk<{ by: string; point: { x: number; y: number } }>(
      client,
      'ui_hover',
      { selector: SYMBOL_SEARCH },
    );
    expect(hovered.data.by).toBe('selector');
    const [search] = await find({ selector: SYMBOL_SEARCH });
    const rect = search?.rect;
    expect(
      rect !== undefined &&
        hovered.data.point.x >= rect.x &&
        hovered.data.point.x <= rect.x + rect.width &&
        hovered.data.point.y >= rect.y &&
        hovered.data.point.y <= rect.y + rect.height,
      'the pointer is on the button',
    ).toBe(true);
    const after = await uiState();
    expect(sameJson(after.dialogs, before.dialogs), 'a hover opens no dialog').toBe(true);
    observe('a hover over the symbol search button', { warnings: hovered.warnings });
  });

  test('opens the symbol search, types into it and closes it with Escape', async (context) => {
    const { client } = server();
    const before = await uiState();
    if (before.dialogs.length > 0) {
      return context.skip(
        'A dialog or menu of TradingView is open, which the test would take for the symbol search',
      );
    }
    const chart = await readChartState(client);
    const facts: Record<string, JsonValue> = {};
    let failure: unknown;
    let failed = false;
    try {
      await callOk(client, 'ui_click', { selector: SYMBOL_SEARCH });
      const opened = await pollUntil(uiState, (state) => state.dialogs.length > 0, {
        intervalMs: 100,
        timeoutMs: 3000,
      });
      expect(opened.satisfied, 'the symbol search opened').toBe(true);
      facts.dialogs = opened.last.dialogs;
      facts.openedWithinMs = opened.waitedMs;
      const atOpen = await focus();
      facts.focusAtOpen = atOpen;
      expect(atOpen.editable && atOpen.inOverlap, 'the search field has the focus').toBe(true);
      const typed = await callOk<{ characters: number }>(client, 'ui_type_text', { text: 'AAPL' });
      expect(typed.data.characters).toBe(4);
      const afterTyping = await focus();
      facts.valueLengthGrewBy =
        afterTyping.valueLength === null || atOpen.valueLength === null
          ? null
          : afterTyping.valueLength - atOpen.valueLength;
      let escapes = 0;
      let closed = false;
      while (!closed && escapes < 2) {
        await callOk(client, 'ui_press_key', { key: 'Escape' });
        escapes += 1;
        closed = (
          await pollUntil(uiState, (state) => state.dialogs.length === 0, {
            intervalMs: 100,
            timeoutMs: 2000,
          })
        ).satisfied;
      }
      facts.escapesToClose = closed ? escapes : null;
      expect(closed, 'Escape closed the symbol search').toBe(true);
      const afterClose = await focus();
      facts.focusAfterClose = afterClose;
      // A key on whatever has the focus now: the chart, or the page, when the dialog gave it back.
      if (!afterClose.editable) {
        const key = await callTool(client, 'ui_press_key', { key: 'Escape' });
        const envelope = key.structuredContent as { error?: { code?: string } };
        facts.escapeAfterClose =
          key.isError === true ? (envelope.error?.code ?? 'UNKNOWN') : 'sent';
      }
    } catch (error) {
      failure = error;
      failed = true;
    }
    // However the test ended: the chart keeps its symbol and timeframe, and no dialog is left open.
    const problems: string[] = [];
    try {
      let state = await uiState();
      if (state.dialogs.length > 0) {
        await callOk(client, 'ui_press_key', { key: 'Escape' });
        state = (
          await pollUntil(uiState, (now) => now.dialogs.length === 0, {
            intervalMs: 100,
            timeoutMs: 2000,
          })
        ).last;
      }
      if (state.dialogs.length > 0) {
        problems.push('A dialog is still open after the test: close it in TradingView');
      }
      const after = await readChartState(client);
      if (after.symbol !== chart.symbol || after.resolution !== chart.resolution) {
        problems.push('The chart shows another symbol or timeframe after the test');
      }
    } catch (error) {
      problems.push(describeFailure(error));
    }
    observe('the symbol search', facts);
    if (failed) {
      if (problems.length > 0) {
        console.error(`The symbol search test left something behind: ${problems.join('; ')}`);
      }
      throw failure;
    }
    if (problems.length > 0) {
      throw new HarnessError(
        `The symbol search test left something behind: ${problems.join('; ')}`,
      );
    }
  });

  test('opens and closes the watchlist panel, leaving the panels as they were', async () => {
    const { client, ctx } = server();
    const page = await ctx.connection.chartPage();
    const before = await uiState();
    const memoryBefore = await page.bridge.evaluate(readWidgetbarMemory, []);
    const wasOpen = before.panels.watchlist;
    // The panel open before, which showing the watchlist replaces, to show again afterwards.
    const other = (['alerts', 'object_tree', 'data_window'] as const).find(
      (panel) => before.panels[panel],
    );
    let failure: unknown;
    let failed = false;
    try {
      const first = await callOk<{ open: boolean; changed: boolean }>(client, 'ui_open_panel', {
        panel: 'watchlist',
        open: !wasOpen,
      });
      expect(first.data.changed).toBe(true);
      expect((await uiState()).panels.watchlist).toBe(!wasOpen);
      const second = await callOk<{ open: boolean; changed: boolean }>(client, 'ui_open_panel', {
        panel: 'watchlist',
        open: wasOpen,
      });
      expect(second.data.changed).toBe(true);
      expect((await uiState()).panels.watchlist).toBe(wasOpen);
      const again = await callOk<{ changed: boolean }>(client, 'ui_open_panel', {
        panel: 'watchlist',
        open: wasOpen,
      });
      expect(again.data.changed, 'a panel as asked is left alone').toBe(false);
    } catch (error) {
      failure = error;
      failed = true;
    }
    const problems: string[] = [];
    try {
      if (other !== undefined && !(await uiState()).panels[other]) {
        await callOk(client, 'ui_open_panel', { panel: other, open: true });
      }
      const after = await uiState();
      if (
        !sameJson(after.panels, before.panels) ||
        !sameJson(after.rightPanel, before.rightPanel)
      ) {
        problems.push('The panels are not as they were before the test');
      }
    } catch (error) {
      problems.push(describeFailure(error));
    }
    const memoryAfter = await page.bridge.evaluate(readWidgetbarMemory, []);
    observe('the watchlist panel', {
      wasOpen,
      otherPanelOpen: other ?? null,
      rememberedPageKept: sameJson(memoryAfter, memoryBefore),
      memoryBefore,
      memoryAfter,
    });
    if (failed) {
      if (problems.length > 0) {
        console.error(`The panel test left something behind: ${problems.join('; ')}`);
      }
      throw failure;
    }
    if (problems.length > 0) {
      throw new HarnessError(`The panel test left something behind: ${problems.join('; ')}`);
    }
  });

  test('ui_evaluate runs one expression that reads, when the run allows it', async (context) => {
    if (!evalAllowed()) {
      return context.skip('ui_evaluate is off unless the run sets TV_MCP_ALLOW_EVAL=true');
    }
    const { client } = server();
    const startedAt = performance.now();
    const { data, warnings } = await callOk<{ value: unknown; truncated: boolean }>(
      client,
      'ui_evaluate',
      { expression: 'document.title.length' },
    );
    const ms = Math.round(performance.now() - startedAt);
    expect(typeof data.value).toBe('number');
    expect(data.truncated).toBe(false);
    expect(warnings.length === 0, 'ui_evaluate gives no warning').toBe(true);
    // Refused before anything is sent.
    const denied = await callFailure(client, 'ui_evaluate', { expression: 'window.user' });
    expect(denied.code).toBe('UNSAFE_ACTION_BLOCKED');
    observe('ui_evaluate in the chart page', { valueType: typeof data.value, ms });
  });

  test('ui_evaluate is off without TV_MCP_ALLOW_EVAL', async () => {
    const plain = await startE2eServer();
    try {
      const off = await callFailure(plain.client, 'ui_evaluate', {
        expression: 'document.title.length',
      });
      expect(off.code).toBe('CAPABILITY_UNAVAILABLE');
    } finally {
      await plain.close();
    }
  });
});
