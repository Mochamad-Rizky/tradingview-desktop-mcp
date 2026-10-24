import type { DashboardTool } from '@contract';
import { useId, useRef, useState, type Ref } from 'react';
import { Fact, Facts } from '@/components/status/status-card';
import { Badge } from '@/components/ui/badge';
import { useCallTool } from '@/hooks/use-call-tool';
import { ArgsEditor, type ToolArgs } from './args-editor';
import { CallResult } from './call-result';
import { RunConfirm } from './run-confirm';
import { SchemaFields } from './schema-fields';
import { toolEffect } from './tool-list';

function yesNo(value: boolean): string {
  return value ? 'Yes' : 'No';
}

interface ToolDetailProps {
  tool: DashboardTool;
  // The heading, which the page focuses when the user opens the tool from the list.
  headingRef?: Ref<HTMLHeadingElement>;
}

// One tool: what it does, what it takes, and a run by hand. The run goes to the server like any
// other call (POST /api/tools/<name>), whose checks decide what happens, and shows in the live log
// as a dashboard call. A tool that is not read-only asks first.
export function ToolDetail({ tool, headingRef }: ToolDetailProps) {
  const headingId = useId();
  const runId = useId();
  const call = useCallTool();
  const [confirming, setConfirming] = useState<ToolArgs | null>(null);
  // From the click that starts a run until the run ends. React Query reports a run as pending a
  // moment after it starts, so a second click in between finds Run still enabled: this keeps it
  // from sending the call again.
  const inFlight = useRef(false);
  // Whether the dialog closed because its Run was clicked, rather than cancelled.
  const confirmed = useRef(false);
  const resultRef = useRef<HTMLElement>(null);
  const runRef = useRef<HTMLButtonElement>(null);
  const effect = toolEffect(tool);
  const paragraphs = tool.description
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  // Starts the call, unless one is on its way; says whether it started.
  const start = (args: ToolArgs): boolean => {
    if (inFlight.current) {
      return false;
    }
    inFlight.current = true;
    call.mutate(
      { name: tool.name, arguments: args },
      {
        onSettled: () => {
          inFlight.current = false;
        },
      },
    );
    return true;
  };

  const run = (args: ToolArgs) => {
    if (inFlight.current) {
      return;
    }
    if (!tool.annotations.readOnlyHint) {
      setConfirming(args);
    } else if (start(args)) {
      resultRef.current?.focus();
    }
  };

  return (
    <article aria-labelledby={headingId} className="flex min-w-0 flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h2
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className="font-heading text-xl font-semibold tracking-tight outline-none"
        >
          {tool.title}
        </h2>
        <p className="flex flex-wrap items-center gap-1.5">
          <code className="font-mono text-sm break-all">{tool.name}</code>
          {effect === 'read-only' ? <Badge variant="secondary">read-only</Badge> : null}
          {effect === 'destructive' ? <Badge variant="destructive">destructive</Badge> : null}
          {tool.core ? <Badge variant="outline">core</Badge> : null}
        </p>
      </header>
      <div className="flex flex-col gap-3">
        {paragraphs.map((paragraph, index) => (
          <p key={index} className="whitespace-pre-line">
            {paragraph}
          </p>
        ))}
      </div>
      <Facts>
        <Fact label="Domain">{tool.domain}</Fact>
        <Fact label="Read-only">{yesNo(tool.annotations.readOnlyHint)}</Fact>
        <Fact label="Destructive">{yesNo(tool.annotations.destructiveHint)}</Fact>
        <Fact label="Idempotent">{yesNo(tool.annotations.idempotentHint)}</Fact>
        <Fact label="Open world">{yesNo(tool.annotations.openWorldHint)}</Fact>
        <Fact label="Profiles">{tool.profiles.join(', ')}</Fact>
      </Facts>
      <SchemaFields schema={tool.inputSchema} />
      <section aria-labelledby={runId} className="flex min-w-0 flex-col gap-3">
        <h3 id={runId} className="font-heading text-base font-medium">
          Run by hand
        </h3>
        <p className="text-sm text-muted-foreground">
          The server runs the call as it runs any other, with the same checks, and the live log
          shows it. A tool that is not read-only asks first.
        </p>
        <ArgsEditor running={call.isPending} onRun={run} runRef={runRef} />
      </section>
      <CallResult
        ref={resultRef}
        tool={tool.name}
        pending={call.isPending}
        result={call.data}
        error={call.error}
      />
      <RunConfirm
        tool={tool}
        args={confirming}
        running={call.isPending}
        onCancel={() => {
          setConfirming(null);
        }}
        onConfirm={(args) => {
          // A second click before the dialog closes starts nothing, and must not undo the first.
          confirmed.current ||= start(args);
          setConfirming(null);
        }}
        onCloseAutoFocus={() => {
          // After a confirmed run the focus follows the run; after Cancel it goes back to Run.
          const target = confirmed.current ? resultRef.current : runRef.current;
          confirmed.current = false;
          target?.focus();
        }}
      />
    </article>
  );
}
