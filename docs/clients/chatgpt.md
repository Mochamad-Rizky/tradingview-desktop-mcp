# Set up ChatGPT

ChatGPT cannot start a program on your computer. It connects to an MCP server at a public HTTPS address, so you run the server over HTTP on your computer and put a tunnel in front of it.

> **Read this first.** A remote assistant reaches the server through a public HTTPS address, which means a tunnel to your computer. Whoever holds the token can control your logged-in TradingView session through that endpoint. Start the server with `--profile readonly`, which offers only the tools that read, and keep the token secret. Read-only is not private: it still lets the token holder take screenshots of your charts and read your alert messages, watchlists, layout names, Pine script source and strategy results. [SECURITY.md](../../SECURITY.md#tunnels-and-remote-clients) has the details.

## What you need

- TradingView Desktop, installed and logged in, started with its debug port. Run `npx -y tradingview-desktop-mcp launch` to start it that way. If TradingView is already open without the port, the command stops and says so; run `npx -y tradingview-desktop-mcp launch --restart` to have it quit and open again with the port. It asks TradingView to quit politely, so TradingView may ask you to save changes first.
- Node.js 20.19 or newer, which provides `npx`.
- A ChatGPT account whose plan and workspace policies allow custom MCP servers. OpenAI's page says that account and workspace policies apply to adding and using them.
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
npx -y tradingview-desktop-mcp --transport http --profile readonly
```

Windows, in Command Prompt (cmd):

```bat
set TV_MCP_AUTH_TOKEN=<the token>
set TV_MCP_ALLOWED_HOSTS=abc.ngrok.app
npx -y tradingview-desktop-mcp --transport http --profile readonly
```

Windows, in PowerShell:

```powershell
$env:TV_MCP_AUTH_TOKEN = "<the token>"
$env:TV_MCP_ALLOWED_HOSTS = "abc.ngrok.app"
npx -y tradingview-desktop-mcp --transport http --profile readonly
```

The server listens on `127.0.0.1:8787`, on this computer only. It prints its addresses on stderr and never prints the token. The HTTP transport also serves the [dashboard](../../README.md#dashboard) at the same address; add `--no-dashboard` if you do not want its files reachable through the tunnel. They hold no data, and the data still needs the token.

**3. Start the tunnel** and point it at `http://127.0.0.1:8787`, as your provider describes. The public host it gives you is the one in `TV_MCP_ALLOWED_HOSTS`. Several hosts are comma-separated.

## The connection and where it goes

<!-- config:chatgpt -->

```text
https://YOUR-TUNNEL-HOST/mcp/<TV_MCP_AUTH_TOKEN>
```

- Paste this URL, with your token in place of <TV_MCP_AUTH_TOKEN>, as the connection of a custom MCP server in ChatGPT (chatgpt.com/plugins, +, Add custom MCP server), with no authentication.
- The URL holds the token, so anyone who has it can use TradingView through the server: keep it private.
- Start the server with TV_MCP_AUTH_TOKEN set to a random secret, such as the output of "openssl rand -hex 32", and TV_MCP_ALLOWED_HOSTS=YOUR-TUNNEL-HOST: npx -y tradingview-desktop-mcp --transport http --profile readonly
- Then point an HTTPS tunnel whose public host is YOUR-TUNNEL-HOST at the server, http://127.0.0.1:8787 unless you set --host or --port.

<!-- /config -->

`npx -y tradingview-desktop-mcp config chatgpt --url abc.ngrok.app` prints the address with your own tunnel host in place of `YOUR-TUNNEL-HOST`, and `config chatgpt` alone prints the placeholder. The result is the same on every system. Put your token where `<TV_MCP_AUTH_TOKEN>` stands.

ChatGPT has no field for a secret header here, so the token travels in the path of the address (`/mcp/<token>`). A tunnel provider can log that address, and so can the tunnel agent on your computer. Treat those logs as holding the token, and make a new token if anyone else can read them. The clients that can send headers use `Authorization: Bearer <token>` instead, which keeps the token out of URLs. The [OpenAI API tutorial](openai-api.md) does.

Running from a checkout instead of the published package? Build it as the [README](../../README.md) describes and start it with `node packages/server/dist/cli.js` in place of `npx -y tradingview-desktop-mcp`.

## Add it in ChatGPT

These steps follow OpenAI's page on connecting an MCP server to ChatGPT, <https://developers.openai.com/plugins/deploy/connect-chatgpt>, as of October 2026. ChatGPT changes often, so if a name differs, follow that page.

1. Go to <https://chatgpt.com/plugins>, select the plus button, then Add custom MCP server.
2. Enter a name and a description.
3. Under Connection, choose the public endpoint and enter the address from the block above, with your token in it. The address already holds the `/mcp` path that the page asks for. (The page also describes a Secure MCP Tunnel from OpenAI. This tutorial does not cover it.)
4. Choose no authentication, since the token is in the address, read the risk warning, and continue.
5. Create it as a plugin, and review the tools that ChatGPT found. With `--profile readonly` you should see only reading tools.
6. Install the plugin, start a new conversation, type `@` and choose the plugin.

After you restart the server with other options, open the connection on the Plugins page and select Refresh, then start a new conversation.

## Restart and check

In a new conversation with the plugin selected, ask: "Check that TradingView is connected." It calls the `app_health` tool.

If it does not work, run `npx -y tradingview-desktop-mcp doctor` on your computer. It checks TradingView without ChatGPT or the tunnel. The chart check fails while a chart tab is in the background; bring the chart to the front.

## Your first prompt

Start with a prompt that only reads:

> What am I looking at on my chart? Tell me the symbol, the timeframe and which indicators are on it.

It reads the chart with `chart_get_state`. Then try "Show me the last 3 daily candles."

## When you are done

Stop the tunnel, and stop the server with Ctrl+C. Close the terminal or clear the variables, and do not reuse the token: make a new one next time. A tunnel that stays up keeps your session reachable by anyone who has the token.

## More

- [Troubleshooting](../troubleshooting.md): what each error means, and what to do when the tunnel answers 403 or the client shows no tools.
- `--profile readonly` offers the tools that read. See [Tool profiles](../../README.md#tool-profiles) for the others, and do not use them through a tunnel unless you accept that the endpoint can change your charts, alerts and layouts.
- [The tool reference](../tools.md) lists every tool.
