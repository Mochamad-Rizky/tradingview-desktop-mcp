import type { CdpSession } from '../../../../src/core/cdp/types.js';
import type { TvMcpError } from '../../../../src/core/errors.js';
import {
  createPageBridge,
  type PageBridge,
  type PageLibFunction,
} from '../../../../src/core/tv/page-bridge.js';
import { createPageLib } from '../../../../src/core/tv/page-lib.js';
import type { TvWindow } from '../../../../src/core/tv/tv-window.js';
import {
  changePineEditor,
  readPineSource,
  readSavedPineScripts,
  savePineScript,
  type PineEditorChange,
  type PineSaveRequest,
} from '../../../../src/tools/pine/page.js';
import type { JsonValue } from '../../../../src/utils/json.js';
import { failureOf } from '../../../helpers/failure-of.js';
import { createPageRuntime } from '../../../helpers/fake-cdp/runtime.js';
import { loadTvFixture, type TvStateFixture } from '../../../helpers/fake-tv/fixture.js';
import { createFakeWebpack } from '../../../helpers/fake-tv/webpack.js';
import { createFakeTvWindow, inspectFakeWindow } from '../../../helpers/fake-tv/window.js';

// The page functions of the Pine source tools (reading the saved scripts and the text, changing the
// text, saving), run the way the server runs them, as source text in a page through the real page
// bridge, and called directly on a second window built the same way, which is what the coverage of
// the module measures. The two answers must agree. Sources and names are synthetic.

const fixture = loadTvFixture();
const [SCRIPT, STRATEGY] = fixture.pineEditor.savedScripts;
const SCRIPT_ID = SCRIPT?.scriptIdPart ?? '';
const SOURCE = '//@version=6\nindicator("Unit")\nplot(close)\n';

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

type Make = () => object;

async function libResultOf<A extends JsonValue[], R extends JsonValue | null>(
  fn: PageLibFunction<A, R>,
  args: A,
  make: Make,
): Promise<{ result: R; win: object }> {
  const win = make();
  const result = await bridgeTo(win).evaluateWithLib(fn, args);
  const other = make() as TvWindow;
  const direct = await fn(other, createPageLib(other), ...args);
  expect(direct).toEqual(result);
  return { result, win };
}

async function libFailureOfBoth<A extends JsonValue[], R extends JsonValue | null>(
  fn: PageLibFunction<A, R>,
  args: A,
  make: Make,
): Promise<{ error: TvMcpError; win: object }> {
  const win = make();
  const error = await failureOf(bridgeTo(win).evaluateWithLib(fn, args));
  const other = make() as TvWindow;
  expect(await fn(other, createPageLib(other), ...args)).toEqual({
    __tvmcpError: error.toPayload(),
  });
  return { error, win };
}

const chart =
  (from: TvStateFixture = fixture): Make =>
  () =>
    createFakeTvWindow(from);

function withEditor(editor: Partial<TvStateFixture['pineEditor']> = {}): TvStateFixture {
  return { ...fixture, pineEditor: { ...fixture.pineEditor, open: 'dialog', ...editor } };
}

// A page whose webpack cache holds `modules` and whose window has `globals`, and nothing else.
function withModules(modules: Record<string, unknown>, globals: object = {}): Make {
  return () => ({ ...globals, webpackChunktradingview: createFakeWebpack({ 1: modules }) });
}

// A page with an editor open in the side panel whose facade `facade()` builds anew for each page,
// signed in unless `signedIn` is false, and with the Pine Editor API `api()` builds.
function withFacade(
  facade: () => unknown,
  options: { api?: () => Record<string, unknown>; signedIn?: boolean } = {},
): Make {
  return () => {
    // Built on the first getFacade, so that a facade() that throws makes getFacade throw.
    let built: { facade: unknown } | null = null;
    const getFacade = (): unknown => {
      built ??= { facade: facade() };
      return built.facade;
    };
    const api = options.api?.() ?? {};
    return {
      is_authenticated: options.signedIn ?? true,
      TradingViewApi: { pineEditorApi: () => api },
      webpackChunktradingview: createFakeWebpack({
        1: {
          getOpenPineEditor: (placement: string) => (placement === 'dialog' ? { getFacade } : null),
        },
      }),
    };
  };
}

const callNames = (win: object): string[] => inspectFakeWindow(win).calls.map(({ name }) => name);

describe('readSavedPineScripts', () => {
  test('lists the saved scripts of the fake app with what decides the limit', async () => {
    const { result, win } = await libResultOf(readSavedPineScripts, [], chart());

    expect(result).toStrictEqual({
      authenticated: true,
      limitEnabled: true,
      unlimited: 99999,
      scripts: fixture.pineEditor.savedScripts.map((script) => ({
        scriptIdPart: script.scriptIdPart,
        scriptName: script.scriptName,
        scriptTitle: script.scriptTitle,
        version: script.version,
        modified: script.modified,
        kind: script.kind ?? null,
      })),
    });
    expect(callNames(win)).toEqual(['requestUserScripts']);
  });

  test('falls back to listSavedScripts and to the toggle on window.TradingView', async () => {
    const items = [
      {
        scriptIdPart: 'USER;a',
        scriptName: 'A',
        version: '1.0',
        modified: '2024-01-01',
        kind: 'strategy',
      },
      { scriptIdPart: '', scriptName: 'No id' },
      'not an item',
      { scriptIdPart: 'USER;b', scriptName: 7, modified: Number.NaN, version: '' },
      { scriptIdPart: 'USER;c', modified: '' },
    ];
    const { result } = await libResultOf(
      readSavedPineScripts,
      [],
      withModules(
        {},
        {
          is_authenticated: false,
          TradingView: {
            isFeatureEnabled: (name: string) => name !== 'pine_free_saved_scripts_limit',
          },
          TradingViewApi: {
            pineEditorApi: () => ({ listSavedScripts: () => Promise.resolve(items) }),
          },
        },
      ),
    );

    expect(result).toStrictEqual({
      authenticated: false,
      limitEnabled: false,
      unlimited: null,
      scripts: [
        {
          scriptIdPart: 'USER;a',
          scriptName: 'A',
          scriptTitle: null,
          version: '1.0',
          modified: '2024-01-01',
          kind: 'strategy',
        },
        {
          scriptIdPart: 'USER;b',
          scriptName: null,
          scriptTitle: null,
          version: null,
          modified: null,
          kind: null,
        },
        {
          scriptIdPart: 'USER;c',
          scriptName: null,
          scriptTitle: null,
          version: null,
          modified: null,
          kind: null,
        },
      ],
    });
  });

  test('reads the toggle as unknown when it answers no boolean, throws or is missing', async () => {
    const list = { requestUserScripts: () => Promise.resolve([]) };
    const toggleAnswers = async (globals: object, modules: Record<string, unknown> = {}) =>
      (await libResultOf(readSavedPineScripts, [], withModules({ ...list, ...modules }, globals)))
        .result;

    await expect(
      toggleAnswers({}, { isFeatureEnabled: () => 'yes', onFeaturesStateChanged: () => ({}) }),
    ).resolves.toMatchObject({ limitEnabled: null });
    await expect(
      toggleAnswers({
        TradingView: {
          isFeatureEnabled: () => {
            throw new Error('no toggles');
          },
        },
      }),
    ).resolves.toMatchObject({ limitEnabled: null });
    const throwingGlobal: Make = () =>
      Object.defineProperty(withModules(list)(), 'TradingView', {
        get() {
          throw new Error('no global');
        },
      });
    await expect(
      libResultOf(readSavedPineScripts, [], throwingGlobal).then(({ result }) => result),
    ).resolves.toMatchObject({ limitEnabled: null });
    await expect(toggleAnswers({})).resolves.toMatchObject({
      limitEnabled: null,
      authenticated: false,
    });
  });

  test('fails CAPABILITY_UNAVAILABLE on a page without a list of saved scripts', async () => {
    const { error } = await libFailureOfBoth(
      readSavedPineScripts,
      [],
      withModules(
        {},
        {
          TradingViewApi: {
            pineEditorApi: () => {
              throw new Error('not yet');
            },
          },
        },
      ),
    );

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
  });

  test('fails NOT_AVAILABLE when the list is no array or the request fails', async () => {
    const failing = async (answer: () => unknown) =>
      (
        await libFailureOfBoth(
          readSavedPineScripts,
          [],
          withModules({ requestUserScripts: answer }),
        )
      ).error;

    await expect(failing(() => Promise.resolve({}))).resolves.toMatchObject({
      code: 'NOT_AVAILABLE',
      message: 'TradingView answered with no list of saved Pine scripts',
    });
    await expect(failing(() => Promise.reject(new Error('Server error')))).resolves.toMatchObject({
      code: 'NOT_AVAILABLE',
      details: { reason: 'Server error' },
    });
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    await expect(failing(() => Promise.reject('Request error'))).resolves.toMatchObject({
      details: { reason: 'Request error' },
    });
    await expect(
      failing(() => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 42;
      }),
    ).resolves.toMatchObject({ details: { reason: '42' } });
  });
});

describe('readPineSource', () => {
  test('reads the text of the open editor, and reports a closed one', async () => {
    const open = await libResultOf(readPineSource, [], chart(withEditor({ source: SOURCE })));
    const closed = await libResultOf(readPineSource, [], chart());

    expect(open.result).toStrictEqual({ open: true, source: SOURCE });
    expect(closed.result).toStrictEqual({ open: false, source: null });
    expect(callNames(open.win)).toEqual([]);
  });

  test('passes over a placement whose lookup throws', async () => {
    const { result } = await libResultOf(
      readPineSource,
      [],
      withModules({
        getOpenPineEditor: (placement: string) => {
          if (placement === 'dialog') {
            throw new Error('boom');
          }
          return { getFacade: () => ({ getSource: () => Promise.resolve(SOURCE) }) };
        },
      }),
    );

    expect(result).toStrictEqual({ open: true, source: SOURCE });
  });

  test('fails CAPABILITY_UNAVAILABLE without the registry or a facade that reads its text', async () => {
    const noRegistry = await libFailureOfBoth(readPineSource, [], withModules({}));
    const noFacade = await libFailureOfBoth(
      readPineSource,
      [],
      withFacade(() => {
        throw new Error('gone');
      }),
    );

    expect(noRegistry.error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(noFacade.error.code).toBe('CAPABILITY_UNAVAILABLE');
  });

  test('fails NOT_AVAILABLE when the text cannot be read or is no text', async () => {
    const rejected = await libFailureOfBoth(
      readPineSource,
      [],
      withFacade(() => ({ getSource: () => Promise.reject(new Error('Value is null')) })),
    );
    const noText = await libFailureOfBoth(
      readPineSource,
      [],
      withFacade(() => ({ getSource: () => Promise.resolve(5) })),
    );

    expect(rejected.error).toMatchObject({ code: 'NOT_AVAILABLE' });
    expect(noText.error).toMatchObject({
      code: 'NOT_AVAILABLE',
      message: 'The Pine Editor answered with no text',
    });
  });
});

describe('changePineEditor', () => {
  const change = (value: PineEditorChange): [PineEditorChange] => [value];

  test('opens a new script of the type, with the source in place of the template', async () => {
    const { result, win } = await libResultOf(
      changePineEditor,
      change({ kind: 'new', type: 'strategy', source: SOURCE, allowModified: false }),
      chart(withEditor()),
    );

    expect(result).toStrictEqual({ changed: true });
    expect(callNames(win)).toEqual(['pineFacade.openNewScript', 'pineFacade.setScript']);
    expect(inspectFakeWindow(win).state.pineEditor).toMatchObject({ script: null, source: SOURCE });
  });

  test('opens a new script with its template, sets a source and opens a saved script', async () => {
    const fresh = await libResultOf(
      changePineEditor,
      change({ kind: 'new', type: 'library', source: null, allowModified: false }),
      chart(withEditor()),
    );
    const replaced = await libResultOf(
      changePineEditor,
      change({ kind: 'source', source: SOURCE, allowModified: true }),
      chart(withEditor({ source: 'changed' })),
    );
    const opened = await libResultOf(
      changePineEditor,
      change({
        kind: 'open',
        scriptIdPart: STRATEGY?.scriptIdPart ?? '',
        version: null,
        source: SOURCE,
        allowModified: false,
      }),
      chart(withEditor()),
    );

    expect(inspectFakeWindow(fresh.win).callsTo('pineFacade.openNewScript')).toEqual([['library']]);
    expect(inspectFakeWindow(replaced.win).state.pineEditor.source).toBe(SOURCE);
    expect(inspectFakeWindow(opened.win).callsTo('pineFacade.openScript')).toEqual([
      [{ scriptIdPart: STRATEGY?.scriptIdPart, scriptSource: SOURCE }],
    ]);
  });

  test('refuses CONFIRMATION_REQUIRED before acting while the text has unsaved changes', async () => {
    const setScript = vi.fn(() => Promise.resolve());
    const refused = async (isModified: () => unknown) =>
      (
        await libFailureOfBoth(
          changePineEditor,
          change({ kind: 'source', source: SOURCE, allowModified: false }),
          withFacade(() => ({ isModified, setScript })),
        )
      ).error;

    await expect(refused(() => true)).resolves.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await expect(refused(() => 'unknown')).resolves.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
    });
    await expect(
      refused(() => {
        throw new Error('no store');
      }),
    ).resolves.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(setScript).not.toHaveBeenCalled();
  });

  test('fails without the registry, an open editor, its facade or the member it needs', async () => {
    const args = change({ kind: 'source', source: SOURCE, allowModified: true });
    const failing = async (make: Make) =>
      (await libFailureOfBoth(changePineEditor, args, make)).error;

    await expect(failing(withModules({}))).resolves.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    });
    await expect(failing(chart())).resolves.toMatchObject({ code: 'NOT_AVAILABLE' });
    await expect(
      failing(
        withModules({
          getOpenPineEditor: () => {
            throw new Error('boom');
          },
        }),
      ),
    ).resolves.toMatchObject({ code: 'NOT_AVAILABLE' });
    await expect(
      failing(
        withFacade(() => {
          throw new Error('gone');
        }),
      ),
    ).resolves.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE', details: { member: 'facade' } });
    await expect(failing(withFacade(() => ({})))).resolves.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      details: { member: 'setScript' },
    });
    const withSource = change({
      kind: 'new',
      type: 'indicator',
      source: SOURCE,
      allowModified: true,
    });
    const noSetScript = await libFailureOfBoth(
      changePineEditor,
      withSource,
      withFacade(() => ({ openNewScript: () => Promise.resolve() })),
    );
    expect(noSetScript.error.details).toEqual({ member: 'setScript' });
  });

  test('fails INVALID_INPUT for a change it does not know', async () => {
    const { error } = await libFailureOfBoth(
      changePineEditor,
      [{ kind: 'rename' } as unknown as PineEditorChange],
      withFacade(() => ({})),
    );

    expect(error).toMatchObject({ code: 'INVALID_INPUT', details: { kind: 'rename' } });
  });

  test('fails NOT_AVAILABLE with the reason when the facade fails', async () => {
    const failing = async (reason: unknown) =>
      (
        await libFailureOfBoth(
          changePineEditor,
          change({
            kind: 'open',
            scriptIdPart: 'USER;x',
            version: '1.0',
            source: null,
            allowModified: true,
          }),
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          withFacade(() => ({ openScript: () => Promise.reject(reason) })),
        )
      ).error;

    await expect(failing(new Error('Network'))).resolves.toMatchObject({
      code: 'NOT_AVAILABLE',
      details: { reason: 'Network' },
    });
    await expect(failing('Request error')).resolves.toMatchObject({
      details: { reason: 'Request error' },
    });
    await expect(failing(undefined)).resolves.toMatchObject({ details: { reason: 'undefined' } });
  });
});

describe('savePineScript', () => {
  const asNew = (name = 'Unit', draftOf: string | null = null): [PineSaveRequest] => [
    { kind: 'new', name, draftOf },
  ];
  const asVersion = (scriptIdPart = SCRIPT_ID): [PineSaveRequest] => [
    { kind: 'version', scriptIdPart },
  ];
  // A facade of a new script holding `source`, with what `extra` adds.
  const newScript =
    (source: unknown = SOURCE, extra: Record<string, unknown> = {}) =>
    () => ({
      getSource: () => Promise.resolve(source),
      getScriptIdVersion: () => null,
      openScript: () => Promise.resolve(),
      ...extra,
    });
  // A facade of the saved script SCRIPT_ID at version 2.0, with what `extra` adds.
  const savedScript =
    (extra: Record<string, unknown> = {}) =>
    () => ({
      getSource: () => Promise.resolve(SOURCE),
      getScriptIdVersion: () => ({ scriptIdPart: SCRIPT_ID, version: '2.0' }),
      isDraft: () => false,
      saveScript: () => Promise.resolve({ script: { scriptIdPart: SCRIPT_ID, version: '3.0' } }),
      ...extra,
    });
  const saving = (answer: () => unknown) => () => ({ saveNewScript: answer });

  test('saves a new script on the fake app and switches the editor to it', async () => {
    const from = {
      ...withEditor({ script: null, source: SOURCE }),
      planLimits: { ...fixture.planLimits, SAVED_PINE_SCRIPTS: 5 },
    };
    const { result, win } = await libResultOf(savePineScript, asNew(), chart(from));

    const editor = inspectFakeWindow(win).state.pineEditor;
    const id = editor.savedScripts.at(-1)?.scriptIdPart;
    expect(result).toStrictEqual({ script: { id, version: '1.0' }, errors: [], tracked: true });
    expect(editor).toMatchObject({ script: { scriptIdPart: id, version: '1.0' }, source: SOURCE });
    expect(callNames(win)).toEqual(['pineEditorApi.saveNewScript', 'pineFacade.openScript']);
  });

  test('saves a server draft as a new script, and refuses a script that is no draft', async () => {
    const draftAt = (version: string) =>
      withFacade(
        newScript(SOURCE, { getScriptIdVersion: () => ({ scriptIdPart: 'USER;draft', version }) }),
        {
          api: saving(() =>
            Promise.resolve({ success: true, metaInfo: { scriptIdPart: 'USER;new' } }),
          ),
        },
      );

    const saved = await libResultOf(savePineScript, asNew('Unit', 'USER;draft'), draftAt('0.2'));
    const refused = await libFailureOfBoth(
      savePineScript,
      asNew('Unit', 'USER;draft'),
      draftAt('1.0'),
    );
    const other = await libFailureOfBoth(
      savePineScript,
      asNew('Unit', 'USER;other'),
      draftAt('0.2'),
    );

    const unversioned = await libFailureOfBoth(
      savePineScript,
      asNew('Unit', 'USER;draft'),
      draftAt(''),
    );

    expect(saved.result).toMatchObject({ script: { id: 'USER;new' } });
    expect(unversioned.error.code).toBe('NOT_AVAILABLE');
    expect(refused.error.code).toBe('NOT_AVAILABLE');
    expect(other.error.code).toBe('NOT_AVAILABLE');
  });

  test('saves a new version of a saved script on the fake app', async () => {
    const { result, win } = await libResultOf(
      savePineScript,
      asVersion(),
      chart(withEditor({ source: SOURCE })),
    );

    expect(result).toStrictEqual({
      script: { id: SCRIPT_ID, version: '3.0' },
      errors: [],
      tracked: null,
    });
    expect(callNames(win)).toEqual(['pineFacade.saveScript']);
  });

  test('fails without the registry, an open editor or the members a save needs', async () => {
    const failing = async (args: [PineSaveRequest], make: Make) =>
      (await libFailureOfBoth(savePineScript, args, make)).error;

    await expect(failing(asNew(), withModules({}))).resolves.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    });
    await expect(failing(asNew(), chart())).resolves.toMatchObject({ code: 'NOT_AVAILABLE' });
    await expect(
      failing(
        asNew(),
        withModules({
          getOpenPineEditor: () => {
            throw new Error('boom');
          },
        }),
      ),
    ).resolves.toMatchObject({ code: 'NOT_AVAILABLE' });
    await expect(
      failing(
        asNew(),
        withFacade(() => {
          throw new Error('gone');
        }),
      ),
    ).resolves.toMatchObject({ details: { member: 'facade' } });
    await expect(failing(asNew(), withFacade(newScript()))).resolves.toMatchObject({
      details: { member: 'saveNewScript' },
    });
    await expect(
      failing(
        asNew(),
        withFacade(newScript(SOURCE, { openScript: undefined }), {
          api: saving(() => Promise.resolve({})),
        }),
      ),
    ).resolves.toMatchObject({ details: { member: 'openScript' } });
    await expect(
      failing(asVersion(), withFacade(savedScript({ isDraft: undefined }))),
    ).resolves.toMatchObject({ details: { member: 'saveScript' } });
    await expect(
      failing([{ kind: 'delete' } as unknown as PineSaveRequest], withFacade(savedScript())),
    ).resolves.toMatchObject({ details: { member: 'request' } });
  });

  test('reads no Pine Editor API from a page whose API throws', async () => {
    const make: Make = () => ({
      ...withFacade(newScript())(),
      TradingViewApi: {
        pineEditorApi: () => {
          throw new Error('not yet');
        },
      },
    });
    const { error } = await libFailureOfBoth(savePineScript, asNew(), make);

    expect(error.details).toEqual({ member: 'saveNewScript' });
  });

  test('fails AUTH_REQUIRED while signed out, before anything is saved', async () => {
    const saveScript = vi.fn();
    const { error } = await libFailureOfBoth(
      savePineScript,
      asVersion(),
      withFacade(savedScript({ saveScript }), { signedIn: false }),
    );

    expect(error.code).toBe('AUTH_REQUIRED');
    expect(saveScript).not.toHaveBeenCalled();
  });

  test('fails NOT_AVAILABLE when the editor no longer holds what the save expects', async () => {
    const failing = async (args: [PineSaveRequest], facade: () => unknown) =>
      (
        await libFailureOfBoth(
          savePineScript,
          args,
          withFacade(facade, { api: saving(() => Promise.resolve({})) }),
        )
      ).error;

    await expect(
      failing(
        asNew(),
        newScript(SOURCE, { getScriptIdVersion: () => ({ scriptIdPart: 'USER;x' }) }),
      ),
    ).resolves.toMatchObject({ code: 'NOT_AVAILABLE' });
    await expect(failing(asVersion('USER;other'), savedScript())).resolves.toMatchObject({
      code: 'NOT_AVAILABLE',
    });
    await expect(
      failing(
        asVersion(),
        savedScript({ getScriptIdVersion: () => ({ scriptIdPart: SCRIPT_ID, version: '' }) }),
      ),
    ).resolves.toMatchObject({ code: 'NOT_AVAILABLE' });
    await expect(failing(asVersion(), savedScript({ isDraft: () => true }))).resolves.toMatchObject(
      { code: 'NOT_AVAILABLE' },
    );
    await expect(
      failing(
        asVersion(),
        savedScript({
          isDraft: () => {
            throw new Error('no store');
          },
        }),
      ),
    ).resolves.toMatchObject({ code: 'NOT_AVAILABLE' });
    await expect(
      failing(
        asVersion(),
        savedScript({
          getScriptIdVersion: () => {
            throw new Error('no store');
          },
        }),
      ),
    ).resolves.toMatchObject({ code: 'NOT_AVAILABLE' });
  });

  test('fails INVALID_INPUT for an empty text and a title TradingView would warn about', async () => {
    const failing = async (source: unknown) =>
      (
        await libFailureOfBoth(
          savePineScript,
          asNew(),
          withFacade(newScript(source), { api: saving(() => Promise.resolve({})) }),
        )
      ).error;
    const long = 'x'.repeat(129);

    await expect(failing('  \n')).resolves.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(failing(7)).resolves.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(failing(`//@version=6\nindicator("${long}")\n`)).resolves.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('129 characters') as string,
    });
    await expect(
      failing(`//@version=6\n  strategy ( title = '${long}', overlay=true)\n`),
    ).resolves.toMatchObject({ code: 'INVALID_INPUT' });
  });

  test('saves a title of 128 characters and a declaration it cannot read', async () => {
    const saved = { success: true, metaInfo: { scriptIdPart: 'USER;n', pine: { version: '1.0' } } };
    const ok = async (source: string) =>
      (
        await libResultOf(
          savePineScript,
          asNew(),
          withFacade(newScript(source), { api: saving(() => Promise.resolve(saved)) }),
        )
      ).result;

    await expect(ok(`indicator("${'x'.repeat(128)}")\n`)).resolves.toMatchObject({
      script: { id: 'USER;n' },
    });
    await expect(ok('indicator(title_var)\n')).resolves.toMatchObject({ script: { id: 'USER;n' } });
  });

  test('fails NOT_AVAILABLE with the reason when the text cannot be read', async () => {
    const { error } = await libFailureOfBoth(
      savePineScript,
      asNew(),
      withFacade(
        newScript(SOURCE, { getSource: () => Promise.reject(new Error('Value is null')) }),
        {
          api: saving(() => Promise.resolve({})),
        },
      ),
    );

    expect(error).toMatchObject({ code: 'NOT_AVAILABLE', details: { reason: 'Value is null' } });
  });

  test('answers the compile errors of a new script TradingView refused', async () => {
    const answer = async (save: () => unknown) =>
      (await libResultOf(savePineScript, asNew(), withFacade(newScript(), { api: saving(save) })))
        .result;
    const errors = [
      { message: 'Mismatched input', start: { line: 3, column: 7 } },
      { start: { line: 0, column: 2.5 } },
      'odd',
    ];
    const expected = [
      { message: 'Mismatched input', line: 3, column: 7 },
      { message: 'Unknown compile error', line: null, column: null },
      { message: 'Unknown compile error', line: null, column: null },
    ];

    await expect(
      answer(() => Promise.resolve({ success: false, metaInfo: {}, compileErrors: { errors } })),
    ).resolves.toStrictEqual({ script: null, errors: expected, tracked: null });
    await expect(
      answer(() =>
        Promise.reject(Object.assign(new Error('Pine translation failed'), { reason: { errors } })),
      ),
    ).resolves.toStrictEqual({ script: null, errors: expected, tracked: null });
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    await expect(answer(() => Promise.reject({ errors }))).resolves.toStrictEqual({
      script: null,
      errors: expected,
      tracked: null,
    });
    await expect(answer(() => Promise.resolve('saved'))).resolves.toStrictEqual({
      script: null,
      errors: [],
      tracked: null,
    });
    await expect(
      answer(() => Promise.resolve({ success: true, metaInfo: { scriptIdPart: '' } })),
    ).resolves.toStrictEqual({ script: null, errors: [], tracked: null });
  });

  test('fails NOT_AVAILABLE with the reason when TradingView refuses a new script', async () => {
    const failing = async (save: () => unknown) =>
      (
        await libFailureOfBoth(
          savePineScript,
          asNew(),
          withFacade(newScript(), { api: saving(save) }),
        )
      ).error;

    await expect(failing(() => Promise.reject(new Error('Server error')))).resolves.toMatchObject({
      code: 'NOT_AVAILABLE',
      details: { reason: 'Server error' },
    });
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    await expect(failing(() => Promise.reject('Request error'))).resolves.toMatchObject({
      details: { reason: 'Request error' },
    });
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    await expect(failing(() => Promise.reject(null))).resolves.toMatchObject({
      details: { reason: expect.stringContaining('no reason') as string },
    });
  });

  test('reports a new script whose editor could not be switched to it as not tracked', async () => {
    const saved = { success: true, metaInfo: { scriptIdPart: 'USER;n' } };
    const tracked = async (openScript: () => unknown) =>
      (
        await libResultOf(
          savePineScript,
          asNew(),
          withFacade(newScript(SOURCE, { openScript }), {
            api: saving(() => Promise.resolve(saved)),
          }),
        )
      ).result;

    // The facade stays on a new script, as when the app falls back to one.
    await expect(tracked(() => Promise.resolve())).resolves.toStrictEqual({
      script: { id: 'USER;n', version: null },
      errors: [],
      tracked: false,
    });
    await expect(tracked(() => Promise.reject(new Error('Network')))).resolves.toMatchObject({
      tracked: false,
    });
  });

  test('saves a version and takes its id from the editor when the answer has none', async () => {
    const answer = async (saveScript: () => unknown) =>
      (await libResultOf(savePineScript, asVersion(), withFacade(savedScript({ saveScript }))))
        .result;

    await expect(answer(() => Promise.resolve(undefined))).resolves.toStrictEqual({
      script: { id: SCRIPT_ID, version: '2.0' },
      errors: [],
      tracked: null,
    });
    await expect(
      answer(() =>
        Promise.resolve({
          script: { scriptIdPart: SCRIPT_ID, version: '3.0' },
          compileErrors: { errors: [{ message: 'Warning as error' }] },
        }),
      ),
    ).resolves.toStrictEqual({
      script: { id: SCRIPT_ID, version: '3.0' },
      errors: [{ message: 'Warning as error', line: null, column: null }],
      tracked: null,
    });
    await expect(answer(() => Promise.resolve({ script: null }))).resolves.toMatchObject({
      script: { id: SCRIPT_ID, version: '2.0' },
    });
  });

  test('answers no script for a version when neither the answer nor the editor has an id', async () => {
    let calls = 0;
    const { result } = await libResultOf(
      savePineScript,
      asVersion(),
      withFacade(
        savedScript({
          // The id is there for the checks before the save and gone after it.
          getScriptIdVersion: () => {
            calls += 1;
            return calls % 2 === 1 ? { scriptIdPart: SCRIPT_ID, version: '2.0' } : null;
          },
          saveScript: () => Promise.resolve({}),
        }),
      ),
    );

    expect(result).toStrictEqual({ script: null, errors: [], tracked: null });
  });

  test('fails NOT_AVAILABLE with the reason when TradingView refuses a version', async () => {
    const failing = async (reason: unknown) =>
      (
        await libFailureOfBoth(
          savePineScript,
          asVersion(),
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          withFacade(savedScript({ saveScript: () => Promise.reject(reason) })),
        )
      ).error;

    await expect(failing(undefined)).resolves.toMatchObject({
      code: 'NOT_AVAILABLE',
      details: { reason: expect.stringContaining('no reason') as string },
    });
    await expect(failing('Server error')).resolves.toMatchObject({
      details: { reason: 'Server error' },
    });
  });
});
