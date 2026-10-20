import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpError, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { isTvMcpError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import { toMcpError } from '../core/mcp-error.js';
import { readChartStateData } from '../tools/chart/index.js';
import { readOhlcvData } from '../tools/data/index.js';
import { readPineErrorsData } from '../tools/pine/compile.js';
import { readPineSourceData } from '../tools/pine/index.js';
import { readStrategyResultsData } from '../tools/strategy/index.js';
import type { ToolContext } from '../tools/types.js';

const JSON_MIME_TYPE = 'application/json';

// How many bars the chart resource holds, which is the default count of data_get_ohlcv.
const OHLCV_BARS = 100;

// A resource whose content is a JSON document read on every request: nothing is cached, because
// the app changes under it. tool is the tool it shares its data with.
interface JsonResource {
  name: string;
  uri: string;
  title: string;
  description: string;
  tool: string;
  read(): Promise<object>;
}

// A failed read is answered with a JSON-RPC error whose data is the error payload of design spec
// 5.2, so a client sees the same codes and hints as from a tool. An unexpected error reaches the
// client as INTERNAL only; the log keeps the whole of it.
function readFailed(error: unknown, uri: string, logger: Logger): McpError {
  if (!isTvMcpError(error)) {
    logger.error({ err: error, uri }, 'Reading a resource failed with an unexpected error');
  }
  return toMcpError(error);
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
// manager and the same reader as the tool it shares its data with, and so fails with the same
// errors. A resource is offered only with that tool: the profile and the tool filter narrow the
// resources as they narrow the tools, so that a server without the Pine tools, say, offers no text
// of the Pine Editor either.
export function registerResources(server: McpServer, ctx: ToolContext): void {
  const offered = new Set(ctx.registry.list().map(({ name }) => name));
  for (const resource of resourcesOf(ctx)) {
    if (offered.has(resource.tool)) {
      registerJsonResource(server, ctx.logger, resource);
    }
  }
}

// Every resource, each with the tool it goes with.
function resourcesOf(ctx: ToolContext): JsonResource[] {
  return [
    {
      name: 'app_health',
      uri: 'tradingview://app/health',
      title: 'TradingView health',
      description:
        'Whether the TradingView debug port answers, how many chart tabs are open, and whether ' +
        'the app is connected and ready. Reading it changes nothing.',
      tool: 'app_health',
      read: () => ctx.connection.health(),
    },
    {
      name: 'chart_state',
      uri: 'tradingview://chart/state',
      title: 'TradingView chart state',
      description:
        'What chart_get_state reports for the active chart: the symbol, the timeframe, the chart ' +
        'type, the visible range, the studies, the number of drawings and the layout. Reading it ' +
        'changes nothing.',
      tool: 'chart_get_state',
      read: async () => (await readChartStateData(ctx)).data,
    },
    {
      name: 'chart_ohlcv',
      uri: 'tradingview://chart/ohlcv',
      title: 'TradingView chart bars',
      description:
        'What data_get_ohlcv reports for the active chart with its default count: the last ' +
        `${String(OHLCV_BARS)} bars (open, high, low, close, volume), oldest first, with the ` +
        'symbol and the resolution they belong to, and complete, which is false when fewer bars ' +
        'exist or could be loaded. Reading it changes nothing on the chart; when fewer bars are ' +
        'loaded, older ones are loaded the way a scroll to the left loads them.',
      tool: 'data_get_ohlcv',
      read: async () => (await readOhlcvData(ctx, { count: OHLCV_BARS })).data,
    },
    {
      name: 'pine_source',
      uri: 'tradingview://pine/source',
      title: 'Pine Editor source',
      description:
        'What pine_get_source reports: the text of the Pine Editor, the script it holds (id and ' +
        'version, null for a new script) and whether the text has unsaved changes. It never ' +
        'opens the editor: while the editor is closed, reading it fails with NOT_AVAILABLE. ' +
        'Reading it changes nothing.',
      tool: 'pine_get_source',
      read: async () => (await readPineSourceData(ctx)).data,
    },
    {
      name: 'pine_errors',
      uri: 'tradingview://pine/errors',
      title: 'Last Pine compile result',
      description:
        'What pine_get_errors reports: the result of the last Pine compilation of this session ' +
        '(success, errors, warnings, addedToChart, studyId and the time of the compilation), or ' +
        'an empty result, with success true, while there has been none. It asks TradingView ' +
        'nothing, so it can be read while TradingView is down. Reading it changes nothing.',
      tool: 'pine_get_errors',
      read: () => Promise.resolve(readPineErrorsData(ctx)),
    },
    {
      name: 'strategy_report',
      uri: 'tradingview://strategy/report',
      title: 'Strategy Tester results',
      description:
        'What strategy_get_results reports for the active strategy of the chart, or its only ' +
        'strategy: the strategy (id and name), the currency, the initial capital and the ' +
        'performance figures for all, long and short trades. Reading it fails with ' +
        'NOT_AVAILABLE while the chart has no strategy or its report is not ready, and with ' +
        'INVALID_INPUT when several strategies are on the chart and none is active. Reading it ' +
        'changes nothing.',
      tool: 'strategy_get_results',
      read: async () => (await readStrategyResultsData(ctx)).data,
    },
  ];
}
