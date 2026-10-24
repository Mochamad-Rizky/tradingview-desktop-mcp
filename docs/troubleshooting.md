# Troubleshooting

Start with the check that needs no AI client:

```sh
npx -y tradingview-desktop-mcp doctor
```

It makes three checks and says what to do about each one that fails:

- **Debug port.** Whether TradingView answers on its debug port (9222 unless you changed it).
- **Chart tab.** Whether a chart is open and in front. The check fails while the chart tab is in the background, for example behind TradingView's New tab page or another tab without a chart. Bring the chart to the front and run `doctor` again.
- **App.** Whether TradingView reports that it is connected and ready.

Every error the server returns has a code, a message and usually a hint. The sections below explain each code, then the situations people meet most often.

## Error codes

### TV_NOT_INSTALLED

The server could not find TradingView Desktop, or the file you named in `TV_APP_PATH` does not exist. It looks in the usual places:

- macOS: `/Applications/TradingView.app` and `~/Applications/TradingView.app`.
- Windows: `%LOCALAPPDATA%\TradingView\TradingView.exe`, `%ProgramFiles%\TradingView\TradingView.exe`, and the Microsoft Store package `TradingView.Desktop`.
- Linux: `/opt/TradingView/tradingview`, `/usr/bin/tradingview` and `/snap/bin/tradingview`.

The macOS places are confirmed. The Windows and Linux places are the ones installers are expected to use, and may differ on your machine. If yours is elsewhere, see [Windows and Linux install paths](#windows-and-linux-install-paths).

### TV_NOT_RUNNING

TradingView Desktop is not running. Start it with the debug port: `npx -y tradingview-desktop-mcp launch`. The server does not return this code for a closed app today; you are more likely to see `CDP_UNREACHABLE`, and the fix is the same.

### RESTART_REQUIRED

TradingView is running, but without the debug port, and it allows only one copy, so starting it again would not open the port. Quit TradingView yourself and run `npx -y tradingview-desktop-mcp launch`, or let the command do it:

```sh
npx -y tradingview-desktop-mcp launch --restart
```

`--restart` asks TradingView to quit, the way closing the app does, and then starts it again with the port. TradingView may ask you to save changes first, so save your work. The command never closes the app by force. If TradingView does not quit within 20 seconds because a dialog is waiting for an answer, answer it or close the app yourself, then run `launch` again. On macOS, see [macOS refuses to quit the app](#macos-refuses-to-quit-the-app).

An assistant can do the same with the `app_launch` tool, with `restart: true` and `confirm: true`. Without `confirm` it refuses, with `CONFIRMATION_REQUIRED`.

### LAUNCH_FAILED

The app could not be started, or did not become ready in time. The message says which:

- **Could not ask TradingView to quit.** Quit TradingView yourself, then run `launch` again. On macOS this is usually the Automation permission.
- **TradingView did not exit.** A dialog, such as a question about unsaved changes, is probably waiting. Close the app yourself, then run `launch` again.
- **Did not become ready within 60 s.** Start TradingView yourself with its debug port, then try again. If the app is only slow, raise `TV_LAUNCH_TIMEOUT_MS` (it has no flag, so set it in the environment of the process that runs `launch`).
- **Could not start the file.** Check that the file exists and that you may run it, or point `TV_APP_PATH` at another TradingView executable.

### CDP_UNREACHABLE

The server cannot talk to TradingView's debug port. Possible causes:

- TradingView is not running, or runs without the port. Run `npx -y tradingview-desktop-mcp launch` (add `--restart` if it asks for one).
- Another browser holds the port. See [The port is taken by another browser](#the-port-is-taken-by-another-browser).
- TradingView closed while the call was running. The hint says whether the call can simply be repeated; if the command may already have run, check the state before repeating a call that changes something.
- `TV_CDP_PORT` is not the port TradingView was started with.

### TARGET_NOT_FOUND

TradingView is up, but the server found no chart page to control. Typical reasons: the tab in front is TradingView's New tab page or another page without a chart, or the window is covered or minimized so that the tab in front cannot be told, or no window is open. Open a chart, bring its tab to the front, and run `doctor`. An assistant can switch tabs with `tab_switch`.

### TIMEOUT

TradingView did not answer in time, or a panel did not open or close. The limit for one call is `TV_CALL_TIMEOUT_MS`, 15 seconds unless you changed it. Look for a dialog in TradingView that waits for you, wait for the chart to finish loading, and try again. If the machine is slow, raise `TV_CALL_TIMEOUT_MS`. It has no flag, so it must be in the environment of the process that runs the server: for a server that a client starts, use the client's own way of giving a server environment variables, which your client's documentation describes.

### PAGE_EVALUATION_FAILED

TradingView's page refused or failed the action. The message repeats what TradingView said. Nothing changed unless the hint says TradingView may have acted anyway, in which case check the state first (for example `alert_list` after a failed alert). Try again, and if it keeps failing after an update of TradingView, report it with the tool name and the message.

### CAPABILITY_UNAVAILABLE

This build of TradingView does not offer what the tool needs, or it is laid out differently from what the server expects, for example a toolbar button that is missing. Do it in TradingView yourself, and update TradingView and this server.

### NOT_AVAILABLE

The thing exists in general but not now: a panel that is not shown, a tool for a feature your TradingView does not have, or several TradingView windows open when the tab and window tools need one. Read the hint. For the windows case, close the extra windows.

### PLAN_LIMIT

Your TradingView plan does not allow it, for example more indicators on a chart or more alerts than the plan holds. The message is what TradingView reported. Remove something first (`alert_delete`, or remove an indicator) or change plan in TradingView. The server does not work around plan limits.

### INVALID_INPUT

Something you passed is not valid: a flag, a value, a command, or a tool argument. This also covers a mistyped client name in `config` (the error lists the valid clients), a tunnel host written in a form that is not accepted, and an HTTP port that is already in use. The message names the setting and what it expected. Run `npx -y tradingview-desktop-mcp --help` for the options.

### CONFIRMATION_REQUIRED

The action can lose work or cannot be undone, so the tool wants `confirm: true`. This happens when an assistant asks to restart TradingView or reload the chart tab, and for some destructive drawing and pane actions. Read what the hint says will be lost, then tell the assistant to go ahead.

### UNSAFE_ACTION_BLOCKED

The server refused a click, typing or a key press because it would reach a trading control, such as a buy or sell button or the trade button, or the focused element is named like a trading action, or because `ui_evaluate` code names the account, credentials or trading. This protection is deliberate and has no switch. Do that action in TradingView yourself.

### AUTH_REQUIRED

TradingView needs you to be signed in for this action, for example for alerts or saved layouts. Sign in to TradingView and try again. This is about your TradingView account. It is not about the server's token: a wrong or missing token gives an HTTP 401 before any tool runs. See [The dashboard asks for a token](#the-dashboard-asks-for-a-token).

### INTERNAL

Something went wrong inside the server that it did not plan for. Run it again with `--log-level debug` (see [Logs](#logs)) to see what happened, and report the problem with the log lines around it, after removing anything private. Never post your token.

## Common situations

### The port is taken by another browser

If `doctor` says another browser answers on the debug port, a program such as Chrome or Edge holds port 9222, so TradingView could not open it. Quit that browser, or use another port for TradingView. To run `launch` and `doctor` on another port, set `TV_CDP_PORT` in your shell, as below. A server that your AI client starts does not read your shell's variables: add `"--cdp-port", "9223"` to the arguments the client passes, after the package name, then restart the client.

macOS and Linux:

```sh
export TV_CDP_PORT=9223
npx -y tradingview-desktop-mcp launch
```

Windows, in Command Prompt (cmd):

```bat
set "TV_CDP_PORT=9223"
npx -y tradingview-desktop-mcp launch
```

Windows, in PowerShell:

```powershell
$env:TV_CDP_PORT = "9223"
npx -y tradingview-desktop-mcp launch
```

`--cdp-port 9223` does the same for one command (`npx -y tradingview-desktop-mcp launch --cdp-port 9223`). The server only ever connects to the debug port on this machine.

### The client does not show the tools

1. Run `npx -y tradingview-desktop-mcp doctor`. If it fails, fix that first.
2. Check that the entry is in the file the tutorial names for your client, with valid JSON (or TOML for Codex CLI), and that you did not replace the other servers. `npx -y tradingview-desktop-mcp config <client>` prints the snippet and the location for your system.
3. Quit the client completely and open it again. Most clients read the file only when they start.
4. Look for an error in the client's own MCP log or status screen. If the client cannot start `npx`, which can happen on Windows, the snippet's notes for Windows give the `cmd /c` form to use instead.
5. Check that Node.js is 20.19 or newer: `node --version`.

### macOS refuses to quit the app

`launch --restart` asks TradingView to quit by sending it a message through `osascript`. The first time, macOS asks whether the app that runs the command (Terminal, or the app of your client) may control TradingView. If you refused, or the question never appeared, allow it under System Settings > Privacy & Security > Automation: find the app that runs the server and turn on TradingView under it. Then run `launch --restart` again. You can always quit TradingView yourself and run `launch`.

### Windows and Linux install paths

The server looks for TradingView in the places listed under [TV_NOT_INSTALLED](#tv_not_installed). If yours is in another place, or you want a particular copy, point `TV_APP_PATH` at the executable. On macOS it can name `TradingView.app`.

macOS and Linux:

```sh
export TV_APP_PATH="/path/to/tradingview"
npx -y tradingview-desktop-mcp launch
```

Windows, in Command Prompt (cmd):

```bat
set "TV_APP_PATH=C:\path\to\TradingView.exe"
npx -y tradingview-desktop-mcp launch
```

Windows, in PowerShell:

```powershell
$env:TV_APP_PATH = "C:\path\to\TradingView.exe"
npx -y tradingview-desktop-mcp launch
```

`--app-path` does the same for one command. A path you set is binding: if it does not exist, the server reports `TV_NOT_INSTALLED` rather than start another copy. When a client starts the server, add `"--app-path", "<path>"` to the arguments the client passes, because the client's environment is not your shell's.

### A tunnel answers 403

The server only accepts requests addressed to its own names, so a request that arrives with your tunnel's public host in the `Host` header is refused with 403 until you name that host. Set `TV_MCP_ALLOWED_HOSTS` (or `--allowed-hosts`) to the host, then start the server again. The host alone is enough: `abc.ngrok.app`. An `https://` URL is accepted and reduced to its host.

macOS and Linux:

```sh
export TV_MCP_ALLOWED_HOSTS=abc.ngrok.app
```

Windows, in Command Prompt (cmd):

```bat
set "TV_MCP_ALLOWED_HOSTS=abc.ngrok.app"
```

Windows, in PowerShell:

```powershell
$env:TV_MCP_ALLOWED_HOSTS = "abc.ngrok.app"
```

The check is exact, so list each host you use, separated by commas. A request from a web page of another site is refused with 403 as well. A 401 means the request reached the server but carried no valid token. Whenever you use a tunnel, read [Tunnels and remote clients](../SECURITY.md#tunnels-and-remote-clients), and stop the tunnel when you are done.

### The dashboard asks for a token

The dashboard needs the server's token, `TV_MCP_AUTH_TOKEN`. The server prints the address of the dashboard on stderr when it starts and never prints the token. Paste the token you started the server with, or open `http://127.0.0.1:8787/#token=<token>` once, as the [README](../README.md#dashboard) describes. If the page asks again after the server restarts, the token has changed. If the server runs with the HTTP transport and no token, it does not start: it needs `TV_MCP_AUTH_TOKEN`.

macOS and Linux:

```sh
export TV_MCP_AUTH_TOKEN="<the token>"
```

Windows, in Command Prompt (cmd):

```bat
set "TV_MCP_AUTH_TOKEN=<the token>"
```

Windows, in PowerShell:

```powershell
$env:TV_MCP_AUTH_TOKEN = "<the token>"
```

Any random secret works. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` prints one on every system, and `openssl rand -hex 32` on macOS and Linux.

### Logs

The server writes its log to stderr. With the stdio transport, stdout carries only MCP messages, so the client shows stderr in its own MCP log. To see more, add `--log-level debug` to the arguments the client passes, after the package name, or, in a terminal, set `TV_MCP_LOG_LEVEL=debug`. The levels run from `trace` to `fatal`, and `silent` turns the log off. In a terminal:

```sh
npx -y tradingview-desktop-mcp doctor --log-level debug
```

Logs carry codes and ids, and they redact the token. Look through a log before you share it anyway, since it can hold the names of your symbols or tabs.
