import type { PageHandle } from '../../src/core/connection.js';
import { classifyTarget } from '../../src/core/cdp/targets.js';
import { probeCapabilities } from '../../src/core/tv/capabilities.js';
import { SELECTORS, UNSAFE_SELECTORS } from '../../src/core/tv/selectors.js';
import type { TvWindow } from '../../src/core/tv/tv-window.js';
import type { JsonObject, JsonValue } from '../../src/utils/json.js';
import { connectToApp, readOptions, runScript } from './session.js';

// Read-only introspection of the running TradingView Desktop (reverse-engineering notes, section
// 14): which globals exist, which members the server relies on are still there, what the chart
// model returns, and what the page's DOM looks like. Run it after a TradingView update and compare
// the summary with the notes.
//
// It only reads. In the chart tab it calls getters whose bodies were checked to have no side
// effects: activeChart, chartsCount, activeChartIndex, layout, isConnected and getIntervals of the
// API; symbol, resolution, chartType, getVisibleRange, getAllStudies, getAllShapes and
// _convertIndexToPublicTime of the chart; mainSeries, bars, symbolInfo and isSymbolInvalid of the
// model; logicalRange, timePointToIndex, indexToTimePoint, barSpacing, rightOffset, baseIndex and
// points of the time scale (logicalRange refreshes a cache the chart refreshes on every frame
// anyway); size, firstIndex, lastIndex and valueAt of the bars; and querySelector, attributes,
// boxes and computed styles in the DOM. It never calls a setter, presses a key or clicks.
//
// It prints no personal data: not the symbol, the layout name or id, drawing text, study names or
// anything of the user object. Values that only describe the app (member names, counts, flags,
// bar indices, the interval list) are printed.

const USAGE = `Usage: pnpm re:probe [--json] [--bodies] [--host 127.0.0.1] [--port 9222]

  --json     print everything as JSON instead of a summary
  --bodies   also print the first characters of the source of each member the server relies on
`;

// The globals of the chart page named in the notes (section 4.1). Only their type is read.
const GLOBALS = [
  'TradingViewApi',
  '_exposed_chartWidgetCollection',
  'TVD',
  'TradingView',
  'widgetbar',
  'getQuoteSessionInstance',
  'studyMarket',
  'TVSettings',
  'TVLocalStorage',
  'webpackChunktradingview',
  'TVScript',
  'is_authenticated',
  'user',
  'BUILD_TIME',
];

// The members each object must have for the server's page functions (src/core/tv/tv-window.ts and
// the chart page functions). A member missing here means a strategy that depends on it is gone.
const CONTRACT: Record<string, string[]> = {
  api: [
    'activeChart',
    'chart',
    'chartsCount',
    'activeChartIndex',
    'setActiveChart',
    'layout',
    'layoutName',
    'layoutId',
    'isConnected',
    'getIntervals',
    'replayApi',
    'pineEditorApi',
  ],
  chart: [
    'symbol',
    'resolution',
    'chartType',
    'getVisibleRange',
    'getAllStudies',
    'getAllShapes',
    'setSymbol',
    'setResolution',
    'setChartType',
    'setVisibleRange',
    '_chartWidget',
    '_convertIndexToPublicTime',
  ],
  model: ['mainSeries', 'model'],
  series: ['bars', 'symbolInfo', 'quotes', 'isSymbolInvalid'],
  timeScale: ['zoomToBarsRange', 'scrollToBar', 'timePointToIndex', 'logicalRange', 'points'],
  bars: ['size', 'firstIndex', 'lastIndex', 'valueAt'],
};

// Which globals exist and what type they are. Values are never read.
export function probeGlobals(
  win: TvWindow,
  names: string[],
): { windowKeys: number; globals: Record<string, string> } {
  const record = win as unknown as Record<string, unknown>;
  const globals: Record<string, string> = {};
  for (const name of names) {
    try {
      const value = record[name];
      globals[name] = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    } catch {
      globals[name] = 'throws';
    }
  }
  return { windowKeys: Object.keys(win).length, globals };
}

// The objects the server's page functions walk through, each with the number of its methods, the
// members of `contract` it lacks, and with `full` every method as name/arity.
export function probeSurface(
  win: TvWindow,
  contract: Record<string, string[]>,
  full: boolean,
): Record<string, { present: boolean; methods: number; missing: string[]; list: string[] }> {
  const member = (owner: unknown, name: string): unknown => {
    try {
      return (typeof owner === 'object' && owner !== null) || typeof owner === 'function'
        ? (owner as Record<string, unknown>)[name]
        : undefined;
    } catch {
      return undefined;
    }
  };
  const call = (owner: unknown, name: string): unknown => {
    const fn = member(owner, name);
    if (typeof fn !== 'function') {
      return undefined;
    }
    try {
      return (fn as () => unknown).call(owner);
    } catch {
      return undefined;
    }
  };
  const api = member(win, 'TradingViewApi');
  const chart = call(api, 'activeChart');
  const model = call(member(chart, '_chartWidget'), 'model');
  const series = call(model, 'mainSeries');
  const objects: Record<string, unknown> = {
    api,
    chart,
    model,
    series,
    timeScale: call(call(model, 'model'), 'timeScale'),
    bars: call(series, 'bars'),
  };
  const methodsOf = (value: unknown): string[] => {
    const names = new Map<string, number>();
    let level: unknown = value;
    while (typeof level === 'object' && level !== null && level !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(level)) {
        if (name === 'constructor' || names.has(name)) {
          continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(level, name);
        if (typeof descriptor?.value === 'function') {
          names.set(name, (descriptor.value as (...args: unknown[]) => unknown).length);
        }
      }
      level = Object.getPrototypeOf(level);
    }
    return [...names].map(([name, arity]) => `${name}/${String(arity)}`).sort();
  };
  const result: Record<
    string,
    { present: boolean; methods: number; missing: string[]; list: string[] }
  > = {};
  for (const [path, value] of Object.entries(objects)) {
    const methods = methodsOf(value);
    result[path] = {
      present: typeof value === 'object' && value !== null,
      methods: methods.length,
      missing: (contract[path] ?? []).filter((name) => member(value, name) === undefined),
      list: full ? methods : [],
    };
  }
  return result;
}

// What the chart model answers, for the questions the notes and the server leave open. Bar indices,
// times of bars and the shapes of answers are reported; the symbol, the layout and study names are
// not.
export function probeChartFacts(win: TvWindow): JsonObject {
  const member = (owner: unknown, name: string): unknown => {
    try {
      return (typeof owner === 'object' && owner !== null) || typeof owner === 'function'
        ? (owner as Record<string, unknown>)[name]
        : undefined;
    } catch {
      return undefined;
    }
  };
  const call = (owner: unknown, name: string, ...args: unknown[]): unknown => {
    const fn = member(owner, name);
    if (typeof fn !== 'function') {
      return undefined;
    }
    try {
      return (fn as (...values: unknown[]) => unknown).apply(owner, args);
    } catch {
      return 'throws';
    }
  };
  const json = (value: unknown): JsonValue => {
    if (value === undefined) {
      return 'undefined';
    }
    try {
      // JSON.stringify answers undefined for a function, which its type does not say.
      const stringify = JSON.stringify as (input: unknown) => string | undefined;
      const text = stringify(value);
      return text === undefined ? null : (JSON.parse(text) as JsonValue);
    } catch {
      return 'unserializable';
    }
  };
  const kind = (value: unknown): string =>
    value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

  const api = member(win, 'TradingViewApi');
  const chart = call(api, 'activeChart');
  const model = call(member(chart, '_chartWidget'), 'model');
  const series = call(model, 'mainSeries');
  const timeScale = call(call(model, 'model'), 'timeScale');
  const bars = call(series, 'bars');
  const first = call(bars, 'firstIndex');
  const last = call(bars, 'lastIndex');
  const timeAt = (index: number): number | null => {
    const row = call(bars, 'valueAt', index);
    return Array.isArray(row) && typeof row[0] === 'number' ? row[0] : null;
  };
  const publicAt = (index: number): unknown => call(chart, '_convertIndexToPublicTime', index);

  const facts: JsonObject = {};
  const flag = call(series, 'isSymbolInvalid');
  facts.isSymbolInvalid = { type: kind(member(series, 'isSymbolInvalid')), returns: kind(flag) };

  const logical = call(timeScale, 'logicalRange');
  facts.logicalRange = {
    returns: kind(logical),
    ownKeys: typeof logical === 'object' && logical !== null ? Object.keys(logical) : [],
    left: json(call(logical, 'left')),
    right: json(call(logical, 'right')),
    from: json(member(logical, 'from')),
    to: json(member(logical, 'to')),
  };

  if (typeof first === 'number' && typeof last === 'number' && last > first) {
    const row = call(bars, 'valueAt', last);
    facts.bars = {
      firstIndex: first,
      lastIndex: last,
      size: json(call(bars, 'size')),
      rowLength: Array.isArray(row) ? row.length : null,
      rowTypes: Array.isArray(row) ? row.map(kind) : [],
      afterLast: json(call(bars, 'valueAt', last + 1)),
      beforeFirst: json(call(bars, 'valueAt', first - 1)),
      fractional: json(call(bars, 'valueAt', first + 0.5)),
    };
    const at = last - 5;
    const atTime = timeAt(at);
    const nextTime = timeAt(at + 1);
    const firstTime = timeAt(first);
    facts.timePointToIndex = {
      exactBar: {
        index: at,
        answer: atTime === null ? null : json(call(timeScale, 'timePointToIndex', atTime)),
      },
      betweenBars: {
        indices: [at, at + 1],
        answer:
          atTime === null || nextTime === null
            ? null
            : json(call(timeScale, 'timePointToIndex', Math.floor((atTime + nextTime) / 2))),
      },
      beforeFirst:
        firstTime === null ? null : json(call(timeScale, 'timePointToIndex', firstTime - 1)),
      afterLast: json(call(timeScale, 'timePointToIndex', 9_999_999_999)),
    };
    const range = call(timeScale, 'points');
    const pointRange = call(call(range, 'range'), 'value');
    const lastBarPublic = publicAt(last);
    const lastBarTime = timeAt(last);
    facts.timeBase = {
      // How far the time the chart reports for a bar lies from the time in its row: the day of a
      // daily bar at 00:00 UTC against the start of its session.
      publicMinusBarSeconds:
        typeof lastBarPublic === 'number' && lastBarTime !== null
          ? lastBarPublic - lastBarTime
          : null,
      pointsLastIndex: json(member(pointRange, 'lastIndex')),
      futurePointPublicTime: kind(publicAt(last + 1)),
    };
  }

  const visible = call(chart, 'getVisibleRange') as { from?: unknown; to?: unknown } | undefined;
  const lastPublic = typeof last === 'number' ? publicAt(last) : undefined;
  facts.visibleRange = {
    shape: typeof visible === 'object' ? Object.keys(visible) : [],
    toAfterLastBar:
      typeof visible?.to === 'number' && typeof lastPublic === 'number'
        ? visible.to > lastPublic
        : null,
    rightOffsetBars: json(call(timeScale, 'rightOffset')),
    barSpacing: json(call(timeScale, 'barSpacing')),
    baseIndex: json(call(timeScale, 'baseIndex')),
  };

  const info = call(series, 'symbolInfo') as Record<string, unknown> | null | undefined;
  const shown = call(chart, 'symbol');
  facts.symbol = {
    type: kind(shown),
    isFullName: typeof info === 'object' && info !== null ? shown === info.full_name : null,
    isProName: typeof info === 'object' && info !== null ? shown === info.pro_name : null,
    symbolInfoKeys: typeof info === 'object' && info !== null ? Object.keys(info).sort() : [],
  };

  const studies = call(chart, 'getAllStudies');
  const shapes = call(chart, 'getAllShapes');
  facts.studies = {
    count: Array.isArray(studies) ? studies.length : null,
    keys: Array.isArray(studies) && studies.length > 0 ? Object.keys(studies[0] as object) : [],
  };
  facts.shapes = {
    count: Array.isArray(shapes) ? shapes.length : null,
    keys: Array.isArray(shapes) && shapes.length > 0 ? Object.keys(shapes[0] as object) : [],
    // Tool types such as trend_line, never the text of a drawing.
    types: Array.isArray(shapes)
      ? [...new Set(shapes.map((shape: unknown) => String(member(shape, 'name'))))].sort()
      : [],
  };
  facts.app = {
    resolution: json(call(chart, 'resolution')),
    chartType: json(call(chart, 'chartType')),
    chartsCount: json(call(api, 'chartsCount')),
    activeChartIndex: json(call(api, 'activeChartIndex')),
    layout: json(call(api, 'layout')),
    layoutNameType: kind(member(api, 'layoutName')),
    layoutIdType: kind(member(api, 'layoutId')),
    isConnected: json(call(api, 'isConnected')),
    intervals: json(call(api, 'getIntervals')),
  };
  return facts;
}

// What the DOM of the chart tab shows, for the interface strategies and app_get_ui_state. Element
// text is never read; attributes are, apart from those of the dialogs, of which only data-name and
// role are.
export function probeDom(
  win: TvWindow,
  selectors: Record<string, string>,
  unsafe: string[],
): JsonObject {
  const doc = win.document as unknown as Document;
  const view = win as unknown as Window;
  const describe = (element: Element | null): JsonObject | null => {
    if (element === null) {
      return null;
    }
    const box = element.getBoundingClientRect();
    const style = win.getComputedStyle?.(element);
    const out: JsonObject = {
      tag: element.localName,
      width: Math.round(box.width),
      height: Math.round(box.height),
      display: style?.display ?? null,
    };
    for (const name of ['id', 'data-name', 'data-qa-id', 'aria-pressed', 'aria-selected', 'role']) {
      const value = element.getAttribute(name);
      if (value !== null) {
        out[name] = value.slice(0, 60);
      }
    }
    return out;
  };
  const elements: JsonObject = {};
  for (const [name, selector] of Object.entries(selectors)) {
    elements[name] = {
      count: doc.querySelectorAll(selector).length,
      first: describe(doc.querySelector(selector)),
    };
  }
  const intervals = doc.querySelector('#header-toolbar-intervals');
  const overlap = doc.querySelector('#overlap-manager-root');
  return {
    zoom: {
      devicePixelRatio: view.devicePixelRatio,
      innerWidth: view.innerWidth,
      screenWidth: view.screen.width,
      visualViewportScale: view.visualViewport?.scale ?? null,
    },
    focus: describe(doc.activeElement),
    focusIsBody: doc.activeElement === doc.body,
    fullscreenElement: doc.fullscreenElement === null ? null : describe(doc.fullscreenElement),
    elements,
    intervalItems: intervals
      ? Array.from(intervals.querySelectorAll('button')).map((button) => ({
          attributes: button.getAttributeNames().sort(),
          ariaLabel: button.getAttribute('aria-label'),
          dataValue: button.getAttribute('data-value'),
        }))
      : [],
    overlapLayers: overlap
      ? Array.from(overlap.children).map((layer) => ({
          shown: layer.getBoundingClientRect().width > 0,
          children: layer.children.length,
          dataName: layer.getAttribute('data-name'),
          role: layer.getAttribute('role'),
        }))
      : [],
    unsafe: unsafe.map((selector) => ({ selector, count: doc.querySelectorAll(selector).length })),
  };
}

// The first characters of the source of each member of `members` (object path, member name). The
// source is the app's code, read through Function.prototype.toString.
export function probeBodies(
  win: TvWindow,
  members: [string, string][],
  length: number,
): Record<string, string> {
  const member = (owner: unknown, name: string): unknown => {
    try {
      return (typeof owner === 'object' && owner !== null) || typeof owner === 'function'
        ? (owner as Record<string, unknown>)[name]
        : undefined;
    } catch {
      return undefined;
    }
  };
  const call = (owner: unknown, name: string): unknown => {
    const fn = member(owner, name);
    try {
      return typeof fn === 'function' ? (fn as () => unknown).call(owner) : undefined;
    } catch {
      return undefined;
    }
  };
  const api = member(win, 'TradingViewApi');
  const chart = call(api, 'activeChart');
  const model = call(member(chart, '_chartWidget'), 'model');
  const series = call(model, 'mainSeries');
  const objects: Record<string, unknown> = {
    api,
    chart,
    model,
    series,
    timeScale: call(call(model, 'model'), 'timeScale'),
    bars: call(series, 'bars'),
  };
  const bodies: Record<string, string> = {};
  for (const [path, name] of members) {
    const fn = member(objects[path], name);
    bodies[`${path}.${name}`] =
      typeof fn === 'function' ? Function.prototype.toString.call(fn).slice(0, length) : typeof fn;
  }
  return bodies;
}

// The selectors the server uses, flattened to name → selector for probeDom.
function flatSelectors(): Record<string, string> {
  const flat: Record<string, string> = {};
  const walk = (prefix: string, value: unknown): void => {
    if (typeof value === 'string') {
      flat[prefix] = value;
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, inner] of Object.entries(value)) {
        walk(prefix === '' ? key : `${prefix}.${key}`, inner);
      }
    }
  };
  walk('', SELECTORS);
  // The window chrome is another renderer; its selectors do not apply to the chart tab.
  return Object.fromEntries(
    Object.entries(flat).filter(([name]) => !name.startsWith('windowChrome')),
  );
}

function line(text = ''): void {
  process.stdout.write(`${text}\n`);
}

// Reads a nested value of the report for printing, whatever its shape turned out to be.
function at(value: JsonValue | undefined, ...path: string[]): JsonValue | undefined {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function show(value: JsonValue | undefined): string {
  if (value === undefined) {
    return 'n/a';
  }
  if (typeof value === 'boolean') {
    return value ? 'yes' : 'no';
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function entries(value: JsonValue | undefined): [string, JsonValue][] {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.entries(value)
    : [];
}

function items(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function printSummary(report: JsonObject): void {
  const chart = report.chart;
  const dom = report.dom;
  line(`TradingView Desktop at ${show(report.endpoint)}: ${show(report.userAgent)}`);
  line(
    `Targets: ${entries(report.targets)
      .map(([kind, count]) => `${show(count)} ${kind}`)
      .join(', ')}; debugger addresses on loopback only: ${show(report.loopbackOnly)}`,
  );
  line(
    `Web build ${show(at(report.capabilities, 'buildTime'))}, connected: ${show(at(chart, 'app', 'isConnected'))}`,
  );
  line(
    `Globals (${show(at(report.globals, 'windowKeys'))} keys on window): ${entries(
      at(report.globals, 'globals'),
    )
      .map(([name, type]) => `${name} ${show(type)}`)
      .join(', ')}`,
  );
  line(
    `Capabilities: ${entries(report.capabilities)
      .filter(([name]) => name !== 'buildTime')
      .map(([name, value]) => `${name} ${show(value)}`)
      .join(', ')}`,
  );
  const surface = entries(report.surface);
  const missing = surface.flatMap(([path, info]) =>
    items(at(info, 'missing')).map((name) => `${path}.${show(name)}`),
  );
  line(
    `Members the server relies on: ${missing.length === 0 ? 'all present' : `MISSING ${missing.join(', ')}`}`,
  );
  line(
    `Methods: ${surface.map(([path, info]) => `${path} ${show(at(info, 'methods'))}`).join(', ')}`,
  );

  line('Chart model:');
  line(
    `  isSymbolInvalid: ${show(at(chart, 'isSymbolInvalid', 'type'))} returning ${show(at(chart, 'isSymbolInvalid', 'returns'))}`,
  );
  line(
    `  logicalRange(): ${show(at(chart, 'logicalRange', 'returns'))} with own keys ${show(at(chart, 'logicalRange', 'ownKeys'))}; left() ${show(at(chart, 'logicalRange', 'left'))}, right() ${show(at(chart, 'logicalRange', 'right'))}; from ${show(at(chart, 'logicalRange', 'from'))}, to ${show(at(chart, 'logicalRange', 'to'))}`,
  );
  line(
    `  bars: indices ${show(at(chart, 'bars', 'firstIndex'))}..${show(at(chart, 'bars', 'lastIndex'))} (size ${show(at(chart, 'bars', 'size'))}), rows of ${show(at(chart, 'bars', 'rowLength'))} ${show(at(chart, 'bars', 'rowTypes'))}; valueAt after the last ${show(at(chart, 'bars', 'afterLast'))}, before the first ${show(at(chart, 'bars', 'beforeFirst'))}, fractional ${show(at(chart, 'bars', 'fractional'))}`,
  );
  line(
    `  timePointToIndex: bar ${show(at(chart, 'timePointToIndex', 'exactBar', 'index'))} at its time -> ${show(at(chart, 'timePointToIndex', 'exactBar', 'answer'))}; between bars ${show(at(chart, 'timePointToIndex', 'betweenBars', 'indices'))} -> ${show(at(chart, 'timePointToIndex', 'betweenBars', 'answer'))}; before the first -> ${show(at(chart, 'timePointToIndex', 'beforeFirst'))}; far after the last -> ${show(at(chart, 'timePointToIndex', 'afterLast'))}`,
  );
  line(
    `  time base: the chart reports a bar ${show(at(chart, 'timeBase', 'publicMinusBarSeconds'))} s from the time in its row; time points up to index ${show(at(chart, 'timeBase', 'pointsLastIndex'))}`,
  );
  line(
    `  visible range: ends after the last bar ${show(at(chart, 'visibleRange', 'toAfterLastBar'))} (right offset ${show(at(chart, 'visibleRange', 'rightOffsetBars'))} bars, bar spacing ${show(at(chart, 'visibleRange', 'barSpacing'))} px)`,
  );
  line(
    `  symbol(): the full_name of the symbol info ${show(at(chart, 'symbol', 'isFullName'))}, the pro_name ${show(at(chart, 'symbol', 'isProName'))}`,
  );
  const keys = items(at(chart, 'symbol', 'symbolInfoKeys'));
  line(`  symbolInfo: ${String(keys.length)} keys: ${keys.map(show).join(', ')}`);
  line(
    `  studies: ${show(at(chart, 'studies', 'count'))} with keys ${show(at(chart, 'studies', 'keys'))}; drawings: ${show(at(chart, 'shapes', 'count'))} with keys ${show(at(chart, 'shapes', 'keys'))}, of the types ${show(at(chart, 'shapes', 'types'))}`,
  );
  line(
    `  layout ${show(at(chart, 'app', 'layout'))}, ${show(at(chart, 'app', 'chartsCount'))} chart(s), active ${show(at(chart, 'app', 'activeChartIndex'))}; timeframe ${show(at(chart, 'app', 'resolution'))}, chart type ${show(at(chart, 'app', 'chartType'))}`,
  );
  line(
    `  intervals: ${items(at(chart, 'app', 'intervals'))
      .map(show)
      .join(' ')}`,
  );

  line('DOM:');
  line(
    `  zoom: devicePixelRatio ${show(at(dom, 'zoom', 'devicePixelRatio'))} (it includes the page zoom; 2 is 100% on a Retina display), page ${show(at(dom, 'zoom', 'innerWidth'))} px wide on a screen of ${show(at(dom, 'zoom', 'screenWidth'))} px`,
  );
  line(
    `  focus: ${show(at(dom, 'focus'))}; fullscreen element: ${show(at(dom, 'fullscreenElement'))}`,
  );
  line(
    `  interval toolbar buttons: ${items(at(dom, 'intervalItems'))
      .map(
        (item) =>
          `aria-label ${show(at(item, 'ariaLabel'))}, data-value ${show(at(item, 'dataValue'))}`,
      )
      .join('; ')}`,
  );
  const element = (name: string): JsonValue | undefined => at(dom, 'elements', name, 'first');
  line(
    `  #bottom-area: ${show(at(element('regions.bottomArea'), 'display'))}; right panel: widgetbar-wrap ${show(at(element('widgets.widgetBar'), 'width'))} px, its pages ${show(at(element('widgets.widgetBarTabs'), 'width'))} px wide`,
  );
  line(
    `  aria-pressed: fullscreen ${show(at(element('header.fullscreen'), 'aria-pressed'))}, replay ${show(at(element('header.replay'), 'aria-pressed'))}, Pine Editor ${show(at(element('buttons.pineEditor'), 'aria-pressed'))}`,
  );
  const layers = items(at(dom, 'overlapLayers'));
  line(
    `  #overlap-manager-root: ${String(layers.filter((layer) => at(layer, 'shown') === true).length)} of ${String(layers.length)} layer(s) shown`,
  );
  line(
    `  trading controls: ${items(at(dom, 'unsafe'))
      .map((item) => `${show(at(item, 'selector'))} ${show(at(item, 'count'))}`)
      .join(', ')}`,
  );
  const unmatched = entries(at(dom, 'elements'))
    .filter(([, info]) => at(info, 'count') === 0)
    .map(([name]) => name);
  line(`  selectors without a match: ${unmatched.length === 0 ? 'none' : unmatched.join(', ')}`);
  if (report.bodies !== undefined) {
    line('Sources:');
    for (const [name, body] of entries(report.bodies)) {
      line(`  ${name}: ${show(body)}`);
    }
  }
}

async function probePage(page: PageHandle, withBodies: boolean): Promise<JsonObject> {
  const report: JsonObject = {};
  report.globals = await page.bridge.evaluate(probeGlobals, [GLOBALS]);
  report.capabilities = await page.bridge.evaluate(probeCapabilities, []);
  report.surface = await page.bridge.evaluate(probeSurface, [CONTRACT, withBodies]);
  report.chart = await page.bridge.evaluate(probeChartFacts, []);
  report.dom = await page.bridge.evaluate(probeDom, [flatSelectors(), [...UNSAFE_SELECTORS]]);
  if (withBodies) {
    const members = Object.entries(CONTRACT).flatMap(([path, names]) =>
      names.map((name): [string, string] => [path, name]),
    );
    report.bodies = await page.bridge.evaluate(probeBodies, [members, 600]);
  }
  return report;
}

async function main(): Promise<void> {
  const { config, flags } = readOptions(process.argv.slice(2), {
    json: { type: 'boolean', default: false },
    bodies: { type: 'boolean', default: false },
  });
  if (flags.help === true) {
    process.stdout.write(USAGE);
    return;
  }
  const app = connectToApp(config);
  try {
    const version = await app.discovery.version();
    const targets = await app.connection.targets();
    const kinds: Record<string, number> = {};
    for (const target of targets) {
      const kind = classifyTarget(target);
      kinds[kind] = (kinds[kind] ?? 0) + 1;
    }
    const page = await app.connection.chartPage();
    const report: JsonObject = {
      endpoint: app.endpoint,
      browser: version.browser,
      userAgent: version.userAgent,
      targets: kinds,
      // Every listed debugger address must stay on this machine.
      loopbackOnly: targets.every(
        (target) =>
          target.webSocketDebuggerUrl === undefined ||
          /^wss?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(target.webSocketDebuggerUrl),
      ),
      ...(await probePage(page, flags.bodies === true)),
    };
    if (flags.json === true) {
      line(JSON.stringify(report, null, 2));
    } else {
      printSummary(report);
    }
  } finally {
    await app.close();
  }
}

runScript(main);
