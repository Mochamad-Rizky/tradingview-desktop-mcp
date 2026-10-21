import type { CdpSession } from '../../../../src/core/cdp/types.js';
import type { TvMcpError } from '../../../../src/core/errors.js';
import {
  createPageBridge,
  type PageBridge,
  type PageFunction,
  type PageLibFunction,
} from '../../../../src/core/tv/page-bridge.js';
import { createPageLib } from '../../../../src/core/tv/page-lib.js';
import type { TvWindow } from '../../../../src/core/tv/tv-window.js';
import {
  addPineScriptToChart,
  compilePineSource,
  readAddedPineStudy,
  readPineConsole,
  readPineConsoleDiagnostics,
} from '../../../../src/tools/pine/page.js';
import type { JsonValue } from '../../../../src/utils/json.js';
import { failureOf } from '../../../helpers/failure-of.js';
import { createPageRuntime } from '../../../helpers/fake-cdp/runtime.js';
import { loadTvFixture, type TvStateFixture } from '../../../helpers/fake-tv/fixture.js';
import { createFakeWebpack } from '../../../helpers/fake-tv/webpack.js';
import type { FakeConsoleEntry } from '../../../helpers/fake-tv/pine-editor.js';
import { createFakeTvWindow, inspectFakeWindow } from '../../../helpers/fake-tv/window.js';

// The page functions of the Pine compile tools (compiling a text, adding the script of the editor
// to the chart, reading the console of the editor and the Pine logs of the studies), run the way
// the server runs them, as source text in a page through the real page bridge, and called directly
// on a second window built the same way, which is what the coverage of the module measures. The two
// answers must agree. Sources and messages are synthetic.

const fixture = loadTvFixture();
const ID = 'USER;00000000000000000000000000000000';

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
});

function bridgeTo(win: object): PageBridge {
  const runtime = createPageRuntime(win);
  disposers.push(() => {
    runtime.dispose();
  });
  const send = (method: string, params?: unknown): Promise<unknown> =>
    method === 'Runtime.evaluate'
      ? runtime.evaluate(params as Record<string, unknown>)
      : Promise.reject(new Error(`Unexpected command ${method}`));
  const session: CdpSession = {
    targetId: 'PAGE1',
    isClosed: false,
    send: send as CdpSession['send'],
    onClose: () => undefined,
    close: () => Promise.resolve(),
  };
  return createPageBridge(session, { timeoutMs: 5000 });
}

type Make = () => object;

async function libResultOf<A extends JsonValue[], R extends JsonValue | null>(
  fn: PageLibFunction<A, R>,
  args: A,
  make: Make,
): Promise<{ result: R; win: object }> {
  const win = make();
  const result = await bridgeTo(win).evaluateWithLib(fn, args);
  const other = make() as TvWindow;
  const direct = await fn(other, createPageLib(other), ...args);
  expect(direct).toEqual(result);
  return { result, win };
}

async function libFailureOfBoth<A extends JsonValue[], R extends JsonValue | null>(
  fn: PageLibFunction<A, R>,
  args: A,
  make: Make,
): Promise<{ error: TvMcpError; win: object }> {
  const win = make();
  const error = await failureOf(bridgeTo(win).evaluateWithLib(fn, args));
  const other = make() as TvWindow;
  expect(await fn(other, createPageLib(other), ...args)).toEqual({
    __tvmcpError: error.toPayload(),
  });
  return { error, win };
}

async function resultOf<A extends JsonValue[], R extends JsonValue | null>(
  fn: PageFunction<A, R>,
  args: A,
  make: Make,
): Promise<R> {
  const result = await bridgeTo(make()).evaluate(fn, args);
  expect(await fn(make() as TvWindow, ...args)).toEqual(result);
  return result;
}

const chart =
  (from: TvStateFixture = fixture, stage: (win: object) => void = () => undefined): Make =>
  () => {
    const win = createFakeTvWindow(from);
    stage(win);
    return win;
  };

function withEditor(editor: Partial<TvStateFixture['pineEditor']> = {}): TvStateFixture {
  return { ...fixture, pineEditor: { ...fixture.pineEditor, open: 'dialog', ...editor } };
}

function withRoom(from: TvStateFixture): TvStateFixture {
  return { ...from, planLimits: { ...from.planLimits, INDICATORS_ON_CHART: 9 } };
}

const editorOf = (win: object) => inspectFakeWindow(win).state.pineEditor;

// A page whose webpack cache holds `modules` and whose window has `globals`, and nothing else.
function withModules(modules: Record<string, unknown>, globals: object = {}): Make {
  return () => ({ ...globals, webpackChunktradingview: createFakeWebpack({ 1: modules }) });
}

// A page with an editor open in the side panel whose facade is `facade`, a chart API `chartApi`
// and signed in unless `signedIn` is false.
function withFacade(
  facade: () => unknown,
  options: { chartApi?: () => unknown; signedIn?: boolean; modules?: Record<string, unknown> } = {},
): Make {
  return () => {
    const built = facade();
    const chartApi = options.chartApi?.();
    return {
      is_authenticated: options.signedIn ?? true,
      TradingViewApi: { activeChart: () => chartApi },
      webpackChunktradingview: createFakeWebpack({
        1: {
          getOpenPineEditor: (placement: string) =>
            placement === 'dialog' ? { getFacade: () => built } : null,
        },
        2: options.modules ?? {},
      }),
    };
  };
}

describe('compilePineSource', () => {
  test('compiles a text on the fake app and answers its errors and warnings', async () => {
    const source = 'plot(undeclared_a)\r\nx = deprecated_b()\r\n';
    const { result, win } = await libResultOf(compilePineSource, [source, ID, 1000], chart());

    expect(result).toEqual({
      errors: [
        {
          message: 'Undeclared identifier "{identifier}"',
          ctx: { identifier: 'undeclared_a' },
          start: { line: 1, column: 6 },
          end: { line: 1, column: 17 },
        },
      ],
      warnings: [
        {
          message: 'The function {name} is deprecated',
          ctx: { name: 'deprecated_b' },
          start: { line: 2, column: 5 },
          end: { line: 2, column: 16 },
        },
      ],
    });
    expect(inspectFakeWindow(win).callsTo('translateScriptAsync')).toEqual([[source, ID]]);

    const clean = await libResultOf(compilePineSource, ['plot(close)', ID, 1000], chart());
    expect(clean.result).toEqual({ errors: [], warnings: [] });
  });

  test('keeps only what JSON carries of a diagnostic', async () => {
    const translateScriptAsync = () =>
      Promise.resolve({
        success: true,
        compileErrors: {
          errors: 'none',
          warnings: [
            null,
            {
              message: 5,
              ctx: { a: 'x', b: 2, c: true, d: { deep: 1 }, e: Number.NaN },
              start: { line: '2', column: 3 },
              end: 'x',
            },
          ],
        },
      });

    const { result } = await libResultOf(
      compilePineSource,
      ['x', ID, 1000],
      withModules({ translateScriptAsync }),
    );

    expect(result).toEqual({
      errors: [],
      warnings: [
        { message: null, ctx: {}, start: null, end: null },
        {
          message: null,
          ctx: { a: 'x', b: 2, c: true },
          start: { line: null, column: 3 },
          end: null,
        },
      ],
    });
  });

  test('takes the compile errors of a rejection, and a plain string as an HTTP failure', async () => {
    const reason = { errors: [{ message: 'Bad', start: { line: 1, column: 2 } }] };
    const rejected = await libResultOf(
      compilePineSource,
      ['x', ID, 1000],
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      withModules({ translateScriptAsync: () => Promise.reject({ reason }) }),
    );
    expect(rejected.result).toEqual({
      errors: [{ message: 'Bad', ctx: {}, start: { line: 1, column: 2 }, end: null }],
      warnings: [],
    });

    const http = await libFailureOfBoth(
      compilePineSource,
      ['x', ID, 1000],
      chart(fixture, (win) => {
        editorOf(win).compileHttpError = 'Server error, try again or contact support.';
      }),
    );
    expect(http.error.toPayload()).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: 'Server error, try again or contact support.',
      details: { reason: 'Server error, try again or contact support.' },
    });

    const other = await libFailureOfBoth(
      compilePineSource,
      ['x', ID, 1000],
      withModules({ translateScriptAsync: () => Promise.reject(new Error('Network down')) }),
    );
    expect(other.error.toPayload()).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: 'TradingView did not compile the script: Network down',
    });

    const thrown = await libFailureOfBoth(
      compilePineSource,
      ['x', ID, 1000],
      withModules({
        translateScriptAsync: () => {
          throw new Error('Broken');
        },
      }),
    );
    expect(thrown.error.code).toBe('NOT_AVAILABLE');
  });

  test('fails TIMEOUT when the compiler does not answer in time, CAPABILITY_UNAVAILABLE without it', async () => {
    const slow = await libFailureOfBoth(
      compilePineSource,
      ['x', ID, 20],
      withModules({ translateScriptAsync: () => new Promise(() => undefined) }),
    );
    expect(slow.error.toPayload()).toMatchObject({ code: 'TIMEOUT', details: { waitMs: 20 } });

    const missing = await libFailureOfBoth(compilePineSource, ['x', ID, 20], withModules({}));
    expect(missing.error.code).toBe('CAPABILITY_UNAVAILABLE');
  });
});

describe('addPineScriptToChart', () => {
  test('adds the script of the editor and answers the studies before and the console length', async () => {
    const { result, win } = await libResultOf(
      addPineScriptToChart,
      [1000, null],
      chart(withRoom(withEditor()), (win) => {
        editorOf(win).consoleMessages.push({ level: 'info', text: 'old', time: '09:00:00' });
      }),
    );

    expect(result).toEqual({
      before: ['STUDY01', 'STUDY02'],
      consoleFrom: 1,
      scriptId: fixture.pineEditor.script?.scriptIdPart,
    });
    expect(inspectFakeWindow(win).callsTo('pineFacade.addToChart')).toEqual([[]]);
    expect(
      (win as ReturnType<typeof createFakeTvWindow>).TradingViewApi?.activeChart().getAllStudies(),
    ).toContainEqual({ id: 'NEW001', name: 'Fixture Script' });
  });

  test('adds to the chart whose room was checked, and refuses once another chart is the active one', async () => {
    const twoCharts = withRoom({ ...withEditor(), layout: { ...fixture.layout, chartsCount: 2 } });
    const { result, win } = await libResultOf(addPineScriptToChart, [1000, 0], chart(twoCharts));

    expect(result).toEqual({
      before: ['STUDY01', 'STUDY02'],
      consoleFrom: 0,
      scriptId: fixture.pineEditor.script?.scriptIdPart,
    });
    expect(inspectFakeWindow(win).callsTo('pineFacade.addToChart')).toEqual([[]]);

    const moved = await libFailureOfBoth(
      addPineScriptToChart,
      [1000, 0],
      chart(twoCharts, (page) => {
        inspectFakeWindow(page).state.activeChartIndex = 1;
      }),
    );
    expect(moved.error.toPayload()).toMatchObject({
      code: 'NOT_AVAILABLE',
      details: { chartIndex: 0, activeChartIndex: 1 },
    });
    expect(moved.error.hint).toContain('pine_compile');
    expect(inspectFakeWindow(moved.win).callsTo('pineFacade.addToChart')).toEqual([]);

    // An active chart that cannot be told is not taken for the one that was checked.
    const unknown = await libFailureOfBoth(
      addPineScriptToChart,
      [1000, 0],
      chart(twoCharts, (page) => {
        const api = (page as ReturnType<typeof createFakeTvWindow>).TradingViewApi;
        if (api !== undefined) {
          api.activeChartIndex = () => {
            throw new Error('No layout');
          };
        }
      }),
    );
    expect(unknown.error.toPayload()).toMatchObject({
      code: 'NOT_AVAILABLE',
      details: { chartIndex: 0, activeChartIndex: null },
    });
    expect(inspectFakeWindow(unknown.win).callsTo('pineFacade.addToChart')).toEqual([]);
  });

  test('answers the script the editor holds after the add: a new script under the id of its draft', async () => {
    const { result } = await libResultOf(
      addPineScriptToChart,
      [1000, null],
      chart(withRoom(withEditor({ script: null, source: 'plot(close)' }))),
    );
    expect(result).toMatchObject({ scriptId: `USER;${(0xd4b0).toString(16).padStart(32, '0')}` });

    const unknown = async (getScriptIdVersion: () => unknown) =>
      (
        await libResultOf(
          addPineScriptToChart,
          [1000, null],
          withFacade(
            () => ({
              addToChart: () => Promise.resolve(),
              isDraft: () => true,
              getScriptIdVersion,
            }),
            { chartApi: () => ({ getAllStudies: () => [] }) },
          ),
        )
      ).result.scriptId;
    await expect(unknown(() => null)).resolves.toBeNull();
    await expect(unknown(() => ({ scriptIdPart: '' }))).resolves.toBeNull();
    await expect(
      unknown(() => {
        throw new Error('No script');
      }),
    ).resolves.toBeNull();
  });

  test('refuses before acting: signed out, a changed saved script, no editor', async () => {
    const signedOut = await libFailureOfBoth(
      addPineScriptToChart,
      [1000, null],
      chart(withRoom(withEditor()), (win) => {
        editorOf(win).signedIn = false;
      }),
    );
    expect(signedOut.error.code).toBe('AUTH_REQUIRED');
    expect(inspectFakeWindow(signedOut.win).callsTo('pineFacade.addToChart')).toEqual([]);

    const changed = await libFailureOfBoth(
      addPineScriptToChart,
      [1000, null],
      chart(withRoom(withEditor({ source: '//@version=6\nindicator("Changed")\n' }))),
    );
    expect(changed.error.code).toBe('NOT_AVAILABLE');
    expect(changed.error.hint).toContain('pine_save');
    expect(inspectFakeWindow(changed.win).callsTo('dialog.confirmSaveChanges')).toEqual([]);

    const closed = await libFailureOfBoth(
      addPineScriptToChart,
      [1000, null],
      chart(withRoom(fixture)),
    );
    expect(closed.error.code).toBe('NOT_AVAILABLE');

    const noRegistry = await libFailureOfBoth(addPineScriptToChart, [1000, null], withModules({}));
    expect(noRegistry.error.code).toBe('CAPABILITY_UNAVAILABLE');
  });

  test('refuses an editor whose state cannot be read, and a page without what it needs', async () => {
    const studies = () => ({ getAllStudies: () => [] });
    const unknownModified = await libFailureOfBoth(
      addPineScriptToChart,
      [1000, null],
      withFacade(
        () => ({
          addToChart: () => Promise.resolve(),
          isDraft: () => false,
          isModified: () => {
            throw new Error('gone');
          },
        }),
        { chartApi: studies },
      ),
    );
    expect(unknownModified.error.code).toBe('NOT_AVAILABLE');

    const noAdd = await libFailureOfBoth(
      addPineScriptToChart,
      [1000, null],
      withFacade(() => ({ isDraft: () => true, isModified: () => false }), { chartApi: studies }),
    );
    expect(noAdd.error.code).toBe('CAPABILITY_UNAVAILABLE');

    const noChart = await libFailureOfBoth(
      addPineScriptToChart,
      [1000, null],
      withFacade(() => ({
        addToChart: () => Promise.resolve(),
        isDraft: () => true,
        isModified: () => true,
      })),
    );
    expect(noChart.error.code).toBe('CAPABILITY_UNAVAILABLE');

    const noFacade = await libFailureOfBoth(
      addPineScriptToChart,
      [1000, null],
      withFacade(() => null, { chartApi: studies }),
    );
    expect(noFacade.error.code).toBe('CAPABILITY_UNAVAILABLE');
  });

  test('a draft with unsaved changes is added, without a console when none can be read', async () => {
    const added: string[] = [];
    const { result } = await libResultOf(
      addPineScriptToChart,
      [1000, null],
      withFacade(
        () => ({
          addToChart: () => {
            added.push('x');
            return Promise.resolve();
          },
          isDraft: () => true,
          isModified: () => true,
        }),
        { chartApi: () => ({ getAllStudies: () => [{ id: 'A' }, { id: 7 }, null] }) },
      ),
    );

    expect(result).toEqual({ before: ['A', '7'], consoleFrom: null, scriptId: null });
    expect(added).toEqual(['x', 'x']);
  });

  test('fails NOT_AVAILABLE when addToChart rejects, TIMEOUT when it hangs', async () => {
    const chartApi = () => ({ getAllStudies: () => [] });
    const rejected = await libFailureOfBoth(
      addPineScriptToChart,
      [1000, null],
      withFacade(
        () => ({
          addToChart: () => Promise.reject(new Error('Compilation request failed')),
          isDraft: () => true,
          isModified: () => false,
        }),
        { chartApi },
      ),
    );
    expect(rejected.error.toPayload()).toMatchObject({
      code: 'NOT_AVAILABLE',
      details: { reason: 'Compilation request failed' },
    });

    const hanging = await libFailureOfBoth(
      addPineScriptToChart,
      [20, null],
      withFacade(
        () => ({
          addToChart: () => new Promise(() => undefined),
          isDraft: () => true,
          isModified: () => false,
        }),
        { chartApi },
      ),
    );
    expect(hanging.error.toPayload()).toMatchObject({ code: 'TIMEOUT', details: { waitMs: 20 } });
  });
});

describe('page members that throw', () => {
  const throwing = (): never => {
    throw new Error('gone');
  };

  test('addPineScriptToChart passes over lookups, a chart list and a console that throw', async () => {
    let calls = 0;
    const make = (): object => ({
      is_authenticated: true,
      TradingViewApi: {
        activeChart: () => ({
          getAllStudies: () => {
            calls += 1;
            if (calls % 2 === 1) {
              throw new Error('not yet');
            }
            return [];
          },
        }),
      },
      webpackChunktradingview: createFakeWebpack({
        1: {
          getOpenPineEditor: (placement: string) => {
            if (placement === 'dialog') {
              throw new Error('gone');
            }
            return {
              getFacade: () => ({
                addToChart: () => Promise.resolve(),
                isDraft: () => true,
                get _editorStore(): never {
                  throw new Error('private');
                },
              }),
            };
          },
        },
      }),
    });

    const { result } = await libResultOf(addPineScriptToChart, [1000, null], make);
    expect(result).toEqual({ before: [], consoleFrom: null, scriptId: null });

    const brokenFacade = await libFailureOfBoth(
      addPineScriptToChart,
      [1000, null],
      withModules({ getOpenPineEditor: () => ({ getFacade: throwing }) }),
    );
    expect(brokenFacade.error.code).toBe('CAPABILITY_UNAVAILABLE');
    const brokenChart = await libFailureOfBoth(
      addPineScriptToChart,
      [1000, null],
      withModules(
        { getOpenPineEditor: () => ({ getFacade: () => ({ addToChart: () => undefined }) }) },
        { TradingViewApi: { activeChart: throwing } },
      ),
    );
    expect(brokenChart.error.code).toBe('CAPABILITY_UNAVAILABLE');
  });

  test('the console readers pass over a registry and studies that throw', async () => {
    const diagnostics = await libResultOf(
      readPineConsoleDiagnostics,
      [0],
      withModules({ getOpenPineEditor: throwing }),
    );
    expect(diagnostics.result).toEqual({ errors: [], warnings: [] });

    const reading = await libResultOf(
      readPineConsole,
      [],
      withModules(
        { getOpenPineEditor: () => null },
        {
          TradingViewApi: {
            activeChart: () => ({
              getAllStudies: () => [null, { id: 3 }, { id: true }],
              getStudyById: () => ({
                study: () => ({
                  logs: () => ({ forEach: throwing }),
                }),
              }),
            }),
          },
        },
      ),
    );
    expect(reading.result).toEqual({
      editorOpen: false,
      editor: null,
      scripts: [],
      silentStudies: ['3'],
    });
  });
});

describe('readAddedPineStudy', () => {
  // The id the fake saves the first new script it adds under, as a server draft.
  const DRAFT_ID = `USER;${(0xd4b0).toString(16).padStart(32, '0')}`;
  // Adds the script of the editor of the fake app to its chart.
  const addScript = (win: object): void => {
    const api = (win as ReturnType<typeof createFakeTvWindow>).TradingViewApi?.pineEditorApi();
    void api?.getDialogFacade()?.addToChart();
  };
  // A chart on which the studies of `metas` appeared after OLD, each with that metadata.
  const appeared =
    (metas: Record<string, unknown>): Make =>
    () => ({
      TradingViewApi: {
        activeChart: () => ({
          getAllStudies: () => ['OLD', ...Object.keys(metas)].map((id) => ({ id })),
          getStudyById: (id: string) => ({ study: () => ({ metaInfo: () => metas[id] }) }),
        }),
      },
    });
  // The metadata of a Pine study, with a script id unless it is undefined.
  const pine = (scriptIdPart: string | undefined, description: string) => ({
    pine: { version: '1' },
    ...(scriptIdPart === undefined ? {} : { scriptIdPart }),
    description,
  });

  test('finds the study the editor added and whether it failed to compile', async () => {
    const make = chart(
      withRoom(withEditor({ script: null, source: 'plot(undeclared_q)' })),
      addScript,
    );
    const script = { id: DRAFT_ID, title: null };

    expect(
      await resultOf(readAddedPineStudy, [['STUDY01', 'STUDY02'], null, script], make),
    ).toEqual({
      studyId: 'NEW001',
      compileError: true,
      others: [],
      otherScripts: [],
    });
    expect(
      await resultOf(readAddedPineStudy, [['STUDY01', 'STUDY02', 'NEW001'], null, script], make),
    ).toEqual({
      studyId: null,
      compileError: null,
      others: [],
      otherScripts: [],
    });
  });

  test('reads the chart of the index it is given, and finds nothing on a chart it cannot reach', async () => {
    const make = chart(withRoom(withEditor({ script: null, source: 'plot(close)' })), addScript);
    const script = { id: DRAFT_ID, title: null };

    expect(await resultOf(readAddedPineStudy, [['STUDY01', 'STUDY02'], 0, script], make)).toEqual({
      studyId: 'NEW001',
      compileError: false,
      others: [],
      otherScripts: [],
    });
    // The fake has one chart: chart(1) throws, as on a layout of one chart.
    expect(await resultOf(readAddedPineStudy, [['STUDY01', 'STUDY02'], 1, script], make)).toEqual({
      studyId: null,
      compileError: null,
      others: [],
      otherScripts: [],
    });
  });

  test('takes a new Pine study only when its metadata names the script that was added', async () => {
    const sameTitle = appeared({
      MINE: pine('USER;mine', 'Mine'),
      THEIRS: pine('USER;theirs', 'Mine'),
      JAVA: {},
    });
    // By the id, when the study and the script both have one: a study of another script with the
    // same title is not taken.
    expect(
      await resultOf(
        readAddedPineStudy,
        [['OLD'], null, { id: 'USER;mine', title: 'Mine' }],
        sameTitle,
      ),
    ).toEqual({ studyId: 'MINE', compileError: null, others: ['JAVA'], otherScripts: ['THEIRS'] });
    // By the title, when the id of the script is not known, or the study has none.
    const titled = appeared({ MINE: pine('USER;mine', 'Mine'), THEIRS: pine('USER;theirs', 'X') });
    expect(
      await resultOf(readAddedPineStudy, [['OLD'], null, { id: null, title: 'Mine' }], titled),
    ).toMatchObject({ studyId: 'MINE', otherScripts: ['THEIRS'] });
    const unnamed = appeared({ MINE: pine(undefined, 'Mine'), THEIRS: pine(undefined, 'X') });
    expect(
      await resultOf(
        readAddedPineStudy,
        [['OLD'], null, { id: 'USER;mine', title: 'Mine' }],
        unnamed,
      ),
    ).toMatchObject({ studyId: 'MINE', otherScripts: ['THEIRS'] });
    // Nothing to tell the script by: no study is taken for it.
    expect(
      await resultOf(readAddedPineStudy, [['OLD'], null, { id: null, title: null }], sameTitle),
    ).toEqual({
      studyId: null,
      compileError: null,
      others: ['JAVA'],
      otherScripts: ['MINE', 'THEIRS'],
    });
  });

  test('takes only a Pine study, lists the others, and reads no compile error without the member', async () => {
    const make = (): object => ({
      TradingViewApi: {
        activeChart: () => ({
          getAllStudies: () => [{ id: 'OLD' }, { id: 'PINE' }, { id: 'JAVA' }, { id: 'BAD' }],
          getStudyById: (id: string) => {
            if (id === 'BAD') {
              throw new Error('There is no such study');
            }
            return {
              study: () => ({
                metaInfo: () =>
                  id === 'PINE' ? { pine: { version: '1' }, scriptIdPart: 'USER;pine' } : {},
              }),
            };
          },
        }),
      },
    });
    const script = { id: 'USER;pine', title: null };

    expect(await resultOf(readAddedPineStudy, [['OLD'], null, script], make)).toEqual({
      studyId: 'PINE',
      compileError: null,
      others: ['JAVA', 'BAD'],
      otherScripts: [],
    });
    // A new study that is not a Pine study is never taken for the script.
    expect(await resultOf(readAddedPineStudy, [['OLD', 'PINE'], null, script], make)).toEqual({
      studyId: null,
      compileError: null,
      others: ['JAVA', 'BAD'],
      otherScripts: [],
    });
    expect(await resultOf(readAddedPineStudy, [['OLD'], null, script], () => ({}))).toEqual({
      studyId: null,
      compileError: null,
      others: [],
      otherScripts: [],
    });
  });
});

describe('readPineConsoleDiagnostics', () => {
  const entries: FakeConsoleEntry[] = [
    { level: 'info', text: 'before', time: '09:00:00' },
    { level: 'info', text: 'Compiling...', time: '09:00:01' },
    {
      level: 'error',
      text: 'Undeclared identifier "a"',
      time: '09:00:02',
      start: { line: 2, column: 3 },
      end: { line: 2, column: 4 },
    },
    {
      level: 'warning',
      text: 'Deprecated',
      time: '09:00:02',
      start: { line: 3, column: 0 },
      end: { line: 0, column: 0 },
    },
    { level: 'error', text: 'Compilation error', time: '09:00:03' },
  ];

  test('answers the diagnostics written after an entry, with the end column made inclusive', async () => {
    const { result } = await libResultOf(
      readPineConsoleDiagnostics,
      [1],
      chart(withEditor(), (win) => {
        editorOf(win).consoleMessages.push(...entries);
      }),
    );

    expect(result).toEqual({
      errors: [
        {
          message: 'Undeclared identifier "a"',
          ctx: {},
          start: { line: 2, column: 3 },
          end: { line: 2, column: 3 },
        },
      ],
      warnings: [{ message: 'Deprecated', ctx: {}, start: { line: 3, column: 0 }, end: null }],
    });
  });

  test('falls back to the error texts without a place, and to every entry after a shrink', async () => {
    const plain: FakeConsoleEntry[] = [
      { level: 'info', text: 'Compiling...', time: '09:00:01' },
      { level: 'error', text: 'Script could not be translated', time: '09:00:02' },
    ];
    const { result } = await libResultOf(
      readPineConsoleDiagnostics,
      [5],
      chart(withEditor(), (win) => {
        editorOf(win).consoleMessages.push(...plain);
      }),
    );
    expect(result).toEqual({
      errors: [{ message: 'Script could not be translated', ctx: {}, start: null, end: null }],
      warnings: [],
    });

    const none = await libResultOf(readPineConsoleDiagnostics, [null], chart(withEditor()));
    expect(none.result).toEqual({ errors: [], warnings: [] });
    const closed = await libResultOf(readPineConsoleDiagnostics, [0], chart());
    expect(closed.result).toEqual({ errors: [], warnings: [] });
    const noRegistry = await libResultOf(readPineConsoleDiagnostics, [0], withModules({}));
    expect(noRegistry.result).toEqual({ errors: [], warnings: [] });
  });
});

describe('readPineConsole', () => {
  test('reads the editor console with a sort key and the logs of the studies', async () => {
    const logs = [
      { barTime: 1_700_000_000, time: 1_700_000_000_500, level: 'info', message: 'tick', line: 3 },
    ];
    const [first, second] = fixture.studies;
    if (first === undefined || second === undefined) {
      throw new Error('The fixture must hold two studies');
    }
    const from = {
      ...withEditor(),
      studies: [
        { ...first, logs },
        { ...second, logs: [] },
      ],
    };
    const { result } = await libResultOf(
      readPineConsole,
      [],
      chart(from, (win) => {
        editorOf(win).consoleMessages.push(
          { level: 'info', text: 'a', time: '00:00:01' },
          { level: 'warning', text: 'b', time: 'not a clock' },
          { level: 'error', text: 'c', time: '12:00:00 AM' },
        );
      }),
    );

    expect(result.editorOpen).toBe(true);
    expect(result.editor?.map(({ level, text, clock }) => ({ level, text, clock }))).toEqual([
      { level: 'info', text: 'a', clock: '00:00:01' },
      { level: 'warning', text: 'b', clock: 'not a clock' },
      { level: 'error', text: 'c', clock: '12:00:00 AM' },
    ]);
    // Keys never grow from the newest entry back, so the order of the console stays.
    const keys = result.editor?.map(({ order }) => order) ?? [];
    expect(keys.every((key) => typeof key === 'number')).toBe(true);
    expect([...keys].sort((a, b) => (b ?? 0) - (a ?? 0))).toEqual([...keys].reverse());
    expect(result.scripts).toEqual([
      {
        studyId: 'STUDY01',
        level: 'info',
        text: 'tick',
        time: 1_700_000_000_500,
        barTime: 1_700_000_000,
      },
    ]);
    expect(result.silentStudies).toEqual(['STUDY02']);
  });

  test('reads 12-hour clocks, and keeps an entry from later in the day for yesterday', async () => {
    const at = (hours: number, minutes: number): string => {
      const suffix = hours >= 12 ? 'PM' : 'AM';
      const twelve = hours % 12 === 0 ? 12 : hours % 12;
      return `${String(twelve)}:${String(minutes).padStart(2, '0')}:00 ${suffix}`;
    };
    const now = new Date();
    const later = new Date(now.getTime() + 2 * 60_000);
    const earlier = new Date(now.getTime() - 2 * 60_000);
    const { result } = await libResultOf(
      readPineConsole,
      [],
      chart(withEditor(), (win) => {
        editorOf(win).consoleMessages.push(
          // Later than now on the clock: written yesterday, so older than the next entry.
          { level: 'info', text: 'yesterday', time: at(later.getHours(), later.getMinutes()) },
          { level: 'info', text: 'today', time: at(earlier.getHours(), earlier.getMinutes()) },
        );
      }),
    );

    const [yesterday, today] = result.editor ?? [];
    expect((today?.order ?? 0) - (yesterday?.order ?? 0)).toBeGreaterThan(20 * 3600_000);
    expect(Math.abs((today?.order ?? 0) - earlier.getTime())).toBeLessThan(60_000);
  });

  test('reports a closed editor, an unreadable store and studies that cannot be read', async () => {
    const closed = await libResultOf(readPineConsole, [], chart());
    expect(closed.result).toEqual({
      editorOpen: false,
      editor: null,
      scripts: [],
      silentStudies: [],
    });

    const unreadable = await libResultOf(
      readPineConsole,
      [],
      withFacade(() => ({ _editorStore: { getStore: () => null } }), {
        chartApi: () => ({
          getAllStudies: () => [{ id: 'X' }, { id: 'Y' }, { id: 'Z' }],
          getStudyById: (id: string) => {
            if (id === 'X') {
              throw new Error('There is no such study');
            }
            return {
              study: () => ({
                metaInfo: () => ({ pine: { version: '1' } }),
                logs: () =>
                  id === 'Y'
                    ? {
                        values: () =>
                          [{ barTime: 'x', time: Number.NaN, level: 7, message: null }, null][
                            Symbol.iterator
                          ](),
                      }
                    : {
                        [Symbol.iterator]: () =>
                          [{ barTime: 5, time: 6, level: 'warning', message: 'z' }][
                            Symbol.iterator
                          ](),
                      },
              }),
            };
          },
        }),
      }),
    );
    expect(unreadable.result).toEqual({
      editorOpen: true,
      editor: null,
      scripts: [
        { studyId: 'Y', level: 'info', text: '', time: null, barTime: null },
        { studyId: 'Z', level: 'warning', text: 'z', time: 6, barTime: 5 },
      ],
      silentStudies: [],
    });

    const noRegistry = await libResultOf(readPineConsole, [], withModules({}));
    expect(noRegistry.result).toEqual({
      editorOpen: false,
      editor: null,
      scripts: [],
      silentStudies: [],
    });
  });
});
