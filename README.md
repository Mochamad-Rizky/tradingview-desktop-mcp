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
> discovery, interface state, reconnect), chart tools (state, symbol, timeframe, chart type, visible
> range, scrolling) and `batch_run`, which runs several tools in one call. Market data, Pine Script,
> drawings, alerts, replay and a web dashboard are planned. It has been tried on macOS; Windows and
> Linux are best effort.

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
