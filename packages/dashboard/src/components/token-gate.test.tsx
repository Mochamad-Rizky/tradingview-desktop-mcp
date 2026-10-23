import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { readToken, storeToken } from '@/api/token';
import { useCallTool } from '@/hooks/use-call-tool';
import { EventLogProvider, useEventLog } from '@/hooks/use-event-log';
import { useHealth } from '@/hooks/use-health';
import { useInfo } from '@/hooks/use-info';
import { useTools } from '@/hooks/use-tools';
import { TEST_TOKEN } from '@/test/fixtures';
import { createFakeApi } from '@/test/handlers';
import { withQueryClient } from '@/test/query';
import { server } from '@/test/server';
import { TokenGate } from './token-gate';

function visit(url: string): void {
  window.history.replaceState(null, '', url);
}

// What the app behind the gate would show: data from every route, and a button that calls a tool.
function Inside() {
  const info = useInfo();
  const tools = useTools();
  const health = useHealth();
  const log = useEventLog();
  const call = useCallTool();
  return (
    <div>
      <p>Inside the app</p>
      <p>{info.data === undefined ? 'No info' : `Version ${info.data.version}`}</p>
      <p>{tools.data === undefined ? 'No tools' : `${String(tools.data.length)} tools`}</p>
      <p>{health.data === undefined ? 'No health' : 'Health read'}</p>
      <p>{`${String(log.calls.length)} calls, ${log.status}`}</p>
      <button
        type="button"
        onClick={() => {
          call.mutate({ name: 'chart_get_state', arguments: { chartIndex: 0 } });
        }}
      >
        Run a tool
      </button>
      <button
        type="button"
        onClick={() => {
          void tools.refetch();
        }}
      >
        Reload the tools
      </button>
    </div>
  );
}

function renderGate() {
  const Wrapper = withQueryClient();
  return render(
    <Wrapper>
      <TokenGate>
        <EventLogProvider>
          <Inside />
        </EventLogProvider>
      </TokenGate>
    </Wrapper>,
  );
}

function tokenInput(): HTMLElement {
  return screen.getByLabelText('Access token');
}

// The server restarted with another token: it refuses every request made with the old one.
function serverTakesAnotherToken(): void {
  server.use(
    http.all('/api/*', () =>
      HttpResponse.json(
        { error: 'Invalid token' },
        { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } },
      ),
    ),
  );
}

afterEach(() => {
  visit('/');
});

test('a token in the URL fragment is stored trimmed and removed from the address', async () => {
  visit(`/log?origin=mcp#token=%20${TEST_TOKEN}%0A`);
  renderGate();
  expect(await screen.findByText('Inside the app')).toBeInTheDocument();
  expect(sessionStorage.getItem('tvmcp.token')).toBe(TEST_TOKEN);
  expect(window.location.hash).toBe('');
  expect(window.location.pathname).toBe('/log');
  expect(window.location.search).toBe('?origin=mcp');
  expect(window.location.href).not.toContain(TEST_TOKEN);
  expect(await screen.findByText('Version 0.0.0-test')).toBeInTheDocument();
});

test('a pasted token with spaces and a newline connects', async () => {
  const user = userEvent.setup();
  const sent: (string | null)[] = [];
  server.events.on('request:start', ({ request }) => {
    sent.push(request.headers.get('Authorization'));
  });
  renderGate();

  expect(screen.getByRole('heading', { name: 'Connect to the server' })).toBeInTheDocument();
  expect(tokenInput()).toHaveAttribute('type', 'password');
  expect(screen.getByText(/TV_MCP_AUTH_TOKEN/)).toBeInTheDocument();
  expect(screen.queryByText('Inside the app')).not.toBeInTheDocument();

  await user.click(tokenInput());
  await user.paste(`  \t${TEST_TOKEN} \n`);
  await user.click(screen.getByRole('button', { name: 'Connect' }));

  expect(await screen.findByText('Inside the app')).toBeInTheDocument();
  expect(readToken()).toBe(TEST_TOKEN);
  // The check of the token filled in the server facts, so they show at once.
  expect(screen.getByText('Version 0.0.0-test')).toBeInTheDocument();
  expect(sent[0]).toBe(`Bearer ${TEST_TOKEN}`);
  server.events.removeAllListeners();
});

test('a wrong token shows the not-accepted message and stays on the form', async () => {
  const user = userEvent.setup();
  renderGate();

  await user.type(tokenInput(), 'wrong-token{Enter}');
  expect(await screen.findByRole('alert')).toHaveTextContent('That token was not accepted.');
  expect(tokenInput()).toHaveValue('wrong-token');
  expect(readToken()).toBeNull();
  expect(screen.queryByText('Inside the app')).not.toBeInTheDocument();

  // The right one then gets through, and the message goes.
  await user.clear(tokenInput());
  await user.type(tokenInput(), TEST_TOKEN);
  await user.click(screen.getByRole('button', { name: 'Connect' }));
  expect(await screen.findByText('Inside the app')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('an empty token, a token no header can carry and a server that cannot be reached each get their own message', async () => {
  const user = userEvent.setup();
  let checks = 0;
  server.events.on('request:start', () => {
    checks += 1;
  });
  renderGate();

  await user.click(screen.getByRole('button', { name: 'Connect' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Enter the access token.');
  await user.type(tokenInput(), '   {Enter}');
  expect(screen.getByRole('alert')).toHaveTextContent('Enter the access token.');

  // Quotes that a word processor curled, and a space inside: never part of a token.
  await user.clear(tokenInput());
  await user.type(tokenInput(), '‘abc’{Enter}');
  expect(screen.getByRole('alert')).toHaveTextContent(
    'That token holds a space or a character that a token cannot hold. Check what was pasted.',
  );
  await user.clear(tokenInput());
  await user.type(tokenInput(), 'abc def{Enter}');
  expect(screen.getByRole('alert')).toHaveTextContent('Check what was pasted.');
  expect(checks).toBe(0);
  server.events.removeAllListeners();

  server.use(http.get('/api/info', () => HttpResponse.error()));
  await user.clear(tokenInput());
  await user.type(tokenInput(), `${TEST_TOKEN}{Enter}`);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'The server could not be reached. Check that it is still running.',
  );

  server.use(
    http.get('/api/info', () =>
      HttpResponse.json({ error: 'This Origin is not allowed' }, { status: 403 }),
    ),
  );
  await user.click(screen.getByRole('button', { name: 'Connect' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'The server refused the request (403): This Origin is not allowed',
  );
  expect(readToken()).toBeNull();
});

test('the Connect button waits while the token is checked', async () => {
  const user = userEvent.setup();
  let release: () => void = () => undefined;
  server.use(
    http.get('/api/info', async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return HttpResponse.json({ error: 'Invalid token' }, { status: 401 });
    }),
  );
  renderGate();
  await user.type(tokenInput(), `${TEST_TOKEN}{Enter}`);
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
  });
  release();
  expect(await screen.findByRole('alert')).toHaveTextContent('That token was not accepted.');
  expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();
});

test('a 401 from any later call returns to the token form', async () => {
  const user = userEvent.setup();
  storeToken(TEST_TOKEN);
  renderGate();
  expect(await screen.findByText('6 tools')).toBeInTheDocument();

  // A tool call refused after the server restarted with another token.
  serverTakesAnotherToken();
  await user.click(screen.getByRole('button', { name: 'Run a tool' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('That token was not accepted.');
  expect(tokenInput()).toHaveValue('');
  expect(readToken()).toBeNull();
  expect(screen.queryByText('Inside the app')).not.toBeInTheDocument();

  // Signed in again, a query refused the same way returns to the form too, with fresh data after.
  server.resetHandlers();
  await user.type(tokenInput(), `${TEST_TOKEN}{Enter}`);
  expect(await screen.findByText('6 tools')).toBeInTheDocument();
  serverTakesAnotherToken();
  await user.click(screen.getByRole('button', { name: 'Reload the tools' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('That token was not accepted.');
  expect(readToken()).toBeNull();

  server.resetHandlers();
  await user.type(tokenInput(), `${TEST_TOKEN}{Enter}`);
  expect(await screen.findByText('6 tools')).toBeInTheDocument();
});

test('a 401 on reconnecting the event stream returns to the token form', async () => {
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
  const api = createFakeApi({ backlog: [] });
  server.use(...api.handlers);
  storeToken(TEST_TOKEN);
  renderGate();
  const connection = await api.stream.next();
  expect(await screen.findByText('0 calls, live')).toBeInTheDocument();

  serverTakesAnotherToken();
  connection.drop();
  expect(await screen.findByText('0 calls, reconnecting')).toBeInTheDocument();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(await screen.findByRole('alert')).toHaveTextContent('That token was not accepted.');
  expect(readToken()).toBeNull();
  vi.useRealTimers();
});

test('the token travels only in the Authorization header, never in a URL or a log', async () => {
  const user = userEvent.setup();
  const consoleCalls = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
    vi.spyOn(console, method),
  );
  const requests: { url: string; authorization: string | null }[] = [];
  server.events.on('request:start', ({ request }) => {
    requests.push({ url: request.url, authorization: request.headers.get('Authorization') });
  });
  const api = createFakeApi();
  server.use(...api.handlers);
  visit(`/#token=${TEST_TOKEN}`);
  renderGate();

  expect(await screen.findByText('Health read')).toBeInTheDocument();
  expect(await screen.findByText(/^3 calls/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Run a tool' }));
  expect(await screen.findByText(/^4 calls/)).toBeInTheDocument();

  const paths = new Set(requests.map((request) => new URL(request.url).pathname));
  expect(paths).toEqual(
    new Set([
      '/api/info',
      '/api/tools',
      '/api/health',
      '/api/events',
      '/api/tools/chart_get_state',
    ]),
  );
  for (const request of requests) {
    expect(request.url).not.toContain(TEST_TOKEN);
    expect(request.authorization).toBe(`Bearer ${TEST_TOKEN}`);
  }
  expect(window.location.href).not.toContain(TEST_TOKEN);
  expect(localStorage.length).toBe(0);
  expect(document.cookie).toBe('');
  for (const spy of consoleCalls) {
    expect(JSON.stringify(spy.mock.calls)).not.toContain(TEST_TOKEN);
  }
  server.events.removeAllListeners();
});
