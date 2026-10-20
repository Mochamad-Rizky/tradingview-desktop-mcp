import {
  analyzePine,
  pineVersion,
  type PineFix,
} from '../../../../src/tools/pine/analyze/analyze.js';
import { applyFixes } from '../../../../src/tools/pine/analyze/fixes.js';
import { tokenize } from '../../../../src/tools/pine/analyze/tokenize.js';

// The offline Pine analyzer. The sources are synthetic.

const HEAD = '//@version=6\nindicator("T")\n';

const ids = (source: string): string[] => analyzePine(source).map(({ ruleId }) => ruleId);
const find = (source: string, ruleId: string) =>
  analyzePine(source).filter((entry) => entry.ruleId === ruleId);
// Analyzes the source, applies every fix and answers the fixed text.
const fixed = (source: string): string =>
  applyFixes(
    source,
    analyzePine(source).flatMap(({ fix }) => (fix === null ? [] : [fix])),
  ).source;

describe('analyzePine', () => {
  test('a clean v6 script has no diagnostics', () => {
    expect(analyzePine(`${HEAD}plot(ta.sma(close, 14))\n`)).toEqual([]);
  });

  test('missing-version reports an error on line 1 with a fix that adds the annotation', () => {
    const [entry] = find('indicator("T")\nplot(close)\n', 'missing-version');
    expect(entry).toMatchObject({ severity: 'error', line: 1, column: 1 });
    expect(fixed('indicator("T")\nplot(close)\n')).toBe(
      '//@version=6\nindicator("T")\nplot(close)\n',
    );
  });

  test('missing-version is absent when the annotation is there', () => {
    expect(ids(`${HEAD}plot(close)\n`)).not.toContain('missing-version');
    expect(ids('// @version = 5\nindicator("T")\n')).not.toContain('missing-version');
  });

  test('a //@version text inside a string is not an annotation', () => {
    expect(ids('indicator("//@version=5")\n')).toContain('missing-version');
  });

  test('old-version is an info without a fix for a version below 5', () => {
    const [entry] = find('//@version=4\nstudy("T")\n', 'old-version');
    expect(entry).toMatchObject({ severity: 'info', line: 1, fix: null });
    expect(ids('//@version=5\nindicator("T")\n')).not.toContain('old-version');
  });

  test('study-declaration renames study( to indicator(', () => {
    const source = '//@version=5\nstudy("T")\n';
    expect(find(source, 'study-declaration')).toMatchObject([
      { severity: 'warning', line: 2, column: 1 },
    ]);
    expect(fixed(source)).toBe('//@version=5\nindicator("T")\n');
    expect(ids(`${HEAD}study = 1\n`)).not.toContain('study-declaration');
    expect(ids('//@version=5\nindicator("study(")\n')).not.toContain('study-declaration');
  });

  test('security-namespace renames bare security( only', () => {
    const source = `${HEAD}x = security(syminfo.tickerid, "D", close)\n`;
    expect(find(source, 'security-namespace')).toMatchObject([{ severity: 'warning', line: 3 }]);
    expect(fixed(source)).toBe(`${HEAD}x = request.security(syminfo.tickerid, "D", close)\n`);
    expect(ids(`${HEAD}x = request.security(syminfo.tickerid, "D", close)\n`)).not.toContain(
      'security-namespace',
    );
  });

  test('ta-namespace renames each v4 built-in and leaves ta.* alone', () => {
    const names = [
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
    for (const name of names) {
      const source = `${HEAD}x = ${name}(close, 5)\n`;
      expect(find(source, 'ta-namespace')).toHaveLength(1);
      expect(fixed(source)).toBe(`${HEAD}x = ta.${name}(close, 5)\n`);
    }
    expect(ids(`${HEAD}x = ta.sma(close, 5)\n`)).not.toContain('ta-namespace');
  });

  test('ta-namespace and security-namespace skip names the script declares', () => {
    const source = `${HEAD}sma(x) =>\n    x\nrsi = 3\ny = sma(close)\nz = rsi(close)\nsecurity = 1\nw = security(a)\n`;
    expect(ids(source)).not.toContain('ta-namespace');
    expect(ids(source)).not.toContain('security-namespace');
    expect(fixed(source)).toBe(source);
  });

  test('a tuple output named like its built-in does not hide the call', () => {
    const source = `${HEAD}[macd, signal, hist] = macd(close, 12, 26, 9)\n`;
    expect(fixed(source)).toBe(`${HEAD}[macd, signal, hist] = ta.macd(close, 12, 26, 9)\n`);
  });

  test('str-namespace renames tostring( to str.tostring(', () => {
    const source = `${HEAD}t = tostring(close)\n`;
    expect(find(source, 'str-namespace')).toHaveLength(1);
    expect(fixed(source)).toBe(`${HEAD}t = str.tostring(close)\n`);
    expect(ids(`${HEAD}t = str.tostring(close)\n`)).not.toContain('str-namespace');
  });

  test('missing-declaration is an error without a fix when no declaration exists', () => {
    const [entry] = find('//@version=6\nplot(close)\n', 'missing-declaration');
    expect(entry).toMatchObject({ severity: 'error', line: 1, column: 1, fix: null });
    for (const decl of ['indicator("T")', 'strategy("T")', 'library("T")', 'study("T")']) {
      expect(ids(`//@version=5\n${decl}\n`)).not.toContain('missing-declaration');
    }
  });

  test('strategy-calls-without-strategy flags strategy.* calls in an indicator', () => {
    const source = `${HEAD}strategy.entry("L", strategy.long)\nstrategy.close("L")\n`;
    const entries = find(source, 'strategy-calls-without-strategy');
    expect(entries).toMatchObject([{ severity: 'error', line: 3, column: 1, fix: null }]);
    expect(entries[0]?.message).toContain('2');
    expect(ids('//@version=6\nstrategy("T")\nstrategy.entry("L", strategy.long)\n')).not.toContain(
      'strategy-calls-without-strategy',
    );
    expect(ids(`${HEAD}x = strategy.long\n`)).not.toContain('strategy-calls-without-strategy');
    expect(ids('//@version=6\nstrategy.entry("L")\n')).not.toContain(
      'strategy-calls-without-strategy',
    );
  });

  test('lookahead-repaint warns for lookahead = barmerge.lookahead_on', () => {
    const source = `${HEAD}x = request.security("A", "D", close, lookahead = barmerge.lookahead_on)\n`;
    expect(find(source, 'lookahead-repaint')).toMatchObject([
      { severity: 'warning', line: 3, fix: null },
    ]);
    expect(
      ids(`${HEAD}x = request.security("A", "D", close, lookahead=barmerge.lookahead_off)\n`),
    ).not.toContain('lookahead-repaint');
  });

  test('too-many-plots flags more than 64 plot calls, not 64', () => {
    const plots = (count: number): string => `${HEAD}${'plot(close)\n'.repeat(count)}`;
    expect(ids(plots(64))).not.toContain('too-many-plots');
    expect(find(plots(65), 'too-many-plots')).toMatchObject([
      { severity: 'error', line: 3 + 64, fix: null },
    ]);
    const mixed = `${HEAD}${'plotshape(close)\nplotchar(close)\nplotarrow(close)\nplotbar(1,1,1,1)\nplotcandle(1,1,1,1)\n'.repeat(13)}`;
    expect(ids(mixed)).toContain('too-many-plots');
  });

  test('analyzePine ignores code in comments and strings', () => {
    const source =
      '//@version=6\nindicator("T")\n// study(close)\nx = "security(close)"\ny = \'tostring(1)\'\n' +
      '// strategy.entry("a")\nz = "a \\" sma(1)"\n';
    expect(analyzePine(source)).toEqual([]);
  });

  test('diagnostics count columns in UTF-16 code units after a tab and an emoji', () => {
    const source = `${HEAD}\tx = "😀" + security(a, b, c)\n`;
    expect(find(source, 'security-namespace')).toMatchObject([{ line: 3, column: 13 }]);
    expect(fixed(source)).toBe(`${HEAD}\tx = "😀" + request.security(a, b, c)\n`);
  });

  test('positions treat CRLF as one line break', () => {
    const source = '//@version=6\r\nindicator("T")\r\nx = tostring(1)\r\n';
    expect(find(source, 'str-namespace')).toMatchObject([{ line: 3, column: 5 }]);
    expect(fixed(source)).toBe('//@version=6\r\nindicator("T")\r\nx = str.tostring(1)\r\n');
  });

  test('diagnostics are sorted by line, then by column', () => {
    const source = 'x = tostring(security(a))\nstudy("T")\n';
    const places = analyzePine(source).map(({ line, column }) => line * 1000 + column);
    expect(places).toEqual([...places].sort((a, b) => a - b));
    expect(places[0]).toBe(1001);
  });

  test('the namespace rules offer no fix for a script below v5', () => {
    const source = '//@version=4\nstudy("T")\nx = rsi(close, 14)\n';
    const entries = analyzePine(source).filter(
      ({ ruleId }) => ruleId.endsWith('-declaration') || ruleId === 'ta-namespace',
    );
    expect(entries.map(({ ruleId, fix }) => [ruleId, fix])).toEqual([
      ['study-declaration', null],
      ['ta-namespace', null],
    ]);
    expect(entries[0]?.message).toContain('upgraded');
    expect(ids(source)).toContain('old-version');
    expect(fixed(source)).toBe(source);
  });

  test('the namespace rules offer fixes when the version is missing or 5 and later', () => {
    for (const head of ['', '//@version=5\n', '//@version=6\n']) {
      const result = analyzePine(`${head}study("T")\nx = rsi(close, 14)\n`);
      const named = result.filter(
        ({ ruleId }) => ruleId === 'study-declaration' || ruleId === 'ta-namespace',
      );
      expect(named.map(({ fix }) => fix !== null)).toEqual([true, true]);
    }
  });

  test('fixing a v4 script leaves nothing to report but the version note', () => {
    const source =
      '//@version=5\nstudy("T")\nx = security(syminfo.tickerid, "D", sma(close, 3))\nplot(tostring(x))\n';
    const result = fixed(source);
    expect(result).toBe(
      '//@version=5\nindicator("T")\nx = request.security(syminfo.tickerid, "D", ta.sma(close, 3))\nplot(str.tostring(x))\n',
    );
    expect(analyzePine(result)).toEqual([]);
  });
});

describe('pineVersion', () => {
  test('reads the annotation and answers null without one', () => {
    expect(pineVersion('//@version=5\n')).toBe(5);
    expect(pineVersion('// @version = 4\nstudy("T")')).toBe(4);
    expect(pineVersion('indicator("T")')).toBeNull();
  });
});

describe('applyFixes', () => {
  const edit = (column: number, endColumn: number, replacement: string, line = 1): PineFix => ({
    description: `${String(line)}:${String(column)}`,
    edits: [{ line, column, endColumn, replacement }],
  });

  test('applyFixes applies non-overlapping edits and skips overlapping ones', () => {
    const result = applyFixes('abcdef\nghij\n', [
      edit(1, 3, 'XX'),
      edit(2, 4, 'YY'),
      edit(5, 7, 'ZZ'),
      edit(1, 2, 'W', 2),
    ]);
    // Edits go in from the bottom up, so the later of two overlapping edits is the one applied.
    expect(result.source).toBe('aYYdZZ\nWhij\n');
    expect(result.applied).toEqual(['1:2', '1:5', '2:1']);
  });

  test('applyFixes keeps a fix whole: it is skipped when any of its edits overlaps', () => {
    const two: PineFix = {
      description: 'two',
      edits: [
        { line: 1, column: 1, endColumn: 2, replacement: 'A' },
        { line: 2, column: 1, endColumn: 2, replacement: 'B' },
      ],
    };
    const result = applyFixes('ab\ncd\n', [two, edit(1, 2, 'Z', 2)]);
    expect(result.applied).toEqual(['2:1']);
    expect(result.source).toBe('ab\nZd\n');
  });

  test('applyFixes skips two insertions at one place and edits of a missing line', () => {
    const result = applyFixes('ab\n', [edit(1, 1, 'X'), edit(1, 1, 'Y'), edit(1, 1, 'Q', 9)]);
    expect(result.applied).toHaveLength(1);
    expect(result.source).toHaveLength(4);
  });

  test('applyFixes with no fixes returns the source', () => {
    expect(applyFixes('abc', [])).toEqual({ source: 'abc', applied: [] });
  });
});

describe('tokenize', () => {
  test('skips an unterminated string at the end of its line', () => {
    const tokens = tokenize('a = "oops\nb = 1.5e3 // c');
    expect(tokens.map(({ kind, text }) => `${kind}:${text}`)).toEqual([
      'ident:a',
      'punct:=',
      'string:"oops',
      'ident:b',
      'punct:=',
      'number:1.5e3',
      'comment:// c',
    ]);
  });

  test('a lone CR is a line break', () => {
    expect(tokenize('a\rb').map(({ line }) => line)).toEqual([1, 2]);
  });
});
