import type { DashboardCallResult, JsonValue } from '@contract';

// The error of a tool call that failed, as the result envelope states it.
export interface ToolError {
  code: string;
  message: string;
  hint?: string;
}

// The envelope every tool result carries in structuredContent: the data of a call that succeeded,
// or the error of one that failed.
export type ResultEnvelope = { ok: true; data: JsonValue } | { ok: false; error: ToolError };

export function isJsonObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The envelope of `result`, or null when it holds none that this dashboard can read.
export function resultEnvelope(result: DashboardCallResult): ResultEnvelope | null {
  const envelope = result.structuredContent;
  if (envelope?.ok === true && envelope.data !== undefined) {
    return { ok: true, data: envelope.data };
  }
  const error = envelope?.error;
  if (
    envelope?.ok === false &&
    isJsonObject(error) &&
    typeof error.code === 'string' &&
    typeof error.message === 'string'
  ) {
    const { code, message, hint } = error;
    return { ok: false, error: { code, message, ...(typeof hint === 'string' ? { hint } : {}) } };
  }
  return null;
}
