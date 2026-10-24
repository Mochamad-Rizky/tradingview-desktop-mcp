import {
  attributeOf,
  callRows,
  connectionBadge,
  expect,
  expectQuietly,
  fact,
  signIn,
  test,
  textOf,
} from './support.ts';

// The status page: how the server runs, whether TradingView is up, and the plan limits on demand.

test(
  'the status page shows the facts of the server',
  { tag: '@real' },
  async ({ page, server, api }) => {
    const info = await api.info();
    await signIn(page, server);

    const card = page.getByRole('region', { name: 'Server' });
    await expect(fact(card, 'Version')).toHaveText(info.version);
    await expect(fact(card, 'Transport')).toHaveText(info.transport === 'http' ? 'HTTP' : 'stdio');
    await expect(fact(card, 'Profile')).toHaveText(info.profile);
    await expect(fact(card, 'Tools')).toHaveText(String(info.toolCount));
    await expect(fact(card, 'MCP endpoint')).toHaveText(info.mcpEndpoint ?? 'stdio');
    await expect(fact(card, 'ui_evaluate')).toHaveText(info.allowEval ? 'Allowed' : 'Not allowed');
  },
);

// Runs against the user's TradingView as well (@app): it checks words the dashboard writes, never
// the chart's, and only quietly.
test(
  'the status page shows TradingView reachable and ready',
  { tag: ['@real', '@app'] },
  async ({ page, server }) => {
    await signIn(page, server);

    await expectQuietly(
      async () => (await attributeOf(connectionBadge(page), 'data-state')) === 'ready',
      'the header says TradingView is ready',
    );
    const card = page.getByRole('region', { name: 'TradingView' });
    await expectQuietly(
      async () => (await textOf(fact(card, 'Debug port')))?.startsWith('Reachable on ') === true,
      'the debug port answers',
    );
    await expectQuietly(
      async () => (await textOf(fact(card, 'Chart'))) === 'Found',
      'a chart is open',
    );
    await expectQuietly(
      async () => (await textOf(fact(card, 'App'))) === 'Ready',
      'the app is ready',
    );
  },
);

test('the status page says when TradingView is not reachable, and how to start it', async ({
  page,
  server,
  mock,
}) => {
  await mock.setHealth('unreachable');
  await signIn(page, server);

  await expect(connectionBadge(page)).toHaveText('TradingView not reachable');
  const card = page.getByRole('region', { name: 'TradingView' });
  await expect(card.getByRole('alert')).toContainText('TradingView is not reachable on');
  await expect(card.getByRole('alert')).toContainText('tradingview-desktop-mcp launch');
  await expect(fact(card, 'App')).toHaveText('Not ready');

  // It comes back: the next check finds it.
  await mock.setHealth('ready');
  await card.getByRole('button', { name: 'Check now' }).click();
  await expect(connectionBadge(page)).toHaveText('TradingView ready');
  await expect(card.getByRole('alert')).toHaveCount(0);
});

test(
  'the status page reads the plan limits only when asked, and the call shows in the log',
  { tag: '@real' },
  async ({ page, server, target }) => {
    await signIn(page, server);

    const card = page.getByRole('region', { name: 'Plan limits' });
    await expect(card.getByText('Not read yet.')).toBeVisible();
    await card.getByRole('button', { name: 'Read plan limits' }).click();

    const rows = card.getByRole('row');
    // The header row and one row at least per limit.
    await expect(rows.nth(1)).toBeVisible();
    if (target === 'mocked') {
      await expect(card.getByRole('row', { name: /SAVED_PINE_SCRIPTS/ })).toContainText(
        'Unlimited',
      );
      await expect(card.getByRole('row', { name: /STUDY_TEMPLATES/ })).toContainText('Unknown');
      await expect(card.getByRole('row', { name: /INDICATORS_ON_CHART/ })).toContainText('5');
    }

    const recent = page.getByRole('region', { name: 'Recent activity' });
    const row = recent.getByRole('row', { name: /app_get_plan_limits/ }).first();
    await expect(row).toContainText('dashboard');
    await expect(row).toContainText('OK');

    await page.getByRole('link', { name: 'Open the live log' }).click();
    await expect(callRows(page).first()).toContainText('app_get_plan_limits');
  },
);

test('the status page lists the recent calls of every client, newest first', async ({
  page,
  server,
}) => {
  await signIn(page, server);

  const recent = page.getByRole('region', { name: 'Recent activity' });
  const rows = recent.getByRole('row');
  // The header row and the last five calls of the backlog.
  await expect(rows).toHaveCount(6);
  await expect(rows.nth(1)).toContainText('data_get_ohlcv');
  await expect(rows.nth(1)).toContainText('Running');
  await expect(rows.nth(2)).toContainText('drawing_list');
  await expect(rows.nth(4)).toContainText('TIMEOUT');
  await expect(rows.nth(5)).toContainText('PLAN_LIMIT');
});
