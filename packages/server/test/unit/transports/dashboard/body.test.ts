import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { BodyError, discardBody, readJsonBody } from '../../../../src/transports/dashboard/body.js';

const JSON_TYPE = { 'content-type': 'application/json' };

// A request whose body the test writes: a stream with the headers of an IncomingMessage.
function fakeRequest(headers: IncomingHttpHeaders = JSON_TYPE): {
  req: IncomingMessage;
  body: PassThrough;
} {
  const body = new PassThrough();
  const req = Object.assign(body, { headers }) as unknown as IncomingMessage;
  return { req, body };
}

// Whether a promise has settled by the time everything that is due has run.
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  return done;
}

async function bodyError(reading: Promise<unknown>): Promise<BodyError> {
  const error = await reading.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof BodyError)) {
    throw new Error(`Expected a BodyError, got ${String(error)}`);
  }
  return error;
}

test('readJsonBody parses a JSON body of any kind', async () => {
  for (const [text, value] of [
    ['{"arguments":{"symbol":"NASDAQ:AAPL"}}', { arguments: { symbol: 'NASDAQ:AAPL' } }],
    ['[1,2]', [1, 2]],
    ['"text"', 'text'],
    [' null ', null],
  ] as const) {
    const { req, body } = fakeRequest();
    body.end(text);

    await expect(readJsonBody(req)).resolves.toEqual(value);
  }
});

test('readJsonBody accepts a JSON media type with parameters, in any case', async () => {
  for (const type of ['application/json; charset=utf-8', 'Application/JSON', 'application/json ']) {
    const { req, body } = fakeRequest({ 'content-type': type });
    body.end('{}');

    await expect(readJsonBody(req)).resolves.toEqual({});
  }
});

// A character whose bytes arrive in two chunks must not be decoded half by half.
test('readJsonBody decodes UTF-8 that is split between chunks', async () => {
  const { req, body } = fakeRequest();
  const bytes = Buffer.from('{"note":"Prüfung €"}', 'utf8');
  const cut = bytes.indexOf(0xe2) + 1;

  const reading = readJsonBody(req);
  body.write(bytes.subarray(0, cut));
  body.end(bytes.subarray(cut));

  await expect(reading).resolves.toEqual({ note: 'Prüfung €' });
});

test.each<[string, IncomingHttpHeaders]>([
  ['text/plain', { 'content-type': 'text/plain' }],
  ['a form', { 'content-type': 'application/x-www-form-urlencoded' }],
  ['a JSON look-alike', { 'content-type': 'application/jsonx' }],
  ['no content type', {}],
])('readJsonBody refuses %s with 415 once the client has sent the body', async (_case, headers) => {
  const { req, body } = fakeRequest(headers);
  const reading = readJsonBody(req);
  body.write('{');

  expect(await settled(reading)).toBe(false);
  body.end('}');
  const error = await bodyError(reading);

  expect(error.status).toBe(415);
  expect(error.message).toContain('application/json');
  // The body was read and dropped, so the answer reaches a client that was still sending it.
  expect(body.readableEnded).toBe(true);
});

test('readJsonBody refuses a body announced as too large with 413, keeping none of it', async () => {
  const { req, body } = fakeRequest({ ...JSON_TYPE, 'content-length': '20' });
  const reading = readJsonBody(req, 10);
  body.write('{"a":"0123');

  expect(await settled(reading)).toBe(false);
  body.end('456789"}');
  const error = await bodyError(reading);

  expect(error.status).toBe(413);
  expect(error.message).toBe('The body is larger than 10 bytes');
  expect(body.readableEnded).toBe(true);
});

test('readJsonBody refuses a body that grows past the limit with 413 once the rest has come', async () => {
  const { req, body } = fakeRequest();
  const reading = readJsonBody(req, 10);
  body.write('{"a":"0123');
  body.write('4');
  // The client is still sending: what it sends is read and dropped, and the answer waits for its
  // end, so that the client reads the answer instead of finding the connection reset.
  body.write('x'.repeat(64 * 1024));

  expect(await settled(reading)).toBe(false);
  body.end();
  const error = await bodyError(reading);

  expect(error.status).toBe(413);
  expect(body.readableEnded).toBe(true);
});

test('readJsonBody takes a body of exactly the limit, and 1 MiB by default', async () => {
  const exact = fakeRequest();
  exact.body.end('"12345678"');
  const atDefault = fakeRequest();
  atDefault.body.end(`"${'x'.repeat(1_048_574)}"`);
  const overDefault = fakeRequest();
  overDefault.body.end(`"${'x'.repeat(1_048_575)}"`);

  await expect(readJsonBody(exact.req, 10)).resolves.toBe('12345678');
  await expect(readJsonBody(atDefault.req)).resolves.toHaveLength(1_048_574);
  expect((await bodyError(readJsonBody(overDefault.req))).status).toBe(413);
});

test.each(['', '{', '{"arguments": }', "{'a': 1}", 'NaN', '{"a":1} {"b":2}'])(
  'readJsonBody refuses %j with 400 and does not repeat it',
  async (text) => {
    const { req, body } = fakeRequest();
    body.end(text);

    const error = await bodyError(readJsonBody(req));

    expect(error.status).toBe(400);
    expect(error.message).toBe('The body is not valid JSON');
  },
);

test('readJsonBody refuses a request that ends before its body with 400', async () => {
  const { req, body } = fakeRequest();
  const reading = readJsonBody(req);
  body.write('{"arguments":');

  body.destroy();

  const error = await bodyError(reading);
  expect(error.status).toBe(400);
  expect(error.message).toContain('before its body');
});

test('readJsonBody refuses a request that fails before its body with 400', async () => {
  const { req, body } = fakeRequest();
  const reading = readJsonBody(req);

  body.destroy(new Error('socket hang up'));

  expect((await bodyError(reading)).status).toBe(400);
});

test('discardBody resolves once the client has sent the rest of the body', async () => {
  const { req, body } = fakeRequest();
  const discarding = discardBody(req);
  body.write('x'.repeat(64 * 1024));

  expect(await settled(discarding)).toBe(false);
  body.end('rest');

  await expect(discarding).resolves.toBeUndefined();
  expect(body.readableEnded).toBe(true);
});

test('discardBody resolves at once for a request that has ended or is gone', async () => {
  const ended = fakeRequest();
  ended.body.end();
  ended.body.resume();
  await expect.poll(() => ended.body.readableEnded).toBe(true);
  const gone = fakeRequest();
  gone.body.destroy();

  await expect(discardBody(ended.req)).resolves.toBeUndefined();
  await expect(discardBody(gone.req)).resolves.toBeUndefined();
});

test('discardBody gives up on a client that sends more than it drops, and on one that leaves', async () => {
  const flooding = fakeRequest();
  const leaving = fakeRequest();
  const failing = fakeRequest();
  const flooded = discardBody(flooding.req, 10);
  const left = discardBody(leaving.req);
  const failed = discardBody(failing.req);

  flooding.body.write('x'.repeat(11));
  leaving.body.destroy();
  failing.body.destroy(new Error('socket hang up'));

  await expect(flooded).resolves.toBeUndefined();
  expect(flooding.body.destroyed).toBe(true);
  await expect(left).resolves.toBeUndefined();
  await expect(failed).resolves.toBeUndefined();
});

test('discardBody drops 16 MiB by default before it gives up', async () => {
  const within = fakeRequest();
  const beyond = fakeRequest();
  const chunk = Buffer.alloc(1_048_576);
  const kept = discardBody(within.req);
  const dropped = discardBody(beyond.req);

  for (let n = 0; n < 16; n++) {
    within.body.write(chunk);
    beyond.body.write(chunk);
  }
  within.body.end();
  beyond.body.write('x');

  await expect(kept).resolves.toBeUndefined();
  await expect(dropped).resolves.toBeUndefined();
  // The one ended as its client ended it; the other was cut before its end.
  expect(within.body.readableEnded).toBe(true);
  expect(beyond.body.readableEnded).toBe(false);
  expect(beyond.body.destroyed).toBe(true);
});
