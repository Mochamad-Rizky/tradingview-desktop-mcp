import { sleep } from './timeout.js';

export interface RetryOptions {
  // Retries after the first attempt, so `retries: 3` allows up to 4 calls.
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  shouldRetry: (err: unknown) => boolean;
  // Replaceable so that tests can check the backoff without waiting and without randomness.
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

// Exponential backoff with full jitter: the wait after failed attempt n (counting from 0) is drawn
// uniformly between 0 and min(maxDelayMs, baseDelayMs * 2^n). Using the whole window, instead of
// adding a little noise to a fixed delay, keeps clients that failed at the same moment from coming
// back together.
export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const { retries, baseDelayMs, maxDelayMs, shouldRetry } = options;
  const wait = options.sleep ?? sleep;
  const random = options.random ?? Math.random;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      // Phrased as "attempt < retries" rather than "attempt >= retries" so that a NaN count ends
      // the loop here instead of retrying forever. The last error is rethrown as it came.
      const retrying = attempt < retries && shouldRetry(error);
      if (!retrying) {
        throw error;
      }
      await wait(random() * Math.min(maxDelayMs, baseDelayMs * 2 ** attempt));
    }
  }
}
