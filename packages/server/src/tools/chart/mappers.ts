import { TvMcpError } from '../../core/errors.js';
import { toIso } from '../../utils/time.js';

// How the chart tools translate between what a client writes and what TradingView takes or
// reports: timeframe aliases, chart type names, and times.

// A count of up to five digits and a unit, or either of them alone. Only m and M differ by case;
// the other units are the letters TradingView shows (H, D, W, S, T, R), and h, d, w and s are
// accepted next to them because people write units in lower case. min is tried before m.
const TIMEFRAME_PATTERN = /^(\d{1,5})?(min|m|h|H|d|D|w|W|M|s|S|T|R)?$/;

// What each unit becomes in the resolution string of TradingView: minutes are a bare number, hours
// are counted in minutes, and the other units keep a suffix.
const UNITS: ReadonlyMap<string, { suffix: string; minutes: number }> = new Map([
  ['', { suffix: '', minutes: 1 }],
  ['m', { suffix: '', minutes: 1 }],
  ['min', { suffix: '', minutes: 1 }],
  ['h', { suffix: '', minutes: 60 }],
  ['H', { suffix: '', minutes: 60 }],
  ['d', { suffix: 'D', minutes: 1 }],
  ['D', { suffix: 'D', minutes: 1 }],
  ['w', { suffix: 'W', minutes: 1 }],
  ['W', { suffix: 'W', minutes: 1 }],
  ['M', { suffix: 'M', minutes: 1 }],
  ['s', { suffix: 'S', minutes: 1 }],
  ['S', { suffix: 'S', minutes: 1 }],
  ['T', { suffix: 'T', minutes: 1 }],
  ['R', { suffix: 'R', minutes: 1 }],
]);

export const TIMEFRAME_FORMS =
  'Use a number of minutes such as 1, 15 or 240, or a count and a unit: m or min for minutes ' +
  '(15m), h or H for hours (4h is 240), d or D for days (1D), w or W for weeks (1W), M for months ' +
  '(3M), s or S for seconds (30S), T for ticks (100T) and R for ranges (1000R). A unit alone counts ' +
  'one (D is 1D). Lowercase m is minutes and uppercase M is months.';

// The resolution string for a timeframe, or null when the text is not one.
function parseTimeframe(input: string): string | null {
  const match = TIMEFRAME_PATTERN.exec(input.trim());
  if (match === null) {
    return null;
  }
  const [, digits, unitText = ''] = match;
  const unit = UNITS.get(unitText);
  // An empty text matches the pattern too, with neither a count nor a unit.
  if (unit === undefined || (digits === undefined && unitText === '')) {
    return null;
  }
  const count = digits === undefined ? 1 : Number(digits);
  if (count < 1) {
    return null;
  }
  return `${String(count * unit.minutes)}${unit.suffix}`;
}

// The resolution string TradingView takes for a timeframe as people write it: 1h is 60, 1d is 1D,
// 30s is 30S. Throws INVALID_INPUT, with the forms that are accepted, for anything else.
export function normalizeTimeframe(input: string): string {
  const resolution = parseTimeframe(input);
  if (resolution === null) {
    throw new TvMcpError('INVALID_INPUT', `Unknown timeframe ${JSON.stringify(input)}`, {
      hint: TIMEFRAME_FORMS,
      details: { timeframe: input },
    });
  }
  return resolution;
}

// Whether two resolution strings name one timeframe, such as D and 1D, or 60 and 1h. A string this
// server cannot read is compared as it is written, since the app may report a form it does not know.
export function sameResolution(a: string, b: string): boolean {
  return (parseTimeframe(a) ?? a) === (parseTimeframe(b) ?? b);
}

// Whether two symbols name one instrument as TradingView writes them: case does not count, and a
// bare ticker matches the same ticker after an exchange (AAPL and NASDAQ:AAPL). Two symbols that
// both name an exchange must name the same one.
export function sameSymbol(a: string, b: string): boolean {
  const left = a.trim().toUpperCase();
  const right = b.trim().toUpperCase();
  const ticker = (symbol: string): string => symbol.slice(symbol.lastIndexOf(':') + 1);
  return (
    left === right ||
    (!left.includes(':') && left === ticker(right)) ||
    (!right.includes(':') && right === ticker(left))
  );
}

// The chart style ids of TradingView by name. Id 11 is left out: it is not recorded what it is.
export const CHART_TYPES = {
  bars: 0,
  candles: 1,
  line: 2,
  area: 3,
  renko: 4,
  kagi: 5,
  point_and_figure: 6,
  line_break: 7,
  heikin_ashi: 8,
  hollow_candles: 9,
  baseline: 10,
  high_low: 12,
  columns: 13,
  line_with_markers: 14,
  step_line: 15,
  hlc_area: 16,
} as const;

export type ChartTypeName = keyof typeof CHART_TYPES;

// The names, in the order of their ids, as the tuple an enum schema takes. Object.keys loses the
// literal types, which the object itself guarantees.
export const CHART_TYPE_NAMES = Object.keys(CHART_TYPES) as [ChartTypeName, ...ChartTypeName[]];

// The names by id, with the ids as text: the form a page function gets them in, since its arguments
// cross the CDP boundary as JSON.
export const CHART_TYPE_NAMES_BY_ID: Readonly<Record<string, ChartTypeName>> = Object.fromEntries(
  CHART_TYPE_NAMES.map((name) => [String(CHART_TYPES[name]), name]),
);

// A number never prints as the name of a member every object inherits, so the lookup is safe.
export function chartTypeName(id: number): ChartTypeName | 'unknown' {
  return CHART_TYPE_NAMES_BY_ID[String(id)] ?? 'unknown';
}

// The largest number of seconds a Date can hold, either side of 1970. toIso throws beyond it.
const MAX_DATE_SECONDS = 8.64e12;

// Whether a value that came from the page is a time this server can report.
export function isReportableTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_DATE_SECONDS;
}

// A range of times as the tools report one: Unix seconds and ISO 8601 (design spec 5.1). Null when
// either end is not a time, and for the zeros getVisibleRange answers instead of a range while the
// chart has none (while a symbol loads, and for a symbol TradingView could not find; seen on the
// app), which are no range of 1970.
export function toTimeRange(
  from: unknown,
  to: unknown,
): { from: number; to: number; fromIso: string; toIso: string } | null {
  if (!isReportableTime(from) || !isReportableTime(to) || (from === 0 && to === 0)) {
    return null;
  }
  return { from, to, fromIso: toIso(from), toIso: toIso(to) };
}
