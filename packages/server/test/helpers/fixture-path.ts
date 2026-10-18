import { fileURLToPath } from 'node:url';

// test/helpers/ -> test/fixtures/. Resolved from this module, so tests do not depend on the
// working directory vitest was started from.
const FIXTURES_ROOT = new URL('../fixtures/', import.meta.url);

export function fixtureUrl(relativePath: string): URL {
  return new URL(relativePath, FIXTURES_ROOT);
}

export function fixturePath(relativePath: string): string {
  return fileURLToPath(fixtureUrl(relativePath));
}
