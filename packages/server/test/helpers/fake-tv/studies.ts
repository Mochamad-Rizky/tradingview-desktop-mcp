import type { JsonValue } from '../../../src/utils/json.js';
import type { FixtureStudy, FixtureStudyInput, TvStateFixture } from './fixture.js';
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
//   the own flag isStudyStrategy and the members the duck test of the app looks for. It also has
//   hasCompileError() (whether the script of a Pine study failed to compile) and logs(): null for a
//   study whose script writes no Pine logs, else a set like the PrimitiveSet of the app (forEach,
//   values(), the iterator and size; entries() and keys() throw, as on the app) of the log items
//   { barTime, time, level, source: { start, end }, message } of the fixture.
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
//
// The studies change (notes, section 7), and every change records itself:
//
// - createStudy(nameOrDescriptor, forceOverlay, lock, inputs, overrides, options) adds a study and
//   resolves its id. A name is the description of a built-in, compared lower case, and the FIRST
//   match counts, hidden built-ins included; no match rejects "unexpected study id:<name>". With
//   options.checkLimit it asks canCreateStudy, and when that fails (forecast aside) the app shows
//   its "too many studies" warning, recorded as dialog.tooManyStudies, and resolves null. A
//   descriptor ({ type: "java", studyId } or { type: "pine", pineId, pineVersion }) ignores every
//   other argument and always asks canCreateStudy: a failure for the general limit opens the
//   paywall (dialog.paywall) and rejects "Failed to create study". It opens the inputs dialog of
//   the app (dialog.studyInputs) for the studies that need one, Overlay, CorrelationCoefficient,
//   Correlation Coeff, Spread and Ratio of tv-basicstudies or a study with a confirm input, and
//   then waits for a person forever. A Pine id the fixture has no standard script for, or a java
//   id it has no built-in for, rejects with the insertion error cannot_get_metainfo. A new study
//   gets the inputs of its built-in or script, with their default values, and an id NEW001,
//   NEW002 and so on.
// - canCreateStudy({ id }) is pure: it fails with reason general and the limit as limitValue when
//   the studies that count have reached INDICATORS_ON_CHART of the plan limits. Studies the app
//   does not count (Volume, the volume profiles and a few more) always pass and never count.
// - removeEntity(id, options) removes a study, undoable unless options.disableUndo (removed lists
//   each removal); an id that is not on the chart does nothing, as the app only warns.
// - The study API has setInputValues([{ id, value }]), which sets the value of each input it has
//   and passes over other ids, and setVisible(visible).
//
// - addUserScript({ name, scriptIdPart, version, compileError }) adds the study of a user script,
//   the way the Pine Editor adds the script it holds (pine-editor.ts), and answers its id. It is
//   not a member of the chart API.
//
// Nothing here opens a dialog: the members that would on the app record a dialog.* call instead,
// so that a test can show that the server never got there.

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
  min?: number;
  max?: number;
  confirm?: boolean;
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
  hasCompileError(): boolean;
  logs(): FakeLogSet | null;
  isStudyStrategy?: true;
}

// A Pine log item as logs() holds it.
export interface FakePineLog {
  barTime: number;
  time: number;
  level: string;
  source: { start: { line: number; column: number }; end: { line: number; column: number } };
  message: string;
}

// The PrimitiveSet of the app, as far as the fake models it.
export interface FakeLogSet extends Iterable<FakePineLog> {
  readonly size: number;
  forEach(callback: (item: FakePineLog) => void): void;
  values(): IterableIterator<FakePineLog>;
  entries(): never;
  keys(): never;
}

export interface FakeStudyApi {
  title(): string;
  isVisible(): boolean;
  getInputsInfo(): FakeInputInfo[];
  getInputValues(): { id: string; value: JsonValue }[];
  setInputValues(values: { id: string; value: unknown }[]): void;
  setVisible(visible: boolean): void;
  study(): FakeStudyCore;
}

export type FakeStudyDescriptor =
  { type: 'java'; studyId: string } | { type: 'pine'; pineId: string; pineVersion: string };

export interface FakeCanCreateStudy {
  success: boolean;
  reason?: string;
  limitValue?: number;
}

export interface FakeStudies {
  getAllStudies(): { id: string; name: string }[];
  getStudyById(id: string): FakeStudyApi;
  createStudy(
    nameOrDescriptor: string | FakeStudyDescriptor,
    forceOverlay?: boolean,
    lock?: boolean,
    inputs?: unknown,
    overrides?: unknown,
    options?: { checkLimit?: boolean },
  ): Promise<string | null>;
  removeEntity(id: string, options?: { disableUndo?: boolean }): void;
  canCreateStudy(spec: { id: string }): FakeCanCreateStudy;
  addUserScript(script: {
    name: string;
    scriptIdPart: string;
    version: string;
    compileError: boolean;
  }): string;
}

// What createFakeStudies needs besides the fixture: the recorder of the window, the check
// createStudy asks (the canCreateStudy of the chart model, which a test can replace), and the list
// each removal is noted in.
export interface FakeStudiesOptions {
  record: (name: string, args: readonly unknown[]) => void;
  canCreateStudy: (spec: { id: string }) => FakeCanCreateStudy | undefined;
  removed: { id: string; undoable: boolean }[];
}

// The built-in studies that never count against the indicator limit of the plan (notes, section
// 7).
const UNCOUNTED_STUDIES = new Set(
  [
    'Volume',
    'Compare',
    'Overlay',
    'Dividends',
    'Earnings',
    'Splits',
    'Sessions',
    'InactivityGaps',
    'AnchoredVWAP',
    'RegressionTrend',
    'LongShortPosition',
  ]
    .map((name) => `${name}@tv-basicstudies`)
    .concat(
      ['VbPAnchored', 'VbPFixed', 'VbPSessionsRough'].map((name) => `${name}@tv-volumebyprice`),
      ['BarSetContinuousRollDates@tv-corestudies', 'ReplayStrategy@tv-scripting'],
    ),
);

// The studies whose descriptor makes the app ask for their inputs in a dialog.
const DIALOG_STUDIES = new Set(
  ['Overlay', 'CorrelationCoefficient', 'Correlation Coeff', 'Spread', 'Ratio'].map(
    (name) => `${name}@tv-basicstudies`,
  ),
);

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
      ...(input.min === undefined ? {} : { min: input.min }),
      ...(input.max === undefined ? {} : { max: input.max }),
      ...(input.confirm === undefined ? {} : { confirm: input.confirm }),
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

// The set logs() answers, built anew on every call from the logs of the fixture.
function createLogSet(logs: NonNullable<FixtureStudy['logs']>): FakeLogSet {
  const items = logs.map(({ barTime, time, level, message, line = 1 }): FakePineLog => ({
    barTime,
    time,
    level,
    source: { start: { line, column: 1 }, end: { line, column: 1 } },
    message,
  }));
  const values = (): IterableIterator<FakePineLog> =>
    items.map((item) => ({ ...item }))[Symbol.iterator]();
  return {
    size: items.length,
    forEach(callback) {
      for (const item of values()) {
        callback(item);
      }
    },
    values,
    [Symbol.iterator]: values,
    entries() {
      throw new Error('Method not implemented.');
    },
    keys() {
      throw new Error('Method not implemented.');
    },
  };
}

export function createFakeStudies(
  fixture: TvStateFixture,
  bars: () => readonly SyntheticBar[],
  options: FakeStudiesOptions,
): FakeStudies {
  const step = fixture.bars.stepSeconds;
  const { builtins, standardScripts } = fixture.studyCatalog;

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

  // The API of a study whose metadata has the id metaId. Its visibility and the values of its
  // inputs change with setVisible and setInputValues.
  const apiOf = (study: FixtureStudy, metaId: string): FakeStudyApi => {
    const inputs = inputsOf(study);
    let visible = study.visible ?? true;
    const metaInfo = (): FakeStudyMetaInfo => ({
      id: metaId,
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
      hasCompileError: () => study.compileError === true,
      logs: () => (study.logs === undefined ? null : createLogSet(study.logs)),
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
      isVisible: () => visible,
      getInputsInfo: () => inputs.map(({ info }) => structuredClone(info)),
      getInputValues: () => inputs.map(({ info, value }) => ({ id: info.id, value })),
      setInputValues(values) {
        options.record('study.setInputValues', [study.id, values]);
        for (const { id, value } of values) {
          const input = inputs.find(({ info }) => info.id === id);
          if (input !== undefined) {
            input.value = value as JsonValue;
          }
        }
      },
      setVisible(shown) {
        options.record('study.setVisible', [study.id, shown]);
        visible = shown;
      },
      study: () => core,
    };
  };

  // The studies on the chart, in the order the app lists them, each with the id of its metadata.
  const entries: { study: FixtureStudy; metaId: string; api: FakeStudyApi }[] = [];
  const add = (study: FixtureStudy, metaId?: string): string => {
    const id =
      metaId ??
      (study.pine === undefined
        ? `${study.name}@tv-basicstudies`
        : `Script$${study.pine.scriptIdPart}@tv-scripting`);
    entries.push({ study, metaId: id, api: apiOf(study, id) });
    return study.id;
  };
  for (const study of fixture.studies) {
    add(study);
  }
  let added = 0;
  const nextId = (): string => {
    added += 1;
    return `NEW${String(added).padStart(3, '0')}`;
  };
  const addBuiltin = (builtin: (typeof builtins)[number]): string =>
    add(
      {
        id: nextId(),
        name: builtin.description,
        title: builtin.shortDescription,
        plots: [],
        ...(builtin.inputs === undefined ? {} : { inputs: structuredClone(builtin.inputs) }),
      },
      builtin.id,
    );
  const addScript = (script: (typeof standardScripts)[number], version: string): string =>
    add({
      id: nextId(),
      name: script.scriptName,
      title: script.scriptTitle ?? script.scriptName,
      plots: [],
      pine: {
        scriptIdPart: script.scriptIdPart,
        version: version === 'last' ? script.version : version,
      },
      ...(script.kind === 'strategy' ? { strategy: true } : {}),
      ...(script.inputs === undefined ? {} : { inputs: structuredClone(script.inputs) }),
    });

  const canCreateStudy = (spec: { id: string }): FakeCanCreateStudy => {
    const id = typeof spec.id === 'string' ? spec.id : '';
    if (UNCOUNTED_STUDIES.has(id)) {
      return { success: true };
    }
    const limit = fixture.planLimits.INDICATORS_ON_CHART;
    const counted = entries.filter(({ metaId }) => !UNCOUNTED_STUDIES.has(metaId)).length;
    return limit !== undefined && counted >= limit
      ? { success: false, reason: 'general', limitValue: limit }
      : { success: true };
  };

  return {
    addUserScript: ({ name, scriptIdPart, version, compileError }) =>
      add({ id: nextId(), name, plots: [], pine: { scriptIdPart, version }, compileError }),
    getAllStudies: () => entries.map(({ study: { id, name } }) => ({ id, name })),
    getStudyById(id) {
      const entry = entries.find(({ study }) => study.id === id);
      if (entry === undefined) {
        throw new Error('There is no such study');
      }
      return entry.api;
    },
    canCreateStudy,
    createStudy(...args) {
      options.record('chart.createStudy', args);
      const [nameOrDescriptor, , , , , createOptions] = args;
      if (typeof nameOrDescriptor === 'string') {
        const wanted = nameOrDescriptor.toLowerCase();
        const builtin = builtins.find(({ description }) => description.toLowerCase() === wanted);
        if (builtin === undefined) {
          return Promise.reject(new Error(`unexpected study id:${wanted}`));
        }
        if (createOptions?.checkLimit === true) {
          const check = options.canCreateStudy({ id: builtin.id });
          if (check !== undefined && !check.success && check.reason !== 'forecast') {
            options.record('dialog.tooManyStudies', [check.limitValue]);
            return Promise.resolve(null);
          }
        }
        return Promise.resolve(addBuiltin(builtin));
      }
      const descriptor = nameOrDescriptor;
      const studyId = descriptor.type === 'java' ? descriptor.studyId : '';
      const check = options.canCreateStudy({ id: studyId });
      if (check !== undefined && !check.success) {
        if (check.reason === 'general') {
          options.record('dialog.paywall', ['studyLimit']);
        }
        // The app rejects with a string here, not an Error.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        return Promise.reject('Failed to create study');
      }
      // What the descriptor stands for: its inputs, and how a study of it is added.
      const builtin =
        descriptor.type === 'java' ? builtins.find(({ id }) => id === studyId) : undefined;
      const script =
        descriptor.type === 'pine'
          ? standardScripts.find(({ scriptIdPart }) => scriptIdPart === descriptor.pineId)
          : undefined;
      const known =
        builtin !== undefined
          ? { inputs: builtin.inputs, insert: () => addBuiltin(builtin) }
          : script !== undefined && descriptor.type === 'pine'
            ? { inputs: script.inputs, insert: () => addScript(script, descriptor.pineVersion) }
            : undefined;
      if (known === undefined) {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        return Promise.reject('cannot_get_metainfo');
      }
      if (DIALOG_STUDIES.has(studyId) || (known.inputs ?? []).some(({ confirm }) => confirm)) {
        options.record('dialog.studyInputs', [
          descriptor.type === 'java' ? studyId : descriptor.pineId,
        ]);
        // The dialog waits for a person, who never comes.
        return new Promise<never>(() => undefined);
      }
      return Promise.resolve(known.insert());
    },
    removeEntity(id, removeOptions) {
      options.record(
        'chart.removeEntity',
        removeOptions === undefined ? [id] : [id, removeOptions],
      );
      const index = entries.findIndex(({ study }) => study.id === id);
      if (index === -1) {
        // The app only warns: "Can't find a source with id".
        return;
      }
      entries.splice(index, 1);
      options.removed.push({ id, undoable: removeOptions?.disableUndo !== true });
    },
  };
}

// The inputs of a built-in as its metadata holds them.
function metaInputsOf(inputs: FixtureStudyInput[] | undefined): Record<string, JsonValue>[] {
  return (inputs ?? []).map(({ value, ...rest }) => ({
    ...structuredClone(rest),
    defval: value,
  })) as Record<string, JsonValue>[];
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
    inputs: metaInputsOf(item.inputs),
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
          // The inputs are what a study of the script gets on the chart, not part of the list.
          catalog.standardScripts.map(
            ({ scriptIdPart, scriptName, scriptTitle, version, kind }) => ({
              scriptIdPart,
              scriptName,
              ...(scriptTitle === undefined ? {} : { scriptTitle }),
              version,
              extra: { kind },
            }),
          ),
        );
      },
    },
  };
}
