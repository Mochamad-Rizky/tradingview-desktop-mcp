// TradingView's own fullscreen mode of the charts in a fake chart tab (notes of Plan 3, section
// 6.2): startFullscreen() of TradingViewApi turns it on and exitFullscreen() turns it off, and the
// collection of the charts reports it as a watched value, _chartWidgetCollection.fullscreen(). The
// mode lives inside the page, so the fullscreen element of the browser stays null and the window
// does not change. Both calls are recorded, as TradingViewApi.startFullscreen and
// TradingViewApi.exitFullscreen, and take effect at once.

export interface FakeFullscreenOptions {
  // Whether the mode is on when the page opens. Default false.
  on?: boolean;
  // Leaves fullscreen() out of the collection of the charts, as on a build where the mode cannot be
  // read.
  unreadable?: boolean;
  // Leaves startFullscreen and exitFullscreen out of TradingViewApi.
  withoutCalls?: boolean;
}

// Whether the mode is on. Tests may assign to it, as the user leaving the mode with Escape would.
export interface FakeFullscreenState {
  on: boolean;
}

export interface FakeFullscreen {
  readonly state: FakeFullscreenState;
  // The members of TradingViewApi, none without its calls.
  readonly api: { startFullscreen?(): void; exitFullscreen?(): void };
  // The member of the collection of the charts, none when the mode cannot be read.
  readonly collection: { fullscreen?(): { value(): boolean } };
}

export function createFakeFullscreen(
  options: FakeFullscreenOptions = {},
  record: (name: string, args: readonly unknown[]) => void,
): FakeFullscreen {
  const state: FakeFullscreenState = { on: options.on ?? false };
  return {
    state,
    api:
      options.withoutCalls === true
        ? {}
        : {
            startFullscreen() {
              record('TradingViewApi.startFullscreen', []);
              state.on = true;
            },
            exitFullscreen() {
              record('TradingViewApi.exitFullscreen', []);
              state.on = false;
            },
          },
    collection:
      options.unreadable === true ? {} : { fullscreen: () => ({ value: () => state.on }) },
  };
}
