import type { DashboardHealth } from '@contract';
import {
  CircleCheckIcon,
  CircleXIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from 'lucide-react';
import { ApiError } from '@/api/client';
import { Badge } from '@/components/ui/badge';
import { useHealth } from '@/hooks/use-health';
import { cn } from '@/lib/utils';

export type ConnectionState =
  | 'ready'
  | 'background'
  | 'unreachable'
  | 'no-chart'
  | 'server-unreachable'
  | 'server-error'
  | 'connecting';

// How far TradingView is up, from a health report; undefined when there is no answer to go by. A
// chart that is not in front needs the user, even when the app says it is ready, as the card says.
export function connectionState(health: DashboardHealth | undefined): ConnectionState {
  if (health === undefined) {
    return 'connecting';
  }
  if (health.chart.inBackground === true) {
    return 'background';
  }
  if (health.app.ready) {
    return 'ready';
  }
  if (!health.cdp.reachable) {
    return 'unreachable';
  }
  // TradingView answers but shows no chart, on its New tab page say: only the user can open one.
  // With a chart found, the app is still starting.
  return health.chart.found ? 'connecting' : 'no-chart';
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
  'no-chart': {
    label: 'No chart open',
    icon: TriangleAlertIcon,
    className: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
  },
  'server-unreachable': {
    label: 'Server not reachable',
    icon: CircleXIcon,
    className: 'bg-destructive/10 text-destructive dark:bg-destructive/20',
  },
  'server-error': {
    label: 'Server error',
    icon: CircleXIcon,
    className: 'bg-destructive/10 text-destructive dark:bg-destructive/20',
  },
  connecting: {
    label: 'Connecting',
    icon: LoaderCircleIcon,
    className: 'bg-secondary text-secondary-foreground',
  },
};

// What a failed health check says: no answer of the server (not an ApiError) means that the
// dashboard cannot reach its own server; an answer with an error status (403, 404, 5xx) is an error
// of the server. A 401 goes to the token gate, which asks for the token again, so the badge waits.
function failureState(error: Error): ConnectionState {
  if (!(error instanceof ApiError)) {
    return 'server-unreachable';
  }
  return error.status === 401 ? 'connecting' : 'server-error';
}

// The header's word on TradingView, from the health check the status page shares. The words carry
// the state; the colour and the icon only repeat it. A live region, so that a screen reader says
// when it changes.
export function ConnectionBadge() {
  const { data, error, isError } = useHealth();
  // After a failed check, the last answer says nothing about TradingView now.
  const state = isError ? failureState(error) : connectionState(data);
  const { label, icon: Icon, className } = LOOKS[state];
  return (
    <Badge role="status" data-state={state} className={className}>
      <Icon aria-hidden className={cn(state === 'connecting' && 'motion-safe:animate-spin')} />
      {label}
    </Badge>
  );
}
