import { Link } from 'wouter';
import type { ToolCall } from '@/api/event-log';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useEventLog } from '@/hooks/use-event-log';
import { formatDuration, formatTime } from '@/lib/format';
import { callOutcome, callStatus, type CallOutcome } from '@/lib/tool-call';
import { cn } from '@/lib/utils';
import { StatusCard } from './status-card';

const SHOWN = 5;

// The words carry the status; the colour only repeats it.
const STATUS_CLASS: Record<CallOutcome, string> = {
  running: 'text-muted-foreground',
  ok: 'text-emerald-700 dark:text-emerald-400',
  error: 'text-destructive',
};

function CallRow({ call }: { call: ToolCall }) {
  return (
    <tr className="border-b last:border-0">
      <td className="py-2 pr-4 tabular-nums">
        <time dateTime={call.startedAt}>{formatTime(call.startedAt)}</time>
      </td>
      <td className="py-2 pr-4 font-mono text-xs">{call.tool}</td>
      <td className="py-2 pr-4">
        <Badge variant="outline">{call.origin}</Badge>
      </td>
      <td className={cn('py-2 pr-4 font-medium', STATUS_CLASS[callOutcome(call)])}>
        {callStatus(call)}
      </td>
      <td className="py-2 tabular-nums">
        {call.durationMs === undefined ? null : formatDuration(call.durationMs)}
      </td>
    </tr>
  );
}

// The last few tool calls of the live log, newest first, whoever made them.
export function RecentActivity() {
  const { calls } = useEventLog();
  // The log keeps the oldest first.
  const recent = calls.slice(-SHOWN).reverse();
  return (
    <StatusCard
      title="Recent activity"
      description="The last five tool calls, newest first."
      action={
        <Button asChild variant="outline" size="sm">
          <Link href="/log">Open the live log</Link>
        </Button>
      }
    >
      {recent.length === 0 ? (
        <p className="text-muted-foreground">No tool calls yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b text-muted-foreground">
                {['Time', 'Tool', 'Origin', 'Status', 'Duration'].map((column) => (
                  <th key={column} scope="col" className="py-2 pr-4 font-medium last:pr-0">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {recent.map((call) => (
                <CallRow key={call.id} call={call} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </StatusCard>
  );
}
