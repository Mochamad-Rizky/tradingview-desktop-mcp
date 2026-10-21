import { appTools } from './app/index.js';
import { batchTools } from './batch/index.js';
import { chartTools } from './chart/index.js';
import { dataTools } from './data/index.js';
import { indicatorTools } from './indicator/index.js';
import { pineTools } from './pine/index.js';
import { screenshotTools } from './screenshot/index.js';
import { strategyTools } from './strategy/index.js';
import type { AnyToolDefinition } from './types.js';
import { uiTools } from './ui/index.js';

// Every tool the server knows, in the order clients list them (the order of design spec 7). The
// profile and the tool filter pick from this list (selectTools); each domain adds its tools here.
export const allTools: AnyToolDefinition[] = [
  ...appTools,
  ...chartTools,
  ...dataTools,
  ...indicatorTools,
  ...pineTools,
  ...strategyTools,
  ...screenshotTools,
  ...uiTools,
  ...batchTools,
];
