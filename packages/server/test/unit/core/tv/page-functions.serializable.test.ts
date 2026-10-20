import { setTimeout as delay } from 'node:timers/promises';
import vm from 'node:vm';
import { pageCallExpression, pageLibCallExpression } from '../../../../src/core/tv/page-bridge.js';
import { pageFunctions, pageLibFunctions } from '../../../../src/core/tv/page-functions.js';
import type { PageLib } from '../../../../src/core/tv/page-lib.js';
import type { TvWindow } from '../../../../src/core/tv/tv-window.js';
import { CDP_ERROR } from '../../../helpers/fake-cdp/protocol.js';
import { createPageContext } from '../../../helpers/fake-cdp/runtime.js';
import { loadTvFixture } from '../../../helpers/fake-tv/fixture.js';
import {
  createFakeTvWindow,
  inspectFakeWindow,
  type FakeTvOverrides,
} from '../../../helpers/fake-tv/window.js';

// The page bridge sends a page function as its source text, so a page function must not depend on
// anything of its module. These checks look at every registered page function the way the bridge
// sees it: its Function.prototype.toString text, run in a page that is a fake window, in the call
// the bridge makes for the registry the function is in.

// What a bundler or a module system leaves in a function that is not self-contained.
const BUNDLER_ARTIFACTS = /\b(require|import)\s*\(|__name|__async|__publicField|__spreadValues/;
// How the test runner rewrites a reference to an imported binding, a dynamic import or
// import.meta. The page has none of them, but the vm run only notices on a path it executes.
const RUNNER_IMPORTS = /__vite_ssr_/;
// Node globals the page does not have. They are matched as words anywhere in the source, so a
// comment or a string inside a page function that uses one of these words fails the check too.
const NODE_GLOBALS = /\b(process|require|module|Buffer)\b/g;
// How long a run may take to settle. A page function that waits for something the fake never
// does, or for an argument the guard does not pass, is checked as far as it got, and its timers
// are cancelled.
const SETTLE_MS = 500;

type Outcome =
  { kind: 'value'; value: unknown } | { kind: 'thrown'; error: unknown } | { kind: 'pending' };

// What the bridge sends for a call without arguments, built the way the bridge builds it: the window
// for a page function, and the window and the page library for a lib function. The guard knows no
// argument values, so a page function runs with only these, as far as that takes it.
function plainCall(source: string): string {
  return pageCallExpression(source, []);
}

function libCall(source: string): string {
  return pageLibCallExpression(source, []);
}

// The first bundler helper or import found in a source, for each kind there is.
function importsIn(source: string): string[] {
  const found: string[] = [];
  for (const pattern of [BUNDLER_ARTIFACTS, RUNNER_IMPORTS]) {
    const match = pattern.exec(source);
    if (match !== null) {
      found.push(match[0]);
    }
  }
  return found;
}

function nodeGlobalsIn(source: string): string[] {
  return source.match(NODE_GLOBALS) ?? [];
}

// Why an expression the bridge sends does not compile, if it does not.
function compileError(expression: string): string | undefined {
  try {
    new vm.Script(expression);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function runInFakePage(expression: string, win: object): Promise<Outcome> {
  const page = createPageContext(win);
  try {
    const value = page.run(expression);
    // Not ref'd, so a deadline that lost the race does not hold the test process.
    const pending = delay(SETTLE_MS, undefined, { ref: false }).then((): Outcome => ({
      kind: 'pending',
    }));
    const settled = Promise.resolve(value).then(
      (result): Outcome => ({ kind: 'value', value: result }),
      (error: unknown): Outcome => ({ kind: 'thrown', error }),
    );
    return await Promise.race([settled, pending]);
  } catch (error) {
    return { kind: 'thrown', error };
  } finally {
    page.dispose();
  }
}

// The message of a ReferenceError, if that is how the run ended. Errors of the page realm fail
// `instanceof ReferenceError`, so the name is what tells.
function referenceError(outcome: Outcome): string | undefined {
  if (outcome.kind !== 'thrown') {
    return undefined;
  }
  const { error } = outcome;
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'ReferenceError'
  ) {
    return 'message' in error ? String(error.message) : 'ReferenceError';
  }
  return undefined;
}

// The message of the TypeError a function ends in when it reads the page library it was not given:
// a lib function called the plain way gets no second argument, so its first look at the library
// reads a member of undefined. Errors of the page realm fail `instanceof`, so the name tells.
function libMisuse(outcome: Outcome): string | undefined {
  if (outcome.kind !== 'thrown') {
    return undefined;
  }
  const { error } = outcome;
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'TypeError' &&
    'message' in error &&
    /\b(findExport|findModuleWith)\b/.test(String(error.message))
  ) {
    return String(error.message);
  }
  return undefined;
}

function fakeWindows(overrides: FakeTvOverrides = {}): object[] {
  const fixture = loadTvFixture();
  // A booted chart, and a tab whose app has not booted, so both kinds of paths get to run.
  return [
    createFakeTvWindow(fixture, overrides),
    createFakeTvWindow(fixture, { ...overrides, withoutApi: true }),
  ];
}

// The ReferenceErrors an expression runs into in the fake pages.
async function referenceErrorsIn(expression: string, windows = fakeWindows()): Promise<string[]> {
  const messages: string[] = [];
  for (const win of windows) {
    const message = referenceError(await runInFakePage(expression, win));
    if (message !== undefined) {
      messages.push(message);
    }
  }
  return messages;
}

// The TypeErrors of a missing page library an expression runs into in the fake pages.
async function libMisusesIn(expression: string, windows = fakeWindows()): Promise<string[]> {
  const messages: string[] = [];
  for (const win of windows) {
    const message = libMisuse(await runInFakePage(expression, win));
    if (message !== undefined) {
      messages.push(message);
    }
  }
  return messages;
}

// Every registered page function, with the call the bridge makes for its registry.
const registered = [
  ...Object.entries(pageFunctions).map(([name, fn]) => ({ name, fn, call: plainCall })),
  ...Object.entries(pageLibFunctions).map(([name, fn]) => ({ name, fn, call: libCall })),
];

test('registers the page functions, so the checks below are not vacuous', () => {
  expect(registered.length).toBeGreaterThan(0);
  expect(Object.keys(pageFunctions)).toContain('readVisibilityState');
  expect(Object.keys(pageFunctions)).toContain('describeElement');
  expect(Object.keys(pageFunctions)).toContain('describeFocusedElement');
  expect(Object.keys(pageFunctions)).toContain('readAppState');
  expect(Object.keys(pageFunctions)).toContain('probeCapabilities');
  expect(Object.keys(pageFunctions)).toContain('readAppInfo');
  expect(Object.keys(pageFunctions)).toContain('readUiState');
  expect(Object.keys(pageFunctions)).toContain('reloadTab');
  expect(Object.keys(pageFunctions)).toContain('createPageLib');
  for (const name of [
    'readChartLayout',
    'readChartState',
    'readChartSnapshot',
    'setSymbolViaApi',
    'setResolutionViaApi',
    'setChartTypeViaApi',
    'readVisibleRange',
    'zoomToTimeRange',
    'scrollToTime',
  ]) {
    expect(Object.keys(pageFunctions)).toContain(name);
  }
  for (const name of [
    'readHistory',
    'requestHistory',
    'readBarRows',
    'readChartQuote',
    'readChartSymbolInfo',
    'searchSymbolsViaApi',
  ]) {
    expect(Object.keys(pageFunctions)).toContain(name);
  }
  expect(Object.keys(pageLibFunctions)).toContain('readCachedQuote');
  expect(Object.keys(pageFunctions)).toContain('readStudies');
  expect(Object.keys(pageFunctions)).toContain('readStudyValues');
  expect(Object.keys(pageLibFunctions)).toContain('readStudyCatalog');
  for (const { name, fn } of registered) {
    expect(typeof fn, name).toBe('function');
  }
  // A function is called one way, so it is in one registry.
  expect(
    Object.keys(pageLibFunctions).filter((name) => Object.hasOwn(pageFunctions, name)),
  ).toEqual([]);
});

test('every page function serializes without bundler helpers or imports', () => {
  for (const { name, fn } of registered) {
    expect(importsIn(fn.toString()), name).toEqual([]);
  }
});

test('every page function stays clear of Node globals', () => {
  for (const { name, fn } of registered) {
    expect(nodeGlobalsIn(fn.toString()), name).toEqual([]);
  }
});

test('every page function compiles as the expression the page bridge sends', () => {
  for (const { name, fn, call } of registered) {
    expect(compileError(call(fn.toString())), name).toBeUndefined();
  }
});

test('every page function runs in an isolated vm context', async () => {
  for (const { name, fn, call } of registered) {
    expect(await referenceErrorsIn(call(fn.toString())), name).toEqual([]);
  }
});

test('no function of the plain registry reads the page library it is not given', async () => {
  for (const [name, fn] of Object.entries(pageFunctions)) {
    expect(await libMisusesIn(plainCall(fn.toString())), name).toEqual([]);
  }
});

// Page functions that break the rules on purpose, to show that each check can fail.
describe('the checks catch what they are meant to', () => {
  function readsImportedConstant(win: TvWindow): number {
    return CDP_ERROR.serverError + win.location.href.length;
  }

  function formatSymbol(symbol: string): string {
    return symbol.toUpperCase();
  }

  function callsModuleHelper(win: TvWindow): string | null {
    const symbol = win.TradingViewApi?.activeChart().symbol();
    return symbol === undefined ? null : formatSymbol(symbol);
  }

  // A lib function in the shape the tools write: it looks a service of the app up, then hands what
  // the service answers to a helper of its module.
  function callsModuleHelperAfterLookup(win: TvWindow, lib: PageLib): string | null {
    const service = lib.findExport('symbolService') as { current?: () => string } | null;
    const symbol = service?.current?.();
    return symbol === undefined ? null : formatSymbol(symbol);
  }

  const withMethod = {
    readHref(win: TvWindow): string {
      return win.location.href;
    },
  };

  test('a reference to an imported binding', async () => {
    const source = readsImportedConstant.toString();

    expect(importsIn(source)).toEqual(['__vite_ssr_']);
    const errors = await referenceErrorsIn(plainCall(source));
    expect(errors).toHaveLength(2);
    expect(
      errors.every((message) => /^__vite_ssr_import_\d+__ is not defined$/.test(message)),
    ).toBe(true);
  });

  test('a call of a helper of the module, which only the run can see', async () => {
    const source = callsModuleHelper.toString();

    expect(importsIn(source)).toEqual([]);
    // Only the booted chart reaches the call.
    expect(await referenceErrorsIn(plainCall(source))).toEqual(['formatSymbol is not defined']);
  });

  test('a call of a helper of the module after a lookup, which only a run with the library can see', async () => {
    const source = callsModuleHelperAfterLookup.toString();
    // Pages whose webpack registry has the service, so that the lookup succeeds and the run goes on.
    const withService = (): object[] =>
      fakeWindows({ webpackModules: { 1: { symbolService: { current: () => 'nasdaq:aapl' } } } });

    expect(importsIn(source)).toEqual([]);
    expect(nodeGlobalsIn(source)).toEqual([]);
    expect(compileError(libCall(source))).toBeUndefined();
    // Both pages reach the call, the one whose app has not booted too: the lookup needs no chart.
    expect(await referenceErrorsIn(libCall(source), withService())).toEqual([
      'formatSymbol is not defined',
      'formatSymbol is not defined',
    ]);
    // Called the plain way, the function gets no library and fails with a TypeError at the lookup.
    // With the library but without the service, the lookup answers null and the run ends early.
    // Neither run reaches the call.
    expect(await referenceErrorsIn(plainCall(source), withService())).toEqual([]);
    expect(await referenceErrorsIn(libCall(source))).toEqual([]);
  });

  test('a lib function registered in the plain registry, which fails at its first lookup', async () => {
    const source = callsModuleHelperAfterLookup.toString();

    // Called the plain way, as the plain registry would have it, it reads a member of undefined.
    const misuses = await libMisusesIn(plainCall(source));
    expect(misuses).toHaveLength(2);
    expect(misuses.every((message) => message.includes('findExport'))).toBe(true);
    // Called with the library, it does not.
    expect(await libMisusesIn(libCall(source))).toEqual([]);
  });

  test('the default fake windows carry the quote cache modules, so a lib function runs past its lookups', async () => {
    function callsModuleHelperAfterQuoteLookup(win: TvWindow, lib: PageLib): string | null {
      const found = ['QUOTE_FIELDS_CACHE', 'getQuoteSessionNoEnsure', 'quoteSessionAdapters'].map(
        (name) => lib.findExport(name),
      );
      return found.includes(null) ? null : formatSymbol('x');
    }
    const source = callsModuleHelperAfterQuoteLookup.toString();

    expect(await referenceErrorsIn(libCall(source))).toEqual([
      'formatSymbol is not defined',
      'formatSymbol is not defined',
    ]);
  });

  test('the default fake windows carry the plan feature modules, so a lib function runs past its lookups', async () => {
    // Looks the two plan modules up the way the tools do, then calls a helper of its module.
    function callsModuleHelperAfterPlanLookup(win: TvWindow, lib: PageLib): string | null {
      const features = lib.findExport('ProductFeatures');
      const config = lib.findModuleWith(['getConfig', 'getProductFeaturesConfig']);
      return features === null || config === null ? null : formatSymbol('x');
    }
    const source = callsModuleHelperAfterPlanLookup.toString();

    expect(await referenceErrorsIn(libCall(source))).toEqual([
      'formatSymbol is not defined',
      'formatSymbol is not defined',
    ]);
    // A window built without the modules stops at the lookup.
    expect(await referenceErrorsIn(libCall(source), fakeWindows({ webpackModules: {} }))).toEqual(
      [],
    );
  });

  test('method shorthand, whose source is not an expression', () => {
    expect(compileError(plainCall(withMethod.readHref.toString()))).toMatch(/^Unexpected token/);
  });

  test('bundler helpers, imports and Node globals in a source text', () => {
    expect(importsIn('function f(win) { return __async(this, null, function* () {}); }')).toEqual([
      '__async',
    ]);
    expect(importsIn('async (win) => (await import("./x.js")).y')).toEqual(['import(']);
    expect(importsIn('(win) => require ("fs")')).toEqual(['require (']);
    expect(importsIn('(win) => ({ ...__spreadValues({}, win) })')).toEqual(['__spreadValues']);
    expect(
      nodeGlobalsIn('(win) => process.env.HOME + globalThis.Buffer.from(typeof module)'),
    ).toEqual(['process', 'Buffer', 'module']);
    expect(nodeGlobalsIn('(win) => win.processing + win.modules')).toEqual([]);
  });

  test('a page function that never settles is reported as pending, not as an error', async () => {
    const neverSettles = (win: TvWindow): Promise<null> =>
      new Promise(() => {
        win.TVD?.reloadTab();
      });

    const outcome = await runInFakePage(plainCall(neverSettles.toString()), fakeWindows()[0] ?? {});

    expect(outcome).toEqual({ kind: 'pending' });
  });

  test('a page function that leaves a timer running has it cancelled', async () => {
    const win = createFakeTvWindow(loadTvFixture());
    const keepsReloading = (pageWindow: TvWindow): null => {
      setInterval(() => {
        pageWindow.TVD?.reloadTab();
      }, 5);
      return null;
    };

    await runInFakePage(plainCall(keepsReloading.toString()), win);
    await delay(40);

    expect(inspectFakeWindow(win).callsTo('TVD.reloadTab')).toEqual([]);
  });
});
