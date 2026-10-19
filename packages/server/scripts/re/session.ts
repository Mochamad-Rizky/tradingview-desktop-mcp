import { parseArgs } from 'node:util';
import type { Protocol } from 'devtools-protocol/types/protocol.js';
import { loadConfig } from '../../src/config/load.js';
import type { Config } from '../../src/config/schema.js';
import { createCriConnector } from '../../src/core/cdp/cri-connector.js';
import { createHttpDiscovery, debugPortEndpoint } from '../../src/core/cdp/discovery.js';
import type { CdpDiscovery, CdpSession } from '../../src/core/cdp/types.js';
import { ConnectionManager } from '../../src/core/connection.js';
import { createLogger } from '../../src/core/logger.js';

// What the reverse-engineering scripts share: their command line, and a connection to the running
// app made of the server's own parts, so that they pick the chart tab the way the server does and
// run page functions through the same bridge.

export interface ScriptOptions {
  config: Readonly<Config>;
  flags: Record<string, string | boolean | undefined>;
}

// The flags of a script plus the ones every script takes: --host and --port of the debug port
// (or TV_CDP_HOST and TV_CDP_PORT), which the server's configuration checks, so a script can only
// reach the app on this machine.
export function readOptions(
  argv: readonly string[],
  own: Record<string, { type: 'string' | 'boolean'; default?: string | boolean }>,
): ScriptOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      host: { type: 'string' },
      port: { type: 'string' },
      help: { type: 'boolean', default: false },
      ...own,
    },
    strict: true,
    allowPositionals: false,
  });
  const env: NodeJS.ProcessEnv = {};
  const host = typeof values.host === 'string' ? values.host : process.env.TV_CDP_HOST;
  const port = typeof values.port === 'string' ? values.port : process.env.TV_CDP_PORT;
  if (host !== undefined) {
    env.TV_CDP_HOST = host;
  }
  if (port !== undefined) {
    env.TV_CDP_PORT = port;
  }
  const { config } = loadConfig({ argv: [], env });
  return { config, flags: values };
}

// tsx compiles with esbuild's keepNames, which wraps every inner function of a page function in a
// call to a __name helper that exists in this process only. The page would then fail with a
// ReferenceError, so each expression runs in a scope that defines the helper as a no-op. Nothing
// is added to the page's globals. The built server and the tests are compiled without keepNames
// and do not need this.
function withNameHelper(session: CdpSession): CdpSession {
  const send: CdpSession['send'] = (method, params, options) => {
    if (method === 'Runtime.evaluate' && params !== undefined) {
      const request = params as Protocol.Runtime.EvaluateRequest;
      const wrapped: Protocol.Runtime.EvaluateRequest = {
        ...request,
        expression: `(() => { const __name = (target) => target; return ${request.expression}; })()`,
      };
      return session.send(method, wrapped, options);
    }
    return session.send(method, params, options);
  };
  return {
    get targetId() {
      return session.targetId;
    },
    get isClosed() {
      return session.isClosed;
    },
    send,
    onClose: (listener) => {
      session.onClose(listener);
    },
    close: () => session.close(),
  };
}

export interface AppConnection {
  connection: ConnectionManager;
  discovery: CdpDiscovery;
  endpoint: string;
  close(): Promise<void>;
}

// A connection manager for the app the options point at. Logs go to stderr, warnings and worse
// only, so that stdout holds what the script prints.
export function connectToApp(config: Readonly<Config>): AppConnection {
  const { cdpHost: host, cdpPort: port, callTimeoutMs } = config;
  const logger = createLogger({ level: 'warn' });
  const discovery = createHttpDiscovery({ host, port, timeoutMs: callTimeoutMs });
  const connector = createCriConnector({ host, port, defaultTimeoutMs: callTimeoutMs });
  const endpoint = debugPortEndpoint(host, port);
  const connection = new ConnectionManager({
    discovery,
    connector: { connect: async (target) => withNameHelper(await connector.connect(target)) },
    logger,
    callTimeoutMs,
    endpoint,
  });
  return { connection, discovery, endpoint, close: () => connection.close() };
}

// Runs a script's main function, prints a failure on stderr and sets the exit code, without the
// stack trace of an expected error.
export function runScript(main: () => Promise<void>): void {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const hint =
      typeof error === 'object' &&
      error !== null &&
      'hint' in error &&
      typeof error.hint === 'string'
        ? `\n${error.hint}`
        : '';
    process.stderr.write(`${message}${hint}\n`);
    process.exitCode = 1;
  });
}
