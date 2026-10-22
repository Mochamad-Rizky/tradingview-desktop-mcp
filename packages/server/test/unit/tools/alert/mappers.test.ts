import type { TvMcpError } from '../../../../src/core/errors.js';
import {
  addSpan,
  ALERT_CONDITIONS,
  alertCounts,
  alertStatus,
  alertTime,
  CONDITION_TYPES,
  defaultMessage,
  expirationWindow,
  isSecondsResolution,
  notDeletedWarning,
  plainSymbol,
  refusalError,
  resolveExpiration,
  toAlertRecord,
  unreadableAlertsWarning,
} from '../../../../src/tools/alert/mappers.js';
import type { AlertRow } from '../../../../src/tools/alert/page.js';

// The pure parts of the alert tools. Values are synthetic.

const DAY = 86_400;
// 2026-10-22T12:00:00Z
const NOW = Date.UTC(2026, 9, 22, 12) / 1000;
const ENCODED = '={"adjustment":"splits","currency-id":"USD","symbol":"NASDAQ:AAPL"}';

function row(change: Partial<AlertRow> = {}): AlertRow {
  return {
    id: 7,
    symbol: ENCODED,
    kinds: ['regular'],
    active: true,
    lastStopReason: null,
    complexity: 'primitive',
    condition: 'cross',
    price: 150,
    message: 'Synthetic',
    expires: '2026-11-21T12:00:00.000Z',
    ...change,
  };
}

function thrown(run: () => unknown): TvMcpError {
  try {
    run();
  } catch (error) {
    return error as TvMcpError;
  }
  throw new Error('Expected a throw');
}

describe('conditions', () => {
  test('each tool condition maps to the condition type of the app', () => {
    expect([...ALERT_CONDITIONS]).toEqual([
      'crossing',
      'crossing_up',
      'crossing_down',
      'greater_than',
      'less_than',
    ]);
    expect(CONDITION_TYPES).toEqual({
      crossing: 'cross',
      crossing_up: 'cross_up',
      crossing_down: 'cross_down',
      greater_than: 'greater',
      less_than: 'less',
    });
  });

  test('defaultMessage describes the alert in a few words', () => {
    expect(defaultMessage('NASDAQ:AAPL', 'crossing', 150)).toBe('AAPL crossing 150');
    expect(defaultMessage('NYSE:IBM', 'crossing_up', 101.25)).toBe('IBM crossing up 101.25');
    expect(defaultMessage('FX:EURUSD', 'crossing_down', 1.08)).toBe('EURUSD crossing down 1.08');
    expect(defaultMessage('BINANCE:BTCUSDT', 'greater_than', 70000)).toBe(
      'BTCUSDT greater than 70000',
    );
    expect(defaultMessage('AAPL', 'less_than', -2)).toBe('AAPL less than -2');
  });
});

describe('records', () => {
  test('plainSymbol takes the symbol out of an encoded symbol and keeps a plain one', () => {
    expect(plainSymbol(ENCODED)).toBe('NASDAQ:AAPL');
    expect(plainSymbol('NYSE:IBM')).toBe('NYSE:IBM');
    // What cannot be decoded stays as it is.
    expect(plainSymbol('={not json')).toBe('={not json');
    expect(plainSymbol('={"symbol":{"a":1}}')).toBe('={"symbol":{"a":1}}');
    expect(plainSymbol('={"symbol":""}')).toBe('={"symbol":""}');
    expect(plainSymbol('=null')).toBe('=null');
  });

  test('alertStatus is active, triggered when it stopped itself after firing, else stopped', () => {
    expect(alertStatus(row())).toBe('active');
    expect(alertStatus(row({ active: false, lastStopReason: 'auto' }))).toBe('triggered');
    expect(alertStatus(row({ active: false, lastStopReason: 'manual' }))).toBe('stopped');
    expect(alertStatus(row({ active: false, lastStopReason: 'expired' }))).toBe('stopped');
    expect(alertStatus(row({ active: false, lastStopReason: null }))).toBe('stopped');
    expect(alertStatus(row({ active: null }))).toBe('stopped');
  });

  test('alertTime reads an ISO time or a timestamp into Unix seconds', () => {
    expect(alertTime('2026-11-21T12:00:00.000Z')).toBe(NOW + 30 * DAY);
    expect(alertTime('2026-11-21T12:00:00.750Z')).toBe(NOW + 30 * DAY);
    expect(alertTime((NOW + DAY) * 1000)).toBe(NOW + DAY);
    expect(alertTime(NOW + DAY)).toBe(NOW + DAY);
    expect(alertTime('never')).toBeNull();
    expect(alertTime(null)).toBeNull();
    expect(alertTime(Number.NaN)).toBeNull();
    // Beyond what a Date can hold.
    expect(alertTime(9e15 * 1000)).toBeNull();
  });

  test('toAlertRecord reports an alert in the terms of the tools', () => {
    const created = new Set(['8']);

    expect(toAlertRecord(row(), created)).toEqual({
      id: '7',
      symbol: 'NASDAQ:AAPL',
      condition: 'crossing',
      price: 150,
      message: 'Synthetic',
      status: 'active',
      expiration: NOW + 30 * DAY,
      expirationIso: '2026-11-21T12:00:00Z',
      createdByServer: false,
    });
    expect(
      toAlertRecord(
        row({
          id: 8,
          symbol: null,
          condition: 'channel_in',
          price: null,
          message: null,
          active: false,
          lastStopReason: 'auto',
          expires: null,
        }),
        created,
      ),
    ).toEqual({
      id: '8',
      symbol: null,
      condition: 'channel_in',
      price: null,
      message: null,
      status: 'triggered',
      expiration: null,
      expirationIso: null,
      createdByServer: true,
    });
    for (const [type, name] of [
      ['cross_up', 'crossing_up'],
      ['cross_down', 'crossing_down'],
      ['greater', 'greater_than'],
      ['less', 'less_than'],
    ]) {
      expect(toAlertRecord(row({ condition: type ?? '' }), created).condition).toBe(name);
    }
    expect(toAlertRecord(row({ condition: null }), created).condition).toBeNull();
    // A name every object inherits is no condition of the tools.
    expect(toAlertRecord(row({ condition: 'constructor' }), created).condition).toBe('constructor');
  });

  test('alertCounts counts every alert and the active price alerts, and an unreadable one as both', () => {
    const rows = [
      row({ id: 1 }),
      row({ id: 2, active: null }),
      row({ id: 3, active: false }),
      row({ id: 4, complexity: 'complex' }),
      row({ id: 5, kinds: ['watchlist'] }),
      row({ id: 6, complexity: null }),
    ];

    expect(alertCounts({ alerts: rows, unreadable: 0 })).toEqual({ all: 6, activePrice: 3 });
    expect(alertCounts({ alerts: rows, unreadable: 2 })).toEqual({ all: 8, activePrice: 5 });
  });
});

describe('refusalError', () => {
  test.each([
    'total_alerts_count_exceeded',
    'max_primitive_alerts_count_exceeded',
    'active_alerts_count_exceeded',
    'max_complex_alerts_count_exceeded',
  ])('relays %s as PLAN_LIMIT with the message of TradingView unchanged', (code) => {
    const error = refusalError({ code, message: `Synthetic ${code}` }, 'create the alert');

    expect(error.toPayload()).toEqual({
      code: 'PLAN_LIMIT',
      message: `Synthetic ${code}`,
      hint: expect.stringContaining('alert_delete') as string,
      details: { feature: 'SERVER_SIDE_ALERTS', code },
    });
  });

  test('names the code of a limit refusal that came without a message', () => {
    expect(
      refusalError({ code: 'total_alerts_count_exceeded', message: '' }, 'create the alert')
        .message,
    ).toBe('TradingView refused to create the alert: total_alerts_count_exceeded');
  });

  test('a signed-out account is AUTH_REQUIRED', () => {
    expect(
      refusalError(
        { code: 'unauthorized', message: 'Unauthorized' },
        'list the alerts',
      ).toPayload(),
    ).toEqual({
      code: 'AUTH_REQUIRED',
      message: 'Alerts need a signed-in TradingView account',
      hint: 'Sign in to TradingView, then try again.',
      details: { code: 'unauthorized' },
    });
  });

  test('any other refusal is PAGE_EVALUATION_FAILED with the code', () => {
    expect(
      refusalError(
        { code: 'no_permissions', message: 'Not allowed' },
        'create the alert',
      ).toPayload(),
    ).toEqual({
      code: 'PAGE_EVALUATION_FAILED',
      message: 'TradingView did not create the alert: Not allowed (no_permissions)',
      hint: 'TradingView refused it, so nothing changed.',
      details: { code: 'no_permissions' },
    });
    expect(refusalError({ code: 'general', message: '' }, 'list the alerts').message).toBe(
      'TradingView did not list the alerts (general)',
    );
    expect(
      refusalError({ code: null, message: 'Fetch Failed' }, 'delete the alerts').toPayload(),
    ).toEqual({
      code: 'PAGE_EVALUATION_FAILED',
      message: 'TradingView did not delete the alerts: Fetch Failed',
      hint: 'Check alert_list: TradingView may have acted despite the error.',
      details: { code: null },
    });
  });
});

describe('expirations', () => {
  test('addSpan adds days, weeks or calendar months, and nothing it does not know', () => {
    expect(addSpan(NOW, { type: 'days', count: 30 })).toBe(NOW + 30 * DAY);
    expect(addSpan(NOW, { type: 'weeks', count: 2 })).toBe(NOW + 14 * DAY);
    expect(addSpan(NOW, { type: 'months', count: 1 })).toBe(Date.UTC(2026, 10, 22, 12) / 1000);
    // The last day of a shorter month, not a day of the month after.
    expect(addSpan(Date.UTC(2027, 0, 31, 9) / 1000, { type: 'months', count: 1 })).toBe(
      Date.UTC(2027, 1, 28, 9) / 1000,
    );
    expect(addSpan(Date.UTC(2026, 11, 15) / 1000, { type: 'months', count: 2 })).toBe(
      Date.UTC(2027, 1, 15) / 1000,
    );
    expect(addSpan(NOW, { type: 'years', count: 1 })).toBeNull();
    expect(addSpan(NOW, { type: 'days', count: 0 })).toBeNull();
    expect(addSpan(NOW, { type: 'days', count: 1.5 })).toBeNull();
  });

  test('expirationWindow takes the bounds of the app, never a default beyond the latest', () => {
    expect(
      expirationWindow(NOW, { type: 'days', count: 60 }, { type: 'months', count: 1 }),
    ).toEqual({
      latest: NOW + 60 * DAY,
      byDefault: Date.UTC(2026, 10, 22, 12) / 1000,
      maximum: '60 days',
    });
    expect(expirationWindow(NOW, { type: 'days', count: 30 }, { type: 'days', count: 45 })).toEqual(
      { latest: NOW + 30 * DAY, byDefault: NOW + 30 * DAY, maximum: '30 days' },
    );
    expect(expirationWindow(NOW, { type: 'months', count: 1 }, null)).toMatchObject({
      maximum: '1 month',
    });
  });

  test('expirationWindow falls back to 30 days for a bound it cannot read', () => {
    const fallback = { latest: NOW + 30 * DAY, byDefault: NOW + 30 * DAY, maximum: '30 days' };

    expect(expirationWindow(NOW, null, null)).toEqual(fallback);
    expect(expirationWindow(NOW, { type: 'years', count: 1 }, { type: 'eons', count: 1 })).toEqual(
      fallback,
    );
  });

  test('resolveExpiration takes the default, or a given time between now and the latest', () => {
    const window = { latest: NOW + 30 * DAY, byDefault: NOW + 20 * DAY, maximum: '30 days' };

    expect(resolveExpiration(undefined, NOW, window)).toBe(NOW + 20 * DAY);
    expect(resolveExpiration(NOW + 30 * DAY, NOW, window)).toBe(NOW + 30 * DAY);
    expect(resolveExpiration(NOW + 1, NOW, window)).toBe(NOW + 1);
  });

  test('an expiration in the past, or now, is INVALID_INPUT', () => {
    const window = { latest: NOW + 30 * DAY, byDefault: NOW + 30 * DAY, maximum: '30 days' };

    for (const given of [NOW, NOW - DAY]) {
      expect(thrown(() => resolveExpiration(given, NOW, window)).toPayload()).toMatchObject({
        code: 'INVALID_INPUT',
        message: expect.stringContaining('is not in the future') as string,
        details: { expiration: given },
      });
    }
  });

  test('an expiration beyond the latest is INVALID_INPUT naming the maximum', () => {
    const window = { latest: NOW + 30 * DAY, byDefault: NOW + 30 * DAY, maximum: '30 days' };

    expect(thrown(() => resolveExpiration(NOW + 31 * DAY, NOW, window)).toPayload()).toEqual({
      code: 'INVALID_INPUT',
      message:
        'The expiration 2026-11-22T12:00:00Z is more than 30 days away, the longest TradingView ' +
        'allows for an alert on this plan',
      hint: 'Give an expiration up to 2026-11-21T12:00:00Z, or leave it out for the default of TradingView.',
      details: {
        expiration: NOW + 31 * DAY,
        expirationIso: '2026-11-22T12:00:00Z',
        latest: NOW + 30 * DAY,
        latestIso: '2026-11-21T12:00:00Z',
        maximum: '30 days',
      },
    });
  });
});

describe('the rest', () => {
  test('isSecondsResolution tells a resolution in seconds', () => {
    for (const resolution of ['1S', '5S', '30s', 'S', '15S,extra']) {
      expect(isSecondsResolution(resolution), resolution).toBe(true);
    }
    for (const resolution of ['1', '60', '1D', 'D', '1W', '10R', '1T', '5SS', '']) {
      expect(isSecondsResolution(resolution), resolution).toBe(false);
    }
  });

  test('the warnings name what they are about', () => {
    expect(unreadableAlertsWarning(1)).toBe(
      'TradingView listed 1 alert that could not be read, so it is left out.',
    );
    expect(unreadableAlertsWarning(3)).toBe(
      'TradingView listed 3 alerts that could not be read, so they are left out.',
    );
    expect(notDeletedWarning(['5'])).toBe(
      'TradingView still lists 1 of the alerts after the deletion: 5. alert_list shows what is ' +
        'left.',
    );
    expect(notDeletedWarning(['5', '6'])).toBe(
      'TradingView still lists 2 of the alerts after the deletion: 5 and 6. alert_list shows ' +
        'what is left.',
    );
  });
});
