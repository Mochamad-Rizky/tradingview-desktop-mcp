import type { Readable, Writable } from 'node:stream';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export interface StdioStreams {
  // process.stdin and process.stdout when absent.
  stdin?: Readable;
  stdout?: Writable;
}

// Serves one client over the streams, newline-delimited JSON-RPC both ways. Nothing but protocol
// messages may reach stdout. It resolves once the server listens; the server closes when its client
// goes away, which its owner learns from server.server.onclose.
export async function startStdioTransport(
  server: McpServer,
  streams: StdioStreams = {},
): Promise<void> {
  const stdin = streams.stdin ?? process.stdin;
  const stdout = streams.stdout ?? process.stdout;
  // The SDK transport watches neither for the end of its input nor for a broken output pipe, so
  // without these the process would linger after its client exited, and the EPIPE of the next
  // write would be thrown from an event handler.
  const close = (): void => {
    void server.close();
  };
  stdin.once('end', close);
  stdin.once('close', close);
  stdout.on('error', close);
  await server.connect(new StdioServerTransport(stdin, stdout));
}
