import type { FixtureSavedLayout } from './fixture.js';

// The saved layouts of the account and the layout functions of the app, built from the
// savedLayouts and the layout of the fixture (reverse-engineering notes of Plan 3, section 1, and
// the web build). Values are synthetic.
//
// - The layouts server (state.layouts.saved) holds the saved layouts of the account, in its order.
//   TradingViewApi.getSavedCharts() answers its records on a later tick, in the shape the app gives
//   them (id, url, image_url, name, symbol, short_name, pro_symbol, short_symbol, resolution,
//   interval, expression, created, modified, created_time, created_timestamp, modified_iso in Unix
//   seconds, favorite, and over_limit only on a layout over the plan limit), and records itself:
//   it sends the request of the layouts menu. A staged error rejects it.
// - The layout on the chart is the meta info of the collection of the charts (state.layouts.current:
//   its server id, its uid, which layoutId() answers, and its name, which layoutName() answers),
//   the layout of the fixture at first. hasChartChanges() answers a read-only watched value of
//   state.layouts.unsaved, and shouldBeSaved(), what the shell asks before it closes the tab of the
//   layout (notes of Plan 3, section 3.4), answers state.layouts.unsaved itself: the layout is not
//   read-only.
// - loadLayoutFromServerByLayoutId(url, openInNewTab, skipConfirm) loads a saved layout the way
//   loadChartByUrl of the app does, and records itself with its arguments as given. A url the server
//   does not hold loads nothing and resolves. A truthy openInNewTab opens the layout in a new tab
//   instead (backend.openLayoutLink, recorded). A layout over the limit opens the paywall
//   (dialog.paywall) and rejects, and so do unsaved changes without skipConfirm, after the
//   unsaved-changes dialog (dialog.unsavedChanges), which the fake answers with Cancel. Otherwise,
//   after a tick (the request for the layout, which a staged error rejects), it switches the meta
//   info first, as loadLayoutState does, clears the unsaved changes and the data of the chart, and
//   resolves loadMs later, once the content is in place. The chart has its data dataMs after that:
//   whenDataReady() resolves then, which the chart answers dataReady() with. state.layouts.loadHangs
//   makes a load never end and switch nothing.
// - The exports createNewChart and openNewChart, one module as on the app. createNewChart(options)
//   records itself, and on a later tick the server adds a layout with the name, the symbol and the
//   interval of the options (its content "null") and it answers the URL of the new layout. A failure
//   answers undefined after recording the dialog the app opens: the paywall (dialog.paywall,
//   PAYWALL_SAVED_CHARTS_LIMIT) for a signed-out account (login_required) and for a plan that is full
//   (saved_chart_limit_reached: as many saved layouts as the CHART_STORAGE limit of the plan), and a
//   warning (dialog.warning) for any other error a test stages. openNewChart only records itself.
// - The export hasPermissionsToCreateNewChart() answers as the app does: false signed out and without
//   a positive CHART_STORAGE limit, else whether that limit is above the count of saved layouts, which
//   it asks the server for (getChartsCount, recorded). A staged error of that request with status 403
//   answers false; any other one rejects.
// - TradingViewApi.loadChartFromServer and TradingViewApi.createNewLayout, which the tools must never
//   use (the first asks about unsaved changes in a dialog, the second rewrites the URL of the page
//   without loading the layout), only record themselves.

export interface FakeLayoutsOptions {
  // How long a load takes from the moment it switches the meta info to the moment its content is in
  // place and it resolves. Default 10 ms.
  loadMs?: number;
  // How long after that the chart has its data. Infinity: never. Default 10 ms.
  dataMs?: number;
  // Leave an export out of the cache, as a build without it.
  withoutCreateNewChart?: boolean;
  withoutPermissionCheck?: boolean;
}

// The requests a test can stage an error for.
export type FakeLayoutsRequest =
  'getSavedCharts' | 'loadLayout' | 'createNewChart' | 'getChartsCount';

// An error of the layouts server: the HTTP status, the code of its answer (null without one) and a
// message.
export interface FakeLayoutsError {
  status: number;
  code: string | null;
  message: string;
}

// A saved layout as the layouts server keeps it. symbol and interval are those it was saved with.
export interface FakeSavedLayout {
  id: number;
  url: string;
  name: string;
  modified: number;
  overLimit: boolean;
  symbol: string;
  interval: string;
}

// The meta info of the layout on the chart: null members for a layout that was never saved.
export interface FakeLayoutMeta {
  id: number | null;
  uid: string | null;
  name: string | null;
}

// The live state of the layouts. Tests may assign to it, for example to stage unsaved changes or the
// error of a request.
export interface FakeLayoutsState {
  saved: FakeSavedLayout[];
  current: FakeLayoutMeta;
  unsaved: boolean;
  // Whether the chart of the layout on the chart has its data.
  dataReady: boolean;
  // Whether a load never ends and switches nothing.
  loadHangs: boolean;
  // The error each request answers with, until a test removes it.
  errors: Partial<Record<FakeLayoutsRequest, FakeLayoutsError>>;
}

export interface FakeLayoutsDeps {
  state: FakeLayoutsState;
  record: (name: string, args: readonly unknown[]) => void;
  signedIn: () => boolean;
  // The CHART_STORAGE limit of the plan, undefined without one.
  planLimit: number | undefined;
  // The layout of the fixture, which is on the chart at first.
  layout: { id: string; name: string };
  // What the layouts of the fixture were saved with.
  symbol: string;
  interval: string;
  options?: FakeLayoutsOptions | undefined;
}

// The members of TradingViewApi that concern layouts.
export interface FakeLayoutsApi {
  layoutName(): string | null;
  layoutId(): string | null;
  getSavedCharts(...args: unknown[]): Promise<Record<string, unknown>[]>;
  hasChartChanges(): { value(): boolean; subscribe(): void; unsubscribe(): void };
  // Optional, so that a test can delete it, as on a build without it.
  shouldBeSaved?: () => boolean;
  loadLayoutFromServerByLayoutId(...args: unknown[]): Promise<void>;
  loadChartFromServer(...args: unknown[]): Promise<void>;
  createNewLayout(...args: unknown[]): Promise<null>;
}

export interface FakeLayouts {
  readonly api: FakeLayoutsApi;
  readonly modules: Record<string, Record<string, unknown>>;
  // Resolves with true once the chart of the layout on the chart has its data.
  whenDataReady(): Promise<true>;
}

const ORIGIN = 'https://www.tradingview.com';

// The error a request of the app rejects with: an Error that carries the status of the answer, as
// the Response the app throws does.
function requestError(staged: FakeLayoutsError): Error {
  return Object.assign(new Error(staged.message), { status: staged.status, code: staged.code });
}

// The ticker of a symbol, as the app names a layout by it.
function tickerOf(symbol: string): string {
  return symbol.slice(symbol.lastIndexOf(':') + 1);
}

// What getSavedCharts answers for a layout. The dates are those of its last change.
function recordOf(layout: FakeSavedLayout): Record<string, unknown> {
  const date = new Date(layout.modified * 1000);
  const day = date.toISOString().slice(0, 10);
  const ticker = tickerOf(layout.symbol);
  return {
    id: layout.id,
    url: layout.url,
    image_url: layout.url,
    name: layout.name,
    symbol: ticker,
    short_name: ticker,
    pro_symbol: layout.symbol,
    short_symbol: ticker,
    resolution: layout.interval,
    interval: layout.interval,
    expression: layout.symbol,
    created: day,
    modified: day,
    created_time: date.toUTCString(),
    created_timestamp: layout.modified,
    modified_iso: layout.modified,
    favorite: false,
    ...(layout.overLimit ? { over_limit: true } : {}),
  };
}

export function createFakeLayouts(
  fixture: FixtureSavedLayout[] | undefined,
  deps: FakeLayoutsDeps,
): FakeLayouts {
  const options = deps.options ?? {};
  const loadMs = options.loadMs ?? 10;
  const dataMs = options.dataMs ?? 10;
  const { state } = deps;
  state.saved = (fixture ?? []).map((layout) => ({
    id: layout.id,
    url: layout.url,
    name: layout.name,
    modified: layout.modified,
    overLimit: layout.overLimit === true,
    symbol: deps.symbol,
    interval: deps.interval,
  }));
  state.current = {
    id: state.saved.find(({ url }) => url === deps.layout.id)?.id ?? null,
    uid: deps.layout.id,
    name: deps.layout.name,
  };
  state.unsaved = false;
  state.dataReady = true;
  state.loadHangs = false;
  state.errors = {};

  // The server ids and urls of the layouts it creates.
  let nextId = Math.max(9000, ...state.saved.map(({ id }) => id)) + 1;
  let created = 0;
  // The waiters for the data of the chart, and the load the data belongs to.
  let waiters: (() => void)[] = [];
  let generation = 0;

  const later = <T>(act: () => T): Promise<T> => Promise.resolve().then(act);
  const pause = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      // Not ref'd, so a load a test never waits for does not hold the test process.
      setTimeout(resolve, ms).unref();
    });
  const dataArrives = (load: number): void => {
    if (dataMs === Infinity) {
      return;
    }
    setTimeout(() => {
      if (load === generation) {
        state.dataReady = true;
        const ready = waiters;
        waiters = [];
        for (const resolve of ready) {
          resolve();
        }
      }
    }, dataMs).unref();
  };
  const notOpened = (url: unknown): Error => new Error(`Layout "${String(url)}" was not opened`);

  const recordedOnly =
    <T>(name: string, answer: T) =>
    (...args: unknown[]): Promise<T> => {
      deps.record(name, args);
      return Promise.resolve(answer);
    };

  const api: FakeLayoutsApi = {
    layoutName: () => state.current.name,
    layoutId: () => state.current.uid,
    getSavedCharts(...args) {
      deps.record('TradingViewApi.getSavedCharts', args);
      return later(() => {
        const staged = state.errors.getSavedCharts;
        if (staged !== undefined) {
          throw new Error(staged.message);
        }
        const records = state.saved.map(recordOf);
        const [callback] = args;
        if (typeof callback === 'function') {
          (callback as (answer: unknown) => void)(records);
        }
        return records;
      });
    },
    hasChartChanges: () => ({
      value: () => state.unsaved,
      subscribe: () => undefined,
      unsubscribe: () => undefined,
    }),
    shouldBeSaved: () => state.unsaved,
    loadLayoutFromServerByLayoutId(...args) {
      deps.record('TradingViewApi.loadLayoutFromServerByLayoutId', args);
      const [url, openInNewTab, skipConfirm] = args;
      return (async (): Promise<void> => {
        await later(() => undefined);
        const layout = state.saved.find((candidate) => candidate.url === url);
        if (layout === undefined) {
          return;
        }
        if (openInNewTab === true) {
          deps.record('backend.openLayoutLink', [url]);
          return;
        }
        if (layout.overLimit) {
          deps.record('dialog.paywall', ['PAYWALL_SAVED_CHARTS_OVER_LIMIT']);
          throw notOpened(url);
        }
        if (skipConfirm !== true && state.unsaved) {
          deps.record('dialog.unsavedChanges', []);
          throw notOpened(url);
        }
        if (state.loadHangs) {
          await new Promise<never>(() => undefined);
        }
        const staged = state.errors.loadLayout;
        if (staged !== undefined) {
          throw requestError(staged);
        }
        generation += 1;
        const load = generation;
        state.current = { id: layout.id, uid: layout.url, name: layout.name };
        state.unsaved = false;
        state.dataReady = false;
        await pause(loadMs);
        dataArrives(load);
      })();
    },
    loadChartFromServer: recordedOnly('TradingViewApi.loadChartFromServer', undefined),
    createNewLayout: recordedOnly('TradingViewApi.createNewLayout', null),
  };

  const createNewChart = (...args: unknown[]): Promise<string | undefined> => {
    deps.record('createNewChart', args);
    const given = (typeof args[0] === 'object' && args[0] !== null ? args[0] : {}) as {
      name?: unknown;
      symbol?: unknown;
      interval?: unknown;
    };
    return later(() => {
      const staged = state.errors.createNewChart;
      const full = deps.planLimit !== undefined && state.saved.length >= deps.planLimit;
      const code =
        staged?.code ??
        (!deps.signedIn() ? 'login_required' : full ? 'saved_chart_limit_reached' : null);
      if (code === 'login_required' || code === 'saved_chart_limit_reached') {
        deps.record('dialog.paywall', ['PAYWALL_SAVED_CHARTS_LIMIT']);
        return undefined;
      }
      if (staged !== undefined) {
        deps.record('dialog.warning', [staged.message]);
        return undefined;
      }
      created += 1;
      const url = `NEW${String(created).padStart(5, '0')}`;
      state.saved.push({
        id: nextId,
        url,
        name: typeof given.name === 'string' ? given.name : '',
        modified: Math.floor(Date.now() / 1000),
        overLimit: false,
        symbol: typeof given.symbol === 'string' ? given.symbol : 'BATS:AAPL',
        interval: typeof given.interval === 'string' ? given.interval : '1D',
      });
      nextId += 1;
      return `${ORIGIN}/chart/${url}/`;
    });
  };

  const hasPermissionsToCreateNewChart = async (...args: unknown[]): Promise<boolean> => {
    deps.record('hasPermissionsToCreateNewChart', args);
    const limit = deps.planLimit;
    if (!deps.signedIn() || limit === undefined || limit <= 0) {
      return false;
    }
    deps.record('getChartsCount', []);
    await later(() => undefined);
    const staged = state.errors.getChartsCount;
    if (staged !== undefined) {
      if (staged.status === 403) {
        return false;
      }
      throw requestError(staged);
    }
    return limit > state.saved.length;
  };

  const modules: Record<string, Record<string, unknown>> = {
    // Module IDs are arbitrary numbers, as in a production build.
    '66581': {
      ...(options.withoutCreateNewChart === true ? {} : { createNewChart }),
      openNewChart(...args: unknown[]): Promise<void> {
        deps.record('openNewChart', args);
        return Promise.resolve();
      },
    },
  };
  if (options.withoutPermissionCheck !== true) {
    modules['61052'] = { hasPermissionsToCreateNewChart };
  }

  return {
    api,
    modules,
    whenDataReady: () =>
      state.dataReady
        ? Promise.resolve(true)
        : new Promise<true>((resolve) => {
            waiters.push(() => {
              resolve(true);
            });
          }),
  };
}
