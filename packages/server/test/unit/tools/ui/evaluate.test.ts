import type { CdpSession } from '../../../../src/core/cdp/types.js';
import { createPageBridge, type PageBridge } from '../../../../src/core/tv/page-bridge.js';
import type { TvWindow } from '../../../../src/core/tv/tv-window.js';
import {
  deniedSurface,
  EVAL_DENIED_NAMES,
  EVAL_DENYLIST,
  EVAL_MAX_RESULT_BYTES,
  EVAL_WITHHELD_GLOBALS,
} from '../../../../src/tools/ui/evaluate.js';
import { TvMcpError } from '../../../../src/core/errors.js';
import type { ToolContext } from '../../../../src/tools/types.js';
import { uiEvaluate } from '../../../../src/tools/ui/evaluate.js';
import { evaluateExpression } from '../../../../src/tools/ui/page.js';
import type { JsonValue } from '../../../../src/utils/json.js';
import { failureOf } from '../../../helpers/failure-of.js';
import { createPageContext, createPageRuntime } from '../../../helpers/fake-cdp/runtime.js';
import { createFakeDomWindow, fakeElement } from '../../../helpers/fake-tv/dom.js';

// The denylist of ui_evaluate, which reads the text of an expression before anything is sent, and
// the page function that runs the expression in the chart tab and hands back its value as JSON. The
// page function runs the way the server runs it, as source text through the real page bridge, and
// directly, which is what the coverage of the module measures; the two answers must agree.

describe('EVAL_DENYLIST', () => {
  test('is frozen, and every pattern ignores case but the one that reads the capitals of a name', () => {
    expect(Object.isFrozen(EVAL_DENYLIST)).toBe(true);
    expect(EVAL_DENYLIST.length).toBeGreaterThan(0);
    const caseSensitive = EVAL_DENYLIST.filter(({ flags }) => !flags.includes('i'));
    // signIn inside a camelCase name, such as showSignInDialog, is told by its capital S.
    expect(caseSensitive.map(({ source }) => source)).toEqual(['Sign_?[Ii]n']);
    expect(Object.isFrozen(EVAL_DENIED_NAMES)).toBe(true);
  });

  // Forms that hide a denied name from a plain reading of the text.
  test.each([
    ['tvd', "window['\\u{00000054}VD']"],
    ['tvd', 'window["T\\\r\nVD"]'],
    ['tvd', 'window["T\\\rVD"]'],
    ['tvd', 'window["T\\\nVD"]'],
    ['tvd', 'window["T\\\u2028VD"]'],
    ['tvd', 'window["T\\\u2029VD"]'],
    ['tvd', "window['T'.concat('VD')]"],
    ['tvd', "window['T' . concat ('VD')]"],
    ['cookies', 'document["coo".concat("kie")]'],
    ['storage', "window['indexed'.concat('DB')]"],
    ['storage', 'window[`${"local"}${"Storage"}`]'],
    ['credentials', "bridge['get'.concat('Credentials')]()"],
    ['credentials', 'showSignInDialog()'],
    ['credentials', 'openSigninForm()'],
    ['network', 'import.meta'],
    ['network', 'import'],
  ])('refuses %s hidden in %j', (category, expression) => {
    expect(deniedSurface(expression)?.category).toBe(category);
  });

  // One case of every entry, and the forms that hide it: spacing, bracket access, quotes, strings
  // joined with +, comments between them, and escapes.
  test.each([
    ['tvd', 'TVD'],
    ['tvd', 'TVD.getCredentials()'],
    ['tvd', 'window . TVD . reloadTab()'],
    ['tvd', "window['TVD']"],
    ['tvd', 'window[ "TVD" ]'],
    ['tvd', 'window[`TVD`]'],
    ['tvd', "window['T' + 'VD']"],
    ['tvd', 'window["T" /* a gap */ + "VD"]'],
    ['tvd', "window['\\x54VD']"],
    ['tvd', "window['\\u0054VD']"],
    ['tvd', "window['\\u{54}VD']"],
    ['tvd', "window['\\124VD']"],
    ['tvd', 'window.\\u0054VD'],
    ['tvd', 'self.tvd'],
    ['tvd', 'window.__TVD__'],
    ['identity', 'user'],
    ['identity', 'window.user'],
    ['identity', "window['user']"],
    ['identity', 'window [ "user" ]'],
    ['identity', 'globalThis.user.id'],
    ['identity', 'this.user'],
    ['identity', "window['us' + 'er']"],
    ['identity', 'window.__user'],
    ['identity', 'data.user_id'],
    ['identity', 'userId'],
    ['identity', 'username'],
    ['identity', 'profile.userName'],
    ['identity', 'session_id'],
    ['identity', 'sessionId'],
    ['cookies', 'document.cookie'],
    ['cookies', "document['cookie']"],
    ['cookies', 'document [ "coo" + "kie" ]'],
    ['cookies', 'cookieStore.getAll()'],
    ['cookies', 'document.COOKIE'],
    ['storage', 'localStorage.getItem("key")'],
    ['storage', "window['localStorage']"],
    ['storage', "window['local' + 'Storage']"],
    ['storage', 'sessionStorage.length'],
    ['storage', 'indexedDB.databases()'],
    ['storage', 'TVLocalStorage.getItem("key")'],
    ['credentials', 'getCredentials()'],
    ['credentials', 'bridge.setCredentials(1)'],
    ['credentials', 'insertCredentialsText("a")'],
    ['credentials', 'signIn()'],
    ['credentials', 'sign_in'],
    ['credentials', 'form.password.value'],
    ['credentials', "form['pass' + 'word']"],
    ['credentials', 'accessToken'],
    ['credentials', 'headers.Authorization'],
    ['credentials', 'is_authenticated'],
    ['credentials', 'oauth'],
    ['network', 'fetch("/x")'],
    ['network', "window['fetch']('/x')"],
    ['network', 'new XMLHttpRequest()'],
    ['network', 'new WebSocket("wss://x")'],
    ['network', 'new EventSource("/x")'],
    ['network', 'navigator.sendBeacon("/x", "y")'],
    ['network', 'import("./x.js")'],
    ['network', 'import ( "x" )'],
    ['node', 'require("fs")'],
    ['node', "window['require']"],
    ['node', 'process.env'],
    ['node', "globalThis['process']"],
    ['node', 'child_process'],
    ['node', 'electron'],
  ])('refuses %s in %s', (category, expression) => {
    expect(deniedSurface(expression)?.category).toBe(category);
  });

  test.each([
    '1 + 1',
    'TradingViewApi.activeChart().symbol()',
    'document.title',
    // userAgent is no user, and the other words merely hold a denied one.
    'navigator.userAgent',
    'document.querySelectorAll("button").length',
    'Object.keys(TradingViewApi)',
    'script.author',
    'assignInputs()',
    'prefetchData',
    'window.users',
    'reprocess()',
    'requirement',
    'importance',
    // An escape past the last code point stands for nothing.
    "'\\u{110000}'",
  ])('lets %s through', (expression) => {
    expect(deniedSurface(expression)).toBeNull();
  });

  test('says which surface is denied, in words, and never quotes the expression', () => {
    const denied = deniedSurface('document.cookie');

    expect(denied).toEqual({ category: 'cookies', surface: expect.any(String) as string });
    expect(denied?.surface).toMatch(/cookie/);
    expect(denied?.surface).not.toContain('document.cookie');
  });
});

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
    // The protocol typings of send are generic over every CDP method; this fake answers one.
    send: send as CdpSession['send'],
    onClose: () => undefined,
    close: () => Promise.resolve(),
  };
  return createPageBridge(session, { timeoutMs: 5000 });
}

// A chart tab with a DOM, and what a test adds to its globals. Its eval runs code in the page,
// which is the vm context of the window, so that a direct call of the page function, which reads
// win.eval, runs the expression where the bridge runs it.
function chartTab(globals: Record<string, unknown> = {}): TvWindow {
  // What Object.prototype.toString names a button of a page by, which the fake element does not
  // give itself.
  const save = fakeElement({ tag: 'button', id: 'save', matches: ['#save'], text: 'Save' });
  Object.defineProperty(save, Symbol.toStringTag, { value: 'HTMLButtonElement' });
  const win = Object.assign(createFakeDomWindow([save]), globals);
  const page = createPageContext(win);
  disposers.push(() => {
    page.dispose();
  });
  return Object.assign(win, { eval: (code: string) => page.run(code) });
}

const WITHHELD = [...EVAL_WITHHELD_GLOBALS];

// The page function run both ways, on two tabs made alike: the answers must agree.
async function bothWays(
  expression: string,
  maxBytes: number = EVAL_MAX_RESULT_BYTES,
  globals: () => Record<string, unknown> = () => ({}),
): Promise<{ value: JsonValue; truncated: boolean }> {
  const viaPage = await bridgeTo(chartTab(globals())).evaluate(evaluateExpression, [
    expression,
    maxBytes,
    WITHHELD,
  ]);
  expect(await evaluateExpression(chartTab(globals()), expression, maxBytes, WITHHELD)).toEqual(
    viaPage,
  );
  return viaPage;
}

describe('evaluateExpression', () => {
  test('returns plain values as they are, and undefined as null', async () => {
    expect(await bothWays('1 + 1')).toEqual({ value: 2, truncated: false });
    expect(await bothWays('"text"')).toEqual({ value: 'text', truncated: false });
    expect(await bothWays('true')).toEqual({ value: true, truncated: false });
    expect(await bothWays('null')).toEqual({ value: null, truncated: false });
    expect(await bothWays('false')).toEqual({ value: false, truncated: false });
    expect(await bothWays('undefined')).toEqual({ value: null, truncated: false });
    expect(await bothWays('')).toEqual({ value: null, truncated: false });
  });

  test('runs statements and answers the value of the last, in the global scope of the page', async () => {
    expect(await bothWays('var counted = 2; counted * 21')).toEqual({
      value: 42,
      truncated: false,
    });
    expect(await bothWays('document.visibilityState')).toEqual({
      value: 'visible',
      truncated: false,
    });
  });

  test('turns the values JSON cannot carry into ones it can', async () => {
    const { value } = await bothWays(
      '({ missing: undefined, list: [undefined, NaN, Infinity, -0, 1.5], big: 10n ** 20n, tag: Symbol("tag") })',
    );

    expect(value).toEqual({
      missing: null,
      list: [null, null, null, 0, 1.5],
      big: '100000000000000000000',
      tag: 'Symbol(tag)',
    });
  });

  test('names a function, a DOM node and the window by their type', async () => {
    const { value } = await bothWays(
      '[function () {}, async () => {}, Math.max, document.querySelector("#save"), window, self, globalThis]',
    );

    expect(value).toEqual([
      '[object Function]',
      '[object AsyncFunction]',
      '[object Function]',
      '[object HTMLButtonElement]',
      '[object Window]',
      '[object Window]',
      '[object Window]',
    ]);
  });

  test('writes dates, patterns, errors, maps and sets as JSON', async () => {
    const { value } = await bothWays(
      '[new Date(0), new Date(NaN), /a+/gi, new TypeError("bad"), new Map([["a", 1], [2, undefined]]), new Set([1, "b"]), [Promise.resolve(1)]]',
    );

    expect(value).toEqual([
      '1970-01-01T00:00:00.000Z',
      null,
      '/a+/gi',
      'TypeError: bad',
      [
        ['a', 1],
        [2, null],
      ],
      [1, 'b'],
      ['[object Promise]'],
    ]);
  });

  test('marks what cycles back, keeps what is merely shared, and names what cannot be read', async () => {
    const cycle = await bothWays('const node = { n: 1 }; node.self = node; node');
    const shared = await bothWays('const one = [1]; [one, one]');
    const unreadable = await bothWays('({ get bad() { throw new Error("no"); }, ok: 1 })');

    expect(cycle.value).toEqual({ n: 1, self: '[circular]' });
    expect(shared.value).toEqual([[1], [1]]);
    expect(unreadable.value).toEqual({ bad: '[unreadable]', ok: 1 });
  });

  test('writes a typed array as its values, and names what cannot be listed or read', async () => {
    const typed = await bothWays('new Uint8Array([1, 2, 3])');
    const proxy = await bothWays(
      'new Proxy({}, { get() { throw new Error("no"); }, ownKeys() { throw new Error("no"); } })',
    );
    const odd = await bothWays(
      '({ get window() { throw new Error("no"); }, get nodeType() { throw new Error("no"); }, a: 1 })',
    );

    expect(typed.value).toEqual([1, 2, 3]);
    expect(proxy.value).toBe('[unreadable]');
    expect(odd.value).toEqual({ window: '[unreadable]', nodeType: '[unreadable]', a: 1 });
  });

  test('names what forges the type of a date, a map, a set or a pattern, and a revoked proxy, as unreadable', async () => {
    const { value, truncated } = await bothWays(
      '[' +
        '{ [Symbol.toStringTag]: "Date" }, ' +
        '{ [Symbol.toStringTag]: "Map" }, ' +
        '{ [Symbol.toStringTag]: "Set" }, ' +
        '{ [Symbol.toStringTag]: "RegExp", get source() { throw new Error("no"); } }, ' +
        '(() => { const { proxy, revoke } = Proxy.revocable({}, {}); revoke(); return proxy; })(), ' +
        '1]',
    );

    expect(value).toEqual([
      '[unreadable]',
      '[unreadable]',
      '[unreadable]',
      '[unreadable]',
      '[unreadable]',
      1,
    ]);
    expect(truncated).toBe(false);
    // As the whole value too, where nothing around it would catch what it throws.
    expect(await bothWays('({ [Symbol.toStringTag]: "Map" })')).toEqual({
      value: '[unreadable]',
      truncated: false,
    });
  });

  test('counts control characters and lone halves of pairs as their escapes', async () => {
    // A control character, a line break, a lone high half, a lone low half, and a character past
    // the halves of pairs, which takes three bytes.
    const text = '\\u0001\\n\\uD800x\\uDC00\\uFF01';

    const whole = await bothWays(`'${text}'`);
    const cut = await bothWays("'\\u0001'.repeat(3)", 14);

    expect(whole).toEqual({ value: '\u0001\n\uD800x\uDC00\uFF01', truncated: false });
    // Each control character takes the six of its escape.
    expect(cut).toEqual({ value: '\u0001\u0001', truncated: true });
  });

  test('stops where not even the start of the next part fits', async () => {
    expect(await bothWays("[1, 'ab']", 4)).toEqual({ value: [1], truncated: true });
    expect(await bothWays('[[1]]', 3)).toEqual({ value: [], truncated: true });
    expect(await bothWays('[1, 2]', 3)).toEqual({ value: [1], truncated: true });
    expect(await bothWays('({ a: true })', 7)).toEqual({ value: {}, truncated: true });
  });

  test('keeps a key named __proto__ as a key', async () => {
    const { value } = await bothWays('JSON.parse(\'{"__proto__": 1, "a": 2}\')');

    expect(Object.keys(value as object)).toEqual(['__proto__', 'a']);
  });

  test('awaits a promise, and only a promise', async () => {
    expect(await bothWays('Promise.resolve({ a: 1 })')).toEqual({
      value: { a: 1 },
      truncated: false,
    });
    // An object with a then is a value like any other, as Runtime.evaluate takes it.
    expect(await bothWays('({ then() {}, n: 1 })')).toEqual({
      value: { then: '[object Function]', n: 1 },
      truncated: false,
    });
  });

  test('never walks the user object, the desktop bridge or the storage of the page', async () => {
    const globals = () => ({
      user: { id: 101, username: 'synthetic-user' },
      TVD: { getCredentials: () => 'synthetic-secret' },
      localStorage: { synthetic: 'stored' },
    });

    const { value } = await bothWays(
      '[window.user, [{ held: window.TVD }], window.localStorage, { ...window.user }.id]',
      EVAL_MAX_RESULT_BYTES,
      globals,
    );

    // A copy is a new object, which nothing can tell from any other: the denylist is what stops it.
    expect(value).toEqual(['[withheld]', [{ held: '[withheld]' }], '[withheld]', 101]);
  });

  test('cuts a long string to fit, without splitting a character, and says so', async () => {
    const ascii = await bothWays("'x'.repeat(1000)", 100);
    const accents = await bothWays("'é'.repeat(100)", 50);
    const emoji = await bothWays("'😀'.repeat(10)", 11);
    const exact = await bothWays("'abc'", 5);

    expect(ascii).toEqual({ value: 'x'.repeat(98), truncated: true });
    expect(accents).toEqual({ value: 'é'.repeat(24), truncated: true });
    // An emoji takes four bytes, and two of them fit in the nine left besides the quotes.
    expect(emoji).toEqual({ value: '😀😀', truncated: true });
    expect(exact).toEqual({ value: 'abc', truncated: false });
  });

  test('counts escapes in what a string takes up', async () => {
    const { value, truncated } = await bothWays("'\"\\\\'.repeat(10)", 12);

    // A quote and a backslash take two characters each in JSON.
    expect(value).toBe('"\\"\\"');
    expect(truncated).toBe(true);
    expect(JSON.stringify(value).length).toBeLessThanOrEqual(12);
  });

  test('cuts a long list and a large object to fit', async () => {
    const list = await bothWays('Array.from({ length: 1000 }, (_, i) => i + 1)', 50);
    const object = await bothWays(
      'Object.fromEntries(Array.from({ length: 100 }, (_, i) => ["key" + i, i]))',
      60,
    );

    expect(list.truncated).toBe(true);
    expect(list.value).toEqual(Array.from({ length: 19 }, (_, index) => index + 1));
    expect(JSON.stringify(list.value).length).toBeLessThanOrEqual(50);
    expect(object.truncated).toBe(true);
    expect(JSON.stringify(object.value).length).toBeLessThanOrEqual(60);
    expect(Object.keys(object.value as object)[0]).toBe('key0');
  });

  test('stops at 32 levels and names what lies deeper', async () => {
    const { value, truncated } = await bothWays(
      'Array.from({ length: 40 }).reduce((inner) => [inner], 0)',
    );

    let depth = 0;
    let level: JsonValue = value;
    while (Array.isArray(level)) {
      depth += 1;
      level = level[0] ?? null;
    }
    expect(truncated).toBe(true);
    expect(depth).toBe(32);
    expect(level).toBe('[object Array]');
  });

  test('takes 100 kB when it is given no usable size', async () => {
    const win = chartTab();

    expect(await evaluateExpression(win, "'a'.repeat(200000)", Number.NaN, WITHHELD)).toEqual({
      value: 'a'.repeat(EVAL_MAX_RESULT_BYTES - 2),
      truncated: true,
    });
  });

  test.each([
    ['throw new Error("boom")', 'The expression threw Error: boom'],
    ['throw "plain"', 'The expression threw plain'],
    ['Promise.reject(new TypeError("later"))', 'The expression threw TypeError: later'],
    ['throw Object.create(null)', 'The expression threw a value that cannot be shown'],
    [`throw new Error("${'x'.repeat(600)}")`, `The expression threw Error: ${'x'.repeat(493)}…`],
    [
      `throw new Error("${'x'.repeat(492)}${'😀'.repeat(10)}")`,
      `The expression threw Error: ${'x'.repeat(492)}…`,
    ],
    ['throw null', 'The expression threw null'],
    ['throw { message: "plain object" }', 'The expression threw Error: plain object'],
    [
      'throw Object.assign(new Error("nameless"), { name: "" })',
      'The expression threw Error: nameless',
    ],
  ])('reports %s as PAGE_EVALUATION_FAILED without a stack', async (expression, message) => {
    const viaPage = await failureOf(
      bridgeTo(chartTab()).evaluate(evaluateExpression, [expression, 1000, WITHHELD]),
    );

    expect(viaPage.toPayload()).toEqual({
      code: 'PAGE_EVALUATION_FAILED',
      message,
      hint: expect.stringMatching(/expression/) as string,
    });
    expect(await evaluateExpression(chartTab(), expression, 1000, WITHHELD)).toEqual({
      __tvmcpError: viaPage.toPayload(),
    });
  });

  test('reports an expression that is no JavaScript as the SyntaxError it is', async () => {
    const error = await failureOf(
      bridgeTo(chartTab()).evaluate(evaluateExpression, ['let = ;', 1000, WITHHELD]),
    );

    expect(error.message).toMatch(/^The expression threw SyntaxError: /);
  });

  test('says CAPABILITY_UNAVAILABLE on a page without eval', async () => {
    const win = createFakeDomWindow([]);

    expect(await evaluateExpression(win, '1', 1000, WITHHELD)).toMatchObject({
      __tvmcpError: { code: 'CAPABILITY_UNAVAILABLE' },
    });
  });
});

describe('ui_evaluate on a failure of the page', () => {
  // A context whose chart page fails every evaluation with `error`.
  const failingWith = (error: TvMcpError): ToolContext =>
    ({
      config: { allowEval: true, callTimeoutMs: 5000 },
      connection: {
        chartPage: () => Promise.resolve({ bridge: { evaluate: () => Promise.reject(error) } }),
      },
    }) as unknown as ToolContext;

  test('adds why to a failure without a hint, with its details or without any', async () => {
    const bare = await failureOf(
      uiEvaluate.handler(
        { expression: 'while (true) {}' },
        failingWith(new TvMcpError('PAGE_EVALUATION_FAILED', 'Execution was terminated')),
      ),
    );
    const detailed = await failureOf(
      uiEvaluate.handler(
        { expression: 'while (true) {}' },
        failingWith(
          new TvMcpError('PAGE_EVALUATION_FAILED', 'Execution was terminated', {
            details: { method: 'Runtime.evaluate' },
          }),
        ),
      ),
    );

    expect(bare.toPayload()).toEqual({
      code: 'PAGE_EVALUATION_FAILED',
      message: 'Execution was terminated',
      hint: expect.stringMatching(/after 4000 ms/) as string,
    });
    expect(detailed.toPayload()).toMatchObject({ details: { method: 'Runtime.evaluate' } });
  });

  test('passes on a failure that has a hint, or of another code, as it is', async () => {
    const threw = new TvMcpError('PAGE_EVALUATION_FAILED', 'The expression threw x', {
      hint: 'Check it.',
    });
    const timeout = new TvMcpError('TIMEOUT', 'CDP Runtime.evaluate timed out');

    await expect(uiEvaluate.handler({ expression: 'x' }, failingWith(threw))).rejects.toBe(threw);
    await expect(uiEvaluate.handler({ expression: 'x' }, failingWith(timeout))).rejects.toBe(
      timeout,
    );
  });
});
