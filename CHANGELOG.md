# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-10-25

### Added

- **Install by asking your AI app.** The README starts its install steps with a prompt to paste
  into an AI app that runs commands, such as Claude Code or Cursor. The app checks Node.js, adds
  the server to its configuration, starts TradingView with its debug port and runs `doctor`, so
  you do not have to type the commands yourself.

### Changed

- **The repository is now `Mochamad-Rizky/tradingview-desktop-mcp`**, named like the package. The
  package metadata, the README and the security policy link to the new address; GitHub forwards
  the old one.

## [0.1.0] - 2026-10-25

The first public release. The version is below 1.0, so tool names, inputs and options may still
change in a minor release.

### Added

- **An MCP server for TradingView Desktop.** It controls the app you are logged in to on your own
  machine over the Chrome DevTools Protocol, through the debug port on the loopback interface. It
  runs on Node.js 20.19 or newer and is started with `npx -y tradingview-desktop-mcp`.
- **83 tools in three profiles.** `--profile full` (the default) offers all 83, `--profile core` 40
  essential ones for clients that accept fewer tools, and `--profile readonly` the 37 that only
  read. `--tools` narrows a profile with name patterns such as `chart_*,data_*`.
- **The app and the chart:** launch TradingView with its debug port, check its health, discover the
  app and its pages, read the interface state and the plan limits, and reconnect; read the chart
  state and set the symbol, timeframe, chart type and visible range, or scroll to a date.
- **Market data:** bars, quotes, symbol information, symbol search and the top of the book.
- **Indicators:** list, search, add and remove them, change their inputs and visibility, and read
  their values.
- **Pine Script:** write a new script, open, read and change the one in the Pine Editor, list and
  save scripts, analyse a script offline, compile it and read its errors and console, compile it
  with rule-based fixes (`pine_smart_compile`), and read the lines, labels, boxes and tables that
  scripts draw.
- **Strategy Tester:** the results, the trades and the equity of the strategy on the chart.
- **Drawings, alerts and watchlists:** create, list and remove drawings; create, list and delete
  price alerts; read watchlists and add symbols, one or several at a time, each checked with the
  symbol search of TradingView first, or remove them.
- **Layouts, panes, tabs and bar replay:** list, create and switch layouts; set the multi-chart
  layout of a tab and focus a pane or set its symbol; list, open, switch and close tabs; start,
  step, autoplay, read and stop bar replay for practice. No tool places orders.
- **Screenshots and low-level tools:** screenshots of the chart or the app, handed to the client as
  images and never written to disk; clicks, hovers, typing, keys, scrolling, finding elements,
  panels and fullscreen; JavaScript in the chart page only with `--allow-eval`; and `batch_run`,
  which runs several tools in one call.
- **Care with what is yours:** replacing unsaved Pine Editor text, removing an indicator, drawing,
  alert, watchlist symbol or tab that the session did not add, and similar changes need
  `confirm: true`. Plan limits are checked before anything is added and reported as `PLAN_LIMIT`
  errors; the server never works around them.
- **Resources and prompts:** seven resources (the app health, the chart state and bars, the Pine
  source and the last compile result, the strategy report and the active watchlist), each offered
  with the tool that shares its data, and five prompts: `analyze_current_chart`,
  `multi_timeframe_review`, `write_and_backtest_strategy`, `debug_pine_script` and
  `replay_practice_session`.
- **An HTTP transport** (`--transport http`) next to the default stdio. It listens on
  `127.0.0.1:8787` and requires a token (`TV_MCP_AUTH_TOKEN`), sent as
  `Authorization: Bearer <token>` or in a `/mcp/<token>` URL. It checks the `Host` and `Origin`
  headers against DNS rebinding, and accepts the public host of a tunnel with
  `TV_MCP_ALLOWED_HOSTS` or `--allowed-hosts`, for remote clients such as ChatGPT.
- **A web dashboard** that shows the status of the app and the server, streams every tool call
  live and runs tools by hand. It is on by default with the HTTP transport, runs next to stdio with
  `--dashboard`, and asks for the token before it shows anything.
- **A command line:** `doctor` checks that TradingView can be reached and is ready, `launch` starts
  it with its debug port (`launch --restart` quits it first when it runs without one), and
  `config <client>` prints the setup snippet of Claude Desktop, Claude Code, Cursor, VS Code,
  Windsurf, Gemini CLI, Codex CLI, ChatGPT or the OpenAI API.
- **Documentation:** a tutorial for each of these clients, a troubleshooting guide, a tool reference
  and worked examples generated from the server itself, a security policy with advice on running
  the server safely, and a testing guide.

[0.1.1]: https://github.com/Mochamad-Rizky/tradingview-desktop-mcp/releases/tag/v0.1.1
[0.1.0]: https://github.com/Mochamad-Rizky/tradingview-desktop-mcp/releases/tag/v0.1.0
