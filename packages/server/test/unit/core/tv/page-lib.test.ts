import type { CdpSession } from '../../../../src/core/cdp/types.js';
import { createPageBridge, type PageBridge } from '../../../../src/core/tv/page-bridge.js';
import { createPageLib, type PageLib } from '../../../../src/core/tv/page-lib.js';
import type { TvWindow } from '../../../../src/core/tv/tv-window.js';
import { createPageRuntime } from '../../../helpers/fake-cdp/runtime.js';
import { loadTvFixture } from '../../../helpers/fake-tv/fixture.js';
import {
  createFakeWebpack,
  type FakeModuleFactory,
  type FakeWebpackRequire,
} from '../../../helpers/fake-tv/webpack.js';
import { createFakeTvWindow } from '../../../helpers/fake-tv/window.js';

// The page library is called directly, which is what the coverage of the module measures, and run
// the way the server runs it, as source text in a page through evaluateWithLib, where a library
// that leans on anything of its module would fail. Modules and their exports are synthetic.

const fixture = loadTvFixture();

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
  vi.restoreAllMocks();
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
  return createPageBridge(session, { timeoutMs: 1000 });
}

// A page with nothing but this chunk list, for lists the fake window does not model.
function pageWith(chunks: unknown): TvWindow {
  return { webpackChunktradingview: chunks } as unknown as TvWindow;
}

// A chunk list whose push hands `handed` to the callback of the chunk, as a runtime would hand its
// require over.
function listHanding(handed: unknown): unknown[] {
  return Object.assign([], {
    push(chunk: unknown): number {
      (chunk as [unknown, unknown, (given: unknown) => void])[2](handed);
      return 0;
    },
  });
}

// The exports object of an ES module, as webpack builds it: every export is a getter.
function esModule(getters: Record<string, () => unknown>): Record<string, unknown> {
  const exports = {};
  for (const [name, get] of Object.entries(getters)) {
    Object.defineProperty(exports, name, { enumerable: true, get });
  }
  return exports;
}

// The require of a fake runtime, the way the app's own code holds it.
function appRequireOf(chunks: unknown[]): FakeWebpackRequire {
  let handed: FakeWebpackRequire | undefined;
  chunks.push([['app'], {}, (given: FakeWebpackRequire) => (handed = given)]);
  if (handed === undefined) {
    throw new Error('The chunk list handed no require over');
  }
  return handed;
}

// Looks each name up, the way the page functions of the tools use the library, and says what it
// found: the type of the export, or null.
function describeExports(win: TvWindow, lib: PageLib, names: string[]): (string | null)[] {
  return names.map((name) => {
    const value = lib.findExport(name);
    return value === null ? null : typeof value;
  });
}

test("findExport returns a cached module's own export", () => {
  const studyMetaInfoRepository = (): string[] => ['Volume'];
  const lib = createPageLib(pageWith(createFakeWebpack({ a: { studyMetaInfoRepository } })));

  expect(lib.findExport('studyMetaInfoRepository')).toBe(studyMetaInfoRepository);
});

test('findExport reads an export through its getter, from the first module that has it', () => {
  const first = { open: () => 'first' };
  const lib = createPageLib(
    pageWith(
      createFakeWebpack({
        a: { unrelated: 1 },
        b: esModule({ getOpenPineEditor: () => first }),
        c: { getOpenPineEditor: { open: () => 'second' } },
      }),
    ),
  );

  expect(lib.findExport('getOpenPineEditor')).toBe(first);
});

test('findExport ignores inherited names and uncached modules', () => {
  const factory = vi.fn<FakeModuleFactory>((record) => {
    record.exports = { onlyInFactory: () => 'loaded' };
  });
  const lib = createPageLib(
    pageWith(
      createFakeWebpack(
        { a: Object.create({ inherited: () => 'from the prototype' }) as Record<string, unknown> },
        { factories: { b: factory } },
      ),
    ),
  );

  expect(lib.findExport('toString')).toBeNull();
  expect(lib.findExport('inherited')).toBeNull();
  expect(lib.findExport('onlyInFactory')).toBeNull();
  expect(lib.findModuleWith(['onlyInFactory'])).toBeNull();
  expect(factory).not.toHaveBeenCalled();
});

test('findModuleWith requires every name on one module', () => {
  const features = { getConfig: () => 0, getProductFeaturesConfig: () => 0, enabled: true };
  const modules = {
    a: { getConfig: () => 'another config' },
    b: { getProductFeaturesConfig: () => 0 },
    c: features,
  };
  const lib = createPageLib(pageWith(createFakeWebpack(modules)));

  expect(lib.findModuleWith(['getConfig', 'getProductFeaturesConfig'])).toBe(features);
  expect(lib.findModuleWith(['getConfig'])).toBe(modules.a);
  expect(lib.findModuleWith(['getConfig', 'canUpgradePlan'])).toBeNull();
  expect(lib.findModuleWith(['toString'])).toBeNull();
  // No name picks out no module.
  expect(lib.findModuleWith([])).toBeNull();
});

test('findModuleWith checks names without reading the exports', () => {
  const read = vi.fn(() => {
    throw new ReferenceError("Cannot access 'n' before initialization");
  });
  const exports = esModule({ getConfig: read, getProductFeaturesConfig: read });
  const lib = createPageLib(pageWith(createFakeWebpack({ a: exports })));

  expect(lib.findModuleWith(['getConfig', 'getProductFeaturesConfig'])).toBe(exports);
  expect(read).not.toHaveBeenCalled();
});

test('the library obtains require once per evaluate', async () => {
  const modules = {
    a: { studyMetaInfoRepository: () => [] },
    b: { getConfig: () => 0, getProductFeaturesConfig: () => 0 },
  };
  const names = ['studyMetaInfoRepository', 'getConfig', 'missing'];

  // Called directly: one push, at the first lookup, however many lookups follow.
  const chunks = createFakeWebpack(modules);
  const lib = createPageLib(pageWith(chunks));
  expect(chunks).toHaveLength(0);
  const direct = describeExports(pageWith(chunks), lib, names);
  expect(lib.findModuleWith(['getConfig', 'getProductFeaturesConfig'])).toBe(modules.b);
  expect(chunks).toHaveLength(1);

  // Run in a page: one push per evaluateWithLib call.
  const win = createFakeTvWindow(fixture, { webpackModules: modules });
  const bridge = bridgeTo(win);
  await expect(bridge.evaluateWithLib(describeExports, [names])).resolves.toEqual(direct);
  await expect(bridge.evaluateWithLib(describeExports, [['getConfig']])).resolves.toEqual([
    'function',
  ]);
  expect(direct).toEqual(['function', 'function', null]);
  expect(win.webpackChunktradingview).toHaveLength(2);
});

test('the library pushes nothing when it looks nothing up', async () => {
  const chunks = createFakeWebpack({ a: { getConfig: () => 0 } });
  createPageLib(pageWith(chunks));
  const win = createFakeTvWindow(fixture, { webpackModules: { a: { getConfig: () => 0 } } });

  await expect(bridgeTo(win).evaluateWithLib(describeExports, [[]])).resolves.toEqual([]);

  expect(chunks).toHaveLength(0);
  expect(win.webpackChunktradingview).toHaveLength(0);
});

test('each push registers one inert chunk ID, unique within a millisecond', () => {
  vi.spyOn(Date, 'now').mockReturnValue(1_767_225_600_000);
  const studyMetaInfoRepository = (): string[] => [];
  const chunks = createFakeWebpack({ a: { studyMetaInfoRepository } });

  const first = createPageLib(pageWith(chunks)).findExport('studyMetaInfoRepository');
  const second = createPageLib(pageWith(chunks)).findExport('studyMetaInfoRepository');

  // The runtime calls back only for a chunk ID it has not seen, so both IDs must be new to it.
  expect([first, second]).toEqual([studyMetaInfoRepository, studyMetaInfoRepository]);
  const chunk = [
    [expect.stringMatching(/^tvmcp_1767225600000_[a-z0-9]+$/)],
    {},
    expect.any(Function),
  ];
  expect([...chunks]).toEqual([chunk, chunk]);
  const [one, two] = chunks as [[string[]], [string[]]];
  expect(one[0]).not.toEqual(two[0]);
});

test('createPageLib returns a library whose lookups return null without a chunk array', () => {
  for (const win of [pageWith(undefined), pageWith(null), createFakeTvWindow(fixture)]) {
    const lib = createPageLib(win);

    expect(lib.findExport('getConfig')).toBeNull();
    expect(lib.findModuleWith(['getConfig'])).toBeNull();
  }
});

test.each<[string, () => TvWindow]>([
  ['a plain list, as before the webpack runtime has loaded', () => pageWith([])],
  ['a chunk list that is not a list', () => pageWith({ length: 0 })],
  [
    'a chunk list whose push throws',
    () =>
      pageWith(
        Object.assign([], {
          push: () => {
            throw new TypeError('The runtime failed');
          },
        }),
      ),
  ],
  [
    'a chunk list that throws when it is read',
    () =>
      Object.defineProperty({}, 'webpackChunktradingview', {
        get: () => {
          throw new Error('Not yet');
        },
      }) as TvWindow,
  ],
  ['a runtime that hands nothing over', () => pageWith(listHanding(undefined))],
  ['a require without a module cache', () => pageWith(listHanding(() => undefined))],
  ['a module cache that is not an object', () => pageWith(listHanding({ c: 'cache' }))],
  [
    'a module cache that cannot be listed',
    () =>
      pageWith(
        listHanding({
          c: new Proxy(
            {},
            {
              ownKeys: () => {
                throw new Error('Revoked');
              },
            },
          ),
        }),
      ),
  ],
])('lookups return null, without throwing, on %s', (_label, page) => {
  const lib = createPageLib(page());

  expect(lib.findExport('getConfig')).toBeNull();
  expect(lib.findModuleWith(['getConfig'])).toBeNull();
});

test('lookups pass over what they cannot read and go on to the next module', () => {
  const open = (): string => 'editor';
  // An export read before the module set up the binding behind it.
  const uninitialized = esModule({
    getOpenPineEditor: () => {
      throw new ReferenceError("Cannot access 'n' before initialization");
    },
  });
  // A module the CommonJS way, whose exports are a function with members.
  const legacy = Object.assign(() => 'legacy', { getOpenPineEditor: open });
  const lib = createPageLib(
    pageWith(
      listHanding({
        c: {
          1: null,
          2: 'not a record',
          3: { exports: null },
          4: { exports: 'text' },
          5: { exports: uninitialized },
          6: { exports: { getOpenPineEditor: undefined } },
          7: {
            exports: new Proxy(
              {},
              {
                getOwnPropertyDescriptor: () => {
                  throw new Error('Revoked');
                },
              },
            ),
          },
          8: Object.defineProperty({}, 'exports', {
            get: () => {
              throw new Error('Broken record');
            },
          }),
          9: { exports: legacy },
          10: { exports: { getOpenPineEditor: () => 'too late' } },
        },
      }),
    ),
  );

  expect(lib.findExport('getOpenPineEditor')).toBe(open);
  // findModuleWith goes by the names alone, so the module whose getter throws is the first match.
  expect(lib.findModuleWith(['getOpenPineEditor'])).toBe(uninitialized);
  // Text is no exports object, though it has a length of its own: the first owner of the name is
  // the function.
  expect(lib.findModuleWith(['length'])).toBe(legacy);
});

test('lookups see a module that ran after the first lookup, without pushing again', () => {
  const open = (): string => 'editor';
  const chunks = createFakeWebpack(
    { a: { unrelated: 1 } },
    {
      factories: {
        b: (record) => {
          record.exports = { getOpenPineEditor: open };
        },
      },
    },
  );
  const lib = createPageLib(pageWith(chunks));

  expect(lib.findExport('getOpenPineEditor')).toBeNull();
  // The app loads the module, as it does when the Pine editor opens.
  appRequireOf(chunks)('b');

  expect(lib.findExport('getOpenPineEditor')).toBe(open);
  // The push of the library, then the one of the app.
  expect(chunks).toHaveLength(2);
});
