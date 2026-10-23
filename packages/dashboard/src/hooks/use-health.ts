import type { DashboardHealth } from '@contract';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/api/client';
import { queryKeys } from '@/api/query-client';

export const HEALTH_INTERVAL_MS = 5000;

// Whether TradingView answers and shows a chart (GET /api/health), checked again five seconds after
// each answer while the page is in front. Checks never overlap, however many components watch the
// health: React Query runs one fetch per query at a time, a tick of the interval that finds one
// running joins it instead of starting another, and the interval starts over when the answer comes.
// The server ends each check within its call timeout. refetch() would cancel the running check and
// start another, so a "check now" button calls refetch({ cancelRefetch: false }).
export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: ({ signal }) => apiGet<DashboardHealth>('/api/health', { signal }),
    refetchInterval: HEALTH_INTERVAL_MS,
  });
}
