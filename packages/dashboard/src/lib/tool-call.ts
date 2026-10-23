import type { ToolCall } from '@/api/event-log';

// What became of a call: still running, ended unseen as far as the dashboard knows (it ran when the
// stream had a gap), or ended well or badly.
export type CallOutcome = 'running' | 'unseen' | 'ok' | 'error';

export function callOutcome(call: ToolCall): CallOutcome {
  if (call.endedAt === undefined) {
    return call.resultNotSeen === true ? 'unseen' : 'running';
  }
  return call.ok === false || call.errorCode !== undefined ? 'error' : 'ok';
}

// What became of a call, in a word or two: Running, Result not seen, OK, its error code, or Failed
// when the end named no code.
export function callStatus(call: ToolCall): string {
  switch (callOutcome(call)) {
    case 'running':
      return 'Running';
    case 'unseen':
      return 'Result not seen';
    case 'ok':
      return 'OK';
    case 'error':
      return call.errorCode ?? 'Failed';
  }
}

// The colour of a status. The words carry the status; the colour only repeats it.
export const CALL_STATUS_CLASS: Record<CallOutcome, string> = {
  running: 'text-muted-foreground',
  unseen: 'text-amber-800 dark:text-amber-300',
  ok: 'text-emerald-700 dark:text-emerald-400',
  error: 'text-destructive',
};
