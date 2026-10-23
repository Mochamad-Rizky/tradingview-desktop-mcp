import { clearToken, readToken, storeToken, takeTokenFromLocation } from './token';

function visit(url: string): void {
  window.history.replaceState(null, '', url);
}

afterEach(() => {
  visit('/');
});

test('storeToken trims, readToken reads it back and clearToken removes it', () => {
  expect(readToken()).toBeNull();
  storeToken('  \tsecret-1\n');
  expect(sessionStorage.getItem('tvmcp.token')).toBe('secret-1');
  expect(readToken()).toBe('secret-1');
  clearToken();
  expect(readToken()).toBeNull();
  expect(sessionStorage.getItem('tvmcp.token')).toBeNull();

  // A blank token is no token: it clears the stored one.
  storeToken('secret-2');
  storeToken(' \n ');
  expect(readToken()).toBeNull();
});

test('a token in the fragment is taken whole, and the path and the query stay', () => {
  // A plus sign is part of the token, not a space, and an escape is decoded.
  visit('/log?origin=mcp#view=table&token=%20ab+c%2Fd%0A&x=1');
  expect(takeTokenFromLocation()).toBe('ab+c/d');
  expect(readToken()).toBe('ab+c/d');
  expect(window.location.pathname).toBe('/log');
  expect(window.location.search).toBe('?origin=mcp');
  expect(window.location.hash).toBe('');
  expect(window.location.href).not.toContain('ab+c');
});

test('a malformed escape in the fragment is kept as it is', () => {
  visit('/#token=abc%zz');
  expect(takeTokenFromLocation()).toBe('abc%zz');
});

test('an address without a token in its fragment is left alone', () => {
  visit('/tools#section');
  expect(takeTokenFromLocation()).toBeNull();
  expect(window.location.hash).toBe('#section');
  expect(readToken()).toBeNull();
});

test('a blank token in the fragment is removed from the address and not stored', () => {
  storeToken('earlier');
  visit('/#token=%20%20');
  expect(takeTokenFromLocation()).toBeNull();
  expect(window.location.hash).toBe('');
  expect(readToken()).toBe('earlier');
});

test('the token is kept for the page when the browser refuses storage', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  });
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  });
  storeToken(' kept-in-memory ');
  expect(readToken()).toBe('kept-in-memory');
  clearToken();
  expect(readToken()).toBeNull();
});

test('a token the browser would not write is read from memory, before an older stored one', () => {
  // Some private windows read storage but refuse to write to it.
  sessionStorage.setItem('tvmcp.token', 'from-an-earlier-session');
  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  });
  storeToken('entered-now');
  expect(readToken()).toBe('entered-now');
  // The older token is gone too, so that a reload asks again rather than send it.
  expect(sessionStorage.getItem('tvmcp.token')).toBeNull();

  // Once the browser writes again, storage holds the token and memory lets go of its copy.
  setItem.mockRestore();
  storeToken('stored');
  expect(sessionStorage.getItem('tvmcp.token')).toBe('stored');
  expect(readToken()).toBe('stored');
  clearToken();
  expect(readToken()).toBeNull();
});
