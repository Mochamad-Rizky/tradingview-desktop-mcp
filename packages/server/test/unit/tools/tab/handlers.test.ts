import { setImmediate as settle } from 'node:timers/promises';
import type { CdpSession, CdpTargetInfo } from '../../../../src/core/cdp/types.js';
import type { ConnectionManager, PageHandle } from '../../../../src/core/connection.js';
import { TvMcpError } from '../../../../src/core/errors.js';
import { createPageBridge } from '../../../../src/core/tv/page-bridge.js';
import { tabClose, tabNew, tabSwitch } from '../../../../src/tools/tab/index.js';
import type { ToolContext } from '../../../../src/tools/types.js';
import { failureOf } from '../../../helpers/failure-of.js';
import { layoutMetrics, layoutSizeOf } from '../../../helpers/fake-cdp/layout.js';
import { createPageRuntime } from '../../../helpers/fake-cdp/runtime.js';
import {
  createFakeWindowChrome,
  type FakeWindowChrome,
} from '../../../helpers/fake-tv/window-chrome.js';
import { createTestContext } from '../../../helpers/tool-context.js';

// The handlers of the tab tools against a connection whose answers a test chooses, for what the fake
// debug port cannot stage: a target list that cannot be read for a while, and a chart tab that
// cannot be reached. The window chrome is the fake strip, run through the real page bridge. Values
// are synthetic.

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const OPENED = '44444444-4444-4444-8444-444444444444';
const NEW_TAB_PAGE: CdpTargetInfo = {
  id: 'NEWTAB',
  type: 'page',
  title: 'index.html',
  url: 'file:///Applications/TradingView.app/Contents/Resources/app.asar/app/new-tab/index.html',
};

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
});

// A page handle to the fake strip: page functions run in it, its layout is answered from its
// window, and its mouse events go to the shell.
function chromePage(chrome: FakeWindowChrome): PageHandle {
  const runtime = createPageRuntime(chrome.window);
  disposers.push(() => {
    runtime.dispose();
  });
  const send = (method: string, params?: unknown): Promise<unknown> => {
    if (method === 'Runtime.evaluate') {
      return runtime.evaluate(params as Record<string, unknown>);
    }
    if (method === 'Page.getLayoutMetrics') {
      return Promise.resolve(layoutMetrics(layoutSizeOf(chrome.window)));
    }
    if (method === 'Input.dispatchMouseEvent') {
      chrome.dispatchMouseEvent(params);
    }
    return Promise.resolve({});
  };
  const session: CdpSession = {
    targetId: 'CHROME',
    isClosed: false,
    send: send as CdpSession['send'],
    onClose: () => undefined,
    close: () => Promise.resolve(),
  };
  return {
    target: {
      id: 'CHROME',
      type: 'page',
      title: 'index.html',
      url: 'file:///app/window/index.html',
    },
    session,
    bridge: createPageBridge(session, { timeoutMs: 5000 }),
  };
}

function contextWith(connection: Partial<ConnectionManager>): ToolContext {
  return {
    ...createTestContext(),
    connection: { reset: () => Promise.resolve(), ...connection } as ConnectionManager,
    registry: { list: () => [], call: () => Promise.reject(new Error('No registry here')) },
  };
}

test('tab_new waits on while the targets cannot be listed, and finds the page of the new tab once they can', async () => {
  const chrome = createFakeWindowChrome({
    tabs: [{ id: A, title: ['AAPL'] }],
    active: A,
    newTabIds: [OPENED],
  });
  let listings = 0;
  const ctx = contextWith({
    windowChromePage: () => Promise.resolve(chromePage(chrome)),
    targets: () => {
      listings += 1;
      // The first listing is before the click; the next two fail, as a debug port that is busy.
      if (listings === 2 || listings === 3) {
        return Promise.reject(new TvMcpError('CDP_UNREACHABLE', 'The debug port did not answer'));
      }
      return Promise.resolve(listings === 1 ? [] : [NEW_TAB_PAGE]);
    },
  });

  const result = await tabNew.handler({}, ctx);

  expect(result).toEqual({ data: { id: OPENED, index: 1 }, via: 'dom', warnings: [] });
  expect(listings).toBeGreaterThanOrEqual(4);
  expect(ctx.session.openedTabIds).toEqual(new Set([OPENED]));
});

test('tab_new passes on a failure of the target list that is not one of the connection', async () => {
  const chrome = createFakeWindowChrome({
    tabs: [{ id: A, title: ['AAPL'] }],
    active: A,
    newTabIds: [OPENED],
  });
  const bug = new Error('A bug in the listing');
  let listings = 0;
  let resets = 0;
  const ctx = contextWith({
    windowChromePage: () => Promise.resolve(chromePage(chrome)),
    targets: () => {
      listings += 1;
      return listings === 1 ? Promise.resolve([]) : Promise.reject(bug);
    },
    reset: () => {
      resets += 1;
      return Promise.resolve();
    },
  });

  await expect(tabNew.handler({}, ctx)).rejects.toBe(bug);
  // The tab did open, so it is recorded, and the sessions are dropped all the same.
  expect(ctx.session.openedTabIds).toEqual(new Set([OPENED]));
  expect(resets).toBe(1);
});

test('tab_close passes on a failure to reach the chart tab, and clicks nothing', async () => {
  const chrome = createFakeWindowChrome({
    tabs: [
      { id: A, title: ['AAPL'] },
      { id: B, title: ['MSFT'] },
    ],
    active: B,
  });
  const unreachable = new TvMcpError('CDP_UNREACHABLE', 'The debug port did not answer');
  const ctx = contextWith({
    windowChromePage: () => Promise.resolve(chromePage(chrome)),
    chartPage: () => Promise.reject(unreachable),
  });

  const error = await failureOf(tabClose.handler({ tabId: B, confirm: true }, ctx));
  await settle();

  expect(error).toBe(unreachable);
  expect(chrome.clicks).toEqual([]);
});

test('an index past the only tab of the window names it as one tab', async () => {
  const chrome = createFakeWindowChrome({ tabs: [{ id: A, title: ['AAPL'] }], active: A });
  const ctx = contextWith({ windowChromePage: () => Promise.resolve(chromePage(chrome)) });

  const error = await failureOf(tabSwitch.handler({ index: 1 }, ctx));

  expect(error.toPayload()).toMatchObject({
    code: 'INVALID_INPUT',
    message: 'There is no tab at index 1: the window has 1 tab',
    details: { index: 1, tabs: 1 },
  });
  expect(chrome.clicks).toEqual([]);
});
