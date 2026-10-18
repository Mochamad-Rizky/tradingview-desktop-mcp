import { sleep as defaultSleep } from './timeout.js';

export interface PollOptions {
  intervalMs: number;
  // Not validated here: a value that is not a positive number ends the wait after the first probe.
  timeoutMs: number;
  // Replaceable so that tests of the callers can run a long wait without waiting.
  sleep?: (ms: number) => Promise<void>;
  // Replaceable so that a test can make the probes take time.
  now?: () => number;
}

export interface PollResult<T> {
  satisfied: boolean;
  // The last value the probe returned, whether or not it satisfied the caller. A caller that gave
  // up uses it to say how far the thing it waited for got.
  last: T;
  waitedMs: number;
}

// Runs `probe` until `isDone` accepts what it returns or `timeoutMs` has passed, with `intervalMs`
// between the runs. The probe always runs at least once, and once more at the deadline, so an
// answer that arrives at the last moment still counts.
export async function pollUntil<T>(
  probe: () => Promise<T>,
  isDone: (value: T) => boolean,
  options: PollOptions,
): Promise<PollResult<T>> {
  const { intervalMs, timeoutMs } = options;
  const wait = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  let slept = 0;
  // The time spent in the probes counts, because a probe of an app that is stuck can take as long
  // as its own timeout, and a wait that only added up its pauses would then run far past the
  // limit. The pauses count too, so that a test with a sleep that returns at once still sees the
  // limit come closer.
  const elapsed = () => Math.max(now() - startedAt, slept);

  for (;;) {
    const last = await probe();
    if (isDone(last)) {
      return { satisfied: true, last, waitedMs: Math.round(elapsed()) };
    }
    const remaining = timeoutMs - elapsed();
    // Phrased as "not above zero" so that a NaN limit ends the wait here instead of never.
    if (!(remaining > 0)) {
      return { satisfied: false, last, waitedMs: Math.round(elapsed()) };
    }
    const pause = Math.min(intervalMs, remaining);
    await wait(pause);
    slept += pause;
  }
}
