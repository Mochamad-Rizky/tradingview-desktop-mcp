import type {
  DashboardCallRequest,
  DashboardCallResult,
  DashboardError,
  DashboardErrorCode,
  DashboardEvent,
  DashboardHealth,
  DashboardInfo,
  DashboardTool,
} from '@contract';
import { http, HttpResponse, type HttpHandler } from 'msw';
import {
  callId,
  callResults,
  endEvent,
  events as backlogEvents,
  health as healthFixture,
  info as infoFixture,
  okResult,
  startEvent,
  streamId,
  TEST_TOKEN,
  tools as toolsFixture,
} from './fixtures';

// The dashboard API as the tests see it, answered in process by MSW with the fixtures. Like the
// server, every route wants `Authorization: Bearer <token>` and answers 401 without it.

const encoder = new TextEncoder();

function errorBody(error: string): DashboardError {
  return { error };
}

// The server's answer to a request without the token or with a wrong one; null when the token is
// right.
function refuseWithoutToken(request: Request): Response | null {
  const header = request.headers.get('Authorization');
  if (header === `Bearer ${TEST_TOKEN}`) {
    return null;
  }
  const body = errorBody(header === null ? 'Missing token' : 'Invalid token');
  return HttpResponse.json(body, { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });
}

// A tool event as the server writes it on the stream; a null id writes no id line.
function toolEventText(event: DashboardEvent, id: string | null): string {
  const idLine = id === null ? '' : `id: ${id}\n`;
  return `${idLine}event: tool\ndata: ${JSON.stringify(event)}\n\n`;
}

// One client's event stream, which a test writes to as the server would.
export interface StreamConnection {
  // The Last-Event-ID header the client sent, or null.
  readonly lastEventId: string | null;
  // True once the stream ended, dropped, or the client went away.
  readonly closed: boolean;
  // A tool event, with the id `<bootId>-<seq>` unless one is given; null sends no id line.
  send(event: DashboardEvent, id?: string | null): void;
  // The event that tells the client it missed events.
  gap(): void;
  // Raw text of the stream, such as a comment or half an event.
  write(text: string): void;
  // Breaks the connection, as a server that crashed or a network that failed.
  drop(): void;
  // Ends the stream cleanly, as a server that shuts down.
  end(): void;
}

export interface EventStream {
  // The handler of GET /api/events.
  readonly handler: HttpHandler;
  // Every connection so far, oldest first.
  readonly connections: readonly StreamConnection[];
  // The connections in the order they were made: the first call gives the first connection, the
  // next call the next one, waiting for it when it has not come yet.
  next(): Promise<StreamConnection>;
  // Sends an event to every open connection.
  broadcast(event: DashboardEvent): void;
}

// An event stream that sends each new connection the retry line and `backlog`, and then whatever
// the test sends it. It stays open until the test ends or drops it, or the client goes away.
export function createEventStream(
  options: { backlog?: readonly DashboardEvent[] } = {},
): EventStream {
  const backlog = options.backlog ?? [];
  const connections: StreamConnection[] = [];
  const waiting: ((connection: StreamConnection) => void)[] = [];
  let taken = 0;

  const open = (request: Request): Response => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let closed = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        closed = true;
      },
    });
    request.signal.addEventListener('abort', () => {
      closed = true;
    });
    const connection: StreamConnection = {
      lastEventId: request.headers.get('Last-Event-ID'),
      get closed() {
        return closed;
      },
      write(text) {
        if (!closed) {
          controller?.enqueue(encoder.encode(text));
        }
      },
      send(event, id = streamId(event.seq)) {
        connection.write(toolEventText(event, id));
      },
      gap() {
        connection.write('event: gap\ndata: {}\n\n');
      },
      drop() {
        if (!closed) {
          closed = true;
          controller?.error(new TypeError('The connection dropped'));
        }
      },
      end() {
        if (!closed) {
          closed = true;
          controller?.close();
        }
      },
    };
    // The server writes the retry line and the replay at once, as one burst.
    connection.write(
      `retry: 3000\n\n${backlog.map((event) => toolEventText(event, streamId(event.seq))).join('')}`,
    );
    connections.push(connection);
    const resolve = waiting.shift();
    if (resolve !== undefined) {
      taken += 1;
      resolve(connection);
    }
    return new HttpResponse(body, {
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  };

  return {
    handler: http.get('/api/events', ({ request }) => refuseWithoutToken(request) ?? open(request)),
    connections,
    next() {
      const ready = connections[taken];
      if (ready !== undefined) {
        taken += 1;
        return Promise.resolve(ready);
      }
      return new Promise((resolve) => {
        waiting.push(resolve);
      });
    },
    broadcast(event) {
      for (const connection of connections) {
        connection.send(event);
      }
    },
  };
}

// The code in the envelope of a failed result, as the registry reports it on the event stream.
function errorCodeOf(result: DashboardCallResult): DashboardErrorCode {
  const error = result.structuredContent?.error;
  const code =
    typeof error === 'object' && error !== null && !Array.isArray(error) ? error.code : undefined;
  return typeof code === 'string' ? (code as DashboardErrorCode) : 'INTERNAL';
}

export interface FakeApiOptions {
  info?: DashboardInfo;
  health?: DashboardHealth;
  tools?: DashboardTool[];
  results?: Record<string, DashboardCallResult>;
  backlog?: readonly DashboardEvent[];
}

export interface FakeApi {
  readonly handlers: HttpHandler[];
  readonly stream: EventStream;
  // The tool calls made so far, oldest first, with the body each was sent with.
  readonly calls: { name: string; body: DashboardCallRequest }[];
}

// Every route of the dashboard API, answered with the fixtures unless `options` says otherwise. A
// tool call is answered with its result from `results`, and reported on the event stream as the
// server reports it: a start and an end of origin dashboard.
export function createFakeApi(options: FakeApiOptions = {}): FakeApi {
  const backlog = options.backlog ?? backlogEvents;
  const toolList = options.tools ?? toolsFixture;
  const results = options.results ?? callResults;
  const stream = createEventStream({ backlog });
  const calls: FakeApi['calls'] = [];
  let seq = backlog.reduce((last, event) => Math.max(last, event.seq), 0);

  const handlers = [
    http.get('/api/info', ({ request }) => {
      return refuseWithoutToken(request) ?? HttpResponse.json(options.info ?? infoFixture);
    }),
    http.get('/api/health', ({ request }) => {
      return refuseWithoutToken(request) ?? HttpResponse.json(options.health ?? healthFixture);
    }),
    http.get('/api/tools', ({ request }) => {
      return refuseWithoutToken(request) ?? HttpResponse.json({ tools: toolList });
    }),
    http.post<{ name: string }>('/api/tools/:name', async ({ request, params }) => {
      const refused = refuseWithoutToken(request);
      if (refused !== null) {
        return refused;
      }
      const { name } = params;
      if (!toolList.some((tool) => tool.name === name)) {
        return HttpResponse.json(errorBody('This server offers no tool of that name'), {
          status: 404,
        });
      }
      const body = (await request.json()) as DashboardCallRequest;
      calls.push({ name, body });
      const result = results[name] ?? okResult({});
      const errorCode = result.isError === true ? errorCodeOf(result) : undefined;
      const id = callId(10_000 + calls.length);
      stream.broadcast(
        startEvent((seq += 1), id, name, { origin: 'dashboard', args: body.arguments ?? {} }),
      );
      stream.broadcast(
        endEvent((seq += 1), id, name, {
          origin: 'dashboard',
          ...(errorCode === undefined ? {} : { errorCode }),
        }),
      );
      return HttpResponse.json(result);
    }),
    stream.handler,
  ];
  return { handlers, stream, calls };
}

// The routes every test starts with (src/test/server.ts); a test that needs other answers adds its
// own with server.use().
export const handlers: HttpHandler[] = createFakeApi().handlers;
