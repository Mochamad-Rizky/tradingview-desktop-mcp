import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { storeToken } from '@/api/token';
import { errorResult, okResult, TEST_TOKEN, toolNamed } from '@/test/fixtures';
import { createFakeApi } from '@/test/handlers';
import { fact, renderInApp } from '@/test/render';
import { server } from '@/test/server';
import { drawingCreate } from '@/test/tool-schemas';
import { ToolDetail } from './tool-detail';

function detail(): HTMLElement {
  return screen.getByRole('article');
}

function result(): HTMLElement {
  return screen.getByRole('region', { name: 'Result' });
}

function runButton(): HTMLElement {
  return within(detail()).getByRole('button', { name: 'Run' });
}

// The item of the field `name` in the list of input fields.
function field(name: string): HTMLElement {
  const list = screen.getByRole('list', { name: 'Input fields' });
  const item = within(list).getByText(name, { selector: 'code' }).closest('li');
  if (item === null) {
    throw new Error(`No input field ${name}`);
  }
  return item;
}

function constraints(name: string): string[] {
  const list = within(field(name)).queryByRole('list', { name: `Constraints of ${name}` });
  return list === null
    ? []
    : within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent);
}

async function writeArgs(user: UserEvent, text: string): Promise<void> {
  const editor = screen.getByRole('textbox', { name: 'Arguments (JSON)' });
  await user.clear(editor);
  await user.click(editor);
  await user.paste(text);
}

// A tool call that answers only when the test lets it, and counts the requests.
function heldCall(name: string) {
  const held: { requests: number; answer: () => void } = { requests: 0, answer: () => undefined };
  server.use(
    http.post(`/api/tools/${name}`, async () => {
      held.requests += 1;
      await new Promise<void>((resolve) => {
        held.answer = resolve;
      });
      return HttpResponse.json(okResult({ done: true }));
    }),
  );
  return held;
}

beforeEach(() => {
  storeToken(TEST_TOKEN);
});

test('the detail shows the description paragraphs and the schema fields with constraints', () => {
  const { rerender } = renderInApp(<ToolDetail tool={toolNamed('chart_set_symbol')} />);
  expect(within(detail()).getByRole('heading', { level: 2 })).toHaveTextContent(
    'Change the chart symbol',
  );
  expect(within(detail()).getByText('chart_set_symbol', { selector: 'code' })).toBeInTheDocument();
  // Each paragraph of the description stays a paragraph.
  const first = within(detail()).getByText(
    'Switches a chart to another symbol and waits until its data has loaded.',
  );
  const second = within(detail()).getByText(/^A symbol TradingView does not know fails/);
  expect([first.tagName, second.tagName]).toEqual(['P', 'P']);
  expect(first).not.toBe(second);

  expect(fact(detail(), 'Domain')).toBe('chart');
  expect(fact(detail(), 'Read-only')).toBe('No');
  expect(fact(detail(), 'Destructive')).toBe('No');
  expect(fact(detail(), 'Idempotent')).toBe('Yes');
  expect(fact(detail(), 'Open world')).toBe('No');
  expect(fact(detail(), 'Profiles')).toBe('full, core');

  expect(within(field('symbol')).getByText('string')).toBeInTheDocument();
  expect(within(field('symbol')).getByText('required')).toBeInTheDocument();
  expect(field('symbol')).toHaveTextContent(
    'Symbol to show, best as EXCHANGE:SYMBOL such as NASDAQ:AAPL.',
  );
  expect(constraints('symbol')).toEqual(['length 1 to 200', 'pattern ^[A-Z0-9_.:!]+$']);
  expect(within(field('chartIndex')).getByText('integer')).toBeInTheDocument();
  expect(within(field('chartIndex')).getByText('optional')).toBeInTheDocument();
  expect(constraints('chartIndex')).toEqual(['at least 0']);

  rerender(<ToolDetail tool={toolNamed('drawing_list')} />);
  expect(constraints('limit')).toEqual(['1 to 500', 'default: 100']);
  expect(fact(detail(), 'Read-only')).toBe('Yes');
  expect(fact(detail(), 'Profiles')).toBe('full, core, readonly');

  rerender(<ToolDetail tool={toolNamed('drawing_clear_all')} />);
  expect(constraints('scope')).toEqual(['one of: created_by_mcp, all']);
  expect(constraints('confirm')).toEqual([]);
  expect(fact(detail(), 'Destructive')).toBe('Yes');

  // Nested fields go by their path.
  rerender(<ToolDetail tool={drawingCreate} />);
  expect(within(field('points[].time')).getByText('string | number')).toBeInTheDocument();
  expect(constraints('points[].time')).toEqual(['length 1 to 64 (string)']);
  expect(constraints('style.lineWidth')).toEqual(['1 to 4']);

  rerender(<ToolDetail tool={toolNamed('app_health')} />);
  expect(within(detail()).getByText('This tool takes no arguments.')).toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'Input fields' })).not.toBeInTheDocument();
});

test('a read-only tool runs at once and shows its result', async () => {
  const user = userEvent.setup();
  const api = createFakeApi();
  server.use(...api.handlers);
  renderInApp(<ToolDetail tool={toolNamed('chart_get_state')} />);
  expect(result()).toHaveTextContent('Not run yet.');

  await user.click(runButton());
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  // The focus follows the run, so that a screen reader hears how it went.
  expect(result()).toHaveFocus();
  await waitFor(() => {
    expect(within(result()).getByRole('status')).toHaveTextContent('OK');
  });
  expect(fact(result(), 'Via')).toBe('api');
  expect(fact(result(), 'Duration')).toBe('12 ms');
  expect(result()).toHaveTextContent('"symbol": "NASDAQ:AAPL"');
  expect(api.calls).toEqual([{ name: 'chart_get_state', body: { arguments: {} } }]);
  expect(runButton()).toBeEnabled();
});

test('a tool that changes things asks for confirmation, and Cancel sends nothing', async () => {
  const user = userEvent.setup();
  const api = createFakeApi();
  server.use(...api.handlers);
  renderInApp(<ToolDetail tool={toolNamed('chart_set_symbol')} />);
  await writeArgs(user, '{"symbol": "NASDAQ:MSFT"}');

  await user.click(runButton());
  const dialog = screen.getByRole('alertdialog', { name: 'Run chart_set_symbol?' });
  expect(dialog).toHaveAccessibleDescription('It acts on your TradingView.');
  expect(within(dialog).getByRole('region', { name: 'Arguments' })).toHaveTextContent(
    '{ "symbol": "NASDAQ:MSFT" }',
  );
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  await waitFor(() => {
    expect(runButton()).toHaveFocus();
  });

  await user.click(runButton());
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(api.calls).toEqual([]);
  expect(result()).toHaveTextContent('Not run yet.');

  // Confirmed, the call goes out with the arguments as written.
  await user.click(runButton());
  await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Run' }));
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  await waitFor(() => {
    expect(within(result()).getByRole('status')).toHaveTextContent('Error');
  });
  expect(within(result()).getByRole('alert')).toHaveTextContent('INVALID_INPUT');
  expect(api.calls).toEqual([
    { name: 'chart_set_symbol', body: { arguments: { symbol: 'NASDAQ:MSFT' } } },
  ]);
  await waitFor(() => {
    expect(result()).toHaveFocus();
  });
});

test("the arguments go to the server as written, and the server's rules decide", async () => {
  const user = userEvent.setup();
  const api = createFakeApi({
    results: {
      drawing_clear_all: errorResult({
        code: 'CONFIRMATION_REQUIRED',
        message: 'Removing every drawing needs confirm: true',
        hint: 'Call drawing_clear_all again with confirm: true.',
      }),
    },
  });
  server.use(...api.handlers);
  renderInApp(<ToolDetail tool={toolNamed('drawing_clear_all')} />);
  await writeArgs(user, '{"scope": "all"}');

  await user.click(runButton());
  const dialog = screen.getByRole('alertdialog', { name: 'Run drawing_clear_all?' });
  expect(dialog).toHaveAccessibleDescription(
    'It acts on your TradingView. It can remove or replace data.',
  );
  await user.click(within(dialog).getByRole('button', { name: 'Run' }));

  // The dialog of the dashboard is no confirmation of the tool's own: nothing is added.
  await waitFor(() => {
    expect(within(result()).getByRole('alert')).toHaveTextContent('CONFIRMATION_REQUIRED');
  });
  expect(within(result()).getByRole('alert')).toHaveTextContent(
    'Call drawing_clear_all again with confirm: true.',
  );
  expect(api.calls).toEqual([{ name: 'drawing_clear_all', body: { arguments: { scope: 'all' } } }]);

  // A request the server refuses says why.
  server.use(
    http.post('/api/tools/drawing_clear_all', () =>
      HttpResponse.json({ error: 'This server offers no tool of that name' }, { status: 404 }),
    ),
  );
  await user.click(runButton());
  await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Run' }));
  await waitFor(() => {
    expect(within(result()).getByRole('alert')).toHaveTextContent(
      'The tool could not be run: This server offers no tool of that name.',
    );
  });
});

test('a double click on Run sends one request, and Run waits while the run is in progress', async () => {
  const user = userEvent.setup();
  const held = heldCall('chart_get_state');
  renderInApp(<ToolDetail tool={toolNamed('chart_get_state')} />);

  // Two clicks before the page has drawn anything new.
  fireEvent.click(runButton());
  fireEvent.click(runButton());
  await waitFor(() => {
    expect(runButton()).toBeDisabled();
  });
  await user.dblClick(runButton());
  expect(within(result()).getByRole('status')).toHaveTextContent('Running chart_get_state…');
  await waitFor(() => {
    expect(held.requests).toBe(1);
  });

  held.answer();
  await waitFor(() => {
    expect(runButton()).toBeEnabled();
  });
  expect(within(result()).getByRole('status')).toHaveTextContent('OK');
  expect(held.requests).toBe(1);

  // Once the run is over, a new one can start.
  await user.click(runButton());
  await waitFor(() => {
    expect(held.requests).toBe(2);
  });
  held.answer();
  await waitFor(() => {
    expect(runButton()).toBeEnabled();
  });
});

test("a double click on the dialog's Run sends one request", async () => {
  const user = userEvent.setup();
  const held = heldCall('chart_set_symbol');
  renderInApp(<ToolDetail tool={toolNamed('chart_set_symbol')} />);

  await user.click(runButton());
  await user.dblClick(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Run' }));
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  await waitFor(() => {
    expect(runButton()).toBeDisabled();
  });
  await user.click(runButton());
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

  held.answer();
  await waitFor(() => {
    expect(runButton()).toBeEnabled();
  });
  expect(held.requests).toBe(1);

  // Two clicks that land before the dialog has closed.
  await user.click(runButton());
  const run = within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Run' });
  act(() => {
    run.click();
    run.click();
  });
  await waitFor(() => {
    expect(held.requests).toBe(2);
  });
  held.answer();
  await waitFor(() => {
    expect(runButton()).toBeEnabled();
  });
  expect(held.requests).toBe(2);
});
