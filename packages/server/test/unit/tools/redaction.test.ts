import { REDACTED_ARGUMENTS, redactedArgs } from '../../../src/tools/redaction.js';
import { allTools } from '../../../src/tools/index.js';

// What the tool events keep of the arguments of a call, by the name of the tool. The registry and
// batch_run are tested in registry.test.ts; these are the edges of the walk itself.

const REDACTED = { redacted: true };

// `value` nested in `depth` objects, each under the key `deeper`.
function nested(depth: number, value: unknown): unknown {
  let result = value;
  for (let level = 0; level < depth; level += 1) {
    result = { deeper: result };
  }
  return result;
}

test('names tools that exist, so that a rename does not drop a redaction', () => {
  const names = new Set(allTools.map(({ name }) => name));

  expect(Object.keys(REDACTED_ARGUMENTS).filter((name) => !names.has(name))).toEqual([]);
  expect(Object.isFrozen(REDACTED_ARGUMENTS)).toBe(true);
});

test('keeps a named argument out in the lists of the arguments too', () => {
  expect(
    redactedArgs('alert_create', {
      price: 1,
      notes: [{ message: 'secret one' }, 'plain', [{ message: 'secret two' }]],
    }),
  ).toEqual({ price: 1, notes: [{ message: REDACTED }, 'plain', [{ message: REDACTED }]] });
});

test('stops walking beyond any depth an event shows, and keeps out what lies there', () => {
  // A value a caller in this process passed, which can even hold itself.
  const cyclic: Record<string, unknown> = { tool: 'batch_run' };
  cyclic.steps = [cyclic];

  const deepAlert = JSON.stringify(redactedArgs('alert_create', nested(40, { price: 1 })));
  const deepBatch = JSON.stringify(redactedArgs('batch_run', nested(40, { steps: [] })));

  expect(deepAlert).toContain('"redacted":true');
  expect(deepAlert).not.toContain('price');
  expect(deepBatch).toContain('"redacted":true');
  expect(deepBatch).not.toContain('steps');
  expect(() => redactedArgs('batch_run', { steps: [cyclic] })).not.toThrow();
});

test('shows the arguments of any other tool as they are', () => {
  const args = { symbol: 'NASDAQ:AAPL', nested: { message: 'shown' } };

  expect(redactedArgs('chart_set_symbol', args)).toBe(args);
});
