import { z } from 'zod';
import type { PageHandle } from '../../core/connection.js';
import { TvMcpError } from '../../core/errors.js';
import { inPlanLimitedTurn } from '../../core/tv/plan-limits.js';
import { pollUntil } from '../../utils/poll.js';
import { READ_ONLY } from '../annotations.js';
import { pageWaitMs } from '../chart/strategies.js';
import { requireStudyRoom } from '../indicator/index.js';
import { readStudyInsertContext } from '../indicator/page.js';
import { defineTool, type AnyToolDefinition, type ToolContext } from '../types.js';
import { CLOSE_EDITOR_HINT, notOpenError, readEditorState } from './editor.js';
import {
  declaredTitle,
  mergeConsoleMessages,
  normalizeCompileErrors,
  toCompileResult,
  type PineCompileResult,
} from './mappers.js';
import {
  addPineScriptToChart,
  compilePineSource,
  readAddedPineStudy,
  readPineConsole,
  readPineConsoleDiagnostics,
  readPineSource,
} from './page.js';

export type { PineCompileError, PineCompileResult } from './mappers.js';

// The compile tools of the Pine domain (design spec 7): compiling a text or the text of the Pine
// Editor, adding the script of the editor to the chart, the errors of the last compilation and the
// console of the editor with the Pine logs of the scripts on the chart.
//
// Compiling alone touches nothing: the text goes to the compiler of TradingView (one request, the
// one its own client sends) and nothing is saved, opened or added. Adding to the chart keeps to the
// rules of the domain: the indicator limit of the plan is checked first (PLAN_LIMIT instead of the
// paywall of the app, NOT_AVAILABLE when it cannot be read), and what would open a dialog of
// TradingView (signed out, a saved script with unsaved changes) is refused before anything is
// added. Texts are the user's own: none is logged.

// The id every text is compiled as. translateScriptAsync of the app stamps the compiled metadata
// with the id it is given and needs one (an empty id is refused); this one names no script, so a
// compilation never refers to a script of the account (seen on the app: it compiles as any other).
export const COMPILE_SCRIPT_ID = 'USER;00000000000000000000000000000000';

// How long the server looks for the study after addToChart resolved, which happens once the app has
// compiled the script and added it, or failed to.
const ADDED_STUDY_WAIT_MS = 1500;
const ADDED_STUDY_POLL_MS = 100;

const MAX_SOURCE = 500_000;

// Now, in whole Unix seconds.
const now = (): number => Math.floor(Date.now() / 1000);

// Compiles `source` without touching the editor or the chart, through the compiler of the app, and
// answers the result, addedToChart false. An empty text is INVALID_INPUT; the failures of
// compilePineSource (an HTTP failure is NOT_AVAILABLE with the text TradingView gives, TIMEOUT after
// waitMs) are not compile errors and are passed on as they are.
export async function compileSource(
  page: PageHandle,
  source: string,
  waitMs: number,
): Promise<PineCompileResult> {
  if (source.trim() === '') {
    throw new TvMcpError('INVALID_INPUT', 'There is no Pine source to compile: the text is empty', {
      hint: 'Pass the script as source, or set it with pine_set_source.',
    });
  }
  const raw = await page.bridge.evaluateWithLib(compilePineSource, [
    source,
    COMPILE_SCRIPT_ID,
    waitMs,
  ]);
  return toCompileResult(normalizeCompileErrors(raw, source), null, now());
}

// The text in the open editor; NOT_AVAILABLE when the editor is closed.
async function editorSource(page: PageHandle): Promise<string> {
  const { source } = await page.bridge.evaluateWithLib(readPineSource, []);
  if (source === null) {
    throw notOpenError();
  }
  return source;
}

// Adds the script of the open editor to the active chart and answers what came of it. The checks run
// before anything is added: the indicator limit of the plan, an open editor, and a script the app
// adds without a dialog (a draft, or a saved script without unsaved changes; the page re-checks this
// and sign-in right before it acts). The check of the room resolves the active chart to its index,
// once: the add goes ahead only while that chart is still the active one, which the editor adds
// to, and the new study is looked for on it, by the ids on the chart before and after, with a plain
// poll. A new study is taken for the script, and counted as added by this session, only when it is
// a Pine study of the script the editor added, by the id of that script or else by the title the
// text declares, so that a study the user adds at the same moment is never taken for it. Its
// compile errors are read from the console of the editor. The caller runs it in a turn of the
// plan-limited actions (inPlanLimitedTurn).
async function addEditorScript(
  page: PageHandle,
  ctx: ToolContext,
  warnings: string[],
): Promise<PineCompileResult> {
  const waitMs = pageWaitMs(ctx.config.callTimeoutMs);
  const deadline = Date.now() + waitMs;
  const context = await page.bridge.evaluateWithLib(readStudyInsertContext, [null, '']);
  await requireStudyRoom(page, context.check, context.count);

  // Over the text this session wrote last, the flag of unsaved changes TradingView keeps is a
  // leftover of its own change, which asks for no dialog; the page checks that again.
  const written = ctx.session.lastWrittenPineText;
  const state = await readEditorState(page, warnings, written);
  if (!state.open) {
    throw notOpenError();
  }
  if (state.script !== null && !state.draft && state.modified) {
    throw new TvMcpError(
      'NOT_AVAILABLE',
      'The Pine Editor holds a saved script with unsaved changes, which TradingView adds only ' +
        'after asking in a dialog whether to save a new version',
      {
        hint:
          'Save the changes first with pine_save, or start a new script with pine_new and the ' +
          `source, then add that. ${CLOSE_EDITOR_HINT} The script can then be opened with ` +
          'pine_open and added.',
        details: { id: state.script.id },
      },
    );
  }
  // For the clamping of positions only; read before the app changes anything.
  const source = await editorSource(page);
  // What is left of the wait after the checks, so that a slow add ends in the TIMEOUT of the page
  // function, with its hint, within the time of the call.
  const { before, consoleFrom, scriptId } = await page.bridge.evaluateWithLib(
    addPineScriptToChart,
    [Math.max(deadline - Date.now(), 0), context.chartIndex, written],
  );
  const script = { id: scriptId, title: declaredTitle(source) };
  const found = await pollUntil(
    () => page.bridge.evaluate(readAddedPineStudy, [before, context.chartIndex, script]),
    ({ studyId }) => studyId !== null,
    {
      intervalMs: ADDED_STUDY_POLL_MS,
      timeoutMs: Math.max(Math.min(ADDED_STUDY_WAIT_MS, deadline - Date.now()), 0),
    },
  );
  const { studyId, compileError, others, otherScripts } = found.last;
  if (studyId !== null) {
    ctx.session.createdStudyIds.add(studyId);
    if (state.script === null || state.draft) {
      warnings.push(
        'TradingView saved the script as a server draft (a version 0.x, not a saved script of ' +
          'the account) to add it to the chart, as its own Add to chart button does.',
      );
    }
  }
  const diagnostics = await page.bridge.evaluateWithLib(readPineConsoleDiagnostics, [consoleFrom]);
  const compiled = normalizeCompileErrors(diagnostics, source);
  if (studyId === null && otherScripts.length > 0) {
    const appeared = [...otherScripts, ...others];
    warnings.push(
      `No new Pine study of the script appeared on the chart, only ${appeared.join(', ')}, ` +
        `which ${appeared.length === 1 ? 'is' : 'are'} not taken for the script and not ` +
        'counted as added by this session: ' +
        (script.id === null && script.title === null
          ? 'neither the id of the script nor a title it declares could tell its study. '
          : 'a Pine study of another script can be one the user added at the same moment. ') +
        'Check indicator_list and the console of the Pine Editor (pine_get_console).',
    );
  } else if (studyId === null && others.length > 0) {
    warnings.push(
      `No new Pine study appeared on the chart, only ${others.join(', ')}, which is not taken ` +
        'for the script and not counted as added by this session. Check indicator_list and the ' +
        'console of the Pine Editor (pine_get_console).',
    );
  } else if (studyId === null) {
    warnings.push(
      'No new study appeared on the chart: TradingView did not add the script. The console of ' +
        'the Pine Editor (pine_get_console) may say why.',
    );
  } else if (compileError === true && compiled.errors.length === 0) {
    warnings.push(
      'TradingView reports a compile error for the added study, but the console of the Pine ' +
        'Editor gave no details: check it with pine_get_console.',
    );
  }
  return toCompileResult(compiled, found.last, now());
}

export const pineCompile = defineTool({
  name: 'pine_compile',
  domain: 'pine',
  title: 'Compile a Pine script',
  description:
    'Compiles a Pine script with the compiler of TradingView. With source, compiles that text; ' +
    'without, the text of the Pine Editor (NOT_AVAILABLE when it is closed; pine_open or pine_new ' +
    'opens it). Compiling alone saves nothing and touches neither the editor nor the chart. ' +
    'addToChart: true adds the script of the editor to the chart instead, as its Add to chart ' +
    'button does: the indicator limit of the plan is checked first (a full chart fails with ' +
    'PLAN_LIMIT, error.details.feature INDICATORS_ON_CHART and limit, and a limit that cannot be ' +
    'read on this TradingView build with NOT_AVAILABLE; either way nothing is added); a new ' +
    'script or draft is saved by TradingView as a server draft (version 0.x) on the way; a saved ' +
    'script with unsaved changes is refused with NOT_AVAILABLE (save it with pine_save first), ' +
    'and signed out the call fails with AUTH_REQUIRED. source and addToChart together fail with ' +
    'INVALID_INPUT. Returns success, errors and warnings (each with 1-based line and column, ' +
    'endLine and endColumn, the end column included or null for none, message and severity), ' +
    'addedToChart, studyId (the added study, which indicator_remove removes without confirm) and ' +
    'compiledAt (Unix seconds) with compiledAtIso. Compile errors are a result, not a failure; a failure of TradingView to compile ' +
    'at all (such as a text too large) is NOT_AVAILABLE with its message. pine_get_errors ' +
    'returns the last result again.',
  inputSchema: {
    source: z
      .string()
      .max(MAX_SOURCE)
      .optional()
      .describe('The Pine Script text to compile. Default: the text of the Pine Editor.'),
    addToChart: z
      .boolean()
      .optional()
      .describe(
        'true to add the script of the Pine Editor to the chart instead of only compiling it. ' +
          'Cannot be combined with source. Default: false.',
      ),
  },
  // Adding to the chart adds a study; nothing is replaced or removed.
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  core: true,
  async handler({ source, addToChart }, ctx) {
    if (source !== undefined && addToChart === true) {
      throw new TvMcpError(
        'INVALID_INPUT',
        'source and addToChart cannot be combined: addToChart adds the script of the Pine Editor',
        {
          hint:
            'Put the text in the editor with pine_set_source first, then call pine_compile with ' +
            'addToChart: true alone.',
        },
      );
    }
    const page = await ctx.connection.chartPage();
    const warnings: string[] = [];
    let result: PineCompileResult;
    if (addToChart === true) {
      // From the check of the room to the end of the add, the other actions on plan limits wait.
      result = await inPlanLimitedTurn(() => addEditorScript(page, ctx, warnings));
    } else {
      const text = source ?? (await editorSource(page));
      result = await compileSource(page, text, pageWaitMs(ctx.config.callTimeoutMs));
    }
    ctx.session.lastPineCompile = result;
    return { data: result, via: 'internal', warnings };
  },
});

// What pine_get_errors and the resource tradingview://pine/errors report: the result of the last
// compilation of this session, or an empty one while there has been none.
export function readPineErrorsData(ctx: ToolContext): PineCompileResult {
  return (
    ctx.session.lastPineCompile ?? {
      success: true,
      errors: [],
      warnings: [],
      addedToChart: false,
      studyId: null,
      compiledAt: null,
      compiledAtIso: null,
    }
  );
}

export const pineGetErrors = defineTool({
  name: 'pine_get_errors',
  domain: 'pine',
  title: 'Read the last Pine compile errors',
  description:
    'Returns the result of the last pine_compile of this session again, unchanged (that of the ' +
    'last attempt for pine_smart_compile): success, errors, warnings, addedToChart, studyId, ' +
    'compiledAt (Unix seconds) and compiledAtIso. Before any compilation in this session it ' +
    'returns an empty result: success true, no errors or warnings, and compiledAt and ' +
    'compiledAtIso null. It asks TradingView nothing and changes nothing; pine_compile compiles anew.',
  inputSchema: {},
  annotations: READ_ONLY,
  core: true,
  handler(_input, ctx) {
    return Promise.resolve({ data: readPineErrorsData(ctx), via: 'internal' as const });
  },
});

export const pineGetConsole = defineTool({
  name: 'pine_get_console',
  domain: 'pine',
  title: 'Read the Pine console',
  description:
    'Reads the console of the Pine Editor (compile messages and errors) and the Pine log ' +
    'messages (log.info, log.warning, log.error) of the scripts on the active chart, newest ' +
    'first, at most limit, and changes nothing. Each message has level, text and source (editor ' +
    'or script). A script message has time (Unix seconds) and timeIso and the studyId of its ' +
    'study. TradingView keeps only a local clock time without a date for an editor message, so ' +
    'its time and timeIso are null and clock holds that time as TradingView shows it; editor ' +
    'messages are placed among the others by that clock, read as today or, when later than now, ' +
    'yesterday. Editor messages need an open editor (a warning says when it is closed). A script ' +
    'whose logs TradingView holds none of may not have its logs enabled: a warning names it, and ' +
    'opening the Pine Logs panel of TradingView enables them; this tool does not.',
  inputSchema: {
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe('The most messages to return, newest first. Default: 100.'),
  },
  annotations: READ_ONLY,
  async handler({ limit }, ctx) {
    const page = await ctx.connection.chartPage();
    const reading = await page.bridge.evaluateWithLib(readPineConsole, []);
    const warnings: string[] = [];
    if (!reading.editorOpen) {
      warnings.push(
        'The Pine Editor is not open, so its console was not read; pine_open or pine_new opens it.',
      );
    } else if (reading.editor === null) {
      warnings.push('The console of the Pine Editor could not be read on this build.');
    }
    if (reading.silentStudies.length > 0) {
      warnings.push(
        `TradingView holds no Pine logs for ${reading.silentStudies.join(', ')}, whose script ` +
          'writes logs: they are probably not enabled, which opening the Pine Logs panel of ' +
          'TradingView for the study does. This tool does not enable them.',
      );
    }
    return {
      data: { messages: mergeConsoleMessages(reading, limit ?? 100) },
      via: 'internal',
      warnings,
    };
  },
});

export const pineCompileTools: AnyToolDefinition[] = [pineCompile, pineGetErrors, pineGetConsole];
