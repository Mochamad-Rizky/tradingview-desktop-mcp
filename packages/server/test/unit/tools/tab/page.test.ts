import type { CdpSession } from '../../../../src/core/cdp/types.js';
import type { TvMcpError } from '../../../../src/core/errors.js';
import {
  createPageBridge,
  type PageBridge,
  type PageFunction,
} from '../../../../src/core/tv/page-bridge.js';
import type { TvWindow } from '../../../../src/core/tv/tv-window.js';
import { readTabs, readUnsavedLayout, TAB_STRIP } from '../../../../src/tools/tab/page.js';
import type { JsonValue } from '../../../../src/utils/json.js';
import { failureOf } from '../../../helpers/failure-of.js';
import { createPageRuntime } from '../../../helpers/fake-cdp/runtime.js';
import { loadTvFixture } from '../../../helpers/fake-tv/fixture.js';
import {
  createFakeDomWindow,
  fakeElement,
  type FakeElement,
} from '../../../helpers/fake-tv/dom.js';
import {
  createFakeWindowChrome,
  type FakeWindowChrome,
  type FakeWindowChromeOptions,
} from '../../../helpers/fake-tv/window-chrome.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTradingViewApi,
  type FakeTvWindow,
} from '../../../helpers/fake-tv/window.js';

// The page functions of the tab tools, run the way the server runs them, as source text in a page
// through the real page bridge, and called directly on a second window built the same way, which is
// what the coverage of the module measures. The two answers must agree. readTabs runs in the window
// chrome, readUnsavedLayout in a chart tab. Values are synthetic.

const fixture = loadTvFixture();
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
});

function bridgeTo(win: object): PageBridge {
  const runtime = createPageRuntime(win);
  disposers.push(() => {
    runtime.dispose();
  });
  const send = (method: string, params?: unknown): Promise<unknown> =>
    method === 'Runtime.evaluate'
      ? runtime.evaluate(params as Record<string, unknown>)
      : Promise.reject(new Error(`Unexpected command ${method}`));
  const session: CdpSession = {
    targetId: 'PAGE1',
    isClosed: false,
    send: send as CdpSession['send'],
    onClose: () => undefined,
    close: () => Promise.resolve(),
  };
  return createPageBridge(session, { timeoutMs: 5000 });
}

async function resultOf<A extends JsonValue[], R extends JsonValue | null>(
  fn: PageFunction<A, R>,
  args: A,
  make: () => object,
): Promise<R> {
  const result = await bridgeTo(make()).evaluate(fn, args);
  const direct = await fn(make() as TvWindow, ...args);
  expect(direct).toEqual(result);
  return result;
}

async function failureOfBoth<A extends JsonValue[], R extends JsonValue | null>(
  fn: PageFunction<A, R>,
  args: A,
  make: () => object,
): Promise<TvMcpError> {
  const error = await failureOf(bridgeTo(make()).evaluate(fn, args));
  const direct = await fn(make() as TvWindow, ...args);
  expect(direct).toEqual({ __tvmcpError: error.toPayload() });
  return error;
}

function stripWith(options: Partial<FakeWindowChromeOptions> = {}): FakeWindowChrome {
  return createFakeWindowChrome({
    tabs: [
      { id: A, title: ['AAPL', '123.45', '+0.67%', 'Morning plan'] },
      { id: B, title: ['MSFT', '234.56', '-0.12%', 'Second layout'] },
      { id: C, title: ['New tab'], newTabPage: true },
    ],
    active: B,
    ...options,
  });
}

const strip =
  (options: Partial<FakeWindowChromeOptions> = {}) =>
  (): object =>
    stripWith(options).window;

describe('readTabs', () => {
  const args: [typeof TAB_STRIP] = [TAB_STRIP];

  test('lists the tabs in the order of the strip, with the title as the strip shows it', async () => {
    expect(await resultOf(readTabs, args, strip())).toEqual({
      tabs: [
        {
          id: A,
          title: 'AAPL 123.45 +0.67% Morning plan',
          active: false,
          closable: true,
          showsSymbol: true,
        },
        {
          id: B,
          title: 'MSFT 234.56 -0.12% Second layout',
          active: true,
          closable: true,
          showsSymbol: true,
        },
        { id: C, title: 'New tab', active: false, closable: true, showsSymbol: false },
      ],
    });
  });

  test('says which tabs show their close button, by the rule of the app', async () => {
    const closable = async (options: Partial<FakeWindowChromeOptions>) =>
      (await resultOf(readTabs, args, strip(options))).tabs.map(({ closable: shown }) => shown);

    expect(await closable({ size: 'small' })).toEqual([false, true, false]);
    expect(
      await closable({
        tabs: [
          { id: A, title: ['AAPL'], pinned: true },
          { id: B, title: ['MSFT'] },
        ],
      }),
    ).toEqual([false, true]);
    expect(await closable({ tabs: [{ id: B, title: ['MSFT'] }] })).toEqual([false]);
  });

  test('reads the pieces of a title apart, with white space collapsed', async () => {
    const tabs = [{ id: A, title: ['  AAPL\n', '\t123.45  ', '', 'My   layout '] }];

    expect(await resultOf(readTabs, args, strip({ tabs, active: A }))).toEqual({
      tabs: [
        {
          id: A,
          title: 'AAPL 123.45 My layout',
          active: true,
          closable: false,
          showsSymbol: true,
        },
      ],
    });
  });

  test('lists no tab of a strip that has none', async () => {
    expect(await resultOf(readTabs, args, strip({ tabs: [], active: '' }))).toEqual({ tabs: [] });
  });

  test('gives a tab whose title shows nothing an empty title', async () => {
    const make = (): object => {
      const chrome = stripWith();
      const tab = chrome.state.tabs[0];
      if (tab !== undefined) {
        tab.title = [];
      }
      chrome.render();
      return chrome.window;
    };

    expect((await resultOf(readTabs, args, make)).tabs[0]?.title).toBe('');
  });

  test('reads a title past a node that is neither text nor an element, and gives a tab without a title an empty one', async () => {
    // A comment among the pieces of a title, as a page can have.
    const comment = { nodeType: 8, data: 'a comment' } as unknown as FakeElement;
    const make = () =>
      createFakeDomWindow([
        fakeElement({
          id: A,
          matches: [TAB_STRIP.tabs, TAB_STRIP.activeTab],
          children: [
            fakeElement({
              matches: [TAB_STRIP.title],
              nodes: ['AAPL', comment, fakeElement({ tag: 'span', text: 'Layout' })],
            }),
          ],
        }),
        fakeElement({ id: B, matches: [TAB_STRIP.tabs] }),
      ]);

    expect(await resultOf(readTabs, args, make)).toEqual({
      tabs: [
        { id: A, title: 'AAPL Layout', active: true, closable: false, showsSymbol: false },
        { id: B, title: '', active: false, closable: false, showsSymbol: false },
      ],
    });
  });

  test('says whether each tab shows a symbol, by the length of its symbol alone', async () => {
    const tabs = [
      { id: A, title: ['AAPL', 'Morning plan'] },
      { id: B, title: ['   ', 'Unnamed'] },
      { id: C, title: ['New tab'], newTabPage: true },
    ];

    const { tabs: read } = await resultOf(readTabs, args, strip({ tabs, active: A }));

    expect(read.map(({ showsSymbol }) => showsSymbol)).toEqual([true, false, false]);
  });

  test('reads the DOM only, and nothing of Node, in the window chrome', async () => {
    const chrome = stripWith();

    await bridgeTo(chrome.window).evaluate(readTabs, args);
    readTabs(chrome.window as TvWindow, ...args);

    expect(chrome.nodeAccess).toEqual([]);
  });

  test('fails NOT_AVAILABLE on a page without a DOM', async () => {
    const error = await failureOfBoth(readTabs, args, () => ({
      document: { visibilityState: 'visible' },
    }));

    expect(error.toPayload()).toEqual({
      code: 'NOT_AVAILABLE',
      message: 'The window chrome has no DOM to read the tabs from',
      hint: 'Check app_health: the window of TradingView may still be loading.',
    });
  });
});

describe('readUnsavedLayout', () => {
  const chart =
    (change: (api: FakeTradingViewApi, win: FakeTvWindow) => void = () => undefined) =>
    (): object => {
      const win = createFakeTvWindow(fixture);
      if (win.TradingViewApi !== undefined) {
        change(win.TradingViewApi, win);
      }
      return win;
    };

  test('reads whether the layout has changes that TradingView would ask about before closing', async () => {
    expect(await resultOf(readUnsavedLayout, [], chart())).toEqual({ shouldBeSaved: false });
    expect(
      await resultOf(
        readUnsavedLayout,
        [],
        chart((_api, win) => {
          inspectFakeWindow(win).state.layouts.unsaved = true;
        }),
      ),
    ).toEqual({ shouldBeSaved: true });
  });

  test.each<[string, () => object]>([
    ['a page without the API', () => createFakeTvWindow(fixture, { withoutApi: true })],
    [
      'an API without shouldBeSaved',
      chart((api) => {
        delete api.shouldBeSaved;
      }),
    ],
    [
      'a shouldBeSaved that throws',
      chart((api) => {
        api.shouldBeSaved = () => {
          throw new Error('Not ready');
        };
      }),
    ],
    [
      'a shouldBeSaved that answers no boolean',
      chart((api) => {
        (api as { shouldBeSaved: () => unknown }).shouldBeSaved = () => 'yes';
      }),
    ],
  ])('answers null for %s, which cannot say', async (_case, make) => {
    expect(await resultOf(readUnsavedLayout, [], make)).toEqual({ shouldBeSaved: null });
  });

  test('changes nothing on the chart', async () => {
    const win = createFakeTvWindow(fixture);

    await bridgeTo(win).evaluate(readUnsavedLayout, []);

    expect(inspectFakeWindow(win).calls).toEqual([]);
  });
});
