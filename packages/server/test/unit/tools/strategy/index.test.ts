import { z } from 'zod';
import { allTools } from '../../../../src/tools/index.js';
import { pineTools } from '../../../../src/tools/pine/index.js';
import { strategyTools } from '../../../../src/tools/strategy/index.js';
import type { AnyToolDefinition } from '../../../../src/tools/types.js';

// What the model and the client see of the Strategy Tester tools: their names, annotations and
// input schemas. The behavior behind them is tested through a server in
// test/integration/tools/strategy.test.ts.

function toolNamed(name: string): AnyToolDefinition {
  const tool = strategyTools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`There is no strategy tool ${name}`);
  }
  return tool;
}

const schemaOf = (name: string) => z.object(toolNamed(name).inputSchema);

test('strategyTools lists the three tools in the order of the catalog', () => {
  expect(strategyTools.map(({ name }) => name)).toEqual([
    'strategy_get_results',
    'strategy_get_trades',
    'strategy_get_equity',
  ]);
  expect(new Set(strategyTools.map(({ domain }) => domain))).toEqual(new Set(['strategy']));
});

test('the catalog lists the strategy tools after the Pine tools and before the batch', () => {
  const names = allTools.map(({ name }) => name);
  const lastPine = pineTools.at(-1);
  if (lastPine === undefined) {
    throw new Error('There are no Pine tools');
  }

  expect(names.indexOf('strategy_get_results')).toBe(names.indexOf(lastPine.name) + 1);
  expect(names.indexOf('batch_run')).toBe(names.indexOf('strategy_get_equity') + 1);
});

test('every strategy tool only reads, and only the results are in the core profile', () => {
  for (const tool of strategyTools) {
    expect(tool.annotations, tool.name).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(tool.description, tool.name).toMatch(/changes nothing/);
    expect(tool.description, tool.name).toMatch(/studyId/);
  }
  // The trades and the equity curve are there for a closer look, which the full profile offers.
  expect(strategyTools.filter(({ core }) => core === true).map(({ name }) => name)).toEqual([
    'strategy_get_results',
  ]);
});

test('every strategy tool takes the study to read and the chart it is on', () => {
  for (const { name } of strategyTools) {
    const schema = schemaOf(name);

    expect(schema.safeParse({}).success, name).toBe(true);
    expect(schema.safeParse({ studyId: 'STRAT01', chartIndex: 0 }).success, name).toBe(true);
    for (const bad of [
      { studyId: '' },
      { studyId: 'x'.repeat(65) },
      { chartIndex: -1 },
      { chartIndex: 1.5 },
    ]) {
      expect(schema.safeParse(bad).success, `${name} ${JSON.stringify(bad)}`).toBe(false);
    }
  }
});

test('strategy_get_trades takes a limit of 1 to 1000, 100 by default, and an offset from 0', () => {
  const schema = schemaOf('strategy_get_trades');

  expect(schema.parse({})).toEqual({ limit: 100, offset: 0 });
  expect(schema.parse({ limit: 1, offset: 5 })).toEqual({ limit: 1, offset: 5 });
  expect(schema.parse({ limit: 1000 })).toMatchObject({ limit: 1000 });
  for (const bad of [
    { limit: 0 },
    { limit: 1001 },
    { limit: 1.5 },
    { offset: -1 },
    { offset: 0.5 },
  ]) {
    expect(schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  }
});

test('strategy_get_equity takes maxPoints of 2 to 5000, 500 by default', () => {
  const schema = schemaOf('strategy_get_equity');

  expect(schema.parse({})).toEqual({ maxPoints: 500 });
  expect(schema.parse({ maxPoints: 2 })).toEqual({ maxPoints: 2 });
  expect(schema.parse({ maxPoints: 5000 })).toEqual({ maxPoints: 5000 });
  for (const bad of [{ maxPoints: 1 }, { maxPoints: 5001 }, { maxPoints: 2.5 }]) {
    expect(schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  }
});

test('strategy_get_results takes no paging', () => {
  expect(Object.keys(toolNamed('strategy_get_results').inputSchema).sort()).toEqual([
    'chartIndex',
    'studyId',
  ]);
});

test('the descriptions say what is derived and what is not known', () => {
  expect(toolNamed('strategy_get_equity').description).toMatch(/closed trades/);
  expect(toolNamed('strategy_get_equity').description).toMatch(/cumulative profit/);
  expect(toolNamed('strategy_get_trades').description).toMatch(/fills/);
  expect(toolNamed('strategy_get_results').description).toMatch(/numberOfWiningTrades/);
});

test('every strategy tool says that it returns the strategy it read', () => {
  for (const { name, description } of strategyTools) {
    expect(description, name).toMatch(/Returns strategy \(id, name\)/);
  }
});
