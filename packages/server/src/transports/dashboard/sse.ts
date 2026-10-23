import type { ServerResponse } from 'node:http';
import type { JsonValue } from '../../utils/json.js';

// How long a browser waits before it reconnects a stream that dropped.
const RETRY_MS = 3000;
// A comment line every so often keeps proxies and idle timers from closing a quiet stream.
const HEARTBEAT_MS = 15_000;
// What a client may leave unread before its stream is closed: a tab in the background or a slow
// link must not make the server hold every event since.
const MAX_BUFFERED_BYTES = 1_048_576;

const LINE_BREAK = /[\r\n]/;
const LINE_BREAK_OR_NUL = /[\r\n\0]/;

// One server-sent event. JSON.stringify escapes every line break inside a value, so the data is one
// line. Without an id the client keeps the last id it saw.
export function formatSseEvent(event: string, data: JsonValue, id?: string): string {
  // A line break would end the field and start another, such as a forged id.
  if (LINE_BREAK.test(event)) {
    throw new Error(`An event name cannot hold a line break: ${JSON.stringify(event)}`);
  }
  // A browser ignores an id with a NUL in it, and would resume from the id before.
  if (id !== undefined && LINE_BREAK_OR_NUL.test(id)) {
    throw new Error(`An event id cannot hold a line break or a NUL: ${JSON.stringify(id)}`);
  }
  const idLine = id === undefined ? '' : `id: ${id}\n`;
  return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export interface SseStreamOptions {
  heartbeatMs?: number;
  maxBufferedBytes?: number;
}

// An event stream over one response. It closes for good, and tells its close listeners once, when
// close() is called, when the client goes away, or when the client falls too far behind: then the
// connection is dropped with what it buffered, and the browser reconnects with the last id it got.
export class SseStream {
  readonly #res: ServerResponse;
  readonly #maxBufferedBytes: number;
  readonly #heartbeat: NodeJS.Timeout;
  readonly #closeListeners: (() => void)[] = [];
  #closed = false;

  constructor(res: ServerResponse, options: SseStreamOptions = {}) {
    this.#res = res;
    this.#maxBufferedBytes = options.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      // Tells a buffering reverse proxy, such as nginx, to pass each event on at once.
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: ${String(RETRY_MS)}\n\n`);
    this.#heartbeat = setInterval(() => {
      this.#write(': ping\n\n');
    }, options.heartbeatMs ?? HEARTBEAT_MS);
    // An open stream holds its connection, which keeps the process alive; the timer need not.
    this.#heartbeat.unref();
    res.once('close', () => {
      this.#close('ended');
    });
    // A client that left before the stream was opened sends no close event any more.
    if (res.destroyed) {
      this.#close('ended');
    }
  }

  // False when the stream is closed, or closes now because the client is too far behind.
  send(event: string, data: JsonValue, id?: string): boolean {
    return this.#write(formatSseEvent(event, data, id));
  }

  // Ends the response after what was sent so far.
  close(): void {
    this.#close('end');
  }

  // A listener added after the close is called at once.
  onClose(fn: () => void): void {
    if (this.#closed) {
      fn();
      return;
    }
    this.#closeListeners.push(fn);
  }

  #write(chunk: string): boolean {
    if (this.#closed) {
      return false;
    }
    // Its owner can end the response before the close event arrives, and a write after the end is
    // an error event on the response.
    if (this.#res.writableEnded || this.#res.destroyed) {
      this.#close('ended');
      return false;
    }
    if (this.#res.writableLength > this.#maxBufferedBytes) {
      this.#close('drop');
      return false;
    }
    this.#res.write(chunk);
    return true;
  }

  // end: end the response after what it buffered. drop: destroy it with what it buffered, which
  // frees the memory at once. ended: the response is over already.
  #close(how: 'end' | 'drop' | 'ended'): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    clearInterval(this.#heartbeat);
    if (how === 'end') {
      if (!this.#res.writableEnded && !this.#res.destroyed) {
        this.#res.end();
      }
    } else if (how === 'drop') {
      this.#res.destroy();
    }
    for (const listener of this.#closeListeners.splice(0)) {
      try {
        listener();
      } catch {
        // A listener only cleans up after the stream (unsubscribing from the bus, say): a failing
        // one must not keep the others from running.
      }
    }
  }
}
