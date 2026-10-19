import type { Readable, Writable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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

// An SDK client on the other end of the streams a stdio server was given: it reads what the server
// writes to its stdout and writes to the server's stdin. The SDK's stdio transport is only
// newline-delimited JSON over two streams, so it serves the client side as well. Closing the client
// leaves the server's stdin open; end it to make the server see its client go away.
export async function connectStdioClient(
  serverStdout: Readable,
  serverStdin: Writable,
): Promise<Client> {
  const client = new Client({ name: 'tradingview-mcp-tests', version: '0.0.0' });
  await client.connect(new StdioServerTransport(serverStdout, serverStdin));
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
