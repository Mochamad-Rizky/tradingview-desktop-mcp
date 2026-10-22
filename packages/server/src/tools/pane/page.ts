import type { PageErrorSentinel } from '../../core/tv/page-bridge.js';
import type { PageLib } from '../../core/tv/page-lib.js';
import type {
  ChartWidgetApiLike,
  LayoutTableLike,
  PaneApiLike,
  TradingViewApiLike,
  TvWindow,
} from '../../core/tv/tv-window.js';

// The page functions of the pane tools (reverse-engineering notes of Plan 3, section 2). The page
// bridge sends the source text of each one into the page, so each uses nothing of this file, only
// its parameters and the globals of the page, and whatever it shares with another is written out in
// each. Types are erased, so the type imports above are fine.
//
// Members of the app are read defensively: another web build can drop or reshape any of them, and a
// read that throws counts as no answer. setLayoutViaApi changes the layout only with the undo step
// of the app (withUndo), after the checks of the caller; it never opens anything itself, and the
// paywall TradingView would open for a layout beyond the plan is ruled out before it is called.
// Only readLayoutCount takes the page library, so that the caller can poll the others without
// adding a chunk to the chunk list of the app at every look.

// A pane as pane_list reports it: its index, its height in CSS pixels, the ids of the studies in it
// and whether the main series is in it; null where the pane does not tell. Type aliases, not
// interfaces: they come back from the page as JSON, which a type must satisfy JsonValue for.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type PaneRow = {
  index: number;
  height: number | null;
  studyIds: string[] | null;
  hasMainSeries: boolean | null;
};

// A chart of the layout as pane_list reports it; panes is null when the chart does not report them.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type ChartRow = {
  index: number;
  symbol: string | null;
  resolution: string | null;
  active: boolean;
  panes: PaneRow[] | null;
};

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type PaneListing = { layout: string | null; charts: ChartRow[] };

// The layout on the chart: its type (a code such as 2h), how many charts it shows and the active
// one, each null when the app does not answer it.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type PaneLayoutState = {
  layout: string | null;
  chartsCount: number | null;
  activeChartIndex: number | null;
};

// What the table of layouts of the app says of a code: whether the table was found, whether it has
// the code, and how many charts the layout shows (null when it does not say).
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type LayoutCount = { found: boolean; known: boolean; count: number | null };

// What setLayoutViaApi did: nothing because the layout is shown already (same), nothing because the
// layout has fewer charts than the layout shows, or TradingView does not tell, and confirm was not
// given (fewer), or it asked for the layout (set). chartsCount is how many charts the layout showed.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type LayoutChange = { outcome: 'same' | 'fewer' | 'set'; chartsCount: number | null };

// What focusChart did: whether the chart was the active one already, and which chart is active
// afterwards (null when the app does not tell).
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type ChartFocus = { wasActive: boolean; activeChartIndex: number | null };

// Each chart of the layout as a ChartRow, with the type of the layout (null unless a text that is
// not empty, as readPaneLayout reads it). A pane reports its index (paneIndex(), or its place when
// that is no whole number), its height (getHeight()), whether it holds the main series, and the ids
// of the studies in it: what getAllEntities() lists that the chart also lists as a study
// (getAllStudies()), since getAllEntities() lists the main series and the drawings of the pane as
// well. A chart that cannot be reached comes back with nulls. It changes nothing.
// CAPABILITY_UNAVAILABLE on a page without the charts of the layout, and NOT_AVAILABLE when the
// layout does not report how many charts it has: a whole number from 1, and no more than 64, which
// no layout of TradingView comes near (16 at most), so that a wild answer is not walked.
export function readPanes(win: TvWindow): PaneListing | PageErrorSentinel {
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  if (typeof api?.chartsCount !== 'function' || typeof api.chart !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no chart API to read the charts of the layout from',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  // Checked above: the members called without a guard are there.
  const layout = api as TradingViewApiLike;
  const attempt = (read: () => unknown): unknown => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  const count = attempt(() => layout.chartsCount());
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 64) {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: 'The layout did not report how many charts it has',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  const active = attempt(() => layout.activeChartIndex());
  const charts: ChartRow[] = [];
  for (let index = 0; index < count; index += 1) {
    const chart = attempt(() => layout.chart(index)) as
      Partial<ChartWidgetApiLike> | null | undefined;
    const studies = attempt(() => chart?.getAllStudies?.());
    const studyIds = Array.isArray(studies)
      ? new Set(
          studies.flatMap((study: unknown) => {
            const id = attempt(() => (study as { id?: unknown } | null)?.id);
            return typeof id === 'string' ? [id] : [];
          }),
        )
      : null;
    const panes = attempt(() => chart?.getPanes?.());
    charts.push({
      index,
      symbol: text(attempt(() => chart?.symbol?.())),
      resolution: text(attempt(() => chart?.resolution?.())),
      active: index === active,
      panes: Array.isArray(panes)
        ? panes.map((pane: unknown, place: number): PaneRow => {
            const found = pane as Partial<PaneApiLike> | null | undefined;
            const at = attempt(() => found?.paneIndex?.());
            const height = attempt(() => found?.getHeight?.());
            const main = attempt(() => found?.hasMainSeries?.());
            const entities = attempt(() => found?.getAllEntities?.());
            return {
              index: typeof at === 'number' && Number.isInteger(at) && at >= 0 ? at : place,
              height: typeof height === 'number' && Number.isFinite(height) ? height : null,
              studyIds:
                studyIds !== null && Array.isArray(entities)
                  ? entities.flatMap((entity: unknown) => {
                      const id = attempt(() => (entity as { id?: unknown } | null)?.id);
                      return typeof id === 'string' && studyIds.has(id) ? [id] : [];
                    })
                  : null,
              hasMainSeries: typeof main === 'boolean' ? main : null,
            };
          })
        : null,
    });
  }
  const type = attempt(() => layout.layout());
  return { layout: typeof type === 'string' && type !== '' ? type : null, charts };
}

// The layout on the chart as a PaneLayoutState: layout() (a text that is not empty), chartsCount()
// (a whole number from 1) and activeChartIndex() (a whole number from 0), each null otherwise. It
// changes nothing. CAPABILITY_UNAVAILABLE on a page without layout() or chartsCount().
export function readPaneLayout(win: TvWindow): PaneLayoutState | PageErrorSentinel {
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  if (typeof api?.layout !== 'function' || typeof api.chartsCount !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no layout API of TradingView to read the layout from',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  const layout = api as TradingViewApiLike;
  const attempt = (read: () => unknown): unknown => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const whole = (value: unknown, least: number): number | null =>
    typeof value === 'number' && Number.isInteger(value) && value >= least ? value : null;
  const type = attempt(() => layout.layout());
  return {
    layout: typeof type === 'string' && type !== '' ? type : null,
    chartsCount: whole(
      attempt(() => layout.chartsCount()),
      1,
    ),
    activeChartIndex: whole(
      attempt(() => layout.activeChartIndex()),
      0,
    ),
  };
}

// How many charts the layout `code` shows, as the table of layouts of the app says: the export
// layouts of the module that also exports isMultipleLayout, isSupportedLayout and
// tryGuessingTheMostSuitableLayout. A code is known when the table has it as an own member; its
// count is a whole number from 1 or null. Without the table nothing is found. It changes nothing.
export function readLayoutCount(_win: TvWindow, lib: PageLib, code: string): LayoutCount {
  const found = lib.findModuleWith([
    'layouts',
    'isMultipleLayout',
    'isSupportedLayout',
    'tryGuessingTheMostSuitableLayout',
  ]);
  let table: unknown;
  try {
    table = found?.layouts;
  } catch {
    table = undefined;
  }
  if (typeof table !== 'object' || table === null) {
    return { found: false, known: false, count: null };
  }
  if (!Object.hasOwn(table, code)) {
    return { found: true, known: false, count: null };
  }
  let count: unknown;
  try {
    count = (table as LayoutTableLike)[code]?.count;
  } catch {
    count = undefined;
  }
  return {
    found: true,
    known: true,
    count: typeof count === 'number' && Number.isInteger(count) && count >= 1 ? count : null,
  };
}

// Asks TradingView for the layout `code`, which shows `count` charts, with setLayout(code, {
// withUndo: true }): a step the user can undo, which also leaves the layout shown already alone. It
// returns at once: the change comes a moment later, which the caller waits for with readPaneLayout.
// The layout is read again right before, in the same turn as the call, since the user may change it
// while the caller checks the plan: the layout shown already is left alone (same), and a layout of
// fewer charts than the layout shows, or a count TradingView does not tell, is left without confirm
// (fewer). A setLayout that throws fails the call, and one that answers with a promise that fails
// leaves no rejection unhandled. CAPABILITY_UNAVAILABLE, before anything is done, on a page without
// setLayout, layout() or chartsCount().
export function setLayoutViaApi(
  win: TvWindow,
  code: string,
  count: number,
  confirm: boolean,
): LayoutChange | PageErrorSentinel {
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  if (
    typeof api?.setLayout !== 'function' ||
    typeof api.layout !== 'function' ||
    typeof api.chartsCount !== 'function'
  ) {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no layout API of TradingView to change the layout with',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  const layout = api as TradingViewApiLike;
  // setLayout answers nothing on the observed build; another build might answer a promise.
  const change = api as { setLayout(type: string, options: { withUndo: boolean }): unknown };
  const attempt = (read: () => unknown): unknown => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const shown = attempt(() => layout.layout());
  const live = attempt(() => layout.chartsCount());
  const chartsCount = typeof live === 'number' && Number.isInteger(live) && live >= 1 ? live : null;
  if (shown === code) {
    return { outcome: 'same', chartsCount };
  }
  if (!confirm && (chartsCount === null || count < chartsCount)) {
    return { outcome: 'fewer', chartsCount };
  }
  const result = change.setLayout(code, { withUndo: true });
  Promise.resolve(result).catch(() => undefined);
  return { outcome: 'set', chartsCount };
}

// Which of the first `count` charts of the layout do not have their data within waitMs, as
// dataReady() of each tells it (the form without an argument, a promise that resolves with true
// once the main series has data). A chart that cannot be reached, a dataReady that is missing,
// throws, rejects or answers anything but true, and a promise that does not settle in time (it
// never does for a symbol TradingView cannot resolve) all count as not ready. It changes nothing.
export function awaitChartsData(
  win: TvWindow,
  count: number,
  waitMs: number,
): Promise<{ notReady: number[] }> {
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  const ready: boolean[] = [];
  const waits: Promise<void>[] = [];
  for (let index = 0; index < count; index += 1) {
    ready.push(false);
    let waiting: Promise<unknown>;
    try {
      const chart = api?.chart?.(index) as Partial<ChartWidgetApiLike> | null | undefined;
      waiting =
        typeof chart?.dataReady === 'function'
          ? Promise.resolve((chart as { dataReady(): unknown }).dataReady())
          : Promise.resolve(false);
    } catch {
      waiting = Promise.resolve(false);
    }
    waits.push(
      waiting.then(
        (answer: unknown) => {
          ready[index] = answer === true;
        },
        () => undefined,
      ),
    );
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, waitMs);
  });
  return Promise.race([Promise.all(waits).then(() => undefined), late]).then(() => {
    clearTimeout(timer);
    return { notReady: ready.flatMap((done, index) => (done ? [] : [index])) };
  });
}

// Makes chart `chartIndex` the active one with setActiveChart, unless it is the active one already,
// and answers which chart is active then. The app ignores an index outside the layout and, while the
// active chart is maximized, maximizes the chart instead, so the caller checks the answer.
// CAPABILITY_UNAVAILABLE, before anything is done, on a page without setActiveChart or
// activeChartIndex.
export function focusChart(win: TvWindow, chartIndex: number): ChartFocus | PageErrorSentinel {
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  if (typeof api?.setActiveChart !== 'function' || typeof api.activeChartIndex !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no chart API to make a chart the active one with',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  const layout = api as TradingViewApiLike;
  const activeIndex = (): number | null => {
    try {
      const index: unknown = layout.activeChartIndex();
      return typeof index === 'number' && Number.isInteger(index) ? index : null;
    } catch {
      return null;
    }
  };
  if (activeIndex() === chartIndex) {
    return { wasActive: true, activeChartIndex: chartIndex };
  }
  layout.setActiveChart(chartIndex);
  return { wasActive: false, activeChartIndex: activeIndex() };
}

// The symbol of each chart of the layout, in order, null for one that does not tell; none when the
// layout does not report how many charts it has (as readPanes reads the count). It changes nothing
// and never fails.
export function readChartSymbols(win: TvWindow): { symbols: (string | null)[] } {
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  let count: unknown;
  try {
    count = api?.chartsCount?.();
  } catch {
    count = undefined;
  }
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 64) {
    return { symbols: [] };
  }
  const symbols: (string | null)[] = [];
  for (let index = 0; index < count; index += 1) {
    let symbol: unknown;
    try {
      symbol = api?.chart?.(index).symbol();
    } catch {
      symbol = undefined;
    }
    symbols.push(typeof symbol === 'string' ? symbol : null);
  }
  return { symbols };
}
