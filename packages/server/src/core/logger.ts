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
  return pino({ level: options.level }, options.destination ?? pino.destination(STDERR_FD));
}
