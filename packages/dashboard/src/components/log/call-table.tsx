import { memo, useMemo } from 'react';
import type { ToolCall } from '@/api/event-log';
import { Badge } from '@/components/ui/badge';
import { matchingCalls, type CallFilter } from '@/lib/call-filter';
import { formatCount, formatDuration, formatTime } from '@/lib/format';
import { CALL_STATUS_CLASS, callOutcome, callStatus } from '@/lib/tool-call';
import { cn } from '@/lib/utils';

// The most rows the table renders: the newest calls that pass the filter. The log keeps up to
// 1000, and rendering them all on every event would slow a busy page down.
export const MAX_ROWS = 200;

const COLUMNS = ['Time', 'Tool', 'Origin', 'Status', 'Duration'];

// Opens the details of `call`; `from` is the button to give the focus back to afterwards.
export type SelectCall = (call: ToolCall, from: HTMLButtonElement | null) => void;

interface CallRowProps {
  call: ToolCall;
  onSelect: SelectCall;
}

// A click anywhere on the row opens the details of its call. The button in it is the way there
// from the keyboard, and what a screen reader lists; its click comes to the row as well. A call
// that did not change keeps its row as it is (memo): the log replaces a call it changes.
const CallRow = memo(function CallRow({ call, onSelect }: CallRowProps) {
  const time = formatTime(call.startedAt);
  return (
    <tr
      className="cursor-pointer border-b transition-colors last:border-0 focus-within:bg-muted/50 hover:bg-muted/50"
      onClick={(event) => {
        onSelect(call, event.currentTarget.querySelector('button'));
      }}
    >
      <td className="px-3 py-2 tabular-nums">
        <time dateTime={call.startedAt}>{time}</time>
      </td>
      <td className="px-3 py-2">
        <button
          type="button"
          aria-label={`Details of ${call.tool} at ${time}`}
          className="rounded-sm text-left font-mono text-xs outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {call.tool}
        </button>
      </td>
      <td className="px-3 py-2">
        <Badge variant="outline">{call.origin}</Badge>
      </td>
      <td className={cn('px-3 py-2 font-medium', CALL_STATUS_CLASS[callOutcome(call)])}>
        {callStatus(call)}
      </td>
      <td className="px-3 py-2 tabular-nums">
        {call.durationMs === undefined ? null : formatDuration(call.durationMs)}
      </td>
    </tr>
  );
});

interface CallTableProps {
  // Oldest first, as the log keeps them.
  calls: readonly ToolCall[];
  filter: CallFilter;
  onSelect: SelectCall;
}

// The calls that pass the filter, newest first, MAX_ROWS of them at most. While the log is paused
// its calls stay the same array, so the table (memo) renders nothing again.
export const CallTable = memo(function CallTable({ calls, filter, onSelect }: CallTableProps) {
  const { rows, total } = useMemo(() => matchingCalls(calls, filter, MAX_ROWS), [calls, filter]);
  if (calls.length === 0) {
    return <p className="text-muted-foreground">No tool calls yet.</p>;
  }
  if (total === 0) {
    return <p className="text-muted-foreground">No calls match the filters.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {total > rows.length ? (
        <p className="text-sm text-muted-foreground">
          {`Showing ${formatCount(rows.length)} of ${formatCount(total)}`}
        </p>
      ) : null}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Tool calls, newest first</caption>
          <thead>
            <tr className="border-b bg-muted/50 text-muted-foreground">
              {COLUMNS.map((column) => (
                <th key={column} scope="col" className="px-3 py-2 font-medium">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((call) => (
              <CallRow key={call.id} call={call} onSelect={onSelect} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
});
