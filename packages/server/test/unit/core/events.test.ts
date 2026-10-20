import { ToolEventBus, type ToolCallEvent } from '../../../src/core/events.js';

function makeEvent(n: number): ToolCallEvent {
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
