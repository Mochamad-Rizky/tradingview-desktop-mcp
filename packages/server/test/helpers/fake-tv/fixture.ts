import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { JsonValue } from '../../../src/utils/json.js';
import { fixturePath } from '../fixture-path.js';

// The state a fake TradingView window starts from, stored as JSON under test/fixtures/tv/.
// Fixtures must not carry personal data or real prices, which is why bars are a generator spec
// instead of rows.
export interface TvStateFixture {
  buildTime: string;
  symbol: string;
  resolution: string;
  chartType: number;
  visibleRange: { from: number; to: number };
  studies: FixtureStudy[];
  shapes: { id: string; name: string }[];
  layout: { type: string; chartsCount: number; name: string; id: string };
  intervals: string[];
  knownSymbols: string[];
  symbolInfo: Record<string, JsonValue>;
  quote: Record<string, JsonValue>;
  // The limits of the plan of the fake account, by plan feature name. The fake window serves them
  // through the two webpack modules that hold the plan features (plan-limits.ts). A feature not
  // listed has no limit entry: getConfig throws for it, as for an unknown value.
  planLimits: Record<string, number>;
  // The feature toggles of the app by name, which the export isFeatureEnabled answers
  // (plan-limits.ts). A toggle not listed is off.
  featureToggles: Record<string, boolean>;
  // Not stored as bars: syntheticBars() expands this spec, so fixtures hold no price data.
  bars: { count: number; startTime: number; stepSeconds: number; seed: number };
  // How far back the history of the symbol reaches: totalBars counts the loaded bars together with
  // the older ones requestMoreData can still load (history.ts), and endOfDataType is what the
  // series reports once no more can be loaded ("end" when the first bar of the symbol was reached).
  history: { totalBars: number; endOfDataType: string };
  // The quotes the caches of the app hold for symbols the chart does not show, by symbol, as their
  // values (quotes.ts): fields is the shared quote field cache (QUOTE_FIELDS_CACHE), full the
  // "full" quote session, watchlist the cache of the watchlist widget. Empty values stand for an
  // entry whose status is "error". Prices are synthetic.
  quoteCache: {
    fields: Record<string, Record<string, JsonValue>>;
    full: Record<string, Record<string, JsonValue>>;
    watchlist: Record<string, Record<string, JsonValue>>;
  };
  // What the symbol search of the app answers: the items, written with the <em> highlight markup
  // the search can put in symbol and description, and the count it says it has not returned yet.
  search: { remaining: number; symbols: Record<string, JsonValue>[] };
  // What the app knows of the indicators it can add (studies.ts): builtins are the metadata of the
  // built-in studies its study repository holds, and standardScripts the standard Pine scripts
  // that requestBuiltinScripts answers with, in the shapes the app keeps them in.
  studyCatalog: {
    builtins: {
      id: string;
      description: string;
      shortDescription: string;
      hidden?: boolean | undefined;
      // The inputs of its metadata, with their default values. None when left out.
      inputs?: FixtureStudyInput[] | undefined;
    }[];
    standardScripts: {
      scriptIdPart: string;
      scriptName: string;
      // The short name, which the app lists as extra.shortDescription (an item has no title).
      shortDescription?: string | undefined;
      version: string;
      kind: 'study' | 'strategy' | 'library';
      // The inputs a study of the script has once it is on the chart. None when left out.
      inputs?: FixtureStudyInput[] | undefined;
    }[];
  };
  // The Pine Editor of the fake app (pine-editor.ts): open is the placement it is registered under
  // when the window is built (null when closed) and opensAt the one pineEditorApi().open() gives
  // it ("dialog" stands for the side panel of the current layout). script is the saved script the
  // editor holds (null for a new script without an id), savedSource its text as opened or saved and
  // source the text in the editor, which differs from savedSource for unsaved changes. templates
  // are the texts of new scripts by type. savedScripts are the scripts of the account, which the
  // export requestUserScripts lists (without source, the text openScript loads), newest first or
  // not: modified orders them, in seconds. A version whose major part is 0 is a server draft.
  // Sources are synthetic, and the templates name an invented author.
  pineEditor: {
    open: 'dialog' | 'bottom' | null;
    opensAt: 'dialog' | 'bottom';
    script: { scriptIdPart: string; version: string } | null;
    savedSource: string;
    source: string;
    templates: { indicator: string; strategy: string; library: string };
    savedScripts: {
      scriptIdPart: string;
      scriptName: string;
      scriptTitle: string;
      version: string;
      modified: number;
      // Left out of an item as the app may leave it out.
      kind?: 'study' | 'strategy' | 'library' | undefined;
      source: string;
    }[];
  };
}

// A study on the chart (studies.ts). Optional fields admit undefined, which is what the schema
// gives for a field that is left out. A recording keeps only id, name and the ids of the plots; the
// other fields are what the fake makes of the study, with defaults for a recording:
// - plots: a plot id stands for a line plot; an object gives the type of the plot and, for a
//   colorer or an ohlc_* plot, the id it targets.
// - title: what the study API reports as its title, the name by default.
// - visible: true by default.
// - pine: the standard script or user script a Pine study runs; a study without it is a built-in.
// - strategy: a strategy (a Pine strategy needs pine as well).
// - styles: the titles of the plots, by plot id, written HTML-entity encoded as the app keeps them;
//   ohlcPlots: the titles of the bars an ohlc_* plot draws, by its target.
// - inputs: the inputs the user sees, with their values. A Pine study gets the hidden internals
//   (text, pineId, pineVersion) in front of them. An input can carry the bounds of its metadata
//   (min, max) and confirm, which makes the app ask for its value in a dialog when the study is
//   added.
// - warmup: how many of the first bars have no value yet (NaN), as a moving average has none
//   before its length; preHistory: how many rows the study keeps before the first bar, at the
//   indices of the app for them (-1e6 and below).
// - compileError: the script of a Pine study failed to compile, which hasCompileError() reports.
// - logs: what the Pine log.* calls of the script wrote, which logs() of the study core holds. Left
//   out, the script writes no logs and logs() is null; an empty list stands for a script that writes
//   logs while TradingView holds none of them (logs not enabled). barTime and time are given in the
//   unit the test wants to stage, and line is where the log call is.
// - graphics: what the script drew, which graphics() of the study core holds (pine-graphics.ts).
//   Left out, graphics() holds empty maps, as for a script that draws nothing.
// - report: the report a strategy holds, which reportData() of its study core answers (strategy.ts).
//   Left out, the strategy has no report yet and reportData() is null. Only a strategy has one.
// - activeStrategy: whether the strategy is the active strategy source of the chart, which the core
//   model reports (the first such strategy counts). Left out, none is.
export interface FixtureStudy {
  id: string;
  name: string;
  plots: (string | FixtureStudyPlot)[];
  title?: string | undefined;
  visible?: boolean | undefined;
  pine?: { scriptIdPart: string; version: string } | undefined;
  strategy?: boolean | undefined;
  styles?: Record<string, string> | undefined;
  ohlcPlots?: Record<string, string> | undefined;
  inputs?: FixtureStudyInput[] | undefined;
  warmup?: number | undefined;
  preHistory?: number | undefined;
  compileError?: boolean | undefined;
  logs?: FixtureStudyLog[] | undefined;
  graphics?: FixtureGraphics | undefined;
  report?: FixtureStrategyReport | undefined;
  activeStrategy?: boolean | undefined;
}

// The report of a strategy as its study holds it (reverse-engineering notes of Plan 2, section Q6).
// The members that are raw JSON are what the app keeps, and a test stages whatever it wants the
// tools to meet in them: numbers, numeric strings, values that are no numbers, or a shape the notes
// do not know.
// - currency: the currency member, "NONE" when the strategy has none.
// - performance: the performance member, with all, long and short and any metric at its top level.
// - trades: the trades member. The notes do not say whether the raw report has one, and in which
//   shape: the Strategy Tester of the app keeps trades with entry and exit legs.
// - filledOrders: the filled orders, with the keys the app abbreviates (id, b for buy, e false for
//   an exit, p price, q quantity, c comment). barIndex is the time-point index barsIndexes()
//   reports for the order; the fake adds the tm the app keeps.
// Each member left out is a member the report does not have.
export interface FixtureStrategyReport {
  currency: string;
  performance?: Record<string, JsonValue> | undefined;
  trades?: JsonValue | undefined;
  filledOrders?: FixtureFilledOrder[] | undefined;
}

export interface FixtureFilledOrder {
  id: string;
  b: boolean;
  e?: boolean | undefined;
  p: number;
  q: number;
  c?: string | undefined;
  barIndex: number;
}

// The drawings of a Pine study, each as the app materializes it (reverse-engineering notes of Plan
// 2, section Q5), with the style it belongs to and whether it is forced onto the price pane. x, left
// and right are time-point indexes, null for a point the app has no index for; the fields a test
// does not stage are filled in with the defaults of the fake. The app has no id for labels and
// boxes, and table cells carry the id of their table.
// - isRGB: the colors are packed integers (metaInfo().isRGB) and not indexes into the palette.
// - palette: the CSS colors of palette_common by index. Left out, the palette is missing.
export interface FixtureGraphics {
  isRGB?: boolean | undefined;
  palette?: string[] | undefined;
  lines?: FixtureLine[] | undefined;
  labels?: FixtureLabel[] | undefined;
  boxes?: FixtureBox[] | undefined;
  tables?: FixtureTable[] | undefined;
  tableCells?: FixtureTableCell[] | undefined;
}

export interface FixtureDrawing {
  styleId: string;
  forceOverlay?: boolean | undefined;
}

export interface FixtureLine extends FixtureDrawing {
  id: number;
  x1: number | null;
  y1: number;
  x2: number | null;
  y2: number;
  style: string;
  extend: string;
  width: number;
  colorIndex: number | null;
}

export interface FixtureLabel extends FixtureDrawing {
  x: number;
  y: number;
  yloc: string;
  text: string;
  style: string;
  colorIndex: number | null;
  textColorIndex: number | null;
}

export interface FixtureBox extends FixtureDrawing {
  left: number | null;
  right: number | null;
  top: number;
  bottom: number;
  extend: string;
  text: string;
  borderColorIndex: number | null;
  backgroundColorIndex: number | null;
}

// The id of a table, and the table id of a cell, can be a number or a text: the raw sets of the app
// are not known to give numbers, and its ready-made table view gives text ids.
export interface FixtureTable extends FixtureDrawing {
  id: number | string;
  position: string;
  rows: number;
  columns: number;
}

// A cell is kept by style only: the app does not group cells by forceOverlay.
export interface FixtureTableCell {
  styleId: string;
  tableId: number | string;
  row: number;
  column: number;
  text: string;
}

export interface FixtureStudyLog {
  barTime: number;
  time: number;
  level: string;
  message: string;
  line?: number | undefined;
}

export interface FixtureStudyPlot {
  id: string;
  type: string;
  target?: string | undefined;
}

// internalID is the id the app gives an input of a strategy that has a meaning of its own, such as
// initial_capital.
export interface FixtureStudyInput {
  id: string;
  name: string;
  type: string;
  value: JsonValue;
  options?: string[] | undefined;
  isHidden?: boolean | undefined;
  min?: number | undefined;
  max?: number | undefined;
  confirm?: boolean | undefined;
  internalID?: string | undefined;
}

const fixtureStudyInputSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  value: z.json(),
  options: z.array(z.string()).optional(),
  isHidden: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  confirm: z.boolean().optional(),
  internalID: z.string().optional(),
});

const fixtureStrategyReportSchema = z.strictObject({
  currency: z.string(),
  performance: z.record(z.string(), z.json()).optional(),
  trades: z.json().optional(),
  filledOrders: z
    .array(
      z.strictObject({
        id: z.string(),
        b: z.boolean(),
        e: z.boolean().optional(),
        p: z.number(),
        q: z.number(),
        c: z.string().optional(),
        barIndex: z.number(),
      }),
    )
    .optional(),
});

const drawingShape = {
  styleId: z.string(),
  forceOverlay: z.boolean().optional(),
};

const fixtureGraphicsSchema = z.strictObject({
  isRGB: z.boolean().optional(),
  palette: z.array(z.string()).optional(),
  lines: z
    .array(
      z.strictObject({
        ...drawingShape,
        id: z.number(),
        x1: z.number().nullable(),
        y1: z.number(),
        x2: z.number().nullable(),
        y2: z.number(),
        style: z.string(),
        extend: z.string(),
        width: z.number(),
        colorIndex: z.number().nullable(),
      }),
    )
    .optional(),
  labels: z
    .array(
      z.strictObject({
        ...drawingShape,
        x: z.number(),
        y: z.number(),
        yloc: z.string(),
        text: z.string(),
        style: z.string(),
        colorIndex: z.number().nullable(),
        textColorIndex: z.number().nullable(),
      }),
    )
    .optional(),
  boxes: z
    .array(
      z.strictObject({
        ...drawingShape,
        left: z.number().nullable(),
        right: z.number().nullable(),
        top: z.number(),
        bottom: z.number(),
        extend: z.string(),
        text: z.string(),
        borderColorIndex: z.number().nullable(),
        backgroundColorIndex: z.number().nullable(),
      }),
    )
    .optional(),
  tables: z
    .array(
      z.strictObject({
        ...drawingShape,
        id: z.union([z.number(), z.string()]),
        position: z.string(),
        rows: z.number(),
        columns: z.number(),
      }),
    )
    .optional(),
  tableCells: z
    .array(
      z.strictObject({
        styleId: z.string(),
        tableId: z.union([z.number(), z.string()]),
        row: z.number(),
        column: z.number(),
        text: z.string(),
      }),
    )
    .optional(),
});

// Strict, so a field a recording adds but this interface lacks fails loudly instead of being
// ignored by every fake.
const tvStateFixtureSchema: z.ZodType<TvStateFixture> = z.strictObject({
  buildTime: z.string(),
  symbol: z.string(),
  resolution: z.string(),
  chartType: z.number(),
  visibleRange: z.strictObject({ from: z.number(), to: z.number() }),
  studies: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      plots: z.array(
        z.union([
          z.string(),
          z.strictObject({ id: z.string(), type: z.string(), target: z.string().optional() }),
        ]),
      ),
      title: z.string().optional(),
      visible: z.boolean().optional(),
      pine: z.strictObject({ scriptIdPart: z.string(), version: z.string() }).optional(),
      strategy: z.boolean().optional(),
      styles: z.record(z.string(), z.string()).optional(),
      ohlcPlots: z.record(z.string(), z.string()).optional(),
      inputs: z.array(fixtureStudyInputSchema).optional(),
      warmup: z.number().optional(),
      preHistory: z.number().optional(),
      compileError: z.boolean().optional(),
      logs: z
        .array(
          z.strictObject({
            barTime: z.number(),
            time: z.number(),
            level: z.string(),
            message: z.string(),
            line: z.number().optional(),
          }),
        )
        .optional(),
      graphics: fixtureGraphicsSchema.optional(),
      report: fixtureStrategyReportSchema.optional(),
      activeStrategy: z.boolean().optional(),
    }),
  ),
  shapes: z.array(z.strictObject({ id: z.string(), name: z.string() })),
  layout: z.strictObject({
    type: z.string(),
    chartsCount: z.number(),
    name: z.string(),
    id: z.string(),
  }),
  intervals: z.array(z.string()),
  knownSymbols: z.array(z.string()),
  symbolInfo: z.record(z.string(), z.json()),
  quote: z.record(z.string(), z.json()),
  planLimits: z.record(z.string(), z.number()),
  featureToggles: z.record(z.string(), z.boolean()),
  bars: z.strictObject({
    count: z.number(),
    startTime: z.number(),
    stepSeconds: z.number(),
    seed: z.number(),
  }),
  history: z.strictObject({ totalBars: z.number(), endOfDataType: z.string() }),
  quoteCache: z.strictObject({
    fields: z.record(z.string(), z.record(z.string(), z.json())),
    full: z.record(z.string(), z.record(z.string(), z.json())),
    watchlist: z.record(z.string(), z.record(z.string(), z.json())),
  }),
  search: z.strictObject({
    remaining: z.number(),
    symbols: z.array(z.record(z.string(), z.json())),
  }),
  studyCatalog: z.strictObject({
    builtins: z.array(
      z.strictObject({
        id: z.string(),
        description: z.string(),
        shortDescription: z.string(),
        hidden: z.boolean().optional(),
        inputs: z.array(fixtureStudyInputSchema).optional(),
      }),
    ),
    standardScripts: z.array(
      z.strictObject({
        scriptIdPart: z.string(),
        scriptName: z.string(),
        shortDescription: z.string().optional(),
        version: z.string(),
        kind: z.enum(['study', 'strategy', 'library']),
        inputs: z.array(fixtureStudyInputSchema).optional(),
      }),
    ),
  }),
  pineEditor: z.strictObject({
    open: z.enum(['dialog', 'bottom']).nullable(),
    opensAt: z.enum(['dialog', 'bottom']),
    script: z.strictObject({ scriptIdPart: z.string(), version: z.string() }).nullable(),
    savedSource: z.string(),
    source: z.string(),
    templates: z.strictObject({ indicator: z.string(), strategy: z.string(), library: z.string() }),
    savedScripts: z.array(
      z.strictObject({
        scriptIdPart: z.string(),
        scriptName: z.string(),
        scriptTitle: z.string(),
        version: z.string(),
        modified: z.number(),
        kind: z.enum(['study', 'strategy', 'library']).optional(),
        source: z.string(),
      }),
    ),
  }),
});

export function parseTvStateFixture(raw: unknown): TvStateFixture {
  const result = tvStateFixtureSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid TradingView state fixture:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function loadTvFixture(name = 'chart-basic'): TvStateFixture {
  const path = fixturePath(`tv/${name}.json`);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new Error(`Cannot read the TradingView fixture "${name}" at ${path}`, { cause });
  }
  return parseTvStateFixture(JSON.parse(text) as unknown);
}
