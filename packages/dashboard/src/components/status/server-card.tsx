import type { DashboardInfo } from '@contract';
import type { ReactNode } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useInfo } from '@/hooks/use-info';
import { failureText, formatCount } from '@/lib/format';
import { Fact, Facts, Loading, StatusCard } from './status-card';

function ServerFacts({ info }: { info: DashboardInfo }) {
  return (
    <Facts>
      <Fact label="Version">{info.version}</Fact>
      <Fact label="Transport">{info.transport === 'http' ? 'HTTP' : 'stdio'}</Fact>
      <Fact label="Profile">{info.profile}</Fact>
      {info.toolPatterns.length === 0 ? null : (
        <Fact label="Tool filter">
          <code className="font-mono">{info.toolPatterns.join(', ')}</code>
        </Fact>
      )}
      <Fact label="Tools">{formatCount(info.toolCount)}</Fact>
      <Fact label="MCP endpoint">
        {info.mcpEndpoint === null ? (
          'stdio'
        ) : (
          <code className="font-mono">{info.mcpEndpoint}</code>
        )}
      </Fact>
      <Fact label="ui_evaluate">{info.allowEval ? 'Allowed' : 'Not allowed'}</Fact>
    </Facts>
  );
}

// The running server and its settings (GET /api/info).
export function ServerCard() {
  const { data, error, isPending } = useInfo();
  let body: ReactNode;
  if (data !== undefined) {
    body = <ServerFacts info={data} />;
  } else if (isPending) {
    body = <Loading label="Reading the server facts…" />;
  } else {
    body = (
      <Alert variant="destructive">
        <AlertDescription>
          The server facts could not be read: {failureText(error)}.
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <StatusCard title="Server" description="How this server runs.">
      {body}
    </StatusCard>
  );
}
