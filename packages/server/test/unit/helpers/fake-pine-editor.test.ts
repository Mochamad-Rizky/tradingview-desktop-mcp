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
