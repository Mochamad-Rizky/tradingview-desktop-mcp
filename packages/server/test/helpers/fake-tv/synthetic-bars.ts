import type { TvStateFixture } from './fixture.js';

// [time (Unix seconds), open, high, low, close, volume], the row shape of bars().valueAt().
export type SyntheticBar = [number, number, number, number, number, number];

const BASE_PRICE = 100;
const MIN_PRICE = 1;
// Prices carry two decimals, like a stock quote, which also keeps the committed numbers short.
const PRICE_SCALE = 100;
// Largest close-to-close move, as a fraction of the previous close.
const MAX_STEP = 0.02;
// Longest wick beyond the body, as a fraction of the body edge.
const MAX_WICK = 0.01;

// mulberry32: a 32-bit generator built from integer arithmetic only, so a given seed yields the
// same series on every platform and Node version. Math.random is not seedable.
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function roundPrice(price: number): number {
  return Math.round(price * PRICE_SCALE) / PRICE_SCALE;
}

// A deterministic random walk standing in for market data, because committed fixtures must not
// hold real prices. Each bar opens at the previous close, which is how a continuous session
// looks, and the wicks are derived from the rounded body so high and low can never cross it.
export function syntheticBars(spec: TvStateFixture['bars']): SyntheticBar[] {
  const { count, startTime, stepSeconds, seed } = spec;
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`Bar count must be a non-negative integer, got ${String(count)}`);
  }
  if (!Number.isFinite(startTime)) {
    throw new RangeError(`Start time must be finite, got ${String(startTime)}`);
  }
  if (!Number.isFinite(stepSeconds) || stepSeconds <= 0) {
    throw new RangeError(`Step must be a positive number of seconds, got ${String(stepSeconds)}`);
  }
  if (!Number.isFinite(seed)) {
    throw new RangeError(`Seed must be finite, got ${String(seed)}`);
  }

  const random = createRandom(seed);
  const bars: SyntheticBar[] = [];
  let previousClose = BASE_PRICE;
  for (let index = 0; index < count; index += 1) {
    const open = previousClose;
    const close = roundPrice(Math.max(MIN_PRICE, open * (1 + (random() - 0.5) * 2 * MAX_STEP)));
    const bodyHigh = Math.max(open, close);
    const bodyLow = Math.min(open, close);
    const high = Math.max(bodyHigh, roundPrice(bodyHigh * (1 + random() * MAX_WICK)));
    const low = Math.min(
      bodyLow,
      Math.max(MIN_PRICE, roundPrice(bodyLow * (1 - random() * MAX_WICK))),
    );
    const volume = Math.floor(1_000_000 + random() * 9_000_000);
    bars.push([startTime + index * stepSeconds, open, high, low, close, volume]);
    previousClose = close;
  }
  return bars;
}
