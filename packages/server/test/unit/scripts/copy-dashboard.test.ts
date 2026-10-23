import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSET_JS, INDEX_HTML } from '../../helpers/dashboard-files.js';

// The last step of the server's build, which puts the built dashboard beside the bundle. The script
// finds both packages from its own place in the repository, so the test runs a copy of it in a
// made-up repository with a server/ and a dashboard/ package.

const SCRIPT = fileURLToPath(new URL('../../../scripts/copy-dashboard.mjs', import.meta.url));

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tv-mcp-copy-dashboard-'));
  mkdirSync(join(root, 'server', 'scripts'), { recursive: true });
  copyFileSync(SCRIPT, join(root, 'server', 'scripts', 'copy-dashboard.mjs'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

function copyDashboard() {
  return spawnSync(process.execPath, [join(root, 'server', 'scripts', 'copy-dashboard.mjs')], {
    cwd: join(root, 'server'),
    encoding: 'utf8',
  });
}

test('copy-dashboard copies the built files and fails with the build hint when they are missing', () => {
  // A dashboard build that stopped before it wrote the page.
  write('dashboard/dist/assets/index-abc123.js', ASSET_JS);
  const missing = copyDashboard();
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain('build the dashboard first: pnpm build');
  expect(existsSync(join(root, 'server', 'dist', 'dashboard'))).toBe(false);

  write('dashboard/dist/index.html', INDEX_HTML);
  // Left by an earlier build, whose asset names the new one no longer has.
  write('server/dist/dashboard/assets/index-old000.js', 'export const stale = true;\n');
  const copied = copyDashboard();
  expect(copied.status).toBe(0);
  expect(copied.stderr).toBe('');
  expect(read('server/dist/dashboard/index.html')).toBe(INDEX_HTML);
  expect(read('server/dist/dashboard/assets/index-abc123.js')).toBe(ASSET_JS);
  expect(existsSync(join(root, 'server', 'dist', 'dashboard', 'assets', 'index-old000.js'))).toBe(
    false,
  );
  // The source stays as it was, for the next build of the server.
  expect(read('dashboard/dist/index.html')).toBe(INDEX_HTML);
});
