import type { Page } from '@playwright/test';
import { callRow, expect, expectQuietly, fact, signIn, test, textOf } from './support.ts';

// The tools page: the tools of the running profile, to search, read and run by hand.

function toolArticle(page: Page, title: string) {
  return page.getByRole('article', { name: title });
}

function resultRegion(page: Page) {
  return page.getByRole('region', { name: 'Result' });
}

test(
  'the search finds a tool, and opening it shows what it does and takes',
  { tag: '@real' },
  async ({ page, server, target }) => {
    await signIn(page, server, '/tools');
    const list = page.getByRole('list', { name: 'Tools' });
    await expect(list.getByRole('link').first()).toBeVisible();
    const all = await list.getByRole('link').count();

    // The search reads the descriptions too, where the server's tools name one another.
    await page.getByRole('searchbox', { name: 'Search tools' }).fill('chart_set_symbol');
    await expect(page.getByText(new RegExp(`^\\d+ of ${String(all)} tools$`))).toBeVisible();
    const link = list.getByRole('link', { name: /^chart_set_symbol/ });
    await expect(link).toBeVisible();
    if (target === 'mocked') {
      await expect(list.getByRole('link')).toHaveCount(1);
    }

    await link.click();
    await expect(page).toHaveURL(/\/tools\/chart_set_symbol$/);
    const article = toolArticle(page, 'Change the chart symbol');
    await expect(article.getByRole('heading', { level: 2 })).toBeFocused();
    await expect(fact(article, 'Domain')).toHaveText('chart');
    await expect(fact(article, 'Read-only')).toHaveText('No');
    await expect(fact(article, 'Destructive')).toHaveText('No');
    await expect(article.getByText('symbol', { exact: true }).first()).toBeVisible();
    await expect(article.getByRole('button', { name: 'Run', exact: true })).toBeEnabled();
  },
);

// Runs against the user's TradingView as well (@app): chart_get_state reads the chart and changes
// nothing. The result holds the chart's data, so the test looks only at the word the dashboard
// writes for the outcome, and only quietly.
test(
  'a read-only tool runs at once and shows its result',
  { tag: ['@real', '@app'] },
  async ({ page, server, target, mock }) => {
    await signIn(page, server, '/tools/chart_get_state');
    const article = toolArticle(page, 'Read the chart state');
    const run = article.getByRole('button', { name: 'Run', exact: true });
    await expectQuietly(async () => (await run.count()) === 1, 'the tool is shown, ready to run');

    await run.click();

    await expectQuietly(
      async () => (await textOf(resultRegion(page).getByRole('status'))) === 'OK',
      'the call succeeded',
    );
    // A tool that asks first would have shown its dialog instead of running.
    await expectQuietly(
      async () => (await page.getByRole('alertdialog').count()) === 0,
      'a read-only tool asks nothing',
    );
    if (target === 'mocked') {
      await expect(resultRegion(page)).toContainText('"symbol": "NASDAQ:AAPL"');
      expect(await mock.calls()).toEqual([{ name: 'chart_get_state', arguments: {} }]);
    }
  },
);

test(
  'a tool that changes the chart asks first, and Cancel runs nothing',
  { tag: '@real' },
  async ({ page, server, target, mock }) => {
    await signIn(page, server, '/tools/chart_set_symbol');
    const article = toolArticle(page, 'Change the chart symbol');
    await article
      .getByRole('textbox', { name: 'Arguments (JSON)' })
      .fill('{"symbol": "NASDAQ:MSFT"}');
    const run = article.getByRole('button', { name: 'Run', exact: true });
    await run.click();

    const dialog = page.getByRole('alertdialog', { name: 'Run chart_set_symbol?' });
    await expect(dialog).toContainText('It acts on your TradingView.');
    await expect(dialog).not.toContainText('It can remove or replace data.');
    await expect(dialog).toContainText('"symbol": "NASDAQ:MSFT"');

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(run).toBeFocused();
    await expect(resultRegion(page)).toContainText('Not run yet.');
    if (target === 'mocked') {
      expect(await mock.calls()).toEqual([]);
    }
  },
);

test('a confirmed run calls the tool and shows in the log as a dashboard call', async ({
  page,
  server,
  mock,
}) => {
  await signIn(page, server, '/tools/chart_set_symbol');
  const article = toolArticle(page, 'Change the chart symbol');
  await article
    .getByRole('textbox', { name: 'Arguments (JSON)' })
    .fill('{"symbol": "NASDAQ:MSFT"}');
  await article.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Run', exact: true }).click();

  await expect(resultRegion(page).getByRole('status')).toHaveText('OK');
  await expect(resultRegion(page)).toContainText('"changed": true');
  expect(await mock.calls()).toEqual([
    { name: 'chart_set_symbol', arguments: { symbol: 'NASDAQ:MSFT' } },
  ]);

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Log' }).click();
  const row = callRow(page, 'chart_set_symbol').first();
  await expect(row).toContainText('dashboard');
  await expect(row).toContainText('OK');
});

test('a tool that removes data says so before it runs', async ({ page, server, mock }) => {
  await signIn(page, server, '/tools/drawing_clear_all');
  const article = toolArticle(page, 'Remove drawings');
  await article.getByRole('textbox', { name: 'Arguments (JSON)' }).fill('{"scope": "all"}');
  await article.getByRole('button', { name: 'Run', exact: true }).click();

  const dialog = page.getByRole('alertdialog', { name: 'Run drawing_clear_all?' });
  await expect(dialog).toContainText('It can remove or replace data.');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await mock.calls()).toEqual([]);
});

test(
  'a failed call shows its error code, message and hint',
  { tag: '@real' },
  async ({ page, server }) => {
    await signIn(page, server, '/tools/chart_get_state');
    const article = toolArticle(page, 'Read the chart state');
    // The layout of the fake app, like the mock's, has one chart.
    await article.getByRole('textbox', { name: 'Arguments (JSON)' }).fill('{"chartIndex": 5}');
    await article.getByRole('button', { name: 'Run', exact: true }).click();

    const result = resultRegion(page);
    await expect(result.getByRole('status')).toHaveText('Error');
    const error = result.getByRole('alert');
    await expect(error).toContainText('INVALID_INPUT');
    await expect(error).toContainText('chartIndex 5 is out of range: the layout has 1 chart');
    await expect(error).toContainText('Leave chartIndex out to use the active chart.');
  },
);
