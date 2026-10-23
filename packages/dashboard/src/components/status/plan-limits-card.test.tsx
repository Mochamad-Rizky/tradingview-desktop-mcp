import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { queryKeys } from '@/api/query-client';
import { storeToken } from '@/api/token';
import { errorResult, okResult, TEST_TOKEN, tools } from '@/test/fixtures';
import { createFakeApi } from '@/test/handlers';
import { cells, renderInApp } from '@/test/render';
import { server } from '@/test/server';
import { PlanLimitsCard } from './plan-limits-card';
import { RecentActivity } from './recent-activity';

function card(): HTMLElement {
  return screen.getByRole('region', { name: 'Plan limits' });
}

function readButton(): HTMLElement {
  return within(card()).getByRole('button', { name: 'Read plan limits' });
}

beforeEach(() => {
  storeToken(TEST_TOKEN);
});

test('plan limits are read on demand, show Unlimited and Unknown, and the call is a dashboard call', async () => {
  const user = userEvent.setup();
  const api = createFakeApi();
  server.use(...api.handlers);
  renderInApp(
    <>
      <PlanLimitsCard />
      <RecentActivity />
    </>,
  );

  // Nothing is read before the user asks.
  expect(await screen.findByRole('region', { name: 'Plan limits' })).toBeInTheDocument();
  expect(within(card()).queryByRole('table')).not.toBeInTheDocument();
  expect(api.calls).toEqual([]);

  await user.click(readButton());
  const table = await within(card()).findByRole('table');
  expect(cells(table)).toEqual([
    ['Feature', 'Limit'],
    ['INDICATORS_ON_CHART', '5'],
    ['SAVED_PINE_SCRIPTS', 'Unlimited'],
    ['CHART_STORAGE', '10'],
    ['MULTIPLE_CHARTS', '2'],
    ['SERVER_SIDE_ALERTS', '20'],
    ['WATCHLIST_SYMBOLS', '1,000'],
    ['STUDY_TEMPLATES', 'Unknown'],
    ['HISTORICAL_BARS', '10,000'],
  ]);
  expect(api.calls).toEqual([{ name: 'app_get_plan_limits', body: { arguments: {} } }]);

  // The call went through the registry, so the log shows it, made by the dashboard.
  const activity = screen.getByRole('region', { name: 'Recent activity' });
  await waitFor(() => {
    expect(within(activity).getAllByRole('row')[1]).toHaveTextContent('app_get_plan_limits');
  });
  expect(within(activity).getAllByRole('row')[1]).toHaveTextContent('dashboard');
});

test('a failed plan limits read shows the error code and message', async () => {
  const user = userEvent.setup();
  const api = createFakeApi({
    results: {
      app_get_plan_limits: errorResult({
        code: 'TV_NOT_RUNNING',
        message: 'TradingView Desktop is not running',
        hint: 'Start it with tradingview-desktop-mcp launch.',
      }),
    },
  });
  server.use(...api.handlers);
  renderInApp(<PlanLimitsCard />);

  await screen.findByRole('region', { name: 'Plan limits' });
  await user.click(readButton());
  const alert = await within(card()).findByRole('alert');
  expect(within(alert).getByText('TV_NOT_RUNNING').tagName).toBe('CODE');
  expect(alert).toHaveTextContent('TradingView Desktop is not running');
  expect(alert).toHaveTextContent('Start it with tradingview-desktop-mcp launch.');
  expect(within(card()).queryByRole('table')).not.toBeInTheDocument();
});

test('the Read button waits while the plan limits are read', async () => {
  const user = userEvent.setup();
  let answer: () => void = () => undefined;
  server.use(
    http.post('/api/tools/app_get_plan_limits', async () => {
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
      return HttpResponse.json(okResult({ limits: { INDICATORS_ON_CHART: 25 } }));
    }),
  );
  renderInApp(<PlanLimitsCard />);
  await screen.findByRole('region', { name: 'Plan limits' });
  expect(within(card()).getByText('Not read yet.')).toBeInTheDocument();

  await user.click(readButton());
  await waitFor(() => {
    expect(readButton()).toBeDisabled();
  });
  expect(within(card()).getByText('Reading the plan limits…')).toBeInTheDocument();
  answer();
  expect(await within(card()).findByRole('table')).toHaveTextContent('25');
  expect(readButton()).toBeEnabled();
});

test('a plan limits read the server refuses or cannot answer says why', async () => {
  const user = userEvent.setup();
  server.use(
    http.post('/api/tools/app_get_plan_limits', () =>
      HttpResponse.json({ error: 'This server offers no tool of that name' }, { status: 404 }),
    ),
  );
  renderInApp(<PlanLimitsCard />);
  await screen.findByRole('region', { name: 'Plan limits' });

  await user.click(readButton());
  expect(await within(card()).findByRole('alert')).toHaveTextContent(
    'The plan limits could not be read: This server offers no tool of that name.',
  );

  server.use(http.post('/api/tools/app_get_plan_limits', () => HttpResponse.error()));
  await user.click(readButton());
  await waitFor(() => {
    expect(within(card()).getByRole('alert')).toHaveTextContent(
      'The plan limits could not be read: The server could not be reached.',
    );
  });
});

test('an answer without plan limits says so', async () => {
  const user = userEvent.setup();
  // From a server of another version, say: no envelope, data that is no object, data without
  // limits, and limits that are no numbers.
  const answers = [
    { content: [{ type: 'text', text: 'ok' }] },
    okResult('unlimited'),
    okResult({ features: [] }),
    okResult({ limits: { INDICATORS_ON_CHART: 'five' } }),
  ];
  for (const answer of answers) {
    server.use(http.post('/api/tools/app_get_plan_limits', () => HttpResponse.json(answer)));
    const { unmount } = renderInApp(<PlanLimitsCard />);
    await screen.findByRole('region', { name: 'Plan limits' });
    await user.click(readButton());
    expect(await within(card()).findByText('The answer held no plan limits.')).toBeInTheDocument();
    expect(within(card()).queryByRole('table')).not.toBeInTheDocument();
    unmount();
  }
});

test('the plan limits card is hidden when the profile does not offer app_get_plan_limits', async () => {
  // The core profile leaves the tool out.
  const api = createFakeApi({ tools: tools.filter((tool) => tool.profiles.includes('core')) });
  server.use(...api.handlers);
  const { client } = renderInApp(<PlanLimitsCard />);
  await waitFor(() => {
    expect(client.getQueryState(queryKeys.tools)?.status).toBe('success');
  });
  expect(screen.queryByRole('region', { name: 'Plan limits' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Read plan limits' })).not.toBeInTheDocument();
});
