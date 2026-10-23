import type { Config } from '../../config/schema.js';
import { TvMcpError } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import {
  dashboardUrl,
  hostPort,
  listenWithRouter,
  stopServer,
  warnIfTokenIsShort,
  type DashboardOptions,
} from '../http.js';
import type { DashboardApi } from './api.js';

export interface DashboardServerOptions {
  config: Readonly<Config>;
  logger: Logger;
  api: DashboardApi;
  // Where the built dashboard is. Without it only the API is served.
  dir?: string;
}

export interface DashboardServerHandle {
  // Where the dashboard page is. It never holds the token, so it can be shown and logged.
  url: string;
  close(): Promise<void>;
}

// The dashboard next to a stdio server, on a listener of its own at config.httpHost:config.httpPort:
// the page, its API and /healthz behind the Host, Origin and token checks of the HTTP transport,
// and no MCP, which runs over stdio. A listener that cannot start is no reason to stop that MCP
// server, so it gives a warning and null.
export async function startDashboardServer(
  options: DashboardServerOptions,
): Promise<DashboardServerHandle | null> {
  const { config, logger, api, dir } = options;
  const token = config.authToken;
  // The API runs tools, so without the token anyone on this machine could.
  if (token === undefined) {
    throw new TvMcpError('INVALID_INPUT', 'TV_MCP_AUTH_TOKEN is required for the dashboard', {
      hint: 'Set TV_MCP_AUTH_TOKEN to a random secret, such as the output of "openssl rand -hex 32".',
    });
  }
  warnIfTokenIsShort(token, logger);
  const dashboard: DashboardOptions = dir === undefined ? { api } : { api, dir };
  let listening: Awaited<ReturnType<typeof listenWithRouter>>;
  try {
    listening = await listenWithRouter(config, { token, logger, dashboard });
  } catch (error) {
    // The error says why, and how to choose another port or host.
    logger.warn(
      { err: error, host: config.httpHost, port: config.httpPort },
      `The dashboard is off, and MCP over stdio runs on without it: it cannot listen on ` +
        hostPort(config.httpHost, config.httpPort),
    );
    return null;
  }
  const { server, port } = listening;
  let closing: Promise<void> | undefined;
  return {
    url: dashboardUrl(config.httpHost, port),
    close() {
      closing ??= stopServer(server, dashboard);
      return closing;
    },
  };
}
