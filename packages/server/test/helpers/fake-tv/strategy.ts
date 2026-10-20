import type { JsonValue } from '../../../src/utils/json.js';
import type { FixtureStrategyReport } from './fixture.js';

// What the study core of a strategy holds of its report, as the app keeps it (reverse-engineering
// notes of Plan 2, section Q6). The members of the core:
//
// - reportData() answers the raw report, or null until the app has computed one. The keys the notes
//   confirm are currency, position, filledOrders, activeOrders and performance; a report also has
//   the members of the fixture (trades), and none that the fixture leaves out. Whether the raw
//   report has trades at all is not known, which is why the fixture can leave them out or stage
//   any shape.
// - ordersData() answers the filledOrders of the report, or null without them.
// - barsIndexes() answers the time-point index of each filled order, in the order of filledOrders:
//   the app keeps indexes[] and each order points into it with tm, so barsIndexes[i] =
//   indexes[filledOrders[i].tm]. The fake makes the indexes the list of barsIndexes and tm the
//   position in it.
// - strategyOrdersPaneView() is there for the duck test the app tests strategies by; the fake draws
//   no orders, so it answers null.
//
// Every read answers a copy, so that what a page does to it stays in the page, where the app hands
// out its live objects.

// A filled order as the report keeps it.
export interface FakeFilledOrder {
  id: string;
  b: boolean;
  e?: boolean;
  p: number;
  q: number;
  c?: string;
  tm: number;
}

export interface FakeStrategyReport {
  currency: string;
  position: { price: number; qty: number; openPL: number };
  activeOrders: never[];
  performance?: Record<string, JsonValue>;
  trades?: JsonValue;
  filledOrders?: FakeFilledOrder[];
}

export interface FakeStrategyMembers {
  strategyOrdersPaneView(): null;
  ordersData(): FakeFilledOrder[] | null;
  reportData(): FakeStrategyReport | null;
  barsIndexes(): number[];
}

export function createFakeStrategyMembers(
  report: FixtureStrategyReport | undefined,
): FakeStrategyMembers {
  // The orders without the bar index of the fixture, and with the position in the indexes as tm.
  // A key the fixture leaves out stays out, as the app does not write an undefined member.
  const filledOrders = (): FakeFilledOrder[] | null =>
    report?.filledOrders === undefined
      ? null
      : report.filledOrders.map(({ id, b, e, p, q, c }, tm): FakeFilledOrder => ({
          id,
          b,
          ...(e === undefined ? {} : { e }),
          p,
          q,
          ...(c === undefined ? {} : { c }),
          tm,
        }));
  return {
    strategyOrdersPaneView: () => null,
    ordersData: filledOrders,
    reportData() {
      if (report === undefined) {
        return null;
      }
      const orders = filledOrders();
      return {
        currency: report.currency,
        position: { price: 0, qty: 0, openPL: 0 },
        activeOrders: [],
        ...(report.performance === undefined
          ? {}
          : { performance: structuredClone(report.performance) }),
        ...(report.trades === undefined ? {} : { trades: structuredClone(report.trades) }),
        ...(orders === null ? {} : { filledOrders: orders }),
      };
    },
    barsIndexes: () => (report?.filledOrders ?? []).map(({ barIndex }) => barIndex),
  };
}
