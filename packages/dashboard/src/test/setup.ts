import '@testing-library/jest-dom/vitest';
import { clearToken } from '@/api/token';
import { createFakeApi } from './handlers';
import { server } from './server';

// jsdom implements no matchMedia. This one matches no query, as a light, wide screen would; a test
// that needs another answer spies on it.
Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  writable: true,
  value: (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

// jsdom has no pointer capture and does not scroll, both of which the select of Radix calls when it
// opens and moves through its options.
Object.assign(Element.prototype, {
  hasPointerCapture: () => false,
  releasePointerCapture: () => undefined,
  setPointerCapture: () => undefined,
  scrollIntoView: () => undefined,
});

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

// Each test gets a fake API of its own, so that no stream connection, recorded call or event seq of
// another test carries over. A test's server.resetHandlers() comes back to it.
beforeEach(() => {
  server.resetHandlers(...createFakeApi().handlers);
});

// Here rather than at the end of a test, so that a test that fails half way leaves nothing behind:
// the clock is real again, nothing listens to the requests of the next test, and no token is kept,
// not even the copy in memory of a browser that refused storage.
afterEach(() => {
  vi.useRealTimers();
  server.events.removeAllListeners();
  server.resetHandlers();
  clearToken();
  localStorage.clear();
  sessionStorage.clear();
});

afterAll(() => {
  server.close();
});
