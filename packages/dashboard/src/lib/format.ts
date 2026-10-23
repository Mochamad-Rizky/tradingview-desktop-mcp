import { ApiError } from '@/api/client';

// How the dashboard writes numbers, times and durations: in English, in the browser's time zone.

const COUNT = new Intl.NumberFormat('en-US');
const TIME = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
const DATE_TIME = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const FULL_TIME = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'medium',
  hourCycle: 'h23',
});

export function formatCount(value: number): string {
  return COUNT.format(value);
}

export function formatDuration(ms: number): string {
  return `${COUNT.format(ms)} ms`;
}

// A value that is not a time is shown as it is.
function formatWith(format: Intl.DateTimeFormat, iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : format.format(date);
}

// An ISO 8601 time as HH:mm:ss.
export function formatTime(iso: string): string {
  return formatWith(TIME, iso);
}

// An ISO 8601 time with its date, such as "1 Jan 2026, 09:30".
export function formatDateTime(iso: string): string {
  return formatWith(DATE_TIME, iso);
}

// An ISO 8601 time with its date, to the second, such as "1 Jan 2026, 09:30:05".
export function formatFullTime(iso: string): string {
  return formatWith(FULL_TIME, iso);
}

// Why a request failed, to follow a colon: the server's own message, or that it could not be
// reached at all.
export function failureText(error: unknown): string {
  return error instanceof ApiError ? error.message : 'The server could not be reached';
}
