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
  closePineEditor,
  openPineEditor,
  readPineEditorState,
  readPineOwnEdit,
} from '../../../../src/tools/pine/page.js';
import type { JsonValue } from '../../../../src/utils/json.js';
import { failureOf } from '../../../helpers/failure-of.js';
import { createPageRuntime } from '../../../helpers/fake-cdp/runtime.js';
import { loadTvFixture, type TvStateFixture } from '../../../helpers/fake-tv/fixture.js';
import { createFakeWebpack } from '../../../helpers/fake-tv/webpack.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTvOverrides,
} from '../../../helpers/fake-tv/window.js';

// The page functions of the Pine Editor access layer, run the way the server runs them, as source
// text in a page through the real page bridge, and called directly on a second window built the
// same way, which is what the coverage of the module measures. The two answers must agree. Sources
// are synthetic.

const fixture = loadTvFixture();
const SCRIPT = {
  id: fixture.pineEditor.script?.scriptIdPart ?? '',
  version: fixture.pineEditor.script?.version ?? '',
};
// What the Pine button of the toolbar of the app passes to open.
const TOOLBAR_OPEN = { scriptInfo: { script: null }, openSourceId: 'main_button', forceOpen: true };

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

const chart =
  (from: TvStateFixture = fixture, overrides: FakeTvOverrides = {}): Make =>
  () =>
    createFakeTvWindow(from, overrides);

// The fixture with the editor registered at `open` when the window is built, opening at `opensAt`,
// and with `editor` changed.
function withEditor(
  open: 'dialog' | 'bottom' | null,
  editor: Partial<TvStateFixture['pineEditor']> = {},
): TvStateFixture {
  return { ...fixture, pineEditor: { ...fixture.pineEditor, open, ...editor } };
}

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

// A page whose webpack cache holds `modules` and whose window has `globals`, and nothing else of the
// app.
function withModules(modules: Record<string, unknown>, globals: object = {}): Make {
  return () => ({ ...globals, webpackChunktradingview: createFakeWebpack({ 1: modules }) });
}

// A registry that answers `entries` by placement.
// The registry of open editors, with the helpers the app keeps its flag of unsaved changes with,
// keeping `kept` for both placements (none by default).
function registry(
  entries: Partial<Record<'dialog' | 'bottom', unknown>>,
  kept: unknown = null,
): Record<string, unknown> {
  return {
    getOpenPineEditor: (placement: 'dialog' | 'bottom') => entries[placement] ?? null,
    hasScriptModificationsKey: 'has_unsaved_modifications',
    getPersistedValue: (key: string, perUser: boolean) =>
      perUser && key === 'has_unsaved_modifications' ? kept : null,
  };
}

const callNames = (win: object): string[] => inspectFakeWindow(win).calls.map(({ name }) => name);

describe('readPineEditorState', () => {
  test('readPineEditorState reports closed when no facade is registered', async () => {
    const { result } = await libResultOf(readPineEditorState, [], chart());

    expect(result).toStrictEqual({
      state: { open: false, placement: null, modified: false, draft: false, script: null },
      unreadable: [],
    });
  });

  test('reports an editor open in the side panel with the id and version of its script', async () => {
    const { result, win } = await libResultOf(readPineEditorState, [], chart(withEditor('dialog')));

    expect(result).toStrictEqual({
      state: { open: true, placement: 'dialog', modified: false, draft: false, script: SCRIPT },
      unreadable: [],
    });
    // Reading changes nothing.
    expect(callNames(win)).toEqual([]);
  });

  test('reports unsaved changes, and a new script as a draft without a script', async () => {
    const { result } = await libResultOf(
      readPineEditorState,
      [],
      chart(withEditor('bottom', { script: null, source: '//@version=6\nindicator("x")\n' })),
    );

    expect(result).toStrictEqual({
      state: { open: true, placement: 'bottom', modified: true, draft: true, script: null },
      unreadable: [],
    });
  });

  test('reports a script saved only as a server draft as a draft with its id', async () => {
    const { result } = await libResultOf(
      readPineEditorState,
      [],
      chart(withEditor('dialog', { script: { scriptIdPart: 'USER;d1', version: '0.2' } })),
    );

    expect(result).toMatchObject({
      state: { draft: true, script: { id: 'USER;d1', version: '0.2' } },
    });
  });

  test('looks at the dialog placement before the bottom one', async () => {
    const facade = (modified: boolean) => ({
      isModified: () => modified,
      isDraft: () => false,
      getScriptIdVersion: () => null,
    });
    const { result } = await libResultOf(
      readPineEditorState,
      [],
      withModules(
        registry({
          bottom: { getFacade: () => facade(false) },
          dialog: { getFacade: () => facade(true) },
        }),
      ),
    );

    expect(result).toMatchObject({ state: { placement: 'dialog', modified: true } });
  });

  test('counts the unsaved changes TradingView keeps as unsaved, though isModified() says none', async () => {
    const facade = {
      isModified: () => false,
      isDraft: () => true,
      getScriptIdVersion: () => null,
    };
    const read = async (kept: unknown) =>
      (
        await libResultOf(
          readPineEditorState,
          [],
          withModules(registry({ dialog: { getFacade: () => facade } }, kept)),
        )
      ).result;

    expect(await read(true)).toMatchObject({ state: { modified: true }, unreadable: [] });
    expect(await read(false)).toMatchObject({ state: { modified: false }, unreadable: [] });
    // Nothing kept for the account.
    expect(await read(undefined)).toMatchObject({ state: { modified: false }, unreadable: [] });
    // A flag that is not one, or a page without the helpers of the app: unsaved changes assumed.
    expect(await read('yes')).toMatchObject({
      state: { modified: true },
      unreadable: ['unsavedChanges'],
    });
    const { result } = await libResultOf(
      readPineEditorState,
      [],
      withModules({
        getOpenPineEditor: (placement: string) =>
          placement === 'dialog' ? { getFacade: () => facade } : null,
      }),
    );
    expect(result).toMatchObject({ state: { modified: true }, unreadable: ['unsavedChanges'] });
    // A helper that throws counts as no answer.
    const throwing = await libResultOf(
      readPineEditorState,
      [],
      withModules({
        ...registry({ dialog: { getFacade: () => facade } }),
        getPersistedValue: () => {
          throw new Error('no storage');
        },
      }),
    );
    expect(throwing.result).toMatchObject({
      state: { modified: true },
      unreadable: ['unsavedChanges'],
    });
  });

  test('reads the flag under the key the app keeps it under, for either placement', async () => {
    const facade = { isModified: () => false, isDraft: () => true, getScriptIdVersion: () => null };
    // The app writes and reads the flag under the bare key, whatever the placement of the editor.
    const { result } = await libResultOf(
      readPineEditorState,
      [],
      withModules({
        getOpenPineEditor: (placement: string) =>
          placement === 'bottom' ? { getFacade: () => facade } : null,
        hasScriptModificationsKey: 'has_unsaved_modifications',
        getPersistenceKey: (key: string, placement: string) =>
          `${placement === 'bottom' ? 'bottom_' : ''}${key}`,
        getPersistedValue: (key: string, perUser: boolean) =>
          perUser && key === 'has_unsaved_modifications' ? true : null,
      }),
    );

    expect(result).toMatchObject({
      state: { placement: 'bottom', modified: true },
      unreadable: [],
    });
  });

  test('openPineEditor reads the flag of unsaved changes TradingView keeps as well', async () => {
    const facade = {
      isModified: () => false,
      isDraft: () => true,
      getScriptIdVersion: () => null,
    };
    const open = async (modules: Record<string, unknown>) =>
      (await libResultOf(openPineEditor, [100], withModules(modules))).result;

    await expect(
      open(registry({ dialog: { getFacade: () => facade } }, true)),
    ).resolves.toMatchObject({ state: { modified: true }, unreadable: [] });
    await expect(
      open({
        ...registry({ dialog: { getFacade: () => facade } }),
        getPersistedValue: () => {
          throw new Error('no storage');
        },
      }),
    ).resolves.toMatchObject({ state: { modified: true }, unreadable: ['unsavedChanges'] });
  });

  test('reports what it can of a facade whose members cannot be read, unsaved changes assumed', async () => {
    const facade = {
      isModified: () => {
        throw new Error('not ready');
      },
      isDraft: () => 'maybe',
      getScriptIdVersion: undefined,
    };
    const { result } = await libResultOf(
      readPineEditorState,
      [],
      withModules(registry({ bottom: { getFacade: () => facade } })),
    );

    expect(result).toStrictEqual({
      state: { open: true, placement: 'bottom', modified: true, draft: true, script: null },
      unreadable: ['getScriptIdVersion', 'isModified', 'isDraft'],
    });
  });

  test('reports a script id whose version is not text with a null version, and a draft', async () => {
    const facade = {
      isModified: () => false,
      isDraft: () => {
        throw new Error('no store');
      },
      getScriptIdVersion: () => ({ scriptIdPart: 'USER;v', version: undefined }),
    };
    const { result } = await libResultOf(
      readPineEditorState,
      [],
      withModules(registry({ dialog: { getFacade: () => facade } })),
    );

    expect(result).toStrictEqual({
      state: {
        open: true,
        placement: 'dialog',
        modified: false,
        draft: true,
        script: { id: 'USER;v', version: null },
      },
      unreadable: ['isDraft'],
    });
  });

  test('reports an open editor whose facade cannot be had as modified', async () => {
    const { result } = await libResultOf(
      readPineEditorState,
      [],
      withModules(
        registry({
          dialog: {
            getFacade: () => {
              throw new Error('gone');
            },
          },
        }),
      ),
    );

    expect(result).toStrictEqual({
      state: { open: true, placement: 'dialog', modified: true, draft: true, script: null },
      unreadable: ['getFacade'],
    });
  });

  test('passes over a placement whose lookup throws', async () => {
    const { result } = await libResultOf(
      readPineEditorState,
      [],
      withModules({
        getOpenPineEditor: (placement: string) => {
          if (placement === 'dialog') {
            throw new Error('boom');
          }
          return null;
        },
      }),
    );

    expect(result).toMatchObject({ state: { open: false, placement: null } });
  });

  test('fails CAPABILITY_UNAVAILABLE on a page without the registry of open editors', async () => {
    const { error } = await libFailureOfBoth(
      readPineEditorState,
      [],
      chart(fixture, { webpackModules: {} }),
    );

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(error.hint).toContain('app_health');
  });
});

describe('readPineOwnEdit', () => {
  // An open editor whose facade answers `members`, under the flag of unsaved changes `kept`.
  const editing = (members: Record<string, unknown>, kept: unknown = true) =>
    withModules(registry({ dialog: { getFacade: () => members } }, kept));
  const own = (written: string | null, make: Make) =>
    libResultOf(readPineOwnEdit, [written], make).then(({ result }) => result);
  const edit = { isModified: () => true, getSource: () => Promise.resolve('own text') };

  test('tells an unsaved edit of exactly the text this session wrote, whatever the flag', async () => {
    expect(await own('own text', editing(edit))).toBe(true);
    expect(await own('own text', editing(edit, false))).toBe(true);
    // Another text, or no text written.
    expect(await own('own text!', editing(edit))).toBe(false);
    expect(await own(null, editing(edit))).toBe(false);
  });

  test('takes no text that isModified() does not call an edit for the session', async () => {
    // Kept across a close: unmodified, flagged, and maybe the text this session wrote.
    expect(await own('own text', editing({ ...edit, isModified: () => false }))).toBe(false);
    expect(
      await own(
        'own text',
        editing({
          ...edit,
          isModified: () => {
            throw new Error('no store');
          },
        }),
      ),
    ).toBe(false);
  });

  test('answers false when the editor, its facade or its text cannot be read', async () => {
    expect(await own('own text', chart())).toBe(false);
    expect(await own('own text', withModules({}))).toBe(false);
    expect(
      await own(
        'own text',
        withModules({
          getOpenPineEditor: () => {
            throw new Error('boom');
          },
        }),
      ),
    ).toBe(false);
    expect(
      await own(
        'own text',
        withModules(
          registry({
            dialog: {
              getFacade: () => {
                throw new Error('gone');
              },
            },
          }),
        ),
      ),
    ).toBe(false);
    expect(await own('own text', editing({ ...edit, getSource: undefined }))).toBe(false);
    expect(
      await own(
        'own text',
        editing({ ...edit, getSource: () => Promise.reject(new Error('Value is null')) }),
      ),
    ).toBe(false);
  });

  test('reads the text of the fake app and changes nothing', async () => {
    const OWN = '//@version=6\nindicator("Own")\nplot(close)\n';
    const { result, win } = await libResultOf(
      readPineOwnEdit,
      [OWN],
      chart(withEditor('dialog', { source: OWN })),
    );

    expect(result).toBe(true);
    expect(callNames(win)).toEqual([]);
  });
});

describe('openPineEditor', () => {
  test('answers an open editor whose script has an id but no version with a null version', async () => {
    const facade = {
      isModified: () => false,
      isDraft: () => true,
      getScriptIdVersion: () => ({ scriptIdPart: 'USER;v' }),
      getSource: () => Promise.resolve(''),
    };
    const { result } = await libResultOf(
      openPineEditor,
      [100],
      withModules(registry({ dialog: { getFacade: () => facade } })),
    );

    expect(result).toStrictEqual({
      state: {
        open: true,
        placement: 'dialog',
        modified: false,
        draft: true,
        script: { id: 'USER;v', version: null },
      },
      unreadable: [],
    });
  });

  test('opens a closed editor the way the toolbar does and waits until it is ready', async () => {
    const make = chart(fixture, { pineEditorReadyMs: 120 });
    const win = make();
    const chunks = (win as { webpackChunktradingview: unknown[] }).webpackChunktradingview;

    const result = await bridgeTo(win).evaluateWithLib(openPineEditor, [2000]);
    const other = make() as TvWindow;
    expect(await openPineEditor(other, createPageLib(other), 2000)).toEqual(result);

    expect(result).toStrictEqual({
      state: { open: true, placement: 'dialog', modified: false, draft: false, script: SCRIPT },
      unreadable: [],
    });
    const inspector = inspectFakeWindow(win);
    expect(inspector.callsTo('pineEditorApi.open')).toEqual([[TOOLBAR_OPEN]]);
    expect(inspector.state.pineEditor.ready).toBe(true);
    // The whole wait ran in one call, which leaves one chunk on the page.
    expect(chunks).toHaveLength(1);
  });

  test('reports the bottom placement when the editor opens there', async () => {
    const { result } = await libResultOf(
      openPineEditor,
      [2000],
      chart(withEditor(null, { opensAt: 'bottom' })),
    );

    expect(result).toMatchObject({ state: { open: true, placement: 'bottom' } });
  });

  test('returns an editor that is already open at once, without opening it again', async () => {
    const { result, win } = await libResultOf(
      openPineEditor,
      [2000],
      chart(withEditor('bottom'), { pineEditorReadyMs: Infinity }),
    );

    expect(result).toMatchObject({ state: { open: true, placement: 'bottom' } });
    expect(callNames(win)).toEqual([]);
  });

  test('fails TIMEOUT when the editor is not ready within the wait', async () => {
    const started = Date.now();
    const { error, win } = await libFailureOfBoth(
      openPineEditor,
      [150],
      chart(fixture, { pineEditorReadyMs: Infinity }),
    );

    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(error.code).toBe('TIMEOUT');
    expect(error.message).toContain('150 ms');
    expect(error.hint).toContain('Pine Editor');
    expect(error.details).toEqual({ waitMs: 150 });
    expect(inspectFakeWindow(win).callsTo('pineEditorApi.open')).toHaveLength(1);
  });

  test('waits no time at all for a wait that is not a positive number', async () => {
    const { error } = await libFailureOfBoth(openPineEditor, [Number.NaN], chart());

    expect(error.code).toBe('TIMEOUT');
    expect(error.details).toEqual({ waitMs: 0 });
  });

  test('fails NOT_AVAILABLE with the reason when TradingView does not open the editor', async () => {
    const { error } = await libFailureOfBoth(
      openPineEditor,
      [2000],
      chart(fixture, { pineEditorOpenError: 'chunk failed' }),
    );

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(error.message).toContain('chunk failed');
    expect(error.details).toEqual({ reason: 'chunk failed' });
  });

  test('fails NOT_AVAILABLE when open throws', async () => {
    const { error } = await libFailureOfBoth(
      openPineEditor,
      [2000],
      withModules(registry({}), {
        TradingViewApi: {
          pineEditorApi: () => ({
            open: () => {
              throw new Error('no chunk');
            },
          }),
        },
      }),
    );

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(error.details).toEqual({ reason: 'no chunk' });
  });

  test('fails CAPABILITY_UNAVAILABLE before acting on a page without the Pine Editor API', async () => {
    const { error, win } = await libFailureOfBoth(
      openPineEditor,
      [2000],
      chart(fixture, { withoutApi: true }),
    );

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(callNames(win)).toEqual([]);
  });

  test('fails CAPABILITY_UNAVAILABLE before acting on a page without the registry', async () => {
    const { error, win } = await libFailureOfBoth(
      openPineEditor,
      [2000],
      chart(fixture, { webpackModules: {} }),
    );

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(callNames(win)).toEqual([]);
  });

  // A page whose editor registers when it is opened, with `facade` behind it.
  function opening(facade: () => unknown): Make {
    return () => {
      let opened = false;
      return {
        TradingViewApi: {
          pineEditorApi: () => ({
            open: () => {
              opened = true;
              return Promise.resolve();
            },
          }),
        },
        webpackChunktradingview: createFakeWebpack({
          1: {
            ...registry({}),
            getOpenPineEditor: (placement: string) =>
              opened && placement === 'dialog' ? { getFacade: facade } : null,
          },
        }),
      };
    };
  }

  test('fails TIMEOUT in time when getSource never answers', async () => {
    const started = Date.now();
    const { error } = await libFailureOfBoth(
      openPineEditor,
      [150],
      opening(() => ({ getSource: () => new Promise(() => undefined) })),
    );

    expect(error.code).toBe('TIMEOUT');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('waits while the registered editor has no facade yet', async () => {
    let asked = 0;
    const { result } = await libResultOf(
      openPineEditor,
      [2000],
      opening(() => {
        asked += 1;
        return asked % 3 === 0
          ? {
              isModified: () => false,
              isDraft: () => true,
              getScriptIdVersion: () => null,
              getSource: () => Promise.resolve(''),
            }
          : null;
      }),
    );

    expect(result).toStrictEqual({
      state: { open: true, placement: 'dialog', modified: false, draft: true, script: null },
      unreadable: [],
    });
  });

  test('takes a facade without getSource as ready', async () => {
    const { result } = await libResultOf(
      openPineEditor,
      [2000],
      opening(() => ({
        isModified: () => true,
        isDraft: () => true,
        getScriptIdVersion: () => null,
      })),
    );

    expect(result).toMatchObject({ state: { open: true, modified: true } });
  });
});

describe('closePineEditor', () => {
  test('closes the side panel, whose script the app keeps', async () => {
    const { result, win } = await libResultOf(closePineEditor, [], chart(withEditor('dialog')));

    expect(result).toStrictEqual({ closed: true, placement: 'dialog' });
    const inspector = inspectFakeWindow(win);
    // The one call it makes is the close of the side panel: nothing resets the script.
    expect(callNames(win)).toEqual(['pageLayout.closeSidePanel']);
    expect(inspector.callsTo('pageLayout.closeSidePanel')).toEqual([['pine']]);
    expect(inspector.state.pineEditor).toMatchObject({
      placement: null,
      visible: false,
      source: fixture.pineEditor.source,
      script: fixture.pineEditor.script,
    });
  });

  test('minimizes the bottom bar for an editor at the bottom', async () => {
    const { result, win } = await libResultOf(closePineEditor, [], chart(withEditor('bottom')));

    expect(result).toStrictEqual({ closed: true, placement: 'bottom' });
    expect(callNames(win)).toEqual(['bottomWidgetBar.close']);
    expect(inspectFakeWindow(win).state.pineEditor).toMatchObject({
      placement: 'bottom',
      visible: false,
      source: fixture.pineEditor.source,
    });
  });

  test('never calls releaseScript, destroy or closeScript, which discard the text', async () => {
    const touched: string[] = [];
    const facade = Object.fromEntries(
      ['releaseScript', 'destroy', 'closeScript'].map((name) => [
        name,
        () => {
          touched.push(name);
        },
      ]),
    );
    const layout = { hasSidePanel: () => true, closeSidePanel: () => undefined };
    for (const placement of ['dialog', 'bottom'] as const) {
      await libResultOf(
        closePineEditor,
        [],
        withModules(
          {
            ...registry({ [placement]: { getFacade: () => facade, ...facade } }),
            hasService: () => true,
            service: () => layout,
            PAGE_LAYOUT_SERVICE: 'PageLayoutService',
          },
          { TradingView: { bottomWidgetBar: { close: () => undefined, ...facade } } },
        ),
      );
    }

    expect(touched).toEqual([]);
  });

  test('does nothing when no editor is open', async () => {
    const { result, win } = await libResultOf(closePineEditor, [], chart());

    expect(result).toStrictEqual({ closed: false, placement: null });
    expect(callNames(win)).toEqual([]);
  });

  test('fails CAPABILITY_UNAVAILABLE before acting without the page layout service', async () => {
    const { error, win } = await libFailureOfBoth(
      closePineEditor,
      [],
      chart(withEditor('dialog'), { withoutPageLayoutService: true }),
    );

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(callNames(win)).toEqual([]);
    expect(inspectFakeWindow(win).state.pineEditor.visible).toBe(true);
  });

  test('fails CAPABILITY_UNAVAILABLE before acting without the bottom bar', async () => {
    const { error, win } = await libFailureOfBoth(
      closePineEditor,
      [],
      chart(withEditor('bottom'), { withoutBottomWidgetBar: true }),
    );

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(callNames(win)).toEqual([]);
    expect(inspectFakeWindow(win).state.pineEditor.visible).toBe(true);
  });

  test('fails CAPABILITY_UNAVAILABLE when the editor is not the side panel', async () => {
    const closed: string[] = [];
    const { error } = await libFailureOfBoth(
      closePineEditor,
      [],
      withModules({
        ...registry({ dialog: { getFacade: () => ({}) } }),
        hasService: () => true,
        service: () => ({
          hasSidePanel: () => false,
          closeSidePanel: (id: string) => closed.push(id),
        }),
        PAGE_LAYOUT_SERVICE: 'PageLayoutService',
      }),
    );

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(closed).toEqual([]);
  });

  test('fails CAPABILITY_UNAVAILABLE on a page without the registry', async () => {
    const { error } = await libFailureOfBoth(
      closePineEditor,
      [],
      chart(withEditor('dialog'), { webpackModules: {} }),
    );

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
  });

  test('fails NOT_AVAILABLE with the reason when the close path throws', async () => {
    const { error } = await libFailureOfBoth(
      closePineEditor,
      [],
      withModules(registry({ bottom: { getFacade: () => ({}) } }), {
        TradingView: {
          bottomWidgetBar: {
            close: () => {
              throw new Error('bar gone');
            },
          },
        },
      }),
    );

    expect(error.code).toBe('NOT_AVAILABLE');
    expect(error.details).toEqual({ reason: 'bar gone' });
  });
});

// A member that throws `message` when it is called.
const thrower = (message: string) => () => {
  throw new Error(message);
};

describe('an open editor read by readPineEditorState and openPineEditor alike', () => {
  const cases: { name: string; make: Make; expected: unknown }[] = [
    {
      name: 'members that throw or answer the wrong type',
      make: withModules(
        registry({
          dialog: {
            getFacade: () => ({
              isModified: thrower('not ready'),
              isDraft: () => 1,
              getScriptIdVersion: () => ({ scriptIdPart: 42, version: '1.0' }),
            }),
          },
        }),
      ),
      expected: {
        state: { open: true, placement: 'dialog', modified: true, draft: true, script: null },
        unreadable: ['getScriptIdVersion', 'isModified', 'isDraft'],
      },
    },
    {
      name: 'a script id that is not an object',
      make: withModules(
        registry({
          bottom: {
            getFacade: () => ({
              isModified: () => false,
              isDraft: () => false,
              getScriptIdVersion: () => 'USER;x',
            }),
          },
        }),
      ),
      expected: {
        state: { open: true, placement: 'bottom', modified: false, draft: false, script: null },
        unreadable: ['getScriptIdVersion'],
      },
    },
    {
      name: 'a facade that cannot be had, after a placement whose lookup throws',
      make: withModules({
        getOpenPineEditor: (placement: string) => {
          if (placement === 'dialog') {
            throw new Error('boom');
          }
          return { getFacade: thrower('gone') };
        },
      }),
      expected: {
        state: { open: true, placement: 'bottom', modified: true, draft: true, script: null },
        unreadable: ['getFacade'],
      },
    },
    {
      name: 'a saved script without unsaved changes',
      make: chart(withEditor('dialog')),
      expected: {
        state: { open: true, placement: 'dialog', modified: false, draft: false, script: SCRIPT },
        unreadable: [],
      },
    },
  ];

  test.each(cases)('$name', async ({ make, expected }) => {
    expect((await libResultOf(readPineEditorState, [], make)).result).toStrictEqual(expected);
    expect((await libResultOf(openPineEditor, [100], make)).result).toStrictEqual(expected);
  });
});

describe('members of the app that throw when they are read', () => {
  test('openPineEditor takes a pineEditorApi that throws for none', async () => {
    const { error } = await libFailureOfBoth(
      openPineEditor,
      [100],
      withModules(registry({}), {
        TradingViewApi: {
          pineEditorApi: () => {
            throw new Error('not yet');
          },
        },
      }),
    );

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
  });

  test('closePineEditor passes over a placement whose lookup throws', async () => {
    const { result } = await libResultOf(
      closePineEditor,
      [],
      withModules({
        getOpenPineEditor: () => {
          throw new Error('boom');
        },
      }),
    );

    expect(result).toStrictEqual({ closed: false, placement: null });
  });

  test('closePineEditor takes a service locator that throws, or a hasSidePanel that throws, as no close path', async () => {
    const closed: string[] = [];
    const layout = (hasSidePanel: () => boolean) => ({
      hasSidePanel,
      closeSidePanel: (id: string) => closed.push(id),
    });
    for (const locator of [
      { hasService: () => true, service: thrower('locked') },
      { hasService: () => true, service: () => layout(thrower('no panels')) },
    ]) {
      const { error } = await libFailureOfBoth(
        closePineEditor,
        [],
        withModules({
          ...registry({ dialog: { getFacade: () => ({}) } }),
          ...locator,
          PAGE_LAYOUT_SERVICE: 'PageLayoutService',
        }),
      );

      expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
      expect(error.details).toEqual({ placement: 'dialog' });
    }
    expect(closed).toEqual([]);
  });

  test('closePineEditor takes a TradingView global that throws as no bottom bar', async () => {
    const { error } = await libFailureOfBoth(
      closePineEditor,
      [],
      // The getter is defined on the window itself, which a spread would read.
      () =>
        Object.defineProperty(
          withModules(registry({ bottom: { getFacade: () => ({}) } }))(),
          'TradingView',
          {
            get: thrower('booting'),
          },
        ),
    );

    expect(error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(error.details).toEqual({ placement: 'bottom' });
  });
});
