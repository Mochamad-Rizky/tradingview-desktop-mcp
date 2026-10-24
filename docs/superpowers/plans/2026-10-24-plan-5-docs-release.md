# Plan 5: Docs and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** make `tradingview-desktop-mcp` ready for a first public release. That means:

- every supported AI client has a copy-paste setup, from a CLI command and a tutorial;
- remote clients work through a tunnel;
- the docs and tool reference are complete and generated where they can drift;
- the npm package is complete, and a tag-driven release workflow exists;
- the whole thing has been verified once more against the real TradingView.

**Architecture:**

- The CLI gains a working `config <client>` command whose snippets are the single source the tutorials embed. Tests keep the docs and the command identical.
- The HTTP transport accepts extra allowed hosts for tunnels.
- Generated docs (`docs/tools.md`) come from the tool catalogue, like `docs/examples.md`.
- CI packs the real tarball and smoke-tests it on Node 20.19.
- A release workflow publishes on a version tag. This plan never pushes a tag or publishes.

**Tech Stack:** TypeScript 6, `node:util.parseArgs`, zod 4 `toJSONSchema`, Vitest 5, GitHub Actions, npm.

**Spec:** `docs/superpowers/specs/2026-10-18-tradingview-mcp-design.md`:

- §2: the clients;
- §8: remote clients need a public HTTPS URL; the docs recommend `--profile readonly` and warn about control;
- §9: the subcommands `launch`, `doctor`, `config <client>`;
- §11: CI;
- §12: Plan 5 = README with tutorials for every client, generated tool reference, `docs/testing.md` final, troubleshooting, publish setup, final verification against real TradingView.

## Global Constraints

- TypeScript strict, no `any`, ESM. English only in code, docs, CLI output and commit messages.
- Commits: Conventional Commits, local git identity, **no AI attribution of any kind**. Code and comments never cite rulings or the SDD ledger.
- **No personal data in committed files:** no layout names or ids, usernames, the user's symbols, real prices or account fields.
- **Server runtime:** `engines.node >=20.19`, no new runtime dependency.
- **The token is never printed:**
  - `config` snippets use the placeholder `<TV_MCP_AUTH_TOKEN>`, never the real token;
  - logs, banners and errors keep redacting it.
- **This plan never publishes:**
  - no `npm publish`;
  - no git tag pushed;
  - no GitHub release created.

  The release workflow runs only when the user pushes a version tag.

- **Never launch, quit, restart or reload the user's TradingView in tests.** Launcher behaviour is tested with injected dependencies. Only Task 8 talks to the real app, under the E2E safety rules in `docs/testing.md`.
- **Coverage:** ≥80% lines, branches, functions and statements over `packages/server/src` and over `packages/dashboard/src`. Keep both near today's ~99.8%.
- **Gate:** `pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm test:coverage`.

## Review Focus

Each line names a likely failure mode and the behaviour a user would expect, with the task that owns its test.

1. **Windows users copying a stdio snippet.** Clients on Windows that cannot start `npx` directly get the `cmd /c npx` form. `--platform win32` prints it, and the default follows the running OS. [Task 2]
2. **A tunnel host written as a URL, with a port, or in another case** (`https://Abc.ngrok.app/`, `abc.ngrok.app:443`). It is normalised to a host and accepted, or refused with a message that shows the expected form. It is never silently ignored. [Task 1]
3. **A mistyped client name** (`config claude`, `config vs-code`). A clear error lists the valid clients and suggests the closest one. [Task 2]
4. **The published tarball works only inside the monorepo**, for example because the dashboard, the type definitions, the README or the LICENSE are missing, or because of a relative path. CI installs the packed tarball into an empty directory on Node 20.19 and runs the stdio and HTTP smoke against the installed bin. [Task 6]
5. **Docs drift:**
   - a tutorial's snippet differs from `config` output;
   - `docs/tools.md` goes stale after a tool change;
   - README counts go wrong.

   Freshness tests fail first. [Tasks 3, 5, 7]

---

### Task 1: Tunnels: extra allowed hosts

**Files:**

- Modify:
  - `packages/server/src/config/{schema,load}.ts`
  - `packages/server/src/transports/http-security.ts`
  - `packages/server/src/transports/http.ts`
  - `packages/server/src/cli/output.ts` (help)
  - `.env.example`
  - `SECURITY.md` ("Tunnels and remote clients")
- Test:
  - `packages/server/test/unit/config/load.test.ts`
  - `packages/server/test/unit/transports/http-security.test.ts`
  - `packages/server/test/integration/http.test.ts`

**Interfaces:**

- **Config:** `Config.allowedHosts: string[]`, default `[]`. It comes from `TV_MCP_ALLOWED_HOSTS` or `--allowed-hosts`: a comma list, each entry trimmed.
  - An entry may be a host (`abc.ngrok.app`), a `host:port`, or a URL (`https://abc.ngrok.app/`). It is normalised to a lowercase host, keeping an explicit port.
  - An entry with a path other than `/`, a query, credentials, or a wildcard is `INVALID_INPUT`, with the hint `TV_MCP_ALLOWED_HOSTS takes host names such as abc.ngrok.app, comma-separated`.
- **`allowedHostsFor(httpHost, port, extra: string[] = [])`:**
  - an extra host without a port matches a `Host` header with no port, or with `:443` or `:80`;
  - an extra `host:port` matches exactly.
- **`isAllowedOrigin`** accepts `https://<extra host>`, and `http://<extra host>` only for an extra host given with an explicit port.
- **Warning:** when `allowedHosts` is not empty and `profile` is not `readonly`, the server logs once at startup: `Extra allowed hosts are set and the profile is "<profile>": anyone who reaches them with the token can control TradingView. Prefer --profile readonly behind a tunnel.`

- [ ] **Step 1: Write the failing tests.**
  - `TV_MCP_ALLOWED_HOSTS accepts hosts, host:port and https URLs and normalises them`.
  - `TV_MCP_ALLOWED_HOSTS refuses a path, a wildcard and credentials with the expected form in the hint` (Review Focus 2).
  - `--allowed-hosts beats TV_MCP_ALLOWED_HOSTS`.
  - `a tunnel Host without a port is accepted on /mcp with the token, and still refused without it`.
  - `a tunnel Origin https://<host> is accepted and another origin is still refused`.
  - `extra hosts with a profile other than readonly log the tunnel warning once`.
  - `loopback hosts keep working with extra hosts set`.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.** Document the variable and the flag in the help text, `.env.example` and SECURITY.md:
  - replace "the tunnel has to rewrite the header" with the new setting;
  - keep the readonly advice, and list what the readonly profile still reveals: screenshots, alert messages, watchlists and layout names;
  - say that `/mcp/<token>` URLs land in tunnel logs.
- [ ] **Step 4: Run them to see them pass,** then run the gate.
- [ ] **Step 5: Commit:** `feat(http): accept extra allowed hosts for tunnels`.

---

### Task 2: `config <client>`

**Files:**

- Create: `packages/server/src/cli/clients.ts`
- Modify:
  - `packages/server/src/cli/run.ts`
  - `packages/server/src/config/load.ts` (options valid only with `config`)
  - `packages/server/src/cli/output.ts` (help)
- Test:
  - `packages/server/test/unit/cli/clients.test.ts`
  - `packages/server/test/unit/cli/run.test.ts`
  - `packages/server/test/integration/cli.test.ts`

**Interfaces:**

- **`CLIENT_IDS`** (exact, in this order): `claude-desktop`, `claude-code`, `cursor`, `vscode`, `windsurf`, `gemini-cli`, `codex-cli`, `chatgpt`, `openai-api`.
- **`renderClientConfig(client: ClientId, options: { platform: NodeJS.Platform; command: { kind: 'npx' } | { kind: 'local'; cliPath: string }; profile?: Profile; url?: string }): { snippet: string; notes: string[] }`**
  - It is pure. `snippet` is exactly what goes to stdout. `notes` go to stderr, one line each: where the snippet goes (the per-platform config path), then the next step.
- **Default formats.** Verify each one against the client's current official documentation and cite the URL in a comment beside its renderer. Where the official format differs from the list below, follow the docs and report the difference as a deviation.
  - **claude-desktop:** JSON `{ "mcpServers": { "tradingview": { "command": "npx", "args": ["-y", "tradingview-desktop-mcp"] } } }`.
    - The notes give `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows), then say to restart Claude Desktop.
  - **claude-code:** the shell line `claude mcp add tradingview -- npx -y tradingview-desktop-mcp`.
  - **cursor:** JSON `mcpServers` as for Claude Desktop. The notes give `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project).
  - **vscode:** JSON `{ "servers": { "tradingview": { "type": "stdio", "command": "npx", "args": [...] } } }`. The notes give `.vscode/mcp.json`.
  - **windsurf:** JSON `mcpServers`. The notes give `~/.codeium/windsurf/mcp_config.json`.
  - **gemini-cli:** JSON `mcpServers`. The notes give `~/.gemini/settings.json`.
  - **codex-cli:** TOML `[mcp_servers.tradingview]` with `command` and `args`. The notes give `~/.codex/config.toml`.
  - **chatgpt:** the connector URL `https://<host>/mcp/<TV_MCP_AUTH_TOKEN>` (path form, for connector UIs that cannot send headers).
    - The notes cover starting the server with `--transport http --profile readonly` and `TV_MCP_ALLOWED_HOSTS`, a tunnel, and the warning that the URL is the token.
  - **openai-api:** JSON `{ "type": "mcp", "server_label": "tradingview", "server_url": "https://<host>/mcp", "headers": { "Authorization": "Bearer <TV_MCP_AUTH_TOKEN>" }, "require_approval": "always" }`.
  - **Remote clients:** `<host>` is from `--url`, normalised like an allowed host. Without it, the placeholder is `YOUR-TUNNEL-HOST`.
- **Options**, accepted only with `config`; any other command gives `INVALID_INPUT`:
  - `--local`: the command becomes `node <absolute path of this cli.js>`;
  - `--url <host or https URL>`;
  - `--platform <darwin|win32|linux>`: default `process.platform`.
  - The global `--profile`, when given explicitly, adds `--profile <p>` to the args.
- **Windows:** for the clients whose docs require it, the npx command on `win32` becomes `"command": "cmd", "args": ["/c", "npx", "-y", "tradingview-desktop-mcp"]`.
- **Unknown or missing client:** `INVALID_INPUT` with the valid list, plus `Did you mean "<closest>"?` when the edit distance is at most 3. Exit 1.
- The `Command` type and `COMMANDS` gain `config`. The help line drops "(not implemented yet)".

- [ ] **Step 1: Write the failing tests.**
  - `renderClientConfig prints each client's snippet` (a table test over all nine, for npx on darwin).
  - `the stdio snippets are valid JSON or TOML with the server named tradingview`.
  - `--local uses node and the absolute path of the running CLI`.
  - `--platform win32 uses cmd /c npx where the client needs it` (Review Focus 1).
  - `remote clients use the --url host, or YOUR-TUNNEL-HOST, and never the real token even when TV_MCP_AUTH_TOKEN is set`.
  - `an explicit --profile is added to the args`.
  - `an unknown client lists the clients and suggests the closest` (Review Focus 3).
  - `config options with another command are INVALID_INPUT`.
  - `config writes the snippet alone to stdout and the notes to stderr, exit 0`.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to see them pass,** then run the gate.
- [ ] **Step 5: Commit:** `feat(cli): print a configuration snippet for each supported client`.

---

### Task 3: Generated tool reference

**Files:**

- Create:
  - `packages/server/scripts/docs/tools.ts`
  - `docs/tools.md` (generated)
  - `packages/server/test/integration/docs-tools.test.ts`
- Modify:
  - `packages/server/package.json` (`docs:tools`)
  - root `package.json` (`docs:tools`)
  - `README.md` (link)

**Interfaces:**

- **`renderToolReference(tools: readonly AnyToolDefinition[]): string`** builds Markdown from `allTools`, `toolProfiles` and `toolInputJsonSchema`.
  - **Header:** "Generated by `pnpm docs:tools` from the tool definitions. Do not edit it by hand.", followed by the totals line: `83 tools: 40 in the core profile, 37 in the readonly profile.` The numbers are computed.
  - **Contents:** a domain table of contents in `allTools` order.
  - **Per domain:** `## <Domain title> (<n> tools)`.
  - **Per tool:**
    - `### <name>`, then the title;
    - a line of badges, from `Read-only`, `Destructive`, `Idempotent`, and the profiles (`core`, `readonly`);
    - the description, with its paragraphs kept;
    - an inputs table (`Input | Type | Required | Description`), where constraints, enums and defaults are appended to the description cell; or "No inputs."
  - **Formatting:** pipes and newlines are escaped in cells. Output is deterministic.
- **`pnpm docs:tools`** writes `docs/tools.md`.

- [ ] **Step 1: Write the failing tests.**
  - `docs/tools.md is up to date`.
  - `the tool reference lists every tool once under its domain with the computed totals`.
  - `a tool with no inputs says No inputs and table cells escape pipes and newlines`.
  - `the README tool counts match the catalogue` (Review Focus 5).
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.** Generate the file and link it from the README's "Tool profiles" section.
- [ ] **Step 4: Run them to see them pass,** then run the gate.
- [ ] **Step 5: Commit:** `docs: generate the tool reference`.

---

### Task 4: Behaviour fixes before release

These come from the review carry-forwards.

**Files:**

- Modify:
  - `packages/server/src/cli/{run,output}.ts`
  - `packages/server/src/tools/indicator/*`
  - `packages/server/src/tools/alert/*`
  - `packages/server/src/tools/watchlist/*`
  - `packages/dashboard/src/components/layout/connection-badge.tsx`
- Test: the matching unit and integration tests.

**Interfaces and decisions:**

1. **`launch --restart`.**
   - The CLI flag passes `restart: true` to `Launcher.launch`.
   - The help says it quits TradingView politely, then starts it again with the debug port, and that TradingView may ask to save changes.
   - Without the flag, behaviour is unchanged (`RESTART_REQUIRED` with a hint that now names `--restart`).
   - Tests use the injected launcher only.
2. **`doctor` and a background chart.** It reports `chart.inBackground` as a failed chart check: "A chart is open but not in front; bring its tab to the front." `isHealthy` is false in that state.
3. **`indicator_list` time inputs** are reported as Unix seconds plus an ISO string (spec §5.1), not raw milliseconds. The description is updated to match.
4. **`alert_list`** shows an alert as a price alert only when `series[0]` is the chart's bar set. Indicator alerts are reported with their own kind.
5. **Watchlist search** passes the exchange for `EXCHANGE:TICKER` input, so a valid listing beyond the first page is not reported `unknown`.
6. **Dashboard badge:** a health failure with an `ApiError` (403, 404, 5xx) shows "Server error", not "Connecting".

- [ ] **Step 1: Write the failing tests,** one or more per item.
  - `launch --restart restarts through the launcher and is required for a running app without the port`.
  - `doctor fails the chart check when the chart is in the background`.
  - `indicator_list reports time inputs as seconds and ISO`.
  - `alert_list reports an indicator alert as such`.
  - `watchlist_add finds EXCHANGE:TICKER beyond the first search page`.
  - `the badge says Server error on an ApiError`.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to see them pass,** then run the gate, with dashboard coverage too.
- [ ] **Step 5: Commit** each item as its own `fix(...)` or `feat(cli)` commit.

---

### Task 5: Client tutorials and troubleshooting

**Files:**

- Create:
  - `docs/clients/{claude-desktop,claude-code,cursor,vscode,windsurf,gemini-cli,codex-cli,chatgpt,openai-api}.md`
  - `docs/troubleshooting.md`
  - `packages/server/scripts/docs/clients.ts`
  - `packages/server/test/integration/docs-clients.test.ts`
- Modify: `packages/server/package.json` and root `package.json` (`docs:clients`).

**Interfaces:**

- **Each tutorial** (written for a new user) contains:
  1. **What you need:** TradingView Desktop started with the debug port by `npx -y tradingview-desktop-mcp launch`, and Node 20.19+.
  2. **The snippet,** inside a block delimited by `<!-- config:<client> -->` / `<!-- /config -->`. `pnpm docs:clients` fills it from `renderClientConfig` (npx, darwin), and a Windows variant where it differs.
  3. **Where it goes,** from the notes.
  4. **Restart and check:** ask the assistant to "check that TradingView is connected" (`app_health`), or run `npx -y tradingview-desktop-mcp doctor`.
  5. **A first prompt.**
  6. **Links** to troubleshooting and to the profiles.

  The remote tutorials (chatgpt, openai-api) also cover the HTTP transport, the token, a tunnel with `TV_MCP_ALLOWED_HOSTS`, and `--profile readonly`, with the spec §8 warning.

- **`docs/troubleshooting.md`:**
  - **One section per error code** in `ERROR_CODES` (`### <CODE>`), saying what it means and what to do, with the CLI command where one helps.
  - **Common situations:** the port is taken by another browser; the client does not show the tools (restart the client, run `doctor`); macOS refuses to quit the app (Automation permission); Windows and Linux install paths and `TV_APP_PATH`; a tunnel answers 403 (`TV_MCP_ALLOWED_HOSTS`); the dashboard asks for a token; logs (`--log-level debug`, stderr).
- **`pnpm docs:clients`** rewrites the delimited blocks only.

- [ ] **Step 1: Write the failing tests.**
  - `every client tutorial holds the snippet config prints` (Review Focus 5).
  - `docs:clients leaves text outside the config blocks untouched`.
  - `troubleshooting documents every error code`.
  - `tutorial and troubleshooting links resolve to files in the repo`.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Write the docs and the generator.**
- [ ] **Step 4: Run them to see them pass,** then run the gate.
- [ ] **Step 5: Commit:** `docs: add a tutorial for each client and a troubleshooting guide`.

---

### Task 6: Package and release setup

**Files:**

- Modify:
  - `packages/server/package.json`
  - `.github/workflows/ci.yml`
  - `scripts/smoke-node20.mjs`
  - `SECURITY.md` ("Supported versions")
  - `.gitignore`
- Create:
  - `packages/server/scripts/prepare-package.mjs`
  - `.github/workflows/release.yml`
  - `CHANGELOG.md`
  - `packages/server/test/unit/scripts/prepare-package.test.ts`

**Interfaces:**

- **`package.json` metadata:**
  - `keywords`: mcp, model-context-protocol, tradingview, trading, charting, claude, cursor, ai, chrome-devtools-protocol.
  - `author`.
  - `repository`: `{ type: git, url: git+https://github.com/Mochamad-Rizky/tradingview-mcp.git, directory: packages/server }`.
  - `homepage`, `bugs`.
  - `exports`: `{ ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } }` and `"types": "./dist/index.d.ts"`.
  - `publishConfig`: `{ "access": "public", "provenance": true }`.
  - `files`: `["dist", "README.md", "LICENSE", "CHANGELOG.md"]`.
  - `prepack`: `node scripts/prepare-package.mjs`.
- **`prepare-package.mjs`:**
  - It copies the root `LICENSE` and `CHANGELOG.md` into the package.
  - It writes `packages/server/README.md` from the root README, with relative links rewritten to `https://github.com/Mochamad-Rizky/tradingview-mcp/blob/main/<path>` and images to `https://raw.githubusercontent.com/Mochamad-Rizky/tradingview-mcp/main/<path>`.
  - The three generated files are gitignored.
  - Export `rewriteReadmeLinks(markdown: string): string` for the test.
- **`CHANGELOG.md`:** in Keep a Changelog form, a `## [0.1.0] - Unreleased` entry that summarises Plans 1–4 for users. The version stays `0.1.0`.
- **CI:**
  - `verify` packs the tarball (`pnpm --filter tradingview-desktop-mcp pack`) and uploads it.
  - It also checks the tarball listing:
    - it must contain `package/dist/cli.js`, `package/dist/index.js`, `package/dist/index.d.ts`, `package/dist/dashboard/index.html`, `package/README.md`, `package/LICENSE` and `package/CHANGELOG.md`;
    - it must not contain `package/src/` or `package/test/`.
  - `runtime-node20` installs that tarball into an empty directory on Node 20.19.0 and runs `scripts/smoke-node20.mjs` against the installed bin. The smoke script takes the CLI path from `SMOKE_CLI`, defaulting to the repo's `dist/cli.js`.
- **`release.yml`:**
  - It runs only on `push: tags: ['v*.*.*']`.
  - It checks that the tag equals `v<package version>`, then runs the gate.
  - It publishes from `packages/server` with npm provenance (`permissions: id-token: write`).
    - It uses npm trusted publishing when configured, and falls back to `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` when that secret exists.
    - Verify the current npm trusted-publishing docs and cite them in a comment.
  - It creates a GitHub release with the CHANGELOG section of that version (`contents: write`).
- **`SECURITY.md`:** supported versions `0.1.x`.

- [ ] **Step 1: Write the failing tests.**
  - `rewriteReadmeLinks makes relative links and images absolute and leaves absolute ones alone`.
  - `prepare-package writes README, LICENSE and CHANGELOG into the package`.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run locally:**
  - the gate;
  - `pnpm --filter tradingview-desktop-mcp pack` and list the tarball;
  - install it into a temp dir with `npx -y node@20.19.0`, then run `SMOKE_CLI=<installed bin> node scripts/smoke-node20.mjs` (Review Focus 4);
  - `actionlint` on both workflows if available.

  Do NOT publish, tag or create a release.

- [ ] **Step 5: Commit:** `build: complete the package metadata and add a tag-driven release workflow`. Put the CI tarball checks in their own `ci:` commit.

---

### Task 7: README, testing guide, contributing and spec

**Files:**

- Modify:
  - `README.md`
  - `docs/testing.md`
  - `CONTRIBUTING.md`
  - `docs/superpowers/specs/2026-10-18-tradingview-mcp-design.md` (§9, §11, §12)
  - `packages/server/test/integration/docs-examples.test.ts`, if headings move

**Interfaces:**

- **README:**
  - Replace the "Work in progress" note with the pre-1.0 status: tool names may still change before 1.0, and the package is published once the maintainer releases 0.1.0.
  - Add npm and license badges.
  - **Install:** `npx -y tradingview-desktop-mcp` (Node 20.19+), with "from source" kept as an alternative.
  - **Connect your AI app:** a table of the nine clients, each linked to its tutorial, with `npx -y tradingview-desktop-mcp config <client>`.
  - **Remote clients and tunnels:** a short summary linking to the ChatGPT and OpenAI tutorials and to SECURITY.md.
  - Link the troubleshooting guide and the tool reference.
  - Keep "Try these prompts", the Safety section, the profiles and the dashboard.
- **`docs/testing.md`, final:**
  - the docs freshness tests (examples, tools, clients);
  - the tarball check and the Node 20 smoke on the installed package;
  - the release workflow;
  - a "Last verified against TradingView" line, which Task 8 fills.
- **CONTRIBUTING.md:**
  - "Releasing": bump the version and the CHANGELOG, then tag `vX.Y.Z` and push the tag. The workflow publishes. Include the one-time npm trusted-publisher setup.
  - Generated docs: which commands to run.
- **Spec:**
  - §9 gains `TV_MCP_ALLOWED_HOSTS` / `--allowed-hosts`, and the `config` and `launch --restart` options;
  - §11 lists the tarball job and the release workflow;
  - §12 marks Plans 1–5.

- [ ] **Step 1: Write the failing docs tests.**
  - `the README links every client tutorial, the troubleshooting guide and the tool reference`.
  - `the README install and config commands name the published package`.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Update the docs.**
- [ ] **Step 4: Run the gate.**
- [ ] **Step 5: Commit:** `docs: finish the README, testing guide and contributing guide for the release`.

---

### Task 8: Final verification against the real TradingView

**Files:**

- Modify:
  - `docs/testing.md` ("Last verified against TradingView": app version, OS version, date, and the results summary; no personal data)
  - `docs/reverse-engineering.md`, only if an observation changes it
  - fakes and source only for a contradicted assumption, each as a focused `fix(...)` commit

**Interfaces:**

- **Before and after:** record the state counts as the earlier E2E tasks did: drawings, alerts, watchlist, layout, tabs, replay off, panels, and the chart symbol and timeframe compared without printing them.
- **Run the full MCP E2E suite** with `TV_E2E=1 TV_E2E_ALLOW_TABS=1 TV_MCP_ALLOW_EVAL=true pnpm test:e2e`.
  - The tab suite needs the TradingView window in view, and otherwise skips with its reason.
  - Never set `TV_E2E_ALLOW_LAYOUTS`.
- **Run the dashboard read-only real-app project:** `TV_E2E=1 pnpm --filter tradingview-desktop-mcp-dashboard test:e2e:real`.
- **Check the packed tarball against the real app:**
  - install it into a temp dir;
  - run its `doctor`, read-only, and expect "TradingView is ready.";
  - run its `config claude-desktop` and check the snippet;
  - start its HTTP server with a generated token and `--profile readonly`, and check `/api/health` reports the app ready; then stop it.
- **Hard rules:**
  - never launch, quit, restart or reload TradingView;
  - only test-created objects are touched;
  - nothing personal is printed or saved;
  - if TradingView is not running with the debug port, stop and report BLOCKED.

- [ ] **Step 1: Record the before state.**
- [ ] **Step 2: Run the suites and the tarball checks.**
- [ ] **Step 3: Record the after state and compare.**
- [ ] **Step 4: Fix any contradicted assumption** with a focused commit and a fake update, and run the gate.
- [ ] **Step 5: Fill "Last verified against TradingView"** and commit: `docs: record the release verification against TradingView`.
