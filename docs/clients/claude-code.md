# Set up Claude Code

Claude Code starts the server itself and talks to it over standard input and output (stdio). The server controls the TradingView Desktop app that you are logged in to, on the same computer.

## What you need

- TradingView Desktop, installed and logged in, started with its debug port. Run `npx -y tradingview-desktop-mcp launch` to start it that way. If TradingView is already open without the port, the command stops and says so; run `npx -y tradingview-desktop-mcp launch --restart` to have it quit and open again with the port. It asks TradingView to quit politely, so TradingView may ask you to save changes first.
- Node.js 20.19 or newer, which provides `npx`.
- Claude Code.

## The snippet and where it goes

For macOS:

<!-- config:claude-code -->

```sh
claude mcp add tradingview -- npx -y tradingview-desktop-mcp
```

- Run this in a terminal. It adds the server to the current project; put --scope user before tradingview to add it to every project.
- Then check that it connects with: claude mcp get tradingview

<!-- /config -->

For Windows:

<!-- config:claude-code:win32 -->

```sh
claude mcp add tradingview -- npx -y tradingview-desktop-mcp
```

- Run this in a terminal. It adds the server to the current project; put --scope user before tradingview to add it to every project.
- Then check that it connects with: claude mcp get tradingview
- If Claude Code cannot start npx, add it with: claude mcp add tradingview -- cmd /c npx -y tradingview-desktop-mcp

<!-- /config -->

`npx -y tradingview-desktop-mcp config claude-code` prints the snippet and the file location for your own system, Linux included.

Running from a checkout of the repository instead of the published package? Build it as the [README](../../README.md) describes, then run `config claude-code --local` from your build to get a snippet that starts that copy.

## Restart and check

Start a new Claude Code session in the project, or run `claude mcp get tradingview` in a terminal to see that the server connects.

Ask the assistant: "Check that TradingView is connected." It calls the `app_health` tool and reports the debug port, the chart tab and the app.

You can also check from a terminal, without the client: `npx -y tradingview-desktop-mcp doctor` prints the same three checks. The chart check fails while a chart tab is in the background, for example behind TradingView's New tab page; bring the chart to the front and run it again.

## Your first prompt

Open a chart in TradingView, bring its tab to the front, and ask the assistant:

> What am I looking at on my chart? Tell me the symbol, the timeframe and which indicators are on it.

It reads the chart with `chart_get_state`. Then try "Show me the last 3 daily candles." [docs/examples.md](../examples.md) shows more prompts with the tool calls and results.

## More

- [Troubleshooting](../troubleshooting.md): what each error means, and what to do when Claude Code does not show the tools.
- By default the server offers every tool. To offer fewer, add `--profile core` or `--profile readonly` to the arguments after the package name. See [Tool profiles](../../README.md#tool-profiles).
- [The tool reference](../tools.md) lists every tool.
