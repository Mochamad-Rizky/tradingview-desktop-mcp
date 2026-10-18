import { isIPv6 } from 'node:net';
import { z } from 'zod';
import type { JsonObject } from '../../utils/json.js';
import { TimeoutError, TvMcpError } from '../errors.js';
import type { CdpDiscovery, CdpTargetInfo, CdpVersionInfo } from './types.js';

// Chrome always sends the keys declared as required, so a document without them comes from some
// other service on that port. The keys it adds beyond these (description, devtoolsFrontendUrl,
// WebKit-Version, ...) are dropped by z.object.
const targetListSchema = z.array(
  z.object({
    id: z.string(),
    type: z.string(),
    title: z.string(),
    url: z.string(),
    webSocketDebuggerUrl: z.string().optional(),
    parentId: z.string().optional(),
  }),
);

const versionSchema = z.object({
  Browser: z.string(),
  'Protocol-Version': z.string(),
  'User-Agent': z.string(),
  'V8-Version': z.string().optional(),
});

export interface HttpDiscoveryOptions {
  host: string;
  port: number;
  // Bounds one whole request: connecting, the headers and the body. It is not validated here,
  // because the configuration already limits it to what a timer can honor.
  timeoutMs: number;
}

// fetch reports every network failure as a TypeError saying "fetch failed", with the errno name
// (ECONNREFUSED, ECONNRESET, ...) in its cause.
function errnoName(error: unknown): string | undefined {
  const cause = error instanceof Error ? error.cause : undefined;
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    return typeof cause.code === 'string' ? cause.code : undefined;
  }
  return undefined;
}

function unreachable(endpoint: string, port: number, error: unknown): TvMcpError {
  const code = errnoName(error);
  return new TvMcpError(
    'CDP_UNREACHABLE',
    `Cannot connect to the TradingView debug port at ${endpoint}`,
    {
      hint:
        'Launch TradingView Desktop with remote debugging: use the app_launch tool, or start the ' +
        `app with --remote-debugging-port=${String(port)}. An instance that is already running ` +
        'without that flag has to be restarted first.',
      details: { endpoint, ...(code === undefined ? {} : { code }) },
      cause: error,
    },
  );
}

const WRONG_PORT_HINT =
  'Check that --cdp-port (TV_CDP_PORT) is the port TradingView was launched with, and that no ' +
  'other program is listening on it.';

// The port answered, but not the way a Chrome debug port does. Another program is most likely
// listening there.
function unexpectedAnswer(
  endpoint: string,
  path: string,
  problem: string,
  extraDetails: JsonObject,
  cause?: unknown,
): TvMcpError {
  return new TvMcpError(
    'CDP_UNREACHABLE',
    `${endpoint} did not answer like a Chrome DevTools endpoint: GET ${path} ${problem}`,
    {
      hint: WRONG_PORT_HINT,
      details: { endpoint, path, ...extraDetails },
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

// A few issues are enough to tell what is wrong: a list of many malformed entries would otherwise
// put one issue per entry into the details.
const MAX_ISSUES_SHOWN = 3;

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, MAX_ISSUES_SHOWN)
    .map((issue) => {
      const where = issue.path.map(String).join('.');
      return where === '' ? issue.message : `${where}: ${issue.message}`;
    })
    .join('; ');
}

// The HTTP half of the debug port: /json/version says whether the app is there, and /json/list
// says which targets it has. Commands go over a WebSocket per target, which is not handled here.
export function createHttpDiscovery(options: HttpDiscoveryOptions): CdpDiscovery {
  const { host, port, timeoutMs } = options;
  // An IPv6 literal must be bracketed in a URL, or its colons read as the start of the port.
  const endpoint = `http://${isIPv6(host) ? `[${host}]` : host}:${String(port)}`;

  async function getJson(path: string): Promise<unknown> {
    // The signal aborts the request itself, not only the wait for it: an app that stalls must not
    // be left holding a connection (and the process a pending request) after we gave up.
    const signal = AbortSignal.timeout(timeoutMs);
    let answer: { ok: boolean; status: number; body: string };
    try {
      // A debug port does not redirect. Following one could carry the request away from the
      // loopback address that the host setting restricts it to.
      const response = await fetch(`${endpoint}${path}`, { signal, redirect: 'error' });
      // The body is read for every status, which also releases the connection.
      answer = { ok: response.ok, status: response.status, body: await response.text() };
    } catch (error) {
      if (signal.aborted) {
        throw new TimeoutError(`CDP discovery GET ${path}`, timeoutMs);
      }
      throw unreachable(endpoint, port, error);
    }
    if (!answer.ok) {
      throw unexpectedAnswer(endpoint, path, `returned HTTP ${String(answer.status)}`, {
        status: answer.status,
      });
    }
    try {
      return JSON.parse(answer.body) as unknown;
    } catch (error) {
      throw unexpectedAnswer(endpoint, path, 'returned a body that is not JSON', {}, error);
    }
  }

  async function read<S extends z.ZodType>(path: string, schema: S): Promise<z.output<S>> {
    const parsed = schema.safeParse(await getJson(path));
    if (!parsed.success) {
      throw unexpectedAnswer(
        endpoint,
        path,
        'returned an unexpected document',
        { issue: describeIssues(parsed.error) },
        parsed.error,
      );
    }
    return parsed.data;
  }

  return {
    async version(): Promise<CdpVersionInfo> {
      const document = await read('/json/version', versionSchema);
      const v8Version = document['V8-Version'];
      return {
        browser: document.Browser,
        protocolVersion: document['Protocol-Version'],
        userAgent: document['User-Agent'],
        // With exactOptionalPropertyTypes an absent key must stay absent, not become undefined.
        ...(v8Version === undefined ? {} : { v8Version }),
      };
    },

    async targets(): Promise<CdpTargetInfo[]> {
      const entries = await read('/json/list', targetListSchema);
      return entries.map(({ id, type, title, url, webSocketDebuggerUrl, parentId }) => ({
        id,
        type,
        title,
        url,
        ...(webSocketDebuggerUrl === undefined ? {} : { webSocketDebuggerUrl }),
        ...(parentId === undefined ? {} : { parentId }),
      }));
    },
  };
}
