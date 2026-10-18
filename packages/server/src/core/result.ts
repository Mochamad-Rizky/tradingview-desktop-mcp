import type { CallToolResult, ImageContent } from '@modelcontextprotocol/sdk/types.js';
import type { JsonValue } from '../utils/json.js';
import type { ErrorPayload } from './errors.js';

// Where a result came from (meta.via). The first four are the fallback tiers T1 to T4 in the order
// they are tried (design spec 6); cdp and local are the other two values spec 5.2 allows.
export type Tier = 'api' | 'internal' | 'dom' | 'keyboard' | 'cdp' | 'local';

export interface ToolMeta {
  via?: Tier;
  durationMs: number;
  warnings?: string[];
}

// The envelope goes into both the text block and structuredContent: clients that only render text
// and clients that read structured data must see the same information.
export function toSuccessResult(
  data: JsonValue,
  meta: ToolMeta,
  images: ImageContent[] = [],
): CallToolResult {
  const envelope = { ok: true, data, meta };
  return {
    // Images go in front of the JSON block (design spec 5.2).
    content: [...images, { type: 'text', text: JSON.stringify(envelope) }],
    structuredContent: envelope,
  };
}

export function toErrorResult(error: ErrorPayload, durationMs: number): CallToolResult {
  const envelope = { ok: false, error, meta: { durationMs } };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    structuredContent: envelope,
  };
}
