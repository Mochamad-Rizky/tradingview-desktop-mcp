import { appTools } from './app/index.js';
import { batchTools } from './batch/index.js';
import { chartTools } from './chart/index.js';
import type { AnyToolDefinition } from './types.js';

// Every tool the server knows, in the order clients list them (the order of design spec 7). The
// profile and the tool filter pick from this list (selectTools); each domain adds its tools here.
export const allTools: AnyToolDefinition[] = [...appTools, ...chartTools, ...batchTools];
