import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { ApiError } from '@/api/client';
import { storeToken } from '@/api/token';
import { callResults, TEST_TOKEN } from '@/test/fixtures';
import { createFakeApi } from '@/test/handlers';
import { withQueryClient } from '@/test/query';
import { server } from '@/test/server';
import { useCallTool } from './use-call-tool';

beforeEach(() => {
  storeToken(TEST_TOKEN);
});

test('useCallTool posts the arguments to the tool and returns its result', async () => {
  const api = createFakeApi();
  server.use(...api.handlers);
  const { result } = renderHook(() => useCallTool(), { wrapper: withQueryClient() });

  act(() => {
    result.current.mutate({ name: 'app_get_plan_limits' });
  });
  await waitFor(() => {
    expect(result.current.data).toEqual(callResults.app_get_plan_limits);
  });
  // No arguments are sent as an empty object, as the server takes them.
  expect(api.calls).toEqual([{ name: 'app_get_plan_limits', body: { arguments: {} } }]);

  await act(async () => {
    await result.current.mutateAsync({
      name: 'chart_set_symbol',
      arguments: { symbol: 'NASDAQ:AAPL' },
    });
  });
  expect(api.calls[1]).toEqual({
    name: 'chart_set_symbol',
    body: { arguments: { symbol: 'NASDAQ:AAPL' } },
  });
  // A failed call is a result like any other.
  await waitFor(() => {
    expect(result.current.data?.isError).toBe(true);
  });
});

test('useCallTool escapes the tool name in the path and reports a refused call', async () => {
  let path = '';
  server.use(
    http.post('/api/tools/:name', ({ request }) => {
      path = new URL(request.url).pathname;
      return HttpResponse.json(
        { error: 'This server offers no tool of that name' },
        { status: 404 },
      );
    }),
  );
  const { result } = renderHook(() => useCallTool(), { wrapper: withQueryClient() });
  act(() => {
    result.current.mutate({ name: 'odd/name?' });
  });
  await waitFor(() => {
    expect(result.current.error).toBeInstanceOf(ApiError);
  });
  expect(path).toBe('/api/tools/odd%2Fname%3F');
  expect(result.current.error).toMatchObject({ status: 404 });
});
