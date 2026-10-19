import { timingSafeEqual } from 'node:crypto';
import {
  allowedHostsFor,
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
  expect(isAllowedOrigin(undefined, HOSTS)).toBe(true);
  expect(isAllowedOrigin('http://127.0.0.1:8787', HOSTS)).toBe(true);
  expect(isAllowedOrigin('http://localhost:8787', HOSTS)).toBe(true);
  expect(isAllowedOrigin('http://[::1]:8787', HOSTS)).toBe(true);
  expect(isAllowedOrigin('HTTP://LOCALHOST:8787', HOSTS)).toBe(true);

  expect(isAllowedOrigin('https://evil.example', HOSTS)).toBe(false);
  // A page whose name was rebound to 127.0.0.1 keeps its own origin.
  expect(isAllowedOrigin('http://evil.example:8787', HOSTS)).toBe(false);
  // Another site on this machine is another origin.
  expect(isAllowedOrigin('http://127.0.0.1:9999', HOSTS)).toBe(false);
  // Sandboxed frames and local files send "null".
  expect(isAllowedOrigin('null', HOSTS)).toBe(false);
  expect(isAllowedOrigin('', HOSTS)).toBe(false);
  expect(isAllowedOrigin('chrome-extension://abcdef', HOSTS)).toBe(false);
  // Only web pages are let in, so the host alone is not enough.
  expect(isAllowedOrigin('ftp://localhost:8787', HOSTS)).toBe(false);
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
