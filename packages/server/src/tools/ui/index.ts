import type { AnyToolDefinition } from '../types.js';
import { pointerTools } from './pointer.js';

// The low-level interface tools (design spec 7, domain Low-level UI), for what no other tool
// reaches: the pointer tools (pointer.ts) for now.
export const uiTools: AnyToolDefinition[] = [...pointerTools];
