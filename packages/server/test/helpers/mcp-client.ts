import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// An SDK client connected to `server` through a linked pair of in-memory transports. Requests go
// through the whole protocol layer of both sides (initialization, capabilities, schema checks of
// requests and results) without a process or a socket. Closing the client closes both ends.
export async function connectInMemoryClient(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'tradingview-mcp-tests', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

// The SDK types a tool result as either the current shape or the legacy `toolResult` one, which
// no server built on this SDK sends. Parsing narrows it to the current shape.
export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  return CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
}

// The text of the first text block, which is what a client without structured content reads.
export function textOf(result: CallToolResult): string {
  for (const block of result.content) {
    if (block.type === 'text') {
      return block.text;
    }
  }
  throw new Error('The result has no text block');
}
