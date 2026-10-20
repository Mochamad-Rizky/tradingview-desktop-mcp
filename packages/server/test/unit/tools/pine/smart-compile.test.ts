import { analyzePine } from '../../../../src/tools/pine/analyze/analyze.js';
import { applyFixes } from '../../../../src/tools/pine/analyze/fixes.js';
import type { PineCompileError, PineCompileResult } from '../../../../src/tools/pine/mappers.js';
import {
  collectFixes,
  fixesForCompileErrors,
  smartCompile,
} from '../../../../src/tools/pine/smart-compile.js';

// The rule-based fixing loop of pine_smart_compile, run against compilers that are scripted here
// (the tool itself is tested through the whole server in test/integration/tools/pine.test.ts). The
// sources are synthetic.

const HEAD = '//@version=6\nindicator("T")\n';

// An error of the compiler for a name that is not declared, as normalizeCompileErrors words it.
const undeclared = (name: string, line: number, column: number): PineCompileError => ({
  line,
  column,
  endLine: line,
  endColumn: column + name.length - 1,
  message: `Undeclared identifier "${name}"`,
  severity: 'error',
});

const outcome = (errors: PineCompileError[] = []): PineCompileResult => ({
  success: errors.length === 0,
  errors,
  warnings: [],
  addedToChart: false,
  studyId: null,
  compiledAt: 1_792_490_400,
  compiledAtIso: '2026-10-20T10:00:00Z',
});

// The v4 built-ins that moved or were renamed in v5, and where they went.
const TA_NAMES = [
  'sma',
  'ema',
  'rsi',
  'macd',
  'stoch',
  'atr',
  'crossover',
  'crossunder',
  'highest',
  'lowest',
  'change',
];
const RENAMES: [string, string][] = [
  ['study', 'indicator'],
  ['security', 'request.security'],
  ['tostring', 'str.tostring'],
  ...TA_NAMES.map((name): [string, string] => [name, `ta.${name}`]),
];

describe('fixesForCompileErrors', () => {
  test('fixesForCompileErrors renames the call an undeclared v4 name points at', () => {
    const source = `${HEAD}plot(rsi(close, 14))\n`;

    const fixes = fixesForCompileErrors(source, [undeclared('rsi', 3, 6)]);

    expect(fixes).toEqual([
      {
        description: 'Replace rsi( with ta.rsi(',
        edits: [{ line: 3, column: 6, endColumn: 9, replacement: 'ta.rsi' }],
      },
    ]);
    expect(applyFixes(source, fixes).source).toBe(`${HEAD}plot(ta.rsi(close, 14))\n`);
  });

  test.each(RENAMES)('fixesForCompileErrors maps %s to %s as the analyzer does', (name, target) => {
    const source = `${HEAD}x = ${name}(close, 5)\n`;

    const fixes = fixesForCompileErrors(source, [undeclared(name, 3, 5)]);

    expect(applyFixes(source, fixes).source).toBe(`${HEAD}x = ${target}(close, 5)\n`);
    // The fix is the very one the analyzer offers for that call.
    const offered = analyzePine(source).flatMap(({ fix }) => (fix === null ? [] : [fix]));
    expect(fixes).toEqual(offered);
  });

  test('fixesForCompileErrors renames a call the analyzer leaves alone because the script declares the name', () => {
    // On the right of the =, rsi is not declared yet, and the compiler says so.
    const source = `${HEAD}rsi = rsi(close, 14)\nplot(rsi)\n`;

    expect(analyzePine(source).flatMap(({ fix }) => (fix === null ? [] : [fix]))).toEqual([]);
    const fixes = fixesForCompileErrors(source, [undeclared('rsi', 3, 7)]);

    expect(applyFixes(source, fixes).source).toBe(`${HEAD}rsi = ta.rsi(close, 14)\nplot(rsi)\n`);
  });

  test('fixesForCompileErrors keeps the order of the errors and fixes each of them', () => {
    const source = `${HEAD}a = sma(close, 5)\nb = ema(close, 5)\n`;

    const fixes = fixesForCompileErrors(source, [undeclared('ema', 4, 5), undeclared('sma', 3, 5)]);

    expect(fixes.map(({ description }) => description)).toEqual([
      'Replace ema( with ta.ema(',
      'Replace sma( with ta.sma(',
    ]);
  });

  test('fixesForCompileErrors applies to a script of version 5 or later or without a version', () => {
    const body = 'x = sma(close, 5)\n';
    const error = (header: string) => [undeclared('sma', header.split('\n').length, 5)];

    for (const header of ['//@version=5\n', '//@version=6\n', '//@version=7\n', '']) {
      const source = `${header}${body}`;
      expect(fixesForCompileErrors(source, error(header)), JSON.stringify(header)).toHaveLength(1);
    }
  });

  test('fixesForCompileErrors offers nothing for a script below version 5, whose header it does not rewrite', () => {
    const source = '//@version=4\nstudy("T")\nx = sma(close, 5)\n';

    expect(
      fixesForCompileErrors(source, [undeclared('study', 2, 1), undeclared('sma', 3, 5)]),
    ).toEqual([]);
  });

  test.each([
    ['a name that is not a v4 built-in', `${HEAD}x = foo(close)\n`, undeclared('foo', 3, 5)],
    ['a built-in already in its namespace', `${HEAD}x = ta.sma(close)\n`, undeclared('sma', 3, 8)],
    ['a name that is not called', `${HEAD}x = sma\n`, undeclared('sma', 3, 5)],
    ['a position where the name is not', `${HEAD}x = sma(close)\n`, undeclared('sma', 3, 6)],
    ['another name at the position', `${HEAD}x = rsi(close)\n`, undeclared('sma', 3, 5)],
    ['a string that holds the name', `${HEAD}x = "sma(close)"\n`, undeclared('sma', 3, 5)],
    ['a comment that holds the name', `${HEAD}x = 1 // sma(close)\n`, undeclared('sma', 3, 10)],
    ['a position past the text', `${HEAD}x = sma(close)\n`, undeclared('sma', 9, 5)],
    [
      'another message about the name',
      `${HEAD}x = sma(close)\n`,
      { ...undeclared('sma', 3, 5), message: 'Cannot call "sma" with arguments' },
    ],
    [
      'a message that names more than an identifier',
      `${HEAD}x = sma(close)\n`,
      { ...undeclared('sma', 3, 5), message: 'Undeclared identifier "sma.x"' },
    ],
  ])('fixesForCompileErrors leaves %s alone', (_what, source, error) => {
    expect(fixesForCompileErrors(source, [error])).toEqual([]);
  });

  test('fixesForCompileErrors gives nothing for no errors', () => {
    expect(fixesForCompileErrors(`${HEAD}x = sma(close)\n`, [])).toEqual([]);
  });

  test('fixesForCompileErrors counts columns in UTF-16 units and a CRLF as one line break', () => {
    // The emoji takes two columns, so rsi starts at column 26 of the third line.
    const line = 't = "é😀" + str.tostring(rsi(close, 14))';
    const source = `//@version=6\r\nindicator("T")\r\n${line}\r\n`;

    const fixes = fixesForCompileErrors(source, [undeclared('rsi', 3, 26)]);

    expect(applyFixes(source, fixes).source).toBe(
      `//@version=6\r\nindicator("T")\r\n${line.replace('rsi(', 'ta.rsi(')}\r\n`,
    );
  });
});

describe('collectFixes', () => {
  test('collectFixes lists a fix of the analyzer and of a compile error once', () => {
    const source = '//@version=6\nstudy("T")\nplot(rsi(close, 14))\n';

    const fixes = collectFixes(source, [undeclared('study', 2, 1), undeclared('rsi', 3, 6)]);

    expect(fixes.map(({ description }) => description)).toEqual([
      'Replace study( with indicator(',
      'Replace rsi( with ta.rsi(',
    ]);
  });

  test('collectFixes puts the fixes of the analyzer first and adds the others', () => {
    // The analyzer offers the study fix and not the one for rsi, which the script declares.
    const source = '//@version=6\nstudy("T")\nrsi = rsi(close, 14)\nplot(rsi)\n';

    const fixes = collectFixes(source, [undeclared('rsi', 3, 7), undeclared('study', 2, 1)]);

    expect(fixes.map(({ description }) => description)).toEqual([
      'Replace study( with indicator(',
      'Replace rsi( with ta.rsi(',
    ]);
  });

  test('collectFixes offers the fixes of the analyzer without any error', () => {
    const fixes = collectFixes('indicator("T")\nplot(close)\n', []);

    expect(fixes.map(({ description }) => description)).toEqual(['Add //@version=6 on line 1']);
  });

  test('collectFixes leaves out what the analyzer reports without a fix', () => {
    // No declaration is an error to the analyzer, which has no fix for it.
    const source = '//@version=6\nplot(close)\n';

    expect(analyzePine(source).map(({ ruleId }) => ruleId)).toEqual(['missing-declaration']);
    expect(collectFixes(source, [])).toEqual([]);
  });

  test('collectFixes keeps two fixes that make different edits and drops a repeated one', () => {
    const source = `${HEAD}a = sma(close, 5)\nb = sma(close, 9)\n`;

    const fixes = collectFixes(source, [
      undeclared('sma', 3, 5),
      undeclared('sma', 4, 5),
      undeclared('sma', 3, 5),
    ]);

    expect(fixes.map(({ edits }) => edits[0]?.line)).toEqual([3, 4]);
  });
});

describe('smartCompile', () => {
  // Compiles the text with the rules of a script of version 6: a v4 name is undeclared.
  const v6Compiler = (calls: string[] = []) => {
    const compile = (source: string): Promise<PineCompileResult> => {
      calls.push(source);
      const errors = source
        .split('\n')
        .flatMap((row, index) =>
          [...row.matchAll(/(?<![\w.])(study|rsi|sma|ema)(?=\()/g)].map((match) =>
            undeclared(match[1] ?? '', index + 1, match.index + 1),
          ),
        );
      return Promise.resolve(outcome(errors));
    };
    return compile;
  };

  test('smartCompile returns a script that compiles as it is, unchanged and with no diff', async () => {
    const calls: string[] = [];
    const source = `${HEAD}plot(close)\n`;

    const run = await smartCompile(v6Compiler(calls), source, { maxAttempts: 3, applyFixes: true });

    expect(run).toMatchObject({
      success: true,
      attempts: [{ errors: [], applied: [] }],
      source,
      diff: '',
    });
    expect(calls).toEqual([source]);
  });

  test('smartCompile fixes the script and compiles the fixed text again', async () => {
    const calls: string[] = [];
    const source = '//@version=6\nstudy("x")\nplot(rsi(close,14))\n';

    const run = await smartCompile(v6Compiler(calls), source, { maxAttempts: 3, applyFixes: true });

    const fixed = '//@version=6\nindicator("x")\nplot(ta.rsi(close,14))\n';
    expect(calls).toEqual([source, fixed]);
    expect(run.success).toBe(true);
    expect(run.attempts).toEqual([
      {
        errors: [undeclared('study', 2, 1), undeclared('rsi', 3, 6)],
        applied: ['Replace study( with indicator(', 'Replace rsi( with ta.rsi('],
      },
      { errors: [], applied: [] },
    ]);
    expect(run.source).toBe(fixed);
    expect(run.diff).toBe(
      [
        '@@ -1,3 +1,3 @@',
        ' //@version=6',
        '-study("x")',
        '-plot(rsi(close,14))',
        '+indicator("x")',
        '+plot(ta.rsi(close,14))',
        '',
      ].join('\n'),
    );
    // The result to remember is the one of the last compilation.
    expect(run.last).toEqual(outcome());
  });

  test('smartCompile compiles once with applyFixes false and changes nothing', async () => {
    const calls: string[] = [];
    const source = '//@version=6\nstudy("x")\n';

    const run = await smartCompile(v6Compiler(calls), source, {
      maxAttempts: 3,
      applyFixes: false,
    });

    expect(calls).toEqual([source]);
    expect(run.success).toBe(false);
    expect(run.attempts).toEqual([{ errors: [undeclared('study', 2, 1)], applied: [] }]);
    expect(run.source).toBe(source);
    expect(run.diff).toBe('');
  });

  test('smartCompile applies a fix only when another compilation follows, so one attempt changes nothing', async () => {
    const calls: string[] = [];
    const source = '//@version=6\nstudy("x")\n';

    const run = await smartCompile(v6Compiler(calls), source, { maxAttempts: 1, applyFixes: true });

    expect(calls).toEqual([source]);
    expect(run.attempts).toEqual([{ errors: [undeclared('study', 2, 1)], applied: [] }]);
    expect(run.source).toBe(source);
  });

  // A compiler that stops at the first v4 name it finds, so that a script with several of them
  // takes several rounds. The script declares every name, which keeps the analyzer from fixing
  // them, so each round fixes only the one the compiler named.
  const SEVERAL =
    `${HEAD}rsi = rsi(close, 14)\nsma = sma(close, 14)\nema = ema(close, 14)\n` +
    'plot(rsi + sma + ema)\n';
  const firstOnly = (calls: string[] = []) => {
    const all = v6Compiler();
    return async (source: string): Promise<PineCompileResult> => {
      calls.push(source);
      const { errors } = await all(source);
      return outcome(errors.slice(0, 1));
    };
  };

  test('smartCompile stops after maxAttempts and returns the last errors', async () => {
    const calls: string[] = [];

    const run = await smartCompile(firstOnly(calls), SEVERAL, { maxAttempts: 3, applyFixes: true });

    expect(calls).toHaveLength(3);
    expect(run.success).toBe(false);
    expect(run.attempts.map(({ applied }) => applied)).toEqual([
      ['Replace rsi( with ta.rsi('],
      ['Replace sma( with ta.sma('],
      [],
    ]);
    expect(run.attempts.at(-1)?.errors).toEqual([undeclared('ema', 5, 7)]);
    // The source is the text the last attempt compiled, so that it matches the errors.
    expect(run.source).toBe(calls[2]);
    expect(run.source).toContain('rsi = ta.rsi(close, 14)');
    expect(run.source).toContain('sma = ta.sma(close, 14)');
    expect(run.source).toContain('ema = ema(close, 14)');
    expect(run.last.errors).toEqual(run.attempts.at(-1)?.errors);
    expect(run.diff).toContain('+rsi = ta.rsi(close, 14)');
    expect(run.diff).not.toContain('ta.ema');
  });

  test('smartCompile goes on while fixes apply and the attempts allow', async () => {
    const run = await smartCompile(firstOnly(), SEVERAL, { maxAttempts: 5, applyFixes: true });

    expect(run.success).toBe(true);
    expect(run.attempts.map(({ applied }) => applied.length)).toEqual([1, 1, 1, 0]);
    expect(run.source).toContain('ema = ta.ema(close, 14)');
  });

  test('smartCompile stops early when no fix applies, whatever maxAttempts allows', async () => {
    const calls: string[] = [];
    const compile = (source: string): Promise<PineCompileResult> => {
      calls.push(source);
      return Promise.resolve(outcome([undeclared('mystery', 3, 1)]));
    };

    const run = await smartCompile(compile, `${HEAD}mystery(close)\n`, {
      maxAttempts: 5,
      applyFixes: true,
    });

    expect(calls).toHaveLength(1);
    expect(run.attempts).toEqual([{ errors: [undeclared('mystery', 3, 1)], applied: [] }]);
    expect(run.success).toBe(false);
    expect(run.diff).toBe('');
  });

  test('smartCompile stops early after a fix when the errors left have none', async () => {
    const calls: string[] = [];
    const compile = (source: string): Promise<PineCompileResult> => {
      calls.push(source);
      return v6Compiler()(source).then(({ errors }) =>
        outcome([...errors, undeclared('mystery', 3, 1)]),
      );
    };

    const run = await smartCompile(compile, `${HEAD}mystery(close)\nx = sma(close, 5)\n`, {
      maxAttempts: 5,
      applyFixes: true,
    });

    expect(calls).toHaveLength(2);
    expect(run.attempts.map(({ applied }) => applied)).toEqual([['Replace sma( with ta.sma('], []]);
    expect(run.attempts.at(-1)?.errors).toEqual([undeclared('mystery', 3, 1)]);
  });

  test('smartCompile stops when the errors that are left point where there is nothing to fix', async () => {
    const calls: string[] = [];
    // A compiler that keeps reporting the one error it saw first, whatever the text.
    const compile = (source: string): Promise<PineCompileResult> => {
      calls.push(source);
      return Promise.resolve(outcome([undeclared('sma', 3, 5)]));
    };
    const source = `${HEAD}x = sma(close, 5)\n`;

    const run = await smartCompile(compile, source, { maxAttempts: 5, applyFixes: true });

    // The first round fixes the call. The second finds nothing at the position of the error.
    expect(calls).toEqual([source, `${HEAD}x = ta.sma(close, 5)\n`]);
    expect(run.attempts).toHaveLength(2);
    expect(run.attempts.map(({ applied }) => applied.length)).toEqual([1, 0]);
  });

  test('smartCompile passes on a failure of the compiler, which is not a compile error', async () => {
    const compile = (): Promise<PineCompileResult> => Promise.reject(new Error('Compiler is down'));

    await expect(
      smartCompile(compile, `${HEAD}plot(close)\n`, { maxAttempts: 3, applyFixes: true }),
    ).rejects.toThrow('Compiler is down');
  });

  test('smartCompile fixes a script without a version when the compiler rejects it', async () => {
    const compile = (source: string): Promise<PineCompileResult> =>
      Promise.resolve(outcome(source.includes('//@version') ? [] : [undeclared('mystery', 2, 1)]));

    const run = await smartCompile(compile, 'indicator("T")\nplot(close)\n', {
      maxAttempts: 3,
      applyFixes: true,
    });

    expect(run.success).toBe(true);
    expect(run.source).toBe('//@version=6\nindicator("T")\nplot(close)\n');
    expect(run.attempts[0]?.applied).toEqual(['Add //@version=6 on line 1']);
  });

  test('smartCompile gives a diff that does not see line endings', async () => {
    const source = '//@version=6\r\nstudy("x")\r\nplot(close)\r\n';

    const run = await smartCompile(v6Compiler(), source, { maxAttempts: 3, applyFixes: true });

    expect(run.source).toBe('//@version=6\r\nindicator("x")\r\nplot(close)\r\n');
    expect(run.diff).toBe(
      [
        '@@ -1,3 +1,3 @@',
        ' //@version=6',
        '-study("x")',
        '+indicator("x")',
        ' plot(close)',
        '',
      ].join('\n'),
    );
  });
});
