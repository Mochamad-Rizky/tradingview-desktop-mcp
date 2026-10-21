import { setTimeout as delay } from 'node:timers/promises';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from '../../../src/core/logger.js';
import { createMcpServer } from '../../../src/server.js';
import {
  ensureEditorOpen,
  KEPT_FLAG_REMEDY,
  SAVED_CHANGES_HINT,
  UNSAVED_TEXT_HINT,
} from '../../../src/tools/pine/editor.js';
import { closePineEditor } from '../../../src/tools/pine/page.js';
import type { ToolContext } from '../../../src/tools/types.js';
import { startFakeCdpServer } from '../../helpers/fake-cdp/server.js';
import { loadTargetsFixture } from '../../helpers/fake-cdp/targets.js';
import { loadTvFixture, type TvStateFixture } from '../../helpers/fake-tv/fixture.js';
import type { FakeWebpackRequire } from '../../helpers/fake-tv/webpack.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTvOverrides,
  type FakeTvWindow,
} from '../../helpers/fake-tv/window.js';
import { recordChartLookups } from '../../helpers/chart-lookups.js';
import { callTool, connectInMemoryClient, textOf } from '../../helpers/mcp-client.js';
import {
  capturingLogger,
  quietLogger,
  refusingLauncher,
  testConfig,
} from '../../helpers/tool-context.js';

// The Pine source tools through the whole server: an SDK client over the in-memory transport, the
// real registry, connection manager and CDP adapter, and the fake debug port of the app with a fake
// chart and Pine Editor behind it. Sources and script names are synthetic.

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
const [SCRIPT, STRATEGY, DRAFT] = fixture.pineEditor.savedScripts.map((script) => ({
  ...script,
}));
if (SCRIPT === undefined || STRATEGY === undefined || DRAFT === undefined) {
  throw new Error('The fixture must hold three saved scripts');
}
const EDITED = '//@version=6\nindicator("Fixture Script")\nplot(open)\n';
const NEW_SOURCE = '//@version=6\nstrategy("Breakout", overlay=true)\n';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function connect(server: McpServer): Promise<Client> {
  const client = await connectInMemoryClient(server);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function startHarness(
  from: TvStateFixture = fixture,
  overrides: FakeTvOverrides = {},
  callTimeoutMs = 5000,
  logger: Logger = quietLogger,
): Promise<{ client: Client; win: FakeTvWindow; ctx: ToolContext }> {
  const win = createFakeTvWindow(from, overrides);
  const app = await startFakeCdpServer({ targets: loadTargetsFixture({ chartWindow: () => win }) });
  cleanups.push(() => app.close());
  const config = testConfig({ cdpPort: app.port, callTimeoutMs });
  const { server, ctx } = createMcpServer(config, { launcher: refusingLauncher(), logger });
  cleanups.push(() => ctx.connection.close());
  return { client: await connect(server), win, ctx };
}

// The fixture with the editor open in the side panel, changed by `editor`.
function withEditor(editor: Partial<TvStateFixture['pineEditor']> = {}): TvStateFixture {
  return { ...fixture, pineEditor: { ...fixture.pineEditor, open: 'dialog', ...editor } };
}

// The fixture with an open editor whose text has unsaved changes.
const modified = (): TvStateFixture => withEditor({ source: EDITED });

// The fixture with room for `limit` saved scripts.
function withLimit(limit: number, from: TvStateFixture = fixture): TvStateFixture {
  return { ...from, planLimits: { ...from.planLimits, SAVED_PINE_SCRIPTS: limit } };
}

interface Envelope {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; hint?: string; details?: Record<string, unknown> };
  meta: { via?: string; durationMs: number; warnings?: string[] };
}

const envelopeOf = (result: { structuredContent?: unknown }): Envelope =>
  result.structuredContent as Envelope;
const dataOf = (result: { structuredContent?: unknown }) => envelopeOf(result).data ?? {};
const errorOf = (result: { structuredContent?: unknown }) => envelopeOf(result).error;
const warningsOf = (result: { structuredContent?: unknown }) =>
  envelopeOf(result).meta.warnings ?? [];
const callsOf = (win: FakeTvWindow, name: string) => inspectFakeWindow(win).callsTo(name);
const editorOf = (win: FakeTvWindow) => inspectFakeWindow(win).state.pineEditor;
const isoOf = (time: number) => new Date(time * 1000).toISOString().replace('.000Z', 'Z');

describe('pine_set_source', () => {
  test('pine_set_source refuses to replace unsaved content without confirm', async () => {
    const { client, win } = await startHarness(modified());

    const result = await callTool(client, 'pine_set_source', { source: NEW_SOURCE });

    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      details: { action: 'pine_set_source' },
    });
    expect(callsOf(win, 'pineFacade.setScript')).toEqual([]);
    expect(editorOf(win).source).toBe(EDITED);
  });

  test('pine_set_source replaces unsaved content with confirm', async () => {
    const { client, win } = await startHarness(modified());

    const result = await callTool(client, 'pine_set_source', { source: NEW_SOURCE, confirm: true });

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: {
        script: { id: SCRIPT.scriptIdPart, version: SCRIPT.version },
        modified: true,
        draft: false,
      },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(callsOf(win, 'pineFacade.setScript')).toEqual([[NEW_SOURCE]]);
    expect(editorOf(win).source).toBe(NEW_SOURCE);
  });

  test('pine_set_source opens a closed editor, which restores its script, and sets the source', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'pine_set_source', { source: NEW_SOURCE });

    expect(dataOf(result)).toEqual({
      script: { id: SCRIPT.scriptIdPart, version: SCRIPT.version },
      modified: true,
      draft: false,
    });
    expect(callsOf(win, 'pineEditorApi.open')).toHaveLength(1);
    expect(editorOf(win).source).toBe(NEW_SOURCE);
  });
});

// Seen on the app: unsaved text of an editor whose side panel was closed is kept by TradingView,
// and the next open shows it again as the text of the script, so that isModified() reads false;
// TradingView keeps a flag for it, which its own guard asks too.
describe('unsaved text TradingView keeps for a closed editor', () => {
  const UNSAVED = '//@version=6\nindicator("Unsaved work")\nplot(open)\n';

  // The editor closed on text the user typed into a new script, which TradingView keeps.
  async function closedWithUnsavedText(from: TvStateFixture = withEditor(), logger?: Logger) {
    const harness = await startHarness(from, {}, 5000, logger);
    await callTool(harness.client, 'pine_new', {});
    editorOf(harness.win).source = UNSAVED;
    const page = await harness.ctx.connection.chartPage();
    await page.bridge.evaluateWithLib(closePineEditor, []);
    expect(editorOf(harness.win)).toMatchObject({ placement: null, unsavedKept: true });
    return harness;
  }

  test('pine_new, pine_set_source and pine_open do not replace it without confirm', async () => {
    const { client, win } = await closedWithUnsavedText();

    for (const [tool, args] of [
      ['pine_new', {}],
      ['pine_set_source', { source: NEW_SOURCE }],
      ['pine_open', { scriptId: SCRIPT.scriptIdPart }],
    ] as const) {
      const result = await callTool(client, tool, args);
      expect(errorOf(result)?.code, tool).toBe('CONFIRMATION_REQUIRED');
    }
    // The editor is open again, with the text as it was.
    expect(editorOf(win)).toMatchObject({ placement: 'dialog', source: UNSAVED });
  });

  test('pine_set_source says what TradingView shows when it opens the editor', async () => {
    const { client } = await startHarness();

    const { tools } = await client.listTools();
    const description = tools.find(({ name }) => name === 'pine_set_source')?.description ?? '';

    expect(description).toContain('the way the Pine button of TradingView opens it');
    expect(description).toContain('unsaved text it kept');
    expect(description).not.toContain('restores the script it last held');
  });

  test('pine_get_source reports it as unsaved, and confirm replaces it', async () => {
    const { client, win } = await closedWithUnsavedText();
    await callTool(client, 'pine_new', {});

    expect(dataOf(await callTool(client, 'pine_get_source'))).toMatchObject({
      source: UNSAVED,
      modified: true,
    });
    // TradingView flags the unsaved changes until the editor closes (seen on the app), so the
    // editor still counts as modified after the text was replaced.
    expect(dataOf(await callTool(client, 'pine_new', { confirm: true }))).toMatchObject({
      modified: true,
    });
    expect(editorOf(win).source).toBe(fixture.pineEditor.templates.indicator);
  });

  test('the tools that replace the text say which text needs confirm until the editor closes', async () => {
    const { client } = await startHarness();

    const { tools } = await client.listTools();

    for (const name of ['pine_new', 'pine_open', 'pine_set_source', 'pine_smart_compile']) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.description, name).toContain('the text it last wrote into the editor');
      expect(tool?.description, name).toContain('needs no confirm: true');
      expect(tool?.description, name).toContain('once TradingView kept it across a close');
      expect(tool?.description, name).toContain(
        'TradingView flags unsaved changes until the editor is closed',
      );
      const confirm = (tool?.inputSchema.properties?.confirm ?? {}) as { description?: string };
      expect(confirm.description, name).toContain('until the editor is closed');
      expect(confirm.description, name).toContain('text this session last wrote');
      expect(confirm.description, name).toContain('as an unsaved edit');
    }
  });

  test('after confirm replaced it, changes need confirm until the editor closes', async () => {
    const { client, ctx, win } = await closedWithUnsavedText();
    // The template of a new script, which this session did not write.
    await callTool(client, 'pine_new', { confirm: true });

    const again = await callTool(client, 'pine_set_source', { source: NEW_SOURCE });
    expect(errorOf(again)?.code).toBe('CONFIRMATION_REQUIRED');
    expect(editorOf(win).source).toBe(fixture.pineEditor.templates.indicator);

    // The close writes the flag from the text then, a new script without changes: none kept.
    const page = await ctx.connection.chartPage();
    await page.bridge.evaluateWithLib(closePineEditor, []);
    expect(editorOf(win)).toMatchObject({ placement: null, unsavedKept: false });
    expect(dataOf(await callTool(client, 'pine_set_source', { source: NEW_SOURCE }))).toMatchObject(
      { modified: true },
    );
    expect(editorOf(win).source).toBe(NEW_SOURCE);
  });

  test('the kept unsaved flag does not ask for confirm when the editor holds exactly the text this session wrote', async () => {
    const { logger, lines } = capturingLogger();
    const { client, ctx, win } = await closedWithUnsavedText(withEditor(), logger);

    const started = await callTool(client, 'pine_new', { source: NEW_SOURCE, confirm: true });

    expect(dataOf(started)).toMatchObject({ script: null, modified: true });
    // TradingView still flags the unsaved changes the call replaced.
    expect(editorOf(win)).toMatchObject({ source: NEW_SOURCE, unsavedKept: true });
    expect(ctx.session.lastWrittenPineText).toBe(NEW_SOURCE);

    // The editor holds exactly what this session wrote, so nothing of the user is replaced.
    const replaced = await callTool(client, 'pine_set_source', { source: EDITED });
    expect(replaced.isError).toBeFalsy();
    expect(dataOf(replaced)).toMatchObject({ modified: true });
    expect(editorOf(win).source).toBe(EDITED);
    expect(ctx.session.lastWrittenPineText).toBe(EDITED);

    // One character typed into the editor, and its text is the user's again.
    const typed = `${EDITED}x`;
    editorOf(win).source = typed;
    const refused = await callTool(client, 'pine_set_source', { source: NEW_SOURCE });
    expect(errorOf(refused)).toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      details: { action: 'pine_set_source' },
    });
    expect(editorOf(win).source).toBe(typed);
    expect(ctx.session.lastWrittenPineText).toBe(EDITED);
    // The texts stay in memory: no log line holds them.
    const logged = JSON.stringify(lines);
    for (const text of [NEW_SOURCE, EDITED, UNSAVED]) {
      expect(logged).not.toContain(JSON.stringify(text).slice(1, -1));
    }
  });

  test('hints name closing the Pine Editor as a way to clear the kept flag', async () => {
    const { client } = await closedWithUnsavedText(withStudyRoom(3, withEditor()));

    const replaced = await callTool(client, 'pine_set_source', { source: NEW_SOURCE });
    // A saved script without changes of its own, which TradingView still flags until the editor
    // closes.
    await callTool(client, 'pine_open', { scriptId: SCRIPT.scriptIdPart, confirm: true });
    const added = await callTool(client, 'pine_compile', { addToChart: true });
    const saved = await callTool(client, 'pine_save', {});

    expect(errorOf(replaced)?.code).toBe('CONFIRMATION_REQUIRED');
    expect(errorOf(added)?.code).toBe('NOT_AVAILABLE');
    expect(errorOf(saved)?.code).toBe('CONFIRMATION_REQUIRED');
    // Every refusal names closing the editor, which clears the flag once nothing is unsaved. Saving
    // does not clear it, so adding and saving say that too, after saving first.
    expect(errorOf(replaced)?.hint).toBe(UNSAVED_TEXT_HINT);
    expect(errorOf(replaced)?.hint).toContain(
      'Closing the Pine Editor, in TradingView or with ui_open_panel (panel: "pine_editor", open: false), clears the flag',
    );
    expect(errorOf(replaced)?.hint).toContain('only when the editor holds no unsaved changes');
    expect(errorOf(added)?.hint).toBe(SAVED_CHANGES_HINT);
    expect(errorOf(added)?.hint).toMatch(/^Save the changes first with pine_save/);
    expect(errorOf(added)?.hint).toContain('open the script with pine_open and add it');
    expect(errorOf(saved)?.hint).toContain('call pine_save again with confirm: true');
    for (const result of [added, saved]) {
      expect(errorOf(result)?.hint).toContain(KEPT_FLAG_REMEDY);
      expect(errorOf(result)?.hint).toContain('Saving does not clear the flag');
      expect(errorOf(result)?.hint).toContain(
        'closing the Pine Editor, in TradingView or with ui_open_panel (panel: "pine_editor", open: false), clears it',
      );
    }
  });

  test('pine_save and pine_compile with addToChart count the flag TradingView keeps as unsaved changes, also over the text this session wrote', async () => {
    const { client, win } = await closedWithUnsavedText(withStudyRoom(3, withEditor()));
    await callTool(client, 'pine_open', { scriptId: SCRIPT.scriptIdPart, confirm: true });
    // The script is the user's, and the flag of the replaced text is still set: confirm, twice.
    await callTool(client, 'pine_set_source', { source: EDITED, confirm: true });
    const version = await callTool(client, 'pine_save', { confirm: true });
    expect(dataOf(version)).toMatchObject({ created: false });
    expect(editorOf(win)).toMatchObject({ source: EDITED, savedSource: EDITED, unsavedKept: true });

    const again = await callTool(client, 'pine_save', {});
    const added = await callTool(client, 'pine_compile', { addToChart: true });

    expect(errorOf(again)?.code).toBe('CONFIRMATION_REQUIRED');
    expect(errorOf(added)?.code).toBe('NOT_AVAILABLE');
    expect(callsOf(win, 'pineFacade.saveScript')).toHaveLength(1);
    expect(callsOf(win, 'pineFacade.addToChart')).toEqual([]);

    // What the hints say does it: with nothing unsaved, closing the Pine Editor with ui_open_panel
    // writes the flag down; the script is opened again and added.
    const closed = await callTool(client, 'ui_open_panel', { panel: 'pine_editor', open: false });
    expect(dataOf(closed)).toEqual({ panel: 'pine_editor', open: false, changed: true });
    expect(editorOf(win)).toMatchObject({ placement: null, unsavedKept: false });
    const opened = await callTool(client, 'pine_open', { scriptId: SCRIPT.scriptIdPart });
    expect(dataOf(opened)).toMatchObject({ script: { id: SCRIPT.scriptIdPart }, modified: false });
    const addedThen = await callTool(client, 'pine_compile', { addToChart: true });
    expect(dataOf(addedThen)).toMatchObject({ addedToChart: true, studyId: 'NEW001' });
    expect(callsOf(win, 'dialog.confirmSaveChanges')).toEqual([]);
  });

  test('the text this session wrote counts as unsaved for saving, adding and replacing once TradingView kept it across a close', async () => {
    const { client, ctx, win } = await startHarness(withLimit(5, withStudyRoom(3, withEditor())));
    await callTool(client, 'pine_open', { scriptId: SCRIPT.scriptIdPart });
    const set = await callTool(client, 'pine_set_source', { source: EDITED });
    expect(set.isError).toBeFalsy();
    // The user closes the editor and opens it again: TradingView keeps the text, shows it as the
    // text of the script and flags it, while isModified() reads false.
    const page = await ctx.connection.chartPage();
    await page.bridge.evaluateWithLib(closePineEditor, []);
    await ensureEditorOpen(page, 3000);
    const facade = win.TradingViewApi?.pineEditorApi().getDialogFacade();
    expect(facade?.isModified()).toBe(false);
    expect(editorOf(win)).toMatchObject({ source: EDITED, unsavedKept: true });
    expect(editorOf(win).savedScripts[0]?.source).not.toBe(EDITED);

    const added = await callTool(client, 'pine_compile', { addToChart: true });
    const saved = await callTool(client, 'pine_save', {});
    const opened = await callTool(client, 'pine_open', { scriptId: STRATEGY.scriptIdPart });

    expect(errorOf(added)?.code).toBe('NOT_AVAILABLE');
    expect(callsOf(win, 'pineFacade.addToChart')).toEqual([]);
    expect(errorOf(saved)?.code).toBe('CONFIRMATION_REQUIRED');
    expect(warningsOf(saved)).toEqual([]);
    expect(errorOf(opened)).toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      details: { action: 'pine_open' },
    });
    expect(editorOf(win).source).toBe(EDITED);
    // With confirm, the save writes the kept text as a new version: it was not saved yet.
    const version = await callTool(client, 'pine_save', { confirm: true });
    expect(dataOf(version)).toMatchObject({ created: false });
    expect(editorOf(win).savedScripts[0]?.source).toBe(EDITED);
  });

  test('smart compile writeBack and pine_open need no confirm over the text this session wrote', async () => {
    const V4 = '//@version=6\nstudy("x")\nplot(close)\n';
    const { client, ctx, win } = await closedWithUnsavedText();
    await callTool(client, 'pine_new', { source: V4, confirm: true });

    const compiled = await callTool(client, 'pine_smart_compile', { writeBack: true });

    expect(dataOf(compiled)).toMatchObject({ success: true, writtenBack: true });
    const fixed = '//@version=6\nindicator("x")\nplot(close)\n';
    expect(editorOf(win).source).toBe(fixed);
    expect(ctx.session.lastWrittenPineText).toBe(fixed);

    // The text that opening a saved script replaces is the one the write-back wrote.
    const opened = await callTool(client, 'pine_open', { scriptId: SCRIPT.scriptIdPart });
    expect(dataOf(opened)).toMatchObject({ script: { id: SCRIPT.scriptIdPart } });
  });

  test('pine_open says that the text this session wrote is gone when TradingView falls back to a new script', async () => {
    const { client, win } = await closedWithUnsavedText(withLimit(5, withEditor()));
    await callTool(client, 'pine_new', { source: NEW_SOURCE, confirm: true });
    const broken = editorOf(win).savedScripts[1];
    if (broken !== undefined) {
      broken.source = null;
    }

    const result = await callTool(client, 'pine_open', { scriptId: STRATEGY.scriptIdPart });

    expect(errorOf(result)).toMatchObject({ code: 'NOT_AVAILABLE' });
    expect(errorOf(result)?.hint).toMatch(/held the text this session wrote last/);
    expect(errorOf(result)?.hint).not.toMatch(/as confirm: true allowed/);
  });
});

describe('pine_new', () => {
  test('pine_new opens a strategy template and sets the given source', async () => {
    const { client, win } = await startHarness(withEditor());

    const result = await callTool(client, 'pine_new', { type: 'strategy', source: NEW_SOURCE });

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: { type: 'strategy', script: null, modified: true, draft: true },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(callsOf(win, 'pineFacade.openNewScript')).toEqual([['strategy']]);
    expect(callsOf(win, 'pineFacade.setScript')).toEqual([[NEW_SOURCE]]);
    expect(editorOf(win)).toMatchObject({ script: null, source: NEW_SOURCE });
  });

  test('pine_new opens an indicator template by default and returns no template text', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'pine_new');

    expect(dataOf(result)).toEqual({
      type: 'indicator',
      script: null,
      modified: false,
      draft: true,
    });
    expect(callsOf(win, 'pineFacade.openNewScript')).toEqual([['indicator']]);
    expect(callsOf(win, 'pineFacade.setScript')).toEqual([]);
    // The template names its author.
    expect(editorOf(win).source).toBe(fixture.pineEditor.templates.indicator);
    expect(textOf(result)).not.toContain('fixture_author');
  });

  test('pine_new refuses to replace unsaved content without confirm', async () => {
    const { client, win } = await startHarness(modified());

    const result = await callTool(client, 'pine_new', { type: 'library' });

    expect(errorOf(result)?.code).toBe('CONFIRMATION_REQUIRED');
    expect(callsOf(win, 'pineFacade.openNewScript')).toEqual([]);
    expect(editorOf(win).source).toBe(EDITED);

    const confirmed = await callTool(client, 'pine_new', { type: 'library', confirm: true });
    expect(dataOf(confirmed)).toMatchObject({ type: 'library', script: null });
    expect(callsOf(win, 'pineFacade.openNewScript')).toEqual([['library']]);
  });
});

describe('pine_open', () => {
  test('pine_open by name opens the matching saved script', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'pine_open', { name: 'fixture draft' });

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: {
        script: { id: DRAFT.scriptIdPart, version: DRAFT.version },
        name: DRAFT.scriptName,
        modified: false,
        draft: true,
      },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(callsOf(win, 'pineFacade.openScript')).toEqual([
      [{ scriptIdPart: DRAFT.scriptIdPart, version: DRAFT.version }],
    ]);
    expect(editorOf(win).source).toBe(DRAFT.source);
  });

  test('pine_open by name matches the title too, and by scriptId opens that script', async () => {
    const { client, win } = await startHarness(withLimit(5));

    const byTitle = await callTool(client, 'pine_open', { name: 'FIXTURE STRAT' });
    expect(dataOf(byTitle)).toMatchObject({
      script: { id: STRATEGY.scriptIdPart, version: STRATEGY.version },
      name: STRATEGY.scriptName,
    });
    const byId = await callTool(client, 'pine_open', { scriptId: SCRIPT.scriptIdPart });
    expect(dataOf(byId)).toMatchObject({
      script: { id: SCRIPT.scriptIdPart, version: SCRIPT.version },
      name: SCRIPT.scriptName,
    });
    expect(editorOf(win).source).toBe(SCRIPT.source);
  });

  test('pine_open fails INVALID_INPUT for an unknown script', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'pine_open', { name: 'No Such Script' });

    expect(errorOf(result)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(errorOf(result)?.hint).toContain('pine_list_scripts');
    expect(callsOf(win, 'pineEditorApi.open')).toEqual([]);
    expect(callsOf(win, 'pineFacade.openScript')).toEqual([]);

    const byId = await callTool(client, 'pine_open', { scriptId: 'USER;nosuchscript' });
    expect(errorOf(byId)?.code).toBe('INVALID_INPUT');
  });

  test('pine_open needs exactly one of scriptId and name', async () => {
    const { client, win } = await startHarness();

    const neither = await callTool(client, 'pine_open');
    const both = await callTool(client, 'pine_open', {
      scriptId: SCRIPT.scriptIdPart,
      name: SCRIPT.scriptName,
    });

    expect(errorOf(neither)?.code).toBe('INVALID_INPUT');
    expect(errorOf(both)?.code).toBe('INVALID_INPUT');
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('pine_open fails INVALID_INPUT with the candidates for an ambiguous name', async () => {
    const twin = { ...STRATEGY, scriptIdPart: 'USER;00000000000000000000000000000abc' };
    twin.scriptName = 'Fixture Strat';
    const from = withLimit(5, {
      ...fixture,
      pineEditor: {
        ...fixture.pineEditor,
        savedScripts: [...fixture.pineEditor.savedScripts, twin],
      },
    });
    const { client, win } = await startHarness(from);

    const result = await callTool(client, 'pine_open', { name: 'fixture strat' });

    expect(errorOf(result)).toMatchObject({
      code: 'INVALID_INPUT',
      details: { candidates: [STRATEGY.scriptIdPart, twin.scriptIdPart] },
    });
    expect(callsOf(win, 'pineFacade.openScript')).toEqual([]);
  });

  test('pine_open names a script by its title, or its id, when the list gives no name', async () => {
    const untitled = { ...DRAFT, scriptIdPart: 'USER;00000000000000000000000000000def' };
    untitled.scriptName = '';
    untitled.scriptTitle = '';
    const titled = { ...DRAFT, scriptName: '' };
    const { client } = await startHarness({
      ...fixture,
      pineEditor: { ...fixture.pineEditor, savedScripts: [titled, untitled] },
    });

    const byTitle = await callTool(client, 'pine_open', { name: DRAFT.scriptTitle });
    expect(dataOf(byTitle)).toMatchObject({ name: DRAFT.scriptTitle });
    const byId = await callTool(client, 'pine_open', { scriptId: untitled.scriptIdPart });
    expect(dataOf(byId)).toMatchObject({ name: untitled.scriptIdPart });
  });

  test('pine_open says that TradingView lists no scripts while signed out', async () => {
    const { client, win } = await startHarness();
    editorOf(win).signedIn = false;

    const result = await callTool(client, 'pine_open', { name: DRAFT.scriptName });

    expect(errorOf(result)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(errorOf(result)?.hint).toContain('signed in');
  });

  test('pine_open fails PLAN_LIMIT for a script outside the newest the plan can open', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'pine_open', { scriptId: STRATEGY.scriptIdPart });

    expect(errorOf(result)).toMatchObject({
      code: 'PLAN_LIMIT',
      details: { feature: 'SAVED_PINE_SCRIPTS', limit: 1 },
    });
    expect(callsOf(win, 'pineEditorApi.open')).toEqual([]);
    expect(callsOf(win, 'pineFacade.openScript')).toEqual([]);
    expect(callsOf(win, 'dialog.paywall')).toEqual([]);
  });

  test('pine_open opens a saved script when the saved-script limit cannot be read', async () => {
    // Opening runs no paywall check in the app: without a limit to check, the open goes ahead.
    const { client, win } = await startHarness({
      ...fixture,
      planLimits: Object.fromEntries(
        Object.entries(fixture.planLimits).filter(([feature]) => feature !== 'SAVED_PINE_SCRIPTS'),
      ),
    });

    const result = await callTool(client, 'pine_open', { scriptId: STRATEGY.scriptIdPart });

    expect(dataOf(result)).toMatchObject({ script: { id: STRATEGY.scriptIdPart } });
    expect(callsOf(win, 'dialog.paywall')).toEqual([]);
  });

  test('pine_open fails NOT_AVAILABLE when TradingView falls back to a new script', async () => {
    const from = withLimit(5);
    const { client, win } = await startHarness(from);
    const broken = editorOf(win).savedScripts[1];
    if (broken !== undefined) {
      broken.source = null;
    }

    const result = await callTool(client, 'pine_open', { scriptId: STRATEGY.scriptIdPart });

    expect(errorOf(result)).toMatchObject({ code: 'NOT_AVAILABLE' });
    expect(errorOf(result)?.message).toContain('could not be opened');
    // The editor opened without unsaved changes, so none were lost.
    expect(errorOf(result)?.hint).toMatch(/held no unsaved changes, so none were lost/);
    expect(callsOf(win, 'pineFacade.openScript')).toHaveLength(1);
  });

  test('pine_open says that the unsaved text confirm let it replace is gone when TradingView falls back to a new script', async () => {
    const { client, win } = await startHarness(withLimit(5, modified()));
    const broken = editorOf(win).savedScripts[1];
    if (broken !== undefined) {
      broken.source = null;
    }

    const result = await callTool(client, 'pine_open', {
      scriptId: STRATEGY.scriptIdPart,
      confirm: true,
    });

    expect(errorOf(result)).toMatchObject({ code: 'NOT_AVAILABLE' });
    expect(errorOf(result)?.hint).not.toMatch(/no unsaved/i);
    expect(errorOf(result)?.hint).toMatch(
      /unsaved changes .* were replaced, as confirm: true allowed/,
    );
    // TradingView shows a new script in place of the text.
    expect(editorOf(win).source).not.toBe(EDITED);
  });

  test('pine_open refuses to replace unsaved content without confirm', async () => {
    const { client, win } = await startHarness(modified());

    const result = await callTool(client, 'pine_open', { name: DRAFT.scriptName });

    expect(errorOf(result)?.code).toBe('CONFIRMATION_REQUIRED');
    expect(callsOf(win, 'pineFacade.openScript')).toEqual([]);
    expect(editorOf(win).source).toBe(EDITED);

    const confirmed = await callTool(client, 'pine_open', {
      name: DRAFT.scriptName,
      confirm: true,
    });
    expect(dataOf(confirmed)).toMatchObject({ script: { id: DRAFT.scriptIdPart } });
  });
});

describe('pine_get_source', () => {
  test('pine_get_source opens no editor and fails NOT_AVAILABLE when it is closed', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'pine_get_source');

    expect(errorOf(result)).toMatchObject({ code: 'NOT_AVAILABLE' });
    expect(errorOf(result)?.hint).toContain('pine_new');
    expect(errorOf(result)?.hint).toContain('pine_open');
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });

  test('pine_get_source returns the text, the script and whether it is modified', async () => {
    const { client, win } = await startHarness(modified());

    const result = await callTool(client, 'pine_get_source');

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: {
        source: EDITED,
        script: { id: SCRIPT.scriptIdPart, version: SCRIPT.version },
        modified: true,
      },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });
});

describe('pine_list_scripts', () => {
  test('pine_list_scripts returns saved scripts', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'pine_list_scripts');

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: {
        scripts: [
          {
            id: SCRIPT.scriptIdPart,
            name: SCRIPT.scriptName,
            version: SCRIPT.version,
            type: 'indicator',
            modified: SCRIPT.modified,
            modifiedIso: isoOf(SCRIPT.modified),
          },
          {
            id: STRATEGY.scriptIdPart,
            name: STRATEGY.scriptName,
            version: STRATEGY.version,
            type: 'strategy',
            modified: STRATEGY.modified,
            modifiedIso: isoOf(STRATEGY.modified),
          },
          {
            id: DRAFT.scriptIdPart,
            name: DRAFT.scriptName,
            version: DRAFT.version,
            type: 'indicator',
            modified: DRAFT.modified,
            modifiedIso: isoOf(DRAFT.modified),
          },
        ],
      },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    // Only the request the app sends itself, and no editor.
    expect(inspectFakeWindow(win).calls.map(({ name }) => name)).toEqual(['requestUserScripts']);
    // The list of the app carries the text of every script, which is never returned.
    for (const { source } of fixture.pineEditor.savedScripts) {
      expect(textOf(result)).not.toContain(source);
    }
  });

  test('pine_list_scripts reads modified in milliseconds as well, and lists none signed out', async () => {
    const from: TvStateFixture = {
      ...fixture,
      pineEditor: {
        ...fixture.pineEditor,
        savedScripts: [{ ...SCRIPT, modified: SCRIPT.modified * 1000 }],
      },
    };
    const { client, win } = await startHarness(from);

    const result = await callTool(client, 'pine_list_scripts');
    expect(dataOf(result)).toEqual({
      scripts: [
        expect.objectContaining({ modified: SCRIPT.modified, modifiedIso: isoOf(SCRIPT.modified) }),
      ],
    });

    editorOf(win).signedIn = false;
    const signedOut = await callTool(client, 'pine_list_scripts');
    expect(dataOf(signedOut)).toEqual({ scripts: [] });
    expect(warningsOf(signedOut).join(' ')).toContain('signed in');
  });
});

describe('pine_save', () => {
  test('pine_save of a new draft returns PLAN_LIMIT when the saved-script limit is reached', async () => {
    const { client, win } = await startHarness(withEditor({ script: null, source: NEW_SOURCE }));

    const result = await callTool(client, 'pine_save', { name: 'Breakout' });

    expect(errorOf(result)).toMatchObject({
      code: 'PLAN_LIMIT',
      details: { feature: 'SAVED_PINE_SCRIPTS', limit: 1 },
    });
    expect(callsOf(win, 'pineEditorApi.saveNewScript')).toEqual([]);
    expect(callsOf(win, 'dialog.paywall')).toEqual([]);
  });

  test('pine_save of a new draft needs a name, so that TradingView opens no dialog', async () => {
    const { client, win } = await startHarness(
      withLimit(5, withEditor({ script: null, source: NEW_SOURCE })),
    );

    const result = await callTool(client, 'pine_save');

    expect(errorOf(result)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(callsOf(win, 'pineEditorApi.saveNewScript')).toEqual([]);
    expect(callsOf(win, 'pineFacade.saveScript')).toEqual([]);
  });

  test('pine_save of a new draft refuses the name of a saved script', async () => {
    const { client, win } = await startHarness(
      withLimit(5, withEditor({ script: null, source: NEW_SOURCE })),
    );

    const result = await callTool(client, 'pine_save', { name: 'fixture strategy' });

    expect(errorOf(result)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(callsOf(win, 'pineEditorApi.saveNewScript')).toEqual([]);
  });

  test('pine_save of a new draft saves it, and the editor then holds the saved script', async () => {
    const { client, win, ctx } = await startHarness(
      withLimit(5, withEditor({ script: null, source: NEW_SOURCE, savedSource: '' })),
    );

    const result = await callTool(client, 'pine_save', { name: 'Breakout' });

    const created = editorOf(win).savedScripts.at(-1);
    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: { script: { id: created?.scriptIdPart, version: '1.0' }, created: true },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(callsOf(win, 'pineEditorApi.saveNewScript')).toEqual([
      [{ source: NEW_SOURCE, name: 'Breakout' }],
    ]);
    expect(created).toMatchObject({ scriptName: 'Breakout', source: NEW_SOURCE });
    expect(ctx.session.createdScriptIds).toEqual(new Set([created?.scriptIdPart]));
    expect(editorOf(win)).toMatchObject({
      script: { scriptIdPart: created?.scriptIdPart, version: '1.0' },
      source: NEW_SOURCE,
      savedSource: NEW_SOURCE,
    });
  });

  test('pine_save of a script this session created saves without confirm', async () => {
    const { client, win } = await startHarness(
      withLimit(5, withEditor({ script: null, source: NEW_SOURCE })),
    );
    const first = await callTool(client, 'pine_save', { name: 'Breakout' });
    const id = (dataOf(first).script as { id: string }).id;
    editorOf(win).source = `${NEW_SOURCE}plot(close)\n`;

    const result = await callTool(client, 'pine_save');

    expect(dataOf(result)).toEqual({ script: { id, version: '2.0' }, created: false });
    expect(callsOf(win, 'pineFacade.saveScript')).toEqual([[]]);
  });

  test('pine_save reports the compile errors of a new draft and saves nothing', async () => {
    const { client, win, ctx } = await startHarness(
      withLimit(5, withEditor({ script: null, source: NEW_SOURCE })),
    );
    editorOf(win).saveErrors = [
      { message: 'Undeclared identifier', start: { line: 2, column: 5 } },
    ];

    const result = await callTool(client, 'pine_save', { name: 'Breakout' });

    expect(errorOf(result)).toMatchObject({
      code: 'INVALID_INPUT',
      details: { errors: [{ message: 'Undeclared identifier', line: 2, column: 5 }] },
    });
    expect(ctx.session.createdScriptIds).toEqual(new Set());
  });

  test('pine_save fails NOT_AVAILABLE when TradingView saves nothing and gives no reason', async () => {
    const { client, win, ctx } = await startHarness(
      withLimit(5, withEditor({ script: null, source: NEW_SOURCE })),
    );
    editorOf(win).saveErrors = [];

    const result = await callTool(client, 'pine_save', { name: 'Breakout' });

    expect(errorOf(result)).toMatchObject({ code: 'NOT_AVAILABLE' });
    expect(ctx.session.createdScriptIds).toEqual(new Set());
  });

  test('pine_save counts several compile errors', async () => {
    const { client, win } = await startHarness(
      withLimit(5, withEditor({ script: null, source: NEW_SOURCE })),
    );
    editorOf(win).saveErrors = [{ message: 'First' }, { message: 'Second' }];

    const result = await callTool(client, 'pine_save', { name: 'Breakout' });

    expect(errorOf(result)?.message).toContain('2 compile errors');
    expect(errorOf(result)?.details).toMatchObject({ saved: false, script: null });
  });

  test('pine_save of a script this session did not create requires confirm', async () => {
    const { client, win } = await startHarness(modified());

    const result = await callTool(client, 'pine_save');

    expect(errorOf(result)).toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      details: { id: SCRIPT.scriptIdPart },
    });
    expect(callsOf(win, 'pineFacade.saveScript')).toEqual([]);
    expect(callsOf(win, 'pineEditorApi.saveExistingScript')).toEqual([]);
  });

  test('pine_save with confirm saves a new version', async () => {
    const { client, win } = await startHarness(modified());

    const result = await callTool(client, 'pine_save', { confirm: true });

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: { script: { id: SCRIPT.scriptIdPart, version: '3.0' }, created: false },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(callsOf(win, 'pineFacade.saveScript')).toEqual([[]]);
    expect(editorOf(win)).toMatchObject({ savedSource: EDITED, source: EDITED });
  });

  test('pine_save never renames: a name other than the current one fails INVALID_INPUT', async () => {
    const { client, win } = await startHarness(modified());

    const renamed = await callTool(client, 'pine_save', { name: 'Other Name', confirm: true });
    expect(errorOf(renamed)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(callsOf(win, 'pineFacade.saveScript')).toEqual([]);

    const same = await callTool(client, 'pine_save', { name: SCRIPT.scriptName, confirm: true });
    expect(dataOf(same)).toMatchObject({ created: false });
  });

  test('pine_save refuses a name it cannot check against a script the list does not have', async () => {
    const { client, win } = await startHarness(modified());
    editorOf(win).script = { scriptIdPart: 'USER;unlisted', version: '1.0' };

    const result = await callTool(client, 'pine_save', { name: 'Anything', confirm: true });

    expect(errorOf(result)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(errorOf(result)?.message).toContain('not known');
    expect(callsOf(win, 'pineFacade.saveScript')).toEqual([]);
  });

  test('pine_save of an unmodified script with its own name saves nothing', async () => {
    const { client, win } = await startHarness(withEditor());

    const result = await callTool(client, 'pine_save', { name: SCRIPT.scriptName });

    expect(dataOf(result)).toMatchObject({ created: false });
    expect(warningsOf(result).join(' ')).toContain('nothing to save');
    expect(callsOf(win, 'pineFacade.saveScript')).toEqual([]);
  });

  test('pine_save of an unmodified script saves nothing', async () => {
    const { client, win } = await startHarness(withEditor());

    const result = await callTool(client, 'pine_save');

    expect(dataOf(result)).toEqual({
      script: { id: SCRIPT.scriptIdPart, version: SCRIPT.version },
      created: false,
    });
    expect(warningsOf(result).join(' ')).toContain('nothing to save');
    expect(callsOf(win, 'pineFacade.saveScript')).toEqual([]);
  });

  test('pine_save of a script with an id but no version needs confirm and never saves it as new', async () => {
    const { client, win } = await startHarness(withLimit(5, modified()));
    editorOf(win).script = { scriptIdPart: SCRIPT.scriptIdPart, version: undefined };

    const unconfirmed = await callTool(client, 'pine_save', { name: 'Breakout' });
    expect(errorOf(unconfirmed)).toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      details: { id: SCRIPT.scriptIdPart },
    });

    const confirmed = await callTool(client, 'pine_save', { confirm: true });
    expect(errorOf(confirmed)).toMatchObject({ code: 'NOT_AVAILABLE' });
    expect(callsOf(win, 'pineEditorApi.saveNewScript')).toEqual([]);
    expect(callsOf(win, 'pineFacade.saveScript')).toEqual([]);
    expect(callsOf(win, 'dialog.renameScript')).toEqual([]);
  });

  // The editor holding the server draft of the fixture, with a change.
  const onDraft = () =>
    withEditor({
      script: { scriptIdPart: DRAFT.scriptIdPart, version: DRAFT.version },
      savedSource: DRAFT.source,
      source: `${DRAFT.source}plot(high)\n`,
    });

  test('pine_save of a server draft saves it as a new script without confirm', async () => {
    const { client, win, ctx } = await startHarness(withLimit(5, onDraft()));

    const result = await callTool(client, 'pine_save', { name: 'From Draft' });

    const created = editorOf(win).savedScripts.at(-1);
    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: { script: { id: created?.scriptIdPart, version: '1.0' }, created: true },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(created?.scriptIdPart).not.toBe(DRAFT.scriptIdPart);
    expect(callsOf(win, 'pineEditorApi.saveNewScript')).toEqual([
      [{ source: `${DRAFT.source}plot(high)\n`, name: 'From Draft' }],
    ]);
    expect(ctx.session.createdScriptIds).toEqual(new Set([created?.scriptIdPart]));
    // The editor holds the new script, and the draft is as it was.
    expect(editorOf(win).script).toEqual({ scriptIdPart: created?.scriptIdPart, version: '1.0' });
    expect(editorOf(win).savedScripts.find((s) => s.scriptIdPart === DRAFT.scriptIdPart)).toEqual(
      DRAFT,
    );
    expect(callsOf(win, 'pineFacade.saveScript')).toEqual([]);
    expect(callsOf(win, 'dialog.renameScript')).toEqual([]);
  });

  test('pine_save of a server draft needs a name', async () => {
    const { client, win } = await startHarness(withLimit(5, onDraft()));

    const result = await callTool(client, 'pine_save', { confirm: true });

    expect(errorOf(result)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(callsOf(win, 'pineEditorApi.saveNewScript')).toEqual([]);
    expect(callsOf(win, 'pineFacade.saveScript')).toEqual([]);
  });

  test('pine_save of a server draft at the saved-script limit fails PLAN_LIMIT', async () => {
    const { client, win } = await startHarness(onDraft());

    const result = await callTool(client, 'pine_save', { name: 'From Draft' });

    expect(errorOf(result)).toMatchObject({
      code: 'PLAN_LIMIT',
      details: { feature: 'SAVED_PINE_SCRIPTS', limit: 1 },
    });
    expect(callsOf(win, 'pineEditorApi.saveNewScript')).toEqual([]);
    expect(callsOf(win, 'dialog.paywall')).toEqual([]);
  });

  test('pine_save of a script the plan cannot update fails PLAN_LIMIT before saving', async () => {
    const { client, win } = await startHarness(
      withEditor({
        script: { scriptIdPart: STRATEGY.scriptIdPart, version: STRATEGY.version },
        savedSource: STRATEGY.source,
        source: `${STRATEGY.source}plot(close)\n`,
      }),
    );

    const result = await callTool(client, 'pine_save', { confirm: true });

    expect(errorOf(result)).toMatchObject({
      code: 'PLAN_LIMIT',
      details: { feature: 'SAVED_PINE_SCRIPTS', limit: 1 },
    });
    expect(callsOf(win, 'pineFacade.saveScript')).toEqual([]);
    expect(callsOf(win, 'dialog.paywall')).toEqual([]);
  });

  // The fixture without a saved-script limit the app reports, while its toggle is on.
  const withoutScriptLimit = (from: TvStateFixture): TvStateFixture => ({
    ...from,
    planLimits: Object.fromEntries(
      Object.entries(from.planLimits).filter(([feature]) => feature !== 'SAVED_PINE_SCRIPTS'),
    ),
  });

  test('pine_save of a new script refuses, and saves nothing, when the saved-script limit cannot be read', async () => {
    const { client, win, ctx } = await startHarness(
      withoutScriptLimit(withEditor({ script: null, source: NEW_SOURCE })),
    );

    const result = await callTool(client, 'pine_save', { name: 'Breakout' });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      hint: expect.stringMatching(/cannot be read.*TradingView itself/) as string,
      details: { feature: 'SAVED_PINE_SCRIPTS' },
    });
    expect(callsOf(win, 'pineEditorApi.saveNewScript')).toEqual([]);
    expect(callsOf(win, 'dialog.paywall')).toEqual([]);
    expect(ctx.session.createdScriptIds).toEqual(new Set());
  });

  test('pine_save of a new version refuses, and saves nothing, when the saved-script limit cannot be read', async () => {
    const { client, win } = await startHarness(withoutScriptLimit(modified()));

    const result = await callTool(client, 'pine_save', { confirm: true });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      details: { feature: 'SAVED_PINE_SCRIPTS' },
    });
    expect(callsOf(win, 'pineFacade.saveScript')).toEqual([]);
    expect(callsOf(win, 'dialog.paywall')).toEqual([]);
    expect(editorOf(win).savedScripts[0]?.version).toBe(SCRIPT.version);
  });

  test('pine_save waits for an indicator_add in progress before it checks the limit and saves', async () => {
    const { client, win } = await startHarness(
      withStudyRoom(5, withLimit(5, withEditor({ script: null, source: NEW_SOURCE }))),
    );
    const held = holdCreateStudy(win);

    const adding = callTool(client, 'indicator_add', { name: 'RSI' });
    await held.called;
    const saving = callTool(client, 'pine_save', { name: 'Breakout' });
    await delay(200);
    held.release();
    const [added, saved] = await Promise.all([adding, saving]);

    expect(dataOf(added)).toMatchObject({ id: 'NEW001' });
    expect(dataOf(saved)).toMatchObject({ created: true });
    expect(
      inspectFakeWindow(win)
        .calls.map(({ name }) => name)
        .filter((name) => name === 'chart.createStudy' || name === 'pineEditorApi.saveNewScript'),
    ).toEqual(['chart.createStudy', 'pineEditorApi.saveNewScript']);
  });

  test('pine_save saves when the limit toggle is off, whose limit the app then does not apply', async () => {
    const { client, win } = await startHarness({
      ...withoutScriptLimit(withEditor({ script: null, source: NEW_SOURCE })),
      featureToggles: {},
    });

    const result = await callTool(client, 'pine_save', { name: 'Breakout' });

    expect(dataOf(result)).toMatchObject({ created: true });
    expect(callsOf(win, 'pineEditorApi.saveNewScript')).toHaveLength(1);
  });

  test('pine_save signed out fails AUTH_REQUIRED and opens no sign-in dialog', async () => {
    const { client, win } = await startHarness(modified());
    editorOf(win).signedIn = false;

    const result = await callTool(client, 'pine_save', { confirm: true });

    expect(errorOf(result)).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(callsOf(win, 'pineFacade.saveScript')).toEqual([]);
    expect(callsOf(win, 'dialog.signIn')).toEqual([]);
  });

  test('pine_save fails NOT_AVAILABLE when the editor is closed, and opens none', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'pine_save', { name: 'Breakout' });

    expect(errorOf(result)).toMatchObject({ code: 'NOT_AVAILABLE' });
    expect(inspectFakeWindow(win).calls).toEqual([]);
  });
});

test('the Pine tools say which of them read and which can replace text', async () => {
  const { client } = await startHarness();

  const { tools } = await client.listTools();
  const hints = Object.fromEntries(
    tools
      .filter(({ name }) => name.startsWith('pine_'))
      .map(({ name, annotations }) => [
        name,
        [annotations?.readOnlyHint, annotations?.destructiveHint],
      ]),
  );

  expect(hints).toEqual({
    pine_new: [false, true],
    pine_open: [false, true],
    pine_get_source: [true, false],
    pine_set_source: [false, true],
    pine_list_scripts: [true, false],
    pine_save: [false, false],
    pine_analyze: [true, false],
    pine_compile: [false, false],
    pine_get_errors: [true, false],
    pine_get_console: [true, false],
    pine_smart_compile: [false, true],
    pine_get_lines: [true, false],
    pine_get_labels: [true, false],
    pine_get_boxes: [true, false],
    pine_get_tables: [true, false],
  });
});

// The id every text is compiled as: it names no script.
const COMPILE_ID = 'USER;00000000000000000000000000000000';
const ISO = expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/) as string;
const SECONDS = expect.any(Number) as number;
const BROKEN =
  '//@version=6\r\nindicator("Broken")\r\nplot(undeclared_x)\r\nx = deprecated_f()\r\nlegacy_error\r\n';
const BROKEN_ERRORS = [
  {
    line: 3,
    column: 6,
    endLine: 3,
    endColumn: 17,
    message: 'Undeclared identifier "undeclared_x"',
    severity: 'error',
  },
  {
    line: 5,
    column: 1,
    endLine: null,
    endColumn: null,
    message: 'Syntax error at input "legacy_error"',
    severity: 'error',
  },
];
const BROKEN_WARNINGS = [
  {
    line: 4,
    column: 5,
    endLine: 4,
    endColumn: 16,
    message: 'The function deprecated_f is deprecated',
    severity: 'warning',
  },
];

// The fixture with room for `limit` studies on the chart.
function withStudyRoom(limit: number, from: TvStateFixture): TvStateFixture {
  return { ...from, planLimits: { ...from.planLimits, INDICATORS_ON_CHART: limit } };
}

const studyIdsOf = (win: FakeTvWindow) =>
  win.TradingViewApi?.activeChart()
    .getAllStudies()
    .map(({ id }) => id);

// Holds the next createStudy of the chart until release() is called. called settles once it was
// called, so that a test can start another call while an indicator_add is halfway.
function holdCreateStudy(win: FakeTvWindow): { called: Promise<void>; release: () => void } {
  const chart = win.TradingViewApi?.activeChart();
  if (chart === undefined) {
    throw new Error('The fake window has no chart');
  }
  const createStudy = chart.createStudy;
  let enter = (): void => undefined;
  const called = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  chart.createStudy = async (...args: Parameters<typeof createStudy>) => {
    enter();
    await released;
    return createStudy(...args);
  };
  return { called, release };
}

describe('pine_compile', () => {
  test('pine_compile compiles the editor source without touching the chart', async () => {
    const { client, win, ctx } = await startHarness(withEditor());
    const studies = studyIdsOf(win);

    const result = await callTool(client, 'pine_compile', {});

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: {
        success: true,
        errors: [],
        warnings: [],
        addedToChart: false,
        studyId: null,
        compiledAt: SECONDS,
        compiledAtIso: ISO,
      },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(callsOf(win, 'translateScriptAsync')).toEqual([[fixture.pineEditor.source, COMPILE_ID]]);
    expect(callsOf(win, 'pineFacade.addToChart')).toEqual([]);
    expect(callsOf(win, 'chart.createStudy')).toEqual([]);
    expect(studyIdsOf(win)).toEqual(studies);
    expect(ctx.session.lastPineCompile).toEqual(dataOf(result));
  });

  test('pine_compile with source compiles that text instead', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'pine_compile', { source: NEW_SOURCE });

    expect(dataOf(result)).toMatchObject({ success: true, addedToChart: false, studyId: null });
    expect(callsOf(win, 'translateScriptAsync')).toEqual([[NEW_SOURCE, COMPILE_ID]]);
    // The editor is neither opened nor read.
    expect(callsOf(win, 'pineEditorApi.open')).toEqual([]);
  });

  test('pine_compile rejects source together with addToChart', async () => {
    const { client, win } = await startHarness(withEditor());

    const result = await callTool(client, 'pine_compile', { source: NEW_SOURCE, addToChart: true });

    expect(errorOf(result)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(errorOf(result)?.hint).toContain('pine_set_source');
    expect(callsOf(win, 'translateScriptAsync')).toEqual([]);
    expect(callsOf(win, 'pineFacade.addToChart')).toEqual([]);
  });

  test('pine_compile reports errors with positions', async () => {
    const { client, ctx } = await startHarness();

    const result = await callTool(client, 'pine_compile', { source: BROKEN });

    expect(result.isError).toBeFalsy();
    expect(dataOf(result)).toStrictEqual({
      success: false,
      errors: BROKEN_ERRORS,
      warnings: BROKEN_WARNINGS,
      addedToChart: false,
      studyId: null,
      compiledAt: SECONDS,
      compiledAtIso: ISO,
    });
    expect(ctx.session.lastPineCompile).toEqual(dataOf(result));
  });

  test('pine_compile fails NOT_AVAILABLE without source while the editor is closed', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'pine_compile', {});

    expect(errorOf(result)).toMatchObject({ code: 'NOT_AVAILABLE' });
    expect(errorOf(result)?.hint).toMatch(/pine_open.*pine_new|pine_new.*pine_open/);
    expect(callsOf(win, 'translateScriptAsync')).toEqual([]);
    expect(callsOf(win, 'pineEditorApi.open')).toEqual([]);
  });

  test('pine_compile reports an HTTP failure as a typed error, not as compile errors', async () => {
    const { client, win, ctx } = await startHarness();
    editorOf(win).compileHttpError = 'The size of the script compilation request is too large.';

    const result = await callTool(client, 'pine_compile', { source: NEW_SOURCE });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: 'The size of the script compilation request is too large.',
    });
    expect(ctx.session.lastPineCompile).toBeNull();
  });

  test('pine_compile with addToChart returns PLAN_LIMIT on a full chart', async () => {
    const { client, win } = await startHarness(withEditor());
    const studies = studyIdsOf(win);

    const result = await callTool(client, 'pine_compile', { addToChart: true });

    expect(errorOf(result)).toMatchObject({
      code: 'PLAN_LIMIT',
      details: { feature: 'INDICATORS_ON_CHART', limit: 2 },
    });
    expect(callsOf(win, 'pineFacade.addToChart')).toEqual([]);
    expect(callsOf(win, 'dialog.paywall')).toEqual([]);
    expect(studyIdsOf(win)).toEqual(studies);
  });

  test('pine_compile with addToChart refuses, and adds nothing, when nothing says whether the chart has room', async () => {
    // The chart model cannot check, and the plan reports no indicator limit.
    const otherLimits = Object.fromEntries(
      Object.entries(fixture.planLimits).filter(([feature]) => feature !== 'INDICATORS_ON_CHART'),
    );
    const { client, win } = await startHarness({ ...withEditor(), planLimits: otherLimits });
    const model = win.TradingViewApi?.activeChart()._chartWidget.model();
    delete model?.canCreateStudy;
    const studies = studyIdsOf(win);

    const result = await callTool(client, 'pine_compile', { addToChart: true });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      hint: expect.stringMatching(/cannot be read.*TradingView itself/) as string,
      details: { feature: 'INDICATORS_ON_CHART' },
    });
    expect(callsOf(win, 'pineFacade.addToChart')).toEqual([]);
    expect(inspectFakeWindow(win).calls.filter(({ name }) => name.startsWith('dialog.'))).toEqual(
      [],
    );
    expect(studyIdsOf(win)).toEqual(studies);
  });

  test('pine_compile with addToChart waits for an indicator_add in progress, and then finds the chart full', async () => {
    const { client, win } = await startHarness(withStudyRoom(3, withEditor()));
    const held = holdCreateStudy(win);

    const adding = callTool(client, 'indicator_add', { name: 'RSI' });
    await held.called;
    const compiling = callTool(client, 'pine_compile', { addToChart: true });
    await delay(200);
    held.release();
    const [added, compiled] = await Promise.all([adding, compiling]);

    expect(dataOf(added)).toMatchObject({ id: 'NEW001' });
    expect(errorOf(compiled)).toMatchObject({
      code: 'PLAN_LIMIT',
      details: { feature: 'INDICATORS_ON_CHART', limit: 3 },
    });
    expect(callsOf(win, 'pineFacade.addToChart')).toEqual([]);
    expect(callsOf(win, 'dialog.paywall')).toEqual([]);
    expect(studyIdsOf(win)).toEqual(['STUDY01', 'STUDY02', 'NEW001']);
  });

  test('pine_compile with addToChart adds the script when a slot is free', async () => {
    const { client, win, ctx } = await startHarness(withStudyRoom(3, withEditor()));

    const result = await callTool(client, 'pine_compile', { addToChart: true });

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: {
        success: true,
        errors: [],
        warnings: [],
        addedToChart: true,
        studyId: 'NEW001',
        compiledAt: SECONDS,
        compiledAtIso: ISO,
      },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(callsOf(win, 'pineFacade.addToChart')).toEqual([[]]);
    expect(studyIdsOf(win)).toContain('NEW001');
    expect(ctx.session.createdStudyIds).toEqual(new Set(['NEW001']));
    expect(ctx.session.lastPineCompile).toEqual(dataOf(result));
    expect(callsOf(win, 'translateScriptAsync')).toEqual([]);
    expect(inspectFakeWindow(win).calls.filter(({ name }) => name.startsWith('dialog.'))).toEqual(
      [],
    );
  });

  test('pine_compile with addToChart reports the compile errors of a new script it added', async () => {
    const { client, win, ctx } = await startHarness(
      withStudyRoom(3, withEditor({ script: null, source: BROKEN, savedSource: BROKEN })),
    );

    const result = await callTool(client, 'pine_compile', { addToChart: true });

    expect(dataOf(result)).toStrictEqual({
      success: false,
      errors: BROKEN_ERRORS,
      warnings: BROKEN_WARNINGS,
      addedToChart: true,
      studyId: 'NEW001',
      compiledAt: SECONDS,
      compiledAtIso: ISO,
    });
    expect(warningsOf(result).join(' ')).toContain('draft');
    expect(ctx.session.createdStudyIds).toEqual(new Set(['NEW001']));
    expect(win.TradingViewApi?.activeChart().getStudyById('NEW001').study().hasCompileError()).toBe(
      true,
    );
  });

  test('pine_compile with addToChart refuses a saved script with unsaved changes before acting', async () => {
    const { client, win } = await startHarness(withStudyRoom(3, modified()));

    const result = await callTool(client, 'pine_compile', { addToChart: true });

    expect(errorOf(result)).toMatchObject({ code: 'NOT_AVAILABLE' });
    expect(errorOf(result)?.hint).toContain('pine_save');
    expect(errorOf(result)?.hint).toContain('pine_new');
    expect(callsOf(win, 'pineFacade.addToChart')).toEqual([]);
    expect(callsOf(win, 'dialog.confirmSaveChanges')).toEqual([]);
    expect(editorOf(win).source).toBe(EDITED);
  });

  test('pine_compile with addToChart fails AUTH_REQUIRED while signed out', async () => {
    const { client, win } = await startHarness(withStudyRoom(3, withEditor()));
    editorOf(win).signedIn = false;

    const result = await callTool(client, 'pine_compile', { addToChart: true });

    expect(errorOf(result)).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(callsOf(win, 'pineFacade.addToChart')).toEqual([]);
    expect(callsOf(win, 'dialog.signIn')).toEqual([]);
  });

  test('pine_compile refuses an empty text before compiling', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'pine_compile', { source: ' \n ' });

    expect(errorOf(result)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(callsOf(win, 'translateScriptAsync')).toEqual([]);
  });

  test('pine_compile with addToChart says so when TradingView adds no study', async () => {
    const { client, win, ctx } = await startHarness(withStudyRoom(3, withEditor()));
    const facade = win.TradingViewApi?.pineEditorApi().getDialogFacade();
    if (facade === null || facade === undefined) {
      throw new Error('The editor must be open');
    }
    facade.addToChart = () => Promise.resolve();

    const result = await callTool(client, 'pine_compile', { addToChart: true });

    expect(dataOf(result)).toMatchObject({
      success: false,
      errors: [],
      addedToChart: false,
      studyId: null,
    });
    expect(warningsOf(result).join(' ')).toContain('No new study appeared');
    expect(ctx.session.createdStudyIds).toEqual(new Set());
  });

  test('pine_compile with addToChart records only the Pine study, not one that appeared with it', async () => {
    const { client, win, ctx } = await startHarness(withStudyRoom(5, withEditor()));
    const chart = win.TradingViewApi?.activeChart();
    const facade = win.TradingViewApi?.pineEditorApi().getDialogFacade();
    if (facade === null || facade === undefined || chart === undefined) {
      throw new Error('The editor must be open');
    }
    const add = facade.addToChart.bind(facade);
    facade.addToChart = async () => {
      await add();
      // A built-in added at the same moment, after the script.
      await chart.createStudy({ type: 'java', studyId: 'RSI@tv-basicstudies' });
    };

    const result = await callTool(client, 'pine_compile', { addToChart: true });

    expect(studyIdsOf(win)).toEqual(['STUDY01', 'STUDY02', 'NEW001', 'NEW002']);
    expect(dataOf(result)).toMatchObject({ success: true, addedToChart: true, studyId: 'NEW001' });
    expect(ctx.session.createdStudyIds).toEqual(new Set(['NEW001']));
  });

  test('a Pine study the user adds at the same moment is not adopted as created by the session', async () => {
    // A standard Pine script the user adds right after the script of the editor.
    const userAdds = (win: FakeTvWindow) =>
      win.TradingViewApi?.activeChart().createStudy({
        type: 'pine',
        pineId: 'STD;RSI',
        pineVersion: 'last',
      });
    const facadeOf = (win: FakeTvWindow) => {
      const facade = win.TradingViewApi?.pineEditorApi().getDialogFacade();
      if (facade === null || facade === undefined) {
        throw new Error('The editor must be open');
      }
      return facade;
    };

    const both = await startHarness(withStudyRoom(5, withEditor()));
    const facade = facadeOf(both.win);
    const add = facade.addToChart.bind(facade);
    facade.addToChart = async () => {
      await add();
      await userAdds(both.win);
    };

    const result = await callTool(both.client, 'pine_compile', { addToChart: true });

    // The last new Pine study is the user's; the one of the script is NEW001.
    expect(studyIdsOf(both.win)).toEqual(['STUDY01', 'STUDY02', 'NEW001', 'NEW002']);
    expect(dataOf(result)).toMatchObject({ success: true, addedToChart: true, studyId: 'NEW001' });
    expect(both.ctx.session.createdStudyIds).toEqual(new Set(['NEW001']));

    // TradingView adds nothing for the script, and the user adds a study meanwhile.
    const only = await startHarness(withStudyRoom(5, withEditor()));
    facadeOf(only.win).addToChart = async () => {
      await userAdds(only.win);
    };

    const alone = await callTool(only.client, 'pine_compile', { addToChart: true });

    expect(studyIdsOf(only.win)).toEqual(['STUDY01', 'STUDY02', 'NEW001']);
    expect(dataOf(alone)).toMatchObject({ addedToChart: false, studyId: null });
    expect(only.ctx.session.createdStudyIds).toEqual(new Set());
    expect(warningsOf(alone).join(' ')).toMatch(
      /only NEW001, .*not taken for the script.*another script/,
    );
  });

  test('pine_compile with addToChart tells the study of a new script by the title it declares when its id is unknown', async () => {
    const { client, win, ctx } = await startHarness(
      withStudyRoom(5, withEditor({ script: null, source: NEW_SOURCE, savedSource: NEW_SOURCE })),
    );
    const facade = win.TradingViewApi?.pineEditorApi().getDialogFacade();
    if (facade === null || facade === undefined) {
      throw new Error('The editor must be open');
    }
    const add = facade.addToChart.bind(facade);
    facade.addToChart = async () => {
      await add();
      await win.TradingViewApi?.activeChart().createStudy({
        type: 'pine',
        pineId: 'STD;RSI',
        pineVersion: 'last',
      });
    };
    // The editor does not tell which script it holds after the add.
    facade.getScriptIdVersion = () => {
      throw new Error('No script yet');
    };

    const result = await callTool(client, 'pine_compile', { addToChart: true });

    // NEW_SOURCE declares the title Breakout, which names the study of the script.
    expect(dataOf(result)).toMatchObject({ addedToChart: true, studyId: 'NEW001' });
    expect(ctx.session.createdStudyIds).toEqual(new Set(['NEW001']));
  });

  test('pine_compile with addToChart takes no study for the script when neither its id nor a title tells it', async () => {
    const untitled = '//@version=6\nindicator(title = name)\nplot(close)\n';
    const { client, win, ctx } = await startHarness(
      withStudyRoom(5, withEditor({ script: null, source: untitled, savedSource: untitled })),
    );
    const facade = win.TradingViewApi?.pineEditorApi().getDialogFacade();
    if (facade === null || facade === undefined) {
      throw new Error('The editor must be open');
    }
    const add = facade.addToChart.bind(facade);
    facade.addToChart = async () => {
      await add();
      await win.TradingViewApi?.activeChart().createStudy({
        type: 'pine',
        pineId: 'STD;RSI',
        pineVersion: 'last',
      });
    };
    facade.getScriptIdVersion = () => null;

    const result = await callTool(client, 'pine_compile', { addToChart: true });

    expect(dataOf(result)).toMatchObject({ addedToChart: false, studyId: null });
    expect(ctx.session.createdStudyIds).toEqual(new Set());
    expect(warningsOf(result).join(' ')).toMatch(
      /only NEW001, NEW002, which are not taken for the script.*neither the id of the script nor a title/,
    );
  });

  test('pine_compile with addToChart takes no study that is not a Pine study for the script', async () => {
    const { client, win, ctx } = await startHarness(withStudyRoom(5, withEditor()));
    const chart = win.TradingViewApi?.activeChart();
    const facade = win.TradingViewApi?.pineEditorApi().getDialogFacade();
    if (facade === null || facade === undefined || chart === undefined) {
      throw new Error('The editor must be open');
    }
    facade.addToChart = async () => {
      await chart.createStudy({ type: 'java', studyId: 'RSI@tv-basicstudies' });
    };

    const result = await callTool(client, 'pine_compile', { addToChart: true });

    expect(dataOf(result)).toMatchObject({ success: false, addedToChart: false, studyId: null });
    expect(ctx.session.createdStudyIds).toEqual(new Set());
    expect(warningsOf(result).join(' ')).toContain(
      'No new Pine study appeared on the chart, only NEW001',
    );
  });

  test('pine_compile with addToChart gives the add only what is left of the wait', async () => {
    // A call timeout of 2000 ms leaves the page 1000 ms; reading the source takes 400 of them.
    const { client, win } = await startHarness(withStudyRoom(5, withEditor()), {}, 2000);
    const facade = win.TradingViewApi?.pineEditorApi().getDialogFacade();
    if (facade === null || facade === undefined) {
      throw new Error('The editor must be open');
    }
    const read = facade.getSource.bind(facade);
    facade.getSource = async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return read();
    };
    facade.addToChart = () => new Promise(() => undefined);

    const result = await callTool(client, 'pine_compile', { addToChart: true });

    const error = errorOf(result);
    expect(error).toMatchObject({ code: 'TIMEOUT' });
    expect(error?.hint).toContain('indicator_list');
    const waited = error?.details?.waitMs;
    expect(typeof waited).toBe('number');
    expect(waited as number).toBeLessThanOrEqual(600);
  });

  test('pine_compile with addToChart warns about a compile error the console gives no details of', async () => {
    const { client, win } = await startHarness(
      withStudyRoom(3, withEditor({ script: null, source: BROKEN, savedSource: BROKEN })),
    );
    const facade = win.TradingViewApi?.pineEditorApi().getDialogFacade();
    if (facade === null || facade === undefined) {
      throw new Error('The editor must be open');
    }
    const add = facade.addToChart.bind(facade);
    facade.addToChart = async () => {
      await add();
      editorOf(win).consoleMessages.length = 0;
    };

    const result = await callTool(client, 'pine_compile', { addToChart: true });

    expect(dataOf(result)).toMatchObject({
      success: false,
      errors: [],
      addedToChart: true,
      studyId: 'NEW001',
    });
    expect(warningsOf(result).join(' ')).toContain('gave no details');
  });

  test('pine_compile with addToChart fails NOT_AVAILABLE while the editor is closed', async () => {
    const { client, win } = await startHarness(withStudyRoom(3, fixture));

    const result = await callTool(client, 'pine_compile', { addToChart: true });

    expect(errorOf(result)).toMatchObject({ code: 'NOT_AVAILABLE' });
    expect(callsOf(win, 'pineFacade.addToChart')).toEqual([]);
    expect(callsOf(win, 'pineEditorApi.open')).toEqual([]);
  });

  test('pine_compile with addToChart resolves the active chart once', async () => {
    const { client, win } = await startHarness(withStudyRoom(3, withEditor()));
    const asked = recordChartLookups(win);

    const result = await callTool(client, 'pine_compile', { addToChart: true });
    const lookups = asked.splice(0);

    expect(dataOf(result)).toMatchObject({ success: true, addedToChart: true, studyId: 'NEW001' });
    // The room check asks the layout which chart is active. The editor adds to the active chart
    // only, so the add checks right before it acts that the active chart is still that one; the
    // studies before the add and the study it added are read on that chart, by its index.
    expect(lookups[0]).toBe('activeChartIndex');
    expect(lookups.filter((name) => !name.startsWith('chart:'))).toEqual([
      'activeChartIndex',
      'activeChartIndex',
    ]);
    expect(new Set(lookups.filter((name) => name.startsWith('chart:')))).toEqual(
      new Set(['chart:0']),
    );
  });

  test('pine_compile with addToChart adds nothing when the active chart changed after its room was checked', async () => {
    const twoCharts = { ...withEditor(), layout: { ...fixture.layout, chartsCount: 2 } };
    const { client, win } = await startHarness(withStudyRoom(3, twoCharts));
    const model = win.TradingViewApi?.activeChart()._chartWidget.model();
    const check = model?.canCreateStudy;
    if (model === undefined || check === undefined) {
      throw new Error('The chart model must check the room for a study');
    }
    // The user makes the other chart of the layout the active one right after the room check.
    model.canCreateStudy = (spec) => {
      const answer = check(spec);
      inspectFakeWindow(win).state.activeChartIndex = 1;
      return answer;
    };

    const result = await callTool(client, 'pine_compile', { addToChart: true });

    expect(errorOf(result)).toMatchObject({ code: 'NOT_AVAILABLE', details: { chartIndex: 0 } });
    expect(errorOf(result)?.hint).toContain('pine_compile');
    expect(callsOf(win, 'pineFacade.addToChart')).toEqual([]);
    expect(inspectFakeWindow(win).calls.filter(({ name }) => name.startsWith('dialog.'))).toEqual(
      [],
    );
  });
});

describe('pine_get_errors', () => {
  test('pine_get_errors returns the last compile result of the session', async () => {
    const { client } = await startHarness();

    const before = await callTool(client, 'pine_get_errors', {});
    expect(dataOf(before)).toStrictEqual({
      success: true,
      errors: [],
      warnings: [],
      addedToChart: false,
      studyId: null,
      compiledAt: null,
      compiledAtIso: null,
    });

    const compiled = await callTool(client, 'pine_compile', { source: BROKEN });
    const after = await callTool(client, 'pine_get_errors', {});

    expect(dataOf(after)).toStrictEqual(dataOf(compiled));
    expect(dataOf(after)).toMatchObject({ success: false, errors: BROKEN_ERRORS });
  });
});

// A local clock time `minutesAgo` minutes ago, as the console of the editor keeps it.
function clockAgo(minutesAgo: number): string {
  const date = new Date(Date.now() - minutesAgo * 60_000);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

// The fixture whose first study writes `logs`.
function withLogs(logs: NonNullable<TvStateFixture['studies'][number]['logs']>, from = fixture) {
  const [first, ...rest] = from.studies;
  if (first === undefined) {
    throw new Error('The fixture must hold a study');
  }
  return { ...from, studies: [{ ...first, logs }, ...rest] };
}

describe('pine_get_console', () => {
  test('pine_get_console merges editor and script messages newest first', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { client, win } = await startHarness(
      withLogs(
        [
          // Milliseconds and seconds: numbers above 1e11 are taken as milliseconds.
          { barTime: now - 1200, time: (now - 1200) * 1000, level: 'info', message: 'older log' },
          { barTime: now - 300, time: now - 300, level: 'error', message: 'newer log' },
        ],
        withEditor(),
      ),
    );
    const older = clockAgo(30);
    const newer = clockAgo(10);
    editorOf(win).consoleMessages.push(
      { level: 'info', text: 'Compiling...', time: older },
      { level: 'error', text: 'Compilation error', time: newer },
    );

    const result = await callTool(client, 'pine_get_console', {});

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: {
        messages: [
          {
            time: now - 300,
            timeIso: isoOf(now - 300),
            level: 'error',
            text: 'newer log',
            source: 'script',
            studyId: 'STUDY01',
          },
          {
            time: null,
            timeIso: null,
            level: 'error',
            text: 'Compilation error',
            source: 'editor',
            clock: newer,
          },
          {
            time: now - 1200,
            timeIso: isoOf(now - 1200),
            level: 'info',
            text: 'older log',
            source: 'script',
            studyId: 'STUDY01',
          },
          {
            time: null,
            timeIso: null,
            level: 'info',
            text: 'Compiling...',
            source: 'editor',
            clock: older,
          },
        ],
      },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
  });

  test('pine_get_console keeps the newest limit messages', async () => {
    const { client, win } = await startHarness(withEditor());
    editorOf(win).consoleMessages.push(
      { level: 'info', text: 'one', time: clockAgo(3) },
      { level: 'info', text: 'two', time: clockAgo(2) },
      { level: 'warning', text: 'three', time: clockAgo(1) },
    );

    const result = await callTool(client, 'pine_get_console', { limit: 2 });

    expect((dataOf(result).messages as { text: string }[]).map(({ text }) => text)).toEqual([
      'three',
      'two',
    ]);
  });

  test('pine_get_console warns when the Pine logs of a study are not enabled, and enables none', async () => {
    const { client, win } = await startHarness(withLogs([]));

    const result = await callTool(client, 'pine_get_console', {});

    expect(dataOf(result)).toEqual({ messages: [] });
    expect(warningsOf(result).join(' ')).toMatch(/STUDY01.*not enabled|not enabled.*STUDY01/);
    expect(inspectFakeWindow(win).calls.map(({ name }) => name)).toEqual([]);
  });

  test('pine_get_console warns when the console of the editor cannot be read', async () => {
    const { client, win } = await startHarness(withEditor());
    const facade = win.TradingViewApi?.pineEditorApi().getDialogFacade();
    Object.defineProperty(facade, '_editorStore', { value: undefined });

    const result = await callTool(client, 'pine_get_console', {});

    expect(dataOf(result)).toEqual({ messages: [] });
    expect(warningsOf(result).join(' ')).toContain('could not be read');
  });

  test('pine_get_console reads no editor messages while the editor is closed', async () => {
    const { client, win } = await startHarness();
    editorOf(win).consoleMessages.push({ level: 'info', text: 'hidden', time: clockAgo(1) });

    const result = await callTool(client, 'pine_get_console', {});

    expect(dataOf(result)).toEqual({ messages: [] });
    expect(warningsOf(result).join(' ')).toContain('not open');
    expect(callsOf(win, 'pineEditorApi.open')).toEqual([]);
  });
});

describe('pine_analyze', () => {
  const SOURCE = '//@version=5\nstudy("T")\nx = tostring(close)\n';

  test('pine_analyze with source works without TradingView', async () => {
    // A debug port nothing listens on: a call that reached for the connection would fail.
    const dead = await startFakeCdpServer({
      targets: loadTargetsFixture({ chartWindow: () => createFakeTvWindow(fixture) }),
    });
    const config = testConfig({ cdpPort: dead.port, callTimeoutMs: 500 });
    await dead.close();
    const { server, ctx } = createMcpServer(config, {
      launcher: refusingLauncher(),
      logger: quietLogger,
    });
    cleanups.push(() => ctx.connection.close());
    const client = await connect(server);

    const result = await callTool(client, 'pine_analyze', { source: SOURCE });

    expect(result.isError).not.toBe(true);
    expect(envelopeOf(result).meta.via).toBe('local');
    expect(dataOf(result)).toMatchObject({ version: 5 });
    const diagnostics = dataOf(result).diagnostics as { ruleId: string; line: number }[];
    expect(diagnostics.map(({ ruleId, line }) => [ruleId, line])).toEqual([
      ['study-declaration', 2],
      ['str-namespace', 3],
    ]);
  });

  test('pine_analyze without source analyzes the text of the open editor', async () => {
    const { client } = await startHarness(withEditor({ source: 'plot(close)\n' }));

    const result = await callTool(client, 'pine_analyze', {});

    const data = dataOf(result);
    expect(data.version).toBeNull();
    expect((data.diagnostics as { ruleId: string }[]).map(({ ruleId }) => ruleId)).toEqual([
      'missing-version',
      'missing-declaration',
    ]);
    expect(envelopeOf(result).meta.via).toBe('internal');
  });

  test('pine_analyze without source fails NOT_AVAILABLE while the editor is closed', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'pine_analyze', {});

    expect(errorOf(result)).toMatchObject({ code: 'NOT_AVAILABLE' });
    expect(callsOf(win, 'pineEditorApi.open')).toEqual([]);
  });
});

// Runs `hook` as each compilation of the fake app starts, with the number of the compilation
// counted from 1, before the compiler answers: to change the app while a call is compiling, or to
// hold a compilation back.
function onCompile(win: FakeTvWindow, hook: (call: number) => Promise<void> | void): void {
  let handed: FakeWebpackRequire | undefined;
  (win.webpackChunktradingview as { push(chunk: unknown): unknown }).push([
    ['probe'],
    {},
    (given: FakeWebpackRequire) => (handed = given),
  ]);
  const client = Object.values(handed?.c ?? {}).find(
    (record) =>
      typeof (record.exports as Record<string, unknown>).translateScriptAsync === 'function',
  );
  if (client === undefined) {
    throw new Error('The fake app must have a Pine compiler');
  }
  const exports = client.exports as Record<string, unknown>;
  const compile = exports.translateScriptAsync as (source: string, id: string) => Promise<unknown>;
  let calls = 0;
  exports.translateScriptAsync = async (source: string, id: string) => {
    calls += 1;
    await hook(calls);
    return compile(source, id);
  };
}

describe('pine_smart_compile', () => {
  // A script written for Pine v4 under a v6 header, which the compiler rejects, and its fixed form.
  const V4_IN_V6 = '//@version=6\nstudy("x")\nplot(rsi(close,14))\n';
  const FIXED = '//@version=6\nindicator("x")\nplot(ta.rsi(close,14))\n';
  const FIX_STUDY = 'Replace study( with indicator(';
  const FIX_RSI = 'Replace rsi( with ta.rsi(';
  const FIXED_DIFF = [
    '@@ -1,3 +1,3 @@',
    ' //@version=6',
    '-study("x")',
    '-plot(rsi(close,14))',
    '+indicator("x")',
    '+plot(ta.rsi(close,14))',
    '',
  ].join('\n');
  const undeclared = (name: string, line: number, column: number) => ({
    line,
    column,
    endLine: line,
    endColumn: column + name.length - 1,
    message: `Undeclared identifier "${name}"`,
    severity: 'error',
  });
  // What the compiler says for a call of a v4 name in a script of version 6, as the compiler of
  // TradingView words it; it reports nothing after it, so of study and rsi only study.
  const notFound = (name: string, line: number, column: number) => ({
    line,
    column,
    endLine: line,
    endColumn: column + name.length - 1,
    message: `Could not find function or function reference '${name}'`,
    severity: 'error',
  });
  const V4_ERRORS = [notFound('study', 2, 1)];
  // The editor holding `source` as its saved text, so that it has no unsaved changes.
  const saved = (source: string) => withEditor({ source, savedSource: source });

  test('smart compile fixes v4-style calls in a v6 script in two attempts', async () => {
    const { client, win, ctx } = await startHarness();

    const result = await callTool(client, 'pine_smart_compile', { source: V4_IN_V6 });

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: {
        success: true,
        attempts: [
          { errors: V4_ERRORS, applied: [FIX_STUDY, FIX_RSI] },
          { errors: [], applied: [] },
        ],
        source: FIXED,
        diff: FIXED_DIFF,
        writtenBack: false,
      },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(callsOf(win, 'translateScriptAsync')).toEqual([
      [V4_IN_V6, COMPILE_ID],
      [FIXED, COMPILE_ID],
    ]);
    // The text was given, so the editor is not opened, read or changed, and nothing is added.
    expect(callsOf(win, 'pineEditorApi.open')).toEqual([]);
    expect(callsOf(win, 'pineFacade.setScript')).toEqual([]);
    expect(callsOf(win, 'pineFacade.addToChart')).toEqual([]);
    expect(callsOf(win, 'chart.createStudy')).toEqual([]);
    expect(ctx.session.lastPineCompile).toMatchObject({
      success: true,
      errors: [],
      addedToChart: false,
      studyId: null,
    });
  });

  test('smart compile with one attempt compiles once and changes nothing', async () => {
    const { client, win, ctx } = await startHarness();

    const result = await callTool(client, 'pine_smart_compile', {
      source: V4_IN_V6,
      maxAttempts: 1,
    });

    // A fix is applied only when another compilation follows, so one attempt changes nothing.
    expect(dataOf(result)).toStrictEqual({
      success: false,
      attempts: [{ errors: V4_ERRORS, applied: [] }],
      source: V4_IN_V6,
      diff: '',
      writtenBack: false,
    });
    expect(callsOf(win, 'translateScriptAsync')).toEqual([[V4_IN_V6, COMPILE_ID]]);
    expect(ctx.session.lastPineCompile).toMatchObject({ success: false, errors: V4_ERRORS });
  });

  // Three v4 calls that the variables of the same names keep the analyzer from fixing, so only the
  // errors of the compiler lead to them. A compiler that stops at its first error reports one a
  // time, which takes one compilation each.
  const SEVERAL =
    '//@version=6\nindicator("x")\nrsi = rsi(close, 14)\nsma = sma(close, 14)\n' +
    'ema = ema(close, 14)\nplot(rsi + sma + ema)\n';
  const FIX_SMA = 'Replace sma( with ta.sma(';
  const FIX_EMA = 'Replace ema( with ta.ema(';

  test('smart compile stops after three attempts by default and returns the last errors', async () => {
    const { client, win, ctx } = await startHarness();
    editorOf(win).compileFirstErrorOnly = true;

    const result = await callTool(client, 'pine_smart_compile', { source: SEVERAL });

    const twoFixed = SEVERAL.replace('rsi = rsi(', 'rsi = ta.rsi(').replace(
      'sma = sma(',
      'sma = ta.sma(',
    );
    expect(dataOf(result)).toStrictEqual({
      success: false,
      attempts: [
        { errors: [notFound('rsi', 3, 7)], applied: [FIX_RSI] },
        { errors: [notFound('sma', 4, 7)], applied: [FIX_SMA] },
        { errors: [notFound('ema', 5, 7)], applied: [] },
      ],
      // The text of the last attempt, which the errors belong to.
      source: twoFixed,
      diff: [
        '@@ -1,6 +1,6 @@',
        ' //@version=6',
        ' indicator("x")',
        '-rsi = rsi(close, 14)',
        '-sma = sma(close, 14)',
        '+rsi = ta.rsi(close, 14)',
        '+sma = ta.sma(close, 14)',
        ' ema = ema(close, 14)',
        ' plot(rsi + sma + ema)',
        '',
      ].join('\n'),
      writtenBack: false,
    });
    expect(callsOf(win, 'translateScriptAsync')).toHaveLength(3);
    expect(ctx.session.lastPineCompile).toMatchObject({
      success: false,
      errors: [notFound('ema', 5, 7)],
    });
  });

  test('smart compile stops after maxAttempts and returns the last errors', async () => {
    const { client, win, ctx } = await startHarness();
    editorOf(win).compileFirstErrorOnly = true;

    const result = await callTool(client, 'pine_smart_compile', {
      source: SEVERAL,
      maxAttempts: 2,
    });

    expect(dataOf(result)).toMatchObject({
      success: false,
      attempts: [
        { errors: [notFound('rsi', 3, 7)], applied: [FIX_RSI] },
        { errors: [notFound('sma', 4, 7)], applied: [] },
      ],
      source: SEVERAL.replace('rsi = rsi(', 'rsi = ta.rsi('),
    });
    expect(callsOf(win, 'translateScriptAsync')).toHaveLength(2);
    expect(ctx.session.lastPineCompile).toMatchObject({
      success: false,
      errors: [notFound('sma', 4, 7)],
    });
  });

  test('smart compile goes on while fixes apply, up to five attempts', async () => {
    const { client, win } = await startHarness();
    editorOf(win).compileFirstErrorOnly = true;

    const result = await callTool(client, 'pine_smart_compile', {
      source: SEVERAL,
      maxAttempts: 5,
    });

    expect(dataOf(result)).toMatchObject({
      success: true,
      attempts: [
        { applied: [FIX_RSI] },
        { applied: [FIX_SMA] },
        { applied: [FIX_EMA] },
        { errors: [], applied: [] },
      ],
      source: SEVERAL.replace('rsi = rsi(', 'rsi = ta.rsi(')
        .replace('sma = sma(', 'sma = ta.sma(')
        .replace('ema = ema(', 'ema = ta.ema('),
    });
    expect(callsOf(win, 'translateScriptAsync')).toHaveLength(4);
  });

  test('smart compile stops early when no fix applies and keeps the errors of the last attempt', async () => {
    const { client, win, ctx } = await startHarness();
    const source = '//@version=6\nstudy("x")\nplot(undeclared_a)\n';

    const result = await callTool(client, 'pine_smart_compile', { source, maxAttempts: 5 });

    // The first round fixes study, which leaves an error nothing here can fix.
    const fixed = '//@version=6\nindicator("x")\nplot(undeclared_a)\n';
    expect(dataOf(result)).toMatchObject({
      success: false,
      attempts: [
        // The compiler stops at study, so undeclared_a comes up only in the next round.
        { errors: [notFound('study', 2, 1)], applied: [FIX_STUDY] },
        { errors: [undeclared('undeclared_a', 3, 6)], applied: [] },
      ],
      source: fixed,
    });
    expect(callsOf(win, 'translateScriptAsync')).toEqual([
      [source, COMPILE_ID],
      [fixed, COMPILE_ID],
    ]);
    // pine_get_errors has the full result of the last attempt, whose text the call returns.
    const errors = await callTool(client, 'pine_get_errors', {});
    expect(dataOf(errors)).toStrictEqual(ctx.session.lastPineCompile);
    expect(dataOf(errors)).toMatchObject({
      success: false,
      errors: [undeclared('undeclared_a', 3, 6)],
    });
  });

  test('smart compile with applyFixes false only compiles once', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'pine_smart_compile', {
      source: V4_IN_V6,
      applyFixes: false,
    });

    expect(dataOf(result)).toStrictEqual({
      success: false,
      attempts: [{ errors: V4_ERRORS, applied: [] }],
      source: V4_IN_V6,
      diff: '',
      writtenBack: false,
    });
    expect(callsOf(win, 'translateScriptAsync')).toEqual([[V4_IN_V6, COMPILE_ID]]);
  });

  test('smart compile returns a script that already compiles as it is', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'pine_smart_compile', { source: FIXED });

    expect(dataOf(result)).toStrictEqual({
      success: true,
      attempts: [{ errors: [], applied: [] }],
      source: FIXED,
      diff: '',
      writtenBack: false,
    });
    expect(callsOf(win, 'translateScriptAsync')).toHaveLength(1);
  });

  test('smart compile without source fixes the text of the editor and leaves the editor as it is', async () => {
    const { client, win } = await startHarness(saved(V4_IN_V6));

    const result = await callTool(client, 'pine_smart_compile', {});

    expect(dataOf(result)).toMatchObject({ success: true, source: FIXED, writtenBack: false });
    expect(callsOf(win, 'translateScriptAsync')).toEqual([
      [V4_IN_V6, COMPILE_ID],
      [FIXED, COMPILE_ID],
    ]);
    expect(callsOf(win, 'pineFacade.setScript')).toEqual([]);
    expect(editorOf(win).source).toBe(V4_IN_V6);
  });

  test('smart compile works on a given text while the editor holds unsaved changes', async () => {
    const { client, win } = await startHarness(modified());

    const result = await callTool(client, 'pine_smart_compile', { source: V4_IN_V6 });

    expect(dataOf(result)).toMatchObject({ success: true, source: FIXED, writtenBack: false });
    expect(editorOf(win).source).toBe(EDITED);
    expect(callsOf(win, 'pineFacade.setScript')).toEqual([]);
  });

  test('smart compile without source fails NOT_AVAILABLE while the editor is closed', async () => {
    const { client, win, ctx } = await startHarness();

    const result = await callTool(client, 'pine_smart_compile', {});

    expect(errorOf(result)).toMatchObject({ code: 'NOT_AVAILABLE' });
    expect(errorOf(result)?.hint).toMatch(/pine_open.*pine_new|pine_new.*pine_open/);
    expect(callsOf(win, 'translateScriptAsync')).toEqual([]);
    expect(callsOf(win, 'pineEditorApi.open')).toEqual([]);
    expect(ctx.session.lastPineCompile).toBeNull();
  });

  test('smart compile writeBack refuses unsaved editor content without confirm', async () => {
    const { client, win, ctx } = await startHarness(withEditor({ source: V4_IN_V6 }));

    const result = await callTool(client, 'pine_smart_compile', { writeBack: true });

    expect(errorOf(result)).toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      details: { action: 'pine_smart_compile with writeBack' },
    });
    expect(errorOf(result)?.hint).toContain('confirm: true');
    // Refused before anything was compiled, and nothing was written.
    expect(callsOf(win, 'translateScriptAsync')).toEqual([]);
    expect(callsOf(win, 'pineFacade.setScript')).toEqual([]);
    expect(editorOf(win).source).toBe(V4_IN_V6);
    expect(ctx.session.lastPineCompile).toBeNull();
  });

  test('smart compile writeBack replaces unsaved editor content with confirm', async () => {
    const { client, win } = await startHarness(withEditor({ source: V4_IN_V6 }));

    const result = await callTool(client, 'pine_smart_compile', { writeBack: true, confirm: true });

    expect(envelopeOf(result)).toStrictEqual({
      ok: true,
      data: {
        success: true,
        attempts: [
          { errors: V4_ERRORS, applied: [FIX_STUDY, FIX_RSI] },
          { errors: [], applied: [] },
        ],
        source: FIXED,
        diff: FIXED_DIFF,
        writtenBack: true,
      },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    expect(callsOf(win, 'pineFacade.setScript')).toEqual([[FIXED]]);
    expect(editorOf(win).source).toBe(FIXED);
    // The editor now holds unsaved text; nothing was saved.
    expect(editorOf(win).savedSource).toBe(fixture.pineEditor.savedSource);
    expect(callsOf(win, 'pineFacade.saveScript')).toEqual([]);
    expect(callsOf(win, 'pineEditorApi.saveNewScript')).toEqual([]);
  });

  test('smart compile writeBack needs no confirm when the editor has no unsaved changes', async () => {
    const { client, win } = await startHarness(saved(V4_IN_V6));

    const result = await callTool(client, 'pine_smart_compile', { writeBack: true });

    expect(dataOf(result)).toMatchObject({ success: true, source: FIXED, writtenBack: true });
    expect(callsOf(win, 'pineFacade.setScript')).toEqual([[FIXED]]);
    expect(editorOf(win).source).toBe(FIXED);
  });

  test('smart compile writeBack writes the fixed text it was given into a closed editor, which it opens', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'pine_smart_compile', {
      source: V4_IN_V6,
      writeBack: true,
    });

    expect(dataOf(result)).toMatchObject({ success: true, source: FIXED, writtenBack: true });
    expect(callsOf(win, 'pineEditorApi.open')).toHaveLength(1);
    expect(callsOf(win, 'pineFacade.setScript')).toEqual([[FIXED]]);
    expect(editorOf(win).source).toBe(FIXED);
  });

  test('smart compile writeBack checks again when it writes, so that opening an editor with unsaved text is refused', async () => {
    // On its first open a closed editor shows the script it last held, here one with unsaved
    // changes.
    const { client, win, ctx } = await startHarness({
      ...fixture,
      pineEditor: { ...fixture.pineEditor, open: null, source: EDITED },
    });

    const result = await callTool(client, 'pine_smart_compile', {
      source: V4_IN_V6,
      writeBack: true,
    });

    expect(errorOf(result)).toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      details: { action: 'pine_smart_compile with writeBack' },
    });
    expect(callsOf(win, 'pineFacade.setScript')).toEqual([]);
    expect(editorOf(win).source).toBe(EDITED);
    // The compilation happened, and pine_get_errors keeps its result.
    expect(ctx.session.lastPineCompile).toMatchObject({ success: true });
  });

  // What the user does to the editor while a call compiles: opens the saved strategy, with the
  // text it was saved with or, when `unsaved`, with a line added.
  const opensStrategy = (win: FakeTvWindow, unsaved = false): void => {
    const editor = editorOf(win);
    const text = STRATEGY.source;
    editor.script = { scriptIdPart: STRATEGY.scriptIdPart, version: STRATEGY.version };
    editor.savedSource = text;
    editor.source = unsaved ? `${text}plot(close)\n` : text;
  };

  test('smart compile writeBack writes nothing when the editor opens another script during the compilation', async () => {
    const { client, win } = await startHarness(saved(V4_IN_V6));
    onCompile(win, (call) => {
      if (call === 2) {
        opensStrategy(win);
      }
    });

    const result = await callTool(client, 'pine_smart_compile', { writeBack: true });

    // The result is for the script the call started with, and it is returned all the same.
    expect(dataOf(result)).toMatchObject({ success: true, source: FIXED, writtenBack: false });
    expect(warningsOf(result).join(' ')).toContain('changed while the script was compiled');
    expect(warningsOf(result).join(' ')).toContain('another script');
    expect(callsOf(win, 'pineFacade.setScript')).toEqual([]);
    expect(editorOf(win)).toMatchObject({
      script: { scriptIdPart: STRATEGY.scriptIdPart },
      source: STRATEGY.source,
      savedSource: STRATEGY.source,
    });
  });

  test('smart compile writeBack with confirm keeps the unsaved edits of the script the editor switched to', async () => {
    const { client, win } = await startHarness(saved(V4_IN_V6));
    onCompile(win, (call) => {
      if (call === 2) {
        opensStrategy(win, true);
      }
    });

    const result = await callTool(client, 'pine_smart_compile', {
      writeBack: true,
      confirm: true,
    });

    expect(dataOf(result)).toMatchObject({ success: true, source: FIXED, writtenBack: false });
    expect(warningsOf(result).join(' ')).toContain('another script');
    expect(callsOf(win, 'pineFacade.setScript')).toEqual([]);
    expect(editorOf(win).source).toBe(`${STRATEGY.source}plot(close)\n`);
  });

  test('smart compile writeBack writes nothing when text is typed into the editor during the compilation', async () => {
    const { client, win } = await startHarness(saved(V4_IN_V6));
    const typed = `${V4_IN_V6}// typed meanwhile\n`;
    onCompile(win, (call) => {
      if (call === 2) {
        editorOf(win).source = typed;
      }
    });

    const result = await callTool(client, 'pine_smart_compile', { writeBack: true });

    // Not refused as unsaved text: the editor changed, and the call says so and returns its result.
    expect(dataOf(result)).toMatchObject({ success: true, source: FIXED, writtenBack: false });
    expect(warningsOf(result).join(' ')).toContain('changed while the script was compiled');
    expect(warningsOf(result).join(' ')).toContain('its text changed');
    expect(callsOf(win, 'pineFacade.setScript')).toEqual([]);
    expect(editorOf(win).source).toBe(typed);
  });

  test('smart compile writeBack with confirm keeps the text typed into the editor during the compilation', async () => {
    // The unsaved text the call started with was confirmed to go, not what is typed after it.
    const { client, win } = await startHarness(withEditor({ source: V4_IN_V6 }));
    const typed = `${V4_IN_V6}// typed meanwhile\n`;
    onCompile(win, (call) => {
      if (call === 2) {
        editorOf(win).source = typed;
      }
    });

    const result = await callTool(client, 'pine_smart_compile', {
      writeBack: true,
      confirm: true,
    });

    expect(dataOf(result)).toMatchObject({ success: true, source: FIXED, writtenBack: false });
    expect(warningsOf(result).join(' ')).toContain('its text changed');
    expect(callsOf(win, 'pineFacade.setScript')).toEqual([]);
    expect(editorOf(win).source).toBe(typed);
  });

  test('smart compile writeBack writes into a new script that is still the one it started with', async () => {
    const { client, win } = await startHarness(
      withEditor({ script: null, source: V4_IN_V6, savedSource: V4_IN_V6 }),
    );

    const result = await callTool(client, 'pine_smart_compile', { writeBack: true });

    expect(dataOf(result)).toMatchObject({ success: true, source: FIXED, writtenBack: true });
    expect(callsOf(win, 'pineFacade.setScript')).toEqual([[FIXED]]);
    expect(editorOf(win)).toMatchObject({ script: null, source: FIXED });
  });

  test('smart compile writeBack of a given text does not depend on what the editor holds', async () => {
    // The target of a given text is the editor as it is when the write comes, under the usual guard.
    const { client, win } = await startHarness(saved(V4_IN_V6));
    onCompile(win, (call) => {
      if (call === 2) {
        opensStrategy(win);
      }
    });

    const result = await callTool(client, 'pine_smart_compile', {
      source: V4_IN_V6,
      writeBack: true,
    });

    expect(dataOf(result)).toMatchObject({ success: true, source: FIXED, writtenBack: true });
    expect(warningsOf(result)).toEqual([]);
    expect(callsOf(win, 'pineFacade.setScript')).toEqual([[FIXED]]);
    expect(editorOf(win).source).toBe(FIXED);
  });

  test('smart compile writeBack writes nothing when the fixes changed nothing', async () => {
    const { client, win } = await startHarness(saved(FIXED));

    const result = await callTool(client, 'pine_smart_compile', { writeBack: true });

    expect(dataOf(result)).toStrictEqual({
      success: true,
      attempts: [{ errors: [], applied: [] }],
      source: FIXED,
      diff: '',
      writtenBack: false,
    });
    expect(warningsOf(result).join(' ')).toContain('left as it is');
    expect(callsOf(win, 'pineFacade.setScript')).toEqual([]);
  });

  test('smart compile writeBack writes nothing when the fixed text compiles worse than the text it started with', async () => {
    // A script without //@version compiles as Pine v1, where rsi( is still a function; the version
    // the fixes add makes it v6, where it is not, while the script names a variable rsi, which
    // keeps the rename from the fixes of the first attempt.
    const headerless = 'study("x")\nrsi = 3\nplot(undeclared_a)\nplot(rsi(close, 14))\n';
    const { client, win } = await startHarness(saved(headerless));

    const result = await callTool(client, 'pine_smart_compile', {
      writeBack: true,
      maxAttempts: 2,
    });

    const data = dataOf(result) as { attempts: { errors: unknown[] }[] };
    expect(data.attempts.map(({ errors }) => errors.length)).toEqual([1, 2]);
    expect(dataOf(result)).toMatchObject({ success: false, writtenBack: false });
    expect(warningsOf(result).join(' ')).toMatch(
      /writeBack was asked for, but the fixed text compiles with 2 errors, not fewer than the 1/,
    );
    expect(callsOf(win, 'pineFacade.setScript')).toEqual([]);
    expect(editorOf(win).source).toBe(headerless);
  });

  test('smart compile writeBack writes nothing when the fixed text has as many errors as at first', async () => {
    const headerless = 'study("x")\nrsi = 3\nplot(undeclared_a)\nplot(rsi(close, 14))\n';
    const { client, win } = await startHarness(saved(headerless));

    const result = await callTool(client, 'pine_smart_compile', { writeBack: true });

    const data = dataOf(result) as { attempts: { errors: unknown[] }[] };
    expect(data.attempts.map(({ errors }) => errors.length)).toEqual([1, 2, 1]);
    expect(dataOf(result)).toMatchObject({ success: false, writtenBack: false });
    expect(callsOf(win, 'pineFacade.setScript')).toEqual([]);
  });

  test('smart compile writeBack writes a fixed text with fewer errors than at first, though it still fails', async () => {
    const source = '//@version=6\nindicator("x")\nplot(undeclared_a)\nplot(rsi(close, 14))\n';
    const { client, win } = await startHarness(saved(source));

    const result = await callTool(client, 'pine_smart_compile', { writeBack: true });

    const data = dataOf(result) as { attempts: { errors: unknown[] }[]; source: string };
    expect(data.attempts.map(({ errors }) => errors.length)).toEqual([2, 1]);
    expect(dataOf(result)).toMatchObject({ success: false, writtenBack: true });
    expect(callsOf(win, 'pineFacade.setScript')).toEqual([[data.source]]);
  });

  test('smart compile writeBack with applyFixes false writes nothing and asks for no confirm', async () => {
    const { client, win } = await startHarness(withEditor({ source: V4_IN_V6 }));

    const result = await callTool(client, 'pine_smart_compile', {
      applyFixes: false,
      writeBack: true,
    });

    expect(dataOf(result)).toMatchObject({
      success: false,
      attempts: [{ errors: V4_ERRORS, applied: [] }],
      source: V4_IN_V6,
      writtenBack: false,
    });
    expect(warningsOf(result).join(' ')).toContain('left as it is');
    expect(callsOf(win, 'translateScriptAsync')).toHaveLength(1);
    expect(callsOf(win, 'pineFacade.setScript')).toEqual([]);
  });

  test('smart compile writeBack with one attempt writes nothing and asks for no confirm', async () => {
    const { client, win } = await startHarness(withEditor({ source: V4_IN_V6 }));

    const result = await callTool(client, 'pine_smart_compile', {
      maxAttempts: 1,
      writeBack: true,
    });

    // A fix is applied only when another compilation follows, so there is nothing to write.
    expect(dataOf(result)).toMatchObject({ success: false, source: V4_IN_V6, writtenBack: false });
    expect(warningsOf(result).join(' ')).toContain('left as it is');
    expect(callsOf(win, 'translateScriptAsync')).toHaveLength(1);
    expect(callsOf(win, 'pineFacade.setScript')).toEqual([]);
  });

  test('smart compile stops when too little time is left for another attempt, and says so', async () => {
    // A call timeout of 3000 ms leaves the whole call 2000 ms of the page.
    const { client, win, ctx } = await startHarness(fixture, {}, 3000);
    onCompile(win, () => delay(1200));

    const result = await callTool(client, 'pine_smart_compile', { source: V4_IN_V6 });

    // The first attempt took more than half of the time, and the fixes found are not made: the
    // text with them would not be compiled in what is left.
    expect(dataOf(result)).toStrictEqual({
      success: false,
      attempts: [{ errors: V4_ERRORS, applied: [] }],
      source: V4_IN_V6,
      diff: '',
      writtenBack: false,
    });
    expect(warningsOf(result).join(' ')).toContain('time limit');
    expect(callsOf(win, 'translateScriptAsync')).toHaveLength(1);
    expect(ctx.session.lastPineCompile).toMatchObject({ success: false, errors: V4_ERRORS });
  });

  test('smart compile gives each compilation only what is left of the time of the call', async () => {
    const { client, win, ctx } = await startHarness(fixture, {}, 3000);
    // An older result, which the failing call must not leave in place.
    await callTool(client, 'pine_compile', { source: FIXED });
    expect(ctx.session.lastPineCompile).toMatchObject({ success: true });
    // The first compilation takes 200 ms, and the second never answers.
    onCompile(win, (call) =>
      call === 1 ? delay(200) : call === 2 ? new Promise<void>(() => undefined) : undefined,
    );

    const result = await callTool(client, 'pine_smart_compile', { source: V4_IN_V6 });

    const error = errorOf(result);
    expect(error).toMatchObject({ code: 'TIMEOUT' });
    const waited = error?.details?.waitMs as number;
    expect(waited).toBeLessThanOrEqual(1800);
    expect(waited).toBeGreaterThan(1000);
    // The first attempt completed: it is what pine_get_errors returns, not the older result.
    expect(ctx.session.lastPineCompile).toMatchObject({ success: false, errors: V4_ERRORS });
  });

  test('smart compile keeps the result of the last attempt that completed when a later one fails', async () => {
    const { client, win, ctx } = await startHarness();
    await callTool(client, 'pine_compile', { source: FIXED });
    onCompile(win, (call) => {
      if (call === 2) {
        editorOf(win).compileHttpError = 'Request error, try again or contact support.';
      }
    });

    const result = await callTool(client, 'pine_smart_compile', { source: V4_IN_V6 });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: 'Request error, try again or contact support.',
    });
    expect(ctx.session.lastPineCompile).toMatchObject({ success: false, errors: V4_ERRORS });
    const errors = await callTool(client, 'pine_get_errors', {});
    expect(dataOf(errors)).toMatchObject({ success: false, errors: V4_ERRORS });
  });

  test('smart compile records each attempt as it completes', async () => {
    const { client, win, ctx } = await startHarness();
    const seen: (number | null)[] = [];
    // What pine_get_errors would say as each compilation starts.
    onCompile(win, () => {
      seen.push(ctx.session.lastPineCompile?.errors.length ?? null);
    });

    await callTool(client, 'pine_smart_compile', { source: V4_IN_V6 });

    expect(seen).toEqual([null, V4_ERRORS.length]);
    expect(ctx.session.lastPineCompile).toMatchObject({ success: true, errors: [] });
  });

  test('smart compile says in its description when the unsaved text is checked and what the time limit is', async () => {
    const { client } = await startHarness();

    const { tools } = await client.listTools();
    const description = tools.find(({ name }) => name === 'pine_smart_compile')?.description ?? '';

    // An open editor is refused before any compilation, a closed one that restores unsaved text
    // only when it is opened by the write, after them.
    expect(description).toContain('open one is refused with CONFIRMATION_REQUIRED before anything');
    expect(description).toContain('closed one that the write opens');
    expect(description).toContain('after the compilations');
    expect(description).toContain('share one time limit');
  });

  test('smart compile keeps the line endings of the text it fixes and diffs without them', async () => {
    const { client } = await startHarness();
    const source = V4_IN_V6.replaceAll('\n', '\r\n');

    const result = await callTool(client, 'pine_smart_compile', { source });

    expect(dataOf(result)).toMatchObject({
      success: true,
      source: FIXED.replaceAll('\n', '\r\n'),
      diff: FIXED_DIFF,
    });
  });

  test('smart compile fixes a script without a version that the compiler rejects, adding the version', async () => {
    const { client } = await startHarness();
    // Without a version the compiler reads an old one, and the analyzer adds the version.
    const source = 'indicator("x")\nplot(undeclared_a)\n';

    const result = await callTool(client, 'pine_smart_compile', { source });

    expect(dataOf(result)).toMatchObject({
      success: false,
      attempts: [
        { errors: [undeclared('undeclared_a', 2, 6)], applied: ['Add //@version=6 on line 1'] },
        { errors: [undeclared('undeclared_a', 3, 6)], applied: [] },
      ],
      source: `//@version=6\n${source}`,
    });
  });

  test('smart compile reports a failure of the compiler as the typed error, not as compile errors', async () => {
    const { client, win, ctx } = await startHarness();
    editorOf(win).compileHttpError = 'The size of the script compilation request is too large.';

    const result = await callTool(client, 'pine_smart_compile', { source: V4_IN_V6 });

    expect(errorOf(result)).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: 'The size of the script compilation request is too large.',
    });
    expect(ctx.session.lastPineCompile).toBeNull();
  });

  test('smart compile refuses an empty text before compiling', async () => {
    const { client, win } = await startHarness();

    const result = await callTool(client, 'pine_smart_compile', { source: ' \n ' });

    expect(errorOf(result)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(callsOf(win, 'translateScriptAsync')).toEqual([]);
  });

  test.each([0, 6, 2.5, -1])('smart compile refuses maxAttempts %s', async (maxAttempts) => {
    const { client, win, ctx } = await startHarness();
    const args = { source: V4_IN_V6, maxAttempts };

    const viaClient = await callTool(client, 'pine_smart_compile', args);
    const viaRegistry = await ctx.registry.call('pine_smart_compile', args, 'dashboard');

    // The SDK refuses it first, with its own result, and the registry would refuse it as well.
    expect(viaClient.isError).toBe(true);
    expect(textOf(viaClient)).toContain('maxAttempts');
    expect(errorOf(viaRegistry)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(callsOf(win, 'translateScriptAsync')).toEqual([]);
  });

  test.each([1, 5])('smart compile accepts maxAttempts %s', async (maxAttempts) => {
    const { client } = await startHarness();

    const result = await callTool(client, 'pine_smart_compile', { source: FIXED, maxAttempts });

    expect(result.isError).toBeFalsy();
  });
});
