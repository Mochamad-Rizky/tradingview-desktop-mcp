import { http, HttpResponse } from 'msw';
import { info, TEST_TOKEN, tools } from '@/test/fixtures';
import { server } from '@/test/server';
import { ApiError, apiGet, apiPost, onUnauthorized, UnexpectedAnswerError } from './client';
import { readToken, storeToken } from './token';

test('apiGet sends the stored token as a Bearer header and returns the JSON', async () => {
  storeToken(TEST_TOKEN);
  let seen: string | null = null;
  server.events.on('request:start', ({ request }) => {
    seen = request.headers.get('Authorization');
  });
  await expect(apiGet('/api/info')).resolves.toEqual(info);
  expect(seen).toBe(`Bearer ${TEST_TOKEN}`);
});

test('a token the browser would not write to storage still goes out with each request', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  });
  storeToken(TEST_TOKEN);
  let seen: string | null = null;
  server.events.on('request:start', ({ request }) => {
    seen = request.headers.get('Authorization');
  });
  await expect(apiGet('/api/info')).resolves.toEqual(info);
  expect(seen).toBe(`Bearer ${TEST_TOKEN}`);
});

test('without a token a request sends no Authorization header, and its 401 clears nothing', async () => {
  let seen: string | null = 'unset';
  server.events.on('request:start', ({ request }) => {
    seen = request.headers.get('Authorization');
  });
  const listener = vi.fn();
  const stop = onUnauthorized(listener);
  await expect(apiGet('/api/info')).rejects.toMatchObject({
    status: 401,
    message: 'Missing token',
  });
  expect(seen).toBeNull();
  expect(listener).not.toHaveBeenCalled();
  stop();
});

test('apiGet takes a token it is given over the stored one', async () => {
  storeToken('stale-token');
  await expect(apiGet('/api/tools', { token: TEST_TOKEN })).resolves.toEqual({ tools });
  expect(readToken()).toBe('stale-token');
});

test('apiPost sends its body as JSON', async () => {
  storeToken(TEST_TOKEN);
  let body: unknown;
  let type: string | null = null;
  server.use(
    http.post('/api/tools/chart_get_state', async ({ request }) => {
      type = request.headers.get('Content-Type');
      body = await request.json();
      return HttpResponse.json({ content: [] });
    }),
  );
  await expect(
    apiPost('/api/tools/chart_get_state', { arguments: { chartIndex: 1 } }),
  ).resolves.toEqual({ content: [] });
  expect(type).toBe('application/json');
  expect(body).toEqual({ arguments: { chartIndex: 1 } });
});

test('an error answer becomes an ApiError with the status and the message of the server', async () => {
  storeToken(TEST_TOKEN);
  const error = await apiPost('/api/tools/no_such_tool', {}).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({
    status: 404,
    message: 'This server offers no tool of that name',
    name: 'ApiError',
  });
  // The token stays: only a 401 says it is wrong.
  expect(readToken()).toBe(TEST_TOKEN);
});

test('an error answer without a JSON body is named by its status', async () => {
  storeToken(TEST_TOKEN);
  server.use(
    http.get('/api/health', () => new HttpResponse('upstream down', { status: 502 })),
    http.get('/api/info', () => HttpResponse.json({ unexpected: true }, { status: 500 })),
  );
  await expect(apiGet('/api/health')).rejects.toMatchObject({
    status: 502,
    message: 'The server answered 502',
  });
  await expect(apiGet('/api/info')).rejects.toMatchObject({
    status: 500,
    message: 'The server answered 500',
  });
});

// A page in place of the JSON, such as a proxy's: something answered, so the server is not out of
// reach, but the answer is not the server's.
test('a success that is not JSON is an unexpected answer', async () => {
  storeToken(TEST_TOKEN);
  server.use(
    http.get(
      '/api/info',
      () =>
        new HttpResponse('<!doctype html><title>Synthetic proxy</title>', {
          headers: { 'Content-Type': 'text/html' },
        }),
    ),
  );
  const error = await apiGet('/api/info').catch((e: unknown) => e);
  expect(error).toBeInstanceOf(UnexpectedAnswerError);
  expect(error).toMatchObject({
    name: 'UnexpectedAnswerError',
    message: 'The server sent an unexpected answer',
  });
  expect(readToken()).toBe(TEST_TOKEN);
});

// A body that breaks off is a connection that failed, not an answer of another kind.
test('a success whose body breaks off fails as it is, not as an unexpected answer', async () => {
  storeToken(TEST_TOKEN);
  server.use(
    http.get(
      '/api/info',
      () =>
        new HttpResponse(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"name":'));
              controller.error(new TypeError('The connection dropped'));
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    ),
  );
  const error = await apiGet('/api/info').catch((e: unknown) => e);
  expect(error).toBeInstanceOf(TypeError);
  expect(error).not.toBeInstanceOf(UnexpectedAnswerError);
});

test('a 401 clears the token, throws, and tells the subscribers once each', async () => {
  storeToken('wrong-token');
  const first = vi.fn();
  const second = vi.fn();
  const stopFirst = onUnauthorized(first);
  const stopSecond = onUnauthorized(second);

  await expect(apiGet('/api/info')).rejects.toMatchObject({
    status: 401,
    message: 'Invalid token',
  });
  expect(readToken()).toBeNull();
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);

  // After unsubscribing, a listener hears nothing more.
  stopFirst();
  storeToken('another-wrong-token');
  await expect(apiGet('/api/health')).rejects.toBeInstanceOf(ApiError);
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(2);
  stopSecond();
});

test('a 401 for a token that was replaced meanwhile keeps the new token', async () => {
  storeToken('old-token');
  const listener = vi.fn();
  const stop = onUnauthorized(listener);
  let arrived = false;
  let release: () => void = () => undefined;
  server.use(
    http.get('/api/info', async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
        arrived = true;
      });
      return HttpResponse.json({ error: 'Invalid token' }, { status: 401 });
    }),
  );
  const pending = apiGet('/api/info');
  // The user enters another token while the request with the old one is on its way.
  await vi.waitFor(() => {
    expect(arrived).toBe(true);
  });
  storeToken(TEST_TOKEN);
  release();
  await expect(pending).rejects.toMatchObject({ status: 401 });
  expect(readToken()).toBe(TEST_TOKEN);
  expect(listener).not.toHaveBeenCalled();
  stop();
});

test('a 401 to a token the caller passed leaves the stored token and the subscribers alone', async () => {
  storeToken(TEST_TOKEN);
  const listener = vi.fn();
  const stop = onUnauthorized(listener);
  await expect(apiGet('/api/info', { token: 'candidate' })).rejects.toMatchObject({
    status: 401,
  });
  expect(readToken()).toBe(TEST_TOKEN);
  expect(listener).not.toHaveBeenCalled();
  stop();
});
