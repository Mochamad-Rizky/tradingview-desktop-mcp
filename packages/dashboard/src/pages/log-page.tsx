import { PauseIcon, PlayIcon, Trash2Icon, TriangleAlertIcon } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import type { StreamStatus, ToolCall } from '@/api/event-log';
import { CallDetail } from '@/components/log/call-detail';
import { CallFilters, useCallFilter } from '@/components/log/call-filters';
import { CallTable, type SelectCall } from '@/components/log/call-table';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useEventLog } from '@/hooks/use-event-log';
import { formatCount } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PageHeader } from './page-header';

const STREAM: Record<StreamStatus, { label: string; className: string }> = {
  live: { label: 'Live', className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' },
  reconnecting: {
    label: 'Reconnecting…',
    className: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
  },
  connecting: { label: 'Connecting…', className: 'bg-secondary text-secondary-foreground' },
};

// Whether the calls come in as they happen. The word carries the state; the dot only repeats it.
// A live region, so that a screen reader says when the stream drops and comes back.
function StreamIndicator({ status }: { status: StreamStatus }) {
  const { label, className } = STREAM[status];
  return (
    <Badge role="status" aria-label="Event stream" data-state={status} className={className}>
      <span
        aria-hidden
        className={cn(
          'size-2 rounded-full bg-current',
          status === 'live' && 'motion-safe:animate-pulse',
        )}
      />
      {label}
    </Badge>
  );
}

// Every tool call the server runs, whoever asked for it, as it happens: a table to filter, pause
// and clear, and the details of a call in a sheet.
export function LogPage() {
  const { calls, status, missed, paused, buffered, pause, resume, clear } = useEventLog();
  const [filter, changeFilter] = useCallFilter();
  const [selected, setSelected] = useState<ToolCall | null>(null);
  const [open, setOpen] = useState(false);
  const openedFrom = useRef<HTMLElement | null>(null);
  const select = useCallback<SelectCall>((call, from) => {
    openedFrom.current = from;
    setSelected(call);
    setOpen(true);
  }, []);
  // The details follow their call as the log changes it. A call the log let go of meanwhile keeps
  // what was last shown of it. Only looked up while the details are open.
  const shown =
    open && selected !== null
      ? (calls.find((call) => call.id === selected.id) ?? selected)
      : selected;

  let pauseLabel = 'Pause';
  if (paused) {
    pauseLabel = buffered > 0 ? `Resume (${formatCount(buffered)} new)` : 'Resume';
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Live log" description="Every tool call, live, as the server runs it." />
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <StreamIndicator status={status} />
          <div className="ml-auto flex items-center gap-2">
            {/* One button that changes its word, so that the focus stays on it. */}
            <Button variant="outline" onClick={paused ? resume : pause}>
              {paused ? <PlayIcon aria-hidden /> : <PauseIcon aria-hidden />}
              {pauseLabel}
            </Button>
            <Button variant="outline" onClick={clear}>
              <Trash2Icon aria-hidden />
              Clear
            </Button>
          </div>
        </div>
        {missed ? (
          <Alert role="status">
            <TriangleAlertIcon aria-hidden className="text-amber-700 dark:text-amber-400" />
            <AlertTitle>Some calls were missed while disconnected.</AlertTitle>
          </Alert>
        ) : null}
        <CallFilters filter={filter} onChange={changeFilter} />
      </div>
      <CallTable calls={calls} filter={filter} onSelect={select} />
      <CallDetail call={shown} open={open} onOpenChange={setOpen} returnFocusTo={openedFrom} />
    </div>
  );
}
