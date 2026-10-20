import type { PageErrorSentinel } from '../../core/tv/page-bridge.js';
import { MILLISECONDS_ABOVE, toIso } from '../../utils/time.js';
import { isReportableTime } from '../chart/mappers.js';
import type { readStrategyReport } from './page.js';

// How what a page reads of the report of a strategy (readStrategyReport) becomes what the Strategy
// Tester tools return: the trades with the ISO form of their times and the side named, the filled
// orders, the equity curve derived from the closed trades, and the downsampling of a curve
// (reverse-engineering notes of Plan 2, section Q6).

// What readStrategyReport answers, and the trade, leg and filled order it reads.
export type StrategyReading = Exclude<ReturnType<typeof readStrategyReport>, PageErrorSentinel>;
export type ReadTrade = NonNullable<StrategyReading['trades']>[number];
type ReadLeg = ReadTrade['entry'];
export type ReadFill = StrategyReading['fills'][number];

// The sides by the type of the entry leg of a trade: le is a long entry and se a short one. The
// exit types (lx, sx) and any other code name no side, as the entry decides the side of a trade.
const SIDE: Readonly<Record<string, 'long' | 'short'>> = { le: 'long', se: 'short' };

function sideOf(type: string | null): 'long' | 'short' | null {
  if (type === null) {
    return null;
  }
  return (Object.hasOwn(SIDE, type) ? SIDE[type] : undefined) ?? null;
}

// The time of a leg of a trade in whole Unix seconds. The unit of the times of a leg is not known:
// the Strategy Tester measures an open trade against the clock in milliseconds, so the times may be
// milliseconds. A number above 1e11 is read as milliseconds and any other as seconds, as every time
// the server takes is (design spec 5.1). Null for no time and for one no date can show.
export function legSeconds(time: number | null): number | null {
  if (time === null) {
    return null;
  }
  const seconds = Math.floor(time > MILLISECONDS_ABOVE ? time / 1000 : time);
  return isReportableTime(seconds) ? seconds : null;
}

// A leg as the trade tools report it: the time in Unix seconds with its ISO form, the price and the
// signal, which is the id of the order that made the leg (the name the script gave it).
function toLeg(leg: ReadLeg) {
  const time = legSeconds(leg.time);
  return { time, timeIso: time === null ? null : toIso(time), price: leg.price, signal: leg.id };
}

// The page of `limit` trades from `offset` of the whole list, and how many there are in all. A
// trade without a trade number of its own is numbered by its place in the whole list, counting
// from 1. An open trade has no exit, whatever leg the page read for it: the leg of an open trade
// holds the state of the trade now, not an exit.
export function toTrades(trades: readonly ReadTrade[], offset: number, limit: number) {
  return {
    total: trades.length,
    trades: trades.slice(offset, offset + limit).map((trade, place) => ({
      number: trade.tradeNumber ?? offset + place + 1,
      isOpen: trade.isOpen,
      side: sideOf(trade.entry.type),
      entry: toLeg(trade.entry),
      exit: trade.isOpen || trade.exit === null ? null : toLeg(trade.exit),
      quantity: trade.quantity,
      profit: trade.profit,
      profitPercent: trade.profitPercent,
      cumulativeProfit: trade.cumulativeProfit,
      runup: trade.runup,
      drawdown: trade.drawdown,
    })),
  };
}

function sideOfOrder(isBuy: boolean | null): 'buy' | 'sell' | null {
  if (isBuy === null) {
    return null;
  }
  return isBuy ? 'buy' : 'sell';
}

// The page of `limit` filled orders from `offset` of the whole list, and how many there are in all.
// The time of an order is that of its bar in the rows of the chart, in Unix seconds with its ISO
// form, and null when the chart has no row for the bar.
export function toFills(fills: readonly ReadFill[], offset: number, limit: number) {
  return {
    total: fills.length,
    fills: fills.slice(offset, offset + limit).map((fill) => {
      const time = isReportableTime(fill.time) ? fill.time : null;
      return {
        id: fill.id,
        side: sideOfOrder(fill.isBuy),
        isEntry: fill.isEntry,
        price: fill.price,
        quantity: fill.quantity,
        comment: fill.comment,
        barIndex: fill.barIndex,
        time,
        timeIso: time === null ? null : toIso(time),
      };
    }),
  };
}

// The equity curve of the closed trades: a point with the initial capital at the first entry, and
// at the exit of each closed trade a point with the initial capital plus the cumulative profit of
// that trade, in time order (trades that closed at one time keep the order they came in, the start
// first). An open trade is left out, as its profit is not realized. A closed trade without an exit
// time or a cumulative profit cannot be placed on the curve, and is counted in `skipped`; the start
// is the earliest entry time of the trades that are on the curve, and there is none when none has
// one, or when no trade is on the curve at all.
export function deriveEquity(trades: readonly ReadTrade[], initialCapital: number) {
  const closed = trades.filter(({ isOpen }) => !isOpen);
  const placed = closed.flatMap((trade) => {
    const time = trade.exit === null ? null : legSeconds(trade.exit.time);
    if (time === null || trade.cumulativeProfit === null) {
      return [];
    }
    return [
      {
        entryTime: legSeconds(trade.entry.time),
        time,
        equity: initialCapital + trade.cumulativeProfit,
      },
    ];
  });
  const entryTimes = placed.flatMap(({ entryTime }) => (entryTime === null ? [] : [entryTime]));
  const start =
    entryTimes.length === 0
      ? []
      : [{ time: entryTimes.reduce((a, b) => Math.min(a, b)), equity: initialCapital }];
  const points = [...start, ...placed.map(({ time, equity }) => ({ time, equity }))]
    .sort((a, b) => a.time - b.time)
    .map(({ time, equity }) => ({ time, timeIso: toIso(time), equity }));
  return { points, skipped: closed.length - placed.length };
}

// At most `maxPoints` points of a curve, which has the first point, the last point, and for each
// stretch of the points between them the lowest and the highest point of the stretch, in time
// order. There are as many stretches as pairs fit beside the first and the last point, they are as
// equal as the count allows, and each has at least two points. Of equal extremes the first counts.
// A curve that has no more than `maxPoints` points is returned whole.
export function downsample<P extends { equity: number }>(
  points: readonly P[],
  maxPoints: number,
): P[] {
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined || points.length <= maxPoints) {
    return [...points];
  }
  const between = points.slice(1, -1);
  const stretches = Math.floor((maxPoints - 2) / 2);
  const kept = [first];
  for (let stretch = 0; stretch < stretches; stretch += 1) {
    const run = between.slice(
      Math.floor((stretch * between.length) / stretches),
      Math.floor(((stretch + 1) * between.length) / stretches),
    );
    const equities = run.map(({ equity }) => equity);
    const lowest = equities.indexOf(equities.reduce((a, b) => Math.min(a, b), Infinity));
    const highest = equities.indexOf(equities.reduce((a, b) => Math.max(a, b), -Infinity));
    const places = [...new Set([lowest, highest])].sort((a, b) => a - b);
    kept.push(...places.flatMap((place) => run.slice(place, place + 1)));
  }
  kept.push(last);
  return kept;
}
