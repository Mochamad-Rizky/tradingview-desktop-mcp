import type { DashboardCallResult, JsonValue } from '@contract';
import { useId, useMemo, useState, type ReactNode, type Ref } from 'react';
import { Fact, Facts } from '@/components/status/status-card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { failureText, formatCount, formatDuration } from '@/lib/format';
import { formatJson, JSON_LIMIT } from '@/lib/json-view';
import { resultEnvelope, resultMeta, type ToolError } from '@/lib/tool-result';

// An image type that a data: URL can show in an <img>. The page's CSP allows data: images.
const IMAGE_TYPE = /^image\/[\w.+-]+$/;

// A JSON value, cut at JSON_LIMIT characters until the user asks for all of it. Each text is
// written once per value, not at every render.
function JsonBlock({ value }: { value: JsonValue }) {
  const [all, setAll] = useState(false);
  const shown = useMemo(() => formatJson(value), [value]);
  const full = useMemo(
    () => (all && shown.truncated ? formatJson(value, Infinity).text : null),
    [all, shown.truncated, value],
  );
  return (
    <div className="flex flex-col gap-2">
      <pre className="max-h-[70vh] overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap wrap-anywhere">
        {full ?? shown.text}
      </pre>
      {shown.truncated ? (
        <div className="flex flex-wrap items-center gap-3">
          {all ? null : (
            <p className="text-sm text-muted-foreground">
              Only the first {formatCount(JSON_LIMIT)} characters are shown.
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setAll(!all);
            }}
          >
            {all ? 'Show less' : 'Show all'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ToolFailure({ error }: { error: ToolError }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>
        <code className="font-mono">{error.code}</code>
      </AlertTitle>
      <AlertDescription>
        <p>{error.message}</p>
        {error.hint === undefined ? null : <p>{error.hint}</p>}
      </AlertDescription>
    </Alert>
  );
}

// A heading and what it names, as a region of the result.
function Part({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-2">
      <h4 id={id} className="text-sm font-medium">
        {title}
      </h4>
      {children}
    </section>
  );
}

// What a tool answered: OK or Error, the tier and the time the call took, its warnings, the error
// of a failed call, its images, and its structured content as JSON.
function Answer({ result }: { result: DashboardCallResult }) {
  const warningsId = useId();
  const envelope = resultEnvelope(result);
  const meta = resultMeta(result);
  const failed = result.isError === true || envelope?.ok === false;
  const images = result.content.filter((block) => block.type === 'image');
  const texts = result.content.filter((block) => block.type === 'text');
  const { structuredContent } = result;
  return (
    <>
      <p role="status" className="flex items-center gap-2">
        <Badge variant={failed ? 'destructive' : 'secondary'} className="text-sm">
          {failed ? 'Error' : 'OK'}
        </Badge>
      </p>
      {meta.via === undefined && meta.durationMs === undefined ? null : (
        <Facts>
          {meta.via === undefined ? null : <Fact label="Via">{meta.via}</Fact>}
          {meta.durationMs === undefined ? null : (
            <Fact label="Duration">{formatDuration(meta.durationMs)}</Fact>
          )}
        </Facts>
      )}
      {meta.warnings.length === 0 ? null : (
        <div className="flex flex-col gap-1">
          <h4 id={warningsId} className="text-sm font-medium">
            Warnings
          </h4>
          <ul
            aria-labelledby={warningsId}
            className="list-disc pl-5 text-amber-800 dark:text-amber-300"
          >
            {meta.warnings.map((warning, index) => (
              // Warnings can repeat, and never move.
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
      {envelope?.ok === false ? <ToolFailure error={envelope.error} /> : null}
      {images.map((image, index) =>
        IMAGE_TYPE.test(image.mimeType) ? (
          <img
            // The images of one answer never move.
            key={index}
            src={`data:${image.mimeType};base64,${image.data}`}
            alt="Tool image"
            className="h-auto max-w-full rounded-lg border"
          />
        ) : (
          <p key={index} className="text-sm text-muted-foreground">
            An image of type {image.mimeType} is not shown.
          </p>
        ),
      )}
      {structuredContent === undefined ? (
        texts.map((block, index) => (
          <pre
            key={index}
            className="overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap wrap-anywhere"
          >
            {block.text}
          </pre>
        ))
      ) : (
        <Part title="Structured content">
          <JsonBlock value={structuredContent} />
        </Part>
      )}
    </>
  );
}

interface CallResultProps {
  tool: string;
  pending: boolean;
  result: DashboardCallResult | undefined;
  // The server refused the run, or could not be reached.
  error: unknown;
  ref?: Ref<HTMLElement>;
}

// The outcome of the last manual run of a tool. The region takes the focus when a run starts, so
// that a screen reader follows it; the status line inside announces how it went.
export function CallResult({ tool, pending, result, error, ref }: CallResultProps) {
  const headingId = useId();
  let body: ReactNode;
  if (pending) {
    body = (
      <p role="status" className="text-muted-foreground">
        Running {tool}…
      </p>
    );
  } else if (error !== null && error !== undefined) {
    body = (
      <Alert variant="destructive">
        <AlertDescription>The tool could not be run: {failureText(error)}.</AlertDescription>
      </Alert>
    );
  } else if (result === undefined) {
    body = <p className="text-muted-foreground">Not run yet.</p>;
  } else {
    body = <Answer result={result} />;
  }
  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-3 outline-none"
    >
      <h3 id={headingId} className="font-heading text-base font-medium">
        Result
      </h3>
      {body}
    </section>
  );
}
