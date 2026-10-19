# Security policy

## Supported versions

There is no release yet. Fixes go to the `main` branch.

## Reporting a vulnerability

Please report a vulnerability privately, and do not open a public issue or pull request for it.

Use GitHub's private vulnerability reporting: open the **Security** tab of the repository, choose
**Report a vulnerability**, and describe the problem. The form is at
<https://github.com/Mochamad-Rizky/tradingview-mcp/security/advisories/new>.

Say what you found, how to reproduce it, which commit or version you tested, and what an attacker
gains. Remove tokens and personal data from anything you attach. This project is maintained by one
person in their spare time, so replies are best effort. Please give me the chance to fix the problem
before you publish it.

Examples of what to report: a way around the loopback restriction on the debug port, a request that
passes the HTTP token, `Host` or `Origin` checks when it should not, a token or other secret that
reaches a log or an output, a tool that acts beyond what it documents, and personal data in a
committed fixture.

## Running the server safely

### The debug port

TradingView's remote debugging port gives whoever connects full control of the app and of the account
you are logged in to. It can read and change anything the app shows, run JavaScript inside it and,
when a broker is connected, reach its trading controls. Treat it like an administrator login without
a password.

- Keep the port on the loopback interface. Start TradingView with `--remote-debugging-port` only.
  Never add `--remote-debugging-address`, and never forward the port, publish it from a container,
  or put it behind a tunnel or a reverse proxy.
- The server refuses a debug-port host that is not loopback (`127.0.0.1`, `localhost` or `::1`),
  and it starts TradingView with the port flag only, never with `--remote-debugging-address` or
  `--options=clean`.
- Every program and every user on your machine can reach a loopback port, so run this on a machine
  you trust.

### The HTTP transport

The default transport is stdio, which opens nothing on the network. The HTTP transport
(`--transport http`) listens on `127.0.0.1:8787` by default and needs `TV_MCP_AUTH_TOKEN`.

- Use a strong random token, for example the output of `openssl rand -hex 32`. Whoever holds it can
  control your TradingView through the server, so it is as sensitive as the debug port.
- The token comes from the environment only. There is no flag for it, because command lines show in
  process lists.
- Send the token as `Authorization: Bearer <token>`. The `/mcp/<token>` form exists for connector
  interfaces that cannot set headers. A URL lands in browser history and in proxy and tunnel logs,
  so treat it as a secret and change the token if it leaks. The server redacts the token in its own
  logs.
- The server also checks the `Host` and `Origin` headers, so that a web page cannot reach it
  through your browser (DNS rebinding). Keep the listening address on loopback. On another address
  the token is the only thing between your network and your logged-in TradingView.

### Tunnels and remote clients

Some assistants only connect to a public HTTPS address, which means a tunnel to your machine. That
puts a server that can control your TradingView on the internet.

- Start the server with `--profile readonly`, which offers only the tools that declare themselves
  read-only, and with a strong token.
- The server rejects a request whose `Host` header is not its own address, so the tunnel has to
  rewrite the header to the local address.
- Stop the tunnel when you do not use it.

### JavaScript in the app

`--allow-eval` (`TV_MCP_ALLOW_EVAL`) is for `ui_evaluate`, a tool planned for a later release that
runs any JavaScript inside TradingView. It is off by default. Leave it off unless you need it, and
never turn it on for a remote or shared endpoint.

### Trading

Tools that click or type in the app could reach trading controls when a broker account is connected.
The server refuses known trading controls and checks what is under the pointer before it clicks, but
that is a safety net and not a guarantee. Use a paper-trading account while you experiment.
