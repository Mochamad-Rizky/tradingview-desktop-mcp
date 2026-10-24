import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isEntryPoint } from '../../../scripts/docs/entry-point.js';

// The check the docs generators run on import, so that `pnpm docs:<name>` writes its document while
// a test that imports the generator writes nothing.

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tv-mcp-entry-point-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('a module is the entry point when node was started with it, also through a link', () => {
  const script = join(dir, 'generator.ts');
  writeFileSync(script, '');
  const link = join(dir, 'linked.ts');
  symlinkSync(script, link);
  const moduleUrl = pathToFileURL(script).href;

  expect(isEntryPoint(moduleUrl, script)).toBe(true);
  expect(isEntryPoint(moduleUrl, link)).toBe(true);
  expect(isEntryPoint(pathToFileURL(link).href, script)).toBe(true);
});

test('a module that node was not started with, or a start without a script, is no entry point', () => {
  const script = join(dir, 'generator.ts');
  const other = join(dir, 'other.ts');
  writeFileSync(script, '');
  writeFileSync(other, '');
  const moduleUrl = pathToFileURL(script).href;

  expect(isEntryPoint(moduleUrl, other)).toBe(false);
  expect(isEntryPoint(moduleUrl, join(dir, 'missing.ts'))).toBe(false);
  expect(isEntryPoint(moduleUrl, undefined)).toBe(false);
  // Under the test runner, node was started with the runner, not with this module.
  expect(isEntryPoint(import.meta.url)).toBe(false);
});
