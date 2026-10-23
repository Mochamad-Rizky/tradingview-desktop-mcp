import type { DashboardTool, DashboardToolList } from '@contract';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/api/client';
import { queryKeys } from '@/api/query-client';

// The tools the server offers, in the order it lists them (GET /api/tools).
export function useTools() {
  return useQuery({
    queryKey: queryKeys.tools,
    queryFn: ({ signal }) => apiGet<DashboardToolList>('/api/tools', { signal }),
    select: (list): DashboardTool[] => list.tools,
  });
}
