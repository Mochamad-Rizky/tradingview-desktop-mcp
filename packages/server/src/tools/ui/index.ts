import type { AnyToolDefinition } from '../types.js';
import { uiEvaluate } from './evaluate.js';
import { uiPressKey, uiTypeText } from './keyboard.js';
import { uiFullscreen, uiOpenPanel } from './panels.js';
import { uiClick, uiFindElement, uiHover, uiScroll } from './pointer.js';

// The low-level interface tools (design spec 7, domain Low-level UI), for what no other tool
// reaches, in the order of the catalog: the pointer (pointer.ts), the keyboard (keyboard.ts), the
// panels and the fullscreen mode (panels.ts), and the opt-in evaluation of JavaScript
// (evaluate.ts).
export const uiTools: AnyToolDefinition[] = [
  uiClick,
  uiHover,
  uiTypeText,
  uiPressKey,
  uiScroll,
  uiFindElement,
  uiOpenPanel,
  uiFullscreen,
  uiEvaluate,
];
