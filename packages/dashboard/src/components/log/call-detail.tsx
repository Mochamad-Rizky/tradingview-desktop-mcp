import type { JsonValue } from '@contract';
import { CopyIcon } from 'lucide-react';
import { useId, useState, type ReactNode, type RefObject } from 'react';
import type { ToolCall } from '@/api/event-log';
import { Fact, Facts } from '@/components/status/status-card';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { formatDuration, formatFullTime, formatTime } from '@/lib/format';
import { CALL_STATUS_CLASS, callOutcome, callStatus } from '@/lib/tool-call';
import { isJsonObject } from '@/lib/tool-result';
import { cn } from '@/lib/utils';

const HIDDEN = 'redacted (hidden by the server)';

// What stands in an event for an argument the server keeps out of it (see the server's
// src/tools/redaction.ts). The dashboard shows what the event holds, and nothing more.
function isRedacted(value: JsonValue): boolean {
  return isJsonObject(value) && value.redacted === true && Object.keys(value).length === 1;
}

// `value` as JSON.stringify(value, null, 2) writes it, except that a value the server kept out
// says so instead of showing the object that stands in for it.
function jsonView(value: JsonValue): ReactNode[] {
  const parts: ReactNode[] = [];
  // Text goes on the text before it, so that the view is one text node between two values kept out.
  const text = (more: string) => {
    const last = parts.at(-1);
    if (typeof last === 'string') {
      parts[parts.length - 1] = last + more;
    } else {
      parts.push(more);
    }
  };
  const write = (item: JsonValue, indent: string): void => {
    if (isRedacted(item)) {
      parts.push(
        <span key={parts.length} className="text-muted-foreground italic">
          {HIDDEN}
        </span>,
      );
      return;
    }
    // A list as entries without keys, so that both are written alike.
    let entries: [string | null, JsonValue][];
    let open = '{';
    let close = '}';
    if (Array.isArray(item)) {
      entries = item.map((each): [null, JsonValue] => [null, each]);
      open = '[';
      close = ']';
    } else if (isJsonObject(item)) {
      entries = Object.entries(item);
    } else {
      text(JSON.stringify(item));
      return;
    }
    if (entries.length === 0) {
      text(`${open}${close}`);
      return;
    }
    const inner = `${indent}  `;
    text(`${open}\n`);
    entries.forEach(([key, each], index) => {
      text(key === null ? inner : `${inner}${JSON.stringify(key)}: `);
      write(each, inner);
      text(index < entries.length - 1 ? ',\n' : '\n');
    });
    text(`${indent}${close}`);
  };
  write(value, '');
  return parts;
}

// Copies text to the clipboard, and says how that went in a live region.
function useCopy(): [string, (text: string, done: string) => void] {
  const [message, setMessage] = useState('');
  const copy = (text: string, done: string) => {
    // The clipboard is missing where the page is not a secure context: that fails here too.
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(text))
      .then(
        () => {
          setMessage(done);
        },
        () => {
          setMessage('Could not copy: the browser refused.');
        },
      );
  };
  return [message, copy];
}

function Status({ call }: { call: ToolCall }) {
  const outcome = callOutcome(call);
  return (
    <span className={cn('font-medium', CALL_STATUS_CLASS[outcome])}>
      {outcome === 'error' && call.errorCode !== undefined ? (
        <>
          Error: <code className="font-mono">{call.errorCode}</code>
        </>
      ) : (
        callStatus(call)
      )}
    </span>
  );
}

function Details({ call }: { call: ToolCall }) {
  const [copied, copy] = useCopy();
  const argumentsId = useId();
  const { args } = call;
  const unseen = callOutcome(call) === 'unseen';
  // What stands for the end and the duration of a call that has not ended, as far as is known.
  const pending = unseen ? 'Not seen' : 'Not yet';
  let duration = pending;
  if (call.durationMs !== undefined) {
    duration = formatDuration(call.durationMs);
  } else if (call.endedAt !== undefined) {
    duration = 'Unknown';
  }
  return (
    <>
      <SheetHeader className="pr-12">
        <SheetTitle className="font-mono break-all">{call.tool}</SheetTitle>
        <SheetDescription>
          A call from {call.origin}, started at {formatTime(call.startedAt)}.
        </SheetDescription>
      </SheetHeader>
      <div className="flex flex-col gap-6 overflow-y-auto px-4">
        <Facts>
          <Fact label="Tool">
            <span className="inline-flex items-center gap-1">
              <code className="font-mono break-all">{call.tool}</code>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Copy tool name"
                title="Copy tool name"
                onClick={() => {
                  copy(call.tool, 'Tool name copied.');
                }}
              >
                <CopyIcon aria-hidden />
              </Button>
            </span>
          </Fact>
          <Fact label="Origin">{call.origin}</Fact>
          <Fact label="Started">
            <time dateTime={call.startedAt}>{formatFullTime(call.startedAt)}</time>
          </Fact>
          <Fact label="Ended">
            {call.endedAt === undefined ? (
              pending
            ) : (
              <time dateTime={call.endedAt}>{formatFullTime(call.endedAt)}</time>
            )}
          </Fact>
          <Fact label="Duration">{duration}</Fact>
          <Fact label="Status">
            <Status call={call} />
          </Fact>
        </Facts>
        {unseen ? (
          <p className="text-amber-800 dark:text-amber-300">
            The stream had a gap while this call ran, so its end may have been lost. If it comes
            after all, it shows here.
          </p>
        ) : null}
        <section aria-labelledby={argumentsId} className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h3 id={argumentsId} className="font-medium">
              Arguments
            </h3>
            <Button
              variant="outline"
              size="xs"
              disabled={args === undefined}
              onClick={() => {
                copy(JSON.stringify(args, null, 2), 'Arguments copied.');
              }}
            >
              <CopyIcon aria-hidden />
              Copy arguments
            </Button>
          </div>
          {args === undefined ? (
            <p className="text-muted-foreground">
              Not known: the stream never sent the start of this call.
            </p>
          ) : (
            <pre className="max-h-[60vh] overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap wrap-anywhere">
              {jsonView(args)}
            </pre>
          )}
        </section>
      </div>
      <SheetFooter>
        <p role="status" className="min-h-5 text-sm text-muted-foreground">
          {copied}
        </p>
      </SheetFooter>
    </>
  );
}

interface CallDetailProps {
  // The call to show, which the sheet follows as the log changes it; null for none.
  call: ToolCall | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Where the focus goes back to once the sheet closes: the row that opened it. The sheet has no
  // trigger of its own to return to.
  returnFocusTo?: RefObject<HTMLElement | null>;
}

// The details of one call, in a sheet at the side: when and how it ran, and its arguments as the
// server sent them.
export function CallDetail({ call, open, onOpenChange, returnFocusTo }: CallDetailProps) {
  return (
    <Sheet open={open && call !== null} onOpenChange={onOpenChange}>
      {call === null ? null : (
        <SheetContent
          className="data-[side=right]:w-11/12 data-[side=right]:sm:max-w-xl"
          onCloseAutoFocus={(event) => {
            const target = returnFocusTo?.current;
            if (target?.isConnected === true) {
              event.preventDefault();
              target.focus();
            }
          }}
        >
          {/* A sheet of its own for each call, so that what was copied from another is not said. */}
          <Details key={call.id} call={call} />
        </SheetContent>
      )}
    </Sheet>
  );
}
