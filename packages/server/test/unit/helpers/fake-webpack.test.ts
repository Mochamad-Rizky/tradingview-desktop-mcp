import {
  createFakeWebpack,
  type FakeModuleFactory,
  type FakeWebpackRequire,
} from '../../helpers/fake-tv/webpack.js';

// The fake runtime has to behave like the runtime of the app where the page library meets it,
// or the tests of the library prove nothing about the app.

// Pushes a chunk with `chunkId` and answers with the require its callback got, if it got one.
function pushChunk(chunks: unknown[], chunkId: string): FakeWebpackRequire | undefined {
  let handed: FakeWebpackRequire | undefined;
  chunks.push([[chunkId], {}, (given: FakeWebpackRequire) => (handed = given)]);
  return handed;
}

describe('createFakeWebpack', () => {
  test('hands require to the callback of a new chunk, with the modules as cache records', () => {
    const exports = { studyMetaInfoRepository: {} };
    const chunks = createFakeWebpack({ 7: exports });

    const handed = pushChunk(chunks, 'first');

    expect(handed?.c).toEqual({ 7: { id: '7', loaded: true, exports } });
    expect(handed?.c[7]?.exports).toBe(exports);
    expect(typeof handed?.m[7]).toBe('function');
  });

  test('appends every chunk, and gives nothing to one whose chunk ID it has seen', () => {
    const chunks = createFakeWebpack({});
    const callback = vi.fn();

    pushChunk(chunks, 'first');
    chunks.push([['first'], {}, callback]);

    expect(callback).not.toHaveBeenCalled();
    expect(chunks).toHaveLength(2);
    expect([...chunks]).toEqual([
      [['first'], {}, expect.any(Function)],
      [['first'], {}, callback],
    ]);
  });

  test('require answers a cached module without running anything, and runs any other once', () => {
    const cached = { a: 1 };
    const factory = vi.fn<FakeModuleFactory>((record, _exports, webpackRequire) => {
      record.exports = { b: webpackRequire('cached') };
    });
    const chunks = createFakeWebpack({ cached }, { factories: { lazy: factory } });
    const webpackRequire = pushChunk(chunks, 'first');

    expect(webpackRequire?.c.lazy).toBeUndefined();
    expect(webpackRequire?.('cached')).toBe(cached);
    expect(webpackRequire?.('lazy')).toEqual({ b: cached });
    expect(webpackRequire?.('lazy')).toBe(webpackRequire?.c.lazy?.exports);
    expect(webpackRequire?.c.lazy).toMatchObject({ id: 'lazy', loaded: true });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(() => webpackRequire?.('missing')).toThrow("Cannot find module 'missing'");
  });

  test('registers the factories a new chunk brings', () => {
    const chunks = createFakeWebpack({});
    const factory: FakeModuleFactory = (record) => {
      record.exports = { late: true };
    };

    chunks.push([['lazy-chunk'], { late: factory }]);

    expect(pushChunk(chunks, 'second')?.('late')).toEqual({ late: true });
  });
});
