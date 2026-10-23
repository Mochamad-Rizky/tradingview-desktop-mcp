import type { DashboardTool } from '@contract';
import { useId } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ToolArgs } from './args-editor';

interface RunConfirmProps {
  tool: DashboardTool;
  // The arguments to confirm; null keeps the dialog closed.
  args: ToolArgs | null;
  running: boolean;
  onCancel: () => void;
  onConfirm: (args: ToolArgs) => void;
  // Puts the focus somewhere once the dialog has closed. The dialog has no trigger of its own to
  // give it back to.
  onCloseAutoFocus: () => void;
}

// Asks before a tool that is not read-only acts on TradingView, with the arguments it will get.
// It guards the dashboard only: the tool's own confirm argument and the server's checks apply all
// the same, so nothing is added to the arguments.
export function RunConfirm({
  tool,
  args,
  running,
  onCancel,
  onConfirm,
  onCloseAutoFocus,
}: RunConfirmProps) {
  const argumentsId = useId();
  const destructive = tool.annotations.destructiveHint;
  return (
    <Dialog
      open={args !== null}
      onOpenChange={(open) => {
        if (!open) {
          onCancel();
        }
      }}
    >
      {args === null ? null : (
        <DialogContent
          role="alertdialog"
          showCloseButton={false}
          className="sm:max-w-lg"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            onCloseAutoFocus();
          }}
        >
          <DialogHeader>
            <DialogTitle className="break-all">Run {tool.name}?</DialogTitle>
            <DialogDescription asChild>
              <div className="flex flex-col gap-1">
                <p>It acts on your TradingView.</p>
                {destructive ? (
                  <p className="font-medium text-destructive">It can remove or replace data.</p>
                ) : null}
              </div>
            </DialogDescription>
          </DialogHeader>
          <section aria-labelledby={argumentsId} className="flex min-w-0 flex-col gap-1.5">
            <h3 id={argumentsId} className="font-medium">
              Arguments
            </h3>
            <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap wrap-anywhere">
              {JSON.stringify(args, null, 2)}
            </pre>
          </section>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant={destructive ? 'destructive' : 'default'}
              disabled={running}
              onClick={() => {
                onConfirm(args);
              }}
            >
              Run
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
