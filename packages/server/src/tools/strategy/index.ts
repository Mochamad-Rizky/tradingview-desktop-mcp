import { z } from 'zod';
import { TvMcpError } from '../../core/errors.js';
import { READ_ONLY } from '../annotations.js';
import { chartIndexInput } from '../chart/index.js';
import { resolveChartTarget } from '../chart/strategies.js';
import { defineTool, type AnyToolDefinition, type ToolContext } from '../types.js';
import { deriveEquity, downsample, toFills, toTrades } from './mappers.js';
import { readStrategyReport } from './page.js';

// The Strategy Tester tools (design spec 7, domain Strategy): the results, the trades and the equity
// curve of a strategy on a chart. They read the report the strategy study holds, and change nothing,
// send no request, and neither open the Strategy Tester nor create anything for it. The raw report
// of the app was never observed (the chart of the notes had no strategy), so what the tools say of
// its shape is what the web build suggests and the descriptions are open about it (reverse-
// engineering notes of Plan 2, section Q6).

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const DEFAULT_MAX_POINTS = 500;
const MAX_POINTS = 5000;

// The inputs the three tools share.
const strategyInputs = () => ({
  studyId: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      'The id of a strategy on the chart, from indicator_list (isStrategy). Default: the active ' +
        'strategy, else the only strategy on the chart.',
    ),
  chartIndex: chartIndexInput(),
});

// The sentences the descriptions of the tools share.
const SELECTION_TEXT =
  'Without studyId it reads the active strategy, the one the Strategy Tester shows, or the only ' +
  'strategy on the chart; with several and none active it fails with INVALID_INPUT, naming their ' +
  'ids. With a studyId (from indicator_list, where isStrategy marks the strategies), an id that ' +
  'is not on the chart or is not a strategy fails with INVALID_INPUT.';

const AVAILABILITY_TEXT =
  'NOT_AVAILABLE when the chart has no strategy (pine_new with type strategy and pine_compile ' +
  'with addToChart put one there) and while TradingView has not calculated the report yet, which ' +
  'wants a call again in a moment.';

type Part = 'results' | 'trades';

// What the page reads of the report, for the part the tool needs.
async function readReport(
  ctx: ToolContext,
  part: Part,
  studyId: string | undefined,
  chartIndex: number | undefined,
) {
  const page = await ctx.connection.chartPage();
  const target = await resolveChartTarget(page, chartIndex);
  return page.bridge.evaluate(readStrategyReport, [target.index, studyId ?? null, part]);
}

// The strategy a result was read from: its id and its name. Taken from what the page reads, and not
// declared as an interface, which would lack the index signature a JSON value needs.
type StrategyRef = Awaited<ReturnType<typeof readReport>>['strategy'];

const labelOf = ({ id, name }: StrategyRef) => `${id} (${name})`;

// The data of a result with the strategy it was read from in front, so that a caller knows which
// one that was when the choice was implicit. It is a function and not a spread at the call, which
// would make the compiler merge the two answers of strategy_get_trades into one shape.
function ofStrategy<T extends object>(strategy: StrategyRef, data: T) {
  return { strategy, ...data };
}

// What strategy_get_results and the resource tradingview://strategy/report report: the results of a
// strategy, with a warning when the report holds no number. The strategy is the one studyId names,
// else the active one, else the only one on the chart.
export async function readStrategyResultsData(
  ctx: ToolContext,
  studyId?: string,
  chartIndex?: number,
) {
  const { strategy, currency, initialCapital, performance } = await readReport(
    ctx,
    'results',
    studyId,
    chartIndex,
  );
  const warnings: string[] = [];
  if (
    [performance.all, performance.long, performance.short].every(
      (figures) => Object.keys(figures).length === 0,
    )
  ) {
    warnings.push(
      `The report of the strategy ${labelOf(strategy)} holds no numeric statistic, so all, long ` +
        'and short are empty.',
    );
  }
  return { data: { strategy, currency, initialCapital, performance }, warnings };
}

export const strategyGetResults = defineTool({
  name: 'strategy_get_results',
  domain: 'strategy',
  title: 'Read Strategy Tester results',
  description:
    'Reads the Strategy Tester results of a strategy on a chart, and changes nothing. ' +
    `${SELECTION_TEXT} Returns strategy (id, name), currency (as TradingView gives it, such as ` +
    'USD, or NONE), initialCapital (null when it cannot be read) and performance: all, long and ' +
    'short, each an object of the numeric statistics TradingView reports, under its own names ' +
    '(netProfit, totalTrades, percentProfitable, profitFactor, maxStrategyDrawDown and the like, ' +
    'with its own spellings such as numberOfWiningTrades and avgLosTrade). A statistic ' +
    'that is not a number is left out, text that is a number is read as one, and all also holds ' +
    'the figures TradingView reports for the whole run outside its long and short split. The ' +
    'amounts are in the currency of the strategy. It reads the report the strategy study holds: ' +
    `nothing is opened or calculated. ${AVAILABILITY_TEXT}`,
  inputSchema: strategyInputs(),
  annotations: READ_ONLY,
  core: true,
  async handler({ studyId, chartIndex }, ctx) {
    const { data, warnings } = await readStrategyResultsData(ctx, studyId, chartIndex);
    return { data, via: 'internal', warnings };
  },
});

export const strategyGetTrades = defineTool({
  name: 'strategy_get_trades',
  domain: 'strategy',
  title: 'Read Strategy Tester trades',
  description:
    'Lists the trades of a strategy on a chart, and changes nothing. ' +
    `${SELECTION_TEXT} Returns strategy (id, name), total, the number of trades, and trades, at ` +
    'most limit of them from offset, in the order TradingView gives them: number, isOpen, side ' +
    '(long or short), entry and exit (each with time in Unix seconds, timeIso, price and signal, ' +
    'the name the script gave the order; exit is null for a trade that is still open), quantity, ' +
    'profit and profitPercent, cumulativeProfit, runup and drawdown, the amounts as TradingView ' +
    'holds them, in the currency of the strategy. If the report of this TradingView build holds ' +
    'filled orders but no list of trades, trades is empty and fills lists the orders instead, ' +
    'with a warning: each fill has id, side (buy or sell), isEntry, price, quantity, comment, ' +
    'barIndex and the time of its bar with timeIso, an entry and an exit make a trade, and ' +
    `total then counts the fills. ${AVAILABILITY_TEXT}`,
  inputSchema: {
    ...strategyInputs(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .default(DEFAULT_LIMIT)
      .describe(
        `How many trades at most: 1 to ${String(MAX_LIMIT)}, ${String(DEFAULT_LIMIT)} by default.`,
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'How many trades to skip from the start of the list, for the next page. Default 0.',
      ),
  },
  annotations: READ_ONLY,
  async handler({ studyId, limit, offset, chartIndex }, ctx) {
    const { strategy, trades, fills } = await readReport(ctx, 'trades', studyId, chartIndex);
    if (trades !== null) {
      return {
        data: ofStrategy(strategy, toTrades(trades, offset, limit)),
        via: 'internal',
        warnings: [],
      };
    }
    const page = toFills(fills, offset, limit);
    return {
      data: ofStrategy(strategy, { total: page.total, trades: [], fills: page.fills }),
      via: 'internal',
      warnings: [
        `The report of the strategy ${labelOf(strategy)} has no list of trades in the shape of ` +
          'the Strategy Tester, so trades is empty and fills lists the filled orders instead: ' +
          'each is an entry or an exit, not a whole trade.',
      ],
    };
  },
});

export const strategyGetEquity = defineTool({
  name: 'strategy_get_equity',
  domain: 'strategy',
  title: 'Derive the equity curve of a strategy',
  description:
    'Derives the equity curve of a strategy on a chart from its closed trades, and changes ' +
    `nothing. ${SELECTION_TEXT} The curve starts at the first entry with the initial capital, ` +
    'then has a point at the exit of each closed trade holding the initial capital plus the ' +
    'cumulative profit of the trades closed by then, in time order. It is the realized equity: ' +
    'an open trade is left out, open profit and the drawdown between trades are not in it, and ' +
    'the equity series of TradingView itself is not read. Returns strategy (id, name), ' +
    'initialCapital, points (time in Unix seconds, timeIso and equity) and downsampled. At most ' +
    `maxPoints points come back (2 to ${String(MAX_POINTS)}, ${String(DEFAULT_MAX_POINTS)} by ` +
    'default): beyond that the first and the last point are kept with the lowest and the ' +
    'highest point of each stretch between them, and downsampled is true. NOT_AVAILABLE also ' +
    'when the report has no list of (closed) trades, which strategy_get_trades then answers ' +
    `with the filled orders, and when the initial capital cannot be read. ${AVAILABILITY_TEXT}`,
  inputSchema: {
    ...strategyInputs(),
    maxPoints: z
      .number()
      .int()
      .min(2)
      .max(MAX_POINTS)
      .default(DEFAULT_MAX_POINTS)
      .describe(
        `How many points at most: 2 to ${String(MAX_POINTS)}, ${String(DEFAULT_MAX_POINTS)} by default.`,
      ),
  },
  annotations: READ_ONLY,
  async handler({ studyId, maxPoints, chartIndex }, ctx) {
    const { strategy, trades, initialCapital } = await readReport(
      ctx,
      'trades',
      studyId,
      chartIndex,
    );
    if (trades === null) {
      throw new TvMcpError(
        'NOT_AVAILABLE',
        `The report of the strategy ${labelOf(strategy)} has no list of trades in the shape of ` +
          'the Strategy Tester, so no equity curve can be derived from its closed trades',
        {
          hint:
            'The curve is derived from the closed trades. strategy_get_trades lists the filled ' +
            'orders the report does hold, with their prices and times.',
        },
      );
    }
    if (initialCapital === null) {
      throw new TvMcpError(
        'NOT_AVAILABLE',
        `The initial capital of the strategy ${labelOf(strategy)} could not be read, so no ` +
          'equity curve can be derived',
        {
          hint:
            'The curve starts from the initial capital. strategy_get_results reports it as ' +
            'initialCapital, taken from the statistics of the report or from the Initial capital ' +
            'input of the strategy.',
        },
      );
    }
    const { points, skipped } = deriveEquity(trades, initialCapital);
    const kept = downsample(points, maxPoints);
    const warnings: string[] = [];
    if (skipped > 0) {
      warnings.push(
        `${String(skipped)} closed trade${skipped === 1 ? ' has' : 's have'} no exit time or no ` +
          `cumulative profit, so ${skipped === 1 ? 'it is' : 'they are'} not on the curve.`,
      );
    }
    if (points.length === 0 && skipped === 0) {
      warnings.push('No trade has closed yet, so the curve has no points.');
    }
    return {
      data: ofStrategy(strategy, {
        initialCapital,
        points: kept,
        downsampled: kept.length < points.length,
      }),
      via: 'internal',
      warnings,
    };
  },
});

// In the order of the catalog (design spec 7).
export const strategyTools: AnyToolDefinition[] = [
  strategyGetResults,
  strategyGetTrades,
  strategyGetEquity,
];
