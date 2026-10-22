import { PlanLimitError, type TvMcpError } from '../../../../src/core/errors.js';
import {
  blankSymbolsError,
  confirmationError,
  isSectionMarker,
  listedEntry,
  notAddedWarning,
  notEditableError,
  notRemovedWarning,
  removalPlan,
  requireRoom,
  resolveAdditions,
  sectionName,
  sectionsOf,
  shortName,
  symbolsOf,
  symbolsToSearch,
  toListing,
  toWatchlistView,
  watchlistRefusalError,
} from '../../../../src/tools/watchlist/mappers.js';
import type { WatchlistRecord } from '../../../../src/tools/watchlist/page.js';

// The pure parts of the watchlist tools. Symbols are synthetic.

const ENTRIES = ['###Tech', 'NASDAQ:AAPL', 'NASDAQ:MSFT', '###Crypto', 'BINANCE:BTCUSDT'];

function thrown(act: () => unknown): TvMcpError {
  try {
    act();
  } catch (error) {
    return error as TvMcpError;
  }
  throw new Error('Expected a throw');
}

function record(change: Partial<WatchlistRecord> = {}): WatchlistRecord {
  return {
    id: '101',
    kind: 'custom',
    name: 'Fixture List',
    entries: ENTRIES,
    active: true,
    editable: true,
    ...change,
  };
}

describe('sections', () => {
  test('a section marker starts with ###, and its name is what follows, without the mark of a collapsed section', () => {
    expect(isSectionMarker('###Tech')).toBe(true);
    expect(isSectionMarker('###')).toBe(true);
    expect(isSectionMarker('NASDAQ:AAPL')).toBe(false);
    expect(isSectionMarker('##Tech')).toBe(false);
    expect(sectionName('###Tech')).toBe('Tech');
    expect(sectionName('###⁤Crypto')).toBe('Crypto');
    expect(sectionName('###')).toBe('');
  });

  test('symbolsOf leaves the markers out, and sectionsOf groups the symbols under their markers in order', () => {
    expect(symbolsOf(ENTRIES)).toEqual(['NASDAQ:AAPL', 'NASDAQ:MSFT', 'BINANCE:BTCUSDT']);
    expect(sectionsOf(ENTRIES)).toEqual([
      { name: 'Tech', symbols: ['NASDAQ:AAPL', 'NASDAQ:MSFT'] },
      { name: 'Crypto', symbols: ['BINANCE:BTCUSDT'] },
    ]);
    expect(sectionsOf(['NYSE:IBM', '###A', '###B', 'FX:EURUSD'])).toEqual([
      { name: null, symbols: ['NYSE:IBM'] },
      { name: 'A', symbols: [] },
      { name: 'B', symbols: ['FX:EURUSD'] },
    ]);
    expect(sectionsOf([])).toEqual([]);
    expect(sectionsOf(['NYSE:IBM'])).toEqual([{ name: null, symbols: ['NYSE:IBM'] }]);
  });
});

describe('matching symbols', () => {
  test('the short name of a symbol is its ticker', () => {
    expect(shortName('NASDAQ:AAPL')).toBe('AAPL');
    expect(shortName('AAPL')).toBe('AAPL');
    expect(shortName('A:B:C')).toBe('C');
  });

  test('a list holds a symbol by its name or by its short name, case aside, and never as a marker', () => {
    const entries = [...ENTRIES, 'IBM', 'nasdaq:aapl'];

    expect(listedEntry(entries, 'NASDAQ:AAPL')).toBe('NASDAQ:AAPL');
    expect(listedEntry(entries, 'nasdaq:msft')).toBe('NASDAQ:MSFT');
    expect(listedEntry(entries, 'NYSE:IBM')).toBe('IBM');
    expect(listedEntry(entries, 'BATS:AAPL')).toBeNull();
    expect(listedEntry(entries, 'AAPL')).toBeNull();
    expect(listedEntry(entries, '###Tech')).toBeNull();
  });
});

describe('additions', () => {
  const GIVEN = ['NYSE:IBM', 'NASDAQ:MSFT', 'nyse:ibm', 'NASDAQ:ZZZZ', 'FX:EURUSD', 'IBM', 'AAPL'];
  const FOUND = new Map<string, string | null>([
    ['NYSE:IBM', 'NYSE:IBM'],
    ['NASDAQ:ZZZZ', null],
    ['FX:EURUSD', 'FX:EURUSD'],
    ['IBM', 'NYSE:IBM'],
    ['AAPL', 'NASDAQ:AAPL'],
  ]);

  test('symbolsToSearch names each symbol the list does not hold once, as first given', () => {
    expect(symbolsToSearch(GIVEN, ENTRIES)).toEqual([
      'NYSE:IBM',
      'NASDAQ:ZZZZ',
      'FX:EURUSD',
      'IBM',
      'AAPL',
    ]);
    expect(symbolsToSearch(['NASDAQ:AAPL', 'nasdaq:aapl'], ENTRIES)).toEqual([]);
  });

  test('resolveAdditions gives each symbol its outcome in the order given', () => {
    expect(resolveAdditions(GIVEN, ENTRIES, FOUND)).toEqual([
      { given: 'NYSE:IBM', outcome: 'add', name: 'NYSE:IBM' },
      { given: 'NASDAQ:MSFT', outcome: 'already_listed', name: 'NASDAQ:MSFT' },
      { given: 'nyse:ibm', outcome: 'duplicate', name: null },
      { given: 'NASDAQ:ZZZZ', outcome: 'unknown', name: null },
      { given: 'FX:EURUSD', outcome: 'add', name: 'FX:EURUSD' },
      { given: 'IBM', outcome: 'duplicate', name: 'NYSE:IBM' },
      { given: 'AAPL', outcome: 'already_listed', name: 'NASDAQ:AAPL' },
    ]);
  });

  test('a symbol that stands for one the list holds and was given before is a duplicate', () => {
    expect(
      resolveAdditions(['NASDAQ:AAPL', 'AAPL'], ENTRIES, new Map([['AAPL', 'NASDAQ:AAPL']])),
    ).toEqual([
      { given: 'NASDAQ:AAPL', outcome: 'already_listed', name: 'NASDAQ:AAPL' },
      { given: 'AAPL', outcome: 'duplicate', name: 'NASDAQ:AAPL' },
    ]);
    // A symbol whose search did not run counts as unknown.
    expect(resolveAdditions(['NYSE:IBM'], ENTRIES, new Map())).toEqual([
      { given: 'NYSE:IBM', outcome: 'unknown', name: null },
    ]);
  });
});

describe('the room in a list', () => {
  test('passes while every new entry fits under the limit and the maximum', () => {
    expect(() => {
      requireRoom(28, 2, { limit: 30, max: 1000 });
    }).not.toThrow();
    expect(() => {
      requireRoom(999, 1, { limit: 1000, max: 1000 });
    }).not.toThrow();
  });

  test('fails with PLAN_LIMIT WATCHLIST_SYMBOLS when the new entries do not fit under the limit', () => {
    const error = thrown(() => {
      requireRoom(1000, 1, { limit: 1000, max: 1000 });
    });
    const many = thrown(() => {
      requireRoom(28, 3, { limit: 30, max: 1000 });
    });

    expect(error).toBeInstanceOf(PlanLimitError);
    expect(error.toPayload()).toEqual({
      code: 'PLAN_LIMIT',
      message:
        'Plan limit reached for WATCHLIST_SYMBOLS: the watchlist holds 1000 entries and ' +
        'TradingView lets it hold 1000, so 1 more does not fit',
      hint: expect.stringContaining('watchlist_remove') as string,
      details: { feature: 'WATCHLIST_SYMBOLS', limit: 1000 },
    });
    expect(many.message).toContain('so 3 more do not fit');
  });

  test('fails NOT_AVAILABLE when the list holds more than the maximum of the app, or the new entries would', () => {
    const over = thrown(() => {
      requireRoom(1001, 1, { limit: 1000, max: 1000 });
    });
    const beyond = thrown(() => {
      requireRoom(1000, 2, { limit: 2000, max: 1000 });
    });

    expect(over.toPayload()).toMatchObject({
      code: 'NOT_AVAILABLE',
      details: { feature: 'WATCHLIST_SYMBOLS', entries: 1001, max: 1000 },
    });
    expect(beyond.toPayload()).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: expect.stringContaining('so 2 more do not fit') as string,
      details: { feature: 'WATCHLIST_SYMBOLS', entries: 1000, max: 1000 },
    });
  });

  test('fails NOT_AVAILABLE when the limit or the maximum cannot be read', () => {
    for (const limits of [
      { limit: null, max: 1000 },
      { limit: 1000, max: null },
    ]) {
      expect(
        thrown(() => {
          requireRoom(5, 1, limits);
        }).toPayload(),
      ).toMatchObject({ code: 'NOT_AVAILABLE', details: { feature: 'WATCHLIST_SYMBOLS' } });
    }
  });
});

describe('refusals of the watchlist server', () => {
  test('the limit code of the server is PLAN_LIMIT with its message unchanged', () => {
    expect(
      watchlistRefusalError(
        { code: 'plan_symbols_limit_reached', message: 'Too many symbols' },
        'add the symbols to the watchlist',
      ).toPayload(),
    ).toEqual({
      code: 'PLAN_LIMIT',
      message: 'Too many symbols',
      hint: expect.stringContaining('watchlist_remove') as string,
      details: { feature: 'WATCHLIST_SYMBOLS', code: 'plan_symbols_limit_reached' },
    });
    expect(
      watchlistRefusalError(
        { code: 'plan_symbols_limit_reached', message: '' },
        'add the symbols to the watchlist',
      ).message,
    ).toBe('TradingView refused to add the symbols to the watchlist: plan_symbols_limit_reached');
  });

  test('any other refusal is PAGE_EVALUATION_FAILED with its code, and one without a code points to watchlist_get', () => {
    expect(
      watchlistRefusalError(
        { code: 'not_found', message: 'Not found' },
        'remove the symbols from the watchlist',
      ).toPayload(),
    ).toEqual({
      code: 'PAGE_EVALUATION_FAILED',
      message: 'TradingView did not remove the symbols from the watchlist: Not found (not_found)',
      hint: 'TradingView refused it, so nothing changed.',
      details: { code: 'not_found' },
    });
    expect(
      watchlistRefusalError(
        { code: null, message: '' },
        'add the symbols to the watchlist',
      ).toPayload(),
    ).toEqual({
      code: 'PAGE_EVALUATION_FAILED',
      message: 'TradingView did not add the symbols to the watchlist',
      hint: expect.stringContaining('watchlist_get') as string,
      details: { code: null },
    });
  });
});

describe('removals', () => {
  test('removalPlan takes the symbols the list holds as it holds them, and never a marker', () => {
    expect(
      removalPlan(
        ['###Tech', 'NYSE:IBM', 'nasdaq:msft', 'NASDAQ:MSFT', 'BINANCE:BTCUSDT'],
        [...ENTRIES, 'NASDAQ:MSFT'],
      ),
    ).toEqual({ toRemove: ['NASDAQ:MSFT', 'BINANCE:BTCUSDT'], notListed: ['###Tech', 'NYSE:IBM'] });
  });

  test('confirmationError names the symbols this session did not add', () => {
    expect(confirmationError('101', ['NASDAQ:AAPL']).toPayload()).toEqual({
      code: 'CONFIRMATION_REQUIRED',
      message:
        'Removing NASDAQ:AAPL from the watchlist 101 needs confirmation: this session did not add it',
      hint: expect.stringContaining('confirm: true') as string,
      details: { listId: '101', symbols: ['NASDAQ:AAPL'] },
    });
    expect(confirmationError('101', ['NASDAQ:AAPL', 'NASDAQ:MSFT']).message).toBe(
      'Removing NASDAQ:AAPL and NASDAQ:MSFT from the watchlist 101 needs confirmation: this ' +
        'session did not add them',
    );
  });
});

describe('records and messages', () => {
  test('toWatchlistView and toListing report what the tools return', () => {
    expect(toWatchlistView(record())).toEqual({
      id: '101',
      name: 'Fixture List',
      editable: true,
      symbols: ['NASDAQ:AAPL', 'NASDAQ:MSFT', 'BINANCE:BTCUSDT'],
      sections: [
        { name: 'Tech', symbols: ['NASDAQ:AAPL', 'NASDAQ:MSFT'] },
        { name: 'Crypto', symbols: ['BINANCE:BTCUSDT'] },
      ],
    });
    expect(
      toListing({
        id: 'red',
        kind: 'flag',
        name: 'Red list',
        symbolCount: 1,
        active: false,
        editable: false,
      }),
    ).toEqual({ id: 'red', name: 'Red list', symbolCount: 1, active: false, editable: false });
  });

  test('notEditableError says why a list cannot be edited, and points to watchlist_list', () => {
    const flag = notEditableError(record({ id: 'red', kind: 'flag', name: 'Red list' }), false);
    const hot = notEditableError(record({ id: '###HOT###US.gainers', kind: 'hot' }), true);
    const local = notEditableError(record({ id: 'deleted_symbols_list_id', name: null }), false);

    expect(flag.toPayload()).toEqual({
      code: 'INVALID_INPUT',
      message: 'The watchlist Red list is a flag list, which the watchlist tools do not edit',
      hint: expect.stringContaining('watchlist_list') as string,
      details: { listId: 'red' },
    });
    expect(hot.message).toBe(
      'The active watchlist Fixture List is a hot list of TradingView, which the watchlist ' +
        'tools do not edit',
    );
    expect(local.message).toBe(
      'The watchlist deleted_symbols_list_id is kept by TradingView on this computer only, ' +
        'which the watchlist tools do not edit',
    );
  });

  test('the warnings name the symbols', () => {
    expect(notAddedWarning(['FX:EURUSD'])).toContain('FX:EURUSD');
    expect(notAddedWarning(['FX:EURUSD', 'NYSE:IBM'])).toContain('FX:EURUSD and NYSE:IBM');
    expect(notRemovedWarning(['NASDAQ:MSFT'])).toContain('NASDAQ:MSFT');
  });
});

test('blankSymbolsError names the positions of the blank symbols, counted from 1', () => {
  expect(blankSymbolsError([2]).toPayload()).toEqual({
    code: 'INVALID_INPUT',
    message: 'The symbol at position 2 is blank',
    hint: expect.stringContaining('EXCHANGE:TICKER') as string,
    details: { positions: [2] },
  });
  expect(blankSymbolsError([2, 3]).message).toBe('The symbols at positions 2 and 3 are blank');
});
