// A line-based unified diff, for the tools that show what a change did to a script.

// The most cells of the table of common lines that the diff builds, 16 MB of it. When the lines
// between the shared start and the shared end of two texts would need more, they are shown as one
// block of deleted lines and one of added lines: still a correct diff, but not the shortest.
const MAX_TABLE_CELLS = 4_000_000;

interface Change {
  // ' ' for a line in both texts, '-' for one only the old text has, '+' for one only the new has.
  kind: ' ' | '-' | '+';
  text: string;
}

// The lines of a text without their line breaks. CRLF, CR and LF each end a line, and a line break
// at the end of the text does not start another one.
function linesOf(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
}

const lineAt = (lines: readonly string[], index: number): string => lines[index] ?? '';

// The changes that turn `a` into `b` when they have no start or end in common: a table of the
// length of the longest common run of lines from every pair of positions on, followed from the
// start. Where deleting and adding are equally good, the old line is deleted first, which makes
// every stretch of changes its deleted lines and then its added ones.
function between(a: string[], b: string[]): Change[] {
  if ((a.length + 1) * (b.length + 1) > MAX_TABLE_CELLS) {
    return [
      ...a.map((text): Change => ({ kind: '-', text })),
      ...b.map((text): Change => ({ kind: '+', text })),
    ];
  }
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  const common = (i: number, j: number): number => table[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        lineAt(a, i) === lineAt(b, j)
          ? common(i + 1, j + 1) + 1
          : Math.max(common(i + 1, j), common(i, j + 1));
    }
  }
  const changes: Change[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && lineAt(a, i) === lineAt(b, j)) {
      changes.push({ kind: ' ', text: lineAt(a, i) });
      i += 1;
      j += 1;
    } else if (i < a.length && (j === b.length || common(i + 1, j) >= common(i, j + 1))) {
      changes.push({ kind: '-', text: lineAt(a, i) });
      i += 1;
    } else {
      changes.push({ kind: '+', text: lineAt(b, j) });
      j += 1;
    }
  }
  return changes;
}

// Every line of both texts as a change: the lines the texts start and end with in common are cut
// off first, since a script and its fixed form differ in few places, and only what lies between
// them is compared.
function diffLines(a: string[], b: string[]): Change[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  const same = (text: string): Change => ({ kind: ' ', text });
  return [
    ...a.slice(0, head).map(same),
    ...between(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
    ...a.slice(a.length - tail).map(same),
  ];
}

// The difference between two texts as the hunks of a unified diff, each with `context` unchanged
// lines around its changes (default 3), or '' when there is none. A hunk starts with
// `@@ -a,b +c,d @@`, the first line and the number of lines it covers in the old text and in the
// new one (an empty range starts at the line before it), and goes on with one row per line: a
// space for a line both texts have, '-' for a deleted one and '+' for an added one. Changes whose
// context meets share a hunk. Every row ends with a line break. There is no file header, since the
// texts have no names.
//
// The texts are compared line by line, without their line breaks: CRLF, CR and LF are all line
// breaks, so a text and the same text with other line breaks have no difference, and neither has a
// text and the same with a line break at its end. The rows are written with LF.
//
// The diff is the shortest one (the longest common run of lines is kept), unless the texts differ
// by so many lines that comparing them takes a table of several million cells; see MAX_TABLE_CELLS.
// A context that is not a count of lines (negative, or not a number) counts as none.
export function unifiedDiff(before: string, after: string, context = 3): string {
  const keep = Math.max(0, Math.trunc(context) || 0);
  const changes = diffLines(linesOf(before), linesOf(after));

  // Runs of changes as the indexes of their first and last change, joined while the unchanged
  // lines between two of them fit in the context of both.
  const groups: { first: number; last: number }[] = [];
  changes.forEach(({ kind }, index) => {
    if (kind === ' ') {
      return;
    }
    const group = groups.at(-1);
    if (group !== undefined && index - group.last - 1 <= 2 * keep) {
      group.last = index;
    } else {
      groups.push({ first: index, last: index });
    }
  });

  // How many lines of the old and of the new text come before the change at `cursor`.
  let oldBefore = 0;
  let newBefore = 0;
  let cursor = 0;
  const pass = (to: number): void => {
    for (const { kind } of changes.slice(cursor, to)) {
      oldBefore += kind === '+' ? 0 : 1;
      newBefore += kind === '-' ? 0 : 1;
    }
    cursor = to;
  };

  return groups
    .map(({ first, last }) => {
      const from = Math.max(0, first - keep);
      const to = Math.min(changes.length, last + 1 + keep);
      pass(from);
      const [oldStart, newStart] = [oldBefore, newBefore];
      pass(to);
      const [oldCount, newCount] = [oldBefore - oldStart, newBefore - newStart];
      const header =
        `@@ -${String(oldCount === 0 ? oldStart : oldStart + 1)},${String(oldCount)} ` +
        `+${String(newCount === 0 ? newStart : newStart + 1)},${String(newCount)} @@`;
      return [header, ...changes.slice(from, to).map(({ kind, text }) => `${kind}${text}`)]
        .map((row) => `${row}\n`)
        .join('');
    })
    .join('');
}
