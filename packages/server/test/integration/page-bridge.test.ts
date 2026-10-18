import { createCriConnector } from '../../src/core/cdp/cri-connector.js';
import { createHttpDiscovery } from '../../src/core/cdp/discovery.js';
import type { CdpSession } from '../../src/core/cdp/types.js';
import { PlanLimitError, TimeoutError, TvMcpError } from '../../src/core/errors.js';
import { createPageBridge, type PageErrorSentinel } from '../../src/core/tv/page-bridge.js';
import { readVisibilityState } from '../../src/core/tv/probes.js';
import type { TvWindow } from '../../src/core/tv/tv-window.js';
import type { JsonValue } from '../../src/utils/json.js';
import { startFakeCdpServer, type FakeCdpServer } from '../helpers/fake-cdp/server.js';
import { loadTargetsFixture } from '../helpers/fake-cdp/targets.js';
import { loadTvFixture } from '../helpers/fake-tv/fixture.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTvOverrides,
  type FakeTvWindow,
} from '../helpers/fake-tv/window.js';

const CHART_ID = 'BBB144A7827AE55CBA0E74986FC9574C';
// A blank page of the app: it accepts the WebSocket and never answers a command.
const SILENT_ID = 'D4FA899CB58B76FCEDDAC2E1E63735B2';
const CALL_TIMEOUT_MS = 5000;

// Everything a test starts is registered here, because a server that is still listening or a
// socket that is still open keeps the vitest worker from exiting.
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

interface Page {
  server: FakeCdpServer;
  win: FakeTvWindow;
  session: CdpSession;
}

// The observed target list of the app, with a fake TradingView window on its chart tab, and a
// session to `targetId` the way the connection manager opens one.
async function openPage(targetId = CHART_ID, overrides: FakeTvOverrides = {}): Promise<Page> {
  const win = createFakeTvWindow(loadTvFixture(), overrides);
  const server = await startFakeCdpServer({
    targets: loadTargetsFixture({ chartWindow: () => win }),
  });
  cleanups.push(() => server.close());
  const discovery = createHttpDiscovery({
    host: server.host,
    port: server.port,
    timeoutMs: CALL_TIMEOUT_MS,
  });
  const target = (await discovery.targets()).find((candidate) => candidate.id === targetId);
  if (target === undefined) {
    throw new Error(`The fake server does not list ${targetId}`);
  }
  const connector = createCriConnector({
    host: server.host,
    port: server.port,
    defaultTimeoutMs: CALL_TIMEOUT_MS,
  });
  const session = await connector.connect(target);
  cleanups.push(() => session.close());
  return { server, win, session };
}

// Resolves with the error of a call that must fail with one of ours.
async function failureOf(call: Promise<unknown>): Promise<TvMcpError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof TvMcpError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the call to reject');
}

// Page functions of the tests, in the shapes the domain modules will use.

// Waits on a timer of the page, then reads the chart: an async page function with arguments.
async function readChartAfter(
  win: TvWindow,
  delayMs: number,
  field: 'symbol' | 'resolution',
): Promise<string | null> {
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
  const chart = win.TradingViewApi?.activeChart();
  if (chart === undefined) {
    return null;
  }
  return field === 'symbol' ? chart.symbol() : chart.resolution();
}

function echoArgs(win: TvWindow, ...values: JsonValue[]): JsonValue[] {
  return win.location.protocol === 'https:' ? values : [];
}

function checkSymbol(win: TvWindow, symbol: string): string | PageErrorSentinel {
  const current = win.TradingViewApi?.activeChart().symbol() ?? null;
  if (current === symbol) {
    return current;
  }
  return {
    __tvmcpError: {
      code: 'INVALID_INPUT',
      message: `The chart does not show ${symbol}`,
      hint: 'Switch the symbol first.',
      details: { symbol, current },
    },
  };
}

function refuseAnotherStudy(win: TvWindow, limit: number): PageErrorSentinel {
  return {
    __tvmcpError: {
      code: 'PLAN_LIMIT',
      message: `This plan allows ${String(limit)} indicators per chart`,
      hint: 'Remove an indicator first.',
      details: {
        feature: 'INDICATORS_ON_CHART',
        limit,
        current: win.TradingViewApi?.activeChart().getAllStudies().length ?? 0,
      },
    },
  };
}

// The observed build throws "Not implemented" from setVisibleRange.
function setVisibleRangeViaApi(win: TvWindow, from: number, to: number): null {
  win.TradingViewApi?.activeChart().setVisibleRange({ from, to });
  return null;
}

async function failInPromise(win: TvWindow, reason: string): Promise<null> {
  await Promise.resolve();
  throw new RangeError(`${reason} on ${win.location.hostname}`);
}

// The page answers undefined where the contract promised a value, as a member that a new web
// build dropped would.
function readDroppedMember(win: TvWindow): string | null {
  const api = win.TradingViewApi as unknown as Record<string, unknown> | undefined;
  return api?.droppedInThisBuild as string | null;
}

test('evaluates a page function against the fake CDP page', async () => {
  const { server, win, session } = await openPage();
  const bridge = createPageBridge(session, { timeoutMs: CALL_TIMEOUT_MS });

  const visibility = await bridge.evaluate(readVisibilityState, []);
  const symbol = await bridge.evaluate(readChartAfter, [10, 'symbol']);
  const echoed = await bridge.evaluate(echoArgs, [1, 'two "quoted"\n', { three: [true, null] }]);

  expect(visibility).toBe('visible');
  expect(symbol).toBe('NASDAQ:AAPL');
  expect(echoed).toEqual([1, 'two "quoted"\n', { three: [true, null] }]);
  expect(
    server.calls.map(({ targetId, method, params }) => ({ targetId, method, params })),
  ).toEqual([
    {
      targetId: CHART_ID,
      method: 'Runtime.evaluate',
      params: {
        expression: `(${readVisibilityState.toString()})(window, ...[])`,
        returnByValue: true,
        awaitPromise: true,
      },
    },
    {
      targetId: CHART_ID,
      method: 'Runtime.evaluate',
      params: {
        expression: `(${readChartAfter.toString()})(window, ...[10,"symbol"])`,
        returnByValue: true,
        awaitPromise: true,
      },
    },
    expect.objectContaining({ method: 'Runtime.evaluate' }),
  ]);
  // Reading leaves the page as it was.
  expect(inspectFakeWindow(win).calls).toEqual([]);
});

test('reads the visibility of a background tab', async () => {
  const { session } = await openPage(CHART_ID, { visibilityState: 'hidden' });
  const bridge = createPageBridge(session, { timeoutMs: CALL_TIMEOUT_MS });

  await expect(bridge.evaluate(readVisibilityState, [])).resolves.toBe('hidden');
});

test('times out on silent targets', async () => {
  const { session } = await openPage(SILENT_ID);
  const bridge = createPageBridge(session, { timeoutMs: 200 });
  const startedAt = performance.now();

  const perCall = await failureOf(bridge.evaluate(readVisibilityState, [], { timeoutMs: 300 }));
  const waitedMs = performance.now() - startedAt;
  const byDefault = await failureOf(bridge.evaluate(readVisibilityState, []));

  expect(perCall).toBeInstanceOf(TimeoutError);
  expect(perCall.details).toEqual({ label: `CDP Runtime.evaluate on ${SILENT_ID}`, ms: 300 });
  expect(waitedMs).toBeGreaterThanOrEqual(250);
  expect(waitedMs).toBeLessThan(CALL_TIMEOUT_MS);
  expect(byDefault).toBeInstanceOf(TimeoutError);
  expect(byDefault.details).toEqual({ label: `CDP Runtime.evaluate on ${SILENT_ID}`, ms: 200 });
});

test('maps an error thrown in the page to PAGE_EVALUATION_FAILED', async () => {
  const { win, session } = await openPage();
  const bridge = createPageBridge(session, { timeoutMs: CALL_TIMEOUT_MS });

  const thrown = await failureOf(bridge.evaluate(setVisibleRangeViaApi, [1, 2]));
  const rejected = await failureOf(bridge.evaluate(failInPromise, ['boom']));

  expect(thrown.toPayload()).toEqual({
    code: 'PAGE_EVALUATION_FAILED',
    message: 'Error: Not implemented',
    details: { text: 'Uncaught' },
  });
  expect(inspectFakeWindow(win).callsTo('chart.setVisibleRange')).toEqual([[{ from: 1, to: 2 }]]);
  expect(rejected.toPayload()).toEqual({
    code: 'PAGE_EVALUATION_FAILED',
    message: 'RangeError: boom on www.tradingview.com',
    details: { text: 'Uncaught (in promise)' },
  });
});

test('relays the error sentinels of page functions as typed errors', async () => {
  const { session } = await openPage();
  const bridge = createPageBridge(session, { timeoutMs: CALL_TIMEOUT_MS });

  await expect(bridge.evaluate(checkSymbol, ['NASDAQ:AAPL'])).resolves.toBe('NASDAQ:AAPL');
  const invalid = await failureOf(bridge.evaluate(checkSymbol, ['NOSUCH:SYMBOL']));
  const limited = await failureOf(bridge.evaluate(refuseAnotherStudy, [2]));

  expect(invalid).not.toBeInstanceOf(PlanLimitError);
  expect(invalid.toPayload()).toEqual({
    code: 'INVALID_INPUT',
    message: 'The chart does not show NOSUCH:SYMBOL',
    hint: 'Switch the symbol first.',
    details: { symbol: 'NOSUCH:SYMBOL', current: 'NASDAQ:AAPL' },
  });
  expect(limited).toBeInstanceOf(PlanLimitError);
  expect(limited.toPayload()).toEqual({
    code: 'PLAN_LIMIT',
    message: 'This plan allows 2 indicators per chart',
    hint: 'Remove an indicator first.',
    details: { feature: 'INDICATORS_ON_CHART', limit: 2 },
  });
});

test('returns null when the page answers undefined', async () => {
  const { session } = await openPage();
  const bridge = createPageBridge(session, { timeoutMs: CALL_TIMEOUT_MS });

  await expect(bridge.evaluate(readDroppedMember, [])).resolves.toBeNull();
});

test('reports a page without TradingViewApi through the result, not as an error', async () => {
  const { session } = await openPage(CHART_ID, { withoutApi: true });
  const bridge = createPageBridge(session, { timeoutMs: CALL_TIMEOUT_MS });

  await expect(bridge.evaluate(readChartAfter, [0, 'resolution'])).resolves.toBeNull();
  await expect(bridge.evaluate(readVisibilityState, [])).resolves.toBe('visible');
});
