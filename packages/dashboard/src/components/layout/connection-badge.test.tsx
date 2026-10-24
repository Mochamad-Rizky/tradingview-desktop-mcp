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

test('the connection badge says Connecting before the first answer', async () => {
  renderInApp(<ConnectionBadge />);
  expect(screen.getByRole('status')).toHaveTextContent('Connecting');
  expect(screen.getByRole('status')).toHaveAttribute('data-state', 'connecting');
  await waitFor(() => {
    expect(screen.getByRole('status')).toHaveTextContent('TradingView ready');
  });
});

test('the badge says Server error on an ApiError', async () => {
  for (const status of [403, 404, 500, 503]) {
    const { client, unmount } = renderInApp(<ConnectionBadge />);
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('TradingView ready');
    });

    // The server answers, with an error: the last answer it gave says nothing about TradingView
    // now, and the server is not still connecting.
    server.use(
      http.get('/api/health', () => HttpResponse.json({ error: 'Synthetic failure' }, { status })),
    );
    await act(async () => {
      await client.refetchQueries({ queryKey: queryKeys.health });
    });
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Server error');
    });
    expect(screen.getByRole('status')).toHaveAttribute('data-state', 'server-error');
    expect(screen.getByRole('status')).not.toHaveTextContent('Connecting');
    unmount();
    server.resetHandlers();
  }
});

test('a 401 is left to the token screen, not called a server error', async () => {
  const { client } = renderInApp(<ConnectionBadge />);
  await waitFor(() => {
    expect(screen.getByRole('status')).toHaveTextContent('TradingView ready');
  });

  // The token is no longer the server's: the token gate asks for it again.
  server.use(
    http.get('/api/health', () => HttpResponse.json({ error: 'Unauthorized' }, { status: 401 })),
  );
  await act(async () => {
    await client.refetchQueries({ queryKey: queryKeys.health });
  });
  await waitFor(() => {
    expect(client.getQueryState(queryKeys.health)?.status).toBe('error');
  });
  expect(screen.getByRole('status')).toHaveAttribute('data-state', 'connecting');
  expect(screen.getByRole('status')).not.toHaveTextContent('Server error');
});

test('the connection badge says the server is not reachable when the dashboard cannot reach it', async () => {
  const { client } = renderInApp(<ConnectionBadge />);
  await waitFor(() => {
    expect(screen.getByRole('status')).toHaveTextContent('TradingView ready');
  });

  // The dashboard's own server is gone: nothing can be said of TradingView.
  server.use(http.get('/api/health', () => HttpResponse.error()));
  await act(async () => {
    await client.refetchQueries({ queryKey: queryKeys.health });
  });
  await waitFor(() => {
    expect(screen.getByRole('status')).toHaveTextContent('Server not reachable');
  });
  expect(screen.getByRole('status')).toHaveAttribute('data-state', 'server-unreachable');

  // It answers again.
  server.use(http.get('/api/health', () => HttpResponse.json(health)));
  await act(async () => {
    await client.refetchQueries({ queryKey: queryKeys.health });
  });
  await waitFor(() => {
    expect(screen.getByRole('status')).toHaveTextContent('TradingView ready');
  });
});
