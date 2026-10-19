import { CapabilityError, isTvMcpError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { Tier } from '../result.js';

// One way to carry out an operation. A tool lists its strategies from the most direct to the least
// (the public API, the app's internals, the DOM, the keyboard) and runWithFallback tries them in
// that order.
//
// `run` raises CAPABILITY_UNAVAILABLE when its way is not open on this page, and it does so before
// it has acted on anything. That is the only failure that lets another strategy take over; any
// other one may have come after the operation started.
export interface Strategy<T> {
  tier: Tier;
  // How the strategy is called in the log and in the error of an operation that none could do.
  name: string;
  run(): Promise<T>;
}

// Runs the strategies one at a time and returns the value of the first that succeeds, with the
// tier it ran in. Only CAPABILITY_UNAVAILABLE moves on to the next strategy. Every other error
// ends the run and reaches the caller as it was, so an operation is never carried out twice, once
// by a strategy that failed halfway and again by the next one.
export async function runWithFallback<T>(
  strategies: Strategy<T>[],
  logger: Logger,
): Promise<{ value: T; via: Tier }> {
  const attempts: string[] = [];
  for (const strategy of strategies) {
    let value: T;
    try {
      value = await strategy.run();
    } catch (error) {
      // Judged by the code: the CDP adapter and the page bridge raise this code as a plain
      // TvMcpError. An object that only looks like one is still no reason to move on.
      if (!isTvMcpError(error) || error.code !== 'CAPABILITY_UNAVAILABLE') {
        throw error;
      }
      attempts.push(strategy.name);
      logger.debug(
        { strategy: strategy.name, tier: strategy.tier, message: error.message },
        'A strategy is unavailable',
      );
      continue;
    }
    return { value, via: strategy.tier };
  }
  throw new CapabilityError(
    attempts.length === 0
      ? 'The operation has no strategy to try'
      : `The operation is unavailable through every strategy: ${attempts.join(', ')}`,
    attempts,
  );
}
