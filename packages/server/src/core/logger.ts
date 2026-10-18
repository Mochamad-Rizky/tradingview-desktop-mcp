import pino from 'pino';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

export type Logger = pino.Logger;

const STDERR_FD = 2;

export function createLogger(options: {
  level: LogLevel;
  destination?: pino.DestinationStream;
}): Logger {
  // Stdout carries JSON-RPC in stdio mode, and pino writes to it when it is not given a
  // destination, so every logger gets one explicitly and the default is stderr.
  // The default is synchronous because the CLI banner and fatal errors are written straight to
  // stderr: an asynchronous destination would print log lines after them, and would leave lines in
  // its buffer if the process dies before the next tick.
  const destination = options.destination ?? pino.destination({ dest: STDERR_FD, sync: true });
  return pino({ level: options.level }, destination);
}
