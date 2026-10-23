import type { DashboardCallRequest, DashboardCallResult } from '@contract';
import { useMutation } from '@tanstack/react-query';
import { apiPost } from '@/api/client';

export interface CallToolVariables extends DashboardCallRequest {
  name: string;
}

// Runs a tool on the server (POST /api/tools/<name>), through the same registry as an MCP call:
// it shows in the event log with origin dashboard. A call the tool failed is a result with
// isError, not an error; an error is a call the server refused.
export function useCallTool() {
  return useMutation({
    mutationFn: ({ name, arguments: args = {} }: CallToolVariables) => {
      const body: DashboardCallRequest = { arguments: args };
      return apiPost<DashboardCallResult>(`/api/tools/${encodeURIComponent(name)}`, body);
    },
  });
}
