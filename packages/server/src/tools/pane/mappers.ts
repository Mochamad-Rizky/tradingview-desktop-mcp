import { PlanLimitError, TvMcpError } from '../../core/errors.js';

// The pure parts of the pane tools: the layout codes of TradingView with how many charts each
// shows, the chart limit of the plan as TradingView computes it, and the errors and warnings.

// The layout codes of TradingView with the count of charts each shows (reverse-engineering notes of
// Plan 3, section 2.1, read through the table of layouts of the app). Codes that look like numbers
// (4, 6, 8) come first among the keys of the object.
export const PANE_LAYOUTS = {
  s: 1,
  '2h': 2,
  '2v': 2,
  '3h': 3,
  '3v': 3,
  '3s': 3,
  '3r': 3,
  '2-1': 3,
  '1-2': 3,
  '4': 4,
  '4v': 4,
  '4h': 4,
  '4s': 4,
  '4s-l': 4,
  '1-3': 4,
  '3-1': 4,
  '2-2-l': 4,
  '2-2-r': 4,
  '2-2': 4,
  '1-4': 5,
  '5h': 5,
  '5v': 5,
  '5s': 5,
  '5s-l': 5,
  '2-3': 5,
  '3-2': 5,
  '4-1': 5,
  '2-3-l': 5,
  '2-3-r': 5,
  '6': 6,
  '6h': 6,
  '6v': 6,
  '6c': 6,
  '2-4': 6,
  '4-2': 6,
  '4-3': 7,
  '7h': 7,
  '7s': 7,
  '8': 8,
  '8c': 8,
  '8h': 8,
  '8v': 8,
  '9s': 9,
  '5-4': 9,
  '9h': 9,
  '9v': 9,
  '10c5': 10,
  '10h': 10,
  '10v': 10,
  '12c6': 12,
  '12c4': 12,
  '12h': 12,
  '14c7': 14,
  '16c8': 16,
  '16c4': 16,
} as const;

export type PaneLayout = keyof typeof PANE_LAYOUTS;

export const PANE_LAYOUT_CODES = Object.keys(PANE_LAYOUTS) as [PaneLayout, ...PaneLayout[]];

// The codes by how many charts they show, fewest first: "1 chart: s; 2 charts: 2h, 2v; …".
export function describeLayouts(): string {
  const byCount = new Map<number, string[]>();
  for (const [code, count] of Object.entries(PANE_LAYOUTS)) {
    byCount.set(count, [...(byCount.get(count) ?? []), code]);
  }
  return [...byCount.entries()]
    .sort(([one], [other]) => one - other)
    .map(([count, codes]) => `${String(count)} chart${count === 1 ? '' : 's'}: ${codes.join(', ')}`)
    .join('; ');
}

// How many charts the plan allows in a layout, the way TradingView computes it before it opens its
// paywall (_planChartsLimit of the collection of the charts): enabled(MULTIPLE_CHARTS) ?
// max(getConfig(MULTIPLE_CHARTS)?.limit ?? 1, 1) : 1. A plan without the feature allows one chart,
// and so does one that configures it without a limit. limit is null when the plan sets none.
export function planChartsLimitOf(enabled: boolean, limit: number | null): number {
  return enabled ? Math.max(limit ?? 1, 1) : 1;
}

// "chart 1", "charts 1 and 2", "charts 1, 2 and 3".
export function chartList(indexes: readonly number[]): string {
  const names = indexes.map(String);
  const last = names.pop();
  if (last === undefined) {
    return 'no chart';
  }
  return names.length === 0 ? `chart ${last}` : `charts ${names.join(', ')} and ${last}`;
}

// The error of a layout with more charts than the plan allows: TradingView would open its paywall
// instead of showing it.
export function multipleChartsError(layout: string, count: number, limit: number): PlanLimitError {
  return new PlanLimitError(
    'MULTIPLE_CHARTS',
    limit,
    `The layout ${layout} has ${String(count)} charts, and the plan allows ${String(limit)} ` +
      `chart${limit === 1 ? '' : 's'} in a layout (plan limit MULTIPLE_CHARTS), so TradingView ` +
      'would offer an upgrade instead; nothing was changed',
    limit === 1
      ? 'The plan allows a single chart (layout s) only.'
      : `Choose a layout of at most ${String(limit)} charts: the layout input of pane_set_layout ` +
          'says how many charts each layout has.',
  );
}

// The error of a layout with fewer charts than the layout shows now (current; null when TradingView
// does not tell), without confirm. TradingView keeps the charts a smaller layout hides only until
// the layout is saved: it saves the charts the layout shows and leaves the others out
// (_getStateForChartImpl answers nothing for a hidden chart), so its next save, which autosave
// makes by itself, drops them.
export function fewerChartsError(
  layout: string,
  count: number,
  current: number | null,
): TvMcpError {
  const shows = `The layout ${layout} shows ${String(count)} chart${count === 1 ? '' : 's'}`;
  const saves =
    'TradingView saves only the charts a layout shows, so its next save, which autosave can make ' +
    'at any time,';
  const dropped = Array.from(
    { length: Math.max((current ?? 0) - count, 0) },
    (_, at) => count + at,
  );
  const message =
    current === null
      ? `${shows}, and TradingView does not tell how many the layout shows now: ${saves} would ` +
        `drop any chart beyond chart ${String(count - 1)} with its symbol, indicators and drawings`
      : `${shows}, fewer than the ${String(current)} the layout shows now: ${saves} drops ` +
        `${chartList(dropped)} with ${dropped.length === 1 ? 'its symbol' : 'their symbols'}, ` +
        'indicators and drawings';
  return new TvMcpError('CONFIRMATION_REQUIRED', message, {
    hint:
      'Nothing was changed. Call pane_set_layout again with confirm: true if the user wants ' +
      'those charts dropped' +
      (current === null ? '.' : `, or choose a layout of at least ${String(current)} charts.`),
    details: { layout, chartsCount: count, currentChartsCount: current },
  });
}

// The error of a code the table of layouts of TradingView does not have: setLayout would show a
// single chart instead, without a word.
export function unknownLayoutError(layout: string): TvMcpError {
  return new TvMcpError(
    'NOT_AVAILABLE',
    `This TradingView build does not know the layout ${layout}, and would show a single chart ` +
      'instead, so nothing was changed',
    { hint: 'Choose another layout; pane_list reports the one shown now.', details: { layout } },
  );
}

// The error of a layout whose count of charts the table of TradingView does not give.
export function uncountedLayoutError(layout: string): TvMcpError {
  return new TvMcpError(
    'NOT_AVAILABLE',
    `TradingView does not say how many charts the layout ${layout} has, so the plan limit cannot ` +
      'be checked, and nothing was changed',
    {
      hint: 'Choose another layout, or change the layout in TradingView itself.',
      details: { layout },
    },
  );
}

// The error of a layout whose type or count of charts cannot be read.
export function unreadableLayoutError(): TvMcpError {
  return new TvMcpError(
    'NOT_AVAILABLE',
    'The layout did not report its type or how many charts it shows, so nothing was changed',
    { hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.' },
  );
}

// The error of a layout TradingView did not show within the wait, with what it showed last.
export function layoutNotShownError(
  layout: string,
  count: number,
  waitMs: number,
  shown: { layout: string | null; chartsCount: number | null },
): TvMcpError {
  return new TvMcpError(
    'TIMEOUT',
    `TradingView did not show the layout ${layout} with ${String(count)} charts within ` +
      `${String(waitMs)} ms`,
    {
      hint:
        'TradingView may still be changing the layout, or may have kept another one: pane_list ' +
        'shows the layout now.',
      details: {
        layout,
        chartsCount: count,
        shownLayout: shown.layout,
        shownChartsCount: shown.chartsCount,
        waitMs,
      },
    },
  );
}

// The error of a chart TradingView did not make the active one; active is the one that is, null
// when TradingView does not tell.
export function notFocusedError(chartIndex: number, active: number | null): TvMcpError {
  return new TvMcpError(
    'NOT_AVAILABLE',
    `TradingView did not make chart ${String(chartIndex)} the active chart` +
      (active === null ? '' : `; chart ${String(active)} is`),
    {
      hint:
        'The chart may still be loading, or a dialog may hold the focus. pane_list shows which ' +
        'chart is active.',
      details: { chartIndex, activeChartIndex: active },
    },
  );
}

export function chartsNotReadyWarning(indexes: readonly number[], waitedMs: number): string {
  return (
    `The data of ${chartList(indexes)} did not load within ${String(waitedMs)} ms; it may still ` +
    'be loading. pane_list and chart_get_state show what each chart shows.'
  );
}

export function unreportedPanesWarning(index: number): string {
  return `Chart ${String(index)} did not report its panes, so its panes are null.`;
}

export function unreportedStudiesWarning(index: number): string {
  return (
    `Chart ${String(index)} did not report which studies are in its panes, so their studyIds ` +
    'are null.'
  );
}

// A chart whose symbol changed: from what to what, from null when the chart did not report it
// before.
export interface SymbolChangeOfChart {
  index: number;
  from: string | null;
  to: string;
}

// The charts other than `target` whose symbol changed between the two reads, by index, among the
// charts both reads list. A chart that does not report its symbol afterwards says nothing.
export function symbolChanges(
  before: readonly (string | null)[],
  after: readonly (string | null)[],
  target: number,
): SymbolChangeOfChart[] {
  const changes: SymbolChangeOfChart[] = [];
  for (let index = 0; index < Math.min(before.length, after.length); index += 1) {
    const from = before[index] ?? null;
    const to = after[index] ?? null;
    if (index !== target && to !== null && to !== from) {
      changes.push({ index, from, to });
    }
  }
  return changes;
}

// The warning for the other charts a layout that syncs symbols changed along with the one asked for.
export function syncedSymbolsWarning(changes: readonly SymbolChangeOfChart[]): string {
  const symbol = (value: string | null): string => value ?? 'a symbol it did not report';
  const [only] = changes;
  const what =
    changes.length === 1 && only !== undefined
      ? `the symbol of chart ${String(only.index)} too, from ${symbol(only.from)} to ${only.to}`
      : `the symbols of ${chartList(changes.map(({ index }) => index))} too (` +
        changes
          .map(({ index, from, to }) => `chart ${String(index)} from ${symbol(from)} to ${to}`)
          .join(', ') +
        ')';
  return (
    `The layout changed ${what}: it syncs the symbol of its charts. pane_list shows what each ` +
    'chart shows.'
  );
}
