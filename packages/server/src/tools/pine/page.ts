import type { ErrorCode } from '../../core/errors.js';
import type { PageErrorSentinel } from '../../core/tv/page-bridge.js';
import type { PageLib } from '../../core/tv/page-lib.js';
import type {
  BottomWidgetBarLike,
  OpenPineEditorLike,
  PageLayoutServiceLike,
  PineCompileErrorsLike,
  PineEditorApiLike,
  PineEditorFacadeLike,
  PineSaveResultLike,
  SavedPineScriptLike,
  ServiceLocatorLike,
  TvWindow,
} from '../../core/tv/tv-window.js';

// The page functions of the Pine Editor access layer (reverse-engineering notes of Plan 2, section
// Q1). The page bridge sends the source text of each one into the page, so each uses nothing of
// this file, only its parameters and the globals of the page, and whatever it shares with another
// is written out in each. Types are erased, so the type imports above are fine.
//
// An editor is open while the registry of open editors (the export getOpenPineEditor) answers for
// one of its two placements, "dialog" and "bottom". The current layout opens the editor as the
// right side panel, which is taken to register as "dialog" (inferred, not observed), so "dialog" is
// looked at first. Members of the app are read defensively: another web build can drop or reshape
// any of them, and a read that throws counts as no answer.
//
// Nothing here returns or keeps the text of the editor, and nothing reads the name of the account
// or the state the editor persists under it. Every function says CAPABILITY_UNAVAILABLE only
// before it acts.

// The state of the editor, read without changing anything: whether one is open and where, whether
// its text has unsaved changes (modified), whether its script is new or saved only as a server
// draft (draft), and the id and version of its script: null for a script that has no id yet, and
// a version of null for one that has an id but no version, which is not a new script either.
// unreadable lists the members of the facade that could not be read, in the order
// they were read: getFacade when the facade itself could not be had, else any of
// getScriptIdVersion, isModified and isDraft. An unreadable isModified counts as modified, so that
// the text is not replaced without confirm, and an unreadable isDraft as a draft when there is no
// script or no version.
export function readPineEditorState(
  _win: TvWindow,
  lib: PageLib,
):
  | {
      state: {
        open: boolean;
        placement: 'dialog' | 'bottom' | null;
        modified: boolean;
        draft: boolean;
        script: { id: string; version: string | null } | null;
      };
      unreadable: string[];
    }
  | PageErrorSentinel {
  const getOpenPineEditor = lib.findExport('getOpenPineEditor');
  if (typeof getOpenPineEditor !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no registry of open Pine editors',
        hint: 'Check app_health: the app may still be loading, or the tab does not show a chart.',
      },
    };
  }
  let placement: PineEditorPlacement | null = null;
  let entry: Partial<OpenPineEditorLike> | null = null;
  for (const candidate of ['dialog', 'bottom'] as const) {
    let found: unknown;
    try {
      found = (getOpenPineEditor as (at: string) => unknown)(candidate);
    } catch {
      found = null;
    }
    if (found !== null && found !== undefined) {
      placement = candidate;
      entry = found;
      break;
    }
  }
  if (placement === null) {
    return {
      state: { open: false, placement: null, modified: false, draft: false, script: null },
      unreadable: [],
    };
  }
  let facade: unknown;
  try {
    facade = entry?.getFacade?.();
  } catch {
    facade = null;
  }

  const at = placement;
  if (typeof facade !== 'object' || facade === null) {
    return {
      state: { open: true, placement: at, modified: true, draft: true, script: null },
      unreadable: ['getFacade'],
    };
  }
  const members = facade as Record<string, unknown>;
  const ask = (name: string): { value: unknown } | null => {
    try {
      const member = members[name];
      return typeof member === 'function'
        ? { value: (member as () => unknown).call(facade) }
        : null;
    } catch {
      return null;
    }
  };
  const unreadable: string[] = [];
  let script: { id: string; version: string | null } | null = null;
  const ids = ask('getScriptIdVersion');
  if (ids !== null && (ids.value === null || ids.value === undefined)) {
    script = null;
  } else if (ids !== null && typeof ids.value === 'object') {
    const { scriptIdPart, version } = ids.value as { scriptIdPart?: unknown; version?: unknown };
    if (typeof scriptIdPart !== 'string' || scriptIdPart === '') {
      unreadable.push('getScriptIdVersion');
    } else {
      script = {
        id: scriptIdPart,
        version: typeof version === 'string' && version !== '' ? version : null,
      };
    }
  } else {
    unreadable.push('getScriptIdVersion');
  }
  let modified = true;
  const changed = ask('isModified');
  if (typeof changed?.value === 'boolean') {
    modified = changed.value;
  } else {
    unreadable.push('isModified');
  }
  let draft = (script?.version ?? null) === null;
  const isNew = ask('isDraft');
  if (typeof isNew?.value === 'boolean') {
    draft = isNew.value;
  } else {
    unreadable.push('isDraft');
  }
  return { state: { open: true, placement: at, modified, draft, script }, unreadable };
}

// What readPineEditorState answers, and the parts of it the other functions and the tools use.
export type PineEditorReading = Exclude<ReturnType<typeof readPineEditorState>, PageErrorSentinel>;
export type PineEditorState = PineEditorReading['state'];
export type PineEditorPlacement = NonNullable<PineEditorState['placement']>;

// Opens the editor the way the Pine button of the toolbar of the app does, which restores the
// script or draft the editor last held and discards nothing, and waits at most waitMs until the
// editor is registered and mounted, then answers its state. Mounted is inferred: getSource of the
// facade answers instead of rejecting (the text it answers is dropped). An editor that is already
// open is answered at once, without opening it again. The whole wait runs in this one call, so the
// page library pushes one chunk at most. A wait that is not a positive number waits no time.
// Failures: TIMEOUT when the editor is not ready in time, and NOT_AVAILABLE with the reason when
// TradingView fails to open it.
export function openPineEditor(
  win: TvWindow,
  lib: PageLib,
  waitMs: number,
): Promise<PineEditorReading | PageErrorSentinel> | PineEditorReading | PageErrorSentinel {
  const wait = typeof waitMs === 'number' && Number.isFinite(waitMs) && waitMs > 0 ? waitMs : 0;
  const getOpenPineEditor = lib.findExport('getOpenPineEditor');
  if (typeof getOpenPineEditor !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no registry of open Pine editors',
        hint: 'Check app_health: the app may still be loading, or the tab does not show a chart.',
      },
    };
  }
  // The open editor that comes first, dialog before bottom, or null.
  const registered = (): {
    placement: PineEditorPlacement;
    entry: Partial<OpenPineEditorLike>;
  } | null => {
    for (const candidate of ['dialog', 'bottom'] as const) {
      let found: unknown;
      try {
        found = (getOpenPineEditor as (at: string) => unknown)(candidate);
      } catch {
        found = null;
      }
      if (found !== null && found !== undefined) {
        return { placement: candidate, entry: found };
      }
    }
    return null;
  };
  const facadeOf = (entry: Partial<OpenPineEditorLike>): unknown => {
    try {
      return entry.getFacade?.();
    } catch {
      return null;
    }
  };
  // What readPineEditorState answers for an open editor, from the facade at hand.
  const readFacade = (at: PineEditorPlacement, facade: unknown): PineEditorReading => {
    if (typeof facade !== 'object' || facade === null) {
      return {
        state: { open: true, placement: at, modified: true, draft: true, script: null },
        unreadable: ['getFacade'],
      };
    }
    const members = facade as Record<string, unknown>;
    const ask = (name: string): { value: unknown } | null => {
      try {
        const member = members[name];
        return typeof member === 'function'
          ? { value: (member as () => unknown).call(facade) }
          : null;
      } catch {
        return null;
      }
    };
    const unreadable: string[] = [];
    let script: { id: string; version: string | null } | null = null;
    const ids = ask('getScriptIdVersion');
    if (ids !== null && (ids.value === null || ids.value === undefined)) {
      script = null;
    } else if (ids !== null && typeof ids.value === 'object') {
      const { scriptIdPart, version } = ids.value as { scriptIdPart?: unknown; version?: unknown };
      if (typeof scriptIdPart !== 'string' || scriptIdPart === '') {
        unreadable.push('getScriptIdVersion');
      } else {
        script = {
          id: scriptIdPart,
          version: typeof version === 'string' && version !== '' ? version : null,
        };
      }
    } else {
      unreadable.push('getScriptIdVersion');
    }
    let modified = true;
    const changed = ask('isModified');
    if (typeof changed?.value === 'boolean') {
      modified = changed.value;
    } else {
      unreadable.push('isModified');
    }
    let draft = (script?.version ?? null) === null;
    const isNew = ask('isDraft');
    if (typeof isNew?.value === 'boolean') {
      draft = isNew.value;
    } else {
      unreadable.push('isDraft');
    }
    return { state: { open: true, placement: at, modified, draft, script }, unreadable };
  };

  const already = registered();
  if (already !== null) {
    return readFacade(already.placement, facadeOf(already.entry));
  }
  let pineApi: Partial<PineEditorApiLike> | null | undefined;
  try {
    pineApi = win.TradingViewApi?.pineEditorApi?.();
  } catch {
    pineApi = undefined;
  }
  if (typeof pineApi?.open !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no Pine Editor API to open the editor with',
        hint: 'Check app_health: the app may still be loading, or the tab does not show a chart.',
      },
    };
  }
  const reasonOf = (error: unknown): string => {
    const message: unknown = (error as { message?: unknown } | null | undefined)?.message;
    return typeof error === 'string'
      ? error
      : typeof message === 'string'
        ? message
        : String(error);
  };
  const notOpened = (reason: string): PageErrorSentinel => ({
    __tvmcpError: {
      code: 'NOT_AVAILABLE',
      message: `TradingView did not open the Pine Editor: ${reason}`,
      hint: 'Open the Pine Editor in TradingView, or check app_health.',
      details: { reason },
    },
  });
  // Why open failed, once its promise has rejected.
  let failure: string | null = null;
  const started = Date.now();
  try {
    Promise.resolve(
      pineApi.open({ scriptInfo: { script: null }, openSourceId: 'main_button', forceOpen: true }),
    ).catch((error: unknown) => {
      failure = reasonOf(error);
    });
  } catch (error) {
    return notOpened(reasonOf(error));
  }

  const pause = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  // Whether getSource answers within ms. A facade without it counts as mounted.
  const mounted = (facade: Record<string, unknown>, ms: number): Promise<boolean> => {
    const getSource = facade.getSource;
    if (typeof getSource !== 'function') {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(false);
      }, ms);
      // A getSource that throws at once rejects this promise too.
      const asked = Promise.resolve().then(() => (getSource as () => unknown).call(facade));
      asked.then(
        () => {
          clearTimeout(timer);
          resolve(true);
        },
        () => {
          clearTimeout(timer);
          resolve(false);
        },
      );
    });
  };
  const poll = async (): Promise<PineEditorReading | PageErrorSentinel> => {
    for (;;) {
      const found = registered();
      if (found !== null) {
        const facade = facadeOf(found.entry);
        if (
          typeof facade === 'object' &&
          facade !== null &&
          (await mounted(
            facade as Record<string, unknown>,
            Math.max(started + wait - Date.now(), 0),
          ))
        ) {
          return readFacade(found.placement, facade);
        }
      }
      if (failure !== null) {
        return notOpened(failure);
      }
      const left = started + wait - Date.now();
      if (left <= 0) {
        return {
          __tvmcpError: {
            code: 'TIMEOUT',
            message: `The Pine Editor was not ready within ${String(wait)} ms`,
            hint:
              'TradingView may still be opening the Pine Editor: try again in a moment, or open ' +
              'it in TradingView.',
            details: { waitMs: wait },
          },
        };
      }
      await pause(Math.min(50, left));
    }
  };
  return poll();
}

// Closes or hides the editor without discarding its text, and answers whether it called a close
// path and for which placement. The side panel (dialog) closes through the page layout service,
// service(PAGE_LAYOUT_SERVICE).closeSidePanel("pine"), with service and hasService found together
// as the exports of the service locator and PAGE_LAYOUT_SERVICE as the export of its own module.
// The bottom placement closes through TradingView.bottomWidgetBar.close(), which only minimizes the
// bar and keeps the editor with its text. Nothing here calls releaseScript, destroy or the
// closeScript of the widget controller, which reset the script and so discard the text. That the
// text survives the side panel closing (the app keeps the script it last held and restores it on
// the next open) is expected from the notes and verified by the E2E tests. An editor that is not
// open is left alone. Without its close path, or with a dialog that is not the "pine" side panel,
// the answer is CAPABILITY_UNAVAILABLE, before anything is called; a close path that throws is
// NOT_AVAILABLE with the reason.
export function closePineEditor(
  win: TvWindow,
  lib: PageLib,
): { closed: boolean; placement: PineEditorPlacement | null } | PageErrorSentinel {
  const getOpenPineEditor = lib.findExport('getOpenPineEditor');
  if (typeof getOpenPineEditor !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no registry of open Pine editors',
        hint: 'Check app_health: the app may still be loading, or the tab does not show a chart.',
      },
    };
  }
  let placement: PineEditorPlacement | null = null;
  for (const candidate of ['dialog', 'bottom'] as const) {
    let found: unknown;
    try {
      found = (getOpenPineEditor as (at: string) => unknown)(candidate);
    } catch {
      found = null;
    }
    if (found !== null && found !== undefined) {
      placement = candidate;
      break;
    }
  }
  if (placement === null) {
    return { closed: false, placement: null };
  }
  const unavailable = (message: string): PageErrorSentinel => ({
    __tvmcpError: {
      code: 'CAPABILITY_UNAVAILABLE',
      message,
      hint: 'Close the Pine Editor in TradingView itself.',
      details: { placement },
    },
  });

  let close: () => void;
  if (placement === 'dialog') {
    const locator = lib.findModuleWith(['hasService', 'service']);
    const descriptor = lib.findExport('PAGE_LAYOUT_SERVICE');
    let layout: Partial<PageLayoutServiceLike> | null = null;
    try {
      if (
        locator !== null &&
        descriptor !== null &&
        typeof locator.hasService === 'function' &&
        typeof locator.service === 'function'
      ) {
        const services = locator as unknown as ServiceLocatorLike;
        const found = services.hasService(descriptor) ? services.service(descriptor) : null;
        layout = typeof found === 'object' && found !== null ? found : null;
      }
    } catch {
      layout = null;
    }
    if (typeof layout?.closeSidePanel !== 'function') {
      return unavailable('This page has no page layout service to close the Pine Editor with');
    }
    let isPanel: unknown;
    try {
      isPanel = typeof layout.hasSidePanel === 'function' ? layout.hasSidePanel('pine') : true;
    } catch {
      isPanel = false;
    }
    if (isPanel !== true) {
      return unavailable('The Pine Editor is open in a dialog that is not the side panel');
    }
    const service = layout as PageLayoutServiceLike;
    close = () => {
      service.closeSidePanel('pine');
    };
  } else {
    let bar: Partial<BottomWidgetBarLike> | null | undefined;
    try {
      bar = win.TradingView?.bottomWidgetBar;
    } catch {
      bar = undefined;
    }
    if (typeof bar?.close !== 'function') {
      return unavailable('This page has no bottom bar to close the Pine Editor with');
    }
    const widgets = bar as BottomWidgetBarLike;
    close = () => {
      widgets.close();
    };
  }
  try {
    close();
  } catch (error) {
    const message: unknown = (error as { message?: unknown } | null | undefined)?.message;
    const reason = typeof message === 'string' ? message : String(error);
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: `TradingView did not close the Pine Editor: ${reason}`,
        hint: 'Close the Pine Editor in TradingView itself.',
        details: { reason },
      },
    };
  }
  return { closed: true, placement };
}

// The saved scripts of the account and what decides the saved-script limit of the app besides the
// plan (notes of Plan 2, sections Q1 and Q2). The list comes from the export requestUserScripts,
// the request the app sends itself and keeps the answer of, or from the same call on
// pineEditorApi(); it is [] while signed out. authenticated is window.is_authenticated,
// limitEnabled the feature toggle pine_free_saved_scripts_limit (null when it cannot be read) and
// unlimited the export UNLIMITED_FEATURE_LIMIT (null when it is missing). A row keeps the id, the
// name, the title, the version, modified as the list gives it (a number or a date string) and the
// kind; an item without an id is left out. Changes nothing. CAPABILITY_UNAVAILABLE when the page
// has no way to list the scripts, NOT_AVAILABLE with the reason when the request fails.
export function readSavedPineScripts(
  win: TvWindow,
  lib: PageLib,
):
  | Promise<
      | {
          authenticated: boolean;
          limitEnabled: boolean | null;
          unlimited: number | null;
          scripts: {
            scriptIdPart: string;
            scriptName: string | null;
            scriptTitle: string | null;
            version: string | null;
            modified: number | string | null;
            kind: string | null;
          }[];
        }
      | PageErrorSentinel
    >
  | PageErrorSentinel {
  const requestUserScripts = lib.findExport('requestUserScripts');
  let pineApi: Partial<PineEditorApiLike> | null | undefined;
  try {
    pineApi = win.TradingViewApi?.pineEditorApi?.();
  } catch {
    pineApi = undefined;
  }
  const api = pineApi;
  let list: (() => unknown) | null = null;
  if (typeof requestUserScripts === 'function') {
    list = () => (requestUserScripts as () => unknown)();
  } else if (typeof api?.listSavedScripts === 'function') {
    const listSavedScripts = api.listSavedScripts;
    list = () => listSavedScripts.call(api);
  }
  if (list === null) {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no list of saved Pine scripts',
        hint: 'Check app_health: the app may still be loading, or the tab does not show a chart.',
      },
    };
  }
  const listScripts = list;

  const toggles = lib.findModuleWith(['isFeatureEnabled', 'onFeaturesStateChanged']);
  // The export, else the same function on window.TradingView, called as a method of its owner.
  let owner: unknown = toggles;
  if (typeof toggles?.isFeatureEnabled !== 'function') {
    try {
      owner = win.TradingView;
    } catch {
      owner = undefined;
    }
  }
  let limitEnabled: boolean | null = null;
  try {
    const toggleOwner = owner as { isFeatureEnabled?: unknown } | null | undefined;
    if (typeof toggleOwner?.isFeatureEnabled === 'function') {
      const enabled: unknown = (
        toggleOwner as { isFeatureEnabled: (name: string) => unknown }
      ).isFeatureEnabled('pine_free_saved_scripts_limit');
      limitEnabled = typeof enabled === 'boolean' ? enabled : null;
    }
  } catch {
    limitEnabled = null;
  }
  const unlimitedValue = lib.findExport('UNLIMITED_FEATURE_LIMIT');
  const unlimited =
    typeof unlimitedValue === 'number' && Number.isFinite(unlimitedValue) ? unlimitedValue : null;
  const authenticated = win.is_authenticated === true;

  const text = (value: unknown): string | null =>
    typeof value === 'string' && value !== '' ? value : null;
  const reasonOf = (error: unknown): string => {
    const message: unknown = (error as { message?: unknown } | null | undefined)?.message;
    return typeof error === 'string'
      ? error
      : typeof message === 'string'
        ? message
        : String(error);
  };
  return Promise.resolve()
    .then(() => listScripts())
    .then(
      (items: unknown) => {
        if (!Array.isArray(items)) {
          return {
            __tvmcpError: {
              code: 'NOT_AVAILABLE',
              message: 'TradingView answered with no list of saved Pine scripts',
              hint: 'Try again in a moment, or check app_health.',
            },
          };
        }
        const scripts = (items as unknown[]).flatMap((raw) => {
          const item = (typeof raw === 'object' && raw !== null ? raw : {}) as SavedPineScriptLike;
          const scriptIdPart = text(item.scriptIdPart);
          if (scriptIdPart === null) {
            return [];
          }
          const modified =
            (typeof item.modified === 'number' && Number.isFinite(item.modified)) ||
            (typeof item.modified === 'string' && item.modified !== '')
              ? item.modified
              : null;
          return [
            {
              scriptIdPart,
              scriptName: text(item.scriptName),
              scriptTitle: text(item.scriptTitle),
              version: text(item.version),
              modified,
              kind: text(item.kind),
            },
          ];
        });
        return { authenticated, limitEnabled, unlimited, scripts };
      },
      (error: unknown) => {
        const reason = reasonOf(error);
        return {
          __tvmcpError: {
            code: 'NOT_AVAILABLE',
            message: `TradingView did not list the saved Pine scripts: ${reason}`,
            hint: 'Try again in a moment, or check app_health.',
            details: { reason },
          },
        };
      },
    );
}

// The text in the open editor, read without changing anything; open is false, with no source,
// when no editor is open. CAPABILITY_UNAVAILABLE when the page has no registry of open editors or
// the facade cannot read its text, NOT_AVAILABLE when the text cannot be read (the code editor is
// not mounted yet).
export function readPineSource(
  _win: TvWindow,
  lib: PageLib,
):
  | Promise<{ open: boolean; source: string | null } | PageErrorSentinel>
  | { open: boolean; source: string | null }
  | PageErrorSentinel {
  const getOpenPineEditor = lib.findExport('getOpenPineEditor');
  if (typeof getOpenPineEditor !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no registry of open Pine editors',
        hint: 'Check app_health: the app may still be loading, or the tab does not show a chart.',
      },
    };
  }
  let entry: Partial<OpenPineEditorLike> | null = null;
  for (const candidate of ['dialog', 'bottom'] as const) {
    let found: unknown;
    try {
      found = (getOpenPineEditor as (at: string) => unknown)(candidate);
    } catch {
      found = null;
    }
    if (found !== null && found !== undefined) {
      entry = found;
      break;
    }
  }
  if (entry === null) {
    return { open: false, source: null };
  }
  let facade: Partial<PineEditorFacadeLike> | null | undefined;
  try {
    facade = entry.getFacade?.();
  } catch {
    facade = null;
  }
  if (typeof facade?.getSource !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'The Pine Editor is open, but its text cannot be read on this build',
        hint: 'Read the script in the Pine Editor of TradingView itself.',
      },
    };
  }
  const editor = facade as PineEditorFacadeLike;
  return Promise.resolve()
    .then(() => editor.getSource())
    .then(
      (source: unknown) =>
        typeof source === 'string'
          ? { open: true, source }
          : {
              __tvmcpError: {
                code: 'NOT_AVAILABLE',
                message: 'The Pine Editor answered with no text',
                hint: 'Try again in a moment: the editor may still be loading.',
              },
            },
      () => ({
        __tvmcpError: {
          code: 'NOT_AVAILABLE',
          message: 'The text of the Pine Editor could not be read',
          hint: 'Try again in a moment: the editor may still be loading.',
        },
      }),
    );
}

// What changePineEditor does to the text of the open editor. allowModified: false makes it check
// right before it acts that the editor holds no unsaved changes, and refuse with
// CONFIRMATION_REQUIRED when it does; the tools pass true only with confirm: true.
// - new: opens a new script of the type, the template of the app, and with a source puts that in
//   place of the template.
// - source: replaces the text, keeping the script.
// - open: opens a saved script, with its own text loaded by the app, or with source as its text.
export type PineEditorChange =
  | {
      kind: 'new';
      type: 'indicator' | 'strategy' | 'library';
      source: string | null;
      allowModified: boolean;
    }
  | { kind: 'source'; source: string; allowModified: boolean }
  | {
      kind: 'open';
      scriptIdPart: string;
      version: string | null;
      source: string | null;
      allowModified: boolean;
    };

// Changes the text of the open editor as `change` says, through the facade of the editor, and
// answers { changed: true } once the facade has done it. It never saves. The caller reads the
// state of the editor afterwards: openScript of the app opens a new script whenever opening the
// saved one fails, which the state shows. Failures: CAPABILITY_UNAVAILABLE without the registry
// or the member of the facade the change needs, NOT_AVAILABLE when no editor is open or the facade
// fails (with the reason), CONFIRMATION_REQUIRED as described above, all before the facade acts
// except a failing facade.
export function changePineEditor(
  _win: TvWindow,
  lib: PageLib,
  change: PineEditorChange,
): Promise<{ changed: true } | PageErrorSentinel> | PageErrorSentinel {
  const getOpenPineEditor = lib.findExport('getOpenPineEditor');
  if (typeof getOpenPineEditor !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no registry of open Pine editors',
        hint: 'Check app_health: the app may still be loading, or the tab does not show a chart.',
      },
    };
  }
  let entry: Partial<OpenPineEditorLike> | null = null;
  for (const candidate of ['dialog', 'bottom'] as const) {
    let found: unknown;
    try {
      found = (getOpenPineEditor as (at: string) => unknown)(candidate);
    } catch {
      found = null;
    }
    if (found !== null && found !== undefined) {
      entry = found;
      break;
    }
  }
  if (entry === null) {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: 'The Pine Editor is not open',
        hint: 'Open a script with pine_open, or start one with pine_new.',
      },
    };
  }
  let found: unknown;
  try {
    found = entry.getFacade?.();
  } catch {
    found = null;
  }
  const unavailable = (member: string): PageErrorSentinel => ({
    __tvmcpError: {
      code: 'CAPABILITY_UNAVAILABLE',
      message: `The Pine Editor of this build has no ${member} to change its text with`,
      hint: 'Change the script in the Pine Editor of TradingView itself.',
      details: { member },
    },
  });
  if (typeof found !== 'object' || found === null) {
    return unavailable('facade');
  }
  const facade = found as Partial<PineEditorFacadeLike>;
  const kind = (change as Partial<PineEditorChange> | undefined)?.kind;
  const needed =
    kind === 'new'
      ? change.source === null
        ? ['openNewScript']
        : ['openNewScript', 'setScript']
      : kind === 'source'
        ? ['setScript']
        : kind === 'open'
          ? ['openScript']
          : null;
  if (needed === null) {
    return {
      __tvmcpError: {
        code: 'INVALID_INPUT',
        message: 'Unknown change of the Pine Editor',
        details: { kind: String(kind) },
      },
    };
  }
  const missing = needed.find(
    (member) => typeof (facade as Record<string, unknown>)[member] !== 'function',
  );
  if (missing !== undefined) {
    return unavailable(missing);
  }
  if (!change.allowModified) {
    let modified: unknown;
    try {
      modified = facade.isModified?.();
    } catch {
      modified = undefined;
    }
    // An answer that is not false counts as unsaved changes.
    if (modified !== false) {
      return {
        __tvmcpError: {
          code: 'CONFIRMATION_REQUIRED',
          message: 'The change would replace the unsaved text in the Pine Editor',
          hint: 'Pass confirm: true to replace it, or save it first with pine_save.',
        },
      };
    }
  }
  const editor = facade as Required<PineEditorFacadeLike>;
  const apply = async (): Promise<void> => {
    if (change.kind === 'new') {
      await editor.openNewScript(change.type);
      if (change.source !== null) {
        await editor.setScript(change.source);
      }
    } else if (change.kind === 'source') {
      await editor.setScript(change.source);
    } else {
      const info: { scriptIdPart: string; version?: string; scriptSource?: string } = {
        scriptIdPart: change.scriptIdPart,
      };
      if (change.version !== null) {
        info.version = change.version;
      }
      if (change.source !== null) {
        info.scriptSource = change.source;
      }
      await editor.openScript(info);
    }
  };
  return apply().then(
    () => ({ changed: true }) as const,
    (error: unknown) => {
      const message: unknown = (error as { message?: unknown } | null | undefined)?.message;
      const reason =
        typeof error === 'string' ? error : typeof message === 'string' ? message : String(error);
      return {
        __tvmcpError: {
          code: 'NOT_AVAILABLE',
          message: `The Pine Editor did not take the change: ${reason}`,
          hint: 'Check the Pine Editor in TradingView: it may hold another text now.',
          details: { reason },
        },
      };
    },
  );
}

// How savePineScript saves the text of the open editor.
// - new: as a new script named `name`, through pineEditorApi().saveNewScript, which shows no
//   dialog. The editor must hold a new script (no id), or the server draft draftOf (that id, with
//   a version whose major part is 0), which stays as it is. Once it is saved, the editor is
//   switched to the saved script with openScript and the saved text, so that it no longer shows a
//   new script or the draft.
// - version: as the next version of the saved script the editor holds, through saveScript of the
//   facade, which keeps the name of the script and shows no dialog for a saved script that is not
//   a draft. The editor must hold that script, with a version, and not as a draft.
export type PineSaveRequest =
  { kind: 'new'; name: string; draftOf: string | null } | { kind: 'version'; scriptIdPart: string };

// Saves as `request` says and answers what came of it: the saved script (null when nothing was
// saved), its compile errors (each with its message and, when it has a place, its 1-based line and
// column; empty when it compiles) and, for a new script, whether the editor now holds the saved
// script (tracked; null for a version). The checks that keep TradingView from opening a dialog run
// right before the save and refuse before anything is saved: AUTH_REQUIRED while signed out (the
// app would ask the user to sign in), NOT_AVAILABLE when the editor no longer holds what the
// request expects (a draft would get the naming dialog), INVALID_INPUT for an empty text and for a
// title longer than the 128 characters the app allows (it would show a warning dialog). The
// saved-script limit of the plan is the caller's to check first: saveNewScript opens the paywall
// when it is reached. A save TradingView refuses is NOT_AVAILABLE with the reason, or answers its
// compile errors with no script.
export function savePineScript(
  win: TvWindow,
  lib: PageLib,
  request: PineSaveRequest,
):
  | Promise<
      | {
          script: { id: string; version: string | null } | null;
          errors: { message: string; line: number | null; column: number | null }[];
          tracked: boolean | null;
        }
      | PageErrorSentinel
    >
  | PageErrorSentinel {
  const getOpenPineEditor = lib.findExport('getOpenPineEditor');
  if (typeof getOpenPineEditor !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no registry of open Pine editors',
        hint: 'Check app_health: the app may still be loading, or the tab does not show a chart.',
      },
    };
  }
  let entry: Partial<OpenPineEditorLike> | null = null;
  for (const candidate of ['dialog', 'bottom'] as const) {
    let found: unknown;
    try {
      found = (getOpenPineEditor as (at: string) => unknown)(candidate);
    } catch {
      found = null;
    }
    if (found !== null && found !== undefined) {
      entry = found;
      break;
    }
  }
  if (entry === null) {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: 'The Pine Editor is not open',
        hint: 'Open a script with pine_open, or start one with pine_new.',
      },
    };
  }
  let found: unknown;
  try {
    found = entry.getFacade?.();
  } catch {
    found = null;
  }
  const facade = (typeof found === 'object' && found !== null ? found : {}) as Partial<
    PineEditorFacadeLike & { isDraft: () => unknown }
  >;
  const kind = (request as Partial<PineSaveRequest> | undefined)?.kind;
  let pineApi: Partial<PineEditorApiLike> | null | undefined;
  try {
    pineApi = win.TradingViewApi?.pineEditorApi?.();
  } catch {
    pineApi = undefined;
  }
  const api = pineApi;
  const missing =
    typeof facade.getSource !== 'function' || typeof facade.getScriptIdVersion !== 'function'
      ? 'facade'
      : kind === 'new'
        ? typeof api?.saveNewScript !== 'function'
          ? 'saveNewScript'
          : typeof facade.openScript !== 'function'
            ? 'openScript'
            : null
        : kind === 'version'
          ? typeof facade.saveScript !== 'function' || typeof facade.isDraft !== 'function'
            ? 'saveScript'
            : null
          : 'request';
  if (missing !== null) {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: `The Pine Editor of this build has no ${missing} to save with`,
        hint: 'Save the script in the Pine Editor of TradingView itself.',
        details: { member: missing },
      },
    };
  }
  const editor = facade as Required<PineEditorFacadeLike> & { isDraft: () => unknown };
  const refuse = (code: ErrorCode, message: string, hint: string): PageErrorSentinel => ({
    __tvmcpError: { code, message, hint },
  });
  if (win.is_authenticated !== true) {
    return refuse(
      'AUTH_REQUIRED',
      'Saving a Pine script needs a signed-in TradingView account',
      'Sign in to TradingView, then save again.',
    );
  }
  const idsOf = (): { scriptIdPart: string | null; version: string | null } => {
    try {
      const ids = editor.getScriptIdVersion() as {
        scriptIdPart?: unknown;
        version?: unknown;
      } | null;
      return {
        scriptIdPart:
          typeof ids?.scriptIdPart === 'string' && ids.scriptIdPart !== ''
            ? ids.scriptIdPart
            : null,
        version: typeof ids?.version === 'string' && ids.version !== '' ? ids.version : null,
      };
    } catch {
      return { scriptIdPart: null, version: null };
    }
  };
  const held = idsOf();
  if (
    request.kind === 'new' &&
    (held.scriptIdPart !== request.draftOf ||
      (held.scriptIdPart !== null && Number.parseInt(held.version ?? '', 10) !== 0))
  ) {
    return refuse(
      'NOT_AVAILABLE',
      'The Pine Editor no longer holds the new script or the server draft to save',
      'Check the state with pine_get_source, then save again.',
    );
  }
  if (request.kind === 'version') {
    let draft: unknown;
    try {
      draft = editor.isDraft();
    } catch {
      draft = undefined;
    }
    if (held.scriptIdPart !== request.scriptIdPart || held.version === null || draft !== false) {
      return refuse(
        'NOT_AVAILABLE',
        'The Pine Editor no longer holds the saved script to save, or holds it as a draft',
        'Check the state with pine_get_source, then save again.',
      );
    }
  }

  const reasonOf = (error: unknown): string => {
    if (typeof error === 'string') {
      return error;
    }
    const message: unknown = (error as { message?: unknown } | null | undefined)?.message;
    return typeof message === 'string'
      ? message
      : 'TradingView gave no reason; the console of the Pine Editor may say more';
  };
  // The compile errors of a save result, or of what a refused save rejected with.
  const errorsOf = (
    compileErrors: PineCompileErrorsLike | null | undefined,
  ): { message: string; line: number | null; column: number | null }[] =>
    (Array.isArray(compileErrors?.errors) ? (compileErrors.errors as unknown[]) : []).map((raw) => {
      const diagnostic = (typeof raw === 'object' && raw !== null ? raw : {}) as {
        message?: unknown;
        start?: { line?: unknown; column?: unknown } | null;
      };
      const place = (value: unknown): number | null =>
        typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
      return {
        message:
          typeof diagnostic.message === 'string' ? diagnostic.message : 'Unknown compile error',
        line: place(diagnostic.start?.line),
        column: place(diagnostic.start?.column),
      };
    });
  const refusedErrors = (error: unknown) => {
    const rejected = (typeof error === 'object' && error !== null ? error : {}) as {
      reason?: unknown;
      errors?: unknown;
    };
    const reason = (
      typeof rejected.reason === 'object' && rejected.reason !== null ? rejected.reason : rejected
    ) as PineCompileErrorsLike;
    return errorsOf(reason);
  };
  const notSaved = (error: unknown): PageErrorSentinel => {
    const reason = reasonOf(error);
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: `TradingView did not save the script: ${reason}`,
        hint: 'Check the console of the Pine Editor in TradingView.',
        details: { reason },
      },
    };
  };

  const save = async () => {
    const source = await editor.getSource();
    if (typeof source !== 'string' || source.trim() === '') {
      return refuse(
        'INVALID_INPUT',
        'The Pine Editor holds no text to save',
        'Set the source with pine_set_source first.',
      );
    }
    // The title the app parses from the declaration, when it is a plain string literal.
    const title =
      /^[ \t]*(?:indicator|strategy|library)[ \t]*\([ \t]*(?:title[ \t]*=[ \t]*)?(["'])((?:\\.|(?!\1)[^\\\n])*)\1/m.exec(
        source,
      )?.[2];
    if (title !== undefined && title.length > 128) {
      return refuse(
        'INVALID_INPUT',
        `The title of the script is ${String(title.length)} characters long; TradingView saves titles of at most 128`,
        'Shorten the title in the declaration with pine_set_source, then save again.',
      );
    }
    if (request.kind === 'version') {
      let answer: unknown;
      try {
        answer = await editor.saveScript();
      } catch (error) {
        return notSaved(error);
      }
      const saved = (typeof answer === 'object' && answer !== null ? answer : {}) as {
        compileErrors?: PineCompileErrorsLike | null;
        script?: unknown;
      };
      const script = (typeof saved.script === 'object' ? saved.script : null) as {
        scriptIdPart?: unknown;
        version?: unknown;
      } | null;
      const after = idsOf();
      const id =
        typeof script?.scriptIdPart === 'string' ? script.scriptIdPart : after.scriptIdPart;
      const version = typeof script?.version === 'string' ? script.version : after.version;
      return {
        script: id === null ? null : { id, version },
        errors: errorsOf(saved.compileErrors),
        tracked: null,
      };
    }
    let answer: unknown;
    try {
      answer = await (
        api as PineEditorApiLike & Required<Pick<PineEditorApiLike, 'saveNewScript'>>
      ).saveNewScript({
        source,
        name: request.name,
      });
    } catch (error) {
      const errors = refusedErrors(error);
      return errors.length > 0 ? { script: null, errors, tracked: null } : notSaved(error);
    }
    const result = (
      typeof answer === 'object' && answer !== null ? answer : {}
    ) as PineSaveResultLike;
    const meta = result.metaInfo;
    const id =
      typeof meta?.scriptIdPart === 'string' && meta.scriptIdPart !== '' ? meta.scriptIdPart : null;
    const versionValue = meta?.pine?.version;
    const version = typeof versionValue === 'string' && versionValue !== '' ? versionValue : null;
    const errors = errorsOf(result.compileErrors);
    if (result.success !== true || id === null) {
      return { script: null, errors, tracked: null };
    }
    // The editor still shows the text as a new script; it is switched to the saved one, with the
    // same text. Should that fail, the app opens a new script, and tracked says so.
    let tracked: boolean;
    try {
      const info: { scriptIdPart: string; version?: string; scriptSource: string } = {
        scriptIdPart: id,
        scriptSource: source,
      };
      if (version !== null) {
        info.version = version;
      }
      await editor.openScript(info);
      tracked = idsOf().scriptIdPart === id;
    } catch {
      tracked = false;
    }
    return { script: { id, version }, errors, tracked };
  };
  return save().catch(notSaved);
}

// A saved script as readSavedPineScripts reads it from the list of the app.
export type SavedScriptRow = Extract<
  Awaited<ReturnType<typeof readSavedPineScripts>>,
  { scripts: unknown }
>['scripts'][number];
