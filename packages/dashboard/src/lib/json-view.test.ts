import type { JsonValue } from '@contract';
import { formatJson, JSON_LIMIT } from './json-view';

const SAMPLE: JsonValue = {
  ok: true,
  data: {
    symbol: 'NASDAQ:AAPL',
    empty: {},
    none: [],
    bars: [
      { time: 1704067200, open: 185.5, close: -0.25, volume: 1e21 },
      { time: 1704153600, open: 186, close: 187.125, volume: null },
    ],
    nested: [[1, [2, []]], { a: { b: {} } }],
    text: 'Quotes " and \\ backslashes,\nnew lines, tabs\t, ünïcödé and 😀',
    flags: [true, false, null],
  },
  meta: { via: 'api', durationMs: 12, warnings: ['A warning'] },
};

test('formatJson writes what JSON.stringify writes with two spaces', () => {
  for (const value of [SAMPLE, null, 0, -1.5, true, 'text', [], {}, [[]], { a: [] }]) {
    expect(formatJson(value)).toEqual({ text: JSON.stringify(value, null, 2), truncated: false });
  }
});

test('formatJson cuts a longer text at the limit, and says so', () => {
  const full = JSON.stringify(SAMPLE, null, 2);
  for (const limit of [0, 1, 10, 57, full.length - 1]) {
    expect(formatJson(SAMPLE, limit)).toEqual({ text: full.slice(0, limit), truncated: true });
  }
  expect(formatJson(SAMPLE, full.length)).toEqual({ text: full, truncated: false });
  expect(formatJson([1, 2], 1)).toEqual({ text: '[', truncated: true });
  // Cut where the inner list opens.
  expect(formatJson([[1], 2], 5)).toEqual({ text: '[\n  [', truncated: true });
  expect(formatJson(SAMPLE, Infinity)).toEqual({ text: full, truncated: false });

  const bars = Array.from({ length: 5000 }, (_, n) => ({ time: n, open: 1, high: 2, low: 0.5 }));
  const view = formatJson({ bars });
  expect(JSON_LIMIT).toBe(20_000);
  expect(view.truncated).toBe(true);
  expect(view.text).toBe(JSON.stringify({ bars }, null, 2).slice(0, 20_000));
});

test('formatJson reads no more of a huge value than the limit needs', () => {
  // A list of a million entries that counts the entries read.
  let read = 0;
  const entries = new Proxy(Array.from<number>({ length: 1_000_000 }).fill(7), {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) {
        read += 1;
      }
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  const view = formatJson({ entries });
  expect(view.truncated).toBe(true);
  expect(view.text).toHaveLength(20_000);
  expect(read).toBeLessThan(5000);

  // A text of 5 MB, such as an image written into the data: only its start is quoted.
  const image = 'A'.repeat(5_000_000);
  const cut = formatJson({ data: image });
  expect(cut.truncated).toBe(true);
  expect(cut.text).toBe(`{\n  "data": "${'A'.repeat(20_000 - 13)}`);
});
