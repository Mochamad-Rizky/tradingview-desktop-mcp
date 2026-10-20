import type { PageErrorSentinel } from '../../core/tv/page-bridge.js';
import type { PageLib } from '../../core/tv/page-lib.js';
import type {
  ChartModelLike,
  ChartWidgetApiLike,
  PlotItemLike,
  PlotListLike,
  StandardScriptLike,
  StudyApiLike,
  StudyCoreLike,
  StudyInputInfoLike,
  StudyMetaInfoLike,
  StudyMetaInfoRepositoryLike,
  TradingViewApiLike,
  TvWindow,
} from '../../core/tv/tv-window.js';

// The page functions of the indicator tools. The page bridge sends the source text of each one into
// the page, so each uses nothing of this file, only its parameters and the globals of the page, and
// whatever it shares with another is written out in both. Types are erased, so the type imports
// above are fine.
//
// A chartIndex of null means the active chart; any other value has been checked against the layout
// by the caller. Members of the app are read defensively: another web build can drop or reshape any
// of them, and a read that throws counts as no answer. The readers change nothing. Only
// readStudyCatalog and readStudyInsertContext send requests: the list of standard Pine scripts,
// which the app asks for the same way, and the study metadata when the repository of the app does
// not hold it yet. The functions at the end change the chart (insertStudy, editStudyInputs with
// values, setStudyVisibility and removeStudy with confirmed); each says CAPABILITY_UNAVAILABLE only
// before it acts.

// The studies of a chart: each with its title, visibility, kind and the inputs the user sees (the
// hidden internals of Pine left out), the value of each joined by input id. A value that is not
// text, a finite number or a boolean is null, and options are kept when they are a list of text.
// isPine is whether the metadata has pine; isStrategy is the flag of the strategy class or, without
// it, the members the app tests strategies by. A study whose API cannot be had is reported by its
// name with defaults, and its id listed in unreadable.
export function readStudies(
  win: TvWindow,
  chartIndex: number | null,
):
  | {
      studies: {
        id: string;
        name: string;
        title: string;
        visible: boolean;
        isPine: boolean;
        isStrategy: boolean;
        inputs: {
          id: string;
          name: string;
          type: string;
          value: string | number | boolean | null;
          options: string[] | null;
        }[];
      }[];
      unreadable: string[];
    }
  | PageErrorSentinel {
  const attempt = (read: () => unknown): unknown => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  const chart = attempt(() =>
    chartIndex === null ? api?.activeChart?.() : api?.chart?.(chartIndex),
  ) as Partial<ChartWidgetApiLike> | null | undefined;
  if (typeof chart?.getAllStudies !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no chart API to read the studies from',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  const listed = attempt(() => chart.getAllStudies?.());
  const entries: unknown[] = Array.isArray(listed) ? listed : [];
  const unreadable: string[] = [];
  const studies = entries.map((entry) => {
    const { id: rawId, name: rawName } = (entry ?? {}) as { id?: unknown; name?: unknown };
    const id = text(rawId) ?? (typeof rawId === 'number' ? String(rawId) : '');
    const name = text(rawName) ?? id;
    const study = attempt(() => chart.getStudyById?.(id)) as
      Partial<StudyApiLike> | null | undefined;
    if (study === undefined || study === null) {
      unreadable.push(id);
      return {
        id,
        name,
        title: name,
        visible: true,
        isPine: false,
        isStrategy: false,
        inputs: [],
      };
    }
    const core = attempt(() => study.study?.()) as Partial<StudyCoreLike> | null | undefined;
    const meta = attempt(() => core?.metaInfo?.()) as StudyMetaInfoLike | null | undefined;
    const isStrategy =
      typeof core === 'object' &&
      core !== null &&
      (core.isStudyStrategy === true ||
        ['strategyOrdersPaneView', 'ordersData', 'reportData'].every((key) => key in core));

    const infos = attempt(() => study.getInputsInfo?.());
    const values = attempt(() => study.getInputValues?.());
    const valueById = new Map<string, unknown>();
    for (const item of Array.isArray(values) ? (values as unknown[]) : []) {
      const { id: inputId, value } = (item ?? {}) as { id?: unknown; value?: unknown };
      if (typeof inputId === 'string') {
        valueById.set(inputId, value);
      }
    }
    const inputs = (Array.isArray(infos) ? (infos as unknown[]) : []).flatMap((raw) => {
      const info = (raw ?? {}) as Partial<StudyInputInfoLike>;
      if (typeof info.id !== 'string' || info.isHidden === true) {
        return [];
      }
      const value = valueById.get(info.id);
      const options: unknown = info.options;
      return [
        {
          id: info.id,
          name: text(info.name) ?? text(info.localizedName) ?? info.id,
          type: text(info.type) ?? '',
          value:
            typeof value === 'string' ||
            typeof value === 'boolean' ||
            (typeof value === 'number' && Number.isFinite(value))
              ? value
              : null,
          options:
            Array.isArray(options) && options.every((option) => typeof option === 'string')
              ? options.map((option: unknown) => String(option))
              : null,
        },
      ];
    });
    return {
      id,
      name,
      title: text(attempt(() => study.title?.())) ?? name,
      visible: attempt(() => study.isVisible?.()) === true,
      isPine: meta?.pine !== undefined,
      isStrategy,
      inputs,
    };
  });
  return { studies, unreadable };
}

// The rows of a study and what keys its plots: the plots of its metadata (id, type and the target
// of a colorer or ohlc_* plot), the plot titles of its styles and the bar titles of its ohlcPlots,
// and at most `count` rows, oldest first, ending at the last row or, with `at`, at the row of the
// last bar at or before that time (in the time base of the bar rows; none when only pre-history
// lies before it). A row is [time, ...one value per plot], a value that is not a finite number (NaN
// or undefined for a value not computed) copied as null; a row without a time is passed over.
// Pre-history rows, at -1e6 and below, are never read. An id that is not a study of the chart is
// INVALID_INPUT.
export function readStudyValues(
  win: TvWindow,
  chartIndex: number | null,
  id: string,
  count: number,
  at: number | null,
):
  | {
      plots: { id: string; type: string; target: string | null }[];
      styles: Record<string, { title: string }>;
      ohlcPlots: Record<string, { title: string }>;
      rows: (number | null)[][];
    }
  | PageErrorSentinel {
  const attempt = (read: () => unknown): unknown => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const number = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  const chart = attempt(() =>
    chartIndex === null ? api?.activeChart?.() : api?.chart?.(chartIndex),
  ) as Partial<ChartWidgetApiLike> | null | undefined;
  if (typeof chart?.getAllStudies !== 'function' || typeof chart.getStudyById !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no chart API to read the studies from',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  const listed = attempt(() => chart.getAllStudies?.());
  const known =
    Array.isArray(listed) &&
    (listed as unknown[]).some((entry) => (entry as { id?: unknown } | null)?.id === id);
  const study = known
    ? (attempt(() => chart.getStudyById?.(id)) as Partial<StudyApiLike> | null | undefined)
    : undefined;
  if (study === undefined || study === null) {
    return {
      __tvmcpError: {
        code: 'INVALID_INPUT',
        message: `The chart has no study with the id ${id}`,
        hint: 'Call indicator_list for the ids of the studies on the chart.',
        details: { id },
      },
    };
  }
  const core = attempt(() => study.study?.()) as Partial<StudyCoreLike> | null | undefined;
  const data = attempt(() => core?.data?.()) as Partial<PlotListLike> | null | undefined;
  if (
    typeof data?.firstPlottableIndex !== 'function' ||
    typeof data.lastIndex !== 'function' ||
    typeof data.search !== 'function' ||
    typeof data.rangeIterator !== 'function'
  ) {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: `The rows of the study ${id} cannot be read on this page`,
        hint: 'This TradingView build keeps study values in another shape. Check app_health.',
        details: { id },
      },
    };
  }
  // Checked above: the members called without a guard are there.
  const list = data as PlotListLike;

  const meta = (attempt(() => core?.metaInfo?.()) ?? {}) as StudyMetaInfoLike;
  const rawPlots: unknown = meta.plots;
  const plots = (Array.isArray(rawPlots) ? (rawPlots as unknown[]) : []).map((raw) => {
    const plot = (raw ?? {}) as { id?: unknown; type?: unknown; target?: unknown };
    return {
      id:
        typeof plot.id === 'string' ? plot.id : typeof plot.id === 'number' ? String(plot.id) : '',
      type: typeof plot.type === 'string' ? plot.type : '',
      target: typeof plot.target === 'string' ? plot.target : null,
    };
  });
  const titles = (source: unknown): Record<string, { title: string }> => {
    const found: Record<string, { title: string }> = {};
    if (typeof source === 'object' && source !== null) {
      for (const [key, entry] of Object.entries(source)) {
        const title: unknown = (entry as { title?: unknown } | null)?.title;
        if (typeof title === 'string') {
          found[key] = { title };
        }
      }
    }
    return found;
  };

  // The plottable rows lie at the indices of the bars, so the last `count` of them start `count - 1`
  // indices before the last one.
  const first = number(list.firstPlottableIndex());
  const last = number(list.lastIndex());
  const timeOf = (item: PlotItemLike | null): number | null =>
    Array.isArray(item?.value) ? number(item.value[0]) : null;
  let end: number | null = first === null || last === null ? null : last;
  if (at !== null && first !== null && last !== null) {
    // The last row whose time is at or before `at`, by halving the indices.
    end = null;
    let low = first;
    let high = last;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const item = list.search(middle, -1);
      const time = timeOf(item);
      if (item !== null && time !== null && time <= at) {
        end = item.index;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
  }
  const rows: (number | null)[][] = [];
  if (first !== null && end !== null) {
    for (const item of list.rangeIterator(Math.max(first, end - count + 1), end)) {
      const time = timeOf(item);
      if (time === null || item.index <= -1_000_000) {
        continue;
      }
      const values = item.value;
      rows.push([time, ...plots.map((_plot, slot) => number(values[slot + 1]))]);
    }
  }
  return {
    plots,
    styles: titles(meta.styles),
    ohlcPlots: titles(meta.ohlcPlots),
    rows: rows.slice(-count),
  };
}

// What the app knows of the indicators it can add, from two sources. scripts are the standard Pine
// scripts, from requestBuiltinScripts, the list the app asks the pine facade for (libraries left
// out); null when there is no such list, with the reason in scriptsError. builtins are the visible
// built-in studies of the study repository, read from its cache once it is ready and else from
// findAllJavaStudies, which requests the metadata once; null when the page has no repository or
// it fails. CAPABILITY_UNAVAILABLE only when the page has neither source.
export function readStudyCatalog(
  _win: TvWindow,
  lib: PageLib,
):
  | Promise<
      | {
          // A standard Pine script: the scriptIdPart as id, the name, the short name
          // (scriptTitle, else extra.shortDescription, else the name), the script version (the
          // pineVersion of a Pine study descriptor; null when the list gives none) and whether it
          // is a strategy.
          scripts:
            | {
                id: string;
                name: string;
                shortName: string;
                version: string | null;
                isStrategy: boolean;
              }[]
            | null;
          scriptsError: string | null;
          // A visible built-in study: the id of its metadata (<Name>@<package>), its description
          // as the name and its short description as the short name.
          builtins: { id: string; name: string; shortName: string; isStrategy: boolean }[] | null;
        }
      | PageErrorSentinel
    >
  | PageErrorSentinel {
  // Looked up first, both of them, before anything is asked.
  const getRepository = lib.findExport('studyMetaInfoRepository');
  const requestScripts = lib.findExport('requestBuiltinScripts');
  if (typeof getRepository !== 'function' && typeof requestScripts !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has neither the study repository nor the list of standard scripts',
        hint: 'Check app_health: the app may still be loading, or the tab does not show a chart.',
      },
    };
  }
  const text = (value: unknown): string | null =>
    typeof value === 'string' && value !== '' ? value : null;
  const reason = (error: unknown): string => {
    const message: unknown = (error as { message?: unknown } | null | undefined)?.message;
    return typeof message === 'string' ? message : String(error);
  };

  const builtins = Promise.resolve()
    .then((): unknown => {
      if (typeof getRepository !== 'function') {
        return null;
      }
      const repository = (getRepository as () => unknown)() as Partial<StudyMetaInfoRepositoryLike>;
      return repository.isReady?.() === true &&
        typeof repository.getInternalMetaInfoArray === 'function'
        ? repository.getInternalMetaInfoArray()
        : repository.findAllJavaStudies?.();
    })
    .then((items: unknown) => {
      if (items === null) {
        return null;
      }
      return (Array.isArray(items) ? (items as unknown[]) : []).flatMap((raw) => {
        const item = (raw ?? {}) as StudyMetaInfoLike;
        const id = text(item.id);
        if (id === null || item.is_hidden_study === true) {
          return [];
        }
        const name = text(item.description) ?? id;
        return [
          {
            id,
            name,
            shortName: text(item.shortDescription) ?? name,
            isStrategy: item.extra?.kind === 'strategy' || item.isTVScriptStrategy === true,
          },
        ];
      });
    })
    .catch((): null => null);

  // The scripts, or why there are none.
  const scripts = Promise.resolve()
    .then((): unknown =>
      typeof requestScripts === 'function' ? (requestScripts as () => unknown)() : undefined,
    )
    .then((list: unknown) => {
      if (typeof requestScripts !== 'function') {
        return 'This TradingView build has no list of standard scripts to read';
      }
      if (!Array.isArray(list)) {
        return 'TradingView answered with no list of scripts';
      }
      return (list as unknown[]).flatMap((raw) => {
        const item = (typeof raw === 'object' && raw !== null ? raw : {}) as StandardScriptLike;
        const id = text(item.scriptIdPart);
        const kind = text(item.extra?.kind) ?? 'study';
        if (id === null || kind === 'library') {
          return [];
        }
        const name = text(item.scriptName) ?? id;
        return [
          {
            id,
            name,
            // The app lists the short name in extra (shortDescription, such as RSI), and no title.
            shortName: text(item.scriptTitle) ?? text(item.extra?.shortDescription) ?? name,
            version: text(item.version),
            isStrategy: kind === 'strategy',
          },
        ];
      });
    })
    .catch(reason);

  return Promise.all([scripts, builtins]).then(([found, studies]) => ({
    scripts: typeof found === 'string' ? null : found,
    scriptsError: typeof found === 'string' ? found : null,
    builtins: studies,
  }));
}

// What the server needs to know before it adds a study, read without changing anything: the chart
// it lands on (chartIndex, the active chart when the caller named none, null when unknown), how many
// studies the chart holds (null when the list cannot be read), what the model's canCreateStudy says
// for studyId (the id of the metadata of a built-in, empty for Pine, as the app asks it; null when
// the model has no such check or it throws), and for a built-in what its metadata says: its
// description, whether that description finds this study first among all built-ins (hidden ones
// included), as a name passed to createStudy does, its inputs with their defaults (the hidden ones
// left out) and whether any input asks for confirmation. builtin is null for Pine and for an id the
// repository does not hold. The repository is read from its cache once it is ready, else through
// findAllJavaStudies, which requests the metadata once.
export function readStudyInsertContext(
  win: TvWindow,
  lib: PageLib,
  chartIndex: number | null,
  studyId: string,
):
  | Promise<{
      chartIndex: number | null;
      count: number | null;
      check: { success: boolean; reason: string | null; limitValue: number | null } | null;
      builtin: {
        description: string;
        firstMatch: boolean;
        confirm: boolean;
        inputs: {
          id: string;
          name: string;
          type: string;
          value: string | number | boolean | null;
          options: (string | number)[] | null;
          min: number | null;
          max: number | null;
        }[];
      } | null;
    }>
  | PageErrorSentinel {
  const attempt = (read: () => unknown): unknown => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const text = (value: unknown): string | null =>
    typeof value === 'string' && value !== '' ? value : null;
  const number = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  const chart = attempt(() =>
    chartIndex === null ? api?.activeChart?.() : api?.chart?.(chartIndex),
  ) as Partial<ChartWidgetApiLike> | null | undefined;
  if (typeof chart?.createStudy !== 'function' || typeof chart.getAllStudies !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no chart API to add indicators with',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  const listed = attempt(() => chart.getAllStudies?.());
  const model = attempt(() => chart._chartWidget?.model()) as
    Partial<ChartModelLike> | null | undefined;
  const answer = (
    typeof model?.canCreateStudy === 'function'
      ? attempt(() => model.canCreateStudy?.({ id: studyId }))
      : undefined
  ) as { success?: unknown; reason?: unknown; limitValue?: unknown } | null | undefined;
  const found = {
    chartIndex: chartIndex ?? number(attempt(() => api?.activeChartIndex?.())),
    count: Array.isArray(listed) ? listed.length : null,
    check:
      typeof answer?.success === 'boolean'
        ? {
            success: answer.success,
            reason: text(answer.reason),
            limitValue: number(answer.limitValue),
          }
        : null,
  };
  const getRepository = studyId === '' ? null : lib.findExport('studyMetaInfoRepository');
  return Promise.resolve()
    .then((): unknown => {
      if (typeof getRepository !== 'function') {
        return null;
      }
      const repository = (getRepository as () => unknown)() as Partial<StudyMetaInfoRepositoryLike>;
      return repository.isReady?.() === true &&
        typeof repository.getInternalMetaInfoArray === 'function'
        ? repository.getInternalMetaInfoArray()
        : repository.findAllJavaStudies?.();
    })
    .then((items: unknown) => {
      const all: unknown[] = Array.isArray(items) ? items : [];
      const item = all.find((raw) => (raw as { id?: unknown } | null)?.id === studyId) as
        StudyMetaInfoLike | undefined;
      const description = text(item?.description);
      if (item === undefined || description === null) {
        return null;
      }
      const wanted = description.toLowerCase();
      const first = all.find((raw) => {
        const other: unknown = (raw as { description?: unknown } | null)?.description;
        return typeof other === 'string' && other.toLowerCase() === wanted;
      });
      const rawInputs: unknown[] = Array.isArray(item.inputs) ? item.inputs : [];
      const inputs = rawInputs.flatMap((raw) => {
        const info = (raw ?? {}) as Partial<StudyInputInfoLike>;
        if (typeof info.id !== 'string' || info.isHidden === true) {
          return [];
        }
        const value: unknown = info.defval;
        const options: unknown = info.options;
        return [
          {
            id: info.id,
            name: text(info.name) ?? text(info.localizedName) ?? info.id,
            type: text(info.type) ?? '',
            value:
              typeof value === 'string' || typeof value === 'boolean' || number(value) !== null
                ? (value as string | number | boolean)
                : null,
            options:
              Array.isArray(options) &&
              options.every((option) => typeof option === 'string' || number(option) !== null)
                ? options.map((option: unknown) => option as string | number)
                : null,
            min: number(info.min),
            max: number(info.max),
          },
        ];
      });
      return {
        description,
        firstMatch: first === item,
        confirm: rawInputs.some((raw) => (raw as { confirm?: unknown } | null)?.confirm === true),
        inputs,
      };
    })
    .catch((): null => null)
    .then((builtin) => ({ ...found, builtin }));
}

// Adds a study with createStudy and answers its id. how says which way: by the description of a
// built-in, the one way that takes overlay and the limit check of the app (checkLimit is always
// on), or by a descriptor of a built-in (java) or a standard Pine script (pine), which the app
// checks with canCreateStudy itself. The caller has checked the limit and refused studies that
// need an input dialog first, because on a failed check the app opens a dialog of its own. Waits
// at most waitMs for the app (TIMEOUT); a null answer and a rejection are NOT_AVAILABLE with the
// reason TradingView gave, and any other answer PAGE_EVALUATION_FAILED.
export function insertStudy(
  win: TvWindow,
  chartIndex: number | null,
  how:
    | { kind: 'description'; description: string }
    | { kind: 'java'; studyId: string }
    | { kind: 'pine'; pineId: string; pineVersion: string },
  overlay: boolean,
  waitMs: number,
): Promise<{ id: string } | PageErrorSentinel> | PageErrorSentinel {
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  let found: Partial<ChartWidgetApiLike> | null | undefined;
  try {
    found = chartIndex === null ? api?.activeChart?.() : api?.chart?.(chartIndex);
  } catch {
    found = undefined;
  }
  if (typeof found?.createStudy !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no chart API to add indicators with',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  // Checked above: the member called without a guard is there.
  const chart = found as ChartWidgetApiLike;
  // How createStudy ended, whether it threw at once or rejected later.
  let added: Promise<{ value: unknown } | { error: unknown }>;
  try {
    added = Promise.resolve(
      how.kind === 'description'
        ? chart.createStudy(how.description, overlay, false, undefined, undefined, {
            checkLimit: true,
          })
        : chart.createStudy(
            how.kind === 'java'
              ? { type: 'java', studyId: how.studyId }
              : { type: 'pine', pineId: how.pineId, pineVersion: how.pineVersion },
          ),
    ).then(
      (value: unknown) => ({ value }),
      (error: unknown) => ({ error }),
    );
  } catch (error) {
    added = Promise.resolve({ error });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ late: true }>((resolve) => {
    timer = setTimeout(() => {
      resolve({ late: true });
    }, waitMs);
  });
  return Promise.race([added, late]).then((outcome): { id: string } | PageErrorSentinel => {
    clearTimeout(timer);
    if ('late' in outcome) {
      return {
        __tvmcpError: {
          code: 'TIMEOUT',
          message: `TradingView did not add the indicator within ${String(waitMs)} ms`,
          hint:
            'It may still appear on the chart: check indicator_list. If TradingView shows a ' +
            'dialog, answer or close it there.',
          details: { waitMs },
        },
      };
    }
    if ('error' in outcome) {
      // The app rejects with a string insertion code (cannot_compile_pub, cancelled, ...) or an
      // Error.
      const { error } = outcome;
      const message: unknown = (error as { message?: unknown } | null | undefined)?.message;
      const reason =
        typeof error === 'string' ? error : typeof message === 'string' ? message : String(error);
      return {
        __tvmcpError: {
          code: 'NOT_AVAILABLE',
          message: `TradingView did not add the indicator: ${reason}`,
          hint: 'Check indicator_list, and that the indicator can be added to this chart in TradingView.',
          details: { reason },
        },
      };
    }
    const { value } = outcome;
    if (typeof value === 'string' && value !== '') {
      return { id: value };
    }
    if (value === null) {
      return {
        __tvmcpError: {
          code: 'NOT_AVAILABLE',
          message:
            'TradingView added no indicator: createStudy answered null, as it does when the chart ' +
            'holds as many indicators as the plan allows',
          hint: 'Call indicator_list to see the indicators on the chart, and app_get_plan_limits.',
          details: { reason: null },
        },
      };
    }
    return {
      __tvmcpError: {
        code: 'PAGE_EVALUATION_FAILED',
        message: 'TradingView answered createStudy with something that is not a study id',
      },
    };
  });
}

// The inputs of a study as the tools that change them check them: the inputs the user sees (the
// hidden internals of Pine left out), each with its type, value, options (text or numbers, else
// null) and the bounds of its metadata (null when it has none). With values, they are set first
// with setInputValues and the inputs are read afterwards; without (null), nothing changes. An id that
// is not a study of the chart is INVALID_INPUT.
export function editStudyInputs(
  win: TvWindow,
  chartIndex: number | null,
  id: string,
  values: { id: string; value: string | number | boolean }[] | null,
):
  | {
      inputs: {
        id: string;
        name: string;
        type: string;
        value: string | number | boolean | null;
        options: (string | number)[] | null;
        min: number | null;
        max: number | null;
      }[];
    }
  | PageErrorSentinel {
  const attempt = (read: () => unknown): unknown => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  const number = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  const chart = attempt(() =>
    chartIndex === null ? api?.activeChart?.() : api?.chart?.(chartIndex),
  ) as Partial<ChartWidgetApiLike> | null | undefined;
  if (typeof chart?.getAllStudies !== 'function' || typeof chart.getStudyById !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no chart API to reach the studies with',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  const listed = attempt(() => chart.getAllStudies?.());
  const known =
    Array.isArray(listed) &&
    (listed as unknown[]).some((entry) => (entry as { id?: unknown } | null)?.id === id);
  const study = known
    ? (attempt(() => chart.getStudyById?.(id)) as Partial<StudyApiLike> | null | undefined)
    : undefined;
  if (study === undefined || study === null) {
    return {
      __tvmcpError: {
        code: 'INVALID_INPUT',
        message: `The chart has no study with the id ${id}`,
        hint: 'Call indicator_list for the ids of the studies on the chart.',
        details: { id },
      },
    };
  }
  if (
    typeof study.getInputsInfo !== 'function' ||
    (values !== null && typeof study.setInputValues !== 'function')
  ) {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: `The inputs of the study ${id} cannot be ${values === null ? 'read' : 'set'} on this page`,
        hint: 'This TradingView build reaches study inputs another way. Check app_health.',
        details: { id },
      },
    };
  }
  if (values !== null) {
    study.setInputValues?.(values);
  }
  const infos = attempt(() => study.getInputsInfo?.());
  const current = attempt(() => study.getInputValues?.());
  const valueById = new Map<string, unknown>();
  for (const item of Array.isArray(current) ? (current as unknown[]) : []) {
    const { id: inputId, value } = (item ?? {}) as { id?: unknown; value?: unknown };
    if (typeof inputId === 'string') {
      valueById.set(inputId, value);
    }
  }
  const inputs = (Array.isArray(infos) ? (infos as unknown[]) : []).flatMap((raw) => {
    const info = (raw ?? {}) as Partial<StudyInputInfoLike>;
    if (typeof info.id !== 'string' || info.isHidden === true) {
      return [];
    }
    const value = valueById.get(info.id);
    const options: unknown = info.options;
    return [
      {
        id: info.id,
        name: text(info.name) ?? text(info.localizedName) ?? info.id,
        type: text(info.type) ?? '',
        value:
          typeof value === 'string' || typeof value === 'boolean' || number(value) !== null
            ? (value as string | number | boolean)
            : null,
        options:
          Array.isArray(options) &&
          options.every((option) => typeof option === 'string' || number(option) !== null)
            ? options.map((option: unknown) => option as string | number)
            : null,
        min: number(info.min),
        max: number(info.max),
      },
    ];
  });
  return { inputs };
}

// Shows or hides a study with setVisible, and answers whether it was visible before and is after,
// as isVisible reports. An id that is not a study of the chart is INVALID_INPUT.
export function setStudyVisibility(
  win: TvWindow,
  chartIndex: number | null,
  id: string,
  visible: boolean,
): { previous: boolean; visible: boolean } | PageErrorSentinel {
  const attempt = (read: () => unknown): unknown => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  const chart = attempt(() =>
    chartIndex === null ? api?.activeChart?.() : api?.chart?.(chartIndex),
  ) as Partial<ChartWidgetApiLike> | null | undefined;
  if (typeof chart?.getAllStudies !== 'function' || typeof chart.getStudyById !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no chart API to reach the studies with',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  const listed = attempt(() => chart.getAllStudies?.());
  const known =
    Array.isArray(listed) &&
    (listed as unknown[]).some((entry) => (entry as { id?: unknown } | null)?.id === id);
  const study = known
    ? (attempt(() => chart.getStudyById?.(id)) as Partial<StudyApiLike> | null | undefined)
    : undefined;
  if (study === undefined || study === null) {
    return {
      __tvmcpError: {
        code: 'INVALID_INPUT',
        message: `The chart has no study with the id ${id}`,
        hint: 'Call indicator_list for the ids of the studies on the chart.',
        details: { id },
      },
    };
  }
  if (typeof study.setVisible !== 'function' || typeof study.isVisible !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: `The visibility of the study ${id} cannot be set on this page`,
        hint: 'This TradingView build shows and hides studies another way. Check app_health.',
        details: { id },
      },
    };
  }
  const previous = attempt(() => study.isVisible?.()) === true;
  study.setVisible(visible);
  return { previous, visible: attempt(() => study.isVisible?.()) === true };
}

// Removes a study with removeEntity, the way the app does it on the chart: as a command the user
// can undo. Without confirmed it only checks: it answers removed false and changes nothing, so
// that the caller can ask for confirmation. The app only warns about an id it does not know, so the
// list of studies is read again afterwards, and a study that is still there is NOT_AVAILABLE. An
// id that is not a study of the chart is INVALID_INPUT, confirmed or not. name is the name the
// study had in the list.
export function removeStudy(
  win: TvWindow,
  chartIndex: number | null,
  id: string,
  confirmed: boolean,
): { removed: boolean; name: string } | PageErrorSentinel {
  const attempt = (read: () => unknown): unknown => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  const chart = attempt(() =>
    chartIndex === null ? api?.activeChart?.() : api?.chart?.(chartIndex),
  ) as Partial<ChartWidgetApiLike> | null | undefined;
  if (typeof chart?.getAllStudies !== 'function' || typeof chart.removeEntity !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no chart API to remove indicators with',
        hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
      },
    };
  }
  const entryOf = (): { id?: unknown; name?: unknown } | undefined => {
    const listed = attempt(() => chart.getAllStudies?.());
    return (Array.isArray(listed) ? (listed as unknown[]) : []).find(
      (entry) => (entry as { id?: unknown } | null)?.id === id,
    ) as { id?: unknown; name?: unknown } | undefined;
  };
  const entry = entryOf();
  if (entry === undefined) {
    return {
      __tvmcpError: {
        code: 'INVALID_INPUT',
        message: `The chart has no study with the id ${id}`,
        hint: 'Call indicator_list for the ids of the studies on the chart.',
        details: { id },
      },
    };
  }
  const name = typeof entry.name === 'string' ? entry.name : id;
  if (!confirmed) {
    return { removed: false, name };
  }
  chart.removeEntity(id);
  if (entryOf() !== undefined) {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: `TradingView did not remove the study ${id}`,
        hint: 'Check indicator_list. The study may be locked, or part of another study, in TradingView.',
        details: { id },
      },
    };
  }
  return { removed: true, name };
}
