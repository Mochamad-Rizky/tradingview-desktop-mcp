import { screen, waitFor, within } from '@testing-library/react';
import { storeToken } from '@/api/token';
import { at, callId, endEvent, startEvent, TEST_TOKEN } from '@/test/fixtures';
import { createFakeApi } from '@/test/handlers';
import { cells, renderInApp } from '@/test/render';
import { server } from '@/test/server';
import { RecentActivity } from './recent-activity';

function region(): HTMLElement {
  return screen.getByRole('region', { name: 'Recent activity' });
}

// The rows of the table without the time, which is shown in the browser's time zone.
function rowsWithoutTime(): string[][] {
  return cells(within(region()).getByRole('table')).map((row) => row.slice(1));
}

beforeEach(() => {
  storeToken(TEST_TOKEN);
});

test('recent activity lists the last five calls', async () => {
  // Seven calls: one OK, one OK of a batch, one that timed out, one that failed without a code, one
  // of the dashboard and one still running, after an older one.
  const api = createFakeApi({
    backlog: [
      startEvent(1, callId(1), 'chart_get_state'),
      endEvent(2, callId(1), 'chart_get_state'),
      startEvent(3, callId(2), 'chart_get_state'),
      endEvent(4, callId(2), 'chart_get_state'),
      startEvent(5, callId(3), 'drawing_list', { origin: 'batch' }),
      endEvent(6, callId(3), 'drawing_list', { origin: 'batch', durationMs: 7 }),
      startEvent(7, callId(4), 'chart_set_symbol'),
      endEvent(8, callId(4), 'chart_set_symbol', { durationMs: 30_000, errorCode: 'TIMEOUT' }),
      startEvent(9, callId(5), 'drawing_clear_all'),
      endEvent(10, callId(5), 'drawing_clear_all', { ok: false, durationMs: 1250 }),
      startEvent(11, callId(6), 'app_health', { origin: 'dashboard' }),
      endEvent(12, callId(6), 'app_health', { origin: 'dashboard', durationMs: 18 }),
      startEvent(13, callId(7), 'chart_get_state', { at: at(1300) }),
    ],
  });
  server.use(...api.handlers);
  renderInApp(<RecentActivity />);

  await waitFor(() => {
    expect(within(region()).getAllByRole('row')).toHaveLength(6);
  });
  // Newest first; the two oldest calls are left out.
  expect(rowsWithoutTime()).toEqual([
    ['Tool', 'Origin', 'Status', 'Duration'],
    ['chart_get_state', 'mcp', 'Running', ''],
    ['app_health', 'dashboard', 'OK', '18 ms'],
    ['drawing_clear_all', 'mcp', 'Failed', '1,250 ms'],
    ['chart_set_symbol', 'mcp', 'TIMEOUT', '30,000 ms'],
    ['drawing_list', 'batch', 'OK', '7 ms'],
  ]);
  expect(cells(within(region()).getByRole('table'))[0]?.[0]).toBe('Time');
  const newest = within(region()).getAllByRole('row')[1];
  expect(newest?.querySelector('time')).toHaveAttribute('datetime', at(1300));
  expect(within(region()).getByRole('link', { name: 'Open the live log' })).toHaveAttribute(
    'href',
    '/log',
  );

  // A new call comes in on top, and the oldest of the five goes.
  const connection = await api.stream.next();
  connection.send(startEvent(14, callId(8), 'drawing_list'));
  await waitFor(() => {
    expect(rowsWithoutTime()[1]).toEqual(['drawing_list', 'mcp', 'Running', '']);
  });
  expect(rowsWithoutTime()).toHaveLength(6);
  expect(rowsWithoutTime().at(-1)).toEqual(['chart_set_symbol', 'mcp', 'TIMEOUT', '30,000 ms']);
});

test('recent activity says when there are no calls yet', async () => {
  const api = createFakeApi({ backlog: [] });
  server.use(...api.handlers);
  renderInApp(<RecentActivity />);
  await api.stream.next();
  expect(await within(region()).findByText('No tool calls yet.')).toBeInTheDocument();
  expect(within(region()).queryByRole('table')).not.toBeInTheDocument();
  expect(within(region()).getByRole('link', { name: 'Open the live log' })).toBeInTheDocument();
});
