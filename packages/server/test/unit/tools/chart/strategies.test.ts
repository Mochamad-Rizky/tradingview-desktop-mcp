import type { CdpSession } from '../../../../src/core/cdp/types.js';
import type { PageHandle } from '../../../../src/core/connection.js';
import { TvMcpError } from '../../../../src/core/errors.js';
import { describeElement, describeFocusedElement } from '../../../../src/core/tv/input.js';
import type { PageBridge } from '../../../../src/core/tv/page-bridge.js';
import { readChartSnapshot, setSymbolViaApi } from '../../../../src/tools/chart/page.js';
import {
  pageWaitMs,
  revertUnknownSymbol,
  runStrategies,
  symbolStrategies,
  timeframeStrategies,
  unknownSymbolPrevious,
} from '../../../../src/tools/chart/strategies.js';
import { failureOf } from '../../../helpers/failure-of.js';
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
};

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

    const error = await revertUnknownSymbol(page, ACTIVE, 'NASDAQ:NOPE', 'NASDAQ:AAPL', 500);

    expect(asked).toEqual([setSymbolViaApi]);
    expect(error.details).toStrictEqual({ requested: 'NASDAQ:NOPE', kept: 'NASDAQ:AAPL' });
  });

  test('revertUnknownSymbol lets a failure that is not ours through, for the log to keep', async () => {
    const failure = new Error('A bug');
    const { page } = stubPage(() => {
      throw failure;
    });

    await expect(revertUnknownSymbol(page, ACTIVE, 'NASDAQ:NOPE', 'NASDAQ:AAPL', 500)).rejects.toBe(
      failure,
    );
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
    });
    // Only the chart was read: nothing was looked up to act on.
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
