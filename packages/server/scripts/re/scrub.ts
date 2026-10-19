import { isDeepStrictEqual } from 'node:util';
import { classifyTarget, type TargetKind } from '../../src/core/cdp/targets.js';
import type { JsonObject, JsonValue } from '../../src/utils/json.js';
import { parseTvStateFixture, type TvStateFixture } from '../../test/helpers/fake-tv/fixture.js';
import { syntheticBars, type SyntheticBar } from '../../test/helpers/fake-tv/synthetic-bars.js';

// Turns a recording of the user's chart into a fixture that may be committed (design spec 10): no
// personal data, the identity of NASDAQ:AAPL instead of the recorded symbol, and synthetic prices
// instead of recorded ones, which are licensed market data. Everything is rebuilt from an
// allowlist, so a field the recording gains in a later build is left out rather than copied:
// - scrubFixture keeps the build time, the timeframe, the chart type, the type of each drawing, the
//   name of each built-in study with its plot ids, the layout type and chart count, the interval
//   list and the symbol info fields that say nothing about which symbol it is. It writes the
//   fixture's own layout name and id, symbol, symbol identity, ids, bars and quote.
// - scrubTargets keeps the id, the type and the parent id of each target; it writes a fixed title
//   per kind of target, and an address of which only the scheme, the host and, for some targets,
//   the path survive (see scrubAddress).
// - findLeaks is the last check of the recorder: no recorded identifying text may survive, whether
//   written plainly, percent-encoded or HTML-escaped.

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

// The recorded bars, oldest first: the time in each row, and the time the chart reports for the bar
// when the recording has it (publicTimes, in the order of the rows). Only times are read; the prices
// of a row are never copied anywhere.
interface RecordedBar {
  time: number;
  reported: number | undefined;
}

function recordedBars(
  bars: JsonValue | undefined,
  publicTimes: JsonValue | undefined,
): RecordedBar[] {
  const reported = list(publicTimes);
  const recorded: RecordedBar[] = [];
  list(bars).forEach((row, index) => {
    const time = Array.isArray(row) ? finite(row[0]) : undefined;
    if (time !== undefined) {
      recorded.push({ time, reported: finite(reported[index]) });
    }
  });
  return recorded.sort((a, b) => a.time - b.time);
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

// The index of the recorded bar a time of the chart's visible range falls on, kept within the bars.
// The chart reports a range in its own time base: a daily bar is its day at 00:00 UTC, which can lie
// hours after the start of the session in the row (a session that starts the day before in UTC) or
// hours before it (13:30 UTC for a US stock), so only the times the chart reports for the bars
// tell for sure. With them, the bar whose reported time is nearest is taken, the earlier on a tie.
// A recording without them is searched by its rows for the first bar at or after the time, which
// is right for every session that starts on the bar's own day in UTC.
function barOfRangeTime(bars: readonly RecordedBar[], time: number): number {
  const reported = bars.map((bar) => bar.reported);
  if (reported.every((value): value is number => value !== undefined)) {
    let nearest = 0;
    reported.forEach((value, index) => {
      if (Math.abs(value - time) < Math.abs((reported[nearest] ?? value) - time)) {
        nearest = index;
      }
    });
    return nearest;
  }
  const index = bars.findIndex((bar) => bar.time >= time);
  return index === -1 ? bars.length - 1 : index;
}

// The recorded visible range, moved onto the synthetic bars at the same places. A range that
// reaches past the last bar ends on it, since a fixture has nothing after its last bar.
function scrubVisibleRange(
  range: JsonValue | undefined,
  recorded: readonly RecordedBar[],
  bars: readonly SyntheticBar[],
): JsonObject {
  const from = isObject(range) ? finite(range.from) : undefined;
  const to = isObject(range) ? finite(range.to) : undefined;
  const timeAt = (index: number): number => bars[index]?.[0] ?? 0;
  if (bars.length === 0 || from === undefined || to === undefined) {
    return { from: 0, to: 0 };
  }
  const start = barOfRangeTime(recorded, from);
  const end = Math.max(barOfRangeTime(recorded, to), start);
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
// state, the symbol info, the quote, the bars as rows and, in publicTimes, the time the chart
// reports for each of them (used only to place the visible range). The result has the same fields
// with the layout named Fixture Layout (FIXTURE1), drawings reduced to their types, studies by
// built-in name only, the identity of NASDAQ:AAPL, the bars replaced by syntheticBars with the
// fixture seed and as many bars as were recorded, a quote made from those bars, and no other field.
export function scrubFixture(raw: JsonObject): JsonObject {
  const recorded = recordedBars(raw.bars, raw.publicTimes);
  const bars = syntheticSeries(recorded.map((bar) => bar.time));
  const fields: Record<(typeof FIXTURE_FIELDS)[number], JsonValue> = {
    buildTime: typeof raw.buildTime === 'string' ? raw.buildTime : '',
    symbol: FIXTURE_SYMBOL,
    resolution: typeof raw.resolution === 'string' ? raw.resolution : '1D',
    chartType: finite(raw.chartType) ?? 1,
    visibleRange: scrubVisibleRange(raw.visibleRange, recorded, bars),
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

// The install folder of the default macOS install, inside its app bundle. A recorded file address
// can lie under another folder (a home folder names its user), so only the part inside the bundle
// is kept and put under this one.
const APP_ROOT = 'file:///Applications/TradingView.app/Contents/Resources/app.asar/';
// The address of the window chrome holds data for its renderer; a fixture keeps only an instance id
// of its own.
const WINDOW_DATA = '{"remoteServiceInstanceId":"fixture-tvd:tabbed-window"}';
const WINDOW_QUERY = `?rendererInitialData=${encodeURIComponent(WINDOW_DATA)}`;
// What the window chrome shows as its title: the file and its data, with the quotes escaped.
export const FIXTURE_WINDOW_TITLE = `index.html${WINDOW_QUERY.replaceAll('%22', '&quot;')}`;
const FIXTURE_CHART_URL = `https://www.tradingview.com/chart/${FIXTURE_LAYOUT_ID}/`;
const TRADINGVIEW_HOST = /(^|\.)tradingview\.com$/;

// The title a target of each kind gets. A recorded title can show what the page shows, such as a
// symbol, a price or the name of a layout or of a person, so none is kept.
const TITLES: Readonly<Record<TargetKind, string>> = {
  chart: FIXTURE_CHART_TITLE,
  'window-chrome': FIXTURE_WINDOW_TITLE,
  helper: 'index.html',
  blank: '',
  other: '',
};

// The address of a target, rebuilt from what a fixture may hold:
// - the chart tab: the fixture chart address, with the layout id FIXTURE1;
// - the window chrome: its file in the default install folder, with the fixture data;
// - another file: the same file in the default install folder, without query or fragment, or the
//   bare scheme when it lies outside an app bundle;
// - a web address: the scheme and the host, and the path only for a frame inside the chart page (ad
//   and anti-abuse frames, whose paths are generic) and not on a TradingView host; any other page,
//   a TradingView page such as a profile among them, keeps the root path. Query and fragment, which
//   carry the data of a page, are always dropped;
// - an empty address stays empty, about:blank stays as it is, and any other scheme keeps only its
//   name, since what follows it can be the content itself.
function scrubAddress(url: string, kind: TargetKind, type: string): string {
  if (url === '' || url === 'about:blank') {
    return url;
  }
  if (kind === 'chart') {
    return FIXTURE_CHART_URL;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }
  if (parsed.protocol === 'file:') {
    const inBundle = /\/app\.asar\/(.*)$/.exec(parsed.pathname)?.[1];
    if (inBundle === undefined) {
      return 'file:///';
    }
    return `${APP_ROOT}${inBundle}${kind === 'window-chrome' ? WINDOW_QUERY : ''}`;
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    const keepsPath = type === 'iframe' && !TRADINGVIEW_HOST.test(parsed.hostname);
    return `${parsed.protocol}//${parsed.host}${keepsPath ? parsed.pathname : '/'}`;
  }
  return parsed.protocol;
}

// A target list of /json/list made safe to commit, rebuilt from an allowlist: of each target its
// id, type and parent id are kept (random ids the app gives), its address is rebuilt by
// scrubAddress, and its title is the fixed one of its kind. Everything else, the debugger addresses
// among it, is dropped, and no recorded layout id can survive in the rebuilt addresses.
export function scrubTargets(targets: readonly JsonValue[]): JsonValue[] {
  return targets.filter(isObject).map((target): JsonObject => {
    const id = typeof target.id === 'string' ? target.id : '';
    const type = typeof target.type === 'string' ? target.type : '';
    const url = typeof target.url === 'string' ? target.url : '';
    const kind = classifyTarget({ id, type, title: '', url });
    const scrubbed: JsonObject = {
      id,
      type,
      title: TITLES[kind],
      url: scrubAddress(url, kind, type),
    };
    if (typeof target.parentId === 'string') {
      scrubbed.parentId = target.parentId;
    }
    return scrubbed;
  });
}

// `text` with percent-encoding undone (twice, for an address inside an address) and the HTML
// entities a title can carry replaced, so that a recorded text is found however it was written.
function decoded(text: string): string {
  let plain = text;
  for (let round = 0; round < 2; round += 1) {
    plain = plain.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
  }
  return plain
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

// The texts among `needles` that still occur in `value`: a last check before a fixture is written.
// The value is searched as it is and with its encodings undone. A text of three characters or more
// counts wherever it occurs, ignoring case; a shorter one, such as the ticker GE, only as a whole
// word of letters and digits written the same way, so that it is not found inside other words.
export function findLeaks(value: JsonValue, needles: readonly string[]): string[] {
  const raw = JSON.stringify(value);
  const plain = decoded(raw);
  const haystacks = [raw.toLowerCase(), plain.toLowerCase()];
  const words = new Set(plain.split(/[^A-Za-z0-9]+/));
  const found = new Set<string>();
  for (const needle of needles) {
    const trimmed = needle.trim();
    if (trimmed === '') {
      continue;
    }
    const leaked =
      trimmed.length >= 3
        ? haystacks.some((haystack) => haystack.includes(trimmed.toLowerCase()))
        : words.has(trimmed);
    if (leaked) {
      found.add(trimmed);
    }
  }
  return [...found];
}
