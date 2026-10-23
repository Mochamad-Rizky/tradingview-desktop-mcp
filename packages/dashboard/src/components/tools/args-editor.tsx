import type { JsonValue } from '@contract';
import { PlayIcon } from 'lucide-react';
import { useId, useMemo, useState, type Ref } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { isJsonObject } from '@/lib/tool-result';

export type ToolArgs = Record<string, JsonValue>;

export type ParsedArgs = { ok: true; args: ToolArgs } | { ok: false; message: string };

// The arguments `text` holds, or why it holds none: a tool takes a JSON object.
export function parseArgs(text: string): ParsedArgs {
  let value: JsonValue;
  try {
    value = JSON.parse(text) as JsonValue;
  } catch (error) {
    return { ok: false, message: `Not valid JSON: ${(error as Error).message}` };
  }
  return isJsonObject(value)
    ? { ok: true, args: value }
    : { ok: false, message: 'The arguments must be a JSON object, such as {}.' };
}

interface ArgsEditorProps {
  // A run is in progress: Run waits for it.
  running: boolean;
  onRun: (args: ToolArgs) => void;
  // The Run button, where the focus goes back to when a confirmation is cancelled.
  runRef?: Ref<HTMLButtonElement>;
}

// The arguments of a manual run, as JSON, and the button that runs the tool with them. The text is
// read at each change, and Run waits until it holds an object.
export function ArgsEditor({ running, onRun, runRef }: ArgsEditorProps) {
  const editorId = useId();
  const problemId = useId();
  const [text, setText] = useState('{}');
  const parsed = useMemo(() => parseArgs(text), [text]);
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={editorId}>Arguments (JSON)</Label>
      <Textarea
        id={editorId}
        value={text}
        rows={6}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        aria-invalid={parsed.ok ? undefined : true}
        aria-describedby={parsed.ok ? undefined : problemId}
        className="max-h-[50vh] font-mono text-xs md:text-xs"
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
      {parsed.ok ? null : (
        <p id={problemId} className="text-sm text-destructive">
          {parsed.message}
        </p>
      )}
      <div>
        <Button
          ref={runRef}
          disabled={!parsed.ok || running}
          onClick={() => {
            if (parsed.ok) {
              onRun(parsed.args);
            }
          }}
        >
          <PlayIcon aria-hidden />
          Run
        </Button>
      </div>
    </div>
  );
}
