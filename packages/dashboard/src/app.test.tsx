import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './app';

const html = document.documentElement;

// The app finds its page in the address bar, the way it does when the server sends it for /log.
function visit(path: string): void {
  window.history.replaceState(null, '', path);
}

function pageHeading(): HTMLElement {
  return within(screen.getByRole('main')).getByRole('heading', { level: 1 });
}

function navLink(name: string): HTMLElement {
  return within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name });
}

// What a browser reports for prefers-color-scheme: dark, and for no other query.
function prefersDark(): void {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string): MediaQueryList => ({
    matches: query === '(prefers-color-scheme: dark)',
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

afterEach(() => {
  visit('/');
  html.classList.remove('dark');
});

test('the app shell renders the nav and switches pages by path', async () => {
  const user = userEvent.setup();
  visit('/tools');
  const { unmount } = render(<App />);

  expect(within(screen.getByRole('banner')).getByText('TradingView MCP')).toBeInTheDocument();
  const links = within(screen.getByRole('navigation', { name: 'Main' })).getAllByRole('link');
  expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
    ['Status', '/'],
    ['Log', '/log'],
    ['Tools', '/tools'],
  ]);
  expect(pageHeading()).toHaveTextContent('Tools');
  expect(navLink('Tools')).toHaveAttribute('aria-current', 'page');

  await user.click(navLink('Log'));
  expect(window.location.pathname).toBe('/log');
  expect(pageHeading()).toHaveTextContent('Log');
  expect(navLink('Log')).toHaveAttribute('aria-current', 'page');
  expect(navLink('Tools')).not.toHaveAttribute('aria-current');

  await user.click(navLink('Status'));
  expect(window.location.pathname).toBe('/');
  expect(pageHeading()).toHaveTextContent('Status');

  // A path the dashboard has no page for, which the server answers with the page all the same.
  unmount();
  visit('/no-such-page');
  render(<App />);
  expect(pageHeading()).toHaveTextContent('Page not found');
  await user.click(
    within(screen.getByRole('main')).getByRole('link', { name: 'Go to the status page' }),
  );
  expect(pageHeading()).toHaveTextContent('Status');
});

test('the theme toggle switches the dark class and remembers the choice', async () => {
  const user = userEvent.setup();
  const first = render(<App />);

  // Nothing chosen yet, and the system prefers light.
  expect(html).not.toHaveClass('dark');
  await user.click(screen.getByRole('button', { name: 'Switch to dark theme' }));
  expect(html).toHaveClass('dark');
  expect(localStorage.getItem('tvmcp.theme')).toBe('dark');

  // A reload keeps the choice over the system's preference.
  first.unmount();
  html.classList.remove('dark');
  render(<App />);
  expect(html).toHaveClass('dark');

  await user.click(screen.getByRole('button', { name: 'Switch to light theme' }));
  expect(html).not.toHaveClass('dark');
  expect(localStorage.getItem('tvmcp.theme')).toBe('light');
});

test('the theme follows the system until a choice is stored', () => {
  prefersDark();
  // A value this dashboard never stores counts as no choice.
  localStorage.setItem('tvmcp.theme', 'sepia');
  const first = render(<App />);
  expect(html).toHaveClass('dark');
  expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument();

  first.unmount();
  localStorage.setItem('tvmcp.theme', 'light');
  render(<App />);
  expect(html).not.toHaveClass('dark');
});

test('the theme toggle still switches when the browser refuses storage', async () => {
  const user = userEvent.setup();
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  });
  render(<App />);

  await user.click(screen.getByRole('button', { name: 'Switch to dark theme' }));
  expect(html).toHaveClass('dark');
});
