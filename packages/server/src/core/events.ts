import type { JsonValue } from '../utils/json.js';
import type { ErrorCode } from './errors.js';

export interface ToolCallEvent {
  id: string;
  tool: string;
  origin: 'mcp' | 'batch' | 'dashboard';
  phase: 'start' | 'end';
  at: string;
  durationMs?: number;
  ok?: boolean;
  errorCode?: ErrorCode;
  args?: JsonValue;
}

const BUFFER_SIZE = 500;

// Fans tool-call events out to live observers (the dashboard) and keeps a short backlog so a
// late observer can catch up. The backlog is a bounded FIFO: at this size, dropping the oldest
// entry with shift() is cheaper than the bookkeeping of a circular index.
export class ToolEventBus {
  readonly #buffer: ToolCallEvent[] = [];
  readonly #subscribers = new Set<(e: ToolCallEvent) => void>();

  emit(e: ToolCallEvent): void {
    this.#buffer.push(e);
    if (this.#buffer.length > BUFFER_SIZE) {
      this.#buffer.shift();
    }
    for (const subscriber of this.#subscribers) {
      try {
        subscriber(e);
      } catch {
        // An observer is not part of the tool call: a failing one (a dashboard socket that just
        // closed, say) must neither fail the call nor starve the observers after it.
      }
    }
  }

  subscribe(fn: (e: ToolCallEvent) => void): () => void {
    this.#subscribers.add(fn);
    return () => {
      this.#subscribers.delete(fn);
    };
  }

  // Oldest first among the newest `limit` events. A copy is returned so callers can reorder it.
  recent(limit = BUFFER_SIZE): ToolCallEvent[] {
    // slice(-0), slice(-0.5) and slice(-NaN) return everything, and a negative limit would skip
    // the oldest events instead of yielding none. So the limit counts whole events only, and
    // anything below one yields nothing.
    const count = Math.floor(limit);
    if (Number.isNaN(count) || count < 1) {
      return [];
    }
    return this.#buffer.slice(-count);
  }
}
