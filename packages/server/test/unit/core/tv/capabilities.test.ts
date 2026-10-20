import { TvMcpError } from '../../../../src/core/errors.js';
import { probeCapabilities, readCapabilities } from '../../../../src/core/tv/capabilities.js';
import type { TvWindow } from '../../../../src/core/tv/tv-window.js';
import {
  chart,
  cleanUpHarness,
  createApp,
  createManager,
  evaluationsOf,
  failing,
  firstSessionOf,
  fixture,
  windowFor,
} from '../../../helpers/fake-connection.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTvOverrides,
} from '../../../helpers/fake-tv/window.js';

afterEach(cleanUpHarness);

// What a page reports when it has none of it, like a blank page or a helper page of the app.
const NOTHING = {
  tradingViewApi: false,
  activeChart: false,
  chartModel: false,
  replayApi: false,
  pineEditorApi: false,
  webpackRegistry: false,
  tvd: false,
  buildTime: null,
};

// A page whose globals are whatever the test needs, to show how the probe copes with builds that
// differ from the one that was observed.
function pageWith(members: object): TvWindow {
  return members as TvWindow;
}

function boom(): never {
  throw new Error('boom');
}

// An object with a member that throws when it is read, like the getter of an app that is still
// starting.
function withThrowingMember(name: string, others: object = {}): object {
  return Object.defineProperty({ ...others }, name, { get: boom, enumerable: true });
}

// A page that has the API in `api` and nothing else.
function probeApi(api: unknown) {
  return probeCapabilities(pageWith({ TradingViewApi: api }));
}

describe('probeCapabilities', () => {
  test('reports features of the fake window', () => {
    expect(probeCapabilities(createFakeTvWindow(fixture))).toStrictEqual({
      tradingViewApi: true,
      activeChart: true,
      chartModel: true,
      // The fake models the chart API and the Pine editor API, not the replay API.
      replayApi: false,
      pineEditorApi: true,
      webpackRegistry: true,
      tvd: true,
      buildTime: fixture.buildTime,
    });
  });

  test('reports false for a window without TradingViewApi', () => {
    expect(probeCapabilities(createFakeTvWindow(fixture, { withoutApi: true }))).toStrictEqual({
      tradingViewApi: false,
      activeChart: false,
      chartModel: false,
      replayApi: false,
      pineEditorApi: false,
      // What does not depend on the API is still reported.
      webpackRegistry: true,
      tvd: true,
      buildTime: fixture.buildTime,
    });
  });

  test('reports nothing for a page that has none of it', () => {
    expect(probeCapabilities(pageWith({}))).toStrictEqual(NOTHING);
  });

  test('changes nothing on the window', () => {
    const win = createFakeTvWindow(fixture);
    const before = structuredClone(inspectFakeWindow(win).state);

    probeCapabilities(win);

    expect(inspectFakeWindow(win).calls).toEqual([]);
    expect(inspectFakeWindow(win).state).toEqual(before);
  });

  test('returns plain JSON, so that it crosses the page boundary as it is', () => {
    const report = probeCapabilities(createFakeTvWindow(fixture));

    expect(JSON.parse(JSON.stringify(report))).toStrictEqual(report);
  });

  describe('the API', () => {
    test.each<[string, unknown]>([
      ['null', null],
      ['a string', 'api'],
      ['a number', 1],
      ['true', true],
    ])('is not looked for in %s', (_case, api) => {
      expect(probeApi(api)).toStrictEqual(NOTHING);
    });

    test('is reported when it is an object, whatever it offers', () => {
      expect(probeApi({})).toStrictEqual({ ...NOTHING, tradingViewApi: true });
    });

    test.each<[string, unknown]>([
      ['not there', {}],
      ['not a function', { activeChart: {} }],
      ['a function that throws', { activeChart: boom }],
    ])('has no chart when activeChart is %s', (_case, api) => {
      expect(probeApi(api)).toStrictEqual({ ...NOTHING, tradingViewApi: true });
    });

    test.each<[string, unknown, boolean, boolean]>([
      ['a widget that has a model', { _chartWidget: { model: () => ({}) } }, true, true],
      ['no widget', {}, true, false],
      ['a null widget', { _chartWidget: null }, true, false],
      ['a widget without a model', { _chartWidget: {} }, true, false],
      ['a widget whose model is not a function', { _chartWidget: { model: {} } }, true, false],
      ['a string', 'chart', false, false],
      ['null', null, false, false],
      ['nothing', undefined, false, false],
    ])(
      'reads the chart and its model when activeChart() returns %s',
      (_case, returned, activeChart, chartModel) => {
        expect(probeApi({ activeChart: () => returned })).toStrictEqual({
          ...NOTHING,
          tradingViewApi: true,
          activeChart,
          chartModel,
        });
      },
    );

    test('is the receiver of the activeChart call, because its methods may rely on it', () => {
      const receivers: unknown[] = [];
      const api = {
        activeChart() {
          receivers.push(this);
          return {};
        },
      };

      probeApi(api);

      expect(receivers).toHaveLength(1);
      expect(receivers[0]).toBe(api);
    });

    test('offers the replay and Pine editor APIs when it has them', () => {
      expect(
        probeApi({ replayApi: () => undefined, pineEditorApi: () => undefined }),
      ).toStrictEqual({
        ...NOTHING,
        tradingViewApi: true,
        replayApi: true,
        pineEditorApi: true,
      });
    });

    test.each<[string, unknown]>([
      ['an object', {}],
      ['a string', 'api'],
      ['null', null],
    ])('does not offer a replay or Pine editor API that is %s', (_case, member) => {
      expect(probeApi({ replayApi: member, pineEditorApi: member })).toStrictEqual({
        ...NOTHING,
        tradingViewApi: true,
      });
    });

    // Nothing is known about what calling the replay or the Pine editor API sets going, so the
    // probe leaves them alone, and everything else too: the chart getter is the one call that is
    // known to change nothing.
    test('calls activeChart and nothing else of the app', () => {
      const untouched = {
        replayApi: vi.fn(),
        pineEditorApi: vi.fn(),
        chart: vi.fn(),
        isConnected: vi.fn(),
        symbol: vi.fn(),
        setSymbol: vi.fn(),
        model: vi.fn(),
      };
      const activeChart = vi.fn(() => ({
        symbol: untouched.symbol,
        setSymbol: untouched.setSymbol,
        _chartWidget: { model: untouched.model },
      }));

      const report = probeApi({
        activeChart,
        replayApi: untouched.replayApi,
        pineEditorApi: untouched.pineEditorApi,
        chart: untouched.chart,
        isConnected: untouched.isConnected,
      });

      expect(report).toStrictEqual({
        ...NOTHING,
        tradingViewApi: true,
        activeChart: true,
        chartModel: true,
        replayApi: true,
        pineEditorApi: true,
      });
      expect(activeChart).toHaveBeenCalledTimes(1);
      for (const [name, spy] of Object.entries(untouched)) {
        expect(spy, name).not.toHaveBeenCalled();
      }
    });
  });

  describe('the webpack registry', () => {
    test.each<[string, unknown, boolean]>([
      ['an empty list', [], true],
      ['a list of chunks', [[['chunk'], {}]], true],
      ['not there', undefined, false],
      ['null', null, false],
      ['an object that only looks like a list', { length: 0 }, false],
      ['a string', 'chunks', false],
    ])('is reported by the chunk list being a list: %s', (_case, chunks, webpackRegistry) => {
      expect(probeCapabilities(pageWith({ webpackChunktradingview: chunks }))).toStrictEqual({
        ...NOTHING,
        webpackRegistry,
      });
    });

    // Reaching the registry takes a push to this list, which runs code of the app's loader. The
    // probe only checks that the list is there.
    test('is left alone: not pushed to, not read, not listed', () => {
      const touched: string[] = [];
      const chunks = new Proxy<unknown[]>([], {
        get(target, property, receiver): unknown {
          touched.push(`get ${String(property)}`);
          return Reflect.get(target, property, receiver);
        },
        set(target, property, value, receiver) {
          touched.push(`set ${String(property)}`);
          return Reflect.set(target, property, value, receiver);
        },
        has(target, property) {
          touched.push(`has ${String(property)}`);
          return Reflect.has(target, property);
        },
        ownKeys(target) {
          touched.push('ownKeys');
          return Reflect.ownKeys(target);
        },
      });

      const report = probeCapabilities(pageWith({ webpackChunktradingview: chunks }));

      expect(report.webpackRegistry).toBe(true);
      expect(touched).toEqual([]);
    });
  });

  describe('the desktop bridge', () => {
    test.each<[string, unknown, boolean]>([
      ['an object', { reloadTab: () => undefined }, true],
      ['an empty object', {}, true],
      ['not there', undefined, false],
      ['null', null, false],
      ['a string', 'TVD', false],
    ])('is reported when it is an object: %s', (_case, tvd, expected) => {
      expect(probeCapabilities(pageWith({ TVD: tvd }))).toStrictEqual({
        ...NOTHING,
        tvd: expected,
      });
    });
  });

  describe('the build time', () => {
    test.each(['2026-10-16T17:55:37', ''])('is reported when it is the string %j', (buildTime) => {
      expect(probeCapabilities(pageWith({ BUILD_TIME: buildTime })).buildTime).toBe(buildTime);
    });

    test.each<[string, unknown]>([
      ['not there', undefined],
      ['null', null],
      ['a number', 20261016],
      ['an object', { at: '2026-10-16' }],
    ])('is null when it is %s', (_case, buildTime) => {
      expect(probeCapabilities(pageWith({ BUILD_TIME: buildTime })).buildTime).toBeNull();
    });
  });

  // The probe runs when the app is in any state, a half-booted one included, so it answers with
  // what it could read and never fails.
  describe('never throws', () => {
    const OTHERS = { TVD: {}, webpackChunktradingview: [], BUILD_TIME: 'build' };
    const REST = { ...NOTHING, webpackRegistry: true, tvd: true, buildTime: 'build' };

    test.each<[string, TvWindow, object]>([
      ['TradingViewApi', pageWith(withThrowingMember('TradingViewApi', OTHERS)), REST],
      [
        'TVD',
        pageWith(withThrowingMember('TVD', { ...OTHERS, TradingViewApi: {} })),
        { ...REST, tradingViewApi: true, tvd: false },
      ],
      [
        'webpackChunktradingview',
        pageWith(withThrowingMember('webpackChunktradingview', { ...OTHERS, TradingViewApi: {} })),
        { ...REST, tradingViewApi: true, webpackRegistry: false },
      ],
      [
        'BUILD_TIME',
        pageWith(withThrowingMember('BUILD_TIME', { ...OTHERS, TradingViewApi: {} })),
        { ...REST, tradingViewApi: true, buildTime: null },
      ],
      [
        'activeChart',
        pageWith({
          ...OTHERS,
          TradingViewApi: withThrowingMember('activeChart', { replayApi: () => undefined }),
        }),
        { ...REST, tradingViewApi: true, replayApi: true },
      ],
      [
        'replayApi',
        pageWith({
          ...OTHERS,
          TradingViewApi: withThrowingMember('replayApi', { activeChart: () => ({}) }),
        }),
        { ...REST, tradingViewApi: true, activeChart: true },
      ],
      [
        'pineEditorApi',
        pageWith({
          ...OTHERS,
          TradingViewApi: withThrowingMember('pineEditorApi', { activeChart: () => ({}) }),
        }),
        { ...REST, tradingViewApi: true, activeChart: true },
      ],
      [
        '_chartWidget',
        pageWith({
          ...OTHERS,
          TradingViewApi: { activeChart: () => withThrowingMember('_chartWidget') },
        }),
        { ...REST, tradingViewApi: true, activeChart: true },
      ],
      [
        'model',
        pageWith({
          ...OTHERS,
          TradingViewApi: {
            activeChart: () => ({ _chartWidget: withThrowingMember('model') }),
          },
        }),
        { ...REST, tradingViewApi: true, activeChart: true },
      ],
    ])('when reading %s throws, and still reports the rest', (_member, win, expected) => {
      expect(probeCapabilities(win)).toStrictEqual(expected);
    });
  });
});

describe('readCapabilities', () => {
  // The chart tab of an app whose window is built with `overrides`, reached the way a tool reaches
  // it.
  async function chartPageOf(overrides: FakeTvOverrides = {}) {
    const app = createApp([chart('A')]);
    app.windows.set('A', createFakeTvWindow(fixture, overrides));
    const { manager } = createManager(app);
    return { app, page: await manager.chartPage() };
  }

  test('reads the capabilities of the chart tab through the page bridge', async () => {
    const { page } = await chartPageOf();

    await expect(readCapabilities(page)).resolves.toStrictEqual({
      tradingViewApi: true,
      activeChart: true,
      chartModel: true,
      replayApi: false,
      pineEditorApi: true,
      webpackRegistry: true,
      tvd: true,
      buildTime: fixture.buildTime,
    });
  });

  test('reads a page whose app has not booted', async () => {
    const { page } = await chartPageOf({ withoutApi: true });

    await expect(readCapabilities(page)).resolves.toStrictEqual({
      ...NOTHING,
      webpackRegistry: true,
      tvd: true,
      buildTime: fixture.buildTime,
    });
  });

  // The app boots after the page has loaded, so a report taken earlier would say it is not there.
  test('reads the page again on every call', async () => {
    const { app, page } = await chartPageOf({ withoutApi: true });

    expect((await readCapabilities(page)).tradingViewApi).toBe(false);

    // The app boots: the API appears on the window of the page.
    Object.assign(windowFor(app, 'A'), { TradingViewApi: {} });

    expect((await readCapabilities(page)).tradingViewApi).toBe(true);
    expect(evaluationsOf(firstSessionOf(app, 'A'))).toHaveLength(2);
  });

  test('fails with the error of the bridge instead of reporting an empty page', async () => {
    const { app, page } = await chartPageOf();
    const timeout = new TvMcpError('TIMEOUT', 'The page did not answer');
    app.onEvaluate = failing(timeout);

    await expect(readCapabilities(page)).rejects.toBe(timeout);
  });
});
