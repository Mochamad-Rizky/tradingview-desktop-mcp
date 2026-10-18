import { pollUntil } from '../../../src/utils/poll.js';

afterEach(() => {
  vi.useRealTimers();
});

// A sleep that returns at once and records what it was asked for, so that a test of the waiting
// logic takes no time. The clock stays at zero, which leaves the sleeps as the only time that
// passes, like a real run in which the probes themselves are instant.
function instantClock() {
  const pauses: number[] = [];
  return {
    pauses,
    sleep: (ms: number) => {
      pauses.push(ms);
      return Promise.resolve();
    },
    now: () => 0,
  };
}

// Answers the probes with the given values in turn, and keeps repeating the last one.
function probeOf<T>(first: T, ...later: T[]) {
  const values = [first, ...later];
  let calls = 0;
  const probe = () => {
    const value = values[Math.min(calls, values.length - 1)] ?? first;
    calls += 1;
    return Promise.resolve(value);
  };
  return { probe, calls: () => calls };
}

const isTrue = (value: boolean) => value;

test('pollUntil returns at once, without sleeping, when the first probe is satisfied', async () => {
  const clock = instantClock();
  const { probe, calls } = probeOf(true);

  const result = await pollUntil(probe, isTrue, { intervalMs: 500, timeoutMs: 5000, ...clock });

  expect(result).toEqual({ satisfied: true, last: true, waitedMs: 0 });
  expect(calls()).toBe(1);
  expect(clock.pauses).toEqual([]);
});

test('pollUntil probes again after each interval until the probe is satisfied', async () => {
  const clock = instantClock();
  const { probe, calls } = probeOf(false, false, true);

  const result = await pollUntil(probe, isTrue, { intervalMs: 500, timeoutMs: 5000, ...clock });

  expect(result).toEqual({ satisfied: true, last: true, waitedMs: 1000 });
  expect(calls()).toBe(3);
  expect(clock.pauses).toEqual([500, 500]);
});

test('pollUntil hands the satisfying value of the probe back, not only a flag', async () => {
  const clock = instantClock();
  const { probe } = probeOf({ tabs: 0 }, { tabs: 3 });

  const result = await pollUntil(probe, ({ tabs }) => tabs > 1, {
    intervalMs: 500,
    timeoutMs: 5000,
    ...clock,
  });

  expect(result).toEqual({ satisfied: true, last: { tabs: 3 }, waitedMs: 500 });
});

test('pollUntil gives up at the timeout and hands back the last value it saw', async () => {
  const clock = instantClock();
  const { probe, calls } = probeOf('starting', 'still starting', 'stuck');

  const result = await pollUntil(probe, (value) => value === 'ready', {
    intervalMs: 500,
    timeoutMs: 1000,
    ...clock,
  });

  expect(result).toEqual({ satisfied: false, last: 'stuck', waitedMs: 1000 });
  expect(calls()).toBe(3);
  expect(clock.pauses).toEqual([500, 500]);
});

test('pollUntil shortens the last pause so that it does not sleep past the deadline', async () => {
  const clock = instantClock();
  const { probe, calls } = probeOf(false);

  const result = await pollUntil(probe, isTrue, { intervalMs: 500, timeoutMs: 1200, ...clock });

  expect(clock.pauses).toEqual([500, 500, 200]);
  expect(result.waitedMs).toBe(1200);
  expect(calls()).toBe(4);
});

test('pollUntil probes once more at the deadline, so an answer that arrives then counts', async () => {
  const clock = instantClock();
  const { probe } = probeOf(false, false, true);

  const result = await pollUntil(probe, isTrue, { intervalMs: 500, timeoutMs: 1000, ...clock });

  expect(result).toEqual({ satisfied: true, last: true, waitedMs: 1000 });
});

test('pollUntil counts the time a probe takes, which a slow health check makes much longer than the pauses', async () => {
  let clock = 0;
  const pauses: number[] = [];
  let calls = 0;
  // Each probe takes 10 s, like a stuck app that makes the health check run into its deadline.
  const probe = () => {
    calls += 1;
    clock += 10_000;
    return Promise.resolve(false);
  };

  const result = await pollUntil(probe, isTrue, {
    intervalMs: 500,
    timeoutMs: 15_000,
    sleep: (ms) => {
      pauses.push(ms);
      return Promise.resolve();
    },
    now: () => clock,
  });

  // The second probe ends at 20 s, past the 15 s limit, so there is no third one.
  expect(calls).toBe(2);
  expect(pauses).toEqual([500]);
  expect(result).toEqual({ satisfied: false, last: false, waitedMs: 20_000 });
});

test.each([
  ['zero', 0],
  ['negative', -1],
  ['not a number', Number.NaN],
])('pollUntil probes once and stops when the timeout is %s', async (_label, timeoutMs) => {
  const clock = instantClock();
  const { probe, calls } = probeOf(false);

  const result = await pollUntil(probe, isTrue, { intervalMs: 500, timeoutMs, ...clock });

  expect(result.satisfied).toBe(false);
  expect(calls()).toBe(1);
  expect(clock.pauses).toEqual([]);
});

test('pollUntil lets the failure of a probe through', async () => {
  const clock = instantClock();
  const failure = new Error('the probe broke');

  await expect(
    pollUntil(() => Promise.reject(failure), isTrue, {
      intervalMs: 500,
      timeoutMs: 5000,
      ...clock,
    }),
  ).rejects.toBe(failure);
});

test('pollUntil sleeps and measures with the real timer and clock unless told otherwise', async () => {
  vi.useFakeTimers();
  const { probe } = probeOf(false, true);
  let settled = false;
  const waiting = pollUntil(probe, isTrue, { intervalMs: 500, timeoutMs: 5000 }).then((result) => {
    settled = true;
    return result;
  });

  await vi.advanceTimersByTimeAsync(499);
  expect(settled).toBe(false);

  await vi.advanceTimersByTimeAsync(1);
  const result = await waiting;

  expect(result).toEqual({ satisfied: true, last: true, waitedMs: 500 });
});
