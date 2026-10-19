import { createCriConnector } from '../../../../src/core/cdp/cri-connector.js';
import type { CdpTargetInfo } from '../../../../src/core/cdp/types.js';
import { TvMcpError } from '../../../../src/core/errors.js';

// The library is replaced here, to reach the failures the real one only produces by timing luck
// and to look at what the adapter hands to it. The integration test runs the real library against
// the fake CDP server. Port 9 (discard) stands in for the debug port, so that a mock that failed to
// apply would not reach a TradingView that runs with the default port open.
const library = vi.hoisted(() => ({
  connect: vi.fn<(options: unknown) => Promise<unknown>>(),
  // Stands in for the class the library rejects a command with when the target answers with an
  // error. It is not needed by the tests below, but the adapter reads it from the module.
  ProtocolError: class ProtocolError extends Error {},
}));

vi.mock('chrome-remote-interface', () => ({
  default: Object.assign((options: unknown) => library.connect(options), {
    ProtocolError: library.ProtocolError,
  }),
}));

const TARGET: CdpTargetInfo = { id: 'TARGET', type: 'page', title: '', url: '' };

function fakeClient() {
  const disconnectListeners: (() => void)[] = [];
  return {
    send: vi.fn<(method: string, params?: object) => Promise<unknown>>(() => Promise.resolve({})),
    on: vi.fn((_event: 'disconnect', listener: () => void) => {
      disconnectListeners.push(listener);
    }),
    close: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    disconnect() {
      for (const listener of disconnectListeners) {
        listener();
      }
    },
  };
}

async function connectOver(client: ReturnType<typeof fakeClient>, target = TARGET) {
  library.connect.mockResolvedValue(client);
  return createCriConnector({ host: '127.0.0.1', port: 9, defaultTimeoutMs: 1000 }).connect(target);
}

// Resolves with the error of a call that must fail with one of ours.
async function failureOf(call: Promise<unknown>): Promise<TvMcpError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof TvMcpError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the call to reject');
}

beforeEach(() => {
  library.connect.mockReset();
});

test('connects through the listed debugger URL with the protocol descriptor of the library', async () => {
  const url = 'ws://127.0.0.1:9/devtools/page/TARGET';

  await connectOver(fakeClient(), { ...TARGET, webSocketDebuggerUrl: url });

  // No host and port: the library has nothing to look up, and `local` keeps it from fetching
  // /json/protocol from the app.
  expect(library.connect).toHaveBeenCalledExactlyOnceWith({ target: url, local: true });
});

test('hands the library the URL the way the URL parser reads it', async () => {
  // The library parses URLs on its own, with another parser. Passing it what was checked, and
  // not the original text, leaves nothing for the two readings to disagree about.
  await connectOver(fakeClient(), {
    ...TARGET,
    webSocketDebuggerUrl: 'ws://LOCALHOST:9/devtools/page/TA\tRGET',
  });

  expect(library.connect).toHaveBeenCalledExactlyOnceWith({
    target: 'ws://localhost:9/devtools/page/TARGET',
    local: true,
  });
});

test('has the library look the target up by id on the configured address when no URL is listed', async () => {
  library.connect.mockResolvedValue(fakeClient());
  const connector = createCriConnector({ host: '::1', port: 9333, defaultTimeoutMs: 1000 });

  await connector.connect(TARGET);

  // The library takes the host as a name and not as part of a URL, so the address has no brackets.
  expect(library.connect).toHaveBeenCalledExactlyOnceWith({
    host: '::1',
    port: 9333,
    target: 'TARGET',
    local: true,
  });
});

test.each([
  ['a rejection that is not an Error', 'refused'],
  ['an error whose code is not an errno name', Object.assign(new Error('odd'), { code: 7 })],
])('leaves the errno out of the details for %s', async (_label, failure) => {
  library.connect.mockRejectedValue(failure);
  const connector = createCriConnector({ host: '127.0.0.1', port: 9, defaultTimeoutMs: 1000 });

  const error = await failureOf(connector.connect(TARGET));

  expect(error.code).toBe('CDP_UNREACHABLE');
  expect(error.details).toEqual({ targetId: 'TARGET', endpoint: 'ws://127.0.0.1:9' });
  expect(error.cause).toBe(failure);
});

test('reports a write error of the socket as a lost connection', async () => {
  const client = fakeClient();
  client.send.mockRejectedValue(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  const session = await connectOver(client);

  const error = await failureOf(session.send('Page.captureScreenshot'));

  expect(error.code).toBe('CDP_UNREACHABLE');
  expect(error.message).toContain('was not completed');
  expect(error.details).toEqual({ targetId: 'TARGET', method: 'Page.captureScreenshot' });
});

test('reports a send on a closing socket as a lost connection before the library says it is gone', async () => {
  const client = fakeClient();
  client.send.mockRejectedValue(new Error('WebSocket is not open: readyState 2 (CLOSING)'));
  const session = await connectOver(client);

  const error = await failureOf(session.send('Page.captureScreenshot'));

  expect(error.code).toBe('CDP_UNREACHABLE');
  // The disconnect event has not arrived yet, and the adapter does not invent it.
  expect(session.isClosed).toBe(false);
});

test('does not take an ordinary error for a lost connection', async () => {
  const client = fakeClient();
  const bug = new Error('something else went wrong');
  client.send.mockRejectedValue(bug);
  const session = await connectOver(client);

  await expect(session.send('Page.captureScreenshot')).rejects.toBe(bug);
});

test('resolves close() when the library fails to close', async () => {
  const client = fakeClient();
  client.close.mockRejectedValue(new Error('close failed'));
  const session = await connectOver(client);

  await expect(session.close()).resolves.toBeUndefined();
  await expect(session.close()).resolves.toBeUndefined();

  expect(session.isClosed).toBe(true);
  expect(client.close).toHaveBeenCalledOnce();
});

test('does not run the listeners again for a disconnect that follows close()', async () => {
  const client = fakeClient();
  const session = await connectOver(client);
  const listener = vi.fn();
  session.onClose(listener);

  await session.close();
  client.disconnect();

  expect(listener).toHaveBeenCalledOnce();
});
