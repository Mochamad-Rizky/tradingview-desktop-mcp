import { toIso } from '../../utils/time.js';
import type { readPineConsole } from './page.js';

// How the compile results and the console of the Pine Editor become what the Pine tools return
// (reverse-engineering notes of Plan 2, sections Q3 and Q4).

// A message of pine_get_console. A message of the editor console has no date (the app keeps only a
// local clock time), so time and timeIso are null and clock holds that clock time as the app shows
// it; a message of a script has its time and the id of its study.
export type PineConsoleMessage =
  | {
      time: null;
      timeIso: null;
      level: string;
      text: string;
      source: 'editor';
      clock: string | null;
    }
  | {
      time: number | null;
      timeIso: string | null;
      level: string;
      text: string;
      source: 'script';
      studyId: string;
    };

// Numbers above this are milliseconds and the rest seconds, the rule of the time inputs (design
// spec 5.1).
const MILLISECONDS_ABOVE = 1e11;

// The last second Date can print with a four-digit year, 9999-12-31T23:59:59Z.
const MAX_SECONDS = 253_402_300_799;

const positive = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);

// The errors and warnings of a compilation, from the compile errors of the app ({ errors, warnings },
// each a list of diagnostics { message, ctx?, start?, end? }) or the diagnostics the page functions
// answer. Anything that is not compile errors gives none.
//
// Each is a PineCompileError. line and column are 1-based and point into the compiled text, where a
// CRLF counts as one line break (so does a lone CR or LF; the compiler counts a CRLF as one, as seen
// on the app). endLine and endColumn are where it ends, the end column included, null when the
// compiler gave no end. A diagnostic without a column (column 0 from the compiler, as legacy and
// runtime messages have) is reported at column 1 of its line with endColumn null, which stands for
// the whole line; one without any place at line 1, column 1, with no end.
//
// Columns are taken to count UTF-16 code units, the unit of JavaScript strings and of Monaco, the
// code editor of the app, which takes the columns of the compiler as they are: a tab is one column,
// é one, and a character outside the Basic Multilingual Plane (an emoji) two. Positions are kept as
// the compiler gives them and only clamped into `source` in that unit: a line past the last one
// becomes the last line, and a column past the end of its line the column right after it.
//
// The {name} placeholders of a message are filled from ctx; a placeholder ctx has no text, number
// or boolean for stays as it is.
export function normalizeCompileErrors(
  raw: unknown,
  source: string,
): Record<
  'errors' | 'warnings',
  {
    line: number;
    column: number;
    endLine: number | null;
    endColumn: number | null;
    message: string;
    severity: 'error' | 'warning';
  }[]
> {
  const lines = source.split(/\r\n|\r|\n/);
  const lengthOf = (line: number): number => lines[line - 1]?.length ?? 0;
  const container = (typeof raw === 'object' && raw !== null ? raw : {}) as {
    errors?: unknown;
    warnings?: unknown;
  };
  const convert = (list: unknown, severity: 'error' | 'warning'): PineCompileError[] =>
    (Array.isArray(list) ? (list as unknown[]) : []).map((item) => {
      const diagnostic = (typeof item === 'object' && item !== null ? item : {}) as {
        message?: unknown;
        ctx?: unknown;
        start?: { line?: unknown; column?: unknown } | null;
        end?: { line?: unknown; column?: unknown } | null;
      };
      const ctx = (
        typeof diagnostic.ctx === 'object' && diagnostic.ctx !== null ? diagnostic.ctx : {}
      ) as Record<string, unknown>;
      const message =
        typeof diagnostic.message === 'string'
          ? diagnostic.message.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
              const value = Object.hasOwn(ctx, name) ? ctx[name] : undefined;
              return typeof value === 'string' ||
                typeof value === 'number' ||
                typeof value === 'boolean'
                ? String(value)
                : placeholder;
            })
          : `Unknown compile ${severity}`;

      const startLine = positive(diagnostic.start?.line);
      const startColumn = startLine === null ? null : positive(diagnostic.start?.column);
      const line = clamp(startLine ?? 1, 1, lines.length);
      const column = startColumn === null ? 1 : clamp(startColumn, 1, lengthOf(line) + 1);
      const rawEndLine = startLine === null ? null : positive(diagnostic.end?.line);
      const endLine = rawEndLine === null ? null : clamp(rawEndLine, line, lines.length);
      const rawEndColumn =
        endLine === null || startColumn === null ? null : positive(diagnostic.end?.column);
      const endColumn =
        endLine === null || rawEndColumn === null
          ? null
          : clamp(
              Math.max(rawEndColumn, endLine === line ? column : 1),
              1,
              Math.max(lengthOf(endLine) + 1, endLine === line ? column : 1),
            );
      return { line, column, endLine, endColumn, message, severity };
    });
  return {
    errors: convert(container.errors, 'error'),
    warnings: convert(container.warnings, 'warning'),
  };
}

export type PineCompileError = ReturnType<typeof normalizeCompileErrors>['errors'][number];

// What one compilation came to, a PineCompileResult. added is what became of adding the script to
// the chart, null for a compilation alone. success is true when there are no errors and, for a
// script added to the chart, the study was added and TradingView reports no compile error for it.
// addedToChart and studyId say whether a study of the script was put on the chart and its id.
// compiledAt is when the server got the result, in Unix seconds, and compiledAtIso the same as ISO
// 8601; both are null only in the empty result pine_get_errors gives before any compilation.
export function toCompileResult(
  diagnostics: { errors: PineCompileError[]; warnings: PineCompileError[] },
  added: { studyId: string | null; compileError: boolean | null } | null,
  compiledAt: number,
): {
  success: boolean;
  errors: PineCompileError[];
  warnings: PineCompileError[];
  addedToChart: boolean;
  studyId: string | null;
  compiledAt: number | null;
  compiledAtIso: string | null;
} {
  const studyId = added?.studyId ?? null;
  return {
    success:
      diagnostics.errors.length === 0 &&
      (added === null || (studyId !== null && added.compileError !== true)),
    errors: diagnostics.errors,
    warnings: diagnostics.warnings,
    addedToChart: studyId !== null,
    studyId,
    compiledAt,
    compiledAtIso: toIso(compiledAt),
  };
}

export type PineCompileResult = ReturnType<typeof toCompileResult>;

// The time of a Pine log in Unix seconds (with a fraction for milliseconds), or null for what is no
// time. The unit the app gives is not known, so a number above 1e11 is taken as milliseconds, the
// rule of the time inputs.
export function logTimeToSeconds(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const seconds = value > MILLISECONDS_ABOVE ? value / 1000 : value;
  return seconds <= MAX_SECONDS ? seconds : null;
}

type ConsoleReading = Pick<ReturnType<typeof readPineConsole>, 'editor' | 'scripts'>;

// The messages of the editor console and of the Pine logs in one list, newest first, at most
// `limit`. Editor messages sort by the key the page derived from their clock, logs by their time,
// else their bar time; a log with neither comes last. Levels are lower case.
export function mergeConsoleMessages(reading: ConsoleReading, limit: number): PineConsoleMessage[] {
  const keyed: { key: number; message: PineConsoleMessage }[] = [];
  for (const entry of [...(reading.editor ?? [])].reverse()) {
    keyed.push({
      key: entry.order ?? Number.NEGATIVE_INFINITY,
      message: {
        time: null,
        timeIso: null,
        level: entry.level.toLowerCase(),
        text: entry.text,
        source: 'editor',
        clock: entry.clock,
      },
    });
  }
  for (const log of reading.scripts) {
    const seconds = logTimeToSeconds(log.time) ?? logTimeToSeconds(log.barTime);
    const time = seconds === null ? null : Math.floor(seconds);
    keyed.push({
      key: seconds === null ? Number.NEGATIVE_INFINITY : seconds * 1000,
      message: {
        time,
        timeIso: time === null ? null : toIso(time),
        level: log.level.toLowerCase(),
        text: log.text,
        source: 'script',
        studyId: log.studyId,
      },
    });
  }
  // Array.prototype.sort is stable, so equal keys keep the order above.
  return keyed
    .sort((a, b) => (a.key === b.key ? 0 : b.key > a.key ? 1 : -1))
    .slice(0, limit)
    .map(({ message }) => message);
}
