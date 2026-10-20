import type { TvWindow } from '../../src/core/tv/tv-window.js';
import type { JsonValue } from '../../src/utils/json.js';

// The shapes of what the app holds for the studies on the chart, which the recorder writes next to
// a fixture, so that the fake app can be checked against them after a TradingView update: for each
// study, whether it is a Pine script and whether it is a strategy, and the key names and the types
// of the values of its metaInfo() plots and styles, of getInputsInfo(), of the members of
// getStudyById(id) and, for a strategy, of its report. Never a value: no input value, price, name,
// title, text or id of the user. A page function, so that it runs in the page (see page-bridge.ts),
// and in a module of its own, because record-fixtures.ts runs when it is imported.
//
// A shape is a type name for a value ("number", "string", ...; several joined by "|" for the items
// of an array that differ), an object of the shapes of its members, by name, or an array holding the
// shape all its items share (the members of each object item merged), empty for an empty array. A
// map whose keys are ids (the styles by plot id) is written with the one key "<id>". Objects deeper
// than six levels are written "object". scrubStudyShapes (scrub.ts) checks every shape before it
// is written.
export function readStudyShapes(win: TvWindow): {
  studies: {
    pine: boolean;
    strategy: boolean;
    plots: JsonValue;
    styles: JsonValue;
    inputs: JsonValue;
    api: JsonValue;
    report: JsonValue;
  }[];
} {
  const attempt = (read: () => unknown): unknown => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const typeName = (value: unknown): string =>
    value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  // The shape two items share: the members of objects merged, other differences joined by "|".
  const merge = (a: JsonValue, b: JsonValue): JsonValue => {
    if (
      typeof a === 'object' &&
      a !== null &&
      !Array.isArray(a) &&
      typeof b === 'object' &&
      b !== null &&
      !Array.isArray(b)
    ) {
      const merged: Record<string, JsonValue> = { ...a };
      for (const [key, value] of Object.entries(b)) {
        const known = merged[key];
        merged[key] = known === undefined ? value : merge(known, value);
      }
      return merged;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      const [first] = a;
      const [second] = b;
      return first === undefined ? b : second === undefined ? a : [merge(first, second)];
    }
    if (typeof a === 'string' && typeof b === 'string') {
      return [...new Set([...a.split('|'), ...b.split('|')])].sort().join('|');
    }
    return JSON.stringify(a) === JSON.stringify(b) ? a : 'mixed';
  };
  const shapeOf = (value: unknown, depth: number): JsonValue => {
    if (Array.isArray(value)) {
      const items = (value as unknown[]).slice(0, 50).map((item) => shapeOf(item, depth - 1));
      const [first, ...rest] = items;
      return first === undefined ? [] : [rest.reduce(merge, first)];
    }
    if (typeof value === 'object' && value !== null) {
      if (depth <= 0) {
        return 'object';
      }
      const shape: Record<string, JsonValue> = {};
      for (const key of Object.keys(value).sort()) {
        shape[key] = shapeOf(
          attempt(() => (value as Record<string, unknown>)[key]),
          depth - 1,
        );
      }
      return shape;
    }
    return typeName(value);
  };
  // A map by id: the shape its values share, under the one key "<id>".
  const mapShape = (value: unknown): JsonValue => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return typeName(value);
    }
    const shapes = Object.keys(value).map((key) =>
      shapeOf(
        attempt(() => (value as Record<string, unknown>)[key]),
        5,
      ),
    );
    const [first, ...rest] = shapes;
    return first === undefined ? {} : { '<id>': rest.reduce(merge, first) };
  };
  // The members of an object, its own and those of its prototypes but the last one (the
  // Object.prototype of whichever realm made it), with the types of their values.
  const membersOf = (owner: unknown): JsonValue => {
    if (typeof owner !== 'object' || owner === null) {
      return typeName(owner);
    }
    const names = new Set<string>();
    for (
      let level: object | null = owner;
      level !== null && Object.getPrototypeOf(level) !== null;
      level = Object.getPrototypeOf(level) as object | null
    ) {
      for (const name of Object.getOwnPropertyNames(level)) {
        if (name !== 'constructor') {
          names.add(name);
        }
      }
    }
    const members: Record<string, JsonValue> = {};
    for (const name of [...names].sort()) {
      members[name] = typeName(attempt(() => (owner as Record<string, unknown>)[name]));
    }
    return members;
  };

  const chart = attempt(() => win.TradingViewApi?.activeChart()) as
    | {
        getAllStudies?: () => { id?: unknown }[];
        getStudyById?: (id: string) => unknown;
      }
    | undefined;
  const listed = attempt(() => chart?.getAllStudies?.());
  const studies = (Array.isArray(listed) ? listed : []).map((item: { id?: unknown }) => {
    const id = String(item.id);
    const api = attempt(() => chart?.getStudyById?.(id)) as
      { study?: () => unknown; getInputsInfo?: () => unknown } | undefined;
    const core = attempt(() => api?.study?.()) as
      | {
          metaInfo?: () => { plots?: unknown; styles?: unknown; pine?: unknown } | null;
          isStudyStrategy?: unknown;
          reportData?: () => unknown;
        }
      | undefined;
    const meta = attempt(() => core?.metaInfo?.()) as
      { plots?: unknown; styles?: unknown; pine?: unknown } | null | undefined;
    const strategy = core?.isStudyStrategy === true;
    return {
      pine: meta?.pine !== undefined && meta.pine !== null,
      strategy,
      plots: shapeOf(meta?.plots, 4),
      styles: mapShape(meta?.styles),
      inputs: shapeOf(
        attempt(() => api?.getInputsInfo?.()),
        4,
      ),
      api: membersOf(api),
      report:
        strategy && typeof core.reportData === 'function'
          ? shapeOf(
              attempt(() => core.reportData?.()),
              6,
            )
          : null,
    };
  });
  return { studies };
}
