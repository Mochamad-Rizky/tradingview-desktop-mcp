import type { TvMcpError } from '../../../../src/core/errors.js';
import {
  decodeEntities,
  plotKeys,
  resolveIndicator,
  searchCatalog,
  toStudyInputs,
  toValueRows,
  validateInputs,
  type IndicatorCatalog,
  type InputSpec,
} from '../../../../src/tools/indicator/mappers.js';

// How the indicator tools turn what the app holds into what they report: plot keys, value rows,
// the matches of an indicator search, the indicator a name stands for and the input values a
// change may set. Values are synthetic.

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

describe('resolveIndicator', () => {
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
        id: 'STD;MACD',
        name: 'Moving Average Convergence Divergence',
        shortName: 'MACD',
        version: null,
        isStrategy: false,
      },
      {
        id: 'STD;Volume',
        name: 'Volume Oscillator',
        shortName: 'Volume',
        version: '3.0',
        isStrategy: false,
      },
    ],
    builtins: [
      { id: 'Volume@tv-basicstudies', name: 'Volume', shortName: 'Vol', isStrategy: false },
      { id: 'MACD@tv-pro', name: 'MACD Pro', shortName: 'MACD Pro', isStrategy: false },
    ],
    scriptsError: null,
  };

  test('takes an exact id of a standard script or a visible built-in first', () => {
    expect(resolveIndicator(catalog, 'STD;RSI')).toEqual({
      kind: 'pine',
      id: 'STD;RSI',
      name: 'Relative Strength Index',
      version: '41.0',
    });
    expect(resolveIndicator(catalog, ' Volume@tv-basicstudies ')).toEqual({
      kind: 'builtin',
      id: 'Volume@tv-basicstudies',
      name: 'Volume',
    });
  });

  test('matches a name or short name case aside, Pine scripts before built-ins', () => {
    expect(resolveIndicator(catalog, 'relative strength INDEX')).toMatchObject({ id: 'STD;RSI' });
    expect(resolveIndicator(catalog, 'rsi')).toMatchObject({ id: 'STD;RSI' });
    // The short name of the Pine script wins over the name of the built-in.
    expect(resolveIndicator(catalog, 'volume')).toMatchObject({ kind: 'pine', id: 'STD;Volume' });
    expect(resolveIndicator(catalog, 'vol')).toMatchObject({
      kind: 'builtin',
      id: 'Volume@tv-basicstudies',
    });
    expect(resolveIndicator(catalog, 'macd pro')).toMatchObject({ id: 'MACD@tv-pro' });
  });

  test('gives a script without a version the latest one, and nothing for no match', () => {
    expect(resolveIndicator(catalog, 'MACD')).toEqual({
      kind: 'pine',
      id: 'STD;MACD',
      name: 'Moving Average Convergence Divergence',
      version: 'last',
    });
    expect(resolveIndicator(catalog, 'rs')).toBeNull();
    expect(resolveIndicator(catalog, '  ')).toBeNull();
    expect(
      resolveIndicator({ scripts: null, builtins: null, scriptsError: 'x' }, 'RSI'),
    ).toBeNull();
  });
});

describe('validateInputs', () => {
  const spec = (fields: Partial<InputSpec> & Pick<InputSpec, 'id' | 'type'>): InputSpec => ({
    name: fields.id,
    value: null,
    options: null,
    min: null,
    max: null,
    ...fields,
  });
  const specs: InputSpec[] = [
    spec({ id: 'in_0', name: 'Length', type: 'integer', value: 14, min: 1, max: 100 }),
    spec({ id: 'in_1', name: 'Multiplier', type: 'float', value: 2, min: 0.5 }),
    spec({ id: 'in_2', name: 'Level', type: 'price', value: 10, max: 50 }),
    spec({ id: 'in_3', name: 'Show', type: 'bool', value: true }),
    spec({ id: 'in_4', name: 'Source', type: 'source', value: 'close' }),
    spec({ id: 'in_5', name: 'Type', type: 'text', value: 'SMA', options: ['SMA', 'EMA'] }),
    spec({ id: 'in_6', name: 'Timeframe', type: 'resolution', value: '' }),
    spec({ id: 'in_7', name: 'Session', type: 'session', value: '0930-1600' }),
    spec({ id: 'in_8', name: 'Start', type: 'time', value: 0 }),
    spec({ id: 'in_9', name: 'Step', type: 'integer', value: 1, options: [1, 2, 5] }),
    spec({ id: 'in_10', name: 'Color', type: 'color', value: '#ffffff' }),
    spec({ id: 'in_11', name: 'Mystery', type: 'usertype', value: null }),
  ];
  const failure = (inputs: Record<string, string | number | boolean>): TvMcpError => {
    try {
      validateInputs(specs, inputs);
    } catch (error) {
      return error as TvMcpError;
    }
    throw new Error('Expected validateInputs to throw');
  };

  test('maps keys by id or by name case aside, in the order given', () => {
    expect(
      validateInputs(specs, {
        length: 20,
        in_1: 1.5,
        LEVEL: 50,
        Show: false,
        source: 'hl2',
        Type: 'EMA',
        Timeframe: '60',
        Session: '24x7',
        Start: 1_704_153_600_000,
        Step: 5,
        Color: '#000000',
      }),
    ).toEqual([
      { id: 'in_0', value: 20 },
      { id: 'in_1', value: 1.5 },
      { id: 'in_2', value: 50 },
      { id: 'in_3', value: false },
      { id: 'in_4', value: 'hl2' },
      { id: 'in_5', value: 'EMA' },
      { id: 'in_6', value: '60' },
      { id: 'in_7', value: '24x7' },
      { id: 'in_8', value: 1_704_153_600_000 },
      { id: 'in_9', value: 5 },
      { id: 'in_10', value: '#000000' },
    ]);
    expect(validateInputs(specs, {})).toEqual([]);
  });

  test('reports every problem at once, naming the inputs and the valid ones', () => {
    const error = failure({ Length: 'long', nope: 1, in_3: true });

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toMatch(/Length \(in_0\) must be an integer/);
    expect(error.message).toMatch(/nope is not an input/);
    expect(error.message).toMatch(/in_0 \(Length\), in_1 \(Multiplier\)/);
    expect(error.details).toMatchObject({
      problems: [expect.stringMatching(/Length/), expect.stringMatching(/nope/)],
    });
    expect((error.details?.validInputs as unknown[])[0]).toEqual({
      id: 'in_0',
      name: 'Length',
      type: 'integer',
    });
    expect(error.hint).toMatch(/indicator_list/);
  });

  test.each([
    ['an integer with a fraction', { Length: 1.5 }, /integer/],
    ['an integer below its minimum', { Length: 0 }, /from 1 to 100/],
    ['an integer above its maximum', { Length: 101 }, /from 1 to 100/],
    ['a float below its minimum', { Multiplier: 0.1 }, /at least 0.5/],
    ['a price above its maximum', { Level: 51 }, /at most 50/],
    ['a number that is not finite', { Level: Number.POSITIVE_INFINITY }, /number/],
    ['a number as text', { Multiplier: '2' }, /number/],
    ['a bool as text', { Show: 'yes' }, /true or false/],
    ['text as a number', { Source: 1 }, /text/],
    ['a value outside the options', { Type: 'WMA' }, /one of SMA, EMA/],
    ['a number outside the options', { Step: 3 }, /one of 1, 2, 5/],
    ['a time with a fraction', { Start: 1.5 }, /time/],
    ['a type the tool cannot set', { Mystery: 'x' }, /usertype/],
    ['the same input twice', { Length: 5, in_0: 6 }, /more than once/],
  ])('refuses %s', (_name, inputs, pattern) => {
    expect(failure(inputs).message).toMatch(pattern);
  });

  test('names an input without a name of its own by its id, and a type it does not have as unknown', () => {
    const bare = [spec({ id: 'x', type: '' })];

    expect(() => validateInputs(bare, { x: 1 })).toThrow(
      /x has the type unknown, which this tool cannot set\. The inputs of this indicator are: x$/,
    );
    expect(() => validateInputs([], { x: 1 })).toThrow(/are: none$/);
  });

  test('describes the inputs as the tools report them', () => {
    expect(toStudyInputs(specs.slice(4, 6).concat(specs[9] ?? []))).toEqual([
      { id: 'in_4', name: 'Source', type: 'source', value: 'close', options: null },
      { id: 'in_5', name: 'Type', type: 'text', value: 'SMA', options: ['SMA', 'EMA'] },
      // Options that are not all text are left out, as indicator_list does.
      { id: 'in_9', name: 'Step', type: 'integer', value: 1, options: null },
    ]);
  });
});
