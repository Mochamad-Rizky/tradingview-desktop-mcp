import type { JsonObject } from '../utils/json.js';

// A closed set, in spec order (design spec 5.2): clients branch on these codes, so adding one is a
// contract change that should show up in review, not a free-form string. It is a value as well as
// a type so that untrusted input, such as an error sentinel returned by a page function, can be
// checked at runtime with isErrorCode.
export const ERROR_CODES = [
  'TV_NOT_INSTALLED',
  'TV_NOT_RUNNING',
  'RESTART_REQUIRED',
  'LAUNCH_FAILED',
  'CDP_UNREACHABLE',
  'TARGET_NOT_FOUND',
  'TIMEOUT',
  'PAGE_EVALUATION_FAILED',
  'CAPABILITY_UNAVAILABLE',
  'NOT_AVAILABLE',
  'PLAN_LIMIT',
  'INVALID_INPUT',
  'CONFIRMATION_REQUIRED',
  'UNSAFE_ACTION_BLOCKED',
  'AUTH_REQUIRED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

// A Set, not an object lookup: names every object inherits, such as "constructor", must not pass.
const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set(ERROR_CODES);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && KNOWN_ERROR_CODES.has(value);
}

// The only error shape that leaves the server. It has no stack and no cause by construction.
export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  hint?: string;
  details?: JsonObject;
}

export class TvMcpError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly details?: JsonObject;

  constructor(
    code: ErrorCode,
    message: string,
    options: { hint?: string; details?: JsonObject; cause?: unknown } = {},
  ) {
    // Error reads only `cause` from its options and ignores the other keys.
    super(message, options);
    this.name = 'TvMcpError';
    this.code = code;
    // With exactOptionalPropertyTypes an absent hint or details must stay absent, not undefined.
    if (options.hint !== undefined) {
      this.hint = options.hint;
    }
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }

  toPayload(): ErrorPayload {
    const payload: ErrorPayload = { code: this.code, message: this.message };
    if (this.hint !== undefined) {
      payload.hint = this.hint;
    }
    if (this.details !== undefined) {
      payload.details = this.details;
    }
    return payload;
  }
}

export class PlanLimitError extends TvMcpError {
  // A message reported by TradingView itself is relayed unchanged (design spec 5.3, rule 3), and
  // so is the hint of the page function that detected the limit.
  constructor(feature: string, limit: number, message?: string, hint?: string) {
    super('PLAN_LIMIT', message ?? `Plan limit reached for ${feature} (limit: ${String(limit)})`, {
      details: { feature, limit },
      // Left out, not set to undefined, to stay valid under exactOptionalPropertyTypes.
      ...(hint === undefined ? {} : { hint }),
    });
    this.name = 'PlanLimitError';
  }
}

export class TimeoutError extends TvMcpError {
  constructor(label: string, ms: number) {
    super('TIMEOUT', `${label} timed out after ${String(ms)} ms`, { details: { label, ms } });
    this.name = 'TimeoutError';
  }
}

export class CapabilityError extends TvMcpError {
  // `attempts` lists the strategies that were tried, in order, so a client can see why every
  // tier was unavailable.
  constructor(message: string, attempts?: string[]) {
    super(
      'CAPABILITY_UNAVAILABLE',
      message,
      attempts === undefined ? {} : { details: { attempts } },
    );
    this.name = 'CapabilityError';
  }
}

export function isTvMcpError(err: unknown): err is TvMcpError {
  // instanceof, not a shape check: a look-alike object from a page or a client must never be
  // trusted as a payload we meant to expose.
  return err instanceof TvMcpError;
}

// Pure on purpose. The message of an unexpected error can carry file paths, selectors or page
// data, so clients only get a generic one and the caller logs the original.
export function toErrorPayload(err: unknown): ErrorPayload {
  if (isTvMcpError(err)) {
    return err.toPayload();
  }
  return { code: 'INTERNAL', message: 'Unexpected error' };
}
