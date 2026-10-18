import { setTimeout as delay } from 'node:timers/promises';
import vm from 'node:vm';
import { pageFunctions } from '../../../../src/core/tv/page-functions.js';
import type { TvWindow } from '../../../../src/core/tv/tv-window.js';
import { CDP_ERROR } from '../../../helpers/fake-cdp/protocol.js';
import { createPageContext } from '../../../helpers/fake-cdp/runtime.js';
import { loadTvFixture } from '../../../helpers/fake-tv/fixture.js';
import { createFakeTvWindow, inspectFakeWindow } from '../../../helpers/fake-tv/window.js';

// The page bridge sends a page function as its source text, so a page function must not depend on
// anything of its module. These checks look at every registered page function the way the bridge
// sees it: its Function.prototype.toString text, run in a page that is a fake window.

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

// What the bridge sends for a call without arguments. The guard knows no argument values, so a
// page function runs with only its window, as far as that takes it.
function pageCall(source: string): string {
  return `(${source})(window, ...[])`;
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

// Why the expression the bridge sends for a source does not compile, if it does not.
function compileError(source: string): string | undefined {
  try {
    new vm.Script(pageCall(source));
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function runInFakePage(source: string, win: object): Promise<Outcome> {
  const page = createPageContext(win);
  try {
    const value = page.run(pageCall(source));
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

function fakeWindows(): object[] {
  const fixture = loadTvFixture();
  // A booted chart, and a tab whose app has not booted, so both kinds of paths get to run.
  return [createFakeTvWindow(fixture), createFakeTvWindow(fixture, { withoutApi: true })];
}

// The ReferenceErrors a source runs into in the fake pages.
async function referenceErrorsIn(source: string): Promise<string[]> {
  const messages: string[] = [];
  for (const win of fakeWindows()) {
    const message = referenceError(await runInFakePage(source, win));
    if (message !== undefined) {
      messages.push(message);
    }
  }
  return messages;
}

const registered = Object.entries(pageFunctions);

test('registers the page functions, so the checks below are not vacuous', () => {
  expect(registered.length).toBeGreaterThan(0);
  expect(Object.keys(pageFunctions)).toContain('readVisibilityState');
  expect(Object.keys(pageFunctions)).toContain('describeElement');
  for (const [name, fn] of registered) {
    expect(typeof fn, name).toBe('function');
  }
});

test('every page function serializes without bundler helpers or imports', () => {
  for (const [name, fn] of registered) {
    expect(importsIn(fn.toString()), name).toEqual([]);
  }
});

test('every page function stays clear of Node globals', () => {
  for (const [name, fn] of registered) {
    expect(nodeGlobalsIn(fn.toString()), name).toEqual([]);
  }
});

test('every page function compiles as the expression the page bridge sends', () => {
  for (const [name, fn] of registered) {
    expect(compileError(fn.toString()), name).toBeUndefined();
  }
});

test('every page function runs in an isolated vm context', async () => {
  for (const [name, fn] of registered) {
    expect(await referenceErrorsIn(fn.toString()), name).toEqual([]);
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

  const withMethod = {
    readHref(win: TvWindow): string {
      return win.location.href;
    },
  };

  test('a reference to an imported binding', async () => {
    const source = readsImportedConstant.toString();

    expect(importsIn(source)).toEqual(['__vite_ssr_']);
    const errors = await referenceErrorsIn(source);
    expect(errors).toHaveLength(2);
    expect(
      errors.every((message) => /^__vite_ssr_import_\d+__ is not defined$/.test(message)),
    ).toBe(true);
  });

  test('a call of a helper of the module, which only the run can see', async () => {
    const source = callsModuleHelper.toString();

    expect(importsIn(source)).toEqual([]);
    // Only the booted chart reaches the call.
    expect(await referenceErrorsIn(source)).toEqual(['formatSymbol is not defined']);
  });

  test('method shorthand, whose source is not an expression', () => {
    expect(compileError(withMethod.readHref.toString())).toMatch(/^Unexpected token/);
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

    const outcome = await runInFakePage(neverSettles.toString(), fakeWindows()[0] ?? {});

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

    await runInFakePage(keepsReloading.toString(), win);
    await delay(40);

    expect(inspectFakeWindow(win).callsTo('TVD.reloadTab')).toEqual([]);
  });
});
