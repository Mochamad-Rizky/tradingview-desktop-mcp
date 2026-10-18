import { readAppState, readVisibilityState } from '../../../../src/core/tv/probes.js';
import type { TvWindow } from '../../../../src/core/tv/tv-window.js';
import { loadTvFixture } from '../../../helpers/fake-tv/fixture.js';
import { createFakeTvWindow, inspectFakeWindow } from '../../../helpers/fake-tv/window.js';

// A page whose document reports `visibilityState`, whatever it is. Real browsers only report
// "visible" or "hidden", which is why the contract cannot express the other values.
function pageReporting(visibilityState: unknown): TvWindow {
  return {
    document: { visibilityState },
    location: { href: 'https://www.tradingview.com/chart/FIXTURE1/' },
  } as unknown as TvWindow;
}

describe('readVisibilityState', () => {
  const fixture = loadTvFixture();

  test('reports the visibility of the tab', () => {
    expect(readVisibilityState(createFakeTvWindow(fixture))).toBe('visible');
    expect(readVisibilityState(createFakeTvWindow(fixture, { visibilityState: 'hidden' }))).toBe(
      'hidden',
    );
  });

  test('reads the current state on every call', () => {
    const win = createFakeTvWindow(fixture);
    expect(readVisibilityState(win)).toBe('visible');

    inspectFakeWindow(win).state.visibilityState = 'hidden';

    expect(readVisibilityState(win)).toBe('hidden');
  });

  test('works on a page without TradingViewApi', () => {
    expect(readVisibilityState(createFakeTvWindow(fixture, { withoutApi: true }))).toBe('visible');
  });

  test.each([['prerender'], ['unloaded'], [''], ['VISIBLE'], [undefined], [null], [1]])(
    'reports unknown for the state %s',
    (state) => {
      expect(readVisibilityState(pageReporting(state))).toBe('unknown');
    },
  );
});

describe('readAppState', () => {
  const fixture = loadTvFixture();

  // A page whose TradingViewApi is whatever the test needs, to show how the probe copes with
  // builds that differ from the one that was observed.
  function pageWith(api: unknown, buildTime?: unknown): TvWindow {
    return { TradingViewApi: api, BUILD_TIME: buildTime } as unknown as TvWindow;
  }

  test('reports an app that is connected to the data servers', () => {
    expect(readAppState(createFakeTvWindow(fixture))).toEqual({
      apiPresent: true,
      connected: true,
      buildTime: fixture.buildTime,
    });
  });

  test('reports an app that lost its connection', () => {
    const win = createFakeTvWindow(fixture);
    inspectFakeWindow(win).state.connected = false;

    expect(readAppState(win)).toEqual({
      apiPresent: true,
      connected: false,
      buildTime: fixture.buildTime,
    });
  });

  test('reads the connection state on every call', () => {
    const win = createFakeTvWindow(fixture);
    expect(readAppState(win).connected).toBe(true);

    inspectFakeWindow(win).state.connected = false;

    expect(readAppState(win).connected).toBe(false);
  });

  test('reports a page whose app has not booted, with the build it already knows', () => {
    expect(readAppState(createFakeTvWindow(fixture, { withoutApi: true }))).toEqual({
      apiPresent: false,
      connected: null,
      buildTime: fixture.buildTime,
    });
  });

  test('does not look into the app of a page that has none', () => {
    expect(readAppState(pageWith(undefined, 'build'))).toEqual({
      apiPresent: false,
      connected: null,
      buildTime: 'build',
    });
  });

  test.each([
    [
      'throws',
      () => ({
        isConnected: () => {
          throw new Error('not ready');
        },
      }),
    ],
    ['is missing', () => ({})],
    ['answers undefined', () => ({ isConnected: () => undefined })],
    ['answers a string', () => ({ isConnected: () => 'true' })],
    ['answers a number', () => ({ isConnected: () => 1 })],
    ['answers null', () => ({ isConnected: () => null })],
  ])('cannot tell the connection when isConnected %s', (_case, makeApi) => {
    expect(readAppState(pageWith(makeApi(), 'build'))).toEqual({
      apiPresent: true,
      connected: null,
      buildTime: 'build',
    });
  });

  test.each([
    ['is missing', undefined],
    ['is null', null],
    ['is a number', 20261016],
    ['is an object', { at: '2026-10-16' }],
  ])('reports no build time when BUILD_TIME %s', (_case, buildTime) => {
    expect(readAppState(pageWith({ isConnected: () => true }, buildTime)).buildTime).toBeNull();
  });
});
