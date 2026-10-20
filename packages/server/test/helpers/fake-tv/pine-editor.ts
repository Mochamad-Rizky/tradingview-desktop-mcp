import type { TvStateFixture } from './fixture.js';

// The Pine Editor of the fake app, built from the pineEditor of the fixture (reverse-engineering
// notes of Plan 2, section Q1):
//
// - The registry module exports getOpenPineEditor(placement), which answers { getFacade } for the
//   placement an editor is registered under ("dialog" or "bottom") and null otherwise, with
//   registerOpenPineEditor and unregisterOpenPineEditor next to it. The current layout opens the
//   editor as the right side panel, which registers as "dialog" (seen on the app).
// - The facade has placement, awaitEditorReady, isModified (the text differs from the saved text),
//   isDraft (no script id, no version, or a version whose major part is 0), getScriptIdVersion
//   ({ scriptIdPart, version } or null; the version is undefined when the script has none),
//   getSource (rejects while the editor is not mounted, like the ensureNotNull of the app),
//   setScript, openNewScript(type) (the template of the type, the indicator template for any
//   other value), openScript, addToChart, updateOnChart, saveScript, releaseScript and destroy,
//   and the private _editorStore, whose getStore().getState().console.messages is the live console
//   of the editor (state.consoleMessages), entries { level, text, time } with time a local clock
//   time without a date, and start and end for a diagnostic (end.column one past the last column,
//   as the console of the app keeps it).
//   releaseScript and destroy reset the script, which discards the text, and unregister the editor,
//   as on the app. openScript with a source opens it as that script; without one it loads the
//   saved script of that id, and on any failure it opens a new script, as the app does.
//   saveScript saves a new version of a saved script under its name. For a draft it would ask the
//   user for a name in a dialog (dialog.renameScript), and signed out it would ask the user to sign
//   in (dialog.signIn); either way it rejects, as the app does when the dialog is cancelled.
//   addToChart adds the script the editor holds to the chart. Signed out it asks the user to sign
//   in (dialog.signIn); for a saved script with unsaved changes it asks in the modal dialog
//   confirmSaveChanges whether to save a new version first (dialog.confirmSaveChanges), which no
//   one answers here, so nothing is added; on a chart without room for a study it opens the paywall
//   (dialog.paywall). Otherwise it saves a new script as a server draft (version 0.1), compiles the
//   text with the fake compiler, adds a study of the script (with hasCompileError() true when the
//   text does not compile, as the app keeps a study that failed) and writes the compile messages
//   and diagnostics to the console. It resolves either way, as the app does.
// - TradingViewApi.pineEditorApi() answers the same object on every call: open(options), which
//   registers the editor at the opensAt placement of the fixture on the next turn of the event loop
//   and mounts it readyMs after the call. As on the app, the first open shows the script the
//   editor last held; an open after the side panel closed shows a new script, unless unsaved
//   changes were kept (state.unsavedKept), whose text it shows again as the text of the script, so
//   that isModified() reads false;
//   getDialogFacade and getBottomFacade; listSavedScripts, the same request as requestUserScripts;
//   saveNewScript, which checks the saved-script limit the way the app does, opening its paywall
//   (dialog.paywall) and throwing when the limit is reached, and else saves a new script; and
//   saveExistingScript, a stub that records its call.
// - The export requestUserScripts lists the saved scripts of the account as the app does: each
//   with its text (scriptSource) and its kind in extra, and none while signed out (signedIn false).
// - The export translateScriptAsync(source, pineId) of the same module compiles a text with the
//   fake compiler (compileFakePine) and sends nothing else: it resolves { success: true, metaInfo,
//   compileErrors } for a text without errors and rejects with an Error whose reason holds the
//   compile errors otherwise, as handleTranslateResult of the app does; with state.compileHttpError
//   set it rejects with that plain string, as the app does for an HTTP failure, and with
//   state.compileFirstErrorOnly set the compiler stops at its first error and reports only that.
// - The service locator module exports hasService, service, serviceOrNull, registerService,
//   unregisterService and waitServiceRegistered, keyed by service descriptors. The page layout
//   service, whose descriptor is the export PAGE_LAYOUT_SERVICE of another module, has
//   hasSidePanel, sidePanel, showSidePanel and closeSidePanel; closeSidePanel("pine") closes the
//   side panel and takes the editor out of the registry, keeping the script it held and whether
//   its text had unsaved changes (seen on the app).
// - Two more modules hold the keys (hasScriptModificationsKey, ...) and the helpers
//   (getPersistedValue, getPersistenceKey) the editor keeps its state between opens with;
//   getPersistedValue(key, perUser) answers the kept unsaved-changes flag.
// - TradingView.bottomWidgetBar.close() minimizes the bottom bar, which hides an editor at the
//   bottom placement and leaves it registered with its text, as the notes record.
//
// Every call that changes the editor, sends a request or opens or closes a panel or a dialog
// records itself (pineEditorApi.*, pineFacade.*, pageLayout.*, bottomWidgetBar.*, requestUserScripts,
// translateScriptAsync, dialog.*). Reads are not recorded. The sources are synthetic, and the templates name an invented
// author.

export type FakePineEditorPlacement = 'dialog' | 'bottom';

export interface FakePineScriptId {
  scriptIdPart: string;
  // Undefined for a script the editor holds without a version.
  version: string | undefined;
}

// A saved script of the account. A source of null cannot be loaded: openScript fails for it, the
// way the app fails when the request for the text fails.
export interface FakeSavedScript {
  scriptIdPart: string;
  scriptName: string;
  scriptTitle: string;
  version: string;
  modified: number;
  kind?: 'study' | 'strategy' | 'library' | undefined;
  source: string | null;
}

// A compile error as the pine facade reports it. message may hold {name} placeholders that ctx
// fills.
export interface FakePineDiagnostic {
  message: string;
  ctx?: Record<string, string>;
  code?: string;
  start?: { line: number; column: number };
  end?: { line: number; column: number };
}

// An entry of the console of the editor.
export interface FakeConsoleEntry {
  level: 'info' | 'warning' | 'error';
  text: string;
  // A local clock time without a date, as toLocaleTimeString gives it.
  time: string;
  start?: { line: number; column: number };
  end?: { line: number; column: number };
}

// The v4 names that a script of version 5 or later no longer has: study, security and tostring,
// and the functions that moved to the ta namespace. Where one is called without a namespace, the
// compiler cannot find the function.
const V4_ONLY_NAMES = [
  'study',
  'security',
  'tostring',
  'sma',
  'ema',
  'rsi',
  'macd',
  'stoch',
  'atr',
  'crossover',
  'crossunder',
  'highest',
  'lowest',
  'change',
];
const V4_CALL = new RegExp(`(?<![\\w.])(?:${V4_ONLY_NAMES.join('|')})(?=\\s*\\()`, 'g');

// The version a text declares with a //@version=N comment line, null for none, which the compiler
// reads as the first and oldest version of the language.
function declaredVersion(source: string): number | null {
  const match = /^[ \t]*\/\/[ \t]*@version[ \t]*=[ \t]*(\d+)/m.exec(source);
  return match?.[1] === undefined ? null : Number(match[1]);
}

// A line with its comment and the insides of its strings blanked out, so that the columns stay and
// only code is left to look at.
function codeOf(line: string): string {
  return line.replace(/\/\/.*$|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, (found) =>
    ' '.repeat(found.length),
  );
}

// Whether the text defines a function of that name (`name(...) =>` at the start of a line), whose
// calls are then declared.
const definesFunction = (source: string, name: string): boolean =>
  new RegExp(`^(?:export[ \\t]+)?${name}[ \\t]*\\([^)]*\\)[ \\t]*=>`, 'm').test(source);

// What the fake compiler finds in a text (lines split at CRLF, LF or CR, counted from 1), in the
// order of the text, as the compiler of TradingView reports them (seen on the app):
// - an error "Undeclared identifier" (code CE10272) for every word starting with undeclared_;
// - in a script of version 5 or later, an error "Could not find function or function reference"
//   (code CE10271) for a call of a v4 name without its namespace, after which the compiler stops
//   and reports nothing more (a version below 5, or none, compiles as an old version, which still
//   has the names; names in comments and strings and names the script defines as functions are
//   not found);
// - a warning for every word starting with deprecated_;
// - an error without a column (column 0, as the legacy messages of the app have) for every word
//   legacy_error.
// All but the last carry the 1-based columns of the word, the end included.
export function compileFakePine(source: string): {
  errors: FakePineDiagnostic[];
  warnings: FakePineDiagnostic[];
} {
  const errors: FakePineDiagnostic[] = [];
  const warnings: FakePineDiagnostic[] = [];
  const modern = (declaredVersion(source) ?? 1) >= 5;
  const defined = new Set(V4_ONLY_NAMES.filter((name) => definesFunction(source, name)));
  const lines = source.split(/\r\n|\n|\r/);
  for (const [index, text] of lines.entries()) {
    const line = index + 1;
    const at = (match: RegExpMatchArray) => ({
      start: { line, column: (match.index ?? 0) + 1 },
      end: { line, column: (match.index ?? 0) + match[0].length },
    });
    // What the line holds, in the order of its columns.
    const found: {
      column: number;
      list: FakePineDiagnostic[];
      item: FakePineDiagnostic;
      stops: boolean;
    }[] = [];
    for (const match of text.matchAll(/\bundeclared_\w*/g)) {
      found.push({
        column: match.index,
        list: errors,
        stops: false,
        item: {
          message: 'Undeclared identifier "{identifier}"',
          ctx: { identifier: match[0] },
          code: 'CE10272',
          ...at(match),
        },
      });
    }
    for (const match of modern ? codeOf(text).matchAll(V4_CALL) : []) {
      if (!defined.has(match[0])) {
        found.push({
          column: match.index,
          list: errors,
          stops: true,
          item: {
            message: "Could not find {kind} '{fullName}'",
            ctx: { fullName: match[0], kind: 'function or function reference' },
            code: 'CE10271',
            ...at(match),
          },
        });
      }
    }
    for (const match of text.matchAll(/\bdeprecated_\w*/g)) {
      found.push({
        column: match.index,
        list: warnings,
        stops: false,
        item: {
          message: 'The function {name} is deprecated',
          ctx: { name: match[0] },
          ...at(match),
        },
      });
    }
    for (const match of text.matchAll(/\blegacy_error\b/g)) {
      found.push({
        column: match.index,
        list: errors,
        stops: false,
        item: { message: `Syntax error at input "${match[0]}"`, start: { line, column: 0 } },
      });
    }
    for (const { list, item, stops } of found.sort((a, b) => a.column - b.column)) {
      list.push(item);
      if (stops) {
        return { errors, warnings };
      }
    }
  }
  return { errors, warnings };
}

// What a diagnostic says once its placeholders are filled, as the console shows it.
function resolveMessage(diagnostic: FakePineDiagnostic): string {
  return diagnostic.message.replace(
    /\{(\w+)\}/g,
    (all, name: string) => diagnostic.ctx?.[name] ?? all,
  );
}

// A local clock time like toLocaleTimeString in a 24-hour locale.
function clockOf(date: Date): string {
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

// The Error the app rejects a failed compilation with (PineCompileFailErrorImpl).
class FakePineCompileFailError extends Error {
  constructor(
    readonly reason: { errors: FakePineDiagnostic[]; warnings: FakePineDiagnostic[] },
    readonly metaInfo: Record<string, unknown>,
  ) {
    super('Pine translation failed');
  }
}

// The live state of the editor. Tests may assign to it to stage a situation, for example a source
// that differs from savedSource for unsaved changes.
export interface FakePineEditorState {
  // Where the editor is registered, or null when none is.
  placement: FakePineEditorPlacement | null;
  // Whether the side panel or the bottom bar shows the editor.
  visible: boolean;
  // Whether the code editor is mounted, so that getSource answers.
  ready: boolean;
  // The text in the editor, and the text of the script as it was opened or saved.
  source: string;
  savedSource: string;
  // The saved script the editor holds, or null for a new script that has no id yet.
  script: FakePineScriptId | null;
  // window.is_authenticated, which the editor and the script list read.
  signedIn: boolean;
  // The saved scripts of the account, which saving adds to.
  savedScripts: FakeSavedScript[];
  // The compile errors the pine facade answers a save with, which then saves nothing. Default null:
  // a save compiles.
  saveErrors: FakePineDiagnostic[] | null;
  // The live console of the editor, oldest first.
  consoleMessages: FakeConsoleEntry[];
  // The plain string translateScriptAsync rejects with, as for an HTTP failure. Default null.
  compileHttpError: string | null;
  // Whether the compiler stops at its first error and reports only that one, as one can when the
  // later errors depend on the first. The warnings are all reported. Default false.
  compileFirstErrorOnly: boolean;
  // What the app keeps for the editor between opens (has_unsaved_modifications, which its helper
  // getPersistedValue reads): whether the text has unsaved changes. Seen on the app: kept when the
  // side panel closes, not at once when the text changes, and cleared when a script is opened,
  // started or saved.
  unsavedKept: boolean;
  // Whether the editor was opened before in this session. Seen on the app: once it was, an open
  // after the side panel closed shows a new script, unless unsaved changes are kept, whose text it
  // shows again as the text of the script, so that isModified() reads false.
  openedBefore: boolean;
}

export interface FakePineEditorOptions {
  // How long after open() the editor is mounted. Infinity: never.
  readyMs: number;
  // The message open() rejects with. Default: it opens the editor.
  openError?: string | undefined;
  // Leaves the page layout service out of the service locator, as on a build without the side
  // panel.
  withoutPageLayoutService?: boolean | undefined;
  // The SAVED_PINE_SCRIPTS limit of the plan, and whether a toggle of the app is on: the paywall
  // check of saveNewScript applies the limit only while pine_free_saved_scripts_limit is on.
  savedScriptsLimit: number | undefined;
  isFeatureEnabled: (name: string) => boolean;
  record: (name: string, args: readonly unknown[]) => void;
  // Whether the chart has room for one more study, and how a study of a user script is added to it
  // (studies.ts). Called lazily, so the studies may be built after the editor.
  canAddStudy: () => boolean;
  addStudy: (script: {
    name: string;
    scriptIdPart: string;
    version: string;
    compileError: boolean;
  }) => string;
}

export interface FakePineEditorFacade {
  readonly placement: FakePineEditorPlacement | null;
  awaitEditorReady(): void;
  isModified(): boolean;
  isDraft(): boolean;
  getScriptIdVersion(): FakePineScriptId | null;
  getSource(): Promise<string>;
  setScript(source: string): Promise<void>;
  openNewScript(type?: string): Promise<void>;
  openScript(info?: {
    scriptIdPart?: string;
    version?: string;
    scriptSource?: string;
  }): Promise<void>;
  addToChart(): Promise<void>;
  updateOnChart(): Promise<void>;
  saveScript(label?: string): Promise<{
    script: { scriptIdPart: string; version: string; scriptName: string };
    compileErrors: undefined;
  }>;
  releaseScript(): void;
  destroy(): void;
  readonly _editorStore: {
    getStore(): {
      getState(): { console: { messages: FakeConsoleEntry[]; isVisible: boolean } };
    };
  };
}

export interface FakeOpenPineEditor {
  getFacade(): FakePineEditorFacade;
}

export interface FakePineEditorApi {
  open(options?: unknown): Promise<void>;
  getDialogFacade(): FakePineEditorFacade | null;
  getBottomFacade(): FakePineEditorFacade | null;
  listSavedScripts(): Promise<unknown[]>;
  saveNewScript(script: { source: string; name: string }): Promise<FakeSaveResult>;
  saveExistingScript(script: {
    scriptIdPart: string;
    source: string;
    name: string;
  }): Promise<{ success: boolean }>;
}

// What saveNewScript resolves with (handleSaveResult of the app).
export interface FakeSaveResult {
  success: boolean;
  metaInfo: { scriptIdPart?: string; pine?: { version: string } };
  compileErrors: { errors: FakePineDiagnostic[]; warnings: FakePineDiagnostic[] };
}

export interface FakeBottomWidgetBar {
  close(): void;
  isVisible(): { value(): boolean };
}

export interface FakePineEditor {
  readonly state: FakePineEditorState;
  // The webpack modules of the editor, by module ID: the registry, the service locator and the
  // descriptor of the page layout service.
  readonly modules: Record<string, Record<string, unknown>>;
  // What TradingViewApi.pineEditorApi() answers.
  readonly api: FakePineEditorApi;
  readonly bottomWidgetBar: FakeBottomWidgetBar;
}

// The descriptor of the page layout service: createServiceDescriptor returns the name it is given.
const PAGE_LAYOUT_SERVICE = 'PageLayoutService';

// What the major and minor parts of a script version are, as the Version class of the app reads
// them.
function majorOf(version: string): number {
  return Number.parseInt(version.split('.')[0] ?? '', 10);
}

function minorOf(version: string): number {
  return Number.parseInt(version.split('.')[1] ?? '0', 10);
}

// The UNLIMITED_FEATURE_LIMIT of the app (plan-limits.ts).
const UNLIMITED = 99999;

// The kind the pine facade gives a script, from the declaration in its source.
function kindOf(source: string): 'study' | 'strategy' | 'library' {
  return /^\s*strategy\s*\(/m.test(source)
    ? 'strategy'
    : /^\s*library\s*\(/m.test(source)
      ? 'library'
      : 'study';
}

export function createFakePineEditor(
  config: TvStateFixture['pineEditor'],
  options: FakePineEditorOptions,
): FakePineEditor {
  const { record } = options;
  const state: FakePineEditorState = {
    placement: config.open,
    visible: config.open !== null,
    ready: config.open !== null,
    source: config.source,
    savedSource: config.savedSource,
    script: config.script === null ? null : { ...config.script },
    signedIn: true,
    savedScripts: config.savedScripts.map((script) => ({ ...script })),
    saveErrors: null,
    consoleMessages: [],
    compileHttpError: null,
    compileFirstErrorOnly: false,
    unsavedKept: false,
    openedBefore: config.open !== null,
  };
  // How many scripts saveNewScript has created, for their ids.
  let created = 0;
  // How many server drafts addToChart has saved, for their ids.
  let drafts = 0;

  // The fake compiler, which reports only its first error while state.compileFirstErrorOnly is set.
  const compile = (source: string): ReturnType<typeof compileFakePine> => {
    const found = compileFakePine(source);
    return state.compileFirstErrorOnly ? { ...found, errors: found.errors.slice(0, 1) } : found;
  };

  // What requestUserScripts resolves with: the saved scripts in the shape the app lists them, with
  // their texts and their kinds in extra (seen on the app).
  const listScripts = (): Promise<unknown[]> =>
    Promise.resolve(
      state.signedIn
        ? state.savedScripts.map(
            ({ scriptIdPart, scriptName, scriptTitle, version, modified, kind, source }) => ({
              scriptIdPart,
              scriptName,
              scriptTitle,
              version,
              modified,
              isTVScriptBuiltIn: false,
              ...(source === null ? {} : { scriptSource: source }),
              extra: kind === undefined ? {} : { kind },
            }),
          )
        : [],
    );
  // isSaveBlockedByPaywall of the app, which opens the paywall when it answers true.
  const saveBlocked = (): boolean => {
    const limit = options.savedScriptsLimit;
    const blocked =
      state.signedIn &&
      options.isFeatureEnabled('pine_free_saved_scripts_limit') &&
      limit !== undefined &&
      limit < UNLIMITED &&
      state.savedScripts.filter(({ version }) => Number.parseInt(version, 10) !== 0).length >=
        limit;
    if (blocked) {
      record('dialog.paywall', [{ feature: 'pineScriptsLimit' }]);
    }
    return blocked;
  };

  // What the ensureNotNull of the app throws for an editor that is not mounted.
  const notMounted = (): Promise<never> => Promise.reject(new Error('Value is null'));

  const templateOf = (type: string | undefined): string =>
    type === 'strategy' || type === 'library' ? config.templates[type] : config.templates.indicator;

  const openNew = (type?: string): void => {
    const template = templateOf(type);
    state.source = template;
    state.savedSource = template;
    state.script = null;
    state.unsavedKept = false;
  };

  // What releaseScript and destroy do: the script is reset and the editor unregistered.
  const reset = (): void => {
    state.source = '';
    state.savedSource = '';
    state.script = null;
    state.placement = null;
    state.visible = false;
    state.ready = false;
  };

  const facade: FakePineEditorFacade = {
    get placement() {
      return state.placement;
    },
    awaitEditorReady() {
      // Not async on the facade of the app: it only marks the store ready when a script exists.
    },
    isModified: () => state.source !== state.savedSource,
    isDraft: () => state.script?.version === undefined || !(majorOf(state.script.version) > 0),
    getScriptIdVersion: () => (state.script === null ? null : { ...state.script }),
    getSource: () => (state.ready ? Promise.resolve(state.source) : notMounted()),
    setScript(source) {
      record('pineFacade.setScript', [source]);
      if (!state.ready) {
        return notMounted();
      }
      state.source = source;
      return Promise.resolve();
    },
    openNewScript(type) {
      record('pineFacade.openNewScript', type === undefined ? [] : [type]);
      openNew(type);
      return Promise.resolve();
    },
    openScript(info) {
      record('pineFacade.openScript', info === undefined ? [] : [info]);
      const { scriptIdPart, version, scriptSource } = info ?? {};
      const saved = state.savedScripts.find((script) => script.scriptIdPart === scriptIdPart);
      const source = typeof scriptSource === 'string' ? scriptSource : (saved?.source ?? undefined);
      const opened = typeof version === 'string' ? version : saved?.version;
      if (typeof scriptIdPart === 'string' && opened !== undefined && source !== undefined) {
        state.script = { scriptIdPart, version: opened };
        state.source = source;
        state.savedSource = source;
        state.unsavedKept = false;
      } else {
        // The app opens a new script whenever opening one fails.
        openNew();
      }
      return Promise.resolve();
    },
    addToChart() {
      record('pineFacade.addToChart', []);
      if (!state.signedIn) {
        record('dialog.signIn', []);
        return Promise.resolve();
      }
      if (state.script !== null && !facade.isDraft() && facade.isModified()) {
        // The modal dialog waits for the user, who never answers here: nothing is added.
        record('dialog.confirmSaveChanges', []);
        return Promise.resolve();
      }
      if (!options.canAddStudy()) {
        record('dialog.paywall', ['studyLimit']);
        return Promise.resolve();
      }
      const say = (level: FakeConsoleEntry['level'], text: string): void => {
        state.consoleMessages.push({ level, text, time: clockOf(new Date()) });
      };
      say('info', 'Compiling...');
      if (state.script === null) {
        // saveNewDraft: a new script is saved as a server draft first.
        drafts += 1;
        state.script = {
          scriptIdPart: `USER;${(0xd4af + drafts).toString(16).padStart(32, '0')}`,
          version: '0.1',
        };
      }
      state.savedSource = state.source;
      state.unsavedKept = false;
      const { errors, warnings } = compile(state.source);
      const title = /(?:indicator|strategy|library)\(\s*"([^"]*)"/.exec(state.source)?.[1];
      options.addStudy({
        name: title ?? 'Untitled script',
        scriptIdPart: state.script.scriptIdPart,
        version: state.script.version ?? '0.1',
        compileError: errors.length > 0,
      });
      for (const [level, list] of [
        ['error', errors],
        ['warning', warnings],
      ] as const) {
        for (const diagnostic of list) {
          state.consoleMessages.push({
            level,
            text: resolveMessage(diagnostic),
            time: clockOf(new Date()),
            ...(diagnostic.start === undefined ? {} : { start: { ...diagnostic.start } }),
            ...(diagnostic.end === undefined
              ? {}
              : { end: { line: diagnostic.end.line, column: diagnostic.end.column + 1 } }),
          });
        }
      }
      say('info', errors.length > 0 ? 'Compilation error' : 'Added to chart');
      return Promise.resolve();
    },
    updateOnChart() {
      record('pineFacade.updateOnChart', []);
      return Promise.resolve();
    },
    saveScript(label) {
      record('pineFacade.saveScript', label === undefined ? [] : [label]);
      if (!state.signedIn) {
        record('dialog.signIn', []);
        return Promise.reject(new Error('Sign in is required to save a script'));
      }
      const script = state.script;
      if (script?.version === undefined || facade.isDraft()) {
        // The app asks the user for a name first, in a dialog that a fake cannot answer: it
        // rejects with undefined, as the app does when the dialog is cancelled.
        record('dialog.renameScript', []);
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        return Promise.reject(undefined);
      }
      if ((!facade.isModified() && minorOf(script.version) === 0) || state.saveErrors !== null) {
        // Nothing to save, or a save that fails: the app says so in its console and rejects with
        // undefined.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        return Promise.reject(undefined);
      }
      const version = `${String(majorOf(script.version) + 1)}.0`;
      const saved = state.savedScripts.find((item) => item.scriptIdPart === script.scriptIdPart);
      if (saved !== undefined) {
        saved.version = version;
        saved.modified = Math.floor(Date.now() / 1000);
        saved.source = state.source;
      }
      state.script = { scriptIdPart: script.scriptIdPart, version };
      state.savedSource = state.source;
      state.unsavedKept = false;
      return Promise.resolve({
        script: {
          scriptIdPart: script.scriptIdPart,
          version,
          scriptName: saved?.scriptName ?? 'Untitled',
        },
        compileErrors: undefined,
      });
    },
    releaseScript() {
      record('pineFacade.releaseScript', []);
      reset();
    },
    destroy() {
      record('pineFacade.destroy', []);
      reset();
    },
    _editorStore: {
      getStore: () => ({
        getState: () => ({
          console: { messages: state.consoleMessages, isVisible: false },
        }),
      }),
    },
  };
  const entry: FakeOpenPineEditor = { getFacade: () => facade };
  const facadeAt = (placement: FakePineEditorPlacement): FakePineEditorFacade | null =>
    state.placement === placement ? facade : null;

  const api: FakePineEditorApi = {
    open(openOptions) {
      record('pineEditorApi.open', openOptions === undefined ? [] : [openOptions]);
      if (options.openError !== undefined) {
        return Promise.reject(new Error(options.openError));
      }
      if (state.placement !== null) {
        state.visible = true;
        return Promise.resolve();
      }
      const openedAt = Date.now();
      return new Promise((resolve) => {
        // The app loads the chunk of the editor first, then builds and registers it.
        setTimeout(() => {
          state.placement = config.opensAt;
          state.visible = true;
          // After a close, the app shows a new script, or the unsaved text it kept as the text of
          // the script (seen on the app); the first open shows the script the editor last held.
          if (state.openedBefore) {
            if (state.unsavedKept) {
              state.savedSource = state.source;
            } else {
              openNew();
            }
          }
          state.openedBefore = true;
          const left = options.readyMs - (Date.now() - openedAt);
          if (left <= 0) {
            state.ready = true;
          } else if (Number.isFinite(left)) {
            setTimeout(() => {
              state.ready = state.placement !== null;
            }, left);
          }
          resolve();
        }, 0);
      });
    },
    getDialogFacade: () => facadeAt('dialog'),
    getBottomFacade: () => facadeAt('bottom'),
    listSavedScripts() {
      record('pineEditorApi.listSavedScripts', []);
      return listScripts();
    },
    saveNewScript(script) {
      record('pineEditorApi.saveNewScript', [script]);
      if (saveBlocked()) {
        return Promise.reject(
          new Error('Saving one more script is not available on the current plan'),
        );
      }
      if (script.source === '') {
        return Promise.reject(new Error('Empty source code'));
      }
      if (state.saveErrors !== null) {
        return Promise.resolve({
          success: false,
          metaInfo: {},
          compileErrors: { errors: structuredClone(state.saveErrors), warnings: [] },
        });
      }
      created += 1;
      const scriptIdPart = `USER;${(0xfa11 + created).toString(16).padStart(32, '0')}`;
      state.savedScripts.push({
        scriptIdPart,
        scriptName: script.name,
        scriptTitle: script.name,
        version: '1.0',
        modified: Math.floor(Date.now() / 1000),
        kind: kindOf(script.source),
        source: script.source,
      });
      return Promise.resolve({
        success: true,
        metaInfo: { scriptIdPart, pine: { version: '1.0' } },
        compileErrors: { errors: [], warnings: [] },
      });
    },
    saveExistingScript(script) {
      record('pineEditorApi.saveExistingScript', [script]);
      return Promise.resolve({ success: false });
    },
  };

  const pageLayout = {
    hasSidePanel: (id: string) => id === 'pine',
    sidePanel: (id: string) =>
      id === 'pine' && state.placement === 'dialog' && state.visible ? {} : null,
    showSidePanel(id: string) {
      record('pageLayout.showSidePanel', [id]);
      return Promise.resolve();
    },
    closeSidePanel(id: string) {
      record('pageLayout.closeSidePanel', [id]);
      // The side panel goes, and the editor leaves the registry; the app keeps the script it held
      // and whether its text had unsaved changes (seen on the app).
      if (id === 'pine' && state.placement === 'dialog') {
        state.unsavedKept = state.source !== state.savedSource;
        state.placement = null;
        state.visible = false;
        state.ready = false;
      }
    },
  };

  const services = new Map<unknown, unknown>(
    options.withoutPageLayoutService === true ? [] : [[PAGE_LAYOUT_SERVICE, pageLayout]],
  );
  const hasService = (descriptor: unknown): boolean => services.has(descriptor);

  const bottomWidgetBar: FakeBottomWidgetBar = {
    close() {
      record('bottomWidgetBar.close', []);
      if (state.placement === 'bottom') {
        state.visible = false;
      }
    },
    isVisible: () => ({ value: () => state.placement === 'bottom' && state.visible }),
  };

  return {
    state,
    modules: {
      // Module IDs are arbitrary numbers, as in a production build.
      '61802': {
        getOpenPineEditor: (placement: unknown) =>
          placement === 'dialog' || placement === 'bottom'
            ? facadeAt(placement) === null
              ? null
              : entry
            : null,
        registerOpenPineEditor(...args: unknown[]) {
          record('registerOpenPineEditor', args);
        },
        unregisterOpenPineEditor(...args: unknown[]) {
          record('unregisterOpenPineEditor', args);
        },
      },
      '70455': {
        hasService,
        service(descriptor: unknown) {
          if (!hasService(descriptor)) {
            throw new Error('Service not found');
          }
          return services.get(descriptor);
        },
        serviceOrNull: (descriptor: unknown) => services.get(descriptor) ?? null,
        registerService(...args: unknown[]) {
          record('registerService', args);
        },
        unregisterService(...args: unknown[]) {
          record('unregisterService', args);
        },
        waitServiceRegistered: (descriptor: unknown) => Promise.resolve(services.get(descriptor)),
      },
      '82931': { PAGE_LAYOUT_SERVICE },
      // The keys and the helpers the editor of the app keeps its state between opens with, per
      // account (the fake has one); getPersistedValue answers the kept unsaved-changes flag, and with
      // its third argument the app would clear the key, which is recorded.
      '57519': {
        hasScriptModificationsKey: 'has_unsaved_modifications',
        lastEditedScriptKey: 'last_edited_script',
        consoleMessagesKey: 'console_messages_key',
      },
      '98521': {
        getPersistenceKey: (key: string, placement: string) =>
          `${placement === 'bottom' ? 'bottom_' : ''}${key}`,
        getPersistedValue(key: unknown, perUser = false, clear = false) {
          if (clear) {
            record('clearPersistedValue', [key]);
          }
          // The app keeps the flag under this bare key whatever the placement of the editor.
          if (key !== 'has_unsaved_modifications') {
            return null;
          }
          return perUser ? state.unsavedKept : { fixture_author: state.unsavedKept };
        },
      },
      // The client of the pine facade, as far as the fake models it.
      '36017': {
        requestUserScripts() {
          record('requestUserScripts', []);
          return listScripts();
        },
        translateScriptAsync(source: string, pineId: string) {
          record('translateScriptAsync', [source, pineId]);
          if (state.compileHttpError !== null) {
            // The app rejects an HTTP failure with a plain string.
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            return Promise.reject(state.compileHttpError);
          }
          const compileErrors = compile(source);
          const metaInfo = { scriptIdPart: pineId, pine: { version: '1.0' } };
          if (compileErrors.errors.length > 0) {
            return Promise.reject(new FakePineCompileFailError(compileErrors, metaInfo));
          }
          return Promise.resolve({ success: true, metaInfo, compileErrors });
        },
      },
    },
    api,
    bottomWidgetBar,
  };
}
