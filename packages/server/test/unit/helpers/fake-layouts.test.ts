import { setTimeout as delay } from 'node:timers/promises';
import { loadTvFixture, type TvStateFixture } from '../../helpers/fake-tv/fixture.js';
import type { FakeWebpackRequire } from '../../helpers/fake-tv/webpack.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTradingViewApi,
  type FakeTvOverrides,
  type FakeTvWindow,
} from '../../helpers/fake-tv/window.js';

// The saved layouts of the fake account and the layout functions of the fake app (layouts.ts),
// checked against what the reverse-engineering notes of Plan 3 (section 1) and the web build record
// for the app. Values are synthetic.

const fixture = loadTvFixture();
// A plan that lets the account save five layouts.
const roomy: TvStateFixture = {
  ...fixture,
  planLimits: { ...fixture.planLimits, CHART_STORAGE: 5 },
};

// The exports of the default webpack cache, by name. Each look pushes a chunk of its own: the runtime
// hands nothing to a chunk ID it has seen.
let probes = 0;
function exportsOf(win: FakeTvWindow): Record<string, unknown> {
  let handed: FakeWebpackRequire | undefined;
  probes += 1;
  (win.webpackChunktradingview as { push(chunk: unknown): unknown }).push([
    [`probe${String(probes)}`],
    {},
    (given: FakeWebpackRequire) => (handed = given),
  ]);
  const found: Record<string, unknown> = {};
  for (const record of Object.values(handed?.c ?? {})) {
    Object.assign(found, record.exports);
  }
  return found;
}

function windowWith(from: TvStateFixture = fixture, overrides: FakeTvOverrides = {}): FakeTvWindow {
  return createFakeTvWindow(from, overrides);
}

function apiOf(win: FakeTvWindow): FakeTradingViewApi {
  if (win.TradingViewApi === undefined) {
    throw new Error('The fake window has no TradingViewApi');
  }
  return win.TradingViewApi;
}

const createNewChartOf = (win: FakeTvWindow) =>
  exportsOf(win).createNewChart as (options?: unknown) => Promise<string | undefined>;
const permissionOf = (win: FakeTvWindow) =>
  exportsOf(win).hasPermissionsToCreateNewChart as () => Promise<boolean>;

const calls = (win: FakeTvWindow, name: string) => inspectFakeWindow(win).callsTo(name);
const stateOf = (win: FakeTvWindow) => inspectFakeWindow(win).state.layouts;

// What a promise rejected with, as a plain object of the members page code reads.
async function rejectionOf(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    const { message, status } = error as Record<string, unknown>;
    return { message, status };
  }
  throw new Error('Expected the promise to reject');
}

describe('the saved layouts', () => {
  test('getSavedCharts answers the records of the server in its order, in the shape of the app, and records itself', async () => {
    const win = windowWith();

    const records = await apiOf(win).getSavedCharts();

    expect(records.map((record) => record.url)).toEqual(['FIXTURE1', 'FIXTURE2', 'FIXTURE3']);
    expect(records[0]).toEqual({
      id: 9001,
      url: 'FIXTURE1',
      image_url: 'FIXTURE1',
      name: 'Fixture Layout',
      symbol: 'AAPL',
      short_name: 'AAPL',
      pro_symbol: 'NASDAQ:AAPL',
      short_symbol: 'AAPL',
      resolution: '1D',
      interval: '1D',
      expression: 'NASDAQ:AAPL',
      created: '2026-01-01',
      modified: '2026-01-01',
      created_time: 'Thu, 01 Jan 2026 00:00:00 GMT',
      created_timestamp: 1767225600,
      modified_iso: 1767225600,
      favorite: false,
    });
    // over_limit only on a layout over the limit.
    expect(records.map((record) => record.over_limit)).toEqual([undefined, undefined, true]);
    expect(calls(win, 'TradingViewApi.getSavedCharts')).toEqual([[]]);
  });

  test('getSavedCharts hands the records to a callback too, and rejects with a staged error', async () => {
    const win = windowWith();
    const handed: unknown[] = [];

    await apiOf(win).getSavedCharts((records: unknown) => handed.push(records));
    stateOf(win).errors.getSavedCharts = { status: 500, code: null, message: 'Not OK' };

    expect(handed).toHaveLength(1);
    await expect(apiOf(win).getSavedCharts()).rejects.toThrow('Not OK');
  });

  test('a fixture without saved layouts has none', async () => {
    const win = windowWith({ ...fixture, savedLayouts: undefined });

    expect(await apiOf(win).getSavedCharts()).toEqual([]);
    expect(stateOf(win).current).toEqual({ id: null, uid: 'FIXTURE1', name: 'Fixture Layout' });
  });

  test('the layout of the fixture is on the chart, without unsaved changes, and its chart has its data', async () => {
    const win = windowWith();
    const api = apiOf(win);

    expect(api.layoutId()).toBe('FIXTURE1');
    expect(api.layoutName()).toBe('Fixture Layout');
    expect(stateOf(win).current).toEqual({ id: 9001, uid: 'FIXTURE1', name: 'Fixture Layout' });
    expect(api.hasChartChanges().value()).toBe(false);
    stateOf(win).unsaved = true;
    expect(api.hasChartChanges().value()).toBe(true);
    expect(await api.activeChart().dataReady()).toBe(true);
    expect(api.activeChart()._chartWidget.model().mainSeries().interval()).toBe('1D');
  });

  test('a layout that was never saved has no id and no name', () => {
    const win = windowWith();
    stateOf(win).current = { id: null, uid: null, name: null };

    expect(apiOf(win).layoutId()).toBeNull();
    expect(apiOf(win).layoutName()).toBeNull();
  });
});

describe('loadLayoutFromServerByLayoutId', () => {
  test('switches the meta info first, resolves once the content is in place and has the data of the chart after that', async () => {
    const win = windowWith(fixture, { layouts: { loadMs: 40, dataMs: 80 } });
    const api = apiOf(win);
    let resolved = false;

    const loading = api.loadLayoutFromServerByLayoutId('FIXTURE2', false, true).then(() => {
      resolved = true;
    });
    await delay(10);

    expect(api.layoutId()).toBe('FIXTURE2');
    expect(api.layoutName()).toBe('Second Layout');
    expect(stateOf(win).current.id).toBe(9002);
    expect(resolved).toBe(false);
    await loading;
    let ready = false;
    const data = api
      .activeChart()
      .dataReady()
      .then(() => (ready = true));
    await delay(20);
    expect(ready).toBe(false);
    await data;
    expect(stateOf(win).dataReady).toBe(true);
    expect(calls(win, 'TradingViewApi.loadLayoutFromServerByLayoutId')).toEqual([
      ['FIXTURE2', false, true],
    ]);
  });

  test('discards unsaved changes when told to skip the confirmation', async () => {
    const win = windowWith();
    stateOf(win).unsaved = true;

    await apiOf(win).loadLayoutFromServerByLayoutId('FIXTURE2', false, true);

    expect(stateOf(win).unsaved).toBe(false);
    expect(calls(win, 'dialog.unsavedChanges')).toEqual([]);
  });

  test('asks about unsaved changes in a dialog without skipConfirm, and opens nothing when cancelled', async () => {
    const win = windowWith();
    stateOf(win).unsaved = true;

    await expect(apiOf(win).loadLayoutFromServerByLayoutId('FIXTURE2')).rejects.toThrow(
      'Layout "FIXTURE2" was not opened',
    );
    expect(calls(win, 'dialog.unsavedChanges')).toEqual([[]]);
    expect(apiOf(win).layoutId()).toBe('FIXTURE1');
  });

  test('loads nothing for a url the server does not hold, and resolves', async () => {
    const win = windowWith();

    await apiOf(win).loadLayoutFromServerByLayoutId('NOSUCH01', false, true);

    expect(apiOf(win).layoutId()).toBe('FIXTURE1');
  });

  test('opens the layout in a new tab when asked to', async () => {
    const win = windowWith();

    await apiOf(win).loadLayoutFromServerByLayoutId('FIXTURE2', true, true);

    expect(calls(win, 'backend.openLayoutLink')).toEqual([['FIXTURE2']]);
    expect(apiOf(win).layoutId()).toBe('FIXTURE1');
  });

  test('opens the paywall for a layout over the limit, and rejects', async () => {
    const win = windowWith();

    await expect(
      apiOf(win).loadLayoutFromServerByLayoutId('FIXTURE3', false, true),
    ).rejects.toThrow('Layout "FIXTURE3" was not opened');
    expect(calls(win, 'dialog.paywall')).toEqual([['PAYWALL_SAVED_CHARTS_OVER_LIMIT']]);
    expect(apiOf(win).layoutId()).toBe('FIXTURE1');
  });

  test('rejects with the status of a failed request for the layout, and switches nothing', async () => {
    const win = windowWith();
    stateOf(win).errors.loadLayout = { status: 500, code: null, message: 'Server error' };

    expect(
      await rejectionOf(apiOf(win).loadLayoutFromServerByLayoutId('FIXTURE2', false, true)),
    ).toEqual({ message: 'Server error', status: 500 });
    expect(apiOf(win).layoutId()).toBe('FIXTURE1');
  });

  test('a load that hangs never ends and switches nothing', async () => {
    const win = windowWith();
    stateOf(win).loadHangs = true;
    let settled = false;

    void apiOf(win)
      .loadLayoutFromServerByLayoutId('FIXTURE2', false, true)
      .then(() => (settled = true));
    await delay(40);

    expect(settled).toBe(false);
    expect(apiOf(win).layoutId()).toBe('FIXTURE1');
  });

  test('a chart whose data never comes keeps dataReady pending, and a newer load wins over an older one', async () => {
    const never = windowWith(fixture, { layouts: { dataMs: Infinity } });
    let ready = false;
    await apiOf(never).loadLayoutFromServerByLayoutId('FIXTURE2', false, true);
    void apiOf(never)
      .activeChart()
      .dataReady()
      .then(() => (ready = true));
    await delay(40);
    expect(ready).toBe(false);

    const win = windowWith(fixture, { layouts: { loadMs: 0, dataMs: 200 } });
    await apiOf(win).loadLayoutFromServerByLayoutId('FIXTURE2', false, true);
    await delay(100);
    await apiOf(win).loadLayoutFromServerByLayoutId('FIXTURE1', false, true);
    await delay(150);
    // The data of the first load arrived after the second load began, so it does not count.
    expect(stateOf(win).dataReady).toBe(false);
    await apiOf(win).activeChart().dataReady();
    expect(apiOf(win).layoutId()).toBe('FIXTURE1');
  });

  test('the chart of an unknown symbol never reports its data', async () => {
    const win = windowWith();
    await apiOf(win).activeChart().setSymbol('NOPE:NOTHING');
    let ready = false;

    void apiOf(win)
      .activeChart()
      .dataReady()
      .then(() => (ready = true));
    await delay(30);

    expect(ready).toBe(false);
  });
});

describe('createNewChart', () => {
  test('creates a saved layout with the options it is given and answers its URL', async () => {
    const win = windowWith(roomy);
    const options = {
      name: 'Example Layout',
      symbol: 'NYSE:IBM',
      short_name: 'IBM',
      symbol_type: 'stock',
      exchange: 'NYSE',
      interval: '60',
    };

    const url = await createNewChartOf(win)(options);

    expect(url).toBe('https://www.tradingview.com/chart/NEW00001/');
    expect(calls(win, 'createNewChart')).toEqual([[options]]);
    expect(stateOf(win).saved.at(-1)).toEqual({
      id: 9004,
      url: 'NEW00001',
      name: 'Example Layout',
      modified: expect.any(Number) as number,
      overLimit: false,
      symbol: 'NYSE:IBM',
      interval: '60',
    });
    // It creates the layout and leaves the chart alone.
    expect(apiOf(win).layoutId()).toBe('FIXTURE1');
    expect(await createNewChartOf(win)()).toBe('https://www.tradingview.com/chart/NEW00002/');
    expect(stateOf(win).saved.at(-1)).toMatchObject({
      name: '',
      symbol: 'BATS:AAPL',
      interval: '1D',
    });
  });

  test('answers undefined after the paywall when the plan is full or the account is signed out', async () => {
    const full = windowWith({
      ...fixture,
      planLimits: { ...fixture.planLimits, CHART_STORAGE: 3 },
    });
    const signedOut = windowWith(roomy);
    inspectFakeWindow(signedOut).state.pineEditor.signedIn = false;

    expect(await createNewChartOf(full)({ name: 'X' })).toBeUndefined();
    expect(await createNewChartOf(signedOut)({ name: 'X' })).toBeUndefined();
    for (const win of [full, signedOut]) {
      expect(calls(win, 'dialog.paywall')).toEqual([['PAYWALL_SAVED_CHARTS_LIMIT']]);
      expect(stateOf(win).saved).toHaveLength(3);
    }
  });

  test('answers undefined after a warning for a staged error, or after the paywall for a staged limit code', async () => {
    const win = windowWith(roomy);
    stateOf(win).errors.createNewChart = {
      status: 503,
      code: 'disabled_temporarily',
      message: 'Saving is disabled',
    };

    expect(await createNewChartOf(win)({ name: 'X' })).toBeUndefined();
    expect(calls(win, 'dialog.warning')).toEqual([['Saving is disabled']]);
    stateOf(win).errors.createNewChart = {
      status: 403,
      code: 'saved_chart_limit_reached',
      message: 'Limit',
    };
    expect(await createNewChartOf(win)({ name: 'X' })).toBeUndefined();
    expect(calls(win, 'dialog.paywall')).toEqual([['PAYWALL_SAVED_CHARTS_LIMIT']]);
    expect(stateOf(win).saved).toHaveLength(3);
  });

  test('a layout it created loads in place, from the server', async () => {
    const win = windowWith(roomy);

    await createNewChartOf(win)({ name: 'Example Layout' });
    await apiOf(win).loadLayoutFromServerByLayoutId('NEW00001', false, true);

    expect(stateOf(win).current).toEqual({ id: 9004, uid: 'NEW00001', name: 'Example Layout' });
  });
});

describe('hasPermissionsToCreateNewChart', () => {
  test('answers whether the CHART_STORAGE limit is above the count of saved layouts, which it asks for', async () => {
    const win = windowWith(roomy);
    const full = windowWith({
      ...fixture,
      planLimits: { ...fixture.planLimits, CHART_STORAGE: 3 },
    });

    expect(await permissionOf(win)()).toBe(true);
    expect(await permissionOf(full)()).toBe(false);
    expect(calls(win, 'hasPermissionsToCreateNewChart')).toEqual([[]]);
    expect(calls(win, 'getChartsCount')).toEqual([[]]);
  });

  test('answers false signed out and without a positive limit, without asking for the count', async () => {
    const signedOut = windowWith(roomy);
    inspectFakeWindow(signedOut).state.pineEditor.signedIn = false;
    const unlimited = windowWith();
    const zero = windowWith({
      ...fixture,
      planLimits: { ...fixture.planLimits, CHART_STORAGE: 0 },
    });

    for (const win of [signedOut, unlimited, zero]) {
      expect(await permissionOf(win)()).toBe(false);
      expect(calls(win, 'getChartsCount')).toEqual([]);
    }
  });

  test('answers false for a count request refused with 403 and rejects for any other failure', async () => {
    const win = windowWith(roomy);
    stateOf(win).errors.getChartsCount = { status: 403, code: null, message: 'Forbidden' };

    expect(await permissionOf(win)()).toBe(false);
    stateOf(win).errors.getChartsCount = { status: 500, code: null, message: 'Server error' };
    expect(await rejectionOf(permissionOf(win)())).toEqual({
      message: 'Server error',
      status: 500,
    });
  });
});

describe('the layout functions the tools must never use', () => {
  test('loadChartFromServer, createNewLayout and openNewChart only record themselves', async () => {
    const win = windowWith(roomy);
    const api = apiOf(win);

    await api.loadChartFromServer({ url: 'FIXTURE2' });
    expect(await api.createNewLayout({ name: 'X' })).toBeNull();
    await (exportsOf(win).openNewChart as (options: unknown) => Promise<void>)({ name: 'X' });

    expect(calls(win, 'TradingViewApi.loadChartFromServer')).toEqual([[{ url: 'FIXTURE2' }]]);
    expect(calls(win, 'TradingViewApi.createNewLayout')).toEqual([[{ name: 'X' }]]);
    expect(calls(win, 'openNewChart')).toEqual([[{ name: 'X' }]]);
    expect(api.layoutId()).toBe('FIXTURE1');
    expect(stateOf(win).saved).toHaveLength(3);
  });

  test('the layout exports can be left out', () => {
    const exports = exportsOf(
      windowWith(fixture, {
        layouts: { withoutCreateNewChart: true, withoutPermissionCheck: true },
      }),
    );

    expect(exports.createNewChart).toBeUndefined();
    expect(exports.hasPermissionsToCreateNewChart).toBeUndefined();
    expect(typeof exports.openNewChart).toBe('function');
  });
});
