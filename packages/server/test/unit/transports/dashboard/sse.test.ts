import { EventEmitter } from 'node:events';
import {
  createServer,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { formatSseEvent, SseStream } from '../../../../src/transports/dashboard/sse.js';

const cleanups: (() => void)[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

// A response that keeps what is written to it. Its unsent buffer is whatever a test sets, and like
// a real one it emits close when it ends or is destroyed.
class FakeResponse extends EventEmitter {
  statusCode = 0;
  headers: OutgoingHttpHeaders = {};
  written = '';
  writableLength = 0;
  writableEnded = false;
  destroyed = false;

  writeHead(statusCode: number, headers: OutgoingHttpHeaders): this {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  write(chunk: string): boolean {
    this.written += chunk;
    return true;
  }

  end(): this {
    this.writableEnded = true;
    this.emit('close');
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    this.emit('close');
    return this;
  }

  asResponse(): ServerResponse {
    return this as unknown as ServerResponse;
  }
}

function openStream(options?: ConstructorParameters<typeof SseStream>[1]) {
  const res = new FakeResponse();
  const stream = new SseStream(res.asResponse(), options);
  // The heartbeat must not outlive a test.
  cleanups.push(() => {
    stream.close();
  });
  return { res, stream };
}

test('formatSseEvent writes one id, event and data line and a blank line', () => {
  const data = { tool: 'chart_get_state', args: { note: 'two\nlines' }, ok: true };

  expect(formatSseEvent('tool', data, 'b007-7')).toBe(
    `id: b007-7\nevent: tool\ndata: ${JSON.stringify(data)}\n\n`,
  );
  // The line break inside a value stays escaped, so the data is one line.
  expect(formatSseEvent('tool', data, 'b007-7').split('\n')).toHaveLength(5);
  // Without an id the client keeps the last one it saw.
  expect(formatSseEvent('gap', {})).toBe('event: gap\ndata: {}\n\n');
});

// A line break in the name would start a field of its own, such as a forged id.
test.each(['tool\nid: 99', 'tool\r', 'tool\r\nretry: 1'])(
  'formatSseEvent refuses an event name with a line break: %j',
  (event) => {
    expect(() => formatSseEvent(event, null)).toThrow('line break');
  },
);

// An id is a string now, and a line break in it would end the id field and forge the ones after.
// A NUL makes a browser ignore the id, which would keep it from resuming where it was.
test.each(['b007-1\nevent: gap', 'b007-1\r', 'b007\u00001'])(
  'formatSseEvent refuses an id with a line break or a NUL: %j',
  (id) => {
    expect(() => formatSseEvent('tool', null, id)).toThrow('line break or a NUL');
  },
);

test('SseStream writes the event-stream headers and the retry delay first', () => {
  const { res } = openStream();

  expect(res.statusCode).toBe(200);
  expect(res.headers).toEqual({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  });
  expect(res.written).toBe('retry: 3000\n\n');
});

test('SseStream sends events as formatSseEvent writes them', () => {
  const { res, stream } = openStream();

  expect(stream.send('tool', { seq: 1 }, 'b007-1')).toBe(true);
  expect(stream.send('gap', {})).toBe(true);

  expect(res.written).toBe(
    `retry: 3000\n\n${formatSseEvent('tool', { seq: 1 }, 'b007-1')}${formatSseEvent('gap', {})}`,
  );
});

test('SseStream sends a heartbeat comment every heartbeatMs', () => {
  vi.useFakeTimers();
  const { res } = openStream({ heartbeatMs: 1000 });
  const pings = () => res.written.split(': ping\n\n').length - 1;

  vi.advanceTimersByTime(999);
  expect(pings()).toBe(0);
  vi.advanceTimersByTime(1);
  expect(pings()).toBe(1);
  vi.advanceTimersByTime(3000);
  expect(pings()).toBe(4);
  expect(res.written).toBe(`retry: 3000\n\n${': ping\n\n'.repeat(4)}`);
});

test('SseStream sends a heartbeat every 15 seconds by default', () => {
  vi.useFakeTimers();
  const { res } = openStream();

  vi.advanceTimersByTime(14_999);
  expect(res.written).not.toContain(': ping');
  vi.advanceTimersByTime(1);
  expect(res.written).toContain(': ping\n\n');
});

test("SseStream closes and refuses to send when the client's unsent buffer passes maxBufferedBytes", () => {
  vi.useFakeTimers();
  const { res, stream } = openStream({ heartbeatMs: 1000, maxBufferedBytes: 100 });
  const onClose = vi.fn();
  stream.onClose(onClose);

  // At the limit the client is behind, but not too far.
  res.writableLength = 100;
  expect(stream.send('tool', { seq: 1 }, 'b007-1')).toBe(true);

  res.writableLength = 101;
  expect(stream.send('tool', { seq: 2 }, 'b007-2')).toBe(false);

  // The buffered events are dropped with the connection, so memory is freed at once; the client
  // reconnects with the last id it got.
  expect(res.destroyed).toBe(true);
  expect(res.writableEnded).toBe(false);
  expect(onClose).toHaveBeenCalledOnce();
  expect(res.written).not.toContain('"seq":2');
  res.writableLength = 0;
  expect(stream.send('tool', { seq: 3 }, 'b007-3')).toBe(false);
  // No heartbeat is written to the closed stream either.
  const written = res.written;
  vi.advanceTimersByTime(5000);
  expect(res.written).toBe(written);
});

test('SseStream lets the client buffer grow to 1 MiB by default', () => {
  const { res, stream } = openStream();

  res.writableLength = 1_048_576;
  expect(stream.send('tool', null)).toBe(true);
  res.writableLength = 1_048_577;
  expect(stream.send('tool', null)).toBe(false);
});

test('SseStream closes when a heartbeat finds the client too far behind', () => {
  vi.useFakeTimers();
  const { res, stream } = openStream({ heartbeatMs: 1000, maxBufferedBytes: 100 });
  const onClose = vi.fn();
  stream.onClose(onClose);

  res.writableLength = 101;
  vi.advanceTimersByTime(1000);

  expect(res.destroyed).toBe(true);
  expect(res.written).not.toContain(': ping');
  expect(onClose).toHaveBeenCalledOnce();
});

// A client that stops reading: its socket stays open, and everything sent piles up on the server.
test('SseStream closes the stream of a real client that stops reading', async () => {
  let resolveStream!: (value: { res: ServerResponse; stream: SseStream }) => void;
  const opened = new Promise<{ res: ServerResponse; stream: SseStream }>((resolve) => {
    resolveStream = resolve;
  });
  const server = createServer((_req, res) => {
    resolveStream({ res, stream: new SseStream(res, { maxBufferedBytes: 64 * 1024 }) });
  });
  const port = await listen(server);
  const client = await stalledClient(port);
  cleanups.push(() => {
    client.destroy();
    server.close();
  });
  const { res, stream } = await opened;
  const closed = new Promise<void>((resolve) => {
    stream.onClose(resolve);
  });

  // 64 MiB at most, far more than the socket buffers of the system take while nobody reads.
  const event = { text: 'x'.repeat(16 * 1024) };
  const most = 4096;
  let sent = 0;
  while (sent < most && stream.send('tool', event, String(sent + 1))) {
    sent += 1;
  }

  expect(sent).toBeGreaterThan(0);
  expect(sent).toBeLessThan(most);
  await closed;
  expect(res.destroyed).toBe(true);
  expect(stream.send('tool', event)).toBe(false);
});

test('SseStream streams through a real response', async () => {
  const server = createServer((_req, res) => {
    const stream = new SseStream(res);
    stream.send('tool', { seq: 1, tool: 'chart_get_state' }, 'b007-1');
    stream.close();
  });
  const port = await listen(server);
  cleanups.push(() => {
    server.close();
  });

  const response = await fetch(`http://127.0.0.1:${String(port)}/`);

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-accel-buffering')).toBe('no');
  expect(await response.text()).toBe(
    `retry: 3000\n\nid: b007-1\nevent: tool\ndata: {"seq":1,"tool":"chart_get_state"}\n\n`,
  );
});

test('SseStream.close ends the response once, stops the heartbeat and tells every listener', () => {
  vi.useFakeTimers();
  const { res, stream } = openStream({ heartbeatMs: 1000 });
  const first = vi.fn();
  const second = vi.fn();
  stream.onClose(first);
  stream.onClose(second);
  const end = vi.spyOn(res, 'end');

  stream.close();
  stream.close();

  expect(end).toHaveBeenCalledOnce();
  expect(res.destroyed).toBe(false);
  expect(first).toHaveBeenCalledOnce();
  expect(second).toHaveBeenCalledOnce();
  expect(stream.send('tool', null)).toBe(false);
  vi.advanceTimersByTime(5000);
  expect(res.written).toBe('retry: 3000\n\n');
});

test('SseStream closes when the client goes away', () => {
  vi.useFakeTimers();
  const { res, stream } = openStream({ heartbeatMs: 1000 });
  const onClose = vi.fn();
  stream.onClose(onClose);
  const end = vi.spyOn(res, 'end');

  // What a response emits when its connection is lost.
  res.destroyed = true;
  res.emit('close');

  expect(onClose).toHaveBeenCalledOnce();
  expect(end).not.toHaveBeenCalled();
  expect(stream.send('tool', null)).toBe(false);
  vi.advanceTimersByTime(5000);
  expect(res.written).toBe('retry: 3000\n\n');
});

// The response can be ended by its owner before its close event arrives, and writing after the
// end would be an error event on the response.
test('SseStream writes nothing to a response that was ended elsewhere', () => {
  const { res, stream } = openStream();
  const onClose = vi.fn();
  stream.onClose(onClose);
  const end = vi.spyOn(res, 'end');
  res.writableEnded = true;

  expect(stream.send('tool', null)).toBe(false);

  expect(res.written).toBe('retry: 3000\n\n');
  expect(end).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledOnce();
});

test('SseStream.close leaves a response that was ended elsewhere as it is', () => {
  const { res, stream } = openStream();
  const onClose = vi.fn();
  stream.onClose(onClose);
  const end = vi.spyOn(res, 'end');
  res.writableEnded = true;

  stream.close();

  expect(end).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledOnce();
});

test('SseStream is closed from the start when the client left before it opened', () => {
  vi.useFakeTimers();
  const res = new FakeResponse();
  res.destroyed = true;
  const end = vi.spyOn(res, 'end');

  const stream = new SseStream(res.asResponse(), { heartbeatMs: 1000 });
  const onClose = vi.fn();
  stream.onClose(onClose);

  expect(onClose).toHaveBeenCalledOnce();
  expect(stream.send('tool', null)).toBe(false);
  expect(end).not.toHaveBeenCalled();
  vi.advanceTimersByTime(5000);
  expect(res.written).toBe('retry: 3000\n\n');
});

test('SseStream.onClose calls a listener added after the close at once', () => {
  const { stream } = openStream();
  stream.close();
  const late = vi.fn();

  stream.onClose(late);

  expect(late).toHaveBeenCalledOnce();
});

test('a throwing close listener neither stops the others nor the close', () => {
  const { res, stream } = openStream();
  const after = vi.fn();
  stream.onClose(() => {
    throw new Error('the subscriber was gone already');
  });
  stream.onClose(after);

  expect(() => {
    stream.close();
  }).not.toThrow();

  expect(after).toHaveBeenCalledOnce();
  expect(res.writableEnded).toBe(true);
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return (server.address() as AddressInfo).port;
}

// A raw client that asks for the stream and never reads from its socket.
async function stalledClient(port: number): Promise<Socket> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.pause();
      socket.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\n\r\n`);
      resolve(socket);
    });
  });
}
