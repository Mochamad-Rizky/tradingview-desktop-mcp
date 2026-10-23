import { readdirSync, readFileSync } from 'node:fs';

// The end-to-end suites run against the app of the person running them, and a failed assertion
// prints what it received: the bars of their chart, a warning that names its symbol, the ids of
// their studies, the script of their Pine Editor. So the suites compare such values without
// printing them, in the form expect(a === b, 'what is compared').toBe(true) (sameJson of setup.ts
// for lists), and none of the forms below, which print what they received, is left in them. Values
// a test made itself (its own scripts, its own study) may still be printed.

const E2E_DIR = new URL('../../e2e/', import.meta.url);

const PRINTING: readonly [RegExp, string][] = [
  [
    /expect\(\s*[\w.?]*\bwarnings\s*(?:\?\?\s*\[\s*\]\s*)?\)\s*\.(?:toEqual|toStrictEqual|toHaveLength|toContain)\(/,
    'compares warnings, which can name the chart symbol, with a matcher that prints them',
  ],
  [
    /expect\(\s*[\w.?]*\b(?:others|elements)\s*\)\s*\.(?:toEqual|toStrictEqual|toHaveLength)\(/,
    'compares elements of the page, whose names and texts can be the user’s, with a matcher that prints them',
  ],
  [
    /expect\(\s*[\w.?]*\.(?:bars|rows)\s*\)\s*\.toHaveLength\(/,
    'counts bars or rows with toHaveLength, which prints them',
  ],
  [
    /\.map\(\(\{\s*id\s*\}\)\s*=>\s*id\)\s*\)\s*\.toEqual\(/,
    'compares the ids of studies with toEqual, which prints them',
  ],
  [
    /expect\(\s*[\w.?]*\.(?:symbol|resolution|chartType|url)\s*\)\s*\.(?:toBe|toMatch)\(/,
    'checks a value of the chart or the app with a matcher that prints it',
  ],
  [
    /expect\(\s*[\w.?]*\bdata\s*\)\s*\.(?:toMatchObject|toEqual)\(\s*\{\s*(?:levels|symbol|resolution|chartType)\b/,
    'matches data of the chart, which the matcher prints whole',
  ],
  [
    /expect\(\s*[\w.?]*\bdata\s*\)\s*\.(?:toMatchObject|toEqual)\(\s*\{\s*(?:removed\s*:\s*\[|(?:notListed|added|skipped|symbols)\b)/,
    'matches what a watchlist tool returns, which can list the user’s symbols, with a matcher that prints it',
  ],
  [
    /expect\(\s*[\w.?]*\.state(?:\.script)?\s*\)\s*\.(?:toMatchObject|toBeNull)\(/,
    'checks the state of the Pine Editor, whose script can be the user’s, with a matcher that prints it',
  ],
  [
    /expect\(\s*[\w.?]*\.data\s*\)\s*\.toMatchObject\(\s*\{\s*(?:type|script)\b/,
    'matches what an editor tool returns, whose script can be the user’s, with a matcher that prints it',
  ],
  [
    /expect\(\s*[\w.?]*\.data\.script\s*\)\s*\.toBeNull\(/,
    'checks the script of the editor with a matcher that prints it',
  ],
  [
    /expect\(\s*[\w.?]*\.dialogs\s*\)\s*\.toEqual\(/,
    'compares the dialogs of the app with toEqual, which prints them',
  ],
  [
    /expect\(\s*[\w.?]*\.details\s*\)\s*\.toMatchObject\(/,
    'matches error details with a matcher that prints them',
  ],
  [
    /expect\(\s*[\w.?]*\.message\s*\)\s*\.toMatch\(/,
    'checks an error message, which can name what the user has, with a matcher that prints it',
  ],
];

// Each assertion of a file, from its expect( to the end of its statement, with the number of the
// line it starts on.
function assertionsOf(text: string): { line: number; statement: string }[] {
  const lines = text.split('\n');
  return lines.flatMap((line, index) => {
    const start = line.indexOf('expect(');
    if (start === -1) {
      return [];
    }
    const rest = [line.slice(start), ...lines.slice(index + 1, index + 4)].join(' ');
    const end = rest.indexOf(';');
    return [
      { line: index + 1, statement: (end === -1 ? rest : rest.slice(0, end)).replace(/\s+/g, ' ') },
    ];
  });
}

test('the E2E suites compare the values of the app without printing them', () => {
  const found: string[] = [];
  for (const file of readdirSync(E2E_DIR)
    .filter((name) => name.endsWith('.ts'))
    .sort()) {
    for (const { line, statement } of assertionsOf(readFileSync(new URL(file, E2E_DIR), 'utf8'))) {
      for (const [pattern, why] of PRINTING) {
        if (pattern.test(statement)) {
          found.push(`${file}:${String(line)} ${why}`);
        }
      }
    }
  }

  expect(found).toEqual([]);
});

test('the check finds the forms that print what they received', () => {
  const statements = [
    'expect(warnings).toEqual([]);',
    'expect(data.bars).toHaveLength(count);',
    'expect(after.map(({ id }) => id)).toEqual(studies.map(({ id }) => id));',
    'expect(switched.data.symbol).toMatch(/:AAPL$/);',
    'expect(reopened.state).toMatchObject({ open: true });',
    'expect(envelope.meta.warnings ?? []).toEqual([]);',
    'expect(others).toEqual([]);',
    "expect(notListed.data).toMatchObject({ removed: [], notListed: ['EXAMPLE:X'] });",
  ];
  const ok = [
    "expect(warnings.length === 0, 'no warnings').toBe(true);",
    "expect(sameJson(after, studies), 'the studies are those of before').toBe(true);",
    "expect(error.code).toBe('PLAN_LIMIT');",
  ];

  const matches = (statement: string) => PRINTING.some(([pattern]) => pattern.test(statement));

  expect(statements.filter((statement) => !matches(statement))).toEqual([]);
  expect(ok.filter(matches)).toEqual([]);
  expect(
    assertionsOf('a();\n  expect(x)\n    .toBe(1);\nb();').map(({ statement }) => statement),
  ).toEqual(['expect(x) .toBe(1)']);
});
