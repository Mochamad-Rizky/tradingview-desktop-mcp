import { batchRun, runBatch } from '../../../../src/tools/batch/index.js';
import { CLIENT_SAFE_BUDGET_MS } from '../../../../src/tools/chart/strategies.js';
import { createToolRegistry } from '../../../../src/tools/registry.js';
import { defineTool, type ToolContext } from '../../../../src/tools/types.js';
import { createTestContext } from '../../../helpers/tool-context.js';

// batch_run within the time a client waits for one call: a step that a client gave up on and sent
// again would run twice, so no step starts once the client-safe budget is spent. The steps run
// through a real registry, on a clock the test moves.

// A registry with batch_run and one step that takes `stepMs` of the clock, and a context to run a
// batch in.
function batchWith(stepMs: number): { ctx: ToolContext; clock: { now: number }; ran: number[] } {
  const clock = { now: 0 };
  const ran: number[] = [];
  const step = defineTool({
    name: 'chart_step',
    domain: 'chart',
    title: 'Step',
    description: 'Takes its time, as a step of a batch may.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
    handler: () => {
      ran.push(clock.now);
      clock.now += stepMs;
      return Promise.resolve({ data: { startedAt: ran.length } });
    },
  });
  const base = createTestContext();
  const registry = createToolRegistry([batchRun, step], base);
  return { ctx: { ...base, registry }, clock, ran };
}

const steps = (count: number) =>
  Array.from({ length: count }, () => ({ tool: 'chart_step', arguments: {} }));

test('batch_run starts no step once its time is spent, and returns the steps it ran with a warning', async () => {
  const { ctx, clock, ran } = batchWith(400);

  const output = await runBatch({ steps: steps(5), stopOnError: true }, ctx, 1000, () => clock.now);

  // Steps start at 0, 400 and 800 ms; at 1200 ms the 1000 ms are spent.
  expect(ran).toEqual([0, 400, 800]);
  expect(output.data).toMatchObject({ completed: 3, stopped: true });
  expect(output.warnings).toEqual([
    'Ran 3 of 5 steps within the 1 s a call allows, and started none after that: send the other ' +
      '2 in another batch_run.',
  ]);
});

test('batch_run runs every step, without a warning, while its time lasts', async () => {
  const { ctx, clock, ran } = batchWith(100);

  const output = await runBatch({ steps: steps(5), stopOnError: true }, ctx, 1000, () => clock.now);

  expect(ran).toHaveLength(5);
  expect(output.data).toMatchObject({ completed: 5, stopped: false });
  expect(output.warnings).toEqual([]);
});

test('batch_run keeps to the time a client waits for one call, and says so', () => {
  expect(CLIENT_SAFE_BUDGET_MS).toBe(45_000);
  expect(batchRun.description).toMatch(/45 s/);
});
