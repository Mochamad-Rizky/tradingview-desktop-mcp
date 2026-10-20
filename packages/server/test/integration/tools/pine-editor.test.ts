import { createMcpServer } from '../../../src/server.js';
import { pageWaitMs } from '../../../src/tools/chart/strategies.js';
import { ensureEditorOpen, readEditorState } from '../../../src/tools/pine/editor.js';
import { startFakeCdpServer } from '../../helpers/fake-cdp/server.js';
import { loadTargetsFixture } from '../../helpers/fake-cdp/targets.js';
import { loadTvFixture } from '../../helpers/fake-tv/fixture.js';
import { createFakeTvWindow, inspectFakeWindow } from '../../helpers/fake-tv/window.js';
import { quietLogger, refusingLauncher, testConfig } from '../../helpers/tool-context.js';

// The Pine Editor access layer through the connection manager of a real server: the chart page it
// hands out, over the CDP adapter, to the fake debug port of the app with a fake chart behind it.
// The Pine tools that build on it are tested through the MCP client in pine.test.ts. Sources are
// synthetic.

// Nothing in this file may run a real program or start TradingView.
vi.mock('node:child_process', () => ({
  spawn: () => {
    throw new Error('A test tried to start a real program with spawn');
  },
  execFile: () => {
    throw new Error('A test tried to start a real program with execFile');
  },
}));

const fixture = loadTvFixture();

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

test('the editor state reads through the fake page', async () => {
  const win = createFakeTvWindow(fixture, { pineEditorReadyMs: 50 });
  const app = await startFakeCdpServer({ targets: loadTargetsFixture({ chartWindow: () => win }) });
  cleanups.push(() => app.close());
  const config = testConfig({ cdpPort: app.port, callTimeoutMs: 5000 });
  const { server, ctx } = createMcpServer(config, {
    launcher: refusingLauncher(),
    logger: quietLogger,
  });
  cleanups.push(async () => {
    await ctx.connection.close();
    await server.close();
  });
  const page = await ctx.connection.chartPage();
  const warnings: string[] = [];

  await expect(readEditorState(page, warnings)).resolves.toEqual({
    open: false,
    placement: null,
    modified: false,
    draft: false,
    script: null,
  });
  const opened = await ensureEditorOpen(page, pageWaitMs(config.callTimeoutMs), warnings);
  inspectFakeWindow(win).state.pineEditor.source = '//@version=6\nindicator("Changed")\n';
  const changed = await readEditorState(page, warnings);

  const script = {
    id: fixture.pineEditor.script?.scriptIdPart,
    version: fixture.pineEditor.script?.version,
  };
  expect(opened).toEqual({
    open: true,
    placement: 'dialog',
    modified: false,
    draft: false,
    script,
  });
  expect(changed).toEqual({ ...opened, modified: true });
  expect(warnings).toEqual([]);
  expect(inspectFakeWindow(win).callsTo('pineEditorApi.open')).toHaveLength(1);
});
