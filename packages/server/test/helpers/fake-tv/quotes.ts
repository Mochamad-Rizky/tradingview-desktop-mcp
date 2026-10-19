import type { JsonValue } from '../../../src/utils/json.js';
import type { TvStateFixture } from './fixture.js';

// The webpack modules that hold the quotes of symbols other than the one the chart shows, filled
// from the quoteCache of the fixture:
//
// - QUOTE_FIELDS_CACHE, the cache every quote session feeds: get(symbol) answers
//   { symbolname, status, values } or null.
// - getQuoteSessionNoEnsure(type), the "full" quote session when it exists, whose
//   internals().data() maps a symbol to its entry; undefined for any other type, as for a session
//   that was never created.
// - quoteSessionAdapters, whose _lastSymbolData Map is the cache of the watchlist widget.
//
// The members of the same modules that create a session or send a request are there too, and record
// their calls, so that a test can show that nothing called them: getQuoteSessionInstance,
// snapshoter, quoteSessionAdapters.get and the snapshot and subscribe of a session. An entry whose
// values are empty has the status "error", as the app keeps an unknown symbol. Values are
// synthetic.

interface Entry {
  symbolname: string;
  status: 'ok' | 'error';
  values: Record<string, JsonValue>;
}

export function createQuoteModules(
  cache: TvStateFixture['quoteCache'],
  record: (name: string, args: readonly unknown[]) => void,
): Record<string, Record<string, unknown>> {
  const entries = (source: Record<string, Record<string, JsonValue>>): Map<string, Entry> =>
    new Map(
      Object.entries(source).map(([symbol, values]) => [
        symbol,
        {
          symbolname: symbol,
          status: Object.keys(values).length === 0 ? 'error' : 'ok',
          values: structuredClone(values),
        },
      ]),
    );
  const fields = entries(cache.fields);
  const full = entries(cache.full);
  const watchlist = entries(cache.watchlist);

  const fullSession = {
    internals: () => ({
      session: () => ({}),
      subscriptions: () => ({}),
      data: () =>
        Object.fromEntries(
          [...full].map(([symbol, entry]) => [symbol, { ...entry, subscribers_count: 1 }]),
        ),
    }),
    snapshot(symbol: string) {
      record('quoteSession.snapshot', [symbol]);
      return Promise.reject(new Error('Quotes snapshot is not received'));
    },
    subscribe(...args: unknown[]) {
      record('quoteSession.subscribe', args);
    },
  };

  return {
    // Module IDs are arbitrary numbers, as in a production build.
    '48084': {
      QUOTE_FIELDS_CACHE: {
        get: (symbol: string) => fields.get(symbol) ?? null,
        getTimes: (symbol: string) =>
          fields.has(symbol)
            ? new Map(Object.keys(fields.get(symbol)?.values ?? {}).map((key) => [key, 0]))
            : null,
        fields: () => ['last_price', 'change', 'change_percent', 'bid', 'ask', 'volume'],
        _cache: fields,
      },
      snapshoter() {
        record('snapshoter', []);
        return {};
      },
    },
    '99790': {
      getQuoteSessionNoEnsure: (type = 'full') => (type === 'full' ? fullSession : undefined),
      getQuoteSessionInstance(type = 'full') {
        record('getQuoteSessionInstance', [type]);
        return fullSession;
      },
    },
    '45516': {
      quoteSessionAdapters: {
        _lastSymbolData: watchlist,
        _adaptersMap: new Map(),
        get(clientId: unknown, type: unknown) {
          record('quoteSessionAdapters.get', [clientId, type]);
          return {};
        },
      },
    },
  };
}
