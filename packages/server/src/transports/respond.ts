import type { OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { JsonValue } from '../utils/json.js';

// A JSON answer of the HTTP listeners. Each one describes the server at the moment it was asked: a
// refusal, its health, a tool result. So no cache may keep one.
export function sendJson(
  res: ServerResponse,
  status: number,
  body: JsonValue,
  headers: OutgoingHttpHeaders = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(text);
}
