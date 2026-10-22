import type { PageErrorSentinel } from '../../core/tv/page-bridge.js';
import type { PageLib } from '../../core/tv/page-lib.js';
import type {
  ChartWidgetApiLike,
  CreateNewChartLike,
  HasPermissionsToCreateNewChartLike,
  NewChartOptionsLike,
  SeriesLike,
  TradingViewApiLike,
  TvWindow,
} from '../../core/tv/tv-window.js';

// The page functions of the layout tools (reverse-engineering notes of Plan 3, section 1). The page
// bridge sends the source text of each one into the page, so each uses nothing of this file, only
// its parameters and the globals of the page, and whatever it shares with another is written out in
// each. Types are erased, so the type imports above are fine.
//
// Saved layouts are the user's data. The readers send nothing but the request the layouts menu of the
// app sends (getSavedCharts). loadLayoutInPlace loads a saved layout in place with
// loadLayoutFromServerByLayoutId(url, false, true), which discards unsaved changes without the dialog
// of the app and never opens a new tab; loadChartFromServer, which asks about unsaved changes in a
// dialog, and createNewLayout, which rewrites the URL of the page without loading the layout, are
// never used. createLayoutViaApi saves a new layout with the export createNewChart, as the Create new
// layout dialog of the app does, and leaves the page alone: openNewChart, which navigates the tab, is
// never used. Only the two functions that need an export of the app take the page library, so that a
// caller can poll the others without adding a chunk to the chunk list of the app at every look.

// The layout on the chart, as far as the tools need it: whether an account is signed in
// (window.is_authenticated), the short id of the layout (layoutId(), the url of its saved record) and
// its name, each null for a layout that was never saved, and whether it has unsaved changes, null
// when TradingView does not tell. A type alias, not an interface: it comes back from the page as
// JSON, which a type must satisfy JsonValue for.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type LayoutState = {
  signedIn: boolean;
  id: string | null;
  name: string | null;
  unsaved: boolean | null;
};

// A saved layout as getSavedCharts lists it: its url (the short id of the layout; null when the
// record has none), its name, when it was last modified as the record gives it (modified_iso, a
// number in Unix seconds despite its name; null when it is no finite number), and whether it is over
// the CHART_STORAGE limit of the plan.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type SavedLayoutRow = {
  url: string | null;
  name: string | null;
  modified: number | null;
  overLimit: boolean;
};

// How a load of a layout ended: loaded (the loader resolved, which it does once the content of the
// layout is in place), failed (it rejected or threw, with why) or late (it had not ended within the
// wait).
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type LoadOutcome = { ended: 'loaded' | 'failed' | 'late'; reason: string | null };

// The layout on the chart as a LayoutState. A member that cannot be read gives null. It changes
// nothing and sends nothing. CAPABILITY_UNAVAILABLE on a page without layoutId().
export function readLayoutState(win: TvWindow): LayoutState | PageErrorSentinel {
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  if (typeof api?.layoutId !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no layout API of TradingView to read the layout from',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  const attempt = (read: () => unknown): unknown => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const text = (value: unknown): string | null =>
    typeof value === 'string' && value !== '' ? value : null;
  // A read-only watched value, whose value() is read as a method of it.
  const changes = attempt(() => api.hasChartChanges?.()) as { value?: unknown } | null | undefined;
  const unsaved =
    typeof changes?.value === 'function'
      ? attempt(() => (changes as { value(): unknown }).value())
      : undefined;
  return {
    signedIn: win.is_authenticated === true,
    id: text(attempt(() => api.layoutId?.())),
    name: text(attempt(() => api.layoutName?.())),
    unsaved: typeof unsaved === 'boolean' ? unsaved : null,
  };
}

// The saved layouts of the account, each as a SavedLayoutRow, in the order TradingView gives them,
// from getSavedCharts: one request, the one the layouts menu of the app sends, answered within waitMs
// or TIMEOUT. Signed out it sends nothing and answers AUTH_REQUIRED, as the app sends nothing then.
// A list TradingView cannot give is NOT_AVAILABLE, and a page without getSavedCharts
// CAPABILITY_UNAVAILABLE.
export function readSavedLayouts(
  win: TvWindow,
  waitMs: number,
): Promise<{ layouts: SavedLayoutRow[] } | PageErrorSentinel> | PageErrorSentinel {
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  if (typeof api?.getSavedCharts !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no layout API of TradingView to list the saved layouts with',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  if (win.is_authenticated !== true) {
    return {
      __tvmcpError: {
        code: 'AUTH_REQUIRED',
        message: 'Saved layouts need a signed-in TradingView account',
        hint: 'Sign in to TradingView, then try again.',
      },
    };
  }
  const list = api as { getSavedCharts(): Promise<unknown> };
  const reasonOf = (error: unknown): string => {
    const { message, status } = (typeof error === 'object' && error !== null ? error : {}) as {
      message?: unknown;
      status?: unknown;
    };
    const said =
      typeof message === 'string' && message !== ''
        ? message
        : typeof error === 'string'
          ? error
          : null;
    const answered = typeof status === 'number' ? `status ${String(status)}` : null;
    return said !== null && answered !== null
      ? `${said} (${answered})`
      : (said ?? answered ?? String(error));
  };
  // How the call ended, or late when it did not end within waitMs.
  const settle = (
    call: () => unknown,
  ): Promise<{ value: unknown } | { error: unknown } | { late: true }> => {
    let ended: Promise<{ value: unknown } | { error: unknown }>;
    try {
      ended = Promise.resolve(call()).then(
        (value: unknown) => ({ value }),
        (error: unknown) => ({ error }),
      );
    } catch (error) {
      ended = Promise.resolve({ error });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<{ late: true }>((resolve) => {
      timer = setTimeout(() => {
        resolve({ late: true });
      }, waitMs);
    });
    return Promise.race([ended, late]).then((outcome) => {
      clearTimeout(timer);
      return outcome;
    });
  };
  const hint = 'Try again in a moment, or check app_health.';

  return settle(() => list.getSavedCharts()).then(
    (outcome): { layouts: SavedLayoutRow[] } | PageErrorSentinel => {
      if ('late' in outcome) {
        return {
          __tvmcpError: {
            code: 'TIMEOUT',
            message: `TradingView did not list the saved layouts within ${String(waitMs)} ms`,
            hint: 'TradingView may be slow or offline. Try again in a moment.',
            details: { waitMs },
          },
        };
      }
      if ('error' in outcome) {
        return {
          __tvmcpError: {
            code: 'NOT_AVAILABLE',
            message: `TradingView could not list the saved layouts: ${reasonOf(outcome.error)}`,
            hint,
          },
        };
      }
      const { value } = outcome;
      if (!Array.isArray(value)) {
        return {
          __tvmcpError: {
            code: 'NOT_AVAILABLE',
            message: 'TradingView answered no list of saved layouts',
            hint,
          },
        };
      }
      const blank: SavedLayoutRow = { url: null, name: null, modified: null, overLimit: false };
      const layouts = (value as unknown[]).map((item): SavedLayoutRow => {
        try {
          if (typeof item !== 'object' || item === null) {
            return blank;
          }
          const { url, name, modified_iso, over_limit } = item as {
            url?: unknown;
            name?: unknown;
            modified_iso?: unknown;
            over_limit?: unknown;
          };
          return {
            url: typeof url === 'string' && url !== '' ? url : null,
            name: typeof name === 'string' ? name : null,
            modified:
              typeof modified_iso === 'number' && Number.isFinite(modified_iso)
                ? modified_iso
                : null,
            overLimit: over_limit === true,
          };
        } catch {
          return blank;
        }
      });
      return { layouts };
    },
  );
}

// Loads the saved layout url in place, with loadLayoutFromServerByLayoutId(url, false, true): no new
// tab, and unsaved changes of the layout on the chart discarded without the dialog of the app, which
// confirm must allow. Answers how the load ended within waitMs (LoadOutcome). The loader resolves
// without loading anything for a url TradingView does not list, so the caller checks the id first and
// then that the layout on the chart became url. Before anything is loaded, a page without the loader
// is CAPABILITY_UNAVAILABLE, a signed-out account AUTH_REQUIRED and an id that is no text
// INVALID_INPUT; and without confirm, a layout on the chart that has unsaved changes, or whose changes
// TradingView does not tell, is CONFIRMATION_REQUIRED (details.unsavedChanges true or null). The
// changes are read in the same turn as the load, since the user may change the chart while the caller
// waits for its requests.
export function loadLayoutInPlace(
  win: TvWindow,
  url: string,
  waitMs: number,
  confirm: boolean,
): Promise<LoadOutcome | PageErrorSentinel> | PageErrorSentinel {
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  if (typeof api?.loadLayoutFromServerByLayoutId !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no layout API of TradingView to open a saved layout with',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  if (win.is_authenticated !== true) {
    return {
      __tvmcpError: {
        code: 'AUTH_REQUIRED',
        message: 'Saved layouts need a signed-in TradingView account',
        hint: 'Sign in to TradingView, then try again.',
      },
    };
  }
  if (typeof url !== 'string' || url === '') {
    return {
      __tvmcpError: {
        code: 'INVALID_INPUT',
        message: 'No layout id was given to open',
        hint: 'Give the id of a saved layout from layout_list.',
      },
    };
  }
  const loader = api as {
    loadLayoutFromServerByLayoutId(
      url: string,
      openInNewTab: boolean,
      skipConfirm: boolean,
    ): unknown;
  };
  const reasonOf = (error: unknown): string => {
    const { message, status } = (typeof error === 'object' && error !== null ? error : {}) as {
      message?: unknown;
      status?: unknown;
    };
    const said =
      typeof message === 'string' && message !== ''
        ? message
        : typeof error === 'string'
          ? error
          : null;
    const answered = typeof status === 'number' ? `status ${String(status)}` : null;
    return said !== null && answered !== null
      ? `${said} (${answered})`
      : (said ?? answered ?? String(error));
  };
  const settle = (
    call: () => unknown,
  ): Promise<{ value: unknown } | { error: unknown } | { late: true }> => {
    let ended: Promise<{ value: unknown } | { error: unknown }>;
    try {
      ended = Promise.resolve(call()).then(
        (value: unknown) => ({ value }),
        (error: unknown) => ({ error }),
      );
    } catch (error) {
      ended = Promise.resolve({ error });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<{ late: true }>((resolve) => {
      timer = setTimeout(() => {
        resolve({ late: true });
      }, waitMs);
    });
    return Promise.race([ended, late]).then((outcome) => {
      clearTimeout(timer);
      return outcome;
    });
  };

  // A read-only watched value, whose value() is read as a method of it; null when it does not tell.
  let changes: unknown;
  try {
    const watched = api.hasChartChanges?.() as { value?: unknown } | null | undefined;
    changes =
      typeof watched?.value === 'function' ? (watched as { value(): unknown }).value() : undefined;
  } catch {
    changes = undefined;
  }
  const unsaved = typeof changes === 'boolean' ? changes : null;
  if (unsaved !== false && !confirm) {
    return {
      __tvmcpError: {
        code: 'CONFIRMATION_REQUIRED',
        message:
          unsaved === true
            ? 'The layout on the chart has unsaved changes, which loading the layout would discard'
            : 'TradingView does not tell whether the layout on the chart has unsaved changes, ' +
              'which loading the layout would discard',
        hint:
          'Nothing was loaded. Save the layout in TradingView first, or call again with ' +
          'confirm: true if the user wants the changes discarded.',
        details: { unsavedChanges: unsaved },
      },
    };
  }

  return settle(() => loader.loadLayoutFromServerByLayoutId(url, false, true)).then(
    (outcome): LoadOutcome =>
      'late' in outcome
        ? { ended: 'late', reason: null }
        : 'error' in outcome
          ? { ended: 'failed', reason: reasonOf(outcome.error) }
          : { ended: 'loaded', reason: null },
  );
}

// Whether the active chart has its data within waitMs, as dataReady() of the chart tells it (the form
// without an argument, a promise that resolves with true once the main series has data). A chart
// that cannot be reached, a dataReady that is missing, throws, rejects or answers anything but true,
// and a promise that does not settle in time (it never does for a symbol TradingView cannot resolve)
// all count as not ready. It changes nothing.
export function awaitChartData(win: TvWindow, waitMs: number): Promise<{ ready: boolean }> {
  let chart: Partial<ChartWidgetApiLike> | null | undefined;
  try {
    chart = win.TradingViewApi?.activeChart();
  } catch {
    chart = undefined;
  }
  let waiting: Promise<boolean>;
  try {
    waiting =
      typeof chart?.dataReady === 'function'
        ? Promise.resolve((chart as { dataReady(): unknown }).dataReady()).then(
            (answer: unknown) => answer === true,
            () => false,
          )
        : Promise.resolve(false);
  } catch {
    waiting = Promise.resolve(false);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, waitMs);
  });
  return Promise.race([waiting, late]).then((ready) => {
    clearTimeout(timer);
    return { ready };
  });
}

// What the check the Create new layout dialog of the app runs before it opens answers
// (hasPermissionsToCreateNewChart, found by the name of its export; it may ask the layouts server for
// the count of saved layouts, as that dialog does): allowed true or false, or null on a build without
// it. An answer that is no boolean, and a check that throws or rejects, come back as failed with why;
// one that does not answer within waitMs is TIMEOUT. It changes nothing.
export function checkLayoutPermission(
  _win: TvWindow,
  lib: PageLib,
  waitMs: number,
): Promise<{ allowed: boolean | null } | { failed: string } | PageErrorSentinel> {
  const check = lib.findExport('hasPermissionsToCreateNewChart');
  if (typeof check !== 'function') {
    return Promise.resolve({ allowed: null });
  }
  const reasonOf = (error: unknown): string => {
    const { message, status } = (typeof error === 'object' && error !== null ? error : {}) as {
      message?: unknown;
      status?: unknown;
    };
    const said =
      typeof message === 'string' && message !== ''
        ? message
        : typeof error === 'string'
          ? error
          : null;
    const answered = typeof status === 'number' ? `status ${String(status)}` : null;
    return said !== null && answered !== null
      ? `${said} (${answered})`
      : (said ?? answered ?? String(error));
  };
  const settle = (
    call: () => unknown,
  ): Promise<{ value: unknown } | { error: unknown } | { late: true }> => {
    let ended: Promise<{ value: unknown } | { error: unknown }>;
    try {
      ended = Promise.resolve(call()).then(
        (value: unknown) => ({ value }),
        (error: unknown) => ({ error }),
      );
    } catch (error) {
      ended = Promise.resolve({ error });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<{ late: true }>((resolve) => {
      timer = setTimeout(() => {
        resolve({ late: true });
      }, waitMs);
    });
    return Promise.race([ended, late]).then((outcome) => {
      clearTimeout(timer);
      return outcome;
    });
  };

  return settle(() => (check as HasPermissionsToCreateNewChartLike)()).then(
    (outcome): { allowed: boolean } | { failed: string } | PageErrorSentinel => {
      if ('late' in outcome) {
        return {
          __tvmcpError: {
            code: 'TIMEOUT',
            message: `TradingView did not tell within ${String(waitMs)} ms whether the account may save another layout`,
            hint: 'Nothing was created. Try again in a moment.',
            details: { waitMs },
          },
        };
      }
      if ('error' in outcome) {
        return { failed: reasonOf(outcome.error) };
      }
      return typeof outcome.value === 'boolean'
        ? { allowed: outcome.value }
        : { failed: 'TradingView answered neither yes nor no' };
    },
  );
}

// Saves a new layout named name with the export createNewChart, as the Create new layout dialog of
// the app does, with the options that dialog passes: the name, and the symbol (pro_name), the ticker
// (name), the symbol type, the exchange and the interval of the main series of the active chart, each
// left out when it cannot be read, for TradingView to fill in. It leaves the page alone. Answers the
// URL of the new layout as TradingView gives it, or null when it gives none: TradingView did not
// create the layout then, and has opened a dialog of its own that says why. A creation that fails
// otherwise is NOT_AVAILABLE, and one that does not answer within waitMs TIMEOUT, both saying the
// layout may exist all the same. Before anything is sent, a build without createNewChart is
// NOT_AVAILABLE, a signed-out account (for which TradingView would open its sign-in paywall)
// AUTH_REQUIRED and a blank name INVALID_INPUT.
export function createLayoutViaApi(
  win: TvWindow,
  lib: PageLib,
  name: string,
  waitMs: number,
): Promise<{ url: string | null } | PageErrorSentinel> | PageErrorSentinel {
  // Looked up first, before anything is asked.
  const create = lib.findExport('createNewChart');
  if (typeof create !== 'function') {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message:
          'This TradingView build has no createNewChart, which saves a new layout the way the ' +
          'Create new layout dialog of TradingView does, so nothing was created',
        hint: 'Create the layout in TradingView itself.',
      },
    };
  }
  if (win.is_authenticated !== true) {
    return {
      __tvmcpError: {
        code: 'AUTH_REQUIRED',
        message: 'Saved layouts need a signed-in TradingView account',
        hint: 'Sign in to TradingView, then try again.',
      },
    };
  }
  if (typeof name !== 'string' || name.trim() === '') {
    return {
      __tvmcpError: {
        code: 'INVALID_INPUT',
        message: 'The layout name is blank',
        hint: 'Give the layout a name.',
      },
    };
  }
  const attempt = (read: () => unknown): unknown => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const series = attempt(() =>
    win.TradingViewApi?.activeChart()._chartWidget?.model().mainSeries(),
  ) as Partial<SeriesLike> | undefined;
  const info = attempt(() => series?.symbolInfo?.()) as Record<string, unknown> | null | undefined;
  const textOf = (read: () => unknown): string | undefined => {
    const value = attempt(read);
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  const symbol = textOf(() => info?.pro_name);
  const shortName = textOf(() => info?.name);
  const symbolType = textOf(() => info?.type);
  const exchange = textOf(() => info?.exchange);
  const interval = textOf(() => series?.interval?.());
  const options: NewChartOptionsLike = {
    name,
    ...(symbol === undefined ? {} : { symbol }),
    ...(shortName === undefined ? {} : { short_name: shortName }),
    ...(symbolType === undefined ? {} : { symbol_type: symbolType }),
    ...(exchange === undefined ? {} : { exchange }),
    ...(interval === undefined ? {} : { interval }),
  };
  const reasonOf = (error: unknown): string => {
    const { message, status } = (typeof error === 'object' && error !== null ? error : {}) as {
      message?: unknown;
      status?: unknown;
    };
    const said =
      typeof message === 'string' && message !== ''
        ? message
        : typeof error === 'string'
          ? error
          : null;
    const answered = typeof status === 'number' ? `status ${String(status)}` : null;
    return said !== null && answered !== null
      ? `${said} (${answered})`
      : (said ?? answered ?? String(error));
  };
  const settle = (
    call: () => unknown,
  ): Promise<{ value: unknown } | { error: unknown } | { late: true }> => {
    let ended: Promise<{ value: unknown } | { error: unknown }>;
    try {
      ended = Promise.resolve(call()).then(
        (value: unknown) => ({ value }),
        (error: unknown) => ({ error }),
      );
    } catch (error) {
      ended = Promise.resolve({ error });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<{ late: true }>((resolve) => {
      timer = setTimeout(() => {
        resolve({ late: true });
      }, waitMs);
    });
    return Promise.race([ended, late]).then((outcome) => {
      clearTimeout(timer);
      return outcome;
    });
  };
  const mayExist =
    'The layout may be created all the same: check layout_list before trying again, so as not ' +
    'to create it twice.';

  return settle(() => (create as CreateNewChartLike)(options)).then(
    (outcome): { url: string | null } | PageErrorSentinel => {
      if ('late' in outcome) {
        return {
          __tvmcpError: {
            code: 'TIMEOUT',
            message: `TradingView did not answer the creation of the layout within ${String(waitMs)} ms`,
            hint: mayExist,
            details: { waitMs },
          },
        };
      }
      if ('error' in outcome) {
        return {
          __tvmcpError: {
            code: 'NOT_AVAILABLE',
            message: `TradingView failed while it created the layout: ${reasonOf(outcome.error)}`,
            hint: mayExist,
          },
        };
      }
      const { value } = outcome;
      return { url: typeof value === 'string' && value !== '' ? value : null };
    },
  );
}
