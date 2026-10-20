import type { JsonValue } from '../../../src/utils/json.js';
import type { FixtureStudy, TvStateFixture } from './fixture.js';
import type { SyntheticBar } from './synthetic-bars.js';

// The studies on the chart and what the app knows of the indicators it can add, built from the
// fixture (reverse-engineering notes of Plan 2, sections 5 and 6):
//
// - getStudyById(id) answers the study API of a study on the chart, and throws "There is no such
//   study" for any other id, as the app does. The API reports title(), isVisible(),
//   getInputsInfo() (every input, the hidden Pine internals included, with localizedName) and
//   getInputValues() ({ id, value } in the same order), and study() answers the study core.
// - The study core has id(), metaInfo() (description, plots, styles, ohlcPlots, inputs, and pine
//   with scriptIdPart for a Pine study) and data(), the plot list of its rows. A strategy carries
//   the own flag isStudyStrategy and the members the duck test of the app looks for.
// - The plot list holds a row [time, ...one slot per plot] for each bar, at the index of the bar
//   (the same indices as bars()), after the pre-history rows at -1e6 and below. It has the members
//   of the PlotList of the app the tools read: size, firstIndex, lastIndex, firstPlottableIndex,
//   first, last, valueAt (exact), search (mode -1 nearest left, 0 exact, 1 nearest right) and
//   rangeIterator, which yields { index, value } items.
// - Values are synthetic and follow the bars: a line or other value plot k holds the close plus k,
//   a colorer the palette index 0, an ohlc_* plot the matching price of the bar, an alertcondition
//   or a dataoffset nothing (undefined). Before the warmup of the study is over, value plots hold
//   NaN.
// - createStudyCatalogModules gives the two webpack modules of the indicator catalog: the study
//   repository (studyMetaInfoRepository, a getter of the singleton) with the built-in metadata of
//   the fixture, and requestBuiltinScripts, which answers with its standard Pine scripts. The calls
//   that send a request record themselves: requestBuiltinScripts (a request on every call) and the
//   requestMetaInfo of a repository that is not ready yet.

// The index the app gives to the rows before the first bar, and below (UNPLOTTABLE_TIME_POINT_INDEX).
const UNPLOTTABLE = -1_000_000;

export type FakePlotRow = (number | undefined)[];

export interface FakePlotItem {
  index: number;
  value: FakePlotRow;
}

export interface FakePlotList {
  size(): number;
  firstIndex(): number | null;
  lastIndex(): number | null;
  firstPlottableIndex(): number | null;
  first(): FakePlotItem | null;
  last(): FakePlotItem | null;
  valueAt(index: number): FakePlotRow | null;
  search(index: number, mode?: number): FakePlotItem | null;
  rangeIterator(from: number, to: number): IterableIterator<FakePlotItem>;
}

export interface FakeInputInfo {
  id: string;
  name: string;
  localizedName: string;
  type: string;
  defval: JsonValue;
  options?: string[];
  isHidden?: boolean;
  isFake?: boolean;
}

export interface FakeStudyMetaInfo {
  id: string;
  description: string;
  shortDescription: string;
  plots: FakeStudyPlot[];
  styles: Record<string, { title: string }>;
  ohlcPlots: Record<string, { title: string }>;
  inputs: FakeInputInfo[];
  pine?: { version: string; digest: string };
  scriptIdPart?: string;
  isTVScript?: boolean;
}

export interface FakeStudyCore {
  id(): string;
  metaInfo(): FakeStudyMetaInfo;
  data(): FakePlotList;
  isStudyStrategy?: true;
}

export interface FakeStudyApi {
  title(): string;
  isVisible(): boolean;
  getInputsInfo(): FakeInputInfo[];
  getInputValues(): { id: string; value: JsonValue }[];
  study(): FakeStudyCore;
}

export interface FakeStudies {
  getAllStudies(): { id: string; name: string }[];
  getStudyById(id: string): FakeStudyApi;
}

const roundPrice = (price: number): number => Math.round(price * 100) / 100;

// A plot of the metadata of a study, which has a target only when it targets something.
export interface FakeStudyPlot {
  id: string;
  type: string;
  target?: string;
}

// The plots of a study, with a plot id standing for a line.
function plotsOf(study: FixtureStudy): FakeStudyPlot[] {
  return study.plots.map((plot) =>
    typeof plot === 'string'
      ? { id: plot, type: 'line' }
      : {
          id: plot.id,
          type: plot.type,
          ...(plot.target === undefined ? {} : { target: plot.target }),
        },
  );
}

// The inputs of a study as the app holds them: the hidden internals of a Pine study first, then
// the inputs of the fixture, whose value is the default value of the metadata as well.
function inputsOf(study: FixtureStudy): { info: FakeInputInfo; value: JsonValue }[] {
  const internals: { info: FakeInputInfo; value: JsonValue }[] =
    study.pine === undefined
      ? []
      : [
          ['text', 'synthetic-script-blob'],
          ['pineId', study.pine.scriptIdPart],
          ['pineVersion', study.pine.version],
        ].map(([id = '', value = '']) => ({
          info: { id, name: id, localizedName: id, type: 'text', defval: value, isHidden: true },
          value,
        }));
  const own = (study.inputs ?? []).map((input) => ({
    info: {
      id: input.id,
      name: input.name,
      localizedName: input.name,
      type: input.type,
      defval: input.value,
      ...(input.options === undefined ? {} : { options: [...input.options] }),
      ...(input.isHidden === undefined ? {} : { isHidden: input.isHidden }),
      ...(study.pine === undefined ? {} : { isFake: true }),
    },
    value: input.value,
  }));
  return [...internals, ...own];
}

// The value plot `slot` of a study holds for a bar, warmup aside.
function plotValue(plot: { type: string }, slot: number, bar: SyntheticBar): number | undefined {
  if (plot.type.endsWith('colorer')) {
    return 0;
  }
  if (plot.type === 'alertcondition' || plot.type === 'dataoffset') {
    return undefined;
  }
  const ohlc = ['ohlc_open', 'ohlc_high', 'ohlc_low', 'ohlc_close'].indexOf(plot.type);
  return ohlc === -1 ? roundPrice(bar[4] + slot) : bar[ohlc + 1];
}

function createPlotList(items: readonly FakePlotItem[]): FakePlotList {
  const copy = (item: FakePlotItem | undefined): FakePlotItem | null =>
    item === undefined ? null : { index: item.index, value: [...item.value] };
  const search = (index: number, mode = 0): FakePlotItem | null => {
    if (mode < 0) {
      return copy(items.findLast((item) => item.index <= index));
    }
    if (mode > 0) {
      return copy(items.find((item) => item.index >= index));
    }
    return copy(items.find((item) => item.index === index));
  };
  return {
    size: () => items.length,
    firstIndex: () => items[0]?.index ?? null,
    lastIndex: () => items.at(-1)?.index ?? null,
    firstPlottableIndex: () => items.find((item) => item.index > UNPLOTTABLE)?.index ?? null,
    first: () => copy(items[0]),
    last: () => copy(items.at(-1)),
    valueAt: (index) => search(index)?.value ?? null,
    search,
    *rangeIterator(from, to) {
      for (const item of items) {
        if (item.index >= from && item.index <= to) {
          yield { index: item.index, value: [...item.value] };
        }
      }
    },
  };
}

export function createFakeStudies(
  fixture: TvStateFixture,
  bars: () => readonly SyntheticBar[],
): FakeStudies {
  const step = fixture.bars.stepSeconds;

  const rowsOf = (study: FixtureStudy): FakePlotItem[] => {
    const plots = plotsOf(study);
    const loaded = bars();
    const first = loaded[0];
    const preHistory = first === undefined ? 0 : (study.preHistory ?? 0);
    const before = Array.from({ length: preHistory }, (_, position): FakePlotItem => {
      const back = preHistory - position;
      const bar: SyntheticBar = [first?.[0] ?? 0, 0, 0, 0, first?.[4] ?? 0, 0];
      return {
        index: UNPLOTTABLE - back,
        value: [bar[0] - back * step, ...plots.map((plot, slot) => plotValue(plot, slot, bar))],
      };
    });
    const plottable = loaded.map((bar, index): FakePlotItem => ({
      index,
      value: [
        bar[0],
        ...plots.map((plot, slot) => {
          const value = plotValue(plot, slot, bar);
          const warm = index >= (study.warmup ?? 0);
          return warm || value === undefined || plot.type.endsWith('colorer') ? value : NaN;
        }),
      ],
    }));
    return [...before, ...plottable];
  };

  const apiOf = (study: FixtureStudy): FakeStudyApi => {
    const inputs = inputsOf(study);
    const metaInfo = (): FakeStudyMetaInfo => ({
      id:
        study.pine === undefined
          ? `${study.name}@tv-basicstudies`
          : `Script$${study.pine.scriptIdPart}@tv-scripting`,
      description: study.name,
      shortDescription: study.title ?? study.name,
      plots: plotsOf(study),
      styles: Object.fromEntries(
        Object.entries(study.styles ?? {}).map(([id, title]) => [id, { title }]),
      ),
      ohlcPlots: Object.fromEntries(
        Object.entries(study.ohlcPlots ?? {}).map(([id, title]) => [id, { title }]),
      ),
      inputs: inputs.map(({ info }) => structuredClone(info)),
      ...(study.pine === undefined
        ? {}
        : {
            pine: { version: study.pine.version, digest: 'synthetic-digest' },
            scriptIdPart: study.pine.scriptIdPart,
            isTVScript: true,
          }),
    });
    const core: FakeStudyCore = {
      id: () => study.id,
      metaInfo,
      data: () => createPlotList(rowsOf(study)),
    };
    if (study.strategy === true) {
      Object.assign(core, {
        isStudyStrategy: true,
        strategyOrdersPaneView: () => null,
        ordersData: () => null,
        reportData: () => null,
      });
    }
    return {
      title: () => study.title ?? study.name,
      isVisible: () => study.visible ?? true,
      getInputsInfo: () => inputs.map(({ info }) => structuredClone(info)),
      getInputValues: () => inputs.map(({ info, value }) => ({ id: info.id, value })),
      study: () => core,
    };
  };

  const apis = new Map(fixture.studies.map((study) => [study.id, apiOf(study)]));
  return {
    getAllStudies: () => fixture.studies.map(({ id, name }) => ({ id, name })),
    getStudyById(id) {
      const api = apis.get(id);
      if (api === undefined) {
        throw new Error('There is no such study');
      }
      return api;
    },
  };
}

export interface FakeStudyCatalogOptions {
  // Whether the study repository has its metadata already (isReady). Default true, as on the app
  // once a chart has loaded. One that is not ready requests it in findAllJavaStudies.
  repositoryReady: boolean;
  // A message requestBuiltinScripts rejects with, as when the request fails. Default: it answers.
  builtinScriptsError: string | undefined;
  record: (name: string, args: readonly unknown[]) => void;
}

export function createStudyCatalogModules(
  catalog: TvStateFixture['studyCatalog'],
  options: FakeStudyCatalogOptions,
): Record<string, Record<string, unknown>> {
  const metaInfo = catalog.builtins.map((item) => ({
    id: item.id,
    description: item.description,
    shortDescription: item.shortDescription,
    description_localized: item.description,
    ...(item.hidden === true ? { is_hidden_study: true } : {}),
    is_price_study: false,
    version: 1,
    inputs: [],
    plots: [],
  }));
  let ready = options.repositoryReady;
  const repository = {
    isReady: () => ready,
    // The live array of the app, filled once the metadata has arrived.
    getInternalMetaInfoArray: () => (ready ? metaInfo : []),
    requestMetaInfo() {
      options.record('studyMetaInfoRepository.requestMetaInfo', []);
      ready = true;
      return Promise.resolve();
    },
    async findAllJavaStudies() {
      if (!ready) {
        await repository.requestMetaInfo();
      }
      return metaInfo;
    },
  };
  return {
    // Module IDs are arbitrary numbers, as in a production build.
    '46014': { studyMetaInfoRepository: () => repository },
    '93622': {
      requestBuiltinScripts() {
        options.record('requestBuiltinScripts', []);
        if (options.builtinScriptsError !== undefined) {
          return Promise.reject(new Error(options.builtinScriptsError));
        }
        return Promise.resolve(
          catalog.standardScripts.map(({ kind, ...item }) => ({ ...item, extra: { kind } })),
        );
      },
    },
  };
}
