import { request, type IncomingHttpHeaders } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { ToolEventBus, type ToolCallEvent } from '../../src/core/events.js';

// A client for the dashboard API over raw node:http, so a test sends exactly the headers it means
// to (node adds Host unless one is given) and sees every byte of the answer, an event stream's too.

export interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface RawRequest {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

// One request on a connection of its own, read to the end.
export function send(
  port: number,
  { method = 'GET', path = '/', headers = {}, body }: RawRequest = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { host: '127.0.0.1', port, method, path, headers, agent: false },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
        });
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text });
        });
        response.on('error', reject);
      },
    );
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

export interface StreamEvent {
  event: string;
  id?: string;
  data: unknown;
}

// The events in the complete blocks of `text`: the retry line and comments are no events, and the
// data of every event the API sends is JSON.
export function parseStreamEvents(text: string): StreamEvent[] {
  const blocks = text.split('\n\n').slice(0, -1);
  const events: StreamEvent[] = [];
  for (const block of blocks) {
    let event: string | undefined;
    let id: string | undefined;
    let data: string | undefined;
    for (const line of block.split('\n')) {
      const colon = line.indexOf(': ');
      const field = line.slice(0, colon);
      const value = line.slice(colon + 2);
      if (field === 'event') {
        event = value;
      } else if (field === 'id') {
        id = value;
      } else if (field === 'data') {
        data = value;
      }
    }
    if (event !== undefined && data !== undefined) {
      events.push({ event, ...(id === undefined ? {} : { id }), data: JSON.parse(data) });
    }
  }
  return events;
}

export interface EventStreamClient {
  status: number;
  headers: IncomingHttpHeaders;
  // Everything received so far, as it came.
  text(): string;
  // The events received so far, in order.
  events(): StreamEvent[];
  // Settles once the response is over: 'end' when the server ended it after its last byte, 'cut'
  // when the connection went before that.
  ended: Promise<'end' | 'cut'>;
  // Goes away, as a closed browser tab does.
  close(): void;
}

// An event stream, held open until the server ends it or close() is called.
export function openEventStream(
  port: number,
  { path = '/api/events', headers = {} }: { path?: string; headers?: Record<string, string> } = {},
): Promise<EventStreamClient> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { host: '127.0.0.1', port, method: 'GET', path, headers, agent: false },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
        });
        // Destroying the request later makes the response emit an error about the reset.
        response.on('error', () => undefined);
        const ended = new Promise<'end' | 'cut'>((settle) => {
          response.on('close', () => {
            settle(response.complete ? 'end' : 'cut');
          });
        });
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          text: () => text,
          events: () => parseStreamEvents(text),
          ended,
          close: () => {
            outgoing.destroy();
          },
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

// A port nothing listens on right now, for a test that must know the port before it listens.
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
}

// A bus that counts its subscribers, so a test can see an event stream let go of it.
export class CountingBus extends ToolEventBus {
  subscribers = 0;

  override subscribe(fn: (e: ToolCallEvent) => void): () => void {
    this.subscribers += 1;
    const unsubscribe = super.subscribe(fn);
    let done = false;
    return () => {
      if (!done) {
        done = true;
        this.subscribers -= 1;
      }
      unsubscribe();
    };
  }
}
