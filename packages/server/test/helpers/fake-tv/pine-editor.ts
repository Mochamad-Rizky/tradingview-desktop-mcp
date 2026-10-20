import type { TvStateFixture } from './fixture.js';

// The Pine Editor of the fake app, built from the pineEditor of the fixture (reverse-engineering
// notes of Plan 2, section Q1):
//
// - The registry module exports getOpenPineEditor(placement), which answers { getFacade } for the
//   placement an editor is registered under ("dialog" or "bottom") and null otherwise, with
//   registerOpenPineEditor and unregisterOpenPineEditor next to it. The current layout opens the
//   editor as the right side panel, which the fake registers as "dialog", as the notes infer.
// - The facade has placement, awaitEditorReady, isModified (the text differs from the saved text),
//   isDraft (no script id, or a version whose major part is 0), getScriptIdVersion
//   ({ scriptIdPart, version } or null), getSource (rejects while the editor is not mounted, like
//   the ensureNotNull of the app), setScript, openNewScript(type) (the template of the type, the
//   indicator template for any other value), openScript, addToChart, updateOnChart, saveScript,
//   releaseScript and destroy. releaseScript and destroy reset the script, which discards the text,
//   and unregister the editor, as on the app.
// - TradingViewApi.pineEditorApi() answers the same object on every call: open(options), which
//   registers the editor at the opensAt placement of the fixture on the next turn of the event loop,
//   restoring the script the editor last held, and mounts it readyMs after the call;
//   getDialogFacade and getBottomFacade; and listSavedScripts, saveNewScript and saveExistingScript
//   as stubs that record their calls. Later tasks give these stubs their answers.
// - The service locator module exports hasService, service, serviceOrNull, registerService,
//   unregisterService and waitServiceRegistered, keyed by service descriptors. The page layout
//   service, whose descriptor is the export PAGE_LAYOUT_SERVICE of another module, has
//   hasSidePanel, sidePanel, showSidePanel and closeSidePanel; closeSidePanel("pine") hides the
//   side panel and leaves the editor registered with its text.
// - TradingView.bottomWidgetBar.close() minimizes the bottom bar, which hides an editor at the
//   bottom placement and leaves it registered with its text, as the notes record.
//
// Every call that changes the editor, sends a request or opens or closes a panel records itself
// (pineEditorApi.*, pineFacade.*, pageLayout.*, bottomWidgetBar.*). Reads are not recorded. The
// sources are synthetic, and the templates name an invented author.

export type FakePineEditorPlacement = 'dialog' | 'bottom';

export interface FakePineScriptId {
  scriptIdPart: string;
  version: string;
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
}

export interface FakePineEditorOptions {
  // How long after open() the editor is mounted. Infinity: never.
  readyMs: number;
  // The message open() rejects with. Default: it opens the editor.
  openError?: string | undefined;
  // Leaves the page layout service out of the service locator, as on a build without the side
  // panel.
  withoutPageLayoutService?: boolean | undefined;
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
  saveScript(label?: string): Promise<{ script: FakePineScriptId }>;
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
  saveNewScript(script: { source: string; name: string }): Promise<{ success: boolean }>;
  saveExistingScript(script: {
    scriptIdPart: string;
    source: string;
    name: string;
  }): Promise<{ success: boolean }>;
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

// What the major part of a script version is, as the Version class of the app reads it.
function majorOf(version: string): number {
  return Number.parseInt(version.split('.')[0] ?? '', 10);
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
    isDraft: () => state.script === null || !(majorOf(state.script.version) > 0),
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
      if (
        typeof scriptIdPart === 'string' &&
        typeof version === 'string' &&
        typeof scriptSource === 'string'
      ) {
        state.script = { scriptIdPart, version };
        state.source = scriptSource;
        state.savedSource = scriptSource;
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
      if (state.script === null) {
        // The app asks the user for a name first, which a stub cannot do: it rejects with
        // undefined, as the app does when the save is cancelled.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        return Promise.reject(undefined);
      }
      return Promise.resolve({ script: { ...state.script } });
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
      return Promise.resolve([]);
    },
    saveNewScript(script) {
      record('pineEditorApi.saveNewScript', [script]);
      return Promise.resolve({ success: false });
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
    },
    api,
    bottomWidgetBar,
  };
}
