import {
  logTimeToSeconds,
  mergeConsoleMessages,
  normalizeCompileErrors,
  toCompileResult,
} from '../../../../src/tools/pine/mappers.js';

// How the compile errors and the console of the Pine Editor become what the Pine tools return.
// Sources and messages are synthetic.

const CRLF_SOURCE = '//@version=6\r\nindicator("Unit")\r\nplot(undeclared_x)\r\n';

test('compile errors keep 1-based positions for CRLF sources', () => {
  const raw = {
    errors: [
      {
        message: 'Undeclared identifier "{identifier}"',
        ctx: { identifier: 'undeclared_x' },
        start: { line: 3, column: 6 },
        end: { line: 3, column: 17 },
      },
    ],
    warnings: [],
  };

  expect(normalizeCompileErrors(raw, CRLF_SOURCE)).toEqual({
    errors: [
      {
        line: 3,
        column: 6,
        endLine: 3,
        endColumn: 17,
        message: 'Undeclared identifier "undeclared_x"',
        severity: 'error',
      },
    ],
    warnings: [],
  });
});

// Columns count UTF-16 code units, as JavaScript strings and Monaco do: these pin that unit, so that
// a server that counted otherwise (bytes, code points, tab stops) would show up as a failure here
// and in the E2E check of the same texts.
test('columns count UTF-16 code units: a tab, a non-ASCII letter and an emoji', () => {
  // undeclared_q starts after a tab (one column), after "é" (one column) and after an emoji (two).
  const source =
    '//@version=6\n\tplot(undeclared_q)\nx = "é" + undeclared_q\ny = "😀" + undeclared_q\n';
  const at = (line: number, column: number) => ({
    message: 'Undeclared identifier',
    start: { line, column },
    end: { line, column: column + 11 },
  });
  const raw = { errors: [at(2, 7), at(3, 11), at(4, 12), at(2, 2)] };

  expect(normalizeCompileErrors(raw, source).errors).toEqual([
    {
      line: 2,
      column: 7,
      endLine: 2,
      endColumn: 18,
      message: 'Undeclared identifier',
      severity: 'error',
    },
    {
      line: 3,
      column: 11,
      endLine: 3,
      endColumn: 22,
      message: 'Undeclared identifier',
      severity: 'error',
    },
    // The emoji line is 23 code units long: the end at column 23 is its last unit, not cut.
    {
      line: 4,
      column: 12,
      endLine: 4,
      endColumn: 23,
      message: 'Undeclared identifier',
      severity: 'error',
    },
    // Column 2 right after the tab stays column 2.
    {
      line: 2,
      column: 2,
      endLine: 2,
      endColumn: 13,
      message: 'Undeclared identifier',
      severity: 'error',
    },
  ]);
  // The clamp works in the same unit: the column right after the end of each line is the last one.
  const past = {
    errors: [2, 3, 4].map((line) => ({
      message: 'x',
      start: { line, column: 99 },
      end: { line, column: 99 },
    })),
  };
  expect(
    normalizeCompileErrors(past, source).errors.map(({ column, endColumn }) => [column, endColumn]),
  ).toEqual([
    [20, 20],
    [23, 23],
    [24, 24],
  ]);
});

test('normalizeCompileErrors separates warnings', () => {
  const source = 'a\nb = deprecated_f()\nc\n';
  const raw = {
    errors: [{ message: 'First', start: { line: 1, column: 1 }, end: { line: 1, column: 1 } }],
    warnings: [
      {
        message: 'The function {name} is deprecated',
        ctx: { name: 'deprecated_f' },
        start: { line: 2, column: 5 },
        end: { line: 2, column: 16 },
      },
    ],
  };

  const { errors, warnings } = normalizeCompileErrors(raw, source);

  expect(errors).toEqual([
    { line: 1, column: 1, endLine: 1, endColumn: 1, message: 'First', severity: 'error' },
  ]);
  expect(warnings).toEqual([
    {
      line: 2,
      column: 5,
      endLine: 2,
      endColumn: 16,
      message: 'The function deprecated_f is deprecated',
      severity: 'warning',
    },
  ]);
});

test('a column of 0 means no column: column 1 and no end column', () => {
  const raw = {
    errors: [
      { message: 'Syntax error at input "legacy_error"', start: { line: 2, column: 0 } },
      {
        message: 'Runtime error',
        start: { line: 1, column: 0 },
        end: { line: 1, column: 0 },
      },
    ],
  };

  expect(normalizeCompileErrors(raw, 'a\nlegacy_error\n').errors).toEqual([
    {
      line: 2,
      column: 1,
      endLine: null,
      endColumn: null,
      message: 'Syntax error at input "legacy_error"',
      severity: 'error',
    },
    {
      line: 1,
      column: 1,
      endLine: 1,
      endColumn: null,
      message: 'Runtime error',
      severity: 'error',
    },
  ]);
});

test('placeholders are filled from ctx, unknown ones stay, and a missing message gets a stand-in', () => {
  const raw = {
    errors: [
      { message: '{a} and {b} and {c}', ctx: { a: 'x', b: 2, c: { nested: true } } },
      { message: 42 },
      null,
    ],
    warnings: [{ ctx: null }],
  };

  const { errors, warnings } = normalizeCompileErrors(raw, 'x\n');

  expect(errors.map(({ message }) => message)).toEqual([
    'x and 2 and {c}',
    'Unknown compile error',
    'Unknown compile error',
  ]);
  expect(warnings.map(({ message }) => message)).toEqual(['Unknown compile warning']);
});

test('positions are clamped into the source, and a diagnostic without a place points at line 1', () => {
  const source = 'short\r\nlonger line\r\n';
  const raw = {
    errors: [
      // Past the last line and past the end of the line.
      { message: 'End of input', start: { line: 9, column: 40 }, end: { line: 12, column: 50 } },
      // An end before its start.
      { message: 'Backwards', start: { line: 2, column: 4 }, end: { line: 1, column: 2 } },
      // No place at all, and places that are no positive integers.
      { message: 'Nowhere' },
      { message: 'Odd', start: { line: 1.5, column: -1 }, end: { line: 'x', column: 2 } },
    ],
  };

  expect(normalizeCompileErrors(raw, source).errors).toEqual([
    { line: 3, column: 1, endLine: 3, endColumn: 1, message: 'End of input', severity: 'error' },
    { line: 2, column: 4, endLine: 2, endColumn: 4, message: 'Backwards', severity: 'error' },
    { line: 1, column: 1, endLine: null, endColumn: null, message: 'Nowhere', severity: 'error' },
    { line: 1, column: 1, endLine: null, endColumn: null, message: 'Odd', severity: 'error' },
  ]);
});

test('anything that is not compile errors gives none', () => {
  for (const raw of [null, undefined, 'text', 7, [], { errors: 'x', warnings: {} }]) {
    expect(normalizeCompileErrors(raw, 'x')).toEqual({ errors: [], warnings: [] });
  }
});

test('logTimeToSeconds takes numbers above 1e11 as milliseconds and the rest as seconds', () => {
  expect(logTimeToSeconds(1_700_000_000)).toBe(1_700_000_000);
  expect(logTimeToSeconds(1_700_000_000_750)).toBe(1_700_000_000.75);
  for (const value of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, '1700000000', null, 1e15]) {
    expect(logTimeToSeconds(value)).toBeNull();
  }
});

test('mergeConsoleMessages puts the newest first, keeps editor clocks and limits the list', () => {
  const reading = {
    editor: [
      { level: 'info', text: 'Compiling...', clock: '10:00:00', order: 1_700_000_000_000 },
      { level: 'error', text: 'Compilation error', clock: '10:20:00', order: 1_700_001_200_000 },
    ],
    scripts: [
      { studyId: 'S1', level: 'info', text: 'tick', time: 1_700_000_600_000, barTime: null },
      { studyId: 'S1', level: 'WARNING', text: 'late', time: 1_700_001_800, barTime: null },
      { studyId: 'S2', level: 'error', text: 'bar only', time: null, barTime: 1_699_999_000 },
      { studyId: 'S2', level: 'info', text: 'no time', time: null, barTime: null },
    ],
  };

  const messages = mergeConsoleMessages(reading, 10);

  expect(messages).toEqual([
    {
      time: 1_700_001_800,
      timeIso: '2023-11-14T22:43:20Z',
      level: 'warning',
      text: 'late',
      source: 'script',
      studyId: 'S1',
    },
    {
      time: null,
      timeIso: null,
      level: 'error',
      text: 'Compilation error',
      source: 'editor',
      clock: '10:20:00',
    },
    {
      time: 1_700_000_600,
      timeIso: '2023-11-14T22:23:20Z',
      level: 'info',
      text: 'tick',
      source: 'script',
      studyId: 'S1',
    },
    {
      time: null,
      timeIso: null,
      level: 'info',
      text: 'Compiling...',
      source: 'editor',
      clock: '10:00:00',
    },
    {
      time: 1_699_999_000,
      timeIso: '2023-11-14T21:56:40Z',
      level: 'error',
      text: 'bar only',
      source: 'script',
      studyId: 'S2',
    },
    {
      time: null,
      timeIso: null,
      level: 'info',
      text: 'no time',
      source: 'script',
      studyId: 'S2',
    },
  ]);
  expect(mergeConsoleMessages(reading, 2).map(({ text }) => text)).toEqual([
    'late',
    'Compilation error',
  ]);
});

test('toCompileResult succeeds without errors, and for a script added to the chart only once it compiled there', () => {
  const at = 1_792_490_400;
  const clean = { errors: [], warnings: [] };
  const error = {
    line: 1,
    column: 1,
    endLine: null,
    endColumn: null,
    message: 'Bad',
    severity: 'error' as const,
  };

  expect(toCompileResult(clean, null, at)).toEqual({
    success: true,
    errors: [],
    warnings: [],
    addedToChart: false,
    studyId: null,
    compiledAt: at,
    compiledAtIso: '2026-10-20T10:00:00Z',
  });
  expect(toCompileResult({ errors: [error], warnings: [] }, null, at).success).toBe(false);
  expect(toCompileResult(clean, { studyId: 'NEW001', compileError: false }, at)).toMatchObject({
    success: true,
    addedToChart: true,
    studyId: 'NEW001',
  });
  expect(toCompileResult(clean, { studyId: 'NEW001', compileError: null }, at).success).toBe(true);
  expect(toCompileResult(clean, { studyId: 'NEW001', compileError: true }, at)).toMatchObject({
    success: false,
    addedToChart: true,
  });
  expect(toCompileResult(clean, { studyId: null, compileError: null }, at)).toMatchObject({
    success: false,
    addedToChart: false,
    studyId: null,
  });
});
