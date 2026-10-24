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
// startedAt is the end time less the duration, and args are unknown. A call still running when the
// stream had a gap may never get its end, and says so.
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
  // The call ran when the stream had a gap, so its end may have been lost: the server crashed or
  // restarted, or fell too far behind to replay it. An end that comes after all clears it.
  resultNotSeen?: boolean;
  // The seq of its start event, or of its end while its start is unknown (the end came first).
  seq: number;
}

export interface EventLogState {
  // Oldest first, in the order the calls became known.
  calls: readonly ToolCall[];
  status: StreamStatus;
  // Events were missed while the stream was down: the server could not resume where it left off.
  missed: boolean;
  paused: boolean;
  // How many calls resume() would add: the calls the events held while paused are about, less
  // those shown already and those the log forgot.
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

export interface EventLogOptions {
  // Called on each gap: the server could not resume the stream, as after a restart, which may have
  // changed what it offers.
  onGap?: () => void;
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
  // The calls those events would add, by id, with how many of the events are about each.
  readonly #buffered = new Map<string, number>();
  // Where among those events the last gap came: the calls running at that point are marked when
  // the log resumes. Null when none came.
  #gapInPending: number | null = null;
  // The calls shown whose end was among the events let go of while paused, to mark on resume.
  readonly #endsDropped = new Set<ToolCall>();
  #status: StreamStatus = 'connecting';
  #missed = false;
  #paused = false;
  #connectedOnce = false;
  #lastEventId: string | null = null;
  #controller: AbortController | null = null;

  readonly #onGap: (() => void) | undefined;

  readonly #listeners = new Set<() => void>();
  #snapshot: EventLogState | null = null;
  // The calls as an array, made again only once they change: while paused the snapshot changes
  // with the count of what is held, and the calls a table shows stay the same array.
  #callList: readonly ToolCall[] | null = null;
  #notifyQueued = false;

  constructor(options: EventLogOptions = {}) {
    this.#onGap = options.onGap;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  getSnapshot = (): EventLogState => {
    this.#callList ??= [...this.#calls.values()];
    this.#snapshot ??= {
      calls: this.#callList,
      status: this.#status,
      missed: this.#missed,
      paused: this.#paused,
      buffered: this.#buffered.size,
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
    const gapAt = this.#gapInPending;
    this.#pending = [];
    this.#gapInPending = null;
    this.#buffered.clear();
    // The events let go of came before every event held.
    for (const call of this.#endsDropped) {
      this.#update({ ...call, resultNotSeen: true });
    }
    this.#endsDropped.clear();
    pending.forEach((event, index) => {
      if (index === gapAt) {
        this.#markRunning();
      }
      this.#merge(event);
    });
    if (gapAt === pending.length) {
      this.#markRunning();
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
    this.#callList = null;
    this.#withoutStart.clear();
    this.#pending = [];
    this.#buffered.clear();
    this.#gapInPending = null;
    this.#endsDropped.clear();
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
          onGap: (lastEventId) => {
            this.#gap(lastEventId);
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

  // The server could not resume from the id, which means nothing to it any more: the stream goes on
  // from the id the server gave the gap. The calls the log has stay, and an event of one replayed
  // later is taken once all the same. The calls running then may have ended unseen; while paused,
  // they are marked on resume, in the order the events came.
  #gap(lastEventId: string | null): void {
    this.#lastEventId = lastEventId;
    this.#missed = true;
    this.#onGap?.();
    if (this.#paused) {
      this.#gapInPending = this.#pending.length;
    } else {
      this.#markRunning();
    }
    this.#changed();
  }

  #markRunning(): void {
    for (const call of this.#calls.values()) {
      if (call.endedAt === undefined && call.resultNotSeen !== true) {
        this.#update({ ...call, resultNotSeen: true });
      }
    }
  }

  // What the stream brings is told only when it changes what shows: an event seen before changes
  // nothing, and while paused only the count of the calls held does.
  #receive(event: DashboardEvent): void {
    if (this.#paused ? this.#hold(event) : this.#merge(event)) {
      this.#changed();
    }
  }

  // Keeps `event` for resume(), and tells whether that changes how many calls it would add.
  #hold(event: DashboardEvent): boolean {
    const before = this.#buffered.size;
    this.#pending.push(event);
    if (!this.#calls.has(event.id) && !this.#forgotten.has(event.id)) {
      this.#buffered.set(event.id, (this.#buffered.get(event.id) ?? 0) + 1);
    }
    if (this.#pending.length > MAX_PENDING_EVENTS) {
      this.#dropOldestHeld();
    }
    return this.#buffered.size !== before;
  }

  // Lets go of the oldest event held. When it is the end of a call shown, the log will not learn
  // how that call ended: as after a gap, the call is marked on resume.
  #dropOldestHeld(): void {
    const dropped = this.#pending.shift();
    if (dropped === undefined) {
      return;
    }
    const count = this.#buffered.get(dropped.id) ?? 0;
    if (count > 1) {
      this.#buffered.set(dropped.id, count - 1);
    } else {
      this.#buffered.delete(dropped.id);
    }
    if (this.#gapInPending !== null) {
      this.#gapInPending = Math.max(this.#gapInPending - 1, 0);
    }
    const shown = this.#calls.get(dropped.id);
    if (dropped.phase === 'end' && shown !== undefined && shown.endedAt === undefined) {
      this.#endsDropped.add(shown);
    }
  }

  // Takes `event` into the log, and tells whether it changed anything. A call is known by its id,
  // and each of its two events counts once: a start or an end that comes again (a replay after a
  // reconnect or a restart) changes nothing.
  #merge(event: DashboardEvent): boolean {
    if (this.#forgotten.has(event.id)) {
      return false;
    }
    const known = this.#calls.get(event.id);
    if (event.phase === 'start') {
      if (known === undefined) {
        this.#add(callFromStart(event));
        return true;
      }
      if (!this.#withoutStart.delete(event.id)) {
        return false;
      }
      // The end came first: the start brings the arguments and the real start time.
      const { startedAt, args, seq } = callFromStart(event);
      this.#update({ ...known, startedAt, seq, ...(args === undefined ? {} : { args }) });
      return true;
    }
    if (known === undefined) {
      this.#withoutStart.add(event.id);
      this.#add(callFromEnd(event));
      return true;
    }
    if (known.endedAt !== undefined) {
      return false;
    }
    const ended: ToolCall = { ...known, ...endFields(event) };
    delete ended.resultNotSeen;
    this.#update(ended);
    return true;
  }

  #update(call: ToolCall): void {
    this.#calls.set(call.id, call);
    this.#callList = null;
  }

  #add(call: ToolCall): void {
    this.#update(call);
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
