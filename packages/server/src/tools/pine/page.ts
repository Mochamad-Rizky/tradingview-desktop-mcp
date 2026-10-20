import type { ErrorCode } from '../../core/errors.js';
import type { PageErrorSentinel } from '../../core/tv/page-bridge.js';
import type { PageLib } from '../../core/tv/page-lib.js';
import type {
  BottomWidgetBarLike,
  ChartWidgetApiLike,
  OpenPineEditorLike,
  PageLayoutServiceLike,
  PineCompileErrorsLike,
  PineConsoleEntryLike,
  PineEditorApiLike,
  PineEditorFacadeLike,
  PineSaveResultLike,
  SavedPineScriptLike,
  ServiceLocatorLike,
  StudyCoreLike,
  StudyMetaInfoLike,
  TradingViewApiLike,
  TvWindow,
} from '../../core/tv/tv-window.js';

// The page functions of the Pine Editor access layer (reverse-engineering notes of Plan 2, section
// Q1). The page bridge sends the source text of each one into the page, so each uses nothing of
// this file, only its parameters and the globals of the page, and whatever it shares with another
// is written out in each. Types are erased, so the type imports above are fine.
//
// An editor is open while the registry of open editors (the export getOpenPineEditor) answers for
// one of its two placements, "dialog" and "bottom". The current layout opens the editor as the
// right side panel, which registers as "dialog" (seen on the app), so "dialog" is looked at first.
// Members of the app are read defensively: another web build can drop or reshape any of them, and
// a read that throws counts as no answer.
//
// Nothing here returns or keeps the text of the editor, and nothing reads the name of the account.
// Of the state the editor persists under it, only the flag for unsaved changes is read, through
// the helper of the app (getPersistedValue), because the app shows unsaved text again when the
// editor opens and its isModified() then reads false. Every function says CAPABILITY_UNAVAILABLE
// only before it acts.

// The state of the editor, read without changing anything: whether one is open and where, whether
// its text has unsaved changes (modified: isModified() of the facade, or the flag the app keeps for
// unsaved changes, which is set for unsaved text the app showed again when the editor opened),
// whether its script is new or saved only as a server draft (draft), and the id and version of its
// script: null for a script that has no id yet, and a version of null for one that has an id but no
// version, which is not a new script either. unreadable lists what could not be read, in the order
// it was read: getFacade when the facade itself could not be had, else any of getScriptIdVersion,
// isModified, unsavedChanges (the flag) and isDraft. An unreadable isModified or flag counts as
// modified, so that the text is not replaced without confirm, and an unreadable isDraft as a draft
// when there is no script or no version.
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
  // Whether the app keeps unsaved changes for the editor (has_unsaved_modifications, under that
  // bare key for every placement, read with the helper of the app, which keeps it per account), or
  // null when that cannot be read. The app writes it when the editor closes and shows the unsaved
  // text again when the editor opens, and isModified() then reads false (seen on the app), so its
  // own guard asks this flag as well. While the editor is open the flag can lag: it stays set after
  // the text was replaced until the editor closes, which only makes the guard ask for confirm.
  const keptUnsaved = (): boolean | null => {
    try {
      const read = lib.findExport('getPersistedValue');
      const key = lib.findExport('hasScriptModificationsKey');
      if (typeof read !== 'function' || typeof key !== 'string') {
        return null;
      }
      const value: unknown = (read as (key: string, perUser: boolean) => unknown)(key, true);
      return value === null || value === undefined
        ? false
        : typeof value === 'boolean'
          ? value
          : null;
    } catch {
      return null;
    }
  };
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
  if (typeof changed?.value !== 'boolean') {
    unreadable.push('isModified');
  }
  const kept = keptUnsaved();
  if (kept === null) {
    unreadable.push('unsavedChanges');
  }
  if (typeof changed?.value === 'boolean' && kept !== null) {
    modified = changed.value || kept;
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

// Opens the editor the way the Pine button of the toolbar of the app does, which discards nothing,
// and waits at most waitMs until the editor is registered and mounted, then answers its state. Seen
// on the app: the first open of a session shows the script or draft the editor last held; an open
// after the side panel closed shows a new script; and either shows again the unsaved text the app
// kept, which then counts as unsaved changes through the flag the app keeps for it. Mounted is
// inferred: getSource of the facade answers instead of rejecting (the text it answers is dropped).
// An editor that is already open is answered at once, without opening it again. The whole wait runs
// in this one call, so the page library pushes one chunk at most. A wait that is not a positive
// number waits no time. Failures: TIMEOUT when the editor is not ready in time, and NOT_AVAILABLE
// with the reason when TradingView fails to open it.
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
  // Whether the app keeps unsaved changes for the editor (has_unsaved_modifications, under that
  // bare key for every placement, read with the helper of the app, which keeps it per account), or
  // null when that cannot be read. The app writes it when the editor closes and shows the unsaved
  // text again when the editor opens, and isModified() then reads false (seen on the app), so its
  // own guard asks this flag as well. While the editor is open the flag can lag: it stays set after
  // the text was replaced until the editor closes, which only makes the guard ask for confirm.
  const keptUnsaved = (): boolean | null => {
    try {
      const read = lib.findExport('getPersistedValue');
      const key = lib.findExport('hasScriptModificationsKey');
      if (typeof read !== 'function' || typeof key !== 'string') {
        return null;
      }
      const value: unknown = (read as (key: string, perUser: boolean) => unknown)(key, true);
      return value === null || value === undefined
        ? false
        : typeof value === 'boolean'
          ? value
          : null;
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
    if (typeof changed?.value !== 'boolean') {
      unreadable.push('isModified');
    }
    const kept = keptUnsaved();
    if (kept === null) {
      unreadable.push('unsavedChanges');
    }
    if (typeof changed?.value === 'boolean' && kept !== null) {
      modified = changed.value || kept;
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
// closeScript of the widget controller, which reset the script and so discard the text. Seen on the
// app: the side panel goes and the editor leaves the registry, and the app keeps the script it held
// and a flag for unsaved changes, whose text it shows again on the next open (see openPineEditor).
// An editor that is not open is left alone. Without its close path, or with a dialog that is not
// the "pine" side panel, the answer is CAPABILITY_UNAVAILABLE, before anything is called; a close
// path that throws is NOT_AVAILABLE with the reason.
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
// kind (extra.kind on the app); an item without an id is left out, and so is the text of every
// script, which the list carries too. Changes nothing. CAPABILITY_UNAVAILABLE when the page has no
// way to list the scripts, NOT_AVAILABLE with the reason when the request fails.
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
              // The app lists the kind in extra, where its own getScriptKind reads it.
              kind: text(item.kind) ?? text(item.extra?.kind),
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
// - source: replaces the text, keeping the script. With expect, only if the editor holds that script
//   (its id, null for a script that has none) and that text right before it acts: else it changes
//   nothing and answers which of the two differs. That check comes before the one for unsaved
//   changes, so an editor that has changed is told from one whose unsaved text is not to be
//   replaced.
// - open: opens a saved script, with its own text loaded by the app, or with source as its text.
export type PineEditorChange =
  | {
      kind: 'new';
      type: 'indicator' | 'strategy' | 'library';
      source: string | null;
      allowModified: boolean;
    }
  | {
      kind: 'source';
      source: string;
      allowModified: boolean;
      expect?: { scriptId: string | null; source: string };
    }
  | {
      kind: 'open';
      scriptIdPart: string;
      version: string | null;
      source: string | null;
      allowModified: boolean;
    };

// Changes the text of the open editor as `change` says, through the facade of the editor, and
// answers { changed: true } once the facade has done it, or { changed: false, differs } when an
// expectation of a source change was not met, with nothing changed (differs is "script" when the
// editor holds another script, which is also so when its id cannot be read, as the state of the
// editor reads it, and "text" when it holds other text or its text cannot be read). It never
// saves. The caller reads the state of the editor afterwards: openScript of the app opens a new
// script whenever opening the saved one fails, which the state shows. Failures:
// CAPABILITY_UNAVAILABLE without the registry or the member of the facade the change needs (and
// getSource when it has an expectation), NOT_AVAILABLE when no editor is open or the facade fails
// (with the reason), CONFIRMATION_REQUIRED as described above, all before the facade acts except a
// failing facade.
export function changePineEditor(
  _win: TvWindow,
  lib: PageLib,
  change: PineEditorChange,
):
  | Promise<{ changed: true } | { changed: false; differs: 'script' | 'text' } | PageErrorSentinel>
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
  const unavailable = (member: string, purpose = 'change its text'): PageErrorSentinel => ({
    __tvmcpError: {
      code: 'CAPABILITY_UNAVAILABLE',
      message: `The Pine Editor of this build has no ${member} to ${purpose} with`,
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
  const expected = change.kind === 'source' ? (change.expect ?? null) : null;
  if (expected !== null && typeof facade.getSource !== 'function') {
    return unavailable('getSource', 'check its text');
  }
  const editor = facade as Required<PineEditorFacadeLike>;
  // Which part of what the caller expects the editor to hold it does not hold, null when it holds
  // all of it. An id that cannot be read counts as no id, and a text that cannot be read as other
  // text, so that nothing is changed on a guess.
  const differsFrom = async (wanted: {
    scriptId: string | null;
    source: string;
  }): Promise<'script' | 'text' | null> => {
    let part: unknown;
    try {
      part = (facade.getScriptIdVersion?.() as { scriptIdPart?: unknown } | null | undefined)
        ?.scriptIdPart;
    } catch {
      part = undefined;
    }
    if ((typeof part === 'string' && part !== '' ? part : null) !== wanted.scriptId) {
      return 'script';
    }
    let text: unknown;
    try {
      text = await editor.getSource();
    } catch {
      text = undefined;
    }
    return text === wanted.source ? null : 'text';
  };
  const act = (): Promise<{ changed: true } | PageErrorSentinel> | PageErrorSentinel => {
    if (!change.allowModified) {
      let modified: unknown;
      try {
        modified = facade.isModified?.();
      } catch {
        modified = undefined;
      }
      // Whether the app keeps unsaved changes for the editor (has_unsaved_modifications, under that
      // bare key, read with its own helper, which keeps it per account): unsaved text of an editor
      // whose side panel closed comes back when it opens with isModified() false (seen on the app),
      // so the guard of the app asks this flag too. null when it cannot be read.
      let kept: unknown = null;
      try {
        const read = lib.findExport('getPersistedValue');
        const key = lib.findExport('hasScriptModificationsKey');
        if (typeof read === 'function' && typeof key === 'string') {
          const value: unknown = (read as (key: string, perUser: boolean) => unknown)(key, true);
          kept = value ?? false;
        }
      } catch {
        kept = null;
      }
      // An answer that is not false, of either, counts as unsaved changes.
      if (modified !== false || kept !== false) {
        return {
          __tvmcpError: {
            code: 'CONFIRMATION_REQUIRED',
            message: 'The change would replace the unsaved text in the Pine Editor',
            hint: 'Pass confirm: true to replace it, or save it first with pine_save.',
          },
        };
      }
    }
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
  };
  return expected === null
    ? act()
    : differsFrom(expected).then<
        { changed: true } | { changed: false; differs: 'script' | 'text' } | PageErrorSentinel
      >((differs) => (differs === null ? act() : { changed: false, differs }));
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

// The page functions of the compile tools (notes of Plan 2, sections Q1, Q3 and Q4). A diagnostic
// they answer (PineRawDiagnostic) keeps what JSON carries of one of the app: message (null when it
// is no text), ctx (the values that fill the {name} placeholders of message, text, finite numbers
// and booleans) and start and end (null when missing, with a line or column that is no number as
// null). The Node side (mappers.ts) turns these into what the tools return.

// Compiles `source` and changes nothing: no editor, chart or saved script is touched. It calls the
// export translateScriptAsync(source, pineId) of the pine facade client, which posts the text to
// translate_source/<pineId> (one request) and resolves { success, metaInfo, compileErrors }, or
// rejects with an Error whose reason holds the compile errors (handleTranslateResult of the app).
// pineId is only the id the compiled metadata is stamped with; the caller passes one that names no
// script. Answers the errors and the warnings, both empty for a text that compiles. Failures, all
// without a compile result: a rejection with a plain string, the way the app reports an HTTP failure
// (413 for a text too large, 5xx, ...), is NOT_AVAILABLE with that text as the message; any other
// rejection is NOT_AVAILABLE with the reason; no answer within waitMs is TIMEOUT; and a page without
// the export is CAPABILITY_UNAVAILABLE.
export function compilePineSource(
  _win: TvWindow,
  lib: PageLib,
  source: string,
  pineId: string,
  waitMs: number,
):
  | Promise<
      | Record<
          'errors' | 'warnings',
          {
            message: string | null;
            ctx: Record<string, string | number | boolean>;
            start: { line: number | null; column: number | null } | null;
            end: { line: number | null; column: number | null } | null;
          }[]
        >
      | PageErrorSentinel
    >
  | PageErrorSentinel {
  const translateScriptAsync = lib.findExport('translateScriptAsync');
  if (typeof translateScriptAsync !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no Pine compiler to compile with',
        hint: 'Check app_health: the app may still be loading, or the tab does not show a chart.',
      },
    };
  }
  const place = (value: unknown): { line: number | null; column: number | null } | null => {
    if (typeof value !== 'object' || value === null) {
      return null;
    }
    const { line, column } = value as { line?: unknown; column?: unknown };
    const number = (part: unknown): number | null =>
      typeof part === 'number' && Number.isFinite(part) ? part : null;
    return { line: number(line), column: number(column) };
  };
  const diagnosticsOf = (list: unknown): PineRawDiagnostic[] =>
    (Array.isArray(list) ? (list as unknown[]) : []).map((raw) => {
      const item = (typeof raw === 'object' && raw !== null ? raw : {}) as {
        message?: unknown;
        ctx?: unknown;
        start?: unknown;
        end?: unknown;
      };
      const ctx: Record<string, string | number | boolean> = {};
      if (typeof item.ctx === 'object' && item.ctx !== null) {
        for (const [key, value] of Object.entries(item.ctx as Record<string, unknown>)) {
          if (
            typeof value === 'string' ||
            typeof value === 'boolean' ||
            (typeof value === 'number' && Number.isFinite(value))
          ) {
            ctx[key] = value;
          }
        }
      }
      return {
        message: typeof item.message === 'string' ? item.message : null,
        ctx,
        start: place(item.start),
        end: place(item.end),
      };
    });
  const failed = (message: string, reason: string): PageErrorSentinel => ({
    __tvmcpError: {
      code: 'NOT_AVAILABLE',
      message,
      hint: 'Try again in a moment, or compile the script in the Pine Editor of TradingView.',
      details: { reason },
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ late: true }>((resolve) => {
    timer = setTimeout(() => {
      resolve({ late: true });
    }, waitMs);
  });
  const compiled = Promise.resolve()
    .then(() => (translateScriptAsync as (text: string, id: string) => unknown)(source, pineId))
    .then(
      (value: unknown) => ({ value }),
      (error: unknown) => ({ error }),
    );
  return Promise.race([compiled, late]).then((outcome) => {
    clearTimeout(timer);
    if ('late' in outcome) {
      return {
        __tvmcpError: {
          code: 'TIMEOUT',
          message: `TradingView did not compile the script within ${String(waitMs)} ms`,
          hint: 'Try again in a moment: the Pine compiler of TradingView may be busy.',
          details: { waitMs },
        },
      };
    }
    if ('error' in outcome) {
      const { error } = outcome;
      if (typeof error === 'string') {
        // An HTTP failure: the app rejects with the text it shows.
        return failed(error, error);
      }
      const rejected = (typeof error === 'object' && error !== null ? error : {}) as {
        reason?: { errors?: unknown; warnings?: unknown } | null;
        message?: unknown;
      };
      const errors = diagnosticsOf(rejected.reason?.errors);
      if (errors.length > 0) {
        return { errors, warnings: diagnosticsOf(rejected.reason?.warnings) };
      }
      const reason = typeof rejected.message === 'string' ? rejected.message : String(error);
      return failed(`TradingView did not compile the script: ${reason}`, reason);
    }
    const result = (
      typeof outcome.value === 'object' && outcome.value !== null ? outcome.value : {}
    ) as { compileErrors?: { errors?: unknown; warnings?: unknown } | null };
    return {
      errors: diagnosticsOf(result.compileErrors?.errors),
      warnings: diagnosticsOf(result.compileErrors?.warnings),
    };
  });
}

export type PineRawDiagnostic = Exclude<
  Awaited<ReturnType<typeof compilePineSource>>,
  PageErrorSentinel
>['errors'][number];

// Adds the script the open editor holds to the active chart through addToChart of the facade, the
// way the Add to chart button of the editor does, and answers the ids of the studies on the chart
// right before (for the caller to find the one that was added) and how many entries the console
// of the editor held then (consoleFrom; null when the console cannot be read), for the caller to
// read the diagnostics written since. The app saves a draft (a new script or a server draft) as a
// server draft first and compiles; it resolves even when compilation fails. Waits at most waitMs for
// addToChart (TIMEOUT). The checks that keep the app from opening a dialog run right before it acts
// and refuse before anything is added: AUTH_REQUIRED while signed out (the app would ask the user
// to sign in), NOT_AVAILABLE for a saved script with unsaved changes or whose state cannot be read
// (the app would ask in a modal dialog whether to save a new version). The indicator limit of the
// plan is the caller's to check first, as the app opens its paywall on a full chart. Other failures:
// CAPABILITY_UNAVAILABLE without the registry, a facade with addToChart or the chart API,
// NOT_AVAILABLE when no editor is open or addToChart rejects (with the reason).
export function addPineScriptToChart(
  win: TvWindow,
  lib: PageLib,
  waitMs: number,
):
  | Promise<{ before: string[]; consoleFrom: number | null } | PageErrorSentinel>
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
  const facade = (
    typeof found === 'object' && found !== null ? found : {}
  ) as Partial<PineEditorFacadeLike>;
  if (typeof facade.addToChart !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'The Pine Editor of this build has no addToChart to add the script with',
        hint: 'Add the script in the Pine Editor of TradingView itself.',
      },
    };
  }
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  let chart: { getAllStudies?: unknown } | null | undefined;
  try {
    chart = api?.activeChart?.();
  } catch {
    chart = undefined;
  }
  const studiesOf = chart?.getAllStudies;
  if (typeof studiesOf !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no chart API to add the script to',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  if (win.is_authenticated !== true) {
    return {
      __tvmcpError: {
        code: 'AUTH_REQUIRED',
        message: 'Adding a Pine script to the chart needs a signed-in TradingView account',
        hint: 'Sign in to TradingView, then try again.',
      },
    };
  }
  const ask = (name: 'isDraft' | 'isModified'): unknown => {
    try {
      const member = facade[name];
      return typeof member === 'function' ? (member as () => unknown).call(facade) : undefined;
    } catch {
      return undefined;
    }
  };
  // Only a draft, or a saved script without unsaved changes, is added without a dialog; an answer
  // that cannot be read counts as the case with the dialog.
  if (ask('isDraft') !== true && ask('isModified') !== false) {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message:
          'The Pine Editor holds a saved script with unsaved changes, which TradingView adds only ' +
          'after asking in a dialog whether to save a new version',
        hint:
          'Save the changes first with pine_save, or start a new script with pine_new and the ' +
          'source, then add that.',
      },
    };
  }
  const idsNow = (): string[] => {
    let listed: unknown;
    try {
      listed = (studiesOf as () => unknown).call(chart);
    } catch {
      listed = [];
    }
    return (Array.isArray(listed) ? (listed as unknown[]) : []).flatMap((item) => {
      const id: unknown = (item as { id?: unknown } | null | undefined)?.id;
      return typeof id === 'string' ? [id] : typeof id === 'number' ? [String(id)] : [];
    });
  };
  let consoleFrom: number | null = null;
  try {
    const messages = facade._editorStore?.getStore().getState().console?.messages;
    consoleFrom = Array.isArray(messages) ? messages.length : null;
  } catch {
    consoleFrom = null;
  }
  const before = idsNow();
  const editor = facade as Required<Pick<PineEditorFacadeLike, 'addToChart'>>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ late: true }>((resolve) => {
    timer = setTimeout(() => {
      resolve({ late: true });
    }, waitMs);
  });
  const added = Promise.resolve()
    .then(() => editor.addToChart())
    .then(
      () => ({ done: true }) as const,
      (error: unknown) => ({ error }),
    );
  return Promise.race([added, late]).then((outcome) => {
    clearTimeout(timer);
    if ('late' in outcome) {
      return {
        __tvmcpError: {
          code: 'TIMEOUT',
          message: `TradingView did not add the script within ${String(waitMs)} ms`,
          hint:
            'It may still appear on the chart: check indicator_list. If TradingView shows a ' +
            'dialog, answer or close it there.',
          details: { waitMs },
        },
      };
    }
    if ('error' in outcome) {
      const { error } = outcome;
      const message: unknown = (error as { message?: unknown } | null | undefined)?.message;
      const reason =
        typeof error === 'string' ? error : typeof message === 'string' ? message : String(error);
      return {
        __tvmcpError: {
          code: 'NOT_AVAILABLE',
          message: `TradingView did not add the script: ${reason}`,
          hint: 'Check the console of the Pine Editor and indicator_list.',
          details: { reason },
        },
      };
    }
    return { before, consoleFrom };
  });
}

// The study on the active chart whose id is not in `before`, which the editor added: the last such
// Pine study, else null. Only a Pine study is taken for it, so that a study that appeared at the
// same time for another reason is never taken for the script; others lists the ids of the new
// studies that are not Pine studies (or whose metadata cannot be read). compileError is what
// hasCompileError of its study core answers, null when it cannot be read. Changes nothing, and
// needs no page library, so the caller may poll it.
export function readAddedPineStudy(
  win: TvWindow,
  before: string[],
): { studyId: string | null; compileError: boolean | null; others: string[] } {
  const attempt = (read: () => unknown): unknown => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  const chart = attempt(() => api?.activeChart?.()) as
    Partial<ChartWidgetApiLike> | null | undefined;
  const listed = attempt(() => chart?.getAllStudies?.());
  const known = new Set(before);
  const fresh = (Array.isArray(listed) ? (listed as unknown[]) : []).flatMap((item) => {
    const id: unknown = (item as { id?: unknown } | null | undefined)?.id;
    const text = typeof id === 'string' ? id : typeof id === 'number' ? String(id) : null;
    return text === null || known.has(text) ? [] : [text];
  });
  const coreOf = (id: string) =>
    attempt(() => chart?.getStudyById?.(id).study()) as Partial<StudyCoreLike> | null | undefined;
  const isPine = (id: string): boolean => {
    const meta = attempt(() => coreOf(id)?.metaInfo?.()) as StudyMetaInfoLike | null | undefined;
    const pine: unknown = meta?.pine;
    return typeof pine === 'object' && pine !== null;
  };
  const pine = fresh.filter(isPine);
  const others = fresh.filter((id) => !pine.includes(id));
  const studyId = pine.at(-1) ?? null;
  if (studyId === null) {
    return { studyId: null, compileError: null, others };
  }
  const failed = attempt(() => coreOf(studyId)?.hasCompileError?.());
  return { studyId, compileError: typeof failed === 'boolean' ? failed : null, others };
}

// The diagnostics the console of the open editor holds from entry `from` on (the length it had
// before the caller acted; all entries when it has fewer now, as when it was cleared, and none for
// null). An entry with a start is a diagnostic, an error or a warning by its level; its end column,
// which the console keeps one past the last column, is made inclusive again, and an end on line 0
// counts as none. When no entry has a start, the error entries without one are the errors. Without
// an editor or a readable console the answer is empty. Changes nothing.
export function readPineConsoleDiagnostics(
  _win: TvWindow,
  lib: PageLib,
  from: number | null,
): { errors: PineRawDiagnostic[]; warnings: PineRawDiagnostic[] } {
  const none = { errors: [], warnings: [] };
  const getOpenPineEditor = lib.findExport('getOpenPineEditor');
  if (typeof getOpenPineEditor !== 'function' || from === null) {
    return none;
  }
  let messages: unknown;
  for (const candidate of ['dialog', 'bottom'] as const) {
    try {
      const entry = (getOpenPineEditor as (at: string) => unknown)(candidate) as
        Partial<OpenPineEditorLike> | null | undefined;
      if (entry !== null && entry !== undefined) {
        messages = entry.getFacade?.()?._editorStore?.getStore().getState().console?.messages;
        break;
      }
    } catch {
      messages = undefined;
    }
  }
  if (!Array.isArray(messages)) {
    return none;
  }
  const all = messages as unknown[];
  const fresh = (all.length < from ? all : all.slice(from)).map(
    (raw) => (typeof raw === 'object' && raw !== null ? raw : {}) as PineConsoleEntryLike,
  );
  const number = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const toDiagnostic = (entry: PineConsoleEntryLike): PineRawDiagnostic => {
    const endLine = number(entry.end?.line);
    const endColumn = number(entry.end?.column);
    return {
      message: typeof entry.text === 'string' ? entry.text : null,
      ctx: {},
      start:
        typeof entry.start === 'object' && entry.start !== null
          ? { line: number(entry.start.line), column: number(entry.start.column) }
          : null,
      end:
        endLine === null || endLine <= 0
          ? null
          : { line: endLine, column: endColumn === null ? null : endColumn - 1 },
    };
  };
  const placed = fresh.filter((entry) => typeof entry.start === 'object' && entry.start !== null);
  if (placed.length === 0) {
    return {
      errors: fresh.filter((entry) => entry.level === 'error').map(toDiagnostic),
      warnings: [],
    };
  }
  return {
    errors: placed.filter((entry) => entry.level === 'error').map(toDiagnostic),
    warnings: placed.filter((entry) => entry.level === 'warning').map(toDiagnostic),
  };
}

// What the console of the open editor and the Pine logs of the studies on the active chart hold,
// read without changing anything (enableLogs, whose effect is not known, is never called).
// - editor: the entries of the live console of the editor (the private store of the facade; the
//   copy the app persists is keyed by the account and never read), oldest first, each with its
//   level, text and clock (the local clock time the app keeps, without a date), and order, a sort
//   key in milliseconds: the clock read as a time of today in the time zone of the page, or of
//   yesterday when that lies in the future, and never later than the key of the entry after it, so
//   the order of the console stays (a clock that cannot be read takes the key of the entry after
//   it). null when no editor is open (editorOpen false) or its console cannot be read.
// - scripts: the log items of each study whose core has logs(), in the order of the chart and of
//   the set, with the time and the bar time as the app gives them (null when no number) and the
//   level as text (info when it is none).
// - silentStudies: the studies whose logs() is a set without items: their script writes logs, but
//   the app holds none, as when the logs are not enabled.
export function readPineConsole(
  win: TvWindow,
  lib: PageLib,
): {
  editorOpen: boolean;
  editor: { level: string; text: string; clock: string | null; order: number | null }[] | null;
  scripts: {
    studyId: string;
    level: string;
    text: string;
    time: number | null;
    barTime: number | null;
  }[];
  silentStudies: string[];
} {
  const attempt = (read: () => unknown): unknown => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const number = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

  let editorOpen = false;
  let messages: unknown;
  const getOpenPineEditor = lib.findExport('getOpenPineEditor');
  if (typeof getOpenPineEditor === 'function') {
    for (const candidate of ['dialog', 'bottom'] as const) {
      const entry = attempt(() => (getOpenPineEditor as (at: string) => unknown)(candidate)) as
        Partial<OpenPineEditorLike> | null | undefined;
      if (entry !== null && entry !== undefined) {
        editorOpen = true;
        messages = attempt(
          () => entry.getFacade?.()?._editorStore?.getStore().getState().console?.messages,
        );
        break;
      }
    }
  }
  // A clock such as 14:03:07 or 2:03:07 PM as a time in milliseconds, or null.
  const now = Date.now();
  const clockTime = (clock: string): number | null => {
    const match = /(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AaPp])\.?[Mm]\.?)?/.exec(clock);
    if (match === null) {
      return null;
    }
    let hours = Number(match[1]);
    const half = match[4]?.toLowerCase();
    if (half !== undefined) {
      hours = (hours % 12) + (half === 'p' ? 12 : 0);
    }
    const at = new Date(now);
    at.setHours(hours, Number(match[2]), Number(match[3] ?? 0), 0);
    const time = at.getTime();
    return time > now ? time - 86_400_000 : time;
  };
  let editor: { level: string; text: string; clock: string | null; order: number | null }[] | null =
    null;
  if (editorOpen && Array.isArray(messages)) {
    const entries = (messages as unknown[]).map((raw) => {
      const item = (typeof raw === 'object' && raw !== null ? raw : {}) as PineConsoleEntryLike;
      return {
        level: typeof item.level === 'string' ? item.level : 'info',
        text: typeof item.text === 'string' ? item.text : '',
        clock: typeof item.time === 'string' ? item.time : null,
        order: null as number | null,
      };
    });
    let next = Number.POSITIVE_INFINITY;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const item = entries[index];
      if (item !== undefined) {
        const parsed = item.clock === null ? null : clockTime(item.clock);
        const order = Math.min(parsed ?? (Number.isFinite(next) ? next : now), next);
        item.order = order;
        next = order;
      }
    }
    editor = entries;
  }

  const scripts: {
    studyId: string;
    level: string;
    text: string;
    time: number | null;
    barTime: number | null;
  }[] = [];
  const silentStudies: string[] = [];
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  const chart = attempt(() => api?.activeChart?.()) as
    Partial<ChartWidgetApiLike> | null | undefined;
  const listed = attempt(() => chart?.getAllStudies?.());
  for (const item of Array.isArray(listed) ? (listed as unknown[]) : []) {
    const rawId: unknown = (item as { id?: unknown } | null | undefined)?.id;
    const studyId =
      typeof rawId === 'string' ? rawId : typeof rawId === 'number' ? String(rawId) : null;
    if (studyId === null) {
      continue;
    }
    const core = attempt(() => chart?.getStudyById?.(studyId).study()) as
      Partial<StudyCoreLike> | null | undefined;
    const set = attempt(() => core?.logs?.()) as
      | {
          forEach?: unknown;
          values?: unknown;
          [Symbol.iterator]?: unknown;
        }
      | null
      | undefined;
    if (typeof set !== 'object' || set === null) {
      continue;
    }
    const items: unknown[] = [];
    attempt(() => {
      if (typeof set.forEach === 'function') {
        (set.forEach as (callback: (value: unknown) => void) => void).call(set, (value) => {
          items.push(value);
        });
      } else {
        const iterate =
          typeof set.values === 'function'
            ? (set.values as () => Iterable<unknown>).call(set)
            : typeof set[Symbol.iterator] === 'function'
              ? (set as Iterable<unknown>)
              : [];
        for (const value of iterate) {
          items.push(value);
        }
      }
    });
    const before = scripts.length;
    for (const raw of items) {
      if (typeof raw !== 'object' || raw === null) {
        continue;
      }
      const log = raw as { barTime?: unknown; time?: unknown; level?: unknown; message?: unknown };
      scripts.push({
        studyId,
        level: typeof log.level === 'string' ? log.level : 'info',
        text: typeof log.message === 'string' ? log.message : '',
        time: number(log.time),
        barTime: number(log.barTime),
      });
    }
    if (scripts.length === before && items.length === 0) {
      silentStudies.push(studyId);
    }
  }
  return { editorOpen, editor, scripts, silentStudies };
}
