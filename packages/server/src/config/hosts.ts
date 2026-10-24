import { TvMcpError } from '../core/errors.js';

// The names a server may be reached by besides its own address, such as a tunnel's public host.
// This module only reads them; the HTTP transport decides what they let in.

export const ALLOWED_HOSTS_HINT =
  'TV_MCP_ALLOWED_HOSTS takes host names such as abc.ngrok.app, comma-separated';

// The ports clients leave out of the Host header. A host without a port already matches them, so
// an entry that names one means the same as the host alone.
const DEFAULT_PORTS = new Set(['80', '443']);

// The scheme an entry written as a URL starts with.
const SCHEME = /^([a-z][a-z\d+.-]*):\/\//i;

// White space and backslashes are never part of a host. The URL parser would drop or rewrite them
// rather than fail, and so turn a typo into another name.
const NOT_IN_A_HOST = /[\s\\]/;

interface Parts {
  // "https://", or empty for an entry without a scheme.
  prefix: string;
  scheme: string | undefined;
  // The user name and password, the host and the port.
  authority: string;
  // Everything after the authority: a path, a query or a fragment.
  tail: string;
}

function split(text: string): Parts {
  const match = SCHEME.exec(text);
  const prefix = match?.[0] ?? '';
  const rest = text.slice(prefix.length);
  const end = rest.search(/[/?#]/);
  return {
    prefix,
    scheme: match?.[1]?.toLowerCase(),
    authority: end === -1 ? rest : rest.slice(0, end),
    tail: end === -1 ? '' : rest.slice(end),
  };
}

// What an error may quote of an entry: its scheme and host, but neither a user name and password
// before the host nor anything after it but a lone slash, because a connector URL pasted by mistake
// carries the token there.
function shown({ prefix, authority, tail }: Parts): string {
  const at = authority.lastIndexOf('@');
  const host = at === -1 ? authority : `…@${authority.slice(at + 1)}`;
  const after = tail === '' || tail === '/' ? tail : `${tail.charAt(0)}…`;
  return `${prefix}${host}${after}`;
}

// The first thing that keeps the tail from being a lone slash, or undefined when it is one.
function tailProblem(tail: string): string | undefined {
  const path = tail.replace(/[?#].*$/s, '');
  if (path !== '' && path !== '/') {
    return 'it has a path';
  }
  const next = tail.charAt(path.length);
  if (next === '?') {
    return 'it has a query';
  }
  return next === '#' ? 'it has a fragment' : undefined;
}

function parse(prefix: string, authority: string): URL | undefined {
  try {
    return new URL(`${prefix === '' ? 'https://' : prefix}${authority}`);
  } catch {
    return undefined;
  }
}

// One entry as a Host header names it: in lower case, with an IPv6 address in brackets, and with
// its port unless that is 80 or 443. An entry may be a host (abc.ngrok.app), a host:port, or an
// http or https URL with nothing after the host but a slash. Anything that could not be compared
// with a Host header as it was written is refused rather than dropped: a path, a query, a fragment,
// a user name or password, and a wildcard, which the list never implies. So is a plain http URL
// without a port other than 80 or 443, because a host without a port lets only https pages in.
// `source`, the variable or flag the entry came from, starts the message of a refusal when given.
export function normalizeHostEntry(entry: string, source?: string): string {
  const parts = split(entry.trim());
  const refused = (problem?: string): TvMcpError =>
    new TvMcpError(
      'INVALID_INPUT',
      `${source === undefined ? '' : `${source}: `}${JSON.stringify(shown(parts))} is not a ` +
        `host name${problem === undefined ? '' : `: ${problem}`}`,
      { hint: ALLOWED_HOSTS_HINT },
    );
  const { prefix, scheme, authority, tail } = parts;

  if (authority === '' && tail === '') {
    throw refused('it is empty');
  }
  if (authority.includes('*')) {
    throw refused('a wildcard is not supported, so list each host');
  }
  if (authority.includes('@')) {
    throw refused('it has a user name or password');
  }
  const problem = tailProblem(tail);
  if (problem !== undefined) {
    throw refused(problem);
  }
  if (scheme !== undefined && scheme !== 'https' && scheme !== 'http') {
    throw refused('give the host alone, or an https URL');
  }
  const url = NOT_IN_A_HOST.test(authority) ? undefined : parse(prefix, authority);
  if (url === undefined) {
    throw refused();
  }
  // The parser leaves out the default port of the scheme; the other one is left out here.
  const port = DEFAULT_PORTS.has(url.port) ? '' : url.port;
  if (scheme === 'http' && port === '') {
    throw refused(
      'plain http needs a port other than 80 or 443, so give the host alone for an https tunnel',
    );
  }
  return port === '' ? url.hostname : `${url.hostname}:${port}`;
}
