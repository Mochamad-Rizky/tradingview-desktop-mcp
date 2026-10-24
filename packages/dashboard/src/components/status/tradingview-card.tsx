import type { DashboardHealth } from '@contract';
import { CircleXIcon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useHealth } from '@/hooks/use-health';
import { failureText, formatCount, formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Fact, Facts, Loading, StatusCard } from './status-card';

// What stands between the user and a working TradingView, when something does.
function HealthNotice({ health }: { health: DashboardHealth }) {
  const { cdp, chart } = health;
  if (!cdp.reachable) {
    return (
      <Alert variant="destructive">
        <CircleXIcon aria-hidden />
        <AlertDescription>
          <p>
            TradingView is not reachable on {cdp.endpoint}.{' '}
            {cdp.otherBrowser === true ? (
              <>
                Another browser answers there
                {cdp.browser === undefined ? '' : ` (${cdp.browser})`}: quit it, or set{' '}
                <code className="font-mono">TV_CDP_PORT</code> to a free port and start this server
                again.
              </>
            ) : (
              <>
                Start it with <code className="font-mono">tradingview-desktop-mcp launch</code>.
              </>
            )}
          </p>
        </AlertDescription>
      </Alert>
    );
  }
  if (chart.inBackground === true) {
    return (
      <Alert>
        <TriangleAlertIcon aria-hidden />
        <AlertDescription>A chart is open but not in front.</AlertDescription>
      </Alert>
    );
  }
  // TradingView answers, but shows something else than a chart, such as its New tab page.
  if (!chart.found) {
    return (
      <Alert>
        <TriangleAlertIcon aria-hidden />
        <AlertDescription>
          TradingView is reachable, but no chart is open. Open a chart tab in TradingView.
        </AlertDescription>
      </Alert>
    );
  }
  return null;
}

function HealthFacts({ health }: { health: DashboardHealth }) {
  const { cdp, chart, app } = health;
  const buildTime = app.buildTime ?? null;
  return (
    <Facts>
      <Fact label="Debug port">
        {cdp.reachable ? 'Reachable' : 'Not reachable'} on{' '}
        <code className="font-mono">{cdp.endpoint}</code>
      </Fact>
      <Fact label="Chart">{chart.found ? 'Found' : 'Not found'}</Fact>
      <Fact label="Chart tabs">{formatCount(chart.tabs)}</Fact>
      <Fact label="In background">{chart.inBackground === true ? 'Yes' : 'No'}</Fact>
      <Fact label="App">{app.ready ? 'Ready' : 'Not ready'}</Fact>
      <Fact label="Build time">{buildTime === null ? 'Unknown' : formatDateTime(buildTime)}</Fact>
    </Facts>
  );
}

// Whether TradingView answers on its debug port and shows a chart (GET /api/health), checked every
// five seconds, and at once with Check now.
export function TradingViewCard() {
  const { data, error, isError, isFetching, refetch } = useHealth();

  const checkNow = () => {
    // A check already running is joined, never cancelled for another (refetch's default).
    void refetch({ cancelRefetch: false });
  };

  let body: ReactNode;
  if (data === undefined) {
    body = isError ? (
      <Alert variant="destructive">
        <AlertDescription>The health check failed: {failureText(error)}.</AlertDescription>
      </Alert>
    ) : (
      <Loading label="Checking TradingView…" />
    );
  } else {
    body = (
      <>
        {isError ? (
          <Alert variant="destructive">
            <AlertDescription>
              The last check failed: {failureText(error)}. The facts below are from the check
              before.
            </AlertDescription>
          </Alert>
        ) : null}
        <HealthNotice health={data} />
        <HealthFacts health={data} />
      </>
    );
  }

  return (
    <StatusCard
      title="TradingView"
      description="Checked every five seconds."
      action={
        <Button variant="outline" size="sm" onClick={checkNow}>
          <RefreshCwIcon aria-hidden className={cn(isFetching && 'motion-safe:animate-spin')} />
          Check now
        </Button>
      }
    >
      {body}
    </StatusCard>
  );
}
