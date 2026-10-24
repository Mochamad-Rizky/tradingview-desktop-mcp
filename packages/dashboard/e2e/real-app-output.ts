import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

// Where a run against the user's TradingView puts what Playwright writes, and how it goes away.
// Whatever a failure writes there (its message, and the snapshot of the page that a failing locator
// matcher takes) can show the user's chart: it must not stay in the repository, nor anywhere once
// the run is over.
// - playwright.config.ts names a directory of its own under the system's temporary directory for
//   each run, and hands it to its worker processes through OUTPUT_VARIABLE;
// - the global setup (this file) creates it, readable by the user alone, once the server is up;
// - the global teardown (real-app-teardown.ts) removes it, after the tests whatever their outcome;
// - a reporter (real-app-reporter.ts) removes it again at the very end, as Playwright writes the
//   record of the run's outcome there after the teardown.
// The results go into a test-results folder inside it: Playwright clears that folder when the run
// starts, and the private directory around it keeps its mode.

export const OUTPUT_VARIABLE = 'DASHBOARD_E2E_OUTPUT_DIR';
const PREFIX = 'tvmcp-dashboard-e2e-';

// Whether `dir` is a directory this setup names: one level under the temporary directory, with the
// prefix. The teardown removes nothing else, whatever the variable says.
export function isRunDirectory(dir: string): boolean {
  return resolve(dirname(dir)) === resolve(tmpdir()) && basename(dir).startsWith(PREFIX);
}

// The directory of this run: the one the runner named, read back by the workers, or a new name.
export function runDirectory(): string {
  const named = process.env[OUTPUT_VARIABLE];
  if (named !== undefined && isRunDirectory(named)) {
    return named;
  }
  const dir = join(tmpdir(), `${PREFIX}${randomUUID()}`);
  process.env[OUTPUT_VARIABLE] = dir;
  return dir;
}

export function removeRunDirectory(): void {
  const dir = process.env[OUTPUT_VARIABLE];
  if (dir !== undefined && isRunDirectory(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

export default function createRunDirectory(): void {
  const dir = process.env[OUTPUT_VARIABLE];
  if (dir === undefined || !isRunDirectory(dir)) {
    throw new Error(`${OUTPUT_VARIABLE} does not name a directory of this run`);
  }
  mkdirSync(dir, { mode: 0o700 });
}
