import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './client';

// The keys of the cached answers of the API, one per route.
export const queryKeys = {
  info: ['info'],
  health: ['health'],
  tools: ['tools'],
} as const;

// A refused request (4xx) fails the same way again, and a 401 has gone to the token gate already;
// a failure on the way, or of the server, may be gone a moment later.
function shouldRetry(failureCount: number, error: Error): boolean {
  if (error instanceof ApiError && error.status < 500) {
    return false;
  }
  return failureCount < 2;
}

// The one query client of the app.
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry },
      // A tool call acts on TradingView: it is never sent again on its own.
      mutations: { retry: false },
    },
  });
}
