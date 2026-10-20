import * as api from '../../src/index.js';
import { allTools } from '../../src/tools/index.js';
import { quietLogger, refusingLauncher, unreachableConnection } from '../helpers/tool-context.js';

// The package entry is the programmatic API (design spec 4): what it exports is a contract with
// everyone who embeds the server.
test('exports the programmatic API and nothing else at run time', () => {
  expect(Object.keys(api).sort()).toEqual(['VERSION', 'createMcpServer', 'loadConfig']);
});

test('builds a server from a loaded configuration', () => {
  const { config } = api.loadConfig({ argv: ['--profile', 'core'], env: {} });

  const { registry, ctx } = api.createMcpServer(config, {
    connection: unreachableConnection(),
    launcher: refusingLauncher(),
    logger: quietLogger,
  });

  expect(ctx.config.profile).toBe('core');
  // The tools that say they are core, in the order of the catalog. Which they are is pinned by
  // test/unit/tools/registry.test.ts.
  expect(registry.list().map(({ name }) => name)).toEqual(
    allTools.filter(({ core }) => core === true).map(({ name }) => name),
  );
});
