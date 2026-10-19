import { stripVTControlCharacters } from 'node:util';
import { renderBanner } from '../../../src/cli/banner.js';

const STDIO = { version: '9.9.9', transport: 'stdio', cdp: 'http://127.0.0.1:9222' };
const HTTP = {
  version: '9.9.9',
  transport: 'http',
  endpoint: 'http://127.0.0.1:8787/mcp',
  cdp: 'http://127.0.0.1:9222',
};

test('renderBanner names the server, its version, the transport and the debug port', () => {
  const text = renderBanner(STDIO, { color: false });

  expect(text).toContain('tradingview-desktop-mcp');
  expect(text).toContain('9.9.9');
  expect(text).toMatch(/transport +stdio/);
  expect(text).toMatch(/cdp +http:\/\/127\.0\.0\.1:9222/);
  // A stdio server has no endpoint to show.
  expect(text).not.toContain('endpoint');
  expect(text.endsWith('\n')).toBe(true);
});

test('renderBanner shows the endpoint of an HTTP server', () => {
  const text = renderBanner(HTTP, { color: false });

  expect(text).toMatch(/transport +http/);
  expect(text).toMatch(/endpoint +http:\/\/127\.0\.0\.1:8787\/mcp/);
});

test('renderBanner adds colors only when asked, and says the same either way', () => {
  const colored = renderBanner(HTTP, { color: true });
  const plain = renderBanner(HTTP, { color: false });

  expect(colored).toContain('\u001b[');
  expect(plain).not.toContain('\u001b[');
  expect(stripVTControlCharacters(colored)).toBe(plain);
});
