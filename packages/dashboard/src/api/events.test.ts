import type { DashboardEvent } from '@contract';
import { http, HttpResponse } from 'msw';
import { callId, endEvent, startEvent, streamId, TEST_TOKEN } from '@/test/fixtures';
import { createEventStream } from '@/test/handlers';
import { server } from '@/test/server';
import { ApiError, onUnauthorized } from './client';
import { SseParser, streamEvents } from './events';
import { readToken, storeToken } from './token';

const encoder = new TextEncoder();

// What streamEvents reported, in order.
function recorder() {
  const seen: (
    | { kind: 'event'; event: DashboardEvent; lastEventId: string | null }
    | { kind: 'gap' }
    | { kind: 'open' }
  )[] = [];
  return {
    seen,
    onEvent(event: DashboardEvent, lastEventId: string | null) {
      seen.push({ kind: 'event', event, lastEventId });
    },
    onGap() {
      seen.push({ kind: 'gap' });
    },
    onOpen() {
      seen.push({ kind: 'open' });
    },
  };
}

// A stream answer whose body comes in exactly these byte chunks.
function chunkedStream(chunks: Uint8Array[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  return new HttpResponse(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

test('the SSE parser handles events split across chunks, comments and multi-line data', () => {
  const parser = new SseParser(null);
  const chunks = [
    'retry: 3000\n\n',
    'id: b1-1\nev',
    'ent: tool\ndata: {"seq":',
    '1}\n',
    '\n: ping\n\n',
    // Multi-line data, with every kind of line break, a CRLF split between two chunks.
    'data: first line\r',
    '\ndata:second line\rdata\n',
    '\r\n',
    // A comment between the fields of one event, and a field this parser does not know.
    'event: gap\n: keep-alive\nfoo: bar\ndata: {}\n\n',
    // An id alone dispatches nothing but is kept; an id holding a NUL is ignored.
    'id: b1-2\n\nid: bad\0id\ndata: x\n\n',
    // Half an event at the end waits for the rest.
    'event: tool\ndata: {"seq"',
  ];
  const messages = chunks.flatMap((chunk) => parser.push(chunk));
  expect(messages).toEqual([
    { event: 'tool', data: '{"seq":1}', id: 'b1-1' },
    { event: 'message', data: 'first line\nsecond line\n', id: 'b1-1' },
    { event: 'gap', data: '{}', id: 'b1-1' },
    { event: 'message', data: 'x', id: 'b1-2' },
  ]);
  expect(parser.lastEventId).toBe('b1-2');
  expect(parser.push(':2}\n\n')).toEqual([{ event: 'tool', data: '{"seq":2}', id: 'b1-2' }]);
});

test('the SSE parser takes a CR that ends the stream as the end of its line', () => {
  const parser = new SseParser('b1-7');
  expect(parser.push('data: last\r\r')).toEqual([]);
  expect(parser.finish()).toEqual([{ event: 'message', data: 'last', id: 'b1-7' }]);
  // An empty id resets the last id, as a browser does.
  expect(parser.push('id\ndata: y\n\n')).toEqual([{ event: 'message', data: 'y', id: null }]);
  expect(parser.lastEventId).toBeNull();
});

test('streamEvents sends the token and the last id, and reports events, gaps and the opening', async () => {
  storeToken(TEST_TOKEN);
  const stream = createEventStream();
  server.use(stream.handler);
  const record = recorder();
  const controller = new AbortController();
  const done = streamEvents({ lastEventId: 'b0-41', signal: controller.signal, ...record });

  const connection = await stream.next();
  expect(connection.lastEventId).toBe('b0-41');
  const start = startEvent(1, callId(1), 'chart_get_state');
  const end = endEvent(2, callId(1), 'chart_get_state');
  connection.gap();
  connection.send(start);
  connection.write(': ping\n\n');
  // An event whose data is no tool event, or no JSON, is passed over.
  connection.write('id: b00710aa-9\nevent: tool\ndata: {"seq": "x"}\n\n');
  connection.write('event: tool\ndata: not json\n\n');
  connection.write('event: other\ndata: {}\n\n');
  connection.send(end);
  connection.end();
  await done;

  expect(record.seen).toEqual([
    { kind: 'open' },
    { kind: 'gap' },
    { kind: 'event', event: start, lastEventId: streamId(1) },
    { kind: 'event', event: end, lastEventId: streamId(2) },
  ]);
});

test('streamEvents sends no Last-Event-ID on a first connection', async () => {
  storeToken(TEST_TOKEN);
  const stream = createEventStream();
  server.use(stream.handler);
  const controller = new AbortController();
  const done = streamEvents({ lastEventId: null, signal: controller.signal, ...recorder() });
  const connection = await stream.next();
  expect(connection.lastEventId).toBeNull();
  connection.end();
  await done;
});

test('streamEvents decodes a character split between two chunks of bytes', async () => {
  storeToken(TEST_TOKEN);
  const event = startEvent(1, callId(1), 'chart_set_symbol', { args: { note: 'café ✓' } });
  const bytes = encoder.encode(`id: b1-1\nevent: tool\ndata: ${JSON.stringify(event)}\n\n`);
  // Cut inside the three bytes of the check mark.
  const cut = bytes.indexOf(0xe2) + 1;
  server.use(http.get('/api/events', () => chunkedStream([bytes.slice(0, cut), bytes.slice(cut)])));
  const record = recorder();
  await streamEvents({ lastEventId: null, signal: new AbortController().signal, ...record });
  expect(record.seen).toEqual([{ kind: 'open' }, { kind: 'event', event, lastEventId: 'b1-1' }]);
});

test('streamEvents rejects a stream answer without a body', async () => {
  storeToken(TEST_TOKEN);
  server.use(http.get('/api/events', () => new HttpResponse(null, { status: 200 })));
  const record = recorder();
  await expect(
    streamEvents({ lastEventId: null, signal: new AbortController().signal, ...record }),
  ).rejects.toThrow('The event stream came without a body');
  expect(record.seen).toEqual([]);
});

test('streamEvents rejects when the connection drops', async () => {
  storeToken(TEST_TOKEN);
  const stream = createEventStream();
  server.use(stream.handler);
  const done = streamEvents({
    lastEventId: null,
    signal: new AbortController().signal,
    ...recorder(),
  });
  const connection = await stream.next();
  connection.drop();
  await expect(done).rejects.toThrow();
});

test('streamEvents ends quietly and lets go of the stream when it is aborted', async () => {
  storeToken(TEST_TOKEN);
  const stream = createEventStream();
  server.use(stream.handler);
  const record = recorder();
  const controller = new AbortController();
  const done = streamEvents({ lastEventId: null, signal: controller.signal, ...record });
  const connection = await stream.next();
  await vi.waitFor(() => {
    expect(record.seen).toEqual([{ kind: 'open' }]);
  });
  controller.abort();
  await done;
  expect(connection.closed).toBe(true);
  // Nothing sent after the abort is reported.
  connection.send(startEvent(1, callId(1), 'chart_get_state'));
  expect(record.seen).toEqual([{ kind: 'open' }]);
});

test('streamEvents throws an ApiError for a refused stream, and a 401 goes to the token gate', async () => {
  storeToken('wrong-token');
  server.use(createEventStream().handler);
  const listener = vi.fn();
  const stop = onUnauthorized(listener);
  const record = recorder();
  const error = await streamEvents({
    lastEventId: null,
    signal: new AbortController().signal,
    ...record,
  }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status: 401 });
  expect(listener).toHaveBeenCalledTimes(1);
  expect(readToken()).toBeNull();
  expect(record.seen).toEqual([]);
  stop();

  storeToken(TEST_TOKEN);
  server.use(
    http.get('/api/events', () =>
      HttpResponse.json({ error: 'The server is shutting down' }, { status: 503 }),
    ),
  );
  await expect(
    streamEvents({ lastEventId: null, signal: new AbortController().signal, ...record }),
  ).rejects.toMatchObject({ status: 503, message: 'The server is shutting down' });
});
