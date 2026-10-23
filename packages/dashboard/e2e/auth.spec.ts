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
      expect(page.url()).not.toContain(server.token);
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

test.describe('the server', () => {
  test(
    'serves the page without the token, with its security headers, and the API only with the Bearer header',
    { tag: '@real' },
    async ({ request, server }) => {
      const page = await request.get('/log', { headers: { Accept: 'text/html' } });
      expect(page.status()).toBe(200);
      expect(page.headers()['content-type']).toBe('text/html; charset=utf-8');
      expect(page.headers()['content-security-policy']).toContain("default-src 'self'");
      expect(page.headers()['x-frame-options']).toBe('DENY');
      expect(await page.text()).toContain('<div id="root"></div>');

      const missing = await request.get('/api/info');
      expect(missing.status()).toBe(401);
      expect(missing.headers()['www-authenticate']).toBe('Bearer');

      const inQuery = await request.get(`/api/info?token=${server.token}`, {
        headers: { Authorization: `Bearer ${server.token}` },
      });
      expect(inQuery.status()).toBe(401);

      const allowed = await request.get('/api/info', {
        headers: { Authorization: `Bearer ${server.token}` },
      });
      expect(allowed.status()).toBe(200);
      expect(allowed.headers()['cache-control']).toBe('no-store');
      expect(await allowed.text()).not.toContain(server.token);
    },
  );
});
