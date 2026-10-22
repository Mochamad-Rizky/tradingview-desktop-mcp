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
  awaitChartData,
  checkLayoutPermission,
  createLayoutViaApi,
  loadLayoutInPlace,
  readLayoutState,
  readSavedLayouts,
} from '../../../../src/tools/layout/page.js';
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

// The page functions of the layout tools, run the way the server runs them, as source text in a page
// through the real page bridge, and called directly on a second window built the same way, which is
// what the coverage of the module measures. The two answers must agree. Values are synthetic.

const fixture = loadTvFixture();
const roomy: TvStateFixture = {
  ...fixture,
  planLimits: { ...fixture.planLimits, CHART_STORAGE: 5 },
};
const WAIT_MS = 2000;
// For the calls that are meant to give up.
const SHORT_WAIT_MS = 60;
const NEW_NAME = 'Example Layout';
// What the app may reject with, and how the page functions say it: a message, a status (the Response
// the app throws for a refused request), both, or neither.
const REJECTIONS: [unknown, string][] = [
  ['Refused', 'Refused'],
  [{ status: 403 }, 'status 403'],
  [Object.assign(new Error('Server error'), { status: 500 }), 'Server error (status 500)'],
  [17, '17'],
];

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
    from: TvStateFixture = fixture,
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
  from: TvStateFixture = fixture,
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

async function libFailureOfBoth<A extends JsonValue[], R extends JsonValue | null>(
  fn: PageLibFunction<A, R>,
  args: A,
  make: Make,
): Promise<{ error: TvMcpError; win: object }> {
  const win = make();
  const error = await failureOf(bridgeTo(win).evaluateWithLib(fn, args));
  const other = make() as TvWindow;
  expect(await fn(other, createPageLib(other), ...args)).toEqual({
    __tvmcpError: error.toPayload(),
  });
  return { error, win };
}

const calls = (win: object, name: string) => inspectFakeWindow(win).callsTo(name);
const layoutsOf = (win: object) => inspectFakeWindow(win).state.layouts;
const signedOut = (win: FakeTvWindow): void => {
  inspectFakeWindow(win).state.pineEditor.signedIn = false;
};

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

// A fake chart whose export `name` is replaced by `value`.
const withExport = (name: string, value: unknown, from: TvStateFixture = roomy): Make =>
  changed((win) => {
    moduleWith(win, name)[name] = value;
  }, from);

describe('readLayoutState', () => {
  test('reads the layout on the chart, whether an account is signed in and whether the layout has unsaved changes', async () => {
    expect((await resultOf(readLayoutState, [], chart())).result).toEqual({
      signedIn: true,
      id: 'FIXTURE1',
      name: 'Fixture Layout',
      unsaved: false,
    });
    expect(
      (
        await resultOf(
          readLayoutState,
          [],
          changed((win) => {
            layoutsOf(win).unsaved = true;
            signedOut(win);
          }),
        )
      ).result,
    ).toEqual({ signedIn: false, id: 'FIXTURE1', name: 'Fixture Layout', unsaved: true });
  });

  test('a layout that was never saved has a null id and name, and so has one whose id or name is no text', async () => {
    const never = changed((win) => {
      layoutsOf(win).current = { id: null, uid: null, name: null };
    });
    const odd = withApi((api) => {
      Object.assign(api, { layoutId: () => '', layoutName: () => 42 });
    });
    const throwing = withApi((api) => {
      Object.assign(api, {
        layoutId: () => {
          throw new Error('Not ready');
        },
      });
      Reflect.deleteProperty(api, 'layoutName');
    });

    for (const make of [never, odd, throwing]) {
      expect((await resultOf(readLayoutState, [], make)).result).toMatchObject({
        id: null,
        name: null,
      });
    }
  });

  test('unsaved is null when TradingView does not tell', async () => {
    const answers: unknown[] = [
      () => {
        throw new Error('Not ready');
      },
      () => null,
      () => ({}),
      () => ({ value: () => 'yes' }),
      () => ({
        value: () => {
          throw new Error('Not ready');
        },
      }),
    ];
    for (const answer of answers) {
      const make = withApi((api) => {
        Object.assign(api, { hasChartChanges: answer });
      });

      expect((await resultOf(readLayoutState, [], make)).result.unsaved).toBeNull();
    }
    const without = withApi((api) => {
      Reflect.deleteProperty(api, 'hasChartChanges');
    });
    expect((await resultOf(readLayoutState, [], without)).result.unsaved).toBeNull();
  });

  test('a page without the layout API is CAPABILITY_UNAVAILABLE', async () => {
    const withoutLayoutId = withApi((api) => {
      Reflect.deleteProperty(api, 'layoutId');
    });

    for (const make of [chart(fixture, { withoutApi: true }), withoutLayoutId]) {
      const { error } = await failureOfBoth(readLayoutState, [], make);

      expect(error.toPayload()).toMatchObject({
        code: 'CAPABILITY_UNAVAILABLE',
        hint: expect.stringContaining('app_health') as string,
      });
    }
  });
});

describe('readSavedLayouts', () => {
  test('lists the saved layouts as the layouts menu does, in the order of TradingView', async () => {
    const { result, win } = await resultOf(readSavedLayouts, [WAIT_MS], chart());

    expect(result).toEqual({
      layouts: [
        { url: 'FIXTURE1', name: 'Fixture Layout', modified: 1767225600, overLimit: false },
        { url: 'FIXTURE2', name: 'Second Layout', modified: 1767312000, overLimit: false },
        { url: 'FIXTURE3', name: 'Locked Layout', modified: 1764547200, overLimit: true },
      ],
    });
    expect(calls(win, 'TradingViewApi.getSavedCharts')).toEqual([[]]);
  });

  test('reads what it can of an odd record', async () => {
    const make = withApi((api) => {
      api.getSavedCharts = () =>
        Promise.resolve([
          null,
          'FIXTURE1',
          { url: '', name: 7, modified_iso: 'yesterday', over_limit: 'yes' },
          { url: 'FIXTURE2', name: 'Second Layout', modified_iso: Number.NaN, over_limit: true },
          {
            get url(): string {
              throw new Error('Unreadable');
            },
          },
        ] as unknown as Record<string, unknown>[]);
    });

    expect((await resultOf(readSavedLayouts, [WAIT_MS], make)).result).toEqual({
      layouts: [
        { url: null, name: null, modified: null, overLimit: false },
        { url: null, name: null, modified: null, overLimit: false },
        { url: null, name: null, modified: null, overLimit: false },
        { url: 'FIXTURE2', name: 'Second Layout', modified: null, overLimit: true },
        { url: null, name: null, modified: null, overLimit: false },
      ],
    });
  });

  test.each(REJECTIONS)(
    'says why the list failed when TradingView rejects with %o',
    async (thrown, reason) => {
      const make = withApi((api) => {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        api.getSavedCharts = () => Promise.reject(thrown);
      });

      expect((await failureOfBoth(readSavedLayouts, [WAIT_MS], make)).error.message).toBe(
        `TradingView could not list the saved layouts: ${reason}`,
      );
    },
  );

  test('a list TradingView cannot give is NOT_AVAILABLE, and one that does not come in time TIMEOUT', async () => {
    const failing = changed((win) => {
      layoutsOf(win).errors.getSavedCharts = { status: 500, code: null, message: 'Not OK' };
    });
    const throwing = withApi((api) => {
      api.getSavedCharts = () => {
        throw new Error('Broken');
      };
    });
    const odd = withApi((api) => {
      api.getSavedCharts = () => Promise.resolve({} as unknown as Record<string, unknown>[]);
    });
    const hanging = withApi((api) => {
      api.getSavedCharts = () => new Promise(() => undefined);
    });

    expect((await failureOfBoth(readSavedLayouts, [WAIT_MS], failing)).error.toPayload()).toEqual({
      code: 'NOT_AVAILABLE',
      message: 'TradingView could not list the saved layouts: Not OK',
      hint: expect.stringContaining('app_health') as string,
    });
    expect((await failureOfBoth(readSavedLayouts, [WAIT_MS], throwing)).error.message).toBe(
      'TradingView could not list the saved layouts: Broken',
    );
    expect((await failureOfBoth(readSavedLayouts, [WAIT_MS], odd)).error.toPayload()).toMatchObject(
      { code: 'NOT_AVAILABLE', message: 'TradingView answered no list of saved layouts' },
    );
    expect(
      (await failureOfBoth(readSavedLayouts, [SHORT_WAIT_MS], hanging)).error.toPayload(),
    ).toMatchObject({ code: 'TIMEOUT', details: { waitMs: SHORT_WAIT_MS } });
  });

  test('signed out it sends nothing and is AUTH_REQUIRED, and without the API CAPABILITY_UNAVAILABLE', async () => {
    const { error, win } = await failureOfBoth(readSavedLayouts, [WAIT_MS], changed(signedOut));
    const withoutList = withApi((api) => {
      Reflect.deleteProperty(api, 'getSavedCharts');
    });

    expect(error.code).toBe('AUTH_REQUIRED');
    expect(calls(win, 'TradingViewApi.getSavedCharts')).toEqual([]);
    for (const make of [chart(fixture, { withoutApi: true }), withoutList]) {
      expect((await failureOfBoth(readSavedLayouts, [WAIT_MS], make)).error.code).toBe(
        'CAPABILITY_UNAVAILABLE',
      );
    }
  });
});

describe('loadLayoutInPlace', () => {
  test('loads the layout in place, with confirm discarding unsaved changes without a dialog, and says when it has loaded', async () => {
    const make = changed((win) => {
      layoutsOf(win).unsaved = true;
    });

    const { result, win } = await resultOf(loadLayoutInPlace, ['FIXTURE2', WAIT_MS, true], make);

    expect(result).toEqual({ ended: 'loaded', reason: null });
    expect(calls(win, 'TradingViewApi.loadLayoutFromServerByLayoutId')).toEqual([
      ['FIXTURE2', false, true],
    ]);
    expect(layoutsOf(win).current.uid).toBe('FIXTURE2');
    expect(calls(win, 'dialog.unsavedChanges')).toEqual([]);
    // Without unsaved changes it needs no confirm.
    expect(
      (await resultOf(loadLayoutInPlace, ['FIXTURE2', WAIT_MS, false], chart())).result,
    ).toEqual({ ended: 'loaded', reason: null });
  });

  test('looks at the unsaved changes again right before it loads, and refuses CONFIRMATION_REQUIRED without confirm', async () => {
    const unsaved = changed((win) => {
      layoutsOf(win).unsaved = true;
    });
    const unreadable = withApi((api) => {
      api.hasChartChanges = () => {
        throw new Error('Not ready');
      };
    });
    const without = withApi((api) => {
      Reflect.deleteProperty(api, 'hasChartChanges');
    });

    for (const [make, unsavedChanges] of [
      [unsaved, true],
      [unreadable, null],
      [without, null],
    ] as const) {
      const { error, win } = await failureOfBoth(
        loadLayoutInPlace,
        ['FIXTURE2', WAIT_MS, false],
        make,
      );

      expect(error.toPayload()).toEqual({
        code: 'CONFIRMATION_REQUIRED',
        message: expect.stringMatching(
          /unsaved changes, which loading the layout would discard$/,
        ) as string,
        hint: expect.stringContaining('confirm: true') as string,
        details: { unsavedChanges },
      });
      expect(calls(win, 'TradingViewApi.loadLayoutFromServerByLayoutId')).toEqual([]);
      expect(layoutsOf(win).current.uid).toBe('FIXTURE1');
    }
    // With confirm, changes TradingView does not tell about are discarded too.
    expect(
      (await resultOf(loadLayoutInPlace, ['FIXTURE2', WAIT_MS, true], unreadable)).result,
    ).toEqual({ ended: 'loaded', reason: null });
  });

  test('says why a load failed', async () => {
    const failing = changed((win) => {
      layoutsOf(win).errors.loadLayout = { status: 500, code: null, message: 'Server error' };
    });
    // The app rejects with what it was answered, which need not be an Error.
    const rejecting = (reason: unknown): Make =>
      withApi((api) => {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        api.loadLayoutFromServerByLayoutId = () => Promise.reject(reason);
      });
    const throwing = withApi((api) => {
      api.loadLayoutFromServerByLayoutId = () => {
        throw new Error('Broken');
      };
    });

    expect(
      (await resultOf(loadLayoutInPlace, ['FIXTURE2', WAIT_MS, false], failing)).result,
    ).toEqual({
      ended: 'failed',
      reason: 'Server error (status 500)',
    });
    for (const [make, reason] of [
      [rejecting('Refused'), 'Refused'],
      [rejecting({ status: 403 }), 'status 403'],
      [rejecting(17), '17'],
      [throwing, 'Broken'],
    ] as const) {
      expect(
        (await resultOf(loadLayoutInPlace, ['FIXTURE2', WAIT_MS, false], make)).result,
      ).toEqual({
        ended: 'failed',
        reason,
      });
    }
  });

  test('says when a load did not end in time', async () => {
    const hanging = changed((win) => {
      layoutsOf(win).loadHangs = true;
    });

    expect(
      (await resultOf(loadLayoutInPlace, ['FIXTURE2', SHORT_WAIT_MS, false], hanging)).result,
    ).toEqual({ ended: 'late', reason: null });
  });

  test('loads nothing signed out, for an id that is no text, or without the loader', async () => {
    const withoutLoader = withApi((api) => {
      Reflect.deleteProperty(api, 'loadLayoutFromServerByLayoutId');
    });

    const { error, win } = await failureOfBoth(
      loadLayoutInPlace,
      ['FIXTURE2', WAIT_MS, true],
      changed(signedOut),
    );
    expect(error.code).toBe('AUTH_REQUIRED');
    expect(calls(win, 'TradingViewApi.loadLayoutFromServerByLayoutId')).toEqual([]);
    const blank = await failureOfBoth(loadLayoutInPlace, ['', WAIT_MS, true], chart());
    expect(blank.error.code).toBe('INVALID_INPUT');
    expect(calls(blank.win, 'TradingViewApi.loadLayoutFromServerByLayoutId')).toEqual([]);
    for (const make of [chart(fixture, { withoutApi: true }), withoutLoader]) {
      expect(
        (await failureOfBoth(loadLayoutInPlace, ['FIXTURE2', WAIT_MS, true], make)).error.code,
      ).toBe('CAPABILITY_UNAVAILABLE');
    }
  });
});

describe('awaitChartData', () => {
  test('answers ready once the chart has its data', async () => {
    expect((await resultOf(awaitChartData, [WAIT_MS], chart())).result).toEqual({ ready: true });
  });

  test('answers not ready when the data does not come in time or the chart cannot tell', async () => {
    const unknownSymbol = changed((win) => {
      void win.TradingViewApi?.activeChart().setSymbol('NOPE:NOTHING');
    });
    const chartWith = (dataReady: unknown): Make =>
      withApi((api) => {
        const active = api.activeChart();
        api.activeChart = () =>
          Object.assign(Object.create(active) as object, { dataReady }) as never;
      });
    const noChart = withApi((api) => {
      api.activeChart = () => {
        throw new Error('No chart');
      };
    });

    for (const make of [
      unknownSymbol,
      chartWith(undefined),
      chartWith(() => {
        throw new Error('Broken');
      }),
      chartWith(() => Promise.reject(new Error('Broken'))),
      chartWith(() => Promise.resolve(false)),
      noChart,
      chart(fixture, { withoutApi: true }),
    ]) {
      expect((await resultOf(awaitChartData, [SHORT_WAIT_MS], make)).result).toEqual({
        ready: false,
      });
    }
  });
});

describe('checkLayoutPermission', () => {
  test('answers what the permission check of TradingView answers', async () => {
    const full = { ...fixture, planLimits: { ...fixture.planLimits, CHART_STORAGE: 3 } };

    const { result, win } = await libResultOf(checkLayoutPermission, [WAIT_MS], chart(roomy));
    expect(result).toEqual({ allowed: true });
    expect(calls(win, 'hasPermissionsToCreateNewChart')).toEqual([[]]);
    expect((await libResultOf(checkLayoutPermission, [WAIT_MS], chart(full))).result).toEqual({
      allowed: false,
    });
  });

  test('answers null on a build without it', async () => {
    const make = chart(roomy, { layouts: { withoutPermissionCheck: true } });

    expect((await libResultOf(checkLayoutPermission, [WAIT_MS], make)).result).toEqual({
      allowed: null,
    });
  });

  test('says why the check failed, and refuses an answer that is no yes or no', async () => {
    const failing = changed((win) => {
      layoutsOf(win).errors.getChartsCount = { status: 500, code: null, message: 'Server error' };
    }, roomy);
    const throwing = withExport('hasPermissionsToCreateNewChart', () => {
      throw new Error('Broken');
    });
    const vague = withExport('hasPermissionsToCreateNewChart', () => Promise.resolve('maybe'));

    expect((await libResultOf(checkLayoutPermission, [WAIT_MS], failing)).result).toEqual({
      failed: 'Server error (status 500)',
    });
    expect((await libResultOf(checkLayoutPermission, [WAIT_MS], throwing)).result).toEqual({
      failed: 'Broken',
    });
    expect((await libResultOf(checkLayoutPermission, [WAIT_MS], vague)).result).toEqual({
      failed: 'TradingView answered neither yes nor no',
    });
  });

  test.each(REJECTIONS)(
    'says why the check failed when it rejects with %o',
    async (thrown, reason) => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      const make = withExport('hasPermissionsToCreateNewChart', () => Promise.reject(thrown));

      expect((await libResultOf(checkLayoutPermission, [WAIT_MS], make)).result).toEqual({
        failed: reason,
      });
    },
  );

  test('a check that does not answer in time is TIMEOUT', async () => {
    const hanging = withExport(
      'hasPermissionsToCreateNewChart',
      () => new Promise(() => undefined),
    );

    const { error } = await libFailureOfBoth(checkLayoutPermission, [SHORT_WAIT_MS], hanging);

    expect(error.toPayload()).toMatchObject({
      code: 'TIMEOUT',
      hint: expect.stringContaining('Nothing was created') as string,
      details: { waitMs: SHORT_WAIT_MS },
    });
  });
});

describe('createLayoutViaApi', () => {
  test('creates the layout with the options of the Create new layout dialog and answers its URL', async () => {
    const { result, win } = await libResultOf(
      createLayoutViaApi,
      [NEW_NAME, WAIT_MS],
      chart(roomy),
    );

    expect(result).toEqual({ url: 'https://www.tradingview.com/chart/NEW00001/' });
    expect(calls(win, 'createNewChart')).toEqual([
      [
        {
          name: NEW_NAME,
          symbol: 'NASDAQ:AAPL',
          short_name: 'AAPL',
          symbol_type: 'stock',
          exchange: 'NASDAQ',
          interval: '1D',
        },
      ],
    ]);
    // It created the layout and left the chart alone.
    expect(layoutsOf(win).current.uid).toBe('FIXTURE1');
  });

  test('leaves out the options it cannot read from the chart', async () => {
    const unknownSymbol = changed((win) => {
      void win.TradingViewApi?.activeChart().setSymbol('NOPE:NOTHING');
    }, roomy);
    const noInterval = changed((win) => {
      const series = win.TradingViewApi?.activeChart()._chartWidget.model().mainSeries();
      if (series !== undefined) {
        Reflect.deleteProperty(series, 'interval');
        Object.assign(series, {
          symbolInfo: () => ({ pro_name: 'NYSE:IBM', name: 3, type: null }),
        });
      }
    }, roomy);
    const noChart = withApi((api) => {
      api.activeChart = () => {
        throw new Error('No chart');
      };
    }, roomy);

    for (const [make, options] of [
      [unknownSymbol, { name: NEW_NAME, interval: '1D' }],
      [noInterval, { name: NEW_NAME, symbol: 'NYSE:IBM' }],
      [noChart, { name: NEW_NAME }],
    ] as const) {
      const { win } = await libResultOf(createLayoutViaApi, [NEW_NAME, WAIT_MS], make);

      expect(calls(win, 'createNewChart')).toEqual([[options]]);
    }
  });

  test('answers null when TradingView does not create the layout', async () => {
    const failing = changed((win) => {
      layoutsOf(win).errors.createNewChart = { status: 500, code: null, message: 'Server error' };
    }, roomy);
    const odd = withExport('createNewChart', () => Promise.resolve(42));

    expect((await libResultOf(createLayoutViaApi, [NEW_NAME, WAIT_MS], failing)).result).toEqual({
      url: null,
    });
    expect((await libResultOf(createLayoutViaApi, [NEW_NAME, WAIT_MS], odd)).result).toEqual({
      url: null,
    });
  });

  test('a creation that fails or does not answer in time says the layout may exist all the same', async () => {
    const rejecting = withExport('createNewChart', () => Promise.reject(new Error('Broken')));
    const throwing = withExport('createNewChart', () => {
      throw new Error('Broken');
    });
    const hanging = withExport('createNewChart', () => new Promise(() => undefined));

    for (const make of [rejecting, throwing]) {
      const { error } = await libFailureOfBoth(createLayoutViaApi, [NEW_NAME, WAIT_MS], make);

      expect(error.toPayload()).toEqual({
        code: 'NOT_AVAILABLE',
        message: 'TradingView failed while it created the layout: Broken',
        hint: expect.stringContaining('layout_list') as string,
      });
    }
    const { error } = await libFailureOfBoth(
      createLayoutViaApi,
      [NEW_NAME, SHORT_WAIT_MS],
      hanging,
    );
    expect(error.toPayload()).toMatchObject({
      code: 'TIMEOUT',
      hint: expect.stringContaining('layout_list') as string,
      details: { waitMs: SHORT_WAIT_MS },
    });
  });

  test.each(REJECTIONS)(
    'says why the creation failed when it rejects with %o',
    async (thrown, reason) => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      const make = withExport('createNewChart', () => Promise.reject(thrown));

      const { error } = await libFailureOfBoth(createLayoutViaApi, [NEW_NAME, WAIT_MS], make);

      expect(error.message).toBe(`TradingView failed while it created the layout: ${reason}`);
    },
  );

  test('creates nothing signed out, for a blank name, or without createNewChart', async () => {
    const out = await libFailureOfBoth(
      createLayoutViaApi,
      [NEW_NAME, WAIT_MS],
      changed(signedOut, roomy),
    );
    const blank = await libFailureOfBoth(createLayoutViaApi, ['  ', WAIT_MS], chart(roomy));
    const without = await libFailureOfBoth(
      createLayoutViaApi,
      [NEW_NAME, WAIT_MS],
      chart(roomy, { layouts: { withoutCreateNewChart: true } }),
    );

    expect(out.error.code).toBe('AUTH_REQUIRED');
    expect(blank.error.code).toBe('INVALID_INPUT');
    expect(without.error.toPayload()).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: expect.stringContaining('createNewChart') as string,
      hint: expect.stringContaining('TradingView itself') as string,
    });
    for (const { win } of [out, blank, without]) {
      expect(calls(win, 'createNewChart')).toEqual([]);
      expect(layoutsOf(win).saved).toHaveLength(3);
    }
  });
});
