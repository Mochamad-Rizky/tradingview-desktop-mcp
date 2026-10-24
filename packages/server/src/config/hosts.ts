import { isIPv4 } from 'node:net';
import { domainToASCII } from 'node:url';
import { TvMcpError } from '../core/errors.js';

// The names a server may be reached by besides its own address, such as a tunnel's public host.
// This module only reads them; the HTTP transport decides what they let in.

export const ALLOWED_HOSTS_HINT =
  'TV_MCP_ALLOWED_HOSTS takes host names such as abc.ngrok.app, comma-separated';

// The ports clients leave out of the Host header. A host without a port already matches them, so
// an entry that names one means the same as the host alone.
const DEFAULT_PORTS = new Set([80, 443]);
const MAX_PORT = 65535;

// The scheme an entry written as a URL starts with.
const SCHEME = /^([a-z][a-z\d+.-]*):\/\//i;

// What ends the host and port of an http or https URL. The URL parser reads a backslash as a slash.
const AUTHORITY_END = /[/?#\\]/;

// The host parser would drop white space rather than fail, and so turn a typo into another name.
const WHITE_SPACE = /\s/;

// A DNS label: letters, digits and hyphens, 1 to 63 of them, with no hyphen at either end.
const DNS_LABEL = /^(?!-)[a-z\d-]{1,63}(?<!-)$/;
const MAX_DNS_NAME = 253;

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
  const end = rest.search(AUTHORITY_END);
  return {
    prefix,
    scheme: match?.[1]?.toLowerCase(),
    authority: end === -1 ? rest : rest.slice(0, end),
    tail: end === -1 ? '' : rest.slice(end),
  };
}

// What an error may quote of an entry: its scheme and host, but neither a user name and password
// before the host nor anything after it but a lone slash, because a connector URL pasted by mistake
// carries the token there. The host is cut at a percent sign too, which can encode a slash.
function shown({ prefix, authority, tail }: Parts): string {
  const at = authority.lastIndexOf('@');
  const user = at === -1 ? '' : '…@';
  const host = authority.slice(at + 1);
  const percent = host.indexOf('%');
  const name = percent === -1 ? host : `${host.slice(0, percent)}…`;
  const after = tail === '' || tail === '/' ? tail : `${tail.charAt(0)}…`;
  return `${prefix}${user}${name}${after}`;
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

// The host and the port text of an authority. An IPv6 address is in brackets, so its colons are
// not taken for the port's; without a closing bracket, all of it is the host, which is refused.
function hostAndPort(authority: string): { host: string; port: string | undefined } {
  const bracket = authority.startsWith('[') ? authority.indexOf(']') : 0;
  if (bracket === -1) {
    return { host: authority, port: undefined };
  }
  const colon = authority.indexOf(':', bracket);
  return colon === -1
    ? { host: authority, port: undefined }
    : { host: authority.slice(0, colon), port: authority.slice(colon + 1) };
}

// The port as a number, NaN for one that is not a whole number from 1 to 65535.
function portNumber(text: string): number {
  return /^\d{1,5}$/.test(text) && Number(text) >= 1 && Number(text) <= MAX_PORT
    ? Number(text)
    : Number.NaN;
}

// The host as a Host header names it, or undefined when no client could send it as it was written.
// The host parser writes a name in lower case and in punycode, and an IPv6 address in its short
// form. It also rewrites the short and octal forms of an IPv4 address, such as 192.0.2, which a
// client sends as written, so an address must come back unchanged. One trailing dot, which the
// parser keeps, names the same host as none.
function canonicalHost(host: string): string | undefined {
  const parsed = domainToASCII(host);
  if (host.startsWith('[')) {
    return parsed === '' ? undefined : parsed;
  }
  if (isIPv4(parsed)) {
    return host.replace(/[.。]$/u, '') === parsed ? parsed : undefined;
  }
  const name = parsed.endsWith('.') ? parsed.slice(0, -1) : parsed;
  const labels = name.split('.');
  return name.length <= MAX_DNS_NAME && labels.every((label) => DNS_LABEL.test(label))
    ? name
    : undefined;
}

// One entry as a Host header names it: in lower case, with an IPv6 address in brackets, and with
// its port unless that is 80 or 443. An entry may be a host (abc.ngrok.app), a host:port, or an
// http or https URL with nothing after the host but a slash. The host must be a DNS name, an IPv4
// address or an IPv6 address in brackets. Anything that could not match a Host header as it was
// written is refused rather than stored: a path, a query, a fragment, a user name or password, a
// wildcard, which the list never implies, a percent-encoded character and port 0. So is a plain
// http URL without a port other than 80 or 443, because a host without a port lets only https
// pages in. `source`, the variable or flag the entry came from, starts the message of a refusal
// when given.
export function normalizeHostEntry(entry: string, source?: string): string {
  const parts = split(entry.trim());
  const refused = (problem?: string): TvMcpError =>
    new TvMcpError(
      'INVALID_INPUT',
      `${source === undefined ? '' : `${source}: `}${JSON.stringify(shown(parts))} is not a ` +
        `host name${problem === undefined ? '' : `: ${problem}`}`,
      { hint: ALLOWED_HOSTS_HINT },
    );
  const { scheme, authority, tail } = parts;

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
  if (authority.includes('%')) {
    throw refused('write it without percent-encoding');
  }
  const { host, port: portText } = hostAndPort(authority);
  if (!host.startsWith('[') && portText?.includes(':') === true) {
    throw refused('put an IPv6 address in brackets');
  }
  const port = portText === undefined ? undefined : portNumber(portText);
  if (Number.isNaN(port)) {
    throw refused('its port must be a whole number from 1 to 65535');
  }
  const name = WHITE_SPACE.test(host) ? undefined : canonicalHost(host);
  if (name === undefined) {
    throw refused();
  }
  const explicit = port === undefined || DEFAULT_PORTS.has(port) ? undefined : port;
  if (scheme === 'http' && explicit === undefined) {
    throw refused(
      'plain http needs a port other than 80 or 443, so give the host alone for an https tunnel',
    );
  }
  return explicit === undefined ? name : `${name}:${String(explicit)}`;
}
