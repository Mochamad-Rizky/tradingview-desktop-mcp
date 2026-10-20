import { unifiedDiff } from '../../../src/utils/diff.js';

// The line-based diff that pine_smart_compile returns. The texts are synthetic.

const names = (count: number, prefix = 'l'): string[] =>
  Array.from({ length: count }, (_unused, n) => `${prefix}${String(n + 1)}`);

// Lines to a text, each ended by a line break.
const text = (rows: readonly string[]): string => rows.map((row) => `${row}\n`).join('');

const ONE_TO_NINE = text(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']);
const ONE_TO_NINE_FIVE_UPPER = ONE_TO_NINE.replace('five', 'FIVE');

describe('unifiedDiff', () => {
  test('unifiedDiff returns an empty string for equal texts', () => {
    expect(unifiedDiff('a\nb\n', 'a\nb\n')).toBe('');
    expect(unifiedDiff('', '')).toBe('');
    expect(unifiedDiff('no break at the end', 'no break at the end')).toBe('');
  });

  test('unifiedDiff marks changed lines with context', () => {
    expect(unifiedDiff(ONE_TO_NINE, ONE_TO_NINE_FIVE_UPPER)).toBe(
      [
        '@@ -2,7 +2,7 @@',
        ' two',
        ' three',
        ' four',
        '-five',
        '+FIVE',
        ' six',
        ' seven',
        ' eight',
        '',
      ].join('\n'),
    );
  });

  test('unifiedDiff keeps the number of context lines it is given', () => {
    expect(unifiedDiff(ONE_TO_NINE, ONE_TO_NINE_FIVE_UPPER, 1)).toBe(
      ['@@ -4,3 +4,3 @@', ' four', '-five', '+FIVE', ' six', ''].join('\n'),
    );
    expect(unifiedDiff(ONE_TO_NINE, ONE_TO_NINE_FIVE_UPPER, 0)).toBe(
      ['@@ -5,1 +5,1 @@', '-five', '+FIVE', ''].join('\n'),
    );
    // More context than the text has shows all of it, and so does an unbounded one.
    const whole = unifiedDiff(ONE_TO_NINE, ONE_TO_NINE_FIVE_UPPER, 50);
    expect(whole.split('\n')[0]).toBe('@@ -1,9 +1,9 @@');
    expect(unifiedDiff(ONE_TO_NINE, ONE_TO_NINE_FIVE_UPPER, Infinity)).toBe(whole);
  });

  test('unifiedDiff reads a context that is not a count as none', () => {
    const none = unifiedDiff(ONE_TO_NINE, ONE_TO_NINE_FIVE_UPPER, 0);

    expect(unifiedDiff(ONE_TO_NINE, ONE_TO_NINE_FIVE_UPPER, -2)).toBe(none);
    expect(unifiedDiff(ONE_TO_NINE, ONE_TO_NINE_FIVE_UPPER, Number.NaN)).toBe(none);
    expect(unifiedDiff(ONE_TO_NINE, ONE_TO_NINE_FIVE_UPPER, 0.9)).toBe(none);
  });

  test('unifiedDiff gives distant changes their own hunks and counts both sides from their own start', () => {
    const before = names(12);
    const after = [...before];
    // A line added after l2, and l11 changed.
    after.splice(2, 0, 'NEW');
    after[after.indexOf('l11')] = 'L11';

    expect(unifiedDiff(text(before), text(after), 1)).toBe(
      [
        '@@ -2,2 +2,3 @@',
        ' l2',
        '+NEW',
        ' l3',
        '@@ -10,3 +11,3 @@',
        ' l10',
        '-l11',
        '+L11',
        ' l12',
        '',
      ].join('\n'),
    );
  });

  test('unifiedDiff joins changes whose context meets or overlaps, and only those', () => {
    const changed = (gap: number): string => {
      const before = names(gap + 6);
      const after = [...before];
      after[0] = 'FIRST';
      after[gap + 1] = 'SECOND';
      return unifiedDiff(text(before), text(after), 1);
    };
    const hunksOf = (diff: string): number =>
      diff.split('\n').filter((row) => row.startsWith('@@')).length;

    // Two equal lines between the changes: the context of one is the context of the other.
    expect(hunksOf(changed(2))).toBe(1);
    expect(hunksOf(changed(1))).toBe(1);
    // Three: a line would be left out between them.
    expect(hunksOf(changed(3))).toBe(2);
  });

  test('unifiedDiff writes a change as its deleted lines and then its added lines', () => {
    expect(unifiedDiff(text(['a', 'b', 'c', 'd']), text(['a', 'X', 'Y', 'Z', 'd']), 0)).toBe(
      ['@@ -2,2 +2,3 @@', '-b', '-c', '+X', '+Y', '+Z', ''].join('\n'),
    );
  });

  test('unifiedDiff numbers the edges of the text and of an empty text', () => {
    expect(unifiedDiff(text(['a', 'b']), text(['x', 'a', 'b']), 1)).toBe(
      ['@@ -1,1 +1,2 @@', '+x', ' a', ''].join('\n'),
    );
    expect(unifiedDiff(text(['a', 'b']), text(['a', 'b', 'x']), 1)).toBe(
      ['@@ -2,1 +2,2 @@', ' b', '+x', ''].join('\n'),
    );
    expect(unifiedDiff('', text(['a', 'b']))).toBe(['@@ -0,0 +1,2 @@', '+a', '+b', ''].join('\n'));
    expect(unifiedDiff(text(['a', 'b']), '')).toBe(['@@ -1,2 +0,0 @@', '-a', '-b', ''].join('\n'));
    // A pure insertion without context sits after the line it follows.
    expect(unifiedDiff(text(['a', 'b']), text(['a', 'x', 'b']), 0)).toBe(
      ['@@ -1,0 +2,1 @@', '+x', ''].join('\n'),
    );
  });

  test('unifiedDiff shows an empty line as a line of its own', () => {
    expect(unifiedDiff('a\n\nb\n', 'a\nb\n')).toBe(
      ['@@ -1,3 +1,2 @@', ' a', '-', ' b', ''].join('\n'),
    );
    expect(unifiedDiff('\n', 'x\n')).toBe(['@@ -1,1 +1,1 @@', '-', '+x', ''].join('\n'));
  });

  test('unifiedDiff changes as few lines as it can, even with repeated lines', () => {
    expect(unifiedDiff(text(['a', 'b', 'c', 'd', 'e']), text(['a', 'c', 'd', 'x', 'e']))).toBe(
      ['@@ -1,5 +1,5 @@', ' a', '-b', ' c', ' d', '+x', ' e', ''].join('\n'),
    );
    expect(unifiedDiff(text(['x', 'x', 'x']), text(['x', 'x']))).toBe(
      ['@@ -1,3 +1,2 @@', ' x', ' x', '-x', ''].join('\n'),
    );
    expect(unifiedDiff(text(['a', 'x', 'a', 'x']), text(['x', 'a', 'x', 'a']), 0)).toBe(
      ['@@ -1,1 +0,0 @@', '-a', '@@ -4,0 +4,1 @@', '+a', ''].join('\n'),
    );
  });

  test('unifiedDiff compares lines without their line breaks, so CRLF and LF are equal', () => {
    expect(unifiedDiff('a\r\nb\r\n', 'a\nb\n')).toBe('');
    expect(unifiedDiff('a\rb\r', 'a\nb\n')).toBe('');
    expect(unifiedDiff('a\r\nb\nc\r', 'a\nb\r\nc\r\n')).toBe('');
    // A line break at the end of the text is not a difference either.
    expect(unifiedDiff('a\nb', 'a\nb\n')).toBe('');
    expect(unifiedDiff('a\nb\n', 'a\nb')).toBe('');
    // A change still shows, written with LF and without the CR.
    expect(unifiedDiff('a\r\nb\r\nc\r\n', 'a\nB\nc\n')).toBe(
      ['@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c', ''].join('\n'),
    );
  });

  test('unifiedDiff sees a line that differs only in its end of line whitespace as changed', () => {
    expect(unifiedDiff('a \nb\n', 'a\nb\n')).toBe(
      ['@@ -1,2 +1,2 @@', '-a ', '+a', ' b', ''].join('\n'),
    );
  });

  test('unifiedDiff shows a change of the last line when the text has no final line break', () => {
    expect(unifiedDiff('a\nb', 'a\nB')).toBe(['@@ -1,2 +1,2 @@', ' a', '-b', '+B', ''].join('\n'));
  });
});

// A generator with a fixed seed, so that a failing case can be repeated.
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

// The length of the longest common subsequence of two lists, the plain way.
function lcsLength(a: readonly string[], b: readonly string[]): number {
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0),
  );
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const row = table[i] ?? [];
      row[j] =
        a[i - 1] === b[j - 1]
          ? (table[i - 1]?.[j - 1] ?? 0) + 1
          : Math.max(table[i - 1]?.[j] ?? 0, row[j - 1] ?? 0);
    }
  }
  return table[a.length]?.[b.length] ?? 0;
}

// Applies the hunks of `diff` to the lines of the old text, and checks that the numbers in each
// header say what the hunk holds and where it starts on both sides.
function patch(before: readonly string[], diff: string): string[] {
  const result: string[] = [];
  let next = 0;
  const rows = diff === '' ? [] : diff.slice(0, -1).split('\n');
  expect(diff === '' || diff.endsWith('\n')).toBe(true);
  let header: { oldStart: number; oldCount: number; newStart: number; newCount: number } | null =
    null;
  let seen = { old: 0, new: 0 };
  const close = (): void => {
    if (header !== null) {
      expect(seen).toEqual({ old: header.oldCount, new: header.newCount });
    }
  };
  for (const row of rows) {
    const match = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(row);
    if (match !== null) {
      close();
      header = {
        oldStart: Number(match[1]),
        oldCount: Number(match[2]),
        newStart: Number(match[3]),
        newCount: Number(match[4]),
      };
      seen = { old: 0, new: 0 };
      // An empty range starts at the line before it.
      const skip = header.oldCount === 0 ? header.oldStart : header.oldStart - 1;
      result.push(...before.slice(next, skip));
      next = skip;
      expect(header.newCount === 0 ? header.newStart : header.newStart - 1).toBe(result.length);
      continue;
    }
    const kind = row.charAt(0);
    const body = row.slice(1);
    if (kind === '+') {
      result.push(body);
      seen.new += 1;
    } else {
      expect(['-', ' ']).toContain(kind);
      expect(before[next]).toBe(body);
      next += 1;
      seen.old += 1;
      if (kind === ' ') {
        result.push(body);
        seen.new += 1;
      }
    }
  }
  close();
  result.push(...before.slice(next));
  return result;
}

describe('unifiedDiff on generated texts', () => {
  const alphabet = ['a', 'b', 'c', 'd', ''];

  test('unifiedDiff gives a diff that turns the old text into the new one and is the shortest', () => {
    const random = generator(20_261_020);
    const pick = (): string => alphabet[Math.floor(random() * alphabet.length)] ?? '';
    const list = (): string[] => Array.from({ length: Math.floor(random() * 10) }, pick);

    for (let round = 0; round < 400; round += 1) {
      const before = list();
      const after = list();
      const context = round % 4;

      const diff = unifiedDiff(text(before), text(after), context);

      expect(patch(before, diff), `round ${String(round)}`).toEqual(after);
      const rows = diff.split('\n');
      const common = lcsLength(before, after);
      expect(rows.filter((row) => row.startsWith('-')).length).toBe(before.length - common);
      expect(rows.filter((row) => row.startsWith('+')).length).toBe(after.length - common);
      // Each stretch of changes is its deleted lines and then its added ones.
      expect(diff).not.toMatch(/\n\+[^\n]*\n-/);
    }
  });

  test('unifiedDiff handles a text that changes in many places', () => {
    const before = names(60);
    const after = before.flatMap((row, index) => {
      if (index % 7 === 0) {
        return [];
      }
      return index % 5 === 0 ? [row, `${row}-extra`] : [row];
    });

    for (const context of [0, 1, 3, 10]) {
      expect(patch(before, unifiedDiff(text(before), text(after), context))).toEqual(after);
    }
  });

  test('unifiedDiff shows a text too large to compare line by line as one replaced block', () => {
    // 2200 shared lines between two different ends: more than the diff compares in full.
    const shared = names(2200, 'same');
    const before = ['old first', ...shared, 'old last'];
    const after = ['new first', ...shared, 'new last'];

    const diff = unifiedDiff(text(before), text(after));

    // It is still a correct diff, but it does not keep the shared lines apart from the change.
    expect(patch(before, diff)).toEqual(after);
    expect(diff.split('\n').filter((row) => row.startsWith('-')).length).toBe(before.length);
    expect(diff.split('\n').filter((row) => row.startsWith('+')).length).toBe(after.length);
  });

  test('unifiedDiff keeps the shared lines of a large text that it can compare', () => {
    const shared = names(1500, 'same');
    const before = ['old first', ...shared, 'old last'];
    const after = ['new first', ...shared, 'new last'];

    const rows = unifiedDiff(text(before), text(after), 0).split('\n');

    expect(rows.filter((row) => row.startsWith('-'))).toEqual(['-old first', '-old last']);
    expect(rows.filter((row) => row.startsWith('+'))).toEqual(['+new first', '+new last']);
  });
});
