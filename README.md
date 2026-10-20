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
> (results, trades, equity) and `batch_run`, which runs several tools in one call. It also offers
> resources (the chart state and bars, the Pine source and the last compile result, the strategy
> report) and four prompts for common jobs. Drawings, alerts, replay and a web dashboard are
> planned. It has been tried on macOS; Windows and Linux are best effort.

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
tool calls the assistant makes and the full results. The excerpts are lines of those results. The
values are synthetic: they come from a fake TradingView app with a made-up NASDAQ:AAPL chart, so the
shape of every result is the real one, but nothing is market data and nothing comes from an account.

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
"message": "Undeclared identifier \"study\"",
"applied": ["Replace study( with indicator(", "Replace rsi( with ta.rsi("]
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

The server also offers four prompts of its own, which a client that supports MCP prompts lists for
you to pick: `analyze_current_chart`, `multi_timeframe_review`, `write_and_backtest_strategy` and
`debug_pine_script`. Each one tells the assistant which tools to call, in which order, and what to
report back.

### Safety

The tools that change your chart or your scripts are careful with what is already yours. Replacing
unsaved text in the Pine Editor, saving a new version of a script you saved earlier, and removing an
indicator that was already on your chart all need `confirm: true`, which the assistant should pass
only after you agree. A plan limit, such as the number of indicators on a chart or of saved scripts,
is checked before anything is added and reported as a `PLAN_LIMIT` error with the limit; the server
does not work around it and does not let TradingView open its upgrade dialog. It deletes and renames
no script.

### Tool profiles

By default the server offers all its tools (`--profile full`). Some clients accept only a limited
number of tools. For them, `--profile core` offers a reduced set of the essential tools, and
`--tools` takes name patterns such as `chart_*,data_*` to pick others. Some descriptions and hints
name tools that `core` leaves out, such as `pine_open` and `pine_save`, which the assistant cannot
call under `core`. `--profile readonly` offers only the tools that read.

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
