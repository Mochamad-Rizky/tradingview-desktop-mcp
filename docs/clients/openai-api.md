# Set up the OpenAI API

The Responses API can call an MCP server for you through its `mcp` tool. OpenAI's servers make the call, so the server must be at a public HTTPS address: you run it over HTTP on your computer and put a tunnel in front of it.

> **Read this first.** A remote assistant reaches the server through a public HTTPS address, which means a tunnel to your computer. Whoever holds the token can control your logged-in TradingView session through that endpoint. Start the server with `--profile readonly`, which offers only the tools that read, and keep the token secret. Read-only is not private: it still lets the token holder take screenshots of your charts and read your alert messages, watchlists, layout names, Pine script source and strategy results. [SECURITY.md](../../SECURITY.md#tunnels-and-remote-clients) has the details.

## What you need

- TradingView Desktop, installed and logged in, started with its debug port. Run `npx -y tradingview-desktop-mcp launch` to start it that way. If TradingView is already open without the port, the command stops and says so; run `npx -y tradingview-desktop-mcp launch --restart` to have it quit and open again with the port. It asks TradingView to quit politely, so TradingView may ask you to save changes first.
- Node.js 20.19 or newer, which provides `npx`.
- An OpenAI API key and an application that sends Responses API requests. Read the key from the environment rather than writing it into your code.
- A tunnel that gives your computer a public HTTPS address, from a provider you trust with your traffic. The examples use the host `abc.ngrok.app`; use the host your provider gives you.

## Start the server and the tunnel

**1. Make a token.** The server refuses to start over HTTP without one. Any random secret works. This prints one on every system that has Node.js:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

On macOS and Linux, `openssl rand -hex 32` does the same. Keep the token out of chats, screenshots and files you commit.

**2. Start the server** in a terminal, with the token and the public host of your tunnel. `TV_MCP_ALLOWED_HOSTS` tells the server that requests addressed to that host are its own. Without it the server answers 403 to everything that comes through the tunnel.

macOS and Linux:

```sh
export TV_MCP_AUTH_TOKEN="<the token>"
export TV_MCP_ALLOWED_HOSTS=abc.ngrok.app
npx -y tradingview-desktop-mcp --transport http --no-dashboard --profile readonly
```

Windows, in Command Prompt (cmd):

```bat
set "TV_MCP_AUTH_TOKEN=<the token>"
set "TV_MCP_ALLOWED_HOSTS=abc.ngrok.app"
npx -y tradingview-desktop-mcp --transport http --no-dashboard --profile readonly
```

Windows, in PowerShell:

```powershell
$env:TV_MCP_AUTH_TOKEN = "<the token>"
$env:TV_MCP_ALLOWED_HOSTS = "abc.ngrok.app"
npx -y tradingview-desktop-mcp --transport http --no-dashboard --profile readonly
```

The server listens on `127.0.0.1:8787`, on this computer only. It prints its addresses on stderr and never prints the token. The HTTP transport also serves the [dashboard](../../README.md#dashboard) at the same address. The start command above leaves it off with `--no-dashboard`, so that its files are not reachable through the tunnel, as [SECURITY.md](../../SECURITY.md#tunnels-and-remote-clients) advises.

**3. Start the tunnel** and point it at `http://127.0.0.1:8787`, as your provider describes. The public host it gives you is the one in `TV_MCP_ALLOWED_HOSTS`. Several hosts are comma-separated.

## The tool and where it goes

<!-- config:openai-api -->

```json
{
  "type": "mcp",
  "server_label": "tradingview",
  "server_url": "https://YOUR-TUNNEL-HOST/mcp",
  "headers": {
    "Authorization": "Bearer <TV_MCP_AUTH_TOKEN>"
  },
  "require_approval": "always"
}
```

- Add this object to the tools of a Responses API request, with your token in place of `<TV_MCP_AUTH_TOKEN>`. Read the token from the environment rather than writing it into your code.
- Start the server with TV_MCP_AUTH_TOKEN set to a random secret, such as the output of "openssl rand -hex 32", and TV_MCP_ALLOWED_HOSTS=YOUR-TUNNEL-HOST: npx -y tradingview-desktop-mcp --transport http --no-dashboard --profile readonly
- Then point an HTTPS tunnel whose public host is YOUR-TUNNEL-HOST at the server, http://127.0.0.1:8787 unless you set --host or --port.

<!-- /config -->

`npx -y tradingview-desktop-mcp config openai-api --url abc.ngrok.app` prints the object with your own tunnel host in place of `YOUR-TUNNEL-HOST`, and `config openai-api` alone prints the placeholder. The result is the same on every system.

Add the object to the `tools` of a Responses API request, with your token in place of `<TV_MCP_AUTH_TOKEN>`. Read the token from the environment in your code, so that it is not in a file you commit. This is the form that OpenAI documents as of October 2026, at <https://developers.openai.com/api/reference/resources/responses/methods/create>: the token goes in `headers`, which sends it as `Authorization: Bearer <token>` and keeps it out of URLs. The server also accepts the token in the path, `/mcp/<token>`, for clients that cannot send headers, but a URL is logged by tunnels; prefer the header.

Running from a checkout instead of the published package? Build it as the [README](../../README.md) describes and start it with `node packages/server/dist/cli.js` in place of `npx -y tradingview-desktop-mcp`.

## Approve each call

The snippet sets `require_approval` to `always`. As OpenAI's guide at <https://developers.openai.com/api/docs/guides/tools-connectors-mcp> describes it, the response then holds an `mcp_approval_request` item with the tool name and its arguments, and your application answers with an `mcp_approval_response` item that approves it. Each approval covers one call. Keep this setting for a server that controls your TradingView.

## Restart and check

Send a request with the tool and ask: "Check that TradingView is connected." The model calls `app_health`. If the request fails, run `npx -y tradingview-desktop-mcp doctor` on your computer to check TradingView without the API or the tunnel. The chart check fails while a chart tab is in the background; bring the chart to the front.

## Your first prompt

Start with a prompt that only reads:

> What am I looking at on my chart? Tell me the symbol, the timeframe and which indicators are on it.

It reads the chart with `chart_get_state`. Then try "Show me the last 3 daily candles."

## When you are done

Stop the tunnel, and stop the server with Ctrl+C. Remove the tunnel host from `TV_MCP_ALLOWED_HOSTS` (close the terminal or clear the variable), and do not reuse the token: make a new one next time. A tunnel that stays up keeps your session reachable by anyone who has the token.

## More

- [Troubleshooting](../troubleshooting.md): what each error means, and what to do when the tunnel answers 403 or the client shows no tools.
- `--profile readonly` offers the tools that read. See [Tool profiles](../../README.md#tool-profiles) for the others, and do not use them through a tunnel unless you accept that the endpoint can change your charts, alerts and layouts.
- [The tool reference](../tools.md) lists every tool.
