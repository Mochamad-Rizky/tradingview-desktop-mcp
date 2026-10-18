import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { fixturePath } from '../fixture-path.js';
import type { FakeTarget } from './server.js';

// The targets TradingView Desktop 3.4.1 listed on macOS in /json/list. The server fills
// webSocketDebuggerUrl and devtoolsFrontendUrl, so they are not in the file. The layout ID of
// the chart URL is scrubbed to FIXTURE1 and the random instance ID of the window chrome to
// "fixture".
const targetsFixtureSchema = z.array(
  z.strictObject({
    id: z.string(),
    type: z.string(),
    title: z.string(),
    url: z.string(),
    parentId: z.string().optional(),
  }),
);

const CHART_URL_PREFIX = 'https://www.tradingview.com/chart/';

export interface TargetsFixtureOptions {
  // Window factory for the chart page, so a test can put a fake TradingView window on it.
  chartWindow?: () => object;
}

export function loadTargetsFixture(options: TargetsFixtureOptions = {}): FakeTarget[] {
  const raw = JSON.parse(
    readFileSync(fixturePath('cdp/targets.macos-3.4.1.json'), 'utf8'),
  ) as unknown;
  return targetsFixtureSchema.parse(raw).map((entry): FakeTarget => ({
    id: entry.id,
    type: entry.type,
    title: entry.title,
    url: entry.url,
    // The two blank pages have no execution context, so evaluating on them never returns.
    behavior: entry.type === 'page' && entry.url === '' ? 'silent' : 'page',
    ...(entry.parentId === undefined ? {} : { parentId: entry.parentId }),
    ...(options.chartWindow !== undefined &&
    entry.type === 'page' &&
    entry.url.startsWith(CHART_URL_PREFIX)
      ? { window: options.chartWindow }
      : {}),
  }));
}
