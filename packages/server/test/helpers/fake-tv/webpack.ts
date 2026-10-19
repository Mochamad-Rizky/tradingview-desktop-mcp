// A stand-in for the webpack runtime of the app, as far as the page library reaches it
// (reverse-engineering notes, section 4.7, and the runtime bundle of the captured web build).
//
// The runtime keeps the module factories in require.m and a record for every module whose factory
// has run in require.c, and replaces push on the chunk list with its chunk callback. A chunk with a
// chunk ID the runtime has not seen gets its factories registered and its callback called with
// require. Either way the chunk is then appended to the list and its IDs are marked as loaded, so
// a chunk ID that comes back gets nothing. This fake does the same, which is why the length of the
// list counts the pushes.
//
// The modules handed in are the ones in the cache. Each is its exports object, kept as it is, so an
// export can be a getter (an ES module defines every export as one) and a test can compare what the
// page library returns by identity. Each also gets a factory, as every cached module has one on the
// app. Factories of modules that have not run can be added: require(id) runs them the way the
// runtime does, so a spy on one shows whether anything did.

// A record of the module cache, as the runtime creates it.
export interface FakeModuleRecord {
  id: string;
  loaded: boolean;
  exports: unknown;
}

// What the runtime calls a factory with: the record, its exports object and require.
export type FakeModuleFactory = (
  record: FakeModuleRecord,
  exports: unknown,
  webpackRequire: FakeWebpackRequire,
) => void;

export interface FakeWebpackRequire {
  (moduleId: string): unknown;
  // The module cache: a record for every module whose factory has run, by module ID.
  readonly c: Record<string, FakeModuleRecord>;
  // The factories by module ID, those of the modules that have not run included.
  readonly m: Record<string, FakeModuleFactory>;
}

export interface FakeWebpackOptions {
  // Factories of modules that are not in the cache, by module ID.
  factories?: Record<string, FakeModuleFactory>;
}

export function createFakeWebpack(
  modules: Record<string, Record<string, unknown>>,
  options: FakeWebpackOptions = {},
): unknown[] {
  const cache: Record<string, FakeModuleRecord> = {};
  const factories: Record<string, FakeModuleFactory> = {};
  for (const [id, exports] of Object.entries(modules)) {
    cache[id] = { id, loaded: true, exports };
    factories[id] = (record) => {
      record.exports = exports;
    };
  }
  Object.assign(factories, options.factories);

  // A cached module answers with its exports. Any other runs its factory first, cached before the
  // factory runs, as the runtime does it.
  const webpackRequire: FakeWebpackRequire = Object.assign(
    (moduleId: string): unknown => {
      const cached = cache[moduleId];
      if (cached !== undefined) {
        return cached.exports;
      }
      const factory = factories[moduleId];
      if (factory === undefined) {
        throw new Error(`Cannot find module '${moduleId}'`);
      }
      const record: FakeModuleRecord = { id: moduleId, loaded: false, exports: {} };
      cache[moduleId] = record;
      factory.call(record.exports, record, record.exports, webpackRequire);
      record.loaded = true;
      return record.exports;
    },
    { c: cache, m: factories },
  );

  const chunks: unknown[] = [];
  const loaded = new Set<string>();
  const append = chunks.push.bind(chunks);
  // The chunk callback of the runtime. It takes one chunk, [chunkIds, factories, callback], and
  // answers with what the callback returned.
  const onChunk = (chunk: unknown): unknown => {
    const [chunkIds, chunkFactories, callback] = chunk as [
      unknown[],
      Record<string, FakeModuleFactory>,
      unknown,
    ];
    let result: unknown;
    if (chunkIds.some((id) => !loaded.has(String(id)))) {
      Object.assign(factories, chunkFactories);
      if (typeof callback === 'function') {
        result = (callback as (handed: FakeWebpackRequire) => unknown)(webpackRequire);
      }
    }
    append(chunk);
    for (const id of chunkIds) {
      loaded.add(String(id));
    }
    return result;
  };
  // Assigned like the runtime assigns it, as an own member of the list.
  Object.assign(chunks, { push: onChunk });
  return chunks;
}
