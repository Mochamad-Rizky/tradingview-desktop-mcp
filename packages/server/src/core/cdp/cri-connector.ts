import { isIPv6 } from 'node:net';
import CDP from 'chrome-remote-interface';
import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping.js';
import { withTimeout } from '../../utils/timeout.js';
import { TimeoutError, TvMcpError } from '../errors.js';
import type { CdpConnector, CdpSession, CdpTargetInfo } from './types.js';

export interface CriConnectorOptions {
  host: string;
  port: number;
  // Bounds the connection attempt, closing a session, and any command that is not given a timeout
  // of its own. It is not validated here, because the configuration already limits it to what a
  // timer can honor.
  defaultTimeoutMs: number;
}

// The part of a chrome-remote-interface client this adapter uses.
interface CriClient {
  send(method: string, params?: object): Promise<unknown>;
  on(event: 'disconnect', listener: () => void): void;
  close(): Promise<void>;
}

// The hosts the configuration allows, spelled the way the URL parser writes them back.
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

// The errno name (ECONNREFUSED, ECONNRESET, ...) of a failure, when it has one.
function errnoName(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return typeof error.code === 'string' ? error.code : undefined;
  }
  return undefined;
}

// A server that answers the WebSocket upgrade with an HTTP error is reported by ws only through
// the text of the error.
const UPGRADE_STATUS = /^Unexpected server response: (\d{3})$/;

function upgradeStatus(error: unknown): number | undefined {
  const digits = error instanceof Error ? UPGRADE_STATUS.exec(error.message)?.[1] : undefined;
  return digits === undefined ? undefined : Number(digits);
}

function unreachable(targetId: string, endpoint: string, port: number, error: unknown): TvMcpError {
  const code = errnoName(error);
  const status = upgradeStatus(error);
  return new TvMcpError(
    'CDP_UNREACHABLE',
    `Cannot open a debugging connection to target ${targetId} at ${endpoint}`,
    {
      hint:
        'Check that TradingView Desktop is still running with ' +
        `--remote-debugging-port=${String(port)}, then retry the call.`,
      details: {
        targetId,
        endpoint,
        ...(code === undefined ? {} : { code }),
        ...(status === undefined ? {} : { status }),
      },
      cause: error,
    },
  );
}

// The URL as the URL parser reads it, if it is a ws: URL on this machine. What is checked is also
// what gets used: the library parses URLs again with a parser of its own, and a text that the two
// read differently could pass the check and lead somewhere else.
function loopbackWebSocketUrl(text: string): string | undefined {
  try {
    const url = new URL(text);
    const isWebSocket = url.protocol === 'ws:' || url.protocol === 'wss:';
    return isWebSocket && LOOPBACK_HOSTNAMES.has(url.hostname) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

// The debugger URL a target lists, if it lists one. The address in it comes from whatever
// answered on the debug port, so it is only followed when it stays on this machine; anything else
// most likely means another program is listening there.
function listedDebuggerUrl(target: CdpTargetInfo, endpoint: string): string | undefined {
  const listed = target.webSocketDebuggerUrl;
  if (listed === undefined || listed === '') {
    return undefined;
  }
  const checked = loopbackWebSocketUrl(listed);
  if (checked === undefined) {
    throw new TvMcpError(
      'CDP_UNREACHABLE',
      `Target ${target.id} lists a debugger URL that this server does not connect to: only ws: ` +
        'URLs on the loopback interface are used',
      {
        hint:
          'Check that --cdp-port (TV_CDP_PORT) is the port TradingView was launched with, and ' +
          'that no other program is listening on it.',
        details: { targetId: target.id, endpoint, webSocketDebuggerUrl: listed },
      },
    );
  }
  return checked;
}

// The longest delay a timer honors; a longer one fires at once.
const MAX_TIMER_MS = 2_147_483_647;

// A per-call timeout is only used when it is a whole number of milliseconds a timer can honor.
// withTimeout does not check: zero, a negative number, NaN, Infinity and anything above the limit
// would make its timer fire at once instead of waiting.
function usableTimeout(requested: number | undefined): number | undefined {
  return requested !== undefined &&
    Number.isInteger(requested) &&
    requested > 0 &&
    requested <= MAX_TIMER_MS
    ? requested
    : undefined;
}

const RECONNECTS = 'The server reconnects on the next call';

// The command never left this process, so repeating it cannot do anything twice.
function notSent(targetId: string, method: string): TvMcpError {
  return new TvMcpError(
    'CDP_UNREACHABLE',
    `CDP ${method} was not sent: the connection to target ${targetId} is closed`,
    {
      hint: `${RECONNECTS}, and nothing was sent, so the call can simply be repeated.`,
      details: { targetId, method },
    },
  );
}

// The command was on its way when the connection went, so the app may or may not have run it.
function notCompleted(targetId: string, method: string, cause: unknown): TvMcpError {
  return new TvMcpError(
    'CDP_UNREACHABLE',
    `CDP ${method} was not completed: the connection to target ${targetId} closed`,
    {
      hint:
        `${RECONNECTS}. The command may already have run, so check the state before ` +
        'repeating a call that changes it.',
      details: { targetId, method },
      cause,
    },
  );
}

// The target answered, with an error. For a method the app does not implement that is "this
// capability is not available", which callers with a fallback act on.
function protocolFailure(
  response: CDP.SendError,
  cause: Error,
  method: string,
  targetId: string,
): TvMcpError {
  const { code, message, data } = response;
  const reason = data === undefined ? message : `${message} (${data})`;
  return new TvMcpError(
    'CAPABILITY_UNAVAILABLE',
    `CDP ${method} failed on target ${targetId}: ${reason}`,
    { details: { method, code, message }, cause },
  );
}

// The library reports a drop that cuts a command short as "WebSocket connection closed", ws a
// send on a socket that is no longer open as "WebSocket is not open", and the socket a failed
// write by errno.
function isTransportFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.startsWith('WebSocket') || errnoName(error) !== undefined)
  );
}

// What a failed command is reported as. An error that is none of the expected kinds is a bug, and
// passes through unchanged so that whoever logs it has the original.
function sendFailure(error: unknown, method: string, targetId: string): unknown {
  if (error instanceof TvMcpError) {
    return error;
  }
  if (error instanceof CDP.ProtocolError) {
    return protocolFailure(error.response, error, method, targetId);
  }
  if (isTransportFailure(error)) {
    return notCompleted(targetId, method, error);
  }
  return error;
}

// The library cannot abort a connection attempt. One that completes after its deadline would
// leave a connection open that nobody holds, so it is closed as soon as it arrives.
function closeWhenConnected(attempt: Promise<CriClient>): void {
  void attempt.then((late) => late.close()).catch(() => undefined);
}

// A listener that throws must not keep the others from running. When a connection drops, the
// listeners run inside an event handler of the library, where an exception would end the process.
function notify(listener: () => void): void {
  try {
    listener();
  } catch {
    // A failing listener is a bug of its owner, and this adapter has no logger to report it to.
  }
}

// The caller is done with the session, so a connection that does not shut down cleanly is not an
// error to report to them. After the deadline the library is left to give up on the peer itself,
// which it does after 30 seconds.
async function release(client: CriClient, targetId: string, timeoutMs: number): Promise<void> {
  try {
    await withTimeout(client.close(), timeoutMs, `CDP close on ${targetId}`);
  } catch {
    // Best effort, as above.
  }
}

function createSession(client: CriClient, targetId: string, defaultTimeoutMs: number): CdpSession {
  let closed = false;
  let closing: Promise<void> | undefined;
  const listeners: (() => void)[] = [];

  const markClosed = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    for (const listener of listeners.splice(0)) {
      notify(listener);
    }
  };

  // The library emits this when the connection ends on its own side or the app's, and not after
  // a close() of ours.
  client.on('disconnect', markClosed);

  return {
    targetId,
    get isClosed() {
      return closed;
    },
    async send<M extends keyof ProtocolMapping.Commands>(
      method: M,
      params?: ProtocolMapping.Commands[M]['paramsType'][0],
      options?: { timeoutMs?: number },
    ): Promise<ProtocolMapping.Commands[M]['returnType']> {
      if (closed) {
        // Never hand a command to a connection that is gone: the library would only fail it later,
        // and the caller could not tell whether it ran.
        throw notSent(targetId, method);
      }
      let reply: unknown;
      try {
        reply = await withTimeout(
          client.send(method, params),
          usableTimeout(options?.timeoutMs) ?? defaultTimeoutMs,
          `CDP ${method} on ${targetId}`,
        );
      } catch (error) {
        throw sendFailure(error, method, targetId);
      }
      // The reply is whatever the app sent; the protocol typings are what callers rely on.
      return reply as ProtocolMapping.Commands[M]['returnType'];
    },
    onClose(listener) {
      if (closed) {
        notify(listener);
      } else {
        listeners.push(listener);
      }
    },
    close() {
      markClosed();
      // A second close() of the library would take over the first one's completion handler and
      // leave that caller waiting for good, so it is called once and its promise is shared.
      closing ??= release(client, targetId, defaultTimeoutMs);
      return closing;
    },
  };
}

export function createCriConnector(options: CriConnectorOptions): CdpConnector {
  const { host, port, defaultTimeoutMs } = options;
  // An IPv6 literal must be bracketed in a URL, or its colons read as the start of the port.
  const endpoint = `ws://${isIPv6(host) ? `[${host}]` : host}:${String(port)}`;

  return {
    async connect(target: CdpTargetInfo): Promise<CdpSession> {
      // Connecting through the URL the target lists spares the library its own request for the
      // list of targets, which this adapter can neither abort nor check.
      const listedUrl = listedDebuggerUrl(target, endpoint);
      if (listedUrl === undefined && target.id === '') {
        // The library takes an empty target to mean "the first page it finds".
        throw new TvMcpError('TARGET_NOT_FOUND', 'Cannot connect to a target that has no id');
      }
      // `local` makes the library use the protocol descriptor it ships instead of fetching one
      // from the app.
      const attempt: Promise<CriClient> = CDP(
        listedUrl === undefined
          ? { host, port, target: target.id, local: true }
          : { target: listedUrl, local: true },
      );
      let client: CriClient;
      try {
        client = await withTimeout(attempt, defaultTimeoutMs, `CDP connect to ${target.id}`);
      } catch (error) {
        if (error instanceof TimeoutError) {
          closeWhenConnected(attempt);
          throw error;
        }
        throw unreachable(target.id, endpoint, port, error);
      }
      return createSession(client, target.id, defaultTimeoutMs);
    },
  };
}
