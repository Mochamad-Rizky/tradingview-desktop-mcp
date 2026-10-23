import { callTool } from '../helpers/mcp-client.js';
import {
  callFailure,
  callOk,
  e2eEnabled,
  observe,
  optedIn,
  planLimitSkipReason,
  sameJson,
  startE2eServer,
  type E2eServer,
  type ToolFailure,
} from './setup.js';

// The layout and pane tools against the real TradingView Desktop. Saved layouts are the user's, in
// the account, and the layout of the chart tab is theirs too: the suite reads them, and asks the
// tools that change them only for what the plan refuses, so that nothing changes. layout_new runs on
// a plan whose saved layouts fill CHART_STORAGE, where it must refuse; on a plan with room it would
// create a layout no tool deletes, which runs only with TV_E2E_ALLOW_LAYOUTS=1. pane_set_layout asks
// for a layout of two charts only on a plan of one chart, where it must refuse. The names and ids of
// the layouts and the symbols of the charts are compared without being printed.

const TEST_LAYOUT_NAME = 'tradingview-mcp E2E layout';

interface LayoutListing {
  current: { id: string | null; name: string | null };
  layouts: {
    id: string;
    name: string;
    modified: number | null;
    modifiedIso: string | null;
    // Present, and true, only on a layout beyond the CHART_STORAGE limit of the plan.
    overLimit?: true;
  }[];
}

interface PaneListing {
  layout: string | null;
  charts: {
    index: number;
    symbol: string | null;
    resolution: string | null;
    active: boolean;
    panes:
      { index: number; height: number; studyIds: string[] | null; hasMainSeries: boolean }[] | null;
  }[];
}

// What a layout tool must leave as it is: the current layout and the saved ones by id, name and lock.
// The time a layout was last saved is left out, since the autosave of TradingView may save the
// current layout at any moment.
function layoutsOf(listing: LayoutListing): unknown {
  return {
    current: listing.current,
    layouts: listing.layouts.map(({ id, name, overLimit }) => ({ id, name, overLimit })),
  };
}

describe.skipIf(!e2eEnabled())('the layout and pane tools against TradingView Desktop', () => {
  let e2e: E2eServer | undefined;

  beforeAll(async () => {
    e2e = await startE2eServer();
  });

  afterAll(async () => {
    await e2e?.close();
  });

  function server(): E2eServer {
    if (e2e === undefined) {
      throw new Error('The server did not start');
    }
    return e2e;
  }

  async function listLayouts(): Promise<LayoutListing> {
    return (await callOk<LayoutListing>(server().client, 'layout_list')).data;
  }

  test('lists the saved layouts', async () => {
    const { client } = server();
    const listing = await listLayouts();
    for (const layout of listing.layouts) {
      expect(typeof layout.id === 'string' && layout.id !== '').toBe(true);
      expect(typeof layout.name).toBe('string');
      expect(layout.overLimit === undefined || layout.overLimit).toBe(true);
      if (layout.modified !== null) {
        expect(Number.isInteger(layout.modified) && layout.modified < 1e11).toBe(true);
        expect(layout.modifiedIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      }
    }
    const { data: state } = await callOk<{ layout: { id: string | null; name: string | null } }>(
      client,
      'chart_get_state',
    );
    expect(
      listing.current.id === state.layout.id,
      'layout_list and chart_get_state name the same layout',
    ).toBe(true);
    observe('saved layouts', {
      saved: listing.layouts.length,
      currentIdPresent: listing.current.id !== null,
      currentNamePresent: listing.current.name !== null,
      currentIsListed: listing.layouts.some(({ id }) => id === listing.current.id),
      overLimit: listing.layouts.filter(({ overLimit }) => overLimit === true).length,
      modifiedReported: listing.layouts.filter(({ modified }) => modified !== null).length,
    });
  });

  test('layout_new on a full plan refuses and creates nothing', async (context) => {
    const { client } = server();
    const before = await listLayouts();
    const full = await planLimitSkipReason(client, 'CHART_STORAGE', before.layouts.length, 1);
    if (full === null) {
      return context.skip(
        'The plan has room for another saved layout, so layout_new would create one; this test ' +
          'runs on a full plan only',
      );
    }
    const uiBefore = await callOk<{ dialogs: string[] }>(client, 'app_get_ui_state');

    // Never with confirm: on a full plan the call must refuse whichever check comes first.
    const result = await callTool(client, 'layout_new', { name: TEST_LAYOUT_NAME });

    if (result.isError !== true) {
      throw new Error(
        'layout_new created a layout on a full plan: delete the layout named ' +
          `"${TEST_LAYOUT_NAME}" in TradingView`,
      );
    }
    const { error } = result.structuredContent as { error: ToolFailure };
    expect(['PLAN_LIMIT', 'CONFIRMATION_REQUIRED']).toContain(error.code);
    if (error.code === 'PLAN_LIMIT') {
      expect(error.details?.feature).toBe('CHART_STORAGE');
    }
    const after = await listLayouts();
    expect(
      sameJson(layoutsOf(after), layoutsOf(before)),
      'the saved layouts and the current one are as before',
    ).toBe(true);
    const uiAfter = await callOk<{ dialogs: string[] }>(client, 'app_get_ui_state');
    expect(sameJson(uiAfter.data.dialogs, uiBefore.data.dialogs), 'no dialog opened').toBe(true);
    observe('layout_new on a full plan', {
      code: error.code,
      feature: typeof error.details?.feature === 'string' ? error.details.feature : null,
      limitReported: typeof error.details?.limit === 'number',
      unsavedChangesReported:
        error.code === 'CONFIRMATION_REQUIRED' && typeof error.details?.unsavedChanges === 'boolean'
          ? error.details.unsavedChanges
          : null,
    });
  });

  test('creates a layout and switches back, on a plan with room, when allowed', async (context) => {
    const { client } = server();
    if (!optedIn('TV_E2E_ALLOW_LAYOUTS')) {
      return context.skip(
        'layout_new leaves a saved layout in the account that no tool deletes; set ' +
          'TV_E2E_ALLOW_LAYOUTS=1 to allow it',
      );
    }
    const before = await listLayouts();
    const full = await planLimitSkipReason(client, 'CHART_STORAGE', before.layouts.length, 1);
    if (full !== null) {
      return context.skip(full);
    }
    const original = before.current.id;
    if (original === null) {
      return context.skip(
        'The chart tab shows a layout that was never saved, which the test could not switch back to',
      );
    }
    const { data: state } = await callOk<{ layout: { id: string | null } }>(
      client,
      'chart_get_state',
    );
    expect(state.layout.id === original).toBe(true);
    const result = await callTool(client, 'layout_new', { name: TEST_LAYOUT_NAME });
    if (result.isError === true) {
      const { error } = result.structuredContent as { error: ToolFailure };
      // Unsaved changes of the user's layout are never discarded by the test.
      if (error.code === 'CONFIRMATION_REQUIRED') {
        return context.skip(
          'The layout of the chart tab has unsaved changes, which layout_new would discard; ' +
            'nothing was created',
        );
      }
      throw new Error(`layout_new failed with ${error.code}`);
    }
    try {
      const created = (result.structuredContent as { data: { id: string | null; opened: boolean } })
        .data;
      expect(created.id).not.toBeNull();
      const listing = await listLayouts();
      expect(listing.layouts.length).toBe(before.layouts.length + 1);
      expect(listing.layouts.some(({ id }) => id === created.id)).toBe(true);
      observe('layout_new on a plan with room', { opened: created.opened });
    } finally {
      // The new layout is the test's own, so its unsaved changes may go.
      const back = await callOk<{ id: string; changed: boolean }>(client, 'layout_switch', {
        layoutId: original,
        confirm: true,
      });
      expect(back.data.id === original, 'the chart tab shows the layout of before').toBe(true);
    }
  });

  test('layout_switch refuses a layout the account does not have', async () => {
    const { client } = server();
    const before = await listLayouts();
    const unknown = await callFailure(client, 'layout_switch', {
      layoutId: 'tvmcp-e2e-no-such-layout',
    });
    expect(unknown.code).toBe('INVALID_INPUT');
    expect(sameJson(layoutsOf(await listLayouts()), layoutsOf(before)), 'nothing changed').toBe(
      true,
    );
  });

  test('lists the charts and panes of the layout', async () => {
    const { client } = server();
    const { data, warnings } = await callOk<PaneListing>(client, 'pane_list');
    const { data: state } = await callOk<{
      symbol: string;
      layout: { type: string | null; chartsCount: number | null; activeChartIndex: number | null };
    }>(client, 'chart_get_state');
    expect(data.layout).toBe(state.layout.type);
    expect(data.charts.length).toBe(state.layout.chartsCount);
    expect(data.charts.filter(({ active }) => active).length).toBe(1);
    const active = data.charts.find((chart) => chart.active);
    expect(active?.index).toBe(state.layout.activeChartIndex);
    expect(active?.symbol === state.symbol, 'pane_list names the symbol of the active chart').toBe(
      true,
    );
    const { data: studies } = await callOk<{ studies: { id: string }[] }>(client, 'indicator_list');
    const studyIds = new Set(studies.studies.map(({ id }) => id));
    for (const pane of active?.panes ?? []) {
      expect(pane.height).toBeGreaterThan(0);
      expect((pane.studyIds ?? []).every((id) => studyIds.has(id))).toBe(true);
    }
    expect(active?.panes?.filter(({ hasMainSeries }) => hasMainSeries).length).toBe(1);
    expect(warnings.length === 0, 'pane_list gives no warning').toBe(true);
    observe('charts and panes', {
      layout: data.layout,
      charts: data.charts.length,
      panes: data.charts.map(({ panes }) => panes?.length ?? null),
      studiesInPanes: data.charts.map(
        ({ panes }) => panes?.reduce((sum, pane) => sum + (pane.studyIds?.length ?? 0), 0) ?? null,
      ),
      studiesOnTheChart: studies.studies.length,
      heightsAreIntegers: (active?.panes ?? []).every(({ height }) => Number.isInteger(height)),
    });
  });

  test('pane_focus keeps the active chart and refuses a chart the layout does not have', async () => {
    const { client } = server();
    const { data } = await callOk<PaneListing>(client, 'pane_list');
    const active = data.charts.find((chart) => chart.active);
    if (active === undefined) {
      throw new Error('pane_list reports no active chart');
    }
    const focus = await callOk<{ chartIndex: number; changed: boolean }>(client, 'pane_focus', {
      chartIndex: active.index,
    });
    expect(focus.data).toEqual({ chartIndex: active.index, changed: false });
    const outside = await callFailure(client, 'pane_focus', { chartIndex: data.charts.length });
    expect(outside.code).toBe('INVALID_INPUT');
    const symbolOutside = await callFailure(client, 'pane_set_symbol', {
      chartIndex: data.charts.length,
      symbol: 'NASDAQ:AAPL',
    });
    expect(symbolOutside.code).toBe('INVALID_INPUT');
    const after = await callOk<PaneListing>(client, 'pane_list');
    expect(sameJson(after.data, data), 'the charts are as before').toBe(true);
  });

  test('pane_set_layout to two charts on a one-chart plan refuses with PLAN_LIMIT', async (context) => {
    const { client } = server();
    const { data: limits } = await callOk<{ limits: Record<string, number | null> }>(
      client,
      'app_get_plan_limits',
    );
    const limit = limits.limits.MULTIPLE_CHARTS;
    if (typeof limit !== 'number' || limit >= 2) {
      return context.skip(
        'The plan allows layouts of several charts (or does not say), so pane_set_layout would ' +
          "change the user's layout; this test runs on a one-chart plan only",
      );
    }
    const before = await callOk<PaneListing>(client, 'pane_list');
    const uiBefore = await callOk<{ dialogs: string[] }>(client, 'app_get_ui_state');

    const result = await callTool(client, 'pane_set_layout', { layout: '2h' });

    if (result.isError !== true) {
      throw new Error(
        'pane_set_layout changed the layout on a one-chart plan: set the layout back to one ' +
          'chart in TradingView',
      );
    }
    const { error } = result.structuredContent as { error: ToolFailure };
    expect(error.code).toBe('PLAN_LIMIT');
    expect(error.details?.feature).toBe('MULTIPLE_CHARTS');
    const after = await callOk<PaneListing>(client, 'pane_list');
    expect(sameJson(after.data, before.data), 'the layout is as before').toBe(true);
    const uiAfter = await callOk<{ dialogs: string[] }>(client, 'app_get_ui_state');
    expect(sameJson(uiAfter.data.dialogs, uiBefore.data.dialogs), 'no dialog opened').toBe(true);
    observe('pane_set_layout on a one-chart plan', {
      code: error.code,
      feature: typeof error.details?.feature === 'string' ? error.details.feature : null,
      limit: typeof error.details?.limit === 'number' ? error.details.limit : null,
    });
  });
});
