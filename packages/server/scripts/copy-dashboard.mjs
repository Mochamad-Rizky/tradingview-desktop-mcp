// The last step of the server's build: copies the built dashboard to dist/dashboard, beside the
// bundle, where the server looks for it, so that the published package carries it. The root build
// builds the dashboard first. Without that build this step fails, rather than ship a package whose
// dashboard is missing.
//
// Plain JavaScript without dependencies. It finds both packages from its own place in the
// repository, whatever directory it runs from.
// Usage: node scripts/copy-dashboard.mjs (the server's build script runs it after tsup).

import { cpSync, existsSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = fileURLToPath(new URL('../../dashboard/dist', import.meta.url));
const TARGET = fileURLToPath(new URL('../dist/dashboard', import.meta.url));
const INDEX = join(SOURCE, 'index.html');

// A path as short as the directory this runs from allows, for the build log.
function shown(path) {
  return relative(process.cwd(), path);
}

if (existsSync(INDEX)) {
  // A file of an earlier build would otherwise stay, and ship, beside the new ones.
  rmSync(TARGET, { recursive: true, force: true });
  cpSync(SOURCE, TARGET, { recursive: true });
  console.log(`copy-dashboard: copied ${shown(SOURCE)} to ${shown(TARGET)}`);
} else {
  console.error(
    `copy-dashboard: ${shown(INDEX)} is missing; build the dashboard first: pnpm build`,
  );
  process.exitCode = 1;
}
