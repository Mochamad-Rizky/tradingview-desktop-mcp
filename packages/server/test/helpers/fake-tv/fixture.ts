import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { JsonValue } from '../../../src/utils/json.js';
import { fixturePath } from '../fixture-path.js';

// The state a fake TradingView window starts from, stored as JSON under test/fixtures/tv/.
// Fixtures must not carry personal data or real prices, which is why bars are a generator spec
// instead of rows.
export interface TvStateFixture {
  buildTime: string;
  symbol: string;
  resolution: string;
  chartType: number;
  visibleRange: { from: number; to: number };
  studies: { id: string; name: string; plots: string[] }[];
  shapes: { id: string; name: string }[];
  layout: { type: string; chartsCount: number; name: string; id: string };
  intervals: string[];
  knownSymbols: string[];
  symbolInfo: Record<string, JsonValue>;
  quote: Record<string, JsonValue>;
  // Not stored as bars: syntheticBars() expands this spec, so fixtures hold no price data.
  bars: { count: number; startTime: number; stepSeconds: number; seed: number };
}

// Strict, so a field a recording adds but this interface lacks fails loudly instead of being
// ignored by every fake.
const tvStateFixtureSchema: z.ZodType<TvStateFixture> = z.strictObject({
  buildTime: z.string(),
  symbol: z.string(),
  resolution: z.string(),
  chartType: z.number(),
  visibleRange: z.strictObject({ from: z.number(), to: z.number() }),
  studies: z.array(
    z.strictObject({ id: z.string(), name: z.string(), plots: z.array(z.string()) }),
  ),
  shapes: z.array(z.strictObject({ id: z.string(), name: z.string() })),
  layout: z.strictObject({
    type: z.string(),
    chartsCount: z.number(),
    name: z.string(),
    id: z.string(),
  }),
  intervals: z.array(z.string()),
  knownSymbols: z.array(z.string()),
  symbolInfo: z.record(z.string(), z.json()),
  quote: z.record(z.string(), z.json()),
  bars: z.strictObject({
    count: z.number(),
    startTime: z.number(),
    stepSeconds: z.number(),
    seed: z.number(),
  }),
});

export function parseTvStateFixture(raw: unknown): TvStateFixture {
  const result = tvStateFixtureSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid TradingView state fixture:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function loadTvFixture(name = 'chart-basic'): TvStateFixture {
  const path = fixturePath(`tv/${name}.json`);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new Error(`Cannot read the TradingView fixture "${name}" at ${path}`, { cause });
  }
  return parseTvStateFixture(JSON.parse(text) as unknown);
}
