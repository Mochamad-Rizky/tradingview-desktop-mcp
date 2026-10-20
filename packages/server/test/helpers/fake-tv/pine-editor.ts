import type { TvStateFixture } from './fixture.js';

// The Pine Editor of the fake app, built from the pineEditor of the fixture (reverse-engineering
// notes of Plan 2, section Q1):
//
// - The registry module exports getOpenPineEditor(placement), which answers { getFacade } for the
//   placement an editor is registered under ("dialog" or "bottom") and null otherwise, with
//   registerOpenPineEditor and unregisterOpenPineEditor next to it. The current layout opens the
//   editor as the right side panel, which the fake registers as "dialog", as the notes infer.
// - The facade has placement, awaitEditorReady, isModified (the text differs from the saved text),
//   isDraft (no script id, no version, or a version whose major part is 0), getScriptIdVersion
//   ({ scriptIdPart, version } or null; the version is undefined when the script has none),
//   getSource (rejects while the editor is not mounted, like the ensureNotNull of the app),
//   setScript, openNewScript(type) (the template of the type, the indicator template for any
//   other value), openScript, addToChart, updateOnChart, saveScript, releaseScript and destroy.
//   releaseScript and destroy reset the script, which discards the text, and unregister the editor,
//   as on the app. openScript with a source opens it as that script; without one it loads the
//   saved script of that id, and on any failure it opens a new script, as the app does.
//   saveScript saves a new version of a saved script under its name. For a draft it would ask the
//   user for a name in a dialog (dialog.renameScript), and signed out it would ask the user to sign
//   in (dialog.signIn); either way it rejects, as the app does when the dialog is cancelled.
// - TradingViewApi.pineEditorApi() answers the same object on every call: open(options), which
//   registers the editor at the opensAt placement of the fixture on the next turn of the event loop,
//   restoring the script the editor last held, and mounts it readyMs after the call;
//   getDialogFacade and getBottomFacade; listSavedScripts, the same request as requestUserScripts;
//   saveNewScript, which checks the saved-script limit the way the app does, opening its paywall
//   (dialog.paywall) and throwing when the limit is reached, and else saves a new script; and
//   saveExistingScript, a stub that records its call.
// - The export requestUserScripts lists the saved scripts of the account, without their sources,
//   and resolves [] while signed out (signedIn false), as the app does.
// - The service locator module exports hasService, service, serviceOrNull, registerService,
//   unregisterService and waitServiceRegistered, keyed by service descriptors. The page layout
//   service, whose descriptor is the export PAGE_LAYOUT_SERVICE of another module, has
//   hasSidePanel, sidePanel, showSidePanel and closeSidePanel; closeSidePanel("pine") hides the
//   side panel and leaves the editor registered with its text.
// - TradingView.bottomWidgetBar.close() minimizes the bottom bar, which hides an editor at the
//   bottom placement and leaves it registered with its text, as the notes record.
//
// Every call that changes the editor, sends a request or opens or closes a panel or a dialog
// records itself (pineEditorApi.*, pineFacade.*, pageLayout.*, bottomWidgetBar.*, requestUserScripts,
// dialog.*). Reads are not recorded. The sources are synthetic, and the templates name an invented
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

// A compile error as the pine facade reports it.
export interface FakePineDiagnostic {
  message: string;
  start?: { line: number; column: number };
  end?: { line: number; column: number };
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
  };
  // How many scripts saveNewScript has created, for their ids.
  let created = 0;

  // What requestUserScripts resolves with: the saved scripts without their sources.
  const listScripts = (): Promise<unknown[]> =>
    Promise.resolve(
      state.signedIn
        ? state.savedScripts.map((script) => {
            const listed: Partial<FakeSavedScript> = { ...script };
            delete listed.source;
            return listed;
          })
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
      } else {
        // The app opens a new script whenever opening one fails.
        openNew();
      }
      return Promise.resolve();
    },
    addToChart() {
      record('pineFacade.addToChart', []);
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
      if (id === 'pine' && state.placement === 'dialog') {
        state.visible = false;
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
      // The client of the pine facade, as far as the fake models it.
      '36017': {
        requestUserScripts() {
          record('requestUserScripts', []);
          return listScripts();
        },
      },
    },
    api,
    bottomWidgetBar,
  };
}
