import { loadConfig } from '../../src/config/load.js';
import type { Config } from '../../src/config/schema.js';
import { ConnectionManager, type ConnectionManagerDeps } from '../../src/core/connection.js';
import { TvMcpError } from '../../src/core/errors.js';
import { ToolEventBus } from '../../src/core/events.js';
import type { Launcher } from '../../src/core/launcher/launch.js';
import { createLogger, type Logger } from '../../src/core/logger.js';
import type { ToolContext } from '../../src/tools/types.js';

// The pieces a tool handler runs with, for tests that must not reach any app: the debug port never
// answers and the launcher refuses to start anything. A test replaces the piece it is about.

export const quietLogger: Logger = createLogger({
  level: 'silent',
  destination: { write: () => undefined },
});

// A logger that keeps every line it writes, parsed, so a test can look at what was logged.
export function capturingLogger(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    level: 'debug',
    destination: {
      write: (line: string) => {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  });
  return { logger, lines };
}

// Port 9 (discard) instead of the default 9222: should a test reach the network by mistake, it
// must not reach a TradingView that happens to run with the debug port open.
const NOWHERE_PORT = 9;

// The configuration of a server started without flags or variables, frozen like loadConfig's.
export function testConfig(overrides: Partial<Config> = {}): Readonly<Config> {
  const defaults = loadConfig({ argv: [], env: {} }).config;
  return Object.freeze({ ...defaults, cdpPort: NOWHERE_PORT, ...overrides });
}

function unreachable(): TvMcpError {
  return new TvMcpError('CDP_UNREACHABLE', 'The debug port does not answer in this test');
}

// What a connection manager needs to fail every call at once with CDP_UNREACHABLE. The retries
// between attempts do not wait.
export function unreachableConnectionDeps(logger: Logger = quietLogger): ConnectionManagerDeps {
  return {
    discovery: {
      version: () => Promise.reject(unreachable()),
      targets: () => Promise.reject(unreachable()),
    },
    connector: { connect: () => Promise.reject(unreachable()) },
    logger,
    callTimeoutMs: 1000,
    endpoint: `http://127.0.0.1:${String(NOWHERE_PORT)}`,
    sleep: () => Promise.resolve(),
  };
}

export function unreachableConnection(logger: Logger = quietLogger): ConnectionManager {
  return new ConnectionManager(unreachableConnectionDeps(logger));
}

export function refusingLauncher(): Launcher {
  const refuse = (): Promise<never> =>
    Promise.reject(new Error('This test must not start or look for TradingView'));
  return { launch: refuse, discover: refuse };
}

// Everything a handler gets except the registry, which createToolRegistry adds itself.
export function createTestContext(
  overrides: Partial<Omit<ToolContext, 'registry'>> = {},
): Omit<ToolContext, 'registry'> {
  return {
    config: testConfig(),
    logger: quietLogger,
    connection: unreachableConnection(),
    launcher: refusingLauncher(),
    events: new ToolEventBus(),
    session: {
      createdDrawingIds: new Set(),
      createdAlertIds: new Set(),
      createdStudyIds: new Set(),
      createdScriptIds: new Set(),
    },
    ...overrides,
  };
}
