import { TvMcpError } from '../../core/errors.js';
import { toIso } from '../../utils/time.js';
import { isReportableTime } from '../chart/mappers.js';
import type { PageErrorSentinel } from '../../core/tv/page-bridge.js';
import type { editStudyInputs, readStudies, readStudyCatalog } from './page.js';

// How the indicator tools turn what the app holds into what they report: the keys of the plots of a
// study, its value rows, the matches of an indicator search, the indicator a name stands for, and
// the input values a change may set.

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

// A study on a chart as indicator_list reports it (readStudies), and one of its inputs.
export type StudyInfo = Exclude<
  ReturnType<typeof readStudies>,
  PageErrorSentinel
>['studies'][number];
export type StudyInput = StudyInfo['inputs'][number];

// An input with what a change of its value is checked against (editStudyInputs): its type, its
// options and the bounds of its metadata.
export type InputSpec = Exclude<
  ReturnType<typeof editStudyInputs>,
  PageErrorSentinel
>['inputs'][number];

// The value an input can be given.
export type InputValue = string | number | boolean;

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

// The indicator indicator_add adds for a name: an exact id of the catalog (the scriptIdPart of a
// standard Pine script or the metadata id of a visible built-in), else the first item whose name or
// short name equals it, case aside, standard Pine scripts before built-ins. null when nothing
// matches. Hidden built-ins are not in the catalog, so they are never chosen. A script without a
// version gets the latest one ("last").
export type ResolvedIndicator =
  | { kind: 'pine'; id: string; name: string; version: string }
  | { kind: 'builtin'; id: string; name: string };

export function resolveIndicator(
  catalog: IndicatorCatalog,
  name: string,
): ResolvedIndicator | null {
  const wanted = name.trim();
  if (wanted === '') {
    return null;
  }
  const scripts = catalog.scripts ?? [];
  const builtins = catalog.builtins ?? [];
  const lower = wanted.toLowerCase();
  const named = (item: { name: string; shortName: string }): boolean =>
    item.name.toLowerCase() === lower || item.shortName.toLowerCase() === lower;
  const script =
    scripts.find(({ id }) => id === wanted) ??
    (builtins.some(({ id }) => id === wanted) ? undefined : scripts.find(named));
  if (script !== undefined) {
    return { kind: 'pine', id: script.id, name: script.name, version: script.version ?? 'last' };
  }
  const builtin = builtins.find(({ id }) => id === wanted) ?? builtins.find(named);
  return builtin === undefined ? null : { kind: 'builtin', id: builtin.id, name: builtin.name };
}

// The inputs as indicator_list reports them: options only when they are all text.
export function toStudyInputs(specs: readonly InputSpec[]): StudyInput[] {
  return specs.map(({ id, name, type, value, options }) => ({
    id,
    name,
    type,
    value,
    options: options?.every((option) => typeof option === 'string') ? options.map(String) : null,
  }));
}

// What a value has to be for each type of input.
const NUMBER_TYPES = new Set(['integer', 'float', 'price']);
const TEXT_TYPES = new Set([
  'text',
  'source',
  'resolution',
  'session',
  'symbol',
  'color',
  'text_area',
]);
const TIME_TYPES = new Set(['time', 'bar_time']);

// Why a value does not suit an input, or null when it does.
function problemWith(spec: InputSpec, value: InputValue): string | null {
  const label = spec.name === spec.id ? spec.id : `${spec.name} (${spec.id})`;
  const got = `got ${JSON.stringify(value)}`;
  if (NUMBER_TYPES.has(spec.type)) {
    const kind = spec.type === 'integer' ? 'an integer' : 'a number';
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return `${label} must be ${kind} (${got})`;
    }
    if (spec.type === 'integer' && !Number.isInteger(value)) {
      return `${label} must be an integer (${got})`;
    }
    const { min, max } = spec;
    if ((min !== null && value < min) || (max !== null && value > max)) {
      const range =
        min !== null && max !== null
          ? `from ${String(min)} to ${String(max)}`
          : min !== null
            ? `at least ${String(min)}`
            : `at most ${String(max)}`;
      return `${label} must be ${kind} ${range} (${got})`;
    }
  } else if (spec.type === 'bool') {
    if (typeof value !== 'boolean') {
      return `${label} must be true or false (${got})`;
    }
  } else if (TEXT_TYPES.has(spec.type)) {
    if (typeof value !== 'string') {
      return `${label} must be text (${got})`;
    }
  } else if (TIME_TYPES.has(spec.type)) {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return `${label} must be a time in Unix milliseconds (${got})`;
    }
  } else {
    return `${label} has the type ${spec.type || 'unknown'}, which this tool cannot set`;
  }
  if (spec.options !== null && !spec.options.includes(value as string | number)) {
    return `${label} must be one of ${spec.options.map(String).join(', ')} (${got})`;
  }
  return null;
}

// The values to set for `inputs`, keyed by input id or by name (case aside), checked against the
// inputs a study has (hidden ones left out): numbers must be finite and within the bounds of the
// metadata, an integer whole, a bool a boolean, text inputs text, and a value of an input with
// options one of them. Every problem is collected, and any problem fails the whole set with
// INVALID_INPUT, so that nothing is set by halves.
export function validateInputs(
  specs: readonly InputSpec[],
  inputs: Readonly<Record<string, InputValue>>,
): { id: string; value: InputValue }[] {
  const problems: string[] = [];
  const values: { id: string; value: InputValue }[] = [];
  for (const [key, value] of Object.entries(inputs)) {
    const spec =
      specs.find(({ id }) => id === key) ??
      specs.find(({ name }) => name.toLowerCase() === key.toLowerCase());
    if (spec === undefined) {
      problems.push(`${key} is not an input of this indicator`);
      continue;
    }
    if (values.some(({ id }) => id === spec.id)) {
      problems.push(`${key} names the input ${spec.id} more than once`);
      continue;
    }
    const problem = problemWith(spec, value);
    if (problem === null) {
      values.push({ id: spec.id, value });
    } else {
      problems.push(problem);
    }
  }
  if (problems.length > 0) {
    const valid = specs.map(({ id, name }) => (name === id ? id : `${id} (${name})`)).join(', ');
    throw new TvMcpError(
      'INVALID_INPUT',
      `Invalid inputs: ${problems.join('; ')}. The inputs of this indicator are: ${valid || 'none'}`,
      {
        hint:
          'Name each input by its id or its name as indicator_list reports them, with a value of ' +
          'its type. Nothing was changed.',
        details: {
          problems,
          validInputs: specs.map(({ id, name, type }) => ({ id, name, type })),
        },
      },
    );
  }
  return values;
}
