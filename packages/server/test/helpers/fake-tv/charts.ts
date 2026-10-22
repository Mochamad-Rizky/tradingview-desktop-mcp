import type { JsonValue } from '../../../src/utils/json.js';
import type { FixtureCharts, FixturePane } from './fixture.js';
import type { SyntheticBar } from './synthetic-bars.js';
import type {
  FakeBars,
  FakeChartModel,
  FakeChartWidgetApi,
  FakeMainSeries,
  FakeSetOptions,
} from './window.js';

// The charts of the layout, their panes and the layout functions of the app, built from the layout
// and the charts of the fixture (reverse-engineering notes of Plan 3, section 2, and the web
// build). Values are synthetic.
//
// - The layout has a type, layout() (a code such as s or 2h), and shows chartsCount() charts, those
//   of the fixture at first. Chart 0 is the chart of the fixture, which window.ts builds; the
//   others come from charts.others of the fixture, from chart 1 on, or from setLayout. A declared
//   chart beyond the count is hidden, as the app keeps the charts a smaller layout hides until the
//   layout is saved. chart(i) answers the charts the layout shows and throws "Incorrect index: i",
//   as the app does, for any other index, so a layout whose fixture counts more charts than it
//   declares reaches chart 0 alone, as the fake did before it modeled other charts.
// - activeChart() is the chart at activeChartIndex(), or chart 0 while no chart is declared there.
//   setActiveChart(i) records itself and makes chart i the active one, and ignores an index the
//   layout does not show, as the app does.
// - Each chart has panes, top to bottom (getPanes()), with the heights of the fixture (one pane of
//   600 px when it gives none): the first holds the main series, the studies no other pane lists
//   and the drawings, each other one the studies it lists. A pane whose studies are all gone
//   disappears, as the app removes an empty pane. getAllEntities() lists the main series ({ name:
//   'Main Series' }), the studies and the drawings of a pane, as the app does.
// - An other chart reports its symbol, resolution, studies and drawings. Its setSymbol and
//   setResolution behave as those of chart 0: they record themselves (chart(i).setSymbol and
//   chart(i).setResolution), make the chart the active one unless doNotActivateChart, flag an
//   unknown symbol, which never gets data, show a known one through its feed, and run dataReady.
//   dataReady() resolves once the chart has its data. Its main series has the bars of chart 0 and
//   the symbol info of the fixture under the names of its own symbol. What else a chart has is not
//   modeled: those members throw.
// - With symbolSync, as when the layout syncs the symbol of its charts, a symbol set on one chart
//   the layout shows is set on each other one too, without a call of their own.
// - setLayout(type, options) records itself and returns nothing, and changes the layout layoutMs
//   later, as the app does once it has flushed the drawings of the charts. With withUndo
//   (setChartLayoutWithUndo of the app) the type shown already changes nothing; a type beyond the
//   chart limit of the plan opens the paywall (dialog.paywall, PAYWALL_MULTIPLE_CHARTS with the
//   count of the type) and changes nothing while the layout holds more charts than the plan allows
//   (_isLayoutKeptBehindPaywall), and otherwise opens it and shows the largest layout the plan
//   allows (_checkProFeature); and a type the table does not know changes nothing (the undo command
//   of the app throws on it). Without withUndo (setLayout of the collection), a type beyond the
//   limit whose charts the layout holds already is shown locked, with as many charts as the plan
//   allows and no paywall (_lockedLayoutLiveCount); any other type beyond it goes through
//   _checkProFeature; and an unknown type becomes s. The limit is the one of the app,
//   enabled(MULTIPLE_CHARTS) ? max(getConfig(MULTIPLE_CHARTS).limit ?? 1, 1) : 1, from the plan of
//   the fixture. A larger layout shows its hidden charts again and adds new ones on the symbol and
//   resolution of the active chart, which have their data dataMs later; a smaller one hides the
//   charts beyond its count, and makes the last chart it shows the active one when the active chart
//   is hidden.
// - The table of the layouts of the app, the export layouts of a module that also exports
//   isMultipleLayout, isSupportedLayout and tryGuessingTheMostSuitableLayout (a stub that throws:
//   only its name is looked for), is in the default webpack cache: code → { title, count,
//   layoutType } for the 55 codes of the app, in its order.
// - The containers of the charts stay those of the fixture (screen.ts), whatever the layout shows.

export interface FakeChartsOptions {
  // How long setLayout takes to change the layout. Default 10 ms.
  layoutMs?: number;
  // How long a chart setLayout adds takes to have its data. Infinity: never. Default 10 ms.
  dataMs?: number;
  // Codes the table of layouts leaves out, as another build might. setLayout does not know them
  // either.
  withoutCodes?: readonly string[];
  // Leaves the module of the table of layouts out of the cache.
  withoutLayoutTable?: boolean;
}

// A pane of a chart, chart.getPanes()[i], as far as the server reads it.
export interface FakePaneApi {
  paneIndex(): number;
  // In CSS pixels.
  getHeight(): number;
  hasMainSeries(): boolean;
  getAllEntities(): { id: string; name: string }[];
}

// A chart of the layout other than chart 0. Tests may change its fields, for example to stage a
// chart that has no data yet.
export interface FakeOtherChartState {
  symbol: string;
  resolution: string;
  symbolInvalid: boolean;
  studies: { id: string; name: string }[];
  shapes: { id: string; name: string }[];
  panes: FixturePane[];
  // Whether the chart has its data.
  dataReady: boolean;
}

// The live state of the charts of the layout.
export interface FakeChartsState {
  // The type of the layout, layout().
  layout: string;
  // How many charts it shows, chartsCount().
  count: number;
  // The charts after chart 0, from chart 1 on, the hidden ones included.
  others: FakeOtherChartState[];
  symbolSync: boolean;
}

export interface FakeChartsDeps {
  state: FakeChartsState;
  record: (name: string, args: readonly unknown[]) => void;
  // Chart 0, which window.ts builds, and what it holds. syncSymbol sets its symbol without a call
  // of its own, as symbol sync does.
  main: {
    chart(): FakeChartWidgetApi;
    studies(): { id: string; name: string }[];
    shapes(): { id: string; name: string }[];
    syncSymbol(symbol: string): void;
  };
  // The active chart, which the state of the window holds.
  active: { get(): number; set(index: number): void };
  // Whether the app knows a symbol, the name of the data feed a known symbol shows through, and the
  // listing a symbol the chart shows stands for.
  isKnown(symbol: string): boolean;
  feedOf(symbol: string): string | undefined;
  listingOf(shown: string): string;
  // The bars and the symbol info of chart 0, which the other charts show as well.
  bars(): readonly SyntheticBar[];
  symbolInfo(): Record<string, JsonValue>;
  // The MULTIPLE_CHARTS limit of the plan and its configuration, as the plan modules serve them
  // (plan-limits.ts).
  planLimit: number | undefined;
  planConfig: Readonly<Record<string, number>> | undefined;
  // The layout of the fixture and its charts.
  layout: { type: string; chartsCount: number };
  fixture: FixtureCharts | undefined;
  options?: FakeChartsOptions | undefined;
}

// The members of TradingViewApi that concern the charts of the layout.
export interface FakeChartsApi {
  activeChart(): FakeChartWidgetApi;
  chart(index?: number): FakeChartWidgetApi;
  chartsCount(): number;
  activeChartIndex(): number;
  setActiveChart(index: number): void;
  layout(): string;
  setLayout(...args: unknown[]): void;
}

export interface FakeCharts {
  readonly api: FakeChartsApi;
  readonly modules: Record<string, Record<string, unknown>>;
  // The panes of chart 0.
  mainPanes(): FakePaneApi[];
  // What symbol sync does once chart 0 took a symbol: the other charts the layout shows take it
  // too.
  syncFromMain(symbol: string): void;
}

// The id of the main series is synthetic: the app gives mainSeries().id().
export const MAIN_SERIES = { id: 'MAINSERIES', name: 'Main Series' } as const;
const DEFAULT_PANE_HEIGHT = 600;

// The table of layouts of the app: code → count, in the order of its source. Codes that look like
// numbers (4, 6, 8) come first among the keys of an object, in the app as here.
const LAYOUT_COUNTS: Readonly<Record<string, number>> = {
  s: 1,
  '2h': 2,
  '2v': 2,
  '3h': 3,
  '3v': 3,
  '3s': 3,
  '3r': 3,
  '2-1': 3,
  '1-2': 3,
  '4': 4,
  '4v': 4,
  '4h': 4,
  '4s': 4,
  '4s-l': 4,
  '1-3': 4,
  '3-1': 4,
  '2-2-l': 4,
  '2-2-r': 4,
  '2-2': 4,
  '1-4': 5,
  '5h': 5,
  '5v': 5,
  '5s': 5,
  '5s-l': 5,
  '2-3': 5,
  '3-2': 5,
  '4-1': 5,
  '2-3-l': 5,
  '2-3-r': 5,
  '6': 6,
  '6h': 6,
  '6v': 6,
  '6c': 6,
  '2-4': 6,
  '4-2': 6,
  '4-3': 7,
  '7h': 7,
  '7s': 7,
  '8': 8,
  '8c': 8,
  '8h': 8,
  '8v': 8,
  '9s': 9,
  '5-4': 9,
  '9h': 9,
  '9v': 9,
  '10c5': 10,
  '10h': 10,
  '10v': 10,
  '12c6': 12,
  '12c4': 12,
  '12h': 12,
  '14c7': 14,
  '16c8': 16,
  '16c4': 16,
};

interface LayoutEntry {
  title: string;
  count: number;
  layoutType: string;
}

interface Entity {
  id: string;
  name: string;
}

const copy = ({ id, name }: Entity): Entity => ({ id, name });

// The panes of a chart from the panes of its fixture and what the chart holds now.
function panesOf(
  spec: readonly FixturePane[],
  studies: readonly Entity[],
  shapes: readonly Entity[],
): FakePaneApi[] {
  const layout = spec.length === 0 ? [{ height: DEFAULT_PANE_HEIGHT, studies: [] }] : spec;
  const elsewhere = new Set(layout.slice(1).flatMap((pane) => pane.studies));
  const filled = layout
    .map((pane, position) => ({
      height: pane.height,
      studies: studies.filter(({ id }) =>
        position === 0 ? !elsewhere.has(id) : pane.studies.includes(id),
      ),
    }))
    .filter((pane, position) => position === 0 || pane.studies.length > 0);
  return filled.map((pane, index): FakePaneApi => ({
    paneIndex: () => index,
    getHeight: () => pane.height,
    hasMainSeries: () => index === 0,
    getAllEntities: () => [
      ...(index === 0 ? [copy(MAIN_SERIES)] : []),
      ...pane.studies.map(copy),
      ...(index === 0 ? shapes.map(copy) : []),
    ],
  }));
}

function barsOf(rows: readonly SyntheticBar[]): FakeBars {
  return {
    size: () => rows.length,
    firstIndex: () => (rows.length === 0 ? null : 0),
    lastIndex: () => (rows.length === 0 ? null : rows.length - 1),
    valueAt(index) {
      const bar = Number.isInteger(index) ? rows[index] : undefined;
      return bar ? [bar[0], bar[1], bar[2], bar[3], bar[4], bar[5]] : null;
    },
  };
}

export function createFakeCharts(deps: FakeChartsDeps): FakeCharts {
  const options = deps.options ?? {};
  const layoutMs = options.layoutMs ?? 10;
  const dataMs = options.dataMs ?? 10;
  const { state } = deps;
  const without = new Set(options.withoutCodes ?? []);

  const table: Record<string, LayoutEntry> = {};
  for (const [code, count] of Object.entries(LAYOUT_COUNTS)) {
    if (!without.has(code)) {
      table[code] = {
        title: `${String(count)} chart${count === 1 ? '' : 's'}`,
        count,
        layoutType: code,
      };
    }
  }
  const countOf = (code: string): number | undefined =>
    Object.hasOwn(table, code) ? table[code]?.count : undefined;

  const fromFixture = (symbol: string): string => deps.feedOf(symbol) ?? symbol;
  state.layout = deps.layout.type;
  state.count = deps.layout.chartsCount;
  state.others = (deps.fixture?.others ?? []).map((other) => ({
    symbol: fromFixture(other.symbol),
    resolution: other.resolution,
    symbolInvalid: !deps.isKnown(other.symbol),
    studies: other.studies.map(copy),
    shapes: other.shapes.map(copy),
    panes: (other.panes ?? []).map((pane) => ({ height: pane.height, studies: [...pane.studies] })),
    dataReady: true,
  }));
  state.symbolSync = deps.fixture?.symbolSync === true;
  const mainPanes = (deps.fixture?.panes ?? []).map((pane) => ({
    height: pane.height,
    studies: [...pane.studies],
  }));

  // The other charts the layout shows.
  const shown = (): FakeOtherChartState[] =>
    state.others.filter((_chart, position) => position + 1 < state.count);
  const indexOf = (chart: FakeOtherChartState): number => state.others.indexOf(chart) + 1;

  // The waiters for the data of each chart, and the API of each, made once.
  const waiters = new WeakMap<FakeOtherChartState, (() => void)[]>();
  const apis = new WeakMap<FakeOtherChartState, FakeChartWidgetApi>();
  const ready = (chart: FakeOtherChartState): void => {
    chart.dataReady = true;
    const waiting = waiters.get(chart) ?? [];
    waiters.delete(chart);
    for (const resolve of waiting) {
      resolve();
    }
  };

  // A symbol taken by a chart: flagged when unknown, and else shown through its feed once
  // resolved.
  const take = (chart: FakeOtherChartState, symbol: string): void => {
    chart.symbol = symbol;
    chart.symbolInvalid = !deps.isKnown(symbol);
    if (chart.symbolInvalid) {
      return;
    }
    const feed = deps.feedOf(symbol);
    if (feed !== undefined) {
      queueMicrotask(() => {
        if (chart.symbol === symbol) {
          chart.symbol = feed;
        }
      });
    }
    ready(chart);
  };
  const syncFrom = (source: FakeOtherChartState | null, symbol: string): void => {
    if (!state.symbolSync) {
      return;
    }
    for (const chart of shown()) {
      if (chart !== source) {
        take(chart, symbol);
      }
    }
    if (source !== null) {
      deps.main.syncSymbol(symbol);
    }
  };
  // As the app does: the app reports readiness later than the call that asked for it, and a
  // callback of the page that throws is the page's own problem.
  const notifyDataReady = (given: FakeSetOptions | undefined): void => {
    const dataReady = given?.dataReady;
    if (typeof dataReady !== 'function') {
      return;
    }
    queueMicrotask(() => {
      try {
        dataReady();
      } catch {
        // Swallowed on purpose, like an uncaught error in the callback of the real app.
      }
    });
  };
  const activate = (chart: FakeOtherChartState, given: FakeSetOptions | undefined): void => {
    if (given?.doNotActivateChart !== true) {
      deps.active.set(indexOf(chart));
    }
  };

  const apiOf = (chart: FakeOtherChartState): FakeChartWidgetApi => {
    const made = apis.get(chart);
    if (made !== undefined) {
      return made;
    }
    const notModeled = (member: string) => (): never => {
      throw new Error(`${member} is not modeled on the other charts of the fake`);
    };
    const series: FakeMainSeries = {
      bars: () => barsOf(chart.symbolInvalid ? [] : deps.bars()),
      symbolInfo: () => {
        if (chart.symbolInvalid) {
          return null;
        }
        const listing = deps.listingOf(chart.symbol);
        return {
          ...structuredClone(deps.symbolInfo()),
          name: listing.slice(listing.lastIndexOf(':') + 1),
          full_name: chart.symbol,
          pro_name: listing,
        };
      },
      quotes: () => null,
      isSymbolInvalid: () => chart.symbolInvalid,
      requestMoreData: notModeled('requestMoreData'),
      requestMoreDataAvailable: () => false,
      endOfData: () => false,
      endOfDataType: () => null,
      isLoading: () => false,
      status: () => 3,
      interval: () => chart.resolution,
    };
    const model: FakeChartModel = {
      mainSeries: () => series,
      model: () => ({
        timeScale: notModeled('timeScale'),
        getStudyById: () => null,
        activeStrategySource: () => ({ value: () => null }),
      }),
    };
    const api: FakeChartWidgetApi = {
      symbol: () => chart.symbol,
      resolution: () => chart.resolution,
      // Every other chart shows candles.
      chartType: () => 1,
      getVisibleRange: notModeled('getVisibleRange'),
      getAllStudies: () => chart.studies.map(copy),
      getStudyById: notModeled('getStudyById'),
      getAllShapes: () => chart.shapes.map(copy),
      getShapeById: notModeled('getShapeById'),
      createShape: notModeled('createShape'),
      createMultipointShape: notModeled('createMultipointShape'),
      removeAllShapes: notModeled('removeAllShapes'),
      createStudy: notModeled('createStudy'),
      removeEntity: notModeled('removeEntity'),
      setSymbol(symbol, given) {
        deps.record(
          `chart(${String(indexOf(chart))}).setSymbol`,
          given === undefined ? [symbol] : [symbol, given],
        );
        activate(chart, given);
        take(chart, symbol);
        syncFrom(chart, symbol);
        if (!chart.symbolInvalid) {
          notifyDataReady(given);
        }
        return Promise.resolve(true);
      },
      setResolution(resolution, given) {
        deps.record(
          `chart(${String(indexOf(chart))}).setResolution`,
          given === undefined ? [resolution] : [resolution, given],
        );
        activate(chart, given);
        chart.resolution = resolution;
        notifyDataReady(given);
        return Promise.resolve(true);
      },
      setChartType: notModeled('setChartType'),
      setVisibleRange: notModeled('setVisibleRange'),
      // The series of an unknown symbol never gets data, so the promise never settles then.
      dataReady: () =>
        chart.symbolInvalid
          ? new Promise<true>(() => undefined)
          : chart.dataReady
            ? Promise.resolve(true)
            : new Promise<true>((resolve) => {
                waiters.set(chart, [
                  ...(waiters.get(chart) ?? []),
                  () => {
                    resolve(true);
                  },
                ]);
              }),
      getPanes: () => panesOf(chart.panes, chart.studies, chart.shapes),
      _convertIndexToPublicTime: () => null,
      _chartWidget: { model: () => model },
    };
    apis.set(chart, api);
    return api;
  };

  const otherAt = (index: number): FakeOtherChartState | undefined =>
    Number.isInteger(index) && index > 0 && index < state.count
      ? state.others[index - 1]
      : undefined;

  // The limit of the app, _planChartsLimit.
  const configured = deps.planLimit !== undefined || deps.planConfig !== undefined;
  const planChartsLimit = (): number =>
    configured ? Math.max(deps.planConfig?.limit ?? deps.planLimit ?? 1, 1) : 1;
  const applied = (code: string): boolean => code !== 's' && Object.hasOwn(table, code);
  const beyond = (code: string): boolean => (countOf(code) ?? 0) > planChartsLimit();
  // Every chart the collection holds, the hidden ones included (_chartsCountToSave).
  const chartsToSave = (): number => 1 + state.others.length;
  const paywall = (code: string): void => {
    deps.record('dialog.paywall', ['PAYWALL_MULTIPLE_CHARTS', { limit: countOf(code) }]);
  };
  // The first layout with the most charts the limit allows (Yt of the app).
  const largestWithin = (limit: number): string => {
    let best = 's';
    let most = 1;
    for (const [code, { count }] of Object.entries(table)) {
      if (count <= limit && count > most) {
        best = code;
        most = count;
      }
    }
    return best;
  };
  const checkProFeature = (code: string): string => {
    if (!applied(code) || !beyond(code)) {
      return code;
    }
    paywall(code);
    return largestWithin(planChartsLimit());
  };

  const pause = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      // Not ref'd, so a change a test never waits for does not hold the test process.
      setTimeout(resolve, ms).unref();
    });
  const show = (code: string, liveLimit: number | null): void => {
    const count = liveLimit ?? countOf(code) ?? 1;
    const active = api.activeChart();
    state.layout = code;
    state.count = count;
    while (state.others.length + 1 < count) {
      const added: FakeOtherChartState = {
        symbol: active.symbol(),
        resolution: active.resolution(),
        symbolInvalid: false,
        studies: [],
        shapes: [],
        panes: [],
        dataReady: false,
      };
      state.others.push(added);
      if (dataMs !== Infinity) {
        setTimeout(() => {
          ready(added);
        }, dataMs).unref();
      }
    }
    if (deps.active.get() >= count) {
      deps.active.set(count - 1);
    }
  };
  // setLayout of the collection.
  const setPlainly = async (code: string): Promise<void> => {
    await pause(layoutMs);
    const locked =
      applied(code) && beyond(code) && chartsToSave() >= (countOf(code) ?? 0)
        ? planChartsLimit()
        : null;
    let shownCode = locked === null ? checkProFeature(code) : code;
    if (!Object.hasOwn(table, shownCode)) {
      shownCode = 's';
    }
    show(shownCode, locked);
  };
  // setChartLayoutWithUndo of the collection, whose undo command sets the layout as above.
  const setWithUndo = async (code: string): Promise<void> => {
    if (state.layout === code) {
      return;
    }
    if (applied(code) && beyond(code) && chartsToSave() > planChartsLimit()) {
      paywall(code);
      return;
    }
    const allowed = checkProFeature(code);
    if (state.layout === allowed || !Object.hasOwn(table, allowed)) {
      return;
    }
    await setPlainly(allowed);
  };

  const api: FakeChartsApi = {
    activeChart() {
      const other = otherAt(deps.active.get());
      return other === undefined ? deps.main.chart() : apiOf(other);
    },
    chart(index = 0) {
      if (index === 0) {
        return deps.main.chart();
      }
      const other = otherAt(index);
      if (other === undefined) {
        throw new Error(`Incorrect index: ${String(index)}`);
      }
      return apiOf(other);
    },
    chartsCount: () => state.count,
    activeChartIndex: () => deps.active.get(),
    setActiveChart(index) {
      deps.record('TradingViewApi.setActiveChart', [index]);
      if (Number.isInteger(index) && index >= 0 && index < state.count) {
        deps.active.set(index);
      }
    },
    layout: () => state.layout,
    setLayout(...args) {
      deps.record('TradingViewApi.setLayout', args);
      const [type, given] = args;
      const withUndo =
        typeof given === 'object' &&
        given !== null &&
        Boolean((given as { withUndo?: unknown }).withUndo);
      const code = String(type);
      void (withUndo ? setWithUndo(code) : setPlainly(code));
    },
  };

  const modules: Record<string, Record<string, unknown>> = options.withoutLayoutTable === true
    ? {}
    : {
        // Module IDs are arbitrary numbers, as in a production build.
        '97177': {
          layouts: table,
          isMultipleLayout: (code: unknown) => code !== 's',
          isSupportedLayout: (code: unknown) =>
            code === 's' || (typeof code === 'string' && Object.hasOwn(table, code)),
          // Only its name is looked for, so that the module is found: it is not modeled.
          tryGuessingTheMostSuitableLayout: (): never => {
            throw new Error('tryGuessingTheMostSuitableLayout is not modeled by the fake');
          },
        },
      };

  return {
    api,
    modules,
    mainPanes: () => panesOf(mainPanes, deps.main.studies(), deps.main.shapes()),
    syncFromMain: (symbol) => {
      syncFrom(null, symbol);
    },
  };
}
