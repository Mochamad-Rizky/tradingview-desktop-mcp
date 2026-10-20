import {
  decodeEntities,
  plotKeys,
  searchCatalog,
  toValueRows,
  type IndicatorCatalog,
} from '../../../../src/tools/indicator/mappers.js';

// How the indicator tools turn what the app holds into what they report: plot keys, value rows and
// the matches of an indicator search. Values are synthetic.

describe('plotKeys', () => {
  test('indicator_get_values keys plots stably and maps NaN to null', () => {
    const plots = [
      { id: 'plot_0', type: 'line' },
      { id: 'plot_1', type: 'line' },
      { id: 'plot_2', type: 'colorer' },
    ];
    const styles = { plot_0: { title: 'EMA' }, plot_1: { title: 'EMA' } };

    const keys = plotKeys(plots, styles);
    const rows = toValueRows([[1_704_153_600, 101.5, Number.NaN, 0]], keys);

    expect(keys).toEqual([
      { index: 0, key: 'EMA' },
      { index: 1, key: 'EMA#2' },
    ]);
    expect(rows).toEqual([
      {
        time: 1_704_153_600,
        timeIso: '2024-01-02T00:00:00Z',
        values: { EMA: 101.5, 'EMA#2': null },
      },
    ]);
    expect(rows[0]?.values).not.toHaveProperty('colorer');
  });

  test('plotKeys falls back to the plot id without a title', () => {
    expect(
      plotKeys(
        [
          { id: 'plot_0', type: 'line' },
          { id: 'plot_1', type: 'shapes' },
        ],
        {
          plot_1: {},
        },
      ),
    ).toEqual([
      { index: 0, key: 'plot_0' },
      { index: 1, key: 'plot_1' },
    ]);
  });

  test('skips every colorer, alertcondition and dataoffset, and keeps the other value plots', () => {
    const types = [
      'line',
      'colorer',
      'bar_colorer',
      'bg_colorer',
      'text_colorer',
      'ohlc_colorer',
      'wick_colorer',
      'border_colorer',
      'up_colorer',
      'down_colorer',
      'shapes',
      'chars',
      'arrows',
      'data',
      'dataoffset',
      'alertcondition',
    ];
    const plots = types.map((type, index) => ({ id: `plot_${String(index)}`, type }));

    expect(plotKeys(plots, {}).map(({ key }) => key)).toEqual([
      'plot_0',
      'plot_10',
      'plot_11',
      'plot_12',
      'plot_13',
    ]);
  });

  test('titles ohlc plots by the bars they draw, numbered when they repeat', () => {
    const plots = ['ohlc_open', 'ohlc_high', 'ohlc_low', 'ohlc_close'].map((type, index) => ({
      id: `plot_${String(index)}`,
      type,
      target: 'plotcandle_0',
    }));

    expect(plotKeys(plots, {}, { plotcandle_0: { title: 'Candles' } })).toEqual([
      { index: 0, key: 'Candles' },
      { index: 1, key: 'Candles#2' },
      { index: 2, key: 'Candles#3' },
      { index: 3, key: 'Candles#4' },
    ]);
    // Without a title for the target, or without a target, the plot id.
    expect(plotKeys(plots.slice(0, 1), {}, {})).toEqual([{ index: 0, key: 'plot_0' }]);
    expect(plotKeys([{ id: 'plot_9', type: 'ohlc_close', target: null }], {}, {})).toEqual([
      { index: 0, key: 'plot_9' },
    ]);
  });

  test('decodes the HTML entities of a title, and numbers past a title that is taken', () => {
    const plots = [
      { id: 'plot_0', type: 'line' },
      { id: 'plot_1', type: 'line' },
      { id: 'plot_2', type: 'line' },
    ];
    const styles = {
      plot_0: { title: 'Up &amp; Down &lt;1&gt; &quot;x&quot; &#39;y&#39; &#x41;' },
      plot_1: { title: 'A#2' },
      plot_2: { title: 'A' },
    };

    expect(plotKeys(plots, styles)).toEqual([
      { index: 0, key: `Up & Down <1> "x" 'y' A` },
      { index: 1, key: 'A#2' },
      { index: 2, key: 'A' },
    ]);
    expect(
      plotKeys(
        [
          { id: 'plot_0', type: 'line' },
          { id: 'plot_1', type: 'line' },
          { id: 'plot_2', type: 'line' },
        ],
        { plot_0: { title: 'A' }, plot_1: { title: 'A#2' }, plot_2: { title: 'A' } },
      ).map(({ key }) => key),
    ).toEqual(['A', 'A#2', 'A#3']);
  });

  test('a blank title counts as none', () => {
    expect(plotKeys([{ id: 'plot_0', type: 'line' }], { plot_0: { title: ' ' } })).toEqual([
      { index: 0, key: 'plot_0' },
    ]);
  });
});

describe('decodeEntities', () => {
  test('leaves unknown entities and plain text as they are', () => {
    expect(decodeEntities('a &nbsp; b &#xZZ; c')).toBe('a &nbsp; b &#xZZ; c');
    expect(decodeEntities('&#128200;')).toBe('\u{1F4C8}');
    expect(decodeEntities('&#99999999;')).toBe('&#99999999;');
  });
});

describe('toValueRows', () => {
  test('reads each value from the slot after the time, and a missing value as null', () => {
    const keys = [
      { index: 0, key: 'A' },
      { index: 2, key: 'B' },
    ];

    expect(toValueRows([[1_704_153_600, 1, 2, null], [1_704_240_000]], keys)).toEqual([
      { time: 1_704_153_600, timeIso: '2024-01-02T00:00:00Z', values: { A: 1, B: null } },
      { time: 1_704_240_000, timeIso: '2024-01-03T00:00:00Z', values: { A: null, B: null } },
    ]);
  });

  test('drops a row without a reportable time', () => {
    expect(
      toValueRows(
        [
          [null, 1],
          [Number.NaN, 2],
        ],
        [{ index: 0, key: 'A' }],
      ),
    ).toEqual([]);
  });
});

describe('searchCatalog', () => {
  const catalog: IndicatorCatalog = {
    scripts: [
      {
        id: 'STD;RSI',
        name: 'Relative Strength Index',
        shortName: 'RSI',
        version: '41.0',
        isStrategy: false,
      },
      {
        id: 'STD;RSI%1Strategy',
        name: 'RSI Strategy',
        shortName: 'RSI Strategy',
        version: '12.0',
        isStrategy: true,
      },
      {
        id: 'STD;MACD',
        name: 'Moving Average Convergence Divergence',
        shortName: 'MACD',
        version: null,
        isStrategy: false,
      },
    ],
    builtins: [
      { id: 'Volume@tv-basicstudies', name: 'Volume', shortName: 'Vol', isStrategy: false },
      { id: 'RSIPro@tv-pro', name: 'Pro Oscillator', shortName: 'RSI Pro', isStrategy: false },
    ],
    scriptsError: null,
  };

  test('matches name or short name case aside, Pine scripts first, then built-ins', () => {
    expect(searchCatalog(catalog, 'rsi', 20)).toEqual([
      {
        name: 'Relative Strength Index',
        shortName: 'RSI',
        id: 'STD;RSI',
        kind: 'pine',
        isStrategy: false,
      },
      {
        name: 'RSI Strategy',
        shortName: 'RSI Strategy',
        id: 'STD;RSI%1Strategy',
        kind: 'pine',
        isStrategy: true,
      },
      {
        name: 'Pro Oscillator',
        shortName: 'RSI Pro',
        id: 'RSIPro@tv-pro',
        kind: 'builtin',
        isStrategy: false,
      },
    ]);
  });

  test('keeps to the limit, trims the query, and finds nothing for a query nothing has', () => {
    expect(searchCatalog(catalog, '  RSI ', 2).map(({ id }) => id)).toEqual([
      'STD;RSI',
      'STD;RSI%1Strategy',
    ]);
    expect(searchCatalog(catalog, 'volume', 20).map(({ kind }) => kind)).toEqual(['builtin']);
    expect(searchCatalog(catalog, 'zzz', 20)).toEqual([]);
  });

  test('searches the built-ins alone when the scripts are missing', () => {
    expect(
      searchCatalog({ scripts: null, builtins: catalog.builtins, scriptsError: 'x' }, 'v', 20),
    ).toEqual([
      {
        name: 'Volume',
        shortName: 'Vol',
        id: 'Volume@tv-basicstudies',
        kind: 'builtin',
        isStrategy: false,
      },
    ]);
    expect(searchCatalog({ scripts: null, builtins: null, scriptsError: 'x' }, 'v', 20)).toEqual(
      [],
    );
  });
});
