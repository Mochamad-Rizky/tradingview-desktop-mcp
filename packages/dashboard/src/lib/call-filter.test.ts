import type { ToolCall } from '@/api/event-log';
import { callId, endedCall as call, runningCall as running } from '@/test/fixtures';
import { ALL, filterFromSearch, matchingCalls, searchWithFilter } from './call-filter';

const ids = (calls: readonly ToolCall[]) => calls.map((each) => each.id);

test('a filter reads its search, origin and status from the address, and anything else means all', () => {
  expect(filterFromSearch(new URLSearchParams('q=Chart&origin=batch&status=error'))).toEqual({
    q: 'Chart',
    origin: 'batch',
    status: 'error',
  });
  expect(filterFromSearch(new URLSearchParams('origin=cli&status=done&q='))).toEqual(ALL);
  expect(filterFromSearch(new URLSearchParams())).toEqual({ q: '', origin: 'all', status: 'all' });
});

test('a filter goes into the address without its defaults, and what else the address holds stays', () => {
  const search = new URLSearchParams('origin=mcp&view=compact');
  expect(searchWithFilter(search, { q: 'chart', origin: 'all' }).toString()).toBe(
    'view=compact&q=chart',
  );
  expect(searchWithFilter(search, { status: 'running', q: '' }).toString()).toBe(
    'origin=mcp&view=compact&status=running',
  );
  // The address it was given is left as it was.
  expect(search.toString()).toBe('origin=mcp&view=compact');
});

test('matching calls come newest first, at most the limit, with how many match in all', () => {
  const calls = [
    call(1),
    call(2, { tool: 'chart_set_symbol', ok: false, errorCode: 'TIMEOUT' }),
    call(3, { origin: 'batch', tool: 'drawing_list' }),
    // Still running, and running when the stream had a gap.
    running(4),
    running(5, { resultNotSeen: true }),
    // Failed without a code.
    call(6, { origin: 'dashboard', tool: 'drawing_clear_all', ok: false }),
  ];

  expect(matchingCalls(calls, ALL, 200)).toEqual({ rows: [...calls].reverse(), total: 6 });
  const newest = matchingCalls(calls, ALL, 2);
  expect(ids(newest.rows)).toEqual([callId(6), callId(5)]);
  expect(newest.total).toBe(6);

  // The search finds a part of the tool name, in any case, without the spaces around it.
  expect(ids(matchingCalls(calls, { ...ALL, q: '  SET_sym ' }, 200).rows)).toEqual([callId(2)]);
  expect(ids(matchingCalls(calls, { ...ALL, q: 'drawing' }, 200).rows)).toEqual([
    callId(6),
    callId(3),
  ]);
  expect(ids(matchingCalls(calls, { ...ALL, origin: 'batch' }, 200).rows)).toEqual([callId(3)]);
  // A call whose result was not seen has no result yet, as far as the dashboard knows.
  expect(ids(matchingCalls(calls, { ...ALL, status: 'running' }, 200).rows)).toEqual([
    callId(5),
    callId(4),
  ]);
  expect(ids(matchingCalls(calls, { ...ALL, status: 'ok' }, 200).rows)).toEqual([
    callId(3),
    callId(1),
  ]);
  expect(ids(matchingCalls(calls, { ...ALL, status: 'error' }, 200).rows)).toEqual([
    callId(6),
    callId(2),
  ]);
  expect(matchingCalls(calls, { q: 'chart', origin: 'dashboard', status: 'error' }, 200)).toEqual({
    rows: [],
    total: 0,
  });
});
