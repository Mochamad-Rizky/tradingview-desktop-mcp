import { TimeoutError } from '../core/errors.js';

export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Some TradingView debug targets accept a connection and then never answer, so every CDP call
// needs a deadline that always fires. The timer is cleared on every outcome, because one left
// behind would keep the process alive for the rest of the deadline after the work has finished.
// It is not unref'd on purpose: it is what stops a pending call from letting the process exit
// without ever reporting TIMEOUT.
export async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(label, ms));
    }, ms);
  });
  try {
    // The race keeps a handler on `work`, so a failure that arrives after the deadline is not
    // reported as an unhandled rejection. A failure before it passes through unchanged.
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
