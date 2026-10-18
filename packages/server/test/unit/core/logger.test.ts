import pino from 'pino';
import { createLogger } from '../../../src/core/logger.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function collectLines(): { lines: string[]; destination: pino.DestinationStream } {
  const lines: string[] = [];
  return {
    lines,
    destination: {
      write: (line) => {
        lines.push(line);
      },
    },
  };
}

function parseLine(line: string | undefined): unknown {
  const parsed: unknown = JSON.parse(line ?? '');
  return parsed;
}

test('logger writes to the given destination and never to stdout', () => {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const { lines, destination } = collectLines();

  createLogger({ level: 'info', destination }).info({ tool: 'chart_get_state' }, 'tool finished');

  expect(stdout).not.toHaveBeenCalled();
  expect(lines).toHaveLength(1);
  // 30 is pino's numeric value for the info level.
  expect(parseLine(lines[0])).toMatchObject({
    level: 30,
    msg: 'tool finished',
    tool: 'chart_get_state',
  });
});

test('logger drops records below the configured level', () => {
  const { lines, destination } = collectLines();
  const logger = createLogger({ level: 'warn', destination });

  logger.debug('debug detail');
  logger.info('routine');
  logger.warn('degraded');
  logger.error('failed');

  expect(lines.map((line) => parseLine(line))).toMatchObject([
    { msg: 'degraded' },
    { msg: 'failed' },
  ]);
});

// pino writes through file descriptors, which bypasses process.stdout.write, so the stdout spy
// above cannot catch a logger that defaults to fd 1. Stdout carries JSON-RPC in stdio mode.
test('logger defaults to stderr (file descriptor 2) when no destination is given', () => {
  const { lines, destination } = collectLines();
  const open = vi
    .spyOn(pino, 'destination')
    .mockReturnValue(destination as unknown as ReturnType<typeof pino.destination>);

  createLogger({ level: 'info' }).info('hello');

  expect(open).toHaveBeenCalledWith(2);
  expect(lines).toHaveLength(1);
  expect(parseLine(lines[0])).toMatchObject({ msg: 'hello' });
});
