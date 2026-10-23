import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { EventLog, type EventLogState } from '@/api/event-log';

export type { StreamStatus, ToolCall } from '@/api/event-log';

const EventLogContext = createContext<EventLog | null>(null);

// One event log for the whole app, with one stream: it keeps the calls, a pause and a clear while
// the user moves between pages. Mounted inside the token gate, so it streams only with a token, and
// a 401 that sends the user back to the gate closes it.
export function EventLogProvider({ children }: { children: ReactNode }) {
  const [log] = useState(() => new EventLog());
  useEffect(() => {
    log.start();
    return () => {
      log.stop();
    };
  }, [log]);
  return createElement(EventLogContext.Provider, { value: log }, children);
}

export interface EventLogView extends EventLogState {
  // Holds the calls that come from now on, so that the log stands still to be read.
  pause: () => void;
  // Shows the calls held while paused.
  resume: () => void;
  // Empties the log on this page only: the server and the stream are left alone.
  clear: () => void;
}

// The live tool calls of the server: the calls (oldest first, at most 1000), the state of the
// stream, and whether some calls were missed while it was down.
export function useEventLog(): EventLogView {
  const log = useContext(EventLogContext);
  if (log === null) {
    throw new Error('useEventLog needs an EventLogProvider above it');
  }
  const state = useSyncExternalStore(log.subscribe, log.getSnapshot);
  return useMemo(
    () => ({ ...state, pause: log.pause, resume: log.resume, clear: log.clear }),
    [state, log],
  );
}
