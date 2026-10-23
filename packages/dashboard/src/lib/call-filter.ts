import type { DashboardEvent } from '@contract';
import type { ToolCall } from '@/api/event-log';
import { callOutcome } from './tool-call';

// Which calls the live log shows: a part of the tool name, an origin and a status. The filter lives
// in the address (?q=&origin=&status=), so that a reload or a link keeps it.

export const ORIGINS = [
  'mcp',
  'batch',
  'dashboard',
] as const satisfies readonly DashboardEvent['origin'][];
export const STATUSES = ['running', 'ok', 'error'] as const;

export interface CallFilter {
  q: string;
  origin: 'all' | (typeof ORIGINS)[number];
  status: 'all' | (typeof STATUSES)[number];
}

// Every call.
export const ALL: CallFilter = { q: '', origin: 'all', status: 'all' };

function oneOf<T extends string>(values: readonly T[], value: string | null): value is T {
  return values.some((each) => each === value);
}

// The filter `search` holds. A value the dashboard does not know, from an old link say, means all.
export function filterFromSearch(search: URLSearchParams): CallFilter {
  const origin = search.get('origin');
  const status = search.get('status');
  return {
    q: search.get('q') ?? '',
    origin: oneOf(ORIGINS, origin) ? origin : 'all',
    status: oneOf(STATUSES, status) ? status : 'all',
  };
}

// `search` with `change` in it, and without a field that is back to all: the address of the
// unfiltered log is plain /log. What else `search` holds stays.
export function searchWithFilter(
  search: URLSearchParams,
  change: Partial<CallFilter>,
): URLSearchParams {
  const next = new URLSearchParams(search);
  for (const key of ['q', 'origin', 'status'] as const) {
    const value = change[key];
    if (value === ALL[key]) {
      next.delete(key);
    } else if (value !== undefined) {
      next.set(key, value);
    }
  }
  return next;
}

// The newest `limit` calls that pass `filter`, newest first, and how many pass it in all. The log
// keeps the oldest first. One pass over the calls, whatever the filter.
export function matchingCalls(
  calls: readonly ToolCall[],
  filter: CallFilter,
  limit: number,
): { rows: ToolCall[]; total: number } {
  const needle = filter.q.trim().toLowerCase();
  const matching = calls.filter((call) => {
    if (filter.origin !== 'all' && call.origin !== filter.origin) {
      return false;
    }
    if (filter.status !== 'all') {
      const outcome = callOutcome(call);
      // A call whose result was not seen has none yet, as far as the dashboard knows.
      const status = outcome === 'unseen' ? 'running' : outcome;
      if (status !== filter.status) {
        return false;
      }
    }
    return needle === '' || call.tool.toLowerCase().includes(needle);
  });
  return { rows: matching.slice(-limit).reverse(), total: matching.length };
}
