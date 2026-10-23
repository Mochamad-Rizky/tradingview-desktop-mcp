import { ApiError } from './client';
import { createQueryClient } from './query-client';

test('the query client retries a failure on the way or of the server twice, and never a refused request', () => {
  const retry = createQueryClient().getDefaultOptions().queries?.retry;
  if (typeof retry !== 'function') {
    throw new Error('retry is not a function');
  }
  const offline = new TypeError('Failed to fetch');
  const serverError = new ApiError(502, 'The server answered 502');
  expect([0, 1, 2].map((count) => retry(count, offline))).toEqual([true, true, false]);
  expect([0, 1, 2].map((count) => retry(count, serverError))).toEqual([true, true, false]);
  expect(retry(0, new ApiError(401, 'Invalid token'))).toBe(false);
  expect(retry(0, new ApiError(404, 'Not found'))).toBe(false);
  expect(createQueryClient().getDefaultOptions().mutations?.retry).toBe(false);
});
