import type { DashboardEvent } from '@contract';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { storeToken } from '@/api/token';
import { formatTime } from '@/lib/format';
import { at, callEvents, callId, endEvent, events, startEvent, TEST_TOKEN } from '@/test/fixtures';
import { createFakeApi, type FakeApi } from '@/test/handlers';
import { cells, fact, renderInApp } from '@/test/render';
import { server } from '@/test/server';
import { LogPage } from './log-page';

const MISSED = 'Some calls were missed while disconnected.';

// The page reads its filters from the address, as it does when the browser opens /log?origin=batch.
function visit(path: string): void {
  window.history.replaceState(null, '', path);
}

function table(): HTMLElement {
  return screen.getByRole('table', { name: 'Tool calls, newest first' });
}

// The rows of the table without the header and without the time, which is on the browser clock.
function rowsWithoutTime(): string[][] {
  return cells(table())
    .slice(1)
    .map((row) => row.slice(1));
}

function streamState(): HTMLElement {
  return screen.getByRole('status', { name: 'Event stream' });
}

// A fake API whose event stream replays `backlog` (by default an OK call, a failed one and one
// still running), for the test to write to.
function serve(backlog: readonly DashboardEvent[] = events): FakeApi {
  const api = createFakeApi({ backlog });
  server.use(...api.handlers);
  return api;
}

beforeEach(() => {
  storeToken(TEST_TOKEN);
  visit('/log');
});

afterEach(() => {
  // Unmounted first, so that the router does not render the change of address outside act.
  cleanup();
  visit('/');
});

test('live calls appear newest first with their status and duration', async () => {
  const api = serve();
  renderInApp(<LogPage />);
  await waitFor(() => {
    expect(rowsWithoutTime()).toHaveLength(3);
  });
  expect(cells(table())[0]).toEqual(['Time', 'Tool', 'Origin', 'Status', 'Duration']);
  expect(rowsWithoutTime()).toEqual([
    ['drawing_list', 'batch', 'Running', ''],
    ['chart_set_symbol', 'mcp', 'TIMEOUT', '30,000 ms'],
    ['chart_get_state', 'mcp', 'OK', '38 ms'],
  ]);
  const time = within(table()).getAllByRole('row')[1]?.querySelector('time');
  expect(time).toHaveAttribute('datetime', at(500));
  expect(time).toHaveTextContent(formatTime(at(500)));

  // A new call goes on top as it runs, and shows how it ended once it has.
  const connection = await api.stream.next();
  connection.send(startEvent(6, callId(4), 'app_health', { origin: 'dashboard' }));
  await waitFor(() => {
    expect(rowsWithoutTime()[0]).toEqual(['app_health', 'dashboard', 'Running', '']);
  });
  connection.send(endEvent(7, callId(4), 'app_health', { origin: 'dashboard', durationMs: 18 }));
  await waitFor(() => {
    expect(rowsWithoutTime()[0]).toEqual(['app_health', 'dashboard', 'OK', '18 ms']);
  });
  expect(rowsWithoutTime()).toHaveLength(4);
});

test('filters narrow the table and are kept in the URL', async () => {
  const user = userEvent.setup();
  serve([
    startEvent(1, callId(1), 'chart_get_state'),
    endEvent(2, callId(1), 'chart_get_state'),
    startEvent(3, callId(2), 'chart_set_symbol'),
    endEvent(4, callId(2), 'chart_set_symbol', { errorCode: 'TIMEOUT', durationMs: 30_000 }),
    startEvent(5, callId(3), 'drawing_list', { origin: 'batch' }),
    startEvent(6, callId(4), 'drawing_list', { origin: 'batch' }),
    endEvent(7, callId(4), 'drawing_list', { origin: 'batch' }),
    startEvent(8, callId(5), 'chart_get_state', { origin: 'dashboard' }),
    endEvent(9, callId(5), 'chart_get_state', { origin: 'dashboard', errorCode: 'INVALID_INPUT' }),
  ]);
  // A link to the batch calls.
  visit('/log?origin=batch');
  const entries = window.history.length;
  const { unmount } = renderInApp(<LogPage />);
  await waitFor(() => {
    expect(rowsWithoutTime()).toEqual([
      ['drawing_list', 'batch', 'OK', '42 ms'],
      ['drawing_list', 'batch', 'Running', ''],
    ]);
  });
  expect(screen.getByRole('combobox', { name: 'Origin' })).toHaveTextContent('batch');

  // Every origin again, then a search: each change goes into the address.
  await user.click(screen.getByRole('combobox', { name: 'Origin' }));
  await user.click(screen.getByRole('option', { name: 'All origins' }));
  expect(window.location.search).toBe('');
  expect(rowsWithoutTime()).toHaveLength(5);
  await user.type(screen.getByRole('searchbox', { name: 'Search tools' }), 'Chart');
  expect(window.location.search).toBe('?q=Chart');
  expect(rowsWithoutTime().map(([tool]) => tool)).toEqual([
    'chart_get_state',
    'chart_set_symbol',
    'chart_get_state',
  ]);
  await user.click(screen.getByRole('combobox', { name: 'Status' }));
  await user.click(screen.getByRole('option', { name: 'Error' }));
  expect(window.location.pathname).toBe('/log');
  expect(window.location.search).toBe('?q=Chart&status=error');
  expect(rowsWithoutTime()).toEqual([
    ['chart_get_state', 'dashboard', 'INVALID_INPUT', '42 ms'],
    ['chart_set_symbol', 'mcp', 'TIMEOUT', '30,000 ms'],
  ]);
  // The address changed in place: Back leaves the log rather than undo a keystroke.
  expect(window.history.length).toBe(entries);

  // A reload keeps the filters.
  unmount();
  renderInApp(<LogPage />);
  await waitFor(() => {
    expect(rowsWithoutTime()).toHaveLength(2);
  });
  expect(screen.getByRole('searchbox', { name: 'Search tools' })).toHaveValue('Chart');
  expect(screen.getByRole('combobox', { name: 'Status' })).toHaveTextContent('Error');

  // When nothing matches, the table says so, and the filters reset in one go.
  await user.click(screen.getByRole('combobox', { name: 'Origin' }));
  await user.click(screen.getByRole('option', { name: 'batch' }));
  expect(screen.getByText('No calls match the filters.')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Reset filters' }));
  expect(window.location.search).toBe('');
  expect(rowsWithoutTime()).toHaveLength(5);
});

test('pause buffers new calls and resume shows them', async () => {
  const user = userEvent.setup();
  const api = serve();
  renderInApp(<LogPage />);
  await waitFor(() => {
    expect(rowsWithoutTime()).toHaveLength(3);
  });
  await user.click(screen.getByRole('button', { name: 'Pause' }));
  expect(screen.getByRole('button', { name: 'Resume' })).toHaveFocus();

  // The end of the call shown that runs, then two new calls.
  const connection = await api.stream.next();
  connection.send(endEvent(6, callId(3), 'drawing_list', { origin: 'batch' }));
  connection.send(startEvent(7, callId(4), 'app_health'));
  connection.send(endEvent(8, callId(4), 'app_health'));
  connection.send(startEvent(9, callId(5), 'chart_get_state'));
  expect(await screen.findByRole('button', { name: 'Resume (2 new)' })).toBeInTheDocument();
  // The table stands still, the running call included.
  expect(rowsWithoutTime()).toEqual([
    ['drawing_list', 'batch', 'Running', ''],
    ['chart_set_symbol', 'mcp', 'TIMEOUT', '30,000 ms'],
    ['chart_get_state', 'mcp', 'OK', '38 ms'],
  ]);

  await user.click(screen.getByRole('button', { name: 'Resume (2 new)' }));
  expect(rowsWithoutTime()).toEqual([
    ['chart_get_state', 'mcp', 'Running', ''],
    ['app_health', 'mcp', 'OK', '42 ms'],
    ['drawing_list', 'batch', 'OK', '42 ms'],
    ['chart_set_symbol', 'mcp', 'TIMEOUT', '30,000 ms'],
    ['chart_get_state', 'mcp', 'OK', '38 ms'],
  ]);
  // The same button, so the focus stays on it.
  expect(screen.getByRole('button', { name: 'Pause' })).toHaveFocus();
});

test('clear empties the table without closing the stream', async () => {
  const user = userEvent.setup();
  const api = serve();
  renderInApp(<LogPage />);
  await waitFor(() => {
    expect(rowsWithoutTime()).toHaveLength(3);
  });
  const connection = await api.stream.next();

  await user.click(screen.getByRole('button', { name: 'Clear' }));
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  expect(screen.getByText('No tool calls yet.')).toBeInTheDocument();
  expect(connection.closed).toBe(false);
  expect(streamState()).toHaveTextContent('Live');

  // The end of a call cleared while it ran stays out; a new call shows, on the same stream.
  connection.send(endEvent(6, callId(3), 'drawing_list', { origin: 'batch' }));
  connection.send(startEvent(7, callId(4), 'app_health'));
  await waitFor(() => {
    expect(rowsWithoutTime()).toEqual([['app_health', 'mcp', 'Running', '']]);
  });
  expect(api.stream.connections).toHaveLength(1);
});

test('the stream indicator and the missed-calls line follow the stream state', async () => {
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
  const api = serve();
  renderInApp(<LogPage />);
  expect(streamState()).toHaveTextContent('Connecting…');
  await waitFor(() => {
    expect(streamState()).toHaveTextContent('Live');
  });
  expect(screen.queryByText(MISSED)).not.toBeInTheDocument();

  // The server goes away, and comes back having lost events.
  const first = await api.stream.next();
  first.drop();
  await waitFor(() => {
    expect(streamState()).toHaveTextContent('Reconnecting…');
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  const second = await api.stream.next();
  await waitFor(() => {
    expect(streamState()).toHaveTextContent('Live');
  });
  second.gap();
  expect(await screen.findByText(MISSED)).toBeInTheDocument();

  // Clearing the log takes note of it.
  await user.click(screen.getByRole('button', { name: 'Clear' }));
  expect(screen.queryByText(MISSED)).not.toBeInTheDocument();
});

test('a call running when the stream had a gap shows Result not seen until its end comes', async () => {
  const api = serve();
  renderInApp(<LogPage />);
  await waitFor(() => {
    expect(rowsWithoutTime()).toHaveLength(3);
  });
  const connection = await api.stream.next();
  connection.gap();
  await waitFor(() => {
    expect(rowsWithoutTime()[0]).toEqual(['drawing_list', 'batch', 'Result not seen', '']);
  });
  connection.send(endEvent(6, callId(3), 'drawing_list', { origin: 'batch', durationMs: 75 }));
  await waitFor(() => {
    expect(rowsWithoutTime()[0]).toEqual(['drawing_list', 'batch', 'OK', '75 ms']);
  });
});

test('a row opens the details of its call, which follow the call live, and closing them returns to the row', async () => {
  const user = userEvent.setup();
  const api = serve();
  renderInApp(<LogPage />);
  await waitFor(() => {
    expect(rowsWithoutTime()).toHaveLength(3);
  });
  const button = within(table()).getByRole('button', {
    name: `Details of drawing_list at ${formatTime(at(500))}`,
  });
  await user.click(button);
  const dialog = screen.getByRole('dialog', { name: 'drawing_list' });
  expect(fact(dialog, 'Origin')).toBe('batch');
  expect(fact(dialog, 'Status')).toBe('Running');
  expect(within(dialog).getByRole('region', { name: 'Arguments' })).toHaveTextContent(
    '{ "limit": 10 }',
  );

  // Its end comes while the details are open.
  const connection = await api.stream.next();
  connection.send(endEvent(6, callId(3), 'drawing_list', { origin: 'batch', durationMs: 75 }));
  await waitFor(() => {
    expect(fact(dialog, 'Status')).toBe('OK');
  });
  expect(fact(dialog, 'Duration')).toBe('75 ms');

  await user.keyboard('{Escape}');
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  expect(button).toHaveFocus();
});

test('the details of a call the log lets go of stay as they were', async () => {
  const user = userEvent.setup();
  const api = serve([startEvent(1, callId(1), 'drawing_list', { args: { limit: 5 } })]);
  renderInApp(<LogPage />);
  await waitFor(() => {
    expect(rowsWithoutTime()).toHaveLength(1);
  });
  await user.click(within(table()).getByRole('button', { name: /^Details of drawing_list/ }));
  const dialog = screen.getByRole('dialog', { name: 'drawing_list' });

  // A thousand newer calls in one burst: the log keeps no more, so the oldest goes. The table is
  // hidden from the accessibility tree while the sheet is open, but still there.
  const connection = await api.stream.next();
  connection.write(
    callEvents(1000, 2, 2)
      .map((event) => `event: tool\ndata: ${JSON.stringify(event)}\n\n`)
      .join(''),
  );
  await waitFor(() => {
    expect(document.querySelector('tbody time')).toHaveAttribute('datetime', at(200_000));
  });
  expect(screen.getByRole('dialog', { name: 'drawing_list' })).toBe(dialog);
  expect(fact(dialog, 'Status')).toBe('Running');
  expect(within(dialog).getByRole('region', { name: 'Arguments' })).toHaveTextContent(
    '{ "limit": 5 }',
  );
});
