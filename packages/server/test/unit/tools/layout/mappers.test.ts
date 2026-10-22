import { PlanLimitError, TvMcpError } from '../../../../src/core/errors.js';
import {
  CHART_STORAGE_HINT,
  dataNotReadyWarning,
  layoutIdFromUrl,
  layoutNameOf,
  MAX_LAYOUT_NAME,
  NO_ID_WARNING,
  notCreatedError,
  notOpenedError,
  notOpenedWarning,
  overLimitError,
  permissionRefusedError,
  permissionUnknownError,
  signedOutError,
  toLayoutListing,
  unfinishedLoadWarning,
  unknownLayoutError,
  unreadableLayoutsWarning,
  unsavedChangesError,
} from '../../../../src/tools/layout/mappers.js';
import type { SavedLayoutRow } from '../../../../src/tools/layout/page.js';

// The pure parts of the layout tools: how a saved layout is reported, how the id of a new layout is
// read from its URL, how a name is checked, and the errors and warnings. Values are synthetic.

function thrown(call: () => unknown): TvMcpError {
  try {
    call();
  } catch (error) {
    if (error instanceof TvMcpError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the call to throw');
}

const row = (change: Partial<SavedLayoutRow> = {}): SavedLayoutRow => ({
  url: 'FIXTURE1',
  name: 'Fixture Layout',
  modified: 1767225600,
  overLimit: false,
  ...change,
});

describe('toLayoutListing', () => {
  test('reports each saved layout by its url, in the order given, with its time in seconds and as ISO', () => {
    expect(
      toLayoutListing([
        row(),
        row({ url: 'FIXTURE3', name: 'Locked Layout', modified: 1764547200, overLimit: true }),
      ]),
    ).toEqual({
      layouts: [
        {
          id: 'FIXTURE1',
          name: 'Fixture Layout',
          modified: 1767225600,
          modifiedIso: '2026-01-01T00:00:00Z',
        },
        {
          id: 'FIXTURE3',
          name: 'Locked Layout',
          modified: 1764547200,
          modifiedIso: '2025-12-01T00:00:00Z',
          overLimit: true,
        },
      ],
      unreadable: 0,
    });
  });

  test('marks overLimit only on a layout over the limit', () => {
    const [plain] = toLayoutListing([row()]).layouts;

    expect(plain).not.toHaveProperty('overLimit');
  });

  test('reads a time above 1e11 as milliseconds, and a missing or impossible time as null', () => {
    const { layouts } = toLayoutListing([
      row({ modified: 1767225600999 }),
      row({ modified: null }),
      row({ modified: -5 }),
      row({ modified: 1767225600.75 }),
    ]);

    expect(layouts.map(({ modified, modifiedIso }) => [modified, modifiedIso])).toEqual([
      [1767225600, '2026-01-01T00:00:00Z'],
      [null, null],
      [null, null],
      [1767225600, '2026-01-01T00:00:00Z'],
    ]);
  });

  test('leaves out a layout without a url and counts it, and keeps a layout without a name', () => {
    expect(toLayoutListing([row({ url: null }), row({ name: null })])).toEqual({
      layouts: [
        {
          id: 'FIXTURE1',
          name: null,
          modified: 1767225600,
          modifiedIso: '2026-01-01T00:00:00Z',
        },
      ],
      unreadable: 1,
    });
  });
});

describe('layoutIdFromUrl', () => {
  test.each([
    ['https://www.tradingview.com/chart/AbCd1234/', 'AbCd1234'],
    ['https://www.tradingview.com/chart/AbCd1234', 'AbCd1234'],
    ['https://www.tradingview.com/chart/AbCd1234/?mobileapp_new=true#top', 'AbCd1234'],
    ['/chart/NEW00001/', 'NEW00001'],
    ['chart/NEW00001/', 'NEW00001'],
  ])('reads the id of %s', (url, id) => {
    expect(layoutIdFromUrl(url)).toBe(id);
  });

  test.each([
    'https://www.tradingview.com/chart/',
    'https://www.tradingview.com/chart/AbCd1234/extra/',
    'https://www.tradingview.com/somewhere-else/',
    'https://[not a url',
    '',
  ])('finds no id in %s', (url) => {
    expect(layoutIdFromUrl(url)).toBeNull();
  });
});

describe('layoutNameOf', () => {
  test('trims the name and takes 1 to 64 characters', () => {
    expect(MAX_LAYOUT_NAME).toBe(64);
    expect(layoutNameOf('  Example Layout  ')).toBe('Example Layout');
    expect(layoutNameOf('x'.repeat(64))).toBe('x'.repeat(64));
    expect(layoutNameOf(`\t${'x'.repeat(64)}\n`)).toBe('x'.repeat(64));
  });

  test('refuses a blank name and one longer than 64 characters with INVALID_INPUT', () => {
    expect(thrown(() => layoutNameOf('   ')).toPayload()).toEqual({
      code: 'INVALID_INPUT',
      message: 'The layout name is blank',
      hint: expect.stringContaining('1 to 64') as string,
    });
    expect(thrown(() => layoutNameOf('x'.repeat(65))).toPayload()).toEqual({
      code: 'INVALID_INPUT',
      message: 'The layout name is 65 characters long, and TradingView takes at most 64',
      hint: expect.stringContaining('Nothing was created') as string,
      details: { length: 65, max: 64 },
    });
  });
});

describe('errors and warnings', () => {
  test('a signed-out account is AUTH_REQUIRED', () => {
    expect(signedOutError().toPayload()).toMatchObject({
      code: 'AUTH_REQUIRED',
      hint: 'Sign in to TradingView, then try again.',
    });
  });

  test('unsaved changes ask for confirm, worded for what would discard them and for whether they are known', () => {
    expect(unsavedChangesError('switch', true).toPayload()).toEqual({
      code: 'CONFIRMATION_REQUIRED',
      message: 'The current layout has unsaved changes, which switching layouts would discard',
      hint: expect.stringMatching(
        /^Save the layout in TradingView first, or.*layout_switch again with confirm: true\.$/,
      ) as string,
      details: { unsavedChanges: true },
    });
    expect(unsavedChangesError('new', null).toPayload()).toEqual({
      code: 'CONFIRMATION_REQUIRED',
      message:
        'TradingView does not tell whether the current layout has unsaved changes, which ' +
        'opening the new layout would discard',
      hint: expect.stringMatching(
        /layout_new again with confirm: true\. Nothing was created\.$/,
      ) as string,
      details: { unsavedChanges: null },
    });
  });

  test('an unknown layout, a layout over the limit and a layout that did not open', () => {
    expect(unknownLayoutError('NOSUCH01').toPayload()).toEqual({
      code: 'INVALID_INPUT',
      message: 'The account has no saved layout NOSUCH01',
      hint: expect.stringContaining('layout_list') as string,
      details: { layoutId: 'NOSUCH01' },
    });
    expect(overLimitError('FIXTURE3').toPayload()).toMatchObject({
      code: 'PLAN_LIMIT',
      message: expect.stringContaining('CHART_STORAGE') as string,
      details: { feature: 'CHART_STORAGE', layoutId: 'FIXTURE3' },
    });
    expect(notOpenedError('FIXTURE2', null).message).toBe(
      'TradingView did not open the layout FIXTURE2',
    );
    expect(notOpenedError('FIXTURE2', 'Server error (status 500)').toPayload()).toEqual({
      code: 'NOT_AVAILABLE',
      message: 'TradingView did not open the layout FIXTURE2: Server error (status 500)',
      hint: expect.stringContaining('layout_list') as string,
      details: { layoutId: 'FIXTURE2' },
    });
  });

  test('a layout TradingView did not create, and the permission check of TradingView', () => {
    expect(notCreatedError().toPayload()).toEqual({
      code: 'NOT_AVAILABLE',
      message: 'TradingView did not create the layout',
      hint: expect.stringContaining('may show a message') as string,
    });
    const refused = permissionRefusedError(5);
    expect(refused).toBeInstanceOf(PlanLimitError);
    expect(refused.toPayload()).toEqual({
      code: 'PLAN_LIMIT',
      message: expect.stringContaining('CHART_STORAGE') as string,
      hint: CHART_STORAGE_HINT,
      details: { feature: 'CHART_STORAGE', limit: 5 },
    });
    expect(permissionUnknownError('Server error').toPayload()).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: expect.stringMatching(/nothing was created: Server error$/) as string,
      details: { feature: 'CHART_STORAGE' },
    });
    expect(CHART_STORAGE_HINT).toMatch(/layout_switch/);
  });

  test('the warnings name the layout and what to do', () => {
    expect(dataNotReadyWarning('FIXTURE2', 1500)).toMatch(
      /^The chart of the layout FIXTURE2 did not report its data as loaded within 1500 ms.*chart_get_state/,
    );
    expect(unfinishedLoadWarning('FIXTURE2')).toMatch(
      /FIXTURE2 but did not report that it finished loading it/,
    );
    expect(notOpenedWarning('NEW00001', null)).toMatch(
      /^TradingView created the layout NEW00001 but did not open it in time\. .*layout_switch \(layoutId NEW00001\); do not call layout_new again/,
    );
    expect(notOpenedWarning('NEW00001', 'Server error')).toContain('(Server error)');
    expect(NO_ID_WARNING).toMatch(/did not say its id.*layout_list.*layout_switch/s);
    expect(unreadableLayoutsWarning(1)).toBe('1 saved layout came without an id and is left out.');
    expect(unreadableLayoutsWarning(2)).toBe(
      '2 saved layouts came without an id and are left out.',
    );
  });
});
