import { setTimeout as delay } from 'node:timers/promises';
import type { CdpSession } from '../../../../src/core/cdp/types.js';
import type { TvMcpError } from '../../../../src/core/errors.js';
import {
  createPageBridge,
  type PageBridge,
  type PageFunction,
  type PageLibFunction,
} from '../../../../src/core/tv/page-bridge.js';
import { createPageLib } from '../../../../src/core/tv/page-lib.js';
import type { TvWindow } from '../../../../src/core/tv/tv-window.js';
import {
  awaitChartsData,
  focusChart,
  readChartSymbols,
  readLayoutCount,
  readPanes,
  setLayoutViaApi,
} from '../../../../src/tools/pane/page.js';
import type { JsonValue } from '../../../../src/utils/json.js';
import { failureOf } from '../../../helpers/failure-of.js';
import { createPageRuntime } from '../../../helpers/fake-cdp/runtime.js';
import { loadTvFixture, type TvStateFixture } from '../../../helpers/fake-tv/fixture.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTradingViewApi,
  type FakeTvOverrides,
  type FakeTvWindow,
} from '../../../helpers/fake-tv/window.js';
import { withTwoCharts } from '../../../helpers/pane-fixtures.js';

// The page functions of the pane tools, run the way the server runs them, as source text in a page
// through the real page bridge, and called directly on a second window built the same way, which is
// what the coverage of the module measures. The two answers must agree. Values are synthetic.

const fixture = loadTvFixture();
const twoCharts = withTwoCharts(fixture);
const WAIT_MS = 1000;
// For the waits that are meant to give up.
const SHORT_WAIT_MS = 60;

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
});

function bridgeTo(win: object): PageBridge {
  const runtime = createPageRuntime(win);
  disposers.push(() => {
    runtime.dispose();
  });
  const send = (method: string, params?: unknown): Promise<unknown> =>
    method === 'Runtime.evaluate'
      ? runtime.evaluate(params as Record<string, unknown>)
      : Promise.reject(new Error(`Unexpected command ${method}`));
  const session: CdpSession = {
    targetId: 'PAGE1',
    isClosed: false,
    send: send as CdpSession['send'],
    onClose: () => undefined,
    close: () => Promise.resolve(),
  };
  return createPageBridge(session, { timeoutMs: 5000 });
}

type Make = () => object;

const chart =
  (from: TvStateFixture = fixture, overrides: FakeTvOverrides = {}): Make =>
  () =>
    createFakeTvWindow(from, overrides);

// A fake chart changed by `change` after it is built.
const changed =
  (
    change: (win: FakeTvWindow) => void,
    from: TvStateFixture = twoCharts,
    overrides: FakeTvOverrides = {},
  ): Make =>
  () => {
    const win = createFakeTvWindow(from, overrides);
    change(win);
    return win;
  };

// A fake chart whose TradingViewApi is changed by `change`.
const withApi = (
  change: (api: FakeTradingViewApi, win: FakeTvWindow) => void,
  from: TvStateFixture = twoCharts,
): Make =>
  changed((win) => {
    if (win.TradingViewApi !== undefined) {
      change(win.TradingViewApi, win);
    }
  }, from);

async function resultOf<A extends JsonValue[], R extends JsonValue | null>(
  fn: PageFunction<A, R>,
  args: A,
  make: Make,
): Promise<{ result: R; win: object }> {
  const win = make();
  const result = await bridgeTo(win).evaluate(fn, args);
  const direct = await fn(make() as TvWindow, ...args);
  expect(direct).toEqual(result);
  return { result, win };
}

async function failureOfBoth<A extends JsonValue[], R extends JsonValue | null>(
  fn: PageFunction<A, R>,
  args: A,
  make: Make,
): Promise<{ error: TvMcpError; win: object }> {
  const win = make();
  const error = await failureOf(bridgeTo(win).evaluate(fn, args));
  const direct = await fn(make() as TvWindow, ...args);
  expect(direct).toEqual({ __tvmcpError: error.toPayload() });
  return { error, win };
}

async function libResultOf<A extends JsonValue[], R extends JsonValue | null>(
  fn: PageLibFunction<A, R>,
  args: A,
  make: Make,
): Promise<{ result: R; win: object }> {
  const win = make();
  const result = await bridgeTo(win).evaluateWithLib(fn, args);
  const other = make() as TvWindow;
  const direct = await fn(other, createPageLib(other), ...args);
  expect(direct).toEqual(result);
  return { result, win };
}

const calls = (win: object, name: string) => inspectFakeWindow(win).callsTo(name);

// The module of a fake window whose exports include `name`, which a test changes in place.
let probes = 0;
function moduleWith(win: FakeTvWindow, name: string): Record<string, unknown> {
  let handed: { c: Record<string, { exports: Record<string, unknown> }> } | undefined;
  probes += 1;
  (win.webpackChunktradingview as { push(chunk: unknown): unknown }).push([
    [`probe${String(probes)}`],
    {},
    (given: typeof handed) => (handed = given),
  ]);
  const found = Object.values(handed?.c ?? {}).find((record) =>
    Object.hasOwn(record.exports, name),
  );
  if (found === undefined) {
    throw new Error(`No module exports ${name}`);
  }
  return found.exports;
}

// A fake chart whose table of layouts is changed by `change`.
const withTable = (change: (table: Record<string, unknown>) => void): Make =>
  changed((win) => {
    change(moduleWith(win, 'layouts').layouts as Record<string, unknown>);
  }, fixture);

const failing = (message: string) => (): never => {
  throw new Error(message);
};

describe('readPanes', () => {
  test('reads each chart of the layout, its symbol, resolution and panes, and which one is active', async () => {
    const { result } = await resultOf(readPanes, [], chart(twoCharts));

    expect(result).toEqual({
      layout: '2h',
      charts: [
        {
          index: 0,
          symbol: 'NASDAQ:AAPL',
          resolution: '1D',
          active: true,
          panes: [
            { index: 0, height: 420, studyIds: ['STUDY01'], hasMainSeries: true },
            { index: 1, height: 180, studyIds: ['STUDY02'], hasMainSeries: false },
          ],
        },
        {
          index: 1,
          symbol: 'NASDAQ:MSFT',
          resolution: '60',
          active: false,
          panes: [
            { index: 0, height: 400, studyIds: ['C1STUDY1'], hasMainSeries: true },
            { index: 1, height: 200, studyIds: ['C1STUDY2'], hasMainSeries: false },
          ],
        },
      ],
    });
  });

  test('reads a layout of one chart, whose one pane holds the studies, the main series and the drawings', async () => {
    const { result, win } = await resultOf(readPanes, [], chart());

    expect(result).toEqual({
      layout: 's',
      charts: [
        {
          index: 0,
          symbol: 'NASDAQ:AAPL',
          resolution: '1D',
          active: true,
          panes: [{ index: 0, height: 600, studyIds: ['STUDY01', 'STUDY02'], hasMainSeries: true }],
        },
      ],
    });
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('a page without the chart API is CAPABILITY_UNAVAILABLE', async () => {
    for (const make of [
      chart(fixture, { withoutApi: true }),
      withApi((api) => {
        Reflect.deleteProperty(api, 'chart');
      }),
    ]) {
      expect((await failureOfBoth(readPanes, [], make)).error.code).toBe('CAPABILITY_UNAVAILABLE');
    }
  });

  test.each([
    ['no number', '2'],
    ['zero', 0],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
  ])('a chart count that is %s is NOT_AVAILABLE', async (_case, count) => {
    const { error } = await failureOfBoth(
      readPanes,
      [],
      withApi((api) => {
        api.chartsCount = () => count as number;
      }),
    );

    expect(error.code).toBe('NOT_AVAILABLE');
  });

  test('a chart that cannot be reached is reported with nulls', async () => {
    const { result } = await resultOf(
      readPanes,
      [],
      chart({ ...fixture, layout: { ...fixture.layout, chartsCount: 2 } }),
    );

    expect(result.charts[1]).toEqual({
      index: 1,
      symbol: null,
      resolution: null,
      active: false,
      panes: null,
    });
  });

  test('what a chart or a pane does not answer is null, and the active flag is false when the active chart is not known', async () => {
    const { result } = await resultOf(
      readPanes,
      [],
      withApi((api) => {
        api.layout = failing('No layout');
        api.activeChartIndex = failing('No active chart');
        const first = api.chart(0);
        first.symbol = failing('No symbol');
        first.getAllStudies = () => 'not a list' as unknown as { id: string; name: string }[];
        const second = api.chart(1);
        second.resolution = () => 60 as unknown as string;
        const panes = second.getPanes();
        const [top, bottom] = panes;
        if (top === undefined || bottom === undefined) {
          throw new Error('Chart 1 has two panes');
        }
        top.getHeight = () => Number.POSITIVE_INFINITY;
        top.hasMainSeries = () => 'yes' as unknown as boolean;
        top.paneIndex = () => '0' as unknown as number;
        bottom.getAllEntities = failing('No entities');
        second.getPanes = () => panes;
      }),
    );

    expect(result).toEqual({
      layout: null,
      charts: [
        {
          index: 0,
          symbol: null,
          resolution: '1D',
          active: false,
          panes: [
            { index: 0, height: 420, studyIds: null, hasMainSeries: true },
            { index: 1, height: 180, studyIds: null, hasMainSeries: false },
          ],
        },
        {
          index: 1,
          symbol: 'NASDAQ:MSFT',
          resolution: null,
          active: false,
          panes: [
            { index: 0, height: null, studyIds: ['C1STUDY1'], hasMainSeries: null },
            { index: 1, height: 200, studyIds: null, hasMainSeries: false },
          ],
        },
      ],
    });
  });

  test('panes that are no list, and entities with ids that are no text, are left out', async () => {
    const { result } = await resultOf(
      readPanes,
      [],
      withApi((api) => {
        api.chart(1).getPanes = () => 'none' as unknown as [];
        const [pane] = api.chart(0).getPanes();
        if (pane === undefined) {
          throw new Error('Chart 0 has a pane');
        }
        const entities = pane.getAllEntities();
        pane.getAllEntities = () => [
          ...entities,
          { id: 7, name: 'a number' } as unknown as { id: string; name: string },
          null as unknown as { id: string; name: string },
        ];
        api.chart(0).getPanes = () => [pane, 'not a pane' as unknown as typeof pane];
        api.layout = () => '';
      }),
    );

    expect(result.charts[0]?.panes).toEqual([
      { index: 0, height: 420, studyIds: ['STUDY01'], hasMainSeries: true },
      { index: 1, height: null, studyIds: null, hasMainSeries: null },
    ]);
    expect(result.charts[1]?.panes).toBeNull();
    // An empty type is no type, as readChartLayout reads it.
    expect(result.layout).toBeNull();
  });
});

describe('readLayoutCount', () => {
  test('reads how many charts a layout has from the table of layouts of the app', async () => {
    for (const [code, count] of [
      ['s', 1],
      ['2h', 2],
      ['4', 4],
      ['16c4', 16],
    ] as const) {
      expect((await libResultOf(readLayoutCount, [code], chart())).result).toEqual({
        found: true,
        known: true,
        count,
      });
    }
  });

  test('a code the table does not have is unknown, an own member of objects too', async () => {
    for (const code of ['2-2-l', 'constructor', '__proto__']) {
      expect(
        (
          await libResultOf(
            readLayoutCount,
            [code],
            chart(fixture, { charts: { withoutCodes: ['2-2-l'] } }),
          )
        ).result,
      ).toEqual({ found: true, known: false, count: null });
    }
  });

  test.each([
    ['missing', undefined],
    ['zero', 0],
    ['a fraction', 1.5],
    ['text', '2'],
  ])('a count that is %s is not known', async (_case, count) => {
    const { result } = await libResultOf(
      readLayoutCount,
      ['2v'],
      withTable((table) => {
        table['2v'] = { title: '2 charts', layoutType: '2v', count };
      }),
    );

    expect(result).toEqual({ found: true, known: true, count: null });
  });

  test('a layout that is no object has no count', async () => {
    const { result } = await libResultOf(
      readLayoutCount,
      ['2v'],
      withTable((table) => {
        table['2v'] = 'two';
      }),
    );

    expect(result).toEqual({ found: true, known: true, count: null });
  });

  test('a count whose read throws is not known, and a table whose read throws is not found', async () => {
    const counted = await libResultOf(
      readLayoutCount,
      ['2v'],
      withTable((table) => {
        table['2v'] = {
          get count(): never {
            throw new Error('Not ready');
          },
        };
      }),
    );
    const unread = await libResultOf(
      readLayoutCount,
      ['2v'],
      changed((win) => {
        Object.defineProperty(moduleWith(win, 'layouts'), 'layouts', {
          get(): never {
            throw new Error('Not set up');
          },
        });
      }, fixture),
    );

    expect(counted.result).toEqual({ found: true, known: true, count: null });
    expect(unread.result).toEqual({ found: false, known: false, count: null });
  });

  test('without the table, or with one that is no object, nothing is found', async () => {
    for (const make of [
      chart(fixture, { charts: { withoutLayoutTable: true } }),
      chart(fixture, { withoutWebpackRuntime: true }),
      changed((win) => {
        moduleWith(win, 'layouts').layouts = null;
      }, fixture),
    ]) {
      expect((await libResultOf(readLayoutCount, ['2h'], make)).result).toEqual({
        found: false,
        known: false,
        count: null,
      });
    }
  });
});

describe('setLayoutViaApi', () => {
  test('sets a layout with the undo step of the app and returns at once', async () => {
    const { result, win } = await resultOf(setLayoutViaApi, ['3h', 3, false], chart(twoCharts));

    expect(result).toEqual({ outcome: 'set', chartsCount: 2 });
    expect(calls(win, 'TradingViewApi.setLayout')).toEqual([['3h', { withUndo: true }]]);
  });

  test('the layout shown already is left alone', async () => {
    const { result, win } = await resultOf(setLayoutViaApi, ['2h', 2, false], chart(twoCharts));

    expect(result).toEqual({ outcome: 'same', chartsCount: 2 });
    expect(calls(win, 'TradingViewApi.setLayout')).toEqual([]);
  });

  test('a layout of fewer charts is set only with confirm', async () => {
    const refused = await resultOf(setLayoutViaApi, ['s', 1, false], chart(twoCharts));
    const confirmed = await resultOf(setLayoutViaApi, ['s', 1, true], chart(twoCharts));

    expect(refused.result).toEqual({ outcome: 'fewer', chartsCount: 2 });
    expect(calls(refused.win, 'TradingViewApi.setLayout')).toEqual([]);
    expect(confirmed.result).toEqual({ outcome: 'set', chartsCount: 2 });
    expect(calls(confirmed.win, 'TradingViewApi.setLayout')).toEqual([['s', { withUndo: true }]]);
  });

  test('a count of charts that cannot be read counts as fewer, unless confirm', async () => {
    const make = withApi((api) => {
      api.chartsCount = () => Number.NaN;
    });

    expect((await resultOf(setLayoutViaApi, ['4', 4, false], make)).result).toEqual({
      outcome: 'fewer',
      chartsCount: null,
    });
    expect((await resultOf(setLayoutViaApi, ['4', 4, true], make)).result).toEqual({
      outcome: 'set',
      chartsCount: null,
    });
  });

  test('a type and a count of charts whose read throws are not known', async () => {
    const make = withApi((api) => {
      api.layout = failing('No layout');
      api.chartsCount = failing('No count');
    });

    const refused = await resultOf(setLayoutViaApi, ['2h', 2, false], make);
    const confirmed = await resultOf(setLayoutViaApi, ['2h', 2, true], make);

    expect(refused.result).toEqual({ outcome: 'fewer', chartsCount: null });
    expect(calls(refused.win, 'TradingViewApi.setLayout')).toEqual([]);
    expect(confirmed.result).toEqual({ outcome: 'set', chartsCount: null });
    expect(calls(confirmed.win, 'TradingViewApi.setLayout')).toEqual([['2h', { withUndo: true }]]);
  });

  test('a setLayout that answers with a promise that fails leaves no unhandled rejection', async () => {
    const make = withApi((api) => {
      (api as { setLayout(...args: unknown[]): unknown }).setLayout = () =>
        Promise.reject(new Error('Not now'));
    });

    expect((await resultOf(setLayoutViaApi, ['3h', 3, false], make)).result).toEqual({
      outcome: 'set',
      chartsCount: 2,
    });
    await delay(1);
  });

  test('a setLayout that throws fails the call', async () => {
    const make = withApi((api) => {
      api.setLayout = failing('Cannot set the layout');
    });

    const error = await failureOf(bridgeTo(make()).evaluate(setLayoutViaApi, ['3h', 3, false]));

    expect(error.code).toBe('PAGE_EVALUATION_FAILED');
    expect(error.message).toBe('Error: Cannot set the layout');
    expect(() => setLayoutViaApi(make() as TvWindow, '3h', 3, false)).toThrow(
      'Cannot set the layout',
    );
  });

  test('a page without setLayout, layout or chartsCount is CAPABILITY_UNAVAILABLE, before it acts', async () => {
    for (const member of ['setLayout', 'layout', 'chartsCount']) {
      const { error, win } = await failureOfBoth(
        setLayoutViaApi,
        ['3h', 3, true],
        withApi((api) => {
          Reflect.deleteProperty(api, member);
        }),
      );

      expect(error.code, member).toBe('CAPABILITY_UNAVAILABLE');
      expect(calls(win, 'TradingViewApi.setLayout')).toEqual([]);
    }
    expect(
      (await failureOfBoth(setLayoutViaApi, ['3h', 3, true], chart(fixture, { withoutApi: true })))
        .error.code,
    ).toBe('CAPABILITY_UNAVAILABLE');
  });
});

describe('awaitChartsData', () => {
  test('answers no chart when every chart has its data', async () => {
    expect((await resultOf(awaitChartsData, [2, WAIT_MS], chart(twoCharts))).result).toEqual({
      notReady: [],
    });
  });

  test('names the charts whose data does not come within the wait', async () => {
    const make = changed((win) => {
      const other = inspectFakeWindow(win).state.charts.others[0];
      if (other !== undefined) {
        other.dataReady = false;
      }
    });

    expect((await resultOf(awaitChartsData, [2, SHORT_WAIT_MS], make)).result).toEqual({
      notReady: [1],
    });
  });

  test('a chart without dataReady, one whose dataReady throws, fails or answers no, and one it cannot reach count as not ready', async () => {
    const make = withApi((api) => {
      const first = api.chart(0);
      const second = api.chart(1);
      Reflect.deleteProperty(first, 'dataReady');
      second.dataReady = () => Promise.resolve(false as unknown as true);
    });
    const throwing = withApi((api) => {
      api.chart(0).dataReady = failing('Not ready');
      api.chart(1).dataReady = () => Promise.reject(new Error('Failed'));
    });

    expect((await resultOf(awaitChartsData, [3, WAIT_MS], make)).result).toEqual({
      notReady: [0, 1, 2],
    });
    expect((await resultOf(awaitChartsData, [2, WAIT_MS], throwing)).result).toEqual({
      notReady: [0, 1],
    });
    expect(
      (await resultOf(awaitChartsData, [1, WAIT_MS], chart(fixture, { withoutApi: true }))).result,
    ).toEqual({ notReady: [0] });
  });
});

describe('focusChart', () => {
  test('makes another chart the active one and reads which chart is active then', async () => {
    const { result, win } = await resultOf(focusChart, [1], chart(twoCharts));

    expect(result).toEqual({ wasActive: false, activeChartIndex: 1 });
    expect(calls(win, 'TradingViewApi.setActiveChart')).toEqual([[1]]);
  });

  test('leaves the active chart alone', async () => {
    const { result, win } = await resultOf(focusChart, [0], chart(twoCharts));

    expect(result).toEqual({ wasActive: true, activeChartIndex: 0 });
    expect(calls(win, 'TradingViewApi.setActiveChart')).toEqual([]);
  });

  test('answers the chart that is active when TradingView did not take the new one', async () => {
    const { result } = await resultOf(
      focusChart,
      [1],
      withApi((api) => {
        api.setActiveChart = () => undefined;
      }),
    );

    expect(result).toEqual({ wasActive: false, activeChartIndex: 0 });
  });

  test('an active chart that cannot be read is null', async () => {
    const { result, win } = await resultOf(
      focusChart,
      [1],
      withApi((api) => {
        api.activeChartIndex = failing('No active chart');
      }),
    );

    expect(result).toEqual({ wasActive: false, activeChartIndex: null });
    expect(calls(win, 'TradingViewApi.setActiveChart')).toEqual([[1]]);
  });

  test('a page without setActiveChart or activeChartIndex is CAPABILITY_UNAVAILABLE, before it acts', async () => {
    for (const member of ['setActiveChart', 'activeChartIndex']) {
      const { error, win } = await failureOfBoth(
        focusChart,
        [1],
        withApi((api) => {
          Reflect.deleteProperty(api, member);
        }),
      );

      expect(error.code, member).toBe('CAPABILITY_UNAVAILABLE');
      expect(calls(win, 'TradingViewApi.setActiveChart')).toEqual([]);
    }
  });
});

describe('readChartSymbols', () => {
  test('reads the symbol of each chart of the layout', async () => {
    expect((await resultOf(readChartSymbols, [], chart(twoCharts))).result).toEqual({
      symbols: ['NASDAQ:AAPL', 'NASDAQ:MSFT'],
    });
  });

  test('a chart it cannot read is null, and a layout it cannot count has none', async () => {
    expect(
      (
        await resultOf(
          readChartSymbols,
          [],
          chart({ ...fixture, layout: { ...fixture.layout, chartsCount: 2 } }),
        )
      ).result,
    ).toEqual({ symbols: ['NASDAQ:AAPL', null] });
    expect(
      (
        await resultOf(
          readChartSymbols,
          [],
          withApi((api) => {
            api.chartsCount = failing('No count');
          }),
        )
      ).result,
    ).toEqual({ symbols: [] });
    expect(
      (await resultOf(readChartSymbols, [], chart(fixture, { withoutApi: true }))).result,
    ).toEqual({ symbols: [] });
  });
});
