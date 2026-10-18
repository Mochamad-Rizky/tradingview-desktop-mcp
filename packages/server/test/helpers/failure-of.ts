import { TvMcpError } from '../../src/core/errors.js';

// Resolves with the error of a call that must fail with one of ours, so a test can look at its
// code, details and payload. A call that succeeds, or fails with any other error, fails the test.
export async function failureOf(call: Promise<unknown>): Promise<TvMcpError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof TvMcpError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the call to reject');
}
