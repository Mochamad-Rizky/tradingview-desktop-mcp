import { setTimeout as delay } from 'node:timers/promises';
import { loadTvFixture, type TvStateFixture } from '../../helpers/fake-tv/fixture.js';
import { compileFakePine, type FakeOpenPineEditor } from '../../helpers/fake-tv/pine-editor.js';
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
    consoleMessages: [],
    compileHttpError: null,
    compileFirstErrorOnly: false,
    unsavedKept: false,
    openedBefore: false,
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

test('closing the side panel takes the editor out of the registry and keeps its script; the bottom bar only hides it', () => {
  const side = editorOf(withEditor('dialog'));
  const layout = (side.exports.service as (descriptor: unknown) => Record<string, unknown>)(
    side.exports.PAGE_LAYOUT_SERVICE,
  );
  side.inspector.state.pineEditor.source = 'unsaved text';
  (layout.closeSidePanel as (id: string) => void)('pine');

  expect(side.inspector.state.pineEditor).toMatchObject({
    placement: null,
    visible: false,
    ready: false,
    source: 'unsaved text',
    script: fixture.pineEditor.script,
    unsavedKept: true,
  });
  expect(side.getOpen('dialog')).toBeNull();
  expect(side.inspector.callsTo('pageLayout.closeSidePanel')).toEqual([['pine']]);

  const bottom = editorOf(withEditor('bottom'));
  bottom.win.TradingView?.bottomWidgetBar?.close();

  expect(bottom.inspector.state.pineEditor).toMatchObject({ placement: 'bottom', visible: false });
  expect(bottom.getOpen('bottom')).not.toBeNull();
  expect(bottom.inspector.callsTo('bottomWidgetBar.close')).toEqual([[]]);
});

test('an open after the side panel closed shows a new script, or the unsaved text it kept as the text of the script', async () => {
  const { exports, api, inspector } = editorOf(withEditor('dialog'), { pineEditorReadyMs: 0 });
  const editor = inspector.state.pineEditor;
  const layout = (exports.service as (descriptor: unknown) => Record<string, unknown>)(
    exports.PAGE_LAYOUT_SERVICE,
  );
  const close = layout.closeSidePanel as (id: string) => void;
  const flag = () =>
    (exports.getPersistedValue as (key: string, perUser: boolean) => unknown)(
      (exports.getPersistenceKey as (key: string, placement: string) => string)(
        exports.hasScriptModificationsKey as string,
        'dialog',
      ),
      true,
    );

  // Without unsaved changes: a new script.
  close('pine');
  expect(flag()).toBe(false);
  await api.open();
  expect(editor).toMatchObject({ placement: 'dialog', script: null });
  expect(editor.source).toBe(fixture.pineEditor.templates.indicator);

  // With unsaved changes: they are kept, and come back as the text of the script.
  editor.source = 'unsaved text';
  expect(flag()).toBe(false);
  close('pine');
  expect(flag()).toBe(true);
  await api.open();
  expect(editor).toMatchObject({ source: 'unsaved text', savedSource: 'unsaved text' });
  expect(api.getDialogFacade()?.isModified()).toBe(false);
  expect(flag()).toBe(true);
  // Whole by account, as the app keeps it, and recorded when the app would clear it.
  expect(
    (exports.getPersistedValue as (key: string, perUser?: boolean, clear?: boolean) => unknown)(
      'has_unsaved_modifications',
      false,
      true,
    ),
  ).toEqual({ fixture_author: true });
  expect(inspector.callsTo('clearPersistedValue')).toEqual([['has_unsaved_modifications']]);
});

test('the flag of unsaved changes stays as it is while the editor is open, and the close writes it', async () => {
  const { exports, api, inspector } = editorOf(withEditor('dialog'), { pineEditorReadyMs: 0 });
  const editor = inspector.state.pineEditor;
  const layout = (exports.service as (descriptor: unknown) => Record<string, unknown>)(
    exports.PAGE_LAYOUT_SERVICE,
  );
  const close = layout.closeSidePanel as (id: string) => void;
  const flag = () =>
    (exports.getPersistedValue as (key: string, perUser: boolean) => unknown)(
      exports.hasScriptModificationsKey as string,
      true,
    );
  editor.source = 'unsaved text';
  close('pine');
  await api.open();
  const facade = api.getDialogFacade();
  expect(flag()).toBe(true);

  // Seen on the app: replacing the text the app kept leaves the flag set until the side panel
  // closes, whether a script is started, opened, saved or added to the chart.
  await facade?.openNewScript();
  expect(flag()).toBe(true);
  await facade?.openScript({ scriptIdPart: SAVED[0]?.scriptIdPart ?? '' });
  expect(editor.source).toBe(SAVED[0]?.source);
  expect(flag()).toBe(true);
  await facade?.setScript('//@version=6\nindicator("Saved again")\nplot(close)\n');
  await facade?.saveScript();
  expect(flag()).toBe(true);
  await facade?.openNewScript();
  await facade?.addToChart();
  expect(flag()).toBe(true);

  // The close writes it from the text the editor holds then: here a script without changes.
  close('pine');
  expect(flag()).toBe(false);
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

test('requestUserScripts and listSavedScripts list the saved scripts as the app does, none signed out', async () => {
  const { win, exports, api, inspector } = editorOf();
  const requestUserScripts = exports.requestUserScripts as () => Promise<unknown[]>;
  // With the text of each script and its kind in extra, as seen on the app.
  const listed = SAVED.map(({ source, kind, ...rest }) => ({
    ...rest,
    isTVScriptBuiltIn: false,
    scriptSource: source,
    extra: kind === undefined ? {} : { kind },
  }));

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

test('saveScript opens the paywall for a saved script outside the newest the plan lets be updated', async () => {
  const { getOpen, inspector } = editorOf(withEditor('dialog'));
  const facade = getOpen('dialog')?.getFacade();
  const editor = inspector.state.pineEditor;
  const [, strategy] = SAVED;
  await facade?.openScript({ scriptIdPart: strategy?.scriptIdPart ?? '' });
  editor.source = `${strategy?.source ?? ''}plot(close)\n`;

  // The plan allows one saved script, and the newest one is another.
  await expect(facade?.saveScript()).rejects.toThrow(
    'Updating this script is not available on the current plan',
  );
  expect(inspector.callsTo('dialog.paywall')).toEqual([[{ feature: 'pineScriptsLimit' }]]);
  expect(editor.savedScripts[1]?.version).toBe(strategy?.version);

  // With the toggle off, the app applies no limit.
  const off = editorOf({ ...withEditor('dialog'), featureToggles: {} });
  const free = off.getOpen('dialog')?.getFacade();
  await free?.openScript({ scriptIdPart: strategy?.scriptIdPart ?? '' });
  off.inspector.state.pineEditor.source = `${strategy?.source ?? ''}plot(close)\n`;
  await expect(free?.saveScript()).resolves.toMatchObject({
    script: { scriptIdPart: strategy?.scriptIdPart, version: '4.0' },
  });
  expect(off.inspector.callsTo('dialog.paywall')).toEqual([]);
});

test('the fake compiler finds undeclared and deprecated words and legacy errors, CRLF or not', () => {
  expect(
    compileFakePine(
      '//@version=6\r\nindicator("X")\r\nplot(undeclared_x)\nx = deprecated_f()\rlegacy_error\n',
    ),
  ).toEqual({
    errors: [
      {
        message: 'Undeclared identifier "{identifier}"',
        ctx: { identifier: 'undeclared_x' },
        code: 'CE10272',
        start: { line: 3, column: 6 },
        end: { line: 3, column: 17 },
      },
      { message: 'Syntax error at input "legacy_error"', start: { line: 5, column: 0 } },
    ],
    warnings: [
      {
        message: 'The function {name} is deprecated',
        ctx: { name: 'deprecated_f' },
        start: { line: 4, column: 5 },
        end: { line: 4, column: 16 },
      },
    ],
  });
});

// The v4 names the analyzer renames, which a script of version 5 or later no longer has.
const V4_NAMES = [
  'study',
  'security',
  'tostring',
  'sma',
  'ema',
  'rsi',
  'macd',
  'stoch',
  'atr',
  'crossover',
  'crossunder',
  'highest',
  'lowest',
  'change',
];

// Where and which names the fake compiler reports as unknown in a text: undeclared, or a function
// it cannot find.
const unknownIn = (source: string) =>
  compileFakePine(source).errors.map(({ ctx, start }) => [
    ctx?.fullName ?? ctx?.identifier,
    start?.line,
    start?.column,
  ]);

test('the fake compiler cannot find a v4 function in a script of version 5 or later, and stops there, as the app does', () => {
  // study is the first error, and the compiler reports none after it: not rsi either.
  expect(compileFakePine('//@version=6\nstudy("x")\nplot(rsi(close,14))\n')).toEqual({
    errors: [
      {
        message: "Could not find {kind} '{fullName}'",
        ctx: { fullName: 'study', kind: 'function or function reference' },
        code: 'CE10271',
        start: { line: 2, column: 1 },
        end: { line: 2, column: 5 },
      },
    ],
    warnings: [],
  });
  for (const name of V4_NAMES) {
    expect(unknownIn(`//@version=5\nx = ${name}(close)\n`), name).toEqual([[name, 2, 5]]);
  }
  // Of several on one line, the first column comes first, and ends the report.
  expect(unknownIn('//@version=6\nplot(sma(rsi(close,14),5))\n')).toEqual([['sma', 2, 6]]);
});

test('the fake compiler compiles a script below version 5, or without a version, as an old one', () => {
  const body = 'study("x")\nplot(rsi(close,14))\n';

  expect(unknownIn(body)).toEqual([]);
  expect(unknownIn(`//@version=4\n${body}`)).toEqual([]);
  expect(unknownIn(`//@version=1\n${body}`)).toEqual([]);
  // The annotation may have spaces and may follow other comments.
  expect(unknownIn(`// An old script\n// @version = 5\n${body}`)).toEqual([['study', 3, 1]]);
});

test('the fake compiler does not find names unknown that are namespaced, quoted, commented or declared', () => {
  const clean = [
    '//@version=6',
    'indicator("study(x)") // rsi(close) and sma(close)',
    "label = 'ema(close)'",
    'plot(ta.rsi(close, 14))',
    'x = request.security("A", "D", close)',
    'y = str.tostring(1) + my_sma(close)',
    'highest(src) =>',
    '    src',
    'plot(highest(close))',
    '',
  ].join('\n');

  expect(unknownIn(clean)).toEqual([]);
  // A variable named like the built-in does not declare the call on its right.
  expect(unknownIn('//@version=6\nrsi = rsi(close, 14)\nplot(rsi)\n')).toEqual([['rsi', 2, 7]]);
});

test('the fake compiler reports what comes before a function it cannot find, and nothing after it', () => {
  const found = compileFakePine(
    [
      '//@version=6',
      'plot(undeclared_a)',
      'x = deprecated_f()',
      'study(close)',
      'legacy_error',
      'plot(undeclared_b)',
      '',
    ].join('\n'),
  );

  expect(
    found.errors.map(({ ctx, message }) => ctx?.fullName ?? ctx?.identifier ?? message),
  ).toEqual(['undeclared_a', 'study']);
  expect(found.warnings.map(({ ctx }) => ctx?.name)).toEqual(['deprecated_f']);
  // On one line, by column: an undeclared word before the call is reported, one after it not.
  expect(unknownIn('//@version=6\nx = undeclared_a + rsi(close)\n')).toEqual([
    ['undeclared_a', 2, 5],
    ['rsi', 2, 20],
  ]);
  expect(unknownIn('//@version=6\nx = rsi(close) + undeclared_a\n')).toEqual([['rsi', 2, 5]]);
});

test('translateScriptAsync resolves a clean text, rejects compile errors and HTTP failures', async () => {
  const { exports, inspector } = editorOf();
  const translate = exports.translateScriptAsync as (
    source: string,
    id: string,
  ) => Promise<unknown>;

  await expect(translate('plot(close)\nx = deprecated_f()\n', 'USER;x')).resolves.toEqual({
    success: true,
    metaInfo: { scriptIdPart: 'USER;x', pine: { version: '1.0' } },
    compileErrors: {
      errors: [],
      warnings: [expect.objectContaining({ ctx: { name: 'deprecated_f' } })],
    },
  });
  const failure: unknown = await translate('plot(undeclared_y)', 'USER;x').catch(
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({
    message: 'Pine translation failed',
    reason: { errors: [expect.objectContaining({ start: { line: 1, column: 6 } })], warnings: [] },
  });
  inspector.state.pineEditor.compileHttpError = 'Server error, try again or contact support.';
  await expect(translate('plot(close)', 'USER;x')).rejects.toBe(
    'Server error, try again or contact support.',
  );
  expect(inspector.callsTo('translateScriptAsync')).toHaveLength(3);
});

test('a compiler that stops at its first error reports one error at a time, and every warning', async () => {
  const room = {
    ...withEditor('dialog'),
    planLimits: { ...fixture.planLimits, INDICATORS_ON_CHART: 5 },
  };
  const { exports, getOpen, inspector } = editorOf(room);
  const editor = inspector.state.pineEditor;
  const translate = exports.translateScriptAsync as (
    source: string,
    id: string,
  ) => Promise<unknown>;
  const source = 'plot(undeclared_a)\nplot(undeclared_b)\nx = deprecated_f()\n';
  editor.compileFirstErrorOnly = true;

  const failure: unknown = await translate(source, 'USER;x').catch((error: unknown) => error);
  expect(failure).toMatchObject({
    reason: {
      errors: [expect.objectContaining({ ctx: { identifier: 'undeclared_a' } })],
      warnings: [expect.objectContaining({ ctx: { name: 'deprecated_f' } })],
    },
  });

  // The editor compiles the same way when it adds the script.
  const facade = getOpen('dialog')?.getFacade();
  await facade?.openNewScript();
  await facade?.setScript(source);
  await facade?.addToChart();
  expect(editor.consoleMessages.filter(({ level }) => level === 'error')).toHaveLength(1);
  expect(editor.consoleMessages.filter(({ level }) => level === 'warning')).toHaveLength(1);
});

test('addToChart saves a new script as a draft, adds its study and writes the console', async () => {
  const room = {
    ...withEditor('dialog'),
    planLimits: { ...fixture.planLimits, INDICATORS_ON_CHART: 5 },
  };
  const { win, getOpen, inspector } = editorOf(room);
  const facade = getOpen('dialog')?.getFacade();
  const editor = inspector.state.pineEditor;
  const chart = win.TradingViewApi?.activeChart();

  await facade?.openNewScript();
  await facade?.setScript(
    '//@version=6\nindicator("Added")\nplot(undeclared_z)\nplot(deprecated_q)\n',
  );
  await expect(facade?.addToChart()).resolves.toBeUndefined();

  expect(editor.script).toEqual({
    scriptIdPart: `USER;${(0xd4b0).toString(16).padStart(32, '0')}`,
    version: '0.1',
  });
  expect(facade?.isModified()).toBe(false);
  expect(chart?.getAllStudies().at(-1)).toEqual({ id: 'NEW001', name: 'Added' });
  const core = chart?.getStudyById('NEW001').study();
  expect(core?.hasCompileError()).toBe(true);
  expect(core?.metaInfo().pine?.version).toBe('0.1');
  expect(core?.logs()).toBeNull();
  const messages = facade?._editorStore.getStore().getState().console.messages ?? [];
  expect(messages.map(({ level, text, start, end }) => ({ level, text, start, end }))).toEqual([
    { level: 'info', text: 'Compiling...', start: undefined, end: undefined },
    {
      level: 'error',
      text: 'Undeclared identifier "undeclared_z"',
      start: { line: 3, column: 6 },
      end: { line: 3, column: 18 },
    },
    {
      level: 'warning',
      text: 'The function deprecated_q is deprecated',
      start: { line: 4, column: 6 },
      end: { line: 4, column: 18 },
    },
    { level: 'info', text: 'Compilation error', start: undefined, end: undefined },
  ]);
  expect(messages.every(({ time }) => /^\d\d:\d\d:\d\d$/.test(time))).toBe(true);

  // A saved script without changes compiles and is added as it is.
  await facade?.openScript({ scriptIdPart: SAVED[0]?.scriptIdPart ?? '' });
  await facade?.addToChart();
  expect(chart?.getAllStudies().at(-1)).toEqual({ id: 'NEW002', name: 'Fixture Script' });
  expect(chart?.getStudyById('NEW002').study().hasCompileError()).toBe(false);
  expect(editor.consoleMessages.at(-1)?.text).toBe('Added to chart');
});

test('addToChart opens a dialog instead for a changed saved script, signed out and on a full chart', async () => {
  const { win, getOpen, inspector } = editorOf(withEditor('dialog'));
  const facade = getOpen('dialog')?.getFacade();
  const editor = inspector.state.pineEditor;
  const count = win.TradingViewApi?.activeChart().getAllStudies().length;

  await facade?.addToChart();
  expect(inspector.callsTo('dialog.paywall')).toEqual([['studyLimit']]);
  editor.source = '//@version=6\nindicator("Fixture Script")\nplot(open)\n';
  await facade?.addToChart();
  expect(inspector.callsTo('dialog.confirmSaveChanges')).toEqual([[]]);
  editor.signedIn = false;
  await facade?.addToChart();
  expect(inspector.callsTo('dialog.signIn')).toEqual([[]]);
  expect(win.TradingViewApi?.activeChart().getAllStudies()).toHaveLength(count ?? -1);
  expect(editor.consoleMessages).toEqual([]);
});

test('the logs of a study come as a set like the PrimitiveSet of the app', () => {
  const study = fixture.studies[0];
  if (study === undefined) {
    throw new Error('The fixture must hold a study');
  }
  const logs = [
    { barTime: 1_700_000_000, time: 1_700_000_000_500, level: 'info', message: 'first', line: 4 },
    { barTime: 1_700_000_060, time: 1_700_000_060_500, level: 'error', message: 'second' },
  ];
  const win = createFakeTvWindow({ ...fixture, studies: [{ ...study, logs }] });
  const set = win.TradingViewApi?.activeChart().getStudyById(study.id).study().logs();

  const items = [...(set ?? [])];
  expect(set?.size).toBe(2);
  expect(items[0]).toEqual({
    barTime: 1_700_000_000,
    time: 1_700_000_000_500,
    level: 'info',
    source: { start: { line: 4, column: 1 }, end: { line: 4, column: 1 } },
    message: 'first',
  });
  const seen: string[] = [];
  set?.forEach((item) => seen.push(item.message));
  expect(seen).toEqual(['first', 'second']);
  expect([...(set?.values() ?? [])].map(({ source }) => source.start.line)).toEqual([4, 1]);
  expect(() => {
    set?.entries();
  }).toThrow('Method not implemented.');
  expect(() => {
    set?.keys();
  }).toThrow('Method not implemented.');
});
