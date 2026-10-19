import { isTvMcpError, type TvMcpError } from '../../../../src/core/errors.js';
import {
  CHART_TYPE_NAMES,
  CHART_TYPE_NAMES_BY_ID,
  CHART_TYPES,
  chartTypeName,
  normalizeTimeframe,
  sameResolution,
  sameSymbol,
  toTimeRange,
} from '../../../../src/tools/chart/mappers.js';
import { toIso } from '../../../../src/utils/time.js';

// How the chart tools translate between what a client writes and what TradingView takes: the
// timeframe aliases, the names of the chart types, and the times a page reports.

function rejectionOf(input: string): TvMcpError {
  try {
    normalizeTimeframe(input);
  } catch (error) {
    if (isTvMcpError(error)) {
      return error;
    }
    throw error;
  }
  throw new Error(`expected ${JSON.stringify(input)} to be rejected`);
}

describe('normalizeTimeframe', () => {
  // Every alias the tool documents, with the resolution string TradingView takes for it.
  const DOCUMENTED_ALIASES: [string, string][] = [
    ['1m', '1'],
    ['1min', '1'],
    ['15m', '15'],
    ['1h', '60'],
    ['4h', '240'],
    ['1d', '1D'],
    ['D', '1D'],
    ['1w', '1W'],
    ['1M', '1M'],
    ['30s', '30S'],
    ['100T', '100T'],
    ['1000R', '1000R'],
  ];

  test('normalizeTimeframe maps documented aliases', () => {
    for (const [input, expected] of DOCUMENTED_ALIASES) {
      expect(normalizeTimeframe(input), input).toBe(expected);
    }
  });

  // The one place where case changes the meaning: TradingView writes months with an uppercase M,
  // and people write minutes with a lowercase one.
  test('normalizeTimeframe distinguishes minutes from months', () => {
    expect(normalizeTimeframe('1m')).toBe('1');
    expect(normalizeTimeframe('1M')).toBe('1M');
    expect(normalizeTimeframe('3m')).toBe('3');
    expect(normalizeTimeframe('3M')).toBe('3M');
    expect(normalizeTimeframe('m')).toBe('1');
    expect(normalizeTimeframe('M')).toBe('1M');
  });

  test('normalizeTimeframe rejects 7x with INVALID_INPUT', () => {
    const error = rejectionOf('7x');

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('"7x"');
    expect(error.details).toEqual({ timeframe: '7x' });
    // The hint lists the forms that are accepted, so a client can correct itself in one step.
    for (const form of ['15m', '4h', '1D', '1W', '3M', '30S', '100T', '1000R']) {
      expect(error.hint, form).toContain(form);
    }
    expect(error.hint).toMatch(/lowercase m is minutes and uppercase M is months/i);
  });

  test.each([
    ['a plain number of minutes', '60', '60'],
    ['TradingView resolutions as they are', '240', '240'],
    ['an uppercase H for hours', '4H', '240'],
    ['an uppercase D with a count', '2D', '2D'],
    ['an uppercase W', 'W', '1W'],
    ['an uppercase S', '5S', '5S'],
    ['a lowercase w with a count', '2w', '2W'],
    ['a lowercase d alone', 'd', '1D'],
    ['a unit of hours alone', 'h', '60'],
    ['seconds alone', 's', '1S'],
    ['ticks alone', 'T', '1T'],
    ['ranges alone', 'R', '1R'],
    ['minutes spelled min alone', 'min', '1'],
    ['leading zeros', '015m', '15'],
    ['surrounding whitespace', ' 1h ', '60'],
    ['many hours', '24h', '1440'],
  ])('normalizeTimeframe accepts %s', (_case, input, expected) => {
    expect(normalizeTimeframe(input)).toBe(expected);
  });

  test.each([
    ['nothing', ''],
    ['only whitespace', '   '],
    ['a zero count', '0'],
    ['a zero count with a unit', '0m'],
    ['a fraction', '1.5h'],
    ['a negative count', '-1'],
    ['a space between count and unit', '1 h'],
    ['the unit in front', 'm1'],
    ['years', '1y'],
    ['a spelled-out unit', '1hour'],
    ['min with a capital', '1Min'],
    ['lowercase ticks', '100t'],
    ['lowercase ranges', '10r'],
    ['two units', '1h30m'],
    ['a count beyond five digits', '100000'],
  ])('normalizeTimeframe rejects %s', (_case, input) => {
    expect(rejectionOf(input).code).toBe('INVALID_INPUT');
  });
});

describe('sameResolution', () => {
  test.each([
    ['1D', 'D'],
    ['D', '1D'],
    ['60', '1h'],
    ['1W', 'W'],
    ['15', '15'],
    // Something TradingView reports in a form this server does not know is compared as written.
    ['odd', 'odd'],
  ])('sameResolution treats %s and %s as one resolution', (a, b) => {
    expect(sameResolution(a, b)).toBe(true);
  });

  test.each([
    ['60', '240'],
    ['1', '1M'],
    ['odd', '1D'],
    ['1D', 'odd'],
  ])('sameResolution tells %s from %s', (a, b) => {
    expect(sameResolution(a, b)).toBe(false);
  });
});

describe('sameSymbol', () => {
  test.each([
    ['the same symbol', 'NASDAQ:AAPL', 'NASDAQ:AAPL'],
    ['another case', 'nasdaq:aapl', 'NASDAQ:AAPL'],
    ['a bare ticker and the same ticker after an exchange', 'AAPL', 'NASDAQ:AAPL'],
    ['the same, the other way round', 'NASDAQ:AAPL', 'aapl'],
    ['surrounding whitespace', ' AAPL ', 'NASDAQ:AAPL'],
    ['a ticker with a suffix', 'BTCUSDT.P', 'BINANCE:BTCUSDT.P'],
  ])('sameSymbol takes %s for one instrument', (_case, a, b) => {
    expect(sameSymbol(a, b)).toBe(true);
  });

  test.each([
    ['other tickers', 'NASDAQ:MSFT', 'NASDAQ:AAPL'],
    ['one ticker on two exchanges', 'BMV:AAPL', 'NASDAQ:AAPL'],
    ['a bare ticker and another qualified one', 'MSFT', 'NASDAQ:AAPL'],
    ['a bare ticker that is only part of the other', 'AAP', 'NASDAQ:AAPL'],
  ])('sameSymbol tells apart %s', (_case, a, b) => {
    expect(sameSymbol(a, b)).toBe(false);
  });
});

describe('chart types', () => {
  test('CHART_TYPES holds the chart style ids of TradingView', () => {
    expect(CHART_TYPES).toStrictEqual({
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
    });
  });

  test('chartTypeName round-trips CHART_TYPES', () => {
    for (const [name, id] of Object.entries(CHART_TYPES)) {
      expect(chartTypeName(id), name).toBe(name);
    }
  });

  test.each([11, 17, -1, 1.5, Number.NaN])('chartTypeName calls the id %s unknown', (id) => {
    expect(chartTypeName(id)).toBe('unknown');
  });

  test('CHART_TYPE_NAMES lists every name once, in the order of the ids', () => {
    expect(CHART_TYPE_NAMES).toEqual(Object.keys(CHART_TYPES));
  });

  // What a page function gets to name a type: JSON, so the ids are keys.
  test('CHART_TYPE_NAMES_BY_ID maps every id, as text, to its name', () => {
    expect(Object.keys(CHART_TYPE_NAMES_BY_ID)).toHaveLength(Object.keys(CHART_TYPES).length);
    for (const [name, id] of Object.entries(CHART_TYPES)) {
      expect(CHART_TYPE_NAMES_BY_ID[String(id)], name).toBe(name);
    }
  });
});

describe('toTimeRange', () => {
  test('toTimeRange gives Unix seconds and ISO strings', () => {
    expect(toTimeRange(1721433600, 1729987200)).toStrictEqual({
      from: 1721433600,
      to: 1729987200,
      fromIso: '2024-07-20T00:00:00Z',
      toIso: '2024-10-27T00:00:00Z',
    });
    expect(toIso(1721433600)).toBe('2024-07-20T00:00:00Z');
  });

  test.each([
    ['a missing start', null, 1729987200],
    ['a missing end', 1721433600, null],
    ['NaN', Number.NaN, 1729987200],
    ['an infinity', 1721433600, Number.POSITIVE_INFINITY],
    ['text', '1721433600', 1729987200],
    ['a time no date can hold', 1721433600, 1e13],
    // What getVisibleRange answers while the chart has no range: while a symbol loads, and for a
    // symbol TradingView could not find.
    ['the empty range of a chart without data', 0, 0],
  ])('toTimeRange gives null for %s', (_case, from, to) => {
    expect(toTimeRange(from, to)).toBeNull();
  });
});
