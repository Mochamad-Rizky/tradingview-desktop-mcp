// A small tokenizer for Pine Script, enough for the analyzer rules to match identifiers and call
// sites without being fooled by comments or string literals. Pine has line comments (//) only, and
// strings in double or single quotes with backslash escapes.
//
// Positions follow the convention of the compile results (mappers.ts): lines are 1-based, columns
// are 1-based UTF-16 code units (the unit of JavaScript strings and of Monaco, so a tab is one
// column and an emoji two), and a CRLF counts as one line break. Every token lies on one line.

export type TokenKind = 'comment' | 'string' | 'ident' | 'number' | 'punct';

export interface Token {
  kind: TokenKind;
  text: string;
  line: number;
  column: number;
  // The column right after the token.
  endColumn: number;
}

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;
const NUMBER = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const TWO_CHAR = new Set(['==', '!=', '<=', '>=', ':=', '=>', '+=', '-=', '*=', '/=', '%=']);

function matchAt(pattern: RegExp, source: string, index: number): string | null {
  pattern.lastIndex = index;
  return pattern.exec(source)?.[0] ?? null;
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let line = 1;
  let lineStart = 0;
  let i = 0;
  const push = (kind: TokenKind, length: number): void => {
    const column = i - lineStart + 1;
    tokens.push({
      kind,
      text: source.slice(i, i + length),
      line,
      column,
      endColumn: column + length,
    });
    i += length;
  };

  while (i < source.length) {
    const ch = source.charAt(i);
    if (ch === '\r' || ch === '\n') {
      i += ch === '\r' && source.charAt(i + 1) === '\n' ? 2 : 1;
      line += 1;
      lineStart = i;
    } else if (ch === ' ' || ch === '\t') {
      i += 1;
    } else if (ch === '/' && source.charAt(i + 1) === '/') {
      let end = i;
      while (end < source.length && source.charAt(end) !== '\r' && source.charAt(end) !== '\n') {
        end += 1;
      }
      push('comment', end - i);
    } else if (ch === '"' || ch === "'") {
      // A string ends at its closing quote, or at the end of the line when it is unterminated.
      let end = i + 1;
      while (end < source.length) {
        const c = source.charAt(end);
        if (c === '\r' || c === '\n') {
          break;
        }
        end += 1;
        if (c === '\\' && end < source.length && !'\r\n'.includes(source.charAt(end))) {
          end += 1;
        } else if (c === ch) {
          break;
        }
      }
      push('string', end - i);
    } else {
      const ident = matchAt(IDENT, source, i);
      const number = ident === null ? matchAt(NUMBER, source, i) : null;
      if (ident !== null) {
        push('ident', ident.length);
      } else if (number !== null) {
        push('number', number.length);
      } else {
        push('punct', TWO_CHAR.has(source.slice(i, i + 2)) ? 2 : 1);
      }
    }
  }
  return tokens;
}
