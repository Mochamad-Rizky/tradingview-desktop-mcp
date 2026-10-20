import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { toErrorPayload } from './errors.js';

// The JSON-RPC error that a resource or a prompt answers a failure with. Its data is the error
// payload of design spec 5.2, so a client sees the same codes and hints as from a tool. A mistake
// of the client is "invalid params" in JSON-RPC terms, and anything else the server's.
export function toMcpError(error: unknown): McpError {
  const payload = toErrorPayload(error);
  const code = payload.code === 'INVALID_INPUT' ? ErrorCode.InvalidParams : ErrorCode.InternalError;
  return new McpError(code, payload.message, payload);
}
