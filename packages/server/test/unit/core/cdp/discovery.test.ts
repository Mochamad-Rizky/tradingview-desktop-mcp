import { debugPortEndpoint } from '../../../../src/core/cdp/discovery.js';

// The health report and every discovery error show this address, so it must be one a user can
// paste into a browser, whichever loopback host the configuration names.
test.each([
  ['127.0.0.1', 9222, 'http://127.0.0.1:9222'],
  ['localhost', 9333, 'http://localhost:9333'],
  ['::1', 9222, 'http://[::1]:9222'],
])('debugPortEndpoint(%s, %d) is %s', (host, port, expected) => {
  expect(debugPortEndpoint(host, port)).toBe(expected);
});
