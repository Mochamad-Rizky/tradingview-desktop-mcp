import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SELECTORS,
  TRADING_ACTION_NAMES,
  UNSAFE_SELECTORS,
} from '../../../../src/core/tv/selectors.js';

// The expectations below are copied by hand from the reverse-engineering notes (section 5), so a
// typo in the selectors under test does not also sit in the assertion that should catch it.

const NOTES_URL = new URL('../../../../../../docs/reverse-engineering.md', import.meta.url);

function camelCase(name: string): string {
  return name.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

const qa = (id: string): string => `[data-qa-id="${id}"]`;
const named = (name: string): string => `[data-name="${name}"]`;
const widget = (type: string): string => `[data-test-id-widget-type="${type}"]`;

// Every selector string under a group, whatever its depth.
function selectorsIn(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap(selectorsIn);
  }
  return [];
}

const ALL = selectorsIn(SELECTORS);

// A class name written by hand: lower-case words joined by hyphens. A hashed one, such as
// iconButton-3Lt7-uhL, has capitals and digits.
const PLAIN_CLASS = /^[a-z]+(-[a-z]+)*$/;

describe('SELECTORS', () => {
  test('groups the selectors by purpose', () => {
    expect(Object.keys(SELECTORS)).toEqual([
      'header',
      'regions',
      'buttons',
      'legend',
      'controlBar',
      'panes',
      'widgets',
      'windowChrome',
    ]);
  });

  test('keeps the key of the example in the plan', () => {
    expect(SELECTORS.header.symbolSearch).toBe('#header-toolbar-symbol-search');
    expectTypeOf(SELECTORS.header.symbolSearch).toEqualTypeOf<'#header-toolbar-symbol-search'>();
  });

  test('names the header toolbar ids of the notes, under their camel-cased names', () => {
    const ids = [
      'symbol-search',
      'compare',
      'intervals',
      'chart-styles',
      'indicators',
      'study-templates',
      'alerts',
      'replay',
      'undo-redo',
      'layouts',
      'save-load',
      'quick-search',
      'properties',
      'fullscreen',
      'screenshot',
    ];

    expect(SELECTORS.header).toEqual(
      Object.fromEntries(ids.map((id) => [camelCase(id), `#header-toolbar-${id}`])),
    );
  });

  test('names the page regions of the notes', () => {
    expect(SELECTORS.regions).toEqual({
      drawingToolbar: '#drawing-toolbar',
      bottomArea: '#bottom-area',
      footerChartPanel: '#footer-chart-panel',
      overlapManagerRoot: '#overlap-manager-root',
      tooltipRoot: '#tooltip-root-element',
      snackbarContainer: '#snackbar-container',
      chartContainer: qa('chart-container'),
      pane: qa('pane'),
      paneCanvas: 'canvas[data-name="pane-canvas"]',
    });
  });

  test('names the data-name buttons of the notes, and nests the two groups of them', () => {
    const entries = Object.entries(SELECTORS.buttons);

    expect(Object.fromEntries(entries.filter(([, value]) => typeof value === 'string'))).toEqual({
      indicatorsDialog: named('open-indicators-dialog'),
      pineEditor: named('pine-dialog-button'),
      alerts: named('alerts'),
      objectTree: named('object_tree'),
      goToDate: named('go-to-date'),
      removeAllDrawingTools: named('removeAllDrawingTools'),
      hideAll: named('hide-all'),
      lockAll: named('lock-all'),
      magnet: named('magnet-button'),
      toggleMaximize: named('toggle-maximize-button'),
      toggleVisibility: named('toggle-visibility-button'),
    });
    expect(entries.filter(([, value]) => typeof value !== 'string').map(([key]) => key)).toEqual([
      'dateRange',
      'lineToolGroups',
    ]);
  });

  test('has a selector for every date range preset, keyed by the preset', () => {
    const presets = ['1D', '5D', '1M', '3M', '6M', 'YTD', '12M', '60M', 'ALL'];

    expect(SELECTORS.buttons.dateRange).toEqual(
      Object.fromEntries(presets.map((preset) => [preset, named(`date-range-tab-${preset}`)])),
    );
  });

  test('has a selector for every group of the drawing toolbar', () => {
    const groups = [
      'trend-line',
      'gann-and-fibonacci',
      'geometric-shapes',
      'annotation',
      'patterns',
      'prediction-and-measurement',
      'cursors',
      'font-icons',
    ];

    expect(SELECTORS.buttons.lineToolGroups).toEqual(
      Object.fromEntries(
        groups.map((group) => [camelCase(group), named(`linetool-group-${group}`)]),
      ),
    );
  });

  test('names the legend items, actions and values of the notes', () => {
    expect(SELECTORS.legend).toEqual({
      root: qa('legend'),
      seriesItem: qa('legend-series-item'),
      sourceItem: qa('legend-source-item'),
      sourceTitle: qa('legend-source-title'),
      showHideAction: qa('legend-show-hide-action'),
      deleteAction: qa('legend-delete-action'),
      settingsAction: qa('legend-settings-action'),
      moreAction: qa('legend-more-action'),
      valueTitle: '[data-test-id-value-title]',
    });
  });

  test('names the control bar buttons of the notes', () => {
    expect(SELECTORS.controlBar).toEqual({
      zoomIn: qa('control-bar-zoom-in-button'),
      zoomOut: qa('control-bar-zoom-out-button'),
      scrollLeft: qa('control-bar-scroll-left-button'),
      scrollRight: qa('control-bar-scroll-right-button'),
      resetScale: qa('control-bar-reset-scale-button'),
      backToRealtime: qa('control-bar-back-to-realtime-button'),
    });
  });

  test('names the pane buttons of the notes', () => {
    expect(SELECTORS.panes).toEqual({
      close: qa('pane-button-close'),
      collapse: qa('pane-button-collapse'),
      up: qa('pane-button-up'),
      down: qa('pane-button-down'),
      maximize: qa('pane-button-maximize'),
      restore: qa('pane-button-restore'),
    });
  });

  test('names the right toolbar, the widget bar and the widgets of the notes', () => {
    expect(SELECTORS.widgets).toEqual({
      rightToolbar: named('right-toolbar'),
      widgetBar: named('widgetbar-wrap'),
      widgetBarTabs: named('widgetbar-pages-with-tabs'),
      watchlist: widget('watchlist'),
      detail: widget('detail'),
      alerts: widget('alerts'),
      objectTree: widget('object_tree'),
      pineLogs: widget('pine_logs'),
    });
  });

  test('names the tabs and buttons of the window chrome', () => {
    expect(SELECTORS.windowChrome).toEqual({
      tab: 'div.tab[draggable="true"][id]',
      activeTab: 'div.tab.active',
      newTab: 'button.create-new-tab-button',
      newWindow: '#new-window-button',
      mainMenu: '#main-menu-button',
    });
  });

  test('holds trimmed, non-empty strings, each one only once', () => {
    expect(ALL.length).toBeGreaterThan(0);
    for (const selector of ALL) {
      expect(selector).toBe(selector.trim());
      expect(selector).not.toBe('');
    }
    expect(new Set(ALL).size).toBe(ALL.length);
  });

  test('uses no hashed class names', () => {
    const classes = ALL.flatMap((selector) =>
      // Attribute values are quoted and may contain dots, so they are blanked before looking.
      [...selector.replace(/"[^"]*"/g, '""').matchAll(/\.([\w-]+)/g)].map(
        (match) => match[1] ?? '',
      ),
    );

    // Not vacuous: the window chrome selects by class.
    expect(classes.length).toBeGreaterThan(0);
    for (const name of classes) {
      expect(name).toMatch(PLAIN_CLASS);
    }
  });

  test('tells a hashed class name from a plain one', () => {
    expect('create-new-tab-button').toMatch(PLAIN_CLASS);
    expect('tab').toMatch(PLAIN_CLASS);
    expect('iconButton-3Lt7-uhL').not.toMatch(PLAIN_CLASS);
    expect('button-1a2b3c').not.toMatch(PLAIN_CLASS);
  });

  test('leaves out everything that UNSAFE_SELECTORS refuses', () => {
    for (const selector of ALL) {
      for (const unsafe of UNSAFE_SELECTORS) {
        expect(selector, `${selector} against ${unsafe}`).not.toContain(unsafe);
      }
    }
  });

  describe('against the notes', () => {
    // Read inside the tests, so a notes file that moved fails these two and not the whole file.
    const readNotes = (): string => readFileSync(fileURLToPath(NOTES_URL), 'utf8');

    // The text between two headings, from the first to just before the second.
    function between(from: string, to: string): string {
      const notes = readNotes();
      const start = notes.indexOf(from);
      const end = notes.indexOf(to, start + from.length);
      if (start === -1 || end === -1) {
        throw new Error(`The notes have no part from "${from}" to "${to}"`);
      }
      return notes.slice(start, end);
    }

    // The selectors a part of the notes writes out in full. Shorthand such as `…-cursors`, `5D`
    // or a bare `legend` is not one, and neither is the alternation of widget types.
    function writtenOut(part: string): string[] {
      return [...part.matchAll(/`([^`]+)`/g)]
        .map((match) => match[1] ?? '')
        .filter((token) => /^(#|\[data-|div\.|button\.|canvas\[)/.test(token))
        .filter((token) => !token.includes('…') && !token.includes(' | '));
    }

    test('has every selector that section 5 writes out in full', () => {
      const section = between('## 5. DOM selectors', '\n## 6.');
      const known = new Set([...ALL, ...UNSAFE_SELECTORS]);

      const found = writtenOut(section);

      // Not vacuous: the section writes out dozens of them.
      expect(found.length).toBeGreaterThan(40);
      expect(found.filter((selector) => !known.has(selector))).toEqual([]);
    });

    test('has exactly the selectors of section 5.5 in UNSAFE_SELECTORS', () => {
      const neverClick = between('### 5.5 Never click', '### 5.6');

      expect(writtenOut(neverClick)).toEqual([...UNSAFE_SELECTORS]);
    });
  });
});

describe('UNSAFE_SELECTORS', () => {
  test('lists the controls the notes say never to click', () => {
    expect([...UNSAFE_SELECTORS]).toEqual([
      '[data-name="buy-order-button"]',
      '[data-name="sell-order-button"]',
      '[data-name="buy-sell-buttons"]',
      '[data-qa-id="trade-button"]',
      '#header-toolbar-trade-desktop',
    ]);
  });

  test('cannot be changed by a caller, which would switch the guard off', () => {
    expectTypeOf(UNSAFE_SELECTORS).toEqualTypeOf<readonly string[]>();
    expect(Object.isFrozen(UNSAFE_SELECTORS)).toBe(true);
    expect(() => {
      (UNSAFE_SELECTORS as string[]).push('body');
    }).toThrow(TypeError);
    expect(() => {
      (UNSAFE_SELECTORS as string[]).length = 0;
    }).toThrow(TypeError);
    expect(UNSAFE_SELECTORS).toHaveLength(5);
  });
});

describe('TRADING_ACTION_NAMES', () => {
  // Matched as the page function matches it: ignoring case.
  const trading = new RegExp(TRADING_ACTION_NAMES, 'i');

  test.each([
    'Buy',
    'buy',
    'BUY 100',
    'Sell',
    'Sell 100',
    'Sell market',
    'Market Buy',
    '1.08571 Sell',
    '▲ Buy',
    'Buy 1 AAPL @ 150 MKT',
    'Buy/sell buttons',
    'Place order',
    'Place an order',
    'Place buy order',
    'Submit order',
    'Send orders',
    'Cancel order',
    'Modify order',
    'Close position',
    'Close position AAPL',
    'Close positions',
    'Close all positions',
    'Close all',
    'Exit position',
    'Reverse',
    'Reverse position',
    'Flatten',
    'Flatten all',
  ])('names a trading action: %j', (name) => {
    expect(trading.test(name)).toBe(true);
  });

  test('takes "How to buy" for a trading action, which is accepted', () => {
    // Buy and sell count as words anywhere in a name, which refuses a few names that trade nothing.
    expect(trading.test('How to buy')).toBe(true);
  });

  test.each([
    'Buyback chart',
    'Sellers',
    'Buyer',
    'Bestsellers',
    'Close',
    'Order panel',
    'Orders',
    'Place',
    'Positions',
    'Alerts',
    'Save all charts',
    '',
  ])('names no trading action: %j', (name) => {
    expect(trading.test(name)).toBe(false);
  });
});
