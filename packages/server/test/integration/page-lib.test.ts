import { createCriConnector } from '../../src/core/cdp/cri-connector.js';
import { createHttpDiscovery } from '../../src/core/cdp/discovery.js';
import {
  createPageBridge,
  type PageBridge,
  type PageErrorSentinel,
} from '../../src/core/tv/page-bridge.js';
import { createPageLib, type PageLib } from '../../src/core/tv/page-lib.js';
import { readVisibilityState } from '../../src/core/tv/probes.js';
import type { TvWindow } from '../../src/core/tv/tv-window.js';
import { failureOf } from '../helpers/failure-of.js';
import { startFakeCdpServer, type FakeCdpServer } from '../helpers/fake-cdp/server.js';
import { loadTargetsFixture } from '../helpers/fake-cdp/targets.js';
import { loadTvFixture } from '../helpers/fake-tv/fixture.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTvOverrides,
  type FakeTvWindow,
} from '../helpers/fake-tv/window.js';

const CHART_ID = 'BBB144A7827AE55CBA0E74986FC9574C';
const CALL_TIMEOUT_MS = 5000;

// Everything a test starts is registered here, because a server that is still listening or a
// socket that is still open keeps the vitest worker from exiting.
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

interface Page {
  server: FakeCdpServer;
  win: FakeTvWindow;
  bridge: PageBridge;
}

// The observed target list of the app, with a fake TradingView window on its chart tab, and the
// page bridge on a session to that tab, the way the connection manager hands them out.
async function openPage(overrides: FakeTvOverrides = {}): Promise<Page> {
  const win = createFakeTvWindow(loadTvFixture(), overrides);
  const server = await startFakeCdpServer({
    targets: loadTargetsFixture({ chartWindow: () => win }),
  });
  cleanups.push(() => server.close());
  const discovery = createHttpDiscovery({
    host: server.host,
    port: server.port,
    timeoutMs: CALL_TIMEOUT_MS,
  });
  const target = (await discovery.targets()).find((candidate) => candidate.id === CHART_ID);
  if (target === undefined) {
    throw new Error(`The fake server does not list ${CHART_ID}`);
  }
  const connector = createCriConnector({
    host: server.host,
    port: server.port,
    defaultTimeoutMs: CALL_TIMEOUT_MS,
  });
  const session = await connector.connect(target);
  cleanups.push(() => session.close());
  return { server, win, bridge: createPageBridge(session, { timeoutMs: CALL_TIMEOUT_MS }) };
}

// Synthetic modules in the shapes the tools will look up: a study repository, and the plan
// features with a config module that is told apart from another getConfig by a second export.
function webpackModules(): Record<string, Record<string, unknown>> {
  return {
    1: { getConfig: () => ({ theme: 'dark' }) },
    2: { studyMetaInfoRepository: { names: () => ['Moving Average', 'Relative Strength Index'] } },
    3: { ProductFeatures: { INDICATORS_ON_CHART: 'indicators_on_chart' } },
    4: { getConfig: () => ({ limit: 2 }), getProductFeaturesConfig: () => ({}) },
  };
}

// Page functions of the tests, in the shapes the domain modules will use.

// The names of the studies of the app that start with `prefix`, from its study repository.
function listStudyNames(win: TvWindow, lib: PageLib, prefix: string): string[] | PageErrorSentinel {
  const repository = lib.findExport('studyMetaInfoRepository') as { names?: () => string[] } | null;
  if (typeof repository?.names !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: `This page has no study repository on ${win.location.hostname}`,
        hint: 'Check app_health: the chart may still be loading.',
      },
    };
  }
  return repository.names().filter((name) => name.startsWith(prefix));
}

// Two lookups in one call: the limit of a plan feature, through two modules.
function readFeatureLimit(win: TvWindow, lib: PageLib, feature: string): number | null {
  const features = lib.findExport('ProductFeatures') as Record<string, string> | null;
  const config = lib.findModuleWith(['getConfig', 'getProductFeaturesConfig']) as {
    getConfig: (key: string) => { limit?: number };
  } | null;
  const key = features?.[feature];
  if (key === undefined || config === null) {
    return null;
  }
  return config.getConfig(key).limit ?? null;
}

test('evaluateWithLib reaches a webpack export through the fake CDP page', async () => {
  const { server, win, bridge } = await openPage({ webpackModules: webpackModules() });

  const names = await bridge.evaluateWithLib(listStudyNames, ['Relative']);
  const limit = await bridge.evaluateWithLib(readFeatureLimit, ['INDICATORS_ON_CHART']);

  expect(names).toEqual(['Relative Strength Index']);
  expect(limit).toBe(2);
  expect(
    server.calls.map(({ targetId, method, params }) => ({ targetId, method, params })),
  ).toEqual([
    {
      targetId: CHART_ID,
      method: 'Runtime.evaluate',
      params: {
        expression: `(${listStudyNames.toString()})(window, (${createPageLib.toString()})(window), ...["Relative"])`,
        returnByValue: true,
        awaitPromise: true,
      },
    },
    expect.objectContaining({ method: 'Runtime.evaluate' }),
  ]);
  // Looking up leaves the chart as it was.
  expect(inspectFakeWindow(win).calls).toEqual([]);
});

test('pushes one chunk per call, however many lookups, and leaves no global behind', async () => {
  const { win, bridge } = await openPage({ webpackModules: webpackModules() });
  // The first evaluation sets the page up, so what the library does is all that changes after it.
  await bridge.evaluate(readVisibilityState, []);
  const globals = Object.getOwnPropertyNames(win);

  await bridge.evaluateWithLib(readFeatureLimit, ['INDICATORS_ON_CHART']);
  await bridge.evaluateWithLib(readFeatureLimit, ['NO_SUCH_FEATURE']);
  await bridge.evaluateWithLib(listStudyNames, ['Moving']);

  expect(win.webpackChunktradingview).toHaveLength(3);
  const chunkIds = (win.webpackChunktradingview as [string[]][]).map(([ids]) => ids[0]);
  expect(new Set(chunkIds).size).toBe(3);
  expect(Object.getOwnPropertyNames(win)).toEqual(globals);
});

test('relays the sentinel of a page function that finds no export as a typed error', async () => {
  // A plain chunk list, as before the webpack runtime has loaded: the push hands nothing back.
  const { win, bridge } = await openPage();

  const error = await failureOf(bridge.evaluateWithLib(listStudyNames, ['Moving']));
  const limit = await bridge.evaluateWithLib(readFeatureLimit, ['INDICATORS_ON_CHART']);

  expect(error.toPayload()).toEqual({
    code: 'CAPABILITY_UNAVAILABLE',
    message: 'This page has no study repository on www.tradingview.com',
    hint: 'Check app_health: the chart may still be loading.',
  });
  expect(limit).toBeNull();
  // Each push stays in the list as an inert chunk: no module, and a callback whose call by a
  // runtime that loads later changes nothing.
  expect(win.webpackChunktradingview).toHaveLength(2);
});
