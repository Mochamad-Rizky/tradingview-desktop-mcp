import type { FixtureGraphics } from './fixture.js';

// The drawings of a Pine study, as the study core of the app holds them (reverse-engineering notes
// of Plan 2, section Q5). graphics() answers one object that keeps its maps, and its accessors
// answer two kinds of map:
//
// - dwglines(), dwglabels(), dwgboxes() and dwgtables() are grouped: a Map from the style id to a
//   Map from forceOverlay (a boolean, whether the drawing is forced onto the price pane) to a
//   PrimitiveSet. The inner map has a key only for a value some drawing has.
// - dwgtablecells() is regular: a Map from the style id to a PrimitiveSet.
//
// A PrimitiveSet iterates the materialized items in the order they came, with size, forEach,
// values() and the iterator, and its entries() and keys() throw, as on the app. An item is a plain
// object. The materializers of the app give these fields (the ones a fixture does not stage have
// the defaults below), and only lines and tables have an id: a label or a box has none, and a cell
// carries the id of its table. A time point the app has no index for is null.
//
// properties() answers a property tree of the study, as far as the palette goes. The renderers
// read a color by its index at properties().childs().palettes.childs().palette_common.childs()
// .colors.childs()[index].childs().color.value(), and palette_common is missing when the study has
// no palette. A study whose colors are packed integers (isRGB) has none, and a study without
// drawings has an empty palettes node.
//
// Nothing here models the live changes of the app (a script that draws more bars later, the items
// the app drops when history loads): the drawings are the ones of the fixture.

export interface FakePrimitiveSet<T> extends Iterable<T> {
  readonly size: number;
  forEach(callback: (item: T, same: T, set: FakePrimitiveSet<T>) => void): void;
  values(): IterableIterator<T>;
  entries(): never;
  keys(): never;
}

// A set of the items, in order. Every read hands out copies, so that what a page does to an item
// stays in the page.
export function createPrimitiveSet<T extends object>(items: readonly T[]): FakePrimitiveSet<T> {
  const values = (): IterableIterator<T> => items.map((item) => ({ ...item }))[Symbol.iterator]();
  const set: FakePrimitiveSet<T> = {
    size: items.length,
    forEach(callback) {
      for (const item of values()) {
        callback(item, item, set);
      }
    },
    values,
    [Symbol.iterator]: values,
    entries() {
      throw new Error('Method not implemented.');
    },
    keys() {
      throw new Error('Method not implemented.');
    },
  };
  return set;
}

export interface FakeDwgLine {
  id: number;
  x1: number | null;
  y1: number;
  x2: number | null;
  y2: number;
  style: string;
  extend: string;
  width: number;
  colorIndex: number | null;
  forceOverlay: boolean;
}

export interface FakeDwgLabel {
  x: number;
  y: number;
  yloc: string;
  text: string;
  style: string;
  size: string;
  colorIndex: number | null;
  textColorIndex: number | null;
  textAlign: string;
  tooltip: string;
  fontType: string | null;
  forceOverlay: boolean;
  textFormatting: number;
}

export interface FakeDwgBox {
  left: number | null;
  right: number | null;
  top: number;
  bottom: number;
  extend: string;
  text: string;
  borderColorIndex: number | null;
  backgroundColorIndex: number | null;
  borderStyle: string;
  borderWidth: number;
  textFormatting: number;
  horizontalTextAlignment: string;
  verticalTextAlignment: string;
  fontSize: string;
  textColorIndex: number | null;
  fontType: string | null;
  forceOverlay: boolean;
}

export interface FakeDwgTable {
  id: number;
  position: string;
  rows: number;
  columns: number;
  backgroundColorIndex: number | null;
  frameColorIndex: number | null;
  frameWidth: number;
  borderColorIndex: number | null;
  borderWidth: number;
  forceOverlay: boolean;
}

export interface FakeDwgTableCell {
  tableId: number;
  row: number;
  column: number;
  widthInPercentsOfPaneWidth: number;
  heightInPercentOfPaneHeight: number;
  text: string;
  textColorIndex: number | null;
  horizontalTextAlignment: string;
  verticalTextAlignment: string;
  fontSize: string;
  backgroundColorIndex: number | null;
  colSpan: number;
  rowSpan: number;
  tooltip: string;
  fontType: string | null;
  textFormatting: number;
}

export type FakeGroupedPrimitives<T> = Map<string, Map<boolean, FakePrimitiveSet<T>>>;

export interface FakeStudyGraphics {
  dwglines(): FakeGroupedPrimitives<FakeDwgLine>;
  dwglabels(): FakeGroupedPrimitives<FakeDwgLabel>;
  dwgboxes(): FakeGroupedPrimitives<FakeDwgBox>;
  dwgtables(): FakeGroupedPrimitives<FakeDwgTable>;
  dwgtablecells(): Map<string, FakePrimitiveSet<FakeDwgTableCell>>;
}

// A node of the property tree: a group has childs(), a leaf value().
export interface FakePropertyNode {
  childs?(): Record<string, FakePropertyNode | undefined>;
  value?(): unknown;
}

// The drawings of the fixture, grouped by style and by forceOverlay, each style and each overlay
// value in the order its first drawing comes.
function grouped<
  E extends { styleId: string; forceOverlay?: boolean | undefined },
  T extends object,
>(
  entries: readonly E[] | undefined,
  materialize: (entry: E, forceOverlay: boolean) => T,
): FakeGroupedPrimitives<T> {
  const buckets = new Map<string, Map<boolean, T[]>>();
  for (const entry of entries ?? []) {
    const forceOverlay = entry.forceOverlay === true;
    const byOverlay = buckets.get(entry.styleId) ?? new Map<boolean, T[]>();
    const items = byOverlay.get(forceOverlay) ?? [];
    items.push(materialize(entry, forceOverlay));
    byOverlay.set(forceOverlay, items);
    buckets.set(entry.styleId, byOverlay);
  }
  return new Map(
    [...buckets].map(([styleId, byOverlay]) => [
      styleId,
      new Map(
        [...byOverlay].map(([forceOverlay, items]) => [forceOverlay, createPrimitiveSet(items)]),
      ),
    ]),
  );
}

export function createFakeGraphics(spec: FixtureGraphics | undefined): FakeStudyGraphics {
  const lines = grouped(
    spec?.lines,
    ({ id, x1, y1, x2, y2, style, extend, width, colorIndex }, forceOverlay): FakeDwgLine => ({
      id,
      x1,
      y1,
      x2,
      y2,
      style,
      extend,
      width,
      colorIndex,
      forceOverlay,
    }),
  );
  const labels = grouped(
    spec?.labels,
    ({ x, y, yloc, text, style, colorIndex, textColorIndex }, forceOverlay): FakeDwgLabel => ({
      x,
      y,
      yloc,
      text,
      style,
      size: 'auto',
      colorIndex,
      textColorIndex,
      textAlign: 'center',
      tooltip: '',
      fontType: null,
      forceOverlay,
      textFormatting: 0,
    }),
  );
  const boxes = grouped(
    spec?.boxes,
    (
      { left, right, top, bottom, extend, text, borderColorIndex, backgroundColorIndex },
      forceOverlay,
    ): FakeDwgBox => ({
      left,
      right,
      top,
      bottom,
      extend,
      text,
      borderColorIndex,
      backgroundColorIndex,
      borderStyle: 'sol',
      borderWidth: 1,
      textFormatting: 0,
      horizontalTextAlignment: 'center',
      verticalTextAlignment: 'center',
      fontSize: 'auto',
      textColorIndex: null,
      fontType: null,
      forceOverlay,
    }),
  );
  const tables = grouped(
    spec?.tables,
    ({ id, position, rows, columns }, forceOverlay): FakeDwgTable => ({
      id,
      position,
      rows,
      columns,
      backgroundColorIndex: null,
      frameColorIndex: null,
      frameWidth: 0,
      borderColorIndex: null,
      borderWidth: 0,
      forceOverlay,
    }),
  );
  const cellItems = new Map<string, FakeDwgTableCell[]>();
  for (const { styleId, tableId, row, column, text } of spec?.tableCells ?? []) {
    cellItems.set(styleId, [
      ...(cellItems.get(styleId) ?? []),
      {
        tableId,
        row,
        column,
        widthInPercentsOfPaneWidth: 0,
        heightInPercentOfPaneHeight: 0,
        text,
        textColorIndex: null,
        horizontalTextAlignment: 'center',
        verticalTextAlignment: 'center',
        fontSize: 'normal',
        backgroundColorIndex: null,
        colSpan: 1,
        rowSpan: 1,
        tooltip: '',
        fontType: null,
        textFormatting: 0,
      },
    ]);
  }
  const cells = new Map(
    [...cellItems].map(([styleId, items]) => [styleId, createPrimitiveSet(items)]),
  );
  return {
    dwglines: () => lines,
    dwglabels: () => labels,
    dwgboxes: () => boxes,
    dwgtables: () => tables,
    dwgtablecells: () => cells,
  };
}

// The part of properties() the palette lives in. Index k of the palette is the child k of the
// colors node, whose child color holds the CSS color.
export function createFakeProperties(spec: FixtureGraphics | undefined): FakePropertyNode {
  const colors: Record<string, FakePropertyNode> = {};
  (spec?.palette ?? []).forEach((color, index) => {
    colors[String(index)] = { childs: () => ({ color: { value: () => color } }) };
  });
  const palettes: Record<string, FakePropertyNode> =
    spec?.palette === undefined
      ? {}
      : { palette_common: { childs: () => ({ colors: { childs: () => colors } }) } };
  return { childs: () => ({ palettes: { childs: () => palettes } }) };
}
