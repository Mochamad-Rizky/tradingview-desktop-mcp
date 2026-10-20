import type { PineFix } from './rules.js';

type Edit = PineFix['edits'][number];

// Whether two edits of the same line touch the same columns. Two insertions at one column also
// conflict, as their order would be arbitrary.
function overlaps(a: Edit, b: Edit): boolean {
  return (
    a.line === b.line &&
    (a.column === b.column || (a.column < b.endColumn && b.column < a.endColumn))
  );
}

// The offset where each line starts; a CRLF counts as one line break.
function lineStarts(source: string): number[] {
  const starts = [0];
  for (const match of source.matchAll(/\r\n|\r|\n/g)) {
    starts.push(match.index + match[0].length);
  }
  return starts;
}

const later = (a: Edit, b: Edit): number => b.line - a.line || b.column - a.column;

// Applies the fixes to the source: the edits go in from the bottom of the file up, so earlier
// positions stay valid. A fix with an edit that overlaps an edit of a fix already taken is
// skipped as a whole. `applied` lists the descriptions of the fixes that were applied, in the
// order given.
export function applyFixes(
  source: string,
  fixes: PineFix[],
): { source: string; applied: string[] } {
  const starts = lineStarts(source);
  const byPosition = [...fixes.keys()].sort((a, b) => {
    const [x, y] = [fixes[a]?.edits[0], fixes[b]?.edits[0]];
    return x === undefined || y === undefined ? 0 : later(x, y);
  });
  const taken: Edit[] = [];
  const takenFixes = new Set<number>();
  for (const index of byPosition) {
    const fix = fixes[index];
    if (
      fix?.edits.every(
        (edit) => starts[edit.line - 1] !== undefined && !taken.some((t) => overlaps(t, edit)),
      ) === true
    ) {
      taken.push(...fix.edits);
      takenFixes.add(index);
    }
  }
  let result = source;
  for (const edit of taken.sort(later)) {
    const start = starts[edit.line - 1] ?? 0;
    result =
      result.slice(0, start + edit.column - 1) +
      edit.replacement +
      result.slice(start + edit.endColumn - 1);
  }
  const applied = fixes
    .filter((_, index) => takenFixes.has(index))
    .map(({ description }) => description);
  return { source: result, applied };
}
