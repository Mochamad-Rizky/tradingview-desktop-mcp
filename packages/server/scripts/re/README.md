# Reverse-engineering scripts

Scripts that look at a running TradingView Desktop through its debug port, so that the findings in
[docs/reverse-engineering.md](../../../../docs/reverse-engineering.md) can be checked again after
TradingView updates (section 14 of the notes). They use the server's own connection manager and page
bridge, so they pick the chart tab the way the server does.

Start TradingView with `--remote-debugging-port=9222` first: `pnpm build`, then
`node packages/server/dist/cli.js launch`, or the `app_launch` tool. Every script takes `--host` and
`--port` (or `TV_CDP_HOST` and `TV_CDP_PORT`); the host must be a loopback address.

| Script               | Run with         | What it does                                                    |
| -------------------- | ---------------- | --------------------------------------------------------------- |
| `probe.ts`           | `pnpm re:probe`  | Prints what the app offers, read-only                           |
| `record-fixtures.ts` | `pnpm re:record` | Writes scrubbed fixtures for the fake app, read-only in the app |
| `scrub.ts`           | (library)        | Makes a recording safe to commit                                |
| `session.ts`         | (library)        | Command line and connection shared by the scripts               |

## `pnpm re:probe`

Prints a summary of the chart tab: the globals of the notes (section 4.1), the capability flags,
whether every member the server's page functions rely on is still there, what the chart model
returns (`isSymbolInvalid`, `logicalRange`, `timePointToIndex`, the bars, the time base of the
visible range), the symbol info keys, the interval list, and what the DOM shows (zoom, focus,
selectors without a match, the interval toolbar, panels, dialogs, trading controls).

- `--json` prints everything as JSON.
- `--bodies` adds the first characters of the source of each member the server relies on.

It only reads: it calls getters whose bodies were checked to have no side effects, and never a
setter, a key or a click. It prints no personal data (not the symbol, the layout name or id,
drawing text, study names or anything of the user object).

## `pnpm re:record`

Records the chart state, the bars, the symbol info, the studies, the drawings (their types only)
and the target list, scrubs them, and writes:

- `<out>/tv/<name>.json`, a fixture for `createFakeTvWindow` (default name `chart-recorded`)
- `<out>/cdp/targets.<platform>-<version>.json`, a target list for the fake debug port

`<out>` defaults to `test/fixtures`. An existing file is never replaced without `--force`, so a
recording cannot overwrite a committed fixture by accident. To try the recorder without touching
the repository, pass `--out` with a directory elsewhere.

What the scrubber does (`scrub.ts`, tested in `test/unit/scripts/scrub.test.ts`):

- The layout becomes `Fixture Layout` with the id `FIXTURE1`.
- A drawing keeps its type only; its text, points and properties are dropped.
- Studies keep a built-in name; any other name (a Pine script's title) becomes `Study N`.
- Every field outside the fixture format is dropped, which removes the user object, the login state
  and any account field.
- The symbol becomes `NASDAQ:AAPL`, with the symbol info of Apple; flags that do not identify a
  symbol are kept, unknown fields are dropped.
- The bars become `syntheticBars` with the fixture seed (42), as many as were recorded, and the
  quote is made from them. Fixtures never hold recorded prices.
- The target list keeps only the id, the type and the parent id of each target. Each title is
  replaced by a fixed one for its kind (the chart tab's generic title, the window chrome's file and
  fixture data, `index.html` for a helper page, empty for the rest). Each address is rebuilt: the
  chart tab gets `https://www.tradingview.com/chart/FIXTURE1/`; the window chrome its file with the
  fixture data `{"remoteServiceInstanceId":"fixture-tvd:tabbed-window"}`; another file its path
  inside the app bundle, under the default install folder; a web address keeps only its scheme and
  host, with the path `/`, a frame of another site (ad and anti-abuse frames) and a TradingView
  profile among them; an address of another scheme keeps only the scheme. Paths, queries and
  fragments of web addresses are always dropped, and so are the debugger addresses.

Before writing, the recorder searches both files for the recorded layout name, layout ids and symbol
names, plainly, percent-decoded and with HTML entities undone, a text shorter than three characters
(a ticker such as `GE`) as a whole word, and refuses to write if any of them survived.

## Why the scripts wrap page functions

`tsx` compiles with esbuild's `keepNames`, which wraps the inner functions of a page function in a
call to a `__name` helper that exists only in the Node process. `session.ts` runs every expression
in a scope that defines that helper as a no-op; nothing is added to the page's globals. The built
server and the tests are compiled without `keepNames`.
