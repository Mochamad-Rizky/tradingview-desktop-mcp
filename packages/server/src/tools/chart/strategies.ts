import type { PageHandle } from '../../core/connection.js';
import { isTvMcpError, TvMcpError } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import type { Tier } from '../../core/result.js';
import {
  clickElement,
  describeElement,
  describeFocusedElement,
  pressKey,
  typeText,
} from '../../core/tv/input.js';
import { SELECTORS, UNSAFE_SELECTORS } from '../../core/tv/selectors.js';
import { runWithFallback, type Strategy } from '../../core/tv/tiers.js';
import { pollUntil } from '../../utils/poll.js';
import { sameResolution, sameSymbol } from './mappers.js';
import {
  readChartLayout,
  readChartSnapshot,
  scrollToTime,
  setChartTypeViaApi,
  setResolutionViaApi,
  setSymbolViaApi,
  zoomToTimeRange,
} from './page.js';

// How the chart tools carry out a change: the strategies of each tool, from the chart API (tier
// api) and the chart model (tier internal) to the interface, where a click (tier dom) or typing on
// the chart (tier keyboard) does what a person would do. Every strategy that needs something the
// page lacks says so with CAPABILITY_UNAVAILABLE before it acts, so that the next one can take over;
// once it has acted, any failure ends the operation (design spec 6).
//
// The interface acts on the active chart only, and it cannot tell by itself whether the change
// took, so after acting it reads the chart through its API until the change shows. A page without
// that API is changed without the check, and the result says so.

// A page function that waits in the page (for the data of a new symbol, say) is bounded by the call
// timeout like every page function, so it stops this much earlier and answers what it waited for,
// instead of letting the bridge give up with a bare timeout.
const PAGE_ANSWER_MARGIN_MS = 1000;
const MIN_PAGE_WAIT_MS = 500;
// How often the page is asked while waiting for a dialog to take the focus or for a change to show.
const POLL_INTERVAL_MS = 100;
// A dialog opens within a moment of the key or click that opens it.
const DIALOG_WAIT_MS = 3000;
// A preset changes the range at once, or after the data of a new timeframe, which this allows for.
const PRESET_WAIT_MS = 3000;
// How long a symbol entered through the interface is at least given, once the chart shows it, to be
// resolved or flagged as unknown, even when the switch itself took most of the wait.
const SETTLE_MIN_MS = 1500;

export function pageWaitMs(callTimeoutMs: number): number {
  return Math.max(callTimeoutMs - PAGE_ANSWER_MARGIN_MS, MIN_PAGE_WAIT_MS);
}

// Which chart a call works on: `index` is the chart the caller named, or null for the active chart,
// and `activeIndex` is the active chart when the layout was asked for it, which happens only when the
// caller named a chart.
export interface ChartTarget {
  index: number | null;
  activeIndex: number | null;
}

// Checks a chartIndex against the charts of the layout. Without one, the call works on the active
// chart and the layout is not asked.
export async function resolveChartTarget(
  page: PageHandle,
  chartIndex: number | undefined,
): Promise<ChartTarget> {
  if (chartIndex === undefined) {
    return { index: null, activeIndex: null };
  }
  const { chartsCount, activeChartIndex } = await page.bridge.evaluate(readChartLayout, []);
  if (chartsCount === null || !Number.isInteger(chartsCount) || chartsCount < 1) {
    throw new TvMcpError('NOT_AVAILABLE', 'The layout did not report how many charts it has', {
      hint: 'Leave chartIndex out to use the active chart, or check app_health.',
      details: { chartIndex },
    });
  }
  if (chartIndex >= chartsCount) {
    const count = `${String(chartsCount)} chart${chartsCount === 1 ? '' : 's'}`;
    const valid = chartsCount === 1 ? 'must be 0' : `must be from 0 to ${String(chartsCount - 1)}`;
    throw new TvMcpError(
      'INVALID_INPUT',
      `chartIndex ${String(chartIndex)} is out of range: the layout has ${count}, so chartIndex ${valid}`,
      {
        hint:
          'Leave chartIndex out to use the active chart. chart_get_state reports how many charts ' +
          'the layout has (layout.chartsCount).',
        details: { chartIndex, chartsCount },
      },
    );
  }
  return { index: chartIndex, activeIndex: activeChartIndex };
}

// runWithFallback, with a hint for the client when no strategy could be used: the error it raises
// then names the strategies, and the hint says what to do about it.
export async function runStrategies<T>(
  strategies: Strategy<T>[],
  logger: Logger,
  hint: string,
): Promise<{ value: T; via: Tier }> {
  try {
    return await runWithFallback(strategies, logger);
  } catch (error) {
    if (isTvMcpError(error) && error.code === 'CAPABILITY_UNAVAILABLE') {
      throw new TvMcpError('CAPABILITY_UNAVAILABLE', error.message, {
        hint,
        ...(error.details === undefined ? {} : { details: error.details }),
      });
    }
    throw error;
  }
}

function unavailable(message: string): TvMcpError {
  return new TvMcpError('CAPABILITY_UNAVAILABLE', message);
}

// The error of a symbol TradingView does not know, the same whichever strategy found it out. The
// tool switches the chart back to `previous` before it reports it (see revertUnknownSymbol).
function unknownSymbol(requested: string, previous: string): TvMcpError {
  return new TvMcpError('INVALID_INPUT', `Unknown symbol ${requested}`, {
    details: { requested, previous },
  });
}

// The symbol a chart showed before `requested` turned out to be unknown, when `error` says that, or
// undefined for any other error.
export function unknownSymbolPrevious(error: unknown, requested: string): string | undefined {
  if (!isTvMcpError(error) || error.code !== 'INVALID_INPUT') {
    return undefined;
  }
  const { details } = error;
  return details?.requested === requested && typeof details.previous === 'string'
    ? details.previous
    : undefined;
}

// Switches the chart back to the symbol it showed before an unknown one, the same ways a symbol is
// set (the chart API, then the interface), and returns the error to report: INVALID_INPUT with
// details.kept, the symbol the chart is back on, or, when switching back failed too, details that
// say so with the code of that failure.
export async function revertUnknownSymbol(
  page: PageHandle,
  target: ChartTarget,
  requested: string,
  previous: string,
  waitMs: number,
  logger: Logger,
): Promise<TvMcpError> {
  let restored: SymbolChange;
  try {
    ({ value: restored } = await runWithFallback(
      symbolStrategies(page, target, previous, waitMs),
      logger,
    ));
  } catch (error) {
    if (!isTvMcpError(error)) {
      throw error;
    }
    return new TvMcpError('INVALID_INPUT', `Unknown symbol ${requested}`, {
      hint:
        `TradingView could not find ${requested}, and switching the chart back to ${previous} ` +
        `failed (${error.code}), so the chart may still show ${requested}. Call chart_set_symbol ` +
        `with ${previous} to restore it.`,
      details: { requested, kept: null, previous, revertFailed: true, revertError: error.code },
    });
  }
  // A switch back through the interface on a chart that cannot be read any more is not checked,
  // and the hint says so.
  const kept = restored.symbol ?? previous;
  const unchecked = restored.symbol === null ? ', which could not be checked' : '';
  return new TvMcpError('INVALID_INPUT', `Unknown symbol ${requested}`, {
    hint:
      `TradingView could not find ${requested}, so the chart was switched back to ${kept}` +
      `${unchecked}. Check the spelling, or use the EXCHANGE:SYMBOL form such as NASDAQ:AAPL.`,
    details: { requested, kept },
  });
}

// What a change of the symbol or the timeframe came to. The values are null when the change was made
// through the interface on a page whose chart API cannot be read, so that it could not be checked.
// `confirmed` says whether TradingView confirmed the symbol: the chart API reports the data of a new
// symbol as loaded, and through the interface the series has resolved it and holds bars for it.
// `listing` is the symbol the series has resolved (the pro_name of its symbol info, such as
// NASDAQ:AAPL), which the chart may show through the exchange of its data feed (BATS:AAPL), or null
// when the series does not say.
export interface SymbolChange {
  symbol: string | null;
  previous: string | null;
  changed: boolean | null;
  confirmed: boolean;
  listing: string | null;
}

export interface TimeframeChange {
  resolution: string | null;
  previous: string | null;
  changed: boolean | null;
}

type Snapshot = NonNullable<Awaited<ReturnType<typeof readChartSnapshot>>>;

function snapshotOf(page: PageHandle, target: ChartTarget): Promise<Snapshot | null> {
  return page.bridge.evaluate(readChartSnapshot, [target.index]);
}

// Whether the chart shows the symbol already, as itself or through the exchange of its data feed,
// in which case the series names it as the symbol it has resolved. A series flagged for an unknown
// symbol has resolved nothing the chart shows, so its name does not count then. TradingView writes
// symbols in capitals and reads them in any case, so case does not count.
function showsSymbol(
  snapshot: Snapshot | null,
  symbol: string,
): snapshot is Snapshot & { symbol: string } {
  const wanted = symbol.toUpperCase();
  return (
    typeof snapshot?.symbol === 'string' &&
    (snapshot.symbol.toUpperCase() === wanted ||
      (!snapshot.symbolInvalid && snapshot.seriesSymbol?.toUpperCase() === wanted))
  );
}

// The interface reaches the active chart only.
function requireActiveChart(target: ChartTarget, way: string): void {
  if (target.index !== null && target.index !== target.activeIndex) {
    throw unavailable(`${way} reaches the active chart only, and chartIndex names another one`);
  }
}

// Before a click: the element is on the page and shown, and the click would reach it. Each of these
// is checked before anything is sent, so a failure leaves the next strategy to try: no element, an
// element that is hidden, covered by a dialog or a frame, off the visible part of the page, or on a
// page that cannot say what lies over it (and a page without a DOM, which has no interface at all).
// A verdict that the element is, holds or sits under a trading control is left to clickElement,
// whose refusal ends the operation instead of handing it on.
async function requireClickable(page: PageHandle, selector: string, what: string): Promise<void> {
  let element: Awaited<ReturnType<typeof lookUp>>;
  try {
    element = await lookUp(page, selector);
  } catch (error) {
    if (isTvMcpError(error) && error.code === 'NOT_AVAILABLE') {
      throw unavailable(`${what} cannot be looked up: the page has no DOM`);
    }
    throw error;
  }
  if (!element.found || !element.visible) {
    throw unavailable(`${what} is not shown`);
  }
  if (element.unsafe) {
    return;
  }
  if (element.coverage === 'obscured') {
    throw unavailable(`${what} is covered by ${element.obscuredBy}`);
  }
  if (element.coverage !== 'clear') {
    throw unavailable(`${what} cannot be clicked (${element.coverage})`);
  }
}

function lookUp(page: PageHandle, selector: string) {
  return page.bridge.evaluate(describeElement, [
    selector,
    [...UNSAFE_SELECTORS],
    [SELECTORS.regions.overlapManagerRoot],
  ]);
}

function focusOf(page: PageHandle) {
  return page.bridge.evaluate(describeFocusedElement, [[...UNSAFE_SELECTORS]]);
}

// Before typing on the chart, and before opening a dialog to type into: no text field has the focus.
// A key would go into that field instead of reaching the chart, and the wait for the dialog would
// take that field for the dialog.
async function requireNoTextField(page: PageHandle): Promise<void> {
  let focus: Awaited<ReturnType<typeof focusOf>>;
  try {
    focus = await focusOf(page);
  } catch (error) {
    if (isTvMcpError(error) && error.code === 'NOT_AVAILABLE') {
      throw unavailable('The page cannot say what has the focus');
    }
    throw error;
  }
  if (focus.editable) {
    throw unavailable('A text field has the focus, so what is typed would go there');
  }
}

// The steps of an interface strategy from its first input event on. Once that event is sent, the
// operation has begun, so a capability that turns out to be missing (a CDP method the page does not
// know, say) ends it as PAGE_EVALUATION_FAILED instead of handing it to the next strategy, which
// would act a second time. The step that sends the first event is inside, because whether the event
// got out before the failure cannot be told. `stage` names the step that is running, for the error.
async function begun<T>(
  strategy: string,
  steps: (stage: (name: string) => void) => Promise<T>,
): Promise<T> {
  let current = 'start';
  try {
    return await steps((name) => {
      current = name;
    });
  } catch (error) {
    if (isTvMcpError(error) && error.code === 'CAPABILITY_UNAVAILABLE') {
      throw new TvMcpError(
        'PAGE_EVALUATION_FAILED',
        `The change through the ${strategy} stopped after it had begun (${current}): ${error.message}`,
        {
          hint:
            'Part of the change may have happened. Call chart_get_state to see what the chart ' +
            'shows, and close any dialog that is still open.',
          details: { strategy, stage: current },
        },
      );
    }
    throw error;
  }
}

// After the click or the key that opens a dialog: its text field takes the focus. As no text field
// had it before, the first one that does is the dialog's.
async function waitForTextField(page: PageHandle, waitMs: number, failure: string): Promise<void> {
  const { satisfied } = await pollUntil(
    () => focusOf(page),
    (focus) => focus.editable,
    { intervalMs: POLL_INTERVAL_MS, timeoutMs: Math.min(waitMs, DIALOG_WAIT_MS) },
  );
  if (!satisfied) {
    throw new TvMcpError('NOT_AVAILABLE', failure, {
      hint:
        'Close any dialog or menu that covers the chart and try again, or make the change in ' +
        'TradingView yourself.',
    });
  }
}

// Whether the series has loaded the symbol the chart shows: the flag of an unknown symbol is down,
// the series holds bars, and its symbol info names what the chart shows, by the full name the chart
// uses once the symbol is resolved (BATS:AAPL) or by the listing (NASDAQ:AAPL, or AAPL for a chart
// that shows a bare ticker). Symbol info that names another symbol is left over from the one before.
function loaded(now: Snapshot): now is Snapshot & { symbol: string } {
  const shown = now.symbol;
  return (
    !now.symbolInvalid &&
    shown !== null &&
    (now.barCount ?? 0) > 0 &&
    ((now.seriesName !== null && now.seriesName.toUpperCase() === shown.toUpperCase()) ||
      (now.seriesSymbol !== null && sameSymbol(now.seriesSymbol, shown)))
  );
}

// After a symbol was entered through the interface. The chart shows the new symbol at once, and only
// afterwards does TradingView resolve it and load its data, or flag it as unknown, so the wait has
// two parts. The first lasts until the chart shows another symbol, or flags the new one as unknown
// while it keeps showing the old one. The second lasts until the series has loaded what the chart
// shows (loaded), or until the flag goes up, which is reported as INVALID_INPUT like the chart API
// reports it, for the tool to switch the chart back. TradingView renames a symbol once it has
// resolved it, to the exchange of its data feed (NASDAQ:AAPL becomes BATS:AAPL, seen on the app), so
// the second part follows the chart to the name it settles on instead of holding it to the text
// that was entered, and the change counts as one only when that name is another than before. The
// second part takes what is left of the wait, and at least SETTLE_MIN_MS, so that a switch seen at
// the last moment still gets the time to be resolved. A symbol that is neither loaded nor flagged by
// then is reported as not confirmed, by the name the chart shows last. A flag that was up before
// belongs to the symbol the chart showed then, so it says nothing about the new one. An unknown
// symbol is reported with the listing the chart showed to switch back to, as the chart API reports
// it, or with the symbol shown when the series named none.
async function confirmSymbol(
  page: PageHandle,
  target: ChartTarget,
  requested: string,
  before: Snapshot | null,
  waitMs: number,
): Promise<SymbolChange> {
  const previous = before?.symbol ?? null;
  if (before === null || previous === null) {
    return { symbol: null, previous: null, changed: null, confirmed: false, listing: null };
  }
  const flagged = (now: Snapshot): boolean => now.symbolInvalid && !before.symbolInvalid;
  // Only reported when the flag goes up now, so the series was not flagged before and its name is
  // the listing the chart showed.
  const restorable = before.seriesSymbol ?? previous;
  // A snapshot of null, a chart that cannot be read any more, ends the wait as well.
  const switched = await pollUntil(
    () => snapshotOf(page, target),
    (now) => now?.symbol !== previous || flagged(now),
    { intervalMs: POLL_INTERVAL_MS, timeoutMs: waitMs },
  );
  const shown = switched.last?.symbol ?? null;
  if (switched.last === null || shown === null) {
    return { symbol: null, previous: null, changed: null, confirmed: false, listing: null };
  }
  if (flagged(switched.last)) {
    throw unknownSymbol(requested, restorable);
  }
  if (!switched.satisfied) {
    throw new TvMcpError(
      'TIMEOUT',
      `The chart still shows ${previous} after ${requested} was entered`,
      {
        hint:
          `TradingView may not have found ${requested}, and its symbol search dialog may still be ` +
          'open. Close the dialog, check the symbol, and try again.',
        details: { requested, previous, timeoutMs: waitMs },
      },
    );
  }
  const settled = await pollUntil(
    () => snapshotOf(page, target),
    (now) => now === null || flagged(now) || loaded(now),
    {
      intervalMs: POLL_INTERVAL_MS,
      timeoutMs: Math.max(waitMs - switched.waitedMs, SETTLE_MIN_MS),
    },
  );
  const last = settled.last;
  if (last !== null && flagged(last)) {
    throw unknownSymbol(requested, restorable);
  }
  const symbol = last?.symbol ?? shown;
  return {
    symbol,
    previous,
    changed: symbol.toUpperCase() !== previous.toUpperCase(),
    confirmed: last !== null && loaded(last),
    listing: last?.seriesSymbol ?? null,
  };
}

// After a timeframe was chosen through the interface: waits until the chart shows another one.
async function confirmTimeframe(
  page: PageHandle,
  target: ChartTarget,
  requested: string,
  before: Snapshot | null,
  waitMs: number,
): Promise<TimeframeChange> {
  const previous = before?.resolution ?? null;
  if (previous === null) {
    return { resolution: null, previous: null, changed: null };
  }
  const { satisfied, last } = await pollUntil(
    () => snapshotOf(page, target),
    (now) => now?.resolution !== previous,
    { intervalMs: POLL_INTERVAL_MS, timeoutMs: waitMs },
  );
  const shown = last?.resolution ?? null;
  if (shown === null) {
    return { resolution: null, previous: null, changed: null };
  }
  if (!satisfied) {
    throw new TvMcpError('TIMEOUT', `The chart still shows the timeframe ${previous}`, {
      hint:
        `TradingView may not offer ${requested} for this symbol or plan, or its interval dialog ` +
        'may still be open. Close the dialog and check chart_get_state.',
      details: { requested, previous, timeoutMs: waitMs },
    });
  }
  return { resolution: shown, previous, changed: true };
}

// The symbol through the chart API, then the symbol search dialog of the header toolbar, then
// typing the symbol on the chart, which opens the same dialog with the first letter in it.
export function symbolStrategies(
  page: PageHandle,
  target: ChartTarget,
  symbol: string,
  waitMs: number,
): Strategy<SymbolChange>[] {
  return [
    {
      tier: 'api',
      name: 'chart api',
      // The chart API reports the data of the new symbol as loaded, which confirms it.
      run: async () => ({
        ...(await page.bridge.evaluate(setSymbolViaApi, [symbol, target.index, waitMs])),
        confirmed: true,
      }),
    },
    {
      tier: 'dom',
      name: 'symbol search',
      async run() {
        requireActiveChart(target, 'The symbol search');
        const before = await snapshotOf(page, target);
        if (showsSymbol(before, symbol)) {
          return {
            symbol: before.symbol,
            previous: before.symbol,
            changed: false,
            confirmed: true,
            listing: before.seriesSymbol,
          };
        }
        await requireClickable(page, SELECTORS.header.symbolSearch, 'The symbol search button');
        await requireNoTextField(page);
        return begun('symbol search', async (stage) => {
          stage('click');
          await clickElement(page, SELECTORS.header.symbolSearch);
          stage('dialog');
          await waitForTextField(
            page,
            waitMs,
            'The symbol search dialog did not open: no text field took the focus after the click',
          );
          stage('type');
          await typeText(page, symbol);
          stage('enter');
          await pressKey(page, 'Enter');
          stage('confirm');
          return confirmSymbol(page, target, symbol, before, waitMs);
        });
      },
    },
    {
      tier: 'keyboard',
      name: 'typing on the chart',
      async run() {
        requireActiveChart(target, 'Typing on the chart');
        // In lower case, as a person types it: a capital would go out as a key that types a
        // capital without Shift, which no keyboard sends and a shortcut of the page could read as
        // another key. The symbol search ignores case, so the rest is typed as written.
        const first = symbol.charAt(0).toLowerCase();
        // A digit typed on the chart opens the interval dialog instead, and the rest of the
        // symbol would become an interval.
        if (!/^[a-z]$/.test(first)) {
          throw unavailable(
            'Typing on the chart opens the symbol search only for a symbol that starts with a letter',
          );
        }
        const before = await snapshotOf(page, target);
        if (showsSymbol(before, symbol)) {
          return {
            symbol: before.symbol,
            previous: before.symbol,
            changed: false,
            confirmed: true,
            listing: before.seriesSymbol,
          };
        }
        await requireNoTextField(page);
        return begun('typing on the chart', async (stage) => {
          stage('key');
          await pressKey(page, first);
          stage('dialog');
          await waitForTextField(
            page,
            waitMs,
            'Typing on the chart did not open the symbol search: no text field took the focus',
          );
          stage('type');
          await typeText(page, symbol.slice(1));
          stage('enter');
          await pressKey(page, 'Enter');
          stage('confirm');
          return confirmSymbol(page, target, symbol, before, waitMs);
        });
      },
    },
  ];
}

// The button of an interval among the favorites of the header toolbar. Which attribute carries the
// interval is not recorded: data-value is assumed, and a page where no element matches makes the
// strategy unavailable, so a wrong guess costs nothing.
function intervalButton(resolution: string): string {
  return `${SELECTORS.header.intervals} [data-value="${resolution}"]`;
}

// The timeframe through the chart API, then the interval button of the header toolbar, then typing
// the interval on the chart, which opens the interval dialog with the first digit in it.
export function timeframeStrategies(
  page: PageHandle,
  target: ChartTarget,
  resolution: string,
  waitMs: number,
): Strategy<TimeframeChange>[] {
  const unchanged = (before: Snapshot | null): TimeframeChange | undefined => {
    const shown = before?.resolution ?? null;
    return shown !== null && sameResolution(shown, resolution)
      ? { resolution: shown, previous: shown, changed: false }
      : undefined;
  };
  return [
    {
      tier: 'api',
      name: 'chart api',
      run: () => page.bridge.evaluate(setResolutionViaApi, [resolution, target.index, waitMs]),
    },
    {
      tier: 'dom',
      name: 'interval button',
      async run() {
        requireActiveChart(target, 'The interval buttons');
        const before = await snapshotOf(page, target);
        const same = unchanged(before);
        if (same !== undefined) {
          return same;
        }
        const selector = intervalButton(resolution);
        await requireClickable(page, selector, 'The button of this interval');
        return begun('interval button', async (stage) => {
          stage('click');
          await clickElement(page, selector);
          stage('confirm');
          return confirmTimeframe(page, target, resolution, before, waitMs);
        });
      },
    },
    {
      tier: 'keyboard',
      name: 'typing on the chart',
      async run() {
        requireActiveChart(target, 'Typing on the chart');
        const first = resolution.charAt(0);
        // A resolution string starts with its count, and a digit is what opens the interval dialog.
        if (!/^\d$/.test(first)) {
          throw unavailable(
            'Typing on the chart sets an interval only when it starts with a digit',
          );
        }
        const before = await snapshotOf(page, target);
        const same = unchanged(before);
        if (same !== undefined) {
          return same;
        }
        await requireNoTextField(page);
        return begun('typing on the chart', async (stage) => {
          stage('key');
          await pressKey(page, first);
          stage('dialog');
          await waitForTextField(
            page,
            waitMs,
            'Typing on the chart did not open the interval dialog: no text field took the focus',
          );
          stage('type');
          await typeText(page, resolution.slice(1));
          stage('enter');
          await pressKey(page, 'Enter');
          stage('confirm');
          return confirmTimeframe(page, target, resolution, before, waitMs);
        });
      },
    },
  ];
}

export function chartTypeStrategies(
  page: PageHandle,
  target: ChartTarget,
  typeId: number,
): Strategy<{ chartType: number; previous: number; changed: boolean }>[] {
  return [
    {
      tier: 'api',
      name: 'chart api',
      run: () => page.bridge.evaluate(setChartTypeViaApi, [typeId, target.index]),
    },
  ];
}

// A range of times through the core time scale. The public setVisibleRange throws on the observed
// build, so the chart model is the first way, not a fallback.
export function rangeStrategies(
  page: PageHandle,
  target: ChartTarget,
  from: number,
  to: number,
): Strategy<{ from: number | null; to: number | null; warnings: string[] }>[] {
  return [
    {
      tier: 'internal',
      name: 'time scale',
      run: () => page.bridge.evaluate(zoomToTimeRange, [from, to, target.index]),
    },
  ];
}

// What a click on a date range preset came to: the visible range and the timeframe afterwards, the
// timeframe before, and whether the range moved within the wait. Null where the chart API cannot be
// read.
export interface PresetMove {
  from: number | null;
  to: number | null;
  resolution: string | null;
  previousResolution: string | null;
  moved: boolean | null;
}

export type DateRangePreset = keyof typeof SELECTORS.buttons.dateRange;

// A date range preset, clicked in the bar under the active chart. TradingView picks the timeframe
// that suits the range, so the click can change the timeframe too, after which the range follows.
export function presetStrategies(
  page: PageHandle,
  target: ChartTarget,
  preset: DateRangePreset,
  waitMs: number,
): Strategy<PresetMove>[] {
  return [
    {
      tier: 'dom',
      name: 'date range preset',
      async run() {
        requireActiveChart(target, 'The date range bar');
        const selector = SELECTORS.buttons.dateRange[preset];
        await requireClickable(page, selector, 'The button of this preset');
        const before = await snapshotOf(page, target);
        return begun('date range preset', async (stage): Promise<PresetMove> => {
          stage('click');
          await clickElement(page, selector);
          if (before === null) {
            return {
              from: null,
              to: null,
              resolution: null,
              previousResolution: null,
              moved: null,
            };
          }
          stage('confirm');
          const { satisfied, last } = await pollUntil(
            () => snapshotOf(page, target),
            (now) => now?.from !== before.from || now.to !== before.to,
            { intervalMs: POLL_INTERVAL_MS, timeoutMs: Math.min(waitMs, PRESET_WAIT_MS) },
          );
          return {
            from: last?.from ?? null,
            to: last?.to ?? null,
            resolution: last?.resolution ?? null,
            previousResolution: before.resolution,
            moved: last === null ? null : satisfied,
          };
        });
      },
    },
  ];
}

export function scrollStrategies(
  page: PageHandle,
  target: ChartTarget,
  time: number,
  align: 'left' | 'center' | 'right',
): Strategy<{ time: number; from: number | null; to: number | null; warnings: string[] }>[] {
  return [
    {
      tier: 'internal',
      name: 'time scale',
      run: () => page.bridge.evaluate(scrollToTime, [time, align, target.index]),
    },
  ];
}
