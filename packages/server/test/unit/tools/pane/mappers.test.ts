import { PlanLimitError } from '../../../../src/core/errors.js';
import {
  chartList,
  chartsNotReadyWarning,
  describeLayouts,
  fewerChartsError,
  layoutNotShownError,
  multipleChartsError,
  notFocusedError,
  PANE_LAYOUT_CODES,
  PANE_LAYOUTS,
  planChartsLimitOf,
  symbolChanges,
  syncedSymbolsWarning,
  uncountedLayoutError,
  unknownLayoutError,
  unreadableLayoutError,
  unreportedPanesWarning,
  unreportedStudiesWarning,
} from '../../../../src/tools/pane/mappers.js';

// The pure parts of the pane tools: the layout codes and their chart counts, the chart limit of the
// plan as TradingView computes it, and the errors and warnings.

describe('PANE_LAYOUTS', () => {
  // The codes of the research notes of Plan 3 (section 2.1), by how many charts each shows.
  const BY_COUNT: Record<number, string[]> = {
    1: ['s'],
    2: ['2h', '2v'],
    3: ['3h', '3v', '3s', '3r', '2-1', '1-2'],
    4: ['4', '4v', '4h', '4s', '4s-l', '1-3', '3-1', '2-2-l', '2-2-r', '2-2'],
    5: ['1-4', '5h', '5v', '5s', '5s-l', '2-3', '3-2', '4-1', '2-3-l', '2-3-r'],
    6: ['6', '6h', '6v', '6c', '2-4', '4-2'],
    7: ['4-3', '7h', '7s'],
    8: ['8', '8c', '8h', '8v'],
    9: ['9s', '5-4', '9h', '9v'],
    10: ['10c5', '10h', '10v'],
    12: ['12c6', '12c4', '12h'],
    14: ['14c7'],
    16: ['16c8', '16c4'],
  };

  test('holds the 55 layout codes of TradingView with the count of charts of each', () => {
    const grouped: Partial<Record<number, string[]>> = {};
    for (const [code, count] of Object.entries(PANE_LAYOUTS)) {
      (grouped[count] ??= []).push(code);
    }

    expect(Object.keys(PANE_LAYOUTS)).toHaveLength(55);
    expect(grouped).toEqual(BY_COUNT);
  });

  test('PANE_LAYOUT_CODES are its codes', () => {
    expect(PANE_LAYOUT_CODES).toEqual(Object.keys(PANE_LAYOUTS));
  });

  test('describeLayouts names every code once, by its count of charts', () => {
    const text = describeLayouts();

    expect(text).toBe(
      Object.entries(BY_COUNT)
        .map(([count, codes]) => `${count} chart${count === '1' ? '' : 's'}: ${codes.join(', ')}`)
        .join('; '),
    );
  });
});

describe('planChartsLimitOf', () => {
  test.each([
    ['off', false, 4, 1],
    ['off without a limit', false, null, 1],
    ['on without a limit', true, null, 1],
    ['on with a limit of 0', true, 0, 1],
    ['on with a negative limit', true, -3, 1],
    ['on with a limit of 1', true, 1, 1],
    ['on with a limit of 2', true, 2, 2],
    ['on with the unlimited value', true, 99999, 99999],
  ])('is the formula of TradingView: %s', (_case, enabled, limit, expected) => {
    expect(planChartsLimitOf(enabled, limit)).toBe(expected);
  });
});

describe('chartList', () => {
  test.each([
    [[], 'no chart'],
    [[1], 'chart 1'],
    [[1, 2], 'charts 1 and 2'],
    [[0, 2, 3], 'charts 0, 2 and 3'],
  ])('names the charts %j as %s', (indexes, expected) => {
    expect(chartList(indexes)).toBe(expected);
  });
});

describe('the errors', () => {
  test('multipleChartsError is a PLAN_LIMIT of MULTIPLE_CHARTS with the limit', () => {
    const one = multipleChartsError('2h', 2, 1);
    const two = multipleChartsError('4', 4, 2);

    expect(one).toBeInstanceOf(PlanLimitError);
    expect(one.toPayload()).toEqual({
      code: 'PLAN_LIMIT',
      message:
        'The layout 2h has 2 charts, and the plan allows 1 chart in a layout (plan limit ' +
        'MULTIPLE_CHARTS), so TradingView would offer an upgrade instead; nothing was changed',
      hint: 'The plan allows a single chart (layout s) only.',
      details: { feature: 'MULTIPLE_CHARTS', limit: 1 },
    });
    expect(two.message).toMatch(/^The layout 4 has 4 charts, and the plan allows 2 charts in/);
    expect(two.hint).toBe(
      'Choose a layout of at most 2 charts: the layout input of pane_set_layout says how many ' +
        'charts each layout has.',
    );
  });

  test('fewerChartsError names the charts the next save drops, and asks for confirm', () => {
    const one = fewerChartsError('s', 1, 2);
    const three = fewerChartsError('2h', 2, 5);
    const unknown = fewerChartsError('3h', 3, null);

    expect(one.toPayload()).toEqual({
      code: 'CONFIRMATION_REQUIRED',
      message:
        'The layout s shows 1 chart, fewer than the 2 the layout shows now: TradingView saves ' +
        'only the charts a layout shows, so its next save, which autosave can make at any time, ' +
        'drops chart 1 with its symbol, indicators and drawings',
      hint:
        'Nothing was changed. Call pane_set_layout again with confirm: true if the user wants ' +
        'those charts dropped, or choose a layout of at least 2 charts.',
      details: { layout: 's', chartsCount: 1, currentChartsCount: 2 },
    });
    expect(three.message).toMatch(
      /drops charts 2, 3 and 4 with their symbols, indicators and drawings$/,
    );
    expect(unknown.message).toBe(
      'The layout 3h shows 3 charts, and TradingView does not tell how many the layout shows ' +
        'now: TradingView saves only the charts a layout shows, so its next save, which autosave ' +
        'can make at any time, would drop any chart beyond chart 2 with its symbol, indicators ' +
        'and drawings',
    );
    expect(unknown.hint).toBe(
      'Nothing was changed. Call pane_set_layout again with confirm: true if the user wants ' +
        'those charts dropped.',
    );
    expect(unknown.details).toEqual({ layout: '3h', chartsCount: 3, currentChartsCount: null });
  });

  test('unknownLayoutError and uncountedLayoutError are NOT_AVAILABLE and name the layout', () => {
    expect(unknownLayoutError('2-2-l').toPayload()).toEqual({
      code: 'NOT_AVAILABLE',
      message:
        'This TradingView build does not know the layout 2-2-l, so it cannot change to it, and ' +
        'nothing was changed',
      hint: 'Choose another layout; pane_list reports the one shown now.',
      details: { layout: '2-2-l' },
    });
    expect(uncountedLayoutError('2v').toPayload()).toEqual({
      code: 'NOT_AVAILABLE',
      message:
        'TradingView does not say how many charts the layout 2v has, so the plan limit cannot ' +
        'be checked, and nothing was changed',
      hint: 'Choose another layout, or change the layout in TradingView itself.',
      details: { layout: '2v' },
    });
  });

  test('unreadableLayoutError is NOT_AVAILABLE', () => {
    expect(unreadableLayoutError().toPayload()).toEqual({
      code: 'NOT_AVAILABLE',
      message:
        'The layout did not report its type or how many charts it shows, so nothing was changed',
      hint: 'Check app_health: the chart may still be loading, or the tab does not show a chart.',
    });
  });

  test('layoutNotShownError is TIMEOUT and says what TradingView shows instead', () => {
    expect(layoutNotShownError('2h', 2, 1000, { layout: 's', chartsCount: 1 }).toPayload()).toEqual(
      {
        code: 'TIMEOUT',
        message: 'TradingView did not show the layout 2h with 2 charts within 1000 ms',
        hint:
          'TradingView may still be changing the layout, or may have kept another one: pane_list ' +
          'shows the layout now.',
        details: {
          layout: '2h',
          chartsCount: 2,
          shownLayout: 's',
          shownChartsCount: 1,
          waitMs: 1000,
        },
      },
    );
  });

  test('notFocusedError is NOT_AVAILABLE and says which chart is active', () => {
    expect(notFocusedError(1, 0).toPayload()).toEqual({
      code: 'NOT_AVAILABLE',
      message: 'TradingView did not make chart 1 the active chart; chart 0 is',
      hint:
        'The chart may still be loading, or a dialog may hold the focus. While a chart is ' +
        'maximized, TradingView may maximize the chosen chart instead of making it the active ' +
        'one. pane_list shows which chart is active.',
      details: { chartIndex: 1, activeChartIndex: 0 },
    });
    expect(notFocusedError(2, null).message).toBe(
      'TradingView did not make chart 2 the active chart',
    );
  });
});

describe('the warnings', () => {
  test('chartsNotReadyWarning names the charts whose data did not load', () => {
    expect(chartsNotReadyWarning([1], 1500)).toBe(
      'The data of chart 1 did not load within 1500 ms; it may still be loading. pane_list and ' +
        'chart_get_state show what each chart shows.',
    );
    expect(chartsNotReadyWarning([1, 2], 900)).toMatch(/^The data of charts 1 and 2 did not/);
  });

  test('syncedSymbolsWarning names each chart the layout changed too', () => {
    expect(syncedSymbolsWarning([{ index: 0, from: 'NASDAQ:AAPL', to: 'NASDAQ:NVDA' }])).toBe(
      'The layout changed the symbol of chart 0 too, from NASDAQ:AAPL to NASDAQ:NVDA: it syncs ' +
        'the symbol of its charts. pane_list shows what each chart shows.',
    );
    expect(
      syncedSymbolsWarning([
        { index: 0, from: 'NASDAQ:AAPL', to: 'NASDAQ:NVDA' },
        { index: 2, from: null, to: 'NASDAQ:NVDA' },
      ]),
    ).toBe(
      'The layout changed the symbols of charts 0 and 2 too (chart 0 from NASDAQ:AAPL to ' +
        'NASDAQ:NVDA, chart 2 from a symbol it did not report to NASDAQ:NVDA): it syncs the ' +
        'symbol of its charts. pane_list shows what each chart shows.',
    );
  });

  test('the warnings of pane_list name the chart', () => {
    expect(unreportedPanesWarning(1)).toBe(
      'Chart 1 did not report its panes, so its panes are null.',
    );
    expect(unreportedStudiesWarning(0)).toBe(
      'Chart 0 did not report which studies are in its panes, so their studyIds are null.',
    );
  });
});

describe('symbolChanges', () => {
  test('lists the other charts whose symbol changed, leaving out the chart that was asked for', () => {
    expect(
      symbolChanges(
        ['NASDAQ:AAPL', 'NASDAQ:MSFT', 'NYSE:IBM'],
        ['NASDAQ:NVDA', 'NASDAQ:NVDA', 'NYSE:IBM'],
        1,
      ),
    ).toEqual([{ index: 0, from: 'NASDAQ:AAPL', to: 'NASDAQ:NVDA' }]);
  });

  test('compares only the charts both reads list, and only a symbol reported afterwards counts', () => {
    expect(symbolChanges(['A', null, 'C'], ['A', null], 0)).toEqual([]);
    expect(symbolChanges([], ['A', 'B'], 0)).toEqual([]);
    expect(symbolChanges(['A', 'B'], ['A', null], 0)).toEqual([]);
    expect(symbolChanges(['A', null], ['A', 'B'], 0)).toEqual([{ index: 1, from: null, to: 'B' }]);
  });
});
