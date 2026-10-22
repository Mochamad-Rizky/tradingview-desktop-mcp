import type { CdpTargetInfo } from '../../../../src/core/cdp/types.js';
import {
  classifyTarget,
  findChartTargets,
  findNewTabPages,
  findWindowChromeTarget,
  isEveryChartTabHidden,
  isNewTabPage,
  isNoChartInFrontError,
  isTradingViewUserAgent,
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
// TradingView's local New tab page, the start page a new tab opens on (notes of Plan 3, section
// 3.2).
const NEW_TAB_URL = `${APP_PAGES}/new-tab/index.html`;
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

test.each<[string, Partial<CdpTargetInfo> & { url: string }, boolean]>([
  ['the New tab page of macOS', { url: NEW_TAB_URL }, true],
  ['the New tab page of Windows', { url: `${WINDOWS_APP_PAGES}/new-tab/index.html` }, true],
  ['the New tab page with a query', { url: `${NEW_TAB_URL}?rendererInitialData=%7B%7D` }, true],
  [
    'a New tab path served over http',
    { url: 'http://localhost:3000/app/new-tab/index.html' },
    false,
  ],
  ['a New tab path loaded in an iframe', { type: 'iframe', url: NEW_TAB_URL }, false],
  [
    'a helper page that mentions the New tab path in its query',
    { url: `${TOOLTIP_URL}&from=/app/new-tab/index.html` },
    false,
  ],
  ['the window chrome', { url: WINDOW_CHROME_URL }, false],
  ['a tooltip page', { url: TOOLTIP_URL }, false],
  ['a chart', { url: 'https://www.tradingview.com/chart/AbC123/' }, false],
  ['a page with an empty URL', { url: '' }, false],
])('isNewTabPage tells %s', (_label, overrides, expected) => {
  expect(isNewTabPage(target(overrides))).toBe(expected);
});

test('a New tab page is still a helper page to classifyTarget, and none is a chart tab', () => {
  const page = target({ id: 'NEWTAB', url: NEW_TAB_URL });

  expect(classifyTarget(page)).toBe('helper');
  expect(findChartTargets([page])).toEqual([]);
});

test('findNewTabPages returns every New tab page in list order, and none of the observed list', () => {
  const list = [
    target({ id: 'FIRST', url: NEW_TAB_URL }),
    chartTab('CHART'),
    target({ id: 'CHROME', url: WINDOW_CHROME_URL }),
    target({ id: 'SECOND', url: `${NEW_TAB_URL}?x=1` }),
  ];

  expect(findNewTabPages(list).map(({ id }) => id)).toEqual(['FIRST', 'SECOND']);
  expect(findNewTabPages(loadTargetsFixture())).toEqual([]);
});

describe('pickChartTarget while a New tab page is open', () => {
  // The window chrome reports itself visible while the window is in view.
  const inView = { newTabPageOpen: true, chromeVisibility: 'visible' } as const;

  test('reads even a lone tab, and takes it when it reports visible', () => {
    const only = chartTab('ONLY');

    expect(pickChartTarget([only], visibilities({ ONLY: 'visible' }), inView)).toBe(only);
    expect(
      pickChartTarget([only], visibilities({ ONLY: 'visible' }), { newTabPageOpen: true }),
    ).toBe(only);
  });

  test.each<[string, Visibility | undefined]>([
    ['hidden', 'hidden'],
    ['unknown', 'unknown'],
    ['not read', undefined],
  ])(
    'refuses a lone tab that is %s while the window is in view: the active tab shows no chart',
    (_label, state) => {
      const only = chartTab('ONLY');

      const error = thrownBy(() =>
        pickChartTarget([only], visibilities(state === undefined ? {} : { ONLY: state }), inView),
      );

      expect(error).toBeInstanceOf(TvMcpError);
      expect(error).toMatchObject({
        code: 'TARGET_NOT_FOUND',
        message: 'The active tab of TradingView shows no chart',
        details: {
          newTabPage: true,
          tabs: [{ id: 'ONLY', url: only.url, visibility: state ?? 'unknown' }],
        },
      });
      expect((error as TvMcpError).hint).toMatch(/tab_switch/);
      expect(isNoChartInFrontError(error)).toBe(true);
    },
  );

  test.each<[string, Visibility | undefined]>([
    ['hidden', 'hidden'],
    ['unknown', 'unknown'],
    ['not read', undefined],
  ])(
    'takes a lone tab that is %s while the window is covered, minimized or cannot say: then visibility tells nothing about the tab in front',
    (_label, state) => {
      const only = chartTab('ONLY');
      const seen = visibilities(state === undefined ? {} : { ONLY: state });

      expect(
        pickChartTarget([only], seen, { newTabPageOpen: true, chromeVisibility: 'hidden' }),
      ).toBe(only);
      expect(
        pickChartTarget([only], seen, { newTabPageOpen: true, chromeVisibility: 'unknown' }),
      ).toBe(only);
      expect(pickChartTarget([only], seen, { newTabPageOpen: true })).toBe(only);
    },
  );

  test('refuses when no chart tab is open at all', () => {
    const error = thrownBy(() => pickChartTarget([], new Map(), { newTabPageOpen: true }));

    expect(error).toMatchObject({
      code: 'TARGET_NOT_FOUND',
      details: { newTabPage: true, tabs: [] },
    });
    expect(isNoChartInFrontError(error)).toBe(true);
  });

  test('takes the only visible one of several tabs, and refuses when none is', () => {
    const first = chartTab('FIRST');
    const second = chartTab('SECOND');

    expect(
      pickChartTarget(
        [first, second],
        visibilities({ FIRST: 'hidden', SECOND: 'visible' }),
        inView,
      ),
    ).toBe(second);
    const error = thrownBy(() =>
      pickChartTarget([first, second], visibilities({ FIRST: 'hidden', SECOND: 'hidden' }), inView),
    );
    // A window chrome that cannot say keeps that refusal too.
    expect(
      thrownBy(() =>
        pickChartTarget([first, second], visibilities({ FIRST: 'hidden', SECOND: 'hidden' }), {
          newTabPageOpen: true,
          chromeVisibility: 'unknown',
        }),
      ),
    ).toMatchObject({ message: 'The active tab of TradingView shows no chart' });
    expect(error).toMatchObject({
      code: 'TARGET_NOT_FOUND',
      details: {
        newTabPage: true,
        tabs: [
          { id: 'FIRST', url: first.url, visibility: 'hidden' },
          { id: 'SECOND', url: second.url, visibility: 'hidden' },
        ],
      },
    });
  });

  test('refuses several visible tabs as without a New tab page: it is unclear which one to use', () => {
    const tabs = [chartTab('FIRST'), chartTab('SECOND')];

    const error = thrownBy(() =>
      pickChartTarget(tabs, visibilities({ FIRST: 'visible', SECOND: 'visible' }), inView),
    );

    expect(error).toMatchObject({
      code: 'TARGET_NOT_FOUND',
      details: { tabs: tabs.map(({ id, url }) => ({ id, url })) },
    });
    expect(isNoChartInFrontError(error)).toBe(false);
  });
});

describe('pickChartTarget while the window is out of view', () => {
  // Covered by other windows or minimized: every page of the window reports hidden, the window
  // chrome too.
  const covered = { chromeVisibility: 'hidden' } as const;

  test.each([false, true])(
    'refuses several hidden tabs saying the window is covered or minimized (New tab page open: %s)',
    (newTabPageOpen) => {
      const tabs = [chartTab('FIRST'), chartTab('SECOND')];

      const error = thrownBy(() =>
        pickChartTarget(tabs, visibilities({ FIRST: 'hidden', SECOND: 'unknown' }), {
          ...covered,
          newTabPageOpen,
        }),
      );

      expect(error).toBeInstanceOf(TvMcpError);
      expect(error).toMatchObject({
        code: 'TARGET_NOT_FOUND',
        message: "TradingView's window is covered or minimized, so the tab in front cannot be told",
        details: { tabs: tabs.map(({ id, url }) => ({ id, url })) },
      });
      expect((error as TvMcpError).hint).toMatch(/Bring TradingView to the front/);
      expect((error as TvMcpError).hint).toMatch(/one chart tab/);
      expect(isNoChartInFrontError(error)).toBe(false);
    },
  );

  test("keeps Plan 1's message when the window chrome reports itself visible or cannot say", () => {
    const tabs = [chartTab('FIRST'), chartTab('SECOND')];
    const hidden = visibilities({ FIRST: 'hidden', SECOND: 'hidden' });

    for (const chromeVisibility of ['visible', 'unknown'] as const) {
      expect(thrownBy(() => pickChartTarget(tabs, hidden, { chromeVisibility }))).toMatchObject({
        code: 'TARGET_NOT_FOUND',
        message: '2 chart tabs are open and it is unclear which one to use',
      });
    }
  });

  test('leaves alone a lone tab without a New tab page, a visible tab, and several visible tabs', () => {
    const only = chartTab('ONLY');
    const first = chartTab('FIRST');
    const second = chartTab('SECOND');

    expect(pickChartTarget([only], visibilities({ ONLY: 'hidden' }), covered)).toBe(only);
    expect(
      pickChartTarget(
        [first, second],
        visibilities({ FIRST: 'hidden', SECOND: 'visible' }),
        covered,
      ),
    ).toBe(second);
    expect(
      thrownBy(() =>
        pickChartTarget(
          [first, second],
          visibilities({ FIRST: 'visible', SECOND: 'visible' }),
          covered,
        ),
      ),
    ).toMatchObject({ message: '2 chart tabs are open and it is unclear which one to use' });
  });
});

test('isNoChartInFrontError tells the refusal of a New tab page in front from every other error', () => {
  const unclear = thrownBy(() =>
    pickChartTarget([chartTab('A'), chartTab('B')], visibilities({ A: 'hidden', B: 'hidden' })),
  );
  const none = thrownBy(() => pickChartTarget([], new Map()));

  for (const other of [
    unclear,
    none,
    new TvMcpError('NOT_AVAILABLE', 'x', { details: { newTabPage: true } }),
    new Error('The active tab of TradingView shows no chart'),
    { code: 'TARGET_NOT_FOUND', details: { newTabPage: true } },
    undefined,
  ]) {
    expect(isNoChartInFrontError(other)).toBe(false);
  }
});

test('isEveryChartTabHidden tells a refusal whose chart tabs all reported hidden from one that has a tab it could not read', () => {
  const refusal = (states: Record<string, Visibility>) =>
    thrownBy(() =>
      pickChartTarget(Object.keys(states).map(chartTab), visibilities(states), {
        newTabPageOpen: true,
        chromeVisibility: 'visible',
      }),
    ) as TvMcpError;

  expect(isEveryChartTabHidden(refusal({ A: 'hidden', B: 'hidden' }))).toBe(true);
  expect(isEveryChartTabHidden(refusal({}))).toBe(true);
  expect(isEveryChartTabHidden(refusal({ A: 'hidden', B: 'unknown' }))).toBe(false);
  // An error that lists no tabs, or lists them in another shape, says nothing about them.
  expect(isEveryChartTabHidden(new TvMcpError('TARGET_NOT_FOUND', 'x'))).toBe(false);
  expect(
    isEveryChartTabHidden(
      new TvMcpError('TARGET_NOT_FOUND', 'x', { details: { tabs: ['A', null, [1]] } }),
    ),
  ).toBe(false);
});

// The user agent /json/version reports. TradingView Desktop names itself in it twice; a browser that
// holds the debug port instead, Chrome or another one built on Chromium, names neither.
test.each([
  [
    'TradingView Desktop 3.4.1 on macOS',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) TradingView/3.4.1 Chrome/146.0.7680.216 Electron/41.7.1 Safari/537.36 TVDesktop/3.4.1',
  ],
  ['a build that keeps only the app name', 'Mozilla/5.0 TradingView/4.0.0 Chrome/150.0.0.0'],
  ['a build that keeps only the desktop name', 'Mozilla/5.0 Chrome/150.0.0.0 TVDesktop/4.0.0'],
])('isTradingViewUserAgent recognizes %s', (_case, userAgent) => {
  expect(isTradingViewUserAgent(userAgent)).toBe(true);
});

test.each([
  [
    'Chrome',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.216 Safari/537.36',
  ],
  [
    'Edge',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0',
  ],
  ['another Electron app', 'Mozilla/5.0 Chrome/146.0.0.0 Electron/41.7.1 Safari/537.36 Slack/4.0'],
  ['an empty user agent', ''],
  ['the name without a version', 'Mozilla/5.0 TradingView Chrome/146.0.0.0'],
  ['the name inside another word', 'Mozilla/5.0 NotTradingView/1.0 MyTVDesktop/1.0'],
])('isTradingViewUserAgent does not take %s for TradingView', (_case, userAgent) => {
  expect(isTradingViewUserAgent(userAgent)).toBe(false);
});
