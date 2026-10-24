# Set up Claude Desktop

Claude Desktop starts the server itself, as a program on your computer, and talks to it over standard input and output (stdio). The server controls the TradingView Desktop app that you are logged in to, on the same computer.

## What you need

- TradingView Desktop, installed and logged in, started with its debug port. Run `npx -y tradingview-desktop-mcp launch` to start it that way. If TradingView is already open without the port, the command stops and says so; run `npx -y tradingview-desktop-mcp launch --restart` to have it quit and open again with the port. It asks TradingView to quit politely, so TradingView may ask you to save changes first.
- Node.js 20.19 or newer, which provides `npx`.
- Claude Desktop, on macOS or Windows. Claude Desktop for Linux is a beta for Ubuntu and Debian.

## The snippet and where it goes

For macOS:

<!-- config:claude-desktop -->

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "npx",
      "args": ["-y", "tradingview-desktop-mcp"]
    }
  }
}
```

- Put this in ~/Library/Application Support/Claude/claude_desktop_config.json, keeping any other servers in mcpServers. In Claude Desktop, Settings > Developer > Edit Config opens the file.
- Then quit Claude Desktop completely and open it again.

<!-- /config -->

For Windows:

<!-- config:claude-desktop:win32 -->

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "npx",
      "args": ["-y", "tradingview-desktop-mcp"]
    }
  }
}
```

- Put this in %APPDATA%\Claude\claude_desktop_config.json, keeping any other servers in mcpServers. In Claude Desktop, Settings > Developer > Edit Config opens the file.
- Then quit Claude Desktop completely and open it again.
- If the client cannot start npx, use "command": "cmd", "args": ["/c", "npx", "-y", "tradingview-desktop-mcp"] instead.

<!-- /config -->

`npx -y tradingview-desktop-mcp config claude-desktop` prints the snippet and the file location for your own system, Linux included.

Running from a checkout of the repository instead of the published package? Build it as the [README](../../README.md) describes, then run `config claude-desktop --local` from your build to get a snippet that starts that copy.

## Restart and check

Quit Claude Desktop completely and open it again, so that it reads the file. Then open a new chat.

Ask the assistant: "Check that TradingView is connected." It calls the `app_health` tool and reports the debug port, the chart tab and the app.

You can also check from a terminal, without the client: `npx -y tradingview-desktop-mcp doctor` prints the same three checks. The chart check fails while a chart tab is in the background, for example behind TradingView's New tab page; bring the chart to the front and run it again.

## Your first prompt

Open a chart in TradingView, bring its tab to the front, and ask the assistant:

> What am I looking at on my chart? Tell me the symbol, the timeframe and which indicators are on it.

It reads the chart with `chart_get_state`. Then try "Show me the last 3 daily candles." [docs/examples.md](../examples.md) shows more prompts with the tool calls and results.

## More

- [Troubleshooting](../troubleshooting.md): what each error means, and what to do when Claude Desktop does not show the tools.
- By default the server offers every tool. To offer fewer, add `--profile core` or `--profile readonly` to the arguments after the package name. See [Tool profiles](../../README.md#tool-profiles).
- [The tool reference](../tools.md) lists every tool.
