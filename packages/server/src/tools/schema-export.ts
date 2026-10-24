import { z } from 'zod';
import type { Profile } from '../config/schema.js';
import type { JsonObject, JsonValue } from '../utils/json.js';
import type { AnyToolDefinition } from './types.js';

// The profiles that keep a tool (design spec 5.4): full keeps every tool, core the ones that say
// they are core, and readonly the ones that say they only read. A tool that does not say that it
// only reads may change something, so only the explicit hint counts. selectTools picks by this.
export function toolProfiles(tool: AnyToolDefinition): Profile[] {
  const profiles: Profile[] = ['full'];
  if (tool.core === true) {
    profiles.push('core');
  }
  if (tool.annotations.readOnlyHint === true) {
    profiles.push('readonly');
  }
  return profiles;
}

// One JSON Schema per definition, shared by everyone who asks, so it is frozen all the way down: a
// caller that changed it would change it for the others.
const inputJsonSchemas = new WeakMap<AnyToolDefinition, JsonObject>();

function deepFreeze<T extends JsonValue>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
    Object.freeze(value);
  }
  return value;
}

// The input of a tool as a JSON Schema object, for the dashboard: what a client sends, so a field
// with a default may be left out. A field that JSON Schema cannot express is described as any value
// rather than failing the tool list; the registry validates every call with the zod schema anyway.
export function toolInputJsonSchema(tool: AnyToolDefinition): JsonObject {
  let schema = inputJsonSchemas.get(tool);
  if (schema === undefined) {
    // zod writes plain JSON, but types it as its own JSON Schema interfaces.
    schema = deepFreeze(
      z.toJSONSchema(z.object(tool.inputSchema), {
        io: 'input',
        unrepresentable: 'any',
      }) as JsonObject,
    );
    inputJsonSchemas.set(tool, schema);
  }
  return schema;
}
