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
- The Pine Editor is the side panel, registered as `dialog`. Closing it unregisters it and keeps
  unsaved text with the flag of unsaved changes, which the next open shows again as the text of the
  script; without unsaved changes, an open after the first one shows a new script. The flag is
  written only when the side panel closes: starting, opening, saving or adding a script leaves it
  as it is.
- The compiler reports, in the order of the text and with the messages and codes of the real one,
  every undeclared name and, in a script of version 5 or later, a call of a Pine v4 name without
  its namespace, after which it stops.
- Options model the rest of the real behavior where a test needs it: `sessionOffsetSeconds` (the
  chart reports a daily bar as its day at 00:00 UTC while its row holds the session start),
  `futurePoints` (the time points the time scale keeps after the last bar), and `feeds` (the chart
  names a resolved symbol by its data feed, such as `BATS:AAPL` for `NASDAQ:AAPL`).

No unit or integration test can reach a real app: the test configuration points the debug port at
port 9, and the suites that could start a program mock `node:child_process`.

### Usage examples

[examples.md](examples.md) shows what an assistant does with the server: a prompt, the tool calls
and their results. It is generated, not written: `pnpm docs:examples` runs the scenarios of
`packages/server/scripts/docs/scenarios.ts` through the real server against the fake app with the
`chart-basic` fixture, so the results have the real shape and synthetic values. The page is the same
on every run, machine and time zone. The duration of a call is left out, and the one value that
comes from the clock, the time of a Pine compilation, is fixed.

The test "docs/examples.md is up to date" (`test/integration/docs-examples.test.ts`) runs the
scenarios again and fails, saying to run `pnpm docs:examples`, when the committed page differs. The
same file checks that the numbers in the summaries appear in the results above them, and that the
prompts, the excerpts and the links in the README come from the page. Prettier skips the page
(`.prettierignore`), so that formatting cannot make it differ from the generator output.

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
- `data.e2e.test.ts`: OHLCV of bars the chart has loaded, oldest first; the quote and the top of the
  book of the chart symbol; the symbol info of the chart symbol, and of `NASDAQ:AAPL` through the
  symbol search; the search for `AAPL`; and one test that asks `data_get_ohlcv` for a few dozen bars
  more than are loaded, which loads older history the way a scroll to the left does.
- `indicator.e2e.test.ts`: the chart's indicators, the last value of the first one, the search for
  RSI, `indicator_add` on a full chart, and, on a chart with a free slot, RSI added, its inputs and
  visibility changed and changed back, and removed.
- `pine.e2e.test.ts`: `pine_analyze` offline; compile-only of synthetic scripts (an error and its
  position, a valid script and `pine_get_errors`, positions after a tab, `é` and an emoji, a script
  without `//@version`); `pine_smart_compile` with the real compiler; the shape of
  `pine_list_scripts`; the editor: a new script whose text is set, read and compiled, and the editor
  closed without a change and opened again, its text compared; and, read only, the drawings of the
  Pine scripts on the chart and the strategy tools on a chart without a strategy. Three tests run
  only when allowed (below): the editor closed and opened again with unsaved text of the test's own,
  and, on a chart with a free slot, a script that draws and a strategy added and removed.

The assertions compare what is the user's (the symbol, prices, names, texts) without printing it.
What a suite sees of the app is printed as `observed <what>: <JSON>` lines of key names, types,
counts and booleans, to compare with [reverse-engineering.md](reverse-engineering.md) after a
TradingView update.

A Mac whose lid is closed sleeps, and the app's timers and connections with it: a run then times
out or fails at random. Keep the lid open and run the suites under `caffeinate -i`.

### Safety rules

The end-to-end suites work on the user's own, logged-in app, so they follow these rules:

- **What they may change:** the symbol, the timeframe, the chart type and the visible range of the
  active chart; the history loaded into the chart, which the data suite extends by a few dozen
  older bars (TradingView keeps them until the chart loads again); the Pine Editor, under the guard
  below; and studies a test added itself, within the plan limits, which the test removes again,
  together with any study a call left on the chart under the name the test added (below).
  Compiling a synthetic script without the editor changes nothing in the app. Nothing else, and
  nothing is left behind in the account, unless the person running the suites allows it (below).
- **What they check first:** before its first change, a suite that changes the chart checks by
  reading only that the chart API has every member the chart tools use (`symbol`, `resolution`,
  `chartType`, `getVisibleRange` and the three setters of the active chart, `zoomToBarsRange` of the
  time scale, and the bar container), and that the chart can be put back as it is: the symbol and
  the timeframe pass the input checks of `chart_set_symbol` and `chart_set_timeframe`, the chart
  type has a name `chart_set_type` takes (id 11 and ids the tools do not know have none), and the
  visible range is two times `chart_set_visible_range` takes, the earlier first. If either check
  fails, every test that changes the chart is skipped with the reason and nothing is changed. The
  editor and the plan limits are checked as described below.
- **How they restore it:** a suite takes a snapshot of those four (through `chart_get_state`) and of
  the view of the time scale (the bars it spans from edge to edge) before its first test. It puts
  the symbol back by the listing the series has resolved (`pro_name`), because the chart can show a
  symbol through the exchange of its data feed (`BATS:AAPL` for `NASDAQ:AAPL`), and setting that
  name would switch to another listing. A range can be set only on bars, so the restore waits for
  the chart's bars after a change of symbol, timeframe or chart type before it sets the range. Every
  test that changes the chart restores it first thing after it ends, and asserts that the symbol,
  timeframe and chart type are back and that the visible range is within one bar of where it was; a
  restore that fails after a failed test is logged next to the test's own failure, which stays the
  one reported. After the last test the suite restores again through the tools, then puts the view
  back exactly: the same bars from edge to edge, with the bar spacing worked out for the width the
  pane has then, because TradingView can resize the price axis while a suite runs. Each of the two
  steps is tried whatever the other did. Restoring runs whether the tests passed or failed.
- **What they never touch:** drawings (no `drawing_clear_all`); the user's indicators (no
  `indicator_remove`, `indicator_set_inputs` or `indicator_set_visibility` on a study a test did not
  add); saved scripts (no `pine_save`, no `pine_smart_compile` with `writeBack`, no `pine_open` but
  of the script the editor showed); alerts, layouts and layout switching, replay, watchlists, and
  anything that trades. They never click or press keys: the check above makes the chart tools take
  the chart API, so none of them falls back to the interface (whose strategies the integration tests
  cover). They never reload the tab, and never quit, launch or restart TradingView.
- **The layout autosave** of TradingView saves the changed chart while a suite runs; the restore
  saves it back as it was.
- **What they print:** a skip reason, a log line and an error of the harness name the part of the
  chart, the tool and the error code, never a value of the user: not the symbol, the timeframe, the
  chart type or the range of the chart that could not be put back, and not the text of a tool that
  failed, which can name the symbol the chart went back to or a saved script
  (`describeFailure`, `ToolCallError`).
- **An interrupted run** (Ctrl+C inside a test) can stop before the restore. Note the symbol,
  timeframe, chart type and range, and what the Pine Editor shows, before a run, and put them back
  by hand if a run is cut short.

### What a run may leave behind, when allowed

By default a run leaves nothing in the account: no study, no script, no draft. Two variables allow
the tests that would, each set to `1`:

- `TV_E2E_ALLOW_DRAFTS` runs `adds a script that draws, …` and `adds a strategy, …`, which add a
  script from the Pine Editor to the chart (`pine_compile` with `addToChart`). TradingView saves
  such a script as a server draft of the account (version 0.x), as its own Add to chart button does,
  and no tool of this server deletes a script: each run that gets to add them leaves two drafts,
  `tradingview-mcp E2E drawings` and `tradingview-mcp E2E strategy`, among the scripts of the account
  (`pine_list_scripts` lists them), to delete in TradingView if they are not wanted. They also need
  a free indicator slot. Without the variable they are skipped with that reason.
- `TV_E2E_ALLOW_EDITOR_TEXT` runs `a closed editor shows its unsaved text again when it is opened`,
  which closes the Pine Editor on unsaved text of the test's own. TradingView keeps that text for
  the next open; the test puts the script back and closes the editor again, but a run cut short in
  between leaves the editor reopening on the test text. Without the variable the suite instead
  closes an unmodified editor without typing, opens it again and compares its text.

### Plan-aware skips

A test that adds something a plan limit counts asks `planLimitSkipReason(client, feature, used,
needed)` (`test/e2e/setup.ts`) first. It reads the limit with `app_get_plan_limits`, and when `used`
plus `needed` would go over it, the test is skipped before anything is changed, with a reason that
names the feature and the limit, such as `The plan allows 2 of INDICATORS_ON_CHART (limit of 2), 2
in use and the test needs 1 more`. A limit the app does not report gives no skip reason: the tool
under test refuses on its own with `NOT_AVAILABLE` wherever nothing else tells it that there is room
(for indicators, the chart model's `canCreateStudy` can), so no dialog of the app opens either way. No
test makes room by touching what the user has.

On a chart without a free indicator slot (2 of 2 on a Basic plan):

- `adds and removes RSI` is skipped with that reason, and so are `adds a script that draws, …` and
  `adds a strategy, …` when `TV_E2E_ALLOW_DRAFTS=1` allows them; without it they are skipped first
  for the draft they would leave.
- `adding an indicator on a full chart returns PLAN_LIMIT and changes nothing` runs, and only there:
  the plan and the app's own check (`canCreateStudy`, reason `general`) must both call the chart
  full, so the call cannot add a study. It asserts the `PLAN_LIMIT` error with the feature and the
  limit, the same studies afterwards and no new dialog (`app_get_ui_state`). Should TradingView add
  the study all the same, the test removes it and fails.

With a free slot the adding tests run (the two that add a script from the editor only with
`TV_E2E_ALLOW_DRAFTS=1`, above), each on its own study only, and within the chart snapshot and the
exact restore of the chart suites. However a test ends, `addThenCleanUp` lists the studies and
removes, with `confirm: true`, every study that was not on the chart before and has the name the
test added (Relative Strength Index, or the title of the test script), because a call that failed
halfway may have added one without answering its id. A study that was on the chart before is never
touched, whatever its name.

### The Pine Editor guard

The text in the Pine Editor can be work the user has not saved, so the editor tests change it only
under these rules (`snapshotEditor`, `restoreEditor` and the steps around them in `setup.ts`):

- **Before the first test** the suite reads what the editor shows, changing nothing. When it is
  open: the script (id and version, or a new script), whether its text differs from the script's
  (`isModified()`), and the text itself, which stays in memory to compare and is never printed.
  When it is closed: the script the app keeps for its next open and whether unsaved changes are
  kept with it (`last_edited_script` and `has_unsaved_modifications` in local storage, ids and flags
  only). Every editor test is skipped, and nothing is changed, when the editor holds or keeps
  unsaved changes, when any of this cannot be read, or when the script could not be shown again
  (`pine_open` must find it at that version, and the plan must let TradingView open it).
- A closed editor is opened once, the way the Pine button opens it. TradingView shows the script it
  keeps only on the first open of a session; later opens show a new script, unless unsaved changes
  are kept. So the suite puts back the script the app kept, not what the editor showed once open.
- **After every test** that script is put back through the tools: `pine_open` by its id (`pine_new`
  of the same type for a new script), with `confirm: true` only while the editor holds text the test
  wrote itself. Unsaved text of anyone else is never discarded: the restore stops and says so. The
  suite then reads the editor until it shows the script without changes.
- **After the last test** a closed editor is closed again, and the suite checks that the app keeps
  the same script for it as before.

The flag of unsaved changes is written when the editor closes and stays as it is while the editor is
open, also after a call with `confirm: true` replaced the text, so the guard asks the editor itself
(`isModified()`). Opening and closing the editor rewrites what the app
keeps of it in local storage: `pine_new` clears the editor console (`console_messages_key`), which
the tests' compile messages then fill; the view state kept for the last script
(`last_edited_script_view_state`) changes; and the copy of that script (`last_edited_script`) is
written again when the editor closes, seen with other line breaks and the text otherwise the same.
None of it is a saved script, and nothing is saved.

### Before and after a run

Note before a run, by reading only, the studies on the chart, what the Pine Editor shows (open or
closed, and the script id and version), and the symbol, timeframe, chart type and visible range,
and compare them after it. They should be the same, apart from the history the data suite loaded
and the editor's local storage described above. A visible range whose left edge moved while its
right edge, the bar spacing and the right offset stayed was not changed by a suite: TradingView
keeps the bar spacing and the right offset, which is what a layout stores of the view, when its
window gets narrower or wider, such as when it moves to a display of another width.

## Reverse-engineering probes and fixtures

The scripts in `packages/server/scripts/re/` look at the running app through its debug port. Their
README describes them in detail.

- `pnpm re:probe` prints, read-only, what the app offers: the globals, the capability flags, whether
  every member the server relies on is still there, what the chart model answers, and what the DOM
  shows. Run it after a TradingView update and compare it with
  [reverse-engineering.md](reverse-engineering.md).
- `pnpm re:record` records the chart state, the bars, the symbol info, the studies, the drawings
  (types only) and the target list, scrubs them, and writes `test/fixtures/tv/chart-recorded.json`
  and `test/fixtures/cdp/targets.<platform>-<version>.json`. Next to the fixture it writes
  `chart-recorded.shapes.json`, the shapes of the studies on the chart: whether each is a Pine
  script and a strategy, and the key names and value types of its `metaInfo()` plots and styles, of
  `getInputsInfo()`, of the members of `getStudyById(id)` and, for a strategy, of `reportData()`,
  to check the fake app against after a TradingView update. It never replaces a file without
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
  inside the app bundle, under the default install folder; a web address keeps only its scheme and
  host, with the path `/`, a frame of another site (ad and anti-abuse frames) and a TradingView
  profile among them; an address of another scheme keeps only the scheme. Paths, queries and
  fragments of web addresses are always dropped, and so are the debugger addresses.
- The shapes keep type names only (`number`, `string`, `number|null`, ..., and `getter` for an
  accessor of the study API, which is never called): a value that got into a shape is replaced
  by the name of its type. Of the plots, styles, inputs and report only the member names the app
  writes there are kept (an allowlist in `scrub.ts`); any other key, such as an order name a
  strategy defines, becomes `<key N>`. The API members stay a flat map of member names. A map
  keyed by ids (the styles by plot id) is written with the one key `<id>`.

Before it writes, the recorder searches the three files for the recorded layout name, layout ids
and symbol names, and the shapes also for the names of the studies the scrubber replaced, plainly,
percent-decoded and with HTML entities undone, a text shorter than three characters (a ticker such
as `GE`) as a whole word, and refuses to write if any of them survived.
