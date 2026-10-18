import type { CdpTargetInfo } from '../../../../src/core/cdp/types.js';
import {
  classifyTarget,
  findChartTargets,
  findWindowChromeTarget,
  pickChartTarget,
  type TargetKind,
  type Visibility,
} from '../../../../src/core/cdp/targets.js';
import { TvMcpError } from '../../../../src/core/errors.js';
import { loadTargetsFixture } from '../../../helpers/fake-cdp/targets.js';

// Ids of the target list recorded from TradingView Desktop 3.4.1 (targets.macos-3.4.1.json).
const CHART_ID = 'BBB144A7827AE55CBA0E74986FC9574C';
const WINDOW_CHROME_ID = 'EE67363DAA56C9940A709061CFAA2FFF';
const HELPER_IDS = [
  '0621E0BEA8DA2CEEE3C6E3AFFD3C3229', // tooltip
  'B8F925F86CC032DD97DED7C12AB73A28', // browser-api-container
  'ABC65E8C0B5768A7D97D910867C78382', // drag-service
];
const BLANK_IDS = ['D4FA899CB58B76FCEDDAC2E1E63735B2', '80A80E86AF3E47B46C0E0C0A748CFC57'];
const OTHER_IDS = [
  '45FA12C67FCC102BC635696179137865', // doubleclick iframe
  '359029838B634FA51337C41A946372CD', // reCAPTCHA iframe
  'A0290DCF69763ECAA55FA54875AD50A1', // googlesyndication iframe
  '98698293B7D146D1E80957D68A04BDD7', // service worker
];

const APP_PAGES = 'file:///Applications/TradingView.app/Contents/Resources/app.asar/app';
const WINDOW_CHROME_URL = `${APP_PAGES}/window/index.html?rendererInitialData=%7B%7D`;
const TOOLTIP_URL = `${APP_PAGES}/tooltip/index.html?rendererInitialData=%7B%7D`;
const WINDOWS_APP_PAGES = 'file:///C:/Users/me/AppData/Local/TradingView/resources/app.asar/app';

function target(overrides: Partial<CdpTargetInfo> & { url: string }): CdpTargetInfo {
  return { id: 'T1', type: 'page', title: '', ...overrides };
}

function chartTab(id: string): CdpTargetInfo {
  return target({ id, url: `https://www.tradingview.com/chart/${id}/` });
}

function visibilities(entries: Record<string, Visibility>): ReadonlyMap<string, Visibility> {
  return new Map(Object.entries(entries));
}

// The error a call throws. A call that returns instead fails the test, so every assertion below
// runs against a real error.
function thrownBy(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to throw');
}

test('classifies the observed macOS target list', () => {
  const targets = loadTargetsFixture();
  const idsOfKind = (kind: TargetKind): string[] =>
    targets.filter((candidate) => classifyTarget(candidate) === kind).map(({ id }) => id);

  expect(targets).toHaveLength(11);
  expect(idsOfKind('chart')).toEqual([CHART_ID]);
  expect(idsOfKind('window-chrome')).toEqual([WINDOW_CHROME_ID]);
  expect(idsOfKind('helper')).toEqual(HELPER_IDS);
  expect(idsOfKind('blank')).toEqual(BLANK_IDS);
  // Iframes and the service worker are listed next to the pages, but they are not renderers to
  // drive.
  expect(idsOfKind('other')).toEqual(OTHER_IDS);
});

test.each<[string, Partial<CdpTargetInfo> & { url: string }, TargetKind]>([
  ['a chart on www.tradingview.com', { url: 'https://www.tradingview.com/chart/AbC123/' }, 'chart'],
  ['a chart on the bare domain', { url: 'https://tradingview.com/chart/AbC123/' }, 'chart'],
  ['a chart on a regional subdomain', { url: 'https://in.tradingview.com/chart/AbC123/' }, 'chart'],
  [
    'a chart that opened without a layout',
    { url: 'https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL' },
    'chart',
  ],
  ['a chart over plain http', { url: 'http://www.tradingview.com/chart/AbC123/' }, 'other'],
  [
    'a TradingView page that is not a chart',
    { url: 'https://www.tradingview.com/symbols/NASDAQ-AAPL/' },
    'other',
  ],
  [
    'a host that only starts with the TradingView domain',
    { url: 'https://www.tradingview.com.example.net/chart/AbC123/' },
    'other',
  ],
  [
    'a host that only ends with the TradingView domain',
    { url: 'https://nottradingview.com/chart/AbC123/' },
    'other',
  ],
  [
    'the TradingView chart path on another host',
    { url: 'https://example.net/tradingview.com/chart/AbC123/' },
    'other',
  ],
  [
    'a chart URL carried in the query of another site',
    { url: 'https://example.net/redirect?to=https://www.tradingview.com/chart/AbC123/' },
    'other',
  ],
  [
    'a view-source page of a chart',
    { url: 'view-source:https://www.tradingview.com/chart/AbC123/' },
    'other',
  ],
  [
    'a host that imitates the dot of the domain',
    { url: 'https://www.tradingviewXcom/chart/AbC123/' },
    'other',
  ],
  [
    'a TradingView path that only starts with chart',
    { url: 'https://www.tradingview.com/charts/AbC123/' },
    'other',
  ],
  [
    'a chart URL loaded in an iframe',
    { type: 'iframe', url: 'https://www.tradingview.com/chart/AbC123/' },
    'other',
  ],
  ['the window chrome of macOS', { url: WINDOW_CHROME_URL }, 'window-chrome'],
  [
    'the window chrome of Windows',
    { url: `${WINDOWS_APP_PAGES}/window/index.html?rendererInitialData=%7B%7D` },
    'window-chrome',
  ],
  [
    'a window path served over http',
    { url: 'http://localhost:3000/app/window/index.html' },
    'other',
  ],
  ['a window path loaded in an iframe', { type: 'iframe', url: WINDOW_CHROME_URL }, 'other'],
  ['a tooltip page', { url: TOOLTIP_URL }, 'helper'],
  [
    'a helper page that mentions the window path in its query',
    { url: `${TOOLTIP_URL}&from=/app/window/index.html` },
    'helper',
  ],
  ['a page with an empty URL', { url: '' }, 'blank'],
  ['an empty URL on a worker', { type: 'worker', url: '' }, 'other'],
  ['about:blank', { url: 'about:blank' }, 'other'],
  ['a page of another site', { url: 'https://example.net/' }, 'other'],
  ['a worker script', { type: 'worker', url: 'https://www.tradingview.com/sw.js' }, 'other'],
])('classifyTarget classifies %s', (_label, overrides, expected) => {
  expect(classifyTarget(target(overrides))).toBe(expected);
});

test('findChartTargets returns the chart tab of the observed target list and nothing else', () => {
  expect(findChartTargets(loadTargetsFixture()).map(({ id }) => id)).toEqual([CHART_ID]);
});

test('findChartTargets returns every chart tab in list order', () => {
  const list = [
    chartTab('FIRST'),
    target({ id: 'CHROME', url: WINDOW_CHROME_URL }),
    chartTab('SECOND'),
  ];

  expect(findChartTargets(list).map(({ id }) => id)).toEqual(['FIRST', 'SECOND']);
});

test('findChartTargets returns an empty list when no chart tab is open', () => {
  const list = loadTargetsFixture().filter(({ id }) => id !== CHART_ID);

  expect(findChartTargets(list)).toEqual([]);
});

test('findWindowChromeTarget returns the window chrome of the observed target list', () => {
  expect(findWindowChromeTarget(loadTargetsFixture())?.id).toBe(WINDOW_CHROME_ID);
});

test('findWindowChromeTarget returns undefined when the list has no window chrome', () => {
  const list = loadTargetsFixture().filter(({ id }) => id !== WINDOW_CHROME_ID);

  expect(findWindowChromeTarget(list)).toBeUndefined();
  expect(findWindowChromeTarget([])).toBeUndefined();
});

test('pickChartTarget returns the sole candidate without visibility data', () => {
  const only = chartTab('ONLY');

  expect(pickChartTarget([only], new Map())).toBe(only);
});

test('pickChartTarget returns the sole candidate even when it reports hidden', () => {
  const only = chartTab('ONLY');

  expect(pickChartTarget([only], visibilities({ ONLY: 'hidden' }))).toBe(only);
});

test('pickChartTarget prefers the visible target', () => {
  const first = chartTab('FIRST');
  const second = chartTab('SECOND');
  const third = chartTab('THIRD');

  expect(
    pickChartTarget([first, second], visibilities({ FIRST: 'hidden', SECOND: 'visible' })),
  ).toBe(second);
  expect(
    pickChartTarget([second, first], visibilities({ FIRST: 'visible', SECOND: 'hidden' })),
  ).toBe(first);
  // A tab whose state could not be read does not compete with the one that is visible.
  expect(
    pickChartTarget(
      [first, second, third],
      visibilities({ FIRST: 'unknown', SECOND: 'hidden', THIRD: 'visible' }),
    ),
  ).toBe(third);
});

test('pickChartTarget throws TARGET_NOT_FOUND when no chart target exists', () => {
  const error = thrownBy(() => pickChartTarget([], new Map()));

  expect(error).toBeInstanceOf(TvMcpError);
  expect(error).toMatchObject({ code: 'TARGET_NOT_FOUND' });
  expect((error as TvMcpError).hint).toMatch(/open a chart tab/i);
});

test('pickChartTarget throws TARGET_NOT_FOUND listing tabs when several are visible or none is', () => {
  const first = chartTab('FIRST');
  const second = chartTab('SECOND');
  const listedTabs = {
    tabs: [
      { id: 'FIRST', url: first.url },
      { id: 'SECOND', url: second.url },
    ],
  };

  const severalVisible = thrownBy(() =>
    pickChartTarget([first, second], visibilities({ FIRST: 'visible', SECOND: 'visible' })),
  );
  const noneVisible = thrownBy(() =>
    pickChartTarget([first, second], visibilities({ FIRST: 'hidden', SECOND: 'hidden' })),
  );

  for (const error of [severalVisible, noneVisible]) {
    expect(error).toBeInstanceOf(TvMcpError);
    expect(error).toMatchObject({ code: 'TARGET_NOT_FOUND', details: listedTabs });
    expect((error as TvMcpError).hint).toMatch(/focus/i);
  }
});

test.each<[string, Record<string, Visibility>]>([
  ['no tab has visibility data', {}],
  ['every tab reports unknown', { FIRST: 'unknown', SECOND: 'unknown' }],
  ['one tab is hidden and the other is unknown', { FIRST: 'hidden', SECOND: 'unknown' }],
])('pickChartTarget does not guess between tabs when %s', (_label, states) => {
  const error = thrownBy(() =>
    pickChartTarget([chartTab('FIRST'), chartTab('SECOND')], visibilities(states)),
  );

  expect(error).toMatchObject({ code: 'TARGET_NOT_FOUND' });
});

test('pickChartTarget lists every tab when three are open and two are visible', () => {
  const tabs = [chartTab('A'), chartTab('B'), chartTab('C')];

  const error = thrownBy(() =>
    pickChartTarget(tabs, visibilities({ A: 'visible', B: 'hidden', C: 'visible' })),
  );

  expect(error).toMatchObject({
    code: 'TARGET_NOT_FOUND',
    details: { tabs: tabs.map(({ id, url }) => ({ id, url })) },
  });
});
