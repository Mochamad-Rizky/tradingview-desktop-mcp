import { statSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '../../core/logger.js';
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

// The errors that mean that no file can be served at a path: it is missing, goes through a file or
// round a loop of links, or is a name the system cannot take. Any other, such as EACCES or EMFILE,
// is the server failing to read a file that is there.
const NO_FILE = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'ENAMETOOLONG', 'EINVAL']);

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

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return typeof error.code === 'string' ? error.code : undefined;
  }
  return undefined;
}

// Whether `file` is inside `dir`, both as written or both resolved.
function isInside(dir: string, file: string): boolean {
  const inside = relative(dir, file);
  return !(inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside));
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
  const refused =
    segments.some((segment) => segment === '..' || /[\0\\]/.test(segment)) || !isInside(dir, file);
  return refused ? undefined : file;
}

// The content of a regular file inside `dir`, or undefined when there is none to serve: a missing
// file, a folder, or a path under a file. It throws when the file is there but cannot be read. The
// file counts by where it really is, once every link is followed and the system has read the name
// its own way (the names that Windows reads as another file or a device among them): a link may
// lead to another file of the dashboard, never out of its folder.
async function readRegularFile(dir: string, file: string): Promise<Buffer | undefined> {
  try {
    const [realDir, realFile] = await Promise.all([realpath(dir), realpath(file)]);
    if (!isInside(realDir, realFile)) {
      return undefined;
    }
    return (await stat(realFile)).isFile() ? await readFile(realFile) : undefined;
  } catch (error) {
    if (NO_FILE.has(errorCode(error) ?? '')) {
      return undefined;
    }
    throw error;
  }
}

// A path without an extension, asked for by a browser loading a page, is one of the dashboard's
// own pages, such as /log: the page finds its view from the address.
function isPageLoad(req: IncomingMessage, file: string): boolean {
  const accept = (req.headers.accept ?? '').toLowerCase();
  return extname(file) === '' && accept.includes('text/html');
}

// The type and the cache follow the address asked for, `file` as the path names it, rather than
// where a link leads. `fallback` is the page sent for a path that names no file.
function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  dir: string,
  file: string,
  content: Buffer,
  fallback: boolean,
): void {
  const immutable = relative(dir, file).startsWith(`assets${sep}`);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': CONTENT_TYPES.get(extname(file).toLowerCase()) ?? 'application/octet-stream',
    'Content-Length': content.length,
    'Cache-Control': immutable ? IMMUTABLE : REVALIDATE,
    // The same path answers 404 to a client that does not accept html, so a cache must keep the
    // two answers apart.
    ...(fallback ? { Vary: 'Accept' } : {}),
  });
  res.end(req.method === 'HEAD' ? undefined : content);
}

// Answers a GET or a HEAD for `path`, the path as sent: the file, the page for a page load, or
// 404. Any other method is left to the caller, and false says so.
export type DashboardFileServer = (
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
) => Promise<boolean>;

// What serves the files of the built dashboard in `dir`, for one listener. A file it cannot read is
// a failure of the server, answered with 500 and logged.
export function dashboardFiles(dir: string, logger: Logger): DashboardFileServer {
  // The codes of the read errors logged so far: each kind is told once, not on every request.
  const reported = new Set<string>();

  const failed = (res: ServerResponse, error: unknown): void => {
    const code = errorCode(error) ?? 'UNKNOWN';
    if (!reported.has(code)) {
      reported.add(code);
      // The code alone: the message of the error names the path, which the client chose.
      logger.warn(
        { code },
        'A file of the dashboard could not be read, so the request failed. Check that the server ' +
          'may read the files of its package (EACCES, EPERM) and is not out of file handles ' +
          '(EMFILE, ENFILE). Each kind of error is logged once',
      );
    }
    sendJson(res, 500, { error: 'Internal server error' }, SECURITY_HEADERS);
  };

  return async (req, res, path) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return false;
    }
    const file = fileIn(dir, path);
    const candidates =
      file === undefined ? [] : [file, ...(isPageLoad(req, file) ? [join(dir, INDEX)] : [])];
    try {
      for (const [index, candidate] of candidates.entries()) {
        const content = await readRegularFile(dir, candidate);
        if (content !== undefined) {
          sendFile(req, res, dir, candidate, content, index > 0);
          return true;
        }
      }
    } catch (error) {
      failed(res, error);
      return true;
    }
    sendJson(res, 404, { error: 'Not found' }, SECURITY_HEADERS);
    return true;
  };
}
