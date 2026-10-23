import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  resolveDashboardDir,
  serveDashboard,
} from '../../../../src/transports/dashboard/static.js';
import { send, type RawResponse } from '../../../helpers/dashboard-client.js';
import {
  ASSET_JS,
  INDEX_HTML,
  OUTSIDE_JSON,
  createDashboardFiles,
  type DashboardFiles,
} from '../../../helpers/dashboard-files.js';

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
// What the harness answers when serveDashboard leaves a request to its caller.
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

// serveDashboard behind a plain listener, with the path as sent, as the transport hands it over.
async function serve(dir: string): Promise<number> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?', 1)[0] ?? '/';
    void serveDashboard(req, res, dir, path).then((handled) => {
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
])('serveDashboard sends /%s as %s, with the security headers', async (path, type) => {
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

test('serveDashboard sends index.html for / and keeps it out of caches, unlike the assets', async () => {
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

test('serveDashboard answers HEAD with the headers of GET and no body', async () => {
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

test('serveDashboard leaves any method but GET and HEAD to its caller', async () => {
  const port = await serve(files().dir);

  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const response = await send(port, { method, path: '/' });
    expect({ method, status: response.status }).toEqual({ method, status: NOT_HANDLED });
  }
});

test('serveDashboard sends index.html for a page path that accepts html, and 404 for any other miss', async () => {
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

test('serveDashboard refuses a path that leaves its folder or cannot be read, even for html', async () => {
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
