import { retry } from '../../../src/utils/retry.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// Records the delays instead of waiting for them, so most tests need neither fake timers nor time.
function makeSleep() {
  const delays: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    delays.push(ms);
    return Promise.resolve();
  };
  return { delays, sleep };
}

// Fails with failures[attempt] while there is one, then succeeds with `result`. `calls` holds the
// attempt index of every call, which is what retry hands to its function.
function makeFlaky<T>(failures: readonly Error[], result: T) {
  const calls: number[] = [];
  const fn = (attempt: number): Promise<T> => {
    calls.push(attempt);
    const failure = failures[attempt];
    return failure === undefined ? Promise.resolve(result) : Promise.reject(failure);
  };
  return { calls, fn };
}

function makeFailures(count: number): Error[] {
  return Array.from({ length: count }, (_unused, n) => new Error(`failure ${String(n + 1)}`));
}

const BACKOFF = { baseDelayMs: 100, maxDelayMs: 400 } as const;
const retryAlways = (): boolean => true;

test('retry returns the first success without sleeping', async () => {
  const { delays, sleep } = makeSleep();
  const { calls, fn } = makeFlaky([], 'bars');

  await expect(
    retry(fn, { retries: 3, ...BACKOFF, shouldRetry: retryAlways, sleep }),
  ).resolves.toBe('bars');

  expect(calls).toEqual([0]);
  expect(delays).toEqual([]);
});

test('retry stops after the configured retries', async () => {
  const { sleep } = makeSleep();
  const failures = makeFailures(4);
  // A fifth call would succeed, so reaching it would show up as a resolved promise.
  const { calls, fn } = makeFlaky(failures, 'unreachable');

  await expect(retry(fn, { retries: 3, ...BACKOFF, shouldRetry: retryAlways, sleep })).rejects.toBe(
    failures[3],
  );

  expect(calls).toHaveLength(4);
});

test('retry does not retry when shouldRetry returns false', async () => {
  const { delays, sleep } = makeSleep();
  const failures = makeFailures(1);
  const { calls, fn } = makeFlaky(failures, 'unreachable');
  const shouldRetry = vi.fn<(err: unknown) => boolean>(() => false);

  await expect(retry(fn, { retries: 3, ...BACKOFF, shouldRetry, sleep })).rejects.toBe(failures[0]);

  expect(calls).toEqual([0]);
  expect(shouldRetry).toHaveBeenCalledExactlyOnceWith(failures[0]);
  expect(delays).toEqual([]);
});

test('retry delays grow exponentially and are capped', async () => {
  const { delays, sleep } = makeSleep();
  const { fn } = makeFlaky(makeFailures(4), 'unreachable');

  await expect(
    retry(fn, { retries: 3, ...BACKOFF, shouldRetry: retryAlways, sleep, random: () => 1 }),
  ).rejects.toThrow('failure 4');

  expect(delays).toEqual([100, 200, 400]);
});

test('retry never waits longer than maxDelayMs', async () => {
  const { delays, sleep } = makeSleep();
  const { fn } = makeFlaky(makeFailures(6), 'unreachable');

  await expect(
    retry(fn, { retries: 5, ...BACKOFF, shouldRetry: retryAlways, sleep, random: () => 1 }),
  ).rejects.toThrow('failure 6');

  // 800 and 1600 would follow 400 without the cap.
  expect(delays).toEqual([100, 200, 400, 400, 400]);
});

// Full jitter scales the whole backoff window, down to nothing, so many clients that failed at the
// same moment do not come back together.
test.each([
  [0, [0, 0, 0]],
  [0.25, [25, 50, 100]],
  [0.5, [50, 100, 200]],
])('retry draws each delay from random() = %s of the backoff window', async (draw, expected) => {
  const { delays, sleep } = makeSleep();
  const { fn } = makeFlaky(makeFailures(4), 'unreachable');

  await expect(
    retry(fn, { retries: 3, ...BACKOFF, shouldRetry: retryAlways, sleep, random: () => draw }),
  ).rejects.toThrow('failure 4');

  expect(delays).toEqual(expected);
});

test('retry hands fn a 0-based attempt index and returns the eventual success', async () => {
  const { delays, sleep } = makeSleep();
  const { calls, fn } = makeFlaky(makeFailures(2), 'bars');

  await expect(
    retry(fn, { retries: 3, ...BACKOFF, shouldRetry: retryAlways, sleep, random: () => 1 }),
  ).resolves.toBe('bars');

  expect(calls).toEqual([0, 1, 2]);
  expect(delays).toEqual([100, 200]);
});

test('retry asks shouldRetry before each retry, and not once the retries are used up', async () => {
  const { sleep } = makeSleep();
  const failures = makeFailures(3);
  const { fn } = makeFlaky(failures, 'unreachable');
  const shouldRetry = vi.fn<(err: unknown) => boolean>(() => true);

  await expect(retry(fn, { retries: 2, ...BACKOFF, shouldRetry, sleep })).rejects.toBe(failures[2]);

  // Only the failures that are followed by a retry are put to the question.
  expect(shouldRetry.mock.calls).toEqual([[failures[0]], [failures[1]]]);
});

test('retry stops at the first error that shouldRetry refuses', async () => {
  const { delays, sleep } = makeSleep();
  const failures = makeFailures(4);
  const fatal = failures[1];
  const { calls, fn } = makeFlaky(failures, 'unreachable');

  await expect(
    retry(fn, { retries: 3, ...BACKOFF, shouldRetry: (err) => err !== fatal, sleep }),
  ).rejects.toBe(fatal);

  expect(calls).toEqual([0, 1]);
  expect(delays).toHaveLength(1);
});

test('retry with zero retries calls fn once', async () => {
  const { delays, sleep } = makeSleep();
  const failures = makeFailures(2);
  const { calls, fn } = makeFlaky(failures, 'unreachable');
  const shouldRetry = vi.fn<(err: unknown) => boolean>(() => true);

  await expect(retry(fn, { retries: 0, ...BACKOFF, shouldRetry, sleep })).rejects.toBe(failures[0]);

  expect(calls).toEqual([0]);
  expect(shouldRetry).not.toHaveBeenCalled();
  expect(delays).toEqual([]);
});

test('retry rethrows a rejection reason that is not an Error unchanged', async () => {
  // CDP clients commonly reject with a plain protocol error object rather than an Error, which is
  // exactly what the lint rule below forbids and what this test needs.
  const reason = { code: -32000, message: 'Target closed' };
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- see above
  const fn = (): Promise<never> => Promise.reject(reason);

  await expect(retry(fn, { retries: 0, ...BACKOFF, shouldRetry: retryAlways })).rejects.toBe(
    reason,
  );
});

test('retry sleeps for real and draws its jitter from Math.random by default', async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const { calls, fn } = makeFlaky(makeFailures(1), 'bars');
  const settled = vi.fn<(value: string) => void>();
  void retry(fn, { retries: 1, ...BACKOFF, shouldRetry: retryAlways }).then(settled);

  // Half of the 100 ms window of the first retry.
  await vi.advanceTimersByTimeAsync(49);
  expect(calls).toEqual([0]);
  expect(settled).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1);
  expect(calls).toEqual([0, 1]);
  expect(settled).toHaveBeenCalledExactlyOnceWith('bars');
});
