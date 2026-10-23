import type { PageErrorSentinel } from '../../core/tv/page-bridge.js';
import type { BoxElementLike, TradingViewApiLike, TvWindow } from '../../core/tv/tv-window.js';

// The page function of the screenshot tool. The page bridge sends its source text into the page, so
// it uses nothing of this file, only its parameters and the globals of the page. Members of the app
// are read defensively: another web build can drop or reshape any of them, and a read that throws
// counts as no answer.

// Where a chart is on the screen: the box of its container in CSS pixels, from the top left of the
// viewport, the way getBoundingClientRect gives it. `chartIndex` is the chart the caller named
// (checked against the layout by the caller), or null for the active chart.
//
// The container is the one the chart widget collection of the app names for the chart. A build
// without that member leaves the position of the chart in the page to go by: the container at the
// same position among the elements that match `containerSelector`, in document order, which
// byPosition says. That the collection and the document list the charts in the same order is an
// assumption: with the one chart of a layout, which is all that was seen, they agree. Without a
// named chart the position is that of the active chart, and when the app cannot say which that is,
// the only container of the page is the one, and several are no choice to make.
//
// NOT_AVAILABLE when the tab is hidden, which comes first: a hidden tab is not on the screen, so a
// capture of it would come out blank or wait for the call timeout. Also when the page has no
// container for the chart, or when it has one without a size, which is how a chart that is not
// shown looks: another chart of the layout is maximized. A capture of a box without an area would
// only fail.
export function readChartBox(
  win: TvWindow,
  chartIndex: number | null,
  containerSelector: string,
):
  | { box: { x: number; y: number; width: number; height: number }; byPosition: boolean }
  | PageErrorSentinel {
  const attempt = (read: () => unknown): unknown => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  // The box an element says it has, if it says one that is made of numbers.
  const boxOf = (
    element: unknown,
  ): { x: number; y: number; width: number; height: number } | null => {
    const rect = attempt(() =>
      (element as Partial<BoxElementLike> | null | undefined)?.getBoundingClientRect?.(),
    ) as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null | undefined;
    const { x, y, width, height } = rect ?? {};
    return typeof x === 'number' &&
      Number.isFinite(x) &&
      typeof y === 'number' &&
      Number.isFinite(y) &&
      typeof width === 'number' &&
      Number.isFinite(width) &&
      typeof height === 'number' &&
      Number.isFinite(height)
      ? { x, y, width, height }
      : null;
  };
  const fail = (message: string, hint: string): PageErrorSentinel => ({
    __tvmcpError: { code: 'NOT_AVAILABLE', message, hint },
  });

  if (attempt(() => win.document.visibilityState) === 'hidden') {
    return fail('The chart tab is hidden', 'Bring the TradingView tab to the front and try again.');
  }

  const api: Partial<TradingViewApiLike> | undefined = win.TradingViewApi;
  const active = attempt(() => api?.activeChartIndex?.());
  const index =
    chartIndex ??
    (typeof active === 'number' && Number.isInteger(active) && active >= 0 ? active : null);
  const what = typeof chartIndex === 'number' ? `chart ${String(chartIndex)}` : 'the active chart';

  let box = boxOf(
    index === null
      ? undefined
      : attempt(() => api?._chartWidgetCollection?._chartWidgetsDefs?.[index]?.container?.value()),
  );
  let byPosition = false;
  if (box === null) {
    const found = attempt(() => win.document.querySelectorAll?.(containerSelector)) as
      ArrayLike<unknown> | null | undefined;
    const count = typeof found?.length === 'number' ? found.length : 0;
    if (index === null && count > 1) {
      return fail(
        `The app did not say which chart is active, so the page cannot tell which of its ${String(count)} chart containers to capture`,
        'Give chartIndex, counted from 0 in the order of the charts of the layout.',
      );
    }
    box = boxOf(found?.[index ?? 0]);
    byPosition = true;
  }
  if (box === null) {
    return fail(
      `The page shows no container for ${what}`,
      'Open a chart in the tab and wait until it has loaded, then try again. target page ' +
        'captures the tab as it is, whether or not it shows a chart.',
    );
  }
  if (box.width <= 0 || box.height <= 0) {
    return fail(
      `The container of ${what} has no size`,
      'The chart is not shown: another chart of the layout may be maximized. Show the chart and ' +
        'try again.',
    );
  }
  return { box, byPosition };
}

// Where the tab strip is in the window chrome: the box of its element (`stripSelector`) in CSS
// pixels, from the top left of the viewport. The window chrome spans the whole window and the strip
// only its top (seen on the app), so a capture of the window is cut to this box. NOT_AVAILABLE when
// the page shows no strip, or one without a size. It runs in the window chrome, whose renderer has
// Node integration, and reads its DOM and nothing else.
export function readStripBox(
  win: TvWindow,
  stripSelector: string,
): { box: { x: number; y: number; width: number; height: number } } | PageErrorSentinel {
  let rect: { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null | undefined;
  try {
    const strip = win.document.querySelector?.(stripSelector) as
      Partial<BoxElementLike> | null | undefined;
    rect = strip?.getBoundingClientRect?.();
  } catch {
    rect = undefined;
  }
  const { x, y, width, height } = rect ?? {};
  if (
    typeof x === 'number' &&
    Number.isFinite(x) &&
    typeof y === 'number' &&
    Number.isFinite(y) &&
    typeof width === 'number' &&
    Number.isFinite(width) &&
    width > 0 &&
    typeof height === 'number' &&
    Number.isFinite(height) &&
    height > 0
  ) {
    return { box: { x, y, width, height } };
  }
  return {
    __tvmcpError: {
      code: 'NOT_AVAILABLE',
      message: 'The window chrome shows no tab strip to capture',
      hint: 'Check app_health: the window of TradingView may still be loading.',
    },
  };
}
