import {
  FIXTURE_CHART_TITLE,
  FIXTURE_LAYOUT_ID,
  FIXTURE_LAYOUT_NAME,
  FIXTURE_SEED,
  FIXTURE_SYMBOL,
  findLeaks,
  scrubFixture,
  scrubTargets,
  toStateFixture,
} from '../../../scripts/re/scrub.js';
import type { JsonObject, JsonValue } from '../../../src/utils/json.js';
import { syntheticBars } from '../../helpers/fake-tv/synthetic-bars.js';

// The scrubber turns a recording of the user's chart into a fixture that may be committed: no
// personal data, the identity of NASDAQ:AAPL instead of the recorded symbol, and synthetic prices
// instead of recorded ones. Every input here is made up.

const DAY = 86_400;
const START = 1_700_000_000;

// Three daily bars with a weekend between the second and the third, priced like a real stock.
const REAL_BARS: JsonValue[] = [
  [START, 705.5, 710, 700.25, 708, 1_234_567],
  [START + DAY, 708, 712.75, 706, 711.5, 2_345_678],
  [START + 4 * DAY, 711.5, 715, 709, 713.25, 3_456_789],
];

function recording(overrides: JsonObject = {}): JsonObject {
  return {
    buildTime: '2026-10-16T17:55:37',
    symbol: 'XAMS_DLY:ZZTEST',
    resolution: '1D',
    chartType: 1,
    visibleRange: { from: START + DAY - 7200, to: START + 90 * DAY },
    studies: [
      { id: 'q1W2e3', name: 'Moving Average Exponential', plots: ['plot_0'] },
      { id: 'r4T5y6', name: 'My Secret Edge v2', plots: ['plot_0', 'plot_1'] },
    ],
    shapes: [
      { id: 'aB3dE9', name: 'text', text: 'entry 705', points: [{ time: START, price: 705 }] },
      { id: 'fG7hJ1', name: 'horizontal_line', properties: { text: 'stop 690' } },
      { id: 'kL2mN4', name: 'Custom Thing!' },
    ],
    layout: { type: 's', chartsCount: 1, name: 'My Layout', id: 'abc123' },
    intervals: ['1', '5', '60', '1D'],
    symbolInfo: {
      name: 'ZZTEST',
      full_name: 'XAMS_DLY:ZZTEST',
      pro_name: 'XAMS:ZZTEST',
      description: 'Zz Test Holding N.V.',
      exchange: 'XAMS',
      isin: 'NL0000000001',
      currency_code: 'EUR',
      timezone: 'Europe/Amsterdam',
      has_intraday: true,
      is_replayable: false,
      bar_source: 'trade',
      some_new_field: 'ZZTEST at XAMS',
    },
    quote: {
      last_price: 713.25,
      bid: 713.2,
      ask: 713.3,
      change: 1.75,
      volume: 3_456_789,
      market_cap_basic: 987_654_321,
    },
    bars: REAL_BARS,
    user: { username: 'someone', email: 'someone@example.com', id: 4242 },
    username: 'someone',
    is_authenticated: true,
    ...overrides,
  };
}

function asObject(value: JsonValue | undefined): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected an object, got ${JSON.stringify(value)}`);
  }
  return value;
}

function asArray(value: JsonValue | undefined): JsonValue[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected an array, got ${JSON.stringify(value)}`);
  }
  return value;
}

describe('scrubFixture', () => {
  it('scrubFixture removes personal data and real prices', () => {
    const scrubbed = scrubFixture(recording());

    expect(scrubbed.layout).toEqual({
      type: 's',
      chartsCount: 1,
      name: FIXTURE_LAYOUT_NAME,
      id: FIXTURE_LAYOUT_ID,
    });
    expect(FIXTURE_LAYOUT_NAME).toBe('Fixture Layout');
    expect(FIXTURE_LAYOUT_ID).toBe('FIXTURE1');
    const text = JSON.stringify(scrubbed);
    expect(text).not.toContain('My Layout');
    expect(text).not.toContain('abc123');
    expect(text).not.toContain('entry 705');
    expect(text).not.toContain('stop 690');
    // One day is the shortest gap between the recorded bars; the weekend does not count.
    expect(scrubbed.bars).toEqual(
      syntheticBars({ count: 3, startTime: START, stepSeconds: DAY, seed: FIXTURE_SEED }),
    );
    // The prices with decimals are distinctive enough to search the whole fixture for.
    for (const price of ['705.5', '700.25', '712.75', '711.5', '713.25']) {
      expect(text).not.toContain(price);
    }
  });

  it('removes account fields and keeps only the fields of a fixture', () => {
    const scrubbed = scrubFixture(recording());

    expect(Object.keys(scrubbed).sort()).toEqual(
      [
        'bars',
        'buildTime',
        'chartType',
        'intervals',
        'layout',
        'quote',
        'resolution',
        'shapes',
        'studies',
        'symbol',
        'symbolInfo',
        'visibleRange',
      ].sort(),
    );
    const text = JSON.stringify(scrubbed);
    expect(text).not.toContain('someone');
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('is_authenticated');
  });

  it('replaces the symbol identity with the one of NASDAQ:AAPL', () => {
    const scrubbed = scrubFixture(recording());
    const info = asObject(scrubbed.symbolInfo);

    expect(scrubbed.symbol).toBe(FIXTURE_SYMBOL);
    expect(FIXTURE_SYMBOL).toBe('NASDAQ:AAPL');
    expect(info).toMatchObject({
      name: 'AAPL',
      full_name: 'NASDAQ:AAPL',
      pro_name: 'NASDAQ:AAPL',
      description: 'Apple Inc.',
      exchange: 'NASDAQ',
      isin: 'US0378331005',
      currency_code: 'USD',
      timezone: 'America/New_York',
    });
    // Flags that say nothing about which symbol it is are kept as recorded.
    expect(info).toMatchObject({ has_intraday: true, is_replayable: false, bar_source: 'trade' });
    // A field the scrubber does not know could name the symbol, so it is left out.
    expect(info).not.toHaveProperty('some_new_field');
    expect(findLeaks(scrubbed, ['ZZTEST', 'XAMS', 'Zz Test Holding', 'NL0000000001'])).toEqual([]);
  });

  it('derives the quote from the synthetic bars and drops the other recorded quote fields', () => {
    const scrubbed = scrubFixture(recording());
    const bars = syntheticBars({
      count: 3,
      startTime: START,
      stepSeconds: DAY,
      seed: FIXTURE_SEED,
    });
    const [lastTime, lastOpen, lastHigh, lastLow, lastClose, lastVolume] = bars[2] ?? [];
    const previousClose = bars[1]?.[4];

    expect(scrubbed.quote).toMatchObject({
      last_price: lastClose,
      open_price: lastOpen,
      high_price: lastHigh,
      low_price: lastLow,
      prev_close_price: previousClose,
      volume: lastVolume,
      lp_time: lastTime,
      currency_code: 'USD',
    });
    expect(asObject(scrubbed.quote)).not.toHaveProperty('market_cap_basic');
  });

  it('keeps only the id and the type of a drawing, with ids of its own', () => {
    const scrubbed = scrubFixture(recording());

    expect(scrubbed.shapes).toEqual([
      { id: 'SHAPE01', name: 'text' },
      { id: 'SHAPE02', name: 'horizontal_line' },
      // A name that is not a tool type could be text someone wrote.
      { id: 'SHAPE03', name: 'shape' },
    ]);
  });

  it('keeps the names of built-in studies and hides the names of the others', () => {
    const scrubbed = scrubFixture(recording());

    expect(scrubbed.studies).toEqual([
      { id: 'STUDY01', name: 'Moving Average Exponential', plots: ['plot_0'] },
      { id: 'STUDY02', name: 'Study 2', plots: ['plot_0', 'plot_1'] },
    ]);
  });

  it('moves the visible range onto the synthetic bars at the same places', () => {
    const scrubbed = scrubFixture(recording());
    const bars = syntheticBars({
      count: 3,
      startTime: START,
      stepSeconds: DAY,
      seed: FIXTURE_SEED,
    });

    // The recorded range starts two hours before the second bar (the day of the bar, as the chart
    // reports it) and ends past the last bar, which is as far as a fixture reaches.
    expect(scrubbed.visibleRange).toEqual({ from: bars[1]?.[0], to: bars[2]?.[0] });
  });

  it('is deterministic and leaves its input alone', () => {
    const input = recording();
    const copy = structuredClone(input);

    expect(scrubFixture(input)).toEqual(scrubFixture(structuredClone(input)));
    expect(input).toEqual(copy);
  });

  it('copes with a recording without bars', () => {
    const scrubbed = scrubFixture(recording({ bars: [] }));

    expect(scrubbed.bars).toEqual([]);
    expect(scrubbed.visibleRange).toEqual({ from: 0, to: 0 });
    expect(asArray(scrubbed.studies)).toHaveLength(2);
  });
});

describe('toStateFixture', () => {
  it('turns a scrubbed recording into a fixture the fake window loads, with bars as a spec', () => {
    const fixture = toStateFixture(scrubFixture(recording()));

    expect(fixture.bars).toEqual({
      count: 3,
      startTime: START,
      stepSeconds: DAY,
      seed: FIXTURE_SEED,
    });
    expect(fixture.layout).toEqual({
      type: 's',
      chartsCount: 1,
      name: FIXTURE_LAYOUT_NAME,
      id: FIXTURE_LAYOUT_ID,
    });
    expect(fixture.symbol).toBe(FIXTURE_SYMBOL);
    expect(fixture.knownSymbols).toContain(FIXTURE_SYMBOL);
  });

  it('refuses bars that are not the synthetic ones, so a recording cannot skip the scrubber', () => {
    expect(() => toStateFixture({ ...scrubFixture(recording()), bars: REAL_BARS })).toThrow(
      /not the synthetic bars/,
    );
  });
});

describe('scrubTargets', () => {
  const targets: JsonValue[] = [
    {
      id: 'EE67363DAA56C9940A709061CFAA2FFF',
      type: 'page',
      title:
        'index.html?rendererInitialData=%7B&quot;remoteServiceInstanceId&quot;%3A&quot;c0ffee12-tvd%3Atabbed-window&quot;%7D',
      url: 'file:///Applications/TradingView.app/Contents/Resources/app.asar/app/window/index.html?rendererInitialData=%7B%22remoteServiceInstanceId%22%3A%22c0ffee12-tvd%3Atabbed-window%22%7D',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/EE67363DAA56C9940A709061CFAA2FFF',
      devtoolsFrontendUrl: '/devtools/inspector.html?ws=127.0.0.1:9222/devtools/page/EE67',
    },
    {
      id: 'BBB144A7827AE55CBA0E74986FC9574C',
      type: 'page',
      title: 'ZZTEST 713.25 ▲ +0.25% My Layout',
      url: 'https://www.tradingview.com/chart/Qw3rTy12/',
    },
    {
      id: '45FA12C67FCC102BC635696179137865',
      type: 'iframe',
      title:
        'https://cm.g.doubleclick.net/partnerpixels?url=https%3A%2F%2Fwww.tradingview.com%2Fchart%2FQw3rTy12%2F',
      url: 'https://cm.g.doubleclick.net/partnerpixels?url=https%3A%2F%2Fwww.tradingview.com%2Fchart%2FQw3rTy12%2F',
      parentId: 'BBB144A7827AE55CBA0E74986FC9574C',
    },
  ];

  it('replaces the layout id, the title of the chart tab and the instance id of the window', () => {
    const scrubbed = scrubTargets(targets, 'Qw3rTy12');
    const text = JSON.stringify(scrubbed);

    expect(text).not.toContain('Qw3rTy12');
    expect(text).not.toContain('c0ffee12');
    expect(text).not.toContain('ZZTEST');
    expect(text).not.toContain('My Layout');
    expect(scrubbed[1]).toEqual({
      id: 'BBB144A7827AE55CBA0E74986FC9574C',
      type: 'page',
      title: FIXTURE_CHART_TITLE,
      url: `https://www.tradingview.com/chart/${FIXTURE_LAYOUT_ID}/`,
    });
    expect(asObject(scrubbed[0]).url).toContain('fixture-tvd%3Atabbed-window');
    expect(asObject(scrubbed[0]).title).toContain('fixture-tvd%3Atabbed-window');
    expect(asObject(scrubbed[2]).url).toContain(`%2Fchart%2F${FIXTURE_LAYOUT_ID}%2F`);
    expect(asObject(scrubbed[2]).parentId).toBe('BBB144A7827AE55CBA0E74986FC9574C');
  });

  it('drops the debugger addresses, which a fake server fills in itself', () => {
    const scrubbed = scrubTargets(targets, 'Qw3rTy12');

    expect(Object.keys(asObject(scrubbed[0])).sort()).toEqual(['id', 'title', 'type', 'url']);
  });
});

describe('findLeaks', () => {
  it('names each identifying text that is still in a value, whatever its case', () => {
    const value: JsonValue = { a: ['nothing here', { b: 'the zztest layout' }] };

    expect(findLeaks(value, ['ZZTEST', 'abc123', 'ZZTEST'])).toEqual(['ZZTEST']);
  });

  it('ignores texts too short to tell apart from ordinary words', () => {
    expect(findLeaks({ a: 'generic' }, ['GE', ' '])).toEqual([]);
  });
});
