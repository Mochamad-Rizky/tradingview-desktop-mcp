import { z } from 'zod';
import type { PageHandle } from '../../core/connection.js';
import { PlanLimitError, TvMcpError } from '../../core/errors.js';
import { getPlanLimits, requireBelowLimit } from '../../core/tv/plan-limits.js';
import { READ_ONLY } from '../annotations.js';
import { pageWaitMs } from '../chart/strategies.js';
import { defineTool, type AnyToolDefinition, type ToolContext, type ToolOutput } from '../types.js';
import { analyzePine, pineVersion } from './analyze/analyze.js';
import { compileSource, pineCompileTools } from './compile.js';
import {
  ensureEditorOpen,
  notOpenError,
  readEditorState,
  requireUnmodifiedOrConfirmed,
  type PineEditorState,
} from './editor.js';
import { pineOutputTools } from './outputs.js';
import {
  changePineEditor,
  readPineSource,
  readSavedPineScripts,
  savePineScript,
  type PineEditorChange,
} from './page.js';
import {
  countedScripts,
  findSavedScripts,
  isOpenLimited,
  savedScriptLimit,
  toSavedScript,
  type SavedScriptRow,
} from './scripts.js';
import { smartCompile } from './smart-compile.js';

// The Pine tools (design spec 7, domain Pine). These start a new script, open a saved one, read
// and replace the text of the Pine Editor, list the saved scripts, save, analyze a text and compile
// it with fixes; the compile tools (compile.ts) and the output tools (outputs.ts, what the scripts
// on the chart drew) join them in pineTools.
//
// They touch the user's saved scripts and the unsaved text of the editor, so they keep to these
// rules (design spec 5.3): no text in the editor is replaced while it has unsaved changes unless
// the call passes confirm: true; a new version of a saved script this session did not create needs
// confirm: true; nothing deletes or renames a script; the saved-script limit of the plan is checked
// with read-only replicas of the checks of the app before anything could open its paywall; and
// nothing calls what would open a dialog of TradingView (the naming dialog of a new script, the
// sign-in dialog). The text of the editor is returned by pine_get_source only and never logged, and
// the template of a new script, which names the account, is never returned.

// The tools that can replace the text of the editor, which with confirm: true can be unsaved text.
const REPLACES_TEXT = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const MAX_SOURCE = 500_000;

const LIMIT_HINT =
  'The plan of the account limits saved Pine scripts. Free a slot in TradingView or upgrade the ' +
  'plan; this server deletes no script.';

const confirmInput = (what: string) =>
  z
    .boolean()
    .optional()
    .describe(
      `Must be true to ${what} while the Pine Editor holds unsaved changes, which are then lost.`,
    );

const sourceInput = () =>
  z.string().max(MAX_SOURCE).describe('The Pine Script source, the whole text of the script.');

// What a tool that changed the editor returns about it.
function editorData(state: PineEditorState) {
  return { script: state.script, modified: state.modified, draft: state.draft };
}

// Makes the change with the guard on unsaved text checked twice: here on the state the editor was
// opened with, and in the page right before the facade acts. A text change that says what the
// editor must hold (expect) is guarded in the page only, where that is looked at first, so that an
// editor that has changed is told from unsaved text this call may not replace. Answers the state
// afterwards and, when nothing was changed because the editor did not hold what was expected,
// which part it did not hold (null when the change was made).
async function changeEditor(
  page: PageHandle,
  ctx: ToolContext,
  action: string,
  confirm: boolean | undefined,
  change: (allowModified: boolean) => PineEditorChange,
  warnings: string[],
): Promise<{ state: PineEditorState; differs: 'script' | 'text' | null }> {
  const opened = await ensureEditorOpen(page, pageWaitMs(ctx.config.callTimeoutMs), warnings);
  const wanted = change(confirm === true);
  if (wanted.kind !== 'source' || wanted.expect === undefined) {
    requireUnmodifiedOrConfirmed(opened, confirm, action);
  }
  const outcome = await page.bridge.evaluateWithLib(changePineEditor, [wanted]);
  return {
    state: await readEditorState(page, warnings),
    differs: outcome.changed ? null : outcome.differs,
  };
}

// The saved scripts of the account and the saved-script limit the app applies to them, null when
// it applies none.
async function loadSavedScripts(page: PageHandle): Promise<{
  authenticated: boolean;
  scripts: SavedScriptRow[];
  limit: number | null;
}> {
  const listing = await page.bridge.evaluateWithLib(readSavedPineScripts, []);
  const limits = await getPlanLimits(page, ['SAVED_PINE_SCRIPTS']);
  return {
    authenticated: listing.authenticated,
    scripts: listing.scripts,
    limit: savedScriptLimit(listing, limits.SAVED_PINE_SCRIPTS),
  };
}

// The body of pine_get_source, which the pine/source resource shares: the text of the open editor,
// its script and whether it has unsaved changes. It never opens the editor.
export async function readPineSourceData(ctx: ToolContext): Promise<{
  data: {
    source: string;
    script: PineEditorState['script'];
    modified: boolean;
  };
  warnings: string[];
}> {
  const page = await ctx.connection.chartPage();
  const warnings: string[] = [];
  const state = await readEditorState(page, warnings);
  if (!state.open) {
    throw notOpenError();
  }
  const { source } = await page.bridge.evaluateWithLib(readPineSource, []);
  if (source === null) {
    throw notOpenError();
  }
  return { data: { source, script: state.script, modified: state.modified }, warnings };
}

export const pineNew = defineTool({
  name: 'pine_new',
  domain: 'pine',
  title: 'Start a new Pine script',
  description:
    'Starts a new script in the Pine Editor of TradingView, opening the editor if needed: the ' +
    'template of the type (indicator by default, strategy or library), or the given source in ' +
    'its place. Nothing is saved; pine_save saves it under a name. Returns type, script (null ' +
    'for a new script), modified and draft; the template text is not returned (pine_get_source ' +
    'reads the text). When the editor holds unsaved changes the call fails with ' +
    'CONFIRMATION_REQUIRED and changes nothing, unless confirm: true, which discards them.',
  inputSchema: {
    type: z
      .enum(['indicator', 'strategy', 'library'])
      .optional()
      .describe('What kind of script to start. Default: indicator.'),
    source: sourceInput()
      .optional()
      .describe('The source of the new script, in place of the template. Default: the template.'),
    confirm: confirmInput('start a new script'),
  },
  annotations: REPLACES_TEXT,
  core: true,
  async handler({ type, source, confirm }, ctx) {
    const kind = type ?? 'indicator';
    const page = await ctx.connection.chartPage();
    const warnings: string[] = [];
    const { state } = await changeEditor(
      page,
      ctx,
      'pine_new',
      confirm,
      (allowModified) => ({ kind: 'new', type: kind, source: source ?? null, allowModified }),
      warnings,
    );
    return { data: { type: kind, ...editorData(state) }, via: 'internal', warnings };
  },
});

export const pineOpen = defineTool({
  name: 'pine_open',
  domain: 'pine',
  title: 'Open a saved Pine script',
  description:
    'Opens a saved script of the account in the Pine Editor of TradingView, opening the editor ' +
    'if needed. Give exactly one of scriptId (from pine_list_scripts) and name (the name or the ' +
    'title of the script, case aside). Returns script (id and version), name, modified and ' +
    'draft. An unknown or ambiguous name fails with INVALID_INPUT (the candidates are in ' +
    'error.details.candidates). A script the plan of the account does not let TradingView open ' +
    '(only the newest saved scripts within the limit can be) fails with PLAN_LIMIT. When the ' +
    'editor holds unsaved changes the call fails with CONFIRMATION_REQUIRED and changes nothing, ' +
    'unless confirm: true, which discards them.',
  inputSchema: {
    scriptId: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('The id of the saved script, as pine_list_scripts reports it.'),
    name: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('The name or the title of the saved script, case aside.'),
    confirm: confirmInput('open the script'),
  },
  annotations: REPLACES_TEXT,
  async handler({ scriptId, name, confirm }, ctx) {
    let wanted: { scriptId: string } | { name: string };
    if (scriptId !== undefined && name === undefined) {
      wanted = { scriptId };
    } else if (name !== undefined && scriptId === undefined) {
      wanted = { name };
    } else {
      throw new TvMcpError('INVALID_INPUT', 'Give exactly one of scriptId and name', {
        hint: 'Pass the id from pine_list_scripts as scriptId, or the name of the script as name.',
      });
    }
    const page = await ctx.connection.chartPage();
    const saved = await loadSavedScripts(page);
    const matches = findSavedScripts(saved.scripts, wanted);
    const label = 'scriptId' in wanted ? `with the id ${wanted.scriptId}` : `named ${wanted.name}`;
    const [match] = matches;
    if (match === undefined) {
      throw new TvMcpError('INVALID_INPUT', `No saved Pine script ${label}`, {
        hint:
          'Call pine_list_scripts for the saved scripts and their ids.' +
          (saved.authenticated ? '' : ' TradingView lists none while no account is signed in.'),
        details: { ...wanted },
      });
    }
    if (matches.length > 1) {
      throw new TvMcpError(
        'INVALID_INPUT',
        `${String(matches.length)} saved Pine scripts are ${label}`,
        {
          hint: 'Pass the id of the one to open as scriptId.',
          details: { candidates: matches.map(({ scriptIdPart }) => scriptIdPart) },
        },
      );
    }
    const title = match.scriptName ?? match.scriptTitle ?? match.scriptIdPart;
    if (saved.limit !== null && isOpenLimited(saved.scripts, match.scriptIdPart, saved.limit)) {
      throw new PlanLimitError(
        'SAVED_PINE_SCRIPTS',
        saved.limit,
        `The plan lets TradingView open only the ${String(saved.limit)} most recently changed ` +
          `saved Pine scripts, and ${title} is not one of them`,
        LIMIT_HINT,
      );
    }
    const warnings: string[] = [];
    const { state } = await changeEditor(
      page,
      ctx,
      'pine_open',
      confirm,
      (allowModified) => ({
        kind: 'open',
        scriptIdPart: match.scriptIdPart,
        version: match.version,
        source: null,
        allowModified,
      }),
      warnings,
    );
    // TradingView opens a new script whenever opening the saved one fails.
    if (state.script?.id !== match.scriptIdPart) {
      throw new TvMcpError(
        'NOT_AVAILABLE',
        `The saved Pine script ${title} could not be opened: TradingView opened a new script instead`,
        {
          hint:
            'No unsaved text was lost. Try again in a moment, or open the script in TradingView ' +
            'itself.',
          details: { id: match.scriptIdPart },
        },
      );
    }
    return {
      data: { ...editorData(state), name: title },
      via: 'internal',
      warnings,
    };
  },
});

export const pineGetSource = defineTool({
  name: 'pine_get_source',
  domain: 'pine',
  title: 'Read the Pine source',
  description:
    'Reads the text of the Pine Editor of TradingView and changes nothing. Returns source, ' +
    'script (its id and version; null for a new script, and a version of null when TradingView ' +
    'reports none) and modified (whether the text has unsaved changes). It does not open the ' +
    'editor: when it is closed the call fails with NOT_AVAILABLE; pine_open or pine_new opens it.',
  inputSchema: {},
  annotations: READ_ONLY,
  core: true,
  async handler(_input, ctx) {
    const { data, warnings } = await readPineSourceData(ctx);
    return { data, via: 'internal', warnings };
  },
});

export const pineSetSource = defineTool({
  name: 'pine_set_source',
  domain: 'pine',
  title: 'Replace the Pine source',
  description:
    'Replaces the text of the Pine Editor of TradingView with source, keeping the script it ' +
    'holds, and opens the editor first if needed (which restores the script it last held). ' +
    'Nothing is saved; pine_save does that. Returns script, modified and draft. When the editor ' +
    'holds unsaved changes the call fails with CONFIRMATION_REQUIRED and changes nothing, unless ' +
    'confirm: true, which discards them.',
  inputSchema: {
    source: sourceInput(),
    confirm: confirmInput('replace the text'),
  },
  annotations: REPLACES_TEXT,
  core: true,
  async handler({ source, confirm }, ctx) {
    const page = await ctx.connection.chartPage();
    const warnings: string[] = [];
    const { state } = await changeEditor(
      page,
      ctx,
      'pine_set_source',
      confirm,
      (allowModified) => ({ kind: 'source', source, allowModified }),
      warnings,
    );
    return { data: editorData(state), via: 'internal', warnings };
  },
});

export const pineListScripts = defineTool({
  name: 'pine_list_scripts',
  domain: 'pine',
  title: 'List saved Pine scripts',
  description:
    'Lists the saved Pine scripts of the account and changes nothing. Returns scripts, each with ' +
    'id (what pine_open takes), name, version (a version whose major part is 0 is a draft saved ' +
    'by TradingView), type (indicator, strategy or library) and modified (ISO 8601, or null). ' +
    'TradingView asks its server for the list the way its own editor does, and lists none while ' +
    'no account is signed in.',
  inputSchema: {},
  annotations: READ_ONLY,
  async handler(_input, ctx) {
    const page = await ctx.connection.chartPage();
    const listing = await page.bridge.evaluateWithLib(readSavedPineScripts, []);
    const warnings = listing.authenticated
      ? []
      : ['No TradingView account is signed in, so TradingView lists no saved scripts.'];
    return { data: { scripts: listing.scripts.map(toSavedScript) }, via: 'internal', warnings };
  },
});

// The error for a save that TradingView refused or that has compile errors. A script that was
// saved nonetheless is named in the details.
function saveFailure(
  errors: { message: string; line: number | null; column: number | null }[],
  script: { id: string; version: string | null } | null,
): TvMcpError {
  if (errors.length === 0) {
    return new TvMcpError(
      'NOT_AVAILABLE',
      'TradingView did not save the script and gave no reason',
      {
        hint: 'Check the console of the Pine Editor in TradingView.',
      },
    );
  }
  const count = `${String(errors.length)} compile error${errors.length === 1 ? '' : 's'}`;
  return new TvMcpError(
    'INVALID_INPUT',
    script === null
      ? `TradingView did not save the script: it has ${count}`
      : `TradingView saved the script as ${script.id}, but it has ${count}`,
    {
      hint: 'Fix the errors (error.details.errors gives line, column and message), then save again.',
      details: { errors, script, saved: script !== null },
    },
  );
}

export const pineSave = defineTool({
  name: 'pine_save',
  domain: 'pine',
  title: 'Save the Pine script',
  description:
    'Saves the script in the Pine Editor of TradingView. A new script, or a draft TradingView ' +
    'saved on its own (version 0.x, which stays as it is), is saved as a new script under name, ' +
    'which it needs (TradingView would ask for it in a dialog) and which no saved script may have; the ' +
    'saved-script limit of the plan is checked first and fails with PLAN_LIMIT (error.details ' +
    'feature SAVED_PINE_SCRIPTS and limit). A saved script gets a new version under its own ' +
    'name: one this session did not create needs confirm: true, else the call fails with ' +
    'CONFIRMATION_REQUIRED and saves nothing. Scripts are never renamed: a name other than the ' +
    'current one fails with INVALID_INPUT. Returns script (id and version) and created. Compile ' +
    'errors fail with INVALID_INPUT and the errors in error.details.errors. Needs a signed-in ' +
    'account (AUTH_REQUIRED) and an open editor (NOT_AVAILABLE).',
  inputSchema: {
    name: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe(
        'The name of a new script, needed for one. For a saved script it may only repeat its ' +
          'current name.',
      ),
    confirm: z
      .boolean()
      .optional()
      .describe(
        'Must be true to save a new version of a saved script this session did not create, ' +
          "which was the user's. Not needed for a new script or one pine_save created.",
      ),
  },
  // It adds a script or a version; it replaces nothing.
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  async handler({ name, confirm }, ctx) {
    const page = await ctx.connection.chartPage();
    const warnings: string[] = [];
    const state = await readEditorState(page, warnings);
    if (!state.open) {
      throw notOpenError();
    }
    const wantedName = name?.trim();
    // A server draft (a version whose major part is 0, which TradingView saves on its own, for
    // example when a new script is added to the chart) is not a saved script of the user: it is
    // saved as a new script, and the draft stays as it is.
    const draftOf =
      state.script !== null &&
      state.script.version !== null &&
      Number.parseInt(state.script.version, 10) === 0
        ? state.script.id
        : null;

    if (state.script === null || draftOf !== null) {
      if (wantedName === undefined || wantedName === '') {
        throw new TvMcpError('INVALID_INPUT', 'A new Pine script needs a name to be saved', {
          hint:
            'Pass name: TradingView would otherwise ask for one in a dialog. A draft TradingView ' +
            'saved on its own is saved as a new script too.',
        });
      }
      const saved = await loadSavedScripts(page);
      requireSignedIn(saved.authenticated);
      const taken = findSavedScripts(saved.scripts, { name: wantedName })[0];
      if (taken !== undefined) {
        throw new TvMcpError(
          'INVALID_INPUT',
          `A saved Pine script is already named ${wantedName}`,
          {
            hint: 'Choose another name. This server never overwrites a saved script.',
            details: { id: taken.scriptIdPart },
          },
        );
      }
      // The check isSaveBlockedByPaywall of the app, which would open the paywall.
      requireBelowLimit(
        'SAVED_PINE_SCRIPTS',
        countedScripts(saved.scripts).length,
        saved.limit,
        LIMIT_HINT,
      );
      const outcome = await page.bridge.evaluateWithLib(savePineScript, [
        { kind: 'new', name: wantedName, draftOf },
      ]);
      if (outcome.script !== null) {
        ctx.session.createdScriptIds.add(outcome.script.id);
      }
      if (outcome.script === null || outcome.errors.length > 0) {
        throw saveFailure(outcome.errors, outcome.script);
      }
      if (outcome.tracked !== true) {
        warnings.push(
          `The script was saved as ${outcome.script.id}, but the Pine Editor could not be ` +
            'switched to it and may show a new script: open the saved one with pine_open.',
        );
      }
      return { data: { script: outcome.script, created: true }, via: 'internal', warnings };
    }

    const { id, version } = state.script;
    if (!state.modified && wantedName === undefined) {
      return nothingToSave(state.script, warnings);
    }
    if (state.modified && confirm !== true && !ctx.session.createdScriptIds.has(id)) {
      throw new TvMcpError(
        'CONFIRMATION_REQUIRED',
        `Saving a new version of ${id} needs confirmation: this session did not create the script`,
        {
          hint:
            "The script is the user's. Make sure the user wants a new version saved, then call " +
            'pine_save again with confirm: true.',
          details: { id },
        },
      );
    }
    const saved = await loadSavedScripts(page);
    requireSignedIn(saved.authenticated);
    const current = saved.scripts.find(({ scriptIdPart }) => scriptIdPart === id);
    if (wantedName !== undefined && current?.scriptName?.trim() !== wantedName) {
      throw new TvMcpError(
        'INVALID_INPUT',
        current?.scriptName === null || current === undefined
          ? `The name of ${id} is not known, so name cannot be checked against it`
          : `The script is named ${current.scriptName}; pine_save never renames a script`,
        {
          hint: 'Leave name out to save a new version under the current name.',
          details: { id },
        },
      );
    }
    if (!state.modified) {
      return nothingToSave(state.script, warnings);
    }
    if (version === null || state.draft) {
      throw new TvMcpError(
        'NOT_AVAILABLE',
        version === null
          ? `TradingView did not report the version of ${id}, so it cannot be saved safely`
          : `TradingView reports ${id} (version ${version}) as a draft, which it saves only ` +
              'through its naming dialog',
        {
          hint:
            'Save it in the Pine Editor of TradingView itself, or start a new script with ' +
            'pine_new, set its source and save that with a name.',
          details: { id, version },
        },
      );
    }
    // The check isScriptUpdateBlockedByPaywall of the app, which would open the paywall.
    if (saved.limit !== null && isOpenLimited(saved.scripts, id, saved.limit)) {
      throw new PlanLimitError(
        'SAVED_PINE_SCRIPTS',
        saved.limit,
        `The plan lets TradingView update only the ${String(saved.limit)} most recently ` +
          `changed saved Pine scripts, and ${id} is not one of them`,
        LIMIT_HINT,
      );
    }
    const outcome = await page.bridge.evaluateWithLib(savePineScript, [
      { kind: 'version', scriptIdPart: id },
    ]);
    if (outcome.script === null || outcome.errors.length > 0) {
      throw saveFailure(outcome.errors, outcome.script);
    }
    return { data: { script: outcome.script, created: false }, via: 'internal', warnings };
  },
});

// Fails AUTH_REQUIRED while no account is signed in: the app would ask the user to sign in.
function requireSignedIn(authenticated: boolean): void {
  if (!authenticated) {
    throw new TvMcpError(
      'AUTH_REQUIRED',
      'Saving a Pine script needs a signed-in TradingView account',
      {
        hint: 'Sign in to TradingView, then save again.',
      },
    );
  }
}

// The answer of pine_save for a saved script without unsaved changes, which saves nothing.
function nothingToSave(
  script: NonNullable<PineEditorState['script']>,
  warnings: string[],
): ToolOutput<{ script: NonNullable<PineEditorState['script']>; created: boolean }> {
  warnings.push('The script has no unsaved changes, so there was nothing to save.');
  return { data: { script, created: false }, via: 'internal', warnings };
}

export const pineAnalyze = defineTool({
  name: 'pine_analyze',
  domain: 'pine',
  title: 'Analyze Pine source offline',
  description:
    'Checks Pine Script source with deterministic rules, locally and without compiling: a ' +
    'missing or old //@version, v4 names that moved to a namespace in v5 (study, security, ' +
    'tostring, sma, ema, rsi, ...), a missing indicator()/strategy()/library() declaration, ' +
    'strategy.* calls in an indicator, lookahead_on repainting and more than 64 plot calls. ' +
    'Returns version (from //@version, or null) and diagnostics sorted by line and column: ' +
    'ruleId, severity (error, warning, info), line and column (1-based, UTF-16 code units), ' +
    'message and fix (single-line edits, or null when the rule has none). With source it works ' +
    'while TradingView is down; without it, it analyzes the text of the Pine Editor and fails ' +
    'NOT_AVAILABLE when the editor is closed. It changes nothing; pine_smart_compile applies ' +
    'the fixes.',
  inputSchema: {
    source: sourceInput()
      .optional()
      .describe('The Pine source to analyze. Default: the text of the Pine Editor.'),
  },
  annotations: READ_ONLY,
  async handler({ source }, ctx) {
    const local = source !== undefined;
    const read = local ? { data: { source }, warnings: [] } : await readPineSourceData(ctx);
    return {
      data: {
        version: pineVersion(read.data.source),
        diagnostics: analyzePine(read.data.source),
      },
      via: local ? 'local' : 'internal',
      warnings: read.warnings,
    };
  },
});

// How the guard on unsaved text names pine_smart_compile when it writes back.
const WRITE_BACK = 'pine_smart_compile with writeBack';

// The text pine_smart_compile starts from, and what the editor must still hold for the result to be
// written back to it. A given source is written wherever the editor is when the write comes, under
// the usual guard, so it expects nothing. The text of the editor is written back only to the
// editor that held it: the same script (its id, null for a new script) with that same text, which
// is checked when the text is written, long after it was read.
async function startOf(
  ctx: ToolContext,
  source: string | undefined,
  warnings: string[],
): Promise<{ text: string; held: { scriptId: string | null; source: string } | null }> {
  if (source !== undefined) {
    return { text: source, held: null };
  }
  const read = await readPineSourceData(ctx);
  warnings.push(...read.warnings);
  const text = read.data.source;
  return { text, held: { scriptId: read.data.script?.id ?? null, source: text } };
}

// How many compilations pine_smart_compile makes at most when it is not told.
const DEFAULT_ATTEMPTS = 3;

export const pineSmartCompile = defineTool({
  name: 'pine_smart_compile',
  domain: 'pine',
  title: 'Compile a Pine script and fix it',
  description:
    'Compiles a Pine script with the compiler of TradingView and, while it has errors, applies ' +
    'deterministic fixes and compiles again, at most maxAttempts compilations (1 to 5, default ' +
    `${String(DEFAULT_ATTEMPTS)}). ` +
    'The fixes are fixed rules and no AI model is involved: the Pine v4 names that v5 renamed or ' +
    'moved into a namespace (study to indicator, security to request.security, tostring to ' +
    'str.tostring, and sma, ema, rsi, macd, stoch, atr, crossover, crossunder, highest, lowest ' +
    'and change to ta.*) and a missing //@version=6, each applied where pine_analyze finds it or ' +
    'a compile error points at it, and only to a script of version 5 or later or without a ' +
    'version. With source it works on that text; without, on the text of the Pine Editor ' +
    '(NOT_AVAILABLE when it is closed; pine_open or pine_new opens it). Returns success (whether ' +
    'the last attempt compiled), attempts (in order, each with errors, those of that ' +
    'compilation, and applied, the descriptions of the fixes applied after it, such as ' +
    '"Replace rsi( with ta.rsi(", which made the text of the next attempt), source (the final ' +
    'text, the one the last attempt compiled), diff (a unified diff of what the fixes changed, ' +
    'line breaks aside, empty when nothing changed) and writtenBack. It stops early when no fix ' +
    'changes the text. A fix is applied only when another compilation follows, so maxAttempts 1 ' +
    'or applyFixes: false compiles once and changes nothing. The compilations share one time ' +
    'limit, that of one page call: each waits only for the time left, and when too little is ' +
    'left for another attempt the call stops there, applies no further fix and says so in a ' +
    'warning. Compile errors are a result; a failure of TradingView to compile at all is ' +
    'NOT_AVAILABLE or TIMEOUT. Nothing is written to the editor unless writeBack: true, which ' +
    'writes the final text into it, as pine_set_source does, when it differs from the text the ' +
    'call started with. An editor with unsaved changes needs confirm: true. An open one is ' +
    'refused with CONFIRMATION_REQUIRED before anything is compiled, and a closed one that the ' +
    'write opens, and that restores unsaved text when it opens, is refused then, after the ' +
    'compilations; either way nothing is written. When the text came from the editor, it is ' +
    'written back only if the editor still holds the same script and text when the write comes ' +
    '(checked in the page, right before it acts, whatever confirm says); else nothing is ' +
    'written, writtenBack is false, a warning says that the editor changed and the result is ' +
    'still returned. Nothing is saved or added to the chart. ' +
    'pine_get_errors returns the full result of the last compilation, warnings included.',
  inputSchema: {
    source: sourceInput()
      .optional()
      .describe('The Pine source to compile and fix. Default: the text of the Pine Editor.'),
    maxAttempts: z
      .number()
      .int()
      .min(1)
      .max(5)
      .optional()
      .describe(
        'The most compilations to make, 1 to 5. Fixes are applied between two of them. ' +
          `Default: ${String(DEFAULT_ATTEMPTS)}.`,
      ),
    applyFixes: z
      .boolean()
      .optional()
      .describe('false to compile once and apply no fix. Default: true.'),
    writeBack: z
      .boolean()
      .optional()
      .describe(
        'true to write the final text into the Pine Editor when the fixes changed it. ' +
          'Default: false.',
      ),
    confirm: z
      .boolean()
      .optional()
      .describe(
        'Must be true for writeBack while the Pine Editor holds unsaved changes, which the ' +
          'written text then replaces. Default: false.',
      ),
  },
  // Only writeBack changes anything, by replacing the text of the editor, which with confirm: true
  // can be unsaved text.
  annotations: REPLACES_TEXT,
  core: true,
  async handler({ source, maxAttempts, applyFixes: fix, writeBack, confirm }, ctx) {
    const page = await ctx.connection.chartPage();
    // One time limit for the compilations, that of one page call: they share it, so that up to
    // five slow ones cannot take several times what a client waits for a call.
    const deadline = Date.now() + pageWaitMs(ctx.config.callTimeoutMs);
    const warnings: string[] = [];
    const limit = maxAttempts ?? DEFAULT_ATTEMPTS;
    // Before anything is compiled, so that a refusal wastes no compilation. The write checks
    // again when it happens (changeEditor). Without a fix to make, and a fix is made only when
    // another attempt follows, nothing is ever written.
    if (writeBack === true && fix !== false && limit > 1) {
      requireUnmodifiedOrConfirmed(await readEditorState(page), confirm, WRITE_BACK);
    }
    const { text: start, held } = await startOf(ctx, source, warnings);
    const run = await smartCompile(
      async (text, waitMs) => {
        const result = await compileSource(page, text, waitMs);
        // What pine_get_errors returns from now on, so that a failure of a later attempt (a
        // TIMEOUT, say) leaves this result there, not that of an older call.
        ctx.session.lastPineCompile = result;
        return result;
      },
      start,
      { maxAttempts: limit, applyFixes: fix !== false, deadline },
    );
    if (run.outOfTime) {
      warnings.push(
        `Stopped after attempt ${String(run.attempts.length)}: the time limit of the call left ` +
          'too little time to compile the fixed text again, so the fixes found for the errors of ' +
          'that attempt were not applied. source is the text it compiled; call ' +
          'pine_smart_compile again with it to go on.',
      );
    }

    let writtenBack = false;
    if (writeBack === true && run.source === start) {
      warnings.push(
        'writeBack was asked for, but no fix changed the text, so the Pine Editor was left as ' +
          'it is.',
      );
    } else if (writeBack === true) {
      const { differs } = await changeEditor(
        page,
        ctx,
        WRITE_BACK,
        confirm,
        (allowModified) => ({
          kind: 'source',
          source: run.source,
          allowModified,
          ...(held === null ? {} : { expect: held }),
        }),
        warnings,
      );
      writtenBack = differs === null;
      if (differs !== null) {
        warnings.push(
          'The Pine Editor changed while the script was compiled (' +
            (differs === 'script' ? 'it holds another script now' : 'its text changed') +
            '), so nothing was written back. The result is for what it held when the call ' +
            'started; call pine_smart_compile again to work on what it holds now.',
        );
      }
    }
    return {
      data: {
        success: run.success,
        attempts: run.attempts,
        source: run.source,
        diff: run.diff,
        writtenBack,
      },
      via: 'internal',
      warnings,
    };
  },
});

export const pineTools: AnyToolDefinition[] = [
  pineNew,
  pineOpen,
  pineGetSource,
  pineSetSource,
  pineListScripts,
  pineSave,
  pineAnalyze,
  ...pineCompileTools,
  pineSmartCompile,
  ...pineOutputTools,
];
