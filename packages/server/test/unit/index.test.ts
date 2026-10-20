import * as api from '../../src/index.js';
import { appTools } from '../../src/tools/app/index.js';
import { chartTools } from '../../src/tools/chart/index.js';
import { dataTools } from '../../src/tools/data/index.js';
import { indicatorTools } from '../../src/tools/indicator/index.js';
import { pineTools } from '../../src/tools/pine/index.js';
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
  // The tools of the app, of the chart, of the indicators and of Pine are all part of the core
  // profile, and so are the batch and the data tools but market depth.
  expect(registry.list().map(({ name }) => name)).toEqual([
    ...appTools.map(({ name }) => name),
    ...chartTools.map(({ name }) => name),
    ...dataTools.map(({ name }) => name).filter((name) => name !== 'data_get_market_depth'),
    ...indicatorTools.map(({ name }) => name),
    ...pineTools.map(({ name }) => name),
    'batch_run',
  ]);
});
