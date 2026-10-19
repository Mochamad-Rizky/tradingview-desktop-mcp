import { setImmediate as nextMacrotask } from 'node:timers/promises';
import {
  CapabilityError,
  ERROR_CODES,
  PlanLimitError,
  TvMcpError,
} from '../../../../src/core/errors.js';
import { createLogger, type Logger } from '../../../../src/core/logger.js';
import type { Tier } from '../../../../src/core/result.js';
import { runWithFallback, type Strategy } from '../../../../src/core/tv/tiers.js';
import { failureOf } from '../../../helpers/failure-of.js';

// The tier runner tries the strategies of one operation in order, and moves on only when a
// strategy says the capability it needs is not there.

// A logger that keeps the records pino writes, so a test can look at what was logged.
function recordingLogger(): { logger: Logger; records: unknown[] } {
  const records: unknown[] = [];
  const logger = createLogger({
    level: 'debug',
    destination: {
      write: (line) => {
        records.push(JSON.parse(line));
      },
    },
  });
  return { logger, records };
}

// Strategies that note in `ran` when they start, and then do what `act` does. A throw in `act`
// becomes a rejection, the way a strategy fails when it awaits a page function.
function strategies(): {
  ran: string[];
  make: (name: string, tier: Tier, act: () => unknown) => Strategy<unknown>;
} {
  const ran: string[] = [];
  return {
    ran,
    make: (name, tier, act) => ({
      tier,
      name,
      run: () => {
        ran.push(name);
        return Promise.resolve().then(act);
      },
    }),
  };
}

function raise(failure: unknown): () => never {
  return () => {
    throw failure;
  };
}

describe('runWithFallback', () => {
  test('returns the first strategy that succeeds and reports its tier', async () => {
    const { logger, records } = recordingLogger();
    const { ran, make } = strategies();

    const result = await runWithFallback(
      [
        make('read via api', 'api', () => 'from api'),
        make('read via dom', 'dom', () => 'from dom'),
      ],
      logger,
    );

    expect(result).toEqual({ value: 'from api', via: 'api' });
    expect(ran).toEqual(['read via api']);
    // Nothing was skipped, so there is nothing to say.
    expect(records).toEqual([]);
  });

  test('reports an action that resolves with nothing, and the tier it ran in', async () => {
    const { logger } = recordingLogger();
    const { make } = strategies();

    const result = await runWithFallback(
      [make('press the key', 'keyboard', () => undefined)],
      logger,
    );

    expect(result).toEqual({ value: undefined, via: 'keyboard' });
  });

  test('falls through only on CAPABILITY_UNAVAILABLE', async () => {
    const { logger } = recordingLogger();
    const { ran, make } = strategies();

    const result = await runWithFallback(
      [
        make('api', 'api', raise(new CapabilityError('TradingViewApi is missing'))),
        make('internal', 'internal', raise(new CapabilityError('The chart model is missing'))),
        make('dom', 'dom', () => 'from dom'),
        make('keyboard', 'keyboard', () => 'from keyboard'),
      ],
      logger,
    );

    // The tier that answered, not the first one that was tried, and nothing after it ran.
    expect(result).toEqual({ value: 'from dom', via: 'dom' });
    expect(ran).toEqual(['api', 'internal', 'dom']);
  });

  // The CDP adapter raises this code as a plain TvMcpError for a method the page does not know,
  // and the page bridge does for a sentinel a page function returns. Neither is a CapabilityError,
  // so the runner has to go by the code.
  test('falls through on a TvMcpError that carries the code but is no CapabilityError', async () => {
    const { logger } = recordingLogger();
    const { ran, make } = strategies();

    const result = await runWithFallback(
      [
        make(
          'api',
          'api',
          raise(new TvMcpError('CAPABILITY_UNAVAILABLE', 'CDP Runtime.evaluate is unknown')),
        ),
        make('dom', 'dom', () => 'from dom'),
      ],
      logger,
    );

    expect(result).toEqual({ value: 'from dom', via: 'dom' });
    expect(ran).toEqual(['api', 'dom']);
  });

  test('stops on any other error without running later strategies', async () => {
    const { logger } = recordingLogger();
    const { ran, make } = strategies();
    const failure = new PlanLimitError('INDICATORS_ON_CHART', 2);

    await expect(
      runWithFallback(
        [make('api', 'api', raise(failure)), make('dom', 'dom', () => 'from dom')],
        logger,
      ),
    ).rejects.toBe(failure);

    expect(ran).toEqual(['api']);
  });

  // The operation may already have acted when a strategy fails with anything but this code, so
  // trying another way could do it twice.
  test.each(ERROR_CODES.filter((code) => code !== 'CAPABILITY_UNAVAILABLE'))(
    'does not fall through on %s',
    async (code) => {
      const { logger } = recordingLogger();
      const { ran, make } = strategies();
      const failure = new TvMcpError(code, 'The first strategy failed');

      await expect(
        runWithFallback(
          [
            make('internal', 'internal', raise(new CapabilityError('The model is missing'))),
            make('dom', 'dom', raise(failure)),
            make('keyboard', 'keyboard', () => 'from keyboard'),
          ],
          logger,
        ),
      ).rejects.toBe(failure);

      expect(ran).toEqual(['internal', 'dom']);
    },
  );

  // What is not one of our errors is a bug or a thrown value of the page, and the caller that logs
  // it needs it as it was. An object that merely looks like ours must not pass for it either.
  test.each<[string, unknown]>([
    ['an Error', new Error('boom')],
    ['a TypeError', new TypeError('x is not a function')],
    ['a string', 'boom'],
    ['null', null],
    ['undefined', undefined],
    ['an object that has the code', { code: 'CAPABILITY_UNAVAILABLE', message: 'no api' }],
    [
      'an Error that has the code',
      Object.assign(new Error('no api'), { code: 'CAPABILITY_UNAVAILABLE' }),
    ],
  ])('rethrows %s unchanged and stops', async (_case, failure) => {
    const { logger } = recordingLogger();
    const { ran, make } = strategies();

    await expect(
      runWithFallback(
        [make('api', 'api', raise(failure)), make('dom', 'dom', () => 'from dom')],
        logger,
      ),
    ).rejects.toBe(failure);

    expect(ran).toEqual(['api']);
  });

  test('treats a strategy that throws instead of rejecting like one that rejects', async () => {
    const { logger } = recordingLogger();
    const unavailable: Strategy<string> = {
      tier: 'api',
      name: 'api',
      run: raise(new CapabilityError('TradingViewApi is missing')),
    };
    const failure = new Error('boom');
    const broken: Strategy<string> = { tier: 'internal', name: 'internal', run: raise(failure) };
    const fallback: Strategy<string> = {
      tier: 'dom',
      name: 'dom',
      run: () => Promise.resolve('from dom'),
    };

    await expect(runWithFallback([unavailable, fallback], logger)).resolves.toEqual({
      value: 'from dom',
      via: 'dom',
    });
    await expect(runWithFallback([unavailable, broken, fallback], logger)).rejects.toBe(failure);
  });

  test('aggregates attempts when every strategy is unavailable', async () => {
    const { logger } = recordingLogger();
    const { ran, make } = strategies();

    const error = await failureOf(
      runWithFallback(
        [
          make('read via api', 'api', raise(new CapabilityError('TradingViewApi is missing'))),
          make('read via model', 'internal', raise(new CapabilityError('No chart model'))),
          make('read via dom', 'dom', raise(new CapabilityError('No toolbar'))),
        ],
        logger,
      ),
    );

    expect(error).toBeInstanceOf(CapabilityError);
    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(error.details).toEqual({ attempts: ['read via api', 'read via model', 'read via dom'] });
    // Each strategy was tried once.
    expect(ran).toEqual(['read via api', 'read via model', 'read via dom']);
  });

  test('names the strategies it tried in its message', async () => {
    const { logger } = recordingLogger();
    const { make } = strategies();

    const error = await failureOf(
      runWithFallback(
        [
          make('read via api', 'api', raise(new CapabilityError('TradingViewApi is missing'))),
          make('read via dom', 'dom', raise(new CapabilityError('No toolbar'))),
        ],
        logger,
      ),
    );

    expect(error.message).toMatch(/unavailable through every strategy/);
    expect(error.message.indexOf('read via api')).toBeGreaterThan(-1);
    expect(error.message.indexOf('read via dom')).toBeGreaterThan(
      error.message.indexOf('read via api'),
    );
  });

  test('fails with no attempts when it is given no strategy', async () => {
    const { logger } = recordingLogger();

    const error = await failureOf(runWithFallback([], logger));

    expect(error).toBeInstanceOf(CapabilityError);
    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(error.details).toEqual({ attempts: [] });
  });

  test('starts a strategy only after the one before it has ended', async () => {
    const { logger } = recordingLogger();
    const events: string[] = [];
    const slowAndUnavailable = (name: string, tier: Tier): Strategy<string> => ({
      tier,
      name,
      run: async () => {
        events.push(`${name} started`);
        await nextMacrotask();
        events.push(`${name} ended`);
        throw new CapabilityError(`${name} is not there`);
      },
    });

    await runWithFallback(
      [
        slowAndUnavailable('api', 'api'),
        slowAndUnavailable('internal', 'internal'),
        { tier: 'dom', name: 'dom', run: () => Promise.resolve('from dom') },
      ],
      logger,
    );

    expect(events).toEqual(['api started', 'api ended', 'internal started', 'internal ended']);
  });

  // The message of a failure can carry what the page said, such as how it describes an element,
  // so only the name of the strategy, a fixed label, and the code go to the log.
  test('logs each strategy it skips at debug level, with its name and the code, never the message', async () => {
    const { logger, records } = recordingLogger();
    const { make } = strategies();

    await runWithFallback(
      [
        make('api', 'api', raise(new CapabilityError('TradingViewApi is missing'))),
        make(
          'internal',
          'internal',
          raise(new TvMcpError('CAPABILITY_UNAVAILABLE', 'div#private-layout-name is missing')),
        ),
        make('dom', 'dom', () => 'from dom'),
      ],
      logger,
    );

    // 20 is pino's numeric value for the debug level. The skipped strategies are the only
    // records: the one that answered is not logged.
    expect(records).toMatchObject([
      { level: 20, strategy: 'api', code: 'CAPABILITY_UNAVAILABLE' },
      { level: 20, strategy: 'internal', code: 'CAPABILITY_UNAVAILABLE' },
    ]);
    for (const record of records) {
      expect(record).not.toHaveProperty('message');
      expect(record).not.toHaveProperty('tier');
      expect(JSON.stringify(record)).not.toContain('missing');
    }
  });

  test('logs the strategies it tried before it gave up', async () => {
    const { logger, records } = recordingLogger();
    const { make } = strategies();

    await failureOf(
      runWithFallback(
        [
          make('api', 'api', raise(new CapabilityError('TradingViewApi is missing'))),
          make('dom', 'dom', raise(new CapabilityError('No toolbar'))),
        ],
        logger,
      ),
    );

    expect(records).toMatchObject([
      { level: 20, strategy: 'api' },
      { level: 20, strategy: 'dom' },
    ]);
  });
});
