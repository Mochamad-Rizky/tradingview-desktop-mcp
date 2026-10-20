import type { Token } from './tokenize.js';

// The rules of the offline Pine analyzer. Each is deterministic and matches identifiers and call
// sites on tokens, never on raw text, so code in comments and strings gives nothing.

// These two are type aliases, not interfaces: they are tool output, which must satisfy JsonValue.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type PineFix = {
  description: string;
  // Single-line edits: replace the columns [column, endColumn) of the line (1-based, UTF-16 code
  // units). An insertion has column === endColumn.
  edits: { line: number; column: number; endColumn: number; replacement: string }[];
};

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type PineDiagnostic = {
  ruleId: string;
  severity: 'error' | 'warning' | 'info';
  line: number;
  column: number;
  message: string;
  fix: PineFix | null;
};

// What a rule sees. `code` is the token stream without comments.
export interface RuleContext {
  code: Token[];
  version: number | null;
  // The names the script declares itself, as a variable or a function.
  declared: ReadonlySet<string>;
}

export type Rule = (ctx: RuleContext) => PineDiagnostic[];

const TARGET_VERSION = 6;
const MAX_PLOTS = 64;
const DECLARATIONS = new Set(['indicator', 'study', 'strategy', 'library']);
const PLOT_CALLS = new Set(['plot', 'plotshape', 'plotchar', 'plotarrow', 'plotbar', 'plotcandle']);
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

// Whether code[i] starts a line at column 1, optionally after export or method. Functions are
// declared at the top level; an indented `name(…) =>` is a switch case.
function startsLine(code: Token[], i: number): boolean {
  let j = i;
  const line = code[i]?.line;
  while (
    code[j - 1]?.line === line &&
    (code[j - 1]?.text === 'export' || code[j - 1]?.text === 'method')
  ) {
    j -= 1;
  }
  return code[j - 1]?.line !== line && code[j]?.column === 1;
}

// The names declared by the script: `name = …` (also with a type or var before it) and
// `name(…) =>` at the start of a top-level line. Tuple outputs are not counted: v4 scripts name an output
// after the built-in they call, as in `[macd, signal, hist] = macd(…)`.
export function declaredNames(code: Token[]): Set<string> {
  const names = new Set<string>();
  code.forEach((token, i) => {
    if (token.kind !== 'ident' || code[i - 1]?.text === '.') {
      return;
    }
    const next = code[i + 1]?.text;
    if (next === '=') {
      names.add(token.text);
    } else if (next === '(') {
      let depth = 0;
      for (let j = i + 1; j < code.length; j += 1) {
        const text = code[j]?.text;
        depth += text === '(' ? 1 : text === ')' ? -1 : 0;
        if (depth === 0) {
          if (code[j + 1]?.text === '=>' && startsLine(code, i)) {
            names.add(token.text);
          }
          break;
        }
      }
    }
  });
  return names;
}

// Whether code[i] is a call of a bare name: `name(`, not preceded by a dot (so `ta.sma(` and
// `request.security(` are not).
function isBareCall(code: Token[], i: number): boolean {
  const token = code[i];
  return token?.kind === 'ident' && code[i + 1]?.text === '(' && code[i - 1]?.text !== '.';
}

function bareCalls(ctx: RuleContext, names: ReadonlySet<string>): Token[] {
  return ctx.code.filter(
    (token, i) => isBareCall(ctx.code, i) && names.has(token.text) && !ctx.declared.has(token.text),
  );
}

function diagnostic(
  ruleId: string,
  severity: PineDiagnostic['severity'],
  at: { line: number; column: number },
  message: string,
  fix: PineFix | null = null,
): PineDiagnostic {
  return { ruleId, severity, line: at.line, column: at.column, message, fix };
}

function renameFix(token: Token, replacement: string): PineFix {
  return {
    description: `Replace ${token.text}( with ${replacement}(`,
    edits: [{ line: token.line, column: token.column, endColumn: token.endColumn, replacement }],
  };
}

function renameRule(
  ruleId: string,
  names: readonly string[],
  target: (name: string) => string,
  reason: string,
): Rule {
  const set = new Set(names);
  return (ctx) => {
    // A script below v5 would break with v5 calls under its v4 header, and these rules do not
    // rewrite the header, so they offer no fix for it.
    const upgradeFirst = ctx.version !== null && ctx.version < 5;
    return bareCalls(ctx, set).map((token) =>
      diagnostic(
        ruleId,
        'warning',
        token,
        `${token.text}( ${reason}; use ${target(token.text)}(` +
          (upgradeFirst
            ? `, which needs the script upgraded from v${String(ctx.version)} to v5 or later first`
            : ''),
        upgradeFirst ? null : renameFix(token, target(token.text)),
      ),
    );
  };
}

const missingDeclaration = (ctx: RuleContext) =>
  !ctx.code.some((token, i) => isBareCall(ctx.code, i) && DECLARATIONS.has(token.text));

// The kind of the first declaration call of the script, null when it has none.
function declarationKind(ctx: RuleContext): string | null {
  const index = ctx.code.findIndex(
    (token, i) => isBareCall(ctx.code, i) && DECLARATIONS.has(token.text),
  );
  return ctx.code[index]?.text ?? null;
}

export const RULES: Rule[] = [
  // missing-version and old-version read the //@version comment, so analyze.ts adds them.
  renameRule('study-declaration', ['study'], () => 'indicator', 'was renamed in Pine v5'),
  renameRule(
    'security-namespace',
    ['security'],
    () => 'request.security',
    'moved to the request namespace in Pine v5',
  ),
  renameRule(
    'ta-namespace',
    TA_NAMES,
    (name) => `ta.${name}`,
    'moved to the ta namespace in Pine v5',
  ),
  renameRule(
    'str-namespace',
    ['tostring'],
    () => 'str.tostring',
    'moved to the str namespace in Pine v5',
  ),
  (ctx) =>
    missingDeclaration(ctx)
      ? [
          diagnostic(
            'missing-declaration',
            'error',
            { line: 1, column: 1 },
            'The script has no indicator(), strategy() or library() declaration',
          ),
        ]
      : [],
  (ctx) => {
    const kind = declarationKind(ctx);
    if (kind !== 'indicator' && kind !== 'study') {
      return [];
    }
    const calls = ctx.code.filter((token, i) => {
      if (token.text !== 'strategy' || token.kind !== 'ident' || ctx.code[i - 1]?.text === '.') {
        return false;
      }
      let j = i + 1;
      while (ctx.code[j]?.text === '.' && ctx.code[j + 1]?.kind === 'ident') {
        j += 2;
      }
      return j > i + 1 && ctx.code[j]?.text === '(';
    });
    const [first] = calls;
    return first === undefined
      ? []
      : [
          diagnostic(
            'strategy-calls-without-strategy',
            'error',
            first,
            `strategy.* calls (${String(calls.length)}) need a strategy() declaration, but the ` +
              `script is ${kind === 'study' ? 'a' : 'an'} ${kind}`,
          ),
        ];
  },
  (ctx) =>
    ctx.code.flatMap((token, i) => {
      const rest = ctx.code.slice(i, i + 5).map(({ text }) => text);
      return token.text === 'lookahead' &&
        token.kind === 'ident' &&
        rest.slice(1).join('') === '=barmerge.lookahead_on'
        ? [
            diagnostic(
              'lookahead-repaint',
              'warning',
              token,
              'lookahead = barmerge.lookahead_on makes the historical values differ from the ' +
                'real-time ones (repainting)',
            ),
          ]
        : [];
    }),
  (ctx) => {
    const plots = bareCalls(ctx, PLOT_CALLS);
    const excess = plots[MAX_PLOTS];
    return excess === undefined
      ? []
      : [
          diagnostic(
            'too-many-plots',
            'error',
            excess,
            `The script has ${String(plots.length)} plot calls; Pine allows at most ` +
              String(MAX_PLOTS),
          ),
        ];
  },
];

// The rules about the //@version comment, which tokens cannot match: comments are tokens of their
// own kind.
export function versionOf(comments: Token[]): { version: number; token: Token } | null {
  for (const token of comments) {
    const match = /^\/\/\s*@version\s*=\s*(\d+)/.exec(token.text);
    if (match?.[1] !== undefined) {
      return { version: Number(match[1]), token };
    }
  }
  return null;
}

export function versionDiagnostics(
  found: { version: number; token: Token } | null,
  eol = '\n',
): PineDiagnostic[] {
  if (found === null) {
    return [
      diagnostic(
        'missing-version',
        'error',
        { line: 1, column: 1 },
        `The script has no //@version annotation; TradingView would read it as an old version`,
        {
          description: `Add //@version=${String(TARGET_VERSION)} on line 1`,
          edits: [
            {
              line: 1,
              column: 1,
              endColumn: 1,
              replacement: `//@version=${String(TARGET_VERSION)}${eol}`,
            },
          ],
        },
      ),
    ];
  }
  return found.version < 5
    ? [
        diagnostic(
          'old-version',
          'info',
          found.token,
          `Pine Script v${String(found.version)} is old; v5 and later are current`,
        ),
      ]
    : [];
}
