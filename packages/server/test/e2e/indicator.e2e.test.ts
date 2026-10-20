import type { PageLib } from '../../src/core/tv/page-lib.js';
import type { TvWindow } from '../../src/core/tv/tv-window.js';
import { readStudyInsertContext } from '../../src/tools/indicator/page.js';
import { callTool } from '../helpers/mcp-client.js';
import {
  callOk,
  changeThenRestore,
  e2eEnabled,
  expectChartRestored,
  observe,
  planLimitSkipReason,
  prepareChartChange,
  startE2eServer,
  type E2eServer,
  type ToolFailure,
} from './setup.js';

// The indicator tools against the real TradingView Desktop. The readers run on the studies the
// user has on the chart and change nothing. Adding is tested within the indicator limit of the
// plan: on a full chart indicator_add must refuse with PLAN_LIMIT and change nothing, no dialog
// included; with a free slot a test adds RSI and removes it again, and touches only that study. No
// test ever changes the inputs or the visibility of a study it did not add, or removes one.

interface StudyInput {
  id: string;
  name: string;
  type: string;
  value: string | number | boolean | null;
  options: string[] | null;
}

interface Study {
  id: string;
  name: string;
  title: string;
  visible: boolean;
  isPine: boolean;
  isStrategy: boolean;
  inputs: StudyInput[];
}

interface SearchResult {
  name: string;
  shortName: string;
  id: string;
  kind: 'pine' | 'builtin';
  isStrategy: boolean;
}

interface Values {
  id: string;
  plots: string[];
  rows: { time: number; timeIso: string; values: Record<string, number | null> }[];
}

// What the standard Pine scripts of the app look like, from the export the indicator search reads
// (requestBuiltinScripts, the request the indicator dialog sends): how many, the keys of an item
// with the types of their values, how many carry a scriptTitle and how many a title other than
// their name, the keys of extra and its kinds, and the item of Relative Strength Index, a script
// of TradingView. Nothing of the user is in it.
function standardScriptShapes(
  _win: TvWindow,
  lib: PageLib,
): Promise<{
  items: number;
  keys: string[];
  withTitle: number;
  titleDiffers: number;
  extraKeys: string[];
  kinds: string[];
  rsi: { scriptName: string; shortDescription: string | null; kind: string | null }[];
}> {
  const request = lib.findExport('requestBuiltinScripts');
  return Promise.resolve()
    .then(() => (typeof request === 'function' ? (request as () => unknown)() : []))
    .then((list: unknown) => {
      const items = (Array.isArray(list) ? list : []) as Record<string, unknown>[];
      const types = new Map<string, Set<string>>();
      const extraKeys = new Set<string>();
      const kinds = new Set<string>();
      for (const item of items) {
        for (const [key, value] of Object.entries(item)) {
          const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
          types.set(key, (types.get(key) ?? new Set()).add(type));
        }
        const extra = item.extra;
        if (typeof extra === 'object' && extra !== null) {
          for (const key of Object.keys(extra)) {
            extraKeys.add(key);
          }
          const kind = (extra as { kind?: unknown }).kind;
          if (typeof kind === 'string') {
            kinds.add(kind);
          }
        }
      }
      const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);
      const extraOf = (item: Record<string, unknown>): Record<string, unknown> =>
        typeof item.extra === 'object' && item.extra !== null
          ? (item.extra as Record<string, unknown>)
          : {};
      // The items about RSI, by their names, which are those of TradingView.
      const rsi = items.filter((item) =>
        /\bRSI\b|relative strength/i.test(
          `${textOf(item.scriptName) ?? ''} ${textOf(extraOf(item).shortDescription) ?? ''}`,
        ),
      );
      return {
        items: items.length,
        keys: [...types].map(([key, set]) => `${key}: ${[...set].join('|')}`).sort(),
        withTitle: items.filter((item) => typeof item.scriptTitle === 'string').length,
        titleDiffers: items.filter(
          (item) => typeof item.scriptTitle === 'string' && item.scriptTitle !== item.scriptName,
        ).length,
        extraKeys: [...extraKeys].sort(),
        kinds: [...kinds].sort(),
        rsi: rsi.slice(0, 8).map((item) => ({
          scriptName: textOf(item.scriptName) ?? '',
          shortDescription: textOf(extraOf(item).shortDescription),
          kind: textOf(extraOf(item).kind),
        })),
      };
    });
}

describe.skipIf(!e2eEnabled())('the indicator tools against TradingView Desktop', () => {
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

  async function listStudies(): Promise<Study[]> {
    return (await callOk<{ studies: Study[] }>(server().client, 'indicator_list')).data.studies;
  }

  // What the check of the chart model says, read only, for a Pine script: the check indicator_add
  // and pine_compile make before they add one.
  async function roomCheck() {
    const page = await server().ctx.connection.chartPage();
    return (await page.bridge.evaluateWithLib(readStudyInsertContext, [null, ''])).check;
  }

  test("lists the chart's indicators", async () => {
    const { client } = server();

    const { data, warnings } = await callOk<{ studies: Study[] }>(client, 'indicator_list');

    const { data: state } = await callOk<{ studies: { id: string }[] | null }>(
      client,
      'chart_get_state',
    );
    expect(data.studies.map(({ id }) => id)).toEqual(state.studies?.map(({ id }) => id));
    for (const study of data.studies) {
      expect(typeof study.name === 'string' && typeof study.title === 'string').toBe(true);
      expect(typeof study.visible).toBe('boolean');
      expect(typeof study.isPine).toBe('boolean');
      expect(typeof study.isStrategy).toBe('boolean');
      for (const input of study.inputs) {
        expect(typeof input.id === 'string' && typeof input.name === 'string').toBe(true);
        expect(
          ['string', 'number', 'boolean'].includes(typeof input.value) || input.value === null,
        ).toBe(true);
      }
      // The internal inputs of a Pine script (its text, id and version) are left out.
      expect(study.inputs.some(({ id }) => ['text', 'pineId', 'pineVersion'].includes(id))).toBe(
        false,
      );
    }
    expect(warnings).toEqual([]);
    observe('indicators on the chart', {
      studies: data.studies.length,
      pine: data.studies.filter(({ isPine }) => isPine).length,
      strategies: data.studies.filter(({ isStrategy }) => isStrategy).length,
      inputTypes: [
        ...new Set(data.studies.flatMap(({ inputs }) => inputs.map(({ type }) => type))),
      ],
    });
  });

  test('reads the last value of the first indicator', async (context) => {
    const { client } = server();
    const [first] = await listStudies();
    if (first === undefined) {
      return context.skip('The chart has no indicator to read');
    }

    const { data, warnings } = await callOk<Values>(client, 'indicator_get_values', {
      id: first.id,
    });

    expect(data.id).toBe(first.id);
    expect(data.plots.length).toBeGreaterThan(0);
    expect(data.rows).toHaveLength(1);
    expect(warnings).toEqual([]);
    const [row] = data.rows;
    expect(Object.keys(row?.values ?? {})).toEqual(data.plots);
    expect(
      Object.values(row?.values ?? {}).every((value) => value === null || Number.isFinite(value)),
    ).toBe(true);
    // The row is that of the last bar, in the bar times of data_get_ohlcv.
    const { data: bars } = await callOk<{ bars: { time: number }[] }>(client, 'data_get_ohlcv', {
      count: 1,
    });
    expect(row?.time === bars.bars[0]?.time, 'the row is the last bar of the chart').toBe(true);
  });

  test('search finds RSI', async () => {
    const { client, ctx } = server();

    const { data, warnings } = await callOk<{ results: SearchResult[] }>(
      client,
      'indicator_search',
      { query: 'rsi', limit: 50 },
    );

    expect(warnings).toEqual([]);
    const pine = data.results.filter(({ kind }) => kind === 'pine');
    expect(pine.some(({ name, shortName }) => /\bRSI\b/i.test(`${name} ${shortName}`))).toBe(true);
    // Relative Strength Index, found by its short name, which the list of the app gives in extra.
    const rsi = pine.find(({ shortName }) => shortName === 'RSI');

    const page = await ctx.connection.chartPage();
    const shapes = await page.bridge.evaluateWithLib(standardScriptShapes, []);
    observe('indicator search for rsi', {
      results: data.results.length,
      pine: pine.length,
      builtin: data.results.length - pine.length,
      relativeStrengthIndexFound: rsi !== undefined,
      relativeStrengthIndexName: rsi?.name ?? null,
    });
    observe('standard Pine scripts', shapes);
    expect(shapes.items).toBeGreaterThan(0);
    expect(rsi?.name).toMatch(/^relative strength index$/i);
  });

  test('adding an indicator on a full chart returns PLAN_LIMIT and changes nothing', async (context) => {
    const { client } = server();
    const before = await listStudies();
    const full = await planLimitSkipReason(client, 'INDICATORS_ON_CHART', before.length, 1);
    const check = await roomCheck();
    // Only on a chart the plan and the app itself call full: anywhere else indicator_add would add.
    if (full === null) {
      return context.skip(
        'The plan leaves room for another indicator, so adding one would add it; this test runs ' +
          'on a full chart only',
      );
    }
    if (check?.success !== false || check.reason !== 'general') {
      return context.skip(
        `TradingView would take another indicator (its check answers ${JSON.stringify(check)}), so ` +
          'adding one would add it; this test runs on a full chart only',
      );
    }
    const { data: found } = await callOk<{ results: SearchResult[] }>(client, 'indicator_search', {
      query: 'rsi',
      limit: 50,
    });
    const script = found.results.find(({ kind, isStrategy }) => kind === 'pine' && !isStrategy);
    if (script === undefined) {
      return context.skip('The indicator search found no standard Pine script to try');
    }
    const uiBefore = await callOk<{ dialogs: string[] }>(client, 'app_get_ui_state');

    const result = await callTool(client, 'indicator_add', { name: script.id });

    if (result.isError !== true) {
      // TradingView took it after all: the test takes off the study it added, then fails.
      const added = (result.structuredContent as { data?: { id?: unknown } }).data?.id;
      if (typeof added === 'string') {
        await callOk(client, 'indicator_remove', { id: added });
      }
      throw new Error(
        'indicator_add added an indicator to a full chart; the test removed it again',
      );
    }
    const { error } = result.structuredContent as { error: ToolFailure };
    expect(error.code).toBe('PLAN_LIMIT');
    expect(error.details).toMatchObject({
      feature: 'INDICATORS_ON_CHART',
      limit: check.limitValue,
    });
    expect((await listStudies()).map(({ id }) => id)).toEqual(before.map(({ id }) => id));
    const uiAfter = await callOk<{ dialogs: string[] }>(client, 'app_get_ui_state');
    expect(uiAfter.data.dialogs).toEqual(uiBefore.data.dialogs);
    observe('indicator_add on a full chart', {
      code: error.code,
      feature: typeof error.details?.feature === 'string' ? error.details.feature : null,
      limitReported: typeof error.details?.limit === 'number',
      check: {
        success: check.success,
        reason: check.reason,
        limitIsNumber: check.limitValue !== null,
      },
      dialogsBefore: uiBefore.data.dialogs.length,
      dialogsAfter: uiAfter.data.dialogs.length,
    });
  });

  test('adds and removes RSI', async (context) => {
    const e2eServer = server();
    const { client } = e2eServer;
    const before = await listStudies();
    const full = await planLimitSkipReason(client, 'INDICATORS_ON_CHART', before.length, 1);
    if (full !== null) {
      return context.skip(full);
    }
    const check = await roomCheck();
    if (check?.success === false) {
      return context.skip(
        `TradingView would not take another indicator (reason: ${String(check.reason)})`,
      );
    }
    const plan = await prepareChartChange(e2eServer);
    const snapshot = plan.snapshot;
    if (snapshot === undefined) {
      return context.skip(plan.skipReason ?? 'The chart could not be prepared for a change');
    }

    // The study the test added and has not removed yet.
    const added: { id: string | null } = { id: null };
    try {
      await changeThenRestore(client, snapshot, async () => {
        const { data } = await callOk<{ id: string; name: string }>(client, 'indicator_add', {
          name: 'RSI',
        });
        added.id = data.id;
        const study = (await listStudies()).find(({ id }) => id === data.id);
        expect(study?.isPine).toBe(true);
        const values = await callOk<Values>(client, 'indicator_get_values', { id: data.id });
        expect(values.data.plots.length).toBeGreaterThan(0);

        // Its own study only: one integer input one higher, then back, and hidden, then shown.
        const input = study?.inputs.find(({ type }) => type === 'integer');
        if (input !== undefined && typeof input.value === 'number') {
          const changed = await callOk<{ current: StudyInput[] }>(client, 'indicator_set_inputs', {
            id: data.id,
            inputs: { [input.id]: input.value + 1 },
          });
          expect(changed.data.current.find(({ id }) => id === input.id)?.value).toBe(
            input.value + 1,
          );
          await callOk(client, 'indicator_set_inputs', {
            id: data.id,
            inputs: { [input.id]: input.value },
          });
        }
        const hidden = await callOk<{ visible: boolean }>(client, 'indicator_set_visibility', {
          id: data.id,
          visible: false,
        });
        expect(hidden.data.visible).toBe(false);
        await callOk(client, 'indicator_set_visibility', { id: data.id, visible: true });

        // This session added it, so it goes without confirm.
        const removed = await callOk<{ removed: string }>(client, 'indicator_remove', {
          id: data.id,
        });
        expect(removed.data.removed).toBe(data.id);
        added.id = null;
      });
    } finally {
      if (added.id !== null) {
        await callOk(client, 'indicator_remove', { id: added.id });
      }
    }
    expect((await listStudies()).map(({ id }) => id)).toEqual(before.map(({ id }) => id));
    await expectChartRestored(e2eServer, snapshot);
  });
});
