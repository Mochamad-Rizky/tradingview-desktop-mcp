import type { ErrorCode } from '../../core/errors.js';
import type { PageErrorSentinel } from '../../core/tv/page-bridge.js';
import type { PageLib } from '../../core/tv/page-lib.js';
import type {
  ChartWidgetApiLike,
  CreateShapeOptionsLike,
  LineDataSourceApiLike,
  LineToolRegistryLike,
  TradingViewApiLike,
  TvWindow,
} from '../../core/tv/tv-window.js';
import type { JsonObject } from '../../utils/json.js';

// The page functions of the drawing tools (reverse-engineering notes of Plan 3, section 1). The
// page bridge sends the source text of each one into the page, so each uses nothing of this file,
// only its parameters and the globals of the page, and whatever it shares with another is written
// out in both. Types are erased, so the type imports above are fine.
//
// A chartIndex of null means the active chart; any other value has been checked against the layout
// by the caller. Members of the app are read defensively: another web build can drop or reshape any
// of them, and a read that throws counts as no answer. The readers change nothing. createDrawing
// draws, removeDrawing (with confirmed) and removeDrawings remove; each says CAPABILITY_UNAVAILABLE
// only before it acts. Nothing here calls removeAllShapes, which opens a confirmation dialog over a
// locked drawing, or the setters of a drawing.

// What drawing_create asks createDrawing for. A type alias, not an interface: it goes to the page as
// JSON, which a type must satisfy JsonValue for.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type DrawingRequest = {
  // The API name of the tool, and the class of the tool by the table of the server, for a page
  // without supportedLineTools.
  shape: string;
  className: string;
  // Unix seconds and prices, as many as the shape takes.
  points: { time: number; price: number }[];
  // Null to draw without a text.
  text: string | null;
  // The style, by the property keys of the shape.
  overrides: Record<string, string | number>;
  // The point count to confirm with the line-tool registry before drawing, for a shape whose count
  // was not seen on the app; null to draw without asking it.
  verifyCount: number | null;
  // The properties to read back from the new drawing.
  readKeys: string[];
};

// A page of the drawings on a chart: total counts them all, and drawings holds those from offset,
// at most limit, in the order getAllShapes lists them, each with its type, its points (a point
// whose time or price is not a finite number left out) and its text (null when empty or none). Only
// the drawings of the page are read. A drawing that cannot be read whole is listed with what could
// be read and its id goes to unreadable.
export function readDrawings(
  win: TvWindow,
  chartIndex: number | null,
  offset: number,
  limit: number,
):
  | {
      total: number;
      drawings: {
        id: string;
        shape: string;
        points: { time: number; price: number }[];
        text: string | null;
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
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  const chart = attempt(() =>
    chartIndex === null ? api?.activeChart?.() : api?.chart?.(chartIndex),
  ) as Partial<ChartWidgetApiLike> | null | undefined;
  if (typeof chart?.getAllShapes !== 'function' || typeof chart.getShapeById !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no chart API to read the drawings from',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  const listed = attempt(() => chart.getAllShapes?.());
  const entries = (Array.isArray(listed) ? (listed as unknown[]) : []).flatMap((entry) => {
    const { id, name } = (entry ?? {}) as { id?: unknown; name?: unknown };
    return typeof id === 'string' ? [{ id, shape: typeof name === 'string' ? name : '' }] : [];
  });
  const unreadable: string[] = [];
  const drawings = entries.slice(offset, offset + limit).map(({ id, shape }) => {
    let whole = true;
    const read = (call: () => unknown): unknown => {
      try {
        return call();
      } catch {
        whole = false;
        return undefined;
      }
    };
    const source = read(() => chart.getShapeById?.(id)) as
      Partial<LineDataSourceApiLike> | null | undefined;
    if (typeof source?.getPoints !== 'function' || typeof source.getProperties !== 'function') {
      whole = false;
    }
    const rawPoints = read(() => source?.getPoints?.());
    const properties = read(() => source?.getProperties?.()) as
      Record<string, unknown> | null | undefined;
    if (!whole) {
      unreadable.push(id);
    }
    const points = (Array.isArray(rawPoints) ? (rawPoints as unknown[]) : []).flatMap((point) => {
      const { time, price } = (point ?? {}) as { time?: unknown; price?: unknown };
      return typeof time === 'number' &&
        Number.isFinite(time) &&
        typeof price === 'number' &&
        Number.isFinite(price)
        ? [{ time, price }]
        : [];
    });
    const text: unknown = properties?.text;
    return { id, shape, points, text: typeof text === 'string' && text !== '' ? text : null };
  });
  return { total: entries.length, drawings, unreadable };
}

// The ids of the drawings on a chart, in the order getAllShapes lists them.
export function readDrawingIds(
  win: TvWindow,
  chartIndex: number | null,
): { ids: string[] } | PageErrorSentinel {
  let chart: Partial<ChartWidgetApiLike> | null | undefined;
  try {
    const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
    chart = chartIndex === null ? api?.activeChart?.() : api?.chart?.(chartIndex);
  } catch {
    chart = undefined;
  }
  if (typeof chart?.getAllShapes !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no chart API to read the drawings from',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  let listed: unknown;
  try {
    listed = chart.getAllShapes();
  } catch {
    listed = [];
  }
  return {
    ids: (Array.isArray(listed) ? (listed as unknown[]) : []).flatMap((entry) => {
      const id: unknown = (entry as { id?: unknown } | null | undefined)?.id;
      return typeof id === 'string' ? [id] : [];
    }),
  };
}

// One drawing: its type, points and text as readDrawings reads them, the properties of `keys` it
// has with a text, number or boolean value, whether it is locked (frozen, the lock of the
// interface, or made with lock: true, which isUserEditEnabled reports) and whether it is hidden
// (isHidden, else its visible property). An id that is not a drawing of the chart is INVALID_INPUT,
// and so is a listed one TradingView says is gone; any other failure to read it is
// PAGE_EVALUATION_FAILED.
export function readDrawing(
  win: TvWindow,
  chartIndex: number | null,
  id: string,
  keys: string[],
):
  | {
      id: string;
      shape: string;
      points: { time: number; price: number }[];
      text: string | null;
      properties: Record<string, string | number | boolean>;
      locked: boolean;
      hidden: boolean;
    }
  | PageErrorSentinel {
  const attempt = (read: () => unknown): unknown => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  const chart = attempt(() =>
    chartIndex === null ? api?.activeChart?.() : api?.chart?.(chartIndex),
  ) as Partial<ChartWidgetApiLike> | null | undefined;
  if (typeof chart?.getAllShapes !== 'function' || typeof chart.getShapeById !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no chart API to read the drawings from',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  const notADrawing: PageErrorSentinel = {
    __tvmcpError: {
      code: 'INVALID_INPUT',
      message: `The chart has no drawing with the id ${id}`,
      hint: 'Call drawing_list for the ids of the drawings on the chart.',
      details: { id },
    },
  };
  const listed = attempt(() => chart.getAllShapes?.());
  const entry = (Array.isArray(listed) ? (listed as unknown[]) : []).find(
    (item) => (item as { id?: unknown } | null | undefined)?.id === id,
  ) as { name?: unknown } | undefined;
  if (entry === undefined) {
    return notADrawing;
  }
  let source: Partial<LineDataSourceApiLike> | null | undefined;
  let reason = 'no answer';
  try {
    source = chart.getShapeById(id);
  } catch (error) {
    const message: unknown = (error as { message?: unknown } | null | undefined)?.message;
    reason = typeof message === 'string' ? message : String(error);
  }
  if (typeof source !== 'object' || source === null) {
    return /no such shape/i.test(reason)
      ? notADrawing
      : {
          __tvmcpError: {
            code: 'PAGE_EVALUATION_FAILED',
            message: `The drawing ${id} could not be read: ${reason}`,
            details: { id },
          },
        };
  }
  const drawing = source;
  const rawPoints = attempt(() => drawing.getPoints?.());
  const raw = attempt(() => drawing.getProperties?.()) as
    Record<string, unknown> | null | undefined;
  const properties: Record<string, string | number | boolean> = {};
  for (const key of keys) {
    const value: unknown =
      raw !== null && raw !== undefined && Object.hasOwn(raw, key) ? raw[key] : undefined;
    if (
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      properties[key] = value;
    }
  }
  const text: unknown = raw?.text;
  return {
    id,
    shape: typeof entry.name === 'string' ? entry.name : '',
    points: (Array.isArray(rawPoints) ? (rawPoints as unknown[]) : []).flatMap((point) => {
      const { time, price } = (point ?? {}) as { time?: unknown; price?: unknown };
      return typeof time === 'number' &&
        Number.isFinite(time) &&
        typeof price === 'number' &&
        Number.isFinite(price)
        ? [{ time, price }]
        : [];
    }),
    text: typeof text === 'string' && text !== '' ? text : null,
    properties,
    locked: raw?.frozen === true || attempt(() => drawing.isUserEditEnabled?.()) === false,
    hidden:
      typeof drawing.isHidden === 'function'
        ? attempt(() => drawing.isHidden?.()) === true
        : raw?.visible === false,
  };
}

// Draws a shape with createShape (one point) or createMultipointShape (more), the shape, the text
// and the overrides in the creation options, never disableUndo, so the drawing goes into the undo
// history of the app; and answers its id, with the properties of readKeys read back from it (null
// when they cannot be read). Before anything is drawn:
// - the gate of the app is read without going through it, since its sign-in wall and paywall are
//   dialogs: signed out (window.is_authenticated false) is AUTH_REQUIRED, the treatment of the
//   drawings experiment (getDrawingsExperimentVariation) NOT_AVAILABLE, and either one that cannot
//   be read NOT_AVAILABLE as well;
// - a page whose supportedLineTools does not list the shape, which the app would draw as a flag, is
//   refused, and the class of the tool is taken from it when it has one;
// - with verifyCount, the line-tool registry loads the class of the tool, as createShape does on
//   its way, and its pointsCount must be verifyCount or -1 (any count); a count that cannot be read
//   is refused.
// A refusal of the app is INVALID_INPUT for a wrong point count and for a text the tool takes
// none of, PAGE_EVALUATION_FAILED with its message otherwise; a creation that does not settle
// within waitMs is TIMEOUT.
export function createDrawing(
  win: TvWindow,
  lib: PageLib,
  chartIndex: number | null,
  request: DrawingRequest,
  waitMs: number,
):
  | Promise<
      | { id: string; properties: Record<string, string | number | boolean> | null }
      | PageErrorSentinel
    >
  | PageErrorSentinel {
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  let found: Partial<ChartWidgetApiLike> | null | undefined;
  try {
    found = chartIndex === null ? api?.activeChart?.() : api?.chart?.(chartIndex);
  } catch {
    found = undefined;
  }
  const noChartApi: PageErrorSentinel = {
    __tvmcpError: {
      code: 'CAPABILITY_UNAVAILABLE',
      message: 'This page has no chart API to draw with',
      hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
    },
  };
  if (
    typeof found?.createShape !== 'function' &&
    typeof found?.createMultipointShape !== 'function'
  ) {
    return noChartApi;
  }
  const chart = found;
  // Looked up first, all of them, before anything is asked.
  const variationOf = lib.findExport('getDrawingsExperimentVariation');
  const supported = lib.findExport('supportedLineTools');
  const registry = lib.findModuleWith([
    'ensureLineToolLoaded',
    'getLoadedLineTool',
  ]) as Partial<LineToolRegistryLike> | null;
  const refuse = (
    code: ErrorCode,
    message: string,
    hint: string,
    details?: JsonObject,
  ): PageErrorSentinel => ({
    __tvmcpError: { code, message, hint, ...(details === undefined ? {} : { details }) },
  });

  if (win.is_authenticated === false) {
    return refuse(
      'AUTH_REQUIRED',
      'Drawing needs a signed-in TradingView account',
      'Sign in to TradingView, then draw again.',
    );
  }
  if (win.is_authenticated !== true) {
    return refuse(
      'NOT_AVAILABLE',
      'This page does not say whether an account is signed in, which drawing needs',
      'Check app_health: the app may still be loading.',
    );
  }
  const readVariation = (): { value: unknown } | null => {
    if (typeof variationOf !== 'function') {
      return null;
    }
    try {
      return { value: (variationOf as () => unknown)() };
    } catch {
      return null;
    }
  };
  const variation = readVariation();
  if (variation === null) {
    return refuse(
      'NOT_AVAILABLE',
      'This TradingView build does not tell whether drawings are gated on this account',
      'Draw in TradingView itself.',
    );
  }
  if (variation.value === 'treatment') {
    return refuse(
      'NOT_AVAILABLE',
      'TradingView gates drawing on this account',
      'Drawings are gated on this account: TradingView would open its upgrade dialog. Draw in ' +
        'TradingView itself.',
    );
  }

  const { shape, points, text, overrides, verifyCount, readKeys } = request;
  const article = /^[aeiou]/.test(shape) ? 'an' : 'a';
  let className = request.className;
  if (typeof supported === 'object' && supported !== null) {
    const tools = supported as Record<string, unknown>;
    const entry: unknown = Object.hasOwn(tools, shape) ? tools[shape] : undefined;
    if (typeof entry !== 'object' || entry === null) {
      return refuse(
        'NOT_AVAILABLE',
        `This TradingView build has no ${shape} drawing tool, so it would draw a flag instead`,
        'Choose another shape, or draw it in TradingView itself.',
        { shape },
      );
    }
    const name: unknown = (entry as { name?: unknown }).name;
    if (typeof name === 'string' && name !== '') {
      className = name;
    }
  }
  const first = points[0];
  const single = points.length === 1 && first !== undefined;
  if (
    (single && typeof chart.createShape !== 'function') ||
    (!single && typeof chart.createMultipointShape !== 'function')
  ) {
    return noChartApi;
  }

  const started = Date.now();
  // How a call ended, or late when it did not end in the time that is left of waitMs.
  const settle = (
    call: () => unknown,
  ): Promise<{ value: unknown } | { error: unknown } | { late: true }> => {
    let ended: Promise<{ value: unknown } | { error: unknown }>;
    try {
      ended = Promise.resolve(call()).then(
        (value: unknown) => ({ value }),
        (error: unknown) => ({ error }),
      );
    } catch (error) {
      ended = Promise.resolve({ error });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<{ late: true }>((resolve) => {
      timer = setTimeout(
        () => {
          resolve({ late: true });
        },
        Math.max(started + waitMs - Date.now(), 0),
      );
    });
    return Promise.race([ended, late]).then((outcome) => {
      clearTimeout(timer);
      return outcome;
    });
  };
  const reasonOf = (error: unknown): string => {
    const message: unknown = (error as { message?: unknown } | null | undefined)?.message;
    return typeof error === 'string'
      ? error
      : typeof message === 'string'
        ? message
        : String(error);
  };
  const unconfirmed = (): PageErrorSentinel =>
    refuse(
      'NOT_AVAILABLE',
      `How many points TradingView takes for ${article} ${shape} drawing cannot be confirmed on ` +
        'this build',
      'Draw it in TradingView itself, or choose a shape whose point count was seen on the app: ' +
        'horizontal_line, rectangle or text.',
      { shape },
    );

  // The point count by the registry, null when it agrees.
  const confirmCount = async (): Promise<PageErrorSentinel | null> => {
    if (verifyCount === null) {
      return null;
    }
    if (
      typeof registry?.ensureLineToolLoaded !== 'function' ||
      typeof registry.getLoadedLineTool !== 'function'
    ) {
      return unconfirmed();
    }
    const tools = registry as LineToolRegistryLike;
    const loaded = await settle(() => tools.ensureLineToolLoaded(className));
    if ('late' in loaded) {
      return refuse(
        'TIMEOUT',
        `TradingView did not load the ${shape} drawing tool within ${String(waitMs)} ms`,
        'Nothing was drawn. Try again in a moment.',
        { waitMs },
      );
    }
    if ('error' in loaded) {
      return unconfirmed();
    }
    let count: unknown;
    try {
      count = tools.getLoadedLineTool(className).prototype.pointsCount();
    } catch {
      return unconfirmed();
    }
    if (typeof count !== 'number' || !Number.isFinite(count)) {
      return unconfirmed();
    }
    if (count !== -1 && count !== verifyCount) {
      return refuse(
        'NOT_AVAILABLE',
        `TradingView takes ${String(count)} point${count === 1 ? '' : 's'} for ${article} ` +
          `${shape} drawing, where this server expects ${String(verifyCount)}`,
        'This TradingView build differs from the one the server knows: draw the shape in ' +
          'TradingView itself.',
        { shape, expected: verifyCount, reported: count },
      );
    }
    return null;
  };

  // The asked properties of the new drawing, null when they cannot be read.
  const readBack = (id: string): Record<string, string | number | boolean> | null => {
    try {
      const source = chart.getShapeById?.(id) as Partial<LineDataSourceApiLike> | null | undefined;
      const raw: unknown = source?.getProperties?.();
      if (typeof raw !== 'object' || raw === null) {
        return null;
      }
      const picked: Record<string, string | number | boolean> = {};
      for (const key of readKeys) {
        const value: unknown = Object.hasOwn(raw, key)
          ? (raw as Record<string, unknown>)[key]
          : undefined;
        if (
          typeof value === 'string' ||
          typeof value === 'boolean' ||
          (typeof value === 'number' && Number.isFinite(value))
        ) {
          picked[key] = value;
        }
      }
      return picked;
    } catch {
      return null;
    }
  };

  const draw = async (): Promise<
    { id: string; properties: Record<string, string | number | boolean> | null } | PageErrorSentinel
  > => {
    const refused = await confirmCount();
    if (refused !== null) {
      return refused;
    }
    const options: CreateShapeOptionsLike = {
      shape,
      ...(text === null ? {} : { text }),
      ...(Object.keys(overrides).length === 0 ? {} : { overrides }),
    };
    const method = single ? 'createShape' : 'createMultipointShape';
    const made = await settle(() =>
      single ? chart.createShape?.(first, options) : chart.createMultipointShape?.(points, options),
    );
    if ('late' in made) {
      return refuse(
        'TIMEOUT',
        `TradingView did not create the drawing within ${String(waitMs)} ms`,
        'It may still appear on the chart: check drawing_list. This session could not record ' +
          'it, so drawing_remove needs confirm: true for it.',
        { waitMs },
      );
    }
    if ('error' in made) {
      const reason = reasonOf(made.error);
      if (reason.startsWith('Wrong points count')) {
        return refuse(
          'INVALID_INPUT',
          `TradingView refused the points: ${reason}`,
          'Give the number of points the shape takes. drawing_list shows whether a half-made ' +
            'drawing was left behind.',
          { shape, reason },
        );
      }
      if (text !== null && reason === 'Value is undefined') {
        return refuse(
          'INVALID_INPUT',
          `TradingView takes no text for ${article} ${shape} drawing`,
          'Leave text out for this shape, or draw a text or note next to it.',
          { shape },
        );
      }
      return refuse(
        'PAGE_EVALUATION_FAILED',
        `TradingView did not create the drawing: ${reason}`,
        'Check drawing_list, and that the chart shows bars.',
        { shape, reason },
      );
    }
    const id = made.value;
    if (typeof id !== 'string' || id === '') {
      return refuse(
        'PAGE_EVALUATION_FAILED',
        `TradingView answered ${method} with something that is no drawing id`,
        'Check drawing_list.',
      );
    }
    return { id, properties: readBack(id) };
  };
  return draw();
}

// Removes one drawing with removeEntity, the way the user could undo, which removes a locked one
// too; without confirmed it only checks that the drawing is there and removes nothing. Answers
// whether it removed it and the type of the drawing. An id that is not a drawing of the chart is
// INVALID_INPUT either way, and a drawing that is still there afterwards NOT_AVAILABLE.
export function removeDrawing(
  win: TvWindow,
  chartIndex: number | null,
  id: string,
  confirmed: boolean,
): { removed: boolean; shape: string } | PageErrorSentinel {
  const attempt = (read: () => unknown): unknown => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  const chart = attempt(() =>
    chartIndex === null ? api?.activeChart?.() : api?.chart?.(chartIndex),
  ) as Partial<ChartWidgetApiLike> | null | undefined;
  if (typeof chart?.getAllShapes !== 'function' || typeof chart.removeEntity !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no chart API to remove drawings with',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  const entryOf = (): { name?: unknown } | undefined => {
    const listed = attempt(() => chart.getAllShapes?.());
    return (Array.isArray(listed) ? (listed as unknown[]) : []).find(
      (item) => (item as { id?: unknown } | null | undefined)?.id === id,
    ) as { name?: unknown } | undefined;
  };
  const entry = entryOf();
  if (entry === undefined) {
    return {
      __tvmcpError: {
        code: 'INVALID_INPUT',
        message: `The chart has no drawing with the id ${id}`,
        hint: 'Call drawing_list for the ids of the drawings on the chart.',
        details: { id },
      },
    };
  }
  const shape = typeof entry.name === 'string' ? entry.name : '';
  if (!confirmed) {
    return { removed: false, shape };
  }
  try {
    chart.removeEntity(id);
  } catch (error) {
    const message: unknown = (error as { message?: unknown } | null | undefined)?.message;
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: `TradingView did not remove the drawing ${id}: ${typeof message === 'string' ? message : String(error)}`,
        hint: 'Check drawing_list, and try again.',
        details: { id },
      },
    };
  }
  if (entryOf() !== undefined) {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: `TradingView did not remove the drawing ${id}`,
        hint: 'Check drawing_list, and try again.',
        details: { id },
      },
    };
  }
  return { removed: true, shape };
}

// Removes drawings one by one with removeEntity, the way the user could undo, locked ones
// included: those of `ids` that are on the chart, or with null every drawing getAllShapes lists.
// Answers the ids it removed and those still there afterwards, in the order it went through them.
// An id of `ids` that is not on the chart is passed over.
export function removeDrawings(
  win: TvWindow,
  chartIndex: number | null,
  ids: string[] | null,
): { removed: string[]; failed: string[] } | PageErrorSentinel {
  let chart: Partial<ChartWidgetApiLike> | null | undefined;
  try {
    const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
    chart = chartIndex === null ? api?.activeChart?.() : api?.chart?.(chartIndex);
  } catch {
    chart = undefined;
  }
  if (typeof chart?.getAllShapes !== 'function' || typeof chart.removeEntity !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no chart API to remove drawings with',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  const found = chart;
  const listedIds = (): Set<string> => {
    let listed: unknown;
    try {
      listed = found.getAllShapes?.();
    } catch {
      listed = [];
    }
    return new Set(
      (Array.isArray(listed) ? (listed as unknown[]) : []).flatMap((entry) => {
        const id: unknown = (entry as { id?: unknown } | null | undefined)?.id;
        return typeof id === 'string' ? [id] : [];
      }),
    );
  };
  const before = listedIds();
  const targets = ids === null ? [...before] : ids.filter((id) => before.has(id));
  for (const id of targets) {
    try {
      found.removeEntity?.(id);
    } catch {
      // Told apart below: the drawing is still listed.
    }
  }
  const after = listedIds();
  return {
    removed: targets.filter((id) => !after.has(id)),
    failed: targets.filter((id) => after.has(id)),
  };
}
