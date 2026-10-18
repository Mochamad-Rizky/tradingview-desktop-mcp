// The selectors for the parts of TradingView Desktop's interface that this server drives, from the
// reverse-engineering notes (section 5). They prefer an id, then data-qa-id, data-name,
// data-test-id-* and aria-label, because the class names of the web app are hashed (such as
// iconButton-3Lt7-uhL) and change with every build. The only classes left are the plain ones the
// notes record for the window chrome.
//
// They are plain strings for document.querySelector, kept in one place so that a web build that
// renames an attribute breaks one line here instead of every caller.
export const SELECTORS = {
  // The ids of the header toolbar (notes, section 5.1).
  header: {
    symbolSearch: '#header-toolbar-symbol-search',
    compare: '#header-toolbar-compare',
    intervals: '#header-toolbar-intervals',
    chartStyles: '#header-toolbar-chart-styles',
    indicators: '#header-toolbar-indicators',
    studyTemplates: '#header-toolbar-study-templates',
    alerts: '#header-toolbar-alerts',
    replay: '#header-toolbar-replay',
    undoRedo: '#header-toolbar-undo-redo',
    layouts: '#header-toolbar-layouts',
    saveLoad: '#header-toolbar-save-load',
    quickSearch: '#header-toolbar-quick-search',
    properties: '#header-toolbar-properties',
    fullscreen: '#header-toolbar-fullscreen',
    screenshot: '#header-toolbar-screenshot',
  },

  // The regions of the page (notes, section 5.2).
  regions: {
    drawingToolbar: '#drawing-toolbar',
    bottomArea: '#bottom-area',
    footerChartPanel: '#footer-chart-panel',
    // Dialogs and menus open in this portal, not where they were asked for.
    overlapManagerRoot: '#overlap-manager-root',
    tooltipRoot: '#tooltip-root-element',
    snackbarContainer: '#snackbar-container',
    chartContainer: '[data-qa-id="chart-container"]',
    pane: '[data-qa-id="pane"]',
    paneCanvas: 'canvas[data-name="pane-canvas"]',
  },

  // The buttons found by data-name (notes, section 5.3). The right toolbar and the widget bar of
  // the same table are under widgets.
  buttons: {
    indicatorsDialog: '[data-name="open-indicators-dialog"]',
    pineEditor: '[data-name="pine-dialog-button"]',
    alerts: '[data-name="alerts"]',
    objectTree: '[data-name="object_tree"]',
    goToDate: '[data-name="go-to-date"]',
    // The presets under the chart, keyed by the label on the button.
    dateRange: {
      '1D': '[data-name="date-range-tab-1D"]',
      '5D': '[data-name="date-range-tab-5D"]',
      '1M': '[data-name="date-range-tab-1M"]',
      '3M': '[data-name="date-range-tab-3M"]',
      '6M': '[data-name="date-range-tab-6M"]',
      YTD: '[data-name="date-range-tab-YTD"]',
      '12M': '[data-name="date-range-tab-12M"]',
      '60M': '[data-name="date-range-tab-60M"]',
      ALL: '[data-name="date-range-tab-ALL"]',
    },
    // The groups of drawing tools in the drawing toolbar.
    lineToolGroups: {
      trendLine: '[data-name="linetool-group-trend-line"]',
      gannAndFibonacci: '[data-name="linetool-group-gann-and-fibonacci"]',
      geometricShapes: '[data-name="linetool-group-geometric-shapes"]',
      annotation: '[data-name="linetool-group-annotation"]',
      patterns: '[data-name="linetool-group-patterns"]',
      predictionAndMeasurement: '[data-name="linetool-group-prediction-and-measurement"]',
      cursors: '[data-name="linetool-group-cursors"]',
      fontIcons: '[data-name="linetool-group-font-icons"]',
    },
    removeAllDrawingTools: '[data-name="removeAllDrawingTools"]',
    hideAll: '[data-name="hide-all"]',
    lockAll: '[data-name="lock-all"]',
    magnet: '[data-name="magnet-button"]',
    toggleMaximize: '[data-name="toggle-maximize-button"]',
    toggleVisibility: '[data-name="toggle-visibility-button"]',
  },

  // The legend over the chart (notes, section 5.4).
  legend: {
    root: '[data-qa-id="legend"]',
    seriesItem: '[data-qa-id="legend-series-item"]',
    // Carries data-entity-id, the id of the study.
    sourceItem: '[data-qa-id="legend-source-item"]',
    sourceTitle: '[data-qa-id="legend-source-title"]',
    showHideAction: '[data-qa-id="legend-show-hide-action"]',
    deleteAction: '[data-qa-id="legend-delete-action"]',
    settingsAction: '[data-qa-id="legend-settings-action"]',
    moreAction: '[data-qa-id="legend-more-action"]',
    // The values of the legend: O, H, L, C, Vol and the titles of plots.
    valueTitle: '[data-test-id-value-title]',
  },

  // The buttons under the chart that zoom and scroll it (notes, section 5.4).
  controlBar: {
    zoomIn: '[data-qa-id="control-bar-zoom-in-button"]',
    zoomOut: '[data-qa-id="control-bar-zoom-out-button"]',
    scrollLeft: '[data-qa-id="control-bar-scroll-left-button"]',
    scrollRight: '[data-qa-id="control-bar-scroll-right-button"]',
    resetScale: '[data-qa-id="control-bar-reset-scale-button"]',
    backToRealtime: '[data-qa-id="control-bar-back-to-realtime-button"]',
  },

  // The buttons on the panes of a multi-pane chart (notes, section 5.4).
  panes: {
    close: '[data-qa-id="pane-button-close"]',
    collapse: '[data-qa-id="pane-button-collapse"]',
    up: '[data-qa-id="pane-button-up"]',
    down: '[data-qa-id="pane-button-down"]',
    maximize: '[data-qa-id="pane-button-maximize"]',
    restore: '[data-qa-id="pane-button-restore"]',
  },

  // The right toolbar, the widget bar and the widgets in it (notes, sections 5.3 and 5.4).
  widgets: {
    rightToolbar: '[data-name="right-toolbar"]',
    widgetBar: '[data-name="widgetbar-wrap"]',
    widgetBarTabs: '[data-name="widgetbar-pages-with-tabs"]',
    watchlist: '[data-test-id-widget-type="watchlist"]',
    detail: '[data-test-id-widget-type="detail"]',
    alerts: '[data-test-id-widget-type="alerts"]',
    objectTree: '[data-test-id-widget-type="object_tree"]',
    pineLogs: '[data-test-id-widget-type="pine_logs"]',
  },

  // The tabs and buttons of the window around the charts (notes, section 5.6). This is another
  // renderer than the chart: the selectors apply to the window chrome target.
  windowChrome: {
    tab: 'div.tab[draggable="true"][id]',
    activeTab: 'div.tab.active',
    newTab: 'button.create-new-tab-button',
    newWindow: '#new-window-button',
    mainMenu: '#main-menu-button',
  },
} as const;

// What no tool of this server may click (notes, section 5.5): the buy and sell buttons of the
// chart and the trade button of the header toolbar. This server has no trading tools, so a click on
// one of them, on anything that holds one, on anything inside one, or on anything one lies over
// at the point of the click, is refused. Keys and text are refused while the focus is on one of
// them or inside one, but not for what the focused element merely holds, such as the chart pane.
// Text is also typed only into a focused text field.
//
// The notes add "anything inside a broker order ticket", but a ticket has no stable selector yet.
// Until one is recorded from a live broker session, a ticket is covered only through the buttons
// in it that match one of these. That is a gap: a control of a ticket that carries none of them
// is not refused.
//
// Frozen so that no caller can shorten the list the guard works from.
export const UNSAFE_SELECTORS: readonly string[] = Object.freeze([
  '[data-name="buy-order-button"]',
  '[data-name="sell-order-button"]',
  '[data-name="buy-sell-buttons"]',
  '[data-qa-id="trade-button"]',
  '#header-toolbar-trade-desktop',
]);
