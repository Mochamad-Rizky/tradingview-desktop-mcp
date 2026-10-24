import { randomBytes } from 'node:crypto';
import type { JsonValue } from '../utils/json.js';
import type { ErrorCode } from './errors.js';

// A type alias, not an interface: it goes to the dashboard as JSON, which a type must satisfy
// JsonValue for.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type ToolCallEvent = {
  // The bus numbers its events from 1, in the order they were emitted, so that an observer that
  // lost its connection can ask for the events after the last one it saw.
  seq: number;
  id: string;
  tool: string;
  origin: 'mcp' | 'batch' | 'dashboard';
  phase: 'start' | 'end';
  at: string;
  durationMs?: number;
  ok?: boolean;
  errorCode?: ErrorCode;
  args?: JsonValue;
};

const BUFFER_SIZE = 500;

// How many events a limit allows. slice(-0), slice(-0.5) and slice(-NaN) return everything, and a
// negative limit would skip the oldest events instead of yielding none. So a limit counts whole
// events only, and anything below one yields nothing.
function wholeCount(limit: number): number {
  const count = Math.floor(limit);
  return Number.isNaN(count) || count < 1 ? 0 : count;
}

// Fans tool-call events out to live observers (the dashboard) and keeps a short backlog so a
// late observer can catch up. The backlog is a bounded FIFO: at this size, dropping the oldest
// entry with shift() is cheaper than the bookkeeping of a circular index.
export class ToolEventBus {
  // Names this bus among the buses of earlier and later processes, whose seqs start at 1 as well:
  // an observer that comes back after a restart can tell that the seq it saw was given by another
  // bus. Hex, so it never holds the dash that a stream id puts between it and a seq.
  readonly bootId: string = randomBytes(4).toString('hex');
  readonly #buffer: ToolCallEvent[] = [];
  readonly #subscribers = new Set<(e: ToolCallEvent) => void>();
  // The seq of the last event emitted; 0 before the first.
  #lastSeq = 0;

  // The seq of the newest event this bus has given, kept or not; 0 before the first.
  get lastSeq(): number {
    return this.#lastSeq;
  }

  // The seq is the bus's to give: one that the emitter passes along is replaced.
  emit(e: Omit<ToolCallEvent, 'seq'>): ToolCallEvent {
    this.#lastSeq += 1;
    const event: ToolCallEvent = { ...e, seq: this.#lastSeq };
    this.#buffer.push(event);
    if (this.#buffer.length > BUFFER_SIZE) {
      this.#buffer.shift();
    }
    for (const subscriber of this.#subscribers) {
      try {
        subscriber(event);
      } catch {
        // An observer is not part of the tool call: a failing one (a dashboard socket that just
        // closed, say) must neither fail the call nor starve the observers after it.
      }
    }
    return event;
  }

  subscribe(fn: (e: ToolCallEvent) => void): () => void {
    this.#subscribers.add(fn);
    return () => {
      this.#subscribers.delete(fn);
    };
  }

  // Oldest first among the newest `limit` events. A copy is returned so callers can reorder it.
  recent(limit = BUFFER_SIZE): ToolCallEvent[] {
    const count = wholeCount(limit);
    return count === 0 ? [] : this.#buffer.slice(-count);
  }

  // The events after `seq`, oldest first, for an observer that saw the events up to it and goes on
  // with the live ones: at most `limit` of them, the newest. `gap` says that the observer misses
  // some events after `seq` all the same, because the buffer dropped them or the limit left them
  // out.
  //
  // A seq that this bus did not give, one beyond its last or no whole number, comes from an
  // observer of an earlier bus, such as the dashboard of a server that restarted: every buffered
  // event is new to it, and what the earlier bus emitted after that seq is lost, so it is a gap.
  after(seq: number, limit = BUFFER_SIZE): { events: ToolCallEvent[]; gap: boolean } {
    const known = Number.isInteger(seq) && seq >= 0 && seq <= this.#lastSeq;
    const from = known ? seq : 0;
    // The buffer holds the newest events without a hole, so the events after `from` that it still
    // holds are its last ones.
    const newer = this.#lastSeq - from;
    const count = Math.min(newer, this.#buffer.length, wholeCount(limit));
    const events = count === 0 ? [] : this.#buffer.slice(-count);
    return { events, gap: !known || events.length < newer };
  }
}
