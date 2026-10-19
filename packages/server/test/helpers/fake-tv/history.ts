import type { TvStateFixture } from './fixture.js';
import { syntheticBars, type SyntheticBar } from './synthetic-bars.js';

// The history of the main series, as the app loads it on demand. The series starts with the bars of
// the fixture. requestMoreData(count) asks for `count` older bars: the call returns at once, the
// series reports loading and refuses another request, and after `loadMs` the bars are put in front
// of the loaded ones, at most `batchBars` of them. Once no older bar is left the series reports the
// end of its data, with the endOfDataType of the fixture ("end" when the first bar of the symbol
// was reached). A request that brings no bar leaves requestMoreDataAvailable false for good, as on
// the app. The end is reported after a request has found it, never at the start: the app reports
// endOfData false until then.
//
// The older bars are a synthetic series of their own, ending one step before the first bar of the
// fixture, so the bars of the fixture keep their values whatever history is loaded.

export interface FakeHistory {
  // The bars loaded so far, oldest first.
  bars(): readonly SyntheticBar[];
  requestMoreData(count?: number): void;
  requestMoreDataAvailable(): boolean;
  endOfData(): boolean;
  endOfDataType(): string | null;
  isLoading(): boolean;
  // The series Status enum: 2 (Loading) while a request runs, else 3 (Ready).
  status(): number;
}

export interface FakeHistoryOptions {
  // How long a request takes to bring its bars.
  loadMs: number;
  // The most bars one request brings, as a data server that answers in batches.
  batchBars: number;
  // A request that brings no bar sets no end flag: the series then takes no more requests and
  // reports no end, which the app may do at the history limit of the plan (not observed).
  endUnflagged: boolean;
  // Whether a request can be sent now; false makes requestMoreData a silent no-op, as on the app
  // while the series has no bars or the chart has not laid them out.
  canRequest: () => boolean;
  record: (name: string, args: readonly unknown[]) => void;
}

export function createFakeHistory(
  fixture: TvStateFixture,
  options: FakeHistoryOptions,
): FakeHistory {
  const { count, startTime, stepSeconds, seed } = fixture.bars;
  const olderCount = Math.max(0, fixture.history.totalBars - count);
  const older = syntheticBars({
    count: olderCount,
    startTime: startTime - olderCount * stepSeconds,
    stepSeconds,
    seed: seed + 1,
  });
  const initial = syntheticBars(fixture.bars);
  let loadedOlder = 0;
  let loaded: readonly SyntheticBar[] = initial;
  let loading = false;
  let available = true;
  let ended = false;

  return {
    bars: () => loaded,
    requestMoreData(requested) {
      options.record('series.requestMoreData', requested === undefined ? [] : [requested]);
      if (
        loading ||
        !available ||
        typeof requested !== 'number' ||
        !(requested > 0) ||
        !options.canRequest()
      ) {
        return;
      }
      loading = true;
      available = false;
      // Not ref'd, so a load a test never waits for does not hold the test process.
      setTimeout(() => {
        const added = Math.min(Math.ceil(requested), options.batchBars, olderCount - loadedOlder);
        loadedOlder += added;
        loaded = [...older.slice(olderCount - loadedOlder), ...initial];
        loading = false;
        available = added > 0;
        ended = loadedOlder === olderCount && !(added === 0 && options.endUnflagged);
      }, options.loadMs).unref();
    },
    requestMoreDataAvailable: () => available,
    endOfData: () => ended,
    endOfDataType: () => (ended ? fixture.history.endOfDataType : null),
    isLoading: () => loading,
    status: () => (loading ? 2 : 3),
  };
}
