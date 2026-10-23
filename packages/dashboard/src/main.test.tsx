import { act, screen } from '@testing-library/react';
import type * as ReactDomClient from 'react-dom/client';
import { TEST_TOKEN } from './test/fixtures';

// The roots the entry creates, so that the test can unmount what it rendered.
const roots = vi.hoisted((): ReactDomClient.Root[] => []);

vi.mock('react-dom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactDomClient>();
  return {
    ...actual,
    createRoot: (...args: Parameters<typeof actual.createRoot>) => {
      const root = actual.createRoot(...args);
      roots.push(root);
      return root;
    },
  };
});

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
  document.body.innerHTML = '';
  window.history.replaceState(null, '', '/');
});

test('a token in the URL fragment is stored trimmed and removed from the address', async () => {
  document.body.innerHTML = '<div id="root"></div>';
  window.history.replaceState(null, '', `/log?origin=mcp#token=%20${TEST_TOKEN}%0A`);

  await act(async () => {
    await import('./main');
  });

  // The entry took the token before the first render, so the app shows, never the token form.
  expect(screen.queryByLabelText('Access token')).not.toBeInTheDocument();
  expect(await screen.findByRole('navigation', { name: 'Main' })).toBeInTheDocument();
  expect(sessionStorage.getItem('tvmcp.token')).toBe(TEST_TOKEN);
  expect(window.location.hash).toBe('');
  expect(window.location.pathname).toBe('/log');
  expect(window.location.search).toBe('?origin=mcp');
  expect(window.location.href).not.toContain(TEST_TOKEN);
});
