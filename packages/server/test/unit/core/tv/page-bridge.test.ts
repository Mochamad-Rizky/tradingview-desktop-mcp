import type { CdpSession } from '../../../../src/core/cdp/types.js';
import { PlanLimitError, TimeoutError, TvMcpError } from '../../../../src/core/errors.js';
import {
  createPageBridge,
  isPageErrorSentinel,
  type PageBridge,
} from '../../../../src/core/tv/page-bridge.js';
import type { TvWindow } from '../../../../src/core/tv/tv-window.js';
import type { JsonValue } from '../../../../src/utils/json.js';

const DEFAULT_TIMEOUT_MS = 1000;

interface SentCommand {
  method: string;
  params: unknown;
  options: { timeoutMs?: number } | undefined;
}

// A session that records what it is sent and answers every command with `reply`, which may also
// throw to make the command fail. It never runs the page function: only its source matters here.
function fakeSession(reply: () => unknown): { session: CdpSession; sent: SentCommand[] } {
  const sent: SentCommand[] = [];
  const send = (
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number },
  ): Promise<unknown> => {
    sent.push({ method, params, options });
    return Promise.resolve().then(reply);
  };
  const session: CdpSession = {
    targetId: 'PAGE1',
    isClosed: false,
    // The protocol typings of send are generic over every CDP method; this fake answers one.
    send: send as CdpSession['send'],
    onClose: () => undefined,
    close: () => Promise.resolve(),
  };
  return { session, sent };
}

function bridgeAnswering(response: unknown): { bridge: PageBridge; sent: SentCommand[] } {
  const { session, sent } = fakeSession(() => response);
  return { bridge: createPageBridge(session, { timeoutMs: DEFAULT_TIMEOUT_MS }), sent };
}

// The Runtime.evaluate answer of a page function that returned `value` by value.
function returned(value: JsonValue): { result: Record<string, unknown> } {
  if (value === null) {
    return { result: { type: 'object', subtype: 'null', value: null } };
  }
  if (typeof value === 'object') {
    return { result: { type: 'object', value } };
  }
  return { result: { type: typeof value, value } };
}

// Page functions for the tests. Each uses its window, so the sources are realistic.
function describeArgs(win: TvWindow, count: number, label: string): string {
  return `${label}:${String(count)}:${win.location.href}`;
}

function readBuildTime(win: TvWindow): string | null {
  return win.BUILD_TIME ?? null;
}

function echoArgs(win: TvWindow, ...values: JsonValue[]): JsonValue[] {
  return win.document.visibilityState === 'visible' ? values : [];
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

function sentinel(error: Record<string, JsonValue>): { result: Record<string, unknown> } {
  return returned({ __tvmcpError: error });
}

describe('createPageBridge', () => {
  test('builds an expression that calls the function with window and JSON args', async () => {
    const { bridge, sent } = bridgeAnswering(returned('a:1:https://www.tradingview.com/'));

    await bridge.evaluate(describeArgs, [1, 'a']);

    expect(sent).toEqual([
      {
        method: 'Runtime.evaluate',
        params: {
          expression: '(' + describeArgs.toString() + ')(window, ...[1,"a"])',
          returnByValue: true,
          awaitPromise: true,
        },
        options: { timeoutMs: DEFAULT_TIMEOUT_MS },
      },
    ]);
  });

  test('spreads an empty argument list and writes arguments as JSON literals', async () => {
    const { bridge, sent } = bridgeAnswering(returned([]));

    await bridge.evaluate(readBuildTime, []);
    await bridge.evaluate(echoArgs, [{ nested: [true, null, -2.5] }, 'say "hi"\n</script>']);

    expect(sent.map(({ params }) => (params as { expression: string }).expression)).toEqual([
      `(${readBuildTime.toString()})(window, ...[])`,
      `(${echoArgs.toString()})(window, ...[{"nested":[true,null,-2.5]},"say \\"hi\\"\\n</script>"])`,
    ]);
  });

  test('uses the timeout of the call, and the default without one', async () => {
    const { bridge, sent } = bridgeAnswering(returned(null));

    await bridge.evaluate(readBuildTime, [], { timeoutMs: 250 });
    await bridge.evaluate(readBuildTime, []);
    await bridge.evaluate(readBuildTime, [], {});

    expect(sent.map(({ options }) => options)).toEqual([
      { timeoutMs: 250 },
      { timeoutMs: DEFAULT_TIMEOUT_MS },
      { timeoutMs: DEFAULT_TIMEOUT_MS },
    ]);
  });

  test.each<[string, JsonValue]>([
    ['a string', '2026-10-16T17:55:37'],
    ['a number', 42.5],
    ['zero', 0],
    ['a boolean', false],
    ['null', null],
    ['an empty string', ''],
    ['an object', { symbol: 'NASDAQ:AAPL', range: { from: 1, to: 2 }, studies: [] }],
    ['an array', [1, 'two', null, { three: 3 }]],
  ])('returns %s that the page function returned', async (_label, value) => {
    const { bridge } = bridgeAnswering(returned(value));

    await expect(bridge.evaluate(echoArgs, [])).resolves.toEqual(value);
  });

  test('maps an undefined result to null', async () => {
    const { bridge } = bridgeAnswering({ result: { type: 'undefined' } });

    await expect(bridge.evaluate(readBuildTime, [])).resolves.toBeNull();
  });

  test('returns negative zero as zero', async () => {
    const { bridge } = bridgeAnswering({
      result: { type: 'number', unserializableValue: '-0', description: '-0' },
    });

    const value = await bridge.evaluate(echoArgs, []);

    expect(Object.is(value, 0)).toBe(true);
  });

  test.each(['NaN', 'Infinity', '-Infinity', '12n'])(
    'refuses the top-level value %s, which JSON cannot carry',
    async (text) => {
      const { bridge } = bridgeAnswering({
        result: {
          type: text.endsWith('n') ? 'bigint' : 'number',
          unserializableValue: text,
          description: text,
        },
      });

      const error = await failureOf(bridge.evaluate(echoArgs, []));

      expect(error.code).toBe('PAGE_EVALUATION_FAILED');
      expect(error.message).toContain(text);
      expect(error.details).toEqual({ unserializableValue: text });
    },
  );

  test('refuses a result that came back without its value', async () => {
    const { bridge } = bridgeAnswering({
      result: { type: 'object', className: 'HTMLDivElement', description: 'div#chart' },
    });

    const error = await failureOf(bridge.evaluate(echoArgs, []));

    expect(error.code).toBe('PAGE_EVALUATION_FAILED');
    expect(error.details).toEqual({ type: 'object' });
  });

  test('maps exceptionDetails to PAGE_EVALUATION_FAILED', async () => {
    const description =
      "TypeError: Cannot read properties of undefined (reading 'activeChart')\n" +
      '    at readChart (<anonymous>:2:30)\n' +
      '    at <anonymous>:4:3';
    const exception = { type: 'object', subtype: 'error', className: 'TypeError', description };
    const { bridge } = bridgeAnswering({
      result: exception,
      exceptionDetails: {
        exceptionId: 1,
        text: 'Uncaught',
        lineNumber: 1,
        columnNumber: 29,
        exception,
      },
    });

    const error = await failureOf(bridge.evaluate(readBuildTime, []));

    expect(error.code).toBe('PAGE_EVALUATION_FAILED');
    expect(error.message).toBe(
      "TypeError: Cannot read properties of undefined (reading 'activeChart')",
    );
    expect(error.toPayload()).toEqual({
      code: 'PAGE_EVALUATION_FAILED',
      message: "TypeError: Cannot read properties of undefined (reading 'activeChart')",
      details: { text: 'Uncaught' },
    });
    // The rest of the description is a stack trace, which never leaves the server.
    expect(JSON.stringify(error.toPayload())).not.toContain('<anonymous>');
  });

  test('takes the first line of a description with Windows line endings', async () => {
    const exception = { type: 'object', subtype: 'error', description: 'Error: boom\r\n    at x' };
    const { bridge } = bridgeAnswering({
      result: exception,
      exceptionDetails: {
        exceptionId: 1,
        text: 'Uncaught',
        lineNumber: 0,
        columnNumber: 0,
        exception,
      },
    });

    const error = await failureOf(bridge.evaluate(readBuildTime, []));

    expect(error.message).toBe('Error: boom');
  });

  test('falls back to the exception text when the thrown value has no description', async () => {
    const exception = { type: 'string', value: 'Data export is not supported' };
    const { bridge } = bridgeAnswering({
      result: exception,
      exceptionDetails: {
        exceptionId: 3,
        text: 'Uncaught (in promise)',
        lineNumber: 0,
        columnNumber: 0,
        exception,
      },
    });

    const error = await failureOf(bridge.evaluate(readBuildTime, []));

    expect(error.toPayload()).toEqual({
      code: 'PAGE_EVALUATION_FAILED',
      message: 'Uncaught (in promise)',
      details: { text: 'Uncaught (in promise)', thrown: 'Data export is not supported' },
    });
  });

  test('reports an exception without an exception object by its text', async () => {
    const { bridge } = bridgeAnswering({
      result: { type: 'undefined' },
      exceptionDetails: { exceptionId: 1, text: 'Uncaught', lineNumber: 0, columnNumber: 0 },
    });

    const error = await failureOf(bridge.evaluate(readBuildTime, []));

    expect(error.toPayload()).toEqual({
      code: 'PAGE_EVALUATION_FAILED',
      message: 'Uncaught',
      details: { text: 'Uncaught' },
    });
  });

  test('names the failure when neither a description nor a text is given', async () => {
    const exception = { type: 'object', subtype: 'error', description: '' };
    const { bridge } = bridgeAnswering({
      result: exception,
      exceptionDetails: { exceptionId: 1, text: '', lineNumber: 0, columnNumber: 0, exception },
    });

    const error = await failureOf(bridge.evaluate(readBuildTime, []));

    expect(error.code).toBe('PAGE_EVALUATION_FAILED');
    expect(error.message).not.toBe('');
  });

  test('maps a PLAN_LIMIT sentinel to PlanLimitError', async () => {
    const { bridge } = bridgeAnswering(
      sentinel({
        code: 'PLAN_LIMIT',
        message: 'Your plan allows 2 indicators per chart',
        hint: 'Remove an indicator first.',
        details: { feature: 'INDICATORS_ON_CHART', limit: 2 },
      }),
    );

    const error = await failureOf(bridge.evaluate(readBuildTime, []));

    expect(error).toBeInstanceOf(PlanLimitError);
    expect(error.toPayload()).toEqual({
      code: 'PLAN_LIMIT',
      message: 'Your plan allows 2 indicators per chart',
      hint: 'Remove an indicator first.',
      details: { feature: 'INDICATORS_ON_CHART', limit: 2 },
    });
  });

  test('maps a PLAN_LIMIT sentinel without a hint to PlanLimitError without one', async () => {
    const { bridge } = bridgeAnswering(
      sentinel({
        code: 'PLAN_LIMIT',
        message: 'total_alerts_count_exceeded',
        details: { feature: 'ALERTS', limit: 5 },
      }),
    );

    const error = await failureOf(bridge.evaluate(readBuildTime, []));

    expect(error).toBeInstanceOf(PlanLimitError);
    expect(error.toPayload()).toEqual({
      code: 'PLAN_LIMIT',
      message: 'total_alerts_count_exceeded',
      details: { feature: 'ALERTS', limit: 5 },
    });
  });

  test.each<[string, JsonValue]>([
    ['no details', null],
    ['no feature', { limit: 2 }],
    ['a feature that is not a string', { feature: 7, limit: 2 }],
    ['a limit that is not a number', { feature: 'INDICATORS_ON_CHART', limit: '2' }],
  ])('keeps a PLAN_LIMIT sentinel with %s as a plain PLAN_LIMIT error', async (_label, details) => {
    const { bridge } = bridgeAnswering(
      sentinel({
        code: 'PLAN_LIMIT',
        message: 'Limit reached',
        ...(details === null ? {} : { details }),
      }),
    );

    const error = await failureOf(bridge.evaluate(readBuildTime, []));

    expect(error).not.toBeInstanceOf(PlanLimitError);
    expect(error.toPayload()).toEqual({
      code: 'PLAN_LIMIT',
      message: 'Limit reached',
      ...(details === null ? {} : { details }),
    });
  });

  test.each<[string, Record<string, JsonValue>]>([
    [
      'INVALID_INPUT with a hint and details',
      {
        code: 'INVALID_INPUT',
        message: 'Unknown symbol NOSUCH:SYMBOL',
        hint: 'Search for the symbol first.',
        details: { symbol: 'NOSUCH:SYMBOL', kept: 'NASDAQ:AAPL' },
      },
    ],
    ['NOT_AVAILABLE without optional members', { code: 'NOT_AVAILABLE', message: 'No depth' }],
    [
      'CAPABILITY_UNAVAILABLE with details only',
      {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'The chart model is not reachable',
        details: { path: '_chartWidget' },
      },
    ],
    ['TIMEOUT with a hint only', { code: 'TIMEOUT', message: 'dataReady', hint: 'Retry.' }],
  ])('maps a sentinel with %s to TvMcpError with the same code', async (_label, error) => {
    const { bridge } = bridgeAnswering(sentinel(error));

    const thrown = await failureOf(bridge.evaluate(readBuildTime, []));

    expect(thrown).not.toBeInstanceOf(PlanLimitError);
    expect(thrown.toPayload()).toEqual(error);
  });

  test('maps an unknown sentinel code to PAGE_EVALUATION_FAILED with the raw code', async () => {
    const { bridge } = bridgeAnswering(
      sentinel({ code: 'NO_SUCH_CODE', message: 'Something failed', hint: 'Ignored.' }),
    );

    const error = await failureOf(bridge.evaluate(readBuildTime, []));

    expect(error.toPayload()).toEqual({
      code: 'PAGE_EVALUATION_FAILED',
      message: 'Something failed',
      details: { rawCode: 'NO_SUCH_CODE' },
    });
  });

  test.each<[string, JsonValue, JsonValue]>([
    ['a code that is not a string', { code: 42, message: 'x' }, 42],
    ['no code', { message: 'x' }, null],
    ['no message', { code: 'INVALID_INPUT' }, 'INVALID_INPUT'],
    ['a message that is not a string', { code: 'INVALID_INPUT', message: 1 }, 'INVALID_INPUT'],
    [
      'a hint that is not a string',
      { code: 'INVALID_INPUT', message: 'x', hint: 3 },
      'INVALID_INPUT',
    ],
    ['a null hint', { code: 'INVALID_INPUT', message: 'x', hint: null }, 'INVALID_INPUT'],
    [
      'details that are a list',
      { code: 'NOT_AVAILABLE', message: 'x', details: [1] },
      'NOT_AVAILABLE',
    ],
    ['null details', { code: 'NOT_AVAILABLE', message: 'x', details: null }, 'NOT_AVAILABLE'],
    ['an error that is a string', 'INVALID_INPUT', null],
    ['an error that is a list', ['INVALID_INPUT', 'x'], null],
    ['an error that is null', null, null],
  ])('treats a sentinel with %s as PAGE_EVALUATION_FAILED', async (_label, raw, rawCode) => {
    const { bridge } = bridgeAnswering(returned({ __tvmcpError: raw }));

    const error = await failureOf(bridge.evaluate(readBuildTime, []));

    expect(error.code).toBe('PAGE_EVALUATION_FAILED');
    expect(error.message).not.toBe('');
    expect(error.details).toEqual({ rawCode });
  });

  test('relays the message of a malformed sentinel when it has one', async () => {
    const { bridge } = bridgeAnswering(
      sentinel({ code: 'INVALID_INPUT', message: 'Unknown symbol', hint: 3 }),
    );

    const error = await failureOf(bridge.evaluate(readBuildTime, []));

    expect(error.message).toBe('Unknown symbol');
  });

  test('does not mistake a result with other keys for a sentinel', async () => {
    const value = { error: { code: 'INVALID_INPUT', message: 'not a sentinel' }, tvmcpError: 1 };
    const { bridge } = bridgeAnswering(returned(value));

    await expect(bridge.evaluate(echoArgs, [])).resolves.toEqual(value);
  });

  test('passes failures of the session through unchanged', async () => {
    const timeout = new TimeoutError('CDP Runtime.evaluate on PAGE1', DEFAULT_TIMEOUT_MS);
    const unreachable = new TvMcpError('CDP_UNREACHABLE', 'The connection to PAGE1 is closed');
    const failures = [timeout, unreachable];
    const { session } = fakeSession(() => {
      const failure = failures.shift();
      throw failure ?? new Error('The test sent more commands than it expected');
    });
    const bridge = createPageBridge(session, { timeoutMs: DEFAULT_TIMEOUT_MS });

    await expect(bridge.evaluate(readBuildTime, [])).rejects.toBe(timeout);
    await expect(bridge.evaluate(readBuildTime, [])).rejects.toBe(unreachable);
  });
});

describe('isPageErrorSentinel', () => {
  test('accepts a sentinel with and without its optional members', () => {
    expect(isPageErrorSentinel({ __tvmcpError: { code: 'NOT_AVAILABLE', message: 'x' } })).toBe(
      true,
    );
    expect(
      isPageErrorSentinel({
        __tvmcpError: {
          code: 'PLAN_LIMIT',
          message: 'x',
          hint: 'y',
          details: { feature: 'ALERTS', limit: 5 },
        },
        extra: 'ignored',
      }),
    ).toBe(true);
  });

  test.each<[string, unknown]>([
    ['null', null],
    ['a string', '__tvmcpError'],
    ['a list', [{ code: 'NOT_AVAILABLE', message: 'x' }]],
    ['an object without the key', { code: 'NOT_AVAILABLE', message: 'x' }],
    [
      'an object that only inherits the key',
      Object.create({ __tvmcpError: { code: 'NOT_AVAILABLE', message: 'x' } }) as unknown,
    ],
    ['an unknown code', { __tvmcpError: { code: 'NOPE', message: 'x' } }],
    [
      'an inherited object member as the code',
      { __tvmcpError: { code: 'toString', message: 'x' } },
    ],
    ['a missing message', { __tvmcpError: { code: 'NOT_AVAILABLE' } }],
    [
      'a hint that is not a string',
      { __tvmcpError: { code: 'NOT_AVAILABLE', message: 'x', hint: 1 } },
    ],
    [
      'details that are a list',
      { __tvmcpError: { code: 'NOT_AVAILABLE', message: 'x', details: [] } },
    ],
    ['null details', { __tvmcpError: { code: 'NOT_AVAILABLE', message: 'x', details: null } }],
    ['an error that is a list', { __tvmcpError: [] }],
  ])('rejects %s', (_label, value) => {
    expect(isPageErrorSentinel(value)).toBe(false);
  });
});
