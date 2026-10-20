import {
  countedScripts,
  findSavedScripts,
  isOpenLimited,
  modifiedToIso,
  savedScriptLimit,
  scriptTypeOf,
  toSavedScript,
  type SavedScriptRow,
} from '../../../../src/tools/pine/scripts.js';

// The Node side of the saved Pine scripts: how a row of the list of the app becomes a tool result,
// and the replicas of the saved-script limit checks of the app (reverse-engineering notes of Plan 2,
// section Q1, "Paywall side effect"). Names are synthetic.

function row(overrides: Partial<SavedScriptRow> = {}): SavedScriptRow {
  return {
    scriptIdPart: 'USER;a',
    scriptName: 'Alpha',
    scriptTitle: 'Alpha Short',
    version: '1.0',
    modified: 1_729_987_200,
    kind: 'study',
    ...overrides,
  };
}

describe('modifiedToIso', () => {
  test('reads numbers above 1e11 as milliseconds and the rest as seconds', () => {
    expect(modifiedToIso(1_729_987_200)).toBe('2024-10-27T00:00:00Z');
    expect(modifiedToIso(1_729_987_200_000)).toBe('2024-10-27T00:00:00Z');
    expect(modifiedToIso(1_729_987_200_500)).toBe('2024-10-27T00:00:00Z');
  });

  test('reads a date string, and answers null for what is no time', () => {
    expect(modifiedToIso('2024-10-27T00:00:00.000Z')).toBe('2024-10-27T00:00:00Z');
    expect(modifiedToIso('yesterday')).toBeNull();
    expect(modifiedToIso(null)).toBeNull();
    expect(modifiedToIso(Number.NaN)).toBeNull();
    expect(modifiedToIso(0)).toBeNull();
    expect(modifiedToIso(-5)).toBeNull();
    expect(modifiedToIso(1e20)).toBeNull();
  });
});

test('scriptTypeOf maps the kinds of the app to the script types of the tools', () => {
  expect(scriptTypeOf('study')).toBe('indicator');
  expect(scriptTypeOf('strategy')).toBe('strategy');
  expect(scriptTypeOf('library')).toBe('library');
  expect(scriptTypeOf(null)).toBe('indicator');
  expect(scriptTypeOf('something')).toBe('indicator');
});

test('toSavedScript keeps the id, the name, the version, the type and the modified time', () => {
  expect(toSavedScript(row({ kind: 'strategy' }))).toEqual({
    id: 'USER;a',
    name: 'Alpha',
    version: '1.0',
    type: 'strategy',
    modified: '2024-10-27T00:00:00Z',
  });
  expect(toSavedScript(row({ scriptName: null, version: null, modified: null }))).toEqual({
    id: 'USER;a',
    name: 'Alpha Short',
    version: null,
    type: 'indicator',
    modified: null,
  });
  expect(toSavedScript(row({ scriptName: null, scriptTitle: null })).name).toBe('USER;a');
});

describe('savedScriptLimit', () => {
  const signedIn = { authenticated: true, limitEnabled: true, unlimited: 99999 };

  test('applies a limit below the unlimited value to a signed-in account', () => {
    expect(savedScriptLimit(signedIn, 3)).toBe(3);
    expect(savedScriptLimit(signedIn, 99999)).toBeNull();
    expect(savedScriptLimit({ ...signedIn, unlimited: null }, 99999)).toBeNull();
    expect(savedScriptLimit({ ...signedIn, unlimited: null }, 3)).toBe(3);
  });

  test('applies none signed out, with the toggle off, or without a known limit', () => {
    expect(savedScriptLimit({ ...signedIn, authenticated: false }, 3)).toBeNull();
    expect(savedScriptLimit({ ...signedIn, limitEnabled: false }, 3)).toBeNull();
    expect(savedScriptLimit(signedIn, null)).toBeNull();
    expect(savedScriptLimit(signedIn, undefined)).toBeNull();
  });

  test('applies the limit when the toggle cannot be read, which fails closed', () => {
    expect(savedScriptLimit({ ...signedIn, limitEnabled: null }, 3)).toBe(3);
  });
});

test('countedScripts leaves out server drafts, whose version parses to 0', () => {
  const rows = [
    row({ scriptIdPart: 'a', version: '1.0' }),
    row({ scriptIdPart: 'b', version: '0.3' }),
    row({ scriptIdPart: 'c', version: '0' }),
    row({ scriptIdPart: 'd', version: null }),
    row({ scriptIdPart: 'e', version: 'x' }),
  ];

  // parseInt of the app: a missing or unreadable version is NaN, which is not 0 and so counts.
  expect(countedScripts(rows).map(({ scriptIdPart }) => scriptIdPart)).toEqual(['a', 'd', 'e']);
});

describe('isOpenLimited', () => {
  const rows = [
    row({ scriptIdPart: 'old', modified: 100 }),
    row({ scriptIdPart: 'new', modified: 300 }),
    row({ scriptIdPart: 'mid', modified: 200 }),
    row({ scriptIdPart: 'draft', version: '0.1', modified: 50 }),
    row({ scriptIdPart: 'undated', modified: null }),
  ];

  test('limits the saved scripts outside the newest `limit` by modified', () => {
    expect(isOpenLimited(rows, 'new', 2)).toBe(false);
    expect(isOpenLimited(rows, 'mid', 2)).toBe(false);
    expect(isOpenLimited(rows, 'old', 2)).toBe(true);
    expect(isOpenLimited(rows, 'undated', 2)).toBe(true);
  });

  test('never limits a draft, an unknown script, or without a limit', () => {
    expect(isOpenLimited(rows, 'draft', 1)).toBe(false);
    expect(isOpenLimited(rows, 'unknown', 1)).toBe(false);
    expect(isOpenLimited(rows, 'old', null)).toBe(false);
  });

  test('orders numbers as they are, as the app does', () => {
    const close = [
      row({ scriptIdPart: 'a', modified: 1_729_987_200_100 }),
      row({ scriptIdPart: 'b', modified: 1_729_987_200_900 }),
    ];
    expect(isOpenLimited(close, 'a', 1)).toBe(true);
    expect(isOpenLimited(close, 'b', 1)).toBe(false);
    expect(isOpenLimited([row({ scriptIdPart: 'x', modified: 'no date' }), row()], 'x', 1)).toBe(
      true,
    );
  });

  test('reads string times for the order too', () => {
    const dated = [
      row({ scriptIdPart: 'a', modified: '2024-01-01T00:00:00Z' }),
      row({ scriptIdPart: 'b', modified: '2024-06-01T00:00:00Z' }),
    ];
    expect(isOpenLimited(dated, 'a', 1)).toBe(true);
    expect(isOpenLimited(dated, 'b', 1)).toBe(false);
  });
});

describe('findSavedScripts', () => {
  const rows = [
    row({ scriptIdPart: 'USER;a', scriptName: 'Alpha', scriptTitle: 'Al' }),
    row({ scriptIdPart: 'USER;b', scriptName: 'Beta', scriptTitle: 'alpha' }),
    row({ scriptIdPart: 'USER;c', scriptName: null, scriptTitle: null }),
  ];

  test('finds by id exactly, and by name or title case aside', () => {
    expect(findSavedScripts(rows, { scriptId: 'USER;b' }).map((r) => r.scriptIdPart)).toEqual([
      'USER;b',
    ]);
    expect(findSavedScripts(rows, { scriptId: 'user;b' })).toEqual([]);
    expect(findSavedScripts(rows, { name: ' ALPHA ' }).map((r) => r.scriptIdPart)).toEqual([
      'USER;a',
      'USER;b',
    ]);
    expect(findSavedScripts(rows, { name: 'al' }).map((r) => r.scriptIdPart)).toEqual(['USER;a']);
    expect(findSavedScripts(rows, { name: 'gamma' })).toEqual([]);
  });
});
