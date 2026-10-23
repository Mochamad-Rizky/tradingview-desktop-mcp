import { ToolEventBus, type ToolCallEvent } from '../../../src/core/events.js';

// What the registry emits: everything but the seq, which the bus assigns.
function makeEvent(n: number): Omit<ToolCallEvent, 'seq'> {
  return {
    id: `e${String(n)}`,
    tool: 'chart_get_state',
    origin: 'mcp',
    phase: 'start',
    at: '2026-10-18T00:00:00.000Z',
  };
}

function emitMany(bus: ToolEventBus, count: number): void {
  for (let n = 1; n <= count; n++) {
    bus.emit(makeEvent(n));
  }
}

test('ToolEventBus keeps the most recent 500 events and notifies subscribers', () => {
  const bus = new ToolEventBus();
  const notified: string[] = [];
  const unsubscribe = bus.subscribe((e) => {
    notified.push(e.id);
  });

  emitMany(bus, 501);

  expect(notified).toHaveLength(501);
  const recent = bus.recent();
  expect(recent).toHaveLength(500);
  // The first event fell out of the buffer, and order is preserved.
  expect(recent[0]?.id).toBe('e2');
  expect(recent[499]?.id).toBe('e501');

  unsubscribe();
  bus.emit(makeEvent(502));
  expect(notified).toHaveLength(501);
  expect(bus.recent(1)[0]?.id).toBe('e502');
});

test('recent(limit) returns the newest events, oldest first', () => {
  const bus = new ToolEventBus();
  emitMany(bus, 5);

  expect(bus.recent(2).map((e) => e.id)).toEqual(['e4', 'e5']);
  expect(bus.recent(99).map((e) => e.id)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
});

// A negative limit must not fall through to slice(n) and return everything but the oldest event,
// and NaN must not turn into slice(0), which returns everything. Dashboards pass user input here.
test.each([0, -1, -0.5, Number.NaN])('recent(%s) returns no events', (limit) => {
  const bus = new ToolEventBus();
  emitMany(bus, 3);

  expect(bus.recent(limit)).toEqual([]);
});

// slice(-0.5) is slice(0) and returns every event, so a fraction is cut to whole events first, and
// a limit below one event yields none.
test('ToolEventBus.recent floors a fractional limit', () => {
  const bus = new ToolEventBus();
  emitMany(bus, 3);

  expect(bus.recent(0.5)).toEqual([]);
  expect(bus.recent(0.999)).toEqual([]);
  expect(bus.recent(1.9).map((e) => e.id)).toEqual(['e3']);
  expect(bus.recent(2.7).map((e) => e.id)).toEqual(['e2', 'e3']);
  expect(bus.recent(3.2).map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
});

test('recent() returns a copy, so reversing the result does not reorder the buffer', () => {
  const bus = new ToolEventBus();
  emitMany(bus, 2);

  bus.recent().reverse();

  expect(bus.recent().map((e) => e.id)).toEqual(['e1', 'e2']);
});

test('a throwing subscriber does not stop other subscribers or the emit', () => {
  const bus = new ToolEventBus();
  const received: string[] = [];
  bus.subscribe(() => {
    throw new Error('dashboard socket closed');
  });
  bus.subscribe((e) => {
    received.push(e.id);
  });

  expect(() => {
    bus.emit(makeEvent(1));
  }).not.toThrow();

  expect(received).toEqual(['e1']);
  expect(bus.recent()).toHaveLength(1);
});

test('the bus numbers events from 1 and after() returns the newer ones oldest first', () => {
  const bus = new ToolEventBus();
  const notified: ToolCallEvent[] = [];
  bus.subscribe((e) => {
    notified.push(e);
  });

  const first = bus.emit(makeEvent(1));
  emitMany(bus, 4);

  // emit returns the event it stored, the one its subscribers get.
  expect(first).toStrictEqual({ ...makeEvent(1), seq: 1 });
  expect(notified[0]).toBe(first);
  expect(bus.recent()[0]).toBe(first);
  expect(bus.recent().map(({ seq }) => seq)).toEqual([1, 2, 3, 4, 5]);
  expect(bus.after(2)).toEqual({ events: bus.recent(3), gap: false });
  expect(bus.after(2).events.map(({ seq }) => seq)).toEqual([3, 4, 5]);
  expect(bus.after(0).events.map(({ seq }) => seq)).toEqual([1, 2, 3, 4, 5]);
  // An observer that has seen the last event is up to date.
  expect(bus.after(5)).toEqual({ events: [], gap: false });
});

test('the bus numbers every event itself, whatever seq the emitter passes', () => {
  const bus = new ToolEventBus();
  // A full event passed on, with the seq of another bus: the seq is this bus's to give.
  const passedOn: ToolCallEvent = { ...makeEvent(1), seq: 41 };

  expect(bus.emit(passedOn).seq).toBe(1);
  expect(bus.emit(makeEvent(2)).seq).toBe(2);
  // Each bus counts on its own.
  expect(new ToolEventBus().emit(makeEvent(3)).seq).toBe(1);
});

test('after() reports a gap when the requested events were dropped from the buffer', () => {
  const bus = new ToolEventBus();
  emitMany(bus, 501);

  // Event 1 fell out of the buffer, so an observer that saw nothing has missed it.
  const fromStart = bus.after(0);
  expect(fromStart.gap).toBe(true);
  expect(fromStart.events).toHaveLength(500);
  expect(fromStart.events[0]?.seq).toBe(2);
  expect(fromStart.events[499]?.seq).toBe(501);
  // An observer that saw event 1 has missed nothing.
  expect(bus.after(1).gap).toBe(false);
  expect(bus.after(1).events).toHaveLength(500);
  expect(bus.after(500)).toEqual({ events: bus.recent(1), gap: false });
});

// The client of a server that restarted resumes with a seq of the bus it had before, which may be
// beyond anything the new bus numbered: every event of the new bus is news to it, and whatever the
// old bus emitted after that seq is lost.
test.each([6, 1000])(
  'after(%s) treats a seq this bus never gave as one from an earlier bus',
  (seq) => {
    const bus = new ToolEventBus();
    emitMany(bus, 5);

    const { events, gap } = bus.after(seq);

    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(gap).toBe(true);
  },
);

// Last-Event-ID comes from the client, so a value no bus gives counts as unknown, like one of an
// earlier bus.
test.each([-1, 2.5, Number.NaN, Number.POSITIVE_INFINITY])(
  'after(%s) treats a seq that is no event number as unknown',
  (seq) => {
    const bus = new ToolEventBus();
    emitMany(bus, 3);

    expect(bus.after(seq)).toEqual({ events: bus.recent(), gap: true });
  },
);

test('after(seq, limit) keeps the newest events and reports the ones it left out as a gap', () => {
  const bus = new ToolEventBus();
  emitMany(bus, 10);

  // Resuming continues with the live events, so the newest are the ones to keep: what the limit
  // leaves out is missed like a dropped event.
  expect(bus.after(4, 3).events.map(({ seq }) => seq)).toEqual([8, 9, 10]);
  expect(bus.after(4, 3).gap).toBe(true);
  expect(bus.after(7, 3)).toEqual({ events: bus.recent(3), gap: false });
  expect(bus.after(7, 3.9)).toEqual({ events: bus.recent(3), gap: false });
  expect(bus.after(4, 0)).toEqual({ events: [], gap: true });
  expect(bus.after(4, Number.NaN)).toEqual({ events: [], gap: true });
  expect(bus.after(10, 0)).toEqual({ events: [], gap: false });
});

test('after() on a bus that emitted nothing has nothing to return and nothing missed', () => {
  const bus = new ToolEventBus();

  expect(bus.after(0)).toEqual({ events: [], gap: false });
  expect(bus.after(3)).toEqual({ events: [], gap: true });
});

test('after() returns a copy, so reordering the result does not reorder the buffer', () => {
  const bus = new ToolEventBus();
  emitMany(bus, 2);

  bus.after(0).events.reverse();

  expect(bus.recent().map(({ seq }) => seq)).toEqual([1, 2]);
});

// The seqs of a bus start at 1 again after a restart, so an observer needs to know which bus gave
// the seq it resumes from.
test('every bus names itself with a short random boot id of its own', () => {
  const ids = new Set(Array.from({ length: 20 }, () => new ToolEventBus().bootId));

  expect(ids.size).toBe(20);
  for (const id of ids) {
    // Hex only: an id never holds the dash that separates it from the seq in a stream id.
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  }
});
