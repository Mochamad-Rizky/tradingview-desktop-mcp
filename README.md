# tradingview-desktop-mcp

[![CI](https://github.com/Mochamad-Rizky/tradingview-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Mochamad-Rizky/tradingview-mcp/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/Mochamad-Rizky/tradingview-mcp/graph/badge.svg)](https://codecov.io/gh/Mochamad-Rizky/tradingview-mcp)

An [MCP](https://modelcontextprotocol.io) server that lets AI assistants read and control the
TradingView Desktop app on your own machine. It drives the app you are already logged in to over the
Chrome DevTools Protocol, through the debug port the app opens when it starts with
`--remote-debugging-port`. It only automates the local app: it does not log in for you, get around
plan limits, or call TradingView's servers.

> **Work in progress.** This is an early foundation, not a release. Nothing is published to npm yet,
> and tool names and options may still change. The server offers app tools (launch, health,
> discovery, interface state, plan limits, reconnect), chart tools (state, symbol, timeframe, chart
> type, visible range, scrolling), market data tools (bars, quotes, symbol info and search),
> indicator tools (list, search, add, remove, inputs, visibility, values), Pine Script tools (the
> editor and saved scripts, compile, smart compile with rule-based fixes, offline analysis, the
> console, and the lines, labels, boxes and tables that scripts draw), Strategy Tester tools
> (results, trades, equity), drawing, alert and watchlist tools, layout, multi-chart and tab tools,
> bar replay, screenshots, low-level interface tools (click, hover, type, keys, scroll, find,
> panels, fullscreen, and JavaScript in the chart page when you allow it) and `batch_run`, which
> runs several tools in one call. It also offers resources (the app health, the chart state and
> bars, the Pine source and the last compile result, the strategy report, the active watchlist),
> each along with the tool it shares its data with, and five prompts for common jobs. A web
> dashboard is planned. It has been tried on macOS; Windows and Linux are best effort.

## Quick start from source

You need:

- TradingView Desktop, installed and logged in.
- Node.js 24 to build the server (`nvm use` reads `.nvmrc`) and [pnpm](https://pnpm.io), whose
  version `package.json` pins.
- Node.js 20.19 or newer to run the built server, which Node.js 24 covers.

Build the server:

```sh
git clone https://github.com/Mochamad-Rizky/tradingview-mcp.git
cd tradingview-mcp
pnpm install && pnpm build
```

Start TradingView with its debug port. The `launch` command finds the app and starts it that way:

```sh
node packages/server/dist/cli.js launch
```

You can also start the app yourself with `--remote-debugging-port=9222`. TradingView allows only one
instance, so quit it first if it is already running without the port. Check that the server can
reach it:

```sh
node packages/server/dist/cli.js doctor
```

Point an MCP client at the server. The default transport is stdio, where stdout carries only MCP
messages and logs go to stderr. For a client with a JSON configuration:

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "node",
      "args": ["/absolute/path/to/tradingview-mcp/packages/server/dist/cli.js"]
    }
  }
}
```

`node packages/server/dist/cli.js --help` lists the options, and [.env.example](.env.example) the
environment variables. There is also an HTTP transport (`--transport http`); read
[SECURITY.md](SECURITY.md) before you use it.

## Use it

Build the server and start TradingView with its debug port as described above, then connect an MCP
client and ask for what you want in plain words. The assistant picks the tools and calls them, so
you do not need to know their names.

### Claude Desktop

Add the `tradingview` entry of the JSON configuration above to `mcpServers` in the configuration
file of Claude Desktop (Settings, Developer, Edit Config), with the absolute path of your checkout,
and restart the app.

### Claude Code

```sh
claude mcp add tradingview -- node /absolute/path/to/tradingview-mcp/packages/server/dist/cli.js
```

### Try these prompts

Each prompt below is one of the examples in [docs/examples.md](docs/examples.md), which shows the
tool calls the assistant makes and the results, with lists longer than three items cut, the
duration of each call (`durationMs`) left out and a screenshot named in a note instead of shown.
The excerpts are lines of those results, and `…` marks where lines of other parts of a result are
left out. The values are synthetic: they come from a fake TradingView app with a made-up
NASDAQ:AAPL chart, so nothing is market data and nothing comes from an account; the results have
the shape the server gives them, though the Strategy Tester report behind the backtest example has
not been read from the real app yet.

**"What am I looking at on my chart? Tell me the symbol, the timeframe and which indicators are on
it."** The assistant reads the chart with `chart_get_state`
([details](docs/examples.md#1-read-the-chart)):

```json
"symbol": "NASDAQ:AAPL",
"resolution": "1D",
"chartTypeName": "candles",
```

**"Show me the last 3 daily candles."** It reads the bars with `data_get_ohlcv`
([details](docs/examples.md#3-read-the-last-candles)):

```json
"timeIso": "2024-10-27T00:00:00Z",
"open": 103.58,
"close": 103.42,
```

**"Add the MACD to my chart."** On a chart that holds as many indicators as the plan allows,
`indicator_add` adds nothing and reports the limit, and removing one of your indicators to make room
needs your confirmation ([details](docs/examples.md#5-add-an-indicator-to-a-full-chart)):

```json
"code": "PLAN_LIMIT",
"message": "The chart holds as many indicators as the plan allows (2)",
```

**"Write a Pine Script indicator that plots a 9-bar and a 21-bar moving average of the close, and
check that it compiles."** It puts the script in the Pine Editor with `pine_new` and compiles it with
`pine_compile` ([details](docs/examples.md#6-write-and-compile-a-pine-script)):

```json
"success": true,
"errors": [],
"warnings": [],
```

**"The script in my Pine Editor will not compile. Can you fix it?"** `pine_smart_compile` compiles
the script, applies rule-based fixes for the errors it knows, such as Pine v4 names in a v6 script,
and compiles again, without changing the editor
([details](docs/examples.md#7-fix-a-pine-script-with-smart-compile)):

```json
"message": "Could not find function or function reference 'study'",
…
"applied": ["Replace study( with indicator(", "Replace rsi( with ta.rsi("]
…
"writtenBack": false
```

**"How did the strategy on my chart do in the backtest?"** It reads the Strategy Tester with
`strategy_get_results` and `strategy_get_trades`
([details](docs/examples.md#8-read-backtest-results)):

```json
"netProfit": 155,
"totalTrades": 3,
"percentProfitable": 66.67,
"profitFactor": 4.1,
```

**"Draw a support line at 102.80 on my chart."** It draws a horizontal line with `drawing_create`,
and `drawing_list` shows it next to your own drawings, marked as drawn by this session
([details](docs/examples.md#9-draw-a-support-line)):

```json
"id": "DRW001",
"shape": "horizontal_line",
"text": "Support",
"createdByServer": true
```

**"Alert me when Apple crosses 110."** `alert_create` sets a price alert in your TradingView account
([details](docs/examples.md#10-create-a-price-alert)). When the plan already holds as many alerts
as it allows, it creates nothing and reports the limit, and `alert_list` shows the alerts that fill
it ([details](docs/examples.md#11-create-an-alert-when-the-plan-is-full)):

```json
"symbol": "NASDAQ:AAPL",
"condition": "crossing",
"price": 110,
"expirationIso": "2024-11-26T00:00:00Z"
```

**"Add these symbols to my watchlist: NYSE:IBM, FX:EURUSD, NASDAQ:MSFT and NASDAQ:MSTF."**
`watchlist_add_bulk` checks each symbol with the symbol search of TradingView, adds the new ones and
says why it skipped the others ([details](docs/examples.md#12-add-symbols-to-a-watchlist)):

```json
"added": ["NYSE:IBM", "FX:EURUSD"],
…
{ "symbol": "NASDAQ:MSFT", "reason": "already_listed" },
{ "symbol": "NASDAQ:MSTF", "reason": "unknown" }
```

**"Let me practice on a bar replay of my chart from 2024-06-03: step five bars forward, tell me
where we are, then end the replay."** It starts bar replay with `replay_start`, steps with
`replay_step`, reads where replay is with `replay_status` and leaves it with `replay_stop`. Nothing
is traded: no tool places orders ([details](docs/examples.md#13-practice-with-bar-replay)):

```json
"dateIso": "2024-06-07T00:00:00Z",
"stepped": 5,
…
"position": null,
"realizedPL": null
```

**"Take a screenshot of my chart."** `screenshot_capture` hands the picture to the assistant as an
image, along with its size, and writes nothing to disk
([details](docs/examples.md#14-take-a-screenshot)):

```json
"data": { "target": "chart", "format": "png", "width": 1180, "height": 640, "bytes": 812 },
"meta": { "via": "cdp", "warnings": [] }
```

The server also offers five prompts of its own, which a client that supports MCP prompts lists for
you to pick: `analyze_current_chart`, `multi_timeframe_review`, `write_and_backtest_strategy`,
`debug_pine_script` and `replay_practice_session`. Each one tells the assistant which tools to
call, in which order, and what to report back. `replay_practice_session` runs a practice session on
bar replay: the assistant steps through the past bar by bar, asks you at each step whether you
would go long, go short or stay flat, keeps a journal of these hypothetical trades at prices it
reads from the chart, works out their profit or loss, and always stops replay at the end.

### Safety

The tools that change your chart, your scripts or your account are careful with what is already
yours. Replacing unsaved text in the Pine Editor (other than an unsaved edit this session of the
server made there itself), saving a new version of a script that this session did not create, and
removing an indicator that was already on your chart all need `confirm: true`, which the assistant
should pass only after you agree. So does removing a drawing, alert, watchlist symbol or tab that
this session did not create, add or open, removing every drawing of a chart, switching away from a
layout with unsaved changes, and changing to a multi-chart layout with fewer charts than the tab
shows, whose next save would drop the others. A plan limit, such as the number of indicators on a
chart, of saved scripts, of alerts or of the charts of a layout, is checked before anything is
added and reported as a `PLAN_LIMIT` error with the limit; when the limit cannot be read on your
TradingView build, the tool does nothing and says so. The server does not work around a limit and
does not let TradingView open its upgrade dialog or any other dialog. It deletes and renames no
script.

No tool places orders: bar replay is for practice, and the assistant keeps any practice trades in
the conversation. Screenshots go to the client as images, and the server writes none to disk.
`ui_evaluate`, which runs JavaScript in the chart page, is off unless you start the server with
`--allow-eval` (`TV_MCP_ALLOW_EVAL=true`).

### Tool profiles

By default the server offers all its 83 tools (`--profile full`). Some clients accept only a limited
number of tools (Cursor warns above 40). For them, `--profile core` offers a reduced set of 39
essential tools, and `--profile readonly` offers only the 38 tools that read. `--tools` takes name
patterns such as `chart_*,data_*` and narrows the profile further: a tool must be in the profile
and match a pattern, so `--profile core --tools 'pine_*'` still leaves out `pine_open` and
`pine_save`, which are not core tools; with the default profile, `--tools` alone picks the tools.
Some descriptions and hints name tools that `core` leaves out, such as `pine_open` and `pine_save`,
which the assistant cannot call under `core`. The resources follow the tools: each one is offered
only with the tool it shares its data with, such as `tradingview://pine/source` with
`pine_get_source`, so `--tools 'chart_*'` offers the chart state and nothing of the Pine Editor.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the local setup, the test levels and the commit
conventions, and [docs/testing.md](docs/testing.md) for the testing guide. To report a
vulnerability, follow [SECURITY.md](SECURITY.md).

## Disclaimer

This project is not affiliated with, endorsed by, or sponsored by TradingView, Inc. TradingView is a
trademark of its owner. Nothing here is financial advice. The tools change what the app shows and
may reach its controls, so you are responsible for what you automate and for following TradingView's
terms of use.

## License

Released under the [MIT license](LICENSE).
