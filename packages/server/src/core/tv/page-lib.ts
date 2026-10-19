import type { TvWindow } from './tv-window.js';

// The page library: lookups of what the webpack modules of the app export, for page functions that
// need a service of the app that has no global (reverse-engineering notes, section 4.7). The page
// bridge builds it in the page for each evaluateWithLib call, from the source text of
// createPageLib, and hands it to the page function after the window. It lives as long as that
// call, and nothing of it is kept on the page.
//
// A module is found by the name of an export, which production builds keep, and never by its module
// ID, which changes with every build. Only modules that have already run are looked at: the library
// reads the exports of the records in the module cache (require.c). It never calls require and never
// reads the factories (require.m), so no code of a module that has not been loaded runs.
export interface PageLib {
  // The value of the export `name` of the first cached module that has it as an own member, or null
  // when none has. An export whose getter throws, or whose value is undefined, does not count.
  findExport(name: string): unknown;
  // The exports object of the first cached module that has every one of `names` as an own member,
  // or null when none has, and for an empty list. Only the names are checked: no export is read.
  findModuleWith(names: string[]): Record<string, unknown> | null;
}

// A page function, so it uses nothing of this module (see page-bridge.ts), and its source text
// steers clear of the words the serializability test takes for Node globals.
//
// The library reaches the module cache through a push to the chunk list of the app,
// webpackChunktradingview: the webpack runtime calls the callback of a chunk it has not seen with
// its require function. The push happens at the first lookup and only once, so once per
// evaluateWithLib call at most. Each push registers one inert chunk ID, tvmcp_ followed by the time
// and a random suffix, so that no two pushes share an ID: the runtime ignores the callback of a
// chunk ID it has seen. The chunk brings no module factory, so it adds nothing to the app. The
// runtime keeps the ID among its loaded chunks and the chunk in the list, as it does for every
// chunk.
//
// Lookups read the cache afresh each time, so they see a module that ran after the push, and they
// never throw. Without a chunk list, or when the push hands nothing back (a plain list before the
// runtime has loaded, or a push that throws), every lookup answers null. A record, an exports object
// or an export that cannot be read is passed over. An exports object is an object or, for a module
// written the CommonJS way, a function.
export function createPageLib(win: TvWindow): PageLib {
  // The cache of the app, asked for at the first lookup: null when the page handed none over.
  let cache: object | null | undefined;
  const cachedRecords = (): unknown[] => {
    if (cache === undefined) {
      cache = null;
      try {
        let handed: unknown;
        win.webpackChunktradingview?.push([
          [`tvmcp_${String(Date.now())}_${Math.random().toString(36).slice(2)}`],
          {},
          (given) => {
            handed = given;
          },
        ]);
        const found: unknown = (handed as { c?: unknown } | null | undefined)?.c;
        if (typeof found === 'object' && found !== null) {
          cache = found;
        }
      } catch {
        // A list without a push, or a runtime that throws, hands nothing over.
      }
    }
    try {
      return cache === null ? [] : Object.values(cache);
    } catch {
      return [];
    }
  };

  // The first answer of `match` for the exports of a cached record, in the order of the cache.
  const search = <T>(match: (exports: object) => T | undefined): T | null => {
    for (const record of cachedRecords()) {
      try {
        const exports: unknown = (record as { exports?: unknown } | null | undefined)?.exports;
        if ((typeof exports === 'object' && exports !== null) || typeof exports === 'function') {
          const answer = match(exports);
          if (answer !== undefined) {
            return answer;
          }
        }
      } catch {
        // Unreadable, such as an export read before the app set it up: the next record may do.
      }
    }
    return null;
  };

  return {
    findExport(name) {
      return search((exports): unknown =>
        Object.hasOwn(exports, name) ? (exports as Record<string, unknown>)[name] : undefined,
      );
    },
    findModuleWith(names) {
      if (names.length === 0) {
        return null;
      }
      return search((exports) =>
        names.every((name) => Object.hasOwn(exports, name))
          ? (exports as Record<string, unknown>)
          : undefined,
      );
    },
  };
}
