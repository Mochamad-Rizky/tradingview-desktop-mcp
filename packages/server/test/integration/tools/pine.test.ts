import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpServer } from '../../../src/server.js';
import type { ToolContext } from '../../../src/tools/types.js';
import { startFakeCdpServer } from '../../helpers/fake-cdp/server.js';
import { loadTargetsFixture } from '../../helpers/fake-cdp/targets.js';
import { loadTvFixture, type TvStateFixture } from '../../helpers/fake-tv/fixture.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTvOverrides,
  type FakeTvWindow,
} from '../../helpers/fake-tv/window.js';
import { callTool, connectInMemoryClient, textOf } from '../../helpers/mcp-client.js';
import { quietLogger, refusingLauncher, testConfig } from '../../helpers/tool-context.js';

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
): Promise<{ client: Client; win: FakeTvWindow; ctx: ToolContext }> {
  const win = createFakeTvWindow(from, overrides);
  const app = await startFakeCdpServer({ targets: loadTargetsFixture({ chartWindow: () => win }) });
  cleanups.push(() => app.close());
  const config = testConfig({ cdpPort: app.port, callTimeoutMs });
  const { server, ctx } = createMcpServer(config, {
    launcher: refusingLauncher(),
    logger: quietLogger,
  });
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
    expect(callsOf(win, 'pineFacade.openScript')).toHaveLength(1);
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
            modified: isoOf(SCRIPT.modified),
          },
          {
            id: STRATEGY.scriptIdPart,
            name: STRATEGY.scriptName,
            version: STRATEGY.version,
            type: 'strategy',
            modified: isoOf(STRATEGY.modified),
          },
          {
            id: DRAFT.scriptIdPart,
            name: DRAFT.scriptName,
            version: DRAFT.version,
            type: 'indicator',
            modified: isoOf(DRAFT.modified),
          },
        ],
      },
      meta: { via: 'internal', durationMs: expect.any(Number) as number, warnings: [] },
    });
    // Only the request the app sends itself, and no editor.
    expect(inspectFakeWindow(win).calls.map(({ name }) => name)).toEqual(['requestUserScripts']);
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
      scripts: [expect.objectContaining({ modified: isoOf(SCRIPT.modified) })],
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

test('the Pine source tools say which of them read and which can replace text', async () => {
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
