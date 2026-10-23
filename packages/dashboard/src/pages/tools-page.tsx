import type { DashboardTool } from '@contract';
import { ArrowLeftIcon } from 'lucide-react';
import { useEffect, useId, useRef, type Ref } from 'react';
import { Link, useParams } from 'wouter';
import { Loading } from '@/components/status/status-card';
import { ToolDetail } from '@/components/tools/tool-detail';
import { ToolList } from '@/components/tools/tool-list';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useTools } from '@/hooks/use-tools';
import { failureText } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PageHeader } from './page-header';

// On a narrow screen the list and a tool take turns: this goes back to the list.
function BackToList() {
  return (
    <Button asChild variant="ghost" size="sm" className="self-start md:hidden">
      <Link href="/tools">
        <ArrowLeftIcon aria-hidden />
        All tools
      </Link>
    </Button>
  );
}

// A link to a tool that this server does not offer: its profile or tool filter leaves it out, or
// there is no tool of that name.
function NotOffered({ name, headingRef }: { name: string; headingRef: Ref<HTMLHeadingElement> }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col items-start gap-3">
      <h2
        id={headingId}
        ref={headingRef}
        tabIndex={-1}
        className="font-heading text-xl font-semibold tracking-tight outline-none"
      >
        Tool not offered
      </h2>
      <p>
        <code className="font-mono break-all">{name}</code> is not offered by this server&apos;s
        profile.
      </p>
      <p className="text-muted-foreground">
        The profile and the tool filter the server runs with decide which tools it offers. The
        status page names both.
      </p>
      <Button asChild variant="outline">
        <Link href="/tools">Show all tools</Link>
      </Button>
    </section>
  );
}

function Tools({ tools, name }: { tools: DashboardTool[]; name: string | undefined }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Opening a tool from the list, or going to another one, puts the focus on its heading, so that
  // a keyboard lands on the tool it picked. Not on the first render: a link to a tool starts at the
  // top of the document, and a move from another page focuses the page heading (the app shell).
  const shown = useRef(name);
  useEffect(() => {
    if (shown.current === name) {
      return;
    }
    shown.current = name;
    if (name !== undefined) {
      headingRef.current?.focus();
    }
  }, [name]);

  const tool = name === undefined ? undefined : tools.find((each) => each.name === name);
  let detail;
  if (name === undefined) {
    detail = (
      <p className="hidden rounded-lg border border-dashed p-6 text-muted-foreground md:block">
        Choose a tool from the list to read about it and run it.
      </p>
    );
  } else if (tool === undefined) {
    detail = <NotOffered name={name} headingRef={headingRef} />;
  } else {
    // A tool of its own each time, so that no arguments or result carry over to another.
    detail = <ToolDetail key={tool.name} tool={tool} headingRef={headingRef} />;
  }

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] md:items-start">
      <ToolList
        tools={tools}
        selected={name}
        className={cn(
          'md:sticky md:top-4 md:max-h-[calc(100svh-2rem)] md:overflow-y-auto md:pr-1',
          name !== undefined && 'hidden md:flex',
        )}
      />
      <div className="flex min-w-0 flex-col gap-4">
        {name === undefined ? null : <BackToList />}
        {detail}
      </div>
    </div>
  );
}

// The tools the server offers, to read and to run by hand: the list, and the tool of the address
// (/tools/<name>) beside it.
export function ToolsPage() {
  const { name } = useParams<{ name?: string }>();
  const { data: tools, error, isPending } = useTools();

  let body;
  if (isPending) {
    body = <Loading label="Reading the tools…" />;
  } else if (tools === undefined) {
    body = (
      <Alert variant="destructive">
        <AlertDescription>The tools could not be read: {failureText(error)}.</AlertDescription>
      </Alert>
    );
  } else {
    body = <Tools tools={tools} name={name} />;
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Tools"
        description="The tools of the running profile, to read and to run."
      />
      {body}
    </div>
  );
}
