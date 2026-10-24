import { ALLOWED_HOSTS_HINT, normalizeHostEntry } from '../../../src/config/hosts.js';
import { TvMcpError } from '../../../src/core/errors.js';

// Returns the error, so a test can check its code, message and hint together.
function refusal(entry: string): TvMcpError {
  try {
    normalizeHostEntry(entry);
  } catch (error) {
    if (error instanceof TvMcpError) {
      return error;
    }
    throw error;
  }
  throw new Error(`expected ${JSON.stringify(entry)} to be refused`);
}

test('the hint shows the expected form', () => {
  expect(ALLOWED_HOSTS_HINT).toBe(
    'TV_MCP_ALLOWED_HOSTS takes host names such as abc.ngrok.app, comma-separated',
  );
});

test.each([
  ['a host', 'abc.ngrok.app', 'abc.ngrok.app'],
  ['a host with a trailing slash', 'abc.ngrok.app/', 'abc.ngrok.app'],
  ['a host:port', 'mymac.local:8443', 'mymac.local:8443'],
  ['an https URL', 'https://abc.ngrok.app', 'abc.ngrok.app'],
  ['an https URL with a trailing slash', 'https://abc.ngrok.app/', 'abc.ngrok.app'],
  ['an https URL with a port', 'https://abc.ngrok.app:8443/', 'abc.ngrok.app:8443'],
  ['an http URL with a port', 'http://mymac.local:8787', 'mymac.local:8787'],
  ['upper case', 'https://Abc.Ngrok.APP/', 'abc.ngrok.app'],
  ['an upper-case scheme', 'HTTPS://abc.ngrok.app', 'abc.ngrok.app'],
  ['surrounding spaces', '  abc.ngrok.app  ', 'abc.ngrok.app'],
  ['an IPv6 address in brackets', '[2001:DB8::1]', '[2001:db8::1]'],
  ['an IPv6 address in brackets with a port', '[2001:db8::1]:8443', '[2001:db8::1]:8443'],
  ['an IPv4 address with a port', '192.0.2.10:8787', '192.0.2.10:8787'],
  // The default ports are what a client leaves out of the Host header, and a host without a port
  // already matches them.
  ['a host with port 443', 'abc.ngrok.app:443', 'abc.ngrok.app'],
  ['a host with port 80', 'abc.ngrok.app:80', 'abc.ngrok.app'],
  ['an https URL with port 443', 'https://abc.ngrok.app:443/', 'abc.ngrok.app'],
  // A fully qualified name ends with a dot, which names the same host as none.
  ['a trailing dot', 'ABC.ngrok.app.', 'abc.ngrok.app'],
  ['an ideographic trailing dot', 'abc.ngrok.app\u3002', 'abc.ngrok.app'],
  ['a trailing dot before the port', 'abc.ngrok.app.:8443', 'abc.ngrok.app:8443'],
  // A client sends a name in other scripts as punycode, and an IPv6 address in its short form.
  ['a name in another script', 'b\u00FCcher.example', 'xn--bcher-kva.example'],
  ['a long IPv6 address', '[2001:DB8:0:0::1]', '[2001:db8::1]'],
  ['a name of one label', 'localhost:8443', 'localhost:8443'],
  ['a port with a leading zero', 'mymac.local:08443', 'mymac.local:8443'],
])('normalizeHostEntry accepts %s', (_case, entry, expected) => {
  expect(normalizeHostEntry(entry)).toBe(expected);
});

// `shown` is what the message quotes of the entry: never what follows the host, nor a user name and
// password before it, because a copied connector URL carries the token there.
test.each([
  ['a path', 'https://abc.ngrok.app/mcp', 'path', 'https://abc.ngrok.app/…'],
  ['a path after a host', 'abc.ngrok.app/mcp/', 'path', 'abc.ngrok.app/…'],
  ['a query', 'https://abc.ngrok.app/?token=x', 'query', 'https://abc.ngrok.app/…'],
  ['an empty query', 'abc.ngrok.app?', 'query', 'abc.ngrok.app?…'],
  ['a fragment', 'https://abc.ngrok.app/#top', 'fragment', 'https://abc.ngrok.app/…'],
  ['a wildcard', '*.ngrok.app', 'wildcard', '*.ngrok.app'],
  ['a wildcard in a URL', 'https://*.ngrok.app', 'wildcard', 'https://*.ngrok.app'],
  [
    'credentials in a URL',
    'https://user:secret@abc.ngrok.app',
    'user name or password',
    'https://…@abc.ngrok.app',
  ],
  ['a user name before a host', 'user@abc.ngrok.app', 'user name or password', '…@abc.ngrok.app'],
  ['an empty entry', '', 'empty', ''],
  ['a blank entry', '   ', 'empty', ''],
  // A host without a port lets only https pages in, so an http URL on a default port could never
  // do what it says.
  ['an http URL without a port', 'http://abc.ngrok.app', 'plain http', 'http://abc.ngrok.app'],
  [
    'an http URL with port 80',
    'http://abc.ngrok.app:80/',
    'plain http',
    'http://abc.ngrok.app:80/',
  ],
  [
    'an http URL with port 443',
    'http://abc.ngrok.app:443',
    'plain http',
    'http://abc.ngrok.app:443',
  ],
  ['another scheme', 'ftp://abc.ngrok.app', 'https URL', 'ftp://abc.ngrok.app'],
  ['a space inside', 'abc ngrok.app', 'not a host name', 'abc ngrok.app'],
  ['a tab inside', 'abc\tngrok.app', 'not a host name', 'abc\tngrok.app'],
  ['an IPv6 address without brackets', '2001:db8::1', 'brackets', '2001:db8::1'],
  ['a port out of range', 'abc.ngrok.app:99999', 'port', 'abc.ngrok.app:99999'],
  // The parser of a URL reads a backslash as a slash.
  ['a backslash', 'abc.ngrok.app\\x', 'path', 'abc.ngrok.app\\…'],
  ['a backslash in a URL', 'https://abc.ngrok.app\\mcp', 'path', 'https://abc.ngrok.app\\…'],
  // Each of these would be stored and then never match a Host header.
  ['a leading dot', '.ngrok.app', 'not a host name', '.ngrok.app'],
  ['a semicolon between hosts', 'a.example;b.example', 'not a host name', 'a.example;b.example'],
  ['a comma alone', ',', 'not a host name', ','],
  ['two trailing dots', 'abc.ngrok.app..', 'not a host name', 'abc.ngrok.app..'],
  ['an empty label', 'abc..ngrok.app', 'not a host name', 'abc..ngrok.app'],
  ['a label that starts with a hyphen', '-abc.ngrok.app', 'not a host name', '-abc.ngrok.app'],
  ['a label that ends with a hyphen', 'abc-.ngrok.app', 'not a host name', 'abc-.ngrok.app'],
  ['an underscore', 'a_b.example', 'not a host name', 'a_b.example'],
  [
    'a label of 64 characters',
    `${'a'.repeat(64)}.example`,
    'not a host name',
    `${'a'.repeat(64)}.example`,
  ],
  [
    'a name of 254 characters',
    `${'a'.repeat(63)}.`.repeat(4).slice(0, 254),
    'not a host name',
    `${'a'.repeat(63)}.`.repeat(4).slice(0, 254),
  ],
  ['a short form of an IPv4 address', '192.0.2', 'not a host name', '192.0.2'],
  ['an IPv4 address with a leading zero', '192.0.02.10', 'not a host name', '192.0.02.10'],
  ['a name that ends in a number', 'abc.123', 'not a host name', 'abc.123'],
  ['an invalid IPv6 address', '[2001:zz::1]', 'not a host name', '[2001:zz::1]'],
  ['an unclosed bracket', '[2001:db8::1', 'not a host name', '[2001:db8::1'],
  ['an IPv6 zone index', '[fe80::1%25en0]', 'percent', '[fe80::1…'],
  ['a percent-encoded wildcard', '%2A.ngrok.app', 'percent', '…'],
  ['port 0', 'abc.ngrok.app:0', 'port', 'abc.ngrok.app:0'],
  ['an empty port', 'abc.ngrok.app:', 'port', 'abc.ngrok.app:'],
  ['a port that is not a number', 'abc.ngrok.app:https', 'port', 'abc.ngrok.app:https'],
])('normalizeHostEntry refuses %s and says why', (_case, entry, problem, shown) => {
  const error = refusal(entry);

  expect(error.code).toBe('INVALID_INPUT');
  expect(error.message).toContain(problem);
  // The entry is quoted, so that the one at fault stands out in a list.
  expect(error.message).toContain(JSON.stringify(shown));
  expect(error.hint).toBe(ALLOWED_HOSTS_HINT);
});

test('a refused entry never shows the token of a copied connector URL', () => {
  const secret = 'Sekrit-0123456789abcdef';
  const entries = [
    `https://abc.ngrok.app/mcp/${secret}`,
    `https://abc.ngrok.app/mcp?token=${secret}`,
    `https://abc.ngrok.app/#token=${secret}`,
    `https://user:${secret}@abc.ngrok.app`,
    `https://${secret}@abc.ngrok.app/mcp`,
    `abc.ngrok.app/mcp/${secret}`,
    `*.ngrok.app/mcp/${secret}`,
    `https://abc.ngrok.app\\mcp\\${secret}`,
    `abc.ngrok.app\\${secret}`,
    `https://abc.ngrok.app\\?token=${secret}`,
    `https://abc.ngrok.app%2Fmcp%2F${secret}`,
    `abc.ngrok.app%2F${secret}`,
  ];

  for (const entry of entries) {
    const error = refusal(entry);
    expect(`${error.message}\n${error.hint ?? ''}`).not.toContain('Sekrit');
  }
});

test('a refusal starts with the variable or flag the entry came from, when it is given', () => {
  expect(() => normalizeHostEntry('https://abc.ngrok.app/mcp', '--url')).toThrow(
    '--url: "https://abc.ngrok.app/…" is not a host name: it has a path',
  );
  expect(() => normalizeHostEntry('abc ngrok.app')).toThrow(
    /^"abc ngrok\.app" is not a host name$/,
  );
});
