import type { CdpSession } from '../../../src/core/cdp/types.js';
import { createPageBridge } from '../../../src/core/tv/page-bridge.js';
import type { TvWindow } from '../../../src/core/tv/tv-window.js';
import type { JsonValue } from '../../../src/utils/json.js';
import { findLeaks, scrubStudyShapes } from '../../../scripts/re/scrub.js';
import { readStudyShapes } from '../../../scripts/re/shapes.js';
import { createPageRuntime } from '../../helpers/fake-cdp/runtime.js';
import { loadTvFixture } from '../../helpers/fake-tv/fixture.js';
import { createFakeTvWindow } from '../../helpers/fake-tv/window.js';
import { SAMPLE_STRATEGY, withStudies } from '../../helpers/strategy-fixtures.js';

// The shapes the recorder writes next to a fixture: key names and value types of what the app holds
// for each study, never a value. Run on the fake app, directly and as source text through the page
// bridge, the way the recorder runs it.

const fixture = loadTvFixture();
const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
});

async function throughTheBridge(win: object) {
  const runtime = createPageRuntime(win);
  disposers.push(() => {
    runtime.dispose();
  });
  const session: CdpSession = {
    targetId: 'PAGE1',
    isClosed: false,
    send: (method: string, params?: unknown) =>
      method === 'Runtime.evaluate'
        ? runtime.evaluate(params as Record<string, unknown>)
        : Promise.reject(new Error(`Unexpected command ${method}`)),
    onClose: () => undefined,
    close: () => Promise.resolve(),
  };
  return createPageBridge(session, { timeoutMs: 5000 }).evaluate(readStudyShapes, []);
}

// Every leaf of a shape, with the path to it.
function leaves(value: JsonValue, path = ''): [string, JsonValue][] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => leaves(item, `${path}[]`));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => leaves(item, `${path}.${key}`));
  }
  return [[path, value]];
}

const TYPE_NAME =
  /^(string|number|boolean|null|undefined|object|array|function|getter|mixed)(\|(string|number|boolean|null|undefined|object|array|function|getter|mixed))*$/;

test('readStudyShapes gives the shapes of the studies on the chart, the same in the page', async () => {
  const win = createFakeTvWindow(fixture);

  const direct = readStudyShapes(win);
  const bridged = await throughTheBridge(createFakeTvWindow(fixture));

  expect(bridged).toEqual(direct);
  expect(direct.studies).toHaveLength(fixture.studies.length);
  const [first] = direct.studies;
  expect(first?.strategy).toBe(false);
  expect(first?.report).toBeNull();
  // The members of a plot, of an input and of the API, with the types of their values.
  expect(first?.plots).toEqual([expect.objectContaining({ id: 'string' })]);
  expect(first?.inputs).toEqual([expect.objectContaining({ id: 'string', name: 'string' })]);
  expect(first?.api).toMatchObject({ getInputsInfo: 'function', study: 'function' });
});

test('readStudyShapes writes types only, never a value of a study', () => {
  const win = createFakeTvWindow(fixture);

  const shapes = readStudyShapes(win);

  for (const study of shapes.studies) {
    for (const [path, leaf] of leaves([study.plots, study.styles, study.inputs, study.api])) {
      expect(typeof leaf === 'string' && TYPE_NAME.test(leaf), path).toBe(true);
    }
  }
  // No name, id or input of the fixture, but those that are also member names of the app (type).
  const values = fixture.studies.flatMap(({ id, name, inputs }) => [
    id,
    name,
    ...(inputs ?? []).flatMap(({ name: input, value }) => [input, JSON.stringify(value)]),
  ]);
  expect(
    findLeaks(
      shapes,
      values.filter((value) => value.length >= 3 && value.toLowerCase() !== 'type'),
    ),
  ).toEqual([]);
});

test('readStudyShapes gives the shape of the report of a strategy, without its numbers', () => {
  const win = createFakeTvWindow(withStudies(fixture, SAMPLE_STRATEGY));

  const shapes = readStudyShapes(win);

  const strategy = shapes.studies.find(({ strategy: isStrategy }) => isStrategy);
  expect(strategy?.report).toMatchObject({
    currency: 'string',
    performance: { all: { netProfit: 'number' } },
    filledOrders: [expect.objectContaining({ p: 'number' })],
  });
  for (const [path, leaf] of leaves(strategy?.report ?? null)) {
    expect(typeof leaf === 'string' && TYPE_NAME.test(leaf), path).toBe(true);
  }
});

test('readStudyShapes reads nothing on a page without a chart, and survives members that throw', () => {
  expect(readStudyShapes({} as TvWindow)).toEqual({ studies: [] });
  const throwing = {
    TradingViewApi: {
      activeChart: () => ({
        getAllStudies: () => [{ id: 'A' }],
        getStudyById: () => {
          throw new Error('There is no such study');
        },
      }),
    },
  } as unknown as TvWindow;

  expect(readStudyShapes(throwing)).toEqual({
    studies: [
      {
        pine: false,
        strategy: false,
        plots: 'undefined',
        styles: 'undefined',
        inputs: 'undefined',
        api: 'undefined',
        report: null,
      },
    ],
  });
});

test('readStudyShapes records an accessor of the study API as a getter, without calling it', () => {
  let reads = 0;
  class StudyApi {
    get paneIndex(): number {
      reads += 1;
      throw new Error('An accessor was called');
    }

    title(): string {
      return 'x';
    }
  }
  const api = new StudyApi();
  Object.defineProperty(api, 'status', {
    get: () => {
      reads += 1;
      return 1;
    },
    enumerable: true,
  });
  const win = {
    TradingViewApi: {
      activeChart: () => ({ getAllStudies: () => [{ id: 'A' }], getStudyById: () => api }),
    },
  } as unknown as TvWindow;

  const shapes = readStudyShapes(win);

  expect(shapes.studies[0]?.api).toEqual({
    paneIndex: 'getter',
    status: 'getter',
    title: 'function',
  });
  expect(reads).toBe(0);
});

test('the shapes of the fake app keep the member names the app writes through the scrubber', () => {
  const win = createFakeTvWindow(withStudies(fixture, SAMPLE_STRATEGY));
  const shapes = readStudyShapes(win);

  const scrubbed = scrubStudyShapes(shapes);

  // Everything but the keys the sample report adds to test the strategy tools, which the app does
  // not write and the scrubber therefore does not keep.
  const odd = /notAvailable|inUse|nested|gone/;
  expect(JSON.stringify(scrubbed)).not.toMatch(odd);
  const strip = (value: JsonValue): JsonValue =>
    JSON.parse(JSON.stringify(value), (key, item: unknown) =>
      odd.test(key) || /^<key \d+>$/.test(key) ? undefined : item,
    ) as JsonValue;
  expect(strip(scrubbed as unknown as JsonValue)).toEqual(strip(shapes as unknown as JsonValue));
});
