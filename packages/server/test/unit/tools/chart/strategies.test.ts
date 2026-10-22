import type { CdpSession } from '../../../../src/core/cdp/types.js';
import type { PageHandle } from '../../../../src/core/connection.js';
import { TvMcpError } from '../../../../src/core/errors.js';
import { describeElement, describeFocusedElement } from '../../../../src/core/tv/input.js';
import type { PageBridge } from '../../../../src/core/tv/page-bridge.js';
import { readChartSnapshot, setSymbolViaApi } from '../../../../src/tools/chart/page.js';
import {
  dataWaitMs,
  MIN_DATA_WAIT_MS,
  pageWaitMs,
  revertUnknownSymbol,
  runStrategies,
  symbolStrategies,
  timeframeStrategies,
  unknownSymbolPrevious,
} from '../../../../src/tools/chart/strategies.js';
import { failureOf } from '../../../helpers/failure-of.js';
import { layoutMetrics } from '../../../helpers/fake-cdp/layout.js';
import { quietLogger } from '../../../helpers/tool-context.js';

// The parts of the chart strategies that a page cannot easily be made to show: errors that are not
// the expected ones, and each strategy on its own, outside the order of its tool. The strategies
// through a real page are tested in test/integration/tools/chart.test.ts.

// A page whose bridge answers each page function the way the test says, and whose session sends
// nothing: these tests must not get as far as input.
function stubPage(answer: (fn: unknown, args: unknown[]) => unknown): {
  page: PageHandle;
  asked: unknown[];
} {
  const asked: unknown[] = [];
  const evaluate = (fn: unknown, args: unknown[]): Promise<unknown> => {
    asked.push(fn);
    return Promise.resolve().then(() => answer(fn, args));
  };
  const session: CdpSession = {
    targetId: 'PAGE1',
    isClosed: false,
    send: () => Promise.reject(new Error('No input in these tests')),
    onClose: () => undefined,
    close: () => Promise.resolve(),
  };
  return {
    page: {
      target: {
        id: 'PAGE1',
        type: 'page',
        title: 'Chart',
        url: 'https://www.tradingview.com/chart/X/',
      },
      session,
      bridge: { evaluate } as unknown as PageBridge,
    },
    asked,
  };
}

const SNAPSHOT = {
  symbol: 'NASDAQ:AAPL',
  resolution: '1D',
  symbolInvalid: false,
  from: 1721433600,
  to: 1729987200,
  seriesSymbol: 'NASDAQ:AAPL',
  seriesName: 'NASDAQ:AAPL',
  barCount: 300,
};

type Snapshot = NonNullable<ReturnType<typeof readChartSnapshot>>;

// A chart with a symbol search button, whose dialog takes the focus once the button is clicked, for
// the symbol search strategy to run through. The chart reads as `snapshots` say, one after another,
// the last one over and over; a null snapshot is a chart that cannot be read. The input events that
// reach the page are recorded and answered, and so are the questions about the layout of the page,
// which a click asks for the zoom of the page. With `tradingAction`, the page says that a click on
// the button would reach a trading action of that name, in a layer that covers the button.
function interfacePage(
  snapshots: (Snapshot | null)[],
  options: { withoutSetter?: boolean; tradingAction?: string } = {},
): { page: PageHandle; sent: string[] } {
  const sent: string[] = [];
  let reads = 0;
  let focusLooks = 0;
  const { page } = stubPage((fn) => {
    if (fn === setSymbolViaApi && options.withoutSetter === true) {
      throw new TvMcpError('CAPABILITY_UNAVAILABLE', 'No setter on this page');
    }
    if (fn === readChartSnapshot) {
      const snapshot = snapshots[Math.min(reads, snapshots.length - 1)] ?? null;
      reads += 1;
      return snapshot;
    }
    if (fn === describeElement) {
      return {
        found: true,
        visible: true,
        unsafe: false,
        rect: { x: 10, y: 10, width: 80, height: 30 },
        ...(options.tradingAction === undefined
          ? { coverage: 'clear', obscuredBy: '' }
          : {
              coverage: 'obscured',
              obscuredBy: 'div[data-name="ticket"]',
              tradingAction: options.tradingAction,
            }),
      };
    }
    if (fn === describeFocusedElement) {
      // Nothing has the focus before the click, and the field of the dialog has it after.
      focusLooks += 1;
      const editable = focusLooks > 1;
      return { unsafe: false, editable, opaque: false, focused: editable ? 'input' : 'body' };
    }
    throw new Error('Unexpected page function');
  });
  const session: CdpSession = {
    ...page.session,
    send: (method: string) => {
      sent.push(method);
      return Promise.resolve(
        method === 'Page.getLayoutMetrics'
          ? layoutMetrics({ width: 1280, height: 720, devicePixelRatio: 1 })
          : {},
      );
    },
  };
  return { page: { ...page, session }, sent };
}

const ACTIVE = { index: null, activeIndex: null };

// The strategy at `position` of a list, which the tests below know to be there.
function strategyAt<T>(list: readonly T[], position: number): T {
  const strategy = list[position];
  if (strategy === undefined) {
    throw new Error(`There is no strategy at ${String(position)}`);
  }
  return strategy;
}

test('pageWaitMs leaves the page a second to answer, and at least half a second to wait', () => {
  expect(pageWaitMs(15_000)).toBe(14_000);
  expect(pageWaitMs(1000)).toBe(500);
  expect(pageWaitMs(1200)).toBe(500);
});

test('dataWaitMs gives the data what is left of the wait, and at least 1.5 s, in whole milliseconds', () => {
  expect(MIN_DATA_WAIT_MS).toBe(1500);
  expect(dataWaitMs(3000.4, 4000)).toBe(3000);
  expect(dataWaitMs(200, 4000)).toBe(1500);
  expect(dataWaitMs(0, 14_000)).toBe(1500);
});

test('dataWaitMs never waits longer than the page wait, nor than the limit of the caller', () => {
  expect(dataWaitMs(200, 1000)).toBe(1000);
  expect(dataWaitMs(5000, 4000)).toBe(4000);
  expect(dataWaitMs(3000, 4000, 2500.6)).toBe(2501);
  expect(dataWaitMs(200, 4000, 900)).toBe(900);
  expect(dataWaitMs(200, 4000, 0)).toBe(0);
});

describe('runStrategies', () => {
  test('runStrategies adds its hint to the error of an operation that had no way', async () => {
    const error = await failureOf(runStrategies([], quietLogger, 'Do this instead.'));

    expect(error.toPayload()).toStrictEqual({
      code: 'CAPABILITY_UNAVAILABLE',
      message: 'The operation has no strategy to try',
      hint: 'Do this instead.',
      details: { attempts: [] },
    });
  });

  test('runStrategies keeps the strategies that were tried', async () => {
    const unavailable = () =>
      Promise.reject(new TvMcpError('CAPABILITY_UNAVAILABLE', 'Not on this page'));

    const error = await failureOf(
      runStrategies(
        [
          { tier: 'api', name: 'first', run: unavailable },
          { tier: 'dom', name: 'second', run: unavailable },
        ],
        quietLogger,
        'Hint.',
      ),
    );

    expect(error).toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      hint: 'Hint.',
      details: { attempts: ['first', 'second'] },
    });
  });

  test('runStrategies lets every other failure through as it is', async () => {
    const failure = new TvMcpError('TIMEOUT', 'Too slow');

    await expect(
      runStrategies(
        [{ tier: 'api', name: 'only', run: () => Promise.reject(failure) }],
        quietLogger,
        'Hint.',
      ),
    ).rejects.toBe(failure);
  });
});

describe('unknownSymbolPrevious', () => {
  const unknown = new TvMcpError('INVALID_INPUT', 'Unknown symbol NASDAQ:NOPE', {
    details: { requested: 'NASDAQ:NOPE', previous: 'NASDAQ:AAPL' },
  });

  test('unknownSymbolPrevious names the symbol the chart showed before an unknown one', () => {
    expect(unknownSymbolPrevious(unknown, 'NASDAQ:NOPE')).toBe('NASDAQ:AAPL');
  });

  test.each([
    ['another requested symbol', unknown, 'NASDAQ:OTHER'],
    [
      'another code',
      new TvMcpError('TIMEOUT', 'x', { details: unknown.details ?? {} }),
      'NASDAQ:NOPE',
    ],
    ['an INVALID_INPUT without details', new TvMcpError('INVALID_INPUT', 'x'), 'NASDAQ:NOPE'],
    [
      'a previous symbol that is not text',
      new TvMcpError('INVALID_INPUT', 'x', { details: { requested: 'NASDAQ:NOPE', previous: 1 } }),
      'NASDAQ:NOPE',
    ],
    ['an error that is not ours', new Error('Unknown symbol NASDAQ:NOPE'), 'NASDAQ:NOPE'],
  ])('unknownSymbolPrevious says nothing for %s', (_case, error, requested) => {
    expect(unknownSymbolPrevious(error, requested)).toBeUndefined();
  });
});

describe('revertUnknownSymbol', () => {
  test('revertUnknownSymbol reports the symbol the chart is back on', async () => {
    const { page, asked } = stubPage(() => ({
      symbol: 'NASDAQ:AAPL',
      previous: 'NASDAQ:NOPE',
      changed: true,
    }));

    const error = await revertUnknownSymbol(
      page,
      ACTIVE,
      'NASDAQ:NOPE',
      'NASDAQ:AAPL',
      500,
      quietLogger,
    );

    expect(asked).toEqual([setSymbolViaApi]);
    expect(error.details).toStrictEqual({ requested: 'NASDAQ:NOPE', kept: 'NASDAQ:AAPL' });
  });

  test('revertUnknownSymbol says that a switch back it could not check was not checked', async () => {
    // No setter, so the symbol search switches back, on a chart that cannot be read any more.
    const { page, sent } = interfacePage([null], { withoutSetter: true });

    const error = await revertUnknownSymbol(
      page,
      ACTIVE,
      'NASDAQ:NOPE',
      'NASDAQ:AAPL',
      500,
      quietLogger,
    );

    expect(sent).toContain('Input.insertText');
    expect(error.details).toStrictEqual({ requested: 'NASDAQ:NOPE', kept: 'NASDAQ:AAPL' });
    expect(error.hint).toMatch(/switched back to NASDAQ:AAPL, which could not be checked/);
  });

  test('revertUnknownSymbol lets a failure that is not ours through, for the log to keep', async () => {
    const failure = new Error('A bug');
    const { page } = stubPage(() => {
      throw failure;
    });

    await expect(
      revertUnknownSymbol(page, ACTIVE, 'NASDAQ:NOPE', 'NASDAQ:AAPL', 500, quietLogger),
    ).rejects.toBe(failure);
  });
});

test('the symbol search ends with the refusal of a click that would reach a trading action by its name', async () => {
  // The verdict is left to the click, whose refusal ends the operation, also when a layer covers the
  // button, which alone would hand the change on to the next strategy: no other way is tried after
  // a trading action was in the way.
  const { page, sent } = interfacePage([SNAPSHOT], { tradingAction: 'Buy' });
  const search = strategyAt(symbolStrategies(page, ACTIVE, 'NASDAQ:MSFT', 500), 1);

  const error = await failureOf(search.run());

  expect(error.code).toBe('UNSAFE_ACTION_BLOCKED');
  expect(error.details).toMatchObject({ name: 'Buy' });
  expect(sent.filter((method) => method.startsWith('Input.'))).toEqual([]);
});

describe('confirming a symbol entered through the symbol search', () => {
  const unresolved = (symbol: string, symbolInvalid = false): Snapshot => ({
    ...SNAPSHOT,
    symbol,
    symbolInvalid,
  });

  // The chart shows the new symbol at once; that it is unknown comes a poll later.
  test('the symbol search reports a symbol whose unknown flag comes after the switch', async () => {
    const { page, sent } = interfacePage([
      SNAPSHOT,
      unresolved('NASDAQ:NOPE'),
      unresolved('NASDAQ:NOPE', true),
    ]);
    const search = strategyAt(symbolStrategies(page, ACTIVE, 'NASDAQ:NOPE', 500), 1);

    const error = await failureOf(search.run());

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details).toStrictEqual({ requested: 'NASDAQ:NOPE', previous: 'NASDAQ:AAPL' });
    expect(sent).toContain('Input.insertText');
  });

  // The chart shows NASDAQ:AAPL through the exchange of its data feed, as BATS:AAPL (seen on the
  // app): switching back to that name would switch to another listing.
  test('the symbol search gives the listing of a symbol shown through its data feed to switch back to', async () => {
    const before = { ...SNAPSHOT, symbol: 'BATS:AAPL', seriesName: 'BATS:AAPL' };
    const { page } = interfacePage([
      before,
      { ...before, symbol: 'NASDAQ:NOPE', symbolInvalid: true },
    ]);
    const search = strategyAt(symbolStrategies(page, ACTIVE, 'NASDAQ:NOPE', 500), 1);

    const error = await failureOf(search.run());

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details).toStrictEqual({ requested: 'NASDAQ:NOPE', previous: 'NASDAQ:AAPL' });
  });

  test('the symbol search gives the symbol shown to switch back to when the series names nothing', async () => {
    const before = { ...SNAPSHOT, symbol: 'BATS:AAPL', seriesSymbol: null, seriesName: null };
    const { page } = interfacePage([
      before,
      { ...before, symbol: 'NASDAQ:NOPE', symbolInvalid: true },
    ]);
    const search = strategyAt(symbolStrategies(page, ACTIVE, 'NASDAQ:NOPE', 500), 1);

    const error = await failureOf(search.run());

    expect(error.details).toStrictEqual({ requested: 'NASDAQ:NOPE', previous: 'BATS:AAPL' });
  });

  test('the symbol search confirms a symbol once the series has resolved it and holds bars', async () => {
    const { page } = interfacePage([
      SNAPSHOT,
      unresolved('NASDAQ:MSFT'),
      { ...unresolved('NASDAQ:MSFT'), seriesSymbol: 'NASDAQ:MSFT', barCount: null },
      { ...unresolved('NASDAQ:MSFT'), seriesSymbol: 'NASDAQ:MSFT', barCount: 0 },
      { ...unresolved('NASDAQ:MSFT'), seriesSymbol: 'NASDAQ:MSFT' },
    ]);
    const search = strategyAt(symbolStrategies(page, ACTIVE, 'NASDAQ:MSFT', 500), 1);

    await expect(search.run()).resolves.toStrictEqual({
      symbol: 'NASDAQ:MSFT',
      previous: 'NASDAQ:AAPL',
      changed: true,
      confirmed: true,
      listing: 'NASDAQ:MSFT',
    });
  });

  test('the symbol search reports a symbol as not confirmed when the chart cannot be read after the switch', async () => {
    const { page } = interfacePage([SNAPSHOT, unresolved('NASDAQ:MSFT'), null]);
    const search = strategyAt(symbolStrategies(page, ACTIVE, 'NASDAQ:MSFT', 500), 1);

    await expect(search.run()).resolves.toStrictEqual({
      symbol: 'NASDAQ:MSFT',
      previous: 'NASDAQ:AAPL',
      changed: true,
      confirmed: false,
      listing: null,
    });
  });

  // Once TradingView has resolved a symbol, the chart names it by the exchange of its data feed:
  // NASDAQ:MSFT becomes BATS:MSFT (seen on the app). The wait follows the chart to that name.
  test('the symbol search follows the chart to the name TradingView gives the symbol once resolved', async () => {
    const { page } = interfacePage([
      SNAPSHOT,
      { ...unresolved('NASDAQ:MSFT'), seriesSymbol: null, seriesName: null, barCount: 0 },
      {
        ...SNAPSHOT,
        symbol: 'BATS:MSFT',
        seriesSymbol: 'NASDAQ:MSFT',
        seriesName: 'BATS:MSFT',
      },
    ]);
    const search = strategyAt(symbolStrategies(page, ACTIVE, 'NASDAQ:MSFT', 500), 1);
    const started = Date.now();

    await expect(search.run()).resolves.toStrictEqual({
      symbol: 'BATS:MSFT',
      previous: 'NASDAQ:AAPL',
      changed: true,
      confirmed: true,
      listing: 'NASDAQ:MSFT',
    });
    // Confirmed as soon as the chart settled, not after the whole wait.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('the symbol search reports no change when the symbol settles on the one the chart showed', async () => {
    const before = { ...SNAPSHOT, symbol: 'BATS:AAPL' };
    const { page } = interfacePage([
      before,
      { ...before, symbol: 'AAPL', seriesSymbol: null, seriesName: null, barCount: 0 },
      { ...before, seriesName: 'BATS:AAPL' },
    ]);
    const search = strategyAt(symbolStrategies(page, ACTIVE, 'AAPL', 500), 1);

    await expect(search.run()).resolves.toMatchObject({
      symbol: 'BATS:AAPL',
      previous: 'BATS:AAPL',
      changed: false,
      confirmed: true,
    });
  });

  // The flag was up for the symbol the chart showed before, so only the series can tell.
  test('the symbol search does not take a flag that was up before for the verdict on the new symbol', async () => {
    const shownInvalid = { ...SNAPSHOT, symbol: 'NASDAQ:OLD', symbolInvalid: true };
    const { page } = interfacePage([
      shownInvalid,
      { ...shownInvalid, symbol: 'NASDAQ:MSFT' },
      { ...unresolved('NASDAQ:MSFT'), seriesSymbol: 'NASDAQ:MSFT' },
    ]);
    const search = strategyAt(symbolStrategies(page, ACTIVE, 'NASDAQ:MSFT', 500), 1);

    await expect(search.run()).resolves.toMatchObject({ symbol: 'NASDAQ:MSFT', confirmed: true });
  });
});

describe('the interface strategies on their own', () => {
  test('the symbol search stops at a failure of the page that is not about the DOM', async () => {
    const timeout = new TvMcpError('TIMEOUT', 'The page did not answer');
    const { page } = stubPage((fn) => {
      if (fn === readChartSnapshot) {
        return SNAPSHOT;
      }
      if (fn === describeElement) {
        throw timeout;
      }
      throw new Error('Unexpected page function');
    });
    const search = strategyAt(symbolStrategies(page, ACTIVE, 'NASDAQ:MSFT', 500), 1);

    await expect(search.run()).rejects.toBe(timeout);
  });

  test('typing on the chart stops at a failure of the page that is not about the focus', async () => {
    const timeout = new TvMcpError('TIMEOUT', 'The page did not answer');
    const { page } = stubPage((fn) => {
      if (fn === readChartSnapshot) {
        return SNAPSHOT;
      }
      if (fn === describeFocusedElement) {
        throw timeout;
      }
      throw new Error('Unexpected page function');
    });
    const typing = strategyAt(symbolStrategies(page, ACTIVE, 'NASDAQ:MSFT', 500), 2);

    await expect(typing.run()).rejects.toBe(timeout);
  });

  // Behind the symbol search or the interval buttons, which look first, these checks never get to
  // answer, so they are asked here on their own.
  test('typing on the chart leaves the chart alone when it shows the symbol already', async () => {
    const { page, asked } = stubPage(() => SNAPSHOT);
    const typing = strategyAt(symbolStrategies(page, ACTIVE, 'Nasdaq:Aapl', 500), 2);

    await expect(typing.run()).resolves.toStrictEqual({
      symbol: 'NASDAQ:AAPL',
      previous: 'NASDAQ:AAPL',
      changed: false,
      confirmed: true,
      listing: 'NASDAQ:AAPL',
    });
    // Only the chart was read: nothing was looked up to act on.
    expect(asked).toEqual([readChartSnapshot]);
  });

  // The chart shows the symbol through the exchange of its data feed, and the series names it.
  test('typing on the chart leaves the chart alone when it shows the symbol through its data feed', async () => {
    const { page, asked } = stubPage(() => ({ ...SNAPSHOT, symbol: 'BATS:AAPL' }));
    const typing = strategyAt(symbolStrategies(page, ACTIVE, 'NASDAQ:AAPL', 500), 2);

    await expect(typing.run()).resolves.toStrictEqual({
      symbol: 'BATS:AAPL',
      previous: 'BATS:AAPL',
      changed: false,
      confirmed: true,
      listing: 'NASDAQ:AAPL',
    });
    expect(asked).toEqual([readChartSnapshot]);
  });

  test('typing on the chart leaves the chart alone when it shows the timeframe already', async () => {
    const { page, asked } = stubPage(() => SNAPSHOT);
    const typing = strategyAt(timeframeStrategies(page, ACTIVE, '1D', 500), 2);

    await expect(typing.run()).resolves.toStrictEqual({
      resolution: '1D',
      previous: '1D',
      changed: false,
    });
    expect(asked).toEqual([readChartSnapshot]);
  });

  test('typing on the chart refuses an interval that does not start with a digit, before it acts', async () => {
    const { page, asked } = stubPage(() => SNAPSHOT);
    const typing = strategyAt(timeframeStrategies(page, ACTIVE, 'D', 500), 2);

    const error = await failureOf(typing.run());

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(asked).toEqual([]);
  });
});
