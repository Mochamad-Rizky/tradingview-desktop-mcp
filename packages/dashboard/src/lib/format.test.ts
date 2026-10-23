import { ApiError } from '@/api/client';
import { failureText, formatCount, formatDateTime, formatDuration, formatTime } from './format';

test('numbers and durations are written in English, with grouped digits', () => {
  expect(formatCount(1000)).toBe('1,000');
  expect(formatCount(7)).toBe('7');
  expect(formatDuration(30_000)).toBe('30,000 ms');
});

test('times are shown on the browser clock, and a value that is no time as it is', () => {
  const at = '2026-01-02T03:04:05.000Z';
  const local = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  expect(formatTime(at)).toBe(
    `${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}`,
  );
  expect(formatDateTime(at)).toContain(String(local.getFullYear()));
  expect(formatTime('not a time')).toBe('not a time');
  expect(formatDateTime('')).toBe('');
});

test('a failure is told by the message of the server, or as a server out of reach', () => {
  expect(failureText(new ApiError(503, 'The server is shutting down'))).toBe(
    'The server is shutting down',
  );
  expect(failureText(new TypeError('Failed to fetch'))).toBe('The server could not be reached');
});
