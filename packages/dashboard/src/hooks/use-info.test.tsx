import { renderHook, waitFor } from '@testing-library/react';
import { storeToken } from '@/api/token';
import { info, TEST_TOKEN } from '@/test/fixtures';
import { withQueryClient } from '@/test/query';
import { useInfo } from './use-info';

test('useInfo reads the server facts from /api/info', async () => {
  storeToken(TEST_TOKEN);
  const { result } = renderHook(() => useInfo(), { wrapper: withQueryClient() });
  await waitFor(() => {
    expect(result.current.data).toEqual(info);
  });
});
