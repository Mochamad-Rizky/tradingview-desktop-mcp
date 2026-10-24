import { proxiedOrigin } from './dev-proxy.ts';

const TARGET = 'http://127.0.0.1:8787';

test("the dev proxy gives the server's own Origin to the dev page and to a request without one", () => {
  expect(proxiedOrigin(undefined, 'localhost:5173', TARGET)).toBe(TARGET);
  expect(proxiedOrigin('http://localhost:5173', 'localhost:5173', TARGET)).toBe(TARGET);
  expect(proxiedOrigin('http://127.0.0.1:5173', '127.0.0.1:5173', TARGET)).toBe(TARGET);
});

// The server refuses a page of another origin, through the dev proxy as without it.
test('the dev proxy passes any other Origin on as it is', () => {
  for (const origin of [
    'http://evil.example',
    'http://localhost:3000',
    'https://localhost:5173',
    'http://localhost:5173.evil.example',
    'null',
  ]) {
    expect(proxiedOrigin(origin, 'localhost:5173', TARGET), origin).toBe(origin);
  }
  expect(proxiedOrigin('http://localhost:5173', undefined, TARGET)).toBe('http://localhost:5173');
});
