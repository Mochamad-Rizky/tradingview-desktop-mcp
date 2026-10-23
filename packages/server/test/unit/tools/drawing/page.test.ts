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
  createDrawing,
  readDrawing,
  readDrawingIds,
  readDrawings,
  removeDrawing,
  removeDrawings,
  type DrawingRequest,
} from '../../../../src/tools/drawing/page.js';
import type { JsonValue } from '../../../../src/utils/json.js';
import { failureOf } from '../../../helpers/failure-of.js';
import { createPageRuntime } from '../../../helpers/fake-cdp/runtime.js';
import { loadTvFixture, type TvStateFixture } from '../../../helpers/fake-tv/fixture.js';
import { syntheticBars } from '../../../helpers/fake-tv/synthetic-bars.js';
import { createFakeWebpack } from '../../../helpers/fake-tv/webpack.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTvOverrides,
  type FakeTvWindow,
} from '../../../helpers/fake-tv/window.js';

// The page functions of the drawing tools, run the way the server runs them, as source text in a
// page through the real page bridge, and called directly on a second window built the same way,
// which is what the coverage of the module measures. The two answers must agree. Values are
// synthetic.

const fixture = loadTvFixture();
const bars = syntheticBars(fixture.bars);
const timeOf = (index: number): number => bars[index]?.[0] ?? Number.NaN;
const WAIT_MS = 2000;

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

const plain =
  (win: object): Make =>
  () =>
    win;

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

// A page whose active chart is made of `members`, signed in, with the webpack cache `modules`.
function withChart(
  members: object,
  modules: Record<string, Record<string, unknown>> = {},
  page: Record<string, unknown> = { is_authenticated: true },
): Make {
  return () => ({
    TradingViewApi: { activeChart: () => members },
    webpackChunktradingview: createFakeWebpack(modules),
    ...page,
  });
}

// A fake chart whose chart API is changed by `change` after the window is built.
function changed(
  change: (api: NonNullable<FakeTvWindow['TradingViewApi']>) => void,
  from: TvStateFixture = fixture,
  overrides: FakeTvOverrides = {},
): Make {
  return () => {
    const win = createFakeTvWindow(from, overrides);
    const api = win.TradingViewApi;
    if (api === undefined) {
      throw new Error('The fake window has no TradingViewApi');
    }
    change(api);
    return win;
  };
}

// A fake chart whose getAllShapes answers as the app does the first time, and with `listing` every
// time after: a list that can no longer be read once a removal has gone out.
function listsAfterRemovalWith(listing: () => unknown): Make {
  return changed((api) => {
    const chartApi = api.activeChart();
    const list = chartApi.getAllShapes.bind(chartApi);
    let looks = 0;
    chartApi.getAllShapes = () => {
      looks += 1;
      return (looks === 1 ? list() : listing()) as ReturnType<typeof list>;
    };
  });
}

function request(change: Partial<DrawingRequest> = {}): DrawingRequest {
  return {
    shape: 'horizontal_line',
    className: 'LineToolHorzLine',
    points: [{ time: timeOf(10), price: 101 }],
    text: null,
    overrides: {},
    verifyCount: null,
    readKeys: [],
    ...change,
  };
}

const TREND_LINE = {
  shape: 'trend_line',
  className: 'LineToolTrendLine',
  points: [
    { time: timeOf(10), price: 100 },
    { time: timeOf(20), price: 104 },
  ],
} as const;

const calls = (win: object, name: string) => inspectFakeWindow(win).callsTo(name);

describe('createDrawing', () => {
  test('draws a shape of one point with createShape, and of more points with createMultipointShape', async () => {
    const one = await libResultOf(createDrawing, [null, request(), WAIT_MS], chart());
    const two = await libResultOf(
      createDrawing,
      [null, request({ ...TREND_LINE, points: [...TREND_LINE.points] }), WAIT_MS],
      chart(),
    );

    expect(one.result).toEqual({ id: 'DRW001', properties: {} });
    expect(calls(one.win, 'chart.createShape')).toEqual([
      [{ time: timeOf(10), price: 101 }, { shape: 'horizontal_line' }],
    ]);
    expect(calls(one.win, 'chart.createMultipointShape')).toEqual([]);
    expect(two.result).toEqual({ id: 'DRW001', properties: {} });
    expect(calls(two.win, 'chart.createMultipointShape')).toEqual([
      [[...TREND_LINE.points], { shape: 'trend_line' }],
    ]);
    expect(calls(two.win, 'chart.createShape')).toEqual([]);
  });

  test('passes the text and the overrides in the creation options, never disableUndo, and reads the asked keys back', async () => {
    const { result, win } = await libResultOf(
      createDrawing,
      [
        null,
        request({
          text: 'Resistance',
          overrides: { linecolor: '#FF5500', linewidth: 3, nonsense: 1 },
          readKeys: ['linecolor', 'linewidth', 'nonsense', 'text'],
        }),
        WAIT_MS,
      ],
      chart(),
    );

    expect(result).toEqual({
      id: 'DRW001',
      properties: { linecolor: '#FF5500', linewidth: 3, text: 'Resistance' },
    });
    expect(calls(win, 'chart.createShape')).toEqual([
      [
        { time: timeOf(10), price: 101 },
        {
          shape: 'horizontal_line',
          text: 'Resistance',
          overrides: { linecolor: '#FF5500', linewidth: 3, nonsense: 1 },
        },
      ],
    ]);
    expect(calls(win, 'shape.setProperties')).toEqual([]);
    expect(calls(win, 'shape.setPoints')).toEqual([]);
  });

  test('draws on the chart of the index it is given', async () => {
    const { result, win } = await libResultOf(createDrawing, [0, request(), WAIT_MS], chart());

    expect(result).toMatchObject({ id: 'DRW001' });
    expect(calls(win, 'chart.createShape')).toHaveLength(1);
  });

  test('refuses a signed-out account with AUTH_REQUIRED before TradingView is asked, so no sign-in wall opens', async () => {
    const make = () => {
      const win = createFakeTvWindow(fixture);
      inspectFakeWindow(win).state.pineEditor.signedIn = false;
      return win;
    };

    const { error, win } = await libFailureOfBoth(createDrawing, [null, request(), WAIT_MS], make);

    expect(error.code).toBe('AUTH_REQUIRED');
    expect(error.hint).toMatch(/sign in/i);
    expect(calls(win, 'chart.createShape')).toEqual([]);
    expect(calls(win, 'dialog.signIn')).toEqual([]);
  });

  test('refuses when the page does not say whether an account is signed in', async () => {
    const { error } = await libFailureOfBoth(
      createDrawing,
      [null, request(), WAIT_MS],
      withChart({ createShape: () => Promise.resolve('AbC123') }, {}, {}),
    );

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(error.message).toMatch(/signed in/);
  });

  test('refuses in the treatment of the drawings experiment before TradingView is asked, so no paywall opens', async () => {
    const { error, win } = await libFailureOfBoth(
      createDrawing,
      [null, request(), WAIT_MS],
      chart(fixture, { drawings: { experiment: 'treatment' } }),
    );

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(error.hint).toMatch(/gated on this account/);
    expect(calls(win, 'chart.createShape')).toEqual([]);
    expect(calls(win, 'dialog.paywall')).toEqual([]);
  });

  test('refuses when the variation of the drawings experiment cannot be read', async () => {
    const missing = await libFailureOfBoth(
      createDrawing,
      [null, request(), WAIT_MS],
      chart(fixture, { drawings: { withoutExperiment: true } }),
    );
    const throwing = await libFailureOfBoth(
      createDrawing,
      [null, request(), WAIT_MS],
      withChart(
        { createShape: () => Promise.resolve('AbC123') },
        {
          1: {
            getDrawingsExperimentVariation: () => {
              throw new Error('not ready');
            },
          },
        },
      ),
    );

    for (const { error } of [missing, throwing]) {
      expect(error.code).toBe('NOT_AVAILABLE');
      expect(error.message).toMatch(/whether drawings are gated/);
    }
    expect(calls(missing.win, 'chart.createShape')).toEqual([]);
  });

  test('a variation other than the treatment lets the drawing through', async () => {
    const { result } = await libResultOf(
      createDrawing,
      [null, request(), WAIT_MS],
      chart(fixture, { drawings: { experiment: 'control' } }),
    );

    expect(result).toMatchObject({ id: 'DRW001' });
  });

  test('refuses a shape this build of TradingView does not list, which it would draw as a flag', async () => {
    const { error, win } = await libFailureOfBoth(
      createDrawing,
      [null, request(), WAIT_MS],
      chart(fixture, {
        webpackModules: {
          1: { getDrawingsExperimentVariation: () => null },
          2: { supportedLineTools: { flag: { name: 'LineToolFlagMark' } } },
        },
      }),
    );

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(error.message).toBe(
      'This TradingView build has no horizontal_line drawing tool, so it would draw a flag instead',
    );
    expect(calls(win, 'chart.createShape')).toEqual([]);
  });

  test('skips the line-tool registry for a point count that was seen on the app', async () => {
    const { win } = await libResultOf(createDrawing, [null, request(), WAIT_MS], chart());

    expect(calls(win, 'lineTools.ensureLineToolLoaded')).toEqual([]);
  });

  test('confirms an unverified point count with the line-tool registry before drawing', async () => {
    const { result, win } = await libResultOf(
      createDrawing,
      [null, request({ ...TREND_LINE, points: [...TREND_LINE.points], verifyCount: 2 }), WAIT_MS],
      chart(),
    );

    expect(result).toMatchObject({ id: 'DRW001' });
    expect(calls(win, 'lineTools.ensureLineToolLoaded')).toEqual([['LineToolTrendLine']]);
  });

  test('refuses a point count the registry does not confirm, naming both, and draws nothing', async () => {
    const { error, win } = await libFailureOfBoth(
      createDrawing,
      [
        null,
        request({
          shape: 'circle',
          className: 'LineToolCircle',
          points: [...TREND_LINE.points],
          verifyCount: 2,
        }),
        WAIT_MS,
      ],
      chart(fixture, { drawings: { classes: { LineToolCircle: { pointsCount: 3 } } } }),
    );

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(error.message).toBe(
      'TradingView takes 3 points for a circle drawing, where this server expects 2',
    );
    expect(error.details).toEqual({ shape: 'circle', expected: 2, reported: 3 });
    expect(calls(win, 'chart.createMultipointShape')).toEqual([]);
  });

  test('a registry count of -1 takes any number of points', async () => {
    const { result } = await libResultOf(
      createDrawing,
      [null, request({ ...TREND_LINE, points: [...TREND_LINE.points], verifyCount: 2 }), WAIT_MS],
      chart(fixture, { drawings: { classes: { LineToolTrendLine: { pointsCount: -1 } } } }),
    );

    expect(result).toMatchObject({ id: 'DRW001' });
  });

  test('takes the class of the tool from supportedLineTools', async () => {
    const loaded: unknown[] = [];
    const { result } = await libResultOf(
      createDrawing,
      [null, request({ ...TREND_LINE, points: [...TREND_LINE.points], verifyCount: 2 }), WAIT_MS],
      withChart(
        { createMultipointShape: () => Promise.resolve('AbC123') },
        {
          1: { getDrawingsExperimentVariation: () => null },
          2: { supportedLineTools: { trend_line: { name: 'LineToolTrendLineV2' } } },
          3: {
            ensureLineToolLoaded: (className: unknown) => {
              loaded.push(className);
              return Promise.resolve();
            },
            getLoadedLineTool: () => ({ prototype: { pointsCount: () => 2 } }),
          },
        },
      ),
    );

    expect(result).toEqual({ id: 'AbC123', properties: null });
    expect(loaded).toEqual(['LineToolTrendLineV2', 'LineToolTrendLineV2']);
  });

  test.each([
    ['without the registry', {}],
    [
      'when the tool cannot be loaded',
      {
        3: {
          ensureLineToolLoaded: () => Promise.reject(new Error('chunk failed')),
          getLoadedLineTool: () => ({ prototype: { pointsCount: () => 2 } }),
        },
      },
    ],
    [
      'when the class cannot be had',
      {
        3: {
          ensureLineToolLoaded: () => Promise.resolve(),
          getLoadedLineTool: () => {
            throw new Error('Line tool LineToolTrendLine is undefined');
          },
        },
      },
    ],
    [
      'when the count is no number',
      {
        3: {
          ensureLineToolLoaded: () => Promise.resolve(),
          getLoadedLineTool: () => ({ prototype: { pointsCount: () => '2' } }),
        },
      },
    ],
  ])('refuses an unverified point count %s', async (_label, registry) => {
    let drawn = 0;
    const { error } = await libFailureOfBoth(
      createDrawing,
      [null, request({ ...TREND_LINE, points: [...TREND_LINE.points], verifyCount: 2 }), WAIT_MS],
      withChart(
        {
          createMultipointShape: () => {
            drawn += 1;
            return Promise.resolve('AbC123');
          },
        },
        { 1: { getDrawingsExperimentVariation: () => null }, ...registry },
      ),
    );

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(error.message).toBe(
      'How many points TradingView takes for a trend_line drawing cannot be confirmed on this build',
    );
    expect(drawn).toBe(0);
  });

  test('a registry that does not answer in time is TIMEOUT, and nothing is drawn', async () => {
    let drawn = 0;
    const { error } = await libFailureOfBoth(
      createDrawing,
      [null, request({ ...TREND_LINE, points: [...TREND_LINE.points], verifyCount: 2 }), 50],
      withChart(
        {
          createMultipointShape: () => {
            drawn += 1;
            return Promise.resolve('AbC123');
          },
        },
        {
          1: { getDrawingsExperimentVariation: () => null },
          3: {
            ensureLineToolLoaded: () => new Promise(() => undefined),
            getLoadedLineTool: () => ({ prototype: { pointsCount: () => 2 } }),
          },
        },
      ),
    );

    expect(error.code).toBe('TIMEOUT');
    expect(error.message).toBe('TradingView did not load the trend_line drawing tool within 50 ms');
    expect(error.hint).toMatch(/nothing was drawn/i);
    expect(drawn).toBe(0);
  });

  test('a wrong point count TradingView reports is INVALID_INPUT', async () => {
    const { error } = await libFailureOfBoth(
      createDrawing,
      [null, request(), WAIT_MS],
      withChart(
        { createShape: () => Promise.reject(new Error('Wrong points count for x. Required 2')) },
        { 1: { getDrawingsExperimentVariation: () => null } },
      ),
    );

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe(
      'TradingView refused the points: Wrong points count for x. Required 2',
    );
  });

  test('a text TradingView refuses for its tool is INVALID_INPUT, and nothing is drawn', async () => {
    const { error, win } = await libFailureOfBoth(
      createDrawing,
      [null, request({ shape: 'flag', className: 'LineToolFlagMark', text: 'x' }), WAIT_MS],
      chart(),
    );

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe('TradingView takes no text for a flag drawing');
    expect(inspectFakeWindow(win).state.drawings.list).toHaveLength(3);
  });

  test('any other refusal of TradingView is PAGE_EVALUATION_FAILED with its message', async () => {
    const { error } = await libFailureOfBoth(
      createDrawing,
      [null, request(), WAIT_MS],
      withChart(
        { createShape: () => Promise.reject(new Error('Cannot create "horizontal_line" shape')) },
        { 1: { getDrawingsExperimentVariation: () => null } },
      ),
    );
    const thrown = await libFailureOfBoth(
      createDrawing,
      [null, request(), WAIT_MS],
      withChart(
        {
          createShape: () => {
            // eslint-disable-next-line @typescript-eslint/only-throw-error
            throw 'no pane';
          },
        },
        { 1: { getDrawingsExperimentVariation: () => null } },
      ),
    );

    expect(error.code).toBe('PAGE_EVALUATION_FAILED');
    expect(error.message).toBe(
      'TradingView did not create the drawing: Cannot create "horizontal_line" shape',
    );
    expect(thrown.error.code).toBe('PAGE_EVALUATION_FAILED');
    expect(thrown.error.message).toBe('TradingView did not create the drawing: no pane');
  });

  test('a creation that does not settle in time is TIMEOUT, with a hint to look for the drawing', async () => {
    const { error } = await libFailureOfBoth(
      createDrawing,
      [null, request(), 50],
      withChart(
        { createShape: () => new Promise(() => undefined) },
        { 1: { getDrawingsExperimentVariation: () => null } },
      ),
    );

    expect(error.code).toBe('TIMEOUT');
    expect(error.message).toBe('TradingView did not create the drawing within 50 ms');
    expect(error.hint).toMatch(/drawing_list/);
  });

  test('an answer that is not an id is PAGE_EVALUATION_FAILED', async () => {
    const { error } = await libFailureOfBoth(
      createDrawing,
      [null, request(), WAIT_MS],
      withChart(
        { createShape: () => Promise.resolve(null) },
        { 1: { getDrawingsExperimentVariation: () => null } },
      ),
    );

    expect(error.code).toBe('PAGE_EVALUATION_FAILED');
    expect(error.message).toBe(
      'TradingView answered createShape with something that is no drawing id',
    );
  });

  test('properties that cannot be read back come back as null', async () => {
    const { result } = await libResultOf(
      createDrawing,
      [null, request({ readKeys: ['linecolor'] }), WAIT_MS],
      changed((api) => {
        api.activeChart().getShapeById = () => {
          throw new Error('There is no such shape');
        };
      }),
    );

    expect(result).toEqual({ id: 'DRW001', properties: null });
  });

  test('keeps the class of the server for an entry of supportedLineTools without a name', async () => {
    const { result } = await libResultOf(
      createDrawing,
      [null, request(), WAIT_MS],
      chart(fixture, {
        webpackModules: {
          1: { getDrawingsExperimentVariation: () => null },
          2: { supportedLineTools: { horizontal_line: {} } },
        },
      }),
    );

    expect(result).toMatchObject({ id: 'DRW001' });
  });

  test('names a registry count of one point in the singular', async () => {
    const { error } = await libFailureOfBoth(
      createDrawing,
      [null, request({ ...TREND_LINE, points: [...TREND_LINE.points], verifyCount: 2 }), WAIT_MS],
      chart(fixture, { drawings: { classes: { LineToolTrendLine: { pointsCount: 1 } } } }),
    );

    expect(error.message).toBe(
      'TradingView takes 1 point for a trend_line drawing, where this server expects 2',
    );
  });

  test('a refusal that is neither an error nor a text is quoted as it reads', async () => {
    const { error } = await libFailureOfBoth(
      createDrawing,
      [null, request(), WAIT_MS],
      withChart(
        {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          createShape: () => Promise.reject(42),
        },
        { 1: { getDrawingsExperimentVariation: () => null } },
      ),
    );

    expect(error.message).toBe('TradingView did not create the drawing: 42');
  });

  test('a chart without the call for the number of points given is CAPABILITY_UNAVAILABLE', async () => {
    let drawn = 0;
    const { error } = await libFailureOfBoth(
      createDrawing,
      [null, request(), WAIT_MS],
      withChart(
        {
          createMultipointShape: () => {
            drawn += 1;
            return Promise.resolve('AbC123');
          },
        },
        { 1: { getDrawingsExperimentVariation: () => null } },
      ),
    );

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(drawn).toBe(0);
  });

  test('a page without the chart API to draw with is CAPABILITY_UNAVAILABLE', async () => {
    const { error } = await libFailureOfBoth(
      createDrawing,
      [null, request(), WAIT_MS],
      withChart({ getAllShapes: () => [] }),
    );
    const booting = await libFailureOfBoth(
      createDrawing,
      [null, request(), WAIT_MS],
      chart(fixture, { withoutApi: true }),
    );

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(error.message).toBe('This page has no chart API to draw with');
    expect(booting.error.code).toBe('CAPABILITY_UNAVAILABLE');
  });
});

describe('readDrawings', () => {
  const five: TvStateFixture = {
    ...fixture,
    shapes: [
      { id: 'USR001', name: 'trend_line', properties: { text: 'first' } },
      { id: 'USR002', name: 'horizontal_line' },
      { id: 'USR003', name: 'text', properties: { text: 'Note to self' } },
      { id: 'USR004', name: 'flag' },
      { id: 'USR005', name: 'brush' },
    ],
  };

  test('reports the total, and the points and text of the drawings of the page it returns', async () => {
    const { result } = await resultOf(readDrawings, [null, 1, 2], chart(five));

    expect(result).toEqual({
      total: 5,
      drawings: [
        {
          id: 'USR002',
          shape: 'horizontal_line',
          points: [{ time: timeOf(3), price: bars[3]?.[4] }],
          text: null,
        },
        {
          id: 'USR003',
          shape: 'text',
          points: [{ time: timeOf(6), price: bars[6]?.[4] }],
          text: 'Note to self',
        },
      ],
      unreadable: [],
    });
  });

  test('reads only the drawings of the page it returns', async () => {
    let reads = 0;
    const make = changed((api) => {
      const chartApi = api.activeChart();
      const read = chartApi.getShapeById.bind(chartApi);
      chartApi.getShapeById = (id) => {
        reads += 1;
        return read(id);
      };
    }, five);

    const { result } = await resultOf(readDrawings, [null, 4, 100], make);

    expect(result.drawings.map(({ id }) => id)).toEqual(['USR005']);
    // Once in the page, once for the direct call.
    expect(reads).toBe(2);
  });

  test('a page past the last drawing is empty, and still reports the total', async () => {
    const { result } = await resultOf(readDrawings, [0, 10, 5], chart(five));

    expect(result).toEqual({ total: 5, drawings: [], unreadable: [] });
  });

  test('a drawing that cannot be read is reported by id and type, and listed as unreadable', async () => {
    const { result } = await resultOf(
      readDrawings,
      [null, 0, 2],
      withChart({
        getAllShapes: () => [
          { id: 'AbC123', name: 'trend_line' },
          { id: 'DeF456', name: 'rectangle' },
        ],
        getShapeById: (id: string) => {
          if (id === 'AbC123') {
            throw new Error('There is no such shape');
          }
          return {
            getPoints: () => [
              { time: 1_709_251_200, price: Number.NaN },
              { time: 1_709_337_600, price: 99.5 },
            ],
            getProperties: () => {
              throw new Error('disposed');
            },
          };
        },
      }),
    );

    expect(result).toEqual({
      total: 2,
      drawings: [
        { id: 'AbC123', shape: 'trend_line', points: [], text: null },
        // A point that is not two finite numbers is left out.
        {
          id: 'DeF456',
          shape: 'rectangle',
          points: [{ time: 1_709_337_600, price: 99.5 }],
          text: null,
        },
      ],
      unreadable: ['AbC123', 'DeF456'],
    });
  });

  test('a page without the chart API to read drawings from is CAPABILITY_UNAVAILABLE', async () => {
    const { error } = await failureOfBoth(readDrawings, [null, 0, 10], plain({}));

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(error.message).toBe('This page has no chart API to read the drawings from');
  });
});

describe('readDrawingIds', () => {
  test('lists the ids of the drawings on the chart', async () => {
    const { result } = await resultOf(readDrawingIds, [null], chart());

    expect(result).toEqual({ ids: ['SHAPE01', 'SHAPE02', 'SHAPE03'] });
  });

  test('a page without the chart API is CAPABILITY_UNAVAILABLE', async () => {
    const { error } = await failureOfBoth(readDrawingIds, [null], withChart({}));

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
  });
});

describe('readDrawing', () => {
  const KEYS = ['linecolor', 'color', 'linewidth', 'linestyle', 'fontsize', 'fontSize'];

  test('reads the asked properties, the points and text, and whether the drawing is locked or hidden', async () => {
    const { result } = await resultOf(
      readDrawing,
      [null, 'USR001', KEYS],
      chart({
        ...fixture,
        shapes: [
          {
            id: 'USR001',
            name: 'horizontal_line',
            points: [{ time: timeOf(5), price: 101.25 }],
            properties: { linecolor: '#FF5500', linewidth: 3, text: 'R1', frozen: true },
          },
        ],
      }),
    );

    expect(result).toEqual({
      id: 'USR001',
      shape: 'horizontal_line',
      points: [{ time: timeOf(5), price: 101.25 }],
      text: 'R1',
      properties: { linecolor: '#FF5500', linewidth: 3, linestyle: 0, fontsize: 14 },
      locked: true,
      hidden: false,
    });
  });

  test('a drawing the user cannot edit counts as locked, and one that is not visible as hidden', async () => {
    const { result } = await resultOf(
      readDrawing,
      [null, 'USR001', []],
      chart({
        ...fixture,
        shapes: [{ id: 'USR001', name: 'text', properties: { visible: false }, editable: false }],
      }),
    );

    expect(result).toMatchObject({ locked: true, hidden: true, text: null, properties: {} });
  });

  test('without isHidden, a drawing is hidden when its visible property is false', async () => {
    const { result } = await resultOf(
      readDrawing,
      [null, 'AbC123', []],
      withChart({
        getAllShapes: () => [{ id: 'AbC123', name: 'trend_line' }],
        getShapeById: () => ({
          getPoints: () => [],
          getProperties: () => ({ visible: false, text: 5 }),
          isUserEditEnabled: () => true,
        }),
      }),
    );

    expect(result).toMatchObject({ hidden: true, locked: false, text: null });
  });

  test('an id that is not a drawing on the chart is INVALID_INPUT with the hint drawing_list', async () => {
    const { error } = await failureOfBoth(readDrawing, [null, 'NOPE01', KEYS], chart());

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe('The chart has no drawing with the id NOPE01');
    expect(error.hint).toMatch(/drawing_list/);
    expect(error.details).toEqual({ id: 'NOPE01' });
  });

  test('a listed drawing TradingView says is gone is INVALID_INPUT too, and any other failure PAGE_EVALUATION_FAILED', async () => {
    const listed = (thrown: string) =>
      withChart({
        getAllShapes: () => [{ id: 'AbC123', name: 'trend_line' }],
        getShapeById: () => {
          throw new Error(thrown);
        },
      });

    const gone = await failureOfBoth(
      readDrawing,
      [null, 'AbC123', KEYS],
      listed('There is no such shape'),
    );
    const broken = await failureOfBoth(readDrawing, [null, 'AbC123', KEYS], listed('disposed'));
    const thrownText = await failureOfBoth(
      readDrawing,
      [null, 'AbC123', KEYS],
      withChart({
        getAllShapes: () => [{ id: 'AbC123', name: 'trend_line' }],
        getShapeById: () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'busy';
        },
      }),
    );
    const silent = await failureOfBoth(
      readDrawing,
      [null, 'AbC123', KEYS],
      withChart({
        getAllShapes: () => [{ id: 'AbC123', name: 'trend_line' }],
        getShapeById: () => null,
      }),
    );

    expect(gone.error.code).toBe('INVALID_INPUT');
    expect(broken.error.code).toBe('PAGE_EVALUATION_FAILED');
    expect(broken.error.message).toBe('The drawing AbC123 could not be read: disposed');
    expect(thrownText.error.message).toBe('The drawing AbC123 could not be read: busy');
    expect(silent.error.message).toBe('The drawing AbC123 could not be read: no answer');
  });

  test('a page without the chart API is CAPABILITY_UNAVAILABLE', async () => {
    const { error } = await failureOfBoth(readDrawing, [null, 'AbC123', KEYS], withChart({}));

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
  });
});

describe('removeDrawing', () => {
  test('without confirmation only checks that the drawing is there, and removes nothing', async () => {
    const { result, win } = await resultOf(removeDrawing, [null, 'SHAPE02', false], chart());

    expect(result).toEqual({ removed: false, shape: 'horizontal_line' });
    expect(calls(win, 'chart.removeEntity')).toEqual([]);
  });

  test('with confirmation removes the drawing the way the user could undo', async () => {
    const { result, win } = await resultOf(removeDrawing, [null, 'SHAPE02', true], chart());

    expect(result).toEqual({ removed: true, shape: 'horizontal_line' });
    expect(calls(win, 'chart.removeEntity')).toEqual([['SHAPE02']]);
    expect(inspectFakeWindow(win).state.drawings.removed).toEqual([
      { id: 'SHAPE02', undoable: true },
    ]);
  });

  test('removes a locked drawing as well', async () => {
    const { result } = await resultOf(
      removeDrawing,
      [null, 'LCK001', true],
      chart({
        ...fixture,
        shapes: [{ id: 'LCK001', name: 'trend_line', properties: { frozen: true } }],
      }),
    );

    expect(result).toEqual({ removed: true, shape: 'trend_line' });
  });

  test('an id that is not a drawing on the chart is INVALID_INPUT with the hint drawing_list, confirmed or not', async () => {
    for (const confirmed of [false, true]) {
      const { error, win } = await failureOfBoth(
        removeDrawing,
        [null, 'NOPE01', confirmed],
        chart(),
      );

      expect(error.code).toBe('INVALID_INPUT');
      expect(error.hint).toMatch(/drawing_list/);
      expect(calls(win, 'chart.removeEntity')).toEqual([]);
    }
  });

  test('a drawing TradingView keeps is NOT_AVAILABLE', async () => {
    const keeps = changed((api) => {
      api.activeChart().removeEntity = () => undefined;
    });
    const throws = changed((api) => {
      api.activeChart().removeEntity = () => {
        throw new Error('busy');
      };
    });

    const kept = await failureOfBoth(removeDrawing, [null, 'SHAPE02', true], keeps);
    const thrown = await failureOfBoth(removeDrawing, [null, 'SHAPE02', true], throws);

    expect(kept.error.code).toBe('NOT_AVAILABLE');
    expect(kept.error.message).toBe('TradingView did not remove the drawing SHAPE02');
    expect(thrown.error.code).toBe('NOT_AVAILABLE');
    expect(thrown.error.message).toBe('TradingView did not remove the drawing SHAPE02: busy');
    const thrownText = await failureOfBoth(
      removeDrawing,
      [null, 'SHAPE02', true],
      changed((api) => {
        api.activeChart().removeEntity = () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'locked by the app';
        };
      }),
    );
    expect(thrownText.error.message).toBe(
      'TradingView did not remove the drawing SHAPE02: locked by the app',
    );
  });

  test('a removal the drawings cannot be listed after is NOT_AVAILABLE, never removed', async () => {
    for (const listing of [
      () => {
        throw new Error('busy');
      },
      () => 'nonsense',
    ]) {
      const { error, win } = await failureOfBoth(
        removeDrawing,
        [null, 'SHAPE02', true],
        listsAfterRemovalWith(listing),
      );

      expect(error.toPayload()).toEqual({
        code: 'NOT_AVAILABLE',
        message:
          'TradingView took the removal of the drawing SHAPE02, but the drawings of the chart ' +
          'could not be listed afterwards to confirm it',
        hint: 'Check drawing_list.',
        details: { id: 'SHAPE02' },
      });
      expect(calls(win, 'chart.removeEntity')).toEqual([['SHAPE02']]);
    }
  });

  test('a page without the chart API to remove drawings with is CAPABILITY_UNAVAILABLE', async () => {
    const { error } = await failureOfBoth(
      removeDrawing,
      [null, 'SHAPE02', true],
      withChart({ getAllShapes: () => [] }),
    );

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(error.message).toBe('This page has no chart API to remove drawings with');
  });
});

describe('removeDrawings', () => {
  test('removes the given drawings that are on the chart, one by one, and leaves the rest', async () => {
    const { result, win } = await resultOf(
      removeDrawings,
      [null, ['SHAPE03', 'GONE01', 'SHAPE01']],
      chart(),
    );

    expect(result).toEqual({ removed: ['SHAPE03', 'SHAPE01'], failed: [] });
    expect(calls(win, 'chart.removeEntity')).toEqual([['SHAPE03'], ['SHAPE01']]);
    expect(inspectFakeWindow(win).state.drawings.list.map(({ id }) => id)).toEqual(['SHAPE02']);
  });

  test('without ids removes every drawing, a locked one included, and never through removeAllShapes', async () => {
    const { result, win } = await resultOf(
      removeDrawings,
      [null, null],
      chart({
        ...fixture,
        shapes: [...fixture.shapes, { id: 'LCK001', name: 'text', properties: { frozen: true } }],
      }),
    );

    expect(result).toEqual({ removed: ['SHAPE01', 'SHAPE02', 'SHAPE03', 'LCK001'], failed: [] });
    expect(inspectFakeWindow(win).state.drawings.list).toEqual([]);
    expect(calls(win, 'chart.removeAllShapes')).toEqual([]);
    expect(calls(win, 'dialog.confirmRemovingLockedLineTools')).toEqual([]);
  });

  test('names each drawing TradingView kept', async () => {
    const make = changed((api) => {
      const chartApi = api.activeChart();
      const remove = chartApi.removeEntity.bind(chartApi);
      chartApi.removeEntity = (id, options) => {
        if (id === 'SHAPE02') {
          throw new Error('busy');
        }
        if (id !== 'SHAPE03') {
          remove(id, options);
        }
      };
    });

    const { result } = await resultOf(removeDrawings, [null, null], make);

    expect(result).toEqual({ removed: ['SHAPE01'], failed: ['SHAPE02', 'SHAPE03'] });
  });

  test('removals the drawings cannot be listed after are NOT_AVAILABLE, none of them removed', async () => {
    for (const listing of [
      () => {
        throw new Error('busy');
      },
      () => 'nonsense',
    ]) {
      const { error, win } = await failureOfBoth(
        removeDrawings,
        [null, ['SHAPE03', 'SHAPE01']],
        listsAfterRemovalWith(listing),
      );

      expect(error.toPayload()).toEqual({
        code: 'NOT_AVAILABLE',
        message:
          'TradingView took the removal of 2 drawings, but the drawings of the chart could not ' +
          'be listed afterwards to confirm it',
        hint: 'Check drawing_list.',
        details: { ids: ['SHAPE03', 'SHAPE01'] },
      });
      expect(calls(win, 'chart.removeEntity')).toEqual([['SHAPE03'], ['SHAPE01']]);
    }
  });

  test('nothing to remove needs no listing afterwards, and an empty list of ids removes nothing', async () => {
    const { result, win } = await resultOf(removeDrawings, [null, []], chart());
    const unlisted = await resultOf(
      removeDrawings,
      [null, ['GONE01']],
      listsAfterRemovalWith(() => {
        throw new Error('busy');
      }),
    );

    expect(result).toEqual({ removed: [], failed: [] });
    expect(calls(win, 'chart.removeEntity')).toEqual([]);
    expect(inspectFakeWindow(win).state.drawings.list.map(({ id }) => id)).toEqual([
      'SHAPE01',
      'SHAPE02',
      'SHAPE03',
    ]);
    expect(unlisted.result).toEqual({ removed: [], failed: [] });
  });

  test('a page without the chart API is CAPABILITY_UNAVAILABLE', async () => {
    const { error } = await failureOfBoth(removeDrawings, [null, null], withChart({}));

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
  });
});

describe('odd answers of the page', () => {
  test('a chart index the page cannot give is CAPABILITY_UNAVAILABLE for every page function, before it acts', async () => {
    // The fake app knows chart 0 only, and throws for chart(1) as the app does.
    const make = chart();

    const errors = [
      (await failureOfBoth(readDrawings, [1, 0, 10], make)).error,
      (await failureOfBoth(readDrawingIds, [1], make)).error,
      (await failureOfBoth(readDrawing, [1, 'SHAPE01', []], make)).error,
      (await libFailureOfBoth(createDrawing, [1, request(), WAIT_MS], make)).error,
      (await failureOfBoth(removeDrawing, [1, 'SHAPE01', true], make)).error,
    ];
    const removal = await failureOfBoth(removeDrawings, [1, null], make);

    for (const error of [...errors, removal.error]) {
      expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
    }
    expect(calls(removal.win, 'chart.removeEntity')).toEqual([]);
  });

  test('list entries without a text id are passed over, and a type that is no text reads as empty', async () => {
    const odd = withChart({
      getAllShapes: () => [null, { id: 5, name: 'trend_line' }, { id: 'AbC123', name: 7 }],
      getShapeById: () => ({
        getPoints: () => [null, { time: 1_709_251_200, price: 1 }],
        getProperties: () => ({}),
        isUserEditEnabled: () => true,
        isHidden: () => false,
      }),
      removeEntity: () => undefined,
    });

    const listedPage = await resultOf(readDrawings, [null, 0, 10], odd);
    const ids = await resultOf(readDrawingIds, [null], odd);
    const one = await resultOf(readDrawing, [null, 'AbC123', []], odd);
    const unconfirmed = await resultOf(removeDrawing, [null, 'AbC123', false], odd);
    const kept = await resultOf(removeDrawings, [null, null], odd);

    expect(listedPage.result).toEqual({
      total: 1,
      drawings: [
        { id: 'AbC123', shape: '', points: [{ time: 1_709_251_200, price: 1 }], text: null },
      ],
      unreadable: [],
    });
    expect(ids.result).toEqual({ ids: ['AbC123'] });
    expect(one.result).toEqual({
      id: 'AbC123',
      shape: '',
      points: [{ time: 1_709_251_200, price: 1 }],
      text: null,
      properties: {},
      locked: false,
      hidden: false,
    });
    expect(unconfirmed.result).toEqual({ removed: false, shape: '' });
    expect(kept.result).toEqual({ removed: [], failed: ['AbC123'] });
  });

  test('a drawing whose points are no list has no points', async () => {
    const { result } = await resultOf(
      readDrawing,
      [null, 'AbC123', []],
      withChart({
        getAllShapes: () => [{ id: 'AbC123', name: 'trend_line' }],
        getShapeById: () => ({ getPoints: () => null, getProperties: () => null }),
      }),
    );

    expect(result).toMatchObject({ points: [], text: null, locked: false, hidden: false });
  });

  test('a list that is no array, or that throws, holds no drawings', async () => {
    const members = { getShapeById: () => ({}), removeEntity: () => undefined };
    for (const getAllShapes of [
      () => 'nonsense',
      () => {
        throw new Error('busy');
      },
    ]) {
      const make = withChart({ ...members, getAllShapes });

      expect((await resultOf(readDrawings, [null, 0, 10], make)).result).toEqual({
        total: 0,
        drawings: [],
        unreadable: [],
      });
      expect((await resultOf(readDrawingIds, [null], make)).result).toEqual({ ids: [] });
      expect((await failureOfBoth(readDrawing, [null, 'AbC123', []], make)).error.code).toBe(
        'INVALID_INPUT',
      );
      expect((await failureOfBoth(removeDrawing, [null, 'AbC123', true], make)).error.code).toBe(
        'INVALID_INPUT',
      );
      expect((await resultOf(removeDrawings, [null, ['AbC123']], make)).result).toEqual({
        removed: [],
        failed: [],
      });
    }
  });
});
