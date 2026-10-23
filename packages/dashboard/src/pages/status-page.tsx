import { PlanLimitsCard } from '@/components/status/plan-limits-card';
import { RecentActivity } from '@/components/status/recent-activity';
import { ServerCard } from '@/components/status/server-card';
import { TradingViewCard } from '@/components/status/tradingview-card';
import { PageHeader } from './page-header';

// TradingView comes first: whether it is up decides whether anything else works. On a wide screen
// the cards stand in two columns, each a stack, so that a tall card leaves no gap beside it; the
// recent calls take the whole width below, as their table needs it.
export function StatusPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Status"
        description="Whether TradingView is reachable, and how this server runs."
      />
      <div className="grid items-start gap-6 md:grid-cols-2">
        <TradingViewCard />
        <div className="flex flex-col gap-6">
          <ServerCard />
          <PlanLimitsCard />
        </div>
      </div>
      <RecentActivity />
    </div>
  );
}
