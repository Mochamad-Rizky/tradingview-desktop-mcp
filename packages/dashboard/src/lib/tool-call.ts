import type { ToolCall } from '@/api/event-log';

export type CallOutcome = 'running' | 'ok' | 'error';

export function callOutcome(call: ToolCall): CallOutcome {
  if (call.endedAt === undefined) {
    return 'running';
  }
  return call.ok === false || call.errorCode !== undefined ? 'error' : 'ok';
}

// What became of a call, in a word: Running, OK, its error code, or Failed when the end named no
// code.
export function callStatus(call: ToolCall): string {
  switch (callOutcome(call)) {
    case 'running':
      return 'Running';
    case 'ok':
      return 'OK';
    case 'error':
      return call.errorCode ?? 'Failed';
  }
}
