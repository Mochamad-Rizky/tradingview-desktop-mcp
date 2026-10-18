import type { Protocol } from 'devtools-protocol/types/protocol.js';
import type { CdpSession } from '../cdp/types.js';
import { isErrorCode, PlanLimitError, TvMcpError, type ErrorCode } from '../errors.js';
import type { JsonObject, JsonValue } from '../../utils/json.js';
import type { TvWindow } from './tv-window.js';

// How a page function reports an expected failure, such as an unknown symbol or a plan limit. An
// exception would arrive as a stack trace without a code, so the function returns this object
// instead, and the bridge turns it into the TvMcpError it describes.
export interface PageErrorSentinel {
  __tvmcpError: { code: ErrorCode; message: string; hint?: string; details?: JsonObject };
}

// A function that runs inside the page. The bridge sends its source text, so it must be
// self-contained: it may use its parameters and the globals of the page, and nothing of its
// module (no imports, helpers or constants). Its arguments and its result cross the CDP boundary
// as JSON.
export type PageFunction<A extends JsonValue[], R extends JsonValue | null> = (
  win: TvWindow,
  ...args: A
) => R | PageErrorSentinel | Promise<R | PageErrorSentinel>;

export interface PageBridge {
  // Runs `fn` in the page with `args` and resolves with what it returned, awaiting a promise; an
  // undefined result becomes null. Fails with PAGE_EVALUATION_FAILED when the function throws or
  // returns something JSON cannot carry, with the error a sentinel describes, and with the errors
  // of CdpSession.send (TIMEOUT, CDP_UNREACHABLE, ...) unchanged.
  evaluate<A extends JsonValue[], R extends JsonValue | null>(
    fn: PageFunction<A, R>,
    args: A,
    options?: { timeoutMs?: number },
  ): Promise<R>;
}

const SENTINEL_KEY = '__tvmcpError';

// Values come back from the page as parsed JSON, so a plain object is anything that is neither
// null nor an array. Nothing here uses instanceof: page values belong to another realm.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasSentinelKey(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.hasOwn(value, SENTINEL_KEY);
}

// Meant for values that crossed the JSON boundary, whose members are JSON already, so details are
// only checked for being an object.
export function isPageErrorSentinel(value: unknown): value is PageErrorSentinel {
  if (!hasSentinelKey(value)) {
    return false;
  }
  const error = value[SENTINEL_KEY];
  return (
    isRecord(error) &&
    isErrorCode(error.code) &&
    typeof error.message === 'string' &&
    (error.hint === undefined || typeof error.hint === 'string') &&
    (error.details === undefined || isRecord(error.details))
  );
}

function sentinelError(value: Record<string, unknown>): TvMcpError {
  if (isPageErrorSentinel(value)) {
    const { code, message, hint, details } = value.__tvmcpError;
    const { feature, limit } = details ?? {};
    if (code === 'PLAN_LIMIT' && typeof feature === 'string' && typeof limit === 'number') {
      return new PlanLimitError(feature, limit, message, hint);
    }
    return new TvMcpError(code, message, {
      ...(hint === undefined ? {} : { hint }),
      ...(details === undefined ? {} : { details }),
    });
  }
  // A page function wrote a sentinel this server cannot trust, most likely with a code that is
  // not one of ours. Its message is still the best account of what went wrong.
  const raw = value[SENTINEL_KEY];
  const rawCode = isRecord(raw) ? raw.code : undefined;
  const message = isRecord(raw) && typeof raw.message === 'string' ? raw.message : '';
  return new TvMcpError(
    'PAGE_EVALUATION_FAILED',
    message === ''
      ? 'The page function reported an error in a form the server does not know'
      : message,
    // JSON, because it came back by value; null when the sentinel had no code at all.
    { details: { rawCode: rawCode === undefined ? null : (rawCode as JsonValue) } },
  );
}

function isJsonPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

// What Runtime.evaluate reports when the code threw or its promise rejected. The description of an
// error is its stack trace, which never leaves the server: only its first line ("TypeError: ...")
// is kept. A thrown value that is not an error has no description, and is kept as a detail.
function evaluationFailure(exceptionDetails: Protocol.Runtime.ExceptionDetails): TvMcpError {
  const { text, exception } = exceptionDetails;
  // trim() also drops the carriage return of a CRLF line end.
  const firstLine = exception?.description?.split('\n', 1)[0]?.trim() ?? '';
  const thrown: unknown = exception?.value;
  return new TvMcpError(
    'PAGE_EVALUATION_FAILED',
    firstLine || text || 'The page function failed without a description',
    { details: { text, ...(isJsonPrimitive(thrown) ? { thrown } : {}) } },
  );
}

// The value of a result that was returned by value. JSON cannot carry NaN, the infinities or a
// bigint, so Chrome hands them over as text, and a page function that produced one broke its
// contract; negative zero is still a number JSON can carry.
function resultValue(result: Protocol.Runtime.RemoteObject): unknown {
  if (result.type === 'undefined') {
    return null;
  }
  const { unserializableValue } = result;
  if (unserializableValue === '-0') {
    return 0;
  }
  if (unserializableValue !== undefined) {
    throw new TvMcpError(
      'PAGE_EVALUATION_FAILED',
      `The page function returned ${unserializableValue}, which is not a JSON value`,
      { details: { unserializableValue } },
    );
  }
  if (!('value' in result)) {
    // What Chrome answers for an object it does not serialize, such as a DOM node.
    throw new TvMcpError(
      'PAGE_EVALUATION_FAILED',
      `The page function returned a value of type ${result.type} that could not be read`,
      { details: { type: result.type } },
    );
  }
  const value: unknown = result.value;
  return value;
}

export function createPageBridge(session: CdpSession, defaults: { timeoutMs: number }): PageBridge {
  return {
    async evaluate<A extends JsonValue[], R extends JsonValue | null>(
      fn: PageFunction<A, R>,
      args: A,
      options?: { timeoutMs?: number },
    ): Promise<R> {
      // The window is passed in rather than read as a global, so page functions take it as a
      // parameter and can run against a fake window in tests. The arguments are written as JSON,
      // which is also a valid JavaScript literal. The one difference: a "__proto__" key sets the
      // prototype of the object literal instead of adding a member.
      const expression = `(${fn.toString()})(window, ...${JSON.stringify(args)})`;
      const { result, exceptionDetails } = await session.send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true },
        { timeoutMs: options?.timeoutMs ?? defaults.timeoutMs },
      );
      if (exceptionDetails !== undefined) {
        throw evaluationFailure(exceptionDetails);
      }
      const value = resultValue(result);
      if (hasSentinelKey(value)) {
        throw sentinelError(value);
      }
      // The page function's own type promises R; what came back is JSON either way.
      return value as R;
    },
  };
}
