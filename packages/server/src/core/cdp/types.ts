import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping.js';

// One entry of /json/list, reduced to the fields this server uses. Chrome adds more (description,
// devtoolsFrontendUrl, faviconUrl), which are dropped at the edge.
export interface CdpTargetInfo {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
  // Set on iframes, to the id of the page that embeds them.
  parentId?: string;
}

// The answer of /json/version, under the names this server uses for Chrome's keys.
export interface CdpVersionInfo {
  browser: string;
  protocolVersion: string;
  userAgent: string;
  v8Version?: string;
}

// The HTTP side of the debug port. Both calls ask the app every time: targets come and go as the
// user opens and closes tabs, so nothing here is cached.
export interface CdpDiscovery {
  version(): Promise<CdpVersionInfo>;
  targets(): Promise<CdpTargetInfo[]>;
}

// One open debugging connection to one target. Everything above the adapter depends on this
// interface and not on the CDP client library, so it can be replaced by a fake.
//
// A session never comes back once it is closed, whether by `close()` or because the app dropped
// the connection. The owner asks the connector for a new one.
export interface CdpSession {
  readonly targetId: string;
  readonly isClosed: boolean;
  // Sends one protocol command and resolves with its result. The failures a caller can expect are
  // TvMcpErrors: TIMEOUT when the target does not answer in time, CDP_UNREACHABLE when the session
  // is closed or its connection drops while the command is in flight, and CAPABILITY_UNAVAILABLE
  // when the target answers with a protocol error (an unknown method, for instance).
  send<M extends keyof ProtocolMapping.Commands>(
    method: M,
    params?: ProtocolMapping.Commands[M]['paramsType'][0],
    options?: { timeoutMs?: number },
  ): Promise<ProtocolMapping.Commands[M]['returnType']>;
  // Runs `listener` once when the session closes, for either reason. A listener added after that
  // runs at once.
  onClose(listener: () => void): void;
  // Idempotent. The session is closed from the moment it is called.
  close(): Promise<void>;
}

export interface CdpConnector {
  connect(target: CdpTargetInfo): Promise<CdpSession>;
}
