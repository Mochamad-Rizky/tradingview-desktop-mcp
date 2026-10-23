import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// A built dashboard made up for a test, in a temporary directory: `root` stands for the folder of
// the bundle, and `dir` for the dashboard/ folder beside it. A file outside `dir` lets a test show
// that no path reaches it.

export const INDEX_HTML =
  '<!doctype html><html><head><title>Synthetic dashboard</title>' +
  '<script type="module" src="/assets/index-abc123.js"></script></head><body></body></html>';
export const ASSET_JS = 'export const synthetic = true;\n';
export const OUTSIDE_JSON = '{"name":"outside-the-dashboard"}';

export interface DashboardFiles {
  root: string;
  dir: string;
  // Adds a file under `dir`, at a path relative to it.
  add(path: string, content: string | Buffer): void;
  remove(): void;
}

export function createDashboardFiles(): DashboardFiles {
  const root = mkdtempSync(join(tmpdir(), 'tv-mcp-dashboard-'));
  const dir = join(root, 'dashboard');
  const add = (path: string, content: string | Buffer): void => {
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  writeFileSync(join(root, 'package.json'), OUTSIDE_JSON);
  add('index.html', INDEX_HTML);
  add('assets/index-abc123.js', ASSET_JS);
  return {
    root,
    dir,
    add,
    remove: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
