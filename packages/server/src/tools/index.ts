import { batchTools } from './batch/index.js';
import type { AnyToolDefinition } from './types.js';

// Every tool the server knows, in the order clients list them. The profile and the tool filter
// pick from this list (selectTools); each domain adds its tools here.
export const allTools: AnyToolDefinition[] = [...batchTools];
