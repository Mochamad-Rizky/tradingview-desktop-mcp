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
      scriptTitle?: string | undefined;
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
}

export interface FixtureStudyPlot {
  id: string;
  type: string;
  target?: string | undefined;
}

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
        scriptTitle: z.string().optional(),
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
