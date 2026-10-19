import { isDeepStrictEqual } from 'node:util';
import type { JsonObject, JsonValue } from '../../src/utils/json.js';
import { parseTvStateFixture, type TvStateFixture } from '../../test/helpers/fake-tv/fixture.js';
import { syntheticBars, type SyntheticBar } from '../../test/helpers/fake-tv/synthetic-bars.js';

// Turns a recording of the user's chart into a fixture that may be committed (design spec 10): no
// personal data, the identity of NASDAQ:AAPL instead of the recorded symbol, and synthetic prices
// instead of recorded ones, which are licensed market data. Everything is rebuilt from an
// allowlist, so a field the recording gains in a later build is left out rather than copied.

export const FIXTURE_LAYOUT_NAME = 'Fixture Layout';
export const FIXTURE_LAYOUT_ID = 'FIXTURE1';
// The seed of the committed fixtures, so a recording reproduces their price series.
export const FIXTURE_SEED = 42;
export const FIXTURE_SYMBOL = 'NASDAQ:AAPL';
// What the chart tab of TradingView Desktop shows as its title. A recorded title can name the
// symbol, its price and the layout instead.
export const FIXTURE_CHART_TITLE =
  'Live stock, index, futures, Forex and Bitcoin charts on TradingView';

// The fields a fixture is made of. Anything else in a recording, such as the user object, the
// login state or an account, is dropped with it.
const FIXTURE_FIELDS = [
  'buildTime',
  'symbol',
  'resolution',
  'chartType',
  'visibleRange',
  'studies',
  'shapes',
  'layout',
  'intervals',
  'symbolInfo',
  'quote',
  'bars',
] as const;

// What symbolInfo() says about NASDAQ:AAPL, for every field that tells one symbol from another.
const AAPL_IDENTITY: JsonObject = {
  name: 'AAPL',
  base_name: ['NASDAQ:AAPL'],
  full_name: 'NASDAQ:AAPL',
  pro_name: 'NASDAQ:AAPL',
  exchange: 'NASDAQ',
  listed_exchange: 'NASDAQ',
  exchange_listed_name: 'NASDAQ',
  description: 'Apple Inc.',
  short_description: 'Apple Inc.',
  type: 'stock',
  typespecs: ['common'],
  country: 'US',
  currency_code: 'USD',
  currency_id: 'USD',
  isin: 'US0378331005',
  'isin-displayed': 'US0378331005',
  figi: { 'country-composite': 'BBG000B9XRY4' },
  language: 'en',
  legs: ['NASDAQ:AAPL'],
  aliases: [],
  alternatives: [],
  pro_perm: '',
  delay: 0,
  pricescale: 100,
  minmov: 1,
  minmove2: 0,
  pointvalue: 1,
  fractional: false,
  variable_tick_size: '',
  source_id: 'NASDAQ',
  source2: {
    country: 'US',
    description: 'Nasdaq Stock Market',
    'exchange-type': 'exchange',
    id: 'NASDAQ',
    name: 'Nasdaq Stock Market',
    url: 'nasdaq.com',
  },
  timezone: 'America/New_York',
  session: '0930-1600',
  session_display: '0930-1600',
  session_holidays: '',
  subsession_id: 'regular',
  subsessions: [
    {
      description: 'Regular Trading Hours',
      id: 'regular',
      private: false,
      session: '0930-1600',
      'session-display': '0930-1600',
    },
  ],
};

// Fields of symbolInfo() that say how the data is built, not which symbol it is, kept as recorded.
const TECHNICAL_SYMBOL_FIELDS = new Set([
  'allowed_adjustment',
  'bar_fillgaps',
  'bar_source',
  'bar_transform',
  'has_adjustment',
  'has_extended_hours',
  'has_intraday',
  'is-tickbars-available',
  'is_replayable',
  'is_tradable',
  'measure',
  'provider_id',
  'visible_plots_set',
]);

// Built-in studies by the name the chart gives them. A Pine script on the chart is named by its
// author, so any other name is replaced.
const BUILT_IN_STUDIES = new Set([
  'Average Directional Index',
  'Average True Range',
  'Bollinger Bands',
  'Commodity Channel Index',
  'Ichimoku Cloud',
  'MACD',
  'Moving Average',
  'Moving Average Exponential',
  'Moving Average Simple',
  'On Balance Volume',
  'Parabolic SAR',
  'Relative Strength Index',
  'Stochastic',
  'Stochastic RSI',
  'Supertrend',
  'Volume',
  'Volume Weighted Average Price',
  'Williams %R',
]);

// The names of drawing tools are snake_case types such as trend_line. Anything else may be text.
const TOOL_NAME = /^[a-z][a-z0-9_]*$/;

const BID_SIZE = 100;
const ASK_SIZE = 200;
// One cent either side of the last price.
const SPREAD = 0.01;

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function list(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function finite(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// A two-digit number for the made-up ids, which keeps them sorting in their recorded order.
function counter(index: number): string {
  return String(index + 1).padStart(2, '0');
}

// The times of the recorded bars, oldest first. Only the time of a row is read; its prices are
// never copied anywhere.
function recordedTimes(bars: JsonValue | undefined): number[] {
  const times: number[] = [];
  for (const row of list(bars)) {
    const time = Array.isArray(row) ? finite(row[0]) : undefined;
    if (time !== undefined) {
      times.push(time);
    }
  }
  return times.sort((a, b) => a - b);
}

// A series of synthetic bars as long as the recording, starting at its first time and as far apart
// as its closest bars, which is one bar of its timeframe: the gaps of a trading calendar
// (nights, weekends, holidays) are wider.
function syntheticSeries(times: readonly number[]): SyntheticBar[] {
  const [first] = times;
  if (first === undefined) {
    return [];
  }
  let step = Number.POSITIVE_INFINITY;
  for (let index = 1; index < times.length; index += 1) {
    const gap = (times[index] ?? first) - (times[index - 1] ?? first);
    if (gap > 0 && gap < step) {
      step = gap;
    }
  }
  return syntheticBars({
    count: times.length,
    startTime: first,
    stepSeconds: Number.isFinite(step) ? step : 86_400,
    seed: FIXTURE_SEED,
  });
}

// The index of the first recorded bar at or after `time`, kept within the bars. The chart reports
// a range in its own time base (the day of a daily bar at 00:00 UTC), which can be hours before
// the time of the bar, so the bar at or after the time is the bar the range starts or ends on.
function barAtOrAfter(times: readonly number[], time: number): number {
  const index = times.findIndex((barTime) => barTime >= time);
  return index === -1 ? times.length - 1 : index;
}

// The recorded visible range, moved onto the synthetic bars at the same places. A range that
// reaches past the last bar ends on it, since a fixture has nothing after its last bar.
function scrubVisibleRange(
  range: JsonValue | undefined,
  times: readonly number[],
  bars: readonly SyntheticBar[],
): JsonObject {
  const from = isObject(range) ? finite(range.from) : undefined;
  const to = isObject(range) ? finite(range.to) : undefined;
  const timeAt = (index: number): number => bars[index]?.[0] ?? 0;
  if (bars.length === 0 || from === undefined || to === undefined) {
    return { from: 0, to: 0 };
  }
  const start = barAtOrAfter(times, from);
  const end = Math.max(barAtOrAfter(times, to), start);
  return { from: timeAt(start), to: timeAt(end) };
}

function scrubSymbolInfo(info: JsonValue | undefined): JsonObject {
  const scrubbed: JsonObject = {};
  if (!isObject(info)) {
    return { ...AAPL_IDENTITY };
  }
  for (const [key, value] of Object.entries(info)) {
    const identity = AAPL_IDENTITY[key];
    if (identity !== undefined) {
      scrubbed[key] = structuredClone(identity);
    } else if (TECHNICAL_SYMBOL_FIELDS.has(key)) {
      scrubbed[key] = structuredClone(value);
    }
  }
  return scrubbed;
}

// A quote made from the last two synthetic bars, in the fields the committed fixtures use. The
// other fields of a recorded quote (fundamentals among them) are dropped.
function syntheticQuote(bars: readonly SyntheticBar[]): JsonObject {
  const last = bars.at(-1);
  if (last === undefined) {
    return {};
  }
  const previous = bars.at(-2) ?? last;
  const [time, open, high, low, close, volume] = last;
  const previousClose = previous[4];
  return {
    last_price: close,
    bid: round2(close - SPREAD),
    ask: round2(close + SPREAD),
    bid_size: BID_SIZE,
    ask_size: ASK_SIZE,
    change: round2(close - previousClose),
    change_percent: round2(((close - previousClose) / previousClose) * 100),
    open_price: open,
    high_price: high,
    low_price: low,
    prev_close_price: previousClose,
    volume,
    lp_time: time,
    currency_code: 'USD',
  };
}

function scrubStudies(studies: JsonValue | undefined): JsonValue[] {
  return list(studies).map((study, index): JsonObject => {
    const { name, plots } = isObject(study) ? study : {};
    return {
      id: `STUDY${counter(index)}`,
      name:
        typeof name === 'string' && BUILT_IN_STUDIES.has(name)
          ? name
          : `Study ${String(index + 1)}`,
      plots: list(plots).filter((plot): plot is string => typeof plot === 'string'),
    };
  });
}

// A drawing keeps its type and nothing else: its text, points and properties are the user's.
function scrubShapes(shapes: JsonValue | undefined): JsonValue[] {
  return list(shapes).map((shape, index): JsonObject => {
    const name = isObject(shape) ? shape.name : undefined;
    return {
      id: `SHAPE${counter(index)}`,
      name: typeof name === 'string' && TOOL_NAME.test(name) ? name : 'shape',
    };
  });
}

function scrubLayout(layout: JsonValue | undefined): JsonObject {
  const { type, chartsCount } = isObject(layout) ? layout : {};
  return {
    type: typeof type === 'string' ? type : 's',
    chartsCount: finite(chartsCount) ?? 1,
    name: FIXTURE_LAYOUT_NAME,
    id: FIXTURE_LAYOUT_ID,
  };
}

// A recording made safe to commit. `raw` is what the recorder read from the chart tab: the chart
// state, the symbol info, the quote and the bars as rows. The result has the same fields with the
// layout named Fixture Layout (FIXTURE1), drawings reduced to their types, studies by built-in name
// only, the identity of NASDAQ:AAPL, the bars replaced by syntheticBars with the fixture seed and as
// many bars as were recorded, a quote made from those bars, and no other field.
export function scrubFixture(raw: JsonObject): JsonObject {
  const times = recordedTimes(raw.bars);
  const bars = syntheticSeries(times);
  const fields: Record<(typeof FIXTURE_FIELDS)[number], JsonValue> = {
    buildTime: typeof raw.buildTime === 'string' ? raw.buildTime : '',
    symbol: FIXTURE_SYMBOL,
    resolution: typeof raw.resolution === 'string' ? raw.resolution : '1D',
    chartType: finite(raw.chartType) ?? 1,
    visibleRange: scrubVisibleRange(raw.visibleRange, times, bars),
    studies: scrubStudies(raw.studies),
    shapes: scrubShapes(raw.shapes),
    layout: scrubLayout(raw.layout),
    intervals: list(raw.intervals).filter((interval) => typeof interval === 'string'),
    symbolInfo: scrubSymbolInfo(raw.symbolInfo),
    quote: syntheticQuote(bars),
    bars,
  };
  return Object.fromEntries(FIXTURE_FIELDS.map((field) => [field, fields[field]]));
}

// The symbols the fake window accepts besides the fixture's own, as in the committed fixture. A
// recording cannot say which symbols exist, so a fixture made from one gets these.
const KNOWN_SYMBOLS = [
  'NASDAQ:AAPL',
  'NASDAQ:MSFT',
  'NASDAQ:NVDA',
  'NYSE:IBM',
  'BINANCE:BTCUSDT',
  'FX:EURUSD',
];

// A scrubbed recording in the form of the fixtures under test/fixtures/tv/, which hold the bars as
// the spec syntheticBars expands, so that no price is committed. The bars must be the synthetic
// ones scrubFixture made, which the spec reproduces exactly: anything else is refused, so a
// recording cannot reach a fixture without being scrubbed. The result is checked against the
// fixture schema, which rejects any field the fake does not know.
export function toStateFixture(scrubbed: JsonObject): TvStateFixture {
  const rows = list(scrubbed.bars);
  const timeOf = (index: number): number | undefined => {
    const row = rows[index];
    return Array.isArray(row) ? finite(row[0]) : undefined;
  };
  const startTime = timeOf(0) ?? 0;
  const second = timeOf(1);
  const spec = {
    count: rows.length,
    startTime,
    stepSeconds: second === undefined ? 86_400 : second - startTime,
    seed: FIXTURE_SEED,
  };
  if (!isDeepStrictEqual(syntheticBars(spec), rows)) {
    throw new Error(
      'The bars are not the synthetic bars of the fixture seed. Pass the recording through ' +
        'scrubFixture first.',
    );
  }
  return parseTvStateFixture({ ...scrubbed, knownSymbols: KNOWN_SYMBOLS, bars: spec });
}

// The random part of the instance id the window chrome carries in its address and title, such as
// c0ffee12 in c0ffee12-tvd:tabbed-window.
const INSTANCE_ID = /[0-9a-f]{6,}-tvd/g;
const CHART_URL = /^https:\/\/([a-z0-9-]+\.)?tradingview\.com\/chart\//;

// A target list of /json/list made safe to commit: the layout id replaced by FIXTURE1 wherever it
// appears (it is made of letters and digits, so encoding leaves it as it is), the title of a chart
// tab replaced by the one the app shows, the instance id of the window chrome replaced by
// "fixture", and the debugger addresses dropped, since a fake server fills them in itself.
export function scrubTargets(targets: readonly JsonValue[], layoutId: string): JsonValue[] {
  const clean = (text: string): string => {
    const withoutLayout = layoutId === '' ? text : text.split(layoutId).join(FIXTURE_LAYOUT_ID);
    return withoutLayout.replace(INSTANCE_ID, 'fixture-tvd');
  };
  return targets.filter(isObject).map((target): JsonObject => {
    const url = typeof target.url === 'string' ? target.url : '';
    const title = typeof target.title === 'string' ? target.title : '';
    const scrubbed: JsonObject = {
      id: typeof target.id === 'string' ? target.id : '',
      type: typeof target.type === 'string' ? target.type : '',
      title: target.type === 'page' && CHART_URL.test(url) ? FIXTURE_CHART_TITLE : clean(title),
      url: clean(url),
    };
    if (typeof target.parentId === 'string') {
      scrubbed.parentId = target.parentId;
    }
    return scrubbed;
  });
}

// The texts among `needles` that still occur in `value`, ignoring case: a last check before a
// fixture is written. Texts of fewer than three characters are skipped, because they occur in
// ordinary words.
export function findLeaks(value: JsonValue, needles: readonly string[]): string[] {
  const text = JSON.stringify(value).toLowerCase();
  const found = new Set<string>();
  for (const needle of needles) {
    const trimmed = needle.trim();
    if (trimmed.length >= 3 && text.includes(trimmed.toLowerCase())) {
      found.add(trimmed);
    }
  }
  return [...found];
}
