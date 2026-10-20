import type { CdpSession, CdpTargetInfo } from '../../../../src/core/cdp/types.js';
import type { ConnectionManager, PageHandle } from '../../../../src/core/connection.js';
import { createPageBridge } from '../../../../src/core/tv/page-bridge.js';
import { pineSave, readPineSourceData } from '../../../../src/tools/pine/index.js';
import type { ToolContext, ToolRegistry } from '../../../../src/tools/types.js';
import { failureOf } from '../../../helpers/failure-of.js';
import { createPageRuntime } from '../../../helpers/fake-cdp/runtime.js';
import { createFakeWebpack } from '../../../helpers/fake-tv/webpack.js';
import { createTestContext } from '../../../helpers/tool-context.js';

// The handlers of the Pine source tools on pages whose editor answers what the fake app does not
// model: an editor that closes between two reads, and saves that TradingView answers with compile
// errors or after which the editor stays on a new script. Sources are synthetic.

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
});

const target: CdpTargetInfo = {
  id: 'PAGE1',
  type: 'page',
  title: 'Chart',
  url: 'https://www.tradingview.com/chart/FIXTURE1/',
};

function pageOf(win: object): PageHandle {
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
  return { target, session, bridge: createPageBridge(session, { timeoutMs: 5000 }) };
}

// A tool context whose chart page is a page over `win`.
function contextFor(win: object): ToolContext {
  const page = pageOf(win);
  const connection = { chartPage: () => Promise.resolve(page) } as unknown as ConnectionManager;
  return { ...createTestContext({ connection }), registry: {} as ToolRegistry };
}

// A signed-in page with an editor in the side panel, answered by `getOpenPineEditor`, the Pine
// Editor API `api` and no saved scripts.
function pageWith(getOpenPineEditor: (placement: string) => unknown, api: object = {}): object {
  return {
    is_authenticated: true,
    TradingViewApi: { pineEditorApi: () => api },
    webpackChunktradingview: createFakeWebpack({
      1: { getOpenPineEditor, requestUserScripts: () => Promise.resolve([]) },
    }),
  };
}

const SOURCE = '//@version=6\nindicator("Unit")\nplot(close)\n';

test('readPineSourceData fails NOT_AVAILABLE when the editor closes between its two reads', async () => {
  const facade = {
    isModified: () => false,
    isDraft: () => true,
    getScriptIdVersion: () => null,
    getSource: () => Promise.resolve(SOURCE),
  };
  let lookups = 0;
  // Open for the read of the state, closed for the read of the text.
  const win = pageWith((placement) => {
    lookups += 1;
    return placement === 'dialog' && lookups === 1 ? { getFacade: () => facade } : null;
  });

  const error = await failureOf(readPineSourceData(contextFor(win)));

  expect(error).toMatchObject({ code: 'NOT_AVAILABLE' });
  expect(error.hint).toContain('pine_open');
});

test('pine_save reports a version TradingView saved with compile errors', async () => {
  const facade = {
    isModified: () => true,
    isDraft: () => false,
    getScriptIdVersion: () => ({ scriptIdPart: 'USER;unit', version: '2.0' }),
    getSource: () => Promise.resolve(SOURCE),
    saveScript: () =>
      Promise.resolve({
        script: { scriptIdPart: 'USER;unit', version: '3.0' },
        compileErrors: {
          errors: [{ message: 'Undeclared identifier', start: { line: 3, column: 6 } }],
        },
      }),
  };
  const ctx = contextFor(
    pageWith((placement) => (placement === 'dialog' ? { getFacade: () => facade } : null)),
  );

  const error = await failureOf(pineSave.handler({ confirm: true }, ctx));

  expect(error).toMatchObject({
    code: 'INVALID_INPUT',
    message: 'TradingView saved the script as USER;unit, but it has 1 compile error',
    details: {
      saved: true,
      script: { id: 'USER;unit', version: '3.0' },
      errors: [{ message: 'Undeclared identifier', line: 3, column: 6 }],
    },
  });
});

test('pine_save warns when the editor could not be switched to the new script it saved', async () => {
  const facade = {
    isModified: () => true,
    isDraft: () => true,
    getScriptIdVersion: () => null,
    getSource: () => Promise.resolve(SOURCE),
    // Stays on the new script, as when the app falls back to one.
    openScript: () => Promise.resolve(),
  };
  const api = {
    saveNewScript: () =>
      Promise.resolve({
        success: true,
        metaInfo: { scriptIdPart: 'USER;new', pine: { version: '1.0' } },
        compileErrors: { errors: [], warnings: [] },
      }),
  };
  const ctx = contextFor(
    pageWith((placement) => (placement === 'dialog' ? { getFacade: () => facade } : null), api),
  );

  const output = await pineSave.handler({ name: 'Unit' }, ctx);

  expect(output.data).toEqual({ script: { id: 'USER;new', version: '1.0' }, created: true });
  expect(output.warnings).toEqual([expect.stringContaining('pine_open') as string]);
  expect(ctx.session.createdScriptIds).toEqual(new Set(['USER;new']));
});
