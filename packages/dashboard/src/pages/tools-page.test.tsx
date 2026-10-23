import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { StrictMode } from 'react';
import { storeToken } from '@/api/token';
import { App } from '@/app';
import { TEST_TOKEN, tools } from '@/test/fixtures';
import { createFakeApi } from '@/test/handlers';
import { server } from '@/test/server';

// The app finds its page in the address bar, as when the server sends it for a link.
function visit(path: string): void {
  window.history.replaceState(null, '', path);
}

function pageHeading(): HTMLElement {
  return within(screen.getByRole('main')).getByRole('heading', { level: 1 });
}

function toolHeading(name: string): HTMLElement {
  return within(screen.getByRole('main')).getByRole('heading', { level: 2, name });
}

function navLink(name: string): HTMLElement {
  return within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name });
}

// The section a heading names.
function sectionOf(heading: HTMLElement): HTMLElement {
  const section = heading.closest('section');
  if (section === null) {
    throw new Error('The heading is in no section');
  }
  return section;
}

function listLink(name: string): HTMLElement {
  return within(screen.getByRole('list', { name: 'Tools' })).getByRole('link', {
    name: new RegExp(`^${name}`),
  });
}

beforeEach(() => {
  storeToken(TEST_TOKEN);
});

afterEach(() => {
  // Unmounted first, so that the router does not render the change of address outside act.
  cleanup();
  visit('/');
});

test('/tools/<name> opens that tool, and an unknown name says it is not offered', async () => {
  const user = userEvent.setup();
  visit('/tools/chart_set_symbol');
  const first = render(<App />);
  await screen.findByRole('heading', { level: 2, name: 'Change the chart symbol' });
  expect(pageHeading()).toHaveTextContent('Tools');
  expect(document.title).toBe('Tools · TradingView MCP Dashboard');
  expect(listLink('chart_set_symbol')).toHaveAttribute('aria-current', 'page');
  // The main navigation still says which page this is part of.
  expect(navLink('Tools')).toHaveAttribute('aria-current', 'true');

  first.unmount();
  visit('/tools/no_such_tool');
  render(<App />);
  const panel = sectionOf(
    await screen.findByRole('heading', { level: 2, name: 'Tool not offered' }),
  );
  expect(panel).toHaveTextContent("no_such_tool is not offered by this server's profile.");
  expect(screen.queryByRole('article')).not.toBeInTheDocument();
  // The list is there to pick another.
  expect(listLink('chart_get_state')).not.toHaveAttribute('aria-current');

  await user.click(within(panel).getByRole('link', { name: 'Show all tools' }));
  expect(window.location.pathname).toBe('/tools');
  expect(
    screen.getByText('Choose a tool from the list to read about it and run it.'),
  ).toBeInTheDocument();
  expect(navLink('Tools')).toHaveAttribute('aria-current', 'page');
});

test("a tool the server's profile leaves out is not offered", async () => {
  const api = createFakeApi({ tools: tools.filter((tool) => tool.profiles.includes('core')) });
  server.use(...api.handlers);
  visit('/tools/drawing_clear_all');
  render(<App />);
  const missing = await screen.findByRole('heading', { level: 2, name: 'Tool not offered' });
  expect(sectionOf(missing)).toHaveTextContent(
    "drawing_clear_all is not offered by this server's profile.",
  );
  expect(screen.getByRole('list', { name: 'Tools' })).not.toHaveTextContent('drawing_clear_all');
});

test('a link to a tool says so when the tools cannot be read', async () => {
  server.use(
    http.get('/api/tools', () => HttpResponse.json({ error: 'Not here' }, { status: 404 })),
  );
  visit('/tools/chart_set_symbol');
  render(<App />);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'The tools could not be read: Not here.',
  );
  expect(pageHeading()).toHaveTextContent('Tools');
});

test('opening a tool from the list puts the focus on its heading, and moving between tools never on the page heading', async () => {
  const user = userEvent.setup();
  visit('/tools');
  // StrictMode runs the effects of the first render twice, which must not count as a move.
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  await screen.findByRole('list', { name: 'Tools' });
  expect(document.body).toHaveFocus();

  await user.click(listLink('chart_set_symbol'));
  expect(window.location.pathname).toBe('/tools/chart_set_symbol');
  expect(toolHeading('Change the chart symbol')).toHaveFocus();

  // By keyboard, from the list to another tool.
  listLink('drawing_list').focus();
  await user.keyboard('{Enter}');
  expect(window.location.pathname).toBe('/tools/drawing_list');
  expect(toolHeading('List the drawings')).toHaveFocus();
  expect(pageHeading()).not.toHaveFocus();

  // Back to a tool seen before.
  act(() => {
    window.history.pushState(null, '', '/tools/chart_set_symbol');
  });
  expect(toolHeading('Change the chart symbol')).toHaveFocus();
});

test('a move to the tools page or from another page focuses the page heading, and a link to a tool focuses nothing', async () => {
  const user = userEvent.setup();
  visit('/tools/chart_set_symbol');
  render(<App />);
  await screen.findByRole('heading', { level: 2, name: 'Change the chart symbol' });
  expect(document.body).toHaveFocus();

  await user.click(navLink('Tools'));
  expect(window.location.pathname).toBe('/tools');
  expect(pageHeading()).toHaveFocus();

  await user.click(navLink('Log'));
  expect(pageHeading()).toHaveTextContent('Live log');
  // Straight from another page to a tool, as Back or Forward go.
  act(() => {
    window.history.pushState(null, '', '/tools/drawing_list');
  });
  expect(toolHeading('List the drawings')).toBeInTheDocument();
  expect(pageHeading()).toHaveTextContent('Tools');
  expect(pageHeading()).toHaveFocus();
});
