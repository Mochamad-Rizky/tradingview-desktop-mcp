import type { PageErrorSentinel } from '../../core/tv/page-bridge.js';
import type { PageLib } from '../../core/tv/page-lib.js';
import type {
  BottomWidgetBarLike,
  OpenPineEditorLike,
  PageLayoutServiceLike,
  PineEditorApiLike,
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
// draft (draft), and the id and version of its script, null for a script that has no id or no
// version yet. unreadable lists the members of the facade that could not be read, in the order
// they were read: getFacade when the facade itself could not be had, else any of
// getScriptIdVersion, isModified and isDraft. An unreadable isModified counts as modified, so that
// the text is not replaced without confirm, and an unreadable isDraft as a draft when there is no
// script.
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
        script: { id: string; version: string } | null;
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
  let script: { id: string; version: string } | null = null;
  const ids = ask('getScriptIdVersion');
  if (ids !== null && (ids.value === null || ids.value === undefined)) {
    script = null;
  } else if (ids !== null && typeof ids.value === 'object') {
    const { scriptIdPart, version } = ids.value as { scriptIdPart?: unknown; version?: unknown };
    if (typeof scriptIdPart !== 'string' || scriptIdPart === '') {
      unreadable.push('getScriptIdVersion');
    } else if (typeof version === 'string' && version !== '') {
      script = { id: scriptIdPart, version };
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
  let draft = script === null;
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
    let script: { id: string; version: string } | null = null;
    const ids = ask('getScriptIdVersion');
    if (ids !== null && (ids.value === null || ids.value === undefined)) {
      script = null;
    } else if (ids !== null && typeof ids.value === 'object') {
      const { scriptIdPart, version } = ids.value as { scriptIdPart?: unknown; version?: unknown };
      if (typeof scriptIdPart !== 'string' || scriptIdPart === '') {
        unreadable.push('getScriptIdVersion');
      } else if (typeof version === 'string' && version !== '') {
        script = { id: scriptIdPart, version };
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
    let draft = script === null;
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
