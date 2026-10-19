import type { CdpSession } from '../../../../src/core/cdp/types.js';
import type { TvMcpError } from '../../../../src/core/errors.js';
import {
  createPageBridge,
  type PageBridge,
  type PageFunction,
} from '../../../../src/core/tv/page-bridge.js';
import type { TvWindow } from '../../../../src/core/tv/tv-window.js';
import { CHART_TYPE_NAMES_BY_ID } from '../../../../src/tools/chart/mappers.js';
import {
  readChartLayout,
  readChartSnapshot,
  readChartState,
  readVisibleRange,
  scrollToTime,
  setChartTypeViaApi,
  setResolutionViaApi,
  setSymbolViaApi,
  zoomToTimeRange,
} from '../../../../src/tools/chart/page.js';
import type { JsonValue } from '../../../../src/utils/json.js';
import { toIso } from '../../../../src/utils/time.js';
import { failureOf } from '../../../helpers/failure-of.js';
import { createPageRuntime } from '../../../helpers/fake-cdp/runtime.js';
import { loadTvFixture, type TvStateFixture } from '../../../helpers/fake-tv/fixture.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTvOverrides,
  type FakeTvWindow,
} from '../../../helpers/fake-tv/window.js';

// The page functions of the chart tools. Each one is run the way the server runs it, as source text
// in a page whose window is the one under test, through the real page bridge: a page function that
// leans on anything of its module would pass a direct call and fail there. It is also called
// directly, which is what the coverage of the module measures, on a second window built the same
// way, so that a function that changes the page starts from the same state both times. The two
// answers must agree.

const fixture = loadTvFixture();
const DAY = 86_400;
const HOUR = 3_600;
// The fixture has one bar a day, every day, from 2024-01-02 on.
const barTime = (index: number): number => fixture.bars.startTime + index * DAY;
const LAST = fixture.bars.count - 1;
// The chart reports a daily bar as its day at 00:00 UTC, while the row of the bar holds the start of
// its session: 13:30 UTC for a US stock, 13.5 hours later (seen on the app).
const SESSION = 13.5 * HOUR;
const US_DAILY: FakeTvOverrides = { sessionOffsetSeconds: SESSION };
const dayOf = (index: number): number => barTime(index) - SESSION;

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
});

function bridgeTo(win: object): PageBridge {
  const runtime = createPageRuntime(win);
  disposers.push(() => {
    runtime.dispose();
  });
  const send = (method: string, params?: unknown): Promise<unknown> =>
    method === 'Runtime.evaluate'
      ? runtime.evaluate(params as Record<string, unknown>)
      : Promise.reject(new Error(`Unexpected command ${method}`));
  const session: CdpSession = {
    targetId: 'PAGE1',
    isClosed: false,
    // The protocol typings of send are generic over every CDP method; this fake answers one.
    send: send as CdpSession['send'],
    onClose: () => undefined,
    close: () => Promise.resolve(),
  };
  return createPageBridge(session, { timeoutMs: 5000 });
}

// The objects of a fake chart that tests reshape.
function partsOf(win: FakeTvWindow) {
  const api = win.TradingViewApi;
  if (api === undefined) {
    throw new Error('The fake window has no TradingViewApi');
  }
  const chart = api.activeChart();
  const model = chart._chartWidget.model();
  return { api, chart, model, series: model.mainSeries(), timeScale: model.model().timeScale() };
}

type Parts = ReturnType<typeof partsOf>;
type Make = () => object;

// A booted chart, reshaped by `patch`, made anew for every run.
function chart(
  patch?: (parts: Parts, win: FakeTvWindow) => void,
  from = fixture,
  overrides: FakeTvOverrides = {},
): Make {
  return () => {
    const win = createFakeTvWindow(from, overrides);
    patch?.(partsOf(win), win);
    return win;
  };
}

const plain =
  (win: object): Make =>
  () =>
    win;

async function resultOf<A extends JsonValue[], R extends JsonValue | null>(
  fn: PageFunction<A, R>,
  args: A,
  make: Make,
): Promise<{ result: R; win: object }> {
  const win = make();
  const result = await bridgeTo(win).evaluate(fn, args);
  const direct = await fn(make() as TvWindow, ...args);
  expect(direct).toEqual(result);
  return { result, win };
}

// A failure the page function reports with a sentinel: the bridge turns it into the error, and a
// direct call returns the sentinel itself.
async function failureOfBoth<A extends JsonValue[], R extends JsonValue | null>(
  fn: PageFunction<A, R>,
  args: A,
  make: Make,
): Promise<{ error: TvMcpError; win: object }> {
  const win = make();
  const error = await failureOf(bridgeTo(win).evaluate(fn, args));
  const direct = await fn(make() as TvWindow, ...args);
  expect(direct).toEqual({ __tvmcpError: error.toPayload() });
  return { error, win };
}

const callsOf = (win: object) => inspectFakeWindow(win).calls;
const callsTo = (win: object, name: string) => inspectFakeWindow(win).callsTo(name);

// What logicalRange() of the time scale answers on the app: an object whose left() and right()
// give the first and the last bar index of the view, fractional, and that has no from or to.
function logical(left: unknown, right: unknown): object {
  return { left: () => left, right: () => right };
}

// What a page recorded: a fake chart window records every call that changes it, and a plain
// object that stands in for a page has nothing to record.
function recordedCalls(win: object): readonly unknown[] {
  try {
    return inspectFakeWindow(win).calls;
  } catch {
    return [];
  }
}

// Pages that lack the way in, in the forms a page can lack it.
const NO_API: [string, Make][] = [
  ['a page without TradingViewApi', plain({})],
  ['a page whose app has not booted', () => createFakeTvWindow(fixture, { withoutApi: true })],
  [
    'a page whose activeChart throws',
    plain({
      TradingViewApi: {
        activeChart: () => {
          throw new Error('No chart is active');
        },
      },
    }),
  ],
  [
    'a page whose activeChart answers nothing',
    plain({ TradingViewApi: { activeChart: () => null } }),
  ],
];

describe('readChartLayout', () => {
  test('readChartLayout reads how many charts the layout has and which one is active', async () => {
    const { result } = await resultOf(readChartLayout, [], chart());

    expect(result).toStrictEqual({ chartsCount: 1, activeChartIndex: 0 });
  });

  test('readChartLayout reports null for what the API does not answer with a number', async () => {
    const win = { TradingViewApi: { chartsCount: () => '2' } };

    const { result } = await resultOf(readChartLayout, [], plain(win));

    expect(result).toStrictEqual({ chartsCount: null, activeChartIndex: null });
  });

  test.each([
    ['a page without TradingViewApi', plain({})],
    ['an API without chartsCount', plain({ TradingViewApi: { activeChartIndex: () => 0 } })],
  ])('readChartLayout is unavailable on %s', async (_case, make) => {
    const { error } = await failureOfBoth(readChartLayout, [], make);

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(error.hint).toMatch(/app_health/);
  });
});

describe('readChartState', () => {
  test('readChartState returns symbol, resolution, type name, range, studies, shapes count and layout', async () => {
    const { result, win } = await resultOf(readChartState, [null, CHART_TYPE_NAMES_BY_ID], chart());

    expect(result).toStrictEqual({
      chartIndex: 0,
      symbol: 'NASDAQ:AAPL',
      resolution: '1D',
      chartType: 1,
      chartTypeName: 'candles',
      visibleRange: { from: fixture.visibleRange.from, to: fixture.visibleRange.to },
      studies: [
        { id: 'STUDY01', name: 'Moving Average' },
        { id: 'STUDY02', name: 'Relative Strength Index' },
      ],
      drawingCount: 3,
      layout: {
        type: 's',
        chartsCount: 1,
        activeChartIndex: 0,
        name: 'Fixture Layout',
        id: 'FIXTURE1',
      },
    });
    // A reading: the page is left as it was.
    expect(callsOf(win)).toEqual([]);
  });

  test('readChartState reads the chart at chartIndex', async () => {
    const make = chart(({ api, chart: first }, win) => {
      const second = { ...first, symbol: () => 'NYSE:IBM', chartType: () => 8 };
      win.TradingViewApi = {
        ...api,
        chartsCount: () => 2,
        chart: (index = 0) => (index === 1 ? second : first),
      };
    });

    const { result } = await resultOf(readChartState, [1, CHART_TYPE_NAMES_BY_ID], make);

    expect(result).toMatchObject({
      chartIndex: 1,
      symbol: 'NYSE:IBM',
      chartType: 8,
      chartTypeName: 'heikin_ashi',
      layout: { chartsCount: 2, activeChartIndex: 0 },
    });
  });

  test('readChartState calls a chart type it has no name for unknown', async () => {
    const make = chart(({ chart: target }) => {
      Object.assign(target, { chartType: () => 11 });
    });

    const { result } = await resultOf(readChartState, [null, CHART_TYPE_NAMES_BY_ID], make);

    expect(result).toMatchObject({ chartType: 11, chartTypeName: 'unknown' });
  });

  // The chart itself is what the state is about; the rest is reported as far as the page can say.
  test('readChartState reports null for the parts the page cannot say', async () => {
    const fail = () => {
      throw new Error('Not ready');
    };
    const make = chart(({ api, chart: target }) => {
      Object.assign(target, {
        getVisibleRange: fail,
        getAllStudies: () => 'none',
        getAllShapes: fail,
      });
      Object.assign(api, { layout: () => 1, layoutName: fail, layoutId: fail, chartsCount: fail });
      Object.assign(api, { activeChartIndex: fail });
    });

    const { result } = await resultOf(readChartState, [null, CHART_TYPE_NAMES_BY_ID], make);

    expect(result).toStrictEqual({
      chartIndex: null,
      symbol: 'NASDAQ:AAPL',
      resolution: '1D',
      chartType: 1,
      chartTypeName: 'candles',
      visibleRange: { from: null, to: null },
      studies: null,
      drawingCount: null,
      layout: { type: null, chartsCount: null, activeChartIndex: null, name: null, id: null },
    });
  });

  test('readChartState keeps only the id and the name of a study', async () => {
    const make = chart(({ chart: target }) => {
      Object.assign(target, {
        getAllStudies: () => [{ id: 'S1', name: 'Volume', inputs: { length: 20 }, extra: true }],
      });
    });

    const { result } = await resultOf(readChartState, [null, CHART_TYPE_NAMES_BY_ID], make);

    expect(result).toMatchObject({ studies: [{ id: 'S1', name: 'Volume' }] });
  });

  test.each(NO_API)('readChartState is unavailable on %s', async (_case, make) => {
    const { error } = await failureOfBoth(readChartState, [null, CHART_TYPE_NAMES_BY_ID], make);

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(error.hint).toMatch(/app_health/);
  });
});

describe('readChartSnapshot', () => {
  test('readChartSnapshot reads the symbol, the timeframe and the visible range', async () => {
    const { result, win } = await resultOf(readChartSnapshot, [null], chart());

    expect(result).toStrictEqual({
      symbol: 'NASDAQ:AAPL',
      resolution: '1D',
      symbolInvalid: false,
      from: fixture.visibleRange.from,
      to: fixture.visibleRange.to,
      seriesSymbol: 'NASDAQ:AAPL',
      barCount: fixture.bars.count,
    });
    expect(callsOf(win)).toEqual([]);
  });

  test('readChartSnapshot names the series symbol by its full name when it has no pro name', async () => {
    const make = chart(({ series }) => {
      Object.assign(series, { symbolInfo: () => ({ full_name: 'NYSE:IBM' }) });
    });

    const { result } = await resultOf(readChartSnapshot, [null], make);

    expect(result).toMatchObject({ seriesSymbol: 'NYSE:IBM' });
  });

  test('readChartSnapshot says when the series flags the symbol as invalid', async () => {
    const make = chart((_parts, win) => {
      inspectFakeWindow(win).state.symbolInvalid = true;
    });

    const { result } = await resultOf(readChartSnapshot, [0], make);

    expect(result).toMatchObject({ symbolInvalid: true });
  });

  test('readChartSnapshot reports null for each part the page cannot say', async () => {
    const fail = () => {
      throw new Error('Not ready');
    };
    const make = chart(({ chart: target, series }) => {
      Object.assign(target, { symbol: () => 7, resolution: fail, getVisibleRange: fail });
      Object.assign(series, {
        isSymbolInvalid: fail,
        symbolInfo: () => ({ pro_name: 5 }),
        bars: fail,
      });
    });

    const { result } = await resultOf(readChartSnapshot, [null], make);

    expect(result).toStrictEqual({
      symbol: null,
      resolution: null,
      symbolInvalid: false,
      from: null,
      to: null,
      seriesSymbol: null,
      barCount: null,
    });
  });

  test.each(NO_API)('readChartSnapshot answers null on %s', async (_case, make) => {
    const { result } = await resultOf(readChartSnapshot, [null], make);

    expect(result).toBeNull();
  });
});

describe('setSymbolViaApi', () => {
  test('setSymbolViaApi switches the symbol and resolves once the data is ready', async () => {
    const { result, win } = await resultOf(setSymbolViaApi, ['NASDAQ:MSFT', null, 5000], chart());

    expect(result).toStrictEqual({
      symbol: 'NASDAQ:MSFT',
      previous: 'NASDAQ:AAPL',
      changed: true,
      listing: 'NASDAQ:MSFT',
    });
    const calls = callsTo(win, 'chart.setSymbol');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('NASDAQ:MSFT');
    expect(typeof (calls[0]?.[1] as { dataReady?: unknown } | undefined)?.dataReady).toBe(
      'function',
    );
    expect(inspectFakeWindow(win).state.symbol).toBe('NASDAQ:MSFT');
  });

  // Without the flag the call would wait for a dataReady that never comes, until the timeout.
  test('setSymbolViaApi returns INVALID_INPUT as soon as the series flags the symbol as unknown', async () => {
    const { error, win } = await failureOfBoth(
      setSymbolViaApi,
      ['NASDAQ:NOPE', null, 60_000],
      chart(),
    );

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe('Unknown symbol NASDAQ:NOPE');
    expect(error.details).toEqual({ requested: 'NASDAQ:NOPE', previous: 'NASDAQ:AAPL' });
    expect(callsTo(win, 'chart.setSymbol')).toHaveLength(1);
  });

  test('setSymbolViaApi notices a symbol that the series flags as unknown only later', async () => {
    const make = chart(({ chart: target, series }) => {
      let invalid = false;
      Object.assign(series, { isSymbolInvalid: () => invalid });
      Object.assign(target, {
        setSymbol: () => {
          setTimeout(() => {
            invalid = true;
          }, 30);
          return Promise.resolve(true);
        },
      });
    });

    const { error } = await failureOfBoth(setSymbolViaApi, ['NASDAQ:LATE', null, 60_000], make);

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details).toEqual({ requested: 'NASDAQ:LATE', previous: 'NASDAQ:AAPL' });
  });

  test('setSymbolViaApi reports an unknown symbol when the data comes with the series flagged', async () => {
    const make = chart(({ chart: target, series }) => {
      let invalid = false;
      Object.assign(series, { isSymbolInvalid: () => invalid });
      Object.assign(target, {
        setSymbol: (_symbol: string, options?: { dataReady?: () => void }) => {
          invalid = true;
          options?.dataReady?.();
          return Promise.resolve(true);
        },
      });
    });

    const { error } = await failureOfBoth(setSymbolViaApi, ['NASDAQ:ODD', null, 5000], make);

    expect(error.code).toBe('INVALID_INPUT');
  });

  // The chart shows an unknown symbol already, so the flag says nothing about the new one.
  test('setSymbolViaApi does not take the flag of an earlier unknown symbol for a failure', async () => {
    const make = chart(({ series }) => {
      Object.assign(series, { isSymbolInvalid: () => true });
    });

    const { result } = await resultOf(setSymbolViaApi, ['NASDAQ:MSFT', null, 5000], make);

    expect(result).toMatchObject({ symbol: 'NASDAQ:MSFT', changed: true });
  });

  test('setSymbolViaApi leaves the chart alone when it shows the symbol already', async () => {
    const { result, win } = await resultOf(setSymbolViaApi, ['NASDAQ:AAPL', null, 5000], chart());

    expect(result).toStrictEqual({
      symbol: 'NASDAQ:AAPL',
      previous: 'NASDAQ:AAPL',
      changed: false,
      listing: 'NASDAQ:AAPL',
    });
    expect(callsOf(win)).toEqual([]);
  });

  test('setSymbolViaApi takes a symbol written in lower case for the one the chart shows', async () => {
    const { result, win } = await resultOf(setSymbolViaApi, ['nasdaq:aapl', null, 5000], chart());

    expect(result).toStrictEqual({
      symbol: 'NASDAQ:AAPL',
      previous: 'NASDAQ:AAPL',
      changed: false,
      listing: 'NASDAQ:AAPL',
    });
    expect(callsOf(win)).toEqual([]);
  });

  // TradingView names a symbol by the exchange of its data feed (BATS:AAPL for NASDAQ:AAPL, seen
  // on the app), and its symbol info keeps the listing as pro_name.
  test('setSymbolViaApi leaves the chart alone when it shows the symbol through its data feed', async () => {
    const { result, win } = await resultOf(
      setSymbolViaApi,
      ['NASDAQ:AAPL', null, 5000],
      chart(undefined, fixture, { feeds: { 'NASDAQ:AAPL': 'BATS:AAPL' } }),
    );

    expect(result).toStrictEqual({
      symbol: 'BATS:AAPL',
      previous: 'BATS:AAPL',
      changed: false,
      listing: 'NASDAQ:AAPL',
    });
    expect(callsOf(win)).toEqual([]);
  });

  test('setSymbolViaApi reports the name the chart gives a symbol once loaded, and its listing', async () => {
    const { result } = await resultOf(
      setSymbolViaApi,
      ['NASDAQ:MSFT', null, 5000],
      chart(undefined, fixture, { feeds: { 'NASDAQ:MSFT': 'BATS:MSFT' } }),
    );

    expect(result).toStrictEqual({
      symbol: 'BATS:MSFT',
      previous: 'NASDAQ:AAPL',
      changed: true,
      listing: 'NASDAQ:MSFT',
    });
  });

  test('setSymbolViaApi does not trust the listing of a series flagged for an unknown symbol', async () => {
    const make = chart(({ series }) => {
      Object.assign(series, {
        isSymbolInvalid: () => true,
        symbolInfo: () => ({ ...fixture.symbolInfo, pro_name: 'NASDAQ:MSFT' }),
      });
    });

    const { win } = await resultOf(setSymbolViaApi, ['NASDAQ:MSFT', null, 5000], make);

    expect(callsTo(win, 'chart.setSymbol')).toHaveLength(1);
  });

  // TradingView reloads a bare ticker even when it resolves to the symbol shown (seen on the app).
  test('setSymbolViaApi reports no change when TradingView reloads the symbol the chart showed', async () => {
    const make = chart(({ chart: target }) => {
      Object.assign(target, {
        setSymbol: (_symbol: string, options?: { dataReady?: () => void }) => {
          setTimeout(() => options?.dataReady?.(), 10);
          return Promise.resolve(true);
        },
      });
    });

    const { result } = await resultOf(setSymbolViaApi, ['AAPL', null, 5000], make);

    expect(result).toStrictEqual({
      symbol: 'NASDAQ:AAPL',
      previous: 'NASDAQ:AAPL',
      changed: false,
      listing: 'NASDAQ:AAPL',
    });
  });

  test('setSymbolViaApi returns TIMEOUT when neither the data nor the flag comes', async () => {
    const make = chart(({ chart: target }) => {
      Object.assign(target, { setSymbol: () => Promise.resolve(true) });
    });

    const { error } = await failureOfBoth(setSymbolViaApi, ['NASDAQ:SLOW', null, 50], make);

    expect(error.code).toBe('TIMEOUT');
    expect(error.message).toContain('NASDAQ:SLOW');
    expect(error.details).toEqual({
      requested: 'NASDAQ:SLOW',
      previous: 'NASDAQ:AAPL',
      timeoutMs: 50,
    });
    expect(error.hint).toMatch(/chart_get_state/);
  });

  test('setSymbolViaApi still waits for the data on a chart whose series it cannot reach', async () => {
    const make = chart(({ chart: target }) => {
      Reflect.deleteProperty(target, '_chartWidget');
    });

    const { result } = await resultOf(setSymbolViaApi, ['NASDAQ:MSFT', null, 5000], make);
    const { error } = await failureOfBoth(setSymbolViaApi, ['NASDAQ:NOPE', null, 50], make);

    expect(result).toMatchObject({ symbol: 'NASDAQ:MSFT', changed: true });
    // Without the series nothing tells that a symbol is unknown, so only the deadline ends the wait.
    expect(error.code).toBe('TIMEOUT');
  });

  test('setSymbolViaApi still waits for the data when looking up the series throws', async () => {
    const make = chart(({ chart: target }) => {
      Object.defineProperty(target, '_chartWidget', {
        value: {
          model: () => {
            throw new Error('Not built yet');
          },
        },
      });
    });

    const { result } = await resultOf(setSymbolViaApi, ['NASDAQ:MSFT', null, 5000], make);

    expect(result).toMatchObject({ symbol: 'NASDAQ:MSFT', changed: true });
  });

  test('setSymbolViaApi ignores a flag that cannot be read', async () => {
    const make = chart(({ series }) => {
      Object.assign(series, {
        isSymbolInvalid: () => {
          throw new Error('Not ready');
        },
      });
    });

    const { result } = await resultOf(setSymbolViaApi, ['NASDAQ:MSFT', null, 5000], make);

    expect(result).toMatchObject({ changed: true });
  });

  test('setSymbolViaApi lets a promise of setSymbol fail without failing itself', async () => {
    const make = chart(({ chart: target }) => {
      const original = target.setSymbol.bind(target);
      Object.assign(target, {
        setSymbol: (symbol: string, options?: { dataReady?: () => void }) => {
          void original(symbol, options);
          return Promise.reject(new Error('The app said no, after all'));
        },
      });
    });

    const { result } = await resultOf(setSymbolViaApi, ['NASDAQ:MSFT', null, 5000], make);

    expect(result).toMatchObject({ symbol: 'NASDAQ:MSFT', changed: true });
  });

  test('setSymbolViaApi fails with PAGE_EVALUATION_FAILED when setSymbol throws', async () => {
    const make = chart(({ chart: target }) => {
      Object.assign(target, {
        setSymbol: () => {
          throw new TypeError('Cannot read the symbol list');
        },
      });
    });

    const error = await failureOf(
      bridgeTo(make()).evaluate(setSymbolViaApi, ['NASDAQ:MSFT', null, 5000]),
    );

    expect(error.code).toBe('PAGE_EVALUATION_FAILED');
    expect(error.message).toBe('TypeError: Cannot read the symbol list');
    await expect(setSymbolViaApi(make() as TvWindow, 'NASDAQ:MSFT', null, 5000)).rejects.toThrow(
      'Cannot read the symbol list',
    );
  });

  test('setSymbolViaApi changes the chart at chartIndex', async () => {
    const make = chart(({ api, chart: first }, win) => {
      let shown = 'NYSE:IBM';
      const second = {
        ...first,
        symbol: () => shown,
        setSymbol: (symbol: string, options?: { dataReady?: () => void }): Promise<true> => {
          shown = symbol;
          queueMicrotask(() => options?.dataReady?.());
          return Promise.resolve(true);
        },
      };
      win.TradingViewApi = {
        ...api,
        chartsCount: () => 2,
        chart: (index = 0) => (index === 1 ? second : first),
      };
    });

    const { result } = await resultOf(setSymbolViaApi, ['NASDAQ:MSFT', 1, 5000], make);

    expect(result).toMatchObject({ previous: 'NYSE:IBM', changed: true });
  });

  test.each([
    ...NO_API,
    [
      'a chart without setSymbol',
      chart(({ chart: target }) => {
        Reflect.deleteProperty(target, 'setSymbol');
      }),
    ],
  ])('setSymbolViaApi is unavailable, before it acts, on %s', async (_case, make) => {
    const { error, win } = await failureOfBoth(setSymbolViaApi, ['NASDAQ:MSFT', null, 5000], make);

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(recordedCalls(win)).toEqual([]);
  });
});

describe('setResolutionViaApi', () => {
  test('setResolutionViaApi switches the timeframe and resolves once the data is ready', async () => {
    const { result, win } = await resultOf(setResolutionViaApi, ['60', null, 5000], chart());

    expect(result).toStrictEqual({ resolution: '60', previous: '1D', changed: true });
    const calls = callsTo(win, 'chart.setResolution');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('60');
    expect(inspectFakeWindow(win).state.resolution).toBe('60');
  });

  test.each([
    ['as written', '1D', '1D'],
    ['in its short form', 'D', '1D'],
    ['when asked in the short form', '1D', 'D'],
  ])(
    'setResolutionViaApi leaves the chart alone when it shows the timeframe already, %s',
    async (_case, shown, requested) => {
      const make = chart((_parts, win) => {
        inspectFakeWindow(win).state.resolution = shown;
      });

      const { result, win } = await resultOf(setResolutionViaApi, [requested, null, 5000], make);

      expect(result).toStrictEqual({ resolution: shown, previous: shown, changed: false });
      expect(callsOf(win)).toEqual([]);
    },
  );

  test('setResolutionViaApi returns TIMEOUT when the data never comes', async () => {
    const make = chart(({ chart: target }) => {
      Object.assign(target, { setResolution: () => Promise.resolve(true) });
    });

    const { error } = await failureOfBoth(setResolutionViaApi, ['240', null, 50], make);

    expect(error.code).toBe('TIMEOUT');
    expect(error.details).toEqual({ requested: '240', previous: '1D', timeoutMs: 50 });
  });

  test('setResolutionViaApi lets a promise of setResolution fail without failing itself', async () => {
    const make = chart(({ chart: target }) => {
      const original = target.setResolution.bind(target);
      Object.assign(target, {
        setResolution: (resolution: string, options?: { dataReady?: () => void }) => {
          void original(resolution, options);
          return Promise.reject(new Error('Refused'));
        },
      });
    });

    const { result } = await resultOf(setResolutionViaApi, ['15', null, 5000], make);

    expect(result).toMatchObject({ resolution: '15', changed: true });
  });

  test('setResolutionViaApi changes the chart at chartIndex', async () => {
    const { result, win } = await resultOf(setResolutionViaApi, ['30', 0, 5000], chart());

    expect(result).toMatchObject({ resolution: '30', changed: true });
    expect(callsTo(win, 'chart.setResolution')).toHaveLength(1);
  });

  test('setResolutionViaApi ignores data that comes after it gave up', async () => {
    let late: (() => void) | undefined;
    const make = chart(({ chart: target }) => {
      Object.assign(target, {
        setResolution: (_resolution: string, options?: { dataReady?: () => void }) => {
          late = options?.dataReady;
          return Promise.resolve(true);
        },
      });
    });

    const { error } = await failureOfBoth(setResolutionViaApi, ['240', null, 30], make);
    late?.();

    expect(error.code).toBe('TIMEOUT');
    expect(late).toBeTypeOf('function');
  });

  test('setResolutionViaApi fails with PAGE_EVALUATION_FAILED when setResolution throws', async () => {
    const make = chart(({ chart: target }) => {
      Object.assign(target, {
        setResolution: () => {
          throw new RangeError('Unsupported resolution');
        },
      });
    });

    const error = await failureOf(
      bridgeTo(make()).evaluate(setResolutionViaApi, ['7', null, 5000]),
    );

    expect(error.code).toBe('PAGE_EVALUATION_FAILED');
    expect(error.message).toBe('RangeError: Unsupported resolution');
    await expect(setResolutionViaApi(make() as TvWindow, '7', null, 5000)).rejects.toThrow(
      'Unsupported resolution',
    );
  });

  test.each([
    ...NO_API,
    [
      'a chart without setResolution',
      chart(({ chart: target }) => {
        Reflect.deleteProperty(target, 'setResolution');
      }),
    ],
  ])('setResolutionViaApi is unavailable, before it acts, on %s', async (_case, make) => {
    const { error } = await failureOfBoth(setResolutionViaApi, ['60', null, 5000], make);

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
  });
});

describe('setChartTypeViaApi', () => {
  test('setChartTypeViaApi sets the chart type and reads it back', async () => {
    const { result, win } = await resultOf(setChartTypeViaApi, [8, null], chart());

    expect(result).toStrictEqual({ chartType: 8, previous: 1, changed: true });
    expect(callsTo(win, 'chart.setChartType')).toEqual([[8]]);
  });

  test('setChartTypeViaApi changes the chart at chartIndex', async () => {
    const { result } = await resultOf(setChartTypeViaApi, [2, 0], chart());

    expect(result).toStrictEqual({ chartType: 2, previous: 1, changed: true });
  });

  test('setChartTypeViaApi leaves the chart alone when it shows the type already', async () => {
    const { result, win } = await resultOf(setChartTypeViaApi, [1, null], chart());

    expect(result).toStrictEqual({ chartType: 1, previous: 1, changed: false });
    expect(callsOf(win)).toEqual([]);
  });

  test('setChartTypeViaApi reports the type the chart shows when it does not take the new one', async () => {
    const make = chart(({ chart: target }) => {
      Object.assign(target, { setChartType: () => undefined });
    });

    const { result } = await resultOf(setChartTypeViaApi, [4, null], make);

    expect(result).toStrictEqual({ chartType: 1, previous: 1, changed: false });
  });

  test('setChartTypeViaApi waits for a promise of setChartType that settles soon', async () => {
    const make = chart(({ chart: target }, win) => {
      Object.assign(target, {
        setChartType: (type: number) =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              inspectFakeWindow(win).state.chartType = type;
              resolve();
            }, 30);
          }),
      });
    });

    const { result } = await resultOf(setChartTypeViaApi, [9, null], make);

    expect(result).toStrictEqual({ chartType: 9, previous: 1, changed: true });
  });

  test('setChartTypeViaApi stops waiting for a promise of setChartType that never settles', async () => {
    const win = chart(({ chart: target }) => {
      Object.assign(target, { setChartType: () => new Promise<never>(() => undefined) });
    })();
    const startedAt = performance.now();

    const result = await bridgeTo(win).evaluate(setChartTypeViaApi, [5, null]);

    expect(result).toStrictEqual({ chartType: 1, previous: 1, changed: false });
    expect(performance.now() - startedAt).toBeLessThan(3000);
  });

  test('setChartTypeViaApi fails with PAGE_EVALUATION_FAILED when the promise of setChartType fails', async () => {
    const make = chart(({ chart: target }) => {
      Object.assign(target, {
        setChartType: () => Promise.reject(new Error('Unsupported style')),
      });
    });

    const error = await failureOf(bridgeTo(make()).evaluate(setChartTypeViaApi, [6, null]));

    expect(error.code).toBe('PAGE_EVALUATION_FAILED');
    expect(error.message).toBe('Error: Unsupported style');
    await expect(setChartTypeViaApi(make() as TvWindow, 6, null)).rejects.toThrow(
      'Unsupported style',
    );
  });

  test.each([
    ...NO_API,
    [
      'a chart without setChartType',
      chart(({ chart: target }) => {
        Reflect.deleteProperty(target, 'setChartType');
      }),
    ],
  ])('setChartTypeViaApi is unavailable, before it acts, on %s', async (_case, make) => {
    const { error } = await failureOfBoth(setChartTypeViaApi, [8, null], make);

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
  });
});

describe('readVisibleRange', () => {
  test('readVisibleRange reads the visible range in Unix seconds', async () => {
    const { result, win } = await resultOf(readVisibleRange, [null], chart());

    expect(result).toStrictEqual({ from: fixture.visibleRange.from, to: fixture.visibleRange.to });
    expect(callsOf(win)).toEqual([]);
  });

  test('readVisibleRange reports null for an end that is not a finite number', async () => {
    const make = chart(({ chart: target }) => {
      Object.assign(target, { getVisibleRange: () => ({ from: Number.NaN, to: '1729987200' }) });
    });

    const { result } = await resultOf(readVisibleRange, [0], make);

    expect(result).toStrictEqual({ from: null, to: null });
  });

  test.each(NO_API)('readVisibleRange is unavailable on %s', async (_case, make) => {
    const { error } = await failureOfBoth(readVisibleRange, [null], make);

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
  });
});

describe('zoomToTimeRange', () => {
  test('zoomToTimeRange calls zoomToBarsRange with indices of the nearest bars', async () => {
    // Ten hours after bar 59, and twenty hours after bar 89, which is four hours before bar 90.
    const from = barTime(59) + 10 * HOUR;
    const to = barTime(89) + 20 * HOUR;

    const { result, win } = await resultOf(zoomToTimeRange, [from, to, null], chart());

    expect(callsTo(win, 'timeScale.zoomToBarsRange')).toEqual([[59, 90]]);
    expect(result).toStrictEqual({ from: barTime(59), to: barTime(90), warnings: [] });
    // The public setter throws on this build, so it is never tried.
    expect(callsTo(win, 'chart.setVisibleRange')).toEqual([]);
  });

  test('zoomToTimeRange reads times as the chart reports them, hours before the rows of the bars', async () => {
    // The days of bars 250 and 280 at 00:00 UTC: 10.5 hours after the row of the bar before, and
    // 13.5 hours before the row of the bar itself.
    const { result, win } = await resultOf(
      zoomToTimeRange,
      [dayOf(250), dayOf(280), null],
      chart(undefined, fixture, US_DAILY),
    );

    expect(callsTo(win, 'timeScale.zoomToBarsRange')).toEqual([[250, 280]]);
    expect(result).toStrictEqual({ from: dayOf(250), to: dayOf(280), warnings: [] });
  });

  test('zoomToTimeRange reads the rows of the bars on a build that cannot convert an index', async () => {
    const make = chart(({ chart: target }) => {
      Reflect.deleteProperty(target, '_convertIndexToPublicTime');
    });

    const { win } = await resultOf(zoomToTimeRange, [barTime(250), barTime(280), null], make);

    expect(callsTo(win, 'timeScale.zoomToBarsRange')).toEqual([[250, 280]]);
  });

  // The time scale keeps time points after the last bar for the empty space a chart shows there,
  // and getVisibleRange reports a range that reaches into it.
  const afterLast = (index: number): number => barTime(LAST) + (index - LAST) * DAY;
  const WITH_SPACE: FakeTvOverrides = { futurePoints: 30 };

  test('zoomToTimeRange lets a range end in the empty space after the last bar', async () => {
    const { result, win } = await resultOf(
      zoomToTimeRange,
      [barTime(250), afterLast(LAST + 20), null],
      chart(undefined, fixture, WITH_SPACE),
    );

    expect(callsTo(win, 'timeScale.zoomToBarsRange')).toEqual([[250, LAST + 20]]);
    expect(result).toStrictEqual({ from: barTime(250), to: afterLast(LAST + 20), warnings: [] });
  });

  test('zoomToTimeRange clamps a range that ends past the time points after the last bar', async () => {
    const { result, win } = await resultOf(
      zoomToTimeRange,
      [barTime(250), afterLast(LAST + 50), null],
      chart(undefined, fixture, WITH_SPACE),
    );

    expect(callsTo(win, 'timeScale.zoomToBarsRange')).toEqual([[250, LAST + 30]]);
    expect(result).toMatchObject({
      warnings: [
        `The chart reaches no further than ${toIso(afterLast(LAST + 30))}; the range was clamped`,
      ],
    });
  });

  test('zoomToTimeRange ends a range at the last bar on a build that does not say where its time points end', async () => {
    const make = chart(
      ({ timeScale }) => {
        Reflect.deleteProperty(timeScale, 'points');
      },
      fixture,
      WITH_SPACE,
    );

    const { result, win } = await resultOf(
      zoomToTimeRange,
      [barTime(250), afterLast(LAST + 20), null],
      make,
    );

    expect(callsTo(win, 'timeScale.zoomToBarsRange')).toEqual([[250, LAST]]);
    expect(result).toMatchObject({
      warnings: [`The chart has no bars after ${toIso(barTime(LAST))}; the range was clamped`],
    });
  });

  test('zoomToTimeRange moves the chart at chartIndex', async () => {
    const { win } = await resultOf(zoomToTimeRange, [barTime(10), barTime(20), 0], chart());

    expect(callsTo(win, 'timeScale.zoomToBarsRange')).toEqual([[10, 20]]);
  });

  test('zoomToTimeRange reports null for a visible range the chart does not report afterwards', async () => {
    const make = chart(({ chart: target }) => {
      Object.assign(target, { getVisibleRange: () => ({ from: Number.NaN, to: undefined }) });
    });

    const { result, win } = await resultOf(zoomToTimeRange, [barTime(10), barTime(20), null], make);

    expect(result).toStrictEqual({ from: null, to: null, warnings: [] });
    expect(callsTo(win, 'timeScale.zoomToBarsRange')).toEqual([[10, 20]]);
  });

  test('zoomToTimeRange stays on the one bar of a chart that has loaded a single bar', async () => {
    const single: TvStateFixture = { ...fixture, bars: { ...fixture.bars, count: 1 } };

    const { win } = await resultOf(
      zoomToTimeRange,
      [barTime(0) - HOUR, barTime(0) + HOUR, null],
      chart(undefined, single),
    );

    // Neither the bar before nor the bar after is loaded, so the range does not reach for them.
    expect(callsTo(win, 'timeScale.zoomToBarsRange')).toEqual([[0, 0]]);
  });

  test('zoomToTimeRange takes the earlier bar when a time lies halfway between two', async () => {
    const { win } = await resultOf(
      zoomToTimeRange,
      [barTime(10) + 12 * HOUR, barTime(20) + 12 * HOUR, null],
      chart(),
    );

    expect(callsTo(win, 'timeScale.zoomToBarsRange')).toEqual([[10, 20]]);
  });

  test('zoomToTimeRange clamps to loaded history and returns a warning', async () => {
    const from = Date.UTC(2023, 5, 1) / 1000;

    const { result, win } = await resultOf(zoomToTimeRange, [from, barTime(30), null], chart());

    expect(callsTo(win, 'timeScale.zoomToBarsRange')).toEqual([[0, 30]]);
    expect(result).toStrictEqual({
      from: barTime(0),
      to: barTime(30),
      warnings: [`History before ${toIso(barTime(0))} is not loaded; the range was clamped`],
    });
    expect(toIso(barTime(0))).toBe('2024-01-02T00:00:00Z');
  });

  test('zoomToTimeRange clamps a range that runs past the last bar and says so', async () => {
    const to = Date.UTC(2025, 0, 1) / 1000;

    const { result, win } = await resultOf(zoomToTimeRange, [barTime(250), to, null], chart());

    expect(callsTo(win, 'timeScale.zoomToBarsRange')).toEqual([[250, LAST]]);
    expect(result).toMatchObject({
      warnings: [`The chart has no bars after ${toIso(barTime(LAST))}; the range was clamped`],
    });
  });

  test.each([
    ['inside one bar', barTime(100), barTime(100) + HOUR, [100, 101]],
    ['before the first bar', 1_600_000_000, 1_650_000_000, [0, 1]],
    ['after the last bar', 1_740_000_000, 1_750_000_000, [LAST - 1, LAST]],
  ])(
    'zoomToTimeRange keeps at least one bar between the ends of a range %s',
    async (_case, from, to, indices) => {
      const { win } = await resultOf(zoomToTimeRange, [from, to, null], chart());

      expect(callsTo(win, 'timeScale.zoomToBarsRange')).toEqual([indices]);
    },
  );

  // The real container does not have to count from 0, and the search must not assume it does.
  test('zoomToTimeRange finds bars in a container whose indices do not start at 0', async () => {
    const make = chart(({ series }) => {
      const offset = 1000;
      const original = series.bars();
      Object.assign(series, {
        bars: () => ({
          size: () => original.size(),
          firstIndex: () => offset,
          lastIndex: () => offset + LAST,
          valueAt: (index: number) => original.valueAt(index - offset),
        }),
      });
    });

    const { win } = await resultOf(
      zoomToTimeRange,
      [barTime(59) + 10 * HOUR, barTime(89) + 20 * HOUR, null],
      make,
    );

    expect(callsTo(win, 'timeScale.zoomToBarsRange')).toEqual([[1059, 1090]]);
  });

  test('zoomToTimeRange answers NOT_AVAILABLE while no bar is loaded, and moves nothing', async () => {
    const empty: TvStateFixture = { ...fixture, bars: { ...fixture.bars, count: 0 } };

    const { error, win } = await failureOfBoth(
      zoomToTimeRange,
      [barTime(10), barTime(20), null],
      chart(undefined, empty),
    );

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(error.hint).toBeTruthy();
    expect(callsOf(win)).toEqual([]);
  });

  test.each([
    ...NO_API,
    [
      'a chart without its widget',
      chart(({ chart: target }) => {
        Reflect.deleteProperty(target, '_chartWidget');
      }),
    ],
    [
      'a model without a time scale',
      chart(({ model }) => {
        Object.assign(model, { model: () => ({}) });
      }),
    ],
    [
      'a time scale without zoomToBarsRange',
      chart(({ timeScale }) => {
        Reflect.deleteProperty(timeScale, 'zoomToBarsRange');
      }),
    ],
    [
      'a series without bars',
      chart(({ series }) => {
        Reflect.deleteProperty(series, 'bars');
      }),
    ],
    [
      'bars without readable times',
      chart(({ chart: target, series }) => {
        const original = series.bars();
        Object.assign(series, { bars: () => ({ ...original, valueAt: () => null }) });
        Reflect.deleteProperty(target, '_convertIndexToPublicTime');
      }),
    ],
  ])('zoomToTimeRange is unavailable, before it acts, on %s', async (_case, make) => {
    const { error, win } = await failureOfBoth(
      zoomToTimeRange,
      [barTime(10), barTime(20), null],
      make,
    );

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(recordedCalls(win)).toEqual([]);
  });
});

describe('scrollToTime', () => {
  // The fixture shows bars 200 to 299, a width of 99 bars.
  test('scrollToTime centers the bar', async () => {
    const { result, win } = await resultOf(scrollToTime, [barTime(99), 'center', null], chart());

    expect(callsTo(win, 'timeScale.zoomToBarsRange')).toEqual([[50, 149]]);
    expect(result).toStrictEqual({
      time: barTime(99),
      from: barTime(50),
      to: barTime(149),
      warnings: [],
    });
    // The width of the view is kept: only where it starts moves.
    expect(barTime(149) - barTime(50)).toBe(fixture.visibleRange.to - fixture.visibleRange.from);
  });

  test('scrollToTime finds the bar of a day as the chart reports the day', async () => {
    const { result, win } = await resultOf(
      scrollToTime,
      [dayOf(99), 'center', null],
      chart(undefined, fixture, US_DAILY),
    );

    expect(callsTo(win, 'timeScale.zoomToBarsRange')).toEqual([[50, 149]]);
    // The bar is reported in the time the chart reports for it, like the visible range.
    expect(result).toStrictEqual({
      time: dayOf(99),
      from: dayOf(50),
      to: dayOf(149),
      warnings: [],
    });
  });

  test.each([
    ['left', [99, 198]],
    ['right', [0, 99]],
  ] as const)('scrollToTime puts the bar at the %s edge', async (align, indices) => {
    const { win } = await resultOf(scrollToTime, [barTime(99) + HOUR, align, null], chart());

    expect(callsTo(win, 'timeScale.zoomToBarsRange')).toEqual([indices]);
  });

  test('scrollToTime scrolls to the last bar and says so for a time after it', async () => {
    const { result, win } = await resultOf(scrollToTime, [1_800_000_000, 'center', null], chart());

    // Centered, the view would reach 50 bars past the data, so it ends at the last bar instead.
    expect(callsTo(win, 'timeScale.zoomToBarsRange')).toEqual([[LAST - 99, LAST]]);
    expect(result).toMatchObject({
      time: barTime(LAST),
      warnings: [
        `The chart has no bars after ${toIso(barTime(LAST))}; the chart was scrolled to the last bar`,
        'The view was moved to stay within the loaded bars, so the bar is not at the center of it',
      ],
    });
  });

  test.each([
    ['the start', 10, 'center', [0, 99], 'the center'],
    ['the end', 280, 'center', [200, 299], 'the center'],
    ['the start, for the right edge', 30, 'right', [0, 99], 'the right edge'],
    ['the end, for the left edge', 250, 'left', [200, 299], 'the left edge'],
  ] as const)(
    'scrollToTime keeps the view within the loaded bars at %s',
    async (_case, index, align, indices, place) => {
      const { result, win } = await resultOf(scrollToTime, [barTime(index), align, null], chart());

      expect(callsTo(win, 'timeScale.zoomToBarsRange')).toEqual([indices]);
      expect(result).toMatchObject({
        time: barTime(index),
        warnings: [
          `The view was moved to stay within the loaded bars, so the bar is not at ${place} of it`,
        ],
      });
    },
  );

  test('scrollToTime narrows a view that is wider than the loaded bars', async () => {
    const make = chart(({ timeScale }) => {
      Object.assign(timeScale, { logicalRange: () => logical(-100, 400) });
    });

    const { result, win } = await resultOf(scrollToTime, [barTime(150), 'center', null], make);

    expect(callsTo(win, 'timeScale.zoomToBarsRange')).toEqual([[0, LAST]]);
    expect(result).toMatchObject({
      warnings: ['The chart has only 300 bars loaded, so the view was narrowed to them'],
    });
  });

  test('scrollToTime stays on the one bar of a chart that has loaded a single bar', async () => {
    const single: TvStateFixture = { ...fixture, bars: { ...fixture.bars, count: 1 } };

    const { result, win } = await resultOf(
      scrollToTime,
      [barTime(0), 'center', null],
      chart(undefined, single),
    );

    expect(callsTo(win, 'timeScale.zoomToBarsRange')).toEqual([[0, 0]]);
    expect(result).toMatchObject({
      time: barTime(0),
      warnings: ['The chart has only 1 bar loaded, so the view was narrowed to them'],
    });
  });

  // The logical range counts the empty space after the last bar, which the visible range mapped to
  // loaded bars does not.
  test('scrollToTime takes the width of the view from the logical range of the time scale', async () => {
    const make = chart(({ timeScale }) => {
      Object.assign(timeScale, { logicalRange: () => logical(100.4, 140.6) });
    });

    const { win } = await resultOf(scrollToTime, [barTime(99), 'center', null], make);

    expect(callsTo(win, 'timeScale.zoomToBarsRange')).toEqual([[79, 119]]);
  });

  test.each([
    ['answers nothing', () => null],
    ['answers ends that are not numbers', () => logical('1', '2')],
    ['has its ends the wrong way round', () => logical(10, 5)],
    // The shape the server once guessed: the app's range has no such members.
    ['has from and to instead of left() and right()', () => ({ from: 100.4, to: 140.6 })],
    [
      'throws',
      () => {
        throw new Error('Not ready');
      },
    ],
  ])(
    'scrollToTime takes the width from the visible range when the logical range %s',
    async (_case, logicalRange) => {
      const make = chart(({ timeScale }) => {
        Object.assign(timeScale, { logicalRange });
      });

      const { win } = await resultOf(scrollToTime, [barTime(99), 'center', null], make);

      expect(callsTo(win, 'timeScale.zoomToBarsRange')).toEqual([[50, 149]]);
    },
  );

  test('scrollToTime scrolls to the first loaded bar and says so for a time before it', async () => {
    const { result } = await resultOf(scrollToTime, [1_600_000_000, 'left', null], chart());

    expect(result).toMatchObject({
      time: barTime(0),
      warnings: [
        `History before ${toIso(barTime(0))} is not loaded; the chart was scrolled to the first loaded bar`,
      ],
    });
  });

  test('scrollToTime moves the chart at chartIndex', async () => {
    const { win } = await resultOf(scrollToTime, [barTime(99), 'center', 0], chart());

    expect(callsTo(win, 'timeScale.zoomToBarsRange')).toEqual([[50, 149]]);
  });

  test('scrollToTime is unavailable, before it acts, when the bars have no readable times', async () => {
    const make = chart(({ chart: target, series }) => {
      const original = series.bars();
      Object.assign(series, { bars: () => ({ ...original, valueAt: () => [null] }) });
      Reflect.deleteProperty(target, '_convertIndexToPublicTime');
    });

    const { error, win } = await failureOfBoth(scrollToTime, [barTime(40), 'center', null], make);

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(callsOf(win)).toEqual([]);
  });

  test('scrollToTime keeps a width of at least one bar', async () => {
    const make = chart(({ timeScale }) => {
      Object.assign(timeScale, { logicalRange: () => logical(5, 5) });
    });

    const { win } = await resultOf(scrollToTime, [barTime(40), 'left', null], make);

    expect(callsTo(win, 'timeScale.zoomToBarsRange')).toEqual([[40, 41]]);
  });

  test('scrollToTime is unavailable, before it acts, when the chart reports neither range', async () => {
    const make = chart(({ chart: target, timeScale }) => {
      Object.assign(target, { getVisibleRange: () => ({ from: null, to: null }) });
      Object.assign(timeScale, { logicalRange: () => null });
    });

    const { error, win } = await failureOfBoth(scrollToTime, [barTime(40), 'center', null], make);

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(callsOf(win)).toEqual([]);
  });

  test('scrollToTime answers NOT_AVAILABLE while no bar is loaded', async () => {
    const empty: TvStateFixture = { ...fixture, bars: { ...fixture.bars, count: 0 } };

    const { error } = await failureOfBoth(
      scrollToTime,
      [barTime(40), 'center', null],
      chart(undefined, empty),
    );

    expect(error.code).toBe('NOT_AVAILABLE');
  });

  test.each([
    ...NO_API,
    [
      'a time scale without zoomToBarsRange',
      chart(({ timeScale }) => {
        Reflect.deleteProperty(timeScale, 'zoomToBarsRange');
      }),
    ],
  ])('scrollToTime is unavailable, before it acts, on %s', async (_case, make) => {
    const { error } = await failureOfBoth(scrollToTime, [barTime(40), 'center', null], make);

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
  });
});
