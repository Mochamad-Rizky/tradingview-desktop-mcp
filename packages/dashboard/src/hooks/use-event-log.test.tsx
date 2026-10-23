import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { http, HttpResponse } from 'msw';
import { reconnectDelay } from '@/api/event-log';
import { onUnauthorized } from '@/api/client';
import { readToken, storeToken } from '@/api/token';
import {
  at,
  callEvents,
  callId,
  endEvent,
  startEvent,
  streamId,
  TEST_TOKEN,
} from '@/test/fixtures';
import { createEventStream, type EventStream } from '@/test/handlers';
import { server } from '@/test/server';
import { EventLogProvider, useEventLog } from './use-event-log';

function renderEventLog() {
  return renderHook(() => useEventLog(), { wrapper: EventLogProvider });
}

// An event stream of its own for the test, which the test writes to as the server would.
function serveStream(backlog: Parameters<typeof createEventStream>[0] = {}): EventStream {
  const stream = createEventStream(backlog);
  server.use(stream.handler);
  return stream;
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  storeToken(TEST_TOKEN);
});

test('useEventLog merges start and end events into one call by id', async () => {
  const stream = serveStream();
  const { result } = renderEventLog();
  expect(result.current.status).toBe('connecting');
  const connection = await stream.next();
  await waitFor(() => {
    expect(result.current.status).toBe('live');
  });

  connection.send(
    startEvent(1, callId(1), 'chart_set_symbol', { args: { symbol: 'NASDAQ:AAPL' }, at: at(0) }),
  );
  connection.send(startEvent(2, callId(2), 'chart_get_state', { origin: 'batch', at: at(5) }));
  await waitFor(() => {
    expect(result.current.calls).toHaveLength(2);
  });
  expect(result.current.calls[0]).toEqual({
    id: callId(1),
    tool: 'chart_set_symbol',
    origin: 'mcp',
    startedAt: at(0),
    args: { symbol: 'NASDAQ:AAPL' },
    seq: 1,
  });

  connection.send(
    endEvent(3, callId(1), 'chart_set_symbol', {
      durationMs: 30_000,
      errorCode: 'TIMEOUT',
      at: at(30_000),
    }),
  );
  connection.send(endEvent(4, callId(2), 'chart_get_state', { origin: 'batch', at: at(47) }));
  await waitFor(() => {
    expect(result.current.calls[1]?.endedAt).toBe(at(47));
  });
  expect(result.current.calls).toEqual([
    {
      id: callId(1),
      tool: 'chart_set_symbol',
      origin: 'mcp',
      startedAt: at(0),
      args: { symbol: 'NASDAQ:AAPL' },
      seq: 1,
      endedAt: at(30_000),
      durationMs: 30_000,
      ok: false,
      errorCode: 'TIMEOUT',
    },
    {
      id: callId(2),
      tool: 'chart_get_state',
      origin: 'batch',
      startedAt: at(5),
      args: {},
      seq: 2,
      endedAt: at(47),
      durationMs: 42,
      ok: true,
    },
  ]);
});

test('useEventLog takes each start and end once, however often and in whatever order they come', async () => {
  const stream = serveStream();
  const { result } = renderEventLog();
  const connection = await stream.next();

  const start = startEvent(1, callId(1), 'chart_get_state', { at: at(0) });
  const end = endEvent(2, callId(1), 'chart_get_state', { durationMs: 40, at: at(40) });
  connection.send(start);
  connection.send(end);
  // The same events again, as a replay sends them, and an end that would say otherwise.
  connection.send(start);
  connection.send(end);
  connection.send(
    endEvent(2, callId(1), 'chart_get_state', { errorCode: 'INTERNAL', durationMs: 1, at: at(1) }),
  );
  // The end of a call whose start this client never saw, and its start after it.
  connection.send(endEvent(9, callId(3), 'drawing_list', { durationMs: 250, at: at(1250) }));
  await waitFor(() => {
    expect(result.current.calls).toHaveLength(2);
  });
  expect(result.current.calls[1]).toEqual({
    id: callId(3),
    tool: 'drawing_list',
    origin: 'mcp',
    startedAt: at(1000),
    seq: 9,
    endedAt: at(1250),
    durationMs: 250,
    ok: true,
  });
  connection.send(startEvent(8, callId(3), 'drawing_list', { args: { limit: 5 }, at: at(1001) }));
  connection.send(startEvent(8, callId(3), 'drawing_list', { args: { limit: 6 }, at: at(1002) }));
  await waitFor(() => {
    expect(result.current.calls[1]?.args).toEqual({ limit: 5 });
  });

  expect(result.current.calls).toEqual([
    {
      id: callId(1),
      tool: 'chart_get_state',
      origin: 'mcp',
      startedAt: at(0),
      args: {},
      seq: 1,
      endedAt: at(40),
      durationMs: 40,
      ok: true,
    },
    {
      id: callId(3),
      tool: 'drawing_list',
      origin: 'mcp',
      startedAt: at(1001),
      args: { limit: 5 },
      seq: 8,
      endedAt: at(1250),
      durationMs: 250,
      ok: true,
    },
  ]);
});

test('useEventLog keeps the newest 1000 calls', async () => {
  // A chatty client: 2200 calls, more than twice what the log keeps, arrive in one burst.
  const stream = serveStream({ backlog: callEvents(2200) });
  const { result } = renderEventLog();
  const connection = await stream.next();
  await waitFor(() => {
    expect(result.current.calls.at(-1)?.id).toBe(callId(2200));
  });
  expect(result.current.calls).toHaveLength(1000);
  expect(result.current.calls[0]?.id).toBe(callId(1201));
  expect(result.current.calls.every((call) => call.ok === true)).toBe(true);

  // A dropped call does not come back with a late event of its own; a new call drops the oldest.
  connection.send(endEvent(2301, callId(1150), 'chart_get_state'));
  connection.send(startEvent(4401, callId(2201), 'chart_get_state'));
  await waitFor(() => {
    expect(result.current.calls.at(-1)?.id).toBe(callId(2201));
  });
  expect(result.current.calls).toHaveLength(1000);
  expect(result.current.calls[0]?.id).toBe(callId(1202));
  expect(result.current.calls.some((call) => call.id === callId(1150))).toBe(false);
});

test('useEventLog reconnects with Last-Event-ID after a drop without duplicating calls and reports a gap', async () => {
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
  const stream = serveStream();
  const { result } = renderEventLog();

  const first = await stream.next();
  first.send(startEvent(1, callId(1), 'chart_get_state'));
  first.send(endEvent(2, callId(1), 'chart_get_state'));
  first.send(startEvent(3, callId(2), 'chart_set_symbol', { args: { symbol: 'NASDAQ:AAPL' } }));
  await waitFor(() => {
    expect(result.current.calls).toHaveLength(2);
  });
  expect(result.current.status).toBe('live');
  expect(result.current.missed).toBe(false);

  // The server goes away.
  first.drop();
  await waitFor(() => {
    expect(result.current.status).toBe('reconnecting');
  });
  // The first retry comes after a second.
  await advance(900);
  expect(stream.connections).toHaveLength(1);
  await advance(100);
  const second = await stream.next();
  expect(second.lastEventId).toBe(streamId(3));

  // The server lost some events meanwhile: it says so, and replays what it still holds, which
  // overlaps with what the dashboard has.
  second.gap();
  second.send(startEvent(3, callId(2), 'chart_set_symbol', { args: { symbol: 'NASDAQ:AAPL' } }));
  second.send(endEvent(4, callId(2), 'chart_set_symbol', { durationMs: 900 }));
  second.send(startEvent(5, callId(4), 'drawing_list', { origin: 'dashboard' }));
  await waitFor(() => {
    expect(result.current.calls).toHaveLength(3);
  });
  expect(result.current.status).toBe('live');
  expect(result.current.missed).toBe(true);
  expect(result.current.calls.map((call) => [call.id, call.durationMs])).toEqual([
    [callId(1), 42],
    [callId(2), 900],
    [callId(4), undefined],
  ]);

  // Connected again, the next drop waits a second again, and resumes from the newest id.
  second.drop();
  await waitFor(() => {
    expect(result.current.status).toBe('reconnecting');
  });
  await advance(1000);
  const third = await stream.next();
  expect(third.lastEventId).toBe(streamId(5));
});

test('after a server restart the log keeps its calls, says some were missed, and resumes from the new server', async () => {
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
  const stream = serveStream();
  const { result } = renderEventLog();
  const first = await stream.next();
  first.send(startEvent(7, callId(7), 'chart_get_state'));
  await waitFor(() => {
    expect(result.current.calls).toHaveLength(1);
  });
  // The server shuts down cleanly and comes back with another boot id and an empty bus.
  first.end();
  await waitFor(() => {
    expect(result.current.status).toBe('reconnecting');
  });
  await advance(1000);
  const second = await stream.next();
  expect(second.lastEventId).toBe(streamId(7));
  second.gap();
  await waitFor(() => {
    expect(result.current.missed).toBe(true);
  });
  expect(result.current.calls.map((call) => call.id)).toEqual([callId(7)]);

  // The id of the old server means nothing to the new one: with no event of the new one yet, the
  // next connection starts afresh rather than announce the same gap again.
  second.drop();
  await advance(1000);
  const third = await stream.next();
  expect(third.lastEventId).toBeNull();
  third.send(startEvent(1, callId(8), 'chart_get_state'), streamId(1, 'c0ffee00'));
  await waitFor(() => {
    expect(result.current.calls).toHaveLength(2);
  });
  third.drop();
  await advance(1000);
  const fourth = await stream.next();
  expect(fourth.lastEventId).toBe(streamId(1, 'c0ffee00'));
});

test('the event log waits 1 s, 2 s, 4 s and at most 15 s between attempts, and starts over once connected', async () => {
  expect([0, 1, 2, 3, 4, 5, 30].map(reconnectDelay)).toEqual([
    1000, 2000, 4000, 8000, 15_000, 15_000, 15_000,
  ]);

  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  const attempts: number[] = [];
  const startedAt = Date.now();
  let refuse = true;
  const stream = serveStream();
  // Counts every attempt, refuses it while `refuse` holds, and passes it on to the stream after.
  server.use(
    http.get('/api/events', () => {
      attempts.push(Date.now() - startedAt);
      return refuse
        ? HttpResponse.json({ error: 'The server is shutting down' }, { status: 503 })
        : undefined;
    }),
  );
  const { result } = renderEventLog();
  await advance(0);
  await advance(1000 + 2000 + 4000 + 8000 + 15_000 + 15_000);
  expect(attempts).toEqual([0, 1000, 3000, 7000, 15_000, 30_000, 45_000]);
  // It never connected, so it is still connecting rather than reconnecting.
  expect(result.current.status).toBe('connecting');

  refuse = false;
  await advance(15_000);
  expect(attempts).toHaveLength(8);
  expect(result.current.status).toBe('live');
  const connection = await stream.next();
  connection.drop();
  await advance(0);
  expect(result.current.status).toBe('reconnecting');
  // Connected once, the wait starts again from a second.
  await advance(1000);
  expect(attempts.at(-1)).toBe(61_000);
});

test('useEventLog buffers while paused and appends on resume', async () => {
  const stream = serveStream();
  const { result } = renderEventLog();
  const connection = await stream.next();
  connection.send(startEvent(1, callId(1), 'chart_get_state'));
  await waitFor(() => {
    expect(result.current.calls).toHaveLength(1);
  });

  act(() => {
    result.current.pause();
  });
  expect(result.current.paused).toBe(true);
  connection.send(endEvent(2, callId(1), 'chart_get_state'));
  connection.send(startEvent(3, callId(2), 'drawing_list'));
  connection.send(endEvent(4, callId(2), 'drawing_list'));
  connection.send(startEvent(5, callId(3), 'chart_set_symbol'));
  await waitFor(() => {
    expect(result.current.buffered).toBe(3);
  });
  // What was shown stays as it was, the running call included.
  expect(result.current.calls).toEqual([expect.objectContaining({ id: callId(1) })]);
  expect(result.current.calls[0]?.endedAt).toBeUndefined();
  expect(result.current.status).toBe('live');

  act(() => {
    result.current.resume();
  });
  expect(result.current.paused).toBe(false);
  expect(result.current.buffered).toBe(0);
  expect(result.current.calls.map((call) => [call.id, call.ok])).toEqual([
    [callId(1), true],
    [callId(2), true],
    [callId(3), undefined],
  ]);

  // Resuming twice, or pausing twice, changes nothing.
  act(() => {
    result.current.resume();
    result.current.pause();
    result.current.pause();
  });
  expect(result.current.paused).toBe(true);
});

test('clear empties the log and the missed flag, keeps the stream, and forgets the calls it removed', async () => {
  const stream = serveStream();
  const { result } = renderEventLog();
  const connection = await stream.next();
  connection.send(startEvent(1, callId(1), 'chart_get_state'));
  connection.send(endEvent(2, callId(1), 'chart_get_state'));
  connection.send(startEvent(3, callId(2), 'chart_set_symbol'));
  connection.gap();
  await waitFor(() => {
    expect(result.current.calls).toHaveLength(2);
  });
  expect(result.current.missed).toBe(true);
  act(() => {
    result.current.pause();
  });
  connection.send(startEvent(4, callId(3), 'drawing_list'));
  await waitFor(() => {
    expect(result.current.buffered).toBe(1);
  });

  act(() => {
    result.current.clear();
  });
  expect(result.current.calls).toEqual([]);
  expect(result.current.missed).toBe(false);
  expect(result.current.buffered).toBe(0);
  act(() => {
    result.current.resume();
  });

  // The end of a call that was cleared while it ran, and a replay of a cleared one, stay out.
  connection.send(endEvent(5, callId(2), 'chart_set_symbol'));
  connection.send(startEvent(1, callId(1), 'chart_get_state'));
  connection.send(endEvent(6, callId(3), 'drawing_list'));
  connection.send(startEvent(7, callId(4), 'chart_get_state'));
  await waitFor(() => {
    expect(result.current.calls).toHaveLength(1);
  });
  expect(result.current.calls[0]?.id).toBe(callId(4));
  expect(connection.closed).toBe(false);
  expect(result.current.status).toBe('live');
});

test('a 401 on the event stream hands over to the token gate and stops reconnecting', async () => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  storeToken('revoked-token');
  let attempts = 0;
  const stream = serveStream();
  // Counts every attempt and passes it on to the stream, which refuses the token.
  server.use(
    http.get('/api/events', () => {
      attempts += 1;
    }),
  );
  const listener = vi.fn();
  const stop = onUnauthorized(listener);
  const { result } = renderEventLog();
  await advance(60_000);
  expect(attempts).toBe(1);
  expect(stream.connections).toHaveLength(0);
  expect(listener).toHaveBeenCalledTimes(1);
  expect(readToken()).toBeNull();
  expect(result.current.status).toBe('connecting');
  stop();
});

test('while paused the log holds the events of the newest 1000 calls at most', async () => {
  const stream = serveStream();
  const { result } = renderEventLog();
  const connection = await stream.next();
  await waitFor(() => {
    expect(result.current.status).toBe('live');
  });
  act(() => {
    result.current.pause();
  });
  for (const event of callEvents(1100)) {
    connection.send(event);
  }
  await waitFor(() => {
    expect(result.current.buffered).toBe(1000);
  });
  expect(result.current.calls).toEqual([]);
  act(() => {
    result.current.resume();
  });
  expect(result.current.calls).toHaveLength(1000);
  expect(result.current.calls[0]?.id).toBe(callId(101));
});

test('in strict mode the log ends the stream of its first mount and keeps one open', async () => {
  const stream = serveStream();
  const { result } = renderHook(() => useEventLog(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <StrictMode>
        <EventLogProvider>{children}</EventLogProvider>
      </StrictMode>
    ),
  });
  await waitFor(() => {
    expect(result.current.status).toBe('live');
  });
  await waitFor(() => {
    expect(stream.connections.filter((connection) => !connection.closed)).toHaveLength(1);
  });
  stream.broadcast(startEvent(1, callId(1), 'chart_get_state'));
  await waitFor(() => {
    expect(result.current.calls).toHaveLength(1);
  });
});

test('unmounting while it waits to reconnect stops the log for good', async () => {
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
  const stream = serveStream();
  const { result, unmount } = renderEventLog();
  const connection = await stream.next();
  connection.drop();
  await waitFor(() => {
    expect(result.current.status).toBe('reconnecting');
  });
  unmount();
  await advance(60_000);
  expect(stream.connections).toHaveLength(1);
});

test('the stream closes when the log is unmounted', async () => {
  const stream = serveStream();
  const { unmount } = renderEventLog();
  const connection = await stream.next();
  expect(connection.closed).toBe(false);
  unmount();
  await waitFor(() => {
    expect(connection.closed).toBe(true);
  });
});

test('useEventLog needs its provider', () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(() => renderHook(() => useEventLog())).toThrow(
    'useEventLog needs an EventLogProvider above it',
  );
});
