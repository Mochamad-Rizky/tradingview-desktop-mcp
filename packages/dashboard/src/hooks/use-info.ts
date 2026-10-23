import type { DashboardInfo } from '@contract';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/api/client';
import { queryKeys } from '@/api/query-client';

// The running server and its settings (GET /api/info).
export function useInfo() {
  return useQuery({
    queryKey: queryKeys.info,
    queryFn: ({ signal }) => apiGet<DashboardInfo>('/api/info', { signal }),
  });
}
