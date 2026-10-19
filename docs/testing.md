# Testing

The server is tested at three levels: unit, integration, and end-to-end against the real TradingView
Desktop. Fixtures for the fake app are recorded from the real one by a script that scrubs them first.
The dashboard tests (component tests and Playwright) arrive with the dashboard.

| Level       | Command                               | Runs against                                        | In CI      |
| ----------- | ------------------------------------- | --------------------------------------------------- | ---------- |
| Unit        | `pnpm test:unit`                      | Fakes: no network, no app                           | yes        |
| Integration | `pnpm build && pnpm test:integration` | A fake CDP server with a fake TradingView window    | yes        |
| End-to-end  | `TV_E2E=1 pnpm test:e2e`              | The TradingView Desktop running on this machine     | local only |
| Coverage    | `pnpm test:coverage`                  | Unit and integration together, ≥80% on every metric | yes        |

Before a commit, run the whole local gate:

```sh
pnpm lint && pnpm typecheck && pnpm build && pnpm test:unit && pnpm test:integration
```

## Unit tests

`packages/server/test/unit/` covers pure logic, schemas, mappers, the launcher with injected OS
dependencies, the fixture scrubber, and the page functions. Each page function runs twice in its
test: directly, and as source text through the real page bridge into a `vm` context, so that a
function that leans on anything outside itself fails there. A unit test never opens a socket.

## Integration tests

`packages/server/test/integration/` starts the real server and talks to it with SDK clients over the
in-memory, stdio and Streamable HTTP transports. Behind it runs a fake CDP server
(`test/helpers/fake-cdp/`) whose `Runtime.evaluate` executes the real serialized page functions
against a fake TradingView window (`test/helpers/fake-tv/window.ts`) built from a fixture
(`test/fixtures/tv/chart-basic.json`). The stdio tests spawn the built CLI, so build first; they
refuse to run against a bundle older than the sources.

The fake window models what the real app was seen to do, among others:

- An unknown symbol is accepted, flags the series as invalid and never reports its data as ready;
  while flagged, the series has no bars and no symbol info, and `getVisibleRange` answers zeros.
- `logicalRange()` answers an object with `left()` and `right()`, and `zoomToBarsRange` ignores a
  range whose ends are the wrong way round.
- Options model the rest of the real behavior where a test needs it: `sessionOffsetSeconds` (the
  chart reports a daily bar as its day at 00:00 UTC while its row holds the session start),
  `futurePoints` (the time points the time scale keeps after the last bar), and `feeds` (the chart
  names a resolved symbol by its data feed, such as `BATS:AAPL` for `NASDAQ:AAPL`).

No unit or integration test can reach a real app: the test configuration points the debug port at
port 9, and the suites that could start a program mock `node:child_process`.

## End-to-end tests

The suites in `packages/server/test/e2e/` drive the TradingView Desktop of the person who runs them.

1. Start TradingView with its debug port: `pnpm build`, then `node packages/server/dist/cli.js
launch`, or the `app_launch` tool.
2. Run `TV_E2E=1 pnpm test:e2e`. Without `TV_E2E=1` every suite is skipped.

Only `TV_CDP_HOST`, `TV_CDP_PORT` and `TV_CALL_TIMEOUT_MS` are read from the environment, so a
profile or a tool filter set for daily use cannot hide the tools under test. The files run one at a
time, because they share one window.

- `app.e2e.test.ts`: `app_health` reports a ready app with its capabilities, and `app_discover`
  finds the chart target.
- `chart.e2e.test.ts`: the symbol and the timeframe are switched and switched back; the chart type
  goes through candles, line and Heikin Ashi and back; the visible range is set and set back, the
  empty space after the last bar included; an unknown symbol is reported and the chart switched
  back.

### Safety rules

The end-to-end suites work on the user's own, logged-in app, so they follow these rules:

- **What they may change:** the symbol, the timeframe, the chart type and the visible range of the
  active chart. Nothing else.
- **How they restore it:** a suite takes a snapshot of those four (through `chart_get_state`) and of
  the zoom of the time scale before its first test. Every test that changes the chart restores it in
  a `finally` block, and asserts that the symbol, timeframe and chart type are back and that the
  visible range is within one bar of where it was. After the last test the suite restores again
  through the tools, then puts the zoom back exactly (bar spacing and right offset, which the tools
  can only set to the nearest bar). Restoring runs whether the tests passed or failed.
- **What they never touch:** drawings (no `drawing_clear_all`), indicators, alerts, layouts and
  layout switching, the Pine Editor, replay, watchlists, and anything that trades. They never click
  or press keys (the tools take the chart API, and the interface fallbacks are covered by the
  integration tests), never reload the tab, and never quit, launch or restart TradingView.
- **The layout autosave** of TradingView saves the changed chart while a suite runs; the restore
  saves it back as it was.
- **Plan limits:** a test that would exceed a limit of the user's plan is to be skipped with the
  name of the feature rather than free capacity by touching user data. That check arrives with the
  plan limits module; the current suites only use what every plan offers.
- **An interrupted run** (Ctrl+C inside a test) can stop before the restore. Note the symbol,
  timeframe, chart type and range before a run, and put them back by hand if a run is cut short.

## Reverse-engineering probes and fixtures

The scripts in `packages/server/scripts/re/` look at the running app through its debug port. Their
README describes them in detail.

- `pnpm re:probe` prints, read-only, what the app offers: the globals, the capability flags, whether
  every member the server relies on is still there, what the chart model answers, and what the DOM
  shows. Run it after a TradingView update and compare it with
  [reverse-engineering.md](reverse-engineering.md).
- `pnpm re:record` records the chart state, the bars, the symbol info, the studies, the drawings
  (types only) and the target list, scrubs them, and writes `test/fixtures/tv/chart-recorded.json`
  and `test/fixtures/cdp/targets.<platform>-<version>.json`. It never replaces a file without
  `--force`; `--out <dir>` writes elsewhere. Commit a recording only when it shows that the fake is
  wrong, and read the diff first.

### Synthetic prices

Committed fixtures never hold recorded prices, which are licensed market data. A fixture stores its
bars as a spec (`count`, `startTime`, `stepSeconds`, `seed`) that `syntheticBars` expands into a
deterministic random walk (seed 42 for the committed fixtures), and its quote is made from the last
two synthetic bars. The recorder replaces the recorded bars with synthetic ones of the same count
and start, and refuses bars that are not.

### Scrubbing

`scripts/re/scrub.ts` (tested in `test/unit/scripts/scrub.test.ts`) makes a recording safe to
commit:

- The layout is renamed `Fixture Layout` with the id `FIXTURE1`, in the fixture and in every target
  address and title; the title of a chart tab becomes the generic one the app shows.
- A drawing keeps its type only: its text, points and properties are dropped.
- A study keeps a built-in name; any other name (the title of a Pine script) becomes `Study N`.
- Every field outside the fixture format is dropped, which removes the user object, the login state
  and any account field.
- The symbol becomes `NASDAQ:AAPL`, with the symbol info of Apple; flags that say nothing about which
  symbol it is are kept, and unknown fields are dropped.
- The random instance id of the window chrome becomes `fixture`, and the debugger addresses are
  dropped.

Before it writes, the recorder searches both files for the recorded layout name, layout id and
symbol names, and refuses to write if any of them survived.
