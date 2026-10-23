import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { storeToken } from '@/api/token';
import { info, TEST_TOKEN } from '@/test/fixtures';
import { createFakeApi } from '@/test/handlers';
import { fact, renderInApp } from '@/test/render';
import { server } from '@/test/server';
import { ServerCard } from './server-card';

function card(): HTMLElement {
  return screen.getByRole('region', { name: 'Server' });
}

beforeEach(() => {
  storeToken(TEST_TOKEN);
});

test('the server card shows a stdio server, with ui_evaluate allowed and its tool filter', async () => {
  const api = createFakeApi({
    info: {
      ...info,
      transport: 'stdio',
      mcpEndpoint: null,
      profile: 'core',
      toolPatterns: ['chart_*', 'data_*'],
      toolCount: 12,
      allowEval: true,
    },
  });
  server.use(...api.handlers);
  renderInApp(<ServerCard />);

  await waitFor(() => {
    expect(fact(card(), 'Transport')).toBe('stdio');
  });
  expect(fact(card(), 'MCP endpoint')).toBe('stdio');
  expect(fact(card(), 'Profile')).toBe('core');
  expect(fact(card(), 'Tool filter')).toBe('chart_*, data_*');
  expect(fact(card(), 'Tools')).toBe('12');
  expect(fact(card(), 'ui_evaluate')).toBe('Allowed');
});

test('the server card says when the server facts cannot be read', async () => {
  server.use(
    http.get('/api/info', () => HttpResponse.json({ error: 'Internal error' }, { status: 500 })),
  );
  renderInApp(<ServerCard />);
  expect(await within(card()).findByRole('alert')).toHaveTextContent(
    'The server facts could not be read: Internal error.',
  );
});
