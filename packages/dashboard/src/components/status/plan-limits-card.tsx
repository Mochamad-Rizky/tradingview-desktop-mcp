import type { DashboardCallResult, JsonValue } from '@contract';
import type { ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useCallTool } from '@/hooks/use-call-tool';
import { useTools } from '@/hooks/use-tools';
import { failureText, formatCount } from '@/lib/format';
import { isJsonObject, resultEnvelope, type ToolError } from '@/lib/tool-result';
import { Loading, StatusCard } from './status-card';

const PLAN_LIMITS_TOOL = 'app_get_plan_limits';

// How TradingView writes a feature without a limit.
const UNLIMITED = 99999;

type Limit = [feature: string, value: number | null];

// The limits in the data of app_get_plan_limits ({ limits: { FEATURE: number | null } }), in the
// order the tool lists them; null when the data holds none.
function limitsOf(data: JsonValue): Limit[] | null {
  const limits = isJsonObject(data) ? data.limits : undefined;
  if (!isJsonObject(limits)) {
    return null;
  }
  const rows = Object.entries(limits).filter(
    (row): row is Limit => row[1] === null || typeof row[1] === 'number',
  );
  return rows.length === 0 ? null : rows;
}

function formatLimit(value: number | null): string {
  if (value === null) {
    // The app does not report a limit for it.
    return 'Unknown';
  }
  return value === UNLIMITED ? 'Unlimited' : formatCount(value);
}

function LimitsTable({ limits }: { limits: Limit[] }) {
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b text-muted-foreground">
          <th scope="col" className="py-2 pr-4 font-medium">
            Feature
          </th>
          <th scope="col" className="py-2 font-medium">
            Limit
          </th>
        </tr>
      </thead>
      <tbody>
        {limits.map(([feature, value]) => (
          <tr key={feature} className="border-b last:border-0">
            <td className="py-2 pr-4 font-mono text-xs">{feature}</td>
            <td className="py-2 tabular-nums">{formatLimit(value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
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

// What the answer of app_get_plan_limits says: the limits, the error of a failed call, or that the
// answer held no limits.
function PlanLimitsAnswer({ result }: { result: DashboardCallResult }) {
  const envelope = resultEnvelope(result);
  if (envelope?.ok === false) {
    return <ToolFailure error={envelope.error} />;
  }
  const limits = envelope === null ? null : limitsOf(envelope.data);
  return limits === null ? (
    <p className="text-muted-foreground">The answer held no plan limits.</p>
  ) : (
    <LimitsTable limits={limits} />
  );
}

function PlanLimits() {
  const call = useCallTool();

  let body: ReactNode;
  if (call.isPending) {
    body = <Loading label="Reading the plan limits…" />;
  } else if (call.isError) {
    body = (
      <Alert variant="destructive">
        <AlertDescription>
          The plan limits could not be read: {failureText(call.error)}.
        </AlertDescription>
      </Alert>
    );
  } else if (call.isSuccess) {
    body = <PlanLimitsAnswer result={call.data} />;
  } else {
    body = <p className="text-muted-foreground">Not read yet.</p>;
  }

  return (
    <StatusCard
      title="Plan limits"
      description="What the TradingView plan of the signed-in account allows, read when you ask. The call shows in the log."
      action={
        <Button
          variant="outline"
          size="sm"
          disabled={call.isPending}
          onClick={() => {
            call.mutate({ name: PLAN_LIMITS_TOOL });
          }}
        >
          Read plan limits
        </Button>
      }
    >
      {body}
    </StatusCard>
  );
}

// The plan limits, read on demand with app_get_plan_limits through the registry, like any tool
// call. Only shown when the running profile offers that tool.
export function PlanLimitsCard() {
  const { data: tools } = useTools();
  const offered = tools?.some((tool) => tool.name === PLAN_LIMITS_TOOL) === true;
  return offered ? <PlanLimits /> : null;
}
