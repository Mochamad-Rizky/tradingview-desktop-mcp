import type { APIResponse } from '@playwright/test';
import { SECURITY_HEADERS } from './fixtures.mjs';
import { expect, signIn, test } from './support.ts';

// The token screen: the dashboard shows nothing of the server before it has the token, takes it
// from the form or from a #token= link, and goes back to the form when the server refuses it.

test.describe('the token screen', () => {
  test(
    'comes first, and a pasted token with spaces around it opens the dashboard',
    { tag: '@real' },
    async ({ page, server }) => {
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Connect to the server' })).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);

      await page.getByLabel('Access token').fill(`  ${server.token}  `);
      await page.getByRole('button', { name: 'Connect' }).click();

      await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
      await expect(page.getByRole('heading', { level: 1, name: 'Status' })).toBeVisible();
      // A boolean, so that a failure does not print the token.
      expect(page.url().includes(server.token), 'the address holds no token').toBe(false);
    },
  );

  test(
    'says a wrong token was not accepted and stays on the form',
    { tag: '@real' },
    async ({ page }) => {
      await page.goto('/log');
      await page.getByLabel('Access token').fill('wrong-token-00000000000000000000000000000000');
      await page.getByRole('button', { name: 'Connect' }).click();

      await expect(page.getByRole('alert')).toHaveText('That token was not accepted.');
      await expect(page.getByLabel('Access token')).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
      expect(await page.evaluate(() => sessionStorage.getItem('tvmcp.token'))).toBeNull();
    },
  );

  test(
    'takes the token from the URL fragment and removes it from the address',
    { tag: '@real' },
    async ({ page, server }) => {
      await page.goto(`/log?origin=mcp#token=${encodeURIComponent(server.token)}`);

      await expect(page.getByRole('heading', { level: 1, name: 'Live log' })).toBeVisible();
      await expect(page.getByLabel('Access token')).toHaveCount(0);
      const url = new URL(page.url());
      expect(url.pathname).toBe('/log');
      expect(url.search).toBe('?origin=mcp');
      expect(url.hash).toBe('');
    },
  );

  test('returns when the server stops accepting the token', async ({ page, server, mock }) => {
    await signIn(page, server);
    await expect(page.getByRole('heading', { level: 1, name: 'Status' })).toBeVisible();

    // The server restarted with another TV_MCP_AUTH_TOKEN: the next check gets a 401.
    await mock.setToken('e2e-token-of-the-next-start-0000000000000000');
    await page.getByRole('button', { name: 'Check now' }).click();

    await expect(page.getByRole('heading', { name: 'Connect to the server' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveText('That token was not accepted.');
  });
});

// The headers of `response` that `expected` names, with their names in lower case as they come.
function headersOf(
  response: APIResponse,
  expected: Record<string, string>,
): Record<string, string | undefined> {
  const headers = response.headers();
  return Object.fromEntries(
    Object.keys(expected).map((name) => [name.toLowerCase(), headers[name.toLowerCase()]]),
  );
}

function lowerCaseNames(expected: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(expected).map(([name, value]) => [name.toLowerCase(), value]),
  );
}

// Runs against the mock and the real server alike, with the same expected headers: a change to the
// server's headers that the mock does not follow fails here.
test.describe('the server', () => {
  test(
    'serves the files with every security header, and the API and MCP only with the token',
    { tag: '@real' },
    async ({ request, server }) => {
      const page = await request.get('/log', { headers: { Accept: 'text/html' } });
      expect(page.status()).toBe(200);
      const pageHeaders = {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      };
      expect(headersOf(page, pageHeaders)).toEqual(lowerCaseNames(pageHeaders));
      const html = await page.text();
      expect(html).toContain('<div id="root"></div>');

      const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
      expect(script, 'the page loads a script of the build').toBeDefined();
      const asset = await request.get(script ?? '');
      expect(asset.status()).toBe(200);
      const assetHeaders = {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=31536000, immutable',
      };
      expect(headersOf(asset, assetHeaders)).toEqual(lowerCaseNames(assetHeaders));

      const absent = await request.get('/assets/absent.js');
      expect(absent.status()).toBe(404);
      const absentHeaders = {
        ...SECURITY_HEADERS,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      };
      expect(headersOf(absent, absentHeaders)).toEqual(lowerCaseNames(absentHeaders));

      const refusedHeaders = { 'WWW-Authenticate': 'Bearer', 'Cache-Control': 'no-store' };
      const missing = await request.get('/api/info');
      expect(missing.status()).toBe(401);
      expect(headersOf(missing, refusedHeaders)).toEqual(lowerCaseNames(refusedHeaders));

      const inQuery = await request.get(`/api/info?token=${server.token}`, {
        headers: { Authorization: `Bearer ${server.token}` },
      });
      expect(inQuery.status()).toBe(401);

      const mcp = await request.post('/mcp', { data: {} });
      expect(mcp.status()).toBe(401);
      expect(headersOf(mcp, refusedHeaders)).toEqual(lowerCaseNames(refusedHeaders));

      const allowed = await request.get('/api/info', {
        headers: { Authorization: `Bearer ${server.token}` },
      });
      expect(allowed.status()).toBe(200);
      expect(allowed.headers()['cache-control']).toBe('no-store');
      // A boolean, so that a failure does not print the token.
      expect((await allowed.text()).includes(server.token), 'the answer holds no token').toBe(
        false,
      );
    },
  );
});
