import { TvMcpError } from '../core/errors.js';

// Numbers above this are Unix milliseconds and the rest are seconds (design spec 5.1). As seconds
// it is the year 5138 and as milliseconds it is March 1973, so a timestamp for any date after 1973
// is read correctly whichever unit it is in. The price is that milliseconds for an earlier date
// would be read as seconds.
const MILLISECONDS_ABOVE = 1e11;

// 9999-12-31T23:59:59Z, the last second with a four-digit year. Date prints later ones with an
// expanded year such as +010000, which parseTimeInput does not read back.
const MAX_UNIX_SECONDS = 253_402_300_799;

const ACCEPTED_FORMS_HINT =
  'Use an ISO 8601 date or date-time, for example 2024-01-31 or 2024-01-31T10:00:00Z, or a Unix ' +
  'timestamp in seconds or milliseconds. A date or date-time without an offset is read as UTC.';

// Digits only. A bare number is a timestamp even when it looks like a year ("2024") or a compact
// date ("20240131"); dates must be written with hyphens.
const NUMERIC_PATTERN = /^\d+(?:\.\d+)?$/;

// Only these shapes are read. Date.parse accepts many looser ones as well, such as "2024-1-5" or
// even "1", and reads them as local time.
const DATE = String.raw`(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})`;
const CLOCK = String.raw`T(?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2})(?:\.\d+)?)?`;
const OFFSET = String.raw`(?:Z|(?<sign>[+-])(?<offsetHour>\d{2})(?::?(?<offsetMinute>\d{2}))?)`;
const ISO_PATTERN = new RegExp(`^${DATE}(?:${CLOCK}${OFFSET}?)?$`);

function invalid(input: string | number, reason: string): never {
  // A string is quoted so that a typo or stray whitespace stands out. A number is printed as it
  // is, because JSON would turn NaN and Infinity into null.
  const shown = typeof input === 'string' ? JSON.stringify(input) : String(input);
  throw new TvMcpError('INVALID_INPUT', `Invalid time ${shown}: ${reason}`, {
    hint: ACCEPTED_FORMS_HINT,
  });
}

function clockSeconds(hours: number, minutes: number, seconds = 0): number {
  return hours * 3600 + minutes * 60 + seconds;
}

function checkRange(seconds: number, input: string | number): number {
  return seconds > MAX_UNIX_SECONDS ? invalid(input, 'it is later than the year 9999') : seconds;
}

function fromTimestamp(value: number, input: string | number): number {
  if (!Number.isFinite(value)) {
    return invalid(input, 'it is not a finite number');
  }
  // A negative number is nearly always a slip, such as a bad subtraction or a -1 placeholder. A
  // date before 1970 is still possible to ask for, as an ISO 8601 string.
  if (value < 0) {
    return invalid(input, 'a Unix timestamp cannot be negative');
  }
  return checkRange(Math.floor(value > MILLISECONDS_ABOVE ? value / 1000 : value), input);
}

// Without an offset a date-time is UTC, not the local time of this machine as in Date.parse:
// TradingView reports bar times in UTC, so the same input must mean the same bar everywhere.
function fromIso(text: string, input: string): number {
  const groups = ISO_PATTERN.exec(text)?.groups;
  if (groups === undefined) {
    return invalid(input, 'it is neither an ISO 8601 date nor a Unix timestamp');
  }
  // A part that was left out reads as zero. A fraction of a second is not captured at all: the
  // seconds of the clock are whole, so ignoring it floors the result, also before 1970.
  const field = (name: string): number => Number(groups[name] ?? 0);
  const year = field('year');
  const month = field('month');
  const day = field('day');
  const hour = field('hour');
  const minute = field('minute');
  const second = field('second');
  const offsetHour = field('offsetHour');
  const offsetMinute = field('offsetMinute');

  // Built by hand instead of with Date.parse, for two reasons: V8 rolls an impossible day such as
  // 31 February over into March instead of refusing it, and Date.UTC maps the years 0 to 99 onto
  // 1900 to 1999. The roll-over is what gives an impossible day away: it moves the month, so a
  // month that differs from the one written means the date does not exist.
  const midnight = new Date(0);
  midnight.setUTCFullYear(year, month - 1, day);
  const exists =
    midnight.getUTCMonth() === month - 1 &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59;
  if (!exists) {
    return invalid(input, 'that date or time does not exist');
  }

  const direction = groups.sign === '-' ? -1 : 1;
  const offset = direction * clockSeconds(offsetHour, offsetMinute);
  return checkRange(midnight.getTime() / 1000 + clockSeconds(hour, minute, second) - offset, input);
}

// Returns Unix seconds. Throws INVALID_INPUT for anything that is not a time: a clear error is
// better than a guess, because a wrong bar range would look like a real answer.
export function parseTimeInput(input: string | number): number {
  if (typeof input === 'number') {
    return fromTimestamp(input, input);
  }
  const text = input.trim();
  return NUMERIC_PATTERN.test(text) ? fromTimestamp(Number(text), input) : fromIso(text, input);
}

// Throws a RangeError for a value that no Date can hold. That is a bug in the caller, which
// formats times that came from TradingView or passed parseTimeInput, so it is not an input error.
export function toIso(seconds: number): string {
  // toISOString always prints milliseconds. Flooring first makes them a constant ".000" that can
  // be dropped, so the output has one format whatever the input.
  return new Date(Math.floor(seconds) * 1000).toISOString().replace('.000Z', 'Z');
}
