import { READ_ONLY } from '../../../src/tools/annotations.js';
import { dataTools } from '../../../src/tools/data/index.js';
import { indicatorTools } from '../../../src/tools/indicator/index.js';
import { pineTools } from '../../../src/tools/pine/index.js';
import { strategyTools } from '../../../src/tools/strategy/index.js';

// The annotation preset the tool definitions share, so that every tool that only reads says it
// with one and the same set of hints.

test('READ_ONLY says that a tool only reads and reaches nothing beyond the local app', () => {
  expect(READ_ONLY).toEqual({
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
});

test.each([
  ['data', dataTools],
  ['indicator', indicatorTools],
  ['Pine', pineTools],
  ['Strategy Tester', strategyTools],
])('every %s tool that only reads shares READ_ONLY', (_domain, tools) => {
  const readers = tools.filter(({ annotations }) => annotations.readOnlyHint === true);

  // Not an empty loop: each of these domains has tools that read.
  expect(readers.length).toBeGreaterThan(0);
  for (const tool of readers) {
    // The object itself, not a copy of its values: a local constant would pass a deep comparison.
    expect(tool.annotations, tool.name).toBe(READ_ONLY);
  }
});
