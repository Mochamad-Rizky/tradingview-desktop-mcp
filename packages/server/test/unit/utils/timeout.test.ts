import { TimeoutError } from '../../../src/core/errors.js';
import { sleep, withTimeout } from '../../../src/utils/timeout.js';

afterEach(() => {
  vi.useRealTimers();
});

// Work that never answers, like a TradingView debug target that accepts the connection and then
// stays silent. Every deadline in these tests exists for this case.
function silence<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

test('withTimeout resolves fast work', async () => {
  vi.useFakeTimers();

  await expect(withTimeout(Promise.resolve('bars'), 1000, 'Runtime.evaluate')).resolves.toBe(
    'bars',
  );
});

test('withTimeout rejects slow work with TIMEOUT', async () => {
  vi.useFakeTimers();
  const guarded = withTimeout(silence<string>(), 1000, 'Runtime.evaluate');
  // The handler goes on before the timer fires, or the rejection would be reported as unhandled.
  const outcome = expect(guarded).rejects.toMatchObject({
    code: 'TIMEOUT',
    details: { label: 'Runtime.evaluate', ms: 1000 },
  });

  await vi.advanceTimersByTimeAsync(1000);

  await outcome;
  await expect(guarded).rejects.toBeInstanceOf(TimeoutError);
});

test('withTimeout waits for the whole duration before it gives up', async () => {
  vi.useFakeTimers();
  const gaveUp = vi.fn<(reason: unknown) => void>();
  withTimeout(silence<string>(), 1000, 'Runtime.evaluate').catch(gaveUp);

  await vi.advanceTimersByTimeAsync(999);
  expect(gaveUp).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1);
  expect(gaveUp).toHaveBeenCalledOnce();
});

test('withTimeout clears its timer once the work resolves', async () => {
  vi.useFakeTimers();

  await withTimeout(Promise.resolve('bars'), 1000, 'Runtime.evaluate');

  // A timer left behind would keep the process alive for the full deadline.
  expect(vi.getTimerCount()).toBe(0);
});

test('withTimeout passes the rejection of the work through and clears its timer', async () => {
  vi.useFakeTimers();
  const failure = new Error('Target closed');

  await expect(withTimeout(Promise.reject(failure), 1000, 'Runtime.evaluate')).rejects.toBe(
    failure,
  );

  expect(vi.getTimerCount()).toBe(0);
});

test('withTimeout leaves no unhandled rejection when timed-out work fails later', async () => {
  const unhandled: unknown[] = [];
  const record = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', record);
  try {
    vi.useFakeTimers();
    let failWork: (reason: Error) => void = () => undefined;
    const work = new Promise<string>((_resolve, reject) => {
      failWork = reject;
    });
    const guarded = withTimeout(work, 1000, 'Runtime.evaluate');
    const outcome = expect(guarded).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await outcome;

    // The page answers after the deadline, which is common when the target was only slow.
    failWork(new Error('Target closed after the deadline'));
    // Node reports unhandled rejections once the microtask queue drains, so give it a real turn.
    vi.useRealTimers();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  } finally {
    process.off('unhandledRejection', record);
  }

  expect(unhandled).toEqual([]);
});

test('sleep resolves after the given delay', async () => {
  vi.useFakeTimers();
  const woke = vi.fn<() => void>();
  void sleep(500).then(woke);

  await vi.advanceTimersByTimeAsync(499);
  expect(woke).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1);
  expect(woke).toHaveBeenCalledOnce();
});
