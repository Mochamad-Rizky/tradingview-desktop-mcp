import { isTvMcpError } from '../../../src/core/errors.js';
import type { TvMcpError } from '../../../src/core/errors.js';
import { parseTimeInput, toIso } from '../../../src/utils/time.js';

// Pin a zone that is neither UTC nor a whole number of hours from it. A parser that falls back on
// the local clock for an offset-less date-time would pass on a CI runner set to UTC and only break
// on a developer machine, so this makes the mistake visible everywhere.
beforeAll(() => {
  vi.stubEnv('TZ', 'Asia/Kolkata');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

function rejectionOf(input: string | number): TvMcpError {
  try {
    parseTimeInput(input);
  } catch (error) {
    if (isTvMcpError(error)) {
      return error;
    }
    throw error;
  }
  throw new Error(`expected ${JSON.stringify(input)} to be rejected`);
}

test('parseTimeInput accepts Unix seconds', () => {
  expect(parseTimeInput(1700000000)).toBe(1700000000);
});

test('parseTimeInput accepts zero, the Unix epoch', () => {
  expect(parseTimeInput(0)).toBe(0);
  expect(parseTimeInput('0')).toBe(0);
});

test('parseTimeInput treats values above 1e11 as milliseconds', () => {
  expect(parseTimeInput(1700000000000)).toBe(1700000000);
});

test('parseTimeInput switches from seconds to milliseconds just above 1e11', () => {
  expect(parseTimeInput(1e11)).toBe(1e11);
  expect(parseTimeInput(1e11 + 1)).toBe(1e8);
});

test('parseTimeInput truncates fractions of a second', () => {
  expect(parseTimeInput(1700000000.9)).toBe(1700000000);
  expect(parseTimeInput(1700000000999)).toBe(1700000000);
  expect(parseTimeInput(1700000000999.9)).toBe(1700000000);
  expect(parseTimeInput('2023-11-14T22:13:20.999Z')).toBe(1700000000);
});

test.each([
  ['1700000000', 1700000000],
  ['1700000000000', 1700000000],
  ['1700000000.5', 1700000000],
  ['  1700000000  ', 1700000000],
])('parseTimeInput reads the numeric string %j as a timestamp', (text, seconds) => {
  expect(parseTimeInput(text)).toBe(seconds);
});

test('parseTimeInput honors ISO offsets', () => {
  expect(parseTimeInput('2023-11-14T22:13:20Z')).toBe(1700000000);
  expect(parseTimeInput('2023-11-15T05:13:20+07:00')).toBe(1700000000);
});

test.each([
  '2023-11-14T22:13:20.000Z',
  '2023-11-14T17:13:20-05:00',
  '2023-11-15T05:13:20+0700',
  '2023-11-15T05:13:20+07',
  '2023-11-15T03:43:20+05:30',
])('parseTimeInput reads %s as the same instant as 1700000000', (text) => {
  expect(parseTimeInput(text)).toBe(1700000000);
});

test('parseTimeInput reads a date-only string as midnight UTC', () => {
  expect(parseTimeInput('2024-01-31')).toBe(1706659200);
});

test('parseTimeInput reads a date-time without an offset as UTC', () => {
  expect(parseTimeInput('2024-01-31T10:00:00')).toBe(1706695200);
  expect(parseTimeInput('2024-01-31T10:00')).toBe(1706695200);
  expect(parseTimeInput('2024-01-31T10:00:00')).toBe(parseTimeInput('2024-01-31T10:00:00Z'));
});

test('parseTimeInput ignores whitespace around an ISO string', () => {
  expect(parseTimeInput(' 2024-01-31T10:00:00Z\n')).toBe(1706695200);
});

// A date before 1970 is a negative timestamp. A negative number is refused as a likely mistake,
// but a date that was spelled out is deliberate, and charts do hold prices from before 1970.
test('parseTimeInput accepts dates before 1970 written as ISO 8601', () => {
  expect(parseTimeInput('1969-12-31')).toBe(-86400);
  // The fraction belongs to the second that is already running, so it floors to the earlier one.
  expect(parseTimeInput('1969-12-31T23:59:59.500Z')).toBe(-1);
});

// Date.UTC would read the year 99 as 1999, which no range check would notice.
test('parseTimeInput keeps years below 100 as written', () => {
  expect(parseTimeInput('0099-01-01')).toBe(-59042995200);
});

test('parseTimeInput accepts 29 February only in leap years', () => {
  expect(parseTimeInput('2024-02-29')).toBe(1709164800);
  expect(parseTimeInput('2000-02-29')).toBe(951782400);
  expect(rejectionOf('2023-02-29').code).toBe('INVALID_INPUT');
  expect(rejectionOf('1900-02-29').code).toBe('INVALID_INPUT');
});

test('parseTimeInput accepts the last representable second and no later one', () => {
  expect(parseTimeInput('9999-12-31T23:59:59Z')).toBe(253402300799);
  expect(parseTimeInput(253402300799999)).toBe(253402300799);
  expect(rejectionOf(253402300800000).code).toBe('INVALID_INPUT');
  // A negative offset puts the instant later than the written clock time, which can carry it
  // over the same limit.
  expect(rejectionOf('9999-12-31T23:59:59-01:00').code).toBe('INVALID_INPUT');
});

test('parseTimeInput rejects garbage with INVALID_INPUT', () => {
  const error = rejectionOf('yesterday-ish');

  expect(error.code).toBe('INVALID_INPUT');
  // The value is quoted so that a typo stands out.
  expect(error.message).toContain('"yesterday-ish"');
});

test('parseTimeInput lists the accepted forms in the hint', () => {
  const hint = rejectionOf('yesterday-ish').hint;

  expect(hint).toContain('ISO 8601');
  expect(hint).toContain('2024-01-31T10:00:00Z');
  expect(hint).toContain('Unix timestamp');
  expect(hint).toContain('UTC');
});

test.each([
  ['an empty string', ''],
  ['only whitespace', '   '],
  ['month 13', '2024-13-01'],
  ['month 00', '2024-00-10'],
  ['day 00', '2024-01-00'],
  ['day 32', '2024-01-32'],
  ['31 April', '2024-04-31'],
  ['hour 24', '2024-01-31T24:00:00Z'],
  ['minute 60', '2024-01-31T10:60:00Z'],
  ['second 60', '2024-01-31T10:00:60Z'],
  ['an offset of 24 hours', '2024-01-31T10:00:00+24:00'],
  ['an offset of 60 minutes', '2024-01-31T10:00:00+07:60'],
  ['unpadded fields', '2024-1-31'],
  ['slashes', '2024/01/31'],
  ['a day-first date', '31-01-2024'],
  ['month names', 'Jan 31 2024'],
  ['an hour without minutes', '2024-01-31T10'],
  ['a space where the T belongs', '2024-01-31 10:00:00'],
  ['a lowercase t', '2024-01-31t10:00:00Z'],
  ['a fraction without digits', '2024-01-31T10:00:00.Z'],
  ['text after the date', '2024-01-31abc'],
  ['an offset on a date without a time', '2024-01-31Z'],
  ['an exponent', '1e9'],
  ['a hexadecimal number', '0x10'],
  ['a signed number', '-5'],
  ['the word Infinity', 'Infinity'],
  ['the word NaN', 'NaN'],
])('parseTimeInput rejects %s', (_label, text) => {
  const error = rejectionOf(text);

  expect(error.code).toBe('INVALID_INPUT');
  expect(error.hint).toContain('ISO 8601');
});

test.each([
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
  ['a negative number of seconds', -1],
  ['a negative number of milliseconds', -1700000000000],
  ['a number beyond the year 9999', 253402300800000],
  ['the largest finite number', Number.MAX_VALUE],
])('parseTimeInput rejects %s', (_label, value) => {
  const error = rejectionOf(value);

  expect(error.code).toBe('INVALID_INPUT');
  // The message shows the number itself, where JSON would have printed NaN and Infinity as null.
  expect(error.message).toContain(String(value));
  expect(error.hint).toContain('Unix timestamp');
});

test('toIso formats Unix seconds as an ISO 8601 UTC string ending in Z', () => {
  expect(toIso(1700000000)).toBe('2023-11-14T22:13:20Z');
  expect(toIso(0)).toBe('1970-01-01T00:00:00Z');
  expect(toIso(-86400)).toBe('1969-12-31T00:00:00Z');
});

test('toIso drops fractions of a second so the format never changes', () => {
  expect(toIso(1700000000.75)).toBe('2023-11-14T22:13:20Z');
  expect(toIso(-0.5)).toBe('1969-12-31T23:59:59Z');
});

test('toIso throws a RangeError for values that no date can hold', () => {
  expect(() => toIso(Number.NaN)).toThrow(RangeError);
  expect(() => toIso(1e300)).toThrow(RangeError);
});

test.each([0, 1, 1700000000, 1706659200, 253402300799])(
  'parseTimeInput reads back what toIso wrote for %s',
  (seconds) => {
    expect(parseTimeInput(toIso(seconds))).toBe(seconds);
  },
);
