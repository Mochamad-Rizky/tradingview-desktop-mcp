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
