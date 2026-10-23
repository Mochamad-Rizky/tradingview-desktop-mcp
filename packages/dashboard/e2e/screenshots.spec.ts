import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { callRows, connectionBadge, expect, signIn, test } from './support.ts';

// The images of the README (pnpm docs:screenshots): the three pages of the dashboard against the
// mock server, so with synthetic data only, at 1280×800 in the light theme. Only the screenshots
// project runs this file.

const IMAGES = fileURLToPath(new URL('../../../docs/images/', import.meta.url));

// Takes the page without a focus ring or a hovered row, and only what fits in the window.
async function capture(page: Page, name: string): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: `${IMAGES}${name}`,
    fullPage: false,
    animations: 'disabled',
    caret: 'hide',
  });
}

test.describe('the README screenshots', { tag: '@screenshots' }, () => {
  test('the status page', async ({ page, server }) => {
    await signIn(page, server);
    await expect(connectionBadge(page)).toHaveText('TradingView ready');
    const limits = page.getByRole('region', { name: 'Plan limits' });
    await limits.getByRole('button', { name: 'Read plan limits' }).click();
    await expect(limits.getByRole('row', { name: /SAVED_PINE_SCRIPTS/ })).toBeVisible();
    await capture(page, 'dashboard-status.png');
  });

  test('the live log', async ({ page, server }) => {
    await signIn(page, server, '/log');
    await expect(page.getByRole('status', { name: 'Event stream' })).toHaveText('Live');
    await expect(callRows(page)).toHaveCount(11);
    await capture(page, 'dashboard-log.png');
  });

  test('the tools page', async ({ page, server }) => {
    await signIn(page, server, '/tools/chart_get_state');
    const article = page.getByRole('article', { name: 'Read the chart state' });
    await article.getByRole('button', { name: 'Run', exact: true }).click();
    const result = page.getByRole('region', { name: 'Result' });
    await expect(result.getByRole('status')).toHaveText('OK');
    // The run and its result, beside the list, which stays in place: the page scrolls to the run,
    // with a little room above its heading.
    await page.getByRole('heading', { name: 'Run by hand' }).evaluate((heading) => {
      heading.scrollIntoView({ block: 'start' });
      window.scrollBy(0, -24);
    });
    await capture(page, 'dashboard-tools.png');
  });
});
