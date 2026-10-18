import { readVisibilityState } from '../../../../src/core/tv/probes.js';
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
