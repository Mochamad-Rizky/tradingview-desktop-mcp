import type { DashboardEvent } from '@contract';
import { authorization, errorFrom } from './client';
import { readToken } from './token';

// The live tool events of GET /api/events, a stream of server-sent events. EventSource cannot send
// an Authorization header, and the token must stay out of the URL, so the stream is read with
// fetch and parsed here.

const EVENTS_PATH = '/api/events';

// One event of the stream: its type (message when it names none), its data lines joined with line
// breaks, and the last event id the stream had set by then.
export interface SseMessage {
  event: string;
  data: string;
  id: string | null;
}

// The parser of the event stream format of the HTML standard (9.2.6), fed with text in chunks
// that may end anywhere, even inside a field name or between the CR and LF of a line break.
export class SseParser {
  #buffer = '';
  #event = '';
  #data: string[] = [];
  #lastEventId: string | null;

  // `lastEventId`: the id the stream resumes from, which an event keeps until an id line sets
  // another.
  constructor(lastEventId: string | null = null) {
    this.#lastEventId = lastEventId;
  }

  // The id of the last id line, as the server wrote it: the client sends it back as it is.
  get lastEventId(): string | null {
    return this.#lastEventId;
  }

  // The events that `chunk` completes.
  push(chunk: string): SseMessage[] {
    this.#buffer += chunk;
    const messages: SseMessage[] = [];
    // Every kind of line break ends a line.
    const lineEnd = /\r\n|\r|\n/g;
    let start = 0;
    let match: RegExpExecArray | null;
    while ((match = lineEnd.exec(this.#buffer)) !== null) {
      // A CR at the end of the text so far may be the first half of a CRLF: it waits for the next
      // chunk.
      if (match[0] === '\r' && lineEnd.lastIndex === this.#buffer.length) {
        break;
      }
      this.#line(this.#buffer.slice(start, match.index), messages);
      start = lineEnd.lastIndex;
    }
    this.#buffer = this.#buffer.slice(start);
    return messages;
  }

  // The events the end of the stream completes: a CR that ended it ended its line. Whatever is
  // left after that is an event the stream broke off, which is dropped.
  finish(): SseMessage[] {
    const messages: SseMessage[] = [];
    if (this.#buffer.endsWith('\r')) {
      this.#line(this.#buffer.slice(0, -1), messages);
    }
    this.#buffer = '';
    return messages;
  }

  #line(line: string, messages: SseMessage[]): void {
    if (line === '') {
      // A blank line ends the event; one without data is no event.
      if (this.#data.length > 0) {
        messages.push({
          event: this.#event === '' ? 'message' : this.#event,
          data: this.#data.join('\n'),
          id: this.#lastEventId,
        });
      }
      this.#event = '';
      this.#data = [];
      return;
    }
    // A comment, such as the server's heartbeat.
    if (line.startsWith(':')) {
      return;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const rawValue = colon === -1 ? '' : line.slice(colon + 1);
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
    switch (field) {
      case 'event':
        this.#event = value;
        break;
      case 'data':
        this.#data.push(value);
        break;
      case 'id':
        // A browser ignores an id that holds a NUL, and an empty one clears the last id.
        if (!value.includes('\0')) {
          this.#lastEventId = value === '' ? null : value;
        }
        break;
      default:
        // retry, and fields this client does not know. The client keeps its own backoff.
        break;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The data of a tool event, or null for data that is not one: the stream is the server's, but a
// proxy or a newer server could send something else, which is passed over rather than shown.
function toolEvent(data: string): DashboardEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.tool !== 'string' ||
    typeof value.seq !== 'number' ||
    typeof value.at !== 'string' ||
    (value.phase !== 'start' && value.phase !== 'end')
  ) {
    return null;
  }
  return value as DashboardEvent;
}

// Whether `response` is an event stream, whatever the parameters and the case of its type.
function isEventStream(response: Response): boolean {
  return /^\s*text\/event-stream\s*(;|$)/i.test(response.headers.get('Content-Type') ?? '');
}

// Lets go of the body of an answer that will not be read, so that its connection is freed.
function discard(response: Response): void {
  response.body?.cancel().catch(() => undefined);
}

export interface StreamEventsOptions {
  // The id of the last event seen, sent as Last-Event-ID so the server resumes after it; null on a
  // first connection.
  lastEventId: string | null;
  signal: AbortSignal;
  // A tool event, with the last event id of the stream after it.
  onEvent(event: DashboardEvent, lastEventId: string | null): void;
  // The server could not resume from lastEventId: events were missed.
  onGap(): void;
  // The server accepted the stream.
  onOpen(): void;
}

// Reads one connection of the event stream until it ends. It resolves when the server ends the
// stream or `signal` aborts it, and rejects when the connection fails, the server refuses it (an
// ApiError; a 401 goes to the token gate first), or the answer is no event stream: only a 200 of
// type text/event-stream opens it. Reconnecting is the caller's.
export async function streamEvents(options: StreamEventsOptions): Promise<void> {
  const { signal } = options;
  const token = readToken();
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
    ...authorization(token),
  };
  if (options.lastEventId !== null) {
    headers['Last-Event-ID'] = options.lastEventId;
  }
  const response = await fetch(EVENTS_PATH, { headers, signal });
  // An abort that came with the answer has fired already, and the listener below would never hear
  // of it.
  if (signal.aborted) {
    discard(response);
    return;
  }
  if (!response.ok) {
    throw await errorFrom(response, token);
  }
  // A 204, say, or the dashboard page from a proxy that knows no /api: nothing to read events from.
  if (response.status !== 200 || !isEventStream(response)) {
    discard(response);
    throw new Error('The server did not answer with an event stream');
  }
  if (response.body === null) {
    throw new Error('The event stream came without a body');
  }
  options.onOpen();
  await readEvents(response.body, options);
}

// Reads the events of an open stream until it ends or `options.signal` aborts it.
async function readEvents(
  body: ReadableStream<Uint8Array>,
  options: StreamEventsOptions,
): Promise<void> {
  const { signal } = options;
  const parser = new SseParser(options.lastEventId);
  const decoder = new TextDecoder();
  const reader = body.getReader();
  // An abort does not always end a body that is being read, so the reader lets go of it itself.
  const cancel = () => {
    reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) {
        return;
      }
      const messages = done
        ? [...parser.push(decoder.decode()), ...parser.finish()]
        : parser.push(decoder.decode(value, { stream: true }));
      for (const message of messages) {
        if (message.event === 'gap') {
          options.onGap();
          continue;
        }
        const event = message.event === 'tool' ? toolEvent(message.data) : null;
        if (event !== null) {
          options.onEvent(event, message.id);
        }
      }
      if (done) {
        return;
      }
    }
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
