import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Logger } from '../../../../src/core/logger.js';
import {
  dashboardFiles,
  resolveDashboardDir,
} from '../../../../src/transports/dashboard/static.js';
import { send, type RawResponse } from '../../../helpers/dashboard-client.js';
import {
  ASSET_JS,
  INDEX_HTML,
  OUTSIDE_JSON,
  createDashboardFiles,
  type DashboardFiles,
} from '../../../helpers/dashboard-files.js';
import { capturingLogger } from '../../../helpers/tool-context.js';

const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' " +
    "data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; " +
    "form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};
const HTML = { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };
// What the harness answers when the file server leaves a request to its caller.
const NOT_HANDLED = 418;

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function files(): DashboardFiles {
  const created = createDashboardFiles();
  cleanups.push(() => {
    created.remove();
  });
  return created;
}

// The file server of `dir` behind a plain listener, with the path as sent, as the transport hands
// it over.
async function serve(dir: string, logger: Logger = capturingLogger().logger): Promise<number> {
  const serveFiles = dashboardFiles(dir, logger);
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?', 1)[0] ?? '/';
    void serveFiles(req, res, path).then((handled) => {
      if (!handled) {
        res.writeHead(NOT_HANDLED);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  );
  return (server.address() as AddressInfo).port;
}

function expectNotFound(response: RawResponse): void {
  expect(response.status).toBe(404);
  expect(response.headers).toMatchObject(SECURITY_HEADERS);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(JSON.parse(response.body)).toEqual({ error: 'Not found' });
}

test('resolveDashboardDir finds dashboard/index.html beside the bundle, and null without it', () => {
  const built = files();
  const bare = mkdtempSync(join(tmpdir(), 'tv-mcp-no-dashboard-'));
  cleanups.push(() => {
    rmSync(bare, { recursive: true, force: true });
  });

  expect(resolveDashboardDir(pathToFileURL(join(built.root, 'cli.js')))).toBe(`${built.dir}${sep}`);
  expect(resolveDashboardDir(pathToFileURL(join(bare, 'cli.js')))).toBeNull();
  // The sources have no built dashboard beside them; the bundle in dist does.
  expect(resolveDashboardDir()).toBeNull();
});

test.each([
  ['index.html', 'text/html; charset=utf-8'],
  ['assets/app.js', 'text/javascript; charset=utf-8'],
  ['assets/app.css', 'text/css; charset=utf-8'],
  ['assets/logo.svg', 'image/svg+xml'],
  ['assets/logo.png', 'image/png'],
  ['favicon.ico', 'image/x-icon'],
  ['assets/data.json', 'application/json; charset=utf-8'],
  ['robots.txt', 'text/plain; charset=utf-8'],
  ['assets/font.woff2', 'font/woff2'],
  ['site.webmanifest', 'application/manifest+json'],
  ['assets/UPPER.JS', 'text/javascript; charset=utf-8'],
  ['assets/archive.bin', 'application/octet-stream'],
  ['LICENSE', 'application/octet-stream'],
])('dashboardFiles sends /%s as %s, with the security headers', async (path, type) => {
  const built = files();
  const content = `synthetic content of ${path}`;
  if (path !== 'index.html') {
    built.add(path, content);
  }
  const port = await serve(built.dir);

  const response = await send(port, { path: `/${path}` });

  expect(response.status).toBe(200);
  expect(response.headers['content-type']).toBe(type);
  expect(response.headers).toMatchObject(SECURITY_HEADERS);
  expect(response.body).toBe(path === 'index.html' ? INDEX_HTML : content);
  expect(response.headers['content-length']).toBe(String(Buffer.byteLength(response.body)));
});

test('dashboardFiles sends index.html for / and keeps it out of caches, unlike the assets', async () => {
  const built = files();
  built.add('robots.txt', 'User-agent: *\n');
  const port = await serve(built.dir);

  const root = await send(port, { path: '/' });
  const index = await send(port, { path: '/index.html' });
  const asset = await send(port, { path: '/assets/index-abc123.js' });
  const robots = await send(port, { path: '/robots.txt' });

  expect(root.body).toBe(INDEX_HTML);
  expect(root.headers['cache-control']).toBe('no-cache');
  expect(index.headers['cache-control']).toBe('no-cache');
  // Only the hashed files under /assets keep their name for one build.
  expect(asset.body).toBe(ASSET_JS);
  expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  expect(robots.headers['cache-control']).toBe('no-cache');
});

test('dashboardFiles answers HEAD with the headers of GET and no body', async () => {
  const port = await serve(files().dir);

  const found = await send(port, { method: 'HEAD', path: '/' });
  const missing = await send(port, { method: 'HEAD', path: '/assets/missing.js' });

  expect(found.status).toBe(200);
  expect(found.headers['content-type']).toBe('text/html; charset=utf-8');
  expect(found.headers['content-length']).toBe(String(Buffer.byteLength(INDEX_HTML)));
  expect(found.body).toBe('');
  expect(missing.status).toBe(404);
  expect(missing.headers).toMatchObject(SECURITY_HEADERS);
  expect(missing.body).toBe('');
});

test('dashboardFiles leaves any method but GET and HEAD to its caller', async () => {
  const port = await serve(files().dir);

  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const response = await send(port, { method, path: '/' });
    expect({ method, status: response.status }).toEqual({ method, status: NOT_HANDLED });
  }
});

test('dashboardFiles sends index.html for a page path that accepts html, and 404 for any other miss', async () => {
  const port = await serve(files().dir);

  for (const path of ['/log', '/tools', '/log/', '/assets']) {
    const response = await send(port, { path, headers: HTML });
    expect({ path, status: response.status }).toEqual({ path, status: 200 });
    expect(response.body).toBe(INDEX_HTML);
    expect(response.headers['cache-control']).toBe('no-cache');
    expect(response.headers).toMatchObject(SECURITY_HEADERS);
  }
  const misses: [string, Record<string, string>][] = [
    // A page path asked for by a script, not a browser loading a page.
    ['/log', {}],
    ['/log', { Accept: 'application/json' }],
    ['/assets', {}],
    // A file name is no page, whatever the client accepts.
    ['/assets/missing.js', HTML],
    ['/missing.png', HTML],
    ['/index.html/inside.js', HTML],
  ];
  for (const [path, headers] of misses) {
    const response = await send(port, { path, headers });
    expectNotFound(response);
  }
});

test('dashboardFiles refuses a path that leaves its folder or cannot be read, even for html', async () => {
  const port = await serve(files().dir);

  for (const path of [
    '/../package.json',
    '/assets/../../package.json',
    '/%2e%2e/package.json',
    '/%2E%2E/%2E%2E/package.json',
    '/..%2fpackage.json',
    '/%2e%2e',
    '/..',
    '/index.html%00',
    '/%00',
    '/..%5cpackage.json',
    '/..\\package.json',
    '/assets\\..\\..\\package.json',
    '/%E0%A4%A',
  ]) {
    for (const headers of [{}, HTML]) {
      const response = await send(port, { path, headers });
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
      expectNotFound(response);
      expect(response.body).not.toContain(OUTSIDE_JSON);
    }
  }
});

// The build holds no link, but a folder that was copied or installed by hand could: a link may
// point at another file of the dashboard, never outside its folder.
test.skipIf(process.platform === 'win32')(
  'dashboardFiles follows a link only to a file inside its folder',
  async () => {
    const built = files();
    symlinkSync(join(built.root, 'package.json'), join(built.dir, 'outside.json'));
    symlinkSync(built.root, join(built.dir, 'up'));
    mkdirSync(join(built.dir, 'nested'));
    symlinkSync(join(built.dir, 'assets', 'index-abc123.js'), join(built.dir, 'nested', 'app.js'));
    const port = await serve(built.dir);

    for (const path of ['/outside.json', '/up/package.json']) {
      for (const headers of [{}, HTML]) {
        const response = await send(port, { path, headers });
        expect({ path, status: response.status }).toEqual({ path, status: 404 });
        expect(response.body).not.toContain(OUTSIDE_JSON);
      }
    }
    const inside = await send(port, { path: '/nested/app.js' });
    expect(inside.status).toBe(200);
    expect(inside.body).toBe(ASSET_JS);
    // The cache follows the address asked for, which names no hashed asset.
    expect(inside.headers['cache-control']).toBe('no-cache');
    // Out of the folder and back into it: the file is the dashboard's own.
    const back = await send(port, { path: '/up/dashboard/index.html' });
    expect(back.status).toBe(200);
    expect(back.body).toBe(INDEX_HTML);
  },
);

// A page path answers with the page for a browser and with 404 for a script, so a cache must keep
// the answers apart by what the client accepts.
test('dashboardFiles marks the page sent for a page path as varying with Accept', async () => {
  const port = await serve(files().dir);

  const fallback = await send(port, { path: '/log', headers: HTML });
  const root = await send(port, { path: '/', headers: HTML });
  const index = await send(port, { path: '/index.html', headers: HTML });
  const asset = await send(port, { path: '/assets/index-abc123.js' });

  expect(fallback.status).toBe(200);
  expect(fallback.body).toBe(INDEX_HTML);
  expect(fallback.headers.vary).toBe('Accept');
  // These name their file whatever the client accepts.
  for (const response of [root, index, asset]) {
    expect(response.status).toBe(200);
    expect(response.headers.vary).toBeUndefined();
  }
});

// A file of the package that the server may not read is no missing file: the answer says the server
// failed, and the log says why, once for each kind of error rather than on every request. The log
// names the error alone: the path came from the client.
test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'dashboardFiles answers 500 for a file it may not read, and logs that once',
  async () => {
    const built = files();
    chmodSync(join(built.dir, 'index.html'), 0o000);
    cleanups.push(() => {
      chmodSync(join(built.dir, 'index.html'), 0o644);
    });
    const { logger, lines } = capturingLogger();
    const port = await serve(built.dir, logger);

    const answers = [
      await send(port, { path: '/' }),
      await send(port, { path: '/log', headers: HTML }),
      await send(port, { method: 'HEAD', path: '/index.html' }),
    ];

    for (const response of answers) {
      expect(response.status).toBe(500);
      expect(response.headers).toMatchObject(SECURITY_HEADERS);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(JSON.parse(answers[0]?.body ?? '')).toEqual({ error: 'Internal server error' });
    const warnings = lines.filter((line) => line.level === 40);
    expect(warnings).toEqual([
      expect.objectContaining({
        code: 'EACCES',
        msg: expect.stringContaining('could not be read') as string,
      }),
    ]);
    expect(JSON.stringify(warnings)).not.toContain(built.dir);
    // A file it may read is served as before.
    expect((await send(port, { path: '/assets/index-abc123.js' })).status).toBe(200);
  },
);
