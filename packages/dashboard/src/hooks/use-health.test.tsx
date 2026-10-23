import { act, render, screen } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { storeToken } from '@/api/token';
import { health, TEST_TOKEN } from '@/test/fixtures';
import { withQueryClient } from '@/test/query';
import { server } from '@/test/server';
import { useHealth } from './use-health';

// The status page and the header badge both watch the health.
function Endpoint() {
  const { data } = useHealth();
  return <p>{data?.cdp.endpoint ?? 'Checking'}</p>;
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  storeToken(TEST_TOKEN);
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

test('useHealth never starts a second request while one is in flight', async () => {
  let requests = 0;
  let inFlight = 0;
  let mostInFlight = 0;
  // A check that takes 12 s, longer than two polling periods: TradingView hangs.
  server.use(
    http.get('/api/health', async () => {
      requests += 1;
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      await delay(12_000);
      inFlight -= 1;
      return HttpResponse.json(health);
    }),
  );
  const Wrapper = withQueryClient();
  render(
    <Wrapper>
      <Endpoint />
      <Endpoint />
    </Wrapper>,
  );

  await advance(0);
  expect(requests).toBe(1);
  // The ticks at 5 s and 10 s find the first check still running, and start nothing.
  await advance(11_000);
  expect(requests).toBe(1);
  // It answers at 12 s, and both components show it.
  await advance(1_000);
  expect(inFlight).toBe(0);
  await advance(1_000);
  expect(screen.getAllByText('http://127.0.0.1:9222')).toHaveLength(2);
  // The next check starts five seconds after the answer, at 17 s.
  await advance(3_000);
  expect(requests).toBe(1);
  await advance(2_000);
  expect(requests).toBe(2);
  // It answers at 29 s, past the ticks at 22 s and 27 s, and the third starts at 34 s.
  await advance(15_000);
  expect(requests).toBe(2);
  await advance(2_000);
  expect(requests).toBe(3);
  expect(mostInFlight).toBe(1);
});

test('useHealth checks again five seconds after each answer', async () => {
  let requests = 0;
  server.use(
    http.get('/api/health', () => {
      requests += 1;
      return HttpResponse.json(health);
    }),
  );
  render(<Endpoint />, { wrapper: withQueryClient() });
  await advance(10);
  expect(requests).toBe(1);
  expect(screen.getByText('http://127.0.0.1:9222')).toBeInTheDocument();
  await advance(4_890);
  expect(requests).toBe(1);
  await advance(200);
  expect(requests).toBe(2);
  await advance(10_000);
  expect(requests).toBe(4);
});
