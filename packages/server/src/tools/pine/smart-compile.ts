import { unifiedDiff } from '../../utils/diff.js';
import { analyzePine, type PineFix } from './analyze/analyze.js';
import { applyFixes } from './analyze/fixes.js';
import { renameFix, V4_RENAMES, versionOf } from './analyze/rules.js';
import { tokenize } from './analyze/tokenize.js';
import type { PineCompileError, PineCompileResult } from './mappers.js';

// The fixing loop of pine_smart_compile (design spec 7): compile, apply fixes, compile again. The
// fixes are rules written down here and in the analyzer, and nothing in this file calls a model or
// reaches the editor or the chart: the tool (index.ts) says where the text comes from and whether
// the result is written back.

// The message of the compiler for a name that is not declared, as normalizeCompileErrors words it.
const UNDECLARED = /^Undeclared identifier "([A-Za-z_]\w*)"$/;

// The fixes that compile errors point at. An error "Undeclared identifier" at a call of a v4 name
// that Pine v5 renamed or moved into a namespace (rsi, study, security, ...) gets the rename of
// that call, the very fix the analyzer offers for it. The analyzer leaves a call alone when the
// script declares the name itself, as in `rsi = rsi(close, 14)`, whose right side is not yet
// declared; the compiler says so, and this adds the fix.
//
// Only an error at an identifier that is called (followed by an opening parenthesis, not by a dot
// before it) and is the name the message gives, found by its position in the text, counts, so an
// error that does not match the text gets no fix. A script below version 5 gets none, as in the
// analyzer: its header is not rewritten, and v5 names under it would not compile.
export function fixesForCompileErrors(source: string, errors: PineCompileError[]): PineFix[] {
  const tokens = tokenize(source);
  const version = versionOf(tokens.filter(({ kind }) => kind === 'comment'))?.version ?? null;
  if (version !== null && version < 5) {
    return [];
  }
  const code = tokens.filter(({ kind }) => kind !== 'comment');
  const indexAt = new Map(
    code.map((token, index) => [`${String(token.line)}:${String(token.column)}`, index]),
  );
  return errors.flatMap(({ message, line, column }) => {
    const name = UNDECLARED.exec(message)?.[1] ?? '';
    const target = V4_RENAMES.get(name);
    const index = indexAt.get(`${String(line)}:${String(column)}`) ?? -1;
    const token = code[index];
    return target !== undefined &&
      token?.kind === 'ident' &&
      token.text === name &&
      code[index + 1]?.text === '(' &&
      code[index - 1]?.text !== '.'
      ? [renameFix(token, target)]
      : [];
  });
}

// Every fix to try on the text: those of the analyzer, then those the errors point at, without
// the fixes that make an edit an earlier one made.
export function collectFixes(source: string, errors: PineCompileError[]): PineFix[] {
  const seen = new Set<string>();
  return [
    ...analyzePine(source).flatMap(({ fix }) => (fix === null ? [] : [fix])),
    ...fixesForCompileErrors(source, errors),
  ].filter(({ edits }) => {
    const key = JSON.stringify(edits);
    const first = !seen.has(key);
    seen.add(key);
    return first;
  });
}

// Compiles `start` with `compile` and, while the text has errors, applies the fixes and compiles
// the fixed text, up to maxAttempts compilations. It stops when a compilation succeeds, when
// applyFixes is false, when the attempts are used up and when no fix changes the text.
//
// A fix is applied only when another compilation follows it, so the text returned is always the one
// the last attempt compiled and `success` and the errors of the last attempt are about it. Each
// attempt lists the errors of its compilation and the descriptions of the fixes applied after it,
// which made the text of the next attempt; the last attempt applied none. `last` is the whole
// result of the last compilation. A failure of `compile` (TradingView not compiling at all) is
// passed on, since the attempts so far are not a result of the call.
export async function smartCompile(
  compile: (source: string) => Promise<PineCompileResult>,
  start: string,
  options: { maxAttempts: number; applyFixes: boolean },
): Promise<{
  success: boolean;
  attempts: { errors: PineCompileError[]; applied: string[] }[];
  source: string;
  diff: string;
  last: PineCompileResult;
}> {
  const attempts: { errors: PineCompileError[]; applied: string[] }[] = [];
  let source = start;
  for (;;) {
    const last = await compile(source);
    // Phrased as "< maxAttempts" so that a count that is not a number allows no more attempts.
    const fixed =
      !last.success && options.applyFixes && attempts.length + 1 < options.maxAttempts
        ? applyFixes(source, collectFixes(source, last.errors))
        : null;
    if (fixed === null || fixed.source === source) {
      attempts.push({ errors: last.errors, applied: [] });
      return { success: last.success, attempts, source, diff: unifiedDiff(start, source), last };
    }
    attempts.push({ errors: last.errors, applied: fixed.applied });
    source = fixed.source;
  }
}
