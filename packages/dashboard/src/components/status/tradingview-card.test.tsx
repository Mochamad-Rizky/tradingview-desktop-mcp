import type { DashboardHealth } from '@contract';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { queryKeys } from '@/api/query-client';
import { storeToken } from '@/api/token';
import { backgroundHealth, health, TEST_TOKEN, unreachableHealth } from '@/test/fixtures';
import { fact, renderInApp } from '@/test/render';
import { server } from '@/test/server';
import { TradingViewCard } from './tradingview-card';

function answerHealth(report: DashboardHealth): void {
  server.use(http.get('/api/health', () => HttpResponse.json(report)));
}

function card(): HTMLElement {
  return screen.getByRole('region', { name: 'TradingView' });
}

beforeEach(() => {
  storeToken(TEST_TOKEN);
});

test('TradingView not reachable shows the endpoint and the launch hint', async () => {
  answerHealth(unreachableHealth);
  renderInApp(<TradingViewCard />);

  const alert = await within(card()).findByRole('alert');
  expect(alert).toHaveTextContent(
    'TradingView is not reachable on http://127.0.0.1:9222. Start it with tradingview-desktop-mcp launch.',
  );
  // The command is set as code, to be copied as it is.
  expect(within(alert).getByText('tradingview-desktop-mcp launch').tagName).toBe('CODE');
  expect(fact(card(), 'Debug port')).toBe('Not reachable on http://127.0.0.1:9222');
  expect(fact(card(), 'Chart')).toBe('Not found');
  expect(fact(card(), 'Chart tabs')).toBe('0');
  expect(fact(card(), 'App')).toBe('Not ready');
  expect(fact(card(), 'Build time')).toBe('Unknown');
});

test('the TradingView card lists what the health check found', async () => {
  renderInApp(<TradingViewCard />);
  await waitFor(() => {
    expect(fact(card(), 'Debug port')).toBe('Reachable on http://127.0.0.1:9222');
  });
  expect(fact(card(), 'Chart')).toBe('Found');
  expect(fact(card(), 'Chart tabs')).toBe('1');
  expect(fact(card(), 'In background')).toBe('No');
  expect(fact(card(), 'App')).toBe('Ready');
  // In the browser's time zone, so only the year is certain.
  expect(fact(card(), 'Build time')).toMatch(/2025|2026/);
  expect(within(card()).queryByRole('alert')).not.toBeInTheDocument();
});

test('a chart behind another tab says it is not in front', async () => {
  answerHealth(backgroundHealth);
  renderInApp(<TradingViewCard />);
  expect(await within(card()).findByText('A chart is open but not in front.')).toBeInTheDocument();
  expect(fact(card(), 'Chart tabs')).toBe('2');
  expect(fact(card(), 'In background')).toBe('Yes');
  expect(fact(card(), 'App')).toBe('Not ready');
  expect(fact(card(), 'Build time')).toBe('Unknown');
});

test('another browser on the debug port is named instead of the launch hint', async () => {
  const otherBrowser = (browser?: string): DashboardHealth => ({
    cdp: {
      reachable: false,
      endpoint: 'http://127.0.0.1:9222',
      ...(browser === undefined ? {} : { browser }),
      otherBrowser: true,
    },
    chart: { found: false, tabs: 0 },
    app: { ready: false },
  });
  answerHealth(otherBrowser('Chrome/131.0.6778.86'));
  const first = renderInApp(<TradingViewCard />);
  const alert = await within(card()).findByRole('alert');
  expect(alert).toHaveTextContent(
    'TradingView is not reachable on http://127.0.0.1:9222. Another browser answers there ' +
      '(Chrome/131.0.6778.86): quit it, or set TV_CDP_PORT to a free port and start this server again.',
  );
  expect(alert).not.toHaveTextContent('launch');
  first.unmount();

  // A browser that did not name itself.
  answerHealth(otherBrowser());
  renderInApp(<TradingViewCard />);
  expect(await within(card()).findByRole('alert')).toHaveTextContent(
    'Another browser answers there: quit it',
  );
});

test('Check now joins a check in flight instead of cancelling it, and starts one otherwise', async () => {
  const user = userEvent.setup();
  let requests = 0;
  let aborted = 0;
  const answers: (() => void)[] = [];
  // The first check answers at once; TradingView is slow to answer the later ones, which wait until
  // the test lets them through.
  server.use(
    http.get('/api/health', async ({ request }) => {
      requests += 1;
      request.signal.addEventListener('abort', () => {
        aborted += 1;
      });
      if (requests > 1) {
        await new Promise<void>((resolve) => {
          answers.push(resolve);
        });
      }
      return HttpResponse.json(health);
    }),
  );
  const { client } = renderInApp(<TradingViewCard />);
  await waitFor(() => {
    expect(fact(card(), 'App')).toBe('Ready');
  });
  expect(requests).toBe(1);

  // Nothing in flight: a click checks at once.
  const checkNow = within(card()).getByRole('button', { name: 'Check now' });
  await user.click(checkNow);
  await waitFor(() => {
    expect(requests).toBe(2);
  });

  // That check is still running: more clicks join it, rather than cancel it and start another.
  await user.click(checkNow);
  await user.click(checkNow);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(requests).toBe(2);
  expect(aborted).toBe(0);

  answers.shift()?.();
  await waitFor(() => {
    expect(client.getQueryState(queryKeys.health)?.fetchStatus).toBe('idle');
  });
  expect(requests).toBe(2);
  expect(aborted).toBe(0);
  expect(fact(card(), 'App')).toBe('Ready');
});

test('a health check the server does not answer says so, and keeps the facts it had', async () => {
  const user = userEvent.setup();
  renderInApp(<TradingViewCard />);
  await waitFor(() => {
    expect(fact(card(), 'App')).toBe('Ready');
  });

  server.use(
    http.get('/api/health', () =>
      HttpResponse.json({ error: 'The server is shutting down' }, { status: 503 }),
    ),
  );
  await user.click(within(card()).getByRole('button', { name: 'Check now' }));
  expect(await within(card()).findByRole('alert')).toHaveTextContent(
    'The last check failed: The server is shutting down. The facts below are from the check before.',
  );
  expect(fact(card(), 'App')).toBe('Ready');
});

test('a first health check that fails says why', async () => {
  server.use(http.get('/api/health', () => HttpResponse.error()));
  renderInApp(<TradingViewCard />);
  expect(await within(card()).findByRole('alert')).toHaveTextContent(
    'The health check failed: The server could not be reached.',
  );
  expect(within(card()).queryByText('Debug port')).not.toBeInTheDocument();
});
