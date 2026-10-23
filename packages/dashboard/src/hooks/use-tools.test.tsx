import { renderHook, waitFor } from '@testing-library/react';
import { storeToken } from '@/api/token';
import { TEST_TOKEN, tools } from '@/test/fixtures';
import { withQueryClient } from '@/test/query';
import { useTools } from './use-tools';

test('useTools lists the tools of the server in its order', async () => {
  storeToken(TEST_TOKEN);
  const { result } = renderHook(() => useTools(), { wrapper: withQueryClient() });
  await waitFor(() => {
    expect(result.current.data).toEqual(tools);
  });
  expect(new Set(result.current.data?.map((tool) => tool.domain))).toEqual(
    new Set(['app', 'chart', 'drawing']),
  );
});
