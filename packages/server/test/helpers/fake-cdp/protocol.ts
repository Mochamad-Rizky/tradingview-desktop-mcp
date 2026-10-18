// JSON-RPC error codes of the Chrome DevTools protocol.
export const CDP_ERROR = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  serverError: -32000,
} as const;

// Thrown by a handler (or by the evaluator) to answer a call with a protocol error instead of a
// result. Any other error a handler throws becomes a generic server error.
export class FakeCdpError extends Error {
  readonly code: number;
  readonly data: string | undefined;

  constructor(code: number, message: string, data?: string) {
    super(message);
    this.name = 'FakeCdpError';
    this.code = code;
    this.data = data;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
