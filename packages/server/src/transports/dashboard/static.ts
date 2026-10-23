import { statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendJson } from '../respond.js';

// The built dashboard: one page and its assets, the same for everyone. They are served without the
// token, which a browser could not add to a page load anyway, and they hold no data: the page asks
// the API for it, with the token.

const INDEX = 'index.html';

// Every answer, a 404 included. The page may load only what this server sends: no CDN, no inline
// script, no frame around it. Inline styles are allowed for the components that set them.
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.json', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.woff2', 'font/woff2'],
  ['.webmanifest', 'application/manifest+json'],
]);

// The build names each file under assets/ after a hash of its content, so a name never changes
// what it holds. Everything else, the page first, is checked again on every load.
const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';

// The dashboard/ folder beside the running bundle, which the build copies there, or null when it
// holds no index.html: when the server runs from its sources, or was built without the dashboard.
export function resolveDashboardDir(from: string | URL = import.meta.url): string | null {
  const dir = fileURLToPath(new URL('./dashboard/', from));
  return statSync(join(dir, INDEX), { throwIfNoEntry: false })?.isFile() === true ? dir : null;
}

// The file `path` names inside `dir`, or undefined for a path that cannot name one: a malformed
// escape, a segment that is .. or holds a NUL or a backslash (a separator on Windows), or anything
// else that would end up outside `dir`.
function fileIn(dir: string, path: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  const segments = decoded.split('/');
  const file = decoded === '/' ? join(dir, INDEX) : join(dir, ...segments);
  const inside = relative(dir, file);
  const refused =
    segments.some((segment) => segment === '..' || /[\0\\]/.test(segment)) ||
    inside === '..' ||
    inside.startsWith(`..${sep}`) ||
    isAbsolute(inside);
  return refused ? undefined : file;
}

// The content of a regular file, or undefined when there is none to serve: a missing file, a
// folder, a path under a file, or one that cannot be read.
async function readRegularFile(file: string): Promise<Buffer | undefined> {
  try {
    return (await stat(file)).isFile() ? await readFile(file) : undefined;
  } catch {
    return undefined;
  }
}

// A path without an extension, asked for by a browser loading a page, is one of the dashboard's
// own pages, such as /log: the page finds its view from the address.
function isPageLoad(req: IncomingMessage, file: string): boolean {
  const accept = (req.headers.accept ?? '').toLowerCase();
  return extname(file) === '' && accept.includes('text/html');
}

function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  dir: string,
  file: string,
  content: Buffer,
): void {
  const immutable = relative(dir, file).startsWith(`assets${sep}`);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': CONTENT_TYPES.get(extname(file).toLowerCase()) ?? 'application/octet-stream',
    'Content-Length': content.length,
    'Cache-Control': immutable ? IMMUTABLE : REVALIDATE,
  });
  res.end(req.method === 'HEAD' ? undefined : content);
}

// Answers a GET or a HEAD for `path`, the path as sent, from the files of `dir`: the file, the page
// for a page load, or 404. Any other method is left to the caller, and false says so.
export async function serveDashboard(
  req: IncomingMessage,
  res: ServerResponse,
  dir: string,
  path: string,
): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return false;
  }
  const file = fileIn(dir, path);
  const candidates =
    file === undefined ? [] : [file, ...(isPageLoad(req, file) ? [join(dir, INDEX)] : [])];
  for (const candidate of candidates) {
    const content = await readRegularFile(candidate);
    if (content !== undefined) {
      sendFile(req, res, dir, candidate, content);
      return true;
    }
  }
  sendJson(res, 404, { error: 'Not found' }, SECURITY_HEADERS);
  return true;
}
