import type { PageErrorSentinel } from '../../core/tv/page-bridge.js';
import { toIso } from '../../utils/time.js';
import { isReportableTime } from '../chart/mappers.js';
import type { readPineGraphics } from './outputs-page.js';

// How what a page reads of the drawings of Pine scripts (readPineGraphics) becomes what the output
// tools return: the names of the codes of the app, the points with the ISO form of their times, the
// ids, the cells of a table, and the drawings the limit keeps (reverse-engineering notes of Plan 2,
// section Q5).

// What readPineGraphics answers, and the drawings it reads of one study.
export type PineGraphicsReading = Exclude<ReturnType<typeof readPineGraphics>, PageErrorSentinel>;
type StudyDrawings = PineGraphicsReading['studies'][number];

// The codes of the app and the names they are reported under. A code that is not here is passed
// through unchanged, as the app may have more of them than the build these notes were written from.
const EXTEND: Readonly<Record<string, string>> = {
  n: 'none',
  l: 'left',
  r: 'right',
  b: 'both',
};

const LINE_STYLE: Readonly<Record<string, string>> = {
  sol: 'solid',
  dot: 'dotted',
  dsh: 'dashed',
  al: 'arrow_left',
  ar: 'arrow_right',
  ab: 'arrow_both',
};

const YLOC: Readonly<Record<string, string>> = {
  ab: 'above_bar',
  bl: 'below_bar',
  pr: 'price',
  auto: 'auto',
};

// The names are those of the label.style_* constants of Pine without the prefix.
const LABEL_STYLE: Readonly<Record<string, string>> = {
  xcr: 'xcross',
  cr: 'cross',
  tup: 'triangleup',
  tdn: 'triangledown',
  flg: 'flag',
  cir: 'circle',
  aup: 'arrowup',
  adn: 'arrowdown',
  lup: 'label_up',
  ldn: 'label_down',
  llf: 'label_left',
  lrg: 'label_right',
  lcn: 'label_center',
  luplf: 'label_upper_left',
  llwlf: 'label_lower_left',
  luprg: 'label_upper_right',
  llwrg: 'label_lower_right',
  sq: 'square',
  dia: 'diamond',
  to: 'text_outline',
  n: 'none',
};

// A code reported by its name. hasOwn keeps a code such as constructor from finding a member that
// every object has.
function named(names: Readonly<Record<string, string>>, code: string | null): string | null {
  if (code === null) {
    return null;
  }
  return (Object.hasOwn(names, code) ? names[code] : undefined) ?? code;
}

// A point as the tools report it: the bar index of the app, and its time in Unix seconds with the
// ISO form of it. A time no date can show is none; the bar index stays.
function toPoint(point: { barIndex: number | null; time: number | null }) {
  const time = isReportableTime(point.time) ? point.time : null;
  return { barIndex: point.barIndex, time, timeIso: time === null ? null : toIso(time) };
}

// The drawings of every study as one list, cut to `limit`, and how many there were. The list is in
// the reverse of an order that is meant to put the newest first, which was not seen on the app:
// within a study the drawings come by id when every one of them has an id that is a whole number,
// the highest last, else in the order the app keeps them; a study further down the chart comes
// after one above it. A drawing without an id is named by its style and its place among the
// drawings of that style, before anything is cut, so the name does not change with the limit.
function newest<D extends { styleId: string; id?: string | null }, R>(
  studies: readonly StudyDrawings[],
  drawingsOf: (study: StudyDrawings) => readonly D[],
  limit: number,
  build: (study: StudyDrawings, id: string, drawing: D) => R,
): { drawings: R[]; total: number } {
  const ordered: R[] = [];
  for (const study of studies) {
    const places = new Map<string, number>();
    const drawings = drawingsOf(study).map((drawing) => {
      const place = places.get(drawing.styleId) ?? 0;
      places.set(drawing.styleId, place + 1);
      const own = drawing.id ?? null;
      return {
        drawing,
        rank: own !== null && /^-?\d+$/.test(own) ? Number(own) : null,
        id: own ?? `${drawing.styleId}:${String(place)}`,
      };
    });
    const ranked = drawings.flatMap((entry) =>
      entry.rank === null ? [] : [{ ...entry, rank: entry.rank }],
    );
    const inOrder =
      ranked.length === drawings.length ? ranked.sort((a, b) => a.rank - b.rank) : drawings;
    for (const { drawing, id } of inOrder) {
      ordered.push(build(study, id, drawing));
    }
  }
  return { drawings: ordered.slice(-limit).reverse(), total: ordered.length };
}

export function toLines(studies: readonly StudyDrawings[], limit: number) {
  const { drawings, total } = newest(
    studies,
    (study) => study.lines,
    limit,
    ({ studyId }, id, line) => ({
      studyId,
      id,
      start: { ...toPoint(line.x1), price: line.y1 },
      end: { ...toPoint(line.x2), price: line.y2 },
      extend: named(EXTEND, line.extend),
      color: line.color,
      width: line.width,
      style: named(LINE_STYLE, line.style),
    }),
  );
  return { lines: drawings, total };
}

// The price of a label is its y, except above or below its bar, where the renderer of the app
// ignores y and puts the label at the high or the low of the bar.
export function toLabels(studies: readonly StudyDrawings[], limit: number) {
  const { drawings, total } = newest(
    studies,
    (study) => study.labels,
    limit,
    ({ studyId }, id, label) => ({
      studyId,
      id,
      ...toPoint(label.x),
      price: label.yloc === 'ab' || label.yloc === 'bl' ? null : label.y,
      yloc: named(YLOC, label.yloc),
      text: label.text,
      color: label.color,
      textColor: label.textColor,
      style: named(LABEL_STYLE, label.style),
    }),
  );
  return { labels: drawings, total };
}

export function toBoxes(studies: readonly StudyDrawings[], limit: number) {
  const { drawings, total } = newest(
    studies,
    (study) => study.boxes,
    limit,
    ({ studyId }, id, box) => ({
      studyId,
      id,
      left: toPoint(box.left),
      right: toPoint(box.right),
      top: box.top,
      bottom: box.bottom,
      extend: named(EXTEND, box.extend),
      text: box.text,
      borderColor: box.borderColor,
      bgColor: box.bgColor,
    }),
  );
  return { boxes: drawings, total };
}

// The cells of a table: those of its study with its id as their tableId, compared as text (whatever
// style they are in, as the renderer of the app joins them), by row and then column. A cell set
// twice at one place is the last one, as for the renderer; a cell without a row or column has no
// place in the table.
function cellsOf(study: StudyDrawings, tableId: string | null) {
  const byPlace = new Map<string, { row: number; column: number; text: string | null }>();
  for (const { tableId: owner, row, column, text } of study.cells) {
    if (tableId !== null && owner === tableId && row !== null && column !== null) {
      byPlace.set(`${String(row)}:${String(column)}`, { row, column, text });
    }
  }
  return [...byPlace.values()].sort((a, b) => a.row - b.row || a.column - b.column);
}

// A warning for each study that holds cells of no table it has (a tableId that is none, or that no
// table of the study has), which the tables leave out.
export function tableCellWarnings(studies: readonly StudyDrawings[]): string[] {
  return studies.flatMap((study) => {
    const ids = new Set(study.tables.flatMap(({ id }) => (id === null ? [] : [id])));
    const count = study.cells.filter(({ tableId }) => tableId === null || !ids.has(tableId)).length;
    if (count === 0) {
      return [];
    }
    const one = count === 1;
    return [
      `The study ${study.studyId} holds ${String(count)} table cell${one ? '' : 's'} that ` +
        `belong${one ? 's' : ''} to no table it has, so ${one ? 'it is' : 'they are'} not listed.`,
    ];
  });
}

// total counts the tables, not their cells.
export function toTables(studies: readonly StudyDrawings[], limit: number) {
  const { drawings, total } = newest(
    studies,
    (study) => study.tables,
    limit,
    (study, id, table) => ({
      studyId: study.studyId,
      id,
      position: table.position,
      rows: table.rows,
      columns: table.columns,
      cells: cellsOf(study, table.id),
    }),
  );
  return { tables: drawings, total };
}
