import type { DashboardHealth } from '@contract';
import {
  CircleCheckIcon,
  CircleXIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useHealth } from '@/hooks/use-health';
import { cn } from '@/lib/utils';

export type ConnectionState = 'ready' | 'background' | 'unreachable' | 'connecting';

// How far TradingView is up, from a health report; undefined when there is no answer to go by.
export function connectionState(health: DashboardHealth | undefined): ConnectionState {
  if (health === undefined) {
    return 'connecting';
  }
  if (health.app.ready) {
    return 'ready';
  }
  if (health.chart.inBackground === true) {
    return 'background';
  }
  return health.cdp.reachable ? 'connecting' : 'unreachable';
}

const LOOKS: Record<ConnectionState, { label: string; icon: LucideIcon; className: string }> = {
  ready: {
    label: 'TradingView ready',
    icon: CircleCheckIcon,
    className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  },
  background: {
    label: 'Chart in background',
    icon: TriangleAlertIcon,
    className: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
  },
  unreachable: {
    label: 'TradingView not reachable',
    icon: CircleXIcon,
    className: 'bg-destructive/10 text-destructive dark:bg-destructive/20',
  },
  connecting: {
    label: 'Connecting',
    icon: LoaderCircleIcon,
    className: 'bg-secondary text-secondary-foreground',
  },
};

// The header's word on TradingView, from the health check the status page shares. The words carry
// the state; the colour and the icon only repeat it. A live region, so that a screen reader says
// when it changes.
export function ConnectionBadge() {
  const { data, isError } = useHealth();
  // After a failed check, the last answer says nothing about TradingView now.
  const state = connectionState(isError ? undefined : data);
  const { label, icon: Icon, className } = LOOKS[state];
  return (
    <Badge role="status" data-state={state} className={className}>
      <Icon aria-hidden className={cn(state === 'connecting' && 'motion-safe:animate-spin')} />
      {label}
    </Badge>
  );
}
