import type { PageErrorSentinel } from '../../core/tv/page-bridge.js';
import type {
  BarsLike,
  ChartModelLike,
  ChartWidgetApiLike,
  CoreModelLike,
  PropertyNodeLike,
  SeriesLike,
  StudyCoreLike,
  StudyGraphicsLike,
  StudyMetaInfoLike,
  TimeScaleLike,
  TradingViewApiLike,
  TvWindow,
} from '../../core/tv/tv-window.js';

// The page function of the Pine output tools (reverse-engineering notes of Plan 2, section Q5).
// The page bridge sends the source text of it into the page, so it uses nothing of this file, only
// its parameters and the globals of the page. Types are erased, so the type imports above are fine.

// The drawings one call reads.
export type PineDrawingKind = 'lines' | 'labels' | 'boxes' | 'tables';

// What the Pine scripts on a chart have drawn, read without changing anything: for each Pine study
// (the metadata has pine), in the order of the chart, or for the one study asked for, the drawings
// of the kind asked for. The other lists of a study are empty, and so are the lists of a script
// that drew nothing. chartIndex null means the active chart; any other value has been checked
// against the layout by the caller.
//
// The drawings are those of graphics() of the study core, reached by the core model
// (getStudyById), as the renderers of the app read them: every set of the grouped maps (by style and
// by forceOverlay), in the order of the maps, and for tables also every cell of dwgtablecells, which
// are not grouped by forceOverlay and are joined to their table by tableId. Each drawing keeps the
// style id of the map it was in. The codes of the app (extend, style, yloc) are copied as they are.
// A number that is not finite, or a text that is none, is null. The id of a line or a table and
// the tableId of a cell are kept as text, a number as its text: the ids of the raw sets were never
// seen on the app, and its ready-made table view gives text ids.
//
// A point is the x of the drawing, a time-point index of the chart, as barIndex, with the time the
// bars of the chart give it: the row of the bar at that index (mainSeries().bars().valueAt), in the
// time base of data_get_ohlcv, and else, for an index with no loaded bar such as the empty space
// after the last bar, the time scale (indexToTimePoint) when it gives a time. barIndex is null
// where the app has no index, and time where no time is found.
//
// A color is the CSS color of the drawing: for a study whose metadata says isRGB the packed integer
// written as the app writes it (rgba(r,g,b,a) with a from 0 to 1), and else the color the palette
// of the study holds at that index. It is null for no color, for an index the palette lacks and
// for a value that is none.
//
// A Pine study that cannot be read whole (no graphics object, an accessor that is missing or fails,
// a set that cannot be iterated) is listed in unreadable and adds nothing; so is a study the chart
// lists but the core model does not know, or whose metadata cannot be read. When one study is asked
// for, that is CAPABILITY_UNAVAILABLE. A Pine study without graphics() fails the call with
// CAPABILITY_UNAVAILABLE too, before anything is returned, as does a page without the chart API or
// the core model. An id that is not a study of the chart, or a study that is not a Pine script, is
// INVALID_INPUT.
export function readPineGraphics(
  win: TvWindow,
  chartIndex: number | null,
  kind: PineDrawingKind,
  studyId: string | null,
):
  | {
      studies: {
        studyId: string;
        lines: {
          styleId: string;
          id: string | null;
          x1: { barIndex: number | null; time: number | null };
          y1: number | null;
          x2: { barIndex: number | null; time: number | null };
          y2: number | null;
          extend: string | null;
          style: string | null;
          width: number | null;
          color: string | null;
        }[];
        labels: {
          styleId: string;
          x: { barIndex: number | null; time: number | null };
          y: number | null;
          yloc: string | null;
          text: string | null;
          style: string | null;
          color: string | null;
          textColor: string | null;
        }[];
        boxes: {
          styleId: string;
          left: { barIndex: number | null; time: number | null };
          right: { barIndex: number | null; time: number | null };
          top: number | null;
          bottom: number | null;
          extend: string | null;
          text: string | null;
          borderColor: string | null;
          bgColor: string | null;
        }[];
        tables: {
          styleId: string;
          id: string | null;
          position: string | null;
          rows: number | null;
          columns: number | null;
        }[];
        cells: {
          tableId: string | null;
          row: number | null;
          column: number | null;
          text: string | null;
        }[];
      }[];
      unreadable: string[];
    }
  | PageErrorSentinel {
  const attempt = (read: () => unknown): unknown => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const number = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  // An id as text: a text that is not empty, or a finite number as its text.
  const idOf = (value: unknown): string | null =>
    typeof value === 'string' && value !== ''
      ? value
      : typeof value === 'number' && Number.isFinite(value)
        ? String(value)
        : null;
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  const chart = attempt(() =>
    chartIndex === null ? api?.activeChart?.() : api?.chart?.(chartIndex),
  ) as Partial<ChartWidgetApiLike> | null | undefined;
  if (typeof chart?.getAllStudies !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no chart API to read the studies from',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  const model = attempt(() => chart._chartWidget?.model()) as
    Partial<ChartModelLike> | null | undefined;
  const core = attempt(() => model?.model?.()) as Partial<CoreModelLike> | null | undefined;
  if (typeof core?.getStudyById !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no study model to read the drawings of Pine scripts from',
        hint: 'This TradingView build keeps the drawings of Pine scripts elsewhere. Check app_health.',
      },
    };
  }

  // The studies of the chart, by id (a number counts as its text), with the name the chart gives.
  const listed = attempt(() => chart.getAllStudies?.());
  const entries = (Array.isArray(listed) ? (listed as unknown[]) : []).flatMap((entry) => {
    const { id: rawId, name: rawName } = (entry ?? {}) as { id?: unknown; name?: unknown };
    const id = text(rawId) ?? (typeof rawId === 'number' ? String(rawId) : null);
    return id === null ? [] : [{ id, name: text(rawName) ?? id }];
  });
  if (studyId !== null && !entries.some(({ id }) => id === studyId)) {
    return {
      __tvmcpError: {
        code: 'INVALID_INPUT',
        message: `The chart has no study with the id ${studyId}`,
        hint: 'Call indicator_list for the ids of the studies on the chart.',
        details: { id: studyId },
      },
    };
  }

  // The times of the points: the rows of the bars first, then the time scale.
  const series = attempt(() => model?.mainSeries?.()) as Partial<SeriesLike> | null | undefined;
  const bars = attempt(() => series?.bars?.()) as Partial<BarsLike> | null | undefined;
  const timeScale = attempt(() => core.timeScale?.()) as Partial<TimeScaleLike> | null | undefined;
  const timeOf = (index: number): number | null => {
    const row = attempt(() => bars?.valueAt?.(index));
    const loaded = Array.isArray(row) ? number(row[0]) : null;
    return loaded ?? number(attempt(() => timeScale?.indexToTimePoint?.(index)));
  };
  const point = (x: unknown): { barIndex: number | null; time: number | null } => {
    const barIndex = number(x);
    return { barIndex, time: barIndex === null ? null : timeOf(barIndex) };
  };

  // The entries of a map and the items of a set, or null when it cannot be iterated. The sets of
  // the app are iterated by values(), as their entries() and keys() throw.
  const entriesOf = (map: unknown): [unknown, unknown][] | null => {
    try {
      const found: [unknown, unknown][] = [];
      for (const entry of map as Iterable<unknown>) {
        const [key, value] = Array.isArray(entry) ? (entry as unknown[]) : [];
        found.push([key, value]);
      }
      return found;
    } catch {
      return null;
    }
  };
  const itemsOf = (set: unknown): Record<string, unknown>[] | null => {
    try {
      const found: Record<string, unknown>[] = [];
      const holder = set as { values?: () => Iterable<unknown> };
      for (const item of typeof holder.values === 'function'
        ? holder.values()
        : (set as Iterable<unknown>)) {
        if (typeof item === 'object' && item !== null) {
          found.push(item as Record<string, unknown>);
        }
      }
      return found;
    } catch {
      return null;
    }
  };
  // Every item of a grouped accessor (style, then forceOverlay) with the style id it was in, and of
  // a regular one (style) the same way; null when the accessor is missing or something in it cannot
  // be iterated.
  const groupedItems = (
    graphics: Partial<StudyGraphicsLike>,
    accessor: 'dwglines' | 'dwglabels' | 'dwgboxes' | 'dwgtables',
  ) => {
    const styles = entriesOf(attempt(() => graphics[accessor]?.()));
    if (styles === null) {
      return null;
    }
    const found: { styleId: string; item: Record<string, unknown> }[] = [];
    for (const [style, byOverlay] of styles) {
      const sets = entriesOf(byOverlay);
      if (sets === null) {
        return null;
      }
      for (const [, set] of sets) {
        const items = itemsOf(set);
        if (items === null) {
          return null;
        }
        const styleId = text(style) ?? String(style);
        for (const item of items) {
          found.push({ styleId, item });
        }
      }
    }
    return found;
  };
  const regularItems = (graphics: Partial<StudyGraphicsLike>, accessor: 'dwgtablecells') => {
    const styles = entriesOf(attempt(() => graphics[accessor]?.()));
    if (styles === null) {
      return null;
    }
    const found: Record<string, unknown>[] = [];
    for (const [, set] of styles) {
      const items = itemsOf(set);
      if (items === null) {
        return null;
      }
      for (const item of items) {
        found.push(item);
      }
    }
    return found;
  };

  const studies = [];
  const unreadable: string[] = [];
  const wanted = studyId === null ? entries : entries.filter((entry) => entry.id === studyId);
  for (const { id, name } of wanted) {
    const study = attempt(() => core.getStudyById?.(id)) as
      Partial<StudyCoreLike> | null | undefined;
    const meta = attempt(() => study?.metaInfo?.()) as StudyMetaInfoLike | null | undefined;
    if (typeof study !== 'object' || study === null || typeof meta !== 'object' || meta === null) {
      unreadable.push(id);
      continue;
    }
    if (meta.pine === undefined) {
      if (studyId !== null) {
        return {
          __tvmcpError: {
            code: 'INVALID_INPUT',
            message: `The study ${id} (${name}) is not a Pine script, so it has no Pine drawings`,
            hint: 'Call indicator_list: isPine tells which studies on the chart are Pine scripts.',
            details: { id },
          },
        };
      }
      continue;
    }
    if (typeof study.graphics !== 'function') {
      return {
        __tvmcpError: {
          code: 'CAPABILITY_UNAVAILABLE',
          message: `The drawings of the study ${id} cannot be read on this page`,
          hint: 'This TradingView build keeps the drawings of Pine scripts elsewhere. Check app_health.',
          details: { id },
        },
      };
    }
    const graphics = attempt(() => study.graphics?.()) as
      Partial<StudyGraphicsLike> | null | undefined;
    if (typeof graphics !== 'object' || graphics === null) {
      unreadable.push(id);
      continue;
    }

    // The colors of the study: packed integers, or indices into its palette.
    const isRGB = meta.isRGB === true;
    const colors = attempt(() => {
      const palettes = study.properties?.().childs?.().palettes;
      return palettes?.childs?.().palette_common?.childs?.().colors?.childs?.();
    }) as Record<string, PropertyNodeLike | undefined> | null | undefined;
    const colorOf = (raw: unknown): string | null => {
      const index = number(raw);
      if (index === null) {
        return null;
      }
      if (!isRGB) {
        const entry = colors?.[index];
        return text(attempt(() => entry?.childs?.().color?.value?.()));
      }
      const packed = Math.round(index);
      if (packed < 0 || packed > 4_294_967_295) {
        return null;
      }
      const alpha = Math.floor(packed / 16_777_216);
      const red = packed % 256;
      const green = Math.floor(packed / 256) % 256;
      const blue = Math.floor(packed / 65_536) % 256;
      return `rgba(${String(red)},${String(green)},${String(blue)},${String(alpha / 255)})`;
    };

    const lines =
      kind === 'lines'
        ? groupedItems(graphics, 'dwglines')?.map(({ styleId, item }) => ({
            styleId,
            id: idOf(item.id),
            x1: point(item.x1),
            y1: number(item.y1),
            x2: point(item.x2),
            y2: number(item.y2),
            extend: text(item.extend),
            style: text(item.style),
            width: number(item.width),
            color: colorOf(item.colorIndex),
          }))
        : [];
    const labels =
      kind === 'labels'
        ? groupedItems(graphics, 'dwglabels')?.map(({ styleId, item }) => ({
            styleId,
            x: point(item.x),
            y: number(item.y),
            yloc: text(item.yloc),
            text: text(item.text),
            style: text(item.style),
            color: colorOf(item.colorIndex),
            textColor: colorOf(item.textColorIndex),
          }))
        : [];
    const boxes =
      kind === 'boxes'
        ? groupedItems(graphics, 'dwgboxes')?.map(({ styleId, item }) => ({
            styleId,
            left: point(item.left),
            right: point(item.right),
            top: number(item.top),
            bottom: number(item.bottom),
            extend: text(item.extend),
            text: text(item.text),
            borderColor: colorOf(item.borderColorIndex),
            bgColor: colorOf(item.backgroundColorIndex),
          }))
        : [];
    const tables =
      kind === 'tables'
        ? groupedItems(graphics, 'dwgtables')?.map(({ styleId, item }) => ({
            styleId,
            id: idOf(item.id),
            position: text(item.position),
            rows: number(item.rows),
            columns: number(item.columns),
          }))
        : [];
    const cells =
      kind === 'tables'
        ? regularItems(graphics, 'dwgtablecells')?.map((item) => ({
            tableId: idOf(item.tableId),
            row: number(item.row),
            column: number(item.column),
            text: text(item.text),
          }))
        : [];
    if (
      lines === undefined ||
      labels === undefined ||
      boxes === undefined ||
      tables === undefined ||
      cells === undefined
    ) {
      unreadable.push(id);
      continue;
    }
    studies.push({ studyId: id, lines, labels, boxes, tables, cells });
  }
  // The one study asked for has to be read, else there is nothing to report.
  if (studyId !== null && unreadable.length > 0) {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: `The drawings of the study ${studyId} could not be read`,
        hint: 'The study may still be loading: try again in a moment, or check app_health.',
        details: { id: studyId },
      },
    };
  }
  return { studies, unreadable };
}
