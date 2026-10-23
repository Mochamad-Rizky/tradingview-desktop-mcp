import type { JsonValue } from '../../../src/utils/json.js';
import type { FixtureShape } from './fixture.js';
import type { SyntheticBar } from './synthetic-bars.js';

// The drawings on the chart and the line tools of the app, built from the shapes of the fixture
// (reverse-engineering notes of Plan 3, section 1). Values are synthetic.
//
// - getAllShapes() lists { id, name } for each drawing, name being the API name of its tool, in the
//   order the drawings were made, those of the fixture first. getShapeById(id) answers the API of a
//   drawing and throws "There is no such shape" for any other id. The API reports getPoints()
//   ({ time, price }, the time as the chart reports bar times), getProperties() (the flat
//   properties, text and frozen among them), isUserEditEnabled() (false for a drawing made with
//   lock: true) and isHidden() (visible false), and records setProperties and setPoints.
// - The tools come from a table by API name, each with its class (LineTool<Name>), the number of
//   points it takes (-1 for any) and the properties a new drawing starts with: the keys the notes
//   record for the horizontal line, the rectangle and the text, and the keys of the convention of
//   the notes for the others (lines like the horizontal line, shapes like the rectangle, the note
//   and the price label like the text); flag, price_label, fib_retracement and brush have no text
//   property. The classes option gives a class another point count or other properties.
// - createShape(point, options) and createMultipointShape(points, options) take the path of the
//   app: its gate first (signed out, the sign-in wall opens, recorded as dialog.signIn; in the
//   treatment of the drawings experiment the paywall, dialog.paywall; either way the promise
//   rejects 'Cannot create "<shape>" shape'), then an unknown or missing shape becomes a flag, a
//   chart without bars rejects 'Cannot create "<shape>" shape', a text for a tool without a text
//   property rejects "Value is undefined" before anything is made, and the drawing is made before
//   its point count is checked, so a wrong count rejects "Wrong points count for <shape>. Required
//   <n>" and leaves the drawing on the chart. Overrides are merged for the keys the tool has and
//   dropped for the others, the text is set, and the promise resolves the id, six letters and
//   digits. A time lies on the bar at or before it and, past the bars, on the grid of the bar step;
//   a point without a price takes the open of its bar. Creating loads the class of the tool.
// - removeEntity(id, options) removes a drawing, locked or not, undoable unless
//   options.disableUndo (state.removed lists each removal), and does nothing for an unknown id, as
//   the app only warns. has(id) tells the chart whether an id is a drawing: its removeEntity
//   removes studies as well.
// - removeAllShapes() opens the confirmation dialog of the app when any drawing is frozen,
//   recorded as dialog.confirmRemovingLockedLineTools, and then removes nothing; otherwise it
//   removes the drawings the user can delete, as one step the user could undo.
// - modules are three webpack modules: supportedLineTools (API name → { name: class }) with
//   isSupportedLineTool; the line-tool registry, whose getLoadedLineTool throws "Line tool <class>
//   is undefined" for a class that is not loaded (only the classes of the drawings on the chart are
//   at first), whose ensureLineToolLoaded loads one and records itself, and whose classes have
//   prototype.pointsCount(); and the gate of drawings, whose getDrawingsExperimentVariation answers
//   state.experiment (null by default) and is left out with withoutExperiment, next to the
//   ensureDrawingCreationAllowed that creating goes through.

export interface FakeLineToolClassOptions {
  pointsCount?: number;
  // The properties a new drawing of the class starts with, in place of the defaults.
  properties?: Record<string, JsonValue>;
}

export interface FakeDrawingsOptions {
  // What getDrawingsExperimentVariation answers at first. Default null.
  experiment?: string | null;
  // Leaves getDrawingsExperimentVariation out of its module.
  withoutExperiment?: boolean;
  // Another point count or other properties for a class, by class name.
  classes?: Record<string, FakeLineToolClassOptions>;
}

export interface FakeDrawingPoint {
  time: number;
  price: number;
}

export interface FakeDrawing {
  id: string;
  name: string;
  points: FakeDrawingPoint[];
  properties: Record<string, JsonValue>;
  // False for a drawing made with lock: true, which the user can neither edit nor delete.
  editable: boolean;
}

// The live state of the drawings. Tests may assign to it, for example to lock a drawing with
// list[0].properties.frozen = true.
export interface FakeDrawingsState {
  // The drawings on the chart, in the order getAllShapes lists them.
  list: FakeDrawing[];
  // Every drawing removeEntity or removeAllShapes removed, in order, and whether the user can undo
  // the removal.
  removed: { id: string; undoable: boolean }[];
  // What getDrawingsExperimentVariation answers; "treatment" makes the app gate drawings.
  experiment: string | null;
}

export interface FakeLineDataSourceApi {
  getPoints(): FakeDrawingPoint[];
  getProperties(): Record<string, JsonValue>;
  setProperties(properties: Record<string, unknown>): void;
  setPoints(points: unknown): void;
  isUserEditEnabled(): boolean;
  isHidden(): boolean;
  isSelectionEnabled(): boolean;
  isSavingEnabled(): boolean;
  isShowInObjectsTreeEnabled(): boolean;
}

export interface FakeDrawings {
  readonly modules: Record<string, Record<string, unknown>>;
  has(id: string): boolean;
  getAllShapes(): { id: string; name: string }[];
  getShapeById(id: string): FakeLineDataSourceApi;
  createShape(point: unknown, options?: unknown): Promise<string>;
  createMultipointShape(points: unknown, options?: unknown): Promise<string>;
  removeEntity(id: string, options?: { disableUndo?: boolean }): void;
  removeAllShapes(): void;
}

// What createFakeDrawings needs besides the shapes of the fixture: among others the state of the
// window to keep the drawings in, which it fills with those of the fixture.
export interface FakeDrawingsDeps {
  state: FakeDrawingsState;
  record: (name: string, args: readonly unknown[]) => void;
  signedIn: () => boolean;
  // The bars the page sees, oldest first, and how many seconds the time the chart reports for a bar
  // lies before the time in its row (window.ts, sessionOffsetSeconds).
  bars: () => readonly SyntheticBar[];
  offsetSeconds: number;
  stepSeconds: number;
  options?: FakeDrawingsOptions | undefined;
}

interface FakeLineTool {
  className: string;
  pointsCount: number;
  properties: Record<string, JsonValue>;
}

// The keys the notes record for the horizontal line (without showPrice), the rectangle and the
// text. Values are synthetic.
const LINE: Record<string, JsonValue> = {
  linecolor: '#2962FF',
  textcolor: '#2962FF',
  linewidth: 2,
  linestyle: 0,
  fontsize: 14,
  bold: false,
  italic: false,
  horzLabelsAlign: 'center',
  vertLabelsAlign: 'top',
  text: '',
  frozen: false,
  visible: true,
};

const SHAPE: Record<string, JsonValue> = {
  color: '#9C27B0',
  fillBackground: true,
  backgroundColor: 'rgba(156, 39, 176, 0.2)',
  linewidth: 2,
  transparency: 80,
  horzLabelsAlign: 'center',
  vertLabelsAlign: 'middle',
  textColor: '#9C27B0',
  fontSize: 14,
  bold: false,
  italic: false,
  extendLeft: false,
  extendRight: false,
  middleLine: false,
  linestyle: 0,
  frozen: false,
  visible: true,
  text: '',
};

const TEXT: Record<string, JsonValue> = {
  color: '#2962FF',
  backgroundColor: 'rgba(91, 133, 191, 0.3)',
  borderColor: '#667B8B',
  backgroundTransparency: 70,
  fontsize: 14,
  bold: false,
  italic: false,
  fillBackground: false,
  drawBorder: false,
  wordWrap: false,
  wordWrapWidth: 200,
  text: '',
  anchored: false,
  frozen: false,
  visible: true,
};

function withoutText(properties: Record<string, JsonValue>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(properties).filter(([key]) => key !== 'text'));
}

function tool(
  className: string,
  pointsCount: number,
  properties: Record<string, JsonValue>,
): FakeLineTool {
  return { className, pointsCount, properties };
}

// The tools of the fake app by API name: the curated ones of the server and brush, which takes any
// number of points.
const LINE_TOOLS: Record<string, FakeLineTool> = {
  horizontal_line: tool('LineToolHorzLine', 1, { ...LINE, showPrice: true }),
  vertical_line: tool('LineToolVertLine', 1, { ...LINE, showTime: true }),
  horizontal_ray: tool('LineToolHorzRay', 1, { ...LINE, showPrice: true }),
  trend_line: tool('LineToolTrendLine', 2, LINE),
  ray: tool('LineToolRay', 2, LINE),
  extended: tool('LineToolExtended', 2, LINE),
  arrow: tool('LineToolArrow', 2, LINE),
  rectangle: tool('LineToolRectangle', 2, SHAPE),
  circle: tool('LineToolCircle', 2, SHAPE),
  ellipse: tool('LineToolEllipse', 3, SHAPE),
  triangle: tool('LineToolTriangle', 3, SHAPE),
  parallel_channel: tool('LineToolParallelChannel', 3, LINE),
  fib_retracement: tool('LineToolFibRetracement', 2, withoutText(LINE)),
  text: tool('LineToolText', 1, TEXT),
  note: tool('LineToolNote', 1, TEXT),
  price_label: tool('LineToolPriceLabel', 1, withoutText(TEXT)),
  arrow_up: tool('LineToolArrowMarkUp', 1, LINE),
  arrow_down: tool('LineToolArrowMarkDown', 1, LINE),
  flag: tool('LineToolFlagMark', 1, withoutText(LINE)),
  brush: tool('LineToolBrush', -1, withoutText(LINE)),
};

// What the app falls back to for a shape it does not know.
const FALLBACK_SHAPE = 'flag';

// A class of the registry: what page code reads of it is prototype.pointsCount().
function lineToolClass(pointsCount: number): { prototype: { pointsCount(): number } } {
  return class {
    pointsCount(): number {
      return pointsCount;
    }
  };
}

export function createFakeDrawings(
  shapes: readonly FixtureShape[],
  deps: FakeDrawingsDeps,
): FakeDrawings {
  const options = deps.options ?? {};
  const tools = new Map(
    Object.entries(LINE_TOOLS).map(([name, entry]) => {
      const custom = options.classes?.[entry.className];
      return [
        name,
        {
          className: entry.className,
          pointsCount: custom?.pointsCount ?? entry.pointsCount,
          properties: custom?.properties ?? entry.properties,
        },
      ];
    }),
  );
  const toolOf = (name: string): FakeLineTool | undefined => tools.get(name);
  const classes = new Map(
    [...tools.values()].map((entry) => [entry.className, lineToolClass(entry.pointsCount)]),
  );

  // Where a time lies: on the bar at or before it, past the bars on the grid of the bar step, in the
  // times the chart reports; with the open of that bar for a point without a price. Null on a chart
  // without bars.
  const place = (time: number): { time: number; open: number } | null => {
    const bars = deps.bars();
    const first = bars[0];
    if (first === undefined) {
      return null;
    }
    const start = first[0] - deps.offsetSeconds;
    const index = Math.floor((time - start) / deps.stepSeconds);
    return { time: start + index * deps.stepSeconds, open: bars[index]?.[1] ?? 0 };
  };

  // A drawing of the fixture: its points, or as many as its tool takes on loaded bars.
  const fromFixture = (shape: FixtureShape, position: number): FakeDrawing => {
    const entry = toolOf(shape.name);
    const bars = deps.bars();
    const count = entry === undefined || entry.pointsCount === -1 ? 2 : entry.pointsCount;
    const points =
      shape.points ??
      (bars.length === 0
        ? []
        : Array.from({ length: count }, (_, slot) => {
            const bar = bars[(position * 3 + slot * 10) % bars.length];
            return {
              time: (bar?.[0] ?? 0) - deps.offsetSeconds,
              price: bar?.[4] ?? 0,
            };
          }));
    return {
      id: shape.id,
      name: shape.name,
      points: points.map((point) => ({ ...point })),
      properties: {
        ...structuredClone(entry?.properties ?? { frozen: false, visible: true }),
        ...structuredClone(shape.properties ?? {}),
      },
      editable: shape.editable ?? true,
    };
  };

  const { state } = deps;
  state.list.splice(0, state.list.length, ...shapes.map(fromFixture));
  state.experiment = options.experiment ?? null;
  // The classes of the tools on the chart are loaded; any other only once something loads it.
  const loaded = new Set(
    state.list.flatMap(({ name }) => {
      const entry = toolOf(name);
      return entry === undefined ? [] : [entry.className];
    }),
  );

  let made = 0;
  const nextId = (): string => {
    made += 1;
    return `DRW${String(made).padStart(3, '0')}`;
  };

  const find = (id: string): FakeDrawing | undefined => state.list.find((entry) => entry.id === id);

  // ensureDrawingCreationAllowed of the app: the sign-in wall for an account that is signed out,
  // the paywall in the treatment of the drawings experiment; either way it rejects.
  const ensureDrawingCreationAllowed = (names: unknown): Promise<void> => {
    deps.record('drawingGate.ensureDrawingCreationAllowed', [names]);
    if (!deps.signedIn()) {
      deps.record('dialog.signIn', []);
      return Promise.reject(new Error('Not signed in'));
    }
    if (state.experiment === 'treatment') {
      deps.record('dialog.paywall', ['drawings']);
      return Promise.reject(new Error('Drawings are a paid feature'));
    }
    return Promise.resolve();
  };

  const create = (
    method: string,
    given: readonly unknown[],
    rawOptions: unknown,
    args: readonly unknown[],
  ): Promise<string> => {
    deps.record(`chart.${method}`, args);
    const asked = (rawOptions ?? {}) as {
      shape?: unknown;
      text?: unknown;
      overrides?: unknown;
      lock?: unknown;
    };
    const name =
      typeof asked.shape === 'string' && tools.has(asked.shape) ? asked.shape : FALLBACK_SHAPE;
    const cannotCreate = (): Error => new Error(`Cannot create "${name}" shape`);
    return ensureDrawingCreationAllowed([name]).then(
      () => {
        const entry = toolOf(name);
        if (entry === undefined) {
          throw cannotCreate();
        }
        loaded.add(entry.className);
        if (deps.bars().length === 0) {
          throw cannotCreate();
        }
        const points = given.map((raw) => {
          const { time, price } = (raw ?? {}) as { time?: unknown; price?: unknown };
          return { place: place(typeof time === 'number' ? time : 0), price };
        });
        const text = asked.text;
        if (typeof text === 'string' && text !== '' && !Object.hasOwn(entry.properties, 'text')) {
          throw new Error('Value is undefined');
        }
        const properties = structuredClone(entry.properties);
        const overrides = asked.overrides;
        if (typeof overrides === 'object' && overrides !== null) {
          for (const [key, value] of Object.entries(overrides)) {
            if (Object.hasOwn(properties, key)) {
              properties[key] = value as JsonValue;
            }
          }
        }
        if (typeof text === 'string' && text !== '') {
          properties.text = text;
        }
        const drawing: FakeDrawing = {
          id: nextId(),
          name,
          points: points.map((point) => ({
            time: point.place?.time ?? 0,
            price: typeof point.price === 'number' ? point.price : (point.place?.open ?? 0),
          })),
          properties,
          editable: asked.lock !== true,
        };
        // Made first, checked afterwards, as the app does it.
        state.list.push(drawing);
        if (entry.pointsCount !== -1 && given.length !== entry.pointsCount) {
          throw new Error(`Wrong points count for ${name}. Required ${String(entry.pointsCount)}`);
        }
        return drawing.id;
      },
      () => {
        throw cannotCreate();
      },
    );
  };

  const apiOf = (drawing: FakeDrawing): FakeLineDataSourceApi => ({
    getPoints: () => drawing.points.map((point) => ({ ...point })),
    getProperties: () => structuredClone(drawing.properties),
    setProperties(properties) {
      deps.record('shape.setProperties', [drawing.id, properties]);
    },
    setPoints(points) {
      deps.record('shape.setPoints', [drawing.id, points]);
    },
    isUserEditEnabled: () => drawing.editable,
    isHidden: () => drawing.properties.visible === false,
    isSelectionEnabled: () => true,
    isSavingEnabled: () => true,
    isShowInObjectsTreeEnabled: () => true,
  });

  const supportedLineTools = Object.fromEntries(
    [...tools].map(([name, entry]) => [name, { name: entry.className }]),
  );

  const registry = {
    getLoadedLineTool(className: unknown) {
      const found = typeof className === 'string' ? classes.get(className) : undefined;
      if (found === undefined || typeof className !== 'string' || !loaded.has(className)) {
        throw new Error(`Line tool ${String(className)} is undefined`);
      }
      return found;
    },
    ensureLineToolLoaded(className: unknown): Promise<void> {
      deps.record('lineTools.ensureLineToolLoaded', [className]);
      return Promise.resolve().then(() => {
        if (typeof className !== 'string' || !classes.has(className)) {
          throw new Error(`Line tool ${String(className)} is undefined`);
        }
        loaded.add(className);
      });
    },
    isLineToolLoaded: (className: unknown) =>
      typeof className === 'string' && loaded.has(className),
  };

  const gate: Record<string, unknown> = { ensureDrawingCreationAllowed };
  if (options.withoutExperiment !== true) {
    gate.getDrawingsExperimentVariation = () => state.experiment;
  }

  return {
    // Module IDs are arbitrary numbers, as in a production build.
    modules: {
      '89901': {
        supportedLineTools,
        isSupportedLineTool: (name: unknown) => typeof name === 'string' && tools.has(name),
        isImageDrawingToolAvailable: () => false,
      },
      '42450': registry,
      '86128': gate,
    },
    has: (id) => find(id) !== undefined,
    getAllShapes: () => state.list.map(({ id, name }) => ({ id, name })),
    getShapeById(id) {
      const drawing = find(id);
      if (drawing === undefined) {
        throw new Error('There is no such shape');
      }
      return apiOf(drawing);
    },
    createShape(point, rawOptions) {
      return create('createShape', [point], rawOptions, [point, rawOptions]);
    },
    createMultipointShape(points, rawOptions) {
      return create(
        'createMultipointShape',
        Array.isArray(points) ? (points as unknown[]) : [],
        rawOptions,
        [points, rawOptions],
      );
    },
    removeEntity(id, removeOptions) {
      deps.record('chart.removeEntity', removeOptions === undefined ? [id] : [id, removeOptions]);
      const index = state.list.findIndex((entry) => entry.id === id);
      if (index === -1) {
        // The app only warns: "Can't find a source with id".
        return;
      }
      state.list.splice(index, 1);
      state.removed.push({ id, undoable: removeOptions?.disableUndo !== true });
    },
    removeAllShapes() {
      deps.record('chart.removeAllShapes', []);
      if (state.list.some(({ properties }) => properties.frozen === true)) {
        // The dialog waits for a person, and removes nothing until one answers.
        deps.record('dialog.confirmRemovingLockedLineTools', []);
        return;
      }
      const kept = state.list.filter(({ editable }) => !editable);
      for (const { id, editable } of state.list) {
        if (editable) {
          state.removed.push({ id, undoable: true });
        }
      }
      state.list.splice(0, state.list.length, ...kept);
    },
  };
}
