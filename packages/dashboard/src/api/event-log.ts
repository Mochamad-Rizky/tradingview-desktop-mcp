import type { DashboardErrorCode, DashboardEvent, JsonValue } from '@contract';
import { ApiError } from './client';
import { streamEvents } from './events';

// The log of tool calls the dashboard shows, built from the event stream: each call merges the
// start and the end event that share its id. The log keeps the connection up, and comes back
// after a drop with the id of the last event it saw.

// The most calls the log keeps; a new one drops the oldest. A busy client must not make a tab
// that stays open slow down.
export const MAX_CALLS = 1000;

// The most events held while the log is paused: a start and an end for each call the log keeps.
const MAX_PENDING_EVENTS = 2 * MAX_CALLS;

const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 15_000;

export type StreamStatus = 'connecting' | 'live' | 'reconnecting';

// One tool call. startedAt, args and seq come from its start event and the rest from its end
// event, which is missing while the call runs. For a call whose start the stream did not replay,
// startedAt is the end time less the duration, and args are unknown.
export interface ToolCall {
  id: string;
  tool: string;
  origin: DashboardEvent['origin'];
  startedAt: string;
  args?: JsonValue;
  endedAt?: string;
  durationMs?: number;
  ok?: boolean;
  errorCode?: DashboardErrorCode;
  // The seq of the event the call was first known by: its start, or its end when that came first.
  seq: number;
}

export interface EventLogState {
  // Oldest first, in the order the calls became known.
  calls: readonly ToolCall[];
  status: StreamStatus;
  // Events were missed while the stream was down: the server could not resume where it left off.
  missed: boolean;
  paused: boolean;
  // How many calls the events held while paused are about.
  buffered: number;
}

// How long to wait before attempt `attempt` (from 0) to connect again: 1 s, 2 s, 4 s and so on,
// at most 15 s.
export function reconnectDelay(attempt: number): number {
  return Math.min(FIRST_RETRY_MS * 2 ** attempt, MAX_RETRY_MS);
}

// Resolves with true after `ms`, or with false at once when `signal` aborts.
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (slept: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve(slept);
    };
    const abort = () => {
      finish(false);
    };
    const timer = setTimeout(() => {
      finish(true);
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function endFields(event: DashboardEvent): Partial<ToolCall> {
  const fields: Partial<ToolCall> = { endedAt: event.at };
  if (event.durationMs !== undefined) {
    fields.durationMs = event.durationMs;
  }
  if (event.ok !== undefined) {
    fields.ok = event.ok;
  }
  if (event.errorCode !== undefined) {
    fields.errorCode = event.errorCode;
  }
  return fields;
}

function callFromStart(event: DashboardEvent): ToolCall {
  const call: ToolCall = {
    id: event.id,
    tool: event.tool,
    origin: event.origin,
    startedAt: event.at,
    seq: event.seq,
  };
  if (event.args !== undefined) {
    call.args = event.args;
  }
  return call;
}

function callFromEnd(event: DashboardEvent): ToolCall {
  const ended = Date.parse(event.at);
  const startedAt =
    event.durationMs === undefined || Number.isNaN(ended)
      ? event.at
      : new Date(ended - event.durationMs).toISOString();
  return {
    id: event.id,
    tool: event.tool,
    origin: event.origin,
    startedAt,
    seq: event.seq,
    ...endFields(event),
  };
}

// The state of the log, and the connection that feeds it. React reads it through
// useSyncExternalStore (subscribe and getSnapshot); the provider starts and stops the connection.
export class EventLog {
  // The calls by id. A Map keeps the order its keys were added in, and replacing a call keeps its
  // place, so it is the log's order too.
  readonly #calls = new Map<string, ToolCall>();
  // The ids of calls known only from their end, whose start may still come in a replay.
  readonly #withoutStart = new Set<string>();
  // The ids of calls the log dropped or the user cleared, oldest first: a late or replayed event
  // of one must not bring it back.
  readonly #forgotten = new Set<string>();
  // The events that came while paused, oldest first.
  #pending: DashboardEvent[] = [];
  #status: StreamStatus = 'connecting';
  #missed = false;
  #paused = false;
  #connectedOnce = false;
  #lastEventId: string | null = null;
  #controller: AbortController | null = null;

  readonly #listeners = new Set<() => void>();
  #snapshot: EventLogState | null = null;
  #notifyQueued = false;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  getSnapshot = (): EventLogState => {
    this.#snapshot ??= {
      calls: [...this.#calls.values()],
      status: this.#status,
      missed: this.#missed,
      paused: this.#paused,
      buffered: new Set(this.#pending.map((event) => event.id)).size,
    };
    return this.#snapshot;
  };

  pause = (): void => {
    if (!this.#paused) {
      this.#paused = true;
      this.#changed(true);
    }
  };

  resume = (): void => {
    if (!this.#paused) {
      return;
    }
    this.#paused = false;
    const pending = this.#pending;
    this.#pending = [];
    for (const event of pending) {
      this.#merge(event);
    }
    this.#changed(true);
  };

  // Empties the log, and what it holds while paused, without touching the stream: what comes
  // next shows, and the calls cleared stay out, even when one of them ends later.
  clear = (): void => {
    for (const id of this.#calls.keys()) {
      this.#forget(id);
    }
    for (const event of this.#pending) {
      this.#forget(event.id);
    }
    this.#calls.clear();
    this.#withoutStart.clear();
    this.#pending = [];
    this.#missed = false;
    this.#changed(true);
  };

  // Opens the stream, and keeps it open until stop().
  start(): void {
    if (this.#controller !== null) {
      return;
    }
    const controller = new AbortController();
    this.#controller = controller;
    void this.#run(controller.signal);
  }

  stop(): void {
    this.#controller?.abort();
    this.#controller = null;
  }

  // Connects, and connects again after each drop, until `signal` aborts. `attempt` counts the
  // attempts since the stream was last open, and sets the wait before the next one.
  async #run(signal: AbortSignal): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await streamEvents({
          lastEventId: this.#lastEventId,
          signal,
          onOpen: () => {
            attempt = 0;
            this.#connectedOnce = true;
            this.#setStatus('live');
          },
          onEvent: (event, lastEventId) => {
            this.#lastEventId = lastEventId;
            this.#receive(event);
          },
          onGap: () => {
            // The server could not resume from the id: it starts afresh, and the id means nothing
            // to it any more. The calls the log has stay, and an event of one replayed later is
            // taken once all the same.
            this.#lastEventId = null;
            this.#missed = true;
            this.#changed();
          },
        });
      } catch (error) {
        // A wrong token: the token gate asks for another one and unmounts the log.
        if (error instanceof ApiError && error.status === 401) {
          return;
        }
        // Otherwise the connection dropped, or the server refused the stream for now (it shuts
        // down, say) or could not be reached: try again.
      }
      if (signal.aborted) {
        return;
      }
      this.#setStatus(this.#connectedOnce ? 'reconnecting' : 'connecting');
      if (!(await sleep(reconnectDelay(attempt), signal))) {
        return;
      }
    }
  }

  #receive(event: DashboardEvent): void {
    if (this.#paused) {
      this.#pending.push(event);
      if (this.#pending.length > MAX_PENDING_EVENTS) {
        this.#pending.shift();
      }
    } else {
      this.#merge(event);
    }
    this.#changed();
  }

  // Takes `event` into the log. A call is known by its id, and each of its two events counts once:
  // a start or an end that comes again (a replay after a reconnect or a restart) changes nothing.
  #merge(event: DashboardEvent): void {
    if (this.#forgotten.has(event.id)) {
      return;
    }
    const known = this.#calls.get(event.id);
    if (event.phase === 'start') {
      if (known === undefined) {
        this.#add(callFromStart(event));
      } else if (this.#withoutStart.delete(event.id)) {
        // The end came first: the start brings the arguments and the real start time.
        const { startedAt, args, seq } = callFromStart(event);
        this.#calls.set(event.id, {
          ...known,
          startedAt,
          seq,
          ...(args === undefined ? {} : { args }),
        });
      }
      return;
    }
    if (known === undefined) {
      this.#withoutStart.add(event.id);
      this.#add(callFromEnd(event));
    } else if (known.endedAt === undefined) {
      this.#calls.set(event.id, { ...known, ...endFields(event) });
    }
  }

  #add(call: ToolCall): void {
    this.#calls.set(call.id, call);
    if (this.#calls.size > MAX_CALLS) {
      const oldest = this.#calls.keys().next().value;
      if (oldest !== undefined) {
        this.#calls.delete(oldest);
        this.#withoutStart.delete(oldest);
        this.#forget(oldest);
      }
    }
  }

  #forget(id: string): void {
    this.#forgotten.add(id);
    if (this.#forgotten.size > MAX_CALLS) {
      const oldest = this.#forgotten.values().next().value;
      if (oldest !== undefined) {
        this.#forgotten.delete(oldest);
      }
    }
  }

  #setStatus(status: StreamStatus): void {
    if (this.#status !== status) {
      this.#status = status;
      this.#changed();
    }
  }

  // The snapshot is made again when it is next read. What the user does shows at once (`now`);
  // what the stream brings is told once the current task is done, so that the many events of one
  // chunk make one snapshot and one render.
  #changed(now = false): void {
    this.#snapshot = null;
    if (now) {
      this.#notify();
      return;
    }
    if (!this.#notifyQueued) {
      this.#notifyQueued = true;
      queueMicrotask(() => {
        this.#notifyQueued = false;
        this.#notify();
      });
    }
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) {
      listener();
    }
  }
}
