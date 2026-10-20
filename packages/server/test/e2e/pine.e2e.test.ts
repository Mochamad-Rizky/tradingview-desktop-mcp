import type { PageLib } from '../../src/core/tv/page-lib.js';
import type {
  OpenPineEditorLike,
  PineConsoleEntryLike,
  TvWindow,
} from '../../src/core/tv/tv-window.js';
import { pollUntil } from '../../src/utils/poll.js';
import { callTool } from '../helpers/mcp-client.js';
import {
  callFailure,
  callOk,
  closeEditor,
  e2eEnabled,
  editorDifferences,
  findEditorReopenProblems,
  findLastEditedScript,
  observe,
  openEditor,
  planLimitSkipReason,
  readChartState,
  restoreEditor,
  snapshotEditor,
  startE2eServer,
  type E2eServer,
  type EditorSnapshot,
  type EditorTarget,
} from './setup.js';

// The Pine tools against the real TradingView Desktop.
//
// - Without the editor: pine_analyze works offline; pine_compile and pine_smart_compile compile
//   synthetic scripts only, which saves, opens and adds nothing (the chart is checked to be
//   unchanged); pine_list_scripts is checked for its shape, without printing a name.
// - The editor: only while it holds no unsaved changes, and only when the script it shows can be
//   shown again (setup.ts, restoreEditor). A closed editor is opened to see what it shows and closed
//   again after the last test. Nothing is saved: pine_save is never called.
// - Scripts added to the chart (drawings, a strategy) need a free indicator slot: on a full chart
//   these tests are skipped with the INDICATORS_ON_CHART limit, before anything is changed. With a
//   free slot TradingView saves the added script as a server draft (version 0.x) of the account,
//   as its own Add to chart button does; the test removes the study it added and deletes no script.
// - The scripts on the chart are only read: their drawings, and the report of a strategy.
//
// The text of the editor is the user's, and the template of a new script names the account, so no
// assertion prints it: texts are compared, never shown.

// Synthetic scripts, compiled only.
const VALID = '//@version=6\nindicator("tradingview-mcp E2E")\nplot(close)\n';
// clse is not declared: line 3, columns 6 to 9.
const INVALID = '//@version=6\nindicator("tradingview-mcp E2E")\nplot(clse)\n';
// Names of Pine v4 in a script of version 6, which the analyzer renames.
const V4_IN_V6 = '//@version=6\nstudy("x")\nplot(rsi(close,14))\n';
// The script declares rsi itself, so the analyzer leaves the call alone and only the error of the
// compiler points at it.
const DECLARED_V4 = '//@version=6\nindicator("x")\nrsi = rsi(close, 14)\nplot(rsi)\n';
// Without //@version the compiler takes the script for Pine v1, where study and rsi exist.
const HEADERLESS = 'study("x")\nplot(rsi(close,14))\n';

// undeclared_q after a tab, é and an emoji, which are one, one and two UTF-16 code units. A tab
// that indents a line makes the compiler stop at the first word of the line, at column 2.
const POSITIONS = [
  {
    what: 'a tab that indents a line',
    source: '//@version=6\nindicator("t")\n\tplot(undeclared_q)\n',
    column: 2,
    endColumn: 5,
  },
  {
    what: 'a tab',
    source: '//@version=6\nindicator("t")\nx = "\t" + undeclared_q\nplot(close)\n',
    column: 11,
    endColumn: 22,
  },
  {
    what: 'é',
    source: '//@version=6\nindicator("t")\nx = "é" + undeclared_q\nplot(close)\n',
    column: 11,
    endColumn: 22,
  },
  {
    what: 'an emoji',
    source: '//@version=6\nindicator("t")\ny = "😀" + undeclared_q\nplot(close)\n',
    column: 12,
    endColumn: 23,
  },
];

// The text the editor test writes into the editor, never saved, and discarded again.
const EDITOR_SOURCE =
  '//@version=6\nindicator("tradingview-mcp E2E test, safe to discard")\nplot(close)\n';

// The scripts the tests with a free indicator slot add to the chart.
const DRAWING_SCRIPT = [
  '//@version=6',
  'indicator("tradingview-mcp E2E drawings", overlay = true)',
  'var t = table.new(position.top_right, 2, 2)',
  'if barstate.islast',
  '    line.new(bar_index - 10, high, bar_index, low)',
  '    label.new(bar_index, high, "E2E")',
  '    box.new(bar_index - 5, high, bar_index, low)',
  '    table.cell(t, 0, 0, "E2E")',
  '',
].join('\n');
const STRATEGY_SCRIPT = [
  '//@version=6',
  'strategy("tradingview-mcp E2E strategy", overlay = true)',
  'fast = ta.sma(close, 5)',
  'slow = ta.sma(close, 20)',
  'if ta.crossover(fast, slow)',
  '    strategy.entry("Long", strategy.long)',
  'if ta.crossunder(fast, slow)',
  '    strategy.close("Long")',
  '',
].join('\n');

interface CompileError {
  line: number;
  column: number;
  endLine: number | null;
  endColumn: number | null;
  message: string;
  severity: 'error' | 'warning';
}

interface CompileResult {
  success: boolean;
  errors: CompileError[];
  warnings: CompileError[];
  addedToChart: boolean;
  studyId: string | null;
  compiledAt: number | null;
  compiledAtIso: string | null;
}

interface SmartCompileResult {
  success: boolean;
  attempts: { errors: CompileError[]; applied: string[] }[];
  source: string;
  diff: string;
  writtenBack: boolean;
}

interface EditorChange {
  type?: string;
  script: { id: string; version: string | null } | null;
  modified: boolean;
  draft: boolean;
}

interface Study {
  id: string;
  isPine: boolean;
  isStrategy: boolean;
}

// The console of the open editor, read only: how many entries, the keys and levels they have, and
// the shape of their clock times with every digit written 9. No text.
function editorConsoleShape(
  _win: TvWindow,
  lib: PageLib,
): { entries: number | null; keys: string[]; levels: string[]; clocks: string[] } {
  const getOpenPineEditor = lib.findExport('getOpenPineEditor') as
    ((placement: string) => OpenPineEditorLike | null) | null;
  let messages: unknown;
  for (const placement of ['dialog', 'bottom']) {
    try {
      const entry = getOpenPineEditor?.(placement);
      if (entry !== null && entry !== undefined) {
        messages = entry.getFacade()?._editorStore?.getStore().getState().console?.messages;
        break;
      }
    } catch {
      messages = undefined;
    }
  }
  if (!Array.isArray(messages)) {
    return { entries: null, keys: [], levels: [], clocks: [] };
  }
  const entries = messages as (PineConsoleEntryLike | null)[];
  return {
    entries: entries.length,
    keys: [...new Set(entries.flatMap((entry) => Object.keys(entry ?? {})))].sort(),
    levels: [...new Set(entries.map((entry) => String(entry?.level)))].sort(),
    clocks: [
      ...new Set(
        entries.map((entry) =>
          typeof entry?.time === 'string' ? entry.time.replace(/\d/g, '9') : typeof entry?.time,
        ),
      ),
    ].sort(),
  };
}

// What the saved scripts of the account look like, from the export pine_list_scripts reads
// (requestUserScripts, which the app keeps the answer of): the keys of an item with the types of
// their values and whether every item has them, the unit modified is in, and the kinds. No count,
// name, id or version.
function savedScriptShapes(
  _win: TvWindow,
  lib: PageLib,
): Promise<{
  keys: string[];
  modified: { types: string[]; milliseconds: boolean | null };
  kinds: string[];
  extraKeys: string[];
  extraKinds: string[];
  versionsLookLikeMajorMinor: boolean | null;
}> {
  const request = lib.findExport('requestUserScripts');
  return Promise.resolve()
    .then(() => (typeof request === 'function' ? (request as () => unknown)() : []))
    .then((list: unknown) => {
      const items = (Array.isArray(list) ? list : []) as Record<string, unknown>[];
      const types = new Map<string, Set<string>>();
      const counts = new Map<string, number>();
      for (const item of items) {
        for (const [key, value] of Object.entries(item)) {
          const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
          types.set(key, (types.get(key) ?? new Set()).add(type));
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
      const extras = items.map((item) =>
        typeof item.extra === 'object' && item.extra !== null
          ? (item.extra as Record<string, unknown>)
          : {},
      );
      const modified = items.map((item) => item.modified);
      const numbers = modified.filter((value): value is number => typeof value === 'number');
      return {
        keys: [...types]
          .map(
            ([key, set]) =>
              `${key}: ${[...set].join('|')}${counts.get(key) === items.length ? '' : ' (not in every item)'}`,
          )
          .sort(),
        modified: {
          types: [...new Set(modified.map((value) => typeof value))],
          milliseconds: numbers.length === 0 ? null : numbers.every((value) => value > 1e11),
        },
        kinds: [...new Set(items.map((item) => String(item.kind)))].sort(),
        extraKeys: [...new Set(extras.flatMap((extra) => Object.keys(extra)))].sort(),
        extraKinds: [...new Set(extras.map((extra) => String(extra.kind)))].sort(),
        versionsLookLikeMajorMinor:
          items.length === 0
            ? null
            : items.every(
                (item) => typeof item.version === 'string' && /^\d+\.\d+$/.test(item.version),
              ),
      };
    });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Whether the editor shows the script of `target`, whatever its text.
function sameEditorScript(now: EditorSnapshot, target: EditorTarget): boolean {
  return !editorDifferences(now, { script: target.script, source: null }).includes('script');
}

describe.skipIf(!e2eEnabled())(
  'the Pine tools without the editor against TradingView Desktop',
  () => {
    let e2e: E2eServer | undefined;

    beforeAll(async () => {
      e2e = await startE2eServer();
    });

    afterAll(async () => {
      await e2e?.close();
    });

    function server(): E2eServer {
      if (e2e === undefined) {
        throw new Error('The server did not start');
      }
      return e2e;
    }

    // The chart state and the studies, to check that a compilation changed neither.
    async function chartNow(): Promise<string> {
      const { client } = server();
      const state = await readChartState(client);
      const { data } = await callOk<{ studies: Study[] }>(client, 'indicator_list');
      return JSON.stringify([state, data.studies.map(({ id }) => id)]);
    }

    test('analyze works offline', async () => {
      const { data, via } = await callOk<{
        version: number | null;
        diagnostics: { ruleId: string; line: number; column: number }[];
      }>(server().client, 'pine_analyze', { source: HEADERLESS });

      expect(via).toBe('local');
      expect(data.version).toBeNull();
      expect(data.diagnostics.map(({ ruleId, line, column }) => [ruleId, line, column])).toEqual([
        ['missing-version', 1, 1],
        ['study-declaration', 1, 1],
        ['ta-namespace', 2, 6],
      ]);
    });

    test('compile-only reports errors with positions for an invalid script', async () => {
      const before = await chartNow();

      const { data, via } = await callOk<CompileResult>(server().client, 'pine_compile', {
        source: INVALID,
      });

      expect(via).toBe('internal');
      expect(data).toMatchObject({
        success: false,
        warnings: [],
        addedToChart: false,
        studyId: null,
      });
      expect(data.errors).toEqual([
        {
          line: 3,
          column: 6,
          endLine: 3,
          endColumn: 9,
          message: 'Undeclared identifier "clse"',
          severity: 'error',
        },
      ]);
      expect(Number.isInteger(data.compiledAt)).toBe(true);
      expect((await chartNow()) === before, 'the chart and its studies are unchanged').toBe(true);
    });

    test('compile-only succeeds for a valid script, and pine_get_errors returns that result', async () => {
      const before = await chartNow();

      const { data } = await callOk<CompileResult>(server().client, 'pine_compile', {
        source: VALID,
      });

      expect(data).toMatchObject({
        success: true,
        errors: [],
        warnings: [],
        addedToChart: false,
        studyId: null,
      });
      expect((await callOk<CompileResult>(server().client, 'pine_get_errors')).data).toEqual(data);
      expect((await chartNow()) === before, 'the chart and its studies are unchanged').toBe(true);
    });

    test('compile positions count UTF-16 code units after a tab, é and an emoji', async () => {
      const found: Record<string, [number, number | null]> = {};
      for (const { what, source } of POSITIONS) {
        const { data } = await callOk<CompileResult>(server().client, 'pine_compile', { source });
        const [error] = data.errors;
        found[what] = [error?.column ?? 0, error?.endColumn ?? null];
      }

      observe('compile positions (column, end column)', found);
      expect(found).toEqual(
        Object.fromEntries(
          POSITIONS.map(({ what, column, endColumn }) => [what, [column, endColumn]]),
        ),
      );
    });

    test('a script without //@version compiles as Pine v1, with a warning', async () => {
      const { data } = await callOk<CompileResult>(server().client, 'pine_compile', {
        source: HEADERLESS,
      });

      expect(data).toMatchObject({ success: true, errors: [] });
      expect(data.warnings).toHaveLength(1);
      expect(data.warnings[0]).toMatchObject({
        line: 1,
        column: 1,
        endLine: null,
        endColumn: null,
        severity: 'warning',
      });
      expect(data.warnings[0]?.message).toMatch(/compile as Pine v1/);
    });

    test('smart compile renames Pine v4 names in a v6 script with the real compiler', async () => {
      const { data } = await callOk<SmartCompileResult>(server().client, 'pine_smart_compile', {
        source: V4_IN_V6,
      });

      observe('smart compile of v4 names in a v6 script', {
        attempts: data.attempts.map(({ errors, applied }) => ({
          errors: errors.map(({ line, column, message }) => [line, column, message]),
          applied,
        })),
      });
      expect(data.success).toBe(true);
      expect(data.attempts).toHaveLength(2);
      expect(data.attempts[0]?.errors.map(({ message }) => message)).toEqual([
        "Could not find function or function reference 'study'",
      ]);
      expect(data.source).toBe('//@version=6\nindicator("x")\nplot(ta.rsi(close,14))\n');
      expect(data.writtenBack).toBe(false);
    });

    test('smart compile renames a v4 call the compiler points at in a script that declares the name', async () => {
      const { data } = await callOk<SmartCompileResult>(server().client, 'pine_smart_compile', {
        source: DECLARED_V4,
      });

      expect(data.attempts[0]?.errors).toEqual([
        {
          line: 3,
          column: 7,
          endLine: 3,
          endColumn: 9,
          message: "Could not find function or function reference 'rsi'",
          severity: 'error',
        },
      ]);
      expect(data.success).toBe(true);
      expect(data.source).toBe(
        '//@version=6\nindicator("x")\nrsi = ta.rsi(close, 14)\nplot(rsi)\n',
      );
    });

    test('lists saved scripts', async () => {
      const { client, ctx } = server();

      const { data } = await callOk<{
        scripts: {
          id: string;
          name: string;
          version: string | null;
          type: string;
          modified: string | null;
        }[];
      }>(client, 'pine_list_scripts');

      // Shape only: the names and ids are the user's.
      const problems = data.scripts.flatMap((script, index) => {
        const at = `script ${String(index)}`;
        return [
          typeof script.id === 'string' && script.id !== '' ? null : `${at} has no id`,
          typeof script.name === 'string' && script.name !== '' ? null : `${at} has no name`,
          script.version === null || /^\d+\.\d+$/.test(script.version)
            ? null
            : `${at} has an odd version`,
          ['indicator', 'strategy', 'library'].includes(script.type)
            ? null
            : `${at} has an odd type`,
          script.modified === null || !Number.isNaN(Date.parse(script.modified))
            ? null
            : `${at} has an odd modified time`,
        ].filter((problem): problem is string => problem !== null);
      });
      expect(problems).toEqual([]);

      const page = await ctx.connection.chartPage();
      const shapes = await page.bridge.evaluateWithLib(savedScriptShapes, []);
      observe('saved Pine scripts', shapes);
      // The kind of each script is in extra, where pine_list_scripts reads it.
      const kinds = shapes.extraKinds.filter((kind) => kind !== 'undefined');
      expect(kinds.every((kind) => ['study', 'strategy', 'library'].includes(kind))).toBe(true);
      expect(data.scripts.some(({ type }) => type === 'strategy')).toBe(kinds.includes('strategy'));
    });
  },
);

describe.skipIf(!e2eEnabled())('the Pine Editor against TradingView Desktop', () => {
  let e2e: E2eServer | undefined;
  // What the editor showed before the suite, the script the app kept for a closed editor, and what
  // the suite puts back after each test: the script the editor showed, or the one it last held.
  let before: EditorSnapshot | undefined;
  let lastEdited: Awaited<ReturnType<typeof findLastEditedScript>> | undefined;
  let target: EditorTarget | undefined;
  // Why the editor must not be changed, found before anything was.
  let editorSkip: string | undefined;
  // The texts this suite wrote into the editor: the only unsaved text it may discard.
  const written = new Set<string>();

  beforeAll(async () => {
    e2e = await startE2eServer();
    before = await snapshotEditor(e2e.ctx);
    if (before.state.open) {
      if (before.state.modified) {
        editorSkip =
          'The Pine Editor holds unsaved changes, which these tests could replace; nothing was ' +
          'changed.';
      } else if (before.source === null) {
        editorSkip =
          'The text of the Pine Editor could not be read, so it could not be compared afterwards; ' +
          'nothing was changed.';
      } else {
        target = { script: before.state.script, source: before.source };
      }
    } else {
      // A closed editor shows, when it opens, the script the app kept for it only on the first
      // open of a session, so that script is read first: it is what goes back in.
      lastEdited = await findLastEditedScript(e2e.ctx);
      if (lastEdited === null) {
        editorSkip =
          'The Pine Editor is closed and the script it last held cannot be read, so it could not ' +
          'be put back; nothing was changed.';
      } else if (lastEdited.unsaved !== false) {
        editorSkip =
          'The Pine Editor is closed with unsaved changes kept for it, which these tests could ' +
          'replace; nothing was changed.';
      } else {
        target = { script: lastEdited.script, source: null };
      }
    }
    if (target !== undefined) {
      const problems = await findEditorReopenProblems(e2e.ctx, target.script);
      if (problems.length > 0) {
        editorSkip =
          `The script of the Pine Editor could not be shown again afterwards (${problems.join('; ')}); ` +
          'nothing was changed.';
      }
    }
    if (editorSkip !== undefined || before.state.open) {
      return;
    }
    // Opened the way the Pine button opens it; it is closed again after the last test.
    await openEditor(e2e.ctx);
    const opened = await snapshotEditor(e2e.ctx);
    observe('pine editor as opened', {
      placement: opened.state.placement,
      visible: opened.visible,
      shows: opened.state.script === null ? 'a new script' : 'a saved script',
      theScriptItLastHeld: target !== undefined && sameEditorScript(opened, target),
      modified: opened.state.modified,
    });
    if (opened.state.modified) {
      editorSkip =
        'The Pine Editor opened with unsaved changes, which these tests could replace; it is ' +
        'closed again and nothing else was changed.';
    } else if (target !== undefined && sameEditorScript(opened, target)) {
      target = { script: target.script, source: opened.source };
    }
  });

  // The target put back, then the editor closed again when it was closed, and the script the app
  // keeps for it checked; the failures are thrown together once the server is closed.
  afterAll(async () => {
    if (e2e === undefined) {
      return;
    }
    const failures: string[] = [];
    try {
      if (target !== undefined && editorSkip === undefined) {
        failures.push(...(await restoreEditor(e2e.client, e2e.ctx, target, written)).problems);
      }
      if (before !== undefined && !before.state.open) {
        await closeEditor(e2e.ctx);
        if ((await snapshotEditor(e2e.ctx)).visible === true) {
          failures.push('The Pine Editor is still on screen after it was closed again');
        }
        const kept = await findLastEditedScript(e2e.ctx);
        if (JSON.stringify(kept) !== JSON.stringify(lastEdited)) {
          failures.push('The app keeps another script for the closed Pine Editor than before');
        }
      }
    } catch (error) {
      failures.push(messageOf(error));
    }
    await e2e.close();
    if (failures.length > 0) {
      throw new Error(failures.join('; '));
    }
  });

  function started(): { e2e: E2eServer; target: EditorTarget } {
    if (e2e === undefined || target === undefined) {
      throw new Error('The suite could not read the Pine Editor');
    }
    return { e2e, target };
  }

  async function listStudies(): Promise<Study[]> {
    if (e2e === undefined) {
      throw new Error('The server did not start');
    }
    return (await callOk<{ studies: Study[] }>(e2e.client, 'indicator_list')).data.studies;
  }

  // Runs `change` and puts the target back first thing after it, however it ended. A failed
  // restore after a failed test is logged next to the test's own failure, which is the one thrown;
  // after a test that passed, it fails the test.
  async function editThenRestore(change: () => Promise<void>): Promise<void> {
    const { e2e: server, target: back } = started();
    let failure: unknown;
    let failed = false;
    try {
      await change();
    } catch (error) {
      failure = error;
      failed = true;
    }
    const { problems, differedAtFirst, waitedMs } = await restoreEditor(
      server.client,
      server.ctx,
      back,
      written,
    );
    if (differedAtFirst !== null) {
      // How the editor showed the script again after the tool that put it back answered.
      observe('pine editor put back', {
        tool: back.script === null ? 'pine_new' : 'pine_open',
        differedRightAfterTheTool: differedAtFirst,
        waitedMs,
      });
    }
    if (problems.length > 0) {
      if (!failed) {
        throw new Error(problems.join('; '));
      }
      console.error(
        `The Pine Editor could not be put back after a failed test: ${problems.join('; ')}`,
      );
    }
    if (failed) {
      throw failure;
    }
  }

  // Adds `source` to the chart from the editor, hands the new study to `read`, and removes the study
  // again, whatever `read` did; the editor is put back afterwards. The caller has checked the room.
  async function addThenRemove(
    source: string,
    read: (studyId: string) => Promise<void>,
  ): Promise<void> {
    const { client } = started().e2e;
    const studiesBefore = (await listStudies()).map(({ id }) => id);
    const added: { id: string | null } = { id: null };
    await editThenRestore(async () => {
      try {
        written.add(source);
        await callOk(client, 'pine_new', { source });
        const { data } = await callOk<CompileResult>(client, 'pine_compile', { addToChart: true });
        added.id = data.studyId;
        expect(data.addedToChart).toBe(true);
        if (data.studyId !== null) {
          await read(data.studyId);
        }
      } finally {
        // This session added it, so it goes without confirm.
        if (added.id !== null) {
          await callOk(client, 'indicator_remove', { id: added.id });
        }
      }
    });
    expect((await listStudies()).map(({ id }) => id)).toEqual(studiesBefore);
  }

  // A tool called until `done` takes what it answers, for what a script computes after it is added.
  async function pollTool<T>(
    name: string,
    args: Record<string, unknown>,
    done: (data: T) => boolean,
  ): Promise<T> {
    const { client } = started().e2e;
    const polled = await pollUntil(
      async () => {
        const result = await callTool(client, name, args);
        const envelope = result.structuredContent as { ok?: boolean; data?: T } | undefined;
        return result.isError === true || envelope?.data === undefined ? null : envelope.data;
      },
      (data) => data !== null && done(data),
      { intervalMs: 250, timeoutMs: 15_000 },
    );
    if (polled.last === null) {
      throw new Error(`${name} gave no result within 15 s`);
    }
    return polled.last;
  }

  test('starts a new script, sets and reads its source, compiles it, and saves nothing', async (context) => {
    if (editorSkip !== undefined) {
      return context.skip(editorSkip);
    }
    const { e2e: server } = started();
    const page = await server.ctx.connection.chartPage();
    const consoleLength = async () =>
      (await page.bridge.evaluateWithLib(editorConsoleShape, [])).entries;
    observe(
      'pine editor console as opened',
      await page.bridge.evaluateWithLib(editorConsoleShape, []),
    );

    await editThenRestore(async () => {
      const created = await callOk<EditorChange>(server.client, 'pine_new', {});
      expect(created.data).toMatchObject({
        type: 'indicator',
        script: null,
        modified: false,
        draft: true,
      });

      written.add(EDITOR_SOURCE);
      const set = await callOk<EditorChange>(server.client, 'pine_set_source', {
        source: EDITOR_SOURCE,
      });
      expect(set.data).toMatchObject({ script: null, modified: true });

      const read = await callOk<{ source: string; script: unknown; modified: boolean }>(
        server.client,
        'pine_get_source',
      );
      expect(read.data.source === EDITOR_SOURCE, 'the editor holds the text set').toBe(true);
      expect(read.data.script).toBeNull();
      expect(read.data.modified).toBe(true);

      // Compiling the text of the editor, twice, to see whether its console grows.
      const lengths = [await consoleLength()];
      const compiled = await callOk<CompileResult>(server.client, 'pine_compile', {});
      expect(compiled.data).toMatchObject({
        success: true,
        errors: [],
        addedToChart: false,
        studyId: null,
      });
      lengths.push(await consoleLength());
      await callOk(server.client, 'pine_compile', {});
      lengths.push(await consoleLength());

      const { data: shownConsole } = await callOk<{
        messages: { source: string; level: string; text: string }[];
      }>(server.client, 'pine_get_console', { limit: 20 });
      expect(
        shownConsole.messages.every(
          ({ source, level, text }) =>
            ['editor', 'script'].includes(source) &&
            typeof level === 'string' &&
            typeof text === 'string',
        ),
      ).toBe(true);
      observe('pine editor flow', {
        consoleEntriesBeforeAndAfterTwoCompiles: lengths,
        consoleAfter: await page.bridge.evaluateWithLib(editorConsoleShape, []),
        pineGetConsoleMessages: shownConsole.messages.length,
      });
    });
  });

  test('a closed editor shows its unsaved text again when it is opened', async (context) => {
    if (editorSkip !== undefined) {
      return context.skip(editorSkip);
    }
    const { e2e: server } = started();

    await editThenRestore(async () => {
      // Unsaved text of the test's own, in a new script.
      await callOk(server.client, 'pine_new', {});
      written.add(EDITOR_SOURCE);
      await callOk(server.client, 'pine_set_source', { source: EDITOR_SOURCE });

      // What the app keeps for the editor while the text is unsaved, after the close, and after
      // the open: whether it records unsaved changes (ids and flags only).
      const keptWhileUnsaved = await findLastEditedScript(server.ctx);
      const closed = await closeEditor(server.ctx);
      const hidden = await snapshotEditor(server.ctx);
      const keptWhileClosed = await findLastEditedScript(server.ctx);
      // What a tool does when it needs the editor: ensureEditorOpen.
      await openEditor(server.ctx);
      const reopened = await snapshotEditor(server.ctx);
      const keptWhenOpenAgain = await findLastEditedScript(server.ctx);
      const dialogs = (await callOk<{ dialogs: string[] }>(server.client, 'app_get_ui_state')).data
        .dialogs;

      observe('pine editor close and open with unsaved text', {
        closed: closed.closed,
        placement: closed.placement,
        registeredAfterClose: hidden.state.open,
        visibleAfterClose: hidden.visible,
        visibleAgain: reopened.visible,
        textBack: reopened.source === EDITOR_SOURCE,
        modifiedAgain: reopened.state.modified,
        unsavedKept: [keptWhileUnsaved, keptWhileClosed, keptWhenOpenAgain].map(
          (kept) => kept?.unsaved ?? null,
        ),
        newScriptKept: [
          keptWhileUnsaved?.script,
          keptWhileClosed?.script,
          keptWhenOpenAgain?.script,
        ].map((script) => script === null),
        dialogsAfterOpen: dialogs.length,
      });
      expect(closed.closed).toBe(true);
      expect(hidden.visible).not.toBe(true);
      expect(reopened.source === EDITOR_SOURCE, 'the unsaved text is back').toBe(true);
      expect(reopened.state).toMatchObject({ open: true, modified: true, script: null });
    });
  });

  test('adds a script that draws, reads its lines, labels, boxes and tables, and removes it', async (context) => {
    const full = await planLimitSkipReason(
      started().e2e.client,
      'INDICATORS_ON_CHART',
      (await listStudies()).length,
      1,
    );
    if (full !== null) {
      return context.skip(full);
    }
    if (editorSkip !== undefined) {
      return context.skip(editorSkip);
    }

    await addThenRemove(DRAWING_SCRIPT, async (studyId) => {
      const lines = await pollTool<{ lines: { studyId: string }[]; total: number }>(
        'pine_get_lines',
        { studyId },
        ({ total }) => total > 0,
      );
      expect(lines.lines[0]?.studyId).toBe(studyId);
      const labels = await pollTool<{ labels: { text: string | null }[]; total: number }>(
        'pine_get_labels',
        { studyId },
        ({ total }) => total > 0,
      );
      expect(labels.labels[0]?.text).toBe('E2E');
      const boxes = await pollTool<{ boxes: unknown[]; total: number }>(
        'pine_get_boxes',
        { studyId },
        ({ total }) => total > 0,
      );
      expect(boxes.total).toBe(1);
      const tables = await pollTool<{
        tables: {
          position: string | null;
          cells: { row: number; column: number; text: string }[];
        }[];
        total: number;
      }>('pine_get_tables', { studyId }, ({ total }) => total > 0);
      expect(tables.tables[0]?.position).toBe('top_right');
      expect(tables.tables[0]?.cells).toContainEqual({ row: 0, column: 0, text: 'E2E' });
    });
  });

  test('adds a strategy, reads its results, trades and equity, and removes it', async (context) => {
    const full = await planLimitSkipReason(
      started().e2e.client,
      'INDICATORS_ON_CHART',
      (await listStudies()).length,
      1,
    );
    if (full !== null) {
      return context.skip(full);
    }
    if (editorSkip !== undefined) {
      return context.skip(editorSkip);
    }

    await addThenRemove(STRATEGY_SCRIPT, async (studyId) => {
      const results = await pollTool<{
        strategy: { id: string };
        performance: { all: Record<string, number> };
      }>('strategy_get_results', { studyId }, () => true);
      expect(results.strategy.id).toBe(studyId);
      expect(typeof results.performance.all.totalTrades).toBe('number');
      const { client } = started().e2e;
      const trades = await callOk<{ total: number }>(client, 'strategy_get_trades', { studyId });
      expect(Number.isInteger(trades.data.total)).toBe(true);
      const equity = await callTool(client, 'strategy_get_equity', { studyId });
      observe('strategy report', {
        allKeys: Object.keys(results.performance.all).length,
        trades: trades.data.total,
        equity: equity.isError === true ? 'not available' : 'available',
      });
    });
  });
});

describe.skipIf(!e2eEnabled())('the Pine scripts on the chart against TradingView Desktop', () => {
  let e2e: E2eServer | undefined;

  beforeAll(async () => {
    e2e = await startE2eServer();
  });

  afterAll(async () => {
    await e2e?.close();
  });

  function server(): E2eServer {
    if (e2e === undefined) {
      throw new Error('The server did not start');
    }
    return e2e;
  }

  test('reads what the Pine scripts on the chart drew, and changes nothing', async () => {
    const { client } = server();
    const studies = (await callOk<{ studies: Study[] }>(client, 'indicator_list')).data.studies;
    const pine = studies.filter(({ isPine }) => isPine);

    const totals: Record<string, number> = {};
    for (const [tool, key] of [
      ['pine_get_lines', 'lines'],
      ['pine_get_labels', 'labels'],
      ['pine_get_boxes', 'boxes'],
      ['pine_get_tables', 'tables'],
    ] as const) {
      const { data, warnings } = await callOk<Record<string, unknown>>(client, tool, { limit: 10 });
      const items = data[key];
      const total = data.total;
      expect(Array.isArray(items)).toBe(true);
      expect(typeof total).toBe('number');
      if (Array.isArray(items) && typeof total === 'number') {
        expect(items.length).toBeLessThanOrEqual(Math.min(10, total));
        totals[key] = total;
      }
      expect(warnings.every((warning) => typeof warning === 'string')).toBe(true);
    }

    observe('drawings of the Pine scripts on the chart', { pineScripts: pine.length, totals });
    const after = (await callOk<{ studies: Study[] }>(client, 'indicator_list')).data.studies;
    expect(after.map(({ id }) => id)).toEqual(studies.map(({ id }) => id));
  });

  test('the strategy tools say the chart has no strategy, when it has none', async (context) => {
    const { client } = server();
    const studies = (await callOk<{ studies: Study[] }>(client, 'indicator_list')).data.studies;
    if (studies.some(({ isStrategy }) => isStrategy)) {
      return context.skip('The chart holds a strategy, whose report this test does not read');
    }

    for (const tool of ['strategy_get_results', 'strategy_get_trades', 'strategy_get_equity']) {
      const error = await callFailure(client, tool);
      expect(error.code).toBe('NOT_AVAILABLE');
      expect(error.message).toMatch(/no strategy/);
    }
  });
});
