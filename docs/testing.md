# Testing

The server is tested at three levels: unit, integration, and end-to-end against the real TradingView
Desktop. A smoke test of the built CLI on the oldest supported Node.js runs next to them in CI.
Fixtures for the fake app are recorded from the real one by a script that scrubs them first. The
dashboard tests (component tests and Playwright) arrive with the dashboard.

| Level       | Command                                       | Runs against                                        | In CI      |
| ----------- | --------------------------------------------- | --------------------------------------------------- | ---------- |
| Unit        | `pnpm test:unit`                              | Fakes: no network, no app                           | yes        |
| Integration | `pnpm build && pnpm test:integration`         | A fake CDP server with a fake TradingView window    | yes        |
| End-to-end  | `TV_E2E=1 pnpm test:e2e`                      | The TradingView Desktop running on this machine     | local only |
| Coverage    | `pnpm test:coverage`                          | Unit and integration together, ≥80% on every metric | yes        |
| Smoke       | `pnpm build && node scripts/smoke-node20.mjs` | The built CLI over stdio, with no app               | yes        |

Before a commit, run the whole local gate:

```sh
pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm test:coverage
```

## Unit tests

`packages/server/test/unit/` covers pure logic, schemas, mappers, the launcher with injected OS
dependencies, the fixture scrubber, and the page functions. Each page function runs twice in its
test: directly, and as source text through the real page bridge into a `vm` context, so that a
function that leans on anything outside itself fails there. Unit tests open no socket, apart from
the tests of the fake CDP server itself, which start it on the loopback address.

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

## Smoke test

`scripts/smoke-node20.mjs` starts the built CLI (`packages/server/dist/cli.js --transport stdio`) the
way a client does and talks to it over stdio. The debug port points at port 9, where nothing
listens, so no app is needed. The script checks that the handshake works, that `app_health` and
`batch_run` are listed, that every line on stdout is a JSON-RPC 2.0 message, and that the server
exits with code 0 once its input closes. It prints `smoke ok`, or the reason it failed and the start
of the server's stderr, and it gives up after 20 s.

CI runs it in the `runtime-node20` job on Node.js 20.19, the oldest runtime the package declares,
after installing only the production dependencies of the package. The test suites cannot show that
the bundle runs there, because Vitest needs Node.js 22 or newer.

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
- **What they check first:** before its first change, the chart suite checks by reading only that
  the chart API has every member the chart tools use (`symbol`, `resolution`, `chartType`,
  `getVisibleRange` and the three setters of the active chart, `zoomToBarsRange` of the time scale,
  and the bar container), and that the chart can be put back as it is: the symbol and the timeframe
  pass the input checks of `chart_set_symbol` and `chart_set_timeframe`, the chart type has a name
  `chart_set_type` takes (id 11 and ids the tools do not know have none), and the visible range is
  two times `chart_set_visible_range` takes, the earlier first. If either check fails, every test is
  skipped with the reason and nothing is changed.
- **How they restore it:** a suite takes a snapshot of those four (through `chart_get_state`) and of
  the view of the time scale (the bars it spans from edge to edge) before its first test. It puts
  the symbol back by the listing the series has resolved (`pro_name`), because the chart can show a
  symbol through the exchange of its data feed (`BATS:AAPL` for `NASDAQ:AAPL`), and setting that
  name would switch to another listing. Every test that changes the chart restores it first thing
  after it ends, and asserts that the symbol, timeframe and chart type are back and that the visible
  range is within one bar of where it was; a restore that fails after a failed test is logged next
  to the test's own failure, which stays the one reported. After the last test the suite restores
  again through the tools, then puts the view back exactly: the same bars from edge to edge, with
  the bar spacing worked out for the width the pane has then, because TradingView can resize the
  price axis while a suite runs. Each of the two steps is tried whatever the other did. Restoring
  runs whether the tests passed or failed.
- **What they never touch:** drawings (no `drawing_clear_all`), indicators, alerts, layouts and
  layout switching, the Pine Editor, replay, watchlists, and anything that trades. They never click
  or press keys: the check above makes the chart tools take the chart API, so none of them falls
  back to the interface (whose strategies the integration tests cover). They never reload the tab,
  and never quit, launch or restart TradingView.
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

- The layout is renamed `Fixture Layout` with the id `FIXTURE1`.
- A drawing keeps its type only: its text, points and properties are dropped.
- A study keeps a built-in name; any other name (the title of a Pine script) becomes `Study N`.
- Every field outside the fixture format is dropped, which removes the user object, the login state
  and any account field.
- The symbol becomes `NASDAQ:AAPL`, with the symbol info of Apple; flags that say nothing about which
  symbol it is are kept, and unknown fields are dropped.
- The target list keeps only the id, the type and the parent id of each target. Each title is
  replaced by a fixed one for its kind (the chart tab's generic title, the window chrome's file and
  fixture data, `index.html` for a helper page, empty for the rest). Each address is rebuilt: the
  chart tab gets `https://www.tradingview.com/chart/FIXTURE1/`; the window chrome its file with the
  fixture data `{"remoteServiceInstanceId":"fixture-tvd:tabbed-window"}`; another file its path
  inside the app bundle, under the default install folder; a web address keeps its scheme and host,
  plus its path only for a frame of another site (ad and anti-abuse frames), so any other page, a
  TradingView profile among them, keeps `/`; an address of another scheme keeps only the scheme.
  Queries and fragments are always dropped, and so are the debugger addresses.

Before it writes, the recorder searches both files for the recorded layout name, layout ids and
symbol names, plainly, percent-decoded and with HTML entities undone, a text shorter than three
characters (a ticker such as `GE`) as a whole word, and refuses to write if any of them survived.
