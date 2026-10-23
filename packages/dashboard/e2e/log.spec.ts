import type { Locator, Page } from '@playwright/test';
import { callId } from './fixtures.mjs';
import { callRow, callRows, expect, signIn, test } from './support.ts';

// The live log: every tool call, from any client, as the server's event stream brings it.

// The calls of the mock's backlog: eleven calls of every origin, two of them failed and the last one
// still running.
const BACKLOG_CALLS = 11;

function streamBadge(page: Page) {
  return page.getByRole('status', { name: 'Event stream' });
}

async function openLog(page: Page, server: { url: string; token: string }, path = '/log') {
  await signIn(page, server, path);
  await expect(streamBadge(page)).toHaveAttribute('data-state', 'live');
}

test('a call shows in the log as it starts, and changes when it ends', async ({
  page,
  server,
  mock,
}) => {
  await openLog(page, server);
  await expect(callRows(page)).toHaveCount(BACKLOG_CALLS);

  const id = callId(100);
  await mock.emit([
    { id, tool: 'watchlist_get', origin: 'mcp', phase: 'start', args: { listId: 'wl1' } },
  ]);
  const row = callRow(page, 'watchlist_get');
  await expect(callRows(page).first()).toContainText('watchlist_get');
  await expect(row).toContainText('Running');

  await mock.emit([
    { id, tool: 'watchlist_get', origin: 'mcp', phase: 'end', durationMs: 87, ok: true },
  ]);
  await expect(row).toContainText('OK');
  await expect(row).toContainText('87 ms');
  // The start and the end are one call.
  await expect(callRows(page)).toHaveCount(BACKLOG_CALLS + 1);

  // Its details: the arguments as the server shows them.
  await row.getByRole('button').click();
  const details = page.getByRole('dialog');
  await expect(details).toContainText('watchlist_get');
  await expect(details).toContainText('"listId": "wl1"');
});

// How many of `rows` the log shows once the stream's replay is on the page: the stream says it is
// live a moment before the events it replays have been drawn.
async function settledCount(page: Page, rows: Locator): Promise<number> {
  let last = -1;
  for (let read = 0; read < 20; read += 1) {
    const count = await rows.count();
    if (count === last) {
      return count;
    }
    last = count;
    await page.waitForTimeout(250);
  }
  throw new Error('The log kept changing while nothing was called');
}

// On the real server, whose log holds the calls of the tests before, so it counts.
test(
  'a call that another client makes shows in the log live',
  { tag: '@real' },
  async ({ page, server, api }) => {
    await openLog(page, server);
    const rows = callRow(page, 'app_health').filter({ hasText: 'dashboard' });
    const before = await settledCount(page, rows);

    const result = await api.callTool('app_health');
    expect(result.isError).not.toBe(true);

    await expect(rows).toHaveCount(before + 1);
    await expect(callRows(page).first()).toContainText('app_health');
    await expect(callRows(page).first()).toContainText('dashboard');
    await expect(callRows(page).first()).toContainText('OK');
  },
);

test('the filters narrow the calls by name, origin and status, and the address keeps them', async ({
  page,
  server,
}) => {
  await openLog(page, server);
  await expect(callRows(page)).toHaveCount(BACKLOG_CALLS);

  await page.getByRole('searchbox', { name: 'Search tools' }).fill('data_');
  await expect(callRows(page)).toHaveCount(3);
  await expect(page).toHaveURL(/[?&]q=data_/);

  await page.getByRole('combobox', { name: 'Origin' }).click();
  await page.getByRole('option', { name: 'batch' }).click();
  await expect(page.getByText('No calls match the filters.')).toBeVisible();

  await page.getByRole('button', { name: 'Reset filters' }).click();
  await expect(callRows(page)).toHaveCount(BACKLOG_CALLS);
  await expect(page).toHaveURL(/\/log$/);

  await page.getByRole('combobox', { name: 'Status' }).click();
  await page.getByRole('option', { name: 'Error' }).click();
  await expect(callRows(page)).toHaveCount(2);
  await expect(callRow(page, 'alert_create')).toContainText('PLAN_LIMIT');
  await expect(callRow(page, 'data_get_quote')).toContainText('TIMEOUT');

  // A reload keeps the filter, from the address.
  await page.reload();
  await expect(streamBadge(page)).toHaveAttribute('data-state', 'live');
  await expect(page.getByRole('combobox', { name: 'Status' })).toHaveText('Error');
  await expect(callRows(page)).toHaveCount(2);
});

test('pause holds new calls back until resume shows them', async ({ page, server, mock }) => {
  await openLog(page, server);
  await expect(callRows(page)).toHaveCount(BACKLOG_CALLS);

  await page.getByRole('button', { name: 'Pause' }).click();
  const id = callId(101);
  await mock.emit([
    { id, tool: 'chart_set_timeframe', origin: 'mcp', phase: 'start', args: { timeframe: '60' } },
    { id, tool: 'chart_set_timeframe', origin: 'mcp', phase: 'end', durationMs: 910, ok: true },
  ]);

  const resume = page.getByRole('button', { name: 'Resume (1 new)' });
  await expect(resume).toBeVisible();
  await expect(callRows(page)).toHaveCount(BACKLOG_CALLS);
  await expect(callRow(page, 'chart_set_timeframe')).toHaveCount(0);

  await resume.click();
  await expect(callRows(page)).toHaveCount(BACKLOG_CALLS + 1);
  await expect(callRows(page).first()).toContainText('chart_set_timeframe');
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
});

test('a dropped stream reconnects and goes on without repeating a call', async ({
  page,
  server,
  mock,
}) => {
  await openLog(page, server);
  await expect(callRows(page)).toHaveCount(BACKLOG_CALLS);

  await mock.dropStreams();
  await expect(streamBadge(page)).toHaveAttribute('data-state', 'reconnecting');
  await expect(streamBadge(page)).toHaveAttribute('data-state', 'live');

  const id = callId(102);
  await mock.emit([
    { id, tool: 'indicator_list', origin: 'batch', phase: 'start', args: {} },
    { id, tool: 'indicator_list', origin: 'batch', phase: 'end', durationMs: 51, ok: true },
  ]);
  await expect(callRows(page)).toHaveCount(BACKLOG_CALLS + 1);
  await expect(callRows(page).first()).toContainText('indicator_list');
  // The stream resumed from the last event it had, so nothing was missed.
  await expect(page.getByText('Some calls were missed while disconnected.')).toHaveCount(0);
});

test('after a server restart the log keeps its calls and says some were missed', async ({
  page,
  server,
  mock,
}) => {
  await openLog(page, server);
  await expect(callRows(page)).toHaveCount(BACKLOG_CALLS);

  await mock.restart();
  await expect(page.getByText('Some calls were missed while disconnected.')).toBeVisible();
  await expect(streamBadge(page)).toHaveAttribute('data-state', 'live');
  await expect(callRows(page)).toHaveCount(BACKLOG_CALLS);

  const id = callId(103);
  await mock.emit([
    { id, tool: 'app_health', origin: 'mcp', phase: 'start', args: {} },
    { id, tool: 'app_health', origin: 'mcp', phase: 'end', durationMs: 19, ok: true },
  ]);
  await expect(callRows(page)).toHaveCount(BACKLOG_CALLS + 1);
  await expect(callRows(page).first()).toContainText('app_health');
});
