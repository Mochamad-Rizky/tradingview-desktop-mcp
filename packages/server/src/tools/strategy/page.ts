import type { PageErrorSentinel } from '../../core/tv/page-bridge.js';
import type {
  BarsLike,
  ChartModelLike,
  ChartWidgetApiLike,
  CoreModelLike,
  SeriesLike,
  StudyApiLike,
  StudyCoreLike,
  TradingViewApiLike,
  TvWindow,
} from '../../core/tv/tv-window.js';
import type { JsonObject } from '../../utils/json.js';

// The page function of the Strategy Tester tools (reverse-engineering notes of Plan 2, section Q6).
// The page bridge sends the source text of it into the page, so it uses nothing of this file, only
// its parameters and the globals of the page. Types are erased, so the type imports above are fine.

// What the strategy tools read of the report a strategy study holds, without opening the Strategy
// Tester or asking for anything: reportData(), ordersData() and barsIndexes() of the study core,
// which the core model gives by study id (getStudyById), as the Pine output tools reach the core of
// a study. chartIndex null means the active chart; any other value has been checked against the
// layout by the caller. The raw report was never observed (the chart of the notes had no
// strategy), so everything in it is read as untrusted: a figure counts when it is a finite number
// or text that is wholly a number (read with parseFloat), and anything else is left out or null.
//
// The strategy is the study of studyId, which has to be a strategy of the chart (the flag of the
// strategy class or the members the app tests strategies by). Without studyId it is the active
// strategy source of the core model when that is a strategy the chart lists, else the only strategy
// of the chart. A source the chart does not list, such as an internal one, or one that cannot be
// named, counts as none.
//
// part 'results' reads the performance: all, long and short as records of the numeric figures under
// the names of the Strategy Tester. The figures the report keeps at the top of the performance,
// next to all, long and short, join all, where all has its own, as the All column of the Strategy
// Tester reads them (all first, else the top). part 'trades' reads the trades and leaves the
// performance empty: trades is a list when the report has a list of trades in the shape of the
// Strategy Tester (items with an entry object; an empty list counts only when the report has no
// filled orders either), and else null, in which case fills holds the filled orders, each with the
// bar of barsIndexes() and the time of that bar in the rows of the chart. fills is empty otherwise.
// A time in a trade is passed on as the report has it; the caller reads its unit.
//
// initialCapital is initialCapital of the all figures, else of the top of the performance, else the
// value of the strategy input whose metadata gives it the internal id initial_capital; null when
// none holds a number.
//
// A page without the chart API or the core model, a strategy that cannot give a report, and an id
// the chart lists but its model does not know are CAPABILITY_UNAVAILABLE. A report that is null or
// no object (not calculated yet), and a report without performance for part 'results', are
// NOT_AVAILABLE. A chart without a strategy is NOT_AVAILABLE too. An id that is not a study of the
// chart or not a strategy, and several strategies none of which is active, are INVALID_INPUT.
export function readStrategyReport(
  win: TvWindow,
  chartIndex: number | null,
  studyId: string | null,
  part: 'results' | 'trades',
):
  | {
      strategy: { id: string; name: string };
      currency: string | null;
      initialCapital: number | null;
      performance: {
        all: Record<string, number>;
        long: Record<string, number>;
        short: Record<string, number>;
      };
      trades:
        | {
            tradeNumber: number | null;
            isOpen: boolean;
            entry: {
              type: string | null;
              time: number | null;
              price: number | null;
              id: string | null;
            };
            exit: {
              type: string | null;
              time: number | null;
              price: number | null;
              id: string | null;
            } | null;
            quantity: number | null;
            profit: number | null;
            profitPercent: number | null;
            cumulativeProfit: number | null;
            runup: number | null;
            drawdown: number | null;
          }[]
        | null;
      fills: {
        id: string | null;
        isBuy: boolean | null;
        isEntry: boolean;
        price: number | null;
        quantity: number | null;
        comment: string | null;
        barIndex: number | null;
        time: number | null;
      }[];
    }
  | PageErrorSentinel {
  const attempt = (read: () => unknown): unknown => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  // A finite number, or text that is wholly a number, which parseFloat then reads: text that only
  // starts with a number, such as 12abc or 1,234.5, is not one.
  const number = (value: unknown): number | null => {
    const parsed =
      typeof value === 'string' && /^\s*[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/i.test(value)
        ? parseFloat(value)
        : value;
    return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
  };
  // An id as the chart lists it: text, or a number as its text.
  const idOf = (raw: unknown): string | null =>
    text(raw) ?? (typeof raw === 'number' ? String(raw) : null);
  const fail = (
    code: 'CAPABILITY_UNAVAILABLE' | 'INVALID_INPUT' | 'NOT_AVAILABLE',
    message: string,
    hint: string,
    details?: JsonObject,
  ): PageErrorSentinel => ({
    __tvmcpError: { code, message, hint, ...(details === undefined ? {} : { details }) },
  });

  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  const chart = attempt(() =>
    chartIndex === null ? api?.activeChart?.() : api?.chart?.(chartIndex),
  ) as Partial<ChartWidgetApiLike> | null | undefined;
  if (typeof chart?.getAllStudies !== 'function') {
    return fail(
      'CAPABILITY_UNAVAILABLE',
      'This page has no chart API to read the studies from',
      'Check app_health: the chart may still be loading, or the tab does not show a chart.',
    );
  }
  const model = attempt(() => chart._chartWidget?.model()) as
    Partial<ChartModelLike> | null | undefined;
  const core = attempt(() => model?.model?.()) as Partial<CoreModelLike> | null | undefined;
  if (typeof core?.getStudyById !== 'function') {
    return fail(
      'CAPABILITY_UNAVAILABLE',
      'This page has no study model to read the reports of strategies from',
      'This TradingView build keeps the reports of strategies elsewhere. Check app_health.',
    );
  }

  // The studies of the chart, in its order, with the name the chart gives, and the core of one.
  const listed = attempt(() => chart.getAllStudies?.());
  const entries = (Array.isArray(listed) ? (listed as unknown[]) : []).flatMap((entry) => {
    const { id: rawId, name: rawName } = (entry ?? {}) as { id?: unknown; name?: unknown };
    const id = idOf(rawId);
    return id === null ? [] : [{ id, name: text(rawName) ?? id }];
  });
  const coreOf = (id: string) =>
    attempt(() => core.getStudyById?.(id)) as Partial<StudyCoreLike> | null | undefined;
  // The flag of the strategy class, or else the members the app tests strategies by.
  const isStrategy = (
    study: Partial<StudyCoreLike> | null | undefined,
  ): study is Partial<StudyCoreLike> =>
    typeof study === 'object' &&
    study !== null &&
    (study.isStudyStrategy === true ||
      ['strategyOrdersPaneView', 'ordersData', 'reportData'].every((key) => key in study));

  let chosen: { id: string; name: string; study: Partial<StudyCoreLike> } | undefined;
  if (studyId !== null) {
    const entry = entries.find(({ id }) => id === studyId);
    if (entry === undefined) {
      return fail(
        'INVALID_INPUT',
        `The chart has no study with the id ${studyId}`,
        'Call indicator_list for the ids of the studies on the chart.',
        { id: studyId },
      );
    }
    const study = coreOf(entry.id);
    if (typeof study !== 'object' || study === null) {
      return fail(
        'CAPABILITY_UNAVAILABLE',
        `The report of the study ${studyId} could not be read`,
        'The study may still be loading: try again in a moment, or check app_health.',
        { id: studyId },
      );
    }
    if (!isStrategy(study)) {
      return fail(
        'INVALID_INPUT',
        `The study ${studyId} (${entry.name}) is not a strategy, so it has no Strategy Tester report`,
        'Call indicator_list: isStrategy tells which studies on the chart are strategies.',
        { id: studyId },
      );
    }
    chosen = { ...entry, study };
  } else {
    const strategies = entries.flatMap((entry) => {
      const study = coreOf(entry.id);
      return isStrategy(study) ? [{ ...entry, study }] : [];
    });
    if (strategies.length === 0) {
      return fail(
        'NOT_AVAILABLE',
        'The chart has no strategy',
        'Add one: pine_new with type strategy starts a strategy script, and pine_compile with ' +
          'addToChart: true puts it on the chart. TradingView calculates its report once it is ' +
          'there.',
      );
    }
    // The active strategy source is the study of the strategy the Strategy Tester shows.
    const source = attempt(() => core.activeStrategySource?.().value?.());
    const named = source as { id?: () => unknown };
    const activeId = isObject(source) ? idOf(attempt(() => named.id?.())) : null;
    chosen =
      strategies.find(({ id }) => id === activeId) ??
      (strategies.length === 1 ? strategies[0] : undefined);
    if (chosen === undefined) {
      const ids = strategies.map(({ id }) => id);
      return fail(
        'INVALID_INPUT',
        `The chart has ${String(ids.length)} strategies and none is the active one: ${ids.join(', ')}`,
        'Give studyId, one of these ids: indicator_list shows which strategy each one is.',
        { ids },
      );
    }
  }

  const { id, name, study } = chosen;
  const label = `${id} (${name})`;
  if (typeof study.reportData !== 'function') {
    return fail(
      'CAPABILITY_UNAVAILABLE',
      `The report of the strategy ${label} cannot be read on this page`,
      'This TradingView build keeps the reports of strategies elsewhere. Check app_health.',
      { id },
    );
  }
  const report = attempt(() => study.reportData?.());
  const wait =
    'TradingView calculates the report after a strategy is added or changed, and while the ' +
    'chart loads its data. Wait a moment and call again.';
  if (!isObject(report)) {
    return fail('NOT_AVAILABLE', `The report of the strategy ${label} is not ready`, wait, { id });
  }
  const performance = isObject(report.performance) ? report.performance : null;
  if (part === 'results' && performance === null) {
    return fail(
      'NOT_AVAILABLE',
      `The report of the strategy ${label} has no performance statistics yet`,
      wait,
      { id },
    );
  }

  // The figures of the performance. Own entries only, so that no key of the report can reach a
  // member every object has.
  const figuresOf = (source: unknown): Record<string, number> =>
    Object.fromEntries(
      Object.entries(isObject(source) ? source : {}).flatMap(([key, value]) => {
        const figure = number(value);
        return figure === null ? [] : [[key, figure] as const];
      }),
    );
  const all = performance !== null && isObject(performance.all) ? performance.all : null;
  const outsideTheSplit = Object.fromEntries(
    Object.entries(performance ?? {}).filter(([key]) => !['all', 'long', 'short'].includes(key)),
  );
  const figures =
    part === 'results'
      ? {
          all: { ...figuresOf(outsideTheSplit), ...figuresOf(all) },
          long: figuresOf(performance?.long),
          short: figuresOf(performance?.short),
        }
      : { all: {}, long: {}, short: {} };

  // The capital the strategy started with: the report first, then the input of the strategy.
  const capitalOfInput = (): number | null => {
    const studyApi = attempt(() => chart.getStudyById?.(id)) as
      Partial<StudyApiLike> | null | undefined;
    const lists = [
      attempt(() => studyApi?.getInputsInfo?.()),
      attempt(() => study.metaInfo?.().inputs),
    ];
    const declared = lists.flatMap((list) => (Array.isArray(list) ? (list as unknown[]) : []));
    const capital = declared.find(
      (input) => isObject(input) && input.internalID === 'initial_capital',
    );
    const inputId = isObject(capital) ? text(capital.id) : null;
    if (inputId === null) {
      return null;
    }
    const values = attempt(() => studyApi?.getInputValues?.());
    const found = (Array.isArray(values) ? (values as unknown[]) : []).find(
      (item) => isObject(item) && item.id === inputId,
    );
    return isObject(found) ? number(found.value) : null;
  };
  const initialCapital =
    number(all?.initialCapital) ?? number(performance?.initialCapital) ?? capitalOfInput();

  // The trades, when the report has them in the shape of the Strategy Tester.
  const orders = Array.isArray(report.filledOrders) ? (report.filledOrders as unknown[]) : [];
  const rawTrades: unknown = report.trades;
  const items = Array.isArray(rawTrades) ? (rawTrades as unknown[]) : null;
  const isTrade = (item: unknown): item is Record<string, unknown> =>
    isObject(item) && isObject(item.entry);
  const leg = (value: Record<string, unknown>) => ({
    type: text(value.type),
    time: number(value.time),
    price: number(value.price),
    id: text(value.id),
  });
  const amount = (value: unknown): number | null => (isObject(value) ? number(value.value) : null);
  const trades =
    part === 'trades' &&
    items !== null &&
    items.every(isTrade) &&
    (items.length > 0 || orders.length === 0)
      ? items.map((item) => ({
          tradeNumber: number(item.tradeNumber),
          isOpen: item.isOpen === true,
          entry: leg(item.entry as Record<string, unknown>),
          exit: isObject(item.exit) ? leg(item.exit) : null,
          quantity: number(item.quantity),
          profit: amount(item.profit),
          profitPercent: isObject(item.profit) ? number(item.profit.percentValue) : null,
          cumulativeProfit: amount(item.cumulativeProfit),
          runup: amount(item.runup),
          drawdown: amount(item.drawdown),
        }))
      : null;

  // Else the filled orders, each with the bar barsIndexes() gives it and the time of that bar in
  // the rows of the chart. An entry that is not marked as an exit (e false) is an entry.
  const series = attempt(() => model?.mainSeries?.()) as Partial<SeriesLike> | null | undefined;
  const bars = attempt(() => series?.bars?.()) as Partial<BarsLike> | null | undefined;
  const indexes = attempt(() => study.barsIndexes?.());
  const fills =
    part === 'trades' && trades === null
      ? orders.flatMap((order, position) => {
          if (!isObject(order)) {
            return [];
          }
          const barIndex = number(Array.isArray(indexes) ? (indexes as unknown[])[position] : null);
          const row = barIndex === null ? null : attempt(() => bars?.valueAt?.(barIndex));
          return [
            {
              id: text(order.id),
              isBuy: typeof order.b === 'boolean' ? order.b : null,
              isEntry: order.e !== false,
              price: number(order.p),
              quantity: number(order.q),
              comment: text(order.c),
              barIndex,
              time: Array.isArray(row) ? number(row[0]) : null,
            },
          ];
        })
      : [];

  return {
    strategy: { id, name },
    currency: text(report.currency),
    initialCapital,
    performance: figures,
    trades,
    fills,
  };
}
