import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError, type ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { isTvMcpError, toErrorPayload } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import { readChartStateData } from '../tools/chart/index.js';
import type { ToolContext } from '../tools/types.js';

const JSON_MIME_TYPE = 'application/json';

// A resource whose content is a JSON document read on every request: nothing is cached, because
// the app changes under it.
interface JsonResource {
  name: string;
  uri: string;
  title: string;
  description: string;
  read(): Promise<object>;
}

// A failed read is answered with a JSON-RPC error whose data is the error payload of design spec
// 5.2, so a client sees the same codes and hints as from a tool. An unexpected error reaches the
// client as INTERNAL only; the log keeps the whole of it.
function readFailed(error: unknown, uri: string, logger: Logger): McpError {
  const payload = toErrorPayload(error);
  if (!isTvMcpError(error)) {
    logger.error({ err: error, uri }, 'Reading a resource failed with an unexpected error');
  }
  const code = payload.code === 'INVALID_INPUT' ? ErrorCode.InvalidParams : ErrorCode.InternalError;
  return new McpError(code, payload.message, payload);
}

function registerJsonResource(server: McpServer, logger: Logger, resource: JsonResource): void {
  server.registerResource(
    resource.name,
    resource.uri,
    { title: resource.title, description: resource.description, mimeType: JSON_MIME_TYPE },
    async (uri): Promise<ReadResourceResult> => {
      let value: object;
      try {
        value = await resource.read();
      } catch (error) {
        throw readFailed(error, uri.href, logger);
      }
      return {
        contents: [{ uri: uri.href, mimeType: JSON_MIME_TYPE, text: JSON.stringify(value) }],
      };
    },
  );
}

// The resources of design spec 7 that exist so far. Each one reads through the same connection
// manager as the tools of the server.
export function registerResources(server: McpServer, ctx: ToolContext): void {
  registerJsonResource(server, ctx.logger, {
    name: 'app_health',
    uri: 'tradingview://app/health',
    title: 'TradingView health',
    description:
      'Whether the TradingView debug port answers, how many chart tabs are open, and whether the ' +
      'app is connected and ready. Reading it changes nothing.',
    read: () => ctx.connection.health(),
  });
  registerJsonResource(server, ctx.logger, {
    name: 'chart_state',
    uri: 'tradingview://chart/state',
    title: 'TradingView chart state',
    description:
      'What chart_get_state reports for the active chart: the symbol, the timeframe, the chart ' +
      'type, the visible range, the studies, the number of drawings and the layout. Reading it ' +
      'changes nothing.',
    read: async () => (await readChartStateData(ctx)).data,
  });
}
