import { toIso } from '../../utils/time.js';
import { isReportableTime } from '../chart/mappers.js';
import type { PageErrorSentinel } from '../../core/tv/page-bridge.js';
import type { readStudyCatalog } from './page.js';

// How the indicator tools turn what the app holds into what they report: the keys of the plots of a
// study, its value rows, and the matches of an indicator search.

// Plot types that hold no value of their own: every colorer (a palette index for the plot or fill
// it colors), the offset of the data plots, and an alert condition.
const NON_VALUE_PLOT = /colorer$|^dataoffset$|^alertcondition$/;

// The entities the app writes plot titles with.
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

// A title with its HTML entities decoded: the named ones above and numeric ones. Anything else is
// left as written.
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });
}

// The value plots of a study and the key each value is reported under, in the order of the plots:
// index is the position of the plot among all plots, so its value is slot index + 1 of a row. The
// key is the title of the plot in styles, or for an ohlc_* plot the title of the bars it draws in
// ohlcPlots, decoded, and else the plot id. A key that is taken already gets #2, #3 and so on, so
// that keys are unique and stable from call to call. Colorers, dataoffset and alertcondition plots
// are left out.
export function plotKeys(
  plots: readonly { id: string; type: string; target?: string | null }[],
  styles: Readonly<Record<string, { title?: string } | undefined>>,
  ohlcPlots: Readonly<Record<string, { title?: string } | undefined>> = {},
): { index: number; key: string }[] {
  const taken = new Set<string>();
  const keys: { index: number; key: string }[] = [];
  plots.forEach((plot, index) => {
    if (NON_VALUE_PLOT.test(plot.type)) {
      return;
    }
    const raw = plot.type.startsWith('ohlc_')
      ? plot.target == null
        ? undefined
        : ohlcPlots[plot.target]?.title
      : styles[plot.id]?.title;
    const title = raw === undefined ? '' : decodeEntities(raw).trim();
    const base = title === '' ? plot.id : title;
    let key = base;
    for (let number = 2; taken.has(key); number += 1) {
      key = `${base}#${String(number)}`;
    }
    taken.add(key);
    keys.push({ index, key });
  });
  return keys;
}

// The value rows of a study as indicator_get_values reports them: the time in Unix seconds and as
// ISO, and the value of each keyed plot, null where the row has no finite number. A row without a
// reportable time is dropped.
export function toValueRows(
  rows: readonly (readonly (number | null)[])[],
  keys: readonly { index: number; key: string }[],
) {
  return rows.flatMap((row) => {
    const time = row[0];
    if (!isReportableTime(time)) {
      return [];
    }
    const values: Record<string, number | null> = {};
    for (const { index, key } of keys) {
      const value = row[index + 1];
      values[key] = typeof value === 'number' && Number.isFinite(value) ? value : null;
    }
    return [{ time, timeIso: toIso(time), values }];
  });
}

// What the app knows of the indicators it can add (readStudyCatalog).
export type IndicatorCatalog = Exclude<
  Awaited<ReturnType<typeof readStudyCatalog>>,
  PageErrorSentinel
>;

// A standard Pine script of the catalog, with the script version a Pine study descriptor takes.
export type StandardScript = NonNullable<IndicatorCatalog['scripts']>[number];

// The indicators whose name or short name contains the query, case aside: the standard Pine
// scripts first, which are what the indicator dialog of the app inserts, then the built-in studies,
// each in the order of the app, at most `limit` of them. id is what indicator_add takes: the
// scriptIdPart of a standard Pine script (kind pine), or the metadata id of a built-in study (kind
// builtin).
export function searchCatalog(catalog: IndicatorCatalog, query: string, limit: number) {
  const wanted = query.trim().toLowerCase();
  const matches = (item: { name: string; shortName: string }): boolean =>
    item.name.toLowerCase().includes(wanted) || item.shortName.toLowerCase().includes(wanted);
  const result =
    (kind: 'pine' | 'builtin') =>
    ({
      name,
      shortName,
      id,
      isStrategy,
    }: {
      name: string;
      shortName: string;
      id: string;
      isStrategy: boolean;
    }) => ({
      name,
      shortName,
      id,
      kind,
      isStrategy,
    });
  return [
    ...(catalog.scripts ?? []).filter(matches).map(result('pine')),
    ...(catalog.builtins ?? []).filter(matches).map(result('builtin')),
  ].slice(0, limit);
}
