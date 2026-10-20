import {
  declaredNames,
  RULES,
  versionDiagnostics,
  versionOf,
  type PineDiagnostic,
} from './rules.js';
import { tokenize } from './tokenize.js';

export type { PineDiagnostic, PineFix } from './rules.js';

// The version of a //@version=N annotation, null when the source has none.
export function pineVersion(source: string): number | null {
  const tokens = tokenize(source);
  return versionOf(tokens.filter(({ kind }) => kind === 'comment'))?.version ?? null;
}

// Runs every rule over the source and answers the diagnostics sorted by line, then column. It is
// deterministic and runs offline.
export function analyzePine(source: string): PineDiagnostic[] {
  const tokens = tokenize(source);
  const found = versionOf(tokens.filter(({ kind }) => kind === 'comment'));
  const code = tokens.filter(({ kind }) => kind !== 'comment');
  const ctx = { code, version: found?.version ?? null, declared: declaredNames(code) };
  const diagnostics = [
    ...versionDiagnostics(found, /\r\n|\r|\n/.exec(source)?.[0]),
    ...RULES.flatMap((rule) => rule(ctx)),
  ];
  return diagnostics
    .map((entry, order) => ({ entry, order }))
    .sort(
      (a, b) => a.entry.line - b.entry.line || a.entry.column - b.entry.column || a.order - b.order,
    )
    .map(({ entry }) => entry);
}
