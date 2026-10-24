import { timingSafeEqual } from 'node:crypto';
import {
  allowedHostsFor,
  allowedOriginsFor,
  bearerToken,
  isAllowedHost,
  isAllowedOrigin,
  tokenMatches,
} from '../../../src/transports/http-security.js';

// The real comparison runs; the wrapper only records what it was given.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

afterEach(() => {
  vi.mocked(timingSafeEqual).mockClear();
});

// What a server bound to 127.0.0.1:8787 answers to.
const HOSTS = ['127.0.0.1:8787', 'localhost:8787', '[::1]:8787'];
// The pages such a server serves itself, over either scheme.
const ORIGINS = [
  'http://127.0.0.1:8787',
  'https://127.0.0.1:8787',
  'http://localhost:8787',
  'https://localhost:8787',
  'http://[::1]:8787',
  'https://[::1]:8787',
];

test('tokenMatches compares in constant time and rejects length mismatches', () => {
  expect(tokenMatches('test-token', 'test-token')).toBe(true);
  // The guess differs from the token only in its last character.
  expect(tokenMatches('test-tokeN', 'test-token')).toBe(false);
  expect(tokenMatches('test', 'test-token')).toBe(false);
  expect(tokenMatches('test-token-and-more', 'test-token')).toBe(false);

  // Every decision is made by the constant-time comparison, over inputs of one length whatever
  // the length of the guess, so it can neither throw nor take longer for a closer guess.
  const calls = vi.mocked(timingSafeEqual).mock.calls;
  expect(calls).toHaveLength(4);
  for (const [left, right] of calls) {
    expect(left.byteLength).toBe(right.byteLength);
  }
});

test('tokenMatches rejects a missing token', () => {
  expect(tokenMatches(undefined, 'test-token')).toBe(false);
});

test('tokenMatches never accepts anything when the expected token is blank', () => {
  expect(tokenMatches('', '')).toBe(false);
});

test('isAllowedOrigin accepts missing and loopback origins and rejects foreign ones', () => {
  // Clients that are not browsers send no Origin.
  expect(isAllowedOrigin(undefined, ORIGINS)).toBe(true);
  expect(isAllowedOrigin('http://127.0.0.1:8787', ORIGINS)).toBe(true);
  expect(isAllowedOrigin('http://localhost:8787', ORIGINS)).toBe(true);
  expect(isAllowedOrigin('http://[::1]:8787', ORIGINS)).toBe(true);
  expect(isAllowedOrigin('HTTP://LOCALHOST:8787', ORIGINS)).toBe(true);

  expect(isAllowedOrigin('https://evil.example', ORIGINS)).toBe(false);
  // A page whose name was rebound to 127.0.0.1 keeps its own origin.
  expect(isAllowedOrigin('http://evil.example:8787', ORIGINS)).toBe(false);
  // Another site on this machine is another origin.
  expect(isAllowedOrigin('http://127.0.0.1:9999', ORIGINS)).toBe(false);
  // Sandboxed frames and local files send "null".
  expect(isAllowedOrigin('null', ORIGINS)).toBe(false);
  expect(isAllowedOrigin('', ORIGINS)).toBe(false);
  expect(isAllowedOrigin('chrome-extension://abcdef', ORIGINS)).toBe(false);
  // Only web pages are let in, so the host alone is not enough.
  expect(isAllowedOrigin('ftp://localhost:8787', ORIGINS)).toBe(false);
});

test('isAllowedHost rejects rebinding hosts like evil.example:8787', () => {
  expect(isAllowedHost('evil.example:8787', HOSTS)).toBe(false);
  expect(isAllowedHost('127.0.0.1.evil.example:8787', HOSTS)).toBe(false);

  expect(isAllowedHost('127.0.0.1:8787', HOSTS)).toBe(true);
  expect(isAllowedHost('localhost:8787', HOSTS)).toBe(true);
  expect(isAllowedHost('[::1]:8787', HOSTS)).toBe(true);
  expect(isAllowedHost('LocalHost:8787', HOSTS)).toBe(true);
});

test('isAllowedHost rejects a missing host and a host for another port', () => {
  expect(isAllowedHost(undefined, HOSTS)).toBe(false);
  expect(isAllowedHost('', HOSTS)).toBe(false);
  expect(isAllowedHost('localhost', HOSTS)).toBe(false);
  expect(isAllowedHost('localhost:9999', HOSTS)).toBe(false);
});

test('allowedHostsFor lists the loopback names and the configured host with the bound port', () => {
  expect(allowedHostsFor('127.0.0.1', 8787).sort()).toEqual(
    ['127.0.0.1:8787', '[::1]:8787', 'localhost:8787'].sort(),
  );
  expect(allowedHostsFor('MyMac.local', 9000).sort()).toEqual(
    ['127.0.0.1:9000', '[::1]:9000', 'localhost:9000', 'mymac.local:9000'].sort(),
  );
});

test('allowedHostsFor brackets an IPv6 address like a Host header does', () => {
  expect(allowedHostsFor('::1', 8787).sort()).toEqual(
    ['127.0.0.1:8787', '[::1]:8787', 'localhost:8787'].sort(),
  );
  expect(allowedHostsFor('fe80::1', 8787)).toContain('[fe80::1]:8787');
});

test('allowedOriginsFor lists the loopback names and the configured host over http and https', () => {
  expect(allowedOriginsFor('127.0.0.1', 8787).sort()).toEqual([...ORIGINS].sort());
  expect(allowedOriginsFor('MyMac.local', 9000)).toEqual(
    expect.arrayContaining(['http://mymac.local:9000', 'https://mymac.local:9000']),
  );
  expect(allowedOriginsFor('fe80::1', 8787)).toContain('http://[fe80::1]:8787');
});

// Extra hosts come normalised from the configuration: lower case, and a port only when it is not
// the default one.
test('allowedHostsFor adds an extra host for no port, :443 and :80, and an extra host:port exactly', () => {
  const hosts = allowedHostsFor('127.0.0.1', 8787, ['abc.ngrok.app', 'mymac.local:8443']);

  expect(hosts.sort()).toEqual(
    [...HOSTS, 'abc.ngrok.app', 'abc.ngrok.app:443', 'abc.ngrok.app:80', 'mymac.local:8443'].sort(),
  );
  // A tunnel forwards to the bound port, but its clients name the tunnel's own port.
  expect(isAllowedHost('abc.ngrok.app:8787', hosts)).toBe(false);
  expect(isAllowedHost('mymac.local', hosts)).toBe(false);
  expect(isAllowedHost('mymac.local:443', hosts)).toBe(false);
  expect(isAllowedHost('ABC.ngrok.app', hosts)).toBe(true);
  // Only the exact name: a wildcard is never implied.
  expect(isAllowedHost('x.abc.ngrok.app', hosts)).toBe(false);
  expect(isAllowedHost('abc.ngrok.app.evil.example', hosts)).toBe(false);
});

test('allowedHostsFor without extra hosts is unchanged', () => {
  expect(allowedHostsFor('127.0.0.1', 8787, []).sort()).toEqual(
    allowedHostsFor('127.0.0.1', 8787).sort(),
  );
});

test('isAllowedOrigin accepts https://<extra host>, and http:// only for an extra host:port', () => {
  const origins = allowedOriginsFor('127.0.0.1', 8787, [
    'abc.ngrok.app',
    'mymac.local:8443',
    '[2001:db8::1]',
  ]);

  expect(isAllowedOrigin('https://abc.ngrok.app', origins)).toBe(true);
  expect(isAllowedOrigin('https://ABC.ngrok.app:443', origins)).toBe(true);
  expect(isAllowedOrigin('https://[2001:db8::1]', origins)).toBe(true);
  expect(isAllowedOrigin('https://mymac.local:8443', origins)).toBe(true);
  expect(isAllowedOrigin('http://mymac.local:8443', origins)).toBe(true);
  // The loopback pages keep working next to extra hosts.
  expect(isAllowedOrigin('http://localhost:8787', origins)).toBe(true);

  // Plain http only for a host given with its port.
  expect(isAllowedOrigin('http://abc.ngrok.app', origins)).toBe(false);
  expect(isAllowedOrigin('http://abc.ngrok.app:80', origins)).toBe(false);
  expect(isAllowedOrigin('http://abc.ngrok.app:443', origins)).toBe(false);
  expect(isAllowedOrigin('https://abc.ngrok.app:80', origins)).toBe(false);
  expect(isAllowedOrigin('https://abc.ngrok.app:8443', origins)).toBe(false);
  expect(isAllowedOrigin('https://mymac.local', origins)).toBe(false);
  expect(isAllowedOrigin('https://x.abc.ngrok.app', origins)).toBe(false);
  expect(isAllowedOrigin('https://evil.example', origins)).toBe(false);
  expect(isAllowedOrigin('wss://abc.ngrok.app', origins)).toBe(false);
});

test.each([
  ['Bearer test-token', 'test-token'],
  ['bearer test-token', 'test-token'],
  ['BEARER   test-token  ', 'test-token'],
])('bearerToken reads the token of %j', (header, token) => {
  expect(bearerToken(header)).toBe(token);
});

test.each([[undefined], [''], ['Basic dGVzdDp0ZXN0'], ['Bearer'], ['Bearer '], ['Bearer a b']])(
  'bearerToken finds no token in %j',
  (header) => {
    expect(bearerToken(header)).toBeUndefined();
  },
);
