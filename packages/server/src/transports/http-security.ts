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

// The Host header values of the server: each loopback name and the configured host, with the port
// it is bound to. A client always names the port, because the server never runs on port 80.
export function allowedHostsFor(httpHost: string, port: number): string[] {
  const configured = isIPv6(httpHost) ? `[${httpHost}]` : httpHost.toLowerCase();
  const names = new Set([...LOOPBACK_HOSTS, configured]);
  return [...names].map((name) => `${name}:${String(port)}`);
}

export function isAllowedHost(host: string | undefined, allowedHosts: string[]): boolean {
  if (host === undefined) {
    return false;
  }
  const wanted = host.toLowerCase();
  return allowedHosts.some((allowed) => allowed.toLowerCase() === wanted);
}

// A request without an Origin comes from a program, not from a web page, and the token guards it.
// A page may only call in when it was served by this server itself (the dashboard): a page from
// any other origin, even one on this machine, is another site to the browser.
export function isAllowedOrigin(origin: string | undefined, allowedHosts: string[]): boolean {
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
  return isAllowedHost(url.host, allowedHosts);
}

// RFC 7235 makes the scheme name case-insensitive. A token never contains white space, so a header
// with more than one word after the scheme carries no token.
const BEARER = /^bearer\s+(\S+)\s*$/i;

export function bearerToken(authorization: string | undefined): string | undefined {
  return BEARER.exec(authorization ?? '')?.[1];
}
