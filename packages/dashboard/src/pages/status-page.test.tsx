import { screen, waitFor } from '@testing-library/react';
import { storeToken } from '@/api/token';
import { TEST_TOKEN } from '@/test/fixtures';
import { fact, renderInApp } from '@/test/render';
import { StatusPage } from './status-page';

beforeEach(() => {
  storeToken(TEST_TOKEN);
});

test('the status page shows the server facts from /api/info', async () => {
  renderInApp(<StatusPage />);
  expect(screen.getByRole('heading', { level: 1, name: 'Status' })).toBeInTheDocument();

  const card = screen.getByRole('region', { name: 'Server' });
  await waitFor(() => {
    expect(fact(card, 'Version')).toBe('0.0.0-test');
  });
  expect(fact(card, 'Transport')).toBe('HTTP');
  expect(fact(card, 'Profile')).toBe('full');
  expect(fact(card, 'Tools')).toBe('6');
  expect(fact(card, 'MCP endpoint')).toBe('http://127.0.0.1:8787/mcp');
  expect(fact(card, 'ui_evaluate')).toBe('Not allowed');
  // No tool filter is set, so none is listed.
  expect(screen.queryByText('Tool filter')).not.toBeInTheDocument();

  // The other cards of the page: the full profile offers app_get_plan_limits.
  expect(screen.getByRole('region', { name: 'TradingView' })).toBeInTheDocument();
  expect(await screen.findByRole('region', { name: 'Plan limits' })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Recent activity' })).toBeInTheDocument();
});
