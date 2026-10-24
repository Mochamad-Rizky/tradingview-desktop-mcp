import { createHash, timingSafeEqual } from 'node:crypto';
import { isIPv6 } from 'node:net';

// The checks that stand between the network and a server that can drive the logged-in app. The
// token proves the caller was given the secret. The Host and Origin checks stop a web page from
// reaching the server through the browser: a page whose name was rebound to 127.0.0.1 (DNS
// rebinding) still sends its own name as the Host, and any page sends its own Origin.

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function tokenMatches(provided: string | undefined, expected: string): boolean {
  // A blank secret would let a blank guess in. The configuration never yields one; this holds
  // for any other caller too.
  if (provided === undefined || expected === '') {
    return false;
  }
  // The digests always have the same length, so the comparison takes as long for any guess and
  // never throws. Comparing the lengths first would tell an attacker how long the token is.
  return timingSafeEqual(digest(provided), digest(expected));
}

// The names of the server on this machine: each loopback name and the configured host, with the
// port it is bound to. A client always names the port, because the server never runs on port 80.
function ownHosts(httpHost: string, port: number): string[] {
  const configured = isIPv6(httpHost) ? `[${httpHost}]` : httpHost.toLowerCase();
  const names = new Set([...LOOPBACK_HOSTS, configured]);
  return [...names].map((name) => `${name}:${String(port)}`);
}

// Whether a normalised extra host names its port. One that does not was given without one, or
// with 80 or 443, the ports a client leaves out. An IPv6 address keeps its colons in brackets.
function hasPort(extra: string): boolean {
  return /:\d+$/.test(extra);
}

// The Host header values of the server: its own names, and the extra hosts it was given, such as a
// tunnel's public host. `extra` holds them normalised, as Config.allowedHosts does. A tunnel sends
// the Host its client named: for an extra host without a port that is the host alone, or with the
// default port of https or http; an extra host:port is matched exactly.
export function allowedHostsFor(
  httpHost: string,
  port: number,
  extra: readonly string[] = [],
): string[] {
  const names = new Set(ownHosts(httpHost, port));
  for (const host of extra) {
    const values = hasPort(host) ? [host] : [host, `${host}:443`, `${host}:80`];
    for (const value of values) {
      names.add(value);
    }
  }
  return [...names];
}

// The origins of the pages the server may have served: its own names over http and https, the
// extra hosts over https, and over plain http only an extra host given with its port, such as a
// name on the local network. A host without a port is a tunnel's, and a tunnel serves https.
export function allowedOriginsFor(
  httpHost: string,
  port: number,
  extra: readonly string[] = [],
): string[] {
  const origins = new Set<string>();
  for (const host of ownHosts(httpHost, port)) {
    origins.add(`http://${host}`);
    origins.add(`https://${host}`);
  }
  for (const host of extra) {
    origins.add(`https://${host}`);
    if (hasPort(host)) {
      origins.add(`http://${host}`);
    }
  }
  return [...origins];
}

export function isAllowedHost(host: string | undefined, allowedHosts: readonly string[]): boolean {
  if (host === undefined) {
    return false;
  }
  const wanted = host.toLowerCase();
  return allowedHosts.some((allowed) => allowed.toLowerCase() === wanted);
}

// A request without an Origin comes from a program, not from a web page, and the token guards it.
// A page may only call in when it was served by this server itself (the dashboard), under one of
// the names in `allowedOrigins`: a page from any other origin, even one on this machine, is another
// site to the browser.
export function isAllowedOrigin(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (origin === undefined) {
    return true;
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    // Includes "null", which sandboxed frames and local files send.
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false;
  }
  // The parser writes the scheme and host in lower case and leaves out the default port, as the
  // allowed origins are written.
  const wanted = url.origin;
  return allowedOrigins.some((allowed) => allowed.toLowerCase() === wanted);
}

// RFC 7235 makes the scheme name case-insensitive. A token never contains white space, so a header
// with more than one word after the scheme carries no token.
const BEARER = /^bearer\s+(\S+)\s*$/i;

export function bearerToken(authorization: string | undefined): string | undefined {
  return BEARER.exec(authorization ?? '')?.[1];
}
