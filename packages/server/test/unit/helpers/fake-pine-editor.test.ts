import { setTimeout as delay } from 'node:timers/promises';
import { loadTvFixture, type TvStateFixture } from '../../helpers/fake-tv/fixture.js';
import type { FakeOpenPineEditor } from '../../helpers/fake-tv/pine-editor.js';
import type { FakeWebpackRequire } from '../../helpers/fake-tv/webpack.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTvOverrides,
  type FakeTvWindow,
} from '../../helpers/fake-tv/window.js';

// The Pine Editor of the fake app (pine-editor.ts), checked against the shapes the
// reverse-engineering notes of Plan 2 record for the app (section Q1). Sources are synthetic.

const fixture = loadTvFixture();

function withEditor(open: 'dialog' | 'bottom' | null, opensAt: 'dialog' | 'bottom' = 'dialog') {
  return { ...fixture, pineEditor: { ...fixture.pineEditor, open, opensAt } };
}

// The exports of the default webpack cache, by name.
function exportsOf(win: FakeTvWindow): Record<string, unknown> {
  let handed: FakeWebpackRequire | undefined;
  (win.webpackChunktradingview as { push(chunk: unknown): unknown }).push([
    ['probe'],
    {},
    (given: FakeWebpackRequire) => (handed = given),
  ]);
  const found: Record<string, unknown> = {};
  for (const record of Object.values(handed?.c ?? {})) {
    Object.assign(found, record.exports);
  }
  return found;
}

function editorOf(from: TvStateFixture = fixture, overrides: FakeTvOverrides = {}) {
  const win = createFakeTvWindow(from, overrides);
  const exports = exportsOf(win);
  const getOpen = exports.getOpenPineEditor as (placement: string) => FakeOpenPineEditor | null;
  const api = win.TradingViewApi?.pineEditorApi();
  if (api === undefined) {
    throw new Error('The fake window has no Pine Editor API');
  }
  return { win, exports, getOpen, api, inspector: inspectFakeWindow(win) };
}

test('the editor starts closed, holding the script of the fixture', () => {
  const { getOpen, api, inspector } = editorOf();

  expect([getOpen('dialog'), getOpen('bottom'), getOpen('detach')]).toEqual([null, null, null]);
  expect([api.getDialogFacade(), api.getBottomFacade()]).toEqual([null, null]);
  expect(inspector.state.pineEditor).toEqual({
    placement: null,
    visible: false,
    ready: false,
    source: fixture.pineEditor.source,
    savedSource: fixture.pineEditor.savedSource,
    script: fixture.pineEditor.script,
    signedIn: true,
    savedScripts: fixture.pineEditor.savedScripts,
    saveErrors: null,
  });
});

test('open registers the editor at the opensAt placement and mounts it after readyMs', async () => {
  const { getOpen, api, inspector } = editorOf(withEditor(null, 'bottom'), {
    pineEditorReadyMs: 60,
  });

  const opened = api.open({ forceOpen: true });
  expect(getOpen('bottom')).toBeNull();
  await opened;

  const facade = getOpen('bottom')?.getFacade();
  expect(facade?.placement).toBe('bottom');
  expect(api.getBottomFacade()).toBe(facade);
  await expect(facade?.getSource()).rejects.toThrow('Value is null');
  await delay(80);
  await expect(facade?.getSource()).resolves.toBe(fixture.pineEditor.source);
  expect(inspector.callsTo('pineEditorApi.open')).toEqual([[{ forceOpen: true }]]);
});

test('open never mounts the editor with an infinite readyMs, and can be made to reject', async () => {
  const never = editorOf(fixture, { pineEditorReadyMs: Infinity });
  await never.api.open();
  await delay(20);
  expect(never.inspector.state.pineEditor).toMatchObject({ placement: 'dialog', ready: false });

  const failing = editorOf(fixture, { pineEditorOpenError: 'chunk failed' });
  await expect(failing.api.open()).rejects.toThrow('chunk failed');
  expect(failing.getOpen('dialog')).toBeNull();
});

test('the facade reports modified, draft and the script id, and a new script takes its template', async () => {
  const { getOpen, inspector } = editorOf(withEditor('dialog'));
  const facade = getOpen('dialog')?.getFacade();

  expect([facade?.isModified(), facade?.isDraft(), facade?.getScriptIdVersion()]).toEqual([
    false,
    false,
    fixture.pineEditor.script,
  ]);
  await facade?.setScript('//@version=6\nindicator("Changed")\n');
  expect(facade?.isModified()).toBe(true);

  await facade?.openNewScript('strategy');
  expect(inspector.state.pineEditor.source).toBe(fixture.pineEditor.templates.strategy);
  expect([facade?.isModified(), facade?.isDraft(), facade?.getScriptIdVersion()]).toEqual([
    false,
    true,
    null,
  ]);
  await facade?.openNewScript('unknown');
  expect(inspector.state.pineEditor.source).toBe(fixture.pineEditor.templates.indicator);
  expect(fixture.pineEditor.templates.indicator).toContain('© fixture_author');

  inspector.state.pineEditor.script = { scriptIdPart: 'USER;x', version: '0.3' };
  expect(facade?.isDraft()).toBe(true);
  expect(inspector.callsTo('pineFacade.setScript')).toHaveLength(1);
  expect(inspector.callsTo('pineFacade.openNewScript')).toEqual([['strategy'], ['unknown']]);
});

test('closing the side panel or the bottom bar hides the editor and keeps it with its text', () => {
  const side = editorOf(withEditor('dialog'));
  const layout = (side.exports.service as (descriptor: unknown) => Record<string, unknown>)(
    side.exports.PAGE_LAYOUT_SERVICE,
  );
  (layout.closeSidePanel as (id: string) => void)('pine');

  expect(side.inspector.state.pineEditor).toMatchObject({
    placement: 'dialog',
    visible: false,
    source: fixture.pineEditor.source,
  });
  expect(side.getOpen('dialog')).not.toBeNull();
  expect(side.inspector.callsTo('pageLayout.closeSidePanel')).toEqual([['pine']]);

  const bottom = editorOf(withEditor('bottom'));
  bottom.win.TradingView?.bottomWidgetBar?.close();

  expect(bottom.inspector.state.pineEditor).toMatchObject({ placement: 'bottom', visible: false });
  expect(bottom.getOpen('bottom')).not.toBeNull();
  expect(bottom.inspector.callsTo('bottomWidgetBar.close')).toEqual([[]]);
});

test('releaseScript discards the text and unregisters the editor', () => {
  const { getOpen, inspector } = editorOf(withEditor('dialog'));

  getOpen('dialog')?.getFacade().releaseScript();

  expect(getOpen('dialog')).toBeNull();
  expect(inspector.state.pineEditor).toMatchObject({ placement: null, source: '', script: null });
  expect(inspector.callsTo('pineFacade.releaseScript')).toEqual([[]]);
});

test('the service locator answers the page layout service unless it is left out', () => {
  const { exports } = editorOf();
  const hasService = exports.hasService as (descriptor: unknown) => boolean;
  const service = exports.service as (descriptor: unknown) => unknown;

  expect(exports.PAGE_LAYOUT_SERVICE).toBe('PageLayoutService');
  expect(hasService('PageLayoutService')).toBe(true);
  expect(() => service('OtherService')).toThrow('Service not found');

  const without = editorOf(fixture, { withoutPageLayoutService: true });
  expect(
    (without.exports.hasService as (descriptor: unknown) => boolean)('PageLayoutService'),
  ).toBe(false);
  expect(editorOf(fixture, { withoutBottomWidgetBar: true }).win.TradingView).toEqual({});
});

const SAVED = fixture.pineEditor.savedScripts;

test('requestUserScripts and listSavedScripts list the saved scripts without sources, none signed out', async () => {
  const { win, exports, api, inspector } = editorOf();
  const requestUserScripts = exports.requestUserScripts as () => Promise<unknown[]>;
  const listed = SAVED.map((script) => {
    const rest: Partial<typeof script> = { ...script };
    delete rest.source;
    return rest;
  });

  expect(win.is_authenticated).toBe(true);
  await expect(requestUserScripts()).resolves.toEqual(listed);
  await expect(api.listSavedScripts()).resolves.toEqual(listed);
  inspector.state.pineEditor.signedIn = false;
  expect(win.is_authenticated).toBe(false);
  await expect(requestUserScripts()).resolves.toEqual([]);
  expect(inspector.callsTo('requestUserScripts')).toEqual([[], []]);
  expect(inspector.callsTo('pineEditorApi.listSavedScripts')).toEqual([[]]);
  expect(
    (exports.isFeatureEnabled as (name: string) => boolean)('pine_free_saved_scripts_limit'),
  ).toBe(true);
  expect((exports.isFeatureEnabled as (name: unknown) => boolean)(1)).toBe(false);
});

test('saveNewScript opens the paywall at the saved-script limit, and saves a new script below it', async () => {
  const atLimit = editorOf();

  await expect(atLimit.api.saveNewScript({ source: 'x', name: 'New' })).rejects.toThrow(
    'Saving one more script is not available on the current plan',
  );
  expect(atLimit.inspector.callsTo('dialog.paywall')).toEqual([[{ feature: 'pineScriptsLimit' }]]);

  const roomy = editorOf({
    ...fixture,
    planLimits: { ...fixture.planLimits, SAVED_PINE_SCRIPTS: 5 },
  });
  await expect(roomy.api.saveNewScript({ source: '', name: 'Empty' })).rejects.toThrow(
    'Empty source code',
  );
  const source = '//@version=6\nstrategy("New")\n';
  const result = await roomy.api.saveNewScript({ source, name: 'New' });
  const id = result.metaInfo.scriptIdPart;

  expect(result).toEqual({
    success: true,
    metaInfo: { scriptIdPart: id, pine: { version: '1.0' } },
    compileErrors: { errors: [], warnings: [] },
  });
  expect(id).toMatch(/^USER;[0-9a-f]{32}$/);
  expect(roomy.inspector.state.pineEditor.savedScripts.at(-1)).toMatchObject({
    scriptIdPart: id,
    scriptName: 'New',
    version: '1.0',
    kind: 'strategy',
    source,
  });
  roomy.inspector.state.pineEditor.saveErrors = [{ message: 'Syntax error' }];
  await expect(roomy.api.saveNewScript({ source, name: 'Other' })).resolves.toEqual({
    success: false,
    metaInfo: {},
    compileErrors: { errors: [{ message: 'Syntax error' }], warnings: [] },
  });
  expect(roomy.inspector.callsTo('dialog.paywall')).toEqual([]);
});

test('the paywall check of saveNewScript follows the feature toggle and skips drafts', async () => {
  const off = editorOf({ ...fixture, featureToggles: {} });
  await expect(off.api.saveNewScript({ source: 'x', name: 'A' })).resolves.toMatchObject({
    success: true,
  });
  const twoLeft = editorOf({
    ...fixture,
    planLimits: { ...fixture.planLimits, SAVED_PINE_SCRIPTS: 3 },
  });
  // Two of the three saved scripts count; the draft does not.
  await expect(twoLeft.api.saveNewScript({ source: 'x', name: 'A' })).resolves.toMatchObject({
    success: true,
  });
  await expect(twoLeft.api.saveNewScript({ source: 'x', name: 'B' })).rejects.toThrow();
});

test('openScript loads a saved script by id, and opens a new script when that fails', async () => {
  const { getOpen, inspector } = editorOf(withEditor('dialog'));
  const facade = getOpen('dialog')?.getFacade();
  const [, strategy, draft] = SAVED;

  await facade?.openScript({ scriptIdPart: strategy?.scriptIdPart ?? '' });
  expect(inspector.state.pineEditor).toMatchObject({
    script: { scriptIdPart: strategy?.scriptIdPart, version: strategy?.version },
    source: strategy?.source,
    savedSource: strategy?.source,
  });
  await facade?.openScript({ scriptIdPart: draft?.scriptIdPart ?? '', version: '0.1' });
  expect(facade?.isDraft()).toBe(true);
  const broken = inspector.state.pineEditor.savedScripts[1];
  if (broken !== undefined) {
    broken.source = null;
  }
  await facade?.openScript({ scriptIdPart: strategy?.scriptIdPart ?? '' });
  expect(inspector.state.pineEditor).toMatchObject({
    script: null,
    source: fixture.pineEditor.templates.indicator,
  });
});

test('saveScript saves a new version of a saved script, and refuses drafts, signed out and nothing to save', async () => {
  const { getOpen, inspector } = editorOf(withEditor('dialog'));
  const facade = getOpen('dialog')?.getFacade();
  const editor = inspector.state.pineEditor;

  await expect(facade?.saveScript()).rejects.toBeUndefined();
  editor.source = '//@version=6\nindicator("Fixture Script")\nplot(open)\n';
  editor.saveErrors = [{ message: 'Syntax error' }];
  await expect(facade?.saveScript()).rejects.toBeUndefined();
  editor.saveErrors = null;
  editor.signedIn = false;
  await expect(facade?.saveScript()).rejects.toThrow('Sign in is required to save a script');
  editor.signedIn = true;
  await expect(facade?.saveScript()).resolves.toEqual({
    script: { scriptIdPart: SAVED[0]?.scriptIdPart, version: '3.0', scriptName: 'Fixture Script' },
    compileErrors: undefined,
  });
  expect(facade?.isModified()).toBe(false);
  expect(editor.savedScripts[0]).toMatchObject({ version: '3.0', source: editor.source });

  editor.script = { scriptIdPart: 'USER;unlisted', version: '1.1' };
  await expect(facade?.saveScript()).resolves.toMatchObject({
    script: { scriptIdPart: 'USER;unlisted', version: '2.0', scriptName: 'Untitled' },
  });
  editor.script = { scriptIdPart: 'USER;noversion', version: undefined };
  await expect(facade?.saveScript()).rejects.toBeUndefined();
  expect(inspector.callsTo('dialog.signIn')).toEqual([[]]);
  expect(inspector.callsTo('dialog.renameScript')).toEqual([[]]);
});
