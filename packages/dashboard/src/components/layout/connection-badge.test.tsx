import type { DashboardHealth } from '@contract';
import { act, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { queryKeys } from '@/api/query-client';
import { storeToken } from '@/api/token';
import {
  backgroundHealth,
  health,
  noChartHealth,
  TEST_TOKEN,
  unreachableHealth,
} from '@/test/fixtures';
import { renderInApp } from '@/test/render';
import { server } from '@/test/server';
import { ConnectionBadge } from './connection-badge';

// TradingView answers and shows a chart in front, but its app has not said it is ready yet.
const startingHealth: DashboardHealth = {
  cdp: { reachable: true, endpoint: 'http://127.0.0.1:9222', browser: 'Chrome/130.0.6723.191' },
  chart: { found: true, tabs: 1, url: 'https://www.tradingview.com/chart/', inBackground: false },
  app: { ready: false, connected: false, buildTime: null },
};

// The app says it is ready, and yet the chart it found is not in front: the card says so, and the
// badge with it.
const readyInBackgroundHealth: DashboardHealth = {
  ...health,
  chart: { ...health.chart, inBackground: true },
};

beforeEach(() => {
  storeToken(TEST_TOKEN);
});

test('the connection badge names each state in text', async () => {
  const states: [DashboardHealth, string, string][] = [
    [health, 'TradingView ready', 'ready'],
    [backgroundHealth, 'Chart in background', 'background'],
    [unreachableHealth, 'TradingView not reachable', 'unreachable'],
    [noChartHealth, 'No chart open', 'no-chart'],
    [readyInBackgroundHealth, 'Chart in background', 'background'],
    [startingHealth, 'Connecting', 'connecting'],
  ];
  for (const [report, label, state] of states) {
    server.use(http.get('/api/health', () => HttpResponse.json(report)));
    const { client, unmount } = renderInApp(<ConnectionBadge />);
    await waitFor(() => {
      expect(client.getQueryState(queryKeys.health)?.status).toBe('success');
    });
    // The words say it, whatever the colour.
    expect(screen.getByRole('status')).toHaveTextContent(label);
    expect(screen.getByRole('status')).toHaveAttribute('data-state', state);
    unmount();
  }
});

test('the connection badge says Connecting before the first answer and after a failed check', async () => {
  const { client } = renderInApp(<ConnectionBadge />);
  expect(screen.getByRole('status')).toHaveTextContent('Connecting');
  await waitFor(() => {
    expect(screen.getByRole('status')).toHaveTextContent('TradingView ready');
  });

  // The server stops answering: the last answer it gave says nothing about TradingView now.
  server.use(
    http.get('/api/health', () =>
      HttpResponse.json({ error: 'The server is shutting down' }, { status: 503 }),
    ),
  );
  await act(async () => {
    await client.refetchQueries({ queryKey: queryKeys.health });
  });
  await waitFor(() => {
    expect(screen.getByRole('status')).toHaveTextContent('Connecting');
  });
  expect(screen.getByRole('status')).toHaveAttribute('data-state', 'connecting');
});
